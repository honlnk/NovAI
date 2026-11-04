<script setup lang="ts">
import { computed } from 'vue'
import type { ChatMessageView } from '@novai/core/services/types'

import { useChatStore } from '../../stores/chat'

/**
 * 主动提问卡（AskUserQuestion 工具调用在消息流里的交互主体，不折叠进工具过程组）。
 * 三态：
 * - 待回答（无 answer 且 questionId 命中当前挂起请求）：可交互——单选/多选、补充文本、提交、跳过；
 * - 已作答（answer 存在）：只读展示所选与补充说明；
 * - 等待已中断（无 answer 且不在挂起快照——典型为页面刷新后）：禁用交互，提示继续发消息。
 * 中性 blue 色系（提问是协作交互，不是 amber 警示的写确认）。
 */
const props = defineProps<{
  message: ChatMessageView
}>()

const chatStore = useChatStore()

const card = computed(() =>
  props.message.kind === 'ask-user-question' ? props.message : null,
)

// 可交互态：这张卡就是当前挂起的那个问题
const isInteractive = computed(
  () => !!card.value
    && !card.value.answer
    && chatStore.pendingQuestion?.questionId === card.value.questionId,
)
// 中断态：无 answer 且已不在挂起快照（刷新/停止/异常后 core 不恢复等待）
const isInterrupted = computed(
  () => !!card.value && !card.value.answer && !isInteractive.value,
)

const canSubmit = computed(() => {
  if (!isInteractive.value) {
    return false
  }
  return chatStore.questionSelection.length > 0 || chatStore.questionText.trim().length > 0
})

function handleSubmit() {
  if (!canSubmit.value) {
    return
  }
  chatStore.submitQuestionAnswer()
}

function handleSkip() {
  chatStore.skipCurrentQuestion()
}

function optionChecked(label: string) {
  return chatStore.questionSelection.includes(label)
}

function optionDisabled() {
  return !isInteractive.value
}
</script>

<template>
  <div v-if="card" class="w-full text-left">
    <div class="rounded-lg border border-blue-200 bg-blue-50/60 p-4">
      <!-- 标题行：短标题（若有）+ 状态徽标 -->
      <div class="mb-2 flex items-center gap-2">
        <svg class="h-4 w-4 shrink-0 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span v-if="card.header" class="text-xs font-medium text-blue-700">{{ card.header }}</span>
        <span
          v-if="isInteractive"
          class="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700"
        >等待回答</span>
        <span
          v-else-if="card.answer?.outcome === 'answered'"
          class="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500"
        >已回答</span>
        <span
          v-else-if="card.answer?.outcome === 'cancelled'"
          class="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500"
        >已跳过</span>
        <span
          v-else-if="isInterrupted"
          class="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500"
        >等待已中断</span>
      </div>

      <!-- 问题正文 -->
      <p class="whitespace-pre-wrap text-sm font-medium text-gray-800">{{ card.question }}</p>

      <!-- 候选项（可交互态：单选/多选；只读态：标记所选） -->
      <div v-if="card.options?.length" class="mt-3 space-y-1.5">
        <label
          v-for="option in card.options"
          :key="option.label"
          class="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors"
          :class="isInteractive
            ? (optionChecked(option.label)
              ? 'border-blue-300 bg-white'
              : 'border-blue-100 bg-white/70 hover:border-blue-200')
            : 'cursor-default border-transparent bg-white/40'"
          :data-checked="optionChecked(option.label) || undefined"
        >
          <input
            :type="card.multiSelect ? 'checkbox' : 'radio'"
            class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-blue-600"
            :checked="optionChecked(option.label)"
            :disabled="optionDisabled()"
            @change="chatStore.toggleQuestionOption(option.label)"
          >
          <span>
            <span class="text-sm text-gray-800">{{ option.label }}</span>
            <span v-if="option.description" class="ml-1.5 text-xs text-gray-500">{{ option.description }}</span>
          </span>
        </label>
      </div>

      <!-- 补充说明输入（可交互态） / 答案展示（只读态） -->
      <textarea
        v-if="isInteractive"
        v-model="chatStore.questionText"
        class="mt-3 w-full resize-y rounded-lg border border-blue-100 bg-white px-3 py-2 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-blue-300"
        rows="2"
        placeholder="补充说明（可选）：也可只填写文字不选候选项"
      />

      <!-- 已作答：所选 + 补充，只读展示 -->
      <div v-if="card.answer" class="mt-3 space-y-1 rounded-lg bg-white/60 px-3 py-2">
        <p v-if="card.answer.selectedLabels.length" class="text-sm text-gray-800">
          <span class="text-xs text-gray-500">所选：</span>{{ card.answer.selectedLabels.join('、') }}
        </p>
        <p v-if="card.answer.text" class="whitespace-pre-wrap text-sm text-gray-800">
          <span class="text-xs text-gray-500">补充：</span>{{ card.answer.text }}
        </p>
        <p v-if="card.answer.outcome === 'cancelled'" class="text-xs text-gray-400">
          用户跳过了这个问题，Agent 已在不获得答案的情况下继续。
        </p>
      </div>

      <!-- 中断提示（计划「停止、异常与刷新」：不自动恢复原工具调用或续跑） -->
      <p
        v-if="isInterrupted"
        class="mt-3 rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-500"
      >
        等待已中断，此问题不能再提交。请继续发送消息让 Agent 接着处理。
      </p>

      <!-- 操作区：提交回答（主）/ 跳过问题（次）；无选择也无文本时禁用提交 -->
      <div v-if="isInteractive" class="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          class="cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:bg-white hover:text-gray-700"
          title="跳过：Agent 将在不获得答案的情况下调整后续处理"
          @click="handleSkip"
        >
          跳过问题
        </button>
        <button
          type="button"
          class="cursor-pointer rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!canSubmit || chatStore.isSubmittingAnswer"
          title="提交回答（至少选择一个候选项或填写补充说明）"
          @click="handleSubmit"
        >
          提交回答
        </button>
      </div>
    </div>
  </div>
</template>
