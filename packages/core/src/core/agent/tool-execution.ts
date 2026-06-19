import type { ProjectSnapshot } from '../../types/project'
import type { AgentToolCall, AgentToolResultMessage } from './messages'
import type { AgentRunnableToolMap } from './tools'
import type { FileChange, ReadFileState, WriteConfirmation } from '../tools/types'

export type ToolExecutionEvent =
  | { type: 'tool-call'; call: AgentToolCall; inputSummary: string }
  | { type: 'tool-result'; call: AgentToolCall; ok: boolean; resultSummary: string; fileChange?: FileChange }

/** 写工具执行前的确认请求，交由上层（service）转交 UI 等待用户决定。 */
export type WriteConfirmationRequest = {
  call: AgentToolCall
  confirmation: WriteConfirmation
}

export type ConfirmDecision = { accepted: boolean }

/**
 * 写工具确认回调。返回用户是否接受写入。
 * service 层实现：发 confirmation-required 事件 → 等待 respondConfirmation → resolve。
 * 拒绝/停止时 resolve 为 { accepted: false }，由 tool-execution 决定是否跳过执行。
 */
export type ConfirmHandler = (request: WriteConfirmationRequest) => Promise<ConfirmDecision>

export async function executeAgentTool(input: {
  call: AgentToolCall
  project: ProjectSnapshot
  tools: AgentRunnableToolMap
  readFileStates?: Map<string, ReadFileState>
  /** 写工具确认回调；未传时不做确认（测试/只读场景）。 */
  confirm?: ConfirmHandler
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

  // 写工具执行前确认：构造预览并等待用户决定。
  // 拒绝时不执行 run，返回「用户已拒绝」tool result 回灌模型，让其自然调整。
  if (!tool.isReadOnly && tool.core.buildConfirmation && input.confirm) {
    const confirmation = tool.core.buildConfirmation(validatedInput)
    let decision: ConfirmDecision
    try {
      decision = await input.confirm({ call: input.call, confirmation })
    } catch {
      // 确认等待被中断（如用户停止），按拒绝处理，交由 query Loop 的 abort 检查接管。
      decision = { accepted: false }
    }

    if (!decision.accepted) {
      const rejectedSummary = `用户已拒绝${summarizeConfirmation(confirmation)}，未修改文件`
      input.onEvent?.({
        type: 'tool-result',
        call: input.call,
        ok: false,
        resultSummary: rejectedSummary,
      })

      return {
        role: 'tool',
        toolCallId: input.call.id,
        name: input.call.name,
        content: `用户拒绝执行该操作，文件未修改。请改用其他方式完成任务，或向用户确认后再试。`,
      }
    }
  }

  try {
    const output = await tool.core.run(validatedInput, {
      project: input.project,
      readFileStates: input.readFileStates,
    })
    const resultSummary = tool.core.summarizeOutput(output)
    // 写工具成功执行后提取结构化文件变更，供 service 层推导 changedFiles
    const fileChange = tool.core.extractFileChange?.(output)

    input.onEvent?.({
      type: 'tool-result',
      call: input.call,
      ok: true,
      resultSummary,
      fileChange,
    })

    return {
      role: 'tool',
      toolCallId: input.call.id,
      name: input.call.name,
      content: tool.formatResult(output),
      fileChange,
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

function summarizeConfirmation(confirmation: WriteConfirmation): string {
  switch (confirmation.kind) {
    case 'create':
      return `新建 ${confirmation.path}`
    case 'edit':
      return `修改 ${confirmation.path}`
    case 'rename':
      return `重命名 ${confirmation.fromPath} 到 ${confirmation.toPath}`
    case 'delete':
      return `删除 ${confirmation.path}`
  }
}
