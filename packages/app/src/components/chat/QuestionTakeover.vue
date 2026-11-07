<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import type { AskUserQuestionRequestView } from '@novai/core/services/types'

import { useChatStore } from '../../stores/chat'
import TakeoverStopButton from './TakeoverStopButton.vue'

/**
 * 主动提问的输入区接管（交互优化计划 §8「提问、重命名与删除」）：Agent 提问在原输入
 * 卡片位置紧凑接管——中性面板、细分隔线、固定底部操作，不再用大面积蓝色卡片。
 * 普通编辑器保持挂载但暂时隐藏（草稿保留），队列、停止和会话切换不受影响。
 *
 * 键盘（§8）：无编辑焦点时 Enter 提交一次、Escape 跳过；焦点在输入控件/按钮上时
 * 原生键盘行为优先（textarea 里 Enter 换行，修饰键 Ctrl/Cmd+Enter 提交）。
 * 每个请求独立锁定提交（isSubmittingAnswer），失败保留所选与已填文本并就地报错。
 */
const props = defineProps<{
  question: AskUserQuestionRequestView
}>()

const chatStore = useChatStore()

const takeoverRef = ref<HTMLDivElement | null>(null)
/** 提交失败的就地错误行（选择与文本保留在 store，不丢） */
const submitError = ref('')

onMounted(() => {
  takeoverRef.value?.focus()
})

const canSubmit = computed(() => {
  return chatStore.questionSelection.length > 0 || chatStore.questionText.trim().length > 0
})

function handleSubmit() {
  if (!canSubmit.value || chatStore.isSubmittingAnswer) {
    return
  }
  submitError.value = ''
  const ok = chatStore.submitQuestionAnswer()
  if (!ok) {
    submitError.value = '回答提交失败，你的选择与补充说明已保留，可重试。'
  }
}

function handleSkip() {
  chatStore.skipCurrentQuestion()
}

function optionChecked(label: string) {
  return chatStore.questionSelection.includes(label)
}

/** 键盘路由（§8：输入控件、输入法、按钮原生键盘行为和修饰键优先） */
function handleKeydown(event: KeyboardEvent) {
  const target = event.target
  const tagName = target instanceof HTMLElement ? target.tagName : ''
  // 按钮与单选/复选框：交给原生键盘行为（Enter/Space 各有原生语义，不重复触发）
  if (tagName === 'BUTTON' || tagName === 'INPUT') {
    return
  }
  // 组字期不抢键
  if (event.isComposing) {
    return
  }
  const isTextarea = tagName === 'TEXTAREA'
  if (event.key === 'Enter') {
    if (isTextarea) {
      // textarea 内裸 Enter 换行（原生）；Ctrl/Cmd+Enter 明确提交
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        handleSubmit()
      }
      return
    }
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      handleSubmit()
    }
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    handleSkip()
  }
}
</script>

<template>
  <div
    ref="takeoverRef"
    class="chat-input-card outline-none"
    tabindex="-1"
    role="group"
    :aria-label="`回答 Agent 提问：${props.question.header || props.question.question}`"
    @keydown="handleKeydown"
  >
    <!-- 标题行：header 短标题 + 问题正文（§8 紧凑说明谁在问、问什么） -->
    <div class="flex items-start gap-2.5 border-b border-gray-100 p-3">
      <svg class="mt-0.5 h-4 w-4 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-gray-700">
          <span v-if="props.question.header" class="mr-1.5 rounded bg-gray-100 px-1 py-0.5 text-[10px] font-normal text-gray-500">{{ props.question.header }}</span>
          Agent 提问
        </p>
        <p class="mt-1 whitespace-pre-wrap text-sm text-gray-800">{{ props.question.question }}</p>
      </div>
    </div>

    <!-- 选项 + 补充说明（内部滚动区）：多选/单选与卡片同语义，选择状态仍在 store -->
    <div class="max-h-56 space-y-1.5 overflow-y-auto px-3 py-2.5">
      <label
        v-for="option in props.question.options"
        :key="option.label"
        class="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors"
        :class="optionChecked(option.label)
          ? 'border-gray-400 bg-gray-50'
          : 'border-gray-200 bg-white hover:border-gray-300'"
      >
        <input
          :type="props.question.multiSelect ? 'checkbox' : 'radio'"
          class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-gray-700"
          :checked="optionChecked(option.label)"
          @change="chatStore.toggleQuestionOption(option.label)"
        >
        <span>
          <span class="text-sm text-gray-800">{{ option.label }}</span>
          <span v-if="option.description" class="ml-1.5 text-xs text-gray-500">{{ option.description }}</span>
        </span>
      </label>
      <textarea
        v-model="chatStore.questionText"
        class="w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-gray-400"
        rows="2"
        placeholder="补充说明（可选）：也可只填写文字不选候选项"
      />
    </div>

    <!-- 就地错误行（§8 失败保留选择与错误） -->
    <p v-if="submitError" class="border-t border-gray-100 px-3 py-1.5 text-xs text-red-600" role="alert">{{ submitError }}</p>

    <!-- 固定底部操作：跳过（次）/ 提交回答（主）；无选择也无文本时禁用提交 -->
    <div class="flex items-center justify-between gap-2 border-t border-gray-100 px-3 py-2.5">
      <p class="min-w-0 text-[11px] text-gray-400">Enter 提交 · Escape 跳过 · 文本框内 Ctrl/Cmd+Enter 提交</p>
      <div class="flex shrink-0 items-center gap-2">
        <!-- 停止仍可用（§8）：接管期间普通工具行隐藏，停止入口随面板保留 -->
        <TakeoverStopButton />
        <button
          type="button"
          class="rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
          title="跳过：Agent 将在不获得答案的情况下调整后续处理"
          @click="handleSkip"
        >跳过问题</button>
        <button
          type="button"
          class="rounded-md bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!canSubmit || chatStore.isSubmittingAnswer"
          @click="handleSubmit"
        >{{ chatStore.isSubmittingAnswer ? '提交中…' : '提交回答' }}</button>
      </div>
    </div>
  </div>
</template>
