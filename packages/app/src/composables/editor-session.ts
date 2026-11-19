/**
 * 编辑器会话状态机（正文自动保存与并发冲突交互重设计计划 §四）：
 * 按「项目 + 路径」把人工编辑、保存编排与冲突/守护状态收敛到可独立测试的会话模块，
 * 组件只负责展示与发送用户操作——不再在组件监听器、草稿表和保存回调里分别拼状态。
 *
 * 自「看板卡片详情自动保存与状态操作优化计划」阶段 1 起，事件序机制（同键串行
 * 写盘、失败补试、冲突代次、恢复核对、生命周期收口）上提到通用引擎
 * composables/save-session.ts，与看板卡片共用同一套已验证编排；本文件是正文
 * 领域适配层：快照 = 正文内容字符串，磁盘版本 = {content, updatedAt}，版本令牌
 * = updatedAt + 基线内容哈希，恢复镜像 = draft-backup（IndexedDB）。
 *
 * 会话记录：最新人工输入、编辑基线（开始编辑时的磁盘正文与版本）、在途写盘
 * 快照、失败原因、已感知的外部版本（冲突代次）、删除/重命名守护、恢复镜像
 * 回填标记。权威正文仍是项目磁盘；内存会话保存运行期最新输入。
 */
import { hashContent } from '@novai/core'
import type { FileContentView } from '@novai/core/services/types'
import type { SaveFileOutcome } from '../stores/project'
import { removeDraftBackup, scheduleDraftBackup } from './draft-backup'
import {
  SAVE_SESSION_AUTOSAVE_DEBOUNCE_MS,
  SAVE_SESSION_RETRY_DELAY_MS,
  SaveServiceUnavailableError,
  createSaveSessionRealm,
  type SaveSessionAdapter,
} from './save-session'

export type EditorSessionPhase =
  | 'clean' // 无待写内容（已保存）
  | 'pending' // 有待写内容（等待保存；去抖窗口内）
  | 'saving' // 写盘在途（正在保存）
  | 'failed' // 普通写入失败（保存失败，可重试）
  | 'conflict' // 检测到外部版本（禁止自动写入，直到用户解决）
  | 'guard' // 删除/重命名守护（禁止自动写入，直到用户选择去向）
  | 'restored' // 恢复镜像已回填，待版本校验

export type EditorConflictState = {
  /** 冲突代次：外部版本读取/采用操作的轮次，晚到结果不得覆盖新一轮 */
  generation: number
  /** 外部版本读取在途（「正在检查另一版本」，不能暂时退回「已保存」） */
  probing: boolean
  /** 「采用 AI 版本」确认在途：用户离开确认（返回编辑/切走）即中止，晚到不得清内容 */
  adoptingDisk?: boolean
  /** 磁盘最新版本（读取成功时；比较时以点击处理时刻的最新读取为准） */
  disk?: { content: string; updatedAt?: string }
  /** 文件确实不存在（读取失败另行保留原因，不伪装成已删除） */
  missing: boolean
  /** 磁盘读取失败原因 */
  unreadable?: string
  /** 版本比较区是否展开（用户主动打开；切走返回保留再入口） */
  expanded: boolean
}

export type EditorGuardState = {
  kind: 'deleted' | 'renamed'
  /** renamed：新路径 */
  toPath?: string
  /** deleted：回收站去向 */
  trashPath?: string
}

export type EditorSession = {
  projectId: string
  path: string
  /** 草稿起源路径（重命名迁移前的旧路径；未迁移时缺省） */
  originPath?: string
  /** 最新人工输入 */
  content: string
  /** 编辑基线：开始编辑时的磁盘正文 */
  baseContent: string
  /** 编辑基线的磁盘版本（updatedAt） */
  baseUpdatedAt?: string
  /** 在途写盘快照（null = 不在途） */
  inFlight: { content: string; baseUpdatedAt?: string; baseHash: string } | null
  /** 普通写入失败原因（存在即 failed；冲突不算失败） */
  failure?: { message: string }
  /** 冲突状态（存在即 conflict） */
  conflict?: EditorConflictState
  /** 删除/重命名守护（存在即 guard） */
  guard?: EditorGuardState
  /** 恢复镜像已回填、待版本校验（恢复核对磁盘见 restoreEditorSessions） */
  restoredPending: boolean
  /** 恢复提示已被知悉（横幅消失标记） */
  restoredAcked: boolean
  /** 会话最后活动时间（ISO） */
  updatedAt: string
}

