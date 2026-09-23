import type { ModelProtocol } from '../../../types/ai'

import { anthropicAdapter } from './anthropic'
import { geminiAdapter } from './gemini'
import { openAiChatAdapter } from './openai-chat'
import type { ProtocolAdapter } from './types'

/**
 * 协议注册表：协议名 → 适配器。
 * 各波次补齐：W1 openai，W2 anthropic，W3 gemini，W4 openai-responses。
 */
const ADAPTERS: Partial<Record<ModelProtocol, ProtocolAdapter>> = {
  openai: openAiChatAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
}

export function resolveProtocolAdapter(protocol: ModelProtocol): ProtocolAdapter {
  const adapter = ADAPTERS[protocol]

  if (!adapter) {
    throw new Error(`尚未实现「${protocol}」协议的生成链路，请在设置中改用已支持的协议`)
  }

  return adapter
}
