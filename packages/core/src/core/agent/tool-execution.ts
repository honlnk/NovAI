import type { ProjectSnapshot } from '../../types/project'
import type { AgentToolCall, AgentToolResultMessage } from './messages'
import type { AgentRunnableToolMap } from './tools'

export type ToolExecutionEvent =
  | { type: 'tool-call'; call: AgentToolCall; inputSummary: string }
  | { type: 'tool-result'; call: AgentToolCall; ok: boolean; resultSummary: string }

export async function executeAgentTool(input: {
  call: AgentToolCall
  project: ProjectSnapshot
  tools: AgentRunnableToolMap
  onEvent?: (event: ToolExecutionEvent) => void
}): Promise<AgentToolResultMessage> {
  const tool = input.tools[input.call.name]

  if (!tool) {
    const content = `未知工具：${input.call.name}`
    input.onEvent?.({
      type: 'tool-call',
      call: input.call,
      inputSummary: `调用未知工具：${input.call.name}`,
    })
    input.onEvent?.({
      type: 'tool-result',
      call: input.call,
      ok: false,
      resultSummary: content,
    })

    return {
      role: 'tool',
      toolCallId: input.call.id,
      name: input.call.name,
      content,
    }
  }

  let validatedInput: unknown

  try {
    validatedInput = tool.core.validateInput(input.call.input)
  } catch (error) {
    const message = error instanceof Error ? error.message : `${tool.name} 参数校验失败`
    input.onEvent?.({
      type: 'tool-call',
      call: input.call,
      inputSummary: `调用 ${tool.name}（参数校验失败）`,
    })
    input.onEvent?.({
      type: 'tool-result',
      call: input.call,
      ok: false,
      resultSummary: message,
    })

    return {
      role: 'tool',
      toolCallId: input.call.id,
      name: input.call.name,
      content: message,
    }
  }

  input.onEvent?.({
    type: 'tool-call',
    call: input.call,
    inputSummary: tool.core.summarizeInput(validatedInput),
  })

  try {
    const output = await tool.core.run(validatedInput, { project: input.project })
    const resultSummary = tool.core.summarizeOutput(output)

    input.onEvent?.({
      type: 'tool-result',
      call: input.call,
      ok: true,
      resultSummary,
    })

    return {
      role: 'tool',
      toolCallId: input.call.id,
      name: input.call.name,
      content: tool.formatResult(output),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : `${tool.name} 执行失败`
    input.onEvent?.({
      type: 'tool-result',
      call: input.call,
      ok: false,
      resultSummary: message,
    })

    return {
      role: 'tool',
      toolCallId: input.call.id,
      name: input.call.name,
      content: message,
    }
  }
}