export type EditorSaveHandler = (
  path: string,
  content: string,
  options?: {
    projectId?: string
    expectedUpdatedAt?: string
    expectedBaseHash?: string
    force?: boolean
  },
) => Promise<SaveFileOutcome>

export type EditorProbeResult =
  | { kind: 'ok'; file: FileContentView }
  | { kind: 'missing' }
  | { kind: 'unreadable'; message: string }

export type EditorProbeHandler = (
  path: string,
  projectId?: string,
) => Promise<EditorProbeResult>

// ---------- 会话存储 ----------

/** 会话键：项目 + 路径无歧义编码（不同项目可有相同章节路径） */
export function editorSessionKey(projectId: string, path: string): string {
  return JSON.stringify([projectId, path])
}

/** 正文领域的磁盘版本形状（引擎视角不透明） */
type EditorDisk = { content: string; updatedAt?: string }
/** 正文领域快照：整份正文内容 */
type EditorSnapshot = { content: string }

function toDisk(file: FileContentView): EditorDisk {
  return {
    content: file.content,
    ...(file.updatedAt !== undefined ? { updatedAt: file.updatedAt } : {}),
  }
}

/** 保存服务（projectStore.saveFile 的注入形态；ProjectView 注册） */
let saveHandler: EditorSaveHandler | null = null
/** 外部版本读取服务（projectStore.probeFile 的注入形态） */
let probeHandler: EditorProbeHandler | null = null

export function setEditorSaveHandler(handler: EditorSaveHandler | null): void {
  saveHandler = handler
}

export function setEditorProbeHandler(handler: EditorProbeHandler | null): void {
  probeHandler = handler
}

/** 当前注册的保存/探测服务（ProjectView 卸载时比对「还是不是自己注册的」再注销，防快速往返竞态） */
export function getEditorSaveHandler(): EditorSaveHandler | null {
  return saveHandler
}

export function getEditorProbeHandler(): EditorProbeHandler | null {
  return probeHandler
}

const editorAdapter: SaveSessionAdapter<EditorSession, EditorSnapshot, EditorDisk> = {
  isSameSnapshot: (a, b) => a.content === b.content,
  getSnapshot: (session) => ({ content: session.content }),
  setSnapshot: (session, snapshot) => {
    session.content = snapshot.content
  },
  getBaseSnapshot: (session) => ({ content: session.baseContent }),
  setBaseSnapshot: (session, snapshot) => {
    session.baseContent = snapshot.content
  },
  getBaseVersion: (session) => session.baseUpdatedAt,
  setBaseVersion: (session, version) => {
    session.baseUpdatedAt = version
  },
  captureInFlight: (_session, captured) => ({
    content: captured.snapshot.content,
    ...(captured.baseVersion !== undefined ? { baseUpdatedAt: captured.baseVersion } : {}),
    baseHash: hashContent(captured.baseSnapshot.content),
  }),
  releaseInFlight: (session, captured) => {
    if (session.inFlight?.content === captured.snapshot.content) {
      session.inFlight = null
    }
  },
  createSession: (projectId, path, seed) => ({
    projectId,
    path,
    content: seed.snapshot.content,
    baseContent: seed.baseSnapshot.content,
    ...(seed.baseVersion !== undefined ? { baseUpdatedAt: seed.baseVersion } : {}),
    ...(seed.originKey !== undefined ? { originPath: seed.originKey } : {}),
    inFlight: null,
    restoredPending: false,
    restoredAcked: false,
    updatedAt: seed.updatedAt ?? new Date().toISOString(),
  }),
  upsertSession: (session, data) => {
    session.content = data.snapshot.content
    session.baseContent = data.baseSnapshot.content
    if (data.originKey !== undefined) {
      session.originPath = data.originKey
    }
  },
  onSessionKeyChange: (session, fromKey, toKey) => {
    session.path = toKey
    session.originPath = session.originPath ?? fromKey
    delete session.guard
  },
  save: async (projectId, path, snapshot, context) => {
    if (!saveHandler) {
      throw new SaveServiceUnavailableError('会话不存在或未注册保存服务')
    }
    const outcome = await saveHandler(path, snapshot.content, {
      projectId,
      ...(context.force
        ? { force: true }
        : {
            ...(context.baseVersion !== undefined ? { expectedUpdatedAt: context.baseVersion } : {}),
            expectedBaseHash: hashContent(context.base.content),
          }),
    })
    if (outcome.ok) {
      return { ok: true, disk: toDisk(outcome.file) }
    }
    return { ok: false, conflict: outcome.conflict, message: outcome.message }
  },
  probe: async (projectId, path) => {
    if (!probeHandler) {
      throw new SaveServiceUnavailableError('未注册外部版本读取服务')
    }
    const probe = await probeHandler(path, projectId)
    if (probe.kind === 'ok') {
      return { kind: 'ok', disk: toDisk(probe.file) }
    }
    return probe
  },
  versionOf: (disk) => disk.updatedAt,
  snapshotFromDisk: (disk) => ({ content: disk.content }),
  scheduleMirror: (session) => {
    scheduleDraftBackup(session.projectId, session.path, {
      content: session.content,
      baseContent: session.baseContent,
      ...(session.originPath !== undefined ? { originPath: session.originPath } : {}),
    })
  },
  removeMirror: (projectId, path) => {
    removeDraftBackup(projectId, path)
  },
}

