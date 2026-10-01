<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ProjectFileNodeView } from '@novai/core/services/types'

/**
 * 大纲指令弹层（R4）。
 *
 * 输入框输入 @ 后弹出，列出 prompts/outlines/ 下的写作大纲供单选激活。
 * 专用组件（单选锚定弹层；多选形态已由园丁任务弹窗承接，要素整理参数化 W4）。
 *
 * 键盘导航由父组件（ChatPanel）在 keydown 时调用 moveUp/moveDown/confirm/cancel；
 * 鼠标点击直接选中。
 */
const props = defineProps<{
  /** 写作大纲列表（prompts/outlines/*.md） */
  outlines: ProjectFileNodeView[]
  /** 当前激活的大纲路径，列表中高亮标记 */
  activeOutlinePath: string | null
  /** 筛选词（@ 后用户输入的文字） */
  query: string
}>()

const emit = defineEmits<{
  /** 选中大纲（path） */
  select: [path: string]
  /** 关闭弹层（Esc / 失焦 / 选中后） */
  close: []
}>()

/** 按 query 过滤大纲名称（不区分大小写，去 .md 扩展名匹配） */
const filteredOutlines = computed(() => {
  const q = props.query.trim().toLowerCase()
  if (!q) return props.outlines
  return props.outlines.filter((s) => s.name.replace(/\.md$/i, '').toLowerCase().includes(q))
})

/** 当前高亮项索引（仅键盘导航用） */
const highlightIndex = ref(0)

/** query 或列表变化时重置高亮到第一项 */
watch(
  () => [props.query, props.outlines.length] as const,
  () => {
    highlightIndex.value = 0
  },
)

defineExpose({
  /** 键盘 ↑：高亮上移（循环） */
  moveUp() {
    if (filteredOutlines.value.length === 0) return
    highlightIndex.value = (highlightIndex.value - 1 + filteredOutlines.value.length) % filteredOutlines.value.length
  },
  /** 键盘 ↓：高亮下移（循环） */
  moveDown() {
    if (filteredOutlines.value.length === 0) return
    highlightIndex.value = (highlightIndex.value + 1) % filteredOutlines.value.length
  },
  /** 键盘 Enter：选中当前高亮项 */
  confirm() {
    const outline = filteredOutlines.value[highlightIndex.value]
    if (outline) emit('select', outline.path)
  },
})

function displayName(name: string): string {
  return name.replace(/\.md$/i, '')
}

function displayDirectory(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.length > 0 ? `${parts.join('/')}/` : ''
}
</script>

<template>
  <div
    class="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[min(360px,56vh)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg shadow-gray-900/10 ring-1 ring-gray-900/5"
  >
    <ul v-if="filteredOutlines.length > 0" class="max-h-72 overflow-y-auto px-1.5 py-1.5">
      <li v-for="(outline, index) in filteredOutlines" :key="outline.path">
        <button
          type="button"
          :class="[
            'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors',
            index === highlightIndex ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50',
          ]"
          @click="emit('select', outline.path)"
        >
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-50 text-xs text-blue-400">M↓</span>
          <span class="min-w-0 flex-1">
            <span class="align-baseline text-sm font-semibold leading-5">{{ displayName(outline.name) }}</span>
            <span class="ml-2 align-baseline text-xs font-medium text-gray-400">{{ displayDirectory(outline.path) }}</span>
          </span>
          <span
            v-if="outline.path === activeOutlinePath"
            class="shrink-0 text-xs text-emerald-400"
            title="当前激活"
          >●</span>
        </button>
      </li>
    </ul>
    <div v-else class="px-4 py-6 text-center text-xs font-medium text-gray-400">
      {{ query ? '没有匹配的大纲' : '暂无写作大纲' }}
    </div>
    <div class="flex items-center gap-2.5 border-t border-gray-100 px-4 py-3 text-xs font-semibold text-gray-400">
      <span class="flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] text-gray-500">i</span>
      <span>输入内容以搜索大纲</span>
    </div>
  </div>
</template>
