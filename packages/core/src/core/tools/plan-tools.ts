import {
  scanPlanCards,
  readPlanCard,
  createPlanCard,
  updatePlanCard,
  deletePlanCard,
} from '../plans'
import { serializePlanCard } from '../plans/parser'
import { countDiffLines } from './file-tools/diff-line-stats'
import type {
  CreatePlanInput,
  CreatePlanOutput,
  DeletePlanInput,
  DeletePlanOutput,
  ListPlansInput,
  ListPlansOutput,
  ReadPlanInput,
  ReadPlanOutput,
  ToolDefinition,
  UpdatePlanInput,
  UpdatePlanOutput,
} from './types'
import { asRecord, readString } from './file-tools/common'
import { isPlanStatus } from '../../types/plans'
import type { PlanStatus } from '../../types/plans'

/**
 * 计划维护工具（只注册给主智能体；要素管理员白名单不含这些工具）。
 *
 * 边界（计划 §AI 工具）：
 * - 只以稳定标识定位卡片，不接受路径（不能把卡片写到 plans/ 之外）；
 * - ListPlans 返回摘要不返回全文；ReadPlan 读完整正文与元数据；
 * - 正文更新前必须 ReadPlan 拿到当前版本（expectedContentHash），保存时校验防覆盖；
 * - 删除只按用户明确要求触发（使用边界写在 prompt 工具规则里）。
 *
 * 变更账本：写工具实现 extractFileChange/extractChangeDiff，与通用文件工具
 * 同一机制进账本、触发看板刷新——普通文件工具与专用工具访问同一份文件。
 */

const STATUS_DESCRIPTION = '卡片状态：inbox=收集箱（默认）、planned=计划中、in-progress=进行中、done=已完成、on-hold=已搁置'

function readPlanStatus(value: unknown, label: string): PlanStatus | undefined {
  if (value === undefined) {
    return undefined
  }

  const status = readString(value, label)

  if (!isPlanStatus(status)) {
    throw new Error(`${label} 必须是 ${STATUS_DESCRIPTION}`)
  }

  return status
}

export const listPlansTool: ToolDefinition<'ListPlans', ListPlansInput, ListPlansOutput> = {
  name: 'ListPlans',
  description: '查询创作计划板的卡片摘要（标题、状态、顺序、更新时间与正文首行摘要），可按状态筛选；不返回全部正文。',
  validateInput(input) {
    const value = asRecord(input)
    const status = readPlanStatus(value.status, 'ListPlans.status')
    return { status }
  },
  async run(input, runtime) {
    const scan = await scanPlanCards(runtime.project)
    const plans = (input.status ? scan.cards.filter((card) => card.status === input.status) : scan.cards)
      .map((card) => ({
        id: card.id,
        title: card.title,
        status: card.status,
        order: card.order,
        updatedAt: card.updatedAt,
        summary: card.summary,
      }))

    return { plans, totalCount: plans.length }
  },
  summarizeInput(input) {
    return input.status ? `查询计划摘要（状态 ${input.status}）` : '查询计划摘要'
  },
  summarizeOutput(output) {
    return `共 ${output.totalCount} 张计划卡片`
  },
}

export const readPlanTool: ToolDefinition<'ReadPlan', ReadPlanInput, ReadPlanOutput> = {
  name: 'ReadPlan',
  description: '按稳定标识读取一张计划的完整正文与元数据（含 contentHash——更新正文时必须回传，防止覆盖外部修改）。未找到时返回 notFound，不抛错。',
  validateInput(input) {
    const value = asRecord(input)
    const id = readString(value.id, 'ReadPlan.id').trim()
    if (!id) {
      throw new Error('ReadPlan.id 不能为空')
    }
    return { id }
  },
  async run(input, runtime) {
    const result = await readPlanCard(runtime.project, input.id)

    if (!result) {
      return { id: input.id, notFound: true as const }
    }

    return {
      id: result.card.id,
      status: result.card.status,
      order: result.card.order,
      title: deriveTitle(result.card.body),
      body: result.card.body,
      sourcePath: result.card.sourcePath,
      contentHash: result.contentHash,
      updatedAt: result.card.updatedAt,
    }
  },
  summarizeInput(input) {
    return `读取计划 ${input.id}`
  },
  summarizeOutput(output) {
    return 'notFound' in output ? `计划 ${output.id} 不存在` : `已读取计划「${output.title || output.id}」`
  },
}

export const createPlanTool: ToolDefinition<'CreatePlan', CreatePlanInput, CreatePlanOutput> = {
  name: 'CreatePlan',
  description: '新建一张创作计划卡片（必须提供正文，第一行会成为标题）；默认进入收集箱并排在目标列末尾，返回新卡片标识。文件名由应用生成。',
  validateInput(input) {
    const value = asRecord(input)
    const body = readString(value.body, 'CreatePlan.body').trim()
    if (!body) {
      throw new Error('计划正文不能为空')
    }
    const status = readPlanStatus(value.status, 'CreatePlan.status')
    return { body, status }
  },
  async run(input, runtime) {
    const card = await createPlanCard(runtime.project, { body: input.body, status: input.status })
    const content = serializePlanCard(card)

    return {
      id: card.id,
      title: deriveTitle(card.body),
      status: card.status,
      order: card.order,
      sourcePath: card.sourcePath,
      content,
      contentLength: content.length,
      linesAdded: countDiffLines('', content).linesAdded,
      created: true as const,
    }
  },
  summarizeInput(input) {
    return input.status ? `新建计划（${input.status}）` : '新建计划'
  },
  summarizeOutput(output) {
    return `已新建计划「${output.title || output.id}」(${output.sourcePath})，状态 ${output.status}`
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
    // 文件名在执行时生成（需扫描序号），确认卡展示目录与正文
    return { kind: 'create', path: 'plans/（新卡片，执行时生成文件名）', content: input.body }
  },
}

