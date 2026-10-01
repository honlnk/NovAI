import { computed, ref } from 'vue'
import type { ProjectFileNodeView } from '@novai/core/services/types'

/**
 * 园丁任务参数弹窗的逻辑层（要素整理参数化计划 W1）。
 *
 * 组件 GardenerTaskDialog 只做视图，可测的状态与拼装规则收在本模块
 * （仓库测试为 node 环境纯逻辑测试，无组件挂载基建，照 reasoning-collapse 模式抽状态机）。
 */

/** 快捷选项（与 W2 的 core 侧 GardenerPresetView 同形，接线后由 core 类型收编） */
export type GardenerPresetOption = {
  /** 列表显示名 */
  label: string
  /** 勾选后拼进任务消息的文本 */
  prompt: string
}

/** 弹窗确认产物（D3 拼装原料，path/name 均来自章节清单） */
export type GardenerTaskParams = {
  /** 任务描述自由文本（未 trim，拼装时再治） */
  text: string
  /** 勾选的快捷选项 prompt 逐条 */
  presetPrompts: string[]
  /** 勾选的章节 */
  chapters: { path: string; name: string }[]
}

/**
 * 拼装园丁任务消息（D3）：base（GARDENER_TASK_PROMPT）+ 自由文本 + 快捷选项逐条 + 章节范围。
 * 空参数时只有 base 本身，与现状裸发行为一致。章节以文本指明范围——园丁自己读文件，
 * 不需要结构化数据。
 */
export function buildGardenerTaskMessage(base: string, params: GardenerTaskParams): string {
  const sections: string[] = [base]
  const text = params.text.trim()
  if (text) {
    sections.push(text)
  }
  for (const preset of params.presetPrompts) {
    const line = preset.trim()
    if (line) {
      sections.push(line)
    }
  }
  if (params.chapters.length > 0) {
    sections.push(`涉及章节：${params.chapters.map((chapter) => chapter.name).join('、')}`)
  }
  return sections.join('\n\n')
}

/**
 * 弹窗状态机（D2 形态的语义核心）：
 * - 开关「选择章节」只控制章节列表显隐（默认开）；快捷选项列表恒显，未配置时给空态。
 * - 确认按钮文案（D2）：无任何输入/勾选 →「直接整理」；有任一 →「确认发送」。
 *
 * presets/chapters 走 getter（组件传 props 的读取函数，测试传常量数组），
 * 状态随来源变化自动重算。
 */
export function createGardenerTaskState(options: {
  presets: () => GardenerPresetOption[]
  chapters: () => Pick<ProjectFileNodeView, 'path' | 'name'>[]
}) {
  const text = ref('')
  const selectedPresetLabels = ref<Set<string>>(new Set())
  const selectedChapterPaths = ref<Set<string>>(new Set())
  /** 「选择章节」开关：开 = 同时显示快捷选项与章节两列表（D2） */
  const chapterListVisible = ref(true)

  const presetList = computed(() => options.presets())
  const chapterList = computed(() => options.chapters())

  /** 快捷选项区空态：未配置任何选项且章节列表收起（此时弹窗只剩任务描述可用） */
  const isPresetEmptyState = computed(
    () => presetList.value.length === 0 && !chapterListVisible.value,
  )

  const hasAnyInput = computed(
    () =>
      text.value.trim() !== '' ||
      selectedPresetLabels.value.size > 0 ||
      selectedChapterPaths.value.size > 0,
  )

  /** 确认按钮动态文案（D2） */
  const confirmLabel = computed(() => (hasAnyInput.value ? '确认发送' : '直接整理'))

  function togglePreset(label: string) {
    const next = new Set(selectedPresetLabels.value)
    if (next.has(label)) {
      next.delete(label)
    } else {
      next.add(label)
    }
    selectedPresetLabels.value = next
  }

  function toggleChapter(path: string) {
    const next = new Set(selectedChapterPaths.value)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
    }
    selectedChapterPaths.value = next
  }

  /** 确认：按勾选集合从来源列表取值（顺序跟随列表，不跟随勾选先后） */
  function confirmParams(): GardenerTaskParams {
    return {
      text: text.value,
      presetPrompts: presetList.value
        .filter((preset) => selectedPresetLabels.value.has(preset.label))
        .map((preset) => preset.prompt),
      chapters: chapterList.value
        .filter((chapter) => selectedChapterPaths.value.has(chapter.path))
        .map((chapter) => ({ path: chapter.path, name: chapter.name })),
    }
  }

  /** 关闭/发送后复位（实例复用，状态不跨次残留） */
  function reset() {
    text.value = ''
    selectedPresetLabels.value = new Set()
    selectedChapterPaths.value = new Set()
    chapterListVisible.value = true
  }

  return {
    text,
    selectedPresetLabels,
    selectedChapterPaths,
    chapterListVisible,
    presetList,
    chapterList,
    isPresetEmptyState,
    hasAnyInput,
    confirmLabel,
    togglePreset,
    toggleChapter,
    confirmParams,
    reset,
  }
}
