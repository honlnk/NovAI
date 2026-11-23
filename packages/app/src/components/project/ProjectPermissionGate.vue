<script setup lang="ts">
import AppIcon from '../ui/AppIcon.vue'

/**
 * 自动恢复需要重新授权时的整页卡片（《项目打开进度与移动端授权修复计划》§5）。
 *
 * 浏览器要求授权请求由一次用户点击触发（手机版 Chrome 冷启动后的自动恢复没有点击，
 * 会被直接拒绝），所以这里不自动发起授权——等用户点「重新授权并打开」，
 * 由点击手势内的调用去弹系统授权框。拒绝后卡片仍在。
 */
defineProps<{
  /** 待授权的项目名；未知时正文改用「这个项目」 */
  projectName?: string
}>()

const emit = defineEmits<{
  authorize: []
  back: []
}>()
</script>

<template>
  <div class="fixed inset-0 z-[70] flex items-center justify-center bg-white px-6">
    <div
      class="w-full max-w-md text-center"
      role="alertdialog"
      aria-labelledby="project-permission-gate-title"
      aria-describedby="project-permission-gate-body"
      data-testid="project-permission-gate"
    >
      <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50">
        <AppIcon name="lock" :size="24" class="h-6 w-6 text-blue-600" />
      </div>
      <h2 id="project-permission-gate-title" class="text-lg font-semibold text-gray-900">
        需要重新授权
      </h2>
      <p id="project-permission-gate-body" class="mt-2 text-sm leading-6 text-gray-600">
        <template v-if="projectName">
          浏览器需要你再次确认，NovAI 才能访问项目「{{ projectName }}」的文件夹。
        </template>
        <template v-else>
          浏览器需要你再次确认，NovAI 才能访问这个项目的文件夹。
        </template>
      </p>
      <div class="mt-6 flex flex-col items-center gap-3">
        <button
          class="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          data-testid="project-permission-authorize"
          @click="emit('authorize')"
        >
          重新授权并打开
        </button>
        <button
          class="rounded text-sm text-gray-500 underline-offset-2 transition-colors hover:text-gray-700 hover:underline"
          data-testid="project-permission-back"
          @click="emit('back')"
        >
          返回首页
        </button>
      </div>
    </div>
  </div>
</template>
