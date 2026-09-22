<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ProjectFileNodeView } from '@novai/core/services/types'
import { INIT_NOVEL_PROMPT } from '@novai/core/services/agent-service'
import { useChatStore } from '../../stores/chat'
import { isImeComposing, resolveSubmitMode } from '../../composables/keyboard'
import { useElementExtraction, type ChapterPick } from '../../composables/useElementExtraction'
import { useInlineCompletion } from '../../composables/useInlineCompletion'
import { useProjectStore } from '../../stores/project'
import MessageItem from '../chat/MessageItem.vue'
import PermissionPresetPicker from '../chat/PermissionPresetPicker.vue'
import QueueDock from '../chat/QueueDock.vue'
import SelectionChip from '../chat/SelectionChip.vue'
import SceneCommandPopover from '../chat/SceneCommandPopover.vue'
import ChapterPicker from '../chat/ChapterPicker.vue'
import ExtractionFlowPanel from '../chat/ExtractionFlowPanel.vue'
import GhostTextOverlay from '../chat/GhostTextOverlay.vue'
import ToolCallRow from '../chat/ToolCallRow.vue'
import TurnProcessGroup from '../chat/TurnProcessGroup.vue'
import WriteConfirmationCard from '../chat/WriteConfirmationCard.vue'
import SlashCommandMenu from '../chat/SlashCommandMenu.vue'
import type { SlashCommandId } from '../../constants/slash-commands'
import type { ChatRenderItem } from '../../stores/chat-render'
import type { PermissionPreset } from '@novai/core/types/project'

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
  /** 章节列表（chapters/*.txt|.md），供 /提取要素 选择（R6） */
  chapters: ProjectFileNodeView[]
}>()

const emit = defineEmits<{
  toggleSidebar: []
  toggleContentPanel: []
  toggleMobileSidebar: []
  clearQuote: []
  /** 切换激活场景，path 为 null 表示关闭 */
  changeScene: [path: string | null]
  /** 要素写入完成，通知 ProjectView 刷新文件树（R6） */
  elementsWritten: []
}>()

const chatStore = useChatStore()
const projectStore = useProjectStore()
const inputText = ref('')
const messagesContainer = ref<HTMLDivElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

// 用户已请求停止、正在等待当前工具完成
const isStopping = computed(() => chatStore.isStopping)

/** 当前写工具权限档位（输入区入口显示 + 选择器勾选） */
const currentPermissionPreset = computed(
  () => projectStore.currentProject?.config.settings.permissionPreset ?? 'chapter-material',
)

/** 切换权限档位：与设置页同一条 updateConfig 写回链路，下一轮起按新档判定 */
function handlePermissionPresetSelect(preset: PermissionPreset) {
  void projectStore.changePermissionPreset(props.projectId, preset)
}

// 最新一条 change-summary 的 id（该面板默认展开文件列表，历史轮折叠成标题行）
const lastChangeSummaryId = computed(() => {
  for (let index = chatStore.messages.length - 1; index >= 0; index -= 1) {
    const message = chatStore.messages[index]
    if (message.role === 'system' && message.kind === 'change-summary') {
      return message.id
    }
  }
  return null
})

/** QueueDock 空草稿 + Ctrl/Cmd+Enter：把全部排队消息逐条升级为插话（dsh 增强项） */
async function steerAllQueued() {
  for (const message of chatStore.queue) {
    if (message.placement === 'queued') {
      await chatStore.steerQueuedMessage(message.id)
    }
  }
}

/** v-for key 统一入口（vue-tsc 对 :key 内联三元 narrowing 不稳，收在函数里） */
function renderItemKey(item: ChatRenderItem): string {
  if (item.kind === 'process-group') {
    return `group-${item.id}`
  }
  if (item.kind === 'tool-row') {
    return `tool-${item.id}`
  }
  return item.message.id
}

// ===== 输入框 AI 补全（FIM ghost text） =====
const completionConfig = computed(() => projectStore.currentProject?.config.completion)
const { suggestion: completionSuggestion, scheduleCompletion, acceptNextSegment, clearSuggestion } = useInlineCompletion()
/** 补全是否处于可显示状态（开启 + 有建议 + 非运行中） */
const isCompletionVisible = computed(
  () => !!completionConfig.value?.enabled && completionSuggestion.value.length > 0 && !chatStore.isRunning,
)

