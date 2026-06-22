import type { ElementType } from '@novai/core'

/**
 * 要素分组的 UI 常量定义。
 *
 * core 层只有 `ElementType` 类型和散落的目录映射（writer.ts 内私有常量），
 * 没有集中维护「type ↔ 目录 ↔ 中文标题 ↔ 图标」的常量。
 * 分类面板需要固定的中文标题展示，因此在 app 层统一维护这份映射，
 * 不依赖磁盘目录名做中文翻译。
 *
 * 顺序固定，对应 UI 中 6 个可折叠分组的展示顺序。
 */
export interface ElementCategory {
  /** core 的 ElementType，作为稳定 key */
  key: ElementType
  /** UI 展示的中文标题（写死） */
  label: string
  /** 对应的磁盘目录前缀，用于从 currentProject.files 过滤 */
  directory: string
  /** UI 展示的图标（emoji，后续可替换为 svg） */
  icon: string
}

export const ELEMENT_CATEGORIES: ElementCategory[] = [
  { key: 'character', label: '人物', directory: 'elements/characters', icon: '👤' },
  { key: 'location', label: '地点', directory: 'elements/locations', icon: '📍' },
  { key: 'entity', label: '其他实体', directory: 'elements/entities', icon: '🔶' },
  { key: 'timeline', label: '时间线', directory: 'elements/timeline', icon: '📅' },
  { key: 'plot', label: '情节', directory: 'elements/plots', icon: '📌' },
  { key: 'worldbuilding', label: '设定', directory: 'elements/worldbuilding', icon: '🌐' },
]
