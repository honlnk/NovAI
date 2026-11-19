import { ref, watch } from 'vue'

import { hashContent } from '@novai/core'
import type { FileChangeRecordView } from '@novai/core/services/types'

import { useProjectStore } from '../stores/project'
import { useChatStore } from '../stores/chat'
import type { RecentFileChange } from '../stores/chat'
import { useToast } from './useToast'
import { freezeEditorSessionForExternal, setEditorGuard } from './editor-session'
import { isFileDraftDirty } from './useFileDrafts'
import {
  dismissChangeNoticesForPath,
  dismissHighlightJob,
  pushChangeNotice,
  startHighlightJob,
  useChangeHighlights,
  type ChangeNotice,
} from './useChangeHighlights'
import { resolveActiveFileEffect } from '../utils/file-tree'

/**
 * 文件变更反馈链（交互优化计划 §7 + 正文自动保存计划 §五.2，修复批 2026-11-20 从
 * ProjectView 抽出，调用链行为不变）：chatStore.recentFileChanges 逐条到达 →
 * 命中当前打开文件时重读并尝试自动播放高亮；不抢现场时入蓝色通知队列；
 * AI 先落盘且人工有未落盘内容时冻结会话建立正文版本冲突。
 *
 * 冲突反馈分层（修复批 2026-11-20，同一冲突只留一个反馈位）：
 * - 当前打开文件进入冲突：黄色冲突条（FilePanelBody 紧凑状态条）即唯一反馈——
 *   不 toast、不新增蓝色通知，并收起该文件既有的同类蓝色通知与残留高亮任务；
 * - 非当前文件首次进入冲突：黄色条在该文件现场、打开前不可见，仅此一次 toast 指路；
 * - 冲突既已建立后 AI 继续修改（conflict-refresh）：静默刷新冲突对应的最新磁盘版本，
 *   不再逐次 toast、不再逐次新增蓝色通知；
 * - 无冲突的普通 AI 修改：重读、自动播放与蓝色通知行为全部保留；
 * - 变更账本（chatStore.recentFileChanges）是底层数据，任何反馈收起都不清理它。
 */
export type FileChangeFeedbackOptions = {
  /** 当前项目 id（getter 保持响应式） */
  projectId: () => string
  /** FilePanelBody 的现场快照（不抢现场判定与冻结入口判定用） */
  getPanelState: () => { path: string | null; viewMode: 'preview' | 'edit'; dirty: boolean } | null
  /** 需要把内容面板展开给用户看（守护置入 / 通知点击） */
  openContentPanel: () => void
  /** AI 删除正打开文件（无草稿清空面板）时的空态提示 */
  setPanelNotice: (notice: { name: string; trashPath?: string } | null) => void
}

