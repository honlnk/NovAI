import {
  createRhythmCard,
  deleteRhythmCard,
  readRhythmCard,
  scanRhythmCards,
  serializeRhythmCard,
  splitRhythmBody,
  updateRhythmCard,
} from '../rhythm'
import { countDiffLines } from './file-tools/diff-line-stats'
import { asRecord, readString } from './file-tools/common'
import { parseChapterNumber } from './chapter-name'
import {
  isRhythmHook,
  isRhythmMood,
  isRhythmPayoff,
  isRhythmStatus,
  RHYTHM_MOODS,
  RHYTHM_HOOKS,
  RHYTHM_PAYOFFS,
} from '../../types/rhythm'
import type { RhythmHook, RhythmMood, RhythmPayoff, RhythmStatus } from '../../types/rhythm'
import type { RhythmCardView } from '../../types/rhythm'
import type {
  RhythmCreateInput,
  RhythmCreateOutput,
  RhythmDeleteInput,
  RhythmDeleteOutput,
  RhythmCheckInput,
  RhythmCheckOutput,
  RhythmCurveInput,
  RhythmCurveOutput,
  RhythmListInput,
  RhythmListOutput,
  RhythmReadInput,
  RhythmReadOutput,
  RhythmSyncInput,
  RhythmSyncOutput,
  RhythmUpdateInput,
  RhythmUpdateOutput,
  ToolDefinition,
  ToolRuntime,
} from './types'

/**
 * 节奏卡维护工具（主 Agent 专属；要素管理员白名单不含这些工具，目录级守卫另挡通用文件工具）。
 *
 * 边界（创作心智模块计划 §四/§五）：
 * - 只以稳定标识定位，不接受路径；List 返回摘要（节奏意图首行），不返回正文全文。
 * - 计划值必填（冲突强度 1~10 整数 + 情绪/钩子/爽点枚举），枚举校验在工具层与
 *   解析层双重把关；status 与 deviation_flag 不接受外部设置——回写任一 actual_*
 *   时领域层按偏差判定规则自动计算并流转状态（written / deviated）。
 * - 正文三节（节奏意图/上下文衔接/作者备注）更新前必须先读取拿 contentHash；
 *   只改计划值/元数据时不传正文，正文原样保留。
 * - 删除只按用户明确要求触发（使用边界写在 prompt 工具规则里）。
 *
 * 变更账本：写工具实现 extractFileChange/extractChangeDiff，与计划/伏笔工具同一机制。
 */

const STATUS_DESCRIPTION = 'planned=规划中、written=已写、deviated=偏差'

function enumDescription(values: readonly string[]): string {
  return values.join('、')
}

function readRhythmStatus(value: unknown, label: string): RhythmStatus | undefined {
  if (value === undefined) {
    return undefined
  }
  const status = readString(value, label)
  if (!isRhythmStatus(status)) {
    throw new Error(`${label} 必须是 ${STATUS_DESCRIPTION}`)
  }
  return status
}

function readRhythmMood(value: unknown, label: string): RhythmMood {
  const mood = readString(value, label)
  if (!isRhythmMood(mood)) {
    throw new Error(`${label} 必须是以下之一：${enumDescription(RHYTHM_MOODS)}`)
  }
  return mood
}

function readRhythmHook(value: unknown, label: string): RhythmHook {
  const hook = readString(value, label)
  if (!isRhythmHook(hook)) {
    throw new Error(`${label} 必须是以下之一：${enumDescription(RHYTHM_HOOKS)}`)
  }
  return hook
}

function readRhythmPayoff(value: unknown, label: string): RhythmPayoff {
  const payoff = readString(value, label)
  if (!isRhythmPayoff(payoff)) {
    throw new Error(`${label} 必须是以下之一：${enumDescription(RHYTHM_PAYOFFS)}`)
  }
  return payoff
}

/** 冲突强度：1~10 整数（工具层先拦一道，领域层 normalize 同规则兜底）。 */
function readConflictIntensity(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error(`${label} 必须是 1~10 的整数`)
  }
  return value
}

function readChapterRange(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} 必须是正整数章号`)
  }
  return value
}

function readStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} 必须是字符串数组`)
  }
  return (value as string[]).map((item) => item.trim()).filter((item) => item.length > 0)
}

function readNullableString(value: unknown, label: string): string | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  return readString(value, label)
}

function readNullableMood(value: unknown, label: string): RhythmMood | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  return readRhythmMood(value, label)
}

function readNullableHook(value: unknown, label: string): RhythmHook | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  return readRhythmHook(value, label)
}

function readNullablePayoff(value: unknown, label: string): RhythmPayoff | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  return readRhythmPayoff(value, label)
}

function readNullableConflict(value: unknown, label: string): number | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  return readConflictIntensity(value, label)
}

