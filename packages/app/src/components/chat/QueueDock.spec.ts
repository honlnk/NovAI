// @vitest-environment happy-dom
/**
 * 排队消息编辑重推导测试（技能包 UI/UX 施工计划 阶段 3，§3.2 显示/指令分离）：
 * 编辑提交按新草稿重新展开斜杠命令与 #技能 点名（与发送链路同序：slash 先、
 * skill 后），发生任一展开时原草稿作为 displayLabel 回传。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import type { QueuedMessageView } from '@novai/core/services/types'
import QueueDock from './QueueDock.vue'

function queuedMessage(overrides: Partial<QueuedMessageView> = {}): QueuedMessageView {
  return {
    id: 'q1',
    text: '排队中的消息',
    at: '2026-11-22T10:00:00Z',
    placement: 'queued',
    ...overrides,
  }
}

function mountDock(queue: QueuedMessageView[], skillNames: string[] = []) {
  return mount(QueueDock, {
    props: { queue, running: false, skillNames },
  })
}

/** 行内编辑提交：点编辑 → 改文本 → Enter */
async function editAndSubmit(wrapper: ReturnType<typeof mountDock>, newText: string) {
  await wrapper.find('button[title="编辑"]').trigger('click')
  const input = wrapper.find('input')
  await input.setValue(newText)
  await input.trigger('keydown.enter')
}

describe('QueueDock 编辑重推导（#技能 点名）', () => {
  it('新草稿命中 #技能名 时重新展开：text 追加点名句，displayLabel 为原草稿', async () => {
    const wrapper = mountDock(
      [queuedMessage({ displayLabel: '#去AI味 帮我改这章' })],
      ['去AI味', '文风仿写'],
    )

    await editAndSubmit(wrapper, '#去AI味 帮我改这章')

    const edit = wrapper.emitted('edit')
    expect(edit).toHaveLength(1)
    const [id, text, displayLabel] = edit![0]!
    expect(id).toBe('q1')
    expect(text).toContain('（作者点名使用技能：去AI味。')
    expect(text).toContain('帮我改这章')
    expect(displayLabel).toBe('#去AI味 帮我改这章')
  })

  it('未命中名单的 #话题标签 不展开：text 原样、displayLabel 缺省', async () => {
    const wrapper = mountDock([queuedMessage()], ['去AI味'])

    await editAndSubmit(wrapper, '#日常 闲聊一段')

    const [id, text, displayLabel] = wrapper.emitted('edit')![0]!
    expect(id).toBe('q1')
    expect(text).toBe('#日常 闲聊一段')
    expect(displayLabel).toBeUndefined()
  })

  it('斜杠命令与 #技能 同现：slash 先展开、点名句追加其后', async () => {
    const wrapper = mountDock([queuedMessage()], ['去AI味'])
    // 用真实命令 label 取首个斜杠命令，避免硬编码命令名随词表漂移
    const { SLASH_COMMANDS, expandSlashCommand } = await import('../../constants/slash-commands')
    const label = SLASH_COMMANDS[0]!.label
    const draft = `${label} #去AI味`

    await editAndSubmit(wrapper, draft)

    const [, text, displayLabel] = wrapper.emitted('edit')![0] as [string, string, string | undefined]
    const slashOnly = expandSlashCommand(draft)
    expect(text.startsWith(slashOnly)).toBe(true)
    expect(text.endsWith('（作者点名使用技能：去AI味。请先用 LoadSkill 逐个加载，再按技能方法完成本条请求。）')).toBe(true)
    expect(displayLabel).toBe(draft)
  })
})
