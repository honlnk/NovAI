import { streamAgentCompletion } from './llm'
import { runAgentTools } from './tool-orchestration'
import type { ToolExecutionEvent } from './tool-execution'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'
import type {
  AgentAssistantMessage,
  AgentMessage,
} from './messages'
import type { AgentRunnableToolMap } from './tools'

const DEFAULT_MAX_TURNS = 8

export type AgentQueryEvent =
  | { type: 'assistant-delta'; text: string }
  | { type: 'assistant-message'; message: AgentAssistantMessage }
  | ToolExecutionEvent
  | { type: 'done'; messages: AgentMessage[] }

export async function query(input: {
  config: ProjectConfig
  project: ProjectSnapshot
  messages: AgentMessage[]
  tools: AgentRunnableToolMap
  maxTurns?: number
  onEvent?: (event: AgentQueryEvent) => void
}): Promise<AgentMessage[]> {
  let messages = [...input.messages]
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const assistantResponse = await streamAgentCompletion(
      {
        baseUrl: input.config.llm.baseUrl,
        apiKey: input.config.llm.apiKey,
        model: input.config.llm.model,
        messages,
        tools: Object.values(input.tools).map((tool) => tool.schema),
      },
      (event) => {
        if (event.type === 'delta') {
          input.onEvent?.({ type: 'assistant-delta', text: event.text })
        }
      },
    )

    const assistantMessage: AgentAssistantMessage = {
      role: 'assistant',
      content: assistantResponse.content,
      toolCalls: assistantResponse.toolCalls,
    }

    messages = [...messages, assistantMessage]
    input.onEvent?.({ type: 'assistant-message', message: assistantMessage })

    if (assistantResponse.toolCalls.length === 0) {
      input.onEvent?.({ type: 'done', messages })
      return messages
    }

    const toolResults = await runAgentTools({
      calls: assistantResponse.toolCalls,
      project: input.project,
      tools: input.tools,
      onEvent: input.onEvent,
    })

    messages = [...messages, ...toolResults]
  }

  const limitMessage: AgentAssistantMessage = {
    role: 'assistant',
    content: `已达到本轮 Agent 最大循环次数（${maxTurns}）。我先停在这里，避免无限调用工具。`,
  }

  messages = [...messages, limitMessage]
  input.onEvent?.({ type: 'assistant-message', message: limitMessage })
  input.onEvent?.({ type: 'done', messages })
  return messages
}
