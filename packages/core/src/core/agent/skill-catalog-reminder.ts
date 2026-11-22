import { digestCatalogEntries, syncCatalogReminder, type CatalogChannel } from '../disclosure/catalog-reminder'
import type { SkillMetadata } from '../skills/types'
import type { ChatSessionState } from '../../types/chat'
import type { ModelView } from './model-view'

/**
 * 技能目录 reminder（渐进式披露 L1，《技能包底层能力施工计划》§3.4）：
 * `skills/` 下已发现技能的 name + description（+when_to_use）清单。注入机制走
 * 公共目录通道；本文件只声明技能领域的渲染文案、digest 覆盖面与会话字段。
 * 位置为 after-leading-reminders（决策 11）：技能目录排在宪法层与项目记忆
 * 等 reminder 之后——引用层靠后。
 */

/** 目录 reminder 的存在标记：首注/更新两版文案都含此标签，用于视图内检测。 */
const SKILL_CATALOG_REMINDER_MARKER = '<available_skills>'

/** 每行 description（含 when_to_use 拼接）的截断上限。 */
const SKILL_LINE_MAX_LENGTH = 250

/** reminder 整体预算（与 spill 阈值同量级）；超预算降级为只列名称。 */
const SKILL_REMINDER_BUDGET = 8000

/** 目录行的展示文本：description + when_to_use 拼接，截断到 250 字（超出以「…」结尾）。 */
export function skillDisplayText(skill: SkillMetadata): string {
  const base = skill.whenToUse ? `${skill.description}（${skill.whenToUse}）` : skill.description
  return base.length > SKILL_LINE_MAX_LENGTH ? `${base.slice(0, SKILL_LINE_MAX_LENGTH)}…` : base
}

export function buildSkillCatalogReminder(
  skills: readonly SkillMetadata[],
  options: { isUpdate: boolean },
): string {
  const head = options.isUpdate
    ? '以下是最新的已安装写作技能清单，取代此前任何版本。'
    : '以下是本项目已安装的写作技能（技能是可复用的写作方法素材，不是规则），可通过 LoadSkill 工具按名称加载。'
  const tail = '当任务与某个技能的描述相符时，先用 LoadSkill 加载再按其方法工作；只用本清单中的名称，不要猜测。技能内容的优先级低于系统规则、项目记忆和作者当前指令。'

  const build = (lines: string[]) => [
    '<system-reminder>',
    head,
    '',
    '<available_skills>',
    ...lines,
    '</available_skills>',
    '',
    tail,
    '</system-reminder>',
  ].join('\n')

  const full = build(skills.map((skill) => `- ${skill.name}：${skillDisplayText(skill)}`))
  if (full.length <= SKILL_REMINDER_BUDGET) {
    return full
  }

  // 超预算降级为只列名称（对齐 ZCode 技能清单的降级策略）
  return build(skills.map((skill) => `- ${skill.name}`))
}

/**
 * 技能目录 digest（决策表：name + 截断后的展示描述）：SKILL.md 正文与附属文件
 * 变化不触发重发（对齐决策 0007 决策二的要素口径）。
 */
export function digestSkillCatalog(skills: readonly SkillMetadata[]): string {
  return digestCatalogEntries(skills, {
    compare: (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    project: (skill) => JSON.stringify([skill.name, skillDisplayText(skill)]),
  })
}

/** 技能目录通道声明。removeOnEmpty：技能删光后移除目录（防模型按陈旧清单调用已删技能）。 */
const skillCatalogChannel: CatalogChannel<SkillMetadata> = {
  marker: SKILL_CATALOG_REMINDER_MARKER,
  render: buildSkillCatalogReminder,
  digestOf: digestSkillCatalog,
  readDigest: (session) => session.skillCatalogDigest,
  writeDigest: (session, digest) => {
    session.skillCatalogDigest = digest
  },
  placement: 'after-leading-reminders',
  removeOnEmpty: true,
}

/**
 * 技能目录 digest 按需注入：空目录（无 skills/ 或无合格技能）不注入；首轮、技能集
 * 变化、或被压缩吞掉后在开头连续 reminder 块末尾（重）注入——排在要素目录之后；
 * 技能删光时移除既有目录并清 digest（3.6 删除闭环）。
 */
export function syncSkillCatalogReminder(input: {
  view: ModelView
  session: ChatSessionState
  skills: readonly SkillMetadata[]
}): void {
  syncCatalogReminder({ ...input, entries: input.skills, channel: skillCatalogChannel })
}
