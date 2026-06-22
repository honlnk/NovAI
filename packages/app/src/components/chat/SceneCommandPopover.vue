<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
const highlightIndex = ref(0)

/** query 或列表变化时重置高亮到第一项 */
watch(
  () => [props.query, props.scenes.length] as const,
  () => {
    highlightIndex.value = 0
  },
)

defineExpose({
  /** 键盘 ↑：高亮上移（循环） */
  moveUp() {
    if (filteredScenes.value.length === 0) return
    highlightIndex.value = (highlightIndex.value - 1 + filteredScenes.value.length) % filteredScenes.value.length
  },
  /** 键盘 ↓：高亮下移（循环） */
  moveDown() {
    if (filteredScenes.value.length === 0) return
    highlightIndex.value = (highlightIndex.value + 1) % filteredScenes.value.length
  },
  /** 键盘 Enter：选中当前高亮项 */
  confirm() {
    const scene = filteredScenes.value[highlightIndex.value]
    if (scene) emit('select', scene.path)
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
    <ul v-if="filteredScenes.length > 0" class="max-h-72 overflow-y-auto px-1.5 py-1.5">
      <li v-for="(scene, index) in filteredScenes" :key="scene.path">
        <button
          type="button"
          :class="[
            'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors',
            index === highlightIndex ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50',
          ]"
          @click="emit('select', scene.path)"
        >
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-50 text-xs text-blue-400">M↓</span>
          <span class="min-w-0 flex-1">
            <span class="align-baseline text-sm font-semibold leading-5">{{ displayName(scene.name) }}</span>
            <span class="ml-2 align-baseline text-xs font-medium text-gray-400">{{ displayDirectory(scene.path) }}</span>
          </span>
          <span
            v-if="scene.path === activeScenePath"
            class="shrink-0 text-xs text-emerald-400"
            title="当前激活"
          >●</span>
        </button>
      </li>
    </ul>
    <div v-else class="px-4 py-6 text-center text-xs font-medium text-gray-400">
      {{ query ? '没有匹配的场景' : '暂无场景提示词' }}
    </div>
    <div class="flex items-center gap-2.5 border-t border-gray-100 px-4 py-3 text-xs font-semibold text-gray-400">
      <span class="flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] text-gray-500">i</span>
      <span>输入内容以搜索场景</span>
    </div>
  </div>
</template>