const realm = createSaveSessionRealm<EditorSession, EditorSnapshot, EditorDisk>(editorAdapter)

/** 取某「项目 + 路径」的会话（组件展示与保存编排的入口；无会话返回 undefined） */
export function getEditorSession(projectId: string, path: string): EditorSession | undefined {
  return realm.getSession(projectId, path)
}

/** 项目内全部会话（离开提醒、恢复提示与守护扫描用） */
export function listEditorSessions(projectId: string): EditorSession[] {
  return realm.listSessions(projectId)
}

/** 会话当前所处阶段（固定状态；派生值，不落盘） */
export function editorSessionPhase(session: EditorSession): EditorSessionPhase {
  return realm.phaseOf(session)
}

/** 某会话是否有未落盘的人工内容（待写/在途输入；不含失败与冲突标记本身） */
export function isEditorSessionDirty(session: EditorSession): boolean {
  return realm.isDirty(session)
}

/**
 * 是否需要离开提醒：有待写、在途、失败、冲突、恢复未校验或守护
 * 未处理内容时提醒继续存在；正常自动保存完成后不因短暂编辑历史提醒。
 */
export function editorSessionNeedsLeaveGuard(session: EditorSession): boolean {
  return realm.needsLeaveGuard(session)
}

/** 建立会话（进入编辑模式时以磁盘内容为基线）；已存在则保留原会话（草稿不丢） */
export function openEditorSession(
  projectId: string,
  path: string,
  diskContent: string,
  diskUpdatedAt?: string,
): EditorSession {
  return realm.openSession(projectId, path, {
    snapshot: { content: diskContent },
    baseSnapshot: { content: diskContent },
    ...(diskUpdatedAt !== undefined ? { baseVersion: diskUpdatedAt } : {}),
  })
}

/** 清除会话（放弃更改、采用磁盘版本后）：同步删除恢复镜像记录 */
export function clearEditorSession(projectId: string, path: string): void {
  realm.clearSession(projectId, path)
}

/**
 * 人工输入（编辑模式每次改动调用）：更新最新输入、重置该文件的自动保存去抖；
 * 输入实时进入恢复镜像（镜像保持自己的去抖策略，不以正文写盘替代）。
 * 输入与基线一致时会话收敛为 clean 并清掉镜像记录（无未落盘内容）。
 */
export function setEditorInput(projectId: string, path: string, content: string): void {
  realm.setInput(projectId, path, { content })
}

/** 外部重定会话数据（迁移/恢复/rebase 兼容路径）：不触发保存编排，但同步恢复镜像 */
export function upsertEditorSessionData(
  projectId: string,
  path: string,
  data: { content: string; baseContent: string; originPath?: string },
): void {
  realm.upsertSessionData(projectId, path, {
    snapshot: { content: data.content },
    baseSnapshot: { content: data.baseContent },
    ...(data.originPath !== undefined ? { originKey: data.originPath } : {}),
  })
}

/**
 * 同路径磁盘版本更新（保存回写 / 外部修改重读）到达时重定基线：
 * 会话 clean（无待写、不在途、无冲突/守护）时跟随最新磁盘版本；
 * 有待写内容时不覆盖基线——保存时由版本 + 内容哈希校验判定。
 */
export function rebaseCleanSessionBaseline(
  projectId: string,
  path: string,
  diskContent: string,
  diskUpdatedAt?: string,
): void {
  realm.rebaseCleanBaseline(projectId, path, {
    content: diskContent,
    ...(diskUpdatedAt !== undefined ? { updatedAt: diskUpdatedAt } : {}),
  })
}

