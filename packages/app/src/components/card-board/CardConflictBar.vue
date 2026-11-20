<script setup lang="ts">
import AppIcon from '../ui/AppIcon.vue'

/**
 * 卡片冲突紧凑条（六个模块右侧详情布局统一计划 阶段 1，卡片展示适配器组成件）：
 * 冲突未展开时常驻的非阻塞琥珀条（唯一，连续外部修改不堆叠）——自动保存冻结，
 * 比较再入口持久。展示结构与位置由统一详情布局的消息区承载，本件只提供卡片文案。
 */
defineProps<{
  testidPrefix?: string
}>()

const emit = defineEmits<{
  /** 「比较并处理」：重读磁盘并展开整页比较 */
  expand: []
}>()
</script>

<template>
  <div
    class="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2"
    role="alert"
  >
    <AppIcon name="triangle-alert" :size="14" class="h-3.5 w-3.5 shrink-0 text-amber-500" />
    <p class="min-w-0 flex-1 text-xs leading-5 text-amber-800">
      这张卡片有两个版本：文件已被 AI 或外部编辑器修改，你尚未写入的修改已保留并暂停自动保存。
    </p>
    <button
      type="button"
      class="shrink-0 rounded-md bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-200"
      :data-testid="testidPrefix ? `${testidPrefix}-detail-conflict-compare` : undefined"
      @click="emit('expand')"
    >
      比较并处理
    </button>
  </div>
</template>
