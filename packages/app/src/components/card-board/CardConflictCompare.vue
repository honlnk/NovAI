<script setup lang="ts">
import { computed } from 'vue'

import type { CardConflictField } from '../../stores/card-board'
import { buildConflictDiff } from '../../utils/conflict-diff'
import ConflictDiffBlocks from '../layout/ConflictDiffBlocks.vue'

/**
 * 卡片冲突字段比较（六个模块右侧详情布局统一计划 阶段 1，卡片展示适配器组成件）：
 * 展开比较的内容区——短字段红绿并排、长正文字段单栏差异块（字级高亮、未改动
 * 折叠跨字段隔离）、无差异字段折叠为一行统计。差异算法复用 utils/conflict-diff；
 * 本件不计算领域字段（store 组合好 mine/disk 展示文本后传入）、不执行采用。
 */
const props = defineProps<{
  /** 领域 store 组合的 mine/disk 展示文本（无差异字段在这里过滤） */
  conflictFields: ReadonlyArray<CardConflictField>
  /** 折叠复位作用域（切卡/收起再展开时清未改动折叠的展开残留） */
  foldScope?: string
}>()

/** 有差异的短字段（红绿并排） */
const changedShortFields = computed(() =>
  props.conflictFields.filter((field) => field.kind === 'short' && field.mine !== field.disk),
)

/** 两版一致的字段数（折叠为一行统计） */
const unchangedFieldCount = computed(() =>
  props.conflictFields.filter((field) => field.mine === field.disk).length,
)

/** 长正文字段的差异块（带字段标签与统计；折叠态由差异块组件按字段 key 隔离） */
const longFieldDiffs = computed(() =>
  props.conflictFields
    .filter((field) => field.kind === 'long' && field.mine !== field.disk)
    .map((field) => ({ key: field.key, label: field.label, diff: buildConflictDiff(field.mine, field.disk) })),
)
</script>

<template>
  <div data-testid="card-conflict-compare">
    <p v-if="changedShortFields.length === 0 && longFieldDiffs.length === 0" class="shrink-0 text-xs text-gray-500">
      两个版本的字段内容一致（可能只有结尾换行等格式差异）。
    </p>
    <p v-if="unchangedFieldCount > 0" class="shrink-0 text-xs text-gray-400">
      其余 {{ unchangedFieldCount }} 个字段两版一致。
    </p>

    <!-- 短字段：单行红绿并排 -->
    <div
      v-for="field in changedShortFields"
      :key="field.key"
      class="mb-2 flex flex-col gap-0.5 border-b border-gray-100 pb-2 last:border-b-0"
    >
      <p class="px-2 text-[11px] font-medium text-gray-500">{{ field.label }}</p>
      <div class="whitespace-pre-wrap rounded-sm px-2 text-xs leading-5 conflict-para-del">
        我的：{{ field.mine || '（空）' }}
      </div>
      <div class="whitespace-pre-wrap rounded-sm px-2 text-xs leading-5 conflict-para-add">
        磁盘：{{ field.disk || '（空）' }}
      </div>
    </div>

    <!-- 长正文字段：单栏差异块（上下文灰显/折叠可展开/红绿对+字级高亮） -->
    <div v-for="entry in longFieldDiffs" :key="entry.key" class="mb-3 last:mb-0">
      <p class="mb-1 px-2 text-[11px] font-medium text-gray-500">{{ entry.label }}</p>
      <p v-if="entry.diff.degraded" class="px-2 pb-1 text-[11px] text-amber-700">
        两版差异过大，整块对比（红 = 仅你的内容，绿 = 仅磁盘）。
      </p>
      <p v-else class="px-2 pb-1 text-[11px] text-gray-400">
        修改 {{ entry.diff.stats.changed }} 段、新增 {{ entry.diff.stats.added }} 段、删除 {{ entry.diff.stats.removed }} 段。
      </p>
      <ConflictDiffBlocks :diff="entry.diff" :fold-prefix="entry.key" :fold-scope="foldScope" />
    </div>
  </div>
</template>
