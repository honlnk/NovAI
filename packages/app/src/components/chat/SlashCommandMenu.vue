<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { SLASH_COMMANDS, type SlashCommandId } from '../../constants/slash-commands'

/**
 * 斜杠命令菜单（R6）。
 *
 * 输入框输入 / 后弹出，列出可用斜杠命令（如 /提取要素）。
 * 选中后由父组件根据命令 id 展开对应的二级界面。
 * 与 @场景 弹层同构：单选 + 键盘导航（defineExpose moveUp/moveDown/confirm）。
 */
const props = defineProps<{
  /** 筛选词（/ 后用户输入的文字） */
  query: string
}>()

const emit = defineEmits<{
  /** 选中命令 */
  select: [id: SlashCommandId]
  /** 关闭（Esc / 失焦 / 选中后） */
  close: []
}>()

/** 按 query 过滤命令（匹配 label 或 description，不区分大小写） */
const filteredCommands = computed(() => {
  const q = props.query.trim().toLowerCase()
  if (!q) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter(
    (c) =>
      c.label.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q),
  )
})

/** 当前高亮项索引（键盘导航用） */
const highlightIndex = ref(0)

watch(
  () => props.query,
  () => {
    highlightIndex.value = 0
  },
)

defineExpose({
  moveUp() {
    if (filteredCommands.value.length === 0) return
    highlightIndex.value = (highlightIndex.value - 1 + filteredCommands.value.length) % filteredCommands.value.length
  },
  moveDown() {
    if (filteredCommands.value.length === 0) return
    highlightIndex.value = (highlightIndex.value + 1) % filteredCommands.value.length
  },
  confirm() {
    const command = filteredCommands.value[highlightIndex.value]
    if (command) emit('select', command.id)
  },
})
</script>

<template>
  <div
    class="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[min(340px,56vh)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg shadow-gray-900/10 ring-1 ring-gray-900/5"
  >
    <div class="px-4 pb-1.5 pt-3">
      <p class="text-xs font-semibold text-gray-400">命令</p>
    </div>
    <ul v-if="filteredCommands.length > 0" class="max-h-64 overflow-y-auto px-1.5 pb-1.5">
      <li v-for="(command, index) in filteredCommands" :key="command.id">
        <button
          type="button"
          :class="[
            'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors',
            index === highlightIndex ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50',
          ]"
          @click="emit('select', command.id)"
        >
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-50 text-sm">{{ command.icon }}</span>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold leading-5">{{ command.label }}</p>
            <p class="truncate text-xs font-medium text-gray-400">{{ command.description }}</p>
          </div>
        </button>
      </li>
    </ul>
    <div v-else class="px-4 py-6 text-center text-xs font-medium text-gray-400">
      没有匹配的命令
    </div>
    <div class="flex items-center gap-2.5 border-t border-gray-100 px-4 py-3 text-xs font-semibold text-gray-400">
      <span class="flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] text-gray-500">i</span>
      <span>输入内容以搜索命令</span>
    </div>
  </div>
</template>
