import { readProjectTextFile } from '../fs/project-fs'
import { buildAgentSystemPrompt, buildAgentUserContext } from '../agent/prompt'
import { query } from '../agent/query'
import { createAgentTools } from '../agent/tools'
import { createLogId, writeAgentLog } from '../logging/agent-log'
import type { AgentQueryEvent } from '../agent/query'

import { deriveChatTargetFromPath } from './target'
import {
  createToolRuntimeContext,
  createFileTool,
  editFileTool,
  readFileTool,
  ragSearchTool,
} from './tools'

import type {
  ChatMessage,
  ChatSessionState,
  ChatTargetContext,
  ChatTurnInput,
  ChatTurnResult,
  PendingFileChange,
  ToolDefinition,
} from '../../types/chat'
import type { AgentMessage } from '../agent/messages'

type SessionEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'draft'; text: string }

type RunChatTurnOptions = {
  session: ChatSessionState
  input: ChatTurnInput
  onEvent?: (event: SessionEvent) => void
}

type ConfirmPendingFileChangeOptions = {
  session: ChatSessionState
  input: Pick<ChatTurnInput, 'project' | 'config'>
  onEvent?: (event: SessionEvent) => void
}

type TurnMode = 'read-only' | 'edit-target' | 'create-chapter'

export function createChatSession(projectId: string): ChatSessionState {
  return {
    sessionId: createId('session'),
    projectId,
    messages: [],
    status: 'idle',
    currentDraftText: '',
    currentTarget: null,
    lastRagResult: null,
  }
}

