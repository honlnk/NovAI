import { describe, expect, it } from 'vitest'

import type { ElementType } from '../../types/rag'

import { ELEMENT_BODY_TEMPLATES, getElementBodyTemplate } from './templates'

const TEMPLATED_TYPES = ['character', 'location', 'entity', 'plot', 'timeline'] as const satisfies readonly ElementType[]

describe('ELEMENT_BODY_TEMPLATES', () => {
  it('provides templates for the five templated element types', () => {
    for (const type of TEMPLATED_TYPES) {
      expect(ELEMENT_BODY_TEMPLATES[type], type).toBeTruthy()
      expect(getElementBodyTemplate(type), type).toBe(ELEMENT_BODY_TEMPLATES[type])
    }
  })

  it('does not provide a template for worldbuilding', () => {
    expect(ELEMENT_BODY_TEMPLATES.worldbuilding).toBeUndefined()
    expect(getElementBodyTemplate('worldbuilding')).toBeUndefined()
  })

  it.each(TEMPLATED_TYPES)('%s template contains the 基本信息 section', (type) => {
    expect(getElementBodyTemplate(type)).toContain('## 基本信息')
  })

  it.each(['character', 'location', 'entity'] as const)('%s template ends with a 状态变化 section', (type) => {
    expect(getElementBodyTemplate(type)).toContain('## 状态变化')
  })

  it('plot template contains 核心事件 and 暗线铺垫 sections', () => {
    const template = getElementBodyTemplate('plot')

    expect(template).toContain('## 核心事件')
    expect(template).toContain('## 暗线铺垫')
  })

  it('timeline template carries the 所属阶段 field and 后续影响 section', () => {
    const template = getElementBodyTemplate('timeline')

    expect(template).toContain('所属阶段')
    expect(template).toContain('## 后续影响')
  })

  it('templates carry no level-1 heading (name lives in frontmatter and file name)', () => {
    for (const type of TEMPLATED_TYPES) {
      expect(getElementBodyTemplate(type), type).not.toMatch(/^# /m)
    }
  })

  it('entity template keeps the eight-section draft from the element plan', () => {
    const template = getElementBodyTemplate('entity')

    for (const section of ['## 基本信息', '## 简介', '## 外观或表现', '## 来历', '## 当前归属', '## 能力或用途', '## 剧情关联', '## 状态变化']) {
      expect(template).toContain(section)
    }
  })
})
