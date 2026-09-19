<script setup lang="ts">
import { computed } from 'vue'
import { diffLines } from 'diff'

/**
 * 行级 diff 渲染（文档 3 S5）：对 oldText/newText 做 diffLines 红绿行渲染。
 * 新建文件 oldText 为空 → 全绿；删除内容全红。
 */
const props = defineProps<{
  oldText: string
  newText: string
}>()

type DiffRow = { kind: 'added' | 'removed' | 'context'; text: string }

const rows = computed<DiffRow[]>(() => {
  const parts = diffLines(props.oldText, props.newText)
  const output: DiffRow[] = []
  for (const part of parts) {
    const lines = part.value.replace(/\n$/, '').split('\n')
    for (const line of lines) {
      if (part.added) {
        output.push({ kind: 'added', text: line })
      } else if (part.removed) {
        output.push({ kind: 'removed', text: line })
      } else {
        output.push({ kind: 'context', text: line })
      }
    }
  }
  return output
})
</script>

<template>
  <div class="overflow-x-auto rounded-md border border-gray-100 bg-gray-50 font-mono text-xs leading-5">
    <div
      v-for="(row, index) in rows"
      :key="index"
      :class="[
        'px-2 whitespace-pre',
        row.kind === 'added' ? 'bg-green-50 text-green-800'
          : row.kind === 'removed' ? 'bg-red-50 text-red-800'
            : 'text-gray-500',
      ]"
    >
      <span
        v-if="row.kind !== 'context'"
        class="mr-1 select-none text-gray-400"
      >{{ row.kind === 'added' ? '+' : '−' }}</span><span v-else class="mr-1 select-none">&nbsp;</span>{{ row.text }}
    </div>
  </div>
</template>
