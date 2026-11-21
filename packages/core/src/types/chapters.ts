/**
 * 章节目录与章节引用的公共类型（作者字段控制权计划阶段 1）。
 *
 * 章节引用按「全本章号位置」解释：标题或文件名变化但章号不变时，引用继续指向
 * 同一位置；不引入稳定章节身份，删后同号重建无法确认是否原章节是明确边界
 * （计划 §三.4、§十二「不做」）。重复章号保留全部候选并标记待消歧，不自动选择。
 */

/** 章节目录条目：chapters/ 下一个真实存在的章节文件（可含「卷/部」子目录）。 */
export type ChapterCatalogEntry = {
  /** 全本章号（解析自文件名「第N章」片段） */
  number: number
  /** 章节标题：规范文件名取标题段；非规范文件名回退为去扩展名文件名 */
  title: string
  /** 文件名（basename，含扩展名） */
  fileName: string
  /** 所在目录（相对 chapters/；根目录为 ''，如 '第一卷'） */
  directory: string
  /** 完整项目相对路径（如 'chapters/第一卷/第012章-夜行.txt'） */
  path: string
  /** 卡片引用形态：path 去 chapters/ 前缀与扩展名（如 '第一卷/第012章-夜行'） */
  ref: string
  /** 文件名是否符合「第NNN章-标题.txt」规范 */
  canonical: boolean
}

/** 章节目录：全本章号命名空间，重复章号保留全部候选。 */
export type ChapterCatalog = {
  /** 按章号升序、同章号按路径排序的全部条目 */
  entries: ChapterCatalogEntry[]
  /** 存在重复章号的章号集合（历史项目待消歧） */
  duplicateNumbers: ReadonlySet<number>
  /** 当前最大章号（无章节时 null） */
  maxNumber: number | null
}

/**
 * 章节引用解析结果（旧值核对层）：只呈现位置状态，绝不自动改绑。
 * 作者主动确认或替换后才更新引用（计划 §八.1）。
 */
export type ChapterRefResolution =
  | { kind: 'unset' }
  | {
      kind: 'chapter'
      entry: ChapterCatalogEntry
      /**
       * 引用自带卷/标题信息与当前条目不一致：按章号位置恢复展示，
       * 但系统无法确认它是否就是原章节（删后同号重建 / 改名同形）。
       */
      uncertainIdentity: boolean
    }
  | { kind: 'missing'; number: number | null }
  | { kind: 'ambiguous'; entries: ChapterCatalogEntry[] }
  | { kind: 'unparseable'; raw: string }

/** 选择器内「新建章节」输入：章号必填正整数，标题留空按「未命名」生成。 */
export type CreateChapterInput = {
  chapterNumber: number
  /** 留空 / null 时以「未命名」作为初始标题 */
  title?: string | null
}

/** 新建章节结果：创建成功后的目录条目。 */
export type CreateChapterResult = {
  entry: ChapterCatalogEntry
}

/** 新建章节的章号非法错误（非正整数）。 */
export class InvalidChapterNumberError extends Error {
  constructor(value: string | number) {
    super(`章号必须是正整数（收到 ${String(value)}）`)
    this.name = 'InvalidChapterNumberError'
  }
}

/** 新建章节的章号占用错误：携带占用该章号的全部现有条目（唯一时选择器可改选，重号待消歧）。 */
export class ChapterNumberTakenError extends Error {
  readonly existing: ChapterCatalogEntry[]

  constructor(existing: ChapterCatalogEntry[]) {
    super(`章节编号已存在：第${String(existing[0]?.number ?? 0).padStart(3, '0')}章`)
    this.name = 'ChapterNumberTakenError'
    this.existing = existing
  }
}
