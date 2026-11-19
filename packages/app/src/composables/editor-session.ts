/**
 * 编辑器会话状态机（正文自动保存与并发冲突交互重设计计划 §四）：
 * 按「项目 + 路径」把人工编辑、保存编排与冲突/守护状态收敛到可独立测试的会话模块，
 * 组件只负责展示与发送用户操作——不再在组件监听器、草稿表和保存回调里分别拼状态。
 *
 * 会话记录（§四.1）：最新人工输入、编辑基线（开始编辑时的磁盘正文与版本）、
 * 在途写盘快照、失败原因、已感知的外部版本（冲突代次）、删除/重命名守护、
 * 恢复镜像回填标记。IndexedDB 草稿备份（draft-backup）是会话的**未落盘恢复镜像**，
 * 权威正文仍是项目磁盘；内存会话保存运行期最新输入。
 *
 * 写盘编排（§四.3）：同键串行（写盘期间的新输入不清除、不回滚；旧写盘完成只承认
 * 其快照，再按新基线处理剩余输入）；保存绑定固定项目与路径，结果只作用于该会话；
 * 冲突与守护在写盘前再次检查；core 写入口的磁盘版本 + 基线内容哈希校验是最终防线。
 *
 * 阶段 1 只接入手动触发（保存按钮 / Ctrl+S / 重试）；输入去抖与生命周期收口
 * （阶段 2）通过 enableAutosaveInput 打开。冲突交互的非阻塞化在阶段 3。
 */
import { reactive } from 'vue'
import { hashContent } from '@novai/core'
import type { FileContentView } from '@novai/core/services/types'
import type { SaveFileOutcome } from '../stores/project'
import { removeDraftBackup, scheduleDraftBackup } from './draft-backup'

export type EditorSessionPhase =
  | 'clean' // 无待写内容（已保存）
  | 'pending' // 有待写内容（等待保存；阶段 2 起等待去抖）
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
  /** 恢复镜像已回填、待版本校验 */
  restoredPending: boolean
  /** 恢复提示已被知悉（横幅消失标记；版本校验在阶段 4 接入） */
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

const sessions = reactive(new Map<string, EditorSession>())

function touchTime(): string {
  return new Date().toISOString()
}

function getSession(projectId: string, path: string): EditorSession | undefined {
  return sessions.get(editorSessionKey(projectId, path))
}

/** 取某「项目 + 路径」的会话（组件展示与保存编排的入口；无会话返回 undefined） */
export function getEditorSession(projectId: string, path: string): EditorSession | undefined {
  return getSession(projectId, path)
}

/** 项目内全部会话（离开提醒、恢复提示与守护扫描用） */
export function listEditorSessions(projectId: string): EditorSession[] {
  return [...sessions.values()].filter((session) => session.projectId === projectId)
}

/** 会话当前所处阶段（§四.2 固定状态；派生值，不落盘） */
export function editorSessionPhase(session: EditorSession): EditorSessionPhase {
  if (session.guard) return 'guard'
  if (session.conflict) return 'conflict'
  if (session.inFlight) return 'saving'
  if (session.failure) return 'failed'
  if (session.restoredPending) return 'restored'
  return session.content !== session.baseContent ? 'pending' : 'clean'
}

/** 某会话是否有未落盘的人工内容（待写/在途输入；不含失败与冲突标记本身） */
export function isEditorSessionDirty(session: EditorSession): boolean {
  return session.content !== session.baseContent
}

/**
 * 是否需要离开提醒（§六.3）：有待写、在途、失败、冲突、恢复未校验或守护
 * 未处理内容时提醒继续存在；正常自动保存完成后不因短暂编辑历史提醒。
 */
export function editorSessionNeedsLeaveGuard(session: EditorSession): boolean {
  return editorSessionPhase(session) !== 'clean'
}

