// @vitest-environment happy-dom
/**
 * 计划位置选择器（作者字段控制权计划阶段 2 §三.5）的行为基线：
 * - 模式切换的编码出口：未设置/开放终点/已有章节/未来章号/相对位置；
 * - 相对位置默认基准 = 最新章号、偏移默认 1，输入即校验并发出确定目标；
 * - 指定未来章号已存在对应章节时直接转为选择该章节；
 * - 兼容原文（raw）保留展示并提示须明确处理。
 *
 * 运行方式：pnpm --filter @novai/app exec vitest run src/components/foreshadowing
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import PlannedPositionPicker from './PlannedPositionPicker.vue'
import type { ChapterCatalogEntry } from '@novai/core/types/chapters'

const ENTRIES: ChapterCatalogEntry[] = [
  { number: 12, title: '夜行', fileName: '第012章-夜行.txt', directory: '第一卷', path: 'chapters/第一卷/第012章-夜行.txt', ref: '第一卷/第012章-夜行', canonical: true },
  { number: 15, title: '旧宅', fileName: '第015章-旧宅.txt', directory: '第一卷', path: 'chapters/第一卷/第015章-旧宅.txt', ref: '第一卷/第015章-旧宅', canonical: true },
]

function mountPicker(overrides: Record<string, unknown> = {}) {
  return mount(PlannedPositionPicker, {
    props: {
      modelValue: 'none',
      entries: ENTRIES,
      catalogReady: true,
      sessionKey: 'spec',
      latestChapterNumber: 12,
      ...overrides,
    },
  })
}

function emittedValue(wrapper: ReturnType<typeof mountPicker>): string | undefined {
  const calls = wrapper.emitted('update:modelValue') as Array<[string]> | undefined
  return calls && calls.length > 0 ? calls[calls.length - 1]![0] : undefined
}

async function switchMode(wrapper: ReturnType<typeof mountPicker>, mode: string) {
  await wrapper.get('[data-testid="planned-position-mode"]').setValue(mode)
}

describe('计划位置选择器：模式与编码出口', () => {
  it('起点切「未设置」发出 none；终点模式含开放终点', async () => {
    const wrapper = mountPicker({ modelValue: 'future:15' })
    await switchMode(wrapper, 'none')
    expect(emittedValue(wrapper)).toBe('none')
    wrapper.unmount()

    const end = mountPicker({ modelValue: 'none', allowOpen: true })
    await switchMode(end, 'open')
    expect(emittedValue(end)).toBe('open')
    end.unmount()
  })

  it('未来章号输入即校验并发出编码；已存在对应章节时转为选择该章节', async () => {
    const wrapper = mountPicker({ modelValue: 'none' })
    await switchMode(wrapper, 'future')
    await wrapper.get('[data-testid="planned-position-future-target"]').setValue('20')
    expect(emittedValue(wrapper)).toBe('future:20')
    expect(wrapper.text()).toContain('尚未创建')

    await wrapper.get('[data-testid="planned-position-future-target"]').setValue('15')
    expect(emittedValue(wrapper)).toBe('chapter:第一卷/第015章-旧宅')
    // 模式随转已有章节
    expect((wrapper.get('[data-testid="planned-position-mode"]').element as HTMLSelectElement).value).toBe('chapter')
    wrapper.unmount()
  })

  it('相对位置：默认基准 = 最新章号、偏移 1，目标 = 基准 + 偏移且编码完整', async () => {
    const wrapper = mountPicker({ modelValue: 'none', latestChapterNumber: 12 })
    await switchMode(wrapper, 'relative')
    // 切模式即带默认值发出：12 + 1
    expect(emittedValue(wrapper)).toBe('relative:13:12:1')

    await wrapper.get('[data-testid="planned-position-relative-base"]').setValue('10')
    await wrapper.get('[data-testid="planned-position-relative-offset"]').setValue('5')
    expect(emittedValue(wrapper)).toBe('relative:15:10:5')
    expect(wrapper.text()).toContain('第10章之后 5 章 → 第15章')
    wrapper.unmount()
  })

  it('非法输入不发出编码并就地提示（基准 0 / 章号 0）', async () => {
    const wrapper = mountPicker({ modelValue: 'none' })
    await switchMode(wrapper, 'relative')
    await wrapper.get('[data-testid="planned-position-relative-base"]').setValue('0')
    const before = wrapper.emitted('update:modelValue')?.length ?? 0
    await wrapper.get('[data-testid="planned-position-relative-offset"]').setValue('2')
    expect(wrapper.emitted('update:modelValue')?.length ?? 0).toBe(before)
    expect(wrapper.text()).toContain('基准章号须为正整数')
    wrapper.unmount()

    const future = mountPicker({ modelValue: 'none' })
    await switchMode(future, 'future')
    await future.get('[data-testid="planned-position-future-target"]').setValue('0')
    expect(emittedValue(future)).toBeUndefined()
    expect(future.text()).toContain('章号须为正整数')
    future.unmount()
  })

  it('兼容原文（raw）保留展示：提示须明确处理，不静默改绑', async () => {
    const wrapper = mountPicker({ modelValue: '大概第十几章' })
    expect(wrapper.get('[data-testid="planned-position-display"]').text()).toBe('大概第十几章')
    expect(wrapper.find('[data-testid="planned-position-raw-hint"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('无法归类')

    // 明确改为未设置后才完成新版编辑
    await switchMode(wrapper, 'none')
    expect(emittedValue(wrapper)).toBe('none')
    wrapper.unmount()
  })

  it('展示：已有章节带标题、未来章号标尚未创建、开放终点与未设置明确区分', async () => {
    const chapter = mountPicker({ modelValue: 'chapter:第一卷/第012章-夜行' })
    expect(chapter.get('[data-testid="planned-position-display"]').text()).toContain('夜行')
    chapter.unmount()

    const future = mountPicker({ modelValue: 'future:20' })
    expect(future.get('[data-testid="planned-position-display"]').text()).toContain('尚未创建')
    future.unmount()

    const open = mountPicker({ modelValue: 'open', allowOpen: true })
    expect(open.get('[data-testid="planned-position-display"]').text()).toContain('开放终点')
    open.unmount()

    const none = mountPicker({ modelValue: 'none' })
    expect(none.get('[data-testid="planned-position-display"]').text()).toBe('未设置')
    none.unmount()
  })
})
