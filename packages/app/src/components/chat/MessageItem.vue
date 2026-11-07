<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ChatMessageView } from '@novai/core/services/types'

import MarkdownRenderer from '../ui/MarkdownRenderer.vue'
import AskUserQuestionCard from './AskUserQuestionCard.vue'
import ReasoningCollapse from './ReasoningCollapse.vue'
import TurnChangesPanel from './TurnChangesPanel.vue'

const props = defineProps<{
  message: ChatMessageView
  /** 该消息正在流式输出中（渲染「生成中」光标） */
  streaming?: boolean
  /** change-summary：是否最新一轮（最新面板默认展开文件列表） */
  newestChangeSummary?: boolean
}>()

function formatTime(dateStr: string) {
  const date = new Date(dateStr)
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// ---------- 本地命令状态行（§3.2）：状态徽章 + 失败详情展开/复制 ----------

/** 状态徽章文案与配色：完成绿、未执行灰（主动取消或无变化不是错误）、失败红 */
const outcomeMeta = computed(() => {
  if (props.message.role === 'system' && props.message.kind === 'local-command') {
    if (props.message.outcome === 'completed') {
      return { label: '已完成', class: 'bg-green-100 text-green-700' }
    }
    if (props.message.outcome === 'noop') {
      return { label: '未执行', class: 'bg-gray-200 text-gray-600' }
    }
    return { label: '失败', class: 'bg-red-100 text-red-700' }
  }
  return { label: '', class: '' }
})

const canExpand = computed(() =>
  props.message.role === 'system' && props.message.kind === 'local-command' && !!props.message.detail,
)
const detailExpanded = ref(false)
const copied = ref(false)

async function copyDetail() {
  if (!(props.message.role === 'system' && props.message.kind === 'local-command' && props.message.detail)) {
    return
  }
  try {
    await navigator.clipboard.writeText(props.message.detail)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    // 剪贴板不可用（权限拒绝等）：静默，用户仍可手动选择文本复制
  }
}
</script>

<template>
  <!-- 用户消息：右对齐气泡，去头像（dsh 风） -->
  <div
    v-if="message.role === 'user'"
    class="flex justify-end"
  >
    <div class="max-w-[80%] rounded-lg rounded-tr-none bg-blue-600 px-4 py-2.5">
      <!-- 引用块：选中内容作为独立引用展示在正文上方 -->
      <div
        v-if="message.quote"
        class="mb-2 border-l-2 border-blue-300 bg-blue-500/40 py-1 pl-2 pr-1"
      >
        <p class="whitespace-pre-wrap text-xs text-blue-100">{{ message.quote }}</p>
      </div>
      <p class="whitespace-pre-wrap text-sm text-white">{{ message.displayLabel ?? message.text }}</p>
      <p class="mt-1 text-right text-xs text-blue-200">{{ formatTime(message.createdAt) }}</p>
    </div>
  </div>

  <!-- AI 消息：全宽左对齐纯 markdown，不套气泡框（dsh 风） -->
  <div
    v-else-if="message.role === 'assistant' && message.kind === 'text'"
    class="w-full text-left"
  >
    <!-- 思考流（reasoning 存在才渲染）：思考中自动展开呼吸态，正文开始自动收起为「已深度思考（N 字）」 -->
    <ReasoningCollapse
      v-if="message.reasoning"
      :reasoning="message.reasoning"
      :thinking="streaming && !message.text"
    />
    <!-- 思考中正文尚未开始（text 空且带 reasoning）时只渲染思考块，不出现空正文与光标 -->
    <div
      v-if="message.text || !message.reasoning"
      class="text-sm leading-relaxed text-gray-800"
    >
      <MarkdownRenderer :content="message.text" :streaming="streaming" />
      <span
        v-if="streaming"
        class="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm bg-gray-400 align-text-bottom"
        aria-label="正在生成"
      />
    </div>
  </div>

  <!-- 旧版完成总结（不再产生；旧会话按瘦行样式只读渲染） -->
  <div
    v-else-if="message.role === 'assistant' && message.kind === 'action-summary'"
    class="text-xs text-gray-400"
  >
    {{ message.text }}
  </div>

  <!-- 改动汇总面板（change-summary：本轮交付物，永不折叠进过程组） -->
  <TurnChangesPanel
    v-else-if="message.role === 'system' && message.kind === 'change-summary'"
    :message="message"
    :newest="newestChangeSummary"
  />

  <!-- 主动提问卡（AskUserQuestion 的交互主体，永不折叠进过程组；三态：待回答/已作答/等待已中断） -->
  <AskUserQuestionCard
    v-else-if="message.role === 'system' && message.kind === 'ask-user-question'"
    :message="message"
  />

  <!-- 本地命令状态行（§3.2：图标 + 命令名 + 状态的紧凑行；失败可展开详情并复制） -->
  <div
    v-else-if="message.role === 'system' && message.kind === 'local-command'"
    class="flex justify-center"
  >
    <div class="w-[90%] max-w-[90%]">
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-left transition-colors"
        :class="canExpand ? 'cursor-pointer hover:bg-gray-100' : 'cursor-default'"
        :aria-expanded="canExpand ? detailExpanded : undefined"
        @click="canExpand && (detailExpanded = !detailExpanded)"
      >
        <!-- 展开箭头（仅有详情可展开时显示） -->
        <svg
          v-if="canExpand"
          class="h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform"
          :class="detailExpanded ? 'rotate-90' : ''"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
        <!-- 命令图标 -->
        <svg v-if="message.command === '/压缩上下文'" class="h-4 w-4 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7 7 7M12 3v12m-7 6h14" />
        </svg>
        <svg v-else class="h-4 w-4 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span class="shrink-0 text-xs font-medium text-gray-700">{{ message.command }}</span>
        <span
          class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-none"
          :class="outcomeMeta.class"
        >{{ outcomeMeta.label }}</span>
        <span class="min-w-0 flex-1 truncate text-xs text-gray-500" :title="message.text">{{ message.text }}</span>
      </button>

      <!-- 展开区：错误详情（内部滚动 + 可复制；不展示异常堆栈） -->
      <div v-if="canExpand && detailExpanded" class="rounded-b-lg border border-t-0 border-gray-100 bg-white px-3 py-2">
        <div class="flex items-start justify-between gap-2">
          <p class="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-gray-600">{{ message.detail }}</p>
          <button
            type="button"
            class="shrink-0 text-xs text-gray-400 transition-colors hover:text-blue-600"
            @click.stop="copyDetail"
          >
            {{ copied ? '已复制' : '复制' }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 轮次安全阀提示（turn-limit：达到 agentMaxTurns 上限，永不折叠进过程组） -->
  <div
    v-else-if="message.role === 'system' && message.kind === 'turn-limit'"
    class="flex justify-center"
  >
    <div class="max-w-[90%] rounded-lg bg-amber-50 px-4 py-2.5 text-amber-800">
      <div class="flex items-center gap-2">
        <svg class="h-4 w-4 shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        <span class="text-sm">{{ message.text }}</span>
      </div>
    </div>
  </div>

  <!-- 错误消息（永不折叠） -->
  <div
    v-else-if="message.role === 'system' && message.kind === 'error'"
    class="flex justify-center"
  >
    <div class="max-w-[90%] rounded-lg bg-red-50 px-4 py-2.5 text-red-800">
      <div class="flex items-center gap-2">
        <svg class="h-4 w-4 shrink-0 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-sm">{{ message.text }}</span>
      </div>
    </div>
  </div>

  <!-- 过程类系统消息（首条 user 之前的残留等，正常已进折叠组） -->
  <div
    v-else-if="message.role === 'system'"
    class="flex justify-center"
  >
    <div class="max-w-[90%] rounded-lg bg-gray-50 px-4 py-2.5 text-gray-600">
      <p class="text-sm">{{ message.text }}</p>
    </div>
  </div>
</template>
