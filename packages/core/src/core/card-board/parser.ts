/**
 * 看板卡片 frontmatter 通用解析与序列化原语（计划/伏笔/节奏卡共用，业务无关）。
 *
 * frontmatter 为自研行式解析（与要素 parser 同风格：`key: value`，不支持嵌套）；
 * 伏笔与节奏卡的字段需要列表值，约定行内数组形态 `[a, b]`（parseStringList/formatStringList）。
 * `#` 开头的注释行与无冒号的行自然跳过，允许在 frontmatter 里写分组注释。
 */

/** 拆分 frontmatter 块与正文；无合法 frontmatter 时正文为全文、frontmatter 为空串。 */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const normalized = content.replace(/\r\n/g, '\n')

  if (!normalized.startsWith('---\n')) {
    return { frontmatter: '', body: normalized }
  }

  const endIndex = normalized.indexOf('\n---\n', 4)

  if (endIndex === -1) {
    return { frontmatter: '', body: normalized }
  }

  return {
    frontmatter: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 5),
  }
}

/** 行式解析 frontmatter：`key: value` → Record；无冒号的行（含注释）跳过。 */
export function parseFrontmatterLines(raw: string): Record<string, string> {
  const record: Record<string, string> = {}

  for (const sourceLine of raw.split('\n')) {
    const line = sourceLine.trim()

    if (!line) {
      continue
    }

    const separatorIndex = line.indexOf(':')

    if (separatorIndex === -1) {
      continue
    }

    record[line.slice(0, separatorIndex).trim()] = line.slice(separatorIndex + 1).trim()
  }

  return record
}

/** 数值字段规范化：非法或缺失回退 0（缺元数据不丢正文）。 */
export function normalizeOrder(value: string | undefined): number {
  const parsed = Number((value ?? '').trim())

  if (!Number.isFinite(parsed)) {
    return 0
  }

  return parsed
}

/** 时间字段规范化：非法时间不影响正文读取——解析失败置空串（展示层按「未知」处理）。 */
export function normalizeTime(value: string | undefined): string {
  const trimmed = (value ?? '').trim()

  if (!trimmed) {
    return ''
  }

  return Number.isNaN(Date.parse(trimmed)) ? '' : trimmed
}

/** 首个非空行（已 trim）。 */
export function firstNonEmptyLine(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
}

/**
 * 列表字段解析：`[a, b]` → ['a', 'b']（逐项 trim、丢空项）。
 * 无括号的裸值按单元素列表处理（手写文件容错）；空值/空括号 → []。
 */
export function parseStringList(value: string | undefined): string[] {
  const trimmed = (value ?? '').trim()

  if (!trimmed || trimmed === 'null' || trimmed === '[]') {
    return []
  }

  const inner = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed

  return inner
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/** 列表字段序列化：['a', 'b'] → '[a, b]'；空列表 → '[]'。 */
export function formatStringList(values: readonly string[]): string {
  return `[${values.join(', ')}]`
}

/** 可空字符串字段解析：'null'/空串 → null，其余原样。 */
export function parseNullableString(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return !trimmed || trimmed === 'null' ? null : trimmed
}

/** 布尔字段解析：'true' → true，'false' → false，其余/缺失回退默认值。 */
export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const trimmed = (value ?? '').trim().toLowerCase()

  if (trimmed === 'true') {
    return true
  }

  if (trimmed === 'false') {
    return false
  }

  return fallback
}

/**
 * 文件名安全片段清理：去掉首尾空白、控制字符与跨平台文件系统非法字符，
 * 压缩连续空白为下划线；清理后为空（或只有路径段 . ..）返回 null。
 */
export function sanitizeFileNameFragment(title: string): string | null {
  const cleaned = title
    .trim()
    // 控制字符
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // 路径分隔符与 Windows 保留字符
    .replace(/[\\/:*?"<>|]/g, '')
    // 连续空白压缩为单个下划线
    .replace(/\s+/g, '_')

  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return null
  }

  return cleaned.slice(0, 60)
}

/**
 * 组装 frontmatter 行序列化块：`---` + 逐行 `key: value` + `---`。
 * 值为 null 时写 `null`（与解析端 parseNullableString 对齐）。
 */
export function formatFrontmatter(entries: ReadonlyArray<readonly [key: string, value: string | null]>): string {
  const lines = [
    '---',
    ...entries.map(([key, value]) => `${key}: ${value ?? 'null'}`),
    '---',
  ]
  return lines.join('\n')
}
