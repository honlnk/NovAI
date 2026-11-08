import {
  createForeshadowingCard,
  deleteForeshadowingCard,
  readForeshadowingCard,
  scanForeshadowingCards,
  updateForeshadowingCard,
} from '../foreshadowing'
import { serializeForeshadowingCard, splitForeshadowingBody } from '../foreshadowing/parser'
import { countDiffLines } from './file-tools/diff-line-stats'
import { asRecord, readString } from './file-tools/common'
import { isForeshadowingStatus } from '../../types/foreshadowing'
import { FORESHADOWING_STATUS_LABELS } from '../../types/foreshadowing'
import type { ForeshadowingStatus } from '../../types/foreshadowing'
import type {
  CreateForeshadowingInput,
  CreateForeshadowingOutput,
  DeleteForeshadowingInput,
  DeleteForeshadowingOutput,
  ListForeshadowingInput,
  ListForeshadowingOutput,
  ReadForeshadowingForPlanningOutput,
  ReadForeshadowingInput,
  ReadForeshadowingOutput,
  ToolDefinition,
  UpdateForeshadowingInput,
  UpdateForeshadowingOutput,
} from './types'

/**
 * 伏笔维护工具（主 Agent 专属；要素管理员白名单不含这些工具，目录级守卫另挡通用文件工具）。
 *
 * 边界（创作心智模块计划 §五）：
 * - 只以稳定标识定位，不接受路径；List 返回摘要（读者视角）不返回全文。
 * - 真相见性是数据流防线：ReadForeshadowing 永远不含「作者真相」节（写正文链路装配），
 *   ReadForeshadowingForPlanning 才含真相（规划阶段使用）——装配层面权限，模型无法越权。
 * - 正文（readerView/authorTruth）更新前必须先读取拿到 contentHash，保存时校验防覆盖；
 *   只改状态/字段时不传正文，真相节原样保留。
 * - 删除只按用户明确要求触发（使用边界写在 prompt 工具规则里）。
 *
 * 变更账本：写工具实现 extractFileChange/extractChangeDiff，与计划工具同一机制。
 */

const STATUS_DESCRIPTION = 'planted=埋入、hinted=暗示、developed=发展、revealed=揭晓、resolved=解决、abandoned=放弃'

function readForeshadowingStatus(value: unknown, label: string): ForeshadowingStatus | undefined {
  if (value === undefined) {
    return undefined
  }

  const status = readString(value, label)

  if (!isForeshadowingStatus(status)) {
    throw new Error(`${label} 必须是 ${STATUS_DESCRIPTION}`)
  }

  return status
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

function readBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'boolean') {
    throw new Error(`${label} 必须是布尔值`)
  }

  return value
}

/** 回收窗口：恰好两个元素的字符串数组（区间两端，起 < 止由作者自己保证语义）。 */
function readPayoffWindow(value: unknown, label: string): [string, string] | null | undefined {
  if (value === undefined) {
    return undefined
  }

  if (value === null) {
    return null
  }

  const items = readStringArray(value, label)

  if (!items || items.length !== 2) {
    throw new Error(`${label} 必须是恰好两个章节路径的数组 [起, 止]（区间而非单点）`)
  }

  return [items[0]!, items[1]!]
}

export const listForeshadowingTool: ToolDefinition<'ListForeshadowing', ListForeshadowingInput, ListForeshadowingOutput> = {
  name: 'ListForeshadowing',
  description: '查询伏笔账本摘要（伏笔名、状态、埋设章节、回收窗口、读者视角首行摘要），可按状态筛选；不返回正文全文，摘要不含作者真相。',
  validateInput(input) {
    const value = asRecord(input)
    const status = readForeshadowingStatus(value.status, 'ListForeshadowing.status')
    return { status }
  },
  async run(input, runtime) {
    const scan = await scanForeshadowingCards(runtime.project)
    const cards = input.status ? scan.cards.filter((card) => card.status === input.status) : scan.cards

    return {
      foreshadowing: cards.map((card) => ({
        id: card.id,
        name: card.name,
        status: card.status,
        plantedAt: card.plantedAt,
        payoffWindow: card.payoffWindow ? [...card.payoffWindow] : null,
        isRedHerring: card.isRedHerring,
        updatedAt: card.updatedAt,
        summary: card.summary,
      })),
      totalCount: cards.length,
    }
  },
  summarizeInput(input) {
    return input.status ? `查询伏笔摘要（状态 ${input.status}）` : '查询伏笔摘要'
  },
  summarizeOutput(output) {
    return `共 ${output.totalCount} 条伏笔`
  },
}