/** 把会话迁移到新路径（重命名守护「迁移草稿」）：保留起源路径与冲突；守护随迁移解除 */
export function migrateEditorSession(projectId: string, fromPath: string, toPath: string): void {
  realm.migrateSession(projectId, fromPath, toPath)
}

/** 项目内当前处于删除/重命名守护的会话（ProjectView 守护动作入口用） */
export function getGuardedEditorSession(projectId: string): EditorSession | undefined {
  return realm.getGuardedSession(projectId)
}

/** 置入删除/重命名守护（AI 改动有人工内容的文件时由 ProjectView 调用）；无会话则忽略 */
export function setEditorGuard(
  projectId: string,
  path: string,
  guard: EditorGuardState | null,
): void {
  realm.setGuard(projectId, path, guard)
}

/**
 * 请求保存（手动触发 / 收口 / 去抖共用入口）：
 * - 无会话、无待写内容、守护或冲突未解决时不写（冲突的「采用我的当前内容」
 *   走 overwriteEditorContent 强写出口，不经此处）；
 * - 写盘在途时按同键串行排队，前一个完成后以最新输入再执行；
 * - 快照在开始时固定（内容 + 基线版本 + 基线内容哈希），结果只作用于该会话。
 */
export async function requestEditorSave(
  projectId: string,
  path: string,
  options?: { trigger?: 'manual' | 'debounce' | 'flush' },
): Promise<void> {
  await realm.requestSave(projectId, path, options)
}

/**
 * 等待该键在途与排队的写盘全部完成（不发起保存；确认复检用）：
 * 自动保存可能恰好在确认审阅期间落盘，复检必须等写盘出结果后再给出
 * 候选是否仍可安全同意的结论，不能拿在途瞬间的旧状态判定。
 */
export function settleEditorSave(projectId: string, path: string): Promise<void> {
  return realm.settleSave(projectId, path)
}

/**
 * AI 写盘到达时冻结有未落盘内容的会话（非阻塞冲突）：
 * 有待写内容的会话置冲突并读取外部版本（不展开比较、不清输入、不切预览——
 * 紧凑状态条通知用户主动处理）；自动保存随之冻结。
 * 无会话或无待写内容返回 'none'/'clean'（clean 会话由 rebase 跟随磁盘）；
 * 守护未决时不动（守护优先于冲突）；已有冲突时按新代次重读磁盘快照。
 *
 * 返回值区分两种冲突结果：'conflict' = 本次首次建立冲突（调用方可给一次反馈）；
 * 'conflict-refresh' = 该会话此前已在冲突中、本次只是刷新磁盘快照（同一冲突的
 * 后续 AI 修改，调用方应抑制重复 toast/通知）。
 */
export function freezeEditorSessionForExternal(
  projectId: string,
  path: string,
): Promise<'conflict' | 'conflict-refresh' | 'clean' | 'none'> {
  return realm.freezeForExternal(projectId, path)
}

/** 用户主动展开比较（再入口）：重新读取磁盘最新 + 最新人工输入并列 */
export function expandEditorConflict(projectId: string, path: string): Promise<void> {
  return realm.expandConflict(projectId, path)
}

/** 返回继续编辑：收起比较、保留冲突与输入（再入口保留）；在途的「采用 AI 版本」随之中止 */
export function collapseEditorConflict(projectId: string, path: string): void {
  realm.collapseConflict(projectId, path)
}

/** 冲突解决出口之一：采用磁盘（AI）版本——重新读取成功后才放弃人工内容（二次确认在 UI 层） */
export function adoptDiskInEditor(
  projectId: string,
  path: string,
): Promise<'resolved' | 'probe-failed' | 'aborted'> {
  return realm.adoptDisk(projectId, path)
}

/**
 * 冲突解决出口之一：采用我的当前内容——整份覆盖磁盘（二次确认在 UI 层）。
 * 等待期间的新输入按新基线保留；采用完成后若仍有未落盘输入，冲突保留
 * （不把不同版本混称为「已保存」）；晚到的旧采用结果不得清掉新输入或新冲突。
 */
export function overwriteEditorContent(
  projectId: string,
  path: string,
): Promise<{ ok: boolean; message?: string }> {
  return realm.overwriteContent(projectId, path)
}

// ---------- 输入去抖与收口 ----------

