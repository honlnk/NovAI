<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

/**
 * Markdown 代码围栏块（借鉴 dsh CodeBlock）：暗色代码块顶部一条栏，左语言名、右「复制」。
 * 复制的是围栏内原文（不含围栏行与结尾换行）；代码本体仍渲染 markdown-it 产出的 html，
 * 样式沿用 MarkdownRenderer 的全局 pre 规则。
 */
const props = defineProps<{
  /** 该顶层块的 html（pre/code，来自 parseMarkdownBlocks） */
  html: string
  /** 围栏内原文（markdown-it 的围栏内容，带结尾换行；流式中未闭合的围栏没有） */
  code: string
  /** 语言名：围栏信息串首词，没写语言则缺省 */
  lang?: string
}>()

/** 「已复制」停留时长：与本地命令详情的复制按钮（MessageItem）同口径 */
const COPIED_FEEDBACK_MS = 1500

const copied = ref(false)
let restoreTimer: ReturnType<typeof setTimeout> | undefined

async function copy() {
  // 「已复制」窗口内的连点忽略，不重置计时
  if (copied.value) return
  // 没有剪贴板 API（非安全上下文等）：不装作复制成功，用户仍可手动选择代码复制
  if (!navigator.clipboard) return
  try {
    await navigator.clipboard.writeText(props.code.replace(/\n$/, ''))
    copied.value = true
    restoreTimer = setTimeout(() => (copied.value = false), COPIED_FEEDBACK_MS)
  } catch {
    // 剪贴板不可用（权限拒绝等）：静默
  }
}

onBeforeUnmount(() => clearTimeout(restoreTimer))
</script>

<template>
  <div class="md-code-block relative">
    <!-- 工具栏浮在 pre 自己的顶部留白上（不另画底色）；它在 pre 的滚动容器之外，代码横向滚动时不动 -->
    <div class="pointer-events-none absolute inset-x-0 top-0 flex h-7 items-center justify-between gap-3 px-4">
      <span v-if="lang" class="min-w-0 truncate font-mono text-xs text-gray-400">{{ lang }}</span>
      <button
        type="button"
        class="pointer-events-auto -my-1.5 ml-auto shrink-0 cursor-pointer px-1.5 py-1.5 text-xs transition-colors"
        :class="copied ? 'text-green-400' : 'text-gray-400 hover:text-white'"
        :aria-label="copied ? '已复制' : '复制代码'"
        @click="copy"
      >{{ copied ? '已复制' : '复制' }}</button>
    </div>
    <div v-html="html" />
  </div>
</template>

<style scoped>
/* 代码本体由 v-html 注入、拿不到 scoped 属性：加高 pre 的顶部留白，让出工具栏的位置 */
.md-code-block :deep(pre) {
  padding-top: 2.25rem;
}
</style>