/** 建立会话（进入编辑模式时以磁盘内容为基线）；已存在则保留原会话（草稿不丢） */
export function openEditorSession(
  projectId: string,
  path: string,
  diskContent: string,
  diskUpdatedAt?: string,
): EditorSession {
  const key = editorSessionKey(projectId, path)
  const existing = sessions.get(key)
  if (existing) {
    return existing
  }
  const session: EditorSession = reactive({
    projectId,
    path,
    content: diskContent,
    baseContent: diskContent,
    ...(diskUpdatedAt !== undefined ? { baseUpdatedAt: diskUpdatedAt } : {}),
    inFlight: null,
    restoredPending: false,
    restoredAcked: false,
    updatedAt: touchTime(),
  })
  sessions.set(key, session)
  return session
}

/** 清除会话（放弃更改、采用磁盘版本后）：同步删除恢复镜像记录 */
export function clearEditorSession(projectId: string, path: string): void {
  const key = editorSessionKey(projectId, path)
  const session = sessions.get(key)
  sessions.delete(key)
  cancelAutosaveTimer(key)
  if (session) {
    removeDraftBackup(projectId, path)
  }
}

/**
 * 人工输入（编辑模式每次改动调用）：更新最新输入、重置该文件的自动保存去抖；
 * 输入实时进入恢复镜像（镜像保持自己的去抖策略，不以正文写盘替代）。
 * 输入与基线一致时会话收敛为 clean 并清掉镜像记录（无未落盘内容）。
 */
export function setEditorInput(projectId: string, path: string, content: string): void {
  const session = getSession(projectId, path)
  if (!session) {
    return
  }
  session.content = content
  session.updatedAt = touchTime()
  if (session.guard || session.conflict) {
    // 守护/冲突期间继续输入只更新内容与镜像，不安排自动写入（禁止自动写入）
    scheduleSessionMirror(session)
    return
  }
  if (content === session.baseContent) {
    removeDraftBackup(projectId, path)
    return
  }
  scheduleSessionMirror(session)
  scheduleAutosave(projectId, path)
}

function scheduleSessionMirror(session: EditorSession): void {
  scheduleDraftBackup(session.projectId, session.path, {
    content: session.content,
    baseContent: session.baseContent,
    ...(session.originPath !== undefined ? { originPath: session.originPath } : {}),
  })
}

/** 外部重定会话数据（迁移/恢复/rebase 兼容路径）：不触发保存编排，但同步恢复镜像 */
export function upsertEditorSessionData(
  projectId: string,
  path: string,
  data: { content: string; baseContent: string; originPath?: string },
): void {
  const key = editorSessionKey(projectId, path)
  const existing = sessions.get(key)
  if (existing) {
    existing.content = data.content
    existing.baseContent = data.baseContent
    if (data.originPath !== undefined) {
      existing.originPath = data.originPath
    }
    existing.updatedAt = touchTime()
    if (data.content !== data.baseContent) {
      scheduleSessionMirror(existing)
    }
    return
  }
  const created = reactive({
    projectId,
    path,
    content: data.content,
    baseContent: data.baseContent,
    ...(data.originPath !== undefined ? { originPath: data.originPath } : {}),
    inFlight: null,
    restoredPending: false,
    restoredAcked: false,
    updatedAt: touchTime(),
  })
  sessions.set(key, created)
  if (data.content !== data.baseContent) {
    scheduleSessionMirror(created)
  }
}

/**
 * 同路径磁盘版本更新（保存回写 / 外部修改重读）到达时重定基线：
 * 会话 clean（无待写、不在途、无冲突/守护）时跟随最新磁盘版本；
 * 有待写内容时不覆盖基线——保存时由版本 + 内容哈希校验判定，冲突在阶段 3 冻结。
 */
export function rebaseCleanSessionBaseline(
  projectId: string,
  path: string,
  diskContent: string,
  diskUpdatedAt?: string,
): void {
  const session = getSession(projectId, path)
  if (!session || session.inFlight || session.conflict || session.guard) {
    return
  }
  if (session.content !== session.baseContent) {
    return
  }
  session.content = diskContent
  session.baseContent = diskContent
  if (diskUpdatedAt !== undefined) {
    session.baseUpdatedAt = diskUpdatedAt
  }
  session.updatedAt = touchTime()
}

