<script setup lang="ts">
import { computed, watch } from 'vue'
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
let highlightIndex = 0

watch(
  () => props.query,
  () => {
    highlightIndex = 0
  },
)

defineExpose({
  moveUp() {
    if (filteredCommands.value.length === 0) return
    highlightIndex = (highlightIndex - 1 + filteredCommands.value.length) % filteredCommands.value.length
  },
  moveDown() {
    if (filteredCommands.value.length === 0) return
    highlightIndex = (highlightIndex + 1) % filteredCommands.value.length
  },
  confirm() {
    const command = filteredCommands.value[highlightIndex]
    if (command) emit('select', command.id)
  },
})
</script>

<template>
  <div
    class="absolute bottom-full left-0 z-50 mb-1 w-72 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
  >
    <div class="border-b border-gray-100 px-3 py-1.5">
      <p class="text-xs font-medium uppercase tracking-wide text-gray-400">命令</p>
    </div>
    <ul v-if="filteredCommands.length > 0" class="max-h-60 overflow-y-auto py-1">
      <li v-for="(command, index) in filteredCommands" :key="command.id">
        <button
          type="button"
          :class="[
            'flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors',
            index === highlightIndex ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50',
          ]"
          @click="emit('select', command.id)"
        >
          <span class="mt-0.5 shrink-0">{{ command.icon }}</span>
          <div class="min-w-0 flex-1">
            <p class="font-medium">{{ command.label }}</p>
            <p class="truncate text-xs text-gray-400">{{ command.description }}</p>
          </div>
        </button>
      </li>
    </ul>
    <div v-else class="px-3 py-4 text-center text-xs text-gray-400">
      没有匹配的命令
    </div>
  </div>
</template>
