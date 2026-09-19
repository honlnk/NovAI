import { buildAgentSystemPrompt, buildAgentUserContext } from '../agent/prompt'
import { buildSteeringContent, query } from '../agent/query'
import { createAgentTools } from '../agent/tools'
import {
  appendUserMessage,
  createModelView,
  setSystemMessage,
  toRequestMessages,
} from '../agent/model-view'
import { createLogId, writeAgentLog } from '../logging/agent-log'
import { hashContent } from '../util/hash'
import type { AgentQueryEvent } from '../agent/query'

import {
  claimTurnStartBatch,
  claimFromInbox,
  enqueueToInbox,
  hasPendingMessages,
} from './inbox'
import type { InboxTarget } from './inbox'
import { deriveChatTargetFromPath } from './target'

import type {
  ChatMessage,
  ChatSessionState,
  ChatTargetContext,
  ChatTurnInput,
  ChatTurnResult,
  QueuedMessage,
} from '../../types/chat'
import type { AgentMessage } from '../agent/messages'

type SessionEvent =
  | { type: 'message'; message: ChatMessage; session: ChatSessionState }
  /** 模型流式输出的文本增量（瞬态渲染态，不落盘）；同一条 assistant 消息共享稳定 messageId。 */
  | { type: 'message-delta'; messageId: string; text: string }
  /** 收件箱在 driver 运行中被抽干/变化（首批 claim、steer 抽干点）；service 层据此广播 queue-updated。 */
  | { type: 'inbox-updated'; session: ChatSessionState }

/** driver 生命周期事件：service 层据此广播 run-start / run-finish / run-error。 */
type ChatDriverLifecycleEvent =
  | { type: 'driver-start'; session: ChatSessionState }
  | { type: 'driver-finish'; session: ChatSessionState }
  | { type: 'driver-error'; session: ChatSessionState; error: unknown }

type RunChatDriverOptions = {
  session: ChatSessionState
  input: ChatTurnInput
  onEvent?: (event: SessionEvent) => void
  onLifecycle?: (event: ChatDriverLifecycleEvent) => void
}

