<script setup lang="ts">
/**
 * 通用模态框外壳（布局照抄 gpt-image-studio 的 BaseModal）。
 *
 * Teleport 到 body + 居中遮罩；点击遮罩自身（mousedown.self 语义）关闭。
 * 不做过渡动画、不监听 Esc——与参考项目行为一致，保持克制。
 */
withDefaults(
  defineProps<{
    isOpen: boolean
    /** 遮罩层 class（含背景色与内边距），如 "bg-black/50 px-3" */
    backdropClass?: string
    /** 内容容器 class（含尺寸与布局），如 "max-w-4xl rounded-lg bg-white" */
    contentClass?: string
    /** 遮罩 z-index class，如 "z-50" */
    zClass?: string
    /** 点击遮罩是否关闭 */
    closeOnBackdrop?: boolean
    ariaLabelledby?: string
  }>(),
  {
    backdropClass: 'bg-black/50 px-3',
    contentClass: '',
    zClass: 'z-50',
    closeOnBackdrop: true,
    ariaLabelledby: undefined,
  },
)

const emit = defineEmits<{
  close: []
}>()

function handleBackdrop(event: MouseEvent) {
  if (event.target === event.currentTarget) {
    emit('close')
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      class="fixed inset-0 flex items-center justify-center"
      :class="[zClass, backdropClass]"
      role="presentation"
      @mousedown="closeOnBackdrop ? handleBackdrop($event) : undefined"
    >
      <section
        class="w-full"
        :class="contentClass"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="ariaLabelledby"
      >
        <slot />
      </section>
    </div>
  </Teleport>
</template>
