<script setup lang="ts">
import AppIcon from '../ui/AppIcon.vue'
</script>

<!--
  工作区载入细条（《项目打开进度与移动端授权修复计划》§5）：小说页最顶部的整行细条，
  占据文档流（高 28 像素）。会话、看板等各自的加载不细分计数，只给不定进度——
  工作区立即可见可操作，不遮挡、不阻塞。
-->
<template>
  <div
    class="relative flex h-7 shrink-0 items-center gap-2 border-b border-blue-100 bg-blue-50 px-3"
    role="status"
    data-testid="workspace-load-strip"
  >
    <AppIcon name="loader-circle" :size="14" class="h-3.5 w-3.5 animate-spin text-blue-600 motion-reduce:animate-none" />
    <span class="text-xs text-blue-700">正在载入工作区…</span>
    <span class="workspace-load-line" aria-hidden="true" />
  </div>
</template>

<style scoped>
/* 底边一条流动的细进度线：从左滑到右，循环 */
.workspace-load-line {
  position: absolute;
  left: 0;
  bottom: -1px;
  height: 2px;
  width: 36%;
  border-radius: 999px;
  background: #2563eb;
  animation: workspace-load-slide 1.3s ease-in-out infinite;
}

@keyframes workspace-load-slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(280%);
  }
}

/* 系统开启「减少动态效果」：改为静态半透明的整条细线 */
@media (prefers-reduced-motion: reduce) {
  .workspace-load-line {
    animation: none;
    width: 100%;
    opacity: 0.3;
  }
}
</style>