export function createChatSession(projectId: string): ChatSessionState {
  const now = new Date().toISOString()
  return {
    sessionId: createId('session'),
    projectId,
    messages: [],
    modelView: createModelView(),
    status: 'idle',
    currentTarget: null,
    lastRagResult: null,
    title: DEFAULT_SESSION_TITLE,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 活跃 driver 注册表（运行态，不落盘）：sessionId → 句柄。
 * 「入队永远先于唤醒」的配套：driver 活着时新消息只入队（同一个会话对象，driver 在
 * 抽干点/首批自己取走）；停止后即刻再发送的竞态由 pendingWake 闩锁兜底（收敛后再唤醒）。
 */
type ChatDriverHandle = {
  abort: AbortController
  /** driver 的工作会话：与 service 层权威会话是同一对象（共享可变，收件箱变更即时可见） */
  session: ChatSessionState
  /** 运行/收敛期间到达的唤醒请求（携带新 input）；driver 收敛后若收件箱非空则重新唤醒 */
  pendingWake?: RunChatDriverOptions
}
const activeChatDrivers = new Map<string, ChatDriverHandle>()

/**
 * 停止指定会话的 driver：abort 当前 turn；当前 turn 优雅收尾后 driver 收敛，
 * 收件箱队列保留、不自动续跑（dsh cancel 语义：pending 等用户下次发送时随首批带走）。
 */
export function stopChatDriver(sessionId: string): void {
  activeChatDrivers.get(sessionId)?.abort.abort()
}

/** 指定会话的 driver 是否活着（service 层「立即插话仅运行中可用」等判定用）。 */
export function isChatDriverActive(sessionId: string): boolean {
  return activeChatDrivers.has(sessionId)
}

/**
 * 入队（入队永远先于唤醒）：把消息追加到会话收件箱并返回消息本体。
 * 直接改传入会话对象——service 层持有权威会话，driver 工作时与其共享同一对象。
 * 调用方负责随后 saveSession 落盘与 queue-updated 广播。
 */
export function enqueueChatMessage(
  session: ChatSessionState,
  target: InboxTarget,
  input: { text: string; quote?: string; activeFilePath?: string | null },
): QueuedMessage {
  const enqueued = enqueueToInbox(session.inbox, target, input)
  session.inbox = enqueued.state
  return enqueued.message
}

/**
 * 唤醒 driver（fire-and-forget）：空闲则启动；活着则记 pendingWake 闩锁——
 * driver 收敛后若收件箱非空则带着新 input 重新唤醒
 * （覆盖「停止后立刻再发送」的竞态：旧 driver 还没收尾，新消息不能只入队不唤醒）。
 */
export function wakeChatDriver(options: RunChatDriverOptions): void {
  const existing = activeChatDrivers.get(options.session.sessionId)
  if (existing) {
    existing.pendingWake = options
    return
  }
  // 监管壳：生命周期事件统一在这里发（pendingWake 再唤醒走同一入口，自带其 options 的回调闭包）。
  void (async () => {
    options.onLifecycle?.({ type: 'driver-start', session: options.session })
    try {
      await runChatDriver(options)
      options.onLifecycle?.({ type: 'driver-finish', session: options.session })
    } catch (error) {
      options.onLifecycle?.({ type: 'driver-error', session: options.session, error })
    }
  })()
}

/** 测试专用：活跃 driver 数（断言闩锁清理）。 */
export function _getActiveChatDriverCountForTest(): number {
  return activeChatDrivers.size
}

/**
 * driver（照抄 dsh 三层循环的 driver 层，`kick(): while(await turn())`）：
 * 一次唤醒连续跑多个 turn，直到收件箱抽干或被停止。
 *
 * 直接工作于传入的会话对象（与 service 层权威会话同一对象，运行中入队即时可见）。
 * 每个 turn：claim 首批（next-step 全量 + next-turn 恰 1 条）→ 显示层/模型视图逐条追加
 * → 跑 query（turn 层）→ turn 收尾（change-summary 等）。停止（abort）后队列保留、不自动续跑。
 */
export async function runChatDriver(options: RunChatDriverOptions): Promise<ChatTurnResult> {
  const { input, onEvent } = options
  const session = options.session
  session.status = 'running'

  // 唤醒闩锁：本 driver 运行期间的统一 abort 源，调用方 signal 与 stopChatDriver 都汇聚到它。
  const driverAbort = new AbortController()
  const linkCallerSignal = () => driverAbort.abort()
  if (input.signal) {
    if (input.signal.aborted) {
      driverAbort.abort()
    } else {
      input.signal.addEventListener('abort', linkCallerSignal, { once: true })
    }
  }
  activeChatDrivers.set(session.sessionId, { abort: driverAbort, session })

  try {
    while (true) {
      // turn 首批：next-step 全量 + next-turn 恰 1 条（claim 即消费，抽干不回滚）
      const batch = claimTurnStartBatch(session.inbox)
      session.inbox = batch.state
      onEvent?.({ type: 'inbox-updated', session })

      // 首批为空 = 收件箱抽干 → 收工
      if (!batch.followup && batch.steering.length === 0) {
        break
      }

      const outcome = await runDriverTurn({ session, input, batch, signal: driverAbort.signal, onEvent })

      // 停止：当前 turn 已优雅收尾，队列保留不自动续跑
      if (outcome.aborted) {
        break
      }
    }
  } finally {
    input.signal?.removeEventListener('abort', linkCallerSignal)
    // 清闩锁：driver 收敛。收件箱剩余消息留在会话里，等用户下次发送时随首批带走。
    // 收敛期间到达过唤醒请求且收件箱非空 → 带新 input 重新唤醒（dsh wakeRequested 闩锁语义）。
    const pendingWake = activeChatDrivers.get(session.sessionId)?.pendingWake
    activeChatDrivers.delete(session.sessionId)
    if (pendingWake && hasPendingMessages(session.inbox)) {
      wakeChatDriver(pendingWake)
    }
  }

  session.status = 'waiting-user'
  return {
    session,
    target: session.currentTarget,
  }
}

type DriverTurnBatch = {
  steering: QueuedMessage[]
  followup?: QueuedMessage
}

/**
 * driver 内的单个 turn：对应旧 runChatTurn 的一次执行。
 * 首批消息在此进显示层与模型视图（steer 在前、followup 在后）；turn 间 runId 各自独立。
 */
async function runDriverTurn(options: {
  session: ChatSessionState
  input: ChatTurnInput
  batch: DriverTurnBatch
  signal?: AbortSignal
  onEvent?: (event: SessionEvent) => void
}): Promise<{ aborted: boolean }> {
  const { input, batch, signal, onEvent } = options
  const session = options.session

  // 「当前文件」以本轮 followup 自己的入队快照为准（排队多条时各用各的）；
  // steer-only 轮或旧队列消息无快照时，回退到唤醒 driver 时的快照。
  const activeFilePath = batch.followup?.activeFilePath ?? input.activeFilePath
  const target = deriveChatTargetFromPath(activeFilePath)
  session.currentTarget = target
  const runId = createLogId('run')

  void writeAgentLog(input.project, {
    sessionId: session.sessionId,
    runId,
    level: 'info',
    event: 'agent_run_start',
    message: 'Agent 开始处理用户输入',
    data: {
      instruction: batch.followup?.text,
      quote: batch.followup?.quote,
      steeringCount: batch.steering.length,
      activeFilePath,
      target,
    },
  })

  // 显示层逐条 push（批次内顺序 = 先全部 steer 气泡，后 followup 气泡）：
  // followup = 普通 user 气泡，是任务组边界；steer 批次 = steering 气泡（steered 标记），不是边界。
  for (const message of batch.steering) {
    pushMessage(session, createSteeringMessage(message), onEvent)
  }
  if (batch.followup) {
    pushMessage(session, createUserMessage(batch.followup.text, batch.followup.quote), onEvent)
  }
  // 每 turn 的两条 context-summary 保持每 turn push；steer 续 turn 在 query 内发生，不产生新条目
  pushMessage(session, createContextSummary(target), onEvent)
  pushMessage(
    session,
    {
      id: createId('message'),
      role: 'system',
      kind: 'context-summary',
      summary: '本轮任务类型：Agent Loop，由模型根据上下文自主决定是否读写文件',
      createdAt: new Date().toISOString(),
    },
    onEvent,
  )

  // 模型视图：发给 LLM 的消息序列唯一来源。与显示层 messages 彻底分离——
  // 显示层是全量 transcript（持久化 + UI），模型层持久化的是压缩后的当前视图。
  // 拷贝建视图，本回合的变更不污染传入的会话对象。
  const modelView = createModelView(session.modelView?.messages ?? [])
  session.modelView = modelView

  // 同会话内 system.md 或场景提示词变化时，刷新视图里的 system message（恒在 index 0）。
  const newSystemContent = buildAgentSystemPrompt({
    systemPrompt: input.systemPrompt,
    scenePrompt: input.scenePrompt,
    novaiOverview: input.novaiOverview,
  })
  const newSystemHash = hashContent(newSystemContent)
  if (modelView.messages.length === 0 || session.systemPromptHash !== newSystemHash) {
    setSystemMessage(modelView, newSystemContent)
  }
  session.systemPromptHash = newSystemHash

  // 模型视图追加（同批次顺序）：steer 包装为「执行中插话」，followup 走完整用户上下文
  for (const message of batch.steering) {
    appendUserMessage(modelView, buildSteeringContent(message))
  }
  if (batch.followup) {
    appendUserMessage(modelView, buildAgentUserContext({
      instruction: batch.followup.text,
      quote: batch.followup.quote,
      project: input.project,
      target,
    }))
  }
  const requestMessages = toRequestMessages(modelView)
  const tools = createAgentTools()
  const enableDebugLogging = Boolean(input.config.settings.enableDebugLogging)
  let aborted = false
  // 当前正在流式输出的 assistant 消息 id：delta 事件携带它，最终的 assistant 落盘消息复用它，
  // 让 UI 能把连续 delta 累积到同一条气泡上、并用完成事件原位替换。
  let streamingMessageId: string | null = null

  if (enableDebugLogging) {
    void writeAgentLog(input.project, {
      sessionId: session.sessionId,
      runId,
      level: 'debug',
      event: 'agent_messages_debug',
      message: 'Agent 模型输入消息调试信息',
      data: {
        messageCount: requestMessages.length,
        messages: summarizeAgentMessages(requestMessages),
      },
    })
  }

  try {
    await query({
      config: input.config,
      project: input.project,
      view: modelView,
      tools,
      signal,
      confirm: input.confirm,
      // 改动账本只读取口（GetFileChangeHistory 用）：getter 形态，账本不可变重建、读时取最新
      getChangeLedger: () => session.changeLedger ?? [],
      // 插话收件箱访问口：query 在每个 step 边界抽干 next-step（claim 即消费，同步更新会话 inbox）
      steering: {
        drain() {
          const claimed = claimFromInbox(session.inbox, 'next-step')
          session.inbox = claimed.state
          if (claimed.messages.length > 0) {
            onEvent?.({ type: 'inbox-updated', session })
          }
          return claimed.messages
        },
        hasPending() {
          return (session.inbox?.nextStep.length ?? 0) > 0
        },
      },
      onEvent(event) {
        logAgentQueryEvent({
          project: input.project,
          session,
          runId,
          event,
        })

        if (event.type === 'aborted') {
          aborted = true
          void writeAgentLog(input.project, {
            sessionId: session.sessionId,
            runId,
            level: 'info',
            event: 'agent_run_aborted',
            message: 'Agent 被用户停止',
          })
          return
        }

        if (event.type === 'steering-message') {
          // 抽干点取到的插话：已进模型视图，这里补显示层气泡（与普通用户气泡零视觉区别）
          pushMessage(session, createSteeringMessage(event.message), onEvent)
          return
        }

        if (event.type === 'turn-limit-reached') {
          pushMessage(
            session,
            {
              id: createId('message'),
              role: 'system',
              kind: 'turn-limit',
              summary: `本轮 Agent 已达最大循环次数（${event.maxTurns}），先停在这里。上下文已保留，继续发送消息即可让它接着完成。`,
              createdAt: new Date().toISOString(),
            },
            onEvent,
          )
          return
        }

        if (event.type === 'context-compacted') {
          pushMessage(
            session,
            {
              id: createId('message'),
              role: 'system',
              kind: 'context-summary',
              summary: `已自动压缩 ${event.compactedMessageCount} 条早期消息（约 ${event.originalTokens} → ${event.summaryTokens} token），此前对话以检查点摘要继续`,
              createdAt: new Date().toISOString(),
            },
            onEvent,
          )
          return
        }

        if (event.type === 'assistant-delta') {
          streamingMessageId ??= createId('message')
          onEvent?.({ type: 'message-delta', messageId: streamingMessageId, text: event.text })
          return
        }

        if (event.type === 'assistant-message') {
          if (event.message.content.trim()) {
            pushMessage(
              session,
              createAssistantText(event.message.content.trim(), streamingMessageId ?? undefined),
              onEvent,
            )
          }
          // 本条 assistant 消息完结（无论是否有正文），下一条流式文本属于新气泡
          streamingMessageId = null
          return
        }

        if (event.type === 'tool-call') {
          pushMessage(
            session,
            {
              id: createId('message'),
              role: 'system',
              kind: 'tool-call',
              toolName: event.call.name,
              inputSummary: event.inputSummary,
              toolCallId: event.call.id,
              createdAt: new Date().toISOString(),
            },
            onEvent,
          )
          return
        }

        if (event.type === 'tool-result') {
          // 改动账本累积点：事件驱动 append-only（与 modelView 无关 → 免疫压缩）。
          // 不可变重建数组，不污染入参数组；diff 仅写工具成功且有 extractChangeDiff 时存在。
          if (event.ok && event.fileChange) {
            session.changeLedger = [
              ...(session.changeLedger ?? []),
              {
                id: createId('change'),
                runId,
                at: new Date().toISOString(),
                change: event.fileChange,
                ...(event.diff ? { diff: event.diff } : {}),
              },
            ]
          }

          pushMessage(
            session,
            {
              id: createId('message'),
              role: 'system',
              kind: 'tool-result',
              toolName: event.call.name,
              ok: event.ok,
              resultSummary: event.resultSummary,
              toolCallId: event.call.id,
              createdAt: new Date().toISOString(),
            },
            onEvent,
          )
        }
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '模型生成失败'
    session.status = 'error'
    void writeAgentLog(input.project, {
      sessionId: session.sessionId,
      runId,
      level: 'error',
      event: 'agent_run_error',
      message,
    })
    pushErrorMessage(session, message, true, onEvent)
    throw error
  }

  // 本轮账本切片（change-summary 只存 runId，面板数据渲染时按 runId 从账本解析）
  const turnChanges = (session.changeLedger ?? []).filter((record) => record.runId === runId)

  if (aborted) {
    // 被停止：一律 push change-summary——有改动渲染为面板并带「已停止」标记；
    // 无改动渲染为一行「本轮已被用户停止」。
    pushMessage(
      session,
      {
        id: createId('message'),
        role: 'system',
        kind: 'change-summary',
        runId,
        aborted: true,
        createdAt: new Date().toISOString(),
      },
      onEvent,
    )

    return { aborted: true }
  }

  // 正常结束：本轮账本非空才 push change-summary 面板；纯问答轮什么都不 push（无「回答完毕」噪音）
  if (turnChanges.length > 0) {
    pushMessage(
      session,
      {
        id: createId('message'),
        role: 'system',
        kind: 'change-summary',
        runId,
        createdAt: new Date().toISOString(),
      },
      onEvent,
    )
  }

  void writeAgentLog(input.project, {
    sessionId: session.sessionId,
    runId,
    level: 'info',
    event: 'agent_run_finish',
    message: turnChanges.length > 0
      ? `Agent 本轮完成，产生 ${turnChanges.length} 处文件变更`
      : 'Agent 本轮完成，未写入文件',
    data: {
      changeCount: turnChanges.length,
      agentMessageCount: session.modelView?.messages.length ?? 0,
    },
  })

  return { aborted: false }
}

function logAgentQueryEvent(input: {
  project: ChatTurnInput['project']
  session: ChatSessionState
  runId: string
  event: AgentQueryEvent
}) {
  const base = {
    sessionId: input.session.sessionId,
    runId: input.runId,
  }

  if (input.event.type === 'query-step-start') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'query_step_start',
      message: `Query Step ${input.event.step} 开始`,
      data: { step: input.event.step },
    })
    return
  }

  if (input.event.type === 'model-start') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'model_start',
      message: `第 ${input.event.step} 轮模型调用开始`,
      data: input.event.debug
        ? {
          step: input.event.step,
          ...input.event.debug,
        }
        : { step: input.event.step },
    })
    return
  }

  if (input.event.type === 'model-finish') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'model_finish',
      message: `第 ${input.event.step} 轮模型调用结束，返回 ${input.event.toolCallCount} 个工具调用`,
      data: input.event,
    })
    return
  }

  if (input.event.type === 'model-tool-call-parse-warning') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'warn',
      event: 'model_tool_call_parse_warning',
      message: `第 ${input.event.step} 轮模型以 tool_calls 结束，但没有解析出有效工具调用`,
      data: input.event,
    })
    return
  }

  if (input.event.type === 'assistant-message') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'assistant_message',
      message: input.event.message.toolCalls?.length
        ? `Assistant 返回文本并请求 ${input.event.message.toolCalls.length} 个工具调用`
        : 'Assistant 返回文本',
      data: {
        content: input.event.message.content,
        toolCalls: input.event.message.toolCalls,
      },
    })
    return
  }

  if (input.event.type === 'turn-limit-reached') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'warn',
      event: 'turn_limit_reached',
      message: `已达 Agent 单轮最大循环次数（${input.event.maxTurns}），优雅收尾`,
      data: input.event,
    })
    return
  }

  if (input.event.type === 'context-compacted') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'context_compacted',
      message: `上下文已压缩：${input.event.compactedMessageCount} 条消息浓缩为检查点（${input.event.originalTokens} → ${input.event.summaryTokens} token）`,
      data: input.event,
    })
    return
  }

  if (input.event.type === 'tool-batch-start') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'tool_batch_start',
      message: `第 ${input.event.step} 轮开始执行 ${input.event.toolCallCount} 个工具调用`,
      data: input.event,
    })
    return
  }

  if (input.event.type === 'tool-call') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'tool_call',
      message: input.event.inputSummary,
      data: {
        id: input.event.call.id,
        name: input.event.call.name,
        input: input.event.call.input,
      },
    })
    return
  }

  if (input.event.type === 'tool-result') {
    void writeAgentLog(input.project, {
      ...base,
      level: input.event.ok ? 'info' : 'error',
      event: 'tool_result',
      message: input.event.resultSummary,
      data: {
        id: input.event.call.id,
        name: input.event.call.name,
        ok: input.event.ok,
      },
    })
    return
  }

  if (input.event.type === 'tool-batch-finish') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'tool_batch_finish',
      message: `第 ${input.event.step} 轮工具执行结束`,
      data: input.event,
    })
    return
  }

  if (input.event.type === 'done') {
    void writeAgentLog(input.project, {
      ...base,
      level: 'info',
      event: 'query_done',
      message: 'Query Loop 完成',
      data: {
        messageCount: input.event.messages.length,
      },
    })
  }
}

