<script setup lang="ts">
import { computed } from 'vue'
import type { ProcessGroupItem, SubagentGroupItem } from '../../stores/chat-render'

/**
 * 任务组折叠（文档 3 S4）：一轮任务的过程消息（context-summary / 工具行 / 中间 assistant 文本）
 * 默认整体折叠成一行计数摘要；永不折叠的白名单成员（user / 最终回答 / change-summary / error）
 * 由父级渲染序列直接排布，不进本组件。子项经默认插槽注入（包裹容器实现折叠）。
 *
 * 子代理嵌套形态（园丁任务组）：group 带 label 时组头显示「标签 · N 次工具调用」，
 * 传 nested 获得一层缩进——嵌套组渲染在轮过程组的插槽内部。
 */
const props = defineProps<{
  group: ProcessGroupItem | SubagentGroupItem
  nested?: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle', id: string, expanded: boolean): void
}>()

const titleText = computed(() => {
  const base = `${props.group.toolCallCount} 次工具调用`
  if (props.group.kind === 'subagent-group') {
    return `${props.group.label} · ${base}`
  }
  return props.group.messageCount > 0 ? `${base} · ${props.group.messageCount} 条过程消息` : base
})

function toggle() {
  emit('toggle', props.group.id, props.group.collapsed)
}

/** Ctrl+F 命中折叠内容时浏览器在 until-found 元素上发 beforematch：自动展开（dsh 同款） */
function revealOnMatch() {
  if (props.group.collapsed) {
    emit('toggle', props.group.id, true)
  }
}
</script>

<template>
  <div class="my-1" :class="nested ? 'ml-4' : ''">
    <button
      type="button"
      class="flex h-6 w-full items-center gap-2 rounded px-1 text-left text-xs transition-colors hover:bg-gray-50 hover:text-gray-600"
      :class="nested ? 'text-emerald-600/80 hover:text-emerald-700' : 'text-gray-400'"
      :title="group.collapsed ? '展开过程' : '收起过程'"
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
      <span class="truncate">{{ titleText }}</span>
    </button>

    <!-- 折叠容器：hidden="until-found" 隐藏但不卸载，浏览器 Ctrl+F 可搜到折叠内容，
         命中时 beforematch 自动展开；不支持的浏览器（Safari <17.4）退化为普通 hidden，
         与旧的 display:none 行为一致。必须用 .attr 强制属性绑定：hidden 是 DOM 布尔
         property，默认绑定会把 'until-found' 强转为 true，丢失可搜索语义 -->
    <div
      :hidden.attr="group.collapsed ? 'until-found' : undefined"
      class="ml-4 space-y-1 border-l border-gray-100 pl-2"
      @beforematch="revealOnMatch"
    >
      <slot />
    </div>
  </div>
</template>
