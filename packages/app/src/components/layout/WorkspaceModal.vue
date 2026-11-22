<script setup lang="ts">
/**
 * 工作区弹窗骨架（关系图谱施工计划阶段 1 公共地基，关系图谱与后续时间线共用）。
 *
 * 只承担外壳语义：复用 BaseModal 的遮罩/居中/层级/关闭，补齐「标题栏（标题、副标题、
 * 操作区、关闭）+ 可滚动主体 + 可选底部状态行 + 加载/空/错误三态」。
 * 滚动责任在主体区：头部与底部固定，主体内部自行滚动；窄屏（<sm）遮罩留白收窄。
 * 不含任何领域判断——「关系怎样、时间线怎样」的分支一律住在调用方。
 */
import BaseModal from '../ui/BaseModal.vue'
import AppIcon from '../ui/AppIcon.vue'

withDefaults(
  defineProps<{
    isOpen: boolean
    title: string
    /** 副标题（如项目名或说明句）；空则不占行 */
    subtitle?: string
    /** 弹窗标题的 id（供 aria-labelledby），缺省自动生成 */
    titleId?: string
    /** 内容宽度档位（max-w-*），默认 max-w-5xl */
    widthClass?: string
    /** 内容高度档位（h-[...]），默认 h-[min(88vh,44rem)] */
    heightClass?: string
    /** 加载态：替代主体内容（骨架不猜加载样式以外的语义） */
    loading?: boolean
    /** 错误态：非空字符串时替代主体内容，以警示条呈现 */
    error?: string | null
    /** 空态：主体无内容时的引导文案 */
    empty?: boolean
    emptyText?: string
    /** 点击遮罩是否关闭（默认开，与 BaseModal 一致） */
    closeOnBackdrop?: boolean
  }>(),
  {
    subtitle: '',
    titleId: undefined,
    widthClass: 'max-w-5xl',
    heightClass: 'h-[min(88vh,44rem)]',
    loading: false,
    error: null,
    empty: false,
    emptyText: '这里还没有内容',
    closeOnBackdrop: true,
  },
)

const emit = defineEmits<{
  close: []
}>()
</script>

<template>
  <BaseModal
    :is-open="isOpen"
    backdrop-class="bg-black/50 p-3 sm:p-6"
    :content-class="`flex w-full flex-col overflow-hidden rounded-xl bg-white shadow-2xl ${heightClass} ${widthClass}`"
    :close-on-backdrop="closeOnBackdrop"
    :aria-labelledby="titleId ?? 'workspace-modal-title'"
    @close="emit('close')"
  >
    <!-- 标题栏：固定高度，操作区与关闭入口由插槽/骨架统一承载 -->
    <header class="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-5 py-3.5">
      <div class="min-w-0">
        <h2 :id="titleId ?? 'workspace-modal-title'" class="truncate text-base font-semibold text-gray-900">
          {{ title }}
        </h2>
        <p v-if="subtitle" class="mt-0.5 truncate text-xs text-gray-500">{{ subtitle }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <slot name="actions" />
        <button
          aria-label="关闭弹窗"
          class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          @click="emit('close')"
        >
          <AppIcon name="x" :size="18" class="h-[18px] w-[18px]" />
        </button>
      </div>
    </header>

    <!-- 主体：唯一滚动区。三态覆盖层优先于默认插槽 -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="loading" class="flex h-full items-center justify-center px-5 py-8 text-sm text-gray-500">
        <slot name="loading">加载中…</slot>
      </div>
      <div v-else-if="error" class="px-5 py-4">
        <div role="alert" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <slot name="error">{{ error }}</slot>
        </div>
      </div>
      <div v-else-if="empty" class="flex h-full items-center justify-center px-5 py-8 text-sm text-gray-400">
        <slot name="empty">{{ emptyText }}</slot>
      </div>
      <slot v-else />
    </div>

    <!-- 底部状态行：可选，固定不随主体滚动 -->
    <footer
      v-if="$slots.footer"
      class="shrink-0 border-t border-gray-100 px-5 py-2 text-xs text-gray-500"
    >
      <slot name="footer" />
    </footer>
  </BaseModal>
</template>
