import { executeAgentTool } from './tool-execution'
import type { ConfirmHandler, ToolExecutionEvent } from './tool-execution'
import type { ToolPolicy } from './tool-policy'
import type { ProjectSnapshot } from '../../types/project'
import type { AgentToolCall, AgentToolResultMessage } from './messages'
import type { AgentRunnableToolMap } from './tools'
import type { ReadFileState } from '../tools/types'

export async function runAgentTools(input: {
  calls: AgentToolCall[]
  project: ProjectSnapshot
  tools: AgentRunnableToolMap
  readFileStates?: Map<string, ReadFileState>
  /** 用户停止信号：已停止时，批次内尚未开始执行的工具会被跳过。 */
  signal?: AbortSignal
  /** 写工具确认回调，透传给 executeAgentTool。 */
  confirm?: ConfirmHandler
  /** 用户即时工具约束，透传给 executeAgentTool。 */
  toolPolicy?: ToolPolicy
  onEvent?: (event: ToolExecutionEvent) => void
}): Promise<AgentToolResultMessage[]> {
  const results: AgentToolResultMessage[] = []

  for (const call of input.calls) {
    // 每个工具开始前检查：用户已停止时跳过剩余工具。
    // 仍为被跳过的工具补一条 tool result，保证消息序列对模型合法。
    if (input.signal?.aborted) {
      const skipSummary = '已因用户停止而跳过该工具'
      input.onEvent?.({
        type: 'tool-call',
        call,
        inputSummary: `跳过 ${call.name}（用户已停止）`,
      })
      input.onEvent?.({
        type: 'tool-result',
        call,
        ok: false,
        resultSummary: skipSummary,
      })
      results.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: skipSummary,
      })
      continue
    }

    results.push(await executeAgentTool({
      call,
      project: input.project,
      tools: input.tools,
      readFileStates: input.readFileStates,
      confirm: input.confirm,
      toolPolicy: input.toolPolicy,
      onEvent: input.onEvent,
    }))
  }

  return results
}
