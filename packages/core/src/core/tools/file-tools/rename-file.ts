import { moveProjectTextFile, readProjectTextFile } from '../../fs/project-fs'
import { assertWritableTextFilePath, isNotFoundError, normalizeProjectPath } from '../path'
import type { RenameFileInput, RenameFileOutput, ToolDefinition } from '../types'
import { asRecord, assertMutableDocumentPath, assertWritableDocumentPath, readString } from './common'

export const renameFileTool: ToolDefinition<'RenameFile', RenameFileInput, RenameFileOutput> = {
  name: 'RenameFile',
  description: '重命名或移动当前小说项目中的单个文本文件；目标路径已存在时会失败。',
  validateInput(input) {
    const value = asRecord(input)
    const fromPath = normalizeProjectPath(readString(value.fromPath, 'RenameFile.fromPath'))
    const toPath = normalizeProjectPath(readString(value.toPath, 'RenameFile.toPath'))

    assertMutableDocumentPath(fromPath, 'RenameFile.fromPath')
    assertWritableDocumentPath(toPath, 'RenameFile.toPath')

    if (fromPath === toPath) {
      throw new Error('RenameFile.fromPath 和 RenameFile.toPath 不能相同')
    }

    return {
      fromPath,
      toPath,
    }
  },
  async run(input, runtime) {
    assertWritableTextFilePath(input.toPath)

    const content = await readProjectTextFile(runtime.project.handle, input.fromPath)

    try {
      await readProjectTextFile(runtime.project.handle, input.toPath)
      throw new Error(`目标文件已存在：${input.toPath}；RenameFile 不会覆盖已有文件，请换一个新路径`)
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error
      }
    }

    await moveProjectTextFile(runtime.project.handle, input.fromPath, input.toPath)

    return {
      fromPath: input.fromPath,
      toPath: input.toPath,
      contentLength: content.length,
    }
  },
  summarizeInput(input) {
    return `将 ${input.fromPath} 重命名或移动到 ${input.toPath}`
  },
  summarizeOutput(output) {
    return `已将 ${output.fromPath} 移动到 ${output.toPath}，共 ${output.contentLength} 个字符`
  },
  extractFileChange(output) {
    return { type: 'renamed', fromPath: output.fromPath, toPath: output.toPath }
  },
  buildConfirmation(input) {
    return { kind: 'rename', fromPath: input.fromPath, toPath: input.toPath }
  },
}
