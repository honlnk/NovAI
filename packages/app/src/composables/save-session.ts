/**
 * 通用保存会话引擎（看板卡片详情自动保存与状态操作优化计划 §三）：
 * 按「项目 + 稳定键」管理人工输入、同键串行写盘、失败自动补试、冲突代次、
 * 守护与恢复核对。机制逐段移植自正文编辑会话（editor-session），已验证的
 * 事件序规则保持不变；领域差异（正文路径 / 看板卡片）全部经由 adapter 注入：
 * 快照形状与读写、保存与探测服务、版本令牌、恢复镜像与领域守护。
 *
 * 引擎不感知文件路径或卡片概念；快照经访问器读写（正文是 content 字符串，
 * 卡片是字段草稿对象），磁盘版本（TDisk）对引擎不透明。写盘编排规则：
 * 同键串行；快照在写盘开始时固定，结果只作用于该会话；旧写完成只承认其
 * 携带的快照，写盘期间的新输入保留并按新基线继续；冲突与守护在写盘前
 * 再次检查；领域写入入口的版本校验是最终防线。
 */
import { reactive, shallowReactive } from 'vue'

/** 会话阶段（派生值，不落盘；与正文 EditorSessionPhase 同构） */
export type SaveSessionPhase =
  | 'clean' // 无待写内容（已保存）
  | 'pending' // 有待写内容（等待保存）
  | 'saving' // 写盘在途（正在保存）
  | 'failed' // 普通写入失败（可重试）
  | 'conflict' // 检测到外部版本（自动写入冻结，直到用户解决）
  | 'guard' // 领域守护（删除/重命名等；禁止写入，直到用户选择去向）
  | 'restored' // 恢复镜像已回填，待版本校验

/**
 * 冲突状态（引擎管理全部字段；disk 为领域磁盘版本，引擎不透明持有）。
 * generation 递增防晚到：外部版本读取/采用操作的轮次，晚到结果不得覆盖新一轮。
 */
export type SaveSessionConflictState = {
  generation: number
  /** 外部版本读取在途 */
  probing: boolean
  /** 「采用磁盘版本」确认在途：用户离开确认即中止，晚到不得清内容 */
  adoptingDisk?: boolean
  /** 磁盘最新版本（读取成功时；读取失败必须作废，防止旧快照清稿） */
  disk?: unknown
  /** 目标确实不存在（读取失败另行保留原因，不伪装成已删除） */
  missing: boolean
  /** 磁盘读取失败原因 */
  unreadable?: string
  /** 版本比较区是否展开（用户主动打开；切走返回保留再入口） */
  expanded: boolean
}

/** 会话的最小约定：引擎读写或判空的最小字段集（领域可追加自有字段） */
export type SaveSessionBase = {
  projectId: string
  /** 在途写盘标记（形状领域定；引擎只判空与释放） */
  inFlight: unknown | null
  /** 普通写入失败原因（存在即 failed；冲突不算失败） */
  failure?: { message: string }
  /** 冲突状态（存在即 conflict） */
  conflict?: SaveSessionConflictState
  /** 领域守护（存在即 guard，禁止一切写入；形状领域定） */
  guard?: object
  /** 恢复镜像已回填、待版本校验 */
  restoredPending: boolean
  /** 恢复提示已被知悉 */
  restoredAcked: boolean
  /** 会话最后活动时间（ISO） */
  updatedAt: string
}

export type SaveSessionWriteOutcome<TDisk> =
  | { ok: true; disk: TDisk }
  | {
    ok: false
    conflict: boolean
    message: string
    /** 冲突时随结果携带的磁盘快照（领域写入冲突错误载荷已含最新版本时可免一次探测） */
    disk?: TDisk
  }

export type SaveSessionProbeResult<TDisk> =
  | { kind: 'ok'; disk: TDisk }
  | { kind: 'missing' }
  | { kind: 'unreadable'; message: string }

/**
 * 保存服务未注册：请求保存时本次写入静默跳过（不失败、不补试），
 * 强写出口（采用我的当前内容）转为失败消息。
 */
export class SaveServiceUnavailableError extends Error {}

/** 建会话种子：快照、基线快照、基线版本令牌与恢复来源信息 */
export type SaveSessionSeed<TSnapshot> = {
  snapshot: TSnapshot
  baseSnapshot: TSnapshot
  baseVersion?: string
  /** 迁移前旧键（重命名域；未迁移缺省） */
  originKey?: string
  /** 恢复记录携带的活动时间（缺省取当前） */
  updatedAt?: string
}

/** 恢复镜像核对记录（领域从持久化记录解析而来） */
export type SaveSessionRestoreRecord<TSnapshot> = {
  key: string
  snapshot: TSnapshot
  baseSnapshot: TSnapshot
  baseVersion?: string
  originKey?: string
  updatedAt: string
  /**
   * 会话携带快照之外的待处理状态（如卡片域待确认的放弃操作态）：草稿内容
   * 已与磁盘一致时也不走「冗余清理」，保留会话让领域回填该状态。
   */
  keepAlive?: boolean
}

/** 每次写盘完成后的回执（卡片域据此同步看板/详情；正文不需要） */
export type SaveSessionSettledResult<TDisk> =
  | { status: 'saved'; disk: TDisk }
  | { status: 'conflict'; message: string }
  | { status: 'failed'; message: string }

/** 请求保存的结果（skipped = 无会话/无待写/守护/冲突禁写/服务未注册） */
export type SaveSessionRequestResult<TDisk> =
  | SaveSessionSettledResult<TDisk>
  | { status: 'skipped' }