/** 按章号筛选辅助：chapter_ref 里的「第N章」数值落在 [from, to]（缺省侧开放）。 */
function chapterRefInRange(chapterRef: string, from: number | undefined, to: number | undefined): boolean {
  if (from === undefined && to === undefined) {
    return true
  }
  const number = parseChapterNumber(chapterRef)
  if (number === null) {
    return false
  }
  if (from !== undefined && number < from) {
    return false
  }
  if (to !== undefined && number > to) {
    return false
  }
  return true
}

export const rhythmListTool: ToolDefinition<'RhythmList', RhythmListInput, RhythmListOutput> = {
  name: 'RhythmList',
  description: '查询节奏卡摘要（卡名、状态、关联章节、计划冲突强度/情绪/钩子/爽点、偏差标记、节奏意图首行摘要），可按状态、卷、章号范围筛选。',
  validateInput(input) {
    const value = asRecord(input)
    const status = readRhythmStatus(value.status, 'RhythmList.status')
    const volume = value.volume === undefined ? undefined : readString(value.volume, 'RhythmList.volume').trim()
    const chapterFrom = readChapterRange(value.chapterFrom, 'RhythmList.chapterFrom')
    const chapterTo = readChapterRange(value.chapterTo, 'RhythmList.chapterTo')
    if (chapterFrom !== undefined && chapterTo !== undefined && chapterFrom > chapterTo) {
      throw new Error('RhythmList.chapterFrom 不能大于 chapterTo')
    }
    return {
      ...(status !== undefined ? { status } : {}),
      ...(volume ? { volume } : {}),
      ...(chapterFrom !== undefined ? { chapterFrom } : {}),
      ...(chapterTo !== undefined ? { chapterTo } : {}),
    }
  },
  async run(input, runtime) {
    const scan = await scanRhythmCards(runtime.project)
    let cards = scan.cards
    if (input.status) {
      cards = cards.filter((card) => card.status === input.status)
    }
    if (input.volume) {
      cards = cards.filter((card) => card.volume === input.volume)
    }
    cards = cards.filter((card) => chapterRefInRange(card.chapterRef, input.chapterFrom, input.chapterTo))

    return {
      rhythm: cards.map((card) => ({
        id: card.id,
        name: card.name,
        status: card.status,
        chapterRef: card.chapterRef,
        volume: card.volume,
        plannedConflict: card.plannedConflict,
        plannedMood: card.plannedMood,
        plannedHook: card.plannedHook,
        plannedPayoff: card.plannedPayoff,
        deviationFlag: card.deviationFlag,
        updatedAt: card.updatedAt,
        summary: card.summary,
      })),
      totalCount: cards.length,
    }
  },
  summarizeInput(input) {
    const parts: string[] = []
    if (input.status) parts.push(`状态 ${input.status}`)
    if (input.volume) parts.push(`卷 ${input.volume}`)
    if (input.chapterFrom !== undefined || input.chapterTo !== undefined) {
      parts.push(`章号 ${input.chapterFrom ?? '…'}~${input.chapterTo ?? '…'}`)
    }
    return `查询节奏卡摘要${parts.length ? `（${parts.join('、')}）` : ''}`
  },
  summarizeOutput(output) {
    return `共 ${output.totalCount} 张节奏卡`
  },
}

export const rhythmReadTool: ToolDefinition<'RhythmRead', RhythmReadInput, RhythmReadOutput> = {
  name: 'RhythmRead',
  description: '按稳定标识读取一张节奏卡完整内容（计划值 + 实际值 + 偏差说明 + 正文三节 + contentHash）。回写实际值或改正文时必须先读取拿 contentHash。',
  validateInput(input) {
    const value = asRecord(input)
    const id = readString(value.id, 'RhythmRead.id').trim()
    if (!id) {
      throw new Error('RhythmRead.id 不能为空')
    }
    return { id }
  },
  async run(input, runtime) {
    const result = await readRhythmCard(runtime.project, input.id)
    if (!result) {
      return { id: input.id, notFound: true as const }
    }
    const { intentBody, linkBody, authorNoteBody } = splitRhythmBody(result.card.body)
    return {
      id: result.card.id,
      name: result.card.name,
      status: result.card.status,
      chapterRef: result.card.chapterRef,
      volume: result.card.volume,
      plannedConflict: result.card.plannedConflict,
      plannedMood: result.card.plannedMood,
      plannedHook: result.card.plannedHook,
      plannedPayoff: result.card.plannedPayoff,
      plannedCharacters: [...result.card.plannedCharacters],
      plannedNote: result.card.plannedNote,
      actualConflict: result.card.actualConflict,
      actualMood: result.card.actualMood,
      actualHook: result.card.actualHook,
      actualPayoff: result.card.actualPayoff,
      actualNote: result.card.actualNote,
      deviationFlag: result.card.deviationFlag,
      deviationNote: result.card.deviationNote,
      intentBody,
      linkBody,
      authorNoteBody,
      sourcePath: result.card.sourcePath,
      contentHash: result.contentHash,
      createdAt: result.card.createdAt,
      updatedAt: result.card.updatedAt,
    }
  },
  summarizeInput(input) {
    return `读取节奏卡 ${input.id}`
  },
  summarizeOutput(output) {
    return 'notFound' in output
      ? `节奏卡 ${output.id} 不存在`
      : `已读取节奏卡「${output.name || output.id}」（${STATUS_DESCRIPTION.split('、').find((part) => part.startsWith(output.status)) ?? output.status}）`
  },
}

