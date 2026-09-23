import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import type { ProjectConfigView } from '@novai/core/services/types'

import {
  getConfig,
  testSearch,
  updateConfig,
} from '@novai/core/services/settings-service'
import { useSettingsStore } from './settings'

vi.mock('@novai/core/services/settings-service', () => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  testLlm: vi.fn(),
  testEmbedding: vi.fn(),
  testRerank: vi.fn(),
  testCompletion: vi.fn(),
  testSearch: vi.fn(),
}))

const mockedGetConfig = vi.mocked(getConfig)
const mockedUpdateConfig = vi.mocked(updateConfig)
const mockedTestSearch = vi.mocked(testSearch)

function createConfigView(overrides: Partial<ProjectConfigView> = {}): ProjectConfigView {
  return {
    version: 1,
    project: { name: '测试书', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    llm: { baseUrl: '', apiKey: '', model: '', protocol: 'openai' },
    embedding: { baseUrl: '', apiKey: '', model: '' },
    rerank: { enabled: false, baseUrl: '', apiKey: '', model: '', mode: 'text', topN: 8 },
    completion: { enabled: false, baseUrl: '', apiKey: '', model: '', debounceMs: 600, maxTokens: 64 },
    search: { provider: 'linkseek-hosted', baseUrl: '', apiKey: '' },
    settings: {
      ragCandidateLimit: 20,
      ragContextMaxItems: 8,
      conversationTokenLimit: 12000,
      compressionKeepRecentTurns: 5,
      agentMaxTurns: 0,
      permissionPreset: 'chapter-material',
      embeddingTextVersion: 1,
      enableDebugLogging: false,
      activeScenePromptPath: null,
    },
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/**
 * 联网搜索设置的 store 链路测试（W3）：配置段加载回填、search patch 透传保存、
 * 测试连接把表单 + webClientId 一并交给 core 的 testSearch。
 */
describe('settings store 联网搜索', () => {
  it('loadSettings 载入含 search 段的配置', async () => {
    const config = createConfigView({
      search: { provider: 'linkseek-selfhost', baseUrl: 'https://seek.mysite.com', apiKey: 'sk-x' },
    })
    mockedGetConfig.mockResolvedValue(config)

    const store = useSettingsStore()
    const result = await store.loadSettings('p-1')

    expect(result?.config.search).toEqual({
      provider: 'linkseek-selfhost',
      baseUrl: 'https://seek.mysite.com',
      apiKey: 'sk-x',
    })
    expect(store.config?.search.provider).toBe('linkseek-selfhost')
  })

  it('saveConfig 把 search patch 原样透传给 updateConfig 并刷新本地配置', async () => {
    const saved = createConfigView({
      search: { provider: 'exa', baseUrl: 'https://api.exa.ai', apiKey: 'sk-exa' },
    })
    mockedUpdateConfig.mockResolvedValue(saved)

    const store = useSettingsStore()
    const result = await store.saveConfig('p-1', {
      search: { provider: 'exa', baseUrl: 'https://api.exa.ai', apiKey: 'sk-exa' },
    })

    expect(mockedUpdateConfig).toHaveBeenCalledWith('p-1', {
      search: { provider: 'exa', baseUrl: 'https://api.exa.ai', apiKey: 'sk-exa' },
    })
    expect(result?.search.provider).toBe('exa')
    expect(store.config?.search.baseUrl).toBe('https://api.exa.ai')
  })

  it('testSearchConfig 携 webClientId 调 testSearch 并回填测试结果', async () => {
    mockedTestSearch.mockResolvedValue({ ok: true, message: '连接成功，返回 8 条结果。' })

    const store = useSettingsStore()
    const result = await store.testSearchConfig({
      provider: 'linkseek-hosted',
      baseUrl: '',
      apiKey: '',
      webClientId: 'client-uuid-0001',
    })

    expect(mockedTestSearch).toHaveBeenCalledWith({
      provider: 'linkseek-hosted',
      baseUrl: '',
      apiKey: '',
      webClientId: 'client-uuid-0001',
    })
    expect(result?.ok).toBe(true)
    expect(store.lastConnectionTest?.message).toBe('连接成功，返回 8 条结果。')
  })
})
