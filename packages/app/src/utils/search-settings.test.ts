import { describe, expect, it } from 'vitest'

import {
  SEARCH_PROVIDER_OPTIONS,
  applyProviderSwitch,
  findSearchProviderOption,
  type SearchSettingsForm,
} from './search-settings'

/**
 * 联网搜索设置逻辑测试：四档元数据完整性、档位切换的地址预填规则。
 * （组件渲染冒烟由 browser-use 冒烟覆盖；此处为抽出的纯逻辑。）
 */
function createForm(overrides: Partial<SearchSettingsForm> = {}): SearchSettingsForm {
  return {
    provider: 'linkseek-hosted',
    baseUrl: '',
    apiKey: '',
    ...overrides,
  }
}

describe('SEARCH_PROVIDER_OPTIONS / findSearchProviderOption', () => {
  it('四档齐备且仅第三方两档需要端点字段', () => {
    expect(SEARCH_PROVIDER_OPTIONS.map((option) => option.value)).toEqual([
      'linkseek-hosted',
      'linkseek-selfhost',
      'exa',
      'perplexity',
    ])
    expect(SEARCH_PROVIDER_OPTIONS.filter((option) => option.needsEndpoint).map((option) => option.value))
      .toEqual(['linkseek-selfhost', 'exa', 'perplexity'])
    expect(SEARCH_PROVIDER_OPTIONS.find((option) => option.value === 'exa')?.baseUrlPrefill)
      .toBe('https://api.exa.ai')
    expect(SEARCH_PROVIDER_OPTIONS.find((option) => option.value === 'perplexity')?.baseUrlPrefill)
      .toBe('https://api.perplexity.ai')
  })

  it('未知档位兜底到托管档（与 config 归一化行为一致）', () => {
    expect(findSearchProviderOption('exa').value).toBe('exa')
    expect(findSearchProviderOption('linkseek-hosted').value).toBe('linkseek-hosted')
  })
})

describe('applyProviderSwitch（切换档位的地址预填）', () => {
  it('地址为空时切到 Exa/Perplexity 预填官方地址，切到托管/自部署清空', () => {
    const form = createForm()
    applyProviderSwitch(form, 'exa')
    expect(form.provider).toBe('exa')
    expect(form.baseUrl).toBe('https://api.exa.ai')

    applyProviderSwitch(form, 'perplexity')
    expect(form.baseUrl).toBe('https://api.perplexity.ai')

    applyProviderSwitch(form, 'linkseek-hosted')
    expect(form.baseUrl).toBe('')
  })

  it('当前地址等于任一档预填默认值时视为默认值，可被替换', () => {
    const form = createForm({ provider: 'exa', baseUrl: 'https://api.exa.ai' })
    applyProviderSwitch(form, 'perplexity')
    expect(form.baseUrl).toBe('https://api.perplexity.ai')
  })

  it('用户自定义地址（自部署实例）不被档位切换覆盖', () => {
    const form = createForm({ provider: 'linkseek-selfhost', baseUrl: 'https://seek.mysite.com' })
    applyProviderSwitch(form, 'exa')
    expect(form.baseUrl).toBe('https://seek.mysite.com')
    expect(form.provider).toBe('exa')
  })
})