export const rhythmCreateTool: ToolDefinition<'RhythmCreate', RhythmCreateInput, RhythmCreateOutput> = {
  name: 'RhythmCreate',
  description: '规划一张节奏卡（一章一卡）。必须提供：关联章节（卷/章）、计划冲突强度（1~10）、计划情绪基调、计划章末钩子、计划爽点类型；节奏意图正文建议同写（本章要什么温度、不要什么）。文件名由应用生成。',
  validateInput(input) {
    const value = asRecord(input)

    const chapterRef = readString(value.chapterRef, 'RhythmCreate.chapterRef').trim()
    if (!chapterRef) {
      throw new Error('关联章节不能为空：写明这张卡对应哪一章（如 第二卷/第083章）')
    }

    const plannedConflict = readConflictIntensity(value.plannedConflict, 'RhythmCreate.plannedConflict')
    const plannedMood = readRhythmMood(value.plannedMood, 'RhythmCreate.plannedMood')
    const plannedHook = readRhythmHook(value.plannedHook, 'RhythmCreate.plannedHook')
    const plannedPayoff = readRhythmPayoff(value.plannedPayoff, 'RhythmCreate.plannedPayoff')

    const name = value.name === undefined ? undefined : readString(value.name, 'RhythmCreate.name').trim()
    if (name !== undefined && !name) {
      throw new Error('节奏卡名不能为空（不传则按章节名自动生成）')
    }
    const volume = value.volume === undefined ? undefined : readString(value.volume, 'RhythmCreate.volume').trim()
    const plannedCharacters = readStringArray(value.plannedCharacters, 'RhythmCreate.plannedCharacters')
    const plannedNote = value.plannedNote === undefined ? undefined : readString(value.plannedNote, 'RhythmCreate.plannedNote')
    const intentBody = value.intentBody === undefined ? undefined : readString(value.intentBody, 'RhythmCreate.intentBody')
    const linkBody = value.linkBody === undefined ? undefined : readString(value.linkBody, 'RhythmCreate.linkBody')
    const authorNoteBody = value.authorNoteBody === undefined ? undefined : readString(value.authorNoteBody, 'RhythmCreate.authorNoteBody')

    return {
      ...(name !== undefined ? { name } : {}),
      chapterRef,
      plannedConflict,
      plannedMood,
      plannedHook,
      plannedPayoff,
      ...(volume ? { volume } : {}),
      ...(plannedCharacters !== undefined ? { plannedCharacters } : {}),
      ...(plannedNote !== undefined ? { plannedNote } : {}),
      ...(intentBody !== undefined ? { intentBody } : {}),
      ...(linkBody !== undefined ? { linkBody } : {}),
      ...(authorNoteBody !== undefined ? { authorNoteBody } : {}),
    }
  },
  async run(input, runtime) {
    // 卡名缺省按章节名生成（如 第二卷/第083章 → 第083章节奏）
    const chapterName = input.chapterRef.split('/').pop() ?? input.chapterRef
    const card = await createRhythmCard(runtime.project, {
      ...input,
      name: input.name ?? `${chapterName}节奏`,
    })
    const content = serializeRhythmCard(card)

    return {
      id: card.id,
      name: card.name,
      status: card.status,
      sourcePath: card.sourcePath,
      content,
      contentLength: content.length,
      linesAdded: countDiffLines('', content).linesAdded,
      created: true as const,
    }
  },
  summarizeInput(input) {
    return `规划节奏卡（${input.chapterRef}）`
  },
  summarizeOutput(output) {
    return `已创建节奏卡「${output.name}」（${output.sourcePath}），状态 规划中`
  },
  extractFileChange(output) {
    return { type: 'created', path: output.sourcePath }
  },
  extractChangeDiff(output) {
    return {
      oldText: '',
      newText: output.content,
      linesAdded: output.linesAdded,
      linesRemoved: 0,
    }
  },
  buildConfirmation(input) {
    // 文件名在执行时生成；确认卡展示目录 + 计划值一行式
    const chapterName = input.chapterRef.split('/').pop() ?? input.chapterRef
    const preview = [
      `章节：${input.chapterRef}`,
      `计划：冲突 ${input.plannedConflict} · ${input.plannedMood} · 钩子 ${input.plannedHook} · 爽点 ${input.plannedPayoff}`,
      ...(input.plannedCharacters?.length ? [`出场：${input.plannedCharacters.join('、')}`] : []),
      ...(input.plannedNote ? [`备注：${input.plannedNote}`] : []),
      ...(input.intentBody ? ['', input.intentBody] : []),
    ].join('\n')
    return {
      kind: 'create',
      path: `rhythm/（${input.name ?? `${chapterName}节奏`}，执行时生成文件名）`,
      content: preview,
    }
  },
}

