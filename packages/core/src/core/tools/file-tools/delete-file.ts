import {
  readProjectTextFile,
  removeProjectFile,
  writeProjectTextFile,
} from '../../fs/project-fs'
import { normalizeProjectPath } from '../path'
import type { DeleteFileInput, DeleteFileOutput, ToolDefinition } from '../types'
import {
  asRecord,
  assertMutableDocumentPath,
  countLines,
  readString,
} from './common'

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

    await writeProjectTextFile(runtime.project.handle, trashPath, content)
    await removeProjectFile(runtime.project.handle, input.path)

    return {
      path: input.path,
      trashPath,
      contentLength: content.length,
      linesRemoved: countLines(content),
    }
  },
  summarizeInput(input) {
    return `删除 ${input.path}`
  },
  summarizeOutput(output) {
    return `已将 ${output.path} 移入回收站 ${output.trashPath}，原文件共 ${output.linesRemoved} 行，${output.contentLength} 个字符`
  },
  extractFileChange(output) {
    return { type: 'deleted', path: output.path, trashPath: output.trashPath }
  },
  buildConfirmation(input) {
    return { kind: 'delete', path: input.path }
  },
}

function createTrashPath(path: string) {
  const now = new Date()
  const stamp = [
    now.getFullYear(),
    `${now.getMonth() + 1}`.padStart(2, '0'),
    `${now.getDate()}`.padStart(2, '0'),
    `${now.getHours()}`.padStart(2, '0'),
    `${now.getMinutes()}`.padStart(2, '0'),
    `${now.getSeconds()}`.padStart(2, '0'),
    Math.random().toString(36).slice(2, 8),
  ].join('-')

  return `.novel/trash/${stamp}/${path}`
}
