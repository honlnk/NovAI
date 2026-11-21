// @vitest-environment happy-dom
/**
 * 章节选择器组件面（作者字段控制权计划阶段 1，计划 §三.4 / 阶段 1 验收）。
 *
 * 根 vitest 配置无 Vue SFC 插件（共享配置不动），本文件用 .spec.ts 避开根
 * include（*.test.ts），由 packages/app 目录（vite.config.js 含 @vitejs/plugin-vue）
 * 单独运行：pnpm --filter @novai/app exec vitest run src/components/card-board
 *
 * 覆盖：搜索过滤（数字全本章号 / 标题）、键盘上下回车 Esc、单选收起、多选标签
 * 增删重排与去重追加、章号缺失 / 删后同号重建 / 历史重号的呈现、新建流程
 * （成功 / 唯一占用改选 / 重号待消歧 / 失败保留输入）、加载失败重试、
 * 会话键切换重置与晚到结果丢弃。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'

import ChapterPicker from './ChapterPicker.vue'
import type { ChapterCreateHandler, ChapterCreateOutcome } from './chapter-picker-state'
import type { ChapterCatalogEntry } from '@novai/core/types/chapters'

function entry(options: Partial<ChapterCatalogEntry> & { number: number }): ChapterCatalogEntry {
  const fileName = options.fileName ?? `第${String(options.number).padStart(3, '0')}章-${options.title ?? '章节'}.txt`
  const directory = options.directory ?? ''
  return {
    number: options.number,
    title: options.title ?? '章节',
    fileName,
    directory,
    path: options.path ?? `chapters/${directory ? `${directory}/` : ''}${fileName}`,
    ref: options.ref ?? `${directory ? `${directory}/` : ''}${fileName.replace(/\.txt$/u, '')}`,
    canonical: options.canonical ?? true,
  }
}

const ENTRIES: ChapterCatalogEntry[] = [
  entry({ number: 3, title: '风雨', directory: '第一卷' }),
  entry({ number: 12, title: '夜行' }),
  entry({ number: 113, title: '大结局' }),
  entry({ number: 12, title: '夜行-草稿副本', ref: '第012章-夜行-草稿副本' }),
]

function mountPicker(options: {
  multiple?: boolean
  modelValue?: string | string[] | null
  entries?: ChapterCatalogEntry[]
  loadError?: string | null
  allowCreate?: boolean
  clearable?: boolean
  suggestedNumber?: number | null
  createHandler?: (input: { chapterNumber: number; title: string | null }) => ChapterCreateOutcome | Promise<ChapterCreateOutcome> | null
} = {}) {
  const createHandler = options.createHandler === undefined
    ? vi.fn(async (input: { chapterNumber: number; title: string | null }) =>
      ({ kind: 'created', entry: entry({ number: input.chapterNumber, title: input.title ?? '未命名' }) }) as ChapterCreateOutcome)
    : options.createHandler === null
      ? null
      : vi.fn(options.createHandler)

  const wrapper = mount(ChapterPicker, {
    props: {
      multiple: options.multiple ?? false,
      modelValue: options.modelValue ?? (options.multiple ? [] : null),
      entries: options.entries ?? ENTRIES,
      loadError: options.loadError ?? null,
      allowCreate: options.allowCreate ?? true,
      clearable: options.clearable ?? false,
      suggestedNumber: options.suggestedNumber ?? null,
      sessionKey: 'session-a',
      createHandler: createHandler as ChapterCreateHandler | null,
    },
  })

  return { wrapper, createHandler: createHandler as Mock | null }
}

async function submitCreateForm(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('form').trigger('submit')
  await nextTick()
  await nextTick()
}

function input(wrapper: VueWrapper) {
  return wrapper.get<HTMLInputElement>('[data-testid="chapter-picker-input"]')
}

async function focusInput(wrapper: VueWrapper) {
  await input(wrapper).setValue('')
  await wrapper.get('[data-testid="chapter-picker-input"]').trigger('focusin')
}

describe('搜索与键盘选择', () => {
  it('数字查询按全本章号等值匹配；标题查询子串匹配', async () => {
    const { wrapper } = mountPicker()
    await focusInput(wrapper)

    await input(wrapper).setValue('12')
    let options = wrapper.findAll('[data-testid^="chapter-picker-option-"]')
    expect(options).toHaveLength(2) // 第012章 两份（历史重号候选都列出）
    expect(options[0]!.text()).toContain('夜行')

    await input(wrapper).setValue('113')
    options = wrapper.findAll('[data-testid^="chapter-picker-option-"]')
    expect(options).toHaveLength(1)
    expect(options[0]!.text()).toContain('大结局')

    await input(wrapper).setValue('夜行')
    options = wrapper.findAll('[data-testid^="chapter-picker-option-"]')
    expect(options).toHaveLength(2)

    await input(wrapper).setValue('没有的内容')
    expect(wrapper.get('[data-testid="chapter-picker-empty"]').text()).toBe('没有匹配的章节')
  })

  it('重号章节在选项中标注「章号重复」，全部候选可见', async () => {
    const { wrapper } = mountPicker()
    await focusInput(wrapper)
    await input(wrapper).setValue('12')

    const options = wrapper.findAll('[data-testid^="chapter-picker-option-"]')
    expect(options).toHaveLength(2)
    expect(options[0]!.text()).toContain('章号重复')
    expect(options[1]!.text()).toContain('章号重复')
  })

  it('键盘：ArrowDown/ArrowUp 移动高亮，Enter 选择，Esc 收起', async () => {
    const { wrapper } = mountPicker()
    await focusInput(wrapper)

    await input(wrapper).trigger('keydown', { key: 'ArrowDown' })
    await input(wrapper).trigger('keydown', { key: 'ArrowDown' })
    let options = wrapper.findAll('[data-testid^="chapter-picker-option-"]')
    expect(options[1]!.classes()).toContain('is-highlighted')

    await input(wrapper).trigger('keydown', { key: 'ArrowUp' })
    options = wrapper.findAll('[data-testid^="chapter-picker-option-"]')
    expect(options[0]!.classes()).toContain('is-highlighted')

    await input(wrapper).trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')![0]).toEqual(['第一卷/第003章-风雨'])

    // 单选：选择后收起；Esc 也收起
    await focusInput(wrapper)
    await input(wrapper).trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-testid="chapter-picker-dropdown"]').exists()).toBe(false)
  })

  it('鼠标点击选项与键盘得到同一结果', async () => {
    const { wrapper } = mountPicker()
    await focusInput(wrapper)

    await wrapper.findAll('[data-testid^="chapter-picker-option-"]')[1]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual(['第012章-夜行'])
  })
})

describe('多选标签', () => {
  it('追加不清空其他项；重复引用不重复添加', async () => {
    const { wrapper } = mountPicker({ multiple: true, modelValue: ['第012章-夜行'] })
    await focusInput(wrapper)

    await wrapper.findAll('[data-testid^="chapter-picker-option-"]')[0]!.trigger('click')
    let emitted = wrapper.emitted('update:modelValue')!
    expect(emitted[emitted.length - 1]).toEqual([['第012章-夜行', '第一卷/第003章-风雨']])

    // 再选同一项不重复
    await wrapper.findAll('[data-testid^="chapter-picker-option-"]')[0]!.trigger('click')
    emitted = wrapper.emitted('update:modelValue')!
    expect(emitted[emitted.length - 1]).toEqual([['第012章-夜行', '第一卷/第003章-风雨']])
  })

  it('删除、重排与清空', async () => {
    const { wrapper } = mountPicker({ multiple: true, modelValue: ['a-ref', 'b-ref', 'c-ref'] })

    await wrapper.get('[data-testid="chapter-picker-tag-remove-1"]').trigger('click')
    let emitted = wrapper.emitted('update:modelValue')!
    expect(emitted[emitted.length - 1]).toEqual([['a-ref', 'c-ref']])

    // 模拟 v-model 回馈：事件值写回 props 再继续操作
    await wrapper.setProps({ modelValue: ['a-ref', 'c-ref'] })
    await wrapper.get('[data-testid="chapter-picker-tag-up-1"]').trigger('click')
    emitted = wrapper.emitted('update:modelValue')!
    expect(emitted[emitted.length - 1]).toEqual([['c-ref', 'a-ref']])

    await wrapper.setProps({ modelValue: ['c-ref', 'a-ref'] })
    await wrapper.get('[data-testid="chapter-picker-tag-down-0"]').trigger('click')
    emitted = wrapper.emitted('update:modelValue')!
    expect(emitted[emitted.length - 1]).toEqual([['a-ref', 'c-ref']])

    await wrapper.get('[data-testid="chapter-picker-clear"]').trigger('click')
    emitted = wrapper.emitted('update:modelValue')!
    expect(emitted[emitted.length - 1]).toEqual([[]])
  })

  it('首项上移 / 末项下移禁用', () => {
    const { wrapper } = mountPicker({ multiple: true, modelValue: ['a-ref', 'b-ref'] })

    expect(wrapper.get('[data-testid="chapter-picker-tag-up-0"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="chapter-picker-tag-down-1"]').attributes('disabled')).toBeDefined()
  })
})

describe('已选值呈现（旧值核对）', () => {
  it('目录未就绪：显示原始引用，不下缺失结论', async () => {
    const { wrapper } = mountPicker({ modelValue: '第099章-不存在' })
    await wrapper.setProps({ catalogReady: false })

    const single = wrapper.get('.chapter-picker-single')
    expect(single.text()).toContain('第099章-不存在')
    expect(single.text()).not.toContain('没有章节')
  })

  it('章号缺失：显示「该章号当前没有章节」', () => {
    const { wrapper } = mountPicker({ modelValue: '第099章-不存在' })
    const single = wrapper.get('.chapter-picker-single')
    expect(single.text()).toContain('第99章当前没有章节')
  })

  it('删后同号重建（引用标题与当前不一致）：恢复展示并说明无法确认原章节', () => {
    const { wrapper } = mountPicker({ modelValue: '第003章-旧标题' })
    const single = wrapper.get('.chapter-picker-single')
    expect(single.text()).toContain('风雨')
    expect(single.text()).toContain('无法确认是否原章节')
  })

  it('历史重号：待消歧标注，主文案退回原始引用', () => {
    const { wrapper } = mountPicker({ modelValue: '第012章-夜行' })
    const single = wrapper.get('.chapter-picker-single')
    expect(single.text()).toContain('章号重复，待消歧')
  })

  it('自由文本：无法解析为章节引用', () => {
    const { wrapper } = mountPicker({ modelValue: '第三章左右再收' })
    const single = wrapper.get('.chapter-picker-single')
    expect(single.text()).toContain('原文无法解析为章节引用')
  })

  it('单选清除按钮（clearable）', async () => {
    const { wrapper } = mountPicker({ modelValue: '第012章-夜行', clearable: true })
    await wrapper.get('[data-testid="chapter-picker-clear"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([null])
  })
})

describe('新建章节', () => {
  it('创建成功：选择新章节并提示；表单收起', async () => {
    const { wrapper, createHandler } = mountPicker({ suggestedNumber: 114 })
    await focusInput(wrapper)

    await wrapper.get('[data-testid="chapter-picker-create-toggle"]').trigger('click')
    expect(wrapper.get<HTMLInputElement>('[data-testid="chapter-picker-create-number"]').element.value).toBe('114')

    await wrapper.get('[data-testid="chapter-picker-create-title"]').setValue('终章之后')
    await submitCreateForm(wrapper)

    expect(createHandler).toHaveBeenCalledWith({ chapterNumber: 114, title: '终章之后' })
    expect(wrapper.emitted('update:modelValue')![0]).toEqual(['第114章-终章之后'])
    expect(wrapper.get('[data-testid="chapter-picker-notice"]').text()).toContain('已创建')
    expect(wrapper.find('[data-testid="chapter-picker-create-number"]').exists()).toBe(false)
  })

  it('唯一占用（本地判定）：改为选择既有章节，不发起创建请求', async () => {
    const { wrapper, createHandler } = mountPicker()
    await focusInput(wrapper)

    await wrapper.get('[data-testid="chapter-picker-create-toggle"]').trigger('click')
    await wrapper.get('[data-testid="chapter-picker-create-number"]').setValue('113')
    await submitCreateForm(wrapper)

    expect(createHandler).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:modelValue')![0]).toEqual(['第113章-大结局'])
    expect(wrapper.get('[data-testid="chapter-picker-notice"]').text()).toContain('已改为选择')
  })

  it('重号占用（本地判定）：报「待消歧」错误，保留输入', async () => {
    const { wrapper, createHandler } = mountPicker()
    await focusInput(wrapper)

    await wrapper.get('[data-testid="chapter-picker-create-toggle"]').trigger('click')
    await wrapper.get('[data-testid="chapter-picker-create-number"]').setValue('12')
    await wrapper.get('[data-testid="chapter-picker-create-title"]').setValue('想建的新章')
    await submitCreateForm(wrapper)

    expect(createHandler).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="chapter-picker-create-error"]').text()).toContain('消歧')
    expect(wrapper.get<HTMLInputElement>('[data-testid="chapter-picker-create-number"]').element.value).toBe('12')
    expect(wrapper.get<HTMLInputElement>('[data-testid="chapter-picker-create-title"]').element.value).toBe('想建的新章')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('创建失败的晚到占用（竞态兜底）：报错并保留输入', async () => {
    const { wrapper } = mountPicker({
      createHandler: async () => ({ kind: 'number-taken', existing: [ENTRIES[1]!, ENTRIES[3]!] }),
    })
    await focusInput(wrapper)

    await wrapper.get('[data-testid="chapter-picker-create-toggle"]').trigger('click')
    await wrapper.get('[data-testid="chapter-picker-create-number"]').setValue('200')
    await submitCreateForm(wrapper)

    expect(wrapper.get('[data-testid="chapter-picker-create-error"]').text()).toContain('消歧')
    expect(wrapper.get<HTMLInputElement>('[data-testid="chapter-picker-create-number"]').element.value).toBe('200')
  })

  it('服务端失败：就地报错，输入保留', async () => {
    const { wrapper } = mountPicker({
      createHandler: async () => ({ kind: 'failed', message: '写入失败' }),
    })
    await focusInput(wrapper)

    await wrapper.get('[data-testid="chapter-picker-create-toggle"]').trigger('click')
    await wrapper.get('[data-testid="chapter-picker-create-number"]').setValue('200')
    await submitCreateForm(wrapper)

    expect(wrapper.get('[data-testid="chapter-picker-create-error"]').text()).toContain('写入失败')
    expect(wrapper.get<HTMLInputElement>('[data-testid="chapter-picker-create-number"]').element.value).toBe('200')
  })

  it('非法章号：就地报错，输入保留', async () => {
    const { wrapper } = mountPicker()
    await focusInput(wrapper)

    await wrapper.get('[data-testid="chapter-picker-create-toggle"]').trigger('click')
    await wrapper.get('[data-testid="chapter-picker-create-number"]').setValue('abc')
    await submitCreateForm(wrapper)
    expect(wrapper.get('[data-testid="chapter-picker-create-error"]').text()).toContain('正整数')
  })

  it('allowCreate=false（实际回收章节）：不提供新建入口', async () => {
    const { wrapper } = mountPicker({ allowCreate: false })
    await focusInput(wrapper)

    expect(wrapper.find('[data-testid="chapter-picker-create-toggle"]').exists()).toBe(false)
  })
})

describe('加载失败与会话隔离', () => {
  it('读取失败：显示错误与重试，不显示成「没有章节」', async () => {
    const { wrapper } = mountPicker({ loadError: '章节目录读取失败' })
    await focusInput(wrapper)

    expect(wrapper.get('[data-testid="chapter-picker-load-error"]').text()).toContain('读取失败')
    expect(wrapper.find('[data-testid="chapter-picker-empty"]').exists()).toBe(false)

    await wrapper.get('[data-testid="chapter-picker-retry"]').trigger('click')
    expect(wrapper.emitted('retry-load')).toHaveLength(1)
  })

  it('会话键变化：搜索与新建现场重置', async () => {
    const { wrapper } = mountPicker()
    await focusInput(wrapper)
    await input(wrapper).setValue('夜行')
    await wrapper.get('[data-testid="chapter-picker-create-toggle"]').trigger('click')

    await wrapper.setProps({ sessionKey: 'session-b' })

    expect(wrapper.find('[data-testid="chapter-picker-dropdown"]').exists()).toBe(false)
    await focusInput(wrapper)
    expect(wrapper.findAll('[data-testid^="chapter-picker-option-"]')).toHaveLength(4)
    expect(wrapper.find('[data-testid="chapter-picker-create-number"]').exists()).toBe(false)
  })

  it('晚到的创建结果（会话键已变）不回填新现场', async () => {
    let resolveCreate: (outcome: ChapterCreateOutcome) => void = () => {}
    const createHandler = () => new Promise<ChapterCreateOutcome>((resolve) => {
      resolveCreate = resolve
    })
    const { wrapper } = mountPicker({ createHandler })
    await focusInput(wrapper)

    await wrapper.get('[data-testid="chapter-picker-create-toggle"]').trigger('click')
    await wrapper.get('[data-testid="chapter-picker-create-number"]').setValue('114')
    await wrapper.get('form').trigger('submit')

    await wrapper.setProps({ sessionKey: 'session-b' })
    resolveCreate({ kind: 'created', entry: entry({ number: 114 }) })
    await nextTick()
    await nextTick()

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.find('[data-testid="chapter-picker-notice"]').exists()).toBe(false)
  })
})