export const rhythmUpdateTool: ToolDefinition<'RhythmUpdate', RhythmUpdateInput, RhythmUpdateOutput> = {
  name: 'RhythmUpdate',
  description: '按稳定标识更新一张节奏卡：计划值各字段、正文三节（节奏意图/上下文衔接/作者备注）、写后回写实际值（actual_*）分别可选。改正文前必须先读取并回传 contentHash；只改计划值时不传正文。回写任一 actual_* 时系统自动计算偏差并流转状态（written/deviated）——status 与偏差标记不接受外部设置；五项 actual_* 全传 null 可撤销回写（回到规划中）。',
  validateInput(input) {
    const value = asRecord(input)
    const id = readString(value.id, 'RhythmUpdate.id').trim()
    if (!id) {
      throw new Error('RhythmUpdate.id 不能为空')
    }

    const name = value.name === undefined ? undefined : readString(value.name, 'RhythmUpdate.name').trim()
    if (name !== undefined && !name) {
      throw new Error('节奏卡名不能为空')
    }
    const chapterRef = value.chapterRef === undefined ? undefined : readString(value.chapterRef, 'RhythmUpdate.chapterRef').trim()
    if (chapterRef !== undefined && !chapterRef) {
      throw new Error('关联章节不能为空')
    }
    const volume = value.volume === undefined ? undefined : readString(value.volume, 'RhythmUpdate.volume').trim()

    const plannedConflict = value.plannedConflict === undefined
      ? undefined
      : readConflictIntensity(value.plannedConflict, 'RhythmUpdate.plannedConflict')
    const plannedMood = value.plannedMood === undefined ? undefined : readRhythmMood(value.plannedMood, 'RhythmUpdate.plannedMood')
    const plannedHook = value.plannedHook === undefined ? undefined : readRhythmHook(value.plannedHook, 'RhythmUpdate.plannedHook')
    const plannedPayoff = value.plannedPayoff === undefined ? undefined : readRhythmPayoff(value.plannedPayoff, 'RhythmUpdate.plannedPayoff')
    const plannedCharacters = readStringArray(value.plannedCharacters, 'RhythmUpdate.plannedCharacters')
    const plannedNote = value.plannedNote === undefined ? undefined : readString(value.plannedNote, 'RhythmUpdate.plannedNote')

    const intentBody = value.intentBody === undefined ? undefined : readString(value.intentBody, 'RhythmUpdate.intentBody')
    const linkBody = value.linkBody === undefined ? undefined : readString(value.linkBody, 'RhythmUpdate.linkBody')
    const authorNoteBody = value.authorNoteBody === undefined ? undefined : readString(value.authorNoteBody, 'RhythmUpdate.authorNoteBody')

    const actualConflict = readNullableConflict(value.actualConflict, 'RhythmUpdate.actualConflict')
    const actualMood = readNullableMood(value.actualMood, 'RhythmUpdate.actualMood')
    const actualHook = readNullableHook(value.actualHook, 'RhythmUpdate.actualHook')
    const actualPayoff = readNullablePayoff(value.actualPayoff, 'RhythmUpdate.actualPayoff')
    const actualNote = readNullableString(value.actualNote, 'RhythmUpdate.actualNote')

    const afterId = value.afterId === undefined || value.afterId === null
      ? null
      : readString(value.afterId, 'RhythmUpdate.afterId').trim() || null
    const expectedContentHash = value.expectedContentHash === undefined
      ? undefined
      : readString(value.expectedContentHash, 'RhythmUpdate.expectedContentHash')

    // 正文替换强制走「先读后写」：防止没有版本依据的整段替换覆盖外部修改
    if ((intentBody !== undefined || linkBody !== undefined || authorNoteBody !== undefined) && !expectedContentHash) {
      throw new Error('更新正文（节奏意图/上下文衔接/作者备注）前，必须先用 RhythmRead 拿到 contentHash 并作为 expectedContentHash 传入')
    }

    const hasUpdate = [
      name, chapterRef, volume, plannedConflict, plannedMood, plannedHook, plannedPayoff,
      plannedCharacters, plannedNote, intentBody, linkBody, authorNoteBody,
      actualConflict, actualMood, actualHook, actualPayoff, actualNote,
    ].some((field) => field !== undefined) || afterId !== null
    if (!hasUpdate) {
      throw new Error('至少提供 name、计划值、正文三节、actual_* 等要更新的字段之一')
    }

    return {
      id,
      ...(name !== undefined ? { name } : {}),
      ...(chapterRef !== undefined ? { chapterRef } : {}),
      ...(volume !== undefined ? { volume } : {}),
      ...(plannedConflict !== undefined ? { plannedConflict } : {}),
      ...(plannedMood !== undefined ? { plannedMood } : {}),
      ...(plannedHook !== undefined ? { plannedHook } : {}),
      ...(plannedPayoff !== undefined ? { plannedPayoff } : {}),
      ...(plannedCharacters !== undefined ? { plannedCharacters } : {}),
      ...(plannedNote !== undefined ? { plannedNote } : {}),
      ...(intentBody !== undefined ? { intentBody } : {}),
      ...(linkBody !== undefined ? { linkBody } : {}),
      ...(authorNoteBody !== undefined ? { authorNoteBody } : {}),
      ...(actualConflict !== undefined ? { actualConflict } : {}),
      ...(actualMood !== undefined ? { actualMood } : {}),
      ...(actualHook !== undefined ? { actualHook } : {}),
      ...(actualPayoff !== undefined ? { actualPayoff } : {}),
      ...(actualNote !== undefined ? { actualNote } : {}),
      afterId,
      ...(expectedContentHash !== undefined ? { expectedContentHash } : {}),
    }
  },
  async run(input, runtime) {
    const card = await updateRhythmCard(runtime.project, {
      ...input,
      conflictThreshold: readConflictThreshold(runtime),
    })
    const content = serializeRhythmCard(card)

    return {
      id: card.id,
      name: card.name,
      status: card.status,
      deviationFlag: card.deviationFlag,
      deviationNote: card.deviationNote,
      sourcePath: card.sourcePath,
      content,
      contentLength: content.length,
    }
  },
  summarizeInput(input) {
    const parts: string[] = []
    if (input.name !== undefined) parts.push('名称')
    if ([input.plannedConflict, input.plannedMood, input.plannedHook, input.plannedPayoff, input.plannedCharacters, input.plannedNote].some((f) => f !== undefined)) parts.push('计划值')
    if ([input.intentBody, input.linkBody, input.authorNoteBody].some((f) => f !== undefined)) parts.push('正文')
    if ([input.actualConflict, input.actualMood, input.actualHook, input.actualPayoff, input.actualNote].some((f) => f !== undefined)) parts.push('回写实际值')
    return `更新节奏卡 ${input.id}（${parts.join('、') || '列内位置'}）`
  },
  summarizeOutput(output) {
    const statusLabel = output.status === 'planned' ? '规划中' : output.status === 'written' ? '已写' : '偏差'
    const deviation = output.deviationFlag && output.deviationNote ? `；${output.deviationNote}` : ''
    return `已更新节奏卡「${output.name || output.id}」，状态 ${statusLabel}${deviation}`
  },
  extractFileChange(output) {
    return { type: 'updated', path: output.sourcePath }
  },
  extractChangeDiff(output) {
    return {
      oldText: '',
      newText: output.content,
      linesAdded: countDiffLines('', output.content).linesAdded,
      linesRemoved: 0,
    }
  },
  buildConfirmation(input) {
    const path = `rhythm/（节奏卡 ${input.id}）`
    const bodyFields: string[] = []
    if (input.intentBody !== undefined) bodyFields.push('节奏意图')
    if (input.linkBody !== undefined) bodyFields.push(input.linkBody ? '上下文衔接' : '清除上下文衔接')
    if (input.authorNoteBody !== undefined) bodyFields.push(input.authorNoteBody ? '作者备注' : '清除作者备注')

    if (bodyFields.length > 0) {
      const preview = [
        input.intentBody !== undefined ? input.intentBody : '（节奏意图不变）',
        input.linkBody !== undefined ? (input.linkBody || '（清除上下文衔接）') : '（上下文衔接不变）',
        input.authorNoteBody !== undefined ? (input.authorNoteBody || '（清除作者备注）') : '（作者备注不变）',
      ].join('\n\n')
      return { kind: 'edit', path, oldText: '（正文节替换，差异以执行结果为准）', newText: preview }
    }

    const metaParts: string[] = []
    if (input.name !== undefined) metaParts.push(`名称改为「${input.name}」`)
    if (input.chapterRef !== undefined) metaParts.push(`关联章节改为 ${input.chapterRef}`)
    const plannedParts: string[] = []
    if (input.plannedConflict !== undefined) plannedParts.push(`冲突 ${input.plannedConflict}`)
    if (input.plannedMood !== undefined) plannedParts.push(`情绪 ${input.plannedMood}`)
    if (input.plannedHook !== undefined) plannedParts.push(`钩子 ${input.plannedHook}`)
    if (input.plannedPayoff !== undefined) plannedParts.push(`爽点 ${input.plannedPayoff}`)
    if (plannedParts.length) metaParts.push(`计划值：${plannedParts.join(' · ')}`)
    const actualParts: string[] = []
    if (input.actualConflict !== undefined) actualParts.push(`冲突 ${input.actualConflict ?? '清除'}`)
    if (input.actualMood !== undefined) actualParts.push(`情绪 ${input.actualMood ?? '清除'}`)
    if (input.actualHook !== undefined) actualParts.push(`钩子 ${input.actualHook ?? '清除'}`)
    if (input.actualPayoff !== undefined) actualParts.push(`爽点 ${input.actualPayoff ?? '清除'}`)
    if (input.actualNote !== undefined) actualParts.push(`自评 ${input.actualNote ? '（已填）' : '清除'}`)
    if (actualParts.length) metaParts.push(`回写实际值：${actualParts.join(' · ')}（偏差与状态由系统自动判定）`)
    const extra = [input.volume, input.plannedCharacters, input.plannedNote].some((field) => field !== undefined)
    if (extra) metaParts.push('（其余元数据字段）')

    return {
      kind: 'edit',
      path,
      oldText: '（不改正文）',
      newText: metaParts.length ? metaParts.join('；') : '（调整列内位置）',
    }
  },
}

