import type { SearchConfigView } from '@novai/core/services/types'

/** 联网搜索设置表单（reactive 引用直传面板，修改由 SettingsModal 自动保存）。 */
export type SearchSettingsForm = {
  provider: SearchConfigView['provider']
  baseUrl: string
  apiKey: string
}

type SearchProviderOption = {
  value: SearchConfigView['provider']
  label: string
  description: string
  /** 是否显示 baseUrl + apiKey 端点字段（托管档零配置）。 */
  needsEndpoint: boolean
  baseUrlPlaceholder?: string
  /** 切换到该档且当前地址为空/等于其他档默认值时预填的地址。 */
  baseUrlPrefill?: string
}

/** 四档搜索来源的展示元数据（label 与说明文案与计划文档拍死的一致）。 */
export const SEARCH_PROVIDER_OPTIONS: Array<SearchProviderOption> = [
  {
    value: 'linkseek-hosted',
    label: 'NovAI 托管服务（默认）',
    description: '零配置即可使用，每日 50 次免费额度（搜索与抓取共用），仅对 NovAI 官方站点开放。',
    needsEndpoint: false,
  },
  {
    value: 'linkseek-selfhost',
    label: '自部署 linkseek',
    description: '使用你自己部署的 linkseek 服务，不限额度。',
    needsEndpoint: true,
    baseUrlPlaceholder: 'https://your-linkseek.example.com',
  },
  {
    value: 'exa',
    label: 'Exa',
    description: '使用 Exa 搜索 API，需自备 API Key；此模式下网页抓取不可用。',
    needsEndpoint: true,
    baseUrlPlaceholder: 'https://api.exa.ai',
    baseUrlPrefill: 'https://api.exa.ai',
  },
  {
    value: 'perplexity',
    label: 'Perplexity',
    description: '使用 Perplexity 搜索 API，需自备 API Key；此模式下网页抓取不可用。',
    needsEndpoint: true,
    baseUrlPlaceholder: 'https://api.perplexity.ai',
    baseUrlPrefill: 'https://api.perplexity.ai',
  },
]

export function findSearchProviderOption(
  provider: SearchConfigView['provider'],
): SearchProviderOption {
  return SEARCH_PROVIDER_OPTIONS.find((option) => option.value === provider) ?? SEARCH_PROVIDER_OPTIONS[0]
}

/**
 * 切换搜索来源档位：地址为空或等于任一档的预填默认值时替换为新档预填
 * （托管/自部署无预填则清空），用户自定义地址不覆盖。
 */
export function applyProviderSwitch(form: SearchSettingsForm, next: SearchConfigView['provider']): void {
  const currentBaseUrl = form.baseUrl.trim()
  const isDefaultUrl =
    !currentBaseUrl ||
    SEARCH_PROVIDER_OPTIONS.some((option) => option.baseUrlPrefill === currentBaseUrl)

  if (isDefaultUrl) {
    const option = findSearchProviderOption(next)
    form.baseUrl = option.baseUrlPrefill ?? ''
  }

  form.provider = next
}