// 自动滚动到底部
async function scrollToBottom() {
  await nextTick()
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

// ===== 历史翻页（借鉴 dsh：滚动到顶自动加载 + 位置锚定） =====
/** 距顶多少 px 内触发向前翻页 */
const OLDER_LOAD_THRESHOLD_PX = 200
/** prepend 在途标志：阻止 messages.length watch 把翻页误判为新消息而吸底 */
const isPrepending = ref(false)

/**
 * 滚动监听：距顶 200px 内且还有更早历史时自动向前翻一页。
 * 锚定用 scrollHeight 差值法：prepend 后内容整体下移，按新增高度回推 scrollTop，
 * 阅读位置不跳动。loadingOlder 与 isPrepending 双重防重入；恢复后仍在阈值内时
 * scroll 事件会自然再触发（逐页连续上翻），不会失控级联——一页 100 条的高度
 * 通常远超阈值，恢复后的位置已在阈值之外。
 */
async function handleMessagesScroll() {
  const container = messagesContainer.value
  if (!container) return
  if (container.scrollTop >= OLDER_LOAD_THRESHOLD_PX) return
  if (!chatStore.hasMoreHistory || chatStore.loadingOlder || isPrepending.value) return

  const previousHeight = container.scrollHeight
  const previousTop = container.scrollTop
  isPrepending.value = true
  try {
    const loaded = await chatStore.loadOlderHistory()
    if (!loaded) return
    await nextTick()
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop =
        messagesContainer.value.scrollHeight - previousHeight + previousTop
    }
  } finally {
    isPrepending.value = false
  }
}

watch(
  () => chatStore.messages.length,
  () => {
    // prepend 旧历史不是新消息：位置由 handleMessagesScroll 锚定，不吸底
    if (isPrepending.value) return
    scrollToBottom()
  },
)


/**
 * 发送（输入框运行中解禁，dsh 风）：mode 'queue' = Enter 语义（空闲直接发送 / 运行中排队），
 * 'steer' = Ctrl/Cmd+Enter 插话。失败时草稿填回输入框。
 */
async function handleSend(mode: 'queue' | 'steer' = 'queue') {
  if (!inputText.value.trim()) return

  clearSuggestion()
  const message = inputText.value.trim()
  // 发送前快照引用文本（发送过程中 chip 可能被清除）
  const quoteText = props.quote?.text
  inputText.value = ''

  // 重置 textarea 高度
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
  }

  const ok = await chatStore.sendMessage(message, quoteText, mode)
  if (ok) {
    // 发送成功后清除引用 chip
    emit('clearQuote')
  } else {
    // 发送失败草稿恢复：把文本填回输入框（dsh restoreFailedDrafts 简单版）
    inputText.value = message
  }
}

function handleStop() {
  chatStore.abortRun()
}

function handleKeydown(event: KeyboardEvent) {
  // 输入框 AI 补全交互（最高优先级，贴近光标）：
  // - IME 组合态放行，避免在中文选词时误触 Tab/Esc
  // - Tab 接受建议的首个分词单位；Esc 丢弃剩余建议
  // - 仅当 ghost text 可见时拦截，避免吞掉其他场景的 Tab/Esc
  if (!isImeComposing(event) && isCompletionVisible.value) {
    if (event.key === 'Tab') {
      event.preventDefault()
      acceptCompletionSegment()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      clearSuggestion()
      return
    }
  }
  // /提取要素 章节选择打开时：仅拦截 Esc（选择走鼠标点击）
  if (isChapterPickerOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      isChapterPickerOpen.value = false
      return
    }
  }
  // 斜杠命令菜单打开时：拦截导航键交给菜单
  if (isSlashMenuOpen.value && slashMenuRef.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      slashMenuRef.value.moveDown()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      slashMenuRef.value.moveUp()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      slashMenuRef.value.confirm()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      isSlashMenuOpen.value = false
      return
    }
  }
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
  // 发送模式（dsh resolveSubmitMode）：Enter = 发送/排队，Ctrl/Cmd+Enter = 插话，
  // Shift+Enter 换行；空草稿 + Ctrl/Cmd+Enter = 全部排队消息逐条插话
  const submitMode = resolveSubmitMode(event)
  if (submitMode) {
    event.preventDefault()
    if (submitMode === 'steer' && !inputText.value.trim()) {
      void steerAllQueued()
      return
    }
    handleSend(submitMode === 'steer' ? 'steer' : 'queue')
  }
}