export function useFileChangeFeedback(options: FileChangeFeedbackOptions) {
  const projectStore = useProjectStore()
  const chatStore = useChatStore()
  const toast = useToast()
  const projectId = options.projectId

  /** 已消费的实时改动 id（防最近队列重复处理） */
  const processedChangeIds = new Set<string>()

  /** 账本记录 → 反馈通知（携带重播所需的定位载荷与后台会话归属） */
  function buildChangeNotice(record: FileChangeRecordView, entry: RecentFileChange): ChangeNotice {
    const change = record.change
    const path = change.type === 'renamed' ? change.toPath : change.path
    const canLocate = Boolean(record.coords && record.coords.ranges.length > 0)
    // 来源归属（F10）：后台会话的改动标注会话标题；当前会话的改动上下文自明不标
    const fromBackground = entry.sessionId !== chatStore.activeSessionId
    const sessionTitle = fromBackground
      ? chatStore.sessions.find((s) => s.sessionId === entry.sessionId)?.title
      : undefined
    return {
      recordId: record.id,
      path,
      fileName: path.split('/').pop() ?? path,
      status: change.type === 'created' ? 'created' : 'updated',
      count: record.coords?.ranges.length ?? 1,
      canLocate,
      ...(canLocate
        ? {
            locate: {
              ranges: record.coords!.ranges,
              oldText: record.diff?.oldText ?? '',
              afterHash: record.coords!.afterVersion?.contentHash,
            },
          }
        : {}),
      ...(fromBackground && sessionTitle !== undefined
        ? { sessionId: entry.sessionId, sessionTitle }
        : {}),
    }
  }

  /**
   * 冲突反馈收口：该文件既有蓝色通知与残留高亮任务全部退场，黄色冲突条接管
   * 这一冲突的持续反馈（账本不动；普通无冲突通知不受影响）。
   */
  function handFeedbackToConflictBar(path: string): void {
    dismissChangeNoticesForPath(projectId(), path)
    if (useChangeHighlights(projectId()).state.job?.path === path) {
      dismissHighlightJob(projectId())
    }
  }

  async function processChangeRecord(entry: RecentFileChange) {
    const record = entry.record
    const change = record.change
    const isContentChange = change.type === 'created' || change.type === 'updated'
    const targetPath = change.type === 'renamed' ? change.toPath : change.path

    // 计划文件只刷新现有计划工作流（计划看板 watch 自行处理），不套用章节高亮（§7）
    if (targetPath.startsWith('plans/')) {
      return
    }

    const panel = options.getPanelState()
    const effect = resolveActiveFileEffect(panel?.path ?? projectStore.activeFile?.path ?? null, change)
    const isActiveSession = entry.sessionId === chatStore.activeSessionId

    // 删除命中当前打开文件：有未保存草稿时置入草稿守护（数据安全计划 §3-3）——
    // 不清空编辑现场、草稿原样保留，由 FilePanelBody 横幅给出「恢复为草稿副本/
    // 放弃草稿并关闭」的去向选择；无草稿才清空面板——快照再留着就是幽灵文件
    // （编辑保存还会复活它），清空后由空态提示回收站去向
    if (effect?.action === 'clear') {
      const deleted = change.type === 'deleted' ? change : null
      const deletedPath = projectStore.activeFile?.path
      if (deleted && deletedPath && isFileDraftDirty(projectId(), deletedPath)) {
        // 草稿守护（§3-3）：不清空编辑现场、草稿原样保留，由 FilePanelBody 横幅
        // 给出「恢复为草稿副本/放弃草稿并关闭」的去向选择（守护状态在编辑会话上）
        setEditorGuard(projectId(), deletedPath, {
          kind: 'deleted',
          ...(deleted.trashPath !== undefined ? { trashPath: deleted.trashPath } : {}),
        })
        options.openContentPanel()
        toast.info(`「${projectStore.activeFile?.name ?? '当前文件'}」已被删除，你尚未写入正文的内容已保留`)
        return
      }
      options.setPanelNotice({
        name: projectStore.activeFile?.name ?? '当前文件',
        trashPath: deleted?.trashPath,
      })
      projectStore.clearActiveFile()
      return
    }

    // 命中当前打开的文件：重读 + 尝试自动播放
    if (effect?.action === 'reload') {
      // 重命名命中且有未保存草稿：暂停自动接管（§3-3）——静默重读会让草稿挂在已不
      // 存在的旧路径上；置入守护，由用户选「迁移草稿/放弃并打开新文件」
      if (change.type === 'renamed') {
        if (isFileDraftDirty(projectId(), change.fromPath)) {
          setEditorGuard(projectId(), change.fromPath, {
            kind: 'renamed',
            toPath: change.toPath,
          })
          options.openContentPanel()
          toast.info(`「${change.fromPath.split('/').pop() ?? change.fromPath}」已被重命名，你尚未写入正文的内容已保留`)
          return
        }
        await projectStore.openFile(change.toPath)
        return
      }
      // AI 先落盘且人工有未落盘内容（§五.2 非阻塞冲突）：不清输入、不切预览，
      // 冻结该会话自动保存并读取外部版本建立冲突。反馈分层（修复批 2026-11-20）：
      // 黄色冲突条就在当前现场，同一冲突不再逐次 toast、不再叠加蓝色通知。
      if (panel?.dirty) {
        const outcome = await freezeEditorSessionForExternal(projectId(), effect.path)
        if (outcome === 'conflict' || outcome === 'conflict-refresh') {
          handFeedbackToConflictBar(effect.path)
        }
        return
      }
      // 编辑模式不打断输入：入通知队列（重命名已在上面分支处理完毕）
      if (panel?.viewMode === 'edit' && isContentChange) {
        pushChangeNotice(projectId(), buildChangeNotice(record, entry))
        return
      }
      await projectStore.openFile(effect.path)
      // 版本相符才自动播放（§7：失配降级为通知，绝不覆盖较新内容）
      const file = projectStore.activeFile
      if (
        isActiveSession
        && record.coords
        && record.coords.ranges.length > 0
        && record.coords.afterVersion
        && file
        && file.format !== 'json'
        && hashContent(file.content) === record.coords.afterVersion.contentHash
      ) {
        startHighlightJob(projectId(), {
          recordId: record.id,
          path: effect.path,
          ranges: record.coords.ranges,
          oldText: record.diff?.oldText ?? '',
          mode: 'timed',
        })
        return
      }
      if (isContentChange) {
        pushChangeNotice(projectId(), buildChangeNotice(record, entry))
      }
      return
    }

    // 未命中当前文件：只入通知队列，不跳转不抢占（§7.4）。
    // 用户编辑过又切走的文件被 AI 写盘时同样冻结（§五.2）：回访该文件即见状态条再入口。
    // 反馈分层（修复批 2026-11-20）：该文件不在当前现场，首次建立冲突给一次 toast
    // 指路（黄色条打开前不可见）；此后继续修改静默刷新磁盘版本；两种结果都不再入
    // 蓝色通知并收起既有同类通知。普通无冲突修改的入队行为保持不变。
    if (isContentChange) {
      if (isFileDraftDirty(projectId(), targetPath)) {
        const outcome = await freezeEditorSessionForExternal(projectId(), targetPath)
        if (outcome === 'conflict' || outcome === 'conflict-refresh') {
          if (outcome === 'conflict') {
            toast.info(`「${targetPath.split('/').pop() ?? targetPath}」已被 AI 修改，已保留你尚未写入正文的内容并暂停自动保存`)
          }
          handFeedbackToConflictBar(targetPath)
          return
        }
      }
      pushChangeNotice(projectId(), buildChangeNotice(record, entry))
    }
  }

  watch(
    () => chatStore.recentFileChanges.length,
    () => {
      for (const entry of chatStore.recentFileChanges) {
        if (processedChangeIds.has(entry.record.id)) continue
        processedChangeIds.add(entry.record.id)
        void processChangeRecord(entry)
      }
    },
  )

  // 切项目：清空上一项目的消费游标与反馈队列（跨项目不串扰；账本由 ProjectView 清）
  watch(
    projectId,
    () => {
      processedChangeIds.clear()
    },
  )

  /** 变更通知「查看差异」点击令牌：递增驱动 FilePanelBody 在路径未变（正编辑同文件）时也切回预览 */
  const locateToken = ref(0)

  /** 变更通知点击：打开对应文件；可定位且版本相符则重播稳定差异，失配降级为提示 */
  async function handleLocateChange(notice: ChangeNotice) {
    locateToken.value += 1
    await projectStore.openFile(notice.path)
    // 面板被收起时等同「在文件树点文件」：先展开，否则高亮在隐藏面板里无从看见
    options.openContentPanel()
    if (!notice.locate) {
      return
    }
    const file = projectStore.activeFile
    if (!notice.locate.afterHash || (file && hashContent(file.content) === notice.locate.afterHash)) {
      startHighlightJob(projectId(), {
        recordId: notice.recordId,
        path: notice.path,
        ranges: notice.locate.ranges,
        oldText: notice.locate.oldText,
        mode: 'stable',
      })
      return
    }
    toast.info(`「${notice.fileName}」内容已再次变化，无法定位该处修改`)
  }

  return {
    locateToken,
    handleLocateChange,
  }
}
