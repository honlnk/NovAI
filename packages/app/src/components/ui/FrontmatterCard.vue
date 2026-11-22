<script lang="ts">
import { reactive } from 'vue'

/**
 * 同路径展开态记忆（文件预览卡片化计划 Step 2）：跨实例共享，切换文件后返回
 * 保持原状；模块级 reactive Map，path 缺省时组件退化为本地 ref。
 */
const expandedByPath = reactive(new Map<string, boolean>())
</script>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { parseFrontmatterDisplay, type FrontmatterField } from '../../utils/frontmatter-display'

/**
 * frontmatter 属性卡片（文件预览卡片化计划 Step 2）：折叠条默认一行
 * （标题 + tags chips + 「N 个字段」），点击展开完整属性网格。呈现与
 * 会话定稿原型一致（方向 C + 标签替代类型徽标）；frontmatter 主要供
 * AI 与工具消费，折叠让正文第一时间可见。
 */
const props = defineProps<{
  /** frontmatter 围栏全文（含两行分隔线），来自 markdown-blocks 的特殊块 */
  raw: string
  /** 展开态记忆键（文件路径）；缺省时退化为本地状态 */
  path?: string
}>()

const expandedLocal = ref(false)
const expanded = computed({
  get: () => (props.path ? (expandedByPath.get(props.path) ?? false) : expandedLocal.value),
  set: (next: boolean) => {
    if (props.path) {
      expandedByPath.set(props.path, next)
    } else {
      expandedLocal.value = next
    }
  },
})
function toggle() {
  expanded.value = !expanded.value
}

const fields = computed<FrontmatterField[]>(() => parseFrontmatterDisplay(props.raw))

function scalarValue(field: FrontmatterField): string | null {
  return typeof field.value === 'string' ? field.value : null
}

/** 标题：首个非空标量的 name / id，兜底首个非空标量值 */
const title = computed(() => {
  for (const key of ['name', 'id']) {
    const field = fields.value.find((item) => item.key === key)
    const value = field ? scalarValue(field) : null
    if (value) return value
  }
  for (const field of fields.value) {
    const value = scalarValue(field)
    if (value) return value
  }
  return '（无标题）'
})

/** tags chips：首个非空数组字段（技能/要素约定为 tags；其余数组键同样成立） */
const tagList = computed<string[]>(() => {
  const field = fields.value.find((item) => Array.isArray(item.value) && item.value.length > 0)
  return field && Array.isArray(field.value) ? field.value : []
})

/** 摘要截断：仅无 tags 时展示（一行装不下两样），取首个非空长值 */
const SNIP_KEYS = ['summary', 'description', 'when_to_use']
const SNIP_MAX = 42
const snip = computed(() => {
  if (tagList.value.length > 0) return ''
  for (const key of SNIP_KEYS) {
    const field = fields.value.find((item) => item.key === key)
    const value = field ? scalarValue(field) : null
    if (value) {
      const text = value.replace(/\n/g, ' ')
      return text.length > SNIP_MAX ? `${text.slice(0, SNIP_MAX)}…` : text
    }
  }
  return ''
})
</script>

<template>
  <div
    v-if="fields.length > 0"
    class="mb-5 overflow-hidden rounded-lg border border-gray-200"
    data-testid="frontmatter-card"
  >
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-2 text-left transition-colors hover:bg-gray-50"
      :aria-expanded="expanded"
      data-testid="frontmatter-bar"
      @click="toggle"
    >
      <svg
        class="shrink-0 text-gray-400 transition-transform"
        :class="expanded ? 'rotate-90' : ''"
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M6 4l4 4-4 4" />
      </svg>
      <span class="shrink-0 text-[13px] font-semibold text-gray-900">{{ title }}</span>
      <span v-if="tagList.length > 0" class="flex min-w-0 flex-wrap gap-1">
        <span
          v-for="tag in tagList"
          :key="tag"
          class="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs leading-none text-gray-800"
        >{{ tag }}</span>
      </span>
      <span v-else-if="snip" class="min-w-0 flex-1 text-xs leading-normal text-gray-600">{{ snip }}</span>
      <span class="ml-auto shrink-0 text-xs text-gray-500">{{ fields.length }} 个字段</span>
    </button>
    <div v-if="expanded" class="flex flex-col gap-2 px-3 pb-3 pt-1" data-testid="frontmatter-grid">
      <div
        v-for="field in fields"
        :key="field.key"
        class="grid grid-cols-[104px_1fr] items-baseline gap-3 sm:grid-cols-[136px_1fr]"
      >
        <span class="break-all font-mono text-xs text-gray-600">{{ field.key }}</span>
        <span
          v-if="Array.isArray(field.value)"
          class="flex flex-wrap gap-1 text-sm leading-relaxed"
        >
          <span
            v-for="tag in field.value"
            :key="tag"
            class="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs leading-none text-gray-800"
          >{{ tag }}</span>
          <span v-if="field.value.length === 0" class="text-sm text-gray-600">—</span>
        </span>
        <span
          v-else
          class="whitespace-pre-line break-words text-sm leading-relaxed"
          :class="field.value === '' ? 'text-gray-600' : 'text-gray-800'"
        >{{ field.value === '' ? '—' : field.value }}</span>
      </div>
    </div>
  </div>
</template>
