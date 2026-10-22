import { resolveSearchProvider } from '../web/search-provider'
import {
  KNOWLEDGE_PLATFORMS,
  isKnowledgePlatform,
  renderKnowledgeUrl,
} from './knowledge-platforms'
import { NO_FETCH_PROVIDER_MESSAGE, truncateOutput } from './web-fetch'
import type {
  ToolDefinition,
  KnowledgeLookupInput,
  KnowledgeLookupOutput,
} from './types'

/** 未命中时的截断提示语（与 WebFetch 的措辞按场景区分） */
const TRUNCATION_HINT =
  '（内容已截断至 50,000 字符。如需后半部分，可用 WebFetch 抓取带章节锚点的 URL。）'

export const knowledgeLookupTool: ToolDefinition<'KnowledgeLookup', KnowledgeLookupInput, KnowledgeLookupOutput> = {
  name: 'KnowledgeLookup',
  description: '直达知识平台查询条目全文（维基百科、维基词典、维基文库、百度百科、萌娘百科、SCP 中文维基、MDN）。比 WebSearch 后再 WebFetch 两步更快：给定平台名 + 条目名一步拿到正文。查人物事迹、历史事件、字词含义、古籍原文、ACG 设定时优先使用。',
  validateInput(input) {
    const value = asObject(input)

    if (typeof value.platform !== 'string' || !value.platform.trim()) {
      throw new Error(`KnowledgeLookup 需要有效的 platform。可用平台：${Object.keys(KNOWLEDGE_PLATFORMS).join('、')}`)
    }
    const platform = value.platform.trim()
    if (!isKnowledgePlatform(platform)) {
      throw new Error(`未知平台「${platform}」。可用平台：${Object.keys(KNOWLEDGE_PLATFORMS).join('、')}`)
    }

    if (typeof value.term !== 'string' || !value.term.trim()) {
      throw new Error('KnowledgeLookup 需要非空的 term（条目名，不是问题）')
    }

    return { platform, term: value.term.trim() }
  },
  async run(input, runtime) {
    const provider = resolveSearchProvider({
      ...runtime.project.config.search,
      webClientId: runtime.webClientId,
    })

    if (!provider.fetch) {
      throw new Error(NO_FETCH_PROVIDER_MESSAGE)
    }

    const url = renderKnowledgeUrl(KNOWLEDGE_PLATFORMS[input.platform].template, input.term)
    const outcome = await provider.fetch(url)

    // 未命中最小判定（计划决策 4）：HTTP 4xx/5xx，或维基系 Special:Search 没跳转成条目
    const missed =
      (outcome.statusCode ?? 0) >= 400 || (outcome.finalUrl ?? '').includes('Special:')
    if (missed) {
      return {
        platform: input.platform,
        term: input.term,
        url,
        finalUrl: outcome.finalUrl,
        statusCode: outcome.statusCode,
        found: false,
        content: `未在${input.platform}命中条目「${input.term}」。可换成标准条目名后重试，或改用 WebSearch 搜索。`,
        truncated: false,
      }
    }

    const { content, truncated } = truncateOutput(outcome.content, TRUNCATION_HINT)

    return {
      platform: input.platform,
      term: input.term,
      url,
      finalUrl: outcome.finalUrl,
      statusCode: outcome.statusCode,
      found: true,
      content,
      truncated: outcome.truncated || truncated,
      renderedBy: outcome.renderedBy,
      notice: outcome.notice,
    }
  },
  summarizeInput(input) {
    return `知识查询：${input.platform}「${input.term}」`
  },
  summarizeOutput(output) {
    if (!output.found) {
      return `KnowledgeLookup 未在${output.platform}命中「${output.term}」`
    }
    const rendered = output.renderedBy === 'browser' ? '（浏览器渲染）' : ''
    return `KnowledgeLookup ${output.platform}「${output.term}」${rendered}，${output.content.length} 字符${output.truncated ? '（已截断）' : ''}`
  },
}

function asObject(input: unknown) {
  if (!input || typeof input !== 'object') {
    throw new Error('工具输入必须是对象')
  }

  return input as Record<string, unknown>
}
