import type { ElementType } from '@novai/core'
import type { AppIconName } from '../components/ui/app-icons'

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
  /** UI 展示的受控语义图标（交互优化计划 §9：人物轮廓/地图标记/菱形/日历/分支/地球） */
  icon: AppIconName
}

export const ELEMENT_CATEGORIES: ElementCategory[] = [
  { key: 'character', label: '人物', directory: 'elements/characters', icon: 'user' },
  { key: 'location', label: '地点', directory: 'elements/locations', icon: 'map-pin' },
  { key: 'entity', label: '其他实体', directory: 'elements/entities', icon: 'diamond' },
  { key: 'plot', label: '情节', directory: 'elements/plots', icon: 'git-branch' },
  { key: 'worldbuilding', label: '设定', directory: 'elements/worldbuilding', icon: 'globe' },
]
