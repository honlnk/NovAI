import { watch } from 'vue'

import type { CardSessionGuard } from '../stores/card-board'
import type { RecentFileChange } from '../stores/chat'
import { useChatStore } from '../stores/chat'
import { useToast } from './useToast'

/**
 * 卡片域变更链（阶段 3）：三个看板目录（plans/ foreshadowing/ rhythm/）接入
 * AI/外部写盘事件的会话保护——与正文反馈链（useFileChangeFeedback）并行消费
 * 同一变更账本，互不重叠：本链只处理卡片目录路径，正文链的 plans/ 早退保留。
 *
 * 看板列刷新由 ProjectView 既有的 changedFiles watch 负责（新卡、干净卡片的
 * 列归属变化），本链只处理「有人工未落盘内容」的会话：
 * - 内容变更（created/updated）：dirty 会话冻结自动保存并建立冲突。反馈分层
 *   与正文一致——当前打开的卡片黄色冲突条即唯一反馈（不 toast）；不在现场的
 *   卡片首次冲突给一次 toast 指路；既有冲突的后续修改静默刷新磁盘版本。
 * - 删除/重命名：有未落盘内容时置入守护（写入被拒绝、现场保留，详情横幅给
 *   「恢复为新卡片/放弃并关闭」出口）；当前打开的卡片顺带展开内容面板。
 * - 干净会话（clean）：AI 修改对人工无风险；当前打开的卡片重读详情跟上最新。
 */
export type CardChangeDomain = 'plans' | 'foreshadowing' | 'rhythm'

/** 单个卡片域的会话保护适配（由 ProjectView 用对应 store 构造） */
export type CardChangeDomainAdapter = {
  /** 目录前缀（如 'plans/'，用于路径匹配） */
  pathPrefix: string
  /** 看板全部卡片摘要（sourcePath → 卡片 id/名称 的匹配源；标题字段按域映射成 name） */
  getCards: () => ReadonlyArray<{ id: string; sourcePath: string; name: string }>
  /** 冻结 dirty 会话建立冲突：'conflict' 首次 / 'conflict-refresh' 既有刷新 / 'clean' | 'none' 无人工内容 */
  freeze: (projectId: string, cardId: string) => Promise<'conflict' | 'conflict-refresh' | 'clean' | 'none'>
  /** 该卡片是否有未落盘草稿或未决冲突（删除/重命名的守护判定） */
  hasDraft: (projectId: string, cardId: string) => boolean
  /** 置入守护（禁止一切写入，现场保留给详情横幅） */
  setGuard: (projectId: string, cardId: string, guard: CardSessionGuard) => void
  /** 干净会话时重读当前打开卡片的详情（跟上 AI 最新内容） */
  reopen: (projectId: string, cardId: string) => Promise<void>
}

export type CardChangeFeedbackOptions = {
  /** 当前项目 id（getter 保持响应式） */
  projectId: () => string
  /** 该域的这张卡片是否正打开在内容面板（冲突条可见性判定） */
  isCardOpen: (domain: CardChangeDomain, cardId: string) => boolean
  /** 需要把内容面板展开给用户看（守护命中当前打开卡片时） */
  openContentPanel: () => void
  domains: Record<CardChangeDomain, CardChangeDomainAdapter>
}

export function useCardChangeFeedback(options: CardChangeFeedbackOptions) {
  const chatStore = useChatStore()
  const toast = useToast()
  const projectId = options.projectId

  /** 已消费的实时改动 id（防最近队列重复处理） */
  const processedChangeIds = new Set<string>()

  function matchDomain(path: string): { domain: CardChangeDomain; adapter: CardChangeDomainAdapter } | null {
    for (const [domain, adapter] of Object.entries(options.domains) as [CardChangeDomain, CardChangeDomainAdapter][]) {
      if (path.startsWith(adapter.pathPrefix)) {
        return { domain, adapter }
      }
    }
    return null
  }

  /** 看板摘要里按文件路径找卡片（找不到 = 新卡/已删，看板刷新足够） */
  function findCard(adapter: CardChangeDomainAdapter, path: string): { id: string; name: string } | null {
    const hit = adapter.getCards().find((summary) => summary.sourcePath === path)
    return hit ? { id: hit.id, name: hit.name } : null
  }

  async function processChangeRecord(entry: RecentFileChange) {
    const change = entry.record.change
    // 删除/重命中的匹配路径都是原路径（重命名后旧路径上的会话才是保护对象）
    const path = change.type === 'renamed' ? change.fromPath : change.path
    const matched = matchDomain(path)
    if (!matched) {
      return
    }
    const pid = projectId()
    const { domain, adapter } = matched
    const hit = findCard(adapter, path)

    if (change.type === 'deleted' || change.type === 'renamed') {
      if (hit && adapter.hasDraft(pid, hit.id)) {
        adapter.setGuard(pid, hit.id, change.type === 'deleted'
          ? { kind: 'deleted', ...(change.trashPath !== undefined ? { trashPath: change.trashPath } : {}) }
          : { kind: 'renamed', toPath: change.toPath })
        const isOpen = options.isCardOpen(domain, hit.id)
        if (isOpen) {
          options.openContentPanel()
        }
        const verb = change.type === 'deleted' ? '删除' : '重命名'
        toast.info(`「${hit.name}」已被${verb}，你尚未写入的修改已保留`)
      }
      // 看板列变化（卡片消失/换位）由 ProjectView 既有的 changedFiles watch 刷新
      return
    }

    if (!hit) {
      return
    }
    const outcome = await adapter.freeze(pid, hit.id)
    if (outcome === 'conflict' || outcome === 'conflict-refresh') {
      // 反馈分层：当前现场黄条唯一，不重复 toast；不在现场首次冲突一次指路；
      // 既有冲突的后续修改静默刷新（磁盘版本在冲突状态里更新）
      if (outcome === 'conflict' && !options.isCardOpen(domain, hit.id)) {
        toast.info(`「${hit.name}」已被 AI 修改，已保留你尚未写入的修改并暂停自动保存`)
      }
      return
    }
    // 干净会话：AI 修改无人工内容风险；当前打开的卡片重读详情跟上最新
    if (options.isCardOpen(domain, hit.id)) {
      await adapter.reopen(pid, hit.id)
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

  // 切项目：清空上一项目的消费游标（跨项目不串扰）
  watch(
    projectId,
    () => {
      processedChangeIds.clear()
    },
  )
}
