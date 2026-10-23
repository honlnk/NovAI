<script setup lang="ts">
import { ref } from 'vue'
import type { EnvironmentReportView } from '@novai/core/services/types'

const props = defineProps<{
  report: EnvironmentReportView
}>()

// 内嵌浏览器（微信/钉钉等）场景额外给「复制本页链接」入口；其余场景直接引导换浏览器。
const isEmbeddedWebview = props.report.blocker === 'embedded-webview'
const linkCopied = ref(false)

const recommendedBrowsers = [
  { name: 'Chrome', vendor: 'Google', url: 'https://www.google.cn/chrome/' },
  { name: 'Edge', vendor: 'Microsoft', url: 'https://www.microsoft.com/zh-cn/edge' },
  { name: '360 安全浏览器', vendor: '360', url: 'https://browser.360.cn/' },
]

async function handleCopyLink() {
  try {
    await window.navigator.clipboard?.writeText(window.location.href)
    linkCopied.value = true
    setTimeout(() => {
      linkCopied.value = false
    }, 2000)
  } catch {
    // 剪贴板不可用时静默失败，用户仍可从地址栏手动复制
  }
}
</script>

<template>
  <div class="flex h-screen flex-col bg-gray-50">
    <!-- 顶栏：与 HomeView 一致的品牌标识 -->
    <header class="flex items-center gap-3 border-b border-gray-200 bg-white px-6 py-4">
      <svg class="h-7 w-7" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="unsupported-mark-acc" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#6366F1" />
            <stop offset="1" stop-color="#06B6D4" />
          </linearGradient>
        </defs>
        <g stroke="url(#unsupported-mark-acc)" stroke-width="2" stroke-linecap="round">
          <path d="M 13 10 L 10.5 7.5" />
          <path d="M 35 10 L 37.5 7.5" />
        </g>
        <rect x="23" y="3" width="2" height="3" rx="1" fill="url(#unsupported-mark-acc)" />
        <circle cx="24" cy="14.5" r="5" fill="url(#unsupported-mark-acc)" />
        <rect x="21.5" y="19.5" width="5" height="1.8" rx="0.9" fill="url(#unsupported-mark-acc)" />
        <rect x="22.2" y="22.4" width="3.6" height="1.6" rx="0.8" fill="url(#unsupported-mark-acc)" />
        <path fill="#18181B" d="M 22.6 26 C 18 22.4, 10.5 21.4, 5 23.2 L 5 41 C 10.5 39.2, 18 40.2, 22.6 43.8 Z" />
        <path fill="#18181B" d="M 25.4 26 C 30 22.4, 37.5 21.4, 43 23.2 L 43 41 C 37.5 39.2, 30 40.2, 25.4 43.8 Z" />
      </svg>
      <h1 class="text-xl font-bold text-gray-900">NovAI（诺艾）</h1>
      <span class="text-sm text-gray-500">AI 小说创作助手</span>
    </header>

    <main class="flex flex-1 items-center justify-center p-6">
      <div class="w-full max-w-2xl rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
        <div class="flex items-start gap-4">
          <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-orange-100">
            <svg class="h-6 w-6 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div class="min-w-0 flex-1">
            <h2 class="mb-2 text-xl font-semibold text-gray-900">NovAI 无法在当前浏览器中运行</h2>
            <p class="mb-6 text-sm leading-6 text-gray-600">{{ props.report.blockerMessage }}</p>

            <h3 class="mb-3 text-sm font-medium text-gray-500">推荐使用以下浏览器（请安装最新版）</h3>
            <div class="mb-6 grid gap-3 sm:grid-cols-3">
              <a
                v-for="browser in recommendedBrowsers"
                :key="browser.name"
                :href="browser.url"
                target="_blank"
                rel="noopener noreferrer"
                class="group rounded-lg border border-gray-200 p-4 transition-all hover:border-blue-300 hover:shadow-sm"
              >
                <p class="font-medium text-gray-900 group-hover:text-blue-700">{{ browser.name }}</p>
                <p class="mt-1 text-xs text-gray-500">{{ browser.vendor }} · 前往下载</p>
              </a>
            </div>

            <button
              v-if="isEmbeddedWebview"
              class="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
              @click="handleCopyLink"
            >
              {{ linkCopied ? '已复制，请在浏览器中粘贴打开' : '复制本页链接' }}
            </button>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
