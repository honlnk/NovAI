<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat'
import { shouldSubmitOnEnter } from '../../composables/keyboard'
import MessageItem from '../chat/MessageItem.vue'

defineProps<{
  projectId: string
  isSidebarOpen: boolean
  isContentPanelOpen: boolean
}>()

const emit = defineEmits<{
  toggleSidebar: []
  toggleContentPanel: []
  toggleMobileSidebar: []
}>()

const chatStore = useChatStore()
const inputText = ref('')
const messagesContainer = ref<HTMLDivElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const isSending = ref(false)

// 自动滚动到底部
async function scrollToBottom() {
  await nextTick()
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

watch(
  () => chatStore.messages.length,
  () => {
    scrollToBottom()
  },
)


async function handleSend() {
  if (!inputText.value.trim() || isSending.value) return

  const message = inputText.value.trim()
  inputText.value = ''
  isSending.value = true

  // 重置 textarea 高度
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
  }

  try {
    await chatStore.sendMessage(message)
  } finally {
    isSending.value = false
  }
}

function handleKeydown(event: KeyboardEvent) {
  // Enter 发送，Shift+Enter 换行
  if (shouldSubmitOnEnter(event)) {
    event.preventDefault()
    handleSend()
  }
}

function autoResize(event: Event) {
  const textarea = event.target as HTMLTextAreaElement
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
}
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col">
    <!-- 头部 -->
    <header class="flex items-center justify-between border-b border-gray-200 px-4 py-3">
      <div class="flex items-center gap-2">
        <button
          class="rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-gray-100 lg:hidden"
          @click="emit('toggleMobileSidebar')"
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <button
          class="hidden rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-gray-100 lg:block"
          @click="emit('toggleSidebar')"
        >
          <!-- 收起状态：显示汉堡菜单（暗示可以展开侧边栏） -->
          <svg v-if="!isSidebarOpen" class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          <!-- 展开状态：显示侧边栏收起图标 -->
          <svg v-else class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          </svg>
        </button>
        <h1 class="text-base font-semibold text-gray-800">AI 对话</h1>
      </div>
      <div class="flex items-center gap-1">
        <button
          class="rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-gray-100"
          @click="emit('toggleContentPanel')"
        >
          <svg
            class="h-5 w-5 transition-transform duration-200"
            :class="isContentPanelOpen ? '' : 'rotate-180'"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </header>

    <!-- 消息列表 -->
    <div
      ref="messagesContainer"
      class="flex-1 overflow-y-auto"
    >
      <div class="mx-auto max-w-3xl px-4 py-6">
        <!-- 首次使用引导插槽 -->
        <slot name="guide" />

        <!-- 空状态 -->
        <div
          v-if="chatStore.messages.length === 0"
          class="flex flex-col items-center justify-center py-16"
        >
          <svg class="mb-4 h-12 w-12 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          <p class="mb-1 text-lg font-medium text-gray-400">开始创作</p>
          <p class="text-sm text-gray-400">输入你的创作指令，AI 会帮你完成</p>
        </div>

        <!-- 消息列表 -->
        <div v-else class="space-y-4">
          <MessageItem
            v-for="message in chatStore.messages"
            :key="message.id"
            :message="message"
          />

        </div>
      </div>
    </div>

    <!-- 输入区域 -->
    <div class="border-t border-gray-200 bg-white px-4 py-3">
      <div class="mx-auto max-w-3xl">
        <div class="flex gap-2">
          <textarea
            ref="textareaRef"
            v-model="inputText"
            class="flex-1 resize-none rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="输入创作指令... (Enter 发送，Shift+Enter 换行)"
            rows="1"
            :disabled="isSending"
            @keydown="handleKeydown"
            @input="autoResize"
          />
          <button
            class="self-end rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
            :disabled="!inputText.trim() || isSending"
            @click="handleSend"
          >
            <svg
              v-if="isSending"
              class="h-5 w-5 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <svg
              v-else
              class="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </div>
        <p class="mt-1 text-xs text-gray-500">{{ chatStore.runStatus }}</p>
      </div>
    </div>
  </section>
</template>
