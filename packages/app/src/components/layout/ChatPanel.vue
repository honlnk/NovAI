<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat'

defineProps<{
  projectId: string
}>()

const emit = defineEmits<{
  toggleSidebar: []
  toggleContentPanel: []
  toggleMobileSidebar: []
}>()

const chatStore = useChatStore()
const inputText = ref('')
const messagesContainer = ref<HTMLDivElement | null>(null)
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

  try {
    await chatStore.sendMessage(message)
  } finally {
    isSending.value = false
  }
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
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7" />
          </svg>
        </button>
        <h1 class="text-base font-semibold text-gray-800">AI 对话</h1>
      </div>
      <div class="flex items-center gap-1">
        <button
          class="rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-gray-100"
          @click="emit('toggleContentPanel')"
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
          <div
            v-for="message in chatStore.messages"
            :key="message.id"
            :class="[
              'flex gap-3',
              message.role === 'user' ? 'justify-end' : 'justify-start',
            ]"
          >
            <!-- AI 消息 -->
            <div
              v-if="message.role === 'assistant'"
              class="flex max-w-[80%] gap-3"
            >
              <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-900 text-white">
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <div class="rounded-lg bg-gray-100 px-4 py-2.5">
                <p class="whitespace-pre-wrap text-sm text-gray-800">{{ message.text }}</p>
              </div>
            </div>

            <!-- 用户消息 -->
            <div
              v-else-if="message.role === 'user'"
              class="flex max-w-[80%] flex-row-reverse gap-3"
            >
              <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white">
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </div>
              <div class="rounded-lg bg-blue-600 px-4 py-2.5">
                <p class="whitespace-pre-wrap text-sm text-white">{{ message.text }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 输入区域 -->
    <div class="border-t border-gray-200 bg-white px-4 py-3">
      <form
        class="mx-auto max-w-3xl"
        @submit.prevent="handleSend"
      >
        <div class="flex gap-2">
          <input
            v-model="inputText"
            class="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="输入创作指令..."
            :disabled="isSending"
          />
          <button
            type="submit"
            class="rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
            :disabled="!inputText.trim() || isSending"
          >
            {{ isSending ? '发送中...' : '发送' }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>
