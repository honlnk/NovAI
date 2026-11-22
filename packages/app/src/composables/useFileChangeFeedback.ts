import { watch } from 'vue'

import { hashContent } from '@novai/core'

import { useProjectStore } from '../stores/project'
import { useChatStore } from '../stores/chat'
import type { RecentFileChange } from '../stores/chat'
import { useToast } from './useToast'
import { freezeEditorSessionForExternal, setEditorGuard } from './editor-session'
import { isFileDraftDirty } from './useFileDrafts'
import {
  dismissHighlightJob,
  startHighlightJob,
  useChangeHighlights,
} from './useChangeHighlights'
import { resolveActiveFileEffect } from '../utils/file-tree'

/**
 * 文件变更反馈链（交互优化计划 §7 + 正文自动保存计划 §五.2，修复批 2026-11-20 从
 * ProjectView 抽出）：chatStore.recentFileChanges 逐条到达 →
 * 命中当前打开文件时重读并尝试自动播放高亮；
 * AI 先落盘且人工有未落盘内容时冻结会话建立正文版本冲突。
 *
 * 变更通知队列（可堆叠蓝色卡片）已于 2026-11-23 按用户决策移除：不抢现场
 * （正在编辑/看别的文件/后台会话改动）时不再入队通知，AI 改动信息由聊天流
 * 工具行摘要与变更账本承载。
 *
 * 冲突反馈分层（修复批 2026-11-20，同一冲突只留一个反馈位）：
 * - 当前打开文件进入冲突：黄色冲突条（FilePanelBody 紧凑状态条）即唯一反馈——
 *   不 toast，并收起该文件残留的高亮任务；
 * - 非当前文件首次进入冲突：黄色条在该文件现场、打开前不可见，仅此一次 toast 指路；
 * - 冲突既已建立后 AI 继续修改（conflict-refresh）：静默刷新冲突对应的最新磁盘版本，
 *   不再逐次 toast；
 * - 变更账本（chatStore.recentFileChanges）是底层数据，任何反馈收起都不清理它。
 */
export type FileChangeFeedbackOptions = {
  /** 当前项目 id（getter 保持响应式） */
  projectId: () => string
  /** FilePanelBody 的现场快照（不抢现场判定与冻结入口判定用） */
  getPanelState: () => { path: string | null; viewMode: 'preview' | 'edit'; dirty: boolean } | null
  /** 需要把内容面板展开给用户看（守护置入时） */
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

  /**
   * 冲突反馈收口：该文件残留的高亮任务退场，黄色冲突条接管这一冲突的持续反馈
   * （账本不动）。
   */
  function handFeedbackToConflictBar(path: string): void {
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
      // 黄色冲突条就在当前现场，同一冲突不再逐次 toast。
      if (panel?.dirty) {
        const outcome = await freezeEditorSessionForExternal(projectId(), effect.path)
        if (outcome === 'conflict' || outcome === 'conflict-refresh') {
          handFeedbackToConflictBar(effect.path)
        }
        return
      }
      // 编辑模式不打断输入（重命名已在上面分支处理完毕）：干净会话由 rebase 跟随
      // 磁盘新版本，不再给通知（变更通知队列已于 2026-11-23 移除）
      if (panel?.viewMode === 'edit' && isContentChange) {
        return
      }
      await projectStore.openFile(effect.path)
      // 版本相符才自动播放（§7：失配不伪造高亮，绝不覆盖较新内容）
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
      }
      return
    }

    // 未命中当前文件：不跳转不抢占（§7.4）。
    // 用户编辑过又切走的文件被 AI 写盘时同样冻结（§五.2）：回访该文件即见状态条再入口。
    // 反馈分层（修复批 2026-11-20）：该文件不在当前现场，首次建立冲突给一次 toast
    // 指路（黄色条打开前不可见）；此后继续修改静默刷新磁盘版本。
    if (isContentChange) {
      if (isFileDraftDirty(projectId(), targetPath)) {
        const outcome = await freezeEditorSessionForExternal(projectId(), targetPath)
        if (outcome === 'conflict' || outcome === 'conflict-refresh') {
          if (outcome === 'conflict') {
            toast.info(`「${targetPath.split('/').pop() ?? targetPath}」已被 AI 修改，已保留你尚未写入正文的内容并暂停自动保存`)
          }
          handFeedbackToConflictBar(targetPath)
        }
      }
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

  // 切项目：清空上一项目的消费游标（跨项目不串扰；账本由 ProjectView 清）
  watch(
    projectId,
    () => {
      processedChangeIds.clear()
    },
  )
}
