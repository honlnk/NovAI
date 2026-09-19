<script setup lang="ts">
import type { ProcessGroupItem } from '../../stores/chat-render'

/**
 * 任务组折叠（文档 3 S4）：一轮任务的过程消息（context-summary / 工具行 / 中间 assistant 文本）
 * 默认整体折叠成一行计数摘要；永不折叠的白名单成员（user / 最终回答 / change-summary / error）
 * 由父级渲染序列直接排布，不进本组件。子项经默认插槽注入（包裹容器实现折叠）。
 */
const props = defineProps<{
  group: ProcessGroupItem
}>()

const emit = defineEmits<{
  (e: 'toggle', id: string, expanded: boolean): void
}>()

function toggle() {
  emit('toggle', props.group.id, props.group.collapsed)
}
</script>

<template>
  <div class="my-1">
    <button
      type="button"
      class="flex h-6 w-full items-center gap-2 rounded px-1 text-left text-xs text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600"
      :title="group.collapsed ? '展开本轮过程' : '收起本轮过程'"
      @click="toggle"
    >
      <svg
        class="h-3 w-3 shrink-0 transition-transform"
        :class="group.collapsed ? '' : 'rotate-90'"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
      </svg>
      <span class="truncate">
        {{ group.toolCallCount }} 次工具调用<span v-if="group.messageCount > 0"> · {{ group.messageCount }} 条过程消息</span>
      </span>
    </button>

    <!-- 折叠容器：收起即 display:none，浏览器 Ctrl+F 搜不到折叠内容；要搜先展开 -->
    <div v-show="!group.collapsed" class="ml-4 space-y-1 border-l border-gray-100 pl-2">
      <slot />
    </div>
  </div>
</template>