export const rhythmDeleteTool: ToolDefinition<'RhythmDelete', RhythmDeleteInput, RhythmDeleteOutput> = {
  name: 'RhythmDelete',
  description: '按稳定标识删除一张节奏卡（移入项目回收站 .novel/trash/，不直接永久删除）。只在用户明确要求删除时使用。',
  validateInput(input) {
    const value = asRecord(input)
    const id = readString(value.id, 'RhythmDelete.id').trim()
    if (!id) {
      throw new Error('RhythmDelete.id 不能为空')
    }
    return { id }
  },
  async run(input, runtime) {
    const result = await deleteRhythmCard(runtime.project, input.id)
    const content = serializeRhythmCard(result.card)

    return {
      id: result.card.id,
      sourcePath: result.card.sourcePath,
      trashPath: result.trashPath,
      contentLength: content.length,
      linesRemoved: countDiffLines(content, '').linesRemoved,
    }
  },
  summarizeInput(input) {
    return `删除节奏卡 ${input.id}`
  },
  summarizeOutput(output) {
    return `已将节奏卡 ${output.sourcePath} 移入回收站 ${output.trashPath}`
  },
  extractFileChange(output) {
    return { type: 'deleted', path: output.sourcePath, trashPath: output.trashPath, linesRemoved: output.linesRemoved }
  },
  buildConfirmation(input) {
    return { kind: 'delete', path: `rhythm/（节奏卡 ${input.id}）` }
  },
}

