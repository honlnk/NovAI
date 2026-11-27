// @vitest-environment happy-dom
/**
 * 档位菜单限高（权限档位 / 思考强度选择器共用）：菜单向上弹出，限高按定位祖先上沿到可视区顶的余量算——
 * 矮视口 / 软键盘弹出时不出视口顶边，超出部分内滚。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import { REASONING_EFFORT_OPTIONS } from '../../constants/reasoning-efforts'
import PermissionPresetPicker from './PermissionPresetPicker.vue'
import ReasoningEffortPicker from './ReasoningEffortPicker.vue'
import { PICKER_MENU_MAX_HEIGHT, pickerMenuMaxHeight } from './picker-menu-height'

const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')

/** 菜单的定位祖先（桌面是按钮外壳，窄屏是输入区外壳）上沿落在 top 处 */
function mockMenuAnchorTop(top: number) {
  const anchor = { getBoundingClientRect: () => ({ top }) as DOMRect }
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => anchor })
}

function restorePrototypes() {
  if (originalOffsetParent) {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', originalOffsetParent)
  } else {
    delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent
  }
  vi.restoreAllMocks()
}

function setVisualViewportTop(offsetTop: number) {
  Object.defineProperty(window, 'visualViewport', { value: { offsetTop }, configurable: true })
}

function menuAnchoredAtTop(top: number) {
  return { offsetParent: { getBoundingClientRect: () => ({ top }) as DOMRect } } as unknown as HTMLElement
}

describe('pickerMenuMaxHeight 菜单限高', () => {
  afterEach(() => {
    delete (window as { visualViewport?: unknown }).visualViewport
  })

  it('上方余量充足：限高 360px', () => {
    expect(pickerMenuMaxHeight(menuAnchoredAtTop(720))).toBe(360)
  })

  it('上方余量不足：限高收到定位祖先上沿（留间距），不出视口顶边', () => {
    expect(pickerMenuMaxHeight(menuAnchoredAtTop(214.7))).toBe(202)
  })

  it('可视区顶不在布局区顶（软键盘只压缩可视区）时，按可视区顶算', () => {
    setVisualViewportTop(300)
    expect(pickerMenuMaxHeight(menuAnchoredAtTop(500))).toBe(188)
  })

  it('极矮时保底 120px，仍可滚动', () => {
    expect(pickerMenuMaxHeight(menuAnchoredAtTop(20))).toBe(120)
  })

  it('菜单尚未渲染（无定位祖先）时用默认上限', () => {
    expect(pickerMenuMaxHeight(null)).toBe(PICKER_MENU_MAX_HEIGHT)
    expect(pickerMenuMaxHeight({ offsetParent: null } as unknown as HTMLElement)).toBe(PICKER_MENU_MAX_HEIGHT)
  })
})

describe('选择器接线：打开菜单时按定位祖先位置写限高', () => {
  afterEach(restorePrototypes)

  it('权限档位：矮视口下限高收到定位祖先上沿，菜单内滚', async () => {
    mockMenuAnchorTop(214)
    const wrapper = mount(PermissionPresetPicker, { props: { preset: 'full' } })

    await wrapper.find('button').trigger('click')
    await flushPromises()

    const menu = wrapper.find('[role="menu"]')
    expect(menu.exists()).toBe(true)
    expect(menu.attributes('style')).toContain('max-height: 202px')
    expect(menu.classes()).toContain('overflow-y-auto')
  })

  it('思考强度：余量充足时限高 360px', async () => {
    mockMenuAnchorTop(720)
    const wrapper = mount(ReasoningEffortPicker, {
      props: { effort: 'high', options: REASONING_EFFORT_OPTIONS, label: '高' },
    })

    await wrapper.find('button').trigger('click')
    await flushPromises()

    const menu = wrapper.find('[role="menu"]')
    expect(menu.exists()).toBe(true)
    expect(menu.attributes('style')).toContain(`max-height: ${PICKER_MENU_MAX_HEIGHT}px`)
    expect(menu.classes()).toContain('overflow-y-auto')
  })
})
