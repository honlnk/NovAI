<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import type { ReasoningEffort } from '@novai/core/types/ai'

import type { reasoningEffortLabel } from '../../constants/reasoning-efforts'
import AppIcon from '../ui/AppIcon.vue'
import { PICKER_MENU_MAX_HEIGHT, pickerMenuMaxHeight } from './picker-menu-height'

/**
 * 思考强度档位选择器（对话输入区入口，思考强度计划 D3）：
 * 按钮显示当前档位名，点击在按钮上方弹出菜单（dsh popover 形态），当前档带勾。
 * 可选档位由 ChatPanel 按协议 × 方言过滤后传入；选中后 emit，走 updateConfig 写回链路。
 */
type EffortOption = { value: ReasoningEffort; label: string; hint: string }

const props = defineProps<{
  effort: ReasoningEffort | undefined
  options: readonly EffortOption[]
  label: ReturnType<typeof reasoningEffortLabel>
}>()

const emit = defineEmits<{
  (e: 'select', effort: ReasoningEffort): void
}>()

const isOpen = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
/** 菜单限高（px）：打开后按菜单定位祖先上方的实际余量算，见 picker-menu-height */
const menuMaxHeight = ref(PICKER_MENU_MAX_HEIGHT)

async function toggle() {
  if (isOpen.value) {
    isOpen.value = false
    return
  }
  // 先按默认上限把菜单渲染出来，再按它实际挂靠的定位祖先量余量（量完才绘制，不会先闪一下）
  menuMaxHeight.value = PICKER_MENU_MAX_HEIGHT
  isOpen.value = true
  await nextTick()
  menuMaxHeight.value = pickerMenuMaxHeight(menuRef.value)
}

function select(effort: ReasoningEffort) {
  isOpen.value = false
  if (effort !== props.effort) {
    emit('select', effort)
  }
}

/** 点击组件外部 / Esc 关闭弹层 */
function handlePointerDown(event: PointerEvent) {
  if (isOpen.value && rootRef.value && !rootRef.value.contains(event.target as Node)) {
    isOpen.value = false
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && isOpen.value) {
    isOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDown)
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <!-- 根节点 shrink-0：工具行放不下时换行，不把档位按钮压窄（标签是 CJK，能被压成一字一行）。
       sm 及以上 relative，菜单锚在按钮上；窄屏改 static，让菜单挂到最近的定位祖先（输入区外壳）上 -->
  <div ref="rootRef" class="relative shrink-0 max-sm:static">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-800"
      :title="`思考强度：${label}（点击切换档位）`"
      @click="toggle"
    >
      <AppIcon name="zap" :size="14" class="h-3.5 w-3.5 text-gray-400" />
      <span class="whitespace-nowrap">{{ label }}</span>
      <AppIcon name="chevron-down" :size="12" class="h-3 w-3 text-gray-400 transition-transform" :class="isOpen ? 'rotate-180' : ''" />
    </button>

    <!-- 档位菜单：按钮上方弹出、右锚向左展开（入口在发送按钮左侧、贴近输入区右缘）。限高内滚——矮视口 / 手机弹出软
         键盘时上方空间不够，超出部分滚动而不是被视口裁掉（限高值按定位祖先上方的余量算，见 picker-menu-height）。
         窄屏（<sm）：定宽 288px 右锚后左缘会落到屏幕外、压在侧栏下；改为与输入区外壳等宽（挂到 ChatPanel 输入区的
         relative 外壳上），与斜杠命令弹层同一形态 -->
    <div
      v-if="isOpen"
      ref="menuRef"
      class="absolute bottom-full right-0 z-20 mb-1.5 w-72 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg max-sm:inset-x-0 max-sm:z-50 max-sm:mb-2 max-sm:w-auto"
      :style="{ maxHeight: `${menuMaxHeight}px` }"
      role="menu"
      aria-label="思考强度档位"
    >
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="menuitemradio"
        :aria-checked="option.value === effort"
        class="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-gray-50"
        @click="select(option.value)"
      >
        <AppIcon name="check" :size="16" class="mt-0.5 h-4 w-4 shrink-0" :class="option.value === effort ? 'text-blue-600' : 'text-transparent'" />
        <span class="min-w-0">
          <span class="block text-sm font-medium text-gray-800">{{ option.label }}</span>
          <span class="mt-0.5 block text-xs leading-snug text-gray-500">{{ option.hint }}</span>
        </span>
      </button>
    </div>
  </div>
</template>