// ---------- 高层工具：Check（写前）/ Sync（写后）/ Curve（查询） ----------
//
// 与 ForeshadowingCheck/Sync 同一设计口径（创作心智模块计划 §五/§六/§10.6）：
// - Check（写前）：本章计划节奏 + 前后章节奏。前一章带实际值——衔接主要看上一章
//   落地的温度，不是计划温度。
// - Sync（写后）：只读的回写提案上下文组装器（本章卡完整内容 + contentHash +
//   偏差规则与当前阈值）。提案由模型整理后交作者审阅，落盘走带确认的 RhythmUpdate
//   ——一条确认链路，不为批量回写另做审批 UI。
// - Curve（查询）：章节范围内计划/实际对照曲线数据，供「最近节奏怎么样」类总结。
// 章号匹配统一走「第N章」数值比较（与伏笔 Check/Sync 同一简化口径）。

/** 项目设置里的偏差阈值（normalize 已夹回 1~10；无配置环境回退默认 3）。 */
function readConflictThreshold(runtime: ToolRuntime): number {
  return runtime.project.config?.settings?.rhythmDeviationThreshold ?? 3
}

function deviationRulesText(threshold: number): string {
  return [
    `偏差判定规则（当前冲突强度阈值 ${threshold}）：`,
    `- 冲突强度：|计划 - 实际| ≥ ${threshold} 判偏差；`,
    '- 情绪基调：与计划不一致即偏差；',
    '- 章末钩子：只在「有 ↔ 无」翻转时判偏差（同为有但类型不同不算）；',
    '- 爽点类型：与计划不一致即偏差。',
    '偏差是中性信号：如实回写，系统自动落「偏差」列并生成说明，不需要粉饰。',
  ].join('\n')
}