/** 输入后自动保存去抖窗口（固定取舍：最后一次输入后 2000ms） */
export const EDITOR_AUTOSAVE_DEBOUNCE_MS = SAVE_SESSION_AUTOSAVE_DEBOUNCE_MS

/** 失败后自动补试延迟 */
export const EDITOR_SAVE_RETRY_DELAY_MS = SAVE_SESSION_RETRY_DELAY_MS

/** 打开/关闭输入自动保存触发 */
export function setAutosaveInputEnabled(enabled: boolean): void {
  realm.setAutosaveInputEnabled(enabled)
}

/** 立即收口某会话（切文件/分类/项目、关面板、切预览等关键时机） */
export async function flushEditorSession(projectId: string, path: string): Promise<void> {
  await realm.flushSession(projectId, path)
}

/** 项目内全部有待写内容的会话立即收口（离开项目视图等） */
export function flushEditorSessions(projectId: string): Promise<void> {
  return realm.flushSessions(projectId)
}

/**
 * 全部项目的待写会话立即收口（页面隐藏/关闭、离开项目视图）：
 * 写盘来不及完成时恢复镜像仍在（draft-backup 独立落盘），离开提醒不谎报。
 */
export function flushAllEditorSessions(): Promise<void> {
  return realm.flushAllSessions()
}

/**
 * 生命周期挂接：页面隐藏/关闭前立即尝试收口全部待写会话。
 * 与 draft-backup 的镜像落盘各自独立——正文写盘失败不拖累镜像，镜像也不替代写盘。
 * 返回退订函数。
 */
export function setupEditorAutosaveLifecycle(): () => void {
  return realm.setupLifecycle()
}

// ---------- 恢复镜像回填 ----------

export type RestoredEditorReport = {
  projectId: string
  /** 磁盘与恢复基线一致（或无法核对）：自动续存，待写内容由自动保存落盘 */
  restored: Array<{ path: string; originPath?: string; updatedAt: string }>
  /** 恢复内容已与磁盘一致：冗余记录已清理，不回填 */
  discarded: Array<{ path: string }>
  /** 磁盘已被修改且不等于基线：回填并建立版本冲突（非阻塞紧凑态） */
  conflicted: Array<{ path: string }>
  /** 原路径已不在磁盘：回填并进入删除守护（不自动复活原文件） */
  guarded: Array<{ path: string }>
}

/**
 * 重新进入项目时从恢复镜像回填会话（存量恢复迁移）：
 * 只回填尚无有效会话的路径（同页会话比备份新，不回退）；回填不触发正文写盘。
 * 恢复时逐文件读取磁盘核对：内容与磁盘一致清冗余记录；磁盘与基线一致才自动
 * 续存；不一致建立版本冲突；原路径已删除进入删除守护；读取失败（或读取服务
 * 未注册）按「有人工内容、待校验」回填（restoredPending），不能因字段缺失
 * 或核对失败丢弃，也不以空值覆盖。
 */
export async function restoreEditorSessions(
  projectId: string,
  records: Array<{ path: string; content: string; baseContent: string; originPath?: string; updatedAt: string }>,
): Promise<RestoredEditorReport> {
  const report = await realm.restoreSessions(
    projectId,
    records.map((record) => ({
      key: record.path,
      snapshot: { content: record.content },
      baseSnapshot: { content: record.baseContent },
      ...(record.originPath !== undefined ? { originKey: record.originPath } : {}),
      updatedAt: record.updatedAt,
    })),
  )
  return {
    projectId: report.projectId,
    restored: report.restored.map((item) => ({
      path: item.key,
      ...(item.originKey !== undefined ? { originPath: item.originKey } : {}),
      updatedAt: item.updatedAt,
    })),
    discarded: report.discarded.map((item) => ({ path: item.key })),
    conflicted: report.conflicted.map((item) => ({ path: item.key })),
    guarded: report.guarded.map((item) => ({ path: item.key })),
  }
}

/** 恢复提示已被知悉（横幅关闭） */
export function acknowledgeRestoredEditor(projectId: string, path: string): void {
  realm.acknowledgeRestored(projectId, path)
}

// ---------- 测试注入口 ----------

/** 测试专用：清空全部会话与编排状态 */
export function _resetEditorSessionsForTest(): void {
  realm.resetForTest()
}

/** 测试专用：等待同键写盘链排空（受控 Promise 事件序断言用） */
export function _waitForEditorSaveChain(projectId: string, path: string): Promise<void> {
  return realm.waitForSaveChain(projectId, path)
}
