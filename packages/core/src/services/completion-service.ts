import { streamFimCompletion, testCompletionConnection } from '../core/ai/completion-client'

import type {
  CompletionConfigView,
  ConnectionTestResultView,
  FimCompletionEventView,
  FimCompletionInputView,
} from './types'

/**
 * 发起一次对话输入框 AI 补全（FIM）。
 *
 * 门控：completion 未启用时不发请求，直接返回空串。
 */
export async function streamInlineCompletion(
  config: CompletionConfigView,
  input: Omit<FimCompletionInputView, 'baseUrl' | 'apiKey' | 'model'>,
  onEvent: (event: FimCompletionEventView) => void,
): Promise<string> {
  if (!config.enabled) {
    return ''
  }

  return streamFimCompletion(
    {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      prompt: input.prompt,
      suffix: input.suffix,
      maxTokens: input.maxTokens ?? config.maxTokens,
      signal: input.signal,
    },
    onEvent,
  )
}

/**
 * 测试补全模型连接是否可用。
 */
export async function testCompletion(config: CompletionConfigView): Promise<ConnectionTestResultView> {
  return testCompletionConnection({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  })
}