function toCheckCardBase(card: RhythmCardView) {
  return {
    id: card.id,
    name: card.name,
    status: card.status,
    chapterRef: card.chapterRef,
    volume: card.volume,
    plannedConflict: card.plannedConflict,
    plannedMood: card.plannedMood,
    plannedHook: card.plannedHook,
    plannedPayoff: card.plannedPayoff,
    actualConflict: card.actualConflict,
    actualMood: card.actualMood,
    actualHook: card.actualHook,
    actualPayoff: card.actualPayoff,
    deviationFlag: card.deviationFlag,
  }
}

/** 扫描结果里按章号定位本章卡（一章一卡；异常重复时取排序后的第一张）。 */
function findCardByChapter(cards: readonly RhythmCardView[], chapter: number): RhythmCardView | null {
  return cards.find((card) => parseChapterNumber(card.chapterRef) === chapter) ?? null
}

export const rhythmCheckTool: ToolDefinition<'RhythmCheck', RhythmCheckInput, RhythmCheckOutput> = {
  name: 'RhythmCheck',
  description: '写前检查（写第 N 章前主动调用）：返回本章的计划节奏（冲突强度/情绪/钩子/爽点 + 节奏意图）与前后章节奏——前一章带已回写的实际值，衔接主要看上一章落地的温度。本章还没有节奏卡时也返回前后章，并提示是否先规划。',
  validateInput(input) {
    const value = asRecord(input)
    const chapter = readChapterRange(value.chapter, 'RhythmCheck.chapter')
    if (chapter === undefined) {
      throw new Error('RhythmCheck.chapter 必须是正整数章号（如 12 表示第 12 章）')
    }
    return { chapter }
  },
  async run(input, runtime) {
    const scan = await scanRhythmCards(runtime.project)
    const chapter = input.chapter
    const planned = findCardByChapter(scan.cards, chapter)

    const numbered = scan.cards
      .map((card) => ({ card, number: parseChapterNumber(card.chapterRef) }))
      .filter((entry): entry is { card: RhythmCardView; number: number } => entry.number !== null)
    const before = numbered.filter((entry) => entry.number < chapter).sort((a, b) => b.number - a.number)
    const after = numbered.filter((entry) => entry.number > chapter).sort((a, b) => a.number - b.number)
    const previous = before[0]?.card ?? null
    const next = after[0]?.card ?? null

    return {
      chapter,
      planned: planned
        ? { ...toCheckCardBase(planned), intentBody: splitRhythmBody(planned.body).intentBody }
        : null,
      previous: previous ? toCheckCardBase(previous) : null,
      next: next ? toCheckCardBase(next) : null,
      guidance: planned
        ? [
          '写作提示：按本章计划值控温（冲突强度/情绪/钩子/爽点），节奏意图说明本章要什么温度；',
          'previous 已带实际值时以实际温度衔接——上一章实际写出来的温度才是读者此刻的感受基线。',
        ].join('\n')
        : '本章还没有节奏卡：先向作者确认是否要为本章规划节奏（RhythmCreate），不主张未经要求自动建卡。',
    }
  },
  summarizeInput(input) {
    return `写前检查第 ${input.chapter} 章节奏`
  },
  summarizeOutput(output) {
    return output.planned
      ? `第 ${output.chapter} 章：计划 冲突 ${output.planned.plannedConflict} · ${output.planned.plannedMood}`
      : `第 ${output.chapter} 章：尚无节奏卡（已带前后章上下文）`
  },
}

