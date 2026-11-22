/**
 * SKILL.md frontmatter 解析（《技能包底层能力施工计划》§3.2）。
 *
 * 独立于要素解析器（elements/parser.ts 的逐行实现不支持块标量）：第三方技能常用
 * `description: >` / `|` 块标量，这里按 YAML 子集实现——顶层扁平键 + 块标量 +
 * 引号值；嵌套结构（缩进块）按块跳过不报错。BOM、CRLF 归一后解析。
 */

/** frontmatter 白名单键（决策表：license/metadata 读取但不使用，其余键计入 ignoredKeys）。 */
const KNOWN_KEYS = ['name', 'description', 'when_to_use', 'license', 'metadata'] as const

export type SkillFrontmatter = {
  name?: string
  description?: string
  whenToUse?: string
  /** 读取但不使用（占位记录，防误当未知键）。 */
  license?: string
  /** 嵌套结构，读取但不使用（值恒为空串）。 */
  metadata?: string
}

export type ParseSkillFileResult =
  | {
      ok: true
      /** 是否存在 frontmatter 块（无 frontmatter 不报错，交由发现层按缺 description 处理）。 */
      hasFrontmatter: boolean
      frontmatter: SkillFrontmatter
      ignoredKeys: string[]
      /** 去 frontmatter 后的正文（LF 归一，保留原始行结构）。 */
      body: string
    }
  | {
      /** 以 --- 开头但找不到闭合分隔线：skill_invalid_frontmatter。 */
      ok: false
      reason: 'unterminated-frontmatter'
    }

export function parseSkillFile(content: string): ParseSkillFileResult {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')

  if (!startsWithFrontmatterDelimiter(normalized)) {
    return {
      ok: true,
      hasFrontmatter: false,
      frontmatter: {},
      ignoredKeys: [],
      body: normalized,
    }
  }

  const lines = normalized.split('\n')
  const closingIndex = findClosingDelimiter(lines)

  if (closingIndex === -1) {
    return { ok: false, reason: 'unterminated-frontmatter' }
  }

  const rawValues = new Map<string, string>()
  const ignoredKeys: string[] = []
  let index = 1 // 跳过开头 ---

  while (index < closingIndex) {
    const line = lines[index]!

    // 顶层只认无缩进行；缩进行只可能出现在块标量/嵌套块的消费循环里，防御性跳过
    if (!line.trim() || line.trimStart().startsWith('#') || /^[ \t]/.test(line)) {
      index += 1
      continue
    }

    const separatorIndex = line.indexOf(':')

    if (separatorIndex === -1) {
      index += 1
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    const rawValue = line.slice(separatorIndex + 1).trim()
    const blockIndicator = matchBlockIndicator(rawValue)

    if (blockIndicator) {
      const { value, nextIndex } = readBlockScalar(lines, index + 1, closingIndex, blockIndicator)
      rawValues.set(key, value)
      index = nextIndex
      continue
    }

    if (rawValue === '') {
      // 空值：后随缩进块（嵌套结构）整块跳过；键保留（metadata/license 类），值为空
      const { nextIndex } = skipIndentedBlock(lines, index + 1, closingIndex)
      rawValues.set(key, '')
      index = nextIndex
      continue
    }

    rawValues.set(key, unquoteValue(rawValue))
    index += 1
  }

  const frontmatter: SkillFrontmatter = {}
  for (const [key, value] of rawValues) {
    if (key === 'name' && value) {
      frontmatter.name = value
    } else if (key === 'description' && value) {
      frontmatter.description = value
    } else if (key === 'when_to_use' && value) {
      frontmatter.whenToUse = value
    } else if (key === 'license') {
      frontmatter.license = value
    } else if (key === 'metadata') {
      frontmatter.metadata = value
    }
  }

  for (const key of rawValues.keys()) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      ignoredKeys.push(key)
    }
  }

  return {
    ok: true,
    hasFrontmatter: true,
    frontmatter,
    ignoredKeys,
    body: lines.slice(closingIndex + 1).join('\n').replace(/^\n+/, ''),
  }
}