/** 把会话迁移到新路径（重命名守护「迁移草稿」）：保留起源路径与冲突；守护随迁移解除 */
export function migrateEditorSession(projectId: string, fromPath: string, toPath: string): void {
  const fromKey = editorSessionKey(projectId, fromPath)
  const session = sessions.get(fromKey)
  if (!session) {
    return
  }
  sessions.delete(fromKey)
  cancelAutosaveTimer(fromKey)
  session.path = toPath
  session.originPath = session.originPath ?? fromPath
  delete session.guard
  session.updatedAt = touchTime()
  sessions.set(editorSessionKey(projectId, toPath), session)
  removeDraftBackup(projectId, fromPath)
  scheduleSessionMirror(session)
}

/** 项目内当前处于删除/重命名守护的会话（ProjectView 守护动作入口用） */
export function getGuardedEditorSession(projectId: string): EditorSession | undefined {
  return listEditorSessions(projectId).find((session) => session.guard !== undefined)
}

/** 置入删除/重命名守护（AI 改动有人工内容的文件时由 ProjectView 调用）；无会话则忽略 */
export function setEditorGuard(
  projectId: string,
  path: string,
  guard: EditorGuardState | null,
): void {
  const session = getSession(projectId, path)
  if (!session) {
    return
  }
  if (guard) {
    session.guard = guard
    cancelAutosaveTimer(editorSessionKey(projectId, path))
  } else {
    delete session.guard
  }
  session.updatedAt = touchTime()
}

// ---------- 保存编排（同键串行） ----------

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

/** 同一会话的写盘请求串行：后到请求等前一个完成后按最新状态执行 */
const saveChains = new Map<string, Promise<void>>()

function enqueueSaveWork(key: string, work: () => Promise<void>): Promise<void> {
  const previous = saveChains.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(work)
  saveChains.set(key, run)
  const cleanup = () => {
    if (saveChains.get(key) === run) {
      saveChains.delete(key)
    }
  }
  void run.then(cleanup, cleanup)
  return run
}

/**
 * 请求保存（手动触发 / 收口 / 去抖共用入口）：
 * - 无会话、无待写内容、守护或冲突未解决时不写（冲突的「采用我的当前内容」
 *   走 overwriteEditorContent 强写出口，不经此处）；
 * - 写盘在途时按同键串行排队，前一个完成后以最新输入再执行；
 * - 快照在开始时固定（内容 + 基线版本 + 基线内容哈希），结果只作用于该会话。
 */
export function requestEditorSave(
  projectId: string,
  path: string,
  options?: { trigger?: 'manual' | 'debounce' | 'flush' },
): Promise<void> {
  const trigger = options?.trigger ?? 'manual'
  const key = editorSessionKey(projectId, path)
  return enqueueSaveWork(key, () => performSave(projectId, path, { trigger, force: false }))
}

