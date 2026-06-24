/**
 * 章节命名规范的单一事实来源。
 *
 * 章节文件统一使用 `第NNN章-标题.txt`：
 * - 中文「第」+ 编号 + 「章」
 * - 编号至少 3 位补零（第001章 ~ 第999章），超过 999 章自然变 4 位
 * - 连字符 `-` 分隔标题，标题必填
 * - 扩展名必须 `.txt`
 *
 * 模块内大部分是纯函数（无 fs 访问）。重号检测需要读 chapters/ 目录，
 * 放在本模块底部，依赖 `listFilesInDirectory`，仅在工具 run 层调用。
 * 旧项目整理工具会复用这里的 parse / format / suggest 能力。
 */
import { listFilesInDirectory } from '../fs/project-fs'

/** 规范正则：匹配完整的 `第NNN章-标题.txt` 文件名（basename） */
export const CHAPTER_NAME_PATTERN = /^第(\d{3,})章-(.+)\.txt$/

/**
 * 宽松编号提取正则，用于解析旧文件名、重号检测、章节扫描。
 * 只要求出现「第NNN章」片段，不校验整体命名是否规范，
 * 因此能从 `第1章-xxx.txt`、`chapter-001-xxx.txt` 之外的旧格式里尽量抢救编号。
 *
 * 注意：对纯英文 `chapter-001` 前缀的旧文件无法提取编号（没有「第X章」片段），
 * 这类文件在重号检测时会被跳过，在整理工具里靠排序顺序分配新编号。
 */
export const CHAPTER_NUMBER_PATTERN = /第(\d+)章/

/** `chapters/` 目录前缀 */
const CHAPTERS_PREFIX = 'chapters/'

/**
 * 判断路径是否落在 chapters/ 目录下。
 * 路径已经过 normalizeProjectPath 规范化（正斜杠、无 ./..、不以 / 结尾）。
 */
export function isChapterPath(path: string): boolean {
  return path === CHAPTERS_PREFIX || path.startsWith(CHAPTERS_PREFIX)
}

/**
 * 从文件名（basename 或完整路径）中提取章节编号。
 * 不要求整体命名规范，只要包含「第NNN章」片段即可。
 * 解析失败返回 null（调用方据此决定跳过或报错）。
 *
 * @example
 * parseChapterNumber('第001章-火中拾婴.txt') // 1
 * parseChapterNumber('第1章.txt')            // 1
 * parseChapterNumber('chapter-001.txt')      // null（无中文编号片段）
 * parseChapterNumber('火中拾婴.md')          // null
 */
export function parseChapterNumber(filename: string): number | null {
  const match = CHAPTER_NUMBER_PATTERN.exec(filename)

  if (!match) {
    return null
  }

  const value = Number(match[1])

  return Number.isFinite(value) ? value : null
}

/**
 * 判断文件名（basename）是否符合完整的命名规范。
 * 用于整理工具区分「已规范」和「待整理」。
 */
export function isChapterNameCompliant(filename: string): boolean {
  return CHAPTER_NAME_PATTERN.test(filename)
}

/**
 * 校验 chapters/ 路径是否符合命名规范，不合规抛出带格式样例的清晰错误。
 * 供工具层的纯函数校验路径调用（无 fs 访问）。
 */
export function assertChapterNameFormat(path: string): void {
  const filename = path.slice(CHAPTERS_PREFIX.length)

  if (CHAPTER_NAME_PATTERN.test(filename)) {
    return
  }

  throw new Error(
    `章节文件名不规范：${filename}；必须形如「第NNN章-标题.txt」（编号至少 3 位补零，标题非空），例如「第001章-火中拾婴.txt」。`,
  )
}

/**
 * 用编号和标题拼装规范文件名（basename，不含目录前缀）。
 * 编号补零到至少 3 位，超过 999 自然变 4 位。
 *
 * @example
 * formatChapterName(1, '火中拾婴')   // '第001章-火中拾婴.txt'
 * formatChapterName(1000, '终局')    // '第1000章-终局.txt'
 */
export function formatChapterName(number: number, title: string): string {
  const padded = String(number).padStart(3, '0')
  const trimmedTitle = title.trim()

  if (!trimmedTitle) {
    throw new Error('章节标题不能为空')
  }

  return `第${padded}章-${trimmedTitle}.txt`
}

/**
 * 当旧章节文件名缺标题时，从正文内容兜底生成一个建议标题。
 * 策略：取首行非空文本，去掉常见标题符号；若首行过长则截断到指定字数。
 *
 * 用于整理工具的 `needsReview` 项，给用户一个可编辑的起点，
 * 而不是让用户从零想标题。多数章节首行本就是标题行。
 *
 * @param content 章节正文
 * @param maxLen  建议标题最大字符数，默认 12
 */
export function suggestChapterTitle(content: string, maxLen = 12): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''

  if (!firstLine) {
    return '未命名章节'
  }

  // 去掉首尾的章节号、Markdown 标题符号、书名号、空白等常见噪音
  const cleaned = firstLine
    .replace(/^#+\s*/, '') // Markdown 标题
    .replace(/^第[\d零一二三四五六七八九十百千]+章[\s　\-—:：]*/, '') // 行首章节号
    .replace(/[「」《》【】\s]/g, '')
    .trim()

  const source = cleaned || firstLine

  if (source.length <= maxLen) {
    return source
  }

  return `${source.slice(0, maxLen)}…`
}

// ─── 重号检测（需要 fs 访问，仅在工具 run 层调用） ─────────────────────────

/**
 * 收集 chapters/ 目录下所有已占用的章节编号。
 * 解析失败的旧文件（命名不规范的）跳过，不报错、不污染编号集合，
 * 因此不会被误判为占用，避免挡住新章节的合法编号。
 *
 * @param rootHandle  项目根目录句柄
 * @param exceptPath  要排除的路径（改名场景传 fromPath，避免把自身算成占用）
 */
export async function collectChapterNumbers(
  rootHandle: FileSystemDirectoryHandle,
  exceptPath?: string,
): Promise<Set<number>> {
  const paths = await listFilesInDirectory(rootHandle, 'chapters')
  const numbers = new Set<number>()

  for (const path of paths) {
    if (exceptPath && path === exceptPath) {
      continue
    }

    const number = parseChapterNumber(path)

    if (number !== null) {
      numbers.add(number)
    }
  }

  return numbers
}

/**
 * 校验目标章节路径的编号是否未被占用，已占用则抛错。
 * 供 CreateFile / RenameFile 的 run 层在写入前调用。
 *
 * @param rootHandle  项目根目录句柄
 * @param targetPath  目标章节路径（已通过格式校验，必然含「第NNN章」编号）
 * @param exceptPath  改名场景的源路径，排除自身
 */
export async function assertChapterNumberAvailable(
  rootHandle: FileSystemDirectoryHandle,
  targetPath: string,
  exceptPath?: string,
): Promise<void> {
  const targetNumber = parseChapterNumber(targetPath)

  if (targetNumber === null) {
    // 走到这里说明格式校验没拦住，理论不会发生；防御性直接放过，交给格式层处理
    return
  }

  const usedNumbers = await collectChapterNumbers(rootHandle, exceptPath)

  if (usedNumbers.has(targetNumber)) {
    throw new Error(
      `章节编号已存在：第${String(targetNumber).padStart(3, '0')}章；请先用 FindFiles 查看 chapters/ 目录确认现有章节编号，使用未占用的编号。`,
    )
  }
}
