import {
  appendProxyHeader,
  createJsonHeaders,
  extractErrorMessage,
  normalizeBaseUrl,
  readJsonResponse,
  resolveApiUrl,
} from './shared'
import { isDashScopeBaseUrl, resolveDashScopeBuiltinModels } from './dashscope-models'

import type { ModelConnectionResult, ModelProtocol } from '../../types/ai'

/** 拉取模型列表的请求超时，与上游网关的常见超时对齐。 */
const LIST_MODELS_TIMEOUT_MS = 15_000

export type ListModelsInput = {
  baseUrl: string
  apiKey: string
  protocol?: ModelProtocol
}

export type ListModelsResult = {
  /** 去重并按字典序排序后的模型 id 列表 */
  models: string[]
}

/** 模型用途，用于客户端过滤「只展示本配置需要的模型」。 */
export type ModelListPurpose = 'llm' | 'embedding' | 'rerank' | 'completion'

/**
 * 拉取指定服务的可用模型列表。
 *
 * 各协议端点与鉴权差异：
 * - openai / openai-responses：GET {base}/models，Bearer 鉴权，取 data[].id
 *   （两套协议的模型列表端点相同，区别只在生成时走 /chat/completions 还是 /responses）。
 * - anthropic：GET {base}/v1/models，x-api-key + anthropic-version，
 *   浏览器直连需带 anthropic-dangerous-direct-browser-access。
 * - gemini：GET {base}/v1beta/models，x-goog-api-key 鉴权，取 models[].name（去掉 models/ 前缀）。
 *
 * DashScope 特例：阿里百炼原生地址（dashscope.aliyuncs.com）没有 OpenAI 风格的 /models，
 * 自动改走 {origin}/compatible-mode/v1/models（同一 API Key 可用）。这样 Rerank 场景
 * 用户填百炼原生地址也能拉到模型列表。
 */
export async function listAvailableModels(input: ListModelsInput): Promise<ListModelsResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)

  if (!baseUrl) {
    throw new Error('请先填写 API 地址')
  }

  if (!input.apiKey.trim()) {
    throw new Error('请先填写 API Key')
  }

  const request = buildModelsRequest(baseUrl, input.apiKey.trim(), input.protocol ?? 'openai')
  const response = await fetch(request.url, {
    method: 'GET',
    headers: request.headers,
    signal: AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
  })

  if (!response.ok) {
    const payload = await readJsonResponse(response)
    throw new Error(extractErrorMessage(payload, `拉取模型列表失败（HTTP ${response.status}）`))
  }

  const payload = await readJsonResponse(response)
  const models = extractModelIds(payload)

  return { models }
}

/**
 * 按用途过滤模型列表，避免把整站模型一口气塞给用户。
 *
 * 过滤规则刻意宽松 + 调用方可展示全量兜底：漏掉远比多显示几个严重。
 */
export function filterModelsByPurpose(models: string[], purpose: ModelListPurpose): string[] {
  if (purpose === 'embedding') {
    return models.filter((model) => EMBEDDING_MODEL_PATTERN.test(model))
  }

  if (purpose === 'rerank') {
    return models.filter((model) => RERANK_MODEL_PATTERN.test(model))
  }

  if (purpose === 'llm') {
    return models.filter(
      (model) =>
        !EMBEDDING_MODEL_PATTERN.test(model) &&
        !RERANK_MODEL_PATTERN.test(model) &&
        !NON_CHAT_MODEL_PATTERN.test(model),
    )
  }

  return [...models]
}

/**
 * 基于拉取模型列表实现测试连接。
 *
 * 列表拉取成功即代表「服务可达 + 鉴权通过」；若用户已填写模型名，
 * 顺带检查模型是否出现在列表中并给出提示（不作为失败，部分网关列表不全）。
 * 百炼 + embedding / rerank 场景的列表不含这类模型，检查时并入内置清单。
 */