async function performSave(
  projectId: string,
  path: string,
  options: { trigger: 'manual' | 'debounce' | 'flush'; force: boolean },
): Promise<void> {
  const session = getSession(projectId, path)
  if (!session || !saveHandler) {
    return
  }
  // 冲突与守护在写盘前再次检查（不能只靠提示出现时的状态）：
  // 守护未选择前去向禁止任何写入；冲突只禁止自动写入（去抖/收口），
  // 手动触发是用户明确选择（会再次撞版本校验并回到比较界面）。
  if (session.guard) {
    return
  }
  if (session.conflict && options.trigger !== 'manual') {
    return
  }
  if (!options.force && session.content === session.baseContent) {
    // 无待写内容；在途失败态不因无内容请求清除（由重试/新输入重新触发）
    return
  }

  const snapshot = {
    content: session.content,
    baseUpdatedAt: session.baseUpdatedAt,
    baseHash: hashContent(session.baseContent),
  }
  session.inFlight = { ...snapshot }
  delete session.failure

  let outcome: SaveFileOutcome
  try {
    outcome = await saveHandler(path, snapshot.content, {
      projectId,
      ...(options.force
        ? { force: true }
        : {
            ...(snapshot.baseUpdatedAt !== undefined ? { expectedUpdatedAt: snapshot.baseUpdatedAt } : {}),
            expectedBaseHash: snapshot.baseHash,
          }),
    })
  } catch (error) {
    // 保存服务异常按普通失败处理（内容与位置保留，原因持续可见）
    session.inFlight = null
    session.failure = { message: error instanceof Error ? error.message : String(error) }
    return
  }

  // 结果处理全部作用于固定归属的会话（projectId + path），与当前界面显示哪个文件无关
  if (session.inFlight?.content === snapshot.content) {
    session.inFlight = null
  }

  if (outcome.ok) {
    applySaveSuccess(session, outcome.file)
    return
  }

  if (outcome.conflict) {
    await enterConflictFromSave(projectId, path, session)
    return
  }

  session.failure = { message: outcome.message }
}

/**
 * 写盘成功（§四.3 / §五.1）：只承认本次快照已落盘——
 * - 会话内容与落盘内容一致：待写清空，基线换到刚落盘的版本，镜像清除；
 * - 写盘期间有新输入：新输入保留为待写，基线 rebase 到刚落盘内容，镜像重定基线；
 * - 冲突不因旧写晚到成功而解除（在途期间到达的外部版本仍待用户处理）。
 */
function applySaveSuccess(session: EditorSession, saved: FileContentView): void {
  session.baseContent = saved.content
  if (saved.updatedAt !== undefined) {
    session.baseUpdatedAt = saved.updatedAt
  }
  if (session.content === saved.content) {
    removeDraftBackup(session.projectId, session.path)
  } else {
    scheduleSessionMirror(session)
  }
  session.updatedAt = touchTime()
}

/** 保存结果判定为冲突：读取外部版本并登记冲突（不自动展开、不清输入） */
async function enterConflictFromSave(projectId: string, path: string, session: EditorSession): Promise<void> {
  const generation = (session.conflict?.generation ?? 0) + 1
  session.conflict = {
    generation,
    probing: true,
    missing: false,
    expanded: session.conflict?.expanded ?? true,
  }
  session.updatedAt = touchTime()
  await probeExternalVersion(projectId, path, session, generation)
}

/**
 * 读取磁盘外部版本到冲突状态（比较/采用前的最新读取）：
 * 读取失败只说明无法读取另一版本（unreadable），不伪装成文件已删除。
 */
async function probeExternalVersion(
  projectId: string,
  path: string,
  session: EditorSession,
  generation: number,
): Promise<void> {
  if (!probeHandler) {
    if (session.conflict && session.conflict.generation === generation) {
      session.conflict.probing = false
      session.conflict.unreadable = '未注册外部版本读取服务'
    }
    return
  }
  const probe = await probeHandler(path, projectId)
  const conflict = session.conflict
  if (!conflict || conflict.generation !== generation) {
    return
  }
  conflict.probing = false
  if (probe.kind === 'ok') {
    conflict.disk = {
      content: probe.file.content,
      ...(probe.file.updatedAt !== undefined ? { updatedAt: probe.file.updatedAt } : {}),
    }
    conflict.missing = false
    delete conflict.unreadable
    return
  }
  if (probe.kind === 'missing') {
    conflict.missing = true
    delete conflict.disk
    delete conflict.unreadable
    return
  }
  conflict.missing = false
  conflict.unreadable = probe.message
  // 读取失败时旧的磁盘快照必须作废：采用磁盘版本绝不能拿着上一轮的旧读取清稿
  delete conflict.disk
}

