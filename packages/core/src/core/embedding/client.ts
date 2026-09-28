import { createJsonHeaders, extractErrorMessage, normalizeBaseUrl, readJsonResponse, resolveApiUrl } from '../ai/shared'
import { testConnectionViaModelList } from '../ai/models-client'

import type { ModelConnectionInput, ModelConnectionResult } from '../../types/ai'

/**
 * 测试 Embedding 配置是否可用：拉取模型列表验证可达与鉴权，
 * 已填写模型名时顺带检查模型是否在列表中。
 */
export async function testEmbeddingConnection(
  input: Omit<ModelConnectionInput, 'kind'>,
): Promise<ModelConnectionResult> {
  return testConnectionViaModelList({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model: input.model,
    purpose: 'embedding',
    label: 'Embedding',
    requiredMessage: '请先填写 API 地址和 API Key',
  })
}

export async function createEmbedding(input: {
  baseUrl: string
  apiKey: string
  model: string
  text: string
}) {
  const baseUrl = normalizeBaseUrl(input.baseUrl)

  if (!baseUrl || !input.apiKey.trim() || !input.model.trim()) {
    throw new Error('请先填写 Embedding 的 API 地址、API Key 和模型名称')
  }

  if (!input.text.trim()) {
    throw new Error('Embedding 输入文本不能为空')
  }

  const response = await fetch(resolveApiUrl(baseUrl, '/embeddings'), {
    method: 'POST',
    headers: createJsonHeaders(input.apiKey, baseUrl),
    body: JSON.stringify({
      model: input.model.trim(),
      input: input.text.trim(),
    }),
  })

  if (!response.ok) {
    const payload = await readJsonResponse(response)
    throw new Error(extractErrorMessage(payload, 'Embedding 请求失败'))
  }

  const payload = await readJsonResponse(response)
  const embedding = extractEmbedding(payload)

  if (!embedding) {
    throw new Error('Embedding 响应中未找到可用向量')
  }

  return {
    vector: embedding,
    dimension: embedding.length,
  }
}

function extractEmbedding(payload: unknown) {
  if (
    payload &&
    typeof payload === 'object' &&
    'data' in payload &&
    Array.isArray(payload.data) &&
    payload.data.length > 0
  ) {
    const firstItem = payload.data[0]

    if (
      firstItem &&
      typeof firstItem === 'object' &&
      'embedding' in firstItem &&
      Array.isArray(firstItem.embedding)
    ) {
      return firstItem.embedding.filter((value: unknown): value is number => typeof value === 'number')
    }
  }

  return null
}
