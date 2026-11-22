<script setup lang="ts">
/**
 * 卡片保存失败条（六个模块右侧详情布局统一计划 阶段 3，卡片展示适配器组成件）：
 * 保存状态移入头部后，失败原因与重试的唯一出口——消息区红条。三类卡片共用，
 * 重试事件由领域 store 的 retrySave 承接；本件不持有任何状态。
 */
defineProps<{
  testidPrefix: string
  /** 失败原因（store 会话失败消息；空值退化为通用文案） */
  message?: string
}>()

const emit = defineEmits<{
  /** 手动重试失败写入 */
  retry: []
}>()
</script>

<template>
  <div
    class="mb-3 flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2"
    role="alert"
  >
    <p class="min-w-0 flex-1 text-xs leading-5 text-red-700">
      {{ message || '保存失败，未写入的内容已保留；可重试或稍后再试。' }}
    </p>
    <button
      type="button"
      class="shrink-0 rounded-md bg-gray-900 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-800"
      :data-testid="`${testidPrefix}-detail-retry`"
      @click="emit('retry')"
    >
      重试
    </button>
  </div>
</template>