/** 用户主动展开比较（再入口）：重新读取磁盘最新 + 最新人工输入并列（阶段 3 接 UI） */
export async function expandEditorConflict(projectId: string, path: string): Promise<void> {
  const session = getSession(projectId, path)
  if (!session?.conflict) {
    return
  }
  const generation = session.conflict.generation + 1
  session.conflict.generation = generation
  session.conflict.probing = true
  session.conflict.expanded = true
  await probeExternalVersion(projectId, path, session, generation)
}

/** 返回继续编辑：收起比较、保留冲突与输入（再入口保留）；在途的「采用 AI 版本」随之中止 */
export function collapseEditorConflict(projectId: string, path: string): void {
  const session = getSession(projectId, path)
  if (session?.conflict) {
    session.conflict.expanded = false
    session.conflict.adoptingDisk = false
  }
}

/** 冲突解决出口之一：采用磁盘（AI）版本——重新读取成功后才放弃人工内容（二次确认在 UI 层） */
export async function adoptDiskInEditor(
  projectId: string,
  path: string,
): Promise<'resolved' | 'probe-failed' | 'aborted'> {
  const session = getSession(projectId, path)
  if (!session?.conflict || !probeHandler) {
    return 'probe-failed'
  }
  const generation = session.conflict.generation + 1
  session.conflict.generation = generation
  session.conflict.adoptingDisk = true
  await probeExternalVersion(projectId, path, session, generation)
  const conflict = session.conflict
  if (!conflict || conflict.generation !== generation || conflict.probing || !conflict.disk) {
    // 读取失败/文件缺失：绝不先删内容，冲突保留并呈现最新探测结果
    conflict && (conflict.expanded = true)
    return 'probe-failed'
  }
  if (!conflict.adoptingDisk) {
    // 复检在途时用户已离开确认（返回编辑/切走）：晚到结果不得清掉继续输入的内容
    return 'aborted'
  }
  delete conflict.adoptingDisk
  clearEditorSession(projectId, path)
  return 'resolved'
}

/**
 * 冲突解决出口之一：采用我的当前内容——整份覆盖磁盘（二次确认在 UI 层）。
 * 等待期间的新输入按新基线保留；采用完成后若仍有未落盘输入，冲突保留
 * （不把不同版本混称为「已保存」）；晚到的旧采用结果不得清掉新输入或新冲突。
 */
export async function overwriteEditorContent(
  projectId: string,
  path: string,
): Promise<{ ok: boolean; message?: string }> {
  const session = getSession(projectId, path)
  if (!session || !saveHandler) {
    return { ok: false, message: '会话不存在或未注册保存服务' }
  }
  const outcome = await saveHandler(path, session.content, { force: true, projectId })
  const current = getSession(projectId, path)
  if (!current || current !== session) {
    // 会话已被清除/迁移：结果不再修改现场（副本归属核对）
    return { ok: outcome.ok, ...(outcome.ok ? {} : { message: outcome.message }) }
  }
  if (outcome.ok) {
    applySaveSuccess(session, outcome.file)
    if (session.content === session.baseContent && session.conflict) {
      // 全部落盘：本次采用解决了冲突
      delete session.conflict
    }
    delete session.failure
    return { ok: true }
  }
  if (outcome.conflict) {
    await enterConflictFromSave(projectId, path, session)
    return { ok: false, message: outcome.message }
  }
  session.failure = { message: outcome.message }
  return { ok: false, message: outcome.message }
}

// ---------- 输入去抖与收口（阶段 2 打开） ----------

/** 输入后自动保存去抖窗口（§二.2 固定取舍：最后一次输入后 2000ms） */
export const EDITOR_AUTOSAVE_DEBOUNCE_MS = 2000

let autosaveInputEnabled = false

/** 打开/关闭输入自动保存触发（阶段 1 仅手动；阶段 2 接入后打开） */
export function setAutosaveInputEnabled(enabled: boolean): void {
  autosaveInputEnabled = enabled
  if (!enabled) {
    for (const key of autosaveTimers.keys()) {
      cancelAutosaveTimer(key)
    }
  }
}

