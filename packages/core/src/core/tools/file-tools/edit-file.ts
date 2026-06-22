import { getProjectTextFile, writeProjectTextFile } from '../../fs/project-fs'
import type { EditFileInput, EditFileOutput, ToolDefinition } from '../types'
import { assertTextFilePath, normalizeProjectPath } from '../path'
import { asRecord, countLines, readString } from './common'
import {
  assertFreshReadFileState,
  createReadFileState,
  readReadFileState,
} from './read-file-state'
import {
  countOccurrences,
  findActualText,
  preserveQuoteStyle,
} from './text-replace'

export const editFileTool: ToolDefinition<'EditFile', EditFileInput, EditFileOutput> = {
  name: 'EditFile',
  description: '用精确文本替换的方式修改当前小说项目中的已有文本文件；修改前应先读取目标文件。',
  validateInput(input) {
    const value = asRecord(input)
    const path = normalizeProjectPath(readString(value.path, 'EditFile.path'))
    const oldText = readString(value.oldText, 'EditFile.oldText')
    const newText = readString(value.newText, 'EditFile.newText')
    const readFileState = value.readFileState === undefined
      ? undefined
      : readReadFileState(value.readFileState, 'EditFile.readFileState')

    assertTextFilePath(path)

    if (oldText === newText) {
      throw new Error('EditFile.oldText 和 EditFile.newText 完全相同，没有可修改内容')
    }

    return {
      path,
      oldText,
      newText,
      replaceAll: typeof value.replaceAll === 'boolean' ? value.replaceAll : false,
      readFileState,
    }
  },
  async run(input, runtime) {
    const file = await getProjectTextFile(runtime.project.handle, input.path)
    const currentContent = await file.text()
    const currentState = createReadFileState(input.path, currentContent, file)
    const expectedState = input.readFileState ?? runtime.readFileStates?.get(input.path)

    if (!expectedState) {
      throw new Error(`修改 ${input.path} 前必须先用 ReadFile 读取目标文件；工具层没有找到可校验的读取状态`)
    }

    assertFreshReadFileState(input.path, expectedState, currentState)

    if (!input.oldText) {
      throw new Error('EditFile.oldText 不能为空；新增文件请使用 CreateFile，修改已有文件请先 ReadFile 并提供要替换的原文片段')
    }

    const actualOldText = findActualText(currentContent, input.oldText)

    if (!actualOldText) {
      throw new Error(`在 ${input.path} 中没有找到要替换的原文；请先用 ReadFile 读取最新内容，确认 oldText 与文件内容完全一致，且不要包含行号前缀`)
    }

    const occurrences = countOccurrences(currentContent, actualOldText)

    if (occurrences > 1 && !input.replaceAll) {
      throw new Error(`在 ${input.path} 中找到 ${occurrences} 处匹配；如需全部替换请启用 replaceAll。如只改其中一处，请直接把目标行与相邻上一行或下一行一起放进 oldText，组成唯一片段后再试`)
    }

    const actualNewText = preserveQuoteStyle(input.oldText, actualOldText, input.newText)
    const nextContent = input.replaceAll
      ? currentContent.split(actualOldText).join(actualNewText)
      : currentContent.replace(actualOldText, actualNewText)

    await writeProjectTextFile(runtime.project.handle, input.path, nextContent)
    runtime.readFileStates?.delete(input.path)

    return {
      path: input.path,
      occurrences: input.replaceAll ? occurrences : 1,
      contentLength: nextContent.length,
      linesAdded: countLines(actualNewText) - countLines(actualOldText),
      linesRemoved: Math.max(countLines(actualOldText) - countLines(actualNewText), 0),
    }
  },
  summarizeInput(input) {
    return input.replaceAll
      ? `替换 ${input.path} 中所有匹配文本`
      : `替换 ${input.path} 中一处匹配文本`
  },
  summarizeOutput(output) {
    return `已修改 ${output.path}，替换 ${output.occurrences} 处，当前 ${output.contentLength} 个字符`
  },
  extractFileChange(output) {
    return { type: 'updated', path: output.path }
  },
  buildConfirmation(input) {
    return { kind: 'edit', path: input.path, oldText: input.oldText, newText: input.newText }
  },
}
