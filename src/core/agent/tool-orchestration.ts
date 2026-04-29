import { executeAgentTool } from './tool-execution'
import type { ToolExecutionEvent } from './tool-execution'
import type { ProjectSnapshot } from '../../types/project'
import type { AgentToolCall, AgentToolResultMessage } from './messages'
import type { AgentRunnableToolMap } from './tools'

export async function runAgentTools(input: {
  calls: AgentToolCall[]
  project: ProjectSnapshot
  tools: AgentRunnableToolMap
  onEvent?: (event: ToolExecutionEvent) => void
}): Promise<AgentToolResultMessage[]> {
  const results: AgentToolResultMessage[] = []

  for (const call of input.calls) {
    results.push(await executeAgentTool({
      call,
      project: input.project,
      tools: input.tools,
      onEvent: input.onEvent,
    }))
  }

  return results
}