/** 领域适配器：引擎与领域形状的全部接缝 */
export interface SaveSessionAdapter<
  TSession extends SaveSessionBase,
  TSnapshot,
  TDisk,
> {
  /** 快照相等（脏判定与「写盘期间无新输入」判定） */
  isSameSnapshot(a: TSnapshot, b: TSnapshot): boolean
  getSnapshot(session: TSession): TSnapshot
  /** 整体替换（不得原地突变；引擎捕获的旧引用需要保持不变） */
  setSnapshot(session: TSession, snapshot: TSnapshot): void
  getBaseSnapshot(session: TSession): TSnapshot
  setBaseSnapshot(session: TSession, snapshot: TSnapshot): void
  /** 基线版本令牌（正文 updatedAt；卡片 contentHash）。无版本概念的领域可省略 */
  getBaseVersion?(session: TSession): string | undefined
  setBaseVersion?(session: TSession, version: string): void
  /** 写盘开始时的在途标记（领域形状；保存入参需要捕获什么领域决定） */
  captureInFlight(
    session: TSession,
    captured: { snapshot: TSnapshot; baseSnapshot: TSnapshot; baseVersion?: string },
  ): unknown
  /** 写盘结束释放在途标记（领域自校验只承认本次快照） */
  releaseInFlight(session: TSession, captured: { snapshot: TSnapshot }): void
  /** 创建会话实体（领域字段形状；引擎负责 reactive 与入表） */
  createSession(projectId: string, key: string, seed: SaveSessionSeed<TSnapshot>): TSession
  /** 外部重定会话数据（迁移/恢复兼容路径）的字段写入 */
  upsertSession(
    session: TSession,
    data: { snapshot: TSnapshot; baseSnapshot: TSnapshot; originKey?: string },
  ): void
  /** 会话迁移到新键（重命名域）：领域同步自有键字段并保留起源键、解除守护 */
  onSessionKeyChange?(session: TSession, fromKey: string, toKey: string): void
  save(
    projectId: string,
    key: string,
    snapshot: TSnapshot,
    context: { session: TSession; base: TSnapshot; baseVersion?: string; force: boolean },
  ): Promise<SaveSessionWriteOutcome<TDisk>>
  probe(projectId: string, key: string): Promise<SaveSessionProbeResult<TDisk>>
  /** 从磁盘版本提取版本令牌 */
  versionOf(disk: TDisk): string | undefined
  /** 磁盘版本的等价快照（成功回填/采用磁盘后的新基线） */
  snapshotFromDisk(disk: TDisk): TSnapshot
  /**
   * 恢复核对：磁盘与恢复基线是否一致（默认按基线快照与磁盘快照相等判定；
   * 卡片等「草稿与磁盘异构」的领域按版本令牌覆盖）。
   */
  isBaselineIntact?(record: SaveSessionRestoreRecord<TSnapshot>, disk: TDisk): boolean
  /** 恢复核对：恢复内容是否已与磁盘一致（默认快照相等；卡片按字段差异覆盖） */
  isSnapshotOnDisk?(record: SaveSessionRestoreRecord<TSnapshot>, disk: TDisk): boolean
  /** 未落盘内容写入恢复镜像（去抖策略领域自定） */
  scheduleMirror(session: TSession): void
  /** 清除恢复镜像记录（保存成功/明确放弃时） */
  removeMirror(projectId: string, key: string): void
  /** 每次写盘完成的回执（含后台收口；正文不需要，卡片同步看板用） */
  onSettled?(projectId: string, key: string, result: SaveSessionSettledResult<TDisk>): void
  /**
   * 会话是否携带快照之外的待处理人工状态（如卡片域待确认的放弃操作态）：
   * 外部写盘冻结判定把它与未落盘内容同等对待——外部修改会作废该状态的
   * 提交基线，干净会话也必须建冲突而不是静默重读（阶段 4）。
   */
  hasPendingState?(session: TSession): boolean
}

export type SaveSessionRestoreReport = {
  projectId: string
  /** 磁盘与恢复基线一致（或无法核对）：回填待校验，待写内容由保存落盘 */
  restored: Array<{ key: string; originKey?: string; updatedAt: string }>
  /** 恢复内容已与磁盘一致：冗余记录已清理，不回填 */
  discarded: Array<{ key: string }>
  /** 磁盘已被修改且不等于基线：回填并建立版本冲突（非阻塞紧凑态） */
  conflicted: Array<{ key: string }>
  /** 目标已不在磁盘：回填并进入删除守护（不自动复活） */
  guarded: Array<{ key: string }>
}

/** 输入后自动保存去抖窗口（固定取舍：最后一次输入后 2000ms） */
export const SAVE_SESSION_AUTOSAVE_DEBOUNCE_MS = 2000
/** 失败后自动补试延迟 */
export const SAVE_SESSION_RETRY_DELAY_MS = 1000

/**
 * 创建一个保存会话域（realm）：独立的会话表、写盘链、计时器与开关。
 * 正文（editor-session）与三类看板卡片（card-save-session）各建一个实例，
 * 互不共享状态；本工厂只提供同一套已验证的事件序机制。
 */
export function createSaveSessionRealm<
  TSession extends SaveSessionBase,
  TSnapshot,
  TDisk,
