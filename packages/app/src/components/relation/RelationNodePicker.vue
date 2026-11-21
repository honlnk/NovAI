<script setup lang="ts">
/**
 * 关系节点选择器（关系图谱施工计划 §六）：按名称子串搜索引用索引里的要素
 * （旧时间线要素已被服务层过滤），选中后以稳定标识回传。
 *
 * 受控组件：modelValue = 要素稳定标识（空串 = 未选）；已选态展示由 label prop
 * 提供（父层从图视图解析，未解析时兜底显示标识本身）。
 */
import { computed, ref, watch } from 'vue'

import type { RelationElementOptionView } from '@novai/core/services/relation-service'
import type { ElementType } from '@novai/core/types/rag'

const props = withDefaults(
  defineProps<{
    modelValue: string
    /** 已选节点展示名（父层解析；缺省显示标识） */
    label?: string
    placeholder?: string
    /** 搜索过滤的要素类型 */
    typeFilter?: ElementType | ''
    /** 排除的标识（另一端已选时防自环） */
    excludeId?: string
    /** 只读态（冲突冻结等场景禁改端点） */
    disabled?: boolean
    /** 搜索函数由父层注入（store 绑定项目）；直接调用会导致组件测试耦合 pinia */
    search: (query: string, type?: ElementType) => Promise<RelationElementOptionView[]>
  }>(),
  {
    label: '',
    placeholder: '搜索要素名称',
    typeFilter: '',
    excludeId: '',
    disabled: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [id: string]
  /** 选中项的完整信息（父层缓存名称用） */
  select: [option: RelationElementOptionView]
}>()

const query = ref('')
const options = ref<RelationElementOptionView[]>([])
const open = ref(false)
const searching = ref(false)

let searchToken = 0

watch(query, async (value) => {
  const token = ++searchToken
  const text = value.trim()
  if (!text) {
    options.value = []
    return
  }
  searching.value = true
  try {
    const result = await props.search(text, props.typeFilter || undefined)
    if (token === searchToken) {
      options.value = result.filter((option) => option.id !== props.excludeId)
      open.value = true
    }
  } finally {
    if (token === searchToken) {
      searching.value = false
    }
  }
})

const displayLabel = computed(() => props.label || props.modelValue)

function choose(option: RelationElementOptionView) {
  emit('update:modelValue', option.id)
  emit('select', option)
  query.value = ''
  options.value = []
  open.value = false
}

function clearSelection() {
  emit('update:modelValue', '')
}

function onInputFocus() {
  if (options.value.length > 0) {
    open.value = true
  }
}

function onInputBlur() {
  setTimeout(() => {
    open.value = false
  }, 150)
}
</script>

<template>
  <div class="relative">
    <!-- 已选态：名称 + 清除；未选态：搜索输入 -->
    <div v-if="modelValue" class="flex items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5">
      <span class="min-w-0 truncate text-sm text-gray-800" :data-testid="`${placeholder}-selected`">{{ displayLabel }}</span>
      <button
        v-if="!disabled"
        type="button"
        aria-label="清除选择"
        class="shrink-0 rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        @click="clearSelection"
      >
        ×
      </button>
    </div>
    <template v-else>
      <input
        v-model="query"
        type="text"
        :placeholder="placeholder"
        :disabled="disabled"
        class="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-800 outline-none transition-colors focus:border-gray-500 disabled:bg-gray-50 disabled:text-gray-400"
        :aria-label="placeholder"
        @focus="onInputFocus"
        @blur="onInputBlur"
      />
      <ul
        v-if="open && options.length > 0"
        class="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
      >
        <li v-for="option in options" :key="option.id">
          <button
            type="button"
            class="flex w-full flex-col items-start px-3 py-1.5 text-left transition-colors hover:bg-gray-50"
            @mousedown.prevent="choose(option)"
          >
            <span class="text-sm text-gray-800">
              {{ option.name }}
              <span class="ml-1 text-xs text-gray-400">{{ option.type }}</span>
            </span>
            <span v-if="option.summary" class="w-full truncate text-xs text-gray-400">{{ option.summary }}</span>
          </button>
        </li>
      </ul>
      <p v-else-if="open && searching" class="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-400 shadow-lg">
        搜索中…
      </p>
    </template>
  </div>
</template>