export async function runChatTurn(options: RunChatTurnOptions): Promise<ChatTurnResult> {
  const { input, onEvent } = options
  const session: ChatSessionState = {
    ...options.session,
    status: 'running',
    currentDraftText: '',
    lastWrittenPath: undefined,
    pendingFileChange: undefined,
  }

  const target = deriveChatTargetFromPath(input.activeFilePath)
  session.currentTarget = target
  session.lastTaskType = undefined
  const runId = createLogId('run')

  void writeAgentLog(input.project, {
    sessionId: session.sessionId,
    runId,
    level: 'info',
    event: 'agent_run_start',
    message: 'Agent 开始处理用户输入',
    data: {
      instruction: input.instruction,
      activeFilePath: input.activeFilePath,
      target,
    },
  })

  pushMessage(session, createUserMessage(input.instruction), onEvent)
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

  const agentMessages = buildAgentMessages({
    previousMessages: session.agentMessages,
    instruction: input.instruction,
    systemPrompt: input.systemPrompt,
    project: input.project,
    target,
  })
  const tools = createAgentTools()

  try {
    session.agentMessages = await query({
      config: input.config,
      project: input.project,
      messages: agentMessages,
      tools,
      onEvent(event) {
        logAgentQueryEvent({
          project: input.project,
          session,
          runId,
          event,
        })

        if (event.type === 'assistant-delta') {
          session.currentDraftText += event.text
          onEvent?.({ type: 'draft', text: session.currentDraftText })
          return
        }

        if (event.type === 'assistant-message') {
          if (event.message.content.trim()) {
            pushMessage(session, createAssistantText(event.message.content.trim()), onEvent)
          }
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
              createdAt: new Date().toISOString(),
            },
            onEvent,
          )
          return
        }

        if (event.type === 'tool-result') {
          if (
            event.ok &&
            (event.call.name === 'EditFile' || event.call.name === 'CreateFile') &&
            typeof event.call.input.path === 'string'
          ) {
            session.lastWrittenPath = event.call.input.path
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

  pushMessage(
    session,
    {
      id: createId('message'),
      role: 'assistant',
      kind: 'action-summary',
      summary: session.lastWrittenPath
        ? `本轮 Agent Loop 完成，已写回 ${session.lastWrittenPath}`
        : '本轮 Agent Loop 完成，未写入文件。',
      targetPath: session.lastWrittenPath,
      createdAt: new Date().toISOString(),
    },
    onEvent,
  )

  session.status = 'waiting-user'

  void writeAgentLog(input.project, {
    sessionId: session.sessionId,
    runId,
    level: 'info',
    event: 'agent_run_finish',
    message: session.lastWrittenPath
      ? `Agent 本轮完成并写回 ${session.lastWrittenPath}`
      : 'Agent 本轮完成，未写入文件',
    data: {
      writtenPath: session.lastWrittenPath,
      agentMessageCount: session.agentMessages?.length ?? 0,
    },
  })

  return {
    session,
    target,
    writtenPath: session.lastWrittenPath,
  }
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
      data: { step: input.event.step },
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

function buildAgentMessages(input: {
  previousMessages?: AgentMessage[]
  instruction: string
  systemPrompt: string
  project: ChatTurnInput['project']
  target: ChatTargetContext | null
}): AgentMessage[] {
  const nextUserMessage: AgentMessage = {
    role: 'user',
    content: buildAgentUserContext({
      instruction: input.instruction,
      project: input.project,
      target: input.target,
    }),
  }

  if (input.previousMessages?.length) {
    return [...input.previousMessages, nextUserMessage]
  }

  return [
    {
      role: 'system',
      content: buildAgentSystemPrompt(input.systemPrompt),
    },
    nextUserMessage,
  ]
}

export async function confirmPendingFileChange(
  options: ConfirmPendingFileChangeOptions,
): Promise<ChatTurnResult> {
  const { input, onEvent } = options
  const session: ChatSessionState = {
    ...options.session,
    status: 'running',
  }
  const pendingFileChange = session.pendingFileChange

  if (!pendingFileChange) {
    const message = '当前没有等待确认的文件变更'
    session.status = 'error'
    pushErrorMessage(session, message, true, onEvent)
    throw new Error(message)
  }

  const runtime = createToolRuntimeContext({
    project: input.project,
    config: input.config,
    target: session.currentTarget,
    session,
  })

  if (pendingFileChange.type === 'edit') {
    await callTool(
      editFileTool,
      {
        path: pendingFileChange.path,
        oldText: pendingFileChange.oldText,
        newText: pendingFileChange.newText,
      },
      runtime,
      session,
      onEvent,
    )
  } else {
    await callTool(
      createFileTool,
      {
        path: pendingFileChange.path,
        content: pendingFileChange.content,
      },
      runtime,
      session,
      onEvent,
    )
  }

  session.lastWrittenPath = pendingFileChange.path
  session.pendingFileChange = undefined

  pushMessage(
    session,
    {
      id: createId('message'),
      role: 'assistant',
      kind: 'action-summary',
      summary: `已确认并写回 ${pendingFileChange.path}`,
      targetPath: pendingFileChange.path,
      relatedPaths: session.lastRagResult?.candidates.slice(0, 3).map((item) => item.sourcePath) ?? [],
      createdAt: new Date().toISOString(),
    },
    onEvent,
  )

  session.status = 'waiting-user'

  return {
    session,
    target: session.currentTarget,
    writtenPath: pendingFileChange.path,
  }
}

export function discardPendingFileChange(session: ChatSessionState): ChatSessionState {
  if (!session.pendingFileChange) {
    return session
  }

  return {
    ...session,
    status: 'waiting-user',
    pendingFileChange: undefined,
    messages: [
      ...session.messages,
      {
        id: createId('message'),
        role: 'assistant',
        kind: 'action-summary',
        summary: `已放弃 ${session.pendingFileChange.path} 的待写入草稿。`,
        targetPath: session.pendingFileChange.path,
        createdAt: new Date().toISOString(),
      },
    ],
  }
}

function createPendingFileChange(input: {
  taskType: Exclude<TurnMode, 'read-only'>
  targetPath: string
  targetFileContent: string
  draftText: string
}): PendingFileChange {
  if (input.taskType === 'edit-target') {
    return {
      id: createId('pending-change'),
      type: 'edit',
      path: input.targetPath,
      oldText: input.targetFileContent,
      newText: input.draftText,
      createdAt: new Date().toISOString(),
    }
  }

  return {
    id: createId('pending-change'),
    type: 'create',
    path: input.targetPath,
    content: input.draftText,
    createdAt: new Date().toISOString(),
  }
}

async function callTool<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
  input: TInput,
  runtime: ReturnType<typeof createToolRuntimeContext>,
  session: ChatSessionState,
  onEvent?: (event: SessionEvent) => void,
) {
  pushMessage(
    session,
    {
      id: createId('message'),
      role: 'system',
      kind: 'tool-call',
      toolName: tool.name,
      inputSummary: tool.summarizeInput(input),
      createdAt: new Date().toISOString(),
    },
    onEvent,
  )

  try {
    const output = await tool.call(tool.validateInput(input), runtime)

    pushMessage(
      session,
      {
        id: createId('message'),
        role: 'system',
        kind: 'tool-result',
        toolName: tool.name,
        ok: true,
        resultSummary: tool.summarizeOutput(output),
        createdAt: new Date().toISOString(),
      },
      onEvent,
    )

    return output
  } catch (error) {
    const message = error instanceof Error ? error.message : `${tool.name} 执行失败`
    session.status = 'error'
    pushMessage(
      session,
      {
        id: createId('message'),
        role: 'system',
        kind: 'tool-result',
        toolName: tool.name,
        ok: false,
        resultSummary: message,
        createdAt: new Date().toISOString(),
      },
      onEvent,
    )
    pushErrorMessage(session, message, true, onEvent)
    throw error
  }
}

async function loadRecentChapters(
  project: ChatTurnInput['project'],
  limit: number,
  excludedPath?: string,
) {
  const chapterPaths = flattenChapterPaths(project.tree)
    .filter((path) => path !== excludedPath)
    .sort((left, right) => right.localeCompare(left, 'zh-Hans-CN'))
    .slice(0, limit)

  return Promise.all(
    chapterPaths.map(async (path) => ({
      path,
      title: path.split('/').pop() || path,
      content: await readProjectTextFile(project.handle, path),
    })),
  )
}

function flattenChapterPaths(tree: ChatTurnInput['project']['tree']) {
  const stack = [...tree]
  const paths: string[] = []

  while (stack.length > 0) {
    const node = stack.shift()

    if (!node) {
      continue
    }

    if (node.kind === 'file' && node.path.startsWith('chapters/') && node.name.endsWith('.md')) {
      paths.push(node.path)
      continue
    }

    if (node.children?.length) {
      stack.unshift(...node.children)
    }
  }

  return paths
}

function pushMessage(
  session: ChatSessionState,
  message: ChatMessage,
  onEvent?: (event: SessionEvent) => void,
) {
  session.messages = [...session.messages, message]
  onEvent?.({ type: 'message', message })
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

function createUserMessage(text: string): ChatMessage {
  return {
    id: createId('message'),
    role: 'user',
    kind: 'text',
    text,
    createdAt: new Date().toISOString(),
  }
}

function createAssistantText(text: string): ChatMessage {
  return {
    id: createId('message'),
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

function shouldUseRag(instruction: string, target: ChatTargetContext | null) {
  if (isReadOnlyIntent(instruction)) {
    return true
  }

  if (target?.type === 'chapter' || target?.type === 'element') {
    return true
  }

  return /人物|角色|地点|设定|世界观|剧情|线索|前文|一致性/.test(instruction)
}

function analyzeTurnMode(
  instruction: string,
  target: ChatTargetContext | null,
): TurnMode {
  const normalized = instruction.trim()

  if (isReadOnlyIntent(normalized)) {
    return 'read-only'
  }

  if (/下一章|新章节|写下一章|写一章|续写|继续写/.test(normalized)) {
    return 'create-chapter'
  }

  if (!target?.primaryPath) {
    return 'create-chapter'
  }

  if (target.type !== 'chapter') {
    return 'edit-target'
  }

  if (/创建|新建/.test(normalized) && /章节|一章/.test(normalized)) {
    return 'create-chapter'
  }

  return 'edit-target'
}

function isReadOnlyIntent(instruction: string) {
  return /看一下|总结|概括|分析|梳理|列出|有哪些|都写了哪些|回顾|介绍一下|说明一下/.test(instruction)
}

function resolveWritePath(
  project: ChatTurnInput['project'],
  target: ChatTargetContext | null,
  taskType: 'edit-target' | 'create-chapter',
) {
  if (taskType === 'edit-target' && target?.primaryPath) {
    return target.primaryPath
  }

  return buildNextChapterPath(project)
}

function buildNextChapterPath(project: ChatTurnInput['project']) {
  const chapterPaths = flattenChapterPaths(project.tree)
  const maxSequence = chapterPaths.reduce((max, path) => {
    const matched = path.match(/(\d{1,4})/)
    if (!matched) {
      return max
    }

    return Math.max(max, Number(matched[1]))
  }, 0)

  const nextSequence = String(maxSequence + 1).padStart(3, '0')
  return `chapters/第${nextSequence}章-未命名章节.md`
}

function summarizeTurnMode(mode: TurnMode) {
  if (mode === 'read-only') {
    return '本轮任务类型：只读分析，不修改文件'
  }

  if (mode === 'create-chapter') {
    return '本轮任务类型：生成新章节'
  }

  return '本轮任务类型：修改当前目标文件'
}

function summarizeRag(result: ChatSessionState['lastRagResult']) {
  if (!result || result.candidates.length === 0) {
    return '无相关 RAG 候选'
  }

  return result.candidates
    .slice(0, 5)
    .map((item, index) => `${index + 1}. ${item.name} - ${item.summary}`)
    .join('\n')
}

function summarizeRagContext(result: ChatSessionState['lastRagResult']) {
  if (!result || result.candidates.length === 0) {
    return 'RAG 未命中可用要素上下文'
  }

  return `RAG 已补充 ${result.candidates.length} 条候选，上下文优先使用前 ${Math.min(result.candidates.length, 5)} 条`
}

function buildUserPrompt(input: {
  instruction: string
  target: ChatTargetContext | null
  targetFileContent: string
  recentChapters: Array<{ path: string; title: string; content: string }>
  ragSummary: string
}) {
  return [
    '你是 NovAI 第一阶段会话引擎中的小说写作智能体。',
    '你的输出会直接写回目标文件，所以请只输出最终文件内容，不要额外解释、不要加前言、不要用代码块。',
    '如果任务是只读分析，请直接输出给用户看的分析结果，不要伪装成小说正文或文件内容。',
    '如果任务是修改已有文件，请输出完整修改后的全文，而不是局部片段。',
    '如果任务是生成新章节，请输出完整 Markdown 章节正文。',
    '保持与当前项目设定、人物状态、情节连续性一致；若上下文不足，优先保守延续现有内容。',
    `用户意图：${input.instruction}`,
    `当前目标：${input.target?.displayName ?? '当前项目'}`,
    `目标路径：${input.target?.primaryPath ?? '将创建新章节文件'}`,
    `任务类型：${input.target?.primaryPath ? '基于当前目标执行分析或修改' : '新章节生成或项目级分析'}`,
    '当前文件内容：',
    input.targetFileContent || '当前目标文件为空。',
    '近期章节上下文：',
    formatRecentChapters(input.recentChapters),
    'RAG 检索摘要：',
    input.ragSummary,
    '输出要求：',
    '1. 只返回最终文件内容。',
    '2. 不要解释你做了什么。',
    '3. 不要输出 JSON、标签、标题说明或额外注释。',
  ].join('\n\n')
}

function formatRecentChapters(chapters: Array<{ path: string; title: string; content: string }>) {
  if (chapters.length === 0) {
    return '无可用近期章节。'
  }

  return chapters
    .map((chapter, index) => {
      const excerpt = chapter.content.trim().slice(0, 1200)
      return `${index + 1}. ${chapter.path}\n${excerpt || '（空内容）'}`
    })
    .join('\n\n')
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}
