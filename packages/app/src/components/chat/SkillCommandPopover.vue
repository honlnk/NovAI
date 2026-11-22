<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { SkillView } from '@novai/core/services/types'
import AppIcon from '../ui/AppIcon.vue'

/**
 * `#技能` 点名弹层（技能包 UI/UX 施工计划 §3.3，与 @大纲弹层、/斜杠菜单同构）。
 *
 * 列出合格技能（broken 不出现）的名称与一句描述，筛选词过滤名称与描述；
 * 无技能时显示「还没有技能」引导。键盘导航由父组件（ChatPanel）在 keydown 时
 * 调用 moveUp/moveDown/confirm；鼠标点击直接选中。
 */
const props = defineProps<{
  /** 合格技能列表（broken 不传入） */
  skills: SkillView[]
  /** 筛选词（# 后用户输入的文字） */
  query: string
}>()

const emit = defineEmits<{
  /** 选中技能（名称——文件夹名即身份） */
  select: [name: string]
  /** 关闭弹层（Esc / 选中后） */
  close: []
}>()

/** 按 query 过滤技能（名称与描述，不区分大小写；displayName 参与名称匹配） */
const filteredSkills = computed(() => {
  const q = props.query.trim().toLowerCase()
  if (!q) return props.skills
  return props.skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(q)
      || (skill.displayName?.toLowerCase().includes(q) ?? false)
      || skill.description.toLowerCase().includes(q),
  )
})

/** 当前高亮项索引（仅键盘导航用） */
const highlightIndex = ref(0)

/** query 或列表变化时重置高亮到第一项 */
watch(
  () => [props.query, props.skills.length] as const,
  () => {
    highlightIndex.value = 0
  },
)

defineExpose({
  /** 键盘 ↑：高亮上移（循环） */
  moveUp() {
    if (filteredSkills.value.length === 0) return
    highlightIndex.value = (highlightIndex.value - 1 + filteredSkills.value.length) % filteredSkills.value.length
  },
  /** 键盘 ↓：高亮下移（循环） */
  moveDown() {
    if (filteredSkills.value.length === 0) return
    highlightIndex.value = (highlightIndex.value + 1) % filteredSkills.value.length
  },
  /** 键盘 Enter：选中当前高亮项 */
  confirm() {
    const skill = filteredSkills.value[highlightIndex.value]
    if (skill) emit('select', skill.name)
  },
})
</script>

<template>
  <div
    class="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[min(360px,56vh)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg shadow-gray-900/10 ring-1 ring-gray-900/5"
    data-testid="skill-popover"
  >
    <ul v-if="filteredSkills.length > 0" class="max-h-72 overflow-y-auto px-1.5 py-1.5">
      <li v-for="(skill, index) in filteredSkills" :key="skill.name">
        <button
          type="button"
          :class="[
            'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors',
            index === highlightIndex ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50',
          ]"
          :data-testid="`skill-popover-item-${skill.name}`"
          @click="emit('select', skill.name)"
        >
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-400">
            <AppIcon name="sparkles" :size="14" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="align-baseline text-sm font-semibold leading-5">{{ skill.name }}</span>
            <span class="ml-2 align-baseline text-xs text-gray-400 line-clamp-1">{{ skill.description }}</span>
          </span>
        </button>
      </li>
    </ul>
    <!-- 无技能 / 无匹配：给出去哪获取的指引（§3.3） -->
    <div v-else class="px-4 py-6 text-center text-xs font-medium text-gray-400">
      {{ props.skills.length === 0 ? '还没有技能，可在左侧「技能」中新建或导入' : '没有匹配的技能' }}
    </div>
    <div class="flex items-center gap-2.5 border-t border-gray-100 px-4 py-3 text-xs font-semibold text-gray-400">
      <AppIcon name="info" :size="14" class="text-gray-500" />
      <span>输入内容以搜索技能；选中后本条消息将点名加载该技能</span>
    </div>
  </div>
</template>