function summarizeAgentMessages(messages: AgentMessage[]) {
  return messages.map((message, index) => {
    if (message.role === 'assistant') {
      return {
        index,
        role: message.role,
        contentLength: message.content.length,
        contentPreview: previewLogText(message.content),
        toolCallCount: message.toolCalls?.length ?? 0,
        toolCalls: message.toolCalls?.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        })),
      }
    }

    if (message.role === 'tool') {
      return {
        index,
        role: message.role,
        toolCallId: message.toolCallId,
        name: message.name,
        contentLength: message.content.length,
        contentPreview: previewLogText(message.content),
      }
    }

    return {
      index,
      role: message.role,
      contentLength: message.content.length,
      contentPreview: previewLogText(message.content),
    }
  })
}

function previewLogText(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 600 ? `${normalized.slice(0, 600)}...` : normalized
}

function pushMessage(
  session: ChatSessionState,
  message: ChatMessage,
  onEvent?: (event: SessionEvent) => void,
) {
  session.messages = [...session.messages, message]
  // 携带会话引用：change-summary 等消息在 service 层转 view 时需按 runId 从 changeLedger 解析
  onEvent?.({ type: 'message', message, session })
}

function pushErrorMessage(
  session: ChatSessionState,
  message: string,
  recoverable: boolean,
  onEvent?: (event: SessionEvent) => void,
) {
  pushMessage(
    session,
    {
      id: createId('message'),
      role: 'system',
      kind: 'error',
      message,
      recoverable,
      createdAt: new Date().toISOString(),
    },
    onEvent,
  )
}

