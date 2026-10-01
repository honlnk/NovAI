<script setup lang="ts">
import { computed } from 'vue'
import type { ProjectFileNodeView } from '@novai/core/services/types'
import ToggleSwitch from '../ui/ToggleSwitch.vue'
import {
  createGardenerTaskState,
  type GardenerPresetOption,
  type GardenerTaskParams,
} from './gardener-task'

/**
 * 园丁任务参数弹窗（要素整理参数化计划 W1，D2 形态）。
 *
 * 自上而下：任务描述文本域 → 快捷选项复选列表 → 章节复选列表（右上角开关控制显隐）。
 * 只渲染面板本体，不自带定位：ChatPanel 用锚定输入框上方的 popover 位，
 * ProjectView 的侧栏入口用 BaseModal 居中模态位（同一组件两个出口，D1/D2）。
 */
const props = withDefaults(
  defineProps<{
    /** 发送目标（仅用于底部提示文案；发送行为由父组件在 confirm 回调里区分） */
    target: 'current' | 'new'
    /** 章节清单（chapters/*.txt，已扁平化） */
    chapters: ProjectFileNodeView[]
    /** 快捷选项（W1 传空数组，W2 接 .novai/gardener-presets.json） */
    presets?: GardenerPresetOption[]
  }>(),
  { presets: () => [] },
)

const emit = defineEmits<{
  /** 确认：payload 为拼装原料（base 由父组件注入 GARDENER_TASK_PROMPT） */
  confirm: [params: GardenerTaskParams]
  /** 取消/关闭 */
  cancel: []
  /** 空态「新建快捷选项」：跳设置页（W1 只开 modal，W2 定位到要素整理 tab） */
  openSettings: []
}>()

const state = createGardenerTaskState({
  presets: () => props.presets,
  chapters: () => props.chapters,
})

const targetHint = computed(
  () => (props.target === 'new' ? '确认后在全新会话中发送' : '确认后发送到当前会话'),
)

function handleConfirm() {
  emit('confirm', state.confirmParams())
  state.reset()
}

function handleCancel() {
  emit('cancel')
  state.reset()
}
</script>

<template>
  <div class="flex max-h-[min(560px,70vh)] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg shadow-gray-900/10 ring-1 ring-gray-900/5">
    <!-- 头部：标题 + 「选择章节」开关（D2：右上角） -->
    <div class="flex items-center justify-between border-b border-gray-100 px-4 py-3">
      <div>
        <p id="gardener-task-title" class="text-sm font-semibold text-gray-800">整理要素</p>
        <p class="mt-0.5 text-xs text-gray-400">可先描述任务、勾选范围，再委派要素整理子智能体</p>
      </div>
      <label class="flex items-center gap-2">
        <span class="text-xs font-semibold text-gray-500">选择章节</span>
        <ToggleSwitch v-model="state.chapterListVisible.value" label="选择章节" />
      </label>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
      <!-- 1. 任务描述 -->
      <div>
        <p class="mb-1.5 text-xs font-semibold text-gray-500">任务描述</p>
        <textarea
          v-model="state.text.value"
          rows="2"
          class="w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-800 placeholder:text-gray-400 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-100"
          placeholder="例：提取最新两章中新出现的人物"
        />
      </div>

      <!-- 2. 快捷选项（未配置时给空态 + 新建入口；显隐不随开关变化） -->
      <div>
        <p class="mb-1.5 text-xs font-semibold text-gray-500">快捷选项</p>
        <ul v-if="state.presetList.value.length > 0" class="max-h-40 overflow-y-auto px-0.5">
          <li v-for="preset in state.presetList.value" :key="preset.label">
            <button
              type="button"
              :class="[
                'flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                state.selectedPresetLabels.value.has(preset.label)
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-700 hover:bg-gray-50',
              ]"
              @click="state.togglePreset(preset.label)"
            >
              <span
                :class="[
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                  state.selectedPresetLabels.value.has(preset.label)
                    ? 'border-blue-400 bg-blue-500 text-white'
                    : 'border-gray-300 bg-white',
                ]"
              >
                <svg
                  v-if="state.selectedPresetLabels.value.has(preset.label)"
                  class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                </svg>
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-semibold leading-5">{{ preset.label }}</span>
                <span class="block truncate text-xs leading-4 text-gray-400">{{ preset.prompt }}</span>
              </span>
            </button>
          </li>
        </ul>
        <div
          v-else
          class="flex items-center justify-between gap-2 rounded-lg border border-dashed border-gray-200 px-3 py-2.5"
          :class="{ 'flex-col': state.isPresetEmptyState.value }"
        >
          <span class="text-xs text-gray-400">未配置快捷选项，可在设置页「要素整理」中新建</span>
          <button
            type="button"
            class="shrink-0 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-800"
            @click="emit('openSettings')"
          >
            新建快捷选项
          </button>
        </div>
      </div>

      <!-- 3. 章节选择（右上角开关控制显隐；自绘复选行，与快捷选项同款式） -->
      <div v-if="state.chapterListVisible.value" class="flex min-h-0 flex-col">
        <p class="mb-1.5 text-xs font-semibold text-gray-500">
          章节范围{{ state.selectedChapterPaths.value.size > 0 ? `（已选 ${state.selectedChapterPaths.value.size} 章）` : '' }}
        </p>
        <ul v-if="state.chapterList.value.length > 0" class="max-h-44 overflow-y-auto px-0.5">
          <li v-for="chapter in state.chapterList.value" :key="chapter.path">
            <button
              type="button"
              :class="[
                'flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                state.selectedChapterPaths.value.has(chapter.path)
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-700 hover:bg-gray-50',
              ]"
              @click="state.toggleChapter(chapter.path)"
            >
              <span
                :class="[
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                  state.selectedChapterPaths.value.has(chapter.path)
                    ? 'border-blue-400 bg-blue-500 text-white'
                    : 'border-gray-300 bg-white',
                ]"
              >
                <svg
                  v-if="state.selectedChapterPaths.value.has(chapter.path)"
                  class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                </svg>
              </span>
              <span class="flex-1 truncate text-sm font-medium leading-5">{{ chapter.name }}</span>
            </button>
          </li>
        </ul>
        <div v-else class="rounded-lg border border-dashed border-gray-200 px-3 py-3 text-center text-xs text-gray-400">
          暂无章节
        </div>
      </div>
    </div>

    <!-- 底部操作 -->
    <div class="flex items-center justify-between gap-3 border-t border-gray-100 px-4 py-3">
      <span class="text-xs font-semibold text-gray-400">{{ targetHint }}</span>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-800"
          @click="handleCancel"
        >
          取消
        </button>
        <button
          type="button"
          class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
          @click="handleConfirm"
        >
          {{ state.confirmLabel.value }}
        </button>
      </div>
    </div>
  </div>
</template>
