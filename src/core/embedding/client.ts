import { createJsonHeaders, extractErrorMessage, normalizeBaseUrl, readJsonResponse } from '../ai/shared'

import type { ModelConnectionInput, ModelConnectionResult } from '../../types/ai'

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
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: createJsonHeaders(input.apiKey),
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