function autoResize(event: Event) {
  const textarea = event.target as HTMLTextAreaElement
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
}

/** textarea input 统一入口：自适应高度 + 指令检测（R4 @场景 / R6 /提取要素）+ 输入补全调度 */
function onTextareaInput(event: Event) {
  autoResize(event)
  detectCommands()
  scheduleInlineCompletion()
}

/**
 * 调度输入补全。命令菜单 / @场景 / 章节选择打开时不调度，避免与这些交互冲突。
 */
function scheduleInlineCompletion() {
  if (isSlashMenuOpen.value || isSceneCommandOpen.value || isChapterPickerOpen.value) {
    clearSuggestion()
    return
  }
  const cursor = textareaRef.value?.selectionStart ?? 0
  scheduleCompletion(inputText.value, cursor, completionConfig.value)
}

/**
 * 接受建议的首个分词单位：拼到 inputText 末尾，吃光后清空状态并重置高度。
 */
function acceptCompletionSegment() {
  const { accepted, hasMore } = acceptNextSegment()
  if (accepted) {
    inputText.value += accepted
    // 同步光标到末尾，让后续补全基于新光标位置
    nextTick(() => {
      if (textareaRef.value) {
        const end = inputText.value.length
        textareaRef.value.selectionStart = end
        textareaRef.value.selectionEnd = end
        textareaRef.value.style.height = 'auto'
        textareaRef.value.style.height = `${Math.min(textareaRef.value.scrollHeight, 200)}px`
      }
    })
  }
  if (!hasMore) {
    // 建议已吃完，基于新内容重新调度一次（可能续出下一段）
    scheduleInlineCompletion()
  }
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
 * 清除光标处匹配指定正则的 token（@场景、/命令 共用）。
 * 清除后光标回位并重新聚焦 textarea。
 */
function clearTokenAtCursor(re: RegExp) {
  const textarea = textareaRef.value
  if (!textarea) return
  const cursor = textarea.selectionStart ?? 0
  const beforeCursor = inputText.value.slice(0, cursor)
  const afterCursor = inputText.value.slice(cursor)
  const cleaned = beforeCursor.replace(re, '')
  inputText.value = cleaned + afterCursor
  nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.selectionStart = cleaned.length
      textareaRef.value.selectionEnd = cleaned.length
      textareaRef.value.focus()
    }
  })
}

/**
 * 选中场景后：清除输入框里的 @token（含筛选词），激活场景，关闭弹层。
 */
function handleSelectScene(path: string) {
  clearTokenAtCursor(SCENE_COMMAND_RE)
  isSceneCommandOpen.value = false
  sceneQuery.value = ''
  emit('changeScene', path)
}

function handleCloseSceneCommand() {
  isSceneCommandOpen.value = false
}

// ===== R6：斜杠命令菜单 / 提取要素 =====

/** 斜杠命令菜单是否打开（输入 / 后弹出命令列表） */
const isSlashMenuOpen = ref(false)
/** / 后的筛选词 */
const slashQuery = ref('')
/** 斜杠命令菜单组件引用（键盘导航用） */
const slashMenuRef = ref<InstanceType<typeof SlashCommandMenu> | null>(null)
/** /提取要素 章节多选弹层是否打开（选中命令后展开） */
const isChapterPickerOpen = ref(false)
/** 提取流程状态（composable 单例） */
const extraction = useElementExtraction()

/**
 * 匹配光标前最近的 / 命令前缀。
 * 规则与 @场景 同构：/ 前是行首或空白，/ 后到光标间不含空格/换行/。
 * 捕获组即筛选词（可能为空）。
 */
const SLASH_COMMAND_RE = /(?:^|\s)\/([^\s/]*)$/

/** 指令检测入口：input 回调统一调用 */
function detectCommands() {
  const textarea = textareaRef.value
  if (!textarea) {
    isSceneCommandOpen.value = false
    isSlashMenuOpen.value = false
    isChapterPickerOpen.value = false
    return
  }
  const cursor = textarea.selectionStart ?? 0
  const beforeCursor = inputText.value.slice(0, cursor)

  // @场景、/ 命令、章节选择三层互斥，同一时刻只开一个
  const sceneMatch = SCENE_COMMAND_RE.exec(beforeCursor)
  const slashMatch = SLASH_COMMAND_RE.exec(beforeCursor)

  if (slashMatch) {
    slashQuery.value = slashMatch[1]
    isSlashMenuOpen.value = true
    isSceneCommandOpen.value = false
    isChapterPickerOpen.value = false
  } else if (sceneMatch) {
    sceneQuery.value = sceneMatch[1]
    isSceneCommandOpen.value = props.scenes.length > 0
    isSlashMenuOpen.value = false
    isChapterPickerOpen.value = false
  } else {
    isSceneCommandOpen.value = false
    isSlashMenuOpen.value = false
    isChapterPickerOpen.value = false
  }
}

