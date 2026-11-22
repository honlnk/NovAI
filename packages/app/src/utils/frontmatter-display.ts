/**
 * frontmatter 展示层切分与键值解析（文件预览 frontmatter 卡片化计划 Step 1）。
 *
 * 预览是化妆不是语义：这里只认「--- 围栏 + 顶层键值」的 dumb 形态，供折叠摘要条
 * 与属性网格展示；YAML 语义解析（块标量树、锚点、嵌套结构）归 core 各领域解析器
 * （skills/frontmatter.ts、elements/parser.ts 等），职责不重叠。识别要求围栏闭合
 * 且首条围栏内行呈键形态——防止把「开头 --- 分隔线 + 短正文 + --- 分隔线」的
 * 场景分割线写法误判成 frontmatter。
 */

/** 单个顶层键的展示值：`[a, b]` 形态切数组，其余为标量字符串 */
export type FrontmatterField = {
  key: string
  value: string | string[]
}

export type SplitFrontmatterResult = {
  hasFrontmatter: boolean
  /** 围栏全文（含两行分隔线）；未识别时为空串 */
  raw: string
  /** 围栏之后的原文（BOM/CRLF 归一）；未识别时与归一后的 source 相同 */
  body: string
}

const FENCE_LINE = /^---\s*$/
/** 键形态：id: / when_to_use: / last-updated: 等（首条围栏内行的门槛） */
const KEY_LINE = /^[\w.-]+\s*:/
/** 键值行：捕获键与冒号后的原始值 */
const KEY_VALUE_LINE = /^([\w.-]+)\s*:\s*(.*)$/
/** 缩进续行（块标量 / 嵌套结构的行，展示时并入上一键的值） */
const CONTINUATION_LINE = /^[ \t]+\S/
const SCAN_LIMIT = 200

function normalize(source: string): string {
  return source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

/**
 * 切出文件开头的 frontmatter 围栏。识别条件（全部满足才识别）：
 * 首行为 `---`；扫描上限内存在闭合 `---` 行；首条围栏内行呈键形态。
 * 任一不满足即整体不识别，调用方按普通 markdown 渲染（与历史行为一致）。
 */
export function splitFrontmatter(source: string): SplitFrontmatterResult {
  const normalized = normalize(source)
  const lines = normalized.split('\n')
  if (!FENCE_LINE.test(lines[0] ?? '')) {
    return { hasFrontmatter: false, raw: '', body: normalized }
  }
  const firstInner = lines[1] ?? ''
  if (!KEY_LINE.test(firstInner)) {
    return { hasFrontmatter: false, raw: '', body: normalized }
  }
  const limit = Math.min(lines.length, SCAN_LIMIT + 1)
  for (let index = 1; index < limit; index += 1) {
    if (FENCE_LINE.test(lines[index] ?? '')) {
      return {
        hasFrontmatter: true,
        raw: lines.slice(0, index + 1).join('\n'),
        body: lines.slice(index + 1).join('\n'),
      }
    }
  }
  return { hasFrontmatter: false, raw: '', body: normalized }
}

/** 去掉成对包裹的引号（`"陈砚"` / `'陈砚'` → 陈砚），不成对则原样 */
function unwrapQuotes(value: string): string {
  if (value.length >= 2) {
    const head = value[0]
    const tail = value[value.length - 1]
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** `[a, b]` 形态切数组（去空格、丢空项）；非数组形态返回 null */
function parseArrayValue(value: string): string[] | null {
  if (value.length < 2 || !value.startsWith('[') || !value.endsWith(']')) {
    return null
  }
  return value
    .slice(1, -1)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * 把围栏原文解析成展示键值列表。规则（刻意 dumb，展示容错优先）：
 * 跳过分隔线；非缩进行按首个冒号切键值，`[...]` 值切数组、成对引号剥掉；
 * 缩进续行 / 无冒号行并入上一键的值（换行保留，展示层由 CSS 折叠为空格）；
 * 数组值后的续行忽略。0 个字段表示空围栏，卡片不渲染。
 */
export function parseFrontmatterDisplay(raw: string): FrontmatterField[] {
  const fields: FrontmatterField[] = []
  for (const line of normalize(raw).split('\n')) {
    if (FENCE_LINE.test(line)) {
      continue
    }
    if (CONTINUATION_LINE.test(line) || !KEY_VALUE_LINE.test(line)) {
      const previous = fields[fields.length - 1]
      if (previous && typeof previous.value === 'string') {
        previous.value = previous.value === '' ? line.trim() : `${previous.value}\n${line.trim()}`
      }
      continue
    }
    const match = KEY_VALUE_LINE.exec(line)
    if (!match) {
      continue
    }
    const scalar = unwrapQuotes(match[2]!.trim())
    if (/^[|>][+-]?\d*$/.test(scalar)) {
      // 块标量开记号（> / | 及折叠修饰）：记号本身不展示，内容由续行收进
      fields.push({ key: match[1]!, value: '' })
      continue
    }
    const arrayValue = parseArrayValue(scalar)
    fields.push({ key: match[1]!, value: arrayValue ?? scalar })
  }
  return fields
}
