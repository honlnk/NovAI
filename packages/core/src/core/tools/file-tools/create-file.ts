import { readProjectTextFile, writeProjectTextFile } from '../../fs/project-fs'
import { assertWritableTextFilePath, isNotFoundError } from '../path'
import { assertChapterNumberAvailable, isChapterPath } from '../chapter-name'
import type { CreateFileInput, CreateFileOutput, ToolDefinition } from '../types'
import { asRecord, countLines, normalizeTextFilePath, readString } from './common'

export const createFileTool: ToolDefinition<'CreateFile', CreateFileInput, CreateFileOutput> = {
  name: 'CreateFile',
  description: '在当前小说项目中新建文本文件；中间目录会自动创建，目标已存在时会失败。已有文件请用 EditFile 修改。',
  validateInput(input) {
    const value = asRecord(input)
    const path = normalizeTextFilePath(value.path, 'CreateFile.path')
    const content = readString(value.content, 'CreateFile.content')

    return {
      path,
      content,
    }
  },
  async run(input, runtime) {
    assertWritableTextFilePath(input.path)

    // chapters/ 下检测章节编号是否已被占用
    if (isChapterPath(input.path)) {
      await assertChapterNumberAvailable(runtime.project.handle, input.path)
    }

    try {
      await readProjectTextFile(runtime.project.handle, input.path)
      throw new Error(`文件已存在：${input.path}；CreateFile 只用于新建文件。修改已有文件请先用 ReadFile 读取原文，再使用 EditFile 精确替换`)
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error
      }
    }

    await writeProjectTextFile(runtime.project.handle, input.path, input.content)

    return {
      path: input.path,
      contentLength: input.content.length,
      linesAdded: countLines(input.content),
      created: true,
    }
  },
  summarizeInput(input) {
    return `新建 ${input.path}`
  },
  summarizeOutput(output) {
    return `已新建 ${output.path}，共 ${output.linesAdded} 行，${output.contentLength} 个字符`
  },
  extractFileChange(output) {
    return { type: 'created', path: output.path }
  },
  buildConfirmation(input) {
    return { kind: 'create', path: input.path, content: input.content }
  },
}