/**
 * 选中斜杠命令后：清除 / token，按命令类型展开二级界面。
 */
function handleSlashCommandSelect(id: SlashCommandId) {
  // 清除输入框里的 / token（含筛选词）
  clearTokenAtCursor(SLASH_COMMAND_RE)
  isSlashMenuOpen.value = false
  slashQuery.value = ''

  if (id === 'extract') {
    // 选中「提取要素」后展开章节多选
    isChapterPickerOpen.value = props.chapters.length > 0
    return
  }

  if (id === 'init') {
    // 选中「生成项目记忆」后，把驱动 prompt 直接作为用户意图发送，由 Agent 扫描项目并生成/更新 prompts/NovAI.md。
    // 不需要二级交互界面，复用普通对话发送链路。
    void chatStore.sendMessage(INIT_NOVEL_PROMPT)
  }
}

/**
 * ChapterPicker 确认：启动提取流程。
 */
function handleChapterPickerConfirm(chapters: ChapterPick[]) {
  isChapterPickerOpen.value = false
  extraction.startExtraction(props.projectId, chapters)
}

function handleChapterPickerCancel() {
  isChapterPickerOpen.value = false
}

/**
 * 提取流程：确认写入。
 */
async function handleExtractionConfirm() {
  const result = await extraction.confirmWrite()
  if (result) {
    // 写入成功，通知 ProjectView 刷新文件树
    emit('elementsWritten')
  }
}
</script>

