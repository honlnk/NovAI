import { describe, expect, it } from 'vitest'

import { ELEMENT_CATEGORIES } from './elements'
import { APP_ICONS } from '../components/ui/app-icons'

/**
 * 六分类契约（交互优化计划 §9）：顺序、数量、目录归属固定，图标为受控语义注册表成员。
 */
describe('ELEMENT_CATEGORIES 六分类契约', () => {
  it('六个分组顺序固定：人物/地点/其他实体/时间线/情节/设定', () => {
    expect(ELEMENT_CATEGORIES.map((category) => category.label)).toEqual([
      '人物',
      '地点',
      '其他实体',
      '时间线',
      '情节',
      '设定',
    ])
    expect(ELEMENT_CATEGORIES.map((category) => category.key)).toEqual([
      'character',
      'location',
      'entity',
      'timeline',
      'plot',
      'worldbuilding',
    ])
  })

  it('目录前缀与 key 对应，过滤要素文件不受图标迁移影响', () => {
    expect(ELEMENT_CATEGORIES.map((category) => category.directory)).toEqual([
      'elements/characters',
      'elements/locations',
      'elements/entities',
      'elements/timeline',
      'elements/plots',
      'elements/worldbuilding',
    ])
  })

  it('图标全部是受控注册表中的 Lucide 语义名（§9：人物轮廓/地图标记/菱形/日历/分支/地球）', () => {
    expect(ELEMENT_CATEGORIES.map((category) => category.icon)).toEqual([
      'user',
      'map-pin',
      'diamond',
      'calendar',
      'git-branch',
      'globe',
    ])
    for (const category of ELEMENT_CATEGORIES) {
      expect(APP_ICONS[category.icon]).toBeDefined()
    }
  })
})
