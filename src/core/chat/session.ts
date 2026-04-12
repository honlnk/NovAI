import { streamChatCompletion } from '../llm/client'
import { readProjectTextFile } from '../fs/project-fs'

import { deriveChatTargetFromPath } from './target'
import {
  createToolRuntimeContext,
  fileEditTool,
  fileReadTool,
  fileWriteTool,
  ragSearchTool,
} from './tools'

import type {
  ChatMessage,
  ChatSessionState,
  ChatTargetContext,
  ChatTurnInput,
  ChatTurnResult,
  ToolDefinition,
} from '../../types/chat'

type SessionEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'draft'; text: string }

type RunChatTurnOptions = {
  session: ChatSessionState
  input: ChatTurnInput
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
  }

  const target = deriveChatTargetFromPath(input.activeFilePath)
  session.currentTarget = target
  const taskType = analyzeTurnMode(input.instruction, target)
  session.lastTaskType = taskType

  pushMessage(session, createUserMessage(input.instruction), onEvent)
  pushMessage(session, createContextSummary(target), onEvent)
  pushMessage(
    session,
    {
      id: createId('message'),
      role: 'system',
      kind: 'context-summary',
      summary: summarizeTurnMode(taskType),
      createdAt: new Date().toISOString(),
    },
    onEvent,
  )

  const runtime = createToolRuntimeContext({
    project: input.project,
    config: input.config,
    target,
    session,
  })

  let targetFileContent = ''
  let targetPath = taskType === 'read-only'
    ? target?.primaryPath
    : resolveWritePath(input.project, target, taskType)
  const recentChapters = await loadRecentChapters(
    input.project,
    input.config.settings.generationRecentChapters,
    target?.type === 'chapter' ? target.primaryPath : undefined,
  )

  if ((taskType === 'edit-target' || taskType === 'read-only') && target?.primaryPath) {
    const readOutput = await callTool(fileReadTool, { path: target.primaryPath }, runtime, session, onEvent)
    targetFileContent = readOutput.content
    targetPath = target.primaryPath
  }

  if (recentChapters.length > 0) {
    pushMessage(
      session,
      {
        id: createId('message'),
        role: 'system',
        kind: 'context-summary',
        summary: `已补充近期章节上下文：${recentChapters.map((item) => item.path).join('、')}`,
        createdAt: new Date().toISOString(),
      },
      onEvent,
    )
  }

  if (shouldUseRag(input.instruction, target)) {
    const ragResult = await callTool(
      ragSearchTool,
      {
        query: input.instruction,
        topK: input.config.settings.ragContextMaxItems,
      },
      runtime,
      session,
      onEvent,
    )
    session.lastRagResult = ragResult
    pushMessage(
      session,
      {
        id: createId('message'),
        role: 'system',
        kind: 'context-summary',
        summary: summarizeRagContext(ragResult),
        createdAt: new Date().toISOString(),
      },
      onEvent,
    )
  } else {
    session.lastRagResult = null
  }

  const prompt = buildUserPrompt({
    instruction: input.instruction,
    target,
    targetFileContent,
    recentChapters,
    ragSummary: summarizeRag(session.lastRagResult),
  })

  pushMessage(session, createAssistantText('正在根据当前目标和上下文生成本轮结果。'), onEvent)

  let generatedText = ''

  try {
    generatedText = await streamChatCompletion(
      {
        baseUrl: input.config.llm.baseUrl,
        apiKey: input.config.llm.apiKey,
        model: input.config.llm.model,
        systemPrompt: input.systemPrompt,
        instruction: prompt,
      },
      (event) => {
        if (event.type === 'delta') {
          session.currentDraftText += event.text
          onEvent?.({ type: 'draft', text: session.currentDraftText })
        }
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : '模型生成失败'
    session.status = 'error'
    pushErrorMessage(session, message, true, onEvent)
    throw error
  }

  session.currentDraftText = generatedText.trim()
  onEvent?.({ type: 'draft', text: session.currentDraftText })

  if (taskType === 'read-only') {
    pushMessage(
      session,
      {
        id: createId('message'),
        role: 'assistant',
        kind: 'action-summary',
        summary: targetPath
          ? `已完成只读分析，未修改文件。分析目标：${targetPath}`
          : '已完成项目级只读分析，未修改任何文件。',
        targetPath,
        relatedPaths: session.lastRagResult?.candidates.slice(0, 3).map((item) => item.sourcePath) ?? [],
        createdAt: new Date().toISOString(),
      },
      onEvent,
    )

    session.status = 'waiting-user'

    return {
      session,
      target,
      writtenPath: undefined,
    }
  }

  if (!targetPath) {
    const message = '当前任务需要写文件，但没有可用的目标路径'
    session.status = 'error'
    pushErrorMessage(session, message, false, onEvent)
    throw new Error(message)
  }

  if (taskType === 'edit-target' && target?.primaryPath) {
    await callTool(fileEditTool, { path: targetPath, content: session.currentDraftText }, runtime, session, onEvent)
  } else {
    await callTool(fileWriteTool, { path: targetPath, content: session.currentDraftText }, runtime, session, onEvent)
  }

  session.lastWrittenPath = targetPath

  pushMessage(
    session,
    {
      id: createId('message'),
      role: 'assistant',
      kind: 'action-summary',
      summary: `已完成本轮处理，并写回 ${targetPath}`,
      targetPath,
      relatedPaths: session.lastRagResult?.candidates.slice(0, 3).map((item) => item.sourcePath) ?? [],
      createdAt: new Date().toISOString(),
    },
    onEvent,
  )

  session.status = 'waiting-user'

  return {
    session,
    target,
    writtenPath: targetPath,
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
