import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DASHSCOPE_EMBEDDING_MODELS,
  DASHSCOPE_RERANK_MODELS,
  listDashScopeModelIds,
  resolveDashScopeBuiltinModels,
} from './dashscope-models'
import { testConnectionViaModelList } from './models-client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('resolveDashScopeBuiltinModels', () => {
  it('百炼 + embedding：返回内置清单（含最新与上一代，不含已下线模型）', () => {
    const result = resolveDashScopeBuiltinModels('https://dashscope.aliyuncs.com/compatible-mode/v1', 'embedding')

    expect(result).not.toBeNull()
    expect(result).toContain('text-embedding-v4')
    expect(result).toContain('qwen3.7-text-embedding')
    expect(result).toContain('text-embedding-v3')
  })

  it('百炼 + rerank：返回 qwen3-rerank 与 gte-rerank-v2，不含已下线的 gte-rerank', () => {
    const result = resolveDashScopeBuiltinModels('https://dashscope.aliyuncs.com', 'rerank')

    expect(result).toEqual(['qwen3-rerank', 'gte-rerank-v2'])
  })

  it('百炼 + llm：返回 null（对话模型列表走 API 拉取）', () => {
    expect(resolveDashScopeBuiltinModels('https://dashscope.aliyuncs.com', 'llm')).toBeNull()
  })

  it('非百炼地址：返回 null', () => {
    expect(
      resolveDashScopeBuiltinModels('https://api.siliconflow.cn/v1', 'embedding'),
    ).toBeNull()
  })

  it('内置清单中的下线模型不会进入可选 ID 列表', () => {
    expect(DASHSCOPE_RERANK_MODELS.some((model) => model.id === 'gte-rerank' && model.deprecated)).toBe(true)
    expect(listDashScopeModelIds('rerank')).not.toContain('gte-rerank')
  })

  it('清单数据完整性：每个模型都有 id、名称、一句话定位与介绍', () => {
    for (const model of [...DASHSCOPE_EMBEDDING_MODELS, ...DASHSCOPE_RERANK_MODELS]) {
      expect(model.id.trim()).toBeTruthy()
      expect(model.name.trim()).toBeTruthy()
      expect(model.summary.trim()).toBeTruthy()
      expect(model.description.trim()).toBeTruthy()
    }
  })
})

describe('testConnectionViaModelList - 百炼内置清单参与模型名校验', () => {
  it('百炼 embedding 场景：模型来自内置清单（不在 API 列表）时不再误报「未见该模型」', async () => {
    // 百炼 compatible-mode /models 只返回对话类模型
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'qwen-max' }, { id: 'qwen-plus' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const result = await testConnectionViaModelList({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-test',
      model: 'text-embedding-v4',
      purpose: 'embedding',
      label: 'Embedding',
      requiredMessage: '请先填写',
    })

    expect(result.ok).toBe(true)
    expect(result.message).not.toContain('未见')
    expect(result.message).toContain('2 个模型')
  })

  it('未传 purpose 时保持原有校验行为（不在列表则提示）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'qwen-max' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const result = await testConnectionViaModelList({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      model: 'not-exist',
      label: 'LLM',
      requiredMessage: '请先填写',
    })

    expect(result.ok).toBe(true)
    expect(result.message).toContain('not-exist')
  })
})
