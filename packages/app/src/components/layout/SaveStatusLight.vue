<script setup lang="ts">
import { computed } from 'vue'

import {
  DETAIL_SAVE_PHASE_LABELS,
  DETAIL_SAVE_PHASE_TEXT_CLASSES,
  type DetailSavePhase,
} from './detail-save-phase'

/**
 * 保存状态灯（六个模块右侧详情布局统一计划 阶段 1）：五态集中映射的唯一实现。
 * 六个模块共用；只表达保存阶段（含圆点与颜色），不混入重试等业务操作——
 * 失败原因与重试由详情布局的消息区承载。
 */
const props = defineProps<{
  phase: DetailSavePhase
  /** 测试标识（缺省不渲染 data-testid） */
  testid?: string
}>()

const label = computed(() => DETAIL_SAVE_PHASE_LABELS[props.phase])
const textClass = computed(() => DETAIL_SAVE_PHASE_TEXT_CLASSES[props.phase])
</script>

<template>
  <span
    class="flex shrink-0 items-center gap-1 text-xs"
    :class="textClass"
    :data-testid="testid"
    :aria-label="`保存状态：${label}`"
  >
    <!-- 等待保存：琥珀圆点（去抖窗口内未写盘的等待感） -->
    <span v-if="phase === 'pending'" class="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
    {{ label }}
  </span>
</template>