export const readForeshadowingTool: ToolDefinition<'ReadForeshadowing', ReadForeshadowingInput, ReadForeshadowingOutput> = {
  name: 'ReadForeshadowing',
  description: '按稳定标识读取一条伏笔（读者视角正文 + 全部元数据 + contentHash）。永远不含「作者真相」——写正文时只依赖读者视角，防止剧透提前泄漏进正文；规划伏笔走向请用 ReadForeshadowingForPlanning。',
  validateInput(input) {
    const value = asRecord(input)
    const id = readString(value.id, 'ReadForeshadowing.id').trim()
    if (!id) {
      throw new Error('ReadForeshadowing.id 不能为空')
    }
    return { id }
  },
  async run(input, runtime) {
    const result = await readForeshadowingCard(runtime.project, input.id)

    if (!result) {
      return { id: input.id, notFound: true as const }
    }

    const { readerBody } = splitForeshadowingBody(result.card.body)

    return {
      id: result.card.id,
      name: result.card.name,
      status: result.card.status,
      plantedAt: result.card.plantedAt,
      payoffWindow: result.card.payoffWindow ? [...result.card.payoffWindow] : null,
      relatedCharacters: [...result.card.relatedCharacters],
      relatedEntities: [...result.card.relatedEntities],
      relatedChapters: [...result.card.relatedChapters],
      isRedHerring: result.card.isRedHerring,
      resolvedAt: result.card.resolvedAt,
      abandonedReason: result.card.abandonedReason,
      body: readerBody,
      sourcePath: result.card.sourcePath,
      contentHash: result.contentHash,
      updatedAt: result.card.updatedAt,
      truthHidden: true as const,
    }
  },
  summarizeInput(input) {
    return `读取伏笔 ${input.id}`
  },
  summarizeOutput(output) {
    return 'notFound' in output ? `伏笔 ${output.id} 不存在` : `已读取伏笔「${output.name || output.id}」（仅读者视角）`
  },
}

export const readForeshadowingForPlanningTool: ToolDefinition<'ReadForeshadowingForPlanning', ReadForeshadowingInput, ReadForeshadowingForPlanningOutput> = {
  name: 'ReadForeshadowingForPlanning',
  description: '按稳定标识读取一条伏笔的完整内容（含「作者真相」剧透）。仅在规划伏笔走向、设计回收方案、与作者讨论全书结构时使用；写正文章节前/中禁用——正文创作只能依赖 ReadForeshadowing 的读者视角。',
  validateInput(input) {
    const value = asRecord(input)
    const id = readString(value.id, 'ReadForeshadowingForPlanning.id').trim()
    if (!id) {
      throw new Error('ReadForeshadowingForPlanning.id 不能为空')
    }
    return { id }
  },
  async run(input, runtime) {
    const result = await readForeshadowingCard(runtime.project, input.id)

    if (!result) {
      return { id: input.id, notFound: true as const }
    }

    const { truthBody } = splitForeshadowingBody(result.card.body)

    return {
      id: result.card.id,
      name: result.card.name,
      status: result.card.status,
      plantedAt: result.card.plantedAt,
      payoffWindow: result.card.payoffWindow ? [...result.card.payoffWindow] : null,
      relatedCharacters: [...result.card.relatedCharacters],
      relatedEntities: [...result.card.relatedEntities],
      relatedChapters: [...result.card.relatedChapters],
      isRedHerring: result.card.isRedHerring,
      resolvedAt: result.card.resolvedAt,
      abandonedReason: result.card.abandonedReason,
      body: result.card.body,
      authorTruth: truthBody,
      sourcePath: result.card.sourcePath,
      contentHash: result.contentHash,
      updatedAt: result.card.updatedAt,
    }
  },
  summarizeInput(input) {
    return `读取伏笔完整内容（规划用，含真相）${input.id}`
  },
  summarizeOutput(output) {
    return 'notFound' in output ? `伏笔 ${output.id} 不存在` : `已读取伏笔「${output.name || output.id}」完整内容（含作者真相）`
  },
}