const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleAutosave(projectId: string, path: string): void {
  if (!autosaveInputEnabled) {
    return
  }
  const key = editorSessionKey(projectId, path)
  const existing = autosaveTimers.get(key)
  if (existing) {
    clearTimeout(existing)
  }
  autosaveTimers.set(
    key,
    setTimeout(() => {
      autosaveTimers.delete(key)
      void requestEditorSave(projectId, path, { trigger: 'debounce' })
    }, EDITOR_AUTOSAVE_DEBOUNCE_MS),
  )
}

function cancelAutosaveTimer(key: string): void {
  const timer = autosaveTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    autosaveTimers.delete(key)
  }
}

/** 立即收口某会话（切文件/分类/项目、关面板、切预览等关键时机） */
export function flushEditorSession(projectId: string, path: string): Promise<void> {
  cancelAutosaveTimer(editorSessionKey(projectId, path))
  return requestEditorSave(projectId, path, { trigger: 'flush' })
}

/** 项目内全部有待写内容的会话立即收口（离开项目视图等） */
export async function flushEditorSessions(projectId: string): Promise<void> {
  const targets = [...sessions.values()].filter(
    (session) => session.projectId === projectId && isEditorSessionDirty(session),
  )
  await Promise.all(targets.map((session) => flushEditorSession(projectId, session.path)))
}

// ---------- 恢复镜像回填 ----------

export type RestoredEditorReport = {
  projectId: string
  restored: Array<{ path: string; originPath?: string; updatedAt: string }>
}

/**
 * 重新进入项目时从恢复镜像回填会话（§六.2）：
 * 只回填尚无会话的路径（同页会话比备份新，不回退）；回填不触发正文写盘；
 * 旧记录缺少会话/冲突字段时按「有人工内容、待校验」处理（restoredPending），
 * 不能因字段缺失丢弃。读取失败抛错，由调用方提示并保留当前内容。
 */
export async function restoreEditorSessions(
  projectId: string,
  records: Array<{ path: string; content: string; baseContent: string; originPath?: string; updatedAt: string }>,
): Promise<RestoredEditorReport> {
  const restored: RestoredEditorReport['restored'] = []
  for (const record of records) {
    const existing = getSession(projectId, record.path)
    if (existing && (isEditorSessionDirty(existing) || existing.conflict || existing.guard)) {
      continue
    }
    const session = openEditorSession(projectId, record.path, record.baseContent)
    session.content = record.content
    session.baseContent = record.baseContent
    if (record.originPath !== undefined) {
      session.originPath = record.originPath
    }
    session.restoredPending = true
    session.restoredAcked = false
    session.updatedAt = record.updatedAt
    restored.push({
      path: record.path,
      ...(record.originPath !== undefined ? { originPath: record.originPath } : {}),
      updatedAt: record.updatedAt,
    })
  }
  restored.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return { projectId, restored }
}

/** 恢复提示已被知悉（横幅关闭；版本校验语义在阶段 4 接入） */
export function acknowledgeRestoredEditor(projectId: string, path: string): void {
  const session = getSession(projectId, path)
  if (session) {
    session.restoredAcked = true
  }
}

// ---------- 测试注入口 ----------

/** 测试专用：清空全部会话与编排状态 */
export function _resetEditorSessionsForTest(): void {
  sessions.clear()
  saveChains.clear()
  for (const key of autosaveTimers.keys()) {
    cancelAutosaveTimer(key)
  }
  autosaveInputEnabled = false
}

/** 测试专用：等待同键写盘链排空（受控 Promise 事件序断言用） */
export async function _waitForEditorSaveChain(projectId: string, path: string): Promise<void> {
  const run = saveChains.get(editorSessionKey(projectId, path))
  if (run) {
    await run
  }
}
