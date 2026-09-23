<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'

import { createReasoningCollapseState } from './reasoning-collapse'

const props = defineProps<{
  /** 思考流文本（纯文本渲染，不走 markdown） */
  reasoning: string
  /** 思考进行中（流式且正文未开始）：自动展开 + 「思考中…」呼吸态；正文开始自动收起 */
  thinking?: boolean
}>()

const state = createReasoningCollapseState()
const expanded = computed(() => state.expanded(props.thinking ?? false))

function toggle() {
  state.toggle(expanded.value)
}

// 思考中自动滚到底（流式追加的新内容保持在视野内）；收起/历史态不抢滚动
const bodyRef = ref<HTMLElement | null>(null)
watch(
  () => props.reasoning.length,
  async () => {
    if (!(props.thinking ?? false)) {
      return
    }
    await nextTick()
    const el = bodyRef.value
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  },
)
</script>

<template>
  <div
    v-if="reasoning"
    class="mb-2"
  >
    <button
      type="button"
      class="flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-gray-600"
      :aria-expanded="expanded"
      @click="toggle"
    >
      <svg
        class="h-3 w-3 shrink-0 transition-transform"
        :class="expanded ? 'rotate-90' : ''"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M9 5l7 7-7 7"
        />
      </svg>
      <span :class="thinking ? 'animate-pulse' : ''">{{
        thinking ? '思考中…' : `已深度思考（${reasoning.length} 字）`
      }}</span>
    </button>
    <div
      v-if="expanded"
      ref="bodyRef"
      class="mt-1.5 max-h-48 overflow-y-auto border-l-2 border-gray-200 pl-2.5"
    >
      <pre class="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-gray-400">{{ reasoning }}</pre>
    </div>
  </div>
</template>
