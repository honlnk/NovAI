// @vitest-environment happy-dom
/**
 * 保存状态灯与五态集中映射（六个模块布局统一计划 阶段 1）：
 * 五种阶段的文案、颜色 class、圆点与测试标识的唯一实现——六个模块的头部
 * 状态都由本组件渲染，领域不得另行拼接文案。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import SaveStatusLight from './SaveStatusLight.vue'
import {
  DETAIL_SAVE_PHASE_LABELS,
  DETAIL_SAVE_PHASE_TEXT_CLASSES,
  type DetailSavePhase,
} from './detail-save-phase'

function mountLight(phase: DetailSavePhase, testid?: string) {
  return mount(SaveStatusLight, { props: { phase, ...(testid ? { testid } : {}) } })
}

describe('detail-save-phase 集中映射', () => {
  it('五态文案唯一且齐全（已保存/等待保存/正在保存/保存失败/保存冲突）', () => {
    expect(DETAIL_SAVE_PHASE_LABELS).toEqual({
      clean: '已保存',
      pending: '等待保存',
      saving: '正在保存',
      failed: '保存失败',
      conflict: '保存冲突',
    })
  })

  it('五态颜色互不相同且覆盖齐全', () => {
    const classes = Object.values(DETAIL_SAVE_PHASE_TEXT_CLASSES)
    expect(new Set(classes).size).toBe(5)
    // 规格锚点：已保存浅灰 / 等待琥珀 / 正在保存蓝 / 失败红 / 冲突琥珀（深）
    expect(DETAIL_SAVE_PHASE_TEXT_CLASSES.clean).toContain('text-gray')
    expect(DETAIL_SAVE_PHASE_TEXT_CLASSES.pending).toContain('text-amber')
    expect(DETAIL_SAVE_PHASE_TEXT_CLASSES.saving).toContain('text-blue')
    expect(DETAIL_SAVE_PHASE_TEXT_CLASSES.failed).toContain('text-red')
    expect(DETAIL_SAVE_PHASE_TEXT_CLASSES.conflict).toContain('text-amber')
  })
})

describe('SaveStatusLight', () => {
  it.each([
    ['clean', '已保存'],
    ['pending', '等待保存'],
    ['saving', '正在保存'],
    ['failed', '保存失败'],
    ['conflict', '保存冲突'],
  ] as [DetailSavePhase, string][])('阶段 %s 渲染文案「%s」', (phase, label) => {
    expect(mountLight(phase).text()).toBe(label)
  })

  it('只有等待保存带圆点；状态灯不含任何按钮（不混入业务操作）', () => {
    for (const phase of ['clean', 'saving', 'failed', 'conflict'] as DetailSavePhase[]) {
      expect(mountLight(phase).find('.animate-pulse').exists()).toBe(false)
      expect(mountLight(phase).find('button').exists()).toBe(false)
    }
    const pending = mountLight('pending')
    expect(pending.find('.animate-pulse').exists()).toBe(true)
    expect(pending.find('button').exists()).toBe(false)
  })

  it('testid 与可读名称（aria-label）随阶段渲染', () => {
    const wrapper = mountLight('saving', 'plan-detail-save-status')
    expect(wrapper.attributes('data-testid')).toBe('plan-detail-save-status')
    expect(wrapper.attributes('aria-label')).toBe('保存状态：正在保存')
  })
})
