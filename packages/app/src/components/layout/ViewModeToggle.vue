<script setup lang="ts">
import Tooltip from '../ui/Tooltip.vue'
import AppIcon from '../ui/AppIcon.vue'
import type { DetailMode } from './detail-mode'

/**
 * 预览／编辑切换（六个模块右侧详情布局统一计划 阶段 1）：六个模块共用的
 * 头部右侧两态分段控件。只负责模式呈现、激活态、禁用原因与切换事件；
 * 模式何时改变、保存后停在哪个态由领域会话决定。
 *
 * 可访问名称：普通文件为「预览／编辑」，卡片正文可传 noun（如「正文」）
 * 得到「预览正文／编辑正文」，与迁移前两侧既有读屏名称保持一致。
 */
const props = withDefaults(
  defineProps<{
    mode: DetailMode
    /** 编辑不可用（如该文件类型不支持编辑） */
    editDisabled?: boolean
    /** 编辑禁用原因（tooltip 解释；缺省用通用文案） */
    editDisabledReason?: string
    /** 可访问名称后缀（卡片传「正文」→「预览正文／编辑正文」） */
    noun?: string
  }>(),
  { editDisabled: false, editDisabledReason: undefined, noun: undefined },
)

const emit = defineEmits<{
  change: [mode: DetailMode]
}>()

const modes: ReadonlyArray<{ key: DetailMode; label: string; icon: 'eye' | 'square-pen' }> = [
  { key: 'preview', label: '预览', icon: 'eye' },
  { key: 'edit', label: '编辑', icon: 'square-pen' },
]

function ariaLabel(label: string): string {
  return props.noun ? `${label}${props.noun}` : label
}
</script>

<template>
  <div class="flex items-center rounded-lg border border-gray-200 bg-gray-50 p-0.5">
    <Tooltip
      v-for="mode in modes"
      :key="mode.key"
      :text="mode.key === 'edit' && editDisabled ? (editDisabledReason ?? `${ariaLabel(mode.label)}（不可用）`) : ariaLabel(mode.label)"
      :delay="300"
      preferred-placement="bottom"
    >
      <button
        :aria-label="ariaLabel(mode.label)"
        :class="[
          'flex items-center justify-center rounded-md p-1.5 transition-colors',
          props.mode === mode.key
            ? 'bg-white text-gray-900 shadow-sm'
            : 'text-gray-500 hover:text-gray-700',
          mode.key === 'edit' && editDisabled ? 'cursor-not-allowed opacity-40' : '',
        ]"
        :disabled="mode.key === 'edit' && editDisabled"
        :data-testid="mode.key === 'edit' ? 'detail-mode-edit' : undefined"
        @click="emit('change', mode.key)"
      >
        <AppIcon :name="mode.icon" :size="16" class="h-4 w-4" />
      </button>
    </Tooltip>
  </div>
</template>
