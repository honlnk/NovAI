<script setup lang="ts">
// 对话历史分类面板。
// 本轮为占位实现：对话历史持久化存储功能尚未开发。
// 后续支持会话列表切换时，这里会渲染历史会话卡片。
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="px-4 py-3">
      <h2 class="text-sm font-semibold text-white">对话</h2>
    </div>

    <div class="flex-1 overflow-y-auto px-2 pb-2">
      <div class="px-2 py-8 text-center">
        <svg class="mx-auto mb-3 h-10 w-10 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        </svg>
        <p class="mb-1 text-sm text-gray-400">对话历史功能开发中</p>
        <p class="text-xs text-gray-500">后续将支持历史会话列表切换</p>
      </div>
    </div>
  </div>
</template>