export async function testConnectionViaModelList(options: {
  baseUrl: string
  apiKey: string
  protocol?: ModelProtocol
  model?: string
  purpose?: ModelListPurpose
  label: string
  requiredMessage: string
}): Promise<ModelConnectionResult> {
  if (!normalizeBaseUrl(options.baseUrl) || !options.apiKey.trim()) {
    return { ok: false, message: options.requiredMessage }
  }

  try {
    const { models } = await listAvailableModels({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      protocol: options.protocol,
    })
    const model = options.model?.trim()

    if (models.length === 0) {
      return { ok: true, message: `${options.label}连接成功（服务未返回模型列表）` }
    }

    const builtinIds =
      options.purpose !== undefined
        ? (resolveDashScopeBuiltinModels(options.baseUrl, options.purpose) ?? [])
        : []

    if (model && !models.includes(model) && !builtinIds.includes(model)) {
      return {
        ok: true,
        message: `${options.label}连接成功（共 ${models.length} 个模型，但列表中未见「${model}」，请确认模型名是否正确）`,
      }
    }

    return { ok: true, message: `${options.label}连接成功（共 ${models.length} 个模型）` }
  } catch (error) {
    const fallback = `${options.label}测试连接失败`
    return { ok: false, message: error instanceof Error ? error.message : fallback }
  }
}

/**
 * 识别阿里云 DashScope（百炼）地址（含国际站）。
 * 实现收敛在 dashscope-models.ts，此处 re-export 保持既有引用不变。
 */
export { isDashScopeBaseUrl } from './dashscope-models'

function buildModelsRequest(baseUrl: string, apiKey: string, protocol: ModelProtocol) {
  if (protocol === 'anthropic') {
    const base = stripTrailingPathSegments(baseUrl, '/v1')
    return {
      url: resolveApiUrl(base, '/v1/models'),
      headers: appendProxyHeader(
        {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        base,
      ),
    }
  }

  if (protocol === 'gemini') {
    const base = stripTrailingPathSegments(baseUrl, '/v1beta', '/v1')
    return {
      url: resolveApiUrl(base, '/v1beta/models'),
      headers: appendProxyHeader(
        {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        base,
      ),
    }
  }

  const base = resolveOpenAiCompatibleBase(baseUrl)
  return {
    url: resolveApiUrl(base, '/models'),
    headers: createJsonHeaders(apiKey, base),
  }
}

/**
 * OpenAI 兼容协议的 baseUrl 归一化：
 * DashScope 原生地址自动改写为 compatible-mode（原生地址没有 /models）。
 */
function resolveOpenAiCompatibleBase(baseUrl: string) {
  if (!isDashScopeBaseUrl(baseUrl)) {
    return baseUrl
  }

  if (baseUrl.includes('/compatible-mode')) {
    return baseUrl
  }

  return `${new URL(baseUrl).origin}/compatible-mode/v1`
}

/**
 * 去掉 baseUrl 结尾处重复的版本段，避免用户填写习惯不同导致路径重复拼接。
 * 例如 anthropic 的 base 常见两种写法：https://api.anthropic.com 与 https://api.anthropic.com/v1。
 */
function stripTrailingPathSegments(baseUrl: string, ...segments: string[]) {
  let result = baseUrl

  for (const segment of segments) {
    if (result.endsWith(segment)) {
      result = result.slice(0, -segment.length)
    }
  }

  return normalizeBaseUrl(result)
}

function extractModelIds(payload: unknown): string[] {
  const ids: string[] = []

  // OpenAI / Anthropic 风格：{ data: [{ id }] }
  if (payload && typeof payload === 'object' && 'data' in payload && Array.isArray(payload.data)) {
    for (const item of payload.data) {
      if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
        ids.push(item.id)
      }
    }
  }

  // Gemini 原生风格：{ models: [{ name: "models/xxx" }] }
  if (
    payload &&
    typeof payload === 'object' &&
    'models' in payload &&
    Array.isArray(payload.models)
  ) {
    for (const item of payload.models) {
      if (item && typeof item === 'object' && 'name' in item && typeof item.name === 'string') {
        ids.push(item.name.replace(/^models\//, ''))
      }
    }
  }

  return [...new Set(ids)].sort()
}

/** embedding 类模型：text-embedding-* / bge-* / e5-* / gte-embedding 等。 */
const EMBEDDING_MODEL_PATTERN = /embedding|(^|[-/.])bge|(^|[-/.])e5-|(^|[-/.])gte-v/i

/** rerank 类模型：gte-rerank / qwen3-rerank / bge-rerank 等（gte-rerank 已下线，推荐 qwen3-rerank）。 */
const RERANK_MODEL_PATTERN = /rerank/i

/** 明显非对话类模型，LLM 列表默认排除：语音、图像、视频、多模态理解、embedding、rerank。 */
const NON_CHAT_MODEL_PATTERN =
  /embedding|rerank|whisper|tts|speech|audio|asr|realtime|dall-e|image|video|omni|vl|stable-diffusion|flux|sora/i
