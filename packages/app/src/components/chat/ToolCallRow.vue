<script setup lang="ts">
import { computed, ref } from 'vue'

import type { ToolRowItem } from '../../stores/chat-render'
import AppIcon from '../ui/AppIcon.vue'

/**
 * 工具行合一（文档 3 S4）：一次工具调用从头到尾只占一行——
 * 调用时转圈，结果回来原地变结果。点击展开显示结果全文。
 */
const props = defineProps<{
  item: ToolRowItem
}>()

const expanded = ref(false)

const pending = computed(() => !props.item.result)
const failed = computed(() => props.item.result?.ok === false)
const toolName = computed(() => props.item.call?.toolName ?? props.item.result?.toolName)
const inputSummary = computed(() => props.item.call?.text ?? '')
const resultText = computed(() => props.item.result?.text ?? '')

/** 失败行摘要换成错误首行（result text 本身是错误摘要，取首行展示） */
const summaryLine = computed(() => {
  if (failed.value && resultText.value) {
    return resultText.value.split('\n')[0]
  }
  return inputSummary.value
})
</script>

<template>
  <div class="group/tool-row text-sm">
    <button
      type="button"
      class="flex h-6 w-full items-center gap-2 rounded px-1 text-left text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
      :title="item.result ? '点击展开/收起结果' : '执行中...'"
      @click="item.result && (expanded = !expanded)"
    >
      <!-- 状态图标：调用中转圈 / 成功勾 / 失败叉 -->
      <AppIcon v-if="pending" name="loader-circle" :size="14" class="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
      <AppIcon name="check" :size="14" class="h-3.5 w-3.5 shrink-0 text-green-500" v-else-if="!failed" />
      <AppIcon name="x" :size="14" class="h-3.5 w-3.5 shrink-0 text-red-500" v-else />

      <span class="shrink-0 font-medium">{{ toolName }}</span>
      <span class="min-w-0 flex-1 truncate">{{ summaryLine }}</span>
      <AppIcon name="chevron-right" :size="12" class="h-3 w-3 shrink-0 transition-transform" :class="expanded ? 'rotate-90' : ''" v-if="item.result" />
    </button>

    <!-- 展开区：结果全文 -->
    <pre
      v-if="expanded && resultText"
      class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600"
    >{{ resultText }}</pre>
  </div>
</template>