function startsWithFrontmatterDelimiter(normalized: string): boolean {
  return normalized === '---' || normalized.startsWith('---\n')
}

/** 闭合分隔线：整行恰为 ---（其后的正文从下一行开始）。 */
function findClosingDelimiter(lines: string[]): number {
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      return index
    }
  }
  return -1
}

type BlockStyle = 'folded' | 'literal'
type Chomping = 'clip' | 'strip' | 'keep'

function matchBlockIndicator(rawValue: string): { style: BlockStyle; chomping: Chomping } | null {
  if (rawValue !== '>' && rawValue !== '|' && rawValue !== '>-' && rawValue !== '|-'
    && rawValue !== '>+' && rawValue !== '|+') {
    return null
  }
  return {
    style: rawValue.startsWith('>') ? 'folded' : 'literal',
    chomping: rawValue.endsWith('-') ? 'strip' : rawValue.endsWith('+') ? 'keep' : 'clip',
  }
}

/**
 * 块标量读取：收集起始行之后所有缩进行（含空行），剥离公共缩进。
 * folded（>）单换行折叠为空格、空行保留为换行；literal（|）原样保留换行。
 */
function readBlockScalar(
  lines: string[],
  startIndex: number,
  endIndex: number,
  indicator: { style: BlockStyle; chomping: Chomping },
): { value: string; nextIndex: number } {
  const blockLines: string[] = []
  let index = startIndex

  while (index < endIndex) {
    const line = lines[index]!
    if (line.trim() === '') {
      blockLines.push('')
      index += 1
      continue
    }
    if (!/^[ \t]/.test(line)) {
      break
    }
    blockLines.push(line)
    index += 1
  }

  // 剥离公共缩进（以最浅缩进行为基准）
  const indents = blockLines
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length)
  const commonIndent = indents.length > 0 ? Math.min(...indents) : 0
  const stripped = blockLines.map((line) => (line.trim() === '' ? '' : line.slice(commonIndent)))

  let value: string
  if (indicator.style === 'literal') {
    value = stripped.join('\n')
  } else {
    value = foldLines(stripped)
  }

  if (indicator.chomping === 'strip') {
    value = value.replace(/\n+$/, '')
  } else if (value !== '') {
    // clip：内容后恰好一个换行（YAML 语义）；keep 的多余空行已在收集时保留，同样收敛到单换行
    value = value.endsWith('\n') ? value.replace(/\n+$/, '\n') : `${value}\n`
  }

  return { value, nextIndex: index }
}

/** folded 折叠：非空行之间的单个换行变空格；连续空行保留为换行。 */
function foldLines(lines: string[]): string {
  const parts: string[] = []
  let pendingBlanks = 0

  for (const line of lines) {
    if (line === '') {
      pendingBlanks += 1
      continue
    }
    if (parts.length > 0) {
      parts.push(pendingBlanks > 0 ? '\n' : ' ')
    }
    pendingBlanks = 0
    parts.push(line)
  }

  return parts.join('') + (pendingBlanks > 0 ? '\n' : '')
}

/** 空值键后随的嵌套结构块：整块跳过（值不消费），返回块结束后的行号。 */
function skipIndentedBlock(lines: string[], startIndex: number, endIndex: number): { nextIndex: number } {
  let index = startIndex
  while (index < endIndex) {
    const line = lines[index]!
    if (line.trim() !== '' && !/^[ \t]/.test(line)) {
      break
    }
    index += 1
  }
  return { nextIndex: index }
}

/** 引号值：双引号处理 \" 与 \\ 转义；单引号按 YAML '' 转义；无引号原样返回。 */
function unquoteValue(rawValue: string): string {
  if (rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')) {
    return rawValue
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (rawValue.length >= 2 && rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1).replace(/''/g, "'")
  }
  return rawValue
}
