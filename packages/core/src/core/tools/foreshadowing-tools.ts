import {
  createForeshadowingCard,
  deleteForeshadowingCard,
  effectivePlannedWindow,
  plannedPositionTarget,
  readForeshadowingCard,
  scanForeshadowingCards,
  updateForeshadowingCard,
} from '../foreshadowing'
import { serializeForeshadowingCard, splitForeshadowingBody } from '../foreshadowing/parser'
import { countDiffLines } from './file-tools/diff-line-stats'
import { asRecord, readString } from './file-tools/common'
import { parseChapterNumber } from './chapter-name'
import { isForeshadowingStatus } from '../../types/foreshadowing'
import { FORESHADOWING_STATUS_LABELS } from '../../types/foreshadowing'
import type { ForeshadowingCardView, ForeshadowingStatus } from '../../types/foreshadowing'
import type { TreeNode } from '../../types/project'
import type {
  CreateForeshadowingInput,
  CreateForeshadowingOutput,
  DeleteForeshadowingInput,
  DeleteForeshadowingOutput,
  ForeshadowingCheckCard,
  ForeshadowingCheckInput,
  ForeshadowingCheckOutput,
  ForeshadowingSyncCard,
  ForeshadowingSyncInput,
  ForeshadowingSyncOutput,
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

// ---------- 高层工具：写前检查 / 写后同步（创作心智模块计划 §六） ----------
//
// 两个工具都是只读的上下文组装器：
// - Check（写前）：该收哪些 + 本章已提及，只含读者视角——写作链路的防剧透边界不变。
// - Sync（写后）：提案所需的完整上下文（含真相 + contentHash + 当量标准），提案由模型
//   整理后交作者审阅；落盘仍走带确认的 Create/UpdateForeshadowing——一条确认链路，
//   不为批量提案另做审批 UI。
// 章号匹配统一走「第N章」数值比较：全本连续编号是主流；卷内独立编号可能漏报/误报
// （与 UI「该收了」高亮同一简化口径）。

const PAYOFF_EQUITY_STANDARD = [
  '回收当量三问（至少占一样才算够分量的回收）：',
  '- 改变：局面变了，有人的立场变了，有条路打开了；',
  '- 代价：真相出来的同时有人失去了什么；',
  '- 重新解释：让读者此前读过的一批内容忽然有了另一层意思。',
  '最弱的还账形式是解释——一样不占的回收，提案时要标注「这次回收只是解释，当量偏弱」。',
].join('\n')

/** 未收口径：还没揭晓/解决/放弃（planted / hinted / developed）。 */
function isForeshadowingUnresolved(status: ForeshadowingStatus): boolean {
  return status === 'planted' || status === 'hinted' || status === 'developed'
}

/**
 * 窗口是否已到达某章（作者字段控制权计划阶段 2 的统一位置语义）：
 * 按结构化计划位置（无结构化数据时按旧窗口反向推导）解析出起点目标章号，
 * 进入起点且未收即提示；存在终点时超过终点仍继续提示逾期，
 * 不因有终点就停止关注。
 */
function payoffWindowReached(
  card: Pick<ForeshadowingCardView, 'payoffWindow' | 'payoffStart' | 'payoffEnd'>,
  chapter: number,
): boolean {
  const { start } = effectivePlannedWindow(card)
  const startTarget = plannedPositionTarget(start)
  return startTarget !== null && chapter >= startTarget
}

function toCheckCard(card: ForeshadowingCardView): ForeshadowingCheckCard {
  return {
    id: card.id,
    name: card.name,
    status: card.status,
    plantedAt: card.plantedAt,
    payoffWindow: copyPayoffWindow(card.payoffWindow),
    summary: card.summary,
  }
}

/** 窗口元组拷贝：直接展开会把 [string, string] 放宽成 string[]。 */
function copyPayoffWindow(window: readonly [string, string] | null): [string, string] | null {
  return window ? [window[0], window[1]] : null
}

function readChapterInput(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} 必须是正整数章号（如 12 表示第 12 章）`)
  }
  return value
}

/** chapters/ 树里按章号找章节文件路径；找不到返回 null（重章号取第一个命中）。 */
function findChapterPath(tree: readonly TreeNode[], chapter: number): string | null {
  const stack = [...tree]
  while (stack.length > 0) {
    const node = stack.shift()
    if (!node) {
      continue
    }
    if (node.kind === 'file' && node.path.startsWith('chapters/') && parseChapterNumber(node.path) === chapter) {
      return node.path
    }
    if (node.children?.length) {
      stack.unshift(...node.children)
    }
  }
  return null
}

export const foreshadowingCheckTool: ToolDefinition<'ForeshadowingCheck', ForeshadowingCheckInput, ForeshadowingCheckOutput> = {
  name: 'ForeshadowingCheck',
  description: '写前检查（写第 N 章前主动调用）：返回该收的伏笔（已进入回收窗口且未收；超过终点的继续提示为逾期）+ 本章已埋/已提及的伏笔（读者视角摘要）。结果只含读者视角，防剧透边界不变；设计具体回收方案需要真相时再用 ReadForeshadowingForPlanning 单条读取。',
  validateInput(input) {
    const value = asRecord(input)
    return { chapter: readChapterInput(value.chapter, 'ForeshadowingCheck.chapter') }
  },
  async run(input, runtime) {
    const scan = await scanForeshadowingCards(runtime.project)
    const chapter = input.chapter

    const dueForPayoff = scan.cards
      .filter((card) => isForeshadowingUnresolved(card.status) && payoffWindowReached(card, chapter))
      .map(toCheckCard)

    const relatedToChapter = scan.cards
      .filter((card) => {
        if (parseChapterNumber(card.plantedAt) === chapter) {
          return true
        }
        return card.relatedChapters.some((ref) => parseChapterNumber(ref) === chapter)
      })
      .map((card) => ({
        ...toCheckCard(card),
        matchedBy: parseChapterNumber(card.plantedAt) === chapter ? ('planted' as const) : ('mentioned' as const),
        relatedChapters: [...card.relatedChapters],
      }))

    return {
      chapter,
      dueForPayoff,
      relatedToChapter,
      guidance: [
        '写作提示：本章可考虑回收列出的「预计回收」伏笔（读者目前只知道各卡 summary 的事实）；',
        '「本章已关联」是读者已知内容，写作时保持一致，不要矛盾重提。',
        '需要设计回收细节（涉及真相）时改用 ReadForeshadowingForPlanning 按稳定标识读取。',
      ].join('\n'),
    }
  },
  summarizeInput(input) {
    return `写前检查第 ${input.chapter} 章伏笔`
  },
  summarizeOutput(output) {
    const parts = [`${output.dueForPayoff.length} 条预计回收`, `${output.relatedToChapter.length} 条本章已关联`]
    return `第 ${output.chapter} 章：${parts.join('、')}`
  },
}

export const foreshadowingSyncTool: ToolDefinition<'ForeshadowingSync', ForeshadowingSyncInput, ForeshadowingSyncOutput> = {
  name: 'ForeshadowingSync',
  description: '写后同步（写完第 N 章后主动调用）：通读本章后组装伏笔提案上下文——本章关联伏笔（含作者真相与 contentHash）+ 该收未收提醒 + 回收当量标准。本工具只读不落盘：把整理好的提案（新增伏笔 / 追加暗示历史 / 状态推进 / resolvedAt）先列给作者，作者批准后逐条用 CreateForeshadowing / UpdateForeshadowing 执行（写确认会再拦一道）。',
  validateInput(input) {
    const value = asRecord(input)
    return { chapter: readChapterInput(value.chapter, 'ForeshadowingSync.chapter') }
  },
  async run(input, runtime) {
    const chapter = input.chapter
    const scan = await scanForeshadowingCards(runtime.project)

    const relatedCards = scan.cards.filter((card) =>
      parseChapterNumber(card.plantedAt) === chapter
      || card.relatedChapters.some((ref) => parseChapterNumber(ref) === chapter))

    // 逐条读取拿磁盘 contentHash：随后 UpdateForeshadowing 直接回传，省一次先读
    const related: ForeshadowingSyncCard[] = []
    for (const card of relatedCards) {
      const result = await readForeshadowingCard(runtime.project, card.id)
      if (!result) {
        continue
      }
      const { readerBody, truthBody } = splitForeshadowingBody(result.card.body)
      related.push({
        id: result.card.id,
        name: result.card.name,
        status: result.card.status,
        plantedAt: result.card.plantedAt,
        relatedChapters: [...result.card.relatedChapters],
        payoffWindow: copyPayoffWindow(result.card.payoffWindow),
        isRedHerring: result.card.isRedHerring,
        resolvedAt: result.card.resolvedAt,
        readerBody,
        authorTruth: truthBody,
        contentHash: result.contentHash,
      })
    }

    const dueUnresolved = scan.cards
      .filter((card) => isForeshadowingUnresolved(card.status) && payoffWindowReached(card, chapter))
      .map((card) => ({
        id: card.id,
        name: card.name,
        status: card.status,
        payoffWindow: copyPayoffWindow(card.payoffWindow),
      }))

    return {
      chapter,
      chapterPath: findChapterPath(runtime.project.tree ?? [], chapter),
      related,
      dueUnresolved,
      payoffEquityStandard: PAYOFF_EQUITY_STANDARD,
      guidance: [
        '对照本章正文整理提案：本章新埋的线索（CreateForeshadowing）、再提及的既有伏笔（addRelatedChapters）、',
        '本章回收的（status→revealed/resolved + resolvedAt，并回答当量三问）、「该收未收」里本章没碰到的（向作者说明，不自动推进）。',
        '提案先列给作者审阅，批准后逐条执行；related 里已带 contentHash，更新正文可直接作为 expectedContentHash 回传。',
      ].join('\n'),
    }
  },
  summarizeInput(input) {
    return `写后同步第 ${input.chapter} 章伏笔`
  },
  summarizeOutput(output) {
    const parts = [`${output.related.length} 条本章关联`, `${output.dueUnresolved.length} 条该收未收`]
    return `第 ${output.chapter} 章伏笔提案上下文：${parts.join('、')}`
  },
}
