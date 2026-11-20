import { readProjectTextFile, writeProjectTextFile } from '../fs/project-fs'
import { hashContent } from '../util/hash'

/**
 * JSON 账本原语（关系图谱阶段 1 公共地基，供关系账本与后续时间线事件账本复用）。
 *
 * 只负责「安全地读写一个 JSON 文件」：读取 + 根对象校验、预期内容哈希写入、
 * 损坏与冲突两类错误。账本的结构、领域校验与写入顺序由各领域模块自行负责，
 * 这里不含任何关系或时间语义（设计构想 §5.2「公共机制不包含领域判断」）。
 */

/** 账本载入所需的最小项目形状（与 CardProjectSnapshot 同思路，只依赖目录句柄）。 */
export type LedgerProjectSnapshot = {
  handle: FileSystemDirectoryHandle
}

/**
 * 账本损坏：JSON 解析失败或根对象校验不过（含版本不识别）。
 * 携带原始内容供界面只读呈现；任何写入路径都必须拒绝覆盖损坏文件，
 * 恢复只能走「副本入回收站 + 重新初始化」的明确出口。
 */
export class JsonLedgerCorruptError extends Error {
  readonly path: string
  readonly raw: string

  constructor(path: string, raw: string, reason: string) {
    super(`账本文件 ${path} 已损坏（${reason}），不会自动覆盖；请在界面中查看原始内容或重新初始化`)
    this.name = 'JsonLedgerCorruptError'
    this.path = path
    this.raw = raw
  }
}

/**
 * 写入版本冲突：磁盘内容与调用方持有的预期版本（内容哈希）不一致。
 * 携带磁盘当前哈希，调用方据此决定重读重试或上抛冲突界面。
 */
export class JsonLedgerConflictError extends Error {
  readonly path: string
  readonly currentContentHash: string | null

  constructor(path: string, currentContentHash: string | null) {
    super(
      currentContentHash === null
        ? `账本 ${path} 已不存在，本次写入基于的版本已过期；请重新读取后再试`
        : `账本 ${path} 已被其他操作修改，本次写入基于的版本已过期；请重新读取后再试`,
    )
    this.name = 'JsonLedgerConflictError'
    this.path = path
    this.currentContentHash = currentContentHash
  }
}

export type JsonLedgerDocument<T> = {
  ledger: T
  contentHash: string
}

export type ReadJsonLedgerOptions<T> = {
  project: LedgerProjectSnapshot
  path: string
  /**
   * 根对象校验与复活：把 JSON.parse 的 unknown 结果转成账本对象。
   * 结构不合法（含版本号不识别）时应抛错——抛错一律按损坏处理。
   */
  revive(raw: unknown): T
}

/**
 * 读取 JSON 账本。文件不存在返回 null（调用方按「空账本」处理，旧项目零迁移）；
 * JSON 解析失败或 revive 抛错抛 JsonLedgerCorruptError（携带原始内容）。
 */
export async function readJsonLedger<T>(options: ReadJsonLedgerOptions<T>): Promise<JsonLedgerDocument<T> | null> {
  const { project, path, revive } = options

  let raw: string
  try {
    raw = await readProjectTextFile(project.handle, path)
  } catch (error) {
    if (isFsNotFoundError(error)) {
      return null
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new JsonLedgerCorruptError(path, raw, error instanceof Error ? error.message : 'JSON 解析失败')
  }

  try {
    return { ledger: revive(parsed), contentHash: hashContent(raw) }
  } catch (error) {
    throw new JsonLedgerCorruptError(path, raw, error instanceof Error ? error.message : '账本结构不合法')
  }
}

export type WriteJsonLedgerOptions<T> = {
  project: LedgerProjectSnapshot
  path: string
  ledger: T
  /**
   * 写入所依据的磁盘版本：
   * - 传入哈希：磁盘内容哈希一致才写，不一致抛 JsonLedgerConflictError；
   * - 传 null：要求文件尚不存在（新建语义），已存在即冲突；
   * - 传 'force'：跳过版本检查直接覆盖。仅限用户明确确认的损坏重置出口，
   *   领域常规写入一律禁止使用。
   */
  expectedContentHash: string | null | 'force'
  /** 序列化格式，默认与项目内其他 JSON 文件一致（两空格缩进、无尾换行）。 */
  serialize?(ledger: T): string
}

/**
 * 写入 JSON 账本（带预期内容版本检查）。返回写入后的内容哈希供调用方续存基线。
 *
 * 读-比-写在浏览器 FSA 下不是原子操作：同进程内的并发由领域模块的写锁串行化
 * （本原语不锁），外部编辑器的竞态窗口由版本检查兜住——命中即抛冲突，绝不覆盖。
 */
export async function writeJsonLedger<T>(options: WriteJsonLedgerOptions<T>): Promise<{ contentHash: string }> {
  const { project, path, ledger, expectedContentHash, serialize } = options

  if (expectedContentHash !== 'force') {
    const current = await readRaw(project.handle, path)
    if (current === null) {
      if (expectedContentHash !== null) {
        throw new JsonLedgerConflictError(path, null)
      }
    } else if (expectedContentHash === null || hashContent(current) !== expectedContentHash) {
      throw new JsonLedgerConflictError(path, hashContent(current))
    }
  }

  const content = serialize ? serialize(ledger) : JSON.stringify(ledger, null, 2)
  await writeProjectTextFile(project.handle, path, content)
  return { contentHash: hashContent(content) }
}

/** 读取原始文本；文件不存在返回 null，其他读取错误原样上抛。 */
async function readRaw(handle: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  try {
    return await readProjectTextFile(handle, path)
  } catch (error) {
    if (isFsNotFoundError(error)) {
      return null
    }
    throw error
  }
}

/** FSA NotFoundError 判定（与 tools/path.ts 的 isNotFoundError 同语义，本模块不依赖工具层）。 */
function isFsNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError'
}
