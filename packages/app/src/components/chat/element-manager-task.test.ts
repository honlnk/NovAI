import { describe, expect, it } from 'vitest'

import {
  buildElementManagerTaskMessage,
  createElementManagerTaskState,
  type ElementManagerPresetOption,
} from './element-manager-task'

const BASE = '请立即调用 DelegateToElementManager 工具……'

const PRESETS: ElementManagerPresetOption[] = [
  { label: '只更新变更章节', prompt: '只整理指定章节涉及的要素，不动其他要素文件' },
  { label: '保守合并', prompt: '同名与近名合并前先列出证据，存疑就不合并' },
]

const CHAPTERS = [
  { path: 'chapters/第001章-试炼.txt', name: '第001章-试炼.txt' },
  { path: 'chapters/第002章-风起.txt', name: '第002章-风起.txt' },
]

describe('buildElementManagerTaskMessage 拼装规则（D3）', () => {
  it('空参数：只发 base 本身，与现状裸发一致', () => {
    expect(buildElementManagerTaskMessage(BASE, { text: '', presetPrompts: [], chapters: [] })).toBe(BASE)
  })

  it('自由文本：trim 后追加在 base 之后', () => {
    expect(buildElementManagerTaskMessage(BASE, { text: '  提取最新两章的人物  ', presetPrompts: [], chapters: [] }))
      .toBe(`${BASE}\n\n提取最新两章的人物`)
  })

  it('快捷选项：逐条追加为独立段落', () => {
    expect(
      buildElementManagerTaskMessage(BASE, {
        text: '',
        presetPrompts: ['只整理指定章节', '存疑不合并'],
        chapters: [],
      }),
    ).toBe(`${BASE}\n\n只整理指定章节\n\n存疑不合并`)
  })

  it('章节：拼为「涉及章节：」一行，顿号连接', () => {
    expect(
      buildElementManagerTaskMessage(BASE, {
        text: '',
        presetPrompts: [],
        chapters: [{ path: 'a.txt', name: '第001章-a.txt' }, { path: 'b.txt', name: '第002章-b.txt' }],
      }),
    ).toBe(`${BASE}\n\n涉及章节：第001章-a.txt、第002章-b.txt`)
  })

  it('全参数：base → 文本 → 逐条选项 → 章节行', () => {
    expect(
      buildElementManagerTaskMessage(BASE, {
        text: '提取最新两章中新出现的人物',
        presetPrompts: ['只更新变更章节'],
        chapters: CHAPTERS,
      }),
    ).toBe(
      [
        BASE,
        '提取最新两章中新出现的人物',
        '只更新变更章节',
        `涉及章节：${CHAPTERS.map((c) => c.name).join('、')}`,
      ].join('\n\n'),
    )
  })

  it('空白自由文本与空白选项行被忽略（不产生空段落）', () => {
    expect(
      buildElementManagerTaskMessage(BASE, { text: '   ', presetPrompts: ['   '], chapters: [] }),
    ).toBe(BASE)
  })
})

describe('createElementManagerTaskState 弹窗状态机（D2）', () => {
  function createState(presets: ElementManagerPresetOption[] = PRESETS) {
    return createElementManagerTaskState({ presets: () => presets, chapters: () => CHAPTERS })
  }

  it('确认按钮文案：无输入为「直接管理」，任一输入/勾选变「确认发送」', () => {
    const state = createState()
    expect(state.confirmLabel.value).toBe('直接管理')

    state.text.value = '整理一下'
    expect(state.confirmLabel.value).toBe('确认发送')

    state.text.value = ''
    expect(state.confirmLabel.value).toBe('直接管理')

    state.togglePreset(PRESETS[0].label)
    expect(state.confirmLabel.value).toBe('确认发送')

    state.togglePreset(PRESETS[0].label)
    expect(state.confirmLabel.value).toBe('直接管理')

    state.toggleChapter(CHAPTERS[0].path)
    expect(state.confirmLabel.value).toBe('确认发送')
  })

  it('开关默认开（章节列表显示）；关闭后进入快捷选项空态判定（未配置选项时）', () => {
    const state = createState([])
    expect(state.chapterListVisible.value).toBe(true)
    expect(state.isPresetEmptyState.value).toBe(false)

    state.chapterListVisible.value = false
    expect(state.isPresetEmptyState.value).toBe(true)
  })

  it('已配置选项时：关闭章节开关不构成空态', () => {
    const state = createState()
    state.chapterListVisible.value = false
    expect(state.isPresetEmptyState.value).toBe(false)
  })

  it('确认产物：勾选按列表顺序取 prompt/name，未勾选项不出现', () => {
    const state = createState()
    state.text.value = '  提取人物  '
    // 逆序勾选，产物仍按列表顺序
    state.togglePreset(PRESETS[1].label)
    state.togglePreset(PRESETS[0].label)
    state.toggleChapter(CHAPTERS[1].path)

    expect(state.confirmParams()).toEqual({
      text: '  提取人物  ',
      presetPrompts: [PRESETS[0].prompt, PRESETS[1].prompt],
      chapters: [{ path: CHAPTERS[1].path, name: CHAPTERS[1].name }],
    })
  })

  it('reset：清空文本/勾选/开关回默认', () => {
    const state = createState()
    state.text.value = 'x'
    state.togglePreset(PRESETS[0].label)
    state.toggleChapter(CHAPTERS[0].path)
    state.chapterListVisible.value = false

    state.reset()
    expect(state.text.value).toBe('')
    expect(state.selectedPresetLabels.value.size).toBe(0)
    expect(state.selectedChapterPaths.value.size).toBe(0)
    expect(state.chapterListVisible.value).toBe(true)
    expect(state.confirmLabel.value).toBe('直接管理')
  })
})
