// @vitest-environment happy-dom
/**
 * 工作区弹窗骨架契约测试（关系图谱施工计划 §八）：
 * 尺寸与滚动责任、关闭收口（遮罩 + 按钮）、加载/空/错误三态、底部插槽、
 * 操作区插槽与关闭互不挤占。骨架不含领域分支——组件只认通用三态与插槽。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WorkspaceModal from './WorkspaceModal.vue'

function bodyText(): string {
  return document.body.textContent ?? ''
}

function queryBody(selector: string): HTMLElement | null {
  return document.body.querySelector(selector)
}

function mountModal(props: Record<string, unknown> = {}, slots: Record<string, string> = {}) {
  const wrapper = mount(WorkspaceModal, {
    attachTo: document.body,
    props: {
      isOpen: true,
      title: '关系图谱',
      ...props,
    },
    slots: {
      default: '<div data-testid="body-content">主体内容</div>',
      ...slots,
    },
  })
  return wrapper
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('WorkspaceModal 契约', () => {
  it('isOpen=false 不渲染任何内容（v-if 卸载语义，无残留状态）', () => {
    mountModal({ isOpen: false })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('渲染标题与副标题；副标题为空不占行；标题供 aria-labelledby 引用', () => {
    mountModal({ subtitle: '测试项目' })
    const dialog = queryBody('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(bodyText()).toContain('关系图谱')
    expect(bodyText()).toContain('测试项目')

    const title = queryBody('h2')
    expect(title?.id).toBeTruthy()
    expect(dialog?.getAttribute('aria-labelledby')).toBe(title?.id)
  })

  it('关闭按钮 emit close；点遮罩自身也 emit close（复用 BaseModal 关闭语义）', async () => {
    const wrapper = mountModal()
    const closeButton = queryBody('button[aria-label="关闭弹窗"]')
    expect(closeButton).not.toBeNull()
    closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)

    const backdrop = document.body.querySelector('.fixed.inset-0')
    expect(backdrop).not.toBeNull()
    backdrop?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('滚动责任在主体：头部 shrink-0、主体 overflow-y-auto、底部固定', () => {
    mountModal({}, { footer: '<span>状态行</span>' })
    const header = queryBody('header')
    const body = header?.parentElement?.querySelector('.overflow-y-auto')
    const footer = queryBody('footer')

    expect(header?.className).toContain('shrink-0')
    expect(body?.className).toContain('flex-1')
    expect(footer?.className).toContain('shrink-0')
  })

  it('默认态渲染默认插槽', () => {
    mountModal()
    expect(queryBody('[data-testid="body-content"]')).not.toBeNull()
  })

  it('加载态替代主体内容，可用插槽覆写文案', () => {
    mountModal({ loading: true })
    expect(bodyText()).toContain('加载中…')
    expect(queryBody('[data-testid="body-content"]')).toBeNull()

    mountModal({ loading: true }, { loading: '<span>正在读取关系账本</span>' })
    expect(bodyText()).toContain('正在读取关系账本')
  })

  it('错误态以警示条呈现（role=alert），可插槽覆写', () => {
    mountModal({ error: '账本文件已损坏' })
    const alert = queryBody('[role="alert"]')
    expect(alert?.textContent).toContain('账本文件已损坏')
    expect(queryBody('[data-testid="body-content"]')).toBeNull()

    mountModal({ error: '账本文件已损坏' }, { error: '<button>重新初始化</button>' })
    expect(queryBody('[role="alert"] button')?.textContent).toBe('重新初始化')
  })

  it('空态呈现引导文案，可插槽覆写', () => {
    mountModal({ empty: true, emptyText: '还没有登记任何关系' })
    expect(bodyText()).toContain('还没有登记任何关系')
    expect(queryBody('[data-testid="body-content"]')).toBeNull()

    mountModal({ empty: true }, { empty: '<button>新建关系</button>' })
    expect(bodyText()).toContain('新建关系')
  })

  it('操作区插槽渲染在标题栏关闭按钮左侧', () => {
    mountModal({}, { actions: '<button data-testid="action">检查</button>' })
    const actions = queryBody('[data-testid="action"]')
    const closeButton = queryBody('button[aria-label="关闭弹窗"]')
    expect(actions).not.toBeNull()
    expect(closeButton).not.toBeNull()
    // 同一 flex 行内 actions 容器先于关闭按钮
    expect(actions && closeButton && (actions.compareDocumentPosition(closeButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy()
  })

  it('尺寸档位由调用方覆盖（widthClass/heightClass 注入内容容器）', () => {
    mountModal({ widthClass: 'max-w-6xl', heightClass: 'h-[80vh]' })
    const dialog = queryBody('[role="dialog"]')
    expect(dialog?.className).toContain('max-w-6xl')
    expect(dialog?.className).toContain('h-[80vh]')
  })

  it('无 footer 插槽不渲染底部行', () => {
    mountModal()
    expect(queryBody('footer')).toBeNull()
  })
})