export const createForeshadowingTool: ToolDefinition<'CreateForeshadowing', CreateForeshadowingInput, CreateForeshadowingOutput> = {
  name: 'CreateForeshadowing',
  description: '登记一条新伏笔。必须提供：伏笔名、埋设章节、读者视角（读者当时能看到什么）；作者真相（剧透）强烈建议同登——读者视角与作者真相分开记是伏笔系统的核心。文件名由应用生成。',
  validateInput(input) {
    const value = asRecord(input)
    const name = readString(value.name, 'CreateForeshadowing.name').trim()
    if (!name) {
      throw new Error('伏笔名不能为空')
    }

    const readerView = readString(value.readerView, 'CreateForeshadowing.readerView').trim()
    if (!readerView) {
      throw new Error('读者视角不能为空：登记伏笔必须写下「读者当时能看到什么」')
    }

    const plantedAt = readString(value.plantedAt, 'CreateForeshadowing.plantedAt').trim()
    if (!plantedAt) {
      throw new Error('埋设章节不能为空：写明在哪一章埋下（如 第一卷/第012章）')
    }

    const authorTruth = value.authorTruth === undefined ? undefined : readString(value.authorTruth, 'CreateForeshadowing.authorTruth')
    const status = readForeshadowingStatus(value.status, 'CreateForeshadowing.status')
    if (value.payoffWindow === null) {
      throw new Error('CreateForeshadowing.payoffWindow 不能为 null：不设回收窗口时请省略该字段')
    }
    const payoffWindow = readPayoffWindow(value.payoffWindow, 'CreateForeshadowing.payoffWindow')
    const relatedCharacters = readStringArray(value.relatedCharacters, 'CreateForeshadowing.relatedCharacters')
    const relatedEntities = readStringArray(value.relatedEntities, 'CreateForeshadowing.relatedEntities')
    const isRedHerring = readBoolean(value.isRedHerring, 'CreateForeshadowing.isRedHerring')

    return {
      name,
      readerView,
      ...(authorTruth !== undefined ? { authorTruth } : {}),
      plantedAt,
      ...(status !== undefined ? { status } : {}),
      ...(payoffWindow ? { payoffWindow } : {}),
      ...(relatedCharacters !== undefined ? { relatedCharacters } : {}),
      ...(relatedEntities !== undefined ? { relatedEntities } : {}),
      ...(isRedHerring !== undefined ? { isRedHerring } : {}),
    }
  },
  async run(input, runtime) {
    const card = await createForeshadowingCard(runtime.project, input)
    const content = serializeForeshadowingCard(card)

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
    return `登记伏笔「${input.name}」`
  },
  summarizeOutput(output) {
    return `已登记伏笔「${output.name}」（${output.sourcePath}），状态 ${FORESHADOWING_STATUS_LABELS[output.status]}`
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
    // 文件名在执行时生成，确认卡展示目录与读者视角；真相在描述行提示
    return {
      kind: 'create',
      path: 'foreshadowing/（新伏笔，执行时生成文件名）',
      content: input.authorTruth !== undefined
        ? `${input.readerView}\n\n（另含作者真相节，${input.authorTruth.trim() ? '已填写' : '未填写'}）`
        : input.readerView,
    }
  },
}

