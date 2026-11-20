import {
  readProjectTextFile,
  removeProjectFile,
  writeProjectTextFile,
} from '../../fs/project-fs'
import { createTrashPath } from '../../fs/trash'
import { isElementSourcePath } from '../../elements/reference-index'
import { parseElementFile } from '../../elements/parser'
import { removeReferences } from '../../../services/relation-service'
import { normalizeProjectPath } from '../path'
import type { DeleteFileInput, DeleteFileOutput, ToolDefinition } from '../types'
import {
  asRecord,
  assertMutableDocumentPath,
  readString,
} from './common'
import { countDiffLines } from './diff-line-stats'

export const deleteFileTool: ToolDefinition<'DeleteFile', DeleteFileInput, DeleteFileOutput> = {
  name: 'DeleteFile',
  description: '将当前小说项目中的单个文本文件移入回收站；不会直接永久删除。',
  validateInput(input) {
    const value = asRecord(input)
    const path = normalizeProjectPath(readString(value.path, 'DeleteFile.path'))

    assertMutableDocumentPath(path, 'DeleteFile.path')

    return {
      path,
    }
  },
  async run(input, runtime) {
    const content = await readProjectTextFile(runtime.project.handle, input.path)
    const trashPath = createTrashPath(input.path)

    // 删除要素文件时级联清理关系账本中引用它的关系（施工计划 §四：删除级联）。
    // 标识必须在删除前从 frontmatter 解析——文件删除后路径→标识的映射即失效；
    // 从未被引用过的要素没有 id（懒分配），天然不进关系账本，无需级联。
    const isElement = isElementSourcePath(input.path)
    const elementId = isElement ? parseElementFile(input.path, content).frontmatter.id.trim() : ''

    await writeProjectTextFile(runtime.project.handle, trashPath, content)
    await removeProjectFile(runtime.project.handle, input.path)

    // 文件删除已成功，级联失败不回滚删除，只不计入结果。
    let removedRelationCount = 0
    if (elementId) {
      try {
        const result = await removeReferences(runtime.project.id, { elementId }, 'agent')
        removedRelationCount = result.removedRelations.length
      } catch {
        // 账本损坏等场景下级联跳过；RelationCheck 与画布幽灵节点兜底报告
      }
    }

    return {
      path: input.path,
      trashPath,
      contentLength: content.length,
      linesRemoved: countDiffLines(content, '').linesRemoved,
      removedRelationCount,
    }
  },
  summarizeInput(input) {
    return `删除 ${input.path}`
  },
  summarizeOutput(output) {
    const cascade = output.removedRelationCount > 0
      ? `；级联移除 ${output.removedRelationCount} 条引用该要素的关系（关系账本已更新）`
      : ''
    return `已将 ${output.path} 移入回收站 ${output.trashPath}，原文件共 ${output.linesRemoved} 行，${output.contentLength} 个字符${cascade}`
  },
  extractFileChange(output) {
    return { type: 'deleted', path: output.path, trashPath: output.trashPath, linesRemoved: output.linesRemoved }
  },
  buildConfirmation(input) {
    return { kind: 'delete', path: input.path }
  },
}