function createUserMessage(text: string, quote?: string): ChatMessage {
  return {
    id: createId('message'),
    role: 'user',
    kind: 'text',
    text,
    quote,
    createdAt: new Date().toISOString(),
  }
}

/** steering 气泡：渲染与普通用户气泡零视觉区别（dsh 同款），仅 steered 数据标记供分组规则判定。 */
function createSteeringMessage(message: QueuedMessage): ChatMessage {
  return {
    id: createId('message'),
    role: 'user',
    kind: 'text',
    text: message.text,
    quote: message.quote,
    steered: true,
    createdAt: message.at,
  }
}

function createAssistantText(text: string, id?: string): ChatMessage {
  return {
    id: id ?? createId('message'),
    role: 'assistant',
    kind: 'text',
    text,
    createdAt: new Date().toISOString(),
  }
}

function createContextSummary(target: ChatTargetContext | null): ChatMessage {
  return {
    id: createId('message'),
    role: 'system',
    kind: 'context-summary',
    summary: target?.primaryPath
      ? `本轮默认目标：${target.displayName}（${target.primaryPath}）`
      : '本轮默认目标：当前项目，将生成新的章节草稿',
    createdAt: new Date().toISOString(),
  }
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

/** 新会话默认标题，首轮用户消息后会被首句截断覆盖 */
export const DEFAULT_SESSION_TITLE = '新对话'

/** 首句截断上限（字符），用于从首条用户消息生成会话标题 */
const SESSION_TITLE_MAX_LENGTH = 20

/**
 * 从首条用户消息派生会话标题：取首行、压空白、超长截断加省略号。
 * 用于新建会话首轮发送后自动更新标题，避免列表里全是「新对话」。
 */
export function deriveSessionTitle(firstUserText: string): string {
  const firstLine = firstUserText.split(/\r?\n/)[0] ?? firstUserText
  const normalized = firstLine.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return DEFAULT_SESSION_TITLE
  }
  return normalized.length > SESSION_TITLE_MAX_LENGTH
    ? `${normalized.slice(0, SESSION_TITLE_MAX_LENGTH)}…`
    : normalized
}
