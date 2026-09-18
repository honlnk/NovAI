import { writeProjectTextFile } from '../fs/project-fs'
import type { ProjectSnapshot } from '../../types/project'

/**
 * 长文本 Spill：超长工具结果在进入上下文之前拦截——全文落盘，上下文里只放预览 + 取回指引。
 *
 * 与 compaction 互补：spill 管「单次工具结果太大」，compaction 管「总量超阈值后的历史浓缩」。
 *
 * 方向（重设计后）：spill 文件**可读回**。ReadFile 有三道闸（行分页/单行截断/50KB 字节
 * 封顶），单次读回结果天然不会再触发 spill，因此 `.novel/spill/` 对 ReadFile 放行可读
 * （仍禁写/改/删），省略标记里的路径是活指针。spill 路径自身豁免 spill（双保险），
 * read→spill→read 的链条两头都断了，不靠禁读防循环。
 *
 * 只对 RagSearch 的结果 spill：ReadFile 已被字节封顶豁免；写工具（CreateFile/EditFile 等）
 * 的内容是模型自己写的，回灌没有信息增益。`.novel/spill/` 文件启动时按保留期清理（7 天）。
 */

/** 单个工具结果超过此字符数才 spill。 */
export const SPILL_THRESHOLD_CHARS = 8192
/** 预览保留的头部字符数。 */
export const SPILL_HEAD_CHARS = 4096
/** 预览保留的尾部字符数。 */
export const SPILL_TAIL_CHARS = 1024

export const SPILL_DIR = '.novel/spill'

/** spill 文件保留期：7 天（写作迭代周期短，spill 只是缓存副本，章节正文项目里有原件）。 */
export const SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 适用 spill 的工具：RagSearch（无分页能力，结果可能一次回一大坨）。
 * ReadFile 已退出——三道闸保证其单次返回 ≤ 50KB 字节，天然不需要 spill（对齐 dsh read 豁免）。
 * 目录/找文件类工具的结果是路径清单，截断反而不可用，从不 spill。
 */
export const SPILLABLE_TOOLS = ['RagSearch'] as const

export function createSpillFileId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 若内容超过阈值：全文写入 `.novel/spill/<id>.txt`，返回「头 + 取回指引 + 尾」的预览；
 * 未超阈值原样返回。落盘失败时也原样返回（宁可上下文大一点，不能让工具结果丢失）。
 *
 * sourcePath 豁免：结果本身读自 `.novel/spill/` 时不再二次 spill（否则标记里又指一个新
 * spill 路径，循环回来了）。当前白名单只有 RagSearch（无 sourcePath），此闸是防御性兜底。
 */
export async function maybeSpill(
  content: string,
  project: ProjectSnapshot,
  sourcePath?: string,
): Promise<string> {
  if (content.length <= SPILL_THRESHOLD_CHARS) {
    return content
  }

  if (sourcePath && sourcePath.toLowerCase().startsWith(`${SPILL_DIR}/`)) {
    return content
  }

  const path = `${SPILL_DIR}/${createSpillFileId()}.txt`

  try {
    await writeProjectTextFile(project.handle, path, content)
  } catch {
    return content
  }

  const omitted = content.length - SPILL_HEAD_CHARS - SPILL_TAIL_CHARS

  return [
    content.slice(0, SPILL_HEAD_CHARS),
    `[... 中间 ${omitted} 字符已省略；完整内容已存至 ${path}，可用 ReadFile 对该路径以 offset/limit 分段取回 ...]`,
    content.slice(content.length - SPILL_TAIL_CHARS),
  ].join('\n')
}

/**
 * 启动清理（抄 dsh cleanup 的行为形状，保留期 7 天）：扫描 `.novel/spill/`，
 * 删除最后修改时间早于保留期的文件。best-effort：任何失败都吞掉，绝不影响项目打开。
 * 返回删除的文件数（观测/测试用）。
 */
export async function sweepExpiredSpillFiles(
  project: ProjectSnapshot,
  now: number = Date.now(),
): Promise<number> {
  const cutoff = now - SPILL_RETENTION_MS
  let removed = 0

  try {
    const spillDir = await getDirectoryIfExists(project.handle, SPILL_DIR)
    if (!spillDir) {
      return 0
    }

    for await (const entry of spillDir.values()) {
      if (entry.kind !== 'file') {
        continue
      }
      try {
        const file = await (entry as FileSystemFileHandle).getFile()
        if (file.lastModified < cutoff) {
          await spillDir.removeEntry(entry.name)
          removed += 1
        }
      } catch {
        // 单个条目失败（竞态删除/权限）不影响其余条目，清理整体永不抛错
      }
    }
  } catch {
    return removed
  }

  return removed
}

/** 逐级解析目录路径；不存在返回 null（不创建）。 */
async function getDirectoryIfExists(
  rootHandle: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle | null> {
  let current = rootHandle
  for (const segment of path.split('/').filter(Boolean)) {
    try {
      current = await current.getDirectoryHandle(segment)
    } catch {
      return null
    }
  }
  return current
}
