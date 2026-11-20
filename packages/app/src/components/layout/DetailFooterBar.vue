<script setup lang="ts">
import { computed } from 'vue'

/**
 * 底部信息行（六个模块右侧详情布局统一计划 阶段 1）：六个模块共用的详情底部。
 * 左侧为项目内真实相对路径（可压缩省略、悬停读全文），右侧为完整本地化时间
 * （不缩水）；不承载保存状态，不推导或伪造路径——数据由调用方传入
 * （文件传 file.path，卡片传 sourcePath）。
 */
const props = defineProps<{
  /** 项目内相对路径（空值不渲染左栏；未选择内容由布局隐藏整个底部） */
  path?: string | null
  /** 更新时间（ISO；空值不渲染右栏） */
  updatedAt?: string | null
}>()

const timeText = computed(() => {
  if (!props.updatedAt) {
    return ''
  }
  try {
    return new Date(props.updatedAt).toLocaleString('zh-CN')
  } catch {
    return props.updatedAt
  }
})
</script>

<template>
  <div class="flex shrink-0 items-center justify-between gap-3 text-xs text-gray-500">
    <!-- 左栏：真实路径；min-w-0 + truncate 长路径省略，不挤压右栏 -->
    <span
      v-if="path"
      class="min-w-0 flex-1 truncate text-left"
      :title="path"
      data-testid="detail-footer-path"
    >{{ path }}</span>
    <span v-else class="min-w-0 flex-1" />
    <!-- 右栏：完整本地化时间；shrink-0 不缩水 -->
    <span v-if="timeText" class="shrink-0 whitespace-nowrap" data-testid="detail-footer-time">
      {{ timeText }}
    </span>
  </div>
</template>
