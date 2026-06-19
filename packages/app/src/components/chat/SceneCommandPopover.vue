<script setup lang="ts">
import { computed, watch } from 'vue'
import type { ProjectFileNodeView } from '@novai/core/services/types'

/**
 * 场景指令弹层（R4）。
 *
 * 输入框输入 @ 后弹出，列出 prompts/scenes/ 下的场景提示词供单选激活。
 * 专用组件，不与 R6 的 /提取要素 多选弹层共用（交互差异大）。
 *
 * 键盘导航由父组件（ChatPanel）在 keydown 时调用 moveUp/moveDown/confirm/cancel；
 * 鼠标点击直接选中。
 */
const props = defineProps<{
  /** 场景提示词列表（prompts/scenes/*.md） */
  scenes: ProjectFileNodeView[]
  /** 当前激活的场景路径，列表中高亮标记 */
  activeScenePath: string | null
  /** 筛选词（@ 后用户输入的文字） */
  query: string
}>()

const emit = defineEmits<{
  /** 选中场景（path） */
  select: [path: string]
  /** 关闭弹层（Esc / 失焦 / 选中后） */
  close: []
}>()

/** 按 query 过滤场景名称（不区分大小写，去 .md 扩展名匹配） */
const filteredScenes = computed(() => {
  const q = props.query.trim().toLowerCase()
  if (!q) return props.scenes
  return props.scenes.filter((s) => s.name.replace(/\.md$/i, '').toLowerCase().includes(q))
})

/** 当前高亮项索引（仅键盘导航用） */
let highlightIndex = 0

/** query 或列表变化时重置高亮到第一项 */
watch(
  () => [props.query, props.scenes.length] as const,
  () => {
    highlightIndex = 0
  },
)

defineExpose({
  /** 键盘 ↑：高亮上移（循环） */
  moveUp() {
    if (filteredScenes.value.length === 0) return
    highlightIndex = (highlightIndex - 1 + filteredScenes.value.length) % filteredScenes.value.length
  },
  /** 键盘 ↓：高亮下移（循环） */
  moveDown() {
    if (filteredScenes.value.length === 0) return
    highlightIndex = (highlightIndex + 1) % filteredScenes.value.length
  },
  /** 键盘 Enter：选中当前高亮项 */
  confirm() {
    const scene = filteredScenes.value[highlightIndex]
    if (scene) emit('select', scene.path)
  },
})

function displayName(name: string): string {
  return name.replace(/\.md$/i, '')
}
</script>

<template>
  <div
    class="absolute bottom-full left-0 z-50 mb-1 w-64 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
  >
    <ul v-if="filteredScenes.length > 0" class="max-h-60 overflow-y-auto py-1">
      <li v-for="(scene, index) in filteredScenes" :key="scene.path">
        <button
          type="button"
          :class="[
            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
            index === highlightIndex ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50',
          ]"
          @click="emit('select', scene.path)"
        >
          <span class="shrink-0">🎬</span>
          <span class="flex-1 truncate">{{ displayName(scene.name) }}</span>
          <span
            v-if="scene.path === activeScenePath"
            class="shrink-0 text-xs text-green-500"
            title="当前激活"
          >●</span>
        </button>
      </li>
    </ul>
    <div v-else class="px-3 py-4 text-center text-xs text-gray-400">
      {{ query ? '没有匹配的场景' : '暂无场景提示词' }}
    </div>
  </div>
</template>