export const updatePlanTool: ToolDefinition<'UpdatePlan', UpdatePlanInput, UpdatePlanOutput> = {
  name: 'UpdatePlan',
  description: '按稳定标识修改一张计划：正文、状态、目标列位置分别可选，一次只更新提供的字段。更新正文前必须先 ReadPlan 取得 contentHash 并回传，防止覆盖用户或外部编辑器的修改；只改状态或位置时不传正文。',
  validateInput(input) {
    const value = asRecord(input)
    const id = readString(value.id, 'UpdatePlan.id').trim()
    if (!id) {
      throw new Error('UpdatePlan.id 不能为空')
    }

    const body = value.body === undefined ? undefined : readString(value.body, 'UpdatePlan.body').trim()
    if (body !== undefined && !body) {
      throw new Error('计划正文不能为空')
    }

    const status = readPlanStatus(value.status, 'UpdatePlan.status')

    const afterId = value.afterId === undefined || value.afterId === null
      ? null
      : readString(value.afterId, 'UpdatePlan.afterId').trim() || null

    const expectedContentHash = value.expectedContentHash === undefined
      ? undefined
      : readString(value.expectedContentHash, 'UpdatePlan.expectedContentHash')

    // 正文替换强制走「先读后写」：没有版本依据的整段替换最容易覆盖别人的修改
    if (body !== undefined && !expectedContentHash) {
      throw new Error('更新正文前必须先用 ReadPlan 读取该计划，并把返回的 contentHash 作为 expectedContentHash 传入')
    }

    if (body === undefined && status === undefined && afterId === null && expectedContentHash === undefined) {
      throw new Error('至少提供 body、status、afterId 之一')
    }

    return { id, body, status, afterId, expectedContentHash }
  },
  async run(input, runtime) {
    const card = await updatePlanCard(runtime.project, input)
    const content = serializePlanCard(card)

    return {
      id: card.id,
      title: deriveTitle(card.body),
      status: card.status,
      order: card.order,
      sourcePath: card.sourcePath,
      content,
      contentLength: content.length,
    }
  },
  summarizeInput(input) {
    const parts: string[] = []
    if (input.body !== undefined) parts.push('正文')
    if (input.status !== undefined) parts.push(`状态→${input.status}`)
    if (input.afterId !== null) parts.push('位置')
    return `修改计划 ${input.id}（${parts.join('、')}）`
  },
  summarizeOutput(output) {
    return `已修改计划「${output.title || output.id}」，状态 ${output.status}`
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
    const path = `plans/（卡片 ${input.id}）`
    if (input.body !== undefined) {
      return { kind: 'edit', path, oldText: '（完整正文替换，差异以执行结果为准）', newText: input.body }
    }
    return {
      kind: 'edit',
      path,
      oldText: '（不改正文）',
      newText: input.status !== undefined ? `（状态改为 ${input.status}${input.afterId !== null ? '，并调整列内位置' : ''}）` : '（调整列内位置）',
    }
  },
}

export const deletePlanTool: ToolDefinition<'DeletePlan', DeletePlanInput, DeletePlanOutput> = {
  name: 'DeletePlan',
  description: '按稳定标识删除一张创作计划（移入项目回收站 .novel/trash/，不直接永久删除）。只在用户明确要求删除时使用。',
  validateInput(input) {
    const value = asRecord(input)
    const id = readString(value.id, 'DeletePlan.id').trim()
    if (!id) {
      throw new Error('DeletePlan.id 不能为空')
    }
    return { id }
  },
  async run(input, runtime) {
    const result = await deletePlanCard(runtime.project, input.id)

    return {
      id: result.card.id,
      sourcePath: result.card.sourcePath,
      trashPath: result.trashPath,
      contentLength: result.card.body.length,
      linesRemoved: countDiffLines(result.card.body, '').linesRemoved,
    }
  },
  summarizeInput(input) {
    return `删除计划 ${input.id}`
  },
  summarizeOutput(output) {
    return `已将计划 ${output.sourcePath} 移入回收站 ${output.trashPath}`
  },
  extractFileChange(output) {
    return { type: 'deleted', path: output.sourcePath, trashPath: output.trashPath, linesRemoved: output.linesRemoved }
  },
  buildConfirmation(input) {
    return { kind: 'delete', path: `plans/（卡片 ${input.id}）` }
  },
}

function deriveTitle(body: string): string {
  const firstLine = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  return firstLine ? firstLine.replace(/^#{1,6}\s*/, '') : ''
}