<template>
  <section class="relative flex min-w-0 flex-1 flex-col">
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
      @scroll="handleMessagesScroll"
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

        <!-- 消息列表：渲染序列（配对 + 分组预处理后的渲染树） -->
        <div v-else class="space-y-4">
          <!-- 向前翻页加载态（滚动到顶自动触发；无更多历史时不显示任何入口） -->
          <div
            v-if="chatStore.loadingOlder"
            class="flex items-center justify-center gap-2 py-1 text-xs text-gray-400"
          >
            <svg class="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            正在加载更早消息…
          </div>
          <template v-for="item in chatStore.renderItems" :key="renderItemKey(item)">
            <!-- 任务过程折叠组：组头 + 包裹容器（子项经插槽注入） -->
            <TurnProcessGroup
              v-if="item.kind === 'process-group'"
              :group="item"
              @toggle="chatStore.toggleProcessGroup"
            >
              <template v-for="child in item.items" :key="renderItemKey(child)">
                <ToolCallRow v-if="child.kind === 'tool-row'" :item="child" />
                <MessageItem
                  v-else-if="child.kind === 'message'"
                  :message="child.message"
                  :streaming="child.message.id === chatStore.streamingMessageId"
                  :newest-change-summary="child.message.id === lastChangeSummaryId"
                />
              </template>
            </TurnProcessGroup>

            <!-- 工具行（调用/结果合一） -->
            <ToolCallRow v-else-if="item.kind === 'tool-row'" :item="item" />

            <!-- 普通消息 -->
            <MessageItem
              v-else-if="item.kind === 'message'"
              :message="item.message"
              :streaming="item.message.id === chatStore.streamingMessageId"
              :newest-change-summary="item.message.id === lastChangeSummaryId"
            />
          </template>
        </div>
      </div>
    </div>

    <!-- 要素提取流程面板（R6） -->
    <ExtractionFlowPanel
      v-if="extraction.phase.value !== 'idle'"
      :phase="extraction.phase.value"
      :extraction-result="extraction.extractionResult.value"
      :write-result="extraction.writeResult.value"
      :progress-current="extraction.progressCurrent.value"
      :progress-total="extraction.progressTotal.value"
      :progress-chapter-name="extraction.progressChapterName.value"
      :error-message="extraction.errorMessage.value"
      @confirm="handleExtractionConfirm"
      @cancel="extraction.cancel()"
      @dismiss="extraction.dismiss()"
    />

    <!-- 写工具确认卡片（Agent Step 2/3） -->
    <WriteConfirmationCard
      v-if="chatStore.pendingConfirmation"
      :confirmation="chatStore.pendingConfirmation.confirmation"
      :tool-name="chatStore.pendingConfirmation.toolName"
      :title="chatStore.pendingConfirmation.title"
      :summary="chatStore.pendingConfirmation.summary"
      @confirm="chatStore.confirmWriteTool()"
      @reject="chatStore.rejectWriteTool()"
    />

    <!-- 输入区域 -->
    <div class="border-t border-gray-200 bg-white px-4 py-3">
      <div class="mx-auto max-w-3xl">
        <!-- QueueDock：输入框正上方，渲染排队/插话队列（空队列不渲染） -->
        <QueueDock
          :queue="chatStore.queue"
          :running="chatStore.isRunning"
          @edit="chatStore.editQueuedMessage"
          @remove="chatStore.removeQueuedMessage"
          @steer="chatStore.steerQueuedMessage"
        />
        <!-- chip 区：引用 chip（场景 chip 已移至底部状态栏） -->
        <div v-if="quote" class="mb-2 flex flex-wrap items-center gap-2">
          <SelectionChip
            v-if="quote"
            :file-name="quote.name"
            :text="quote.text"
            @remove="emit('clearQuote')"
          />
        </div>
        <div class="relative">
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
          <!-- 斜杠命令菜单（R6） -->
          <SlashCommandMenu
            v-if="isSlashMenuOpen"
            ref="slashMenuRef"
            :query="slashQuery"
            @select="handleSlashCommandSelect"
            @close="isSlashMenuOpen = false"
          />
          <!-- /提取要素 章节多选弹层（R6） -->
          <ChapterPicker
            v-if="isChapterPickerOpen"
            :chapters="chapters"
            @confirm="handleChapterPickerConfirm"
            @cancel="handleChapterPickerCancel"
          />
          <!-- 卡片式输入框：textarea + ghost text 覆盖层 + 工具行（发送按钮） -->
          <div class="chat-input-card">
            <!-- textarea + ghost text 覆盖层（补全开启且有建议时） -->
            <div class="relative">
              <GhostTextOverlay
                v-if="isCompletionVisible"
                :input-text="inputText"
                :suggestion="completionSuggestion"
              />
              <textarea
                ref="textareaRef"
                v-model="inputText"
                class="chat-input-base resize-none bg-transparent text-gray-800 outline-none placeholder:text-gray-400"
                :placeholder="chatStore.isRunning
                  ? 'Agent 运行中：Enter 排队发送，Ctrl/Cmd+Enter 插话，Shift+Enter 换行'
                  : '输入创作指令... (Enter 发送，Shift+Enter 换行；输入 @ 切换场景)'"
                rows="2"
                @keydown="handleKeydown"
                @input="onTextareaInput"
              />
            </div>
            <!-- 工具行：左侧权限档位入口 + 右侧发送（模式感知文案）/ 停止按钮（独立位置，仅运行中显示） -->
            <div class="mt-1 flex items-center justify-between gap-2">
              <PermissionPresetPicker
                :preset="currentPermissionPreset"
                @select="handlePermissionPresetSelect"
              />
              <div class="flex items-center gap-2">
              <button
                v-if="isStopping"
                class="shrink-0 rounded-lg border border-gray-200 bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-400"
                title="正在停止…"
                disabled
              >
                <svg class="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </button>
              <button
                v-else-if="chatStore.isRunning"
                class="shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
                title="停止运行"
                @click="handleStop"
              >
                <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
                </svg>
              </button>
              <!-- 插话鼠标入口（与 Ctrl/Cmd+Enter 同一条 handleSend('steer') 链路）：运行中才显示 -->
              <button
                v-if="chatStore.isRunning"
                class="shrink-0 cursor-pointer rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-30"
                :disabled="!inputText.trim()"
                title="插话：下一个工具边界生效，不打断当前任务（等同 Ctrl/Cmd+Enter）"
                @click="handleSend('steer')"
              >
                插话
              </button>
              <button
                class="shrink-0 cursor-pointer rounded-lg bg-black px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-30"
                :disabled="!inputText.trim()"
                :title="chatStore.isRunning ? '排队发送：当前任务跑完后作为新一轮执行（Ctrl/Cmd+Enter 插话）' : '发送'"
                @click="handleSend('queue')"
              >
                {{ chatStore.isRunning ? '排队发送' : '发送' }}
              </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
