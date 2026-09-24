import { normalizeBaseUrl } from '../ai/shared'
import { testConnectionViaModelList } from '../ai/models-client'
import { streamAgentCompletion } from '../agent/llm'
import type { AgentMessage } from '../agent/messages'

import type {
  LlmStreamEvent,
  LlmStreamInput,
  ModelConnectionInput,
  ModelConnectionResult,
} from '../../types/ai'

/**
 * 测试 LLM 配置是否可用：拉取模型列表验证可达与鉴权，
 * 已填写模型名时顺带检查模型是否在列表中。
 */
export async function testLlmConnection(
  input: Omit<ModelConnectionInput, 'kind'>,
): Promise<ModelConnectionResult> {
  return testConnectionViaModelList({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    protocol: input.protocol,
    model: input.model,
    label: 'LLM',
    requiredMessage: '请先填写 API 地址和 API Key',
  })
}

/**
 * 发起一次最小化的流式对话生成（单轮 system + user，无工具）。
 * 薄入口：随 protocol 分发到 core/llm/protocol 下的适配器，
 * 要素提取等一次性结构化输出场景复用整条生成链路。
 */
export async function streamChatCompletion(
  input: LlmStreamInput,
  onEvent: (event: LlmStreamEvent) => void,
): Promise<string> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)

  if (!baseUrl || !input.apiKey.trim() || !input.model.trim()) {
    const message = '请先填写 LLM 的 API 地址、API Key 和模型名称'
    onEvent({ type: 'error', message })
    throw new Error(message)
  }

  const messages: AgentMessage[] = []

  if (input.systemPrompt?.trim()) {
    messages.push({
      role: 'system',
      content: input.systemPrompt.trim(),
    })
  }

  messages.push({
    role: 'user',
    content: input.instruction.trim(),
  })

  const response = await streamAgentCompletion(
    {
      baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      protocol: input.protocol,
      messages,
      tools: [],
      // 辅助请求固定关思考：一次性结构化输出（要素提取等）不需要思考流
      reasoningEffort: 'off',
    },
    (event) => {
      // 思考流增量对本场景无消费方；start/delta/error 保持原时序透传
      if (event.type === 'delta') {
        onEvent({ type: 'delta', text: event.text })
      } else if (event.type === 'start') {
        onEvent({ type: 'start' })
      } else if (event.type === 'error') {
        onEvent({ type: 'error', message: event.message })
      }
    },
  )

  onEvent({ type: 'finish', text: response.content })
  return response.content
}
