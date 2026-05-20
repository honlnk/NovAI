import { streamChatCompletion } from '../core/llm/client'

import type {
  LlmStreamEventView,
  LlmStreamInputView,
} from './types'

export async function streamGeneration(
  input: LlmStreamInputView,
  onEvent: (event: LlmStreamEventView) => void,
): Promise<string> {
  return streamChatCompletion(input, onEvent)
}
