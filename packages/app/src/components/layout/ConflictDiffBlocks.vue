<script setup lang="ts">
import { ref, watch } from 'vue'

import type { ConflictDiffResult } from '../../utils/conflict-diff'

/**
 * 冲突差异块（六个模块右侧详情布局统一计划 阶段 1）：单栏差异块的唯一展示
 * 结构——上下文灰显、未改动折叠（可展开）、红绿变更对与字级高亮。差异计算
 * 仍由 utils/conflict-diff 承担，文件（整份正文）与卡片（长字段）只是不同
 * 数据源；折叠态由本组件持有，跨字段用 foldPrefix 隔离。
 */
const props = withDefaults(
  defineProps<{
    diff: ConflictDiffResult
    /** 长字段隔离前缀（卡片多字段比较时各字段折叠态互不影响） */
    foldPrefix?: string
    /** 折叠态作用域（如 路径+冲突代次 / 卡片id+展开态）：变化即复位折叠 */
    foldScope?: string
  }>(),
  { foldPrefix: '', foldScope: undefined },
)

const expandedFolds = ref(new Set<string>())

watch(
  () => props.foldScope,
  () => {
    expandedFolds.value = new Set()
  },
)

function foldKey(blockId: number): string {
  return `${props.foldPrefix}:${blockId}`
}

function toggleFold(blockId: number) {
  const key = foldKey(blockId)
  const next = new Set(expandedFolds.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  expandedFolds.value = next
}

function isFoldExpanded(blockId: number): boolean {
  return expandedFolds.value.has(foldKey(blockId))
}
</script>

<template>
  <template v-for="(block, index) in diff.blocks" :key="index">
    <!-- 未改动上下文：灰显 -->
    <template v-if="block.kind === 'context'">
      <div
        v-for="(line, lineIndex) in block.lines"
        :key="lineIndex"
        class="whitespace-pre-wrap px-2 text-xs leading-5 text-gray-400"
      >{{ line }}&nbsp;</div>
    </template>
    <!-- 折叠的未改动区：可展开 / 收起 -->
    <template v-else-if="block.kind === 'fold'">
      <div v-if="isFoldExpanded(block.id)">
        <div
          v-for="(line, lineIndex) in block.lines"
          :key="lineIndex"
          class="whitespace-pre-wrap px-2 text-xs leading-5 text-gray-400"
        >{{ line }}&nbsp;</div>
        <button
          type="button"
          class="my-1 w-full rounded border border-gray-100 bg-gray-50 px-2 py-1 text-[11px] text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          @click="toggleFold(block.id)"
        >
          收起 {{ block.count }} 段未改动内容
        </button>
      </div>
      <button
        v-else
        type="button"
        class="my-1 w-full rounded border border-gray-100 bg-gray-50 px-2 py-1 text-[11px] text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        @click="toggleFold(block.id)"
      >
        ⋯ 展开 {{ block.count }} 段未改动内容
      </button>
    </template>
    <!-- 变更块：上下相邻的原段落（红）／新段落（绿），段内字级高亮 -->
    <div v-else class="my-1 flex flex-col gap-0.5">
      <div v-for="(pair, pairIndex) in block.pairs" :key="pairIndex" class="flex flex-col gap-0.5">
        <!-- 原段落（仅我的内容）：红底；有字级变换时只加深实际被替换的字 -->
        <div v-if="pair.old !== undefined" class="whitespace-pre-wrap rounded-sm px-2 text-xs leading-5 conflict-para-del">
          <template v-if="pair.inline">
            <template v-for="(seg, segIndex) in pair.inline" :key="segIndex">
              <span v-if="seg.kind !== 'add'" :class="seg.kind === 'del' ? 'conflict-inline-del' : ''">{{ seg.text }}</span>
            </template>
          </template>
          <template v-else>{{ pair.old }}</template>
        </div>
        <!-- 新段落（仅磁盘）：绿底；有字级变换时只加深实际新增的字 -->
        <div v-if="pair.new !== undefined" class="whitespace-pre-wrap rounded-sm px-2 text-xs leading-5 conflict-para-add">
          <template v-if="pair.inline">
            <template v-for="(seg, segIndex) in pair.inline" :key="segIndex">
              <span v-if="seg.kind !== 'del'" :class="seg.kind === 'add' ? 'conflict-inline-add' : ''">{{ seg.text }}</span>
            </template>
          </template>
          <template v-else>{{ pair.new }}</template>
        </div>
      </div>
    </div>
  </template>
</template>

<style>
/* 冲突比较（单栏差异块）：段落级底色 + 字级加深。红系 = 仅我的内容（原段落），
   绿系 = 仅磁盘（新段落）；未改动上下文灰显。全局样式：差异块结构由本组件与
   两域冲突界面共用，段落底色不随 scoped 属性漂移。 */
.conflict-para-del {
  background-color: rgb(254 226 226 / 0.55);
  border-left: 2px solid rgb(248 113 113);
  color: rgb(127 29 29);
}

.conflict-para-add {
  background-color: rgb(220 252 231 / 0.6);
  border-left: 2px solid rgb(74 222 128);
  color: rgb(20 83 45);
}

.conflict-inline-del {
  background-color: rgb(254 178 178 / 0.85);
  border-radius: 2px;
  font-weight: 500;
}

.conflict-inline-add {
  background-color: rgb(134 239 172 / 0.85);
  border-radius: 2px;
  font-weight: 500;
}
</style>
