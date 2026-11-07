<script setup lang="ts">
import { computed } from 'vue'
import type { ChatMessageView } from '@novai/core/services/types'

import { useChatStore } from '../../stores/chat'
import AppIcon from '../ui/AppIcon.vue'

/**
 * 主动提问卡（AskUserQuestion 工具调用在消息流里的只读记录，交互优化计划 §8）：
 * 可交互作答已迁至输入区接管（QuestionTakeover）——卡片只承担三种历史态：
 * - 已作答（answer 存在）：只读展示所选与补充说明；
 * - 等待回答（questionId 命中当前挂起请求）：不可交互，指引到下方输入区；
 * - 等待已中断（无 answer 且不在挂起快照——典型为页面刷新后）：提示继续发消息。
 */
const props = defineProps<{
  message: ChatMessageView
}>()

const chatStore = useChatStore()

const card = computed(() =>
  props.message.kind === 'ask-user-question' ? props.message : null,
)

// 等待中：这张卡就是当前挂起的那个问题（作答入口在下方输入区接管面板）
const isPendingHere = computed(
  () => !!card.value
    && !card.value.answer
    && chatStore.pendingQuestion?.questionId === card.value.questionId,
)
// 中断态：无 answer 且已不在挂起快照（刷新/停止/异常后 core 不恢复等待）
const isInterrupted = computed(
  () => !!card.value && !card.value.answer && !isPendingHere.value,
)
</script>

<template>
  <div v-if="card" class="w-full text-left">
    <div class="rounded-lg border border-blue-200 bg-blue-50/60 p-4">
      <!-- 标题行：短标题（若有）+ 状态徽标 -->
      <div class="mb-2 flex items-center gap-2">
        <AppIcon name="circle-help" :size="16" class="h-4 w-4 shrink-0 text-blue-500" />
        <span v-if="card.header" class="text-xs font-medium text-blue-700">{{ card.header }}</span>
        <span
          v-if="isPendingHere"
          class="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700"
        >等待回答 · 请在下方输入区作答</span>
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

      <!-- 候选项：只读记录——所选候选项高亮，其余淡显 -->
      <div v-if="card.options?.length" class="mt-3 space-y-1.5">
        <div
          v-for="option in card.options"
          :key="option.label"
          class="flex items-start gap-2.5 rounded-lg border px-3 py-2"
          :class="card.answer?.selectedLabels.includes(option.label)
            ? 'border-blue-200 bg-white/80'
            : 'border-transparent bg-white/40'"
        >
          <span
            class="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border"
            :class="card.answer?.selectedLabels.includes(option.label)
              ? 'border-blue-500 bg-blue-500'
              : 'border-gray-300 bg-transparent'"
          />
          <span>
            <span class="text-sm text-gray-800">{{ option.label }}</span>
            <span v-if="option.description" class="ml-1.5 text-xs text-gray-500">{{ option.description }}</span>
          </span>
        </div>
      </div>

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
    </div>
  </div>
</template>