export const rhythmSyncTool: ToolDefinition<'RhythmSync', RhythmSyncInput, RhythmSyncOutput> = {
  name: 'RhythmSync',
  description: '写后同步（写完第 N 章后主动调用）：组装节奏回写提案——本章节奏卡完整内容（含 contentHash）+ 偏差判定规则与当前阈值。本工具只读不落盘：对照本章正文整理 actual_* 回写提案（一组回写，不拆半组），先列给作者审阅，批准后用 RhythmUpdate 落盘（contentHash 直接回传）。',
  validateInput(input) {
    const value = asRecord(input)
    const chapter = readChapterRange(value.chapter, 'RhythmSync.chapter')
    if (chapter === undefined) {
      throw new Error('RhythmSync.chapter 必须是正整数章号（如 12 表示第 12 章）')
    }
    return { chapter }
  },
  async run(input, runtime) {
    const chapter = input.chapter
    const scan = await scanRhythmCards(runtime.project)
    const target = findCardByChapter(scan.cards, chapter)

    if (!target) {
      return {
        chapter,
        notFound: true as const,
        guidance: '本章没有节奏卡，无需回写。若作者想补登本章节奏，先提案 RhythmCreate（一章一卡）。',
      }
    }

    const result = await readRhythmCard(runtime.project, target.id)
    if (!result) {
      return {
        chapter,
        notFound: true as const,
        guidance: '本章节奏卡在扫描后已被移除，重新用 RhythmList 确认。',
      }
    }

    const { intentBody, linkBody, authorNoteBody } = splitRhythmBody(result.card.body)
    const threshold = readConflictThreshold(runtime)

    return {
      chapter,
      id: result.card.id,
      name: result.card.name,
      status: result.card.status,
      chapterRef: result.card.chapterRef,
      volume: result.card.volume,
      plannedConflict: result.card.plannedConflict,
      plannedMood: result.card.plannedMood,
      plannedHook: result.card.plannedHook,
      plannedPayoff: result.card.plannedPayoff,
      plannedCharacters: [...result.card.plannedCharacters],
      intentBody,
      linkBody,
      authorNoteBody,
      actualConflict: result.card.actualConflict,
      actualMood: result.card.actualMood,
      actualHook: result.card.actualHook,
      actualPayoff: result.card.actualPayoff,
      deviationFlag: result.card.deviationFlag,
      deviationNote: result.card.deviationNote,
      contentHash: result.contentHash,
      conflictThreshold: threshold,
      deviationRules: deviationRulesText(threshold),
      guidance: [
        '对照本章正文如实整理 actual_* 一组回写值（冲突强度/情绪/钩子/爽点 + 本章自评 actualNote）；',
        '系统按偏差规则自动判定状态与偏差说明——status 与偏差标记不手填；',
        '提案先列给作者审阅（写超了也要如实报，偏差不是错误），批准后用 RhythmUpdate 落盘，contentHash 直接作为 expectedContentHash 回传。',
      ].join('\n'),
    }
  },
  summarizeInput(input) {
    return `写后同步第 ${input.chapter} 章节奏`
  },
  summarizeOutput(output) {
    return 'notFound' in output
      ? `第 ${output.chapter} 章：无节奏卡，无需回写`
      : `第 ${output.chapter} 章「${output.name || output.id}」：已组装回写提案上下文`
  },
}

export const rhythmCurveTool: ToolDefinition<'RhythmCurve', RhythmCurveInput, RhythmCurveOutput> = {
  name: 'RhythmCurve',
  description: '节奏曲线查询（作者问「最近节奏怎么样」时调用）：返回章节范围内每章的计划/实际对照（按章号升序）。范围用章号数值给定（如最近 20 章 = chapterFrom: 最新章号-19, chapterTo: 最新章号）；不传范围返回全部。拿到曲线后用自然语言总结趋势与建议（连续高强度提示安排呼吸口、连续低强度提示蓄力）。',
  validateInput(input) {
    const value = asRecord(input)
    const chapterFrom = readChapterRange(value.chapterFrom, 'RhythmCurve.chapterFrom')
    const chapterTo = readChapterRange(value.chapterTo, 'RhythmCurve.chapterTo')
    if (chapterFrom !== undefined && chapterTo !== undefined && chapterFrom > chapterTo) {
      throw new Error('RhythmCurve.chapterFrom 不能大于 chapterTo')
    }
    return {
      ...(chapterFrom !== undefined ? { chapterFrom } : {}),
      ...(chapterTo !== undefined ? { chapterTo } : {}),
    }
  },
  async run(input, runtime) {
    const scan = await scanRhythmCards(runtime.project)
    const inRange = scan.cards
      .filter((card) => chapterRefInRange(card.chapterRef, input.chapterFrom, input.chapterTo))
      .sort((a, b) => {
        const left = parseChapterNumber(a.chapterRef)
        const right = parseChapterNumber(b.chapterRef)
        if (left !== null && right !== null) {
          return left - right
        }
        if (left !== null) {
          return -1
        }
        return right !== null ? 1 : 0
      })

    return {
      curve: inRange.map((card) => ({ ...toCheckCardBase(card), updatedAt: card.updatedAt, summary: card.summary })),
      totalCount: inRange.length,
      chapterFrom: input.chapterFrom ?? null,
      chapterTo: input.chapterTo ?? null,
      guidance: '以实际值（actual_*）为主线总结趋势：与计划的偏离方向、连续区间（连续高强度/低强度/同类钩子）；给作者的建议要具体到章，不要泛泛而谈。',
    }
  },
  summarizeInput(input) {
    const from = input.chapterFrom ?? '…'
    const to = input.chapterTo ?? '…'
    return `查询节奏曲线（章号 ${from}~${to}）`
  },
  summarizeOutput(output) {
    return `节奏曲线：${output.totalCount} 章对照数据`
  },
}
