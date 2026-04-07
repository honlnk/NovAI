import { createJsonHeaders, extractErrorMessage, normalizeBaseUrl, readJsonResponse, resolveApiUrl } from '../ai/shared'

import type { ModelConnectionResult } from '../../types/ai'
import type { RerankInput, RerankResult } from '../../types/rag'

export type RerankConnectionInput = {
  baseUrl: string
  apiKey: string
  model?: string
}

export async function testRerankConnection(
  input: RerankConnectionInput,
): Promise<ModelConnectionResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)

  if (!baseUrl || !input.apiKey.trim()) {
    return {
      ok: false,
      message: '请先填写 Rerank 的 API 地址和 API Key',
    }
  }

  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: createJsonHeaders(input.apiKey, baseUrl),
    })

    if (!response.ok) {
      const payload = await readJsonResponse(response)
      return {
        ok: false,
        message: extractErrorMessage(payload, 'Rerank 测试连接失败'),
      }
    }

    return {
      ok: true,
      message: 'Rerank 连接成功',
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Rerank 测试连接失败',
    }
  }
}

export async function rerankCandidates(
  input: RerankConnectionInput & RerankInput,
): Promise<RerankResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)

  if (!baseUrl || !input.apiKey.trim() || !input.model?.trim()) {
    throw new Error('请先填写 Rerank 的 API 地址、API Key 和模型名称')
  }

  const request = buildRerankRequest(baseUrl, input)
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
  })

  if (!response.ok) {
    const payload = await readJsonResponse(response)
    throw new Error(extractErrorMessage(payload, 'Rerank 请求失败'))
  }

  const payload = await readJsonResponse(response)
  return normalizeRerankResult(payload, input)
}

function normalizeRerankResult(payload: unknown, input: RerankInput): RerankResult {
  const results = extractRerankResults(payload)

  if (results) {
    const items = results
      .map((item) => {
        if (
          item &&
          typeof item === 'object' &&
          'index' in item &&
          typeof item.index === 'number'
        ) {
          const candidate = input.candidates[item.index]

          if (!candidate) {
            return null
          }

          return {
            id: candidate.id,
            score:
              'relevance_score' in item && typeof item.relevance_score === 'number'
                ? item.relevance_score
                : 0,
          }
        }

        return null
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)

    return {
      items,
      model:
        payload &&
        typeof payload === 'object' &&
        'model' in payload &&
        typeof payload.model === 'string'
          ? payload.model
          : undefined,
    }
  }

  return {
    items: input.candidates.slice(0, input.topN).map((candidate, index) => ({
      id: candidate.id,
      score: input.candidates.length - index,
    })),
  }
}

function extractRerankResults(payload: unknown) {
  if (
    payload &&
    typeof payload === 'object' &&
    'results' in payload &&
    Array.isArray(payload.results)
  ) {
    return payload.results
  }

  if (
    payload &&
    typeof payload === 'object' &&
    'output' in payload &&
    payload.output &&
    typeof payload.output === 'object' &&
    'results' in payload.output &&
    Array.isArray(payload.output.results)
  ) {
    return payload.output.results
  }

  return null
}

function buildRerankRequest(baseUrl: string, input: RerankConnectionInput & RerankInput) {
  const model = input.model?.trim() ?? ''

  if (isDashScopeBaseUrl(baseUrl)) {
    const dashScopeOrigin = new URL(baseUrl).origin
    const dashScopePath = '/api/v1/services/rerank/text-rerank/text-rerank'

    return {
      url: resolveApiUrl(dashScopeOrigin, dashScopePath),
      headers: createJsonHeaders(input.apiKey, dashScopeOrigin),
      body: {
        model,
        input: {
          query: input.query,
          documents: input.candidates.map((candidate) => candidate.retrievalText),
        },
        parameters: {
          top_n: input.topN,
          return_documents: false,
        },
      },
    }
  }

  return {
    url: resolveApiUrl(baseUrl, '/rerank'),
    headers: createJsonHeaders(input.apiKey, baseUrl),
    body: {
      model,
      query: input.query,
      top_n: input.topN,
      documents: input.candidates.map((candidate) => candidate.retrievalText),
    },
  }
}

function isDashScopeBaseUrl(baseUrl: string) {
  return /dashscope(-intl)?\.aliyuncs\.com/.test(baseUrl)
}