>(adapter: SaveSessionAdapter<TSession, TSnapshot, TDisk>) {
  /** 域内会话键：项目 + 领域键无歧义编码 */
  function realmKey(projectId: string, key: string): string {
    return JSON.stringify([projectId, key])
  }

  // shallowReactive：Map 键级变更（set/delete）可追踪，值不做 UnwrapRef 深转换
  // （泛型 TSession 下深转换的类型无法证明恒等）；会话对象在建入时单独 reactive，
  // 字段级读写照常追踪。
  const sessions = shallowReactive(new Map<string, TSession>())

  function touchTime(): string {
    return new Date().toISOString()
  }

  function getSession(projectId: string, key: string): TSession | undefined {
    return sessions.get(realmKey(projectId, key))
  }

  /** 项目内全部会话（收口、恢复提示与守护扫描用） */
  function listSessions(projectId: string): TSession[] {
    return [...sessions.values()].filter((session) => session.projectId === projectId)
  }

  /** 全部项目的全部会话（整体清理用） */
  function listAllSessions(): TSession[] {
    return [...sessions.values()]
  }

  /** 会话当前阶段 */
  function phaseOf(session: TSession): SaveSessionPhase {
    if (session.guard) return 'guard'
    if (session.conflict) return 'conflict'
    if (session.inFlight !== null && session.inFlight !== undefined) return 'saving'
    if (session.failure) return 'failed'
    if (session.restoredPending) return 'restored'
    return adapter.isSameSnapshot(adapter.getSnapshot(session), adapter.getBaseSnapshot(session))
      ? 'clean'
      : 'pending'
  }

  /** 是否有未落盘的人工内容（待写/在途输入；不含失败与冲突标记本身） */
  function isDirty(session: TSession): boolean {
    return !adapter.isSameSnapshot(adapter.getSnapshot(session), adapter.getBaseSnapshot(session))
  }

  /** 是否需要离开提醒：有待写、在途、失败、冲突、恢复未校验或守护未处理 */
  function needsLeaveGuard(session: TSession): boolean {
    return phaseOf(session) !== 'clean'
  }

  function getBaseVersion(session: TSession): string | undefined {
    return adapter.getBaseVersion?.(session)
  }

  /** 建立会话；已存在则保留原会话（草稿不丢） */
  function openSession(
    projectId: string,
    key: string,
    seed: SaveSessionSeed<TSnapshot>,
  ): TSession {
    const existing = getSession(projectId, key)
    if (existing) {
      return existing
    }
    const session = reactive(adapter.createSession(projectId, key, seed)) as unknown as TSession
    sessions.set(realmKey(projectId, key), session)
    return session
  }

  /** 清除会话（放弃更改、采用磁盘版本后）：同步删除恢复镜像记录 */
  function clearSession(projectId: string, key: string): void {
    const composite = realmKey(projectId, key)
    const session = sessions.get(composite)
    sessions.delete(composite)
    cancelAutosaveTimer(composite)
    clearAutoRetryCycle(composite)
    if (session) {
      adapter.removeMirror(projectId, key)
    }
  }

  /**
   * 人工输入：更新最新输入、重置自动保存去抖；输入实时进入恢复镜像。
   * 输入与基线一致时会话收敛为 clean 并清掉镜像记录。
   */
  function setInput(projectId: string, key: string, snapshot: TSnapshot): void {
    const session = getSession(projectId, key)
    if (!session) {
      return
    }
    adapter.setSnapshot(session, snapshot)
    session.updatedAt = touchTime()
    // 新输入开启新的保存周期：失败补试次数随之重置
    clearAutoRetryCycle(realmKey(projectId, key))
    if (session.guard || session.conflict) {
      // 守护/冲突期间继续输入只更新内容与镜像，不安排自动写入
      adapter.scheduleMirror(session)
      return
    }
    if (adapter.isSameSnapshot(snapshot, adapter.getBaseSnapshot(session))) {
      adapter.removeMirror(projectId, key)
      return
    }
    adapter.scheduleMirror(session)
    scheduleAutosave(projectId, key)
  }

  /** 外部重定会话数据（迁移/恢复兼容路径）：不触发保存编排，但同步恢复镜像 */
  function upsertSessionData(
    projectId: string,
    key: string,
    data: { snapshot: TSnapshot; baseSnapshot: TSnapshot; originKey?: string },
  ): void {
    const existing = getSession(projectId, key)
    if (existing) {
      adapter.upsertSession(existing, data)
      existing.updatedAt = touchTime()
      if (!adapter.isSameSnapshot(data.snapshot, data.baseSnapshot)) {
        adapter.scheduleMirror(existing)
      }
      return
    }
    const created = openSession(projectId, key, {
      snapshot: data.snapshot,
      baseSnapshot: data.baseSnapshot,
      ...(data.originKey !== undefined ? { originKey: data.originKey } : {}),
    })
    if (!adapter.isSameSnapshot(data.snapshot, data.baseSnapshot)) {
      adapter.scheduleMirror(created)
    }
  }

  /**
   * 同键磁盘版本更新（保存回写 / 外部修改重读）到达时重定基线：
   * 会话 clean 时跟随最新磁盘版本；有待写内容时不覆盖基线——
   * 保存时由领域版本校验判定，冲突走冻结。
   */
  function rebaseCleanBaseline(projectId: string, key: string, disk: TDisk): void {
    const session = getSession(projectId, key)
    if (!session || session.inFlight || session.conflict || session.guard) {
      return
    }
    if (!adapter.isSameSnapshot(adapter.getSnapshot(session), adapter.getBaseSnapshot(session))) {
      return
    }
    const fromDisk = adapter.snapshotFromDisk(disk)
    adapter.setSnapshot(session, fromDisk)
    adapter.setBaseSnapshot(session, fromDisk)
    const version = adapter.versionOf(disk)
    if (version !== undefined) {
      adapter.setBaseVersion?.(session, version)
    }
    session.updatedAt = touchTime()
  }

  /**
   * 把会话迁移到新键（重命名域）：保留人工内容与冲突；守护随迁移解除。
   * 领域自有键字段与起源键的保留在 onSessionKeyChange 中完成。
   */
  function migrateSession(projectId: string, fromKey: string, toKey: string): void {
    const fromComposite = realmKey(projectId, fromKey)
    const session = sessions.get(fromComposite)
    if (!session) {
      return
    }
    sessions.delete(fromComposite)
    cancelAutosaveTimer(fromComposite)
    adapter.onSessionKeyChange?.(session, fromKey, toKey)
    adapter.removeMirror(projectId, fromKey)
    sessions.set(realmKey(projectId, toKey), session)
    adapter.scheduleMirror(session)
  }

  /** 项目内当前处于守护的会话 */
  function getGuardedSession(projectId: string): TSession | undefined {
    return listSessions(projectId).find((session) => session.guard !== undefined)
  }

  /** 置入/解除守护；置入即取消自动写与补试计时器 */
  function setGuard(projectId: string, key: string, guard: object | null): void {
    const session = getSession(projectId, key)
    if (!session) {
      return
    }
    if (guard) {
      session.guard = guard
      cancelAutosaveTimer(realmKey(projectId, key))
      cancelAutoRetryTimer(realmKey(projectId, key))
    } else {
      delete session.guard
    }
    session.updatedAt = touchTime()
  }

  // ---------- 保存编排（同键串行） ----------

  /** 同一会话的写盘请求串行：后到请求等前一个完成后按最新状态执行 */
  const saveChains = new Map<string, Promise<void>>()

  function enqueueSaveWork(composite: string, work: () => Promise<void>): Promise<void> {
    const previous = saveChains.get(composite) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(work)
    saveChains.set(composite, run)
    const cleanup = () => {
      if (saveChains.get(composite) === run) {
        saveChains.delete(composite)
      }
    }
    void run.then(cleanup, cleanup)
    return run
  }

  /**
   * 请求保存（手动触发 / 收口 / 去抖共用入口）：
   * - 无会话、无待写内容、守护或冲突未解决时不写（冲突的「采用我的当前内容」
   *   走 overwriteContent 强写出口，不经此处）；
   * - 写盘在途时按同键串行排队，前一个完成后以最新状态执行；
   * - 手动/去抖触发（用户输入的写盘承诺）：会话引用与提交快照在请求时同步
   *   固定——排队间隙里会话被清除（切项目 reset 等）也不取消已请求的文件
   *   写入，结果只作用于该会话；请求后继续输入的内容保留为待写；
   * - 收口触发（flush）：执行时重读会话当前快照——排队间隙里待写内容已被
   *   前一次保存落盘或会话已清时，本次请求自然收敛为 skipped，不重复提交
   *   已落盘的内容（收口的目的是清空待写，不是兑现某次固定提交）。
   */
  function requestSave(
    projectId: string,
    key: string,
    options?: { trigger?: 'manual' | 'debounce' | 'flush'; snapshot?: TSnapshot },
  ): Promise<SaveSessionRequestResult<TDisk>> {
    const trigger = options?.trigger ?? 'manual'
    const composite = realmKey(projectId, key)
    const pinAtRequest = trigger !== 'flush' || options?.snapshot !== undefined
    // 请求时同步固定会话与快照（与调用方按钮点击同 tick；排队后写盘开始前
    // 的新输入不算进本次提交）。显式携带 snapshot 的调用（saveDraft 提交
    // 草稿）始终固定，与触发方式无关。
    const sessionAtRequest = getSession(projectId, key)
    const submitted
      = options?.snapshot
        ?? (pinAtRequest && sessionAtRequest !== undefined ? adapter.getSnapshot(sessionAtRequest) : undefined)
    let result: SaveSessionRequestResult<TDisk> = { status: 'skipped' }
    const run = enqueueSaveWork(composite, async () => {
      result = await performSave(projectId, key, {
        trigger,
        force: false,
        ...(pinAtRequest && sessionAtRequest !== undefined ? { session: sessionAtRequest } : {}),
        ...(submitted !== undefined ? { submitted } : {}),
      })
    })
    return run.then(() => result)
  }

  /** 等待该键在途与排队的写盘全部完成（不发起保存；确认复检用） */
  function settleSave(projectId: string, key: string): Promise<void> {
    const composite = realmKey(projectId, key)
    return enqueueSaveWork(composite, async () => {})
  }

  async function performSave(
    projectId: string,
    key: string,
    options: {
      trigger: 'manual' | 'debounce' | 'flush'
      force: boolean
      /** 请求时固定的会话（排队间隙被清除也不取消已请求的写入） */
      session?: TSession
      /** 请求时固定的提交快照（缺省在写盘开始时读取） */
      submitted?: TSnapshot
    },
  ): Promise<SaveSessionRequestResult<TDisk>> {
    const session = options.session ?? getSession(projectId, key)
    if (!session) {
      return { status: 'skipped' }
    }
    // 冲突与守护在写盘前再次检查：守护未决禁止任何写入；冲突只禁止自动写入
    // （手动触发是用户明确选择，会再次撞版本校验）。
    if (session.guard) {
      return { status: 'skipped' }
    }
    if (session.conflict && options.trigger !== 'manual') {
      return { status: 'skipped' }
    }
    if (
      !options.force
      && adapter.isSameSnapshot(
        options.submitted ?? adapter.getSnapshot(session),
        adapter.getBaseSnapshot(session),
      )
    ) {
      // 无待写内容；在途失败态不因无内容请求清除（由重试/新输入重新触发）
      return { status: 'skipped' }
    }

    const snapshot = options.submitted ?? adapter.getSnapshot(session)
    const captured = {
      snapshot,
      baseSnapshot: adapter.getBaseSnapshot(session),
      baseVersion: getBaseVersion(session),
    }
    session.inFlight = adapter.captureInFlight(session, captured)
    delete session.failure

    let outcome: SaveSessionWriteOutcome<TDisk> | null = null
    try {
      outcome = await adapter.save(projectId, key, snapshot, {
        session,
        base: captured.baseSnapshot,
        ...(captured.baseVersion !== undefined ? { baseVersion: captured.baseVersion } : {}),
        force: options.force,
      })
    } catch (error) {
      adapter.releaseInFlight(session, captured)
      if (error instanceof SaveServiceUnavailableError) {
        // 保存服务未注册：本次静默跳过（不失败、不补试）
        return { status: 'skipped' }
      }
      // 保存服务异常按普通失败处理（内容与位置保留，原因持续可见）
      session.failure = { message: error instanceof Error ? error.message : String(error) }
      scheduleAutoRetry(projectId, key)
      await adapter.onSettled?.(projectId, key, { status: 'failed', message: session.failure.message })
      return { status: 'failed', message: session.failure.message }
    }
    adapter.releaseInFlight(session, captured)

    if (
      !outcome
      || typeof outcome !== 'object'
      || typeof outcome.ok !== 'boolean'
      || (outcome.ok && outcome.disk == null)
    ) {
      // 保存服务返回非法结果（类型契约之外）：按普通失败处理，
      // 不悬挂在途态、不静默当成功
      session.failure = { message: '保存服务返回无效结果' }
      scheduleAutoRetry(projectId, key)
      await adapter.onSettled?.(projectId, key, { status: 'failed', message: session.failure.message })
      return { status: 'failed', message: session.failure.message }
    }

    if (outcome.ok) {
      applySaveSuccess(session, key, outcome.disk, snapshot)
      clearAutoRetryCycle(realmKey(projectId, key))
      await adapter.onSettled?.(projectId, key, { status: 'saved', disk: outcome.disk })
      return { status: 'saved', disk: outcome.disk }
    }

    if (outcome.conflict) {
      await enterConflictFromSave(projectId, key, session, outcome.disk)
      await adapter.onSettled?.(projectId, key, { status: 'conflict', message: outcome.message })
      return { status: 'conflict', message: outcome.message }
    }

    session.failure = { message: outcome.message }
    // 手动触发（保存按钮/状态条重试）重新开启补试周期：用户明确动作后允许再补试一次
    if (options.trigger === 'manual') {
      clearAutoRetryCycle(realmKey(projectId, key))
    }
    // 普通失败自动补试一次：持久错误必须可见，补试失败后不再自动打扰
    scheduleAutoRetry(projectId, key)
    await adapter.onSettled?.(projectId, key, { status: 'failed', message: outcome.message })
    return { status: 'failed', message: outcome.message }
  }

  /**
   * 写盘成功：只承认本次提交的快照（submitted）已落盘——
   * - 会话内容与提交快照一致（本次写盘后无新输入）：待写清空，基线换到刚落盘
   *   的版本，快照收敛到新基线，镜像清除；
   * - 写盘期间有新输入：新输入保留为待写，基线 rebase 到刚落盘内容，镜像重定基线；
   * - 冲突不因旧写晚到成功而解除。
   * 按 submitted 而非磁盘快照判等：卡片等「草稿与磁盘异构」的领域里，
   * 服务忠实回写时提交草稿即已落盘，不能因形状差异误判为仍有新输入。
   */
  function applySaveSuccess(session: TSession, key: string, disk: TDisk, submitted: TSnapshot): void {
    const fromDisk = adapter.snapshotFromDisk(disk)
    adapter.setBaseSnapshot(session, fromDisk)
    const version = adapter.versionOf(disk)
    if (version !== undefined) {
      adapter.setBaseVersion?.(session, version)
    }
    if (adapter.isSameSnapshot(adapter.getSnapshot(session), submitted)) {
      adapter.setSnapshot(session, fromDisk)
      adapter.removeMirror(session.projectId, key)
      // 恢复内容已真实落盘：续存完成，恢复横幅随之消失
      session.restoredPending = false
      session.restoredAcked = true
    } else {
      adapter.scheduleMirror(session)
    }
    session.updatedAt = touchTime()
  }

  /**
   * 保存结果判定为冲突：登记冲突并读取外部版本（不自动展开、不清输入）。
   * 领域写入冲突错误载荷已携带最新版本（outcome.disk）时直接采用，免一次探测。
   */
  async function enterConflictFromSave(
    projectId: string,
    key: string,
    session: TSession,
    disk?: unknown,
  ): Promise<void> {
    const generation = (session.conflict?.generation ?? 0) + 1
    session.conflict = {
      generation,
      probing: false,
      missing: false,
      expanded: session.conflict?.expanded ?? true,
      ...(disk !== undefined ? { disk } : {}),
    }
    session.updatedAt = touchTime()
    if (disk === undefined) {
      session.conflict.probing = true
      await probeExternalVersion(projectId, key, session, generation)
    }
  }

  /**
   * 读取磁盘外部版本到冲突状态（比较/采用前的最新读取）：
   * 读取失败只说明无法读取另一版本（unreadable），不伪装成已删除；
   * 读取失败时旧的磁盘快照必须作废：采用磁盘版本绝不能拿着旧读取清稿。
   */
  async function probeExternalVersion(
    projectId: string,
    key: string,
    session: TSession,
    generation: number,
  ): Promise<void> {
    let probe: SaveSessionProbeResult<TDisk>
    try {
      probe = await adapter.probe(projectId, key)
    } catch (error) {
      probe = {
        kind: 'unreadable',
        message: error instanceof Error ? error.message : String(error),
      }
    }
    const conflict = session.conflict
    if (!conflict || conflict.generation !== generation) {
      return
    }
    conflict.probing = false
    if (probe.kind === 'ok') {
      conflict.disk = probe.disk
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
    delete conflict.disk
  }

  /**
   * AI/外部写盘到达时冻结有未落盘内容的会话：有待写内容的会话置冲突并读取
   * 外部版本（不展开比较、不清输入）；自动保存随之冻结。无会话或无待写内容
   * 返回 'none'/'clean'（clean 会话由 rebase 跟随磁盘）；守护未决时不动
   * （守护优先于冲突）；已有冲突时按新代次重读磁盘快照。
   *
   * 返回值区分：'conflict' = 本次首次建立冲突（调用方可给一次反馈）；
   * 'conflict-refresh' = 此前已在冲突中、本次只刷新磁盘快照（调用方抑制重复反馈）。
   */
  async function freezeForExternal(
    projectId: string,
    key: string,
  ): Promise<'conflict' | 'conflict-refresh' | 'clean' | 'none'> {
    const session = getSession(projectId, key)
    if (!session) {
      return 'none'
    }
    if (session.guard) {
      return 'none'
    }
    // 快照外的待处理状态（待确认放弃操作态等）与未落盘内容同等对待：外部
    // 修改作废其提交基线，干净会话也建冲突（领域通过 hasPendingState 声明）
    if (!isDirty(session) && !session.conflict && !(adapter.hasPendingState?.(session) ?? false)) {
      return 'clean'
    }
    cancelAutosaveTimer(realmKey(projectId, key))
    cancelAutoRetryTimer(realmKey(projectId, key))
    const hadConflict = session.conflict !== undefined
    const generation = (session.conflict?.generation ?? 0) + 1
    session.conflict = {
      generation,
      probing: true,
      missing: false,
      // 后台到达非阻塞：保持当前展开状态（紧凑状态条提示，用户主动展开比较）
      expanded: session.conflict?.expanded ?? false,
    }
    session.updatedAt = touchTime()
    await probeExternalVersion(projectId, key, session, generation)
    return hadConflict ? 'conflict-refresh' : 'conflict'
  }

  /** 用户主动展开比较（再入口）：重新读取磁盘最新 + 最新人工输入并列 */
  async function expandConflict(projectId: string, key: string): Promise<void> {
    const session = getSession(projectId, key)
    if (!session?.conflict) {
      return
    }
    const generation = session.conflict.generation + 1
    session.conflict.generation = generation
    session.conflict.probing = true
    session.conflict.expanded = true
    await probeExternalVersion(projectId, key, session, generation)
  }

  /** 返回继续编辑：收起比较、保留冲突与输入；在途的「采用磁盘版本」随之中止 */
  function collapseConflict(projectId: string, key: string): void {
    const session = getSession(projectId, key)
    if (session?.conflict) {
      session.conflict.expanded = false
      session.conflict.adoptingDisk = false
    }
  }

  /** 冲突解决出口之一：采用磁盘版本——重新读取成功后才放弃人工内容（二次确认在领域层） */
  async function adoptDisk(
    projectId: string,
    key: string,
  ): Promise<'resolved' | 'probe-failed' | 'aborted'> {
    const session = getSession(projectId, key)
    if (!session?.conflict) {
      return 'probe-failed'
    }
    const generation = session.conflict.generation + 1
    session.conflict.generation = generation
    session.conflict.adoptingDisk = true
    await probeExternalVersion(projectId, key, session, generation)
    const conflict = session.conflict
    if (!conflict || conflict.generation !== generation || conflict.probing || conflict.disk === undefined) {
      // 读取失败/目标缺失：绝不先删内容，冲突保留并呈现最新探测结果
      conflict && (conflict.expanded = true)
      return 'probe-failed'
    }
    if (!conflict.adoptingDisk) {
      // 复检在途时用户已离开确认（返回编辑/切走）：晚到结果不得清掉继续输入的内容
      return 'aborted'
    }
    delete conflict.adoptingDisk
    clearSession(projectId, key)
    return 'resolved'
  }

  /**
   * 冲突解决出口之一：采用我的当前内容——整份覆盖磁盘（二次确认在领域层）。
   * 等待期间的新输入按新基线保留；采用完成后若仍有未落盘输入，冲突保留；
   * 晚到的旧采用结果不得清掉新输入或新冲突。
   */
  async function overwriteContent(
    projectId: string,
    key: string,
  ): Promise<{ ok: boolean; message?: string }> {
    const session = getSession(projectId, key)
    if (!session) {
      return { ok: false, message: '会话不存在或未注册保存服务' }
    }
    const submitted = adapter.getSnapshot(session)
    let outcome: SaveSessionWriteOutcome<TDisk>
    try {
      outcome = await adapter.save(projectId, key, submitted, {
        session,
        base: adapter.getBaseSnapshot(session),
        force: true,
      })
    } catch (error) {
      if (error instanceof SaveServiceUnavailableError) {
        return { ok: false, message: error.message }
      }
      const message = error instanceof Error ? error.message : String(error)
      session.failure = { message }
      return { ok: false, message }
    }
    const current = getSession(projectId, key)
    if (!current || current !== session) {
      // 会话已被清除/迁移：结果不再修改现场（副本归属核对）
      return { ok: outcome.ok, ...(outcome.ok ? {} : { message: outcome.message }) }
    }
    if (outcome.ok) {
      applySaveSuccess(session, key, outcome.disk, submitted)
      if (
        adapter.isSameSnapshot(adapter.getSnapshot(session), adapter.getBaseSnapshot(session))
        && session.conflict
      ) {
        // 全部落盘：本次采用解决了冲突
        delete session.conflict
      }
      delete session.failure
      return { ok: true }
    }
    if (outcome.conflict) {
      await enterConflictFromSave(projectId, key, session, outcome.disk)
      return { ok: false, message: outcome.message }
    }
    session.failure = { message: outcome.message }
    return { ok: false, message: outcome.message }
  }

  // ---------- 输入去抖与收口 ----------

  let autosaveInputEnabled = false

  /** 打开/关闭输入自动保存触发（领域接线后打开） */
  function setAutosaveInputEnabled(enabled: boolean): void {
    autosaveInputEnabled = enabled
    if (!enabled) {
      for (const composite of autosaveTimers.keys()) {
        cancelAutosaveTimer(composite)
      }
    }
  }

  const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function scheduleAutosave(projectId: string, key: string): void {
    if (!autosaveInputEnabled) {
      return
    }
    const composite = realmKey(projectId, key)
    const existing = autosaveTimers.get(composite)
    if (existing) {
      clearTimeout(existing)
    }
    autosaveTimers.set(
      composite,
      setTimeout(() => {
        autosaveTimers.delete(composite)
        void requestSave(projectId, key, { trigger: 'debounce' })
      }, SAVE_SESSION_AUTOSAVE_DEBOUNCE_MS),
    )
  }

  function cancelAutosaveTimer(composite: string): void {
    const timer = autosaveTimers.get(composite)
    if (timer) {
      clearTimeout(timer)
      autosaveTimers.delete(composite)
    }
  }

  // ---------- 普通失败自动补试 ----------

  const autoRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 本失败周期已自动补试过的会话键（新输入/保存成功重置周期） */
  const autoRetriedKeys = new Set<string>()

  /**
   * 普通写入失败后自动补试一次：补试按系统自动触发走（冲突/守护下不写）；
   * 补试也失败则保持失败态等用户处理，持久错误持续可见。
   */
  function scheduleAutoRetry(projectId: string, key: string): void {
    const composite = realmKey(projectId, key)
    if (autoRetriedKeys.has(composite)) {
      return
    }
    cancelAutoRetryTimer(composite)
    autoRetryTimers.set(
      composite,
      setTimeout(() => {
        autoRetryTimers.delete(composite)
        autoRetriedKeys.add(composite)
        void requestSave(projectId, key, { trigger: 'debounce' })
      }, SAVE_SESSION_RETRY_DELAY_MS),
    )
  }

  function cancelAutoRetryTimer(composite: string): void {
    const timer = autoRetryTimers.get(composite)
    if (timer) {
      clearTimeout(timer)
      autoRetryTimers.delete(composite)
    }
  }

  function clearAutoRetryCycle(composite: string): void {
    cancelAutoRetryTimer(composite)
    autoRetriedKeys.delete(composite)
  }

  /** 立即收口某会话（切键/分类/项目、关面板等关键时机） */
  function flushSession(projectId: string, key: string): Promise<SaveSessionRequestResult<TDisk>> {
    cancelAutosaveTimer(realmKey(projectId, key))
    return requestSave(projectId, key, { trigger: 'flush' })
  }

  /** 项目内全部有待写内容的会话立即收口（离开项目视图等） */
  async function flushSessions(projectId: string): Promise<void> {
    const keys: string[] = []
    for (const [composite, session] of sessions.entries()) {
      const [owner, key] = JSON.parse(composite) as [string, string]
      if (owner === projectId && isDirty(session)) {
        keys.push(key)
      }
    }
    await Promise.all(keys.map((key) => flushSession(projectId, key)))
  }

  /** 全部项目的待写会话立即收口（页面隐藏/关闭）：写盘来不及完成时恢复镜像仍在 */
  async function flushAllSessions(): Promise<void> {
    const targets: Array<{ projectId: string; key: string }> = []
    for (const [composite, session] of sessions.entries()) {
      if (!isDirty(session)) {
        continue
      }
      const [projectId, key] = JSON.parse(composite) as [string, string]
      targets.push({ projectId, key })
    }
    await Promise.all(targets.map(({ projectId, key }) => flushSession(projectId, key)))
  }

  /**
   * 生命周期挂接：页面隐藏/关闭前立即尝试收口全部待写会话。
   * 与恢复镜像的落盘各自独立。返回退订函数。
   */
  function setupLifecycle(): () => void {
    if (typeof document === 'undefined') {
      return () => {}
    }
    const flush = () => {
      void flushAllSessions()
    }
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
    }
  }

  // ---------- 恢复镜像回填 ----------

  /**
   * 重新进入项目时从恢复镜像回填会话：只回填尚无有效会话的键（同页会话比
   * 备份新，不回退）；回填不触发写盘。恢复时逐键读取磁盘核对：内容与磁盘
   * 一致清冗余记录；磁盘与基线一致才自动续存；不一致建立版本冲突；目标已
   * 删除进入删除守护；读取失败按「有人工内容、待校验」回填，不能丢弃。
   */
  async function restoreSessions(
    projectId: string,
    records: Array<SaveSessionRestoreRecord<TSnapshot>>,
  ): Promise<SaveSessionRestoreReport> {
    const restored: SaveSessionRestoreReport['restored'] = []
    const discarded: SaveSessionRestoreReport['discarded'] = []
    const conflicted: SaveSessionRestoreReport['conflicted'] = []
    const guarded: SaveSessionRestoreReport['guarded'] = []
    for (const record of records) {
      const existing = getSession(projectId, record.key)
      if (existing && (isDirty(existing) || existing.conflict || existing.guard)) {
        continue
      }

      // 逐键核对磁盘版本（不能只看更新时间，内容/版本身份直接比较）
      let probe: SaveSessionProbeResult<TDisk> | null = null
      try {
        probe = await adapter.probe(projectId, record.key)
      } catch {
        probe = null
      }

      const snapshotOnDisk = (disk: TDisk): boolean =>
        adapter.isSnapshotOnDisk?.(record, disk)
        ?? adapter.isSameSnapshot(record.snapshot, adapter.snapshotFromDisk(disk))
      const baselineIntact = (disk: TDisk): boolean =>
        adapter.isBaselineIntact?.(record, disk)
        ?? adapter.isSameSnapshot(record.baseSnapshot, adapter.snapshotFromDisk(disk))

      if (probe?.kind === 'ok' && snapshotOnDisk(probe.disk) && !record.keepAlive) {
        // 恢复内容已与磁盘一致：冗余恢复记录清理，不回填
        // （keepAlive：会话携带快照外的待处理状态，保留会话交给领域回填）
        adapter.removeMirror(projectId, record.key)
        discarded.push({ key: record.key })
        continue
      }

      const session = openSession(projectId, record.key, {
        snapshot: record.snapshot,
        baseSnapshot: record.baseSnapshot,
        ...(record.baseVersion !== undefined ? { baseVersion: record.baseVersion } : {}),
        ...(record.originKey !== undefined ? { originKey: record.originKey } : {}),
        updatedAt: record.updatedAt,
      })

      if (probe?.kind === 'missing') {
        // 目标已不在磁盘：删除守护（不自动复活；重命名记录沿用迁移选择）
        session.guard = { kind: 'deleted' }
        session.restoredPending = false
        session.restoredAcked = true
        guarded.push({ key: record.key })
        continue
      }
      if (probe?.kind === 'ok' && !baselineIntact(probe.disk)) {
        // 磁盘已被修改且不等于恢复基线：建立版本冲突（非阻塞紧凑态）
        session.restoredPending = true
        session.restoredAcked = false
        session.conflict = {
          generation: 1,
          probing: false,
          missing: false,
          expanded: false,
          disk: probe.disk,
        }
        conflicted.push({ key: record.key })
        continue
      }

      // 基线一致（自动续存）/ 无法核对（unreadable、服务未注册、读取异常）：待校验回填
      session.restoredPending = true
      session.restoredAcked = false
      if (probe?.kind === 'ok' && baselineIntact(probe.disk)) {
        // 基线一致已核对：自动续存——启动保存去抖，未写完内容由保存随后落盘
        scheduleAutosave(projectId, record.key)
      }
      restored.push({
        key: record.key,
        ...(record.originKey !== undefined ? { originKey: record.originKey } : {}),
        updatedAt: record.updatedAt,
      })
    }
    restored.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return { projectId, restored, discarded, conflicted, guarded }
  }

  /** 恢复提示已被知悉（横幅关闭） */
  function acknowledgeRestored(projectId: string, key: string): void {
    const session = getSession(projectId, key)
    if (session) {
      session.restoredAcked = true
    }
  }

  // ---------- 测试注入口 ----------

  /** 测试专用：清空全部会话与编排状态 */
  function resetForTest(): void {
    sessions.clear()
    saveChains.clear()
    for (const composite of autosaveTimers.keys()) {
      cancelAutosaveTimer(composite)
    }
    for (const composite of autoRetryTimers.keys()) {
      cancelAutoRetryTimer(composite)
    }
    autoRetriedKeys.clear()
    autosaveInputEnabled = false
  }

  /** 测试专用：等待同键写盘链排空（受控 Promise 事件序断言用） */
  async function waitForSaveChain(projectId: string, key: string): Promise<void> {
    const run = saveChains.get(realmKey(projectId, key))
    if (run) {
      await run
    }
  }

  return {
    getSession,
    listSessions,
    listAllSessions,
    phaseOf,
    isDirty,
    needsLeaveGuard,
    openSession,
    clearSession,
    setInput,
    upsertSessionData,
    rebaseCleanBaseline,
    migrateSession,
    getGuardedSession,
    setGuard,
    requestSave,
    settleSave,
    freezeForExternal,
    expandConflict,
    collapseConflict,
    adoptDisk,
    overwriteContent,
    setAutosaveInputEnabled,
    flushSession,
    flushSessions,
    flushAllSessions,
    setupLifecycle,
    restoreSessions,
    acknowledgeRestored,
    resetForTest,
    waitForSaveChain,
  }
}

export type SaveSessionRealm<TSession extends SaveSessionBase, TSnapshot, TDisk> =
  ReturnType<typeof createSaveSessionRealm<TSession, TSnapshot, TDisk>>
