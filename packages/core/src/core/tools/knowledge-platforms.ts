/**
 * 知识平台映射（KnowledgeLookup 的数据面）。
 *
 * 设计（见 docs/plans/知识库直达工具计划.md）：
 * - 键 = 模型可见的 platform 枚举值（中文平台名）；
 * - 值 = URL 模板，{term} 渲染时替换为编码后的条目名；
 * - 加平台 = 加一行；平台专用逻辑一律不加（统一走 provider.fetch 的 HTML→Markdown）。
 *
 * 2026-09-30 定稿 8 键，各模板均经真实抓取链路验证（计划 §1 平台扩展调研）；
 * THBWiki / 灰机 wiki / 古诗文网 / 汉典 / 全历史等评估后排除，原因落档计划 §1。
 * 维基系四键用 Special:Search（MediaWiki 自动跳最匹配条目，兜住简繁/大小写变体；
 * 未命中时 finalUrl 停留在 Special: 页，工具据此判定 found:false）。
 */
export const KNOWLEDGE_PLATFORMS = {
  维基百科: {
    template: 'https://zh.wikipedia.org/wiki/Special:Search?search={term}',
    description: '中文维基百科，自动跳最匹配条目',
  },
  '维基百科（英文）': {
    template: 'https://en.wikipedia.org/wiki/Special:Search?search={term}',
    description: '英文维基百科，自动跳最匹配条目',
  },
  维基词典: {
    template: 'https://zh.wiktionary.org/wiki/Special:Search?search={term}',
    description: '多语言词典：字源、读音、释义、组词',
  },
  维基文库: {
    template: 'https://zh.wikisource.org/wiki/Special:Search?search={term}',
    description: '公有领域文献与古籍原文（条目名可能为繁体，通常可简繁互匹）',
  },
  百度百科: {
    template: 'https://baike.baidu.com/item/{term}',
    description: '中文百科（服务端自动升级浏览器渲染）',
  },
  萌娘百科: {
    template: 'https://zh.moegirl.org.cn/{term}',
    description: 'ACGN 文化与设定百科',
  },
  'SCP 中文维基': {
    template: 'https://scp-wiki-cn.wikidot.com/{term}',
    description: 'SCP 基金会虚构档案，怪谈/科幻素材（term 形如 scp-173）',
  },
  MDN: {
    template: 'https://developer.mozilla.org/zh-CN/docs/{term}',
    description: 'Web 技术文档（term 为斜杠路径，如 Web/JavaScript）',
  },
} as const

export type KnowledgePlatformName = keyof typeof KNOWLEDGE_PLATFORMS

export const KNOWLEDGE_PLATFORM_NAMES = Object.keys(KNOWLEDGE_PLATFORMS) as KnowledgePlatformName[]

export function isKnowledgePlatform(value: string): value is KnowledgePlatformName {
  return value in KNOWLEDGE_PLATFORMS
}

/** 渲染 URL 模板：{term} 替换为编码后的条目名（保留 /，MDN 嵌套路径需要） */
export function renderKnowledgeUrl(template: string, term: string): string {
  return template.replace(
    '{term}',
    term.split('/').map((segment) => encodeURIComponent(segment)).join('/'),
  )
}
