import { getProjectTextFile, writeProjectTextFile } from '../../fs/project-fs'
import type { FileChangeVersion } from '../../../types/chat'
import type { EditFileInput, EditFileOutput, ReadFileState, ToolDefinition } from '../types'
import { isNotFoundError, normalizeProjectPath } from '../path'
import { assertChapterNameFormat, isChapterPath } from '../chapter-name'
import { computeReplaceRanges } from './change-coords'
import { asRecord, assertMutableDocumentPath, readString } from './common'
import { countDiffLines } from './diff-line-stats'
import {
  assertFreshReadFileState,
  createReadFileState,
  readReadFileState,
  updateReadFileStateAfterWrite,
} from './read-file-state'
import {
  countOccurrences,
  findActualText,
  preserveQuoteStyle,
} from './text-replace'

export const editFileTool: ToolDefinition<'EditFile', EditFileInput, EditFileOutput> = {
  name: 'EditFile',
  description: '用精确文本替换的方式修改当前小说项目中的已有文本文件；编辑前必须先 ReadFile 读取目标文件。',
  validateInput(input) {
    const value = asRecord(input)
    const path = normalizeProjectPath(readString(value.path, 'EditFile.path'))
    const oldText = readString(value.oldText, 'EditFile.oldText')
    const newText = readString(value.newText, 'EditFile.newText')
    const readFileState = value.readFileState === undefined
      ? undefined
      : readReadFileState(value.readFileState, 'EditFile.readFileState')

    // .novel/ 与 novel.config.json 永远禁改（大小写变体同拦），连确认卡都不弹
    assertMutableDocumentPath(path, 'EditFile.path')

    // chapters/ 下对称强制命名规范：不规范章节不可编辑内容，必须先整理改名
    if (isChapterPath(path)) {
      assertChapterNameFormat(path)
    }

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
    let file: File

    try {
      file = await getProjectTextFile(runtime.project.handle, input.path)
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new Error(`文件 ${input.path} 不存在；新建文件请使用 CreateFile，不要用 EditFile`)
      }

      throw error
    }

    const currentContent = await file.text()

    // 空文件特判（D1，参照 ZCode edit 空串分支）：oldText="" 只允许「填充空文件」一种用法——
    // 豁免读后写校验（空文件没有旧内容可保护），但仍走确认链（buildConfirmation 不变）。
    if (!input.oldText) {
      if (currentContent.trim() !== '') {
        throw new Error(`文件 ${input.path} 非空，不能用 oldText="" 整体写入；请提供要替换的原文片段`)
      }

      await writeProjectTextFile(runtime.project.handle, input.path, input.newText)
      const afterState = await updateReadFileStateAfterWrite(runtime, input.path, input.newText)

      return {
        path: input.path,
        occurrences: 1,
        contentLength: input.newText.length,
        ...countDiffLines('', input.newText),
        oldText: '',
        newText: input.newText,
        coords: {
          ranges: computeReplaceRanges(currentContent, '', input.newText, false),
          beforeVersion: toVersion(createReadFileState(input.path, currentContent, file)),
          afterVersion: toVersion(afterState),
        },
      }
    }

    const currentState = createReadFileState(input.path, currentContent, file)
    const expectedState = input.readFileState ?? runtime.readFileStates?.get(input.path)

    if (!expectedState) {
      throw new Error(`修改 ${input.path} 前必须先用 ReadFile 读取目标文件；工具层没有找到可校验的读取状态`)
    }

    assertFreshReadFileState(input.path, expectedState, currentState)

    const actualOldText = findActualText(currentContent, input.oldText)

    if (!actualOldText) {
      // ZCode 式错误教学：空文件里不可能匹配到原文，把 D1 入口（oldText=""）在这里告诉模型
      if (currentContent.trim() === '') {
        throw new Error(`文件 ${input.path} 为空；向空文件写入内容请把 oldText 设为空字符串`)
      }

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
    // D2：写完不删读取状态，改为更新为新内容——连续编辑同一文件免重读。
    const afterState = await updateReadFileStateAfterWrite(runtime, input.path, nextContent)

    return {
      path: input.path,
      occurrences: input.replaceAll ? occurrences : 1,
      contentLength: nextContent.length,
      ...countDiffLines(actualOldText, actualNewText),
      oldText: actualOldText,
      newText: actualNewText,
      coords: {
        ranges: computeReplaceRanges(currentContent, actualOldText, actualNewText, input.replaceAll === true),
        beforeVersion: toVersion(currentState),
        afterVersion: toVersion(afterState),
      },
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
  extractChangeDiff(output) {
    return {
      oldText: output.oldText,
      newText: output.newText,
      linesAdded: output.linesAdded,
      linesRemoved: output.linesRemoved,
    }
  },
  extractChangeCoords(output) {
    return output.coords
  },
  buildConfirmation(input) {
    return {
      kind: 'edit',
      path: input.path,
      oldText: input.oldText,
      newText: input.newText,
      ...(input.replaceAll === true ? { replaceAll: true } : {}),
    }
  },
}

/** ReadFileState → 账本版本标识（同一口径：内容哈希 + mtime ISO） */
function toVersion(state: ReadFileState): FileChangeVersion {
  return { contentHash: state.contentHash, updatedAt: state.lastModified }
}
