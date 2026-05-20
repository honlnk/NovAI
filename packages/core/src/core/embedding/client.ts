import { createJsonHeaders, extractErrorMessage, normalizeBaseUrl, readJsonResponse, resolveApiUrl } from '../ai/shared'

import type { ModelConnectionInput, ModelConnectionResult } from '../../types/ai'

/**
 * 使用 OpenAI 兼容的 `/models` 接口测试 Embedding 配置是否可用。
 * 第一版先只验证“服务可达 + 鉴权通过”，不引入真实向量请求。
 */
export async function testEmbeddingConnection(
  input: Omit<ModelConnectionInput, 'kind'>,
): Promise<ModelConnectionResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)

  if (!baseUrl || !input.apiKey.trim()) {
    return {
      ok: false,
      message: '请先填写 API 地址和 API Key',
    }
  }

  try {
    // 测试连接先走最轻量的 models 接口，避免第一版就被具体 embedding 输入格式卡住。
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: createJsonHeaders(input.apiKey, baseUrl),
    })

    if (!response.ok) {
      const payload = await readJsonResponse(response)
      return {
        ok: false,
        message: extractErrorMessage(payload, 'Embedding 测试连接失败'),
      }
    }

    return {
      ok: true,
      message: 'Embedding 连接成功',
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Embedding 测试连接失败',
    }
  }
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
