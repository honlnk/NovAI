export type ModelKind = 'llm' | 'embedding'

export type ModelConnectionInput = {
  baseUrl: string
  apiKey: string
  model?: string
  kind: ModelKind
}

export type ModelConnectionResult = {
  ok: boolean
  message: string
}

export type LlmStreamEvent =
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'finish'; text: string }
  | { type: 'error'; message: string }

export type LlmStreamInput = {
  baseUrl: string
  apiKey: string
  model: string
  systemPrompt?: string
  instruction: string
}
