// @vitest-environment happy-dom
/**
 * 结构性写操作接管 × 追加式账本条目删除文案（时间线JSON化改造计划 §十二 阶段4）：
 * TimelineDelete 的 delete 候选路径形如 elements/timeline.json（事件 EVT-…），
 * 只删账本里的一条事件而非整个账本文件——接管面板须按账本前缀改用条目删除文案，
 * 不落「文件将移入回收站」的普通文件文案误导作者（关系账本同一先例）。
 */
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import type { FileChangeConfirmationView } from '@novai/core/services/types'

import WriteActionTakeover from './WriteActionTakeover.vue'

function mountDelete(path: string) {
  return mount(WriteActionTakeover, {
    props: {
      confirmation: {
        id: 'cf-del',
        toolName: 'TimelineDelete',
        title: '删除时间线事件',
        summary: `删除 ${path}`,
        confirmation: { kind: 'delete', path },
      } as unknown as FileChangeConfirmationView,
    },
    global: { plugins: [createPinia()] },
  })
}

describe('WriteActionTakeover 账本条目删除文案', () => {
  it('时间线账本事件删除：说明只删一条事件、级联清理，不提回收站', () => {
    const wrapper = mountDelete('elements/timeline.json（事件 EVT-4lguzium4z）')
    const text = wrapper.text()

    expect(text).toContain('将从时间线账本中删除这一条事件')
    expect(text).toContain('引用它的关系自动级联清理')
    expect(text).not.toContain('回收站')
  })

  it('关系账本条目删除文案保持不变（先例回归）', () => {
    const wrapper = mountDelete('elements/relations.json（关系 REL-abc）')

    expect(wrapper.text()).toContain('将从关系账本中删除这一条关系')
    expect(wrapper.text()).not.toContain('回收站')
  })

  it('对照组：普通文件删除仍走「移入回收站」文案', () => {
    const wrapper = mountDelete('chapters/第001章-风起.txt')

    expect(wrapper.text()).toContain('将移入回收站')
  })
})