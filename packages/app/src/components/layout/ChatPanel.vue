<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ProjectFileNodeView } from '@novai/core/services/types'
import { useChatStore } from '../../stores/chat'
import { shouldSubmitOnEnter } from '../../composables/keyboard'
import MessageItem from '../chat/MessageItem.vue'
import SelectionChip from '../chat/SelectionChip.vue'
import SceneChip from '../chat/SceneChip.vue'
import SceneCommandPopover from '../chat/SceneCommandPopover.vue'

/** 选中引用的数据结构，与 ContentPanel emit 的 selectQuote payload 一致 */
type SelectionQuote = {
  path: string
  name: string
  text: string
}

const props = defineProps<{
  projectId: string
  isSidebarOpen: boolean
  isContentPanelOpen: boolean
  quote: SelectionQuote | null
  /** 场景提示词列表（prompts/scenes/*.md），供 @ 指令选择 */
  scenes: ProjectFileNodeView[]
  /** 当前激活的场景路径，null 表示未激活 */
  activeScenePromptPath: string | null
  /** 当前激活场景的显示名（已去扩展名），chip 展示用 */
  activeSceneName: string | null
}>()

const emit = defineEmits<{
  toggleSidebar: []
  toggleContentPanel: []
  toggleMobileSidebar: []
  clearQuote: []
  /** 切换激活场景，path 为 null 表示关闭 */
  changeScene: [path: string | null]
}>()

const chatStore = useChatStore()
const inputText = ref('')
const messagesContainer = ref<HTMLDivElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

// 是否正在运行，直接读 store，避免本地状态与 store 不同步
const isSending = computed(() => chatStore.isRunning)
// 用户已请求停止、正在等待当前工具完成
const isStopping = computed(() => chatStore.isStopping)

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
  // 发送前快照引用文本（发送过程中 chip 可能被清除）
  const quoteText = props.quote?.text
  inputText.value = ''

  // 重置 textarea 高度
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
  }

  try {
    await chatStore.sendMessage(message, quoteText)
    // 发送成功后清除引用 chip
    emit('clearQuote')
  } catch {
    // 错误已在 store 中写入 runStatus，这里静默处理
  }
}

function handleStop() {
  chatStore.abortRun()
}

function handleKeydown(event: KeyboardEvent) {
  // @场景 弹层打开时：拦截导航键交给弹层
  if (isSceneCommandOpen.value && scenePopoverRef.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      scenePopoverRef.value.moveDown()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      scenePopoverRef.value.moveUp()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      scenePopoverRef.value.confirm()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      handleCloseSceneCommand()
      return
    }
  }
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

/** textarea input 统一入口：自适应高度 + @场景 指令检测（R4） */
function onTextareaInput(event: Event) {
  autoResize(event)
  detectSceneCommand()
}

// ===== R4：@场景 指令检测 =====

/** @场景 弹层是否打开 */
const isSceneCommandOpen = ref(false)
/** @ 后的筛选词 */
const sceneQuery = ref('')
/** 弹层组件引用（键盘导航用） */
const scenePopoverRef = ref<InstanceType<typeof SceneCommandPopover> | null>(null)

/**
 * 匹配光标前最近的 @ 指令。
 * 规则：@ 前是行首或空白，@ 后到光标间不含空格/换行/@。
 * 捕获组即筛选词（可能为空字符串）。
 */
const SCENE_COMMAND_RE = /(?:^|\s)@([^\s@]*)$/

/**
 * input 回调里调用：取光标位置，检测是否处于 @ 指令态。
 * 命中则打开弹层并设置 query；否则关闭。
 */
function detectSceneCommand() {
  const textarea = textareaRef.value
  if (!textarea) {
    isSceneCommandOpen.value = false
    return
  }
  const cursor = textarea.selectionStart ?? 0
  const beforeCursor = inputText.value.slice(0, cursor)
  const match = SCENE_COMMAND_RE.exec(beforeCursor)
  if (match) {
    sceneQuery.value = match[1]
    isSceneCommandOpen.value = props.scenes.length > 0
  } else {
    isSceneCommandOpen.value = false
  }
}

/**
 * 选中场景后：清除输入框里的 @token（含筛选词），激活场景，关闭弹层。
 */
function handleSelectScene(path: string) {
  const textarea = textareaRef.value
  if (textarea) {
    const cursor = textarea.selectionStart ?? 0
    const beforeCursor = inputText.value.slice(0, cursor)
    const afterCursor = inputText.value.slice(cursor)
    // 去掉匹配的 @token（含其前导的一个空白，若是行首则只去 @token）
    const cleaned = beforeCursor.replace(SCENE_COMMAND_RE, '')
    inputText.value = cleaned + afterCursor
    // 光标移到清除点
    nextTick(() => {
      if (textareaRef.value) {
        textareaRef.value.selectionStart = cleaned.length
        textareaRef.value.selectionEnd = cleaned.length
        textareaRef.value.focus()
      }
    })
  }
  isSceneCommandOpen.value = false
  sceneQuery.value = ''
  emit('changeScene', path)
}

function handleCloseSceneCommand() {
  isSceneCommandOpen.value = false
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
        <!-- chip 区：引用 chip + 场景 chip -->
        <div v-if="quote || activeSceneName" class="mb-2 flex flex-wrap items-center gap-2">
          <SelectionChip
            v-if="quote"
            :file-name="quote.name"
            :text="quote.text"
            @remove="emit('clearQuote')"
          />
          <SceneChip
            v-if="activeSceneName"
            :scene-name="activeSceneName"
            @remove="emit('changeScene', null)"
          />
        </div>
        <div class="relative flex gap-2">
          <!-- @场景 指令弹层（R4） -->
          <SceneCommandPopover
            v-if="isSceneCommandOpen"
            ref="scenePopoverRef"
            :scenes="scenes"
            :active-scene-path="activeScenePromptPath"
            :query="sceneQuery"
            @select="handleSelectScene"
            @close="handleCloseSceneCommand"
          />
          <textarea
            ref="textareaRef"
            v-model="inputText"
            class="flex-1 resize-none rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="输入创作指令... (Enter 发送，Shift+Enter 换行；输入 @ 切换场景)"
            rows="1"
            @keydown="handleKeydown"
            @input="onTextareaInput"
          />
          <button
            v-if="isStopping"
            class="self-end rounded-lg border border-gray-200 bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-400"
            title="正在停止…"
            disabled
          >
            <svg class="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </button>
          <button
            v-else-if="isSending"
            class="self-end rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
            title="停止运行"
            @click="handleStop"
          >
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
            </svg>
          </button>
          <button
            v-else
            class="self-end rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
            :disabled="!inputText.trim()"
            @click="handleSend"
          >
            <svg
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