export const updateForeshadowingTool: ToolDefinition<'UpdateForeshadowing', UpdateForeshadowingInput, UpdateForeshadowingOutput> = {
  name: 'UpdateForeshadowing',
  description: '按稳定标识更新一条伏笔：名称、读者视角、作者真相、状态、回收窗口、关联角色等分别可选。修改读者视角或作者真相前必须先读取并把 contentHash 作为 expectedContentHash 传入（防覆盖）；只改状态或元数据时不传正文。addRelatedChapters 追加暗示历史（去重）；状态改 abandoned 必须给 abandonedReason。',
  validateInput(input) {
    const value = asRecord(input)
    const id = readString(value.id, 'UpdateForeshadowing.id').trim()
    if (!id) {
      throw new Error('UpdateForeshadowing.id 不能为空')
    }

    const name = value.name === undefined ? undefined : readString(value.name, 'UpdateForeshadowing.name').trim()
    if (name !== undefined && !name) {
      throw new Error('伏笔名不能为空')
    }

    const readerView = value.readerView === undefined ? undefined : readString(value.readerView, 'UpdateForeshadowing.readerView').trim()
    if (readerView !== undefined && !readerView) {
      throw new Error('读者视角不能为空')
    }

    const authorTruth = value.authorTruth === undefined ? undefined : readString(value.authorTruth, 'UpdateForeshadowing.authorTruth')
    const status = readForeshadowingStatus(value.status, 'UpdateForeshadowing.status')
    const plantedAt = value.plantedAt === undefined ? undefined : readString(value.plantedAt, 'UpdateForeshadowing.plantedAt').trim()
    const payoffWindow = readPayoffWindow(value.payoffWindow, 'UpdateForeshadowing.payoffWindow')
    const relatedCharacters = readStringArray(value.relatedCharacters, 'UpdateForeshadowing.relatedCharacters')
    const relatedEntities = readStringArray(value.relatedEntities, 'UpdateForeshadowing.relatedEntities')
    const addRelatedChapters = readStringArray(value.addRelatedChapters, 'UpdateForeshadowing.addRelatedChapters')
    const isRedHerring = readBoolean(value.isRedHerring, 'UpdateForeshadowing.isRedHerring')

    const resolvedAt = value.resolvedAt === undefined
      ? undefined
      : (value.resolvedAt === null ? null : readString(value.resolvedAt, 'UpdateForeshadowing.resolvedAt').trim())
    const abandonedReason = value.abandonedReason === undefined
      ? undefined
      : (value.abandonedReason === null ? null : readString(value.abandonedReason, 'UpdateForeshadowing.abandonedReason'))

    const afterId = value.afterId === undefined || value.afterId === null
      ? null
      : readString(value.afterId, 'UpdateForeshadowing.afterId').trim() || null

    const expectedContentHash = value.expectedContentHash === undefined
      ? undefined
      : readString(value.expectedContentHash, 'UpdateForeshadowing.expectedContentHash')

    // 正文替换强制走「先读后写」：防止没有版本依据的整段替换覆盖外部修改
    if ((readerView !== undefined || authorTruth !== undefined) && !expectedContentHash) {
      throw new Error('更新读者视角或作者真相前，必须先用 ReadForeshadowing（或规划读取）拿到 contentHash 并作为 expectedContentHash 传入')
    }

    const hasUpdate = [name, readerView, authorTruth, status, plantedAt, payoffWindow, relatedCharacters,
      relatedEntities, addRelatedChapters, isRedHerring, resolvedAt, abandonedReason].some((field) => field !== undefined)
      || afterId !== null

    if (!hasUpdate) {
      throw new Error('至少提供 name、readerView、authorTruth、status、addRelatedChapters 等要更新的字段之一')
    }

    if (status === 'abandoned' && !abandonedReason) {
      throw new Error('状态改为 abandoned（放弃）时必须同时提供 abandonedReason（放弃原因），避免日后误以为漏写')
    }

    return {
      id,
      ...(name !== undefined ? { name } : {}),
      ...(readerView !== undefined ? { readerView } : {}),
      ...(authorTruth !== undefined ? { authorTruth } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(plantedAt !== undefined ? { plantedAt } : {}),
      ...(payoffWindow !== undefined ? { payoffWindow } : {}),
      ...(relatedCharacters !== undefined ? { relatedCharacters } : {}),
      ...(relatedEntities !== undefined ? { relatedEntities } : {}),
      ...(addRelatedChapters !== undefined ? { addRelatedChapters } : {}),
      ...(isRedHerring !== undefined ? { isRedHerring } : {}),
      ...(resolvedAt !== undefined ? { resolvedAt } : {}),
      ...(abandonedReason !== undefined ? { abandonedReason } : {}),
      afterId,
      ...(expectedContentHash !== undefined ? { expectedContentHash } : {}),
    }
  },
  async run(input, runtime) {
    const card = await updateForeshadowingCard(runtime.project, input)
    const content = serializeForeshadowingCard(card)

    return {
      id: card.id,
      name: card.name,
      status: card.status,
      sourcePath: card.sourcePath,
      content,
      contentLength: content.length,
    }
  },
  summarizeInput(input) {
    const parts: string[] = []
    if (input.name !== undefined) parts.push('名称')
    if (input.readerView !== undefined) parts.push('读者视角')
    if (input.authorTruth !== undefined) parts.push('作者真相')
    if (input.status !== undefined) parts.push(`状态→${input.status}`)
    if (input.addRelatedChapters !== undefined) parts.push('暗示历史')
    const extra = [input.plantedAt, input.payoffWindow, input.relatedCharacters, input.relatedEntities,
      input.isRedHerring, input.resolvedAt, input.abandonedReason].some((field) => field !== undefined)
    if (extra) parts.push('元数据')
    return `更新伏笔 ${input.id}（${parts.join('、') || '列内位置'}）`
  },
  summarizeOutput(output) {
    return `已更新伏笔「${output.name || output.id}」，状态 ${FORESHADOWING_STATUS_LABELS[output.status]}`
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
    const path = `foreshadowing/（伏笔 ${input.id}）`
    const bodyFields: string[] = []
    if (input.readerView !== undefined) bodyFields.push('读者视角')
    if (input.authorTruth !== undefined) bodyFields.push(input.authorTruth ? '作者真相' : '清除作者真相')

    if (bodyFields.length > 0) {
      const preview = [
        input.readerView !== undefined ? input.readerView : '（读者视角不变）',
        input.authorTruth !== undefined ? (input.authorTruth || '（清除作者真相）') : '（作者真相不变）',
      ].join('\n\n')
      return { kind: 'edit', path, oldText: '（正文节替换，差异以执行结果为准）', newText: preview }
    }

    const metaParts: string[] = []
    if (input.name !== undefined) metaParts.push(`名称改为「${input.name}」`)
    if (input.status !== undefined) metaParts.push(`状态改为 ${FORESHADOWING_STATUS_LABELS[input.status]}`)
    if (input.addRelatedChapters !== undefined) metaParts.push(`追加暗示历史：${input.addRelatedChapters.join('、')}`)
    if (input.resolvedAt !== undefined) metaParts.push(`回收章节：${input.resolvedAt ?? '（清除）'}`)
    if (input.abandonedReason !== undefined && input.abandonedReason) metaParts.push(`放弃原因：${input.abandonedReason}`)
    const extra = [input.plantedAt, input.payoffWindow, input.relatedCharacters, input.relatedEntities, input.isRedHerring]
      .some((field) => field !== undefined)
    if (extra) metaParts.push('（其余元数据字段）')

    return {
      kind: 'edit',
      path,
      oldText: '（不改正文）',
      newText: metaParts.length ? metaParts.join('；') : '（调整列内位置）',
    }
  },
}

export const deleteForeshadowingTool: ToolDefinition<'DeleteForeshadowing', DeleteForeshadowingInput, DeleteForeshadowingOutput> = {
  name: 'DeleteForeshadowing',
  description: '按稳定标识删除一条伏笔（移入项目回收站 .novel/trash/，不直接永久删除）。只在用户明确要求删除时使用；伏笔已收或已放弃本身不构成删除理由（账本要留痕）。',
  validateInput(input) {
    const value = asRecord(input)
    const id = readString(value.id, 'DeleteForeshadowing.id').trim()
    if (!id) {
      throw new Error('DeleteForeshadowing.id 不能为空')
    }
    return { id }
  },
  async run(input, runtime) {
    const result = await deleteForeshadowingCard(runtime.project, input.id)
    const content = serializeForeshadowingCard(result.card)

    return {
      id: result.card.id,
      sourcePath: result.card.sourcePath,
      trashPath: result.trashPath,
      contentLength: content.length,
      linesRemoved: countDiffLines(content, '').linesRemoved,
    }
  },
  summarizeInput(input) {
    return `删除伏笔 ${input.id}`
  },
  summarizeOutput(output) {
    return `已将伏笔 ${output.sourcePath} 移入回收站 ${output.trashPath}`
  },
  extractFileChange(output) {
    return { type: 'deleted', path: output.sourcePath, trashPath: output.trashPath, linesRemoved: output.linesRemoved }
  },
  buildConfirmation(input) {
    return { kind: 'delete', path: `foreshadowing/（伏笔 ${input.id}）` }
  },
}
