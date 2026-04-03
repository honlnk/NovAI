import { createJsonHeaders, extractErrorMessage, normalizeBaseUrl, readJsonResponse } from '../ai/shared'

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
