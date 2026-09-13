import { writeProjectTextFile } from '../fs/project-fs'
import type { ProjectSnapshot } from '../../types/project'

/**
 * 长文本 Spill：超长工具结果在进入上下文之前拦截——全文落盘，上下文里只放预览 + 引用路径。
 *
 * 与 compaction 互补：spill 管「单次工具结果太大」，compaction 管「总量超阈值后的历史浓缩」。
 * 对「AI 读 4000 字章节」的场景，spill 比 compaction 更直接命中痛点。
 *
 * 只对 ReadFile / RagSearch 的结果 spill：写工具（CreateFile/EditFile 等）的内容是
 * 模型自己写的，回灌没有信息增益。spill 文件落在 `.novel/spill/`（受内部目录保护，
 * Agent 的 ReadFile 不能读取），避免 read → spill → read 把全文又读回上下文。
 */

/** 单个工具结果超过此字符数才 spill。 */
export const SPILL_THRESHOLD_CHARS = 8192
/** 预览保留的头部字符数。 */
export const SPILL_HEAD_CHARS = 4096
/** 预览保留的尾部字符数。 */
export const SPILL_TAIL_CHARS = 1024

export const SPILL_DIR = '.novel/spill'

/** 适用 spill 的工具：只读内容型工具（读目录/找文件的结果是路径清单，截断反而不可用）。 */
export const SPILLABLE_TOOLS = ['ReadFile', 'RagSearch'] as const

export function createSpillFileId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 若内容超过阈值：全文写入 `.novel/spill/<id>.txt`，返回「头 + 省略标记 + 尾」的预览；
 * 未超阈值原样返回。落盘失败时也原样返回（宁可上下文大一点，不能让工具结果丢失）。
 */
export async function maybeSpill(content: string, project: ProjectSnapshot): Promise<string> {
  if (content.length <= SPILL_THRESHOLD_CHARS) {
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
    `[... 中间 ${omitted} 字符已省略，完整内容见 ${path} ...]`,
    content.slice(content.length - SPILL_TAIL_CHARS),
  ].join('\n')
}
