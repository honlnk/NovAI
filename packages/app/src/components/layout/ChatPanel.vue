<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ProjectFileNodeView } from '@novai/core/services/types'
import { GARDENER_TASK_PROMPT } from '@novai/core/services/agent-service'
import { getGardenerPresets } from '@novai/core/services/settings-service'
import type { GardenerPresetView } from '@novai/core/services/types'
import { useChatStore } from '../../stores/chat'
import { isGardenerShortcut, isImeComposing, resolveSubmitMode } from '../../composables/keyboard'
import { useElementExtraction, type ChapterPick } from '../../composables/useElementExtraction'
import { useInlineCompletion } from '../../composables/useInlineCompletion'
import { useProjectStore } from '../../stores/project'
import MessageItem from '../chat/MessageItem.vue'
import PermissionPresetPicker from '../chat/PermissionPresetPicker.vue'
import QueueDock from '../chat/QueueDock.vue'
import SelectionChip from '../chat/SelectionChip.vue'
import OutlineCommandPopover from '../chat/OutlineCommandPopover.vue'
import ChapterPicker from '../chat/ChapterPicker.vue'
import ExtractionFlowPanel from '../chat/ExtractionFlowPanel.vue'
import GardenerTaskDialog from '../chat/GardenerTaskDialog.vue'
import { buildGardenerTaskMessage, type GardenerTaskParams } from '../chat/gardener-task'
import GhostTextOverlay from '../chat/GhostTextOverlay.vue'
import ToolCallRow from '../chat/ToolCallRow.vue'
import TurnProcessGroup from '../chat/TurnProcessGroup.vue'
import WriteConfirmationCard from '../chat/WriteConfirmationCard.vue'
import SlashCommandMenu from '../chat/SlashCommandMenu.vue'
import {
  expandSlashCommand,
  SLASH_COMMANDS,
  slashCommandDraftText,
  type SlashCommandId,
} from '../../constants/slash-commands'
import type { ChatRenderItem } from '../../stores/chat-render'
import type { PermissionPreset } from '@novai/core/types/project'
import type { ReasoningEffort } from '@novai/core/types/ai'

import ReasoningEffortPicker from '../chat/ReasoningEffortPicker.vue'
import { reasoningEffortLabel, reasoningEffortOptions } from '../../constants/reasoning-efforts'

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
  /** 写作大纲列表（prompts/outlines/*.md），供 @ 指令选择 **/
  outlines: ProjectFileNodeView[]
  /** 当前激活的大纲路径，null 表示未激活 **/
  activeOutlinePath: string | null
  /** 章节列表（chapters/*.txt|.md），供 /提取要素 选择（R6） */
  chapters: ProjectFileNodeView[]
}>()

const emit = defineEmits<{
  toggleSidebar: []
  toggleContentPanel: []
  toggleMobileSidebar: []
  clearQuote: []
  /** 切换激活大纲，path 为 null 表示关闭 **/
  changeOutline: [path: string | null]
  /** 要素写入完成，通知 ProjectView 刷新文件树（R6） */
  elementsWritten: []
  /** 园丁弹窗空态「新建快捷选项」：请求打开设置页（要素整理参数化 W1） */
  openGardenerSettings: []
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

/** 当前思考强度档位与可选档位（按协议 × 方言过滤，思考强度计划 D3；未配置按 off 显示） */
const currentReasoningEffort = computed(
  () => projectStore.currentProject?.config.llm.reasoningEffort ?? 'off',
)
const reasoningEffortOptionList = computed(() => {
  const llm = projectStore.currentProject?.config.llm
  return reasoningEffortOptions(llm?.protocol ?? 'openai', llm?.baseUrl ?? '')
})
const currentReasoningEffortLabel = computed(() => reasoningEffortLabel(currentReasoningEffort.value))

/** 切换思考档位：updateConfig 写回，下一轮请求起生效 */
function handleReasoningEffortSelect(effort: ReasoningEffort) {
  void projectStore.changeReasoningEffort(props.projectId, effort)
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
  if (item.kind === 'subagent-group') {
    return `subagent-${item.id}`
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

// ===== 跟随语义（借鉴 duet 的严格贴底判定）：仅当用户停留在底部时才自动吸底 =====
/** 是否跟随：上翻读历史即退出跟随，此后运行期新输出不再拽人 */
const isFollowing = ref(true)
/** 未跟随期间是否有新内容到达底部（驱动浮钮「有新内容」文案） */
const hasNewBelow = ref(false)

/**
 * 依真实滚动位置刷新跟随状态；回到底部时顺带清掉「有新内容」标记。
 * 跟随判定必须完全贴底（distance <= 0），上翻任意 1px 即退出——阈值式判定
 * （距底 N px 内算跟随）会在流式贴底与用户小幅上翻之间制造拉扯带，上翻被
 * 下一次自动吸底覆盖，表现为抖动（duet 的实践经验）。
 * distance < 0 的情况：内容不足一页、未出现滚动条，同样视为贴底。
 */
function updateFollowState(container: HTMLDivElement) {
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 0
  isFollowing.value = atBottom
  if (atBottom) {
    hasNewBelow.value = false
  }
}

/** 用户主动表达「要看最新」时（发送/切会话/点浮钮）恢复跟随并吸底 */
function followAndScrollToBottom() {
  isFollowing.value = true
  hasNewBelow.value = false
  void scrollToBottom()
}

// ===== 历史翻页（借鉴 dsh：滚动到顶自动加载 + 位置锚定） =====
/** 距顶多少 px 内触发向前翻页 */
const OLDER_LOAD_THRESHOLD_PX = 200
/** prepend 在途标志：阻止尾部签名 watch 把翻页误判为新消息而吸底 */
const isPrepending = ref(false)

/**
 * 滚动监听：先如实刷新跟随状态，再做翻页判定——
 * 距顶 200px 内且还有更早历史时自动向前翻一页。
 * 锚定用 scrollHeight 差值法：prepend 后内容整体下移，按新增高度回推 scrollTop，
 * 阅读位置不跳动。loadingOlder 与 isPrepending 双重防重入；恢复后仍在阈值内时
 * scroll 事件会自然再触发（逐页连续上翻），不会失控级联——一页 100 条的高度
 * 通常远超阈值，恢复后的位置已在阈值之外。
 */
async function handleMessagesScroll() {
  const container = messagesContainer.value
  if (!container) return
  updateFollowState(container)
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

/**
 * 尾部签名：条数 + 末条文本长度。流式 delta 只长文本不改条数，
 * 单靠 length 观察不到「尾部还在长」，签名把两类变化合并成一个标量。
 */
const tailSignature = computed(() => {
  const messages = chatStore.messages
  const last = messages[messages.length - 1]
  const lastTextLength = last && last.kind === 'text' ? last.text.length : 0
  return `${messages.length}:${lastTextLength}`
})

// 新内容到达（新消息/流式增长）：仅跟随中吸底，用户上翻读历史时不拽人
watch(tailSignature, () => {
  // prepend 旧历史不是新消息：位置由 handleMessagesScroll 锚定，不吸底
  if (isPrepending.value) return
  if (!isFollowing.value) {
    hasNewBelow.value = true
    return
  }
  scrollToBottom()
})

// 切换会话也吸底：窗口化后两个长会话的窗口等长（都恰好 100 条），
// 只靠尾部签名区分不出切换，会停留在上一个会话的阅读位置；
// 同时重置跟随，避免上个会话「上翻读历史」的状态泄漏到新会话
watch(
  () => chatStore.activeSessionId,
  () => {
    followAndScrollToBottom()
  },
)


/**
 * 发送（输入框运行中解禁，dsh 风）：mode 'queue' = Enter 语义（空闲直接发送 / 运行中排队），
 * 'steer' = Ctrl/Cmd+Enter 插话。失败时草稿填回输入框。
 */
async function handleSend(mode: 'queue' | 'steer' = 'queue') {
  const draft = inputText.value.trim()
  if (!draft) return

  clearSuggestion()
  // 斜杠命令前缀拦截（W3 D6）：行首命中的命令文本替换为驱动 prompt 全文，
  // 其后参数原样保留；不在行首的命令文本视作正文，不替换
  const message = expandSlashCommand(draft)
  // 发送前快照引用文本（发送过程中 chip 可能被清除）
  const quoteText = props.quote?.text
  inputText.value = ''

  // 重置 textarea 高度
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
  }

  // 自己发消息恒吸底：发送即「要看最新输出」的显式意图
  followAndScrollToBottom()
  const ok = await chatStore.sendMessage(message, quoteText, mode)
  if (ok) {
    // 发送成功后清除引用 chip
    emit('clearQuote')
  } else {
    // 发送失败草稿恢复：把原草稿文本填回输入框（dsh restoreFailedDrafts 简化版；
    // 填回的是用户输入的草稿而非替换后的 prompt 全文）
    inputText.value = draft
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
  // /提取要素 章节选择、园丁任务弹窗打开时：仅拦截 Esc（选择走鼠标点击）
  if (isChapterPickerOpen.value || isGardenerDialogOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      isChapterPickerOpen.value = false
      isGardenerDialogOpen.value = false
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
  // @大纲 弹层打开时：拦截导航键交给弹层
  if (isOutlineCommandOpen.value && outlinePopoverRef.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      outlinePopoverRef.value.moveDown()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      outlinePopoverRef.value.moveUp()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      outlinePopoverRef.value.confirm()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      handleCloseOutlineCommand()
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

/** textarea input 统一入口：自适应高度 + 指令检测（R4 @大纲 / R6 /提取要素）+ 输入补全调度 */
function onTextareaInput(event: Event) {
  autoResize(event)
  detectCommands()
  scheduleInlineCompletion()
}

/**
 * 调度输入补全。命令菜单 / @大纲 / 章节选择打开时不调度，避免与这些交互冲突。
 */
function scheduleInlineCompletion() {
  if (
    isSlashMenuOpen.value ||
    isOutlineCommandOpen.value ||
    isChapterPickerOpen.value ||
    isGardenerDialogOpen.value
  ) {
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

// ===== R4：@大纲 指令检测 =====

/** @大纲 弹层是否打开 */
const isOutlineCommandOpen = ref(false)
/** @ 后的筛选词 */
const outlineQuery = ref('')
/** 弹层组件引用（键盘导航用） */
const outlinePopoverRef = ref<InstanceType<typeof OutlineCommandPopover> | null>(null)

/**
 * 匹配光标前最近的 @ 指令。
 * 规则：@ 前是行首或空白，@ 后到光标间不含空格/换行/@。
 * 捕获组即筛选词（可能为空字符串）。
 */
const OUTLINE_COMMAND_RE = /(?:^|\s)@([^\s@]*)$/

/**
 * 清除/替换光标处匹配指定正则的 token（@大纲、/命令 共用；W3 起替换为命令文本）。
 * 正则锚定 beforeCursor 结尾，替换后光标落在替换文本之后并重新聚焦 textarea。
 * token 前的边界空白（正则的 (?:^|\s) 部分）保留，命令文本不会黏进前文。
 */
function replaceTokenAtCursor(re: RegExp, replacement = '') {
  const textarea = textareaRef.value
  if (!textarea) return
  const cursor = textarea.selectionStart ?? 0
  const beforeCursor = inputText.value.slice(0, cursor)
  const afterCursor = inputText.value.slice(cursor)
  const cleaned = beforeCursor.replace(re, (match: string) => {
    const boundary = match.startsWith('/') || match.startsWith('@') ? '' : match.slice(0, 1)
    return `${boundary}${replacement}`
  })
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
 * 选中大纲后：清除输入框里的 @token（含筛选词），激活大纲，关闭弹层。
 */
function handleSelectOutline(path: string) {
  replaceTokenAtCursor(OUTLINE_COMMAND_RE)
  isOutlineCommandOpen.value = false
  outlineQuery.value = ''
  emit('changeOutline', path)
}

function handleCloseOutlineCommand() {
  isOutlineCommandOpen.value = false
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
 * 规则与 @大纲 同构：/ 前是行首或空白，/ 后到光标间不含空格/换行/。
 * 捕获组即筛选词（可能为空）。
 */
const SLASH_COMMAND_RE = /(?:^|\s)\/([^\s/]*)$/

/** 指令检测入口：input 回调统一调用 */
function detectCommands() {
  const textarea = textareaRef.value
  if (!textarea) {
    isOutlineCommandOpen.value = false
    isSlashMenuOpen.value = false
    isChapterPickerOpen.value = false
    return
  }
  const cursor = textarea.selectionStart ?? 0
  const beforeCursor = inputText.value.slice(0, cursor)

  // @大纲、/ 命令、章节选择三层互斥，同一时刻只开一个
  const outlineMatch = OUTLINE_COMMAND_RE.exec(beforeCursor)
  const slashMatch = SLASH_COMMAND_RE.exec(beforeCursor)

  if (slashMatch) {
    slashQuery.value = slashMatch[1]
    isSlashMenuOpen.value = true
    isOutlineCommandOpen.value = false
    isChapterPickerOpen.value = false
  } else if (outlineMatch) {
    outlineQuery.value = outlineMatch[1]
    isOutlineCommandOpen.value = props.outlines.length > 0
    isSlashMenuOpen.value = false
    isChapterPickerOpen.value = false
  } else {
    isOutlineCommandOpen.value = false
    isSlashMenuOpen.value = false
    isChapterPickerOpen.value = false
  }
}

/**
 * 选中斜杠命令后（W3 新范式）：清除 / token，把命令文本落进输入框（尾部带空格、
 * 光标置后），命令是纯文本——用户可在其后补参数、可编辑可删除。
 * gardener 额外打开参数弹窗（确认后以弹窗拼装的消息为准发送）；
 * extract 保留 R6 旧行为（直接展开章节多选，不落文本——该命令随 W4 退役）。
 */
function handleSlashCommandSelect(id: SlashCommandId) {
  isSlashMenuOpen.value = false
  slashQuery.value = ''

  if (id === 'extract') {
    replaceTokenAtCursor(SLASH_COMMAND_RE)
    isChapterPickerOpen.value = props.chapters.length > 0
    return
  }

  const command = SLASH_COMMANDS.find((entry) => entry.id === id)
  if (!command) return
  replaceTokenAtCursor(SLASH_COMMAND_RE, slashCommandDraftText(command.label))

  if (id === 'gardener') {
    // 整理要素：落文本 + 打开参数弹窗；输入框残留的命令文本在弹窗确认发送时一并清掉，
    // 弹窗拼装的消息为准（避免双发）
    openGardenerDialog()
    return
  }

  // init（/生成项目记忆）：落文本后不自动发送，用户可补参数后 Enter；
  // 发送链路的前缀拦截会把命令文本替换为 INIT_NOVEL_PROMPT 全文
}

/**
 * 一键整理要素（园丁 Phase 2 W2 快捷入口）：全局快捷键入口直发裸 GARDENER_TASK_PROMPT——
 * 快捷键语义是「一键」，不弹参数弹窗；斜杠命令与工具栏按钮已改为参数弹窗（要素整理参数化 W1）。
 */
function triggerGardener() {
  followAndScrollToBottom()
  void chatStore.sendMessage(GARDENER_TASK_PROMPT)
}

// ===== 园丁任务参数弹窗（要素整理参数化 W1，target=current 实例） =====

/** 弹窗是否打开（锚定输入框上方） */
const isGardenerDialogOpen = ref(false)
/** 快捷选项数据源（打开弹窗时从 .novai/gardener-presets.json 拉取，失败降级为空） */
const gardenerPresets = ref<GardenerPresetView[]>([])

async function loadGardenerPresets() {
  try {
    gardenerPresets.value = await getGardenerPresets(props.projectId)
  } catch {
    gardenerPresets.value = []
  }
}

/** 输入框上方「🌿 整理要素」按钮 / 斜杠命令：打开参数弹窗（D1：当前会话） */
function openGardenerDialog() {
  void loadGardenerPresets()
  isGardenerDialogOpen.value = true
}

/** 弹窗确认：按 D3 拼装任务消息，发到当前会话（空闲即发，运行中排队）。
 *  斜杠入口落进输入框的 `/整理要素 …` 命令文本随发送清空——弹窗拼装的消息为准，避免双发。 */
async function handleGardenerConfirm(params: GardenerTaskParams) {
  isGardenerDialogOpen.value = false
  const hasCommandResidue = inputText.value.trimStart().startsWith('/整理要素')
  followAndScrollToBottom()
  const ok = await chatStore.sendMessage(buildGardenerTaskMessage(GARDENER_TASK_PROMPT, params))
  if (ok && hasCommandResidue) {
    inputText.value = ''
    if (textareaRef.value) {
      textareaRef.value.style.height = 'auto'
    }
  }
}

function handleGardenerDialogCancel() {
  isGardenerDialogOpen.value = false
}

/** 弹窗空态「新建快捷选项」：关弹窗并请求打开设置页（W2 起定位到要素整理 tab） */
function handleGardenerOpenSettings() {
  isGardenerDialogOpen.value = false
  emit('openGardenerSettings')
}

/**
 * 全局快捷键（window 级监听，不限输入框焦点）：Ctrl/Cmd+Shift+G 触发一键整理要素。
 * 模态框（BaseModal 带 role=dialog）打开时不抢键，避免在设置页等弹窗背后触发委派。
 */
function handleGlobalKeydown(event: KeyboardEvent) {
  if (!isGardenerShortcut(event) || document.querySelector('[role="dialog"]')) return
  event.preventDefault()
  triggerGardener()
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
})

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
          aria-label="打开分类面板"
          class="rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-gray-100 lg:hidden"
          @click="emit('toggleMobileSidebar')"
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <button
          :aria-label="isSidebarOpen ? '收起侧边栏' : '展开侧边栏'"
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
          :aria-label="isContentPanelOpen ? '收起内容面板' : '展开内容面板'"
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

    <!-- 消息列表区（relative 包裹：「回到底部」浮钮的定位父级；浮钮放进滚动容器会随内容滚走） -->
    <div class="relative flex min-h-0 flex-1 flex-col">
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
                  <!-- 园丁子代理嵌套任务组：组头带标签、嵌套缩进，子项为其工具行 -->
                  <TurnProcessGroup
                    v-if="child.kind === 'subagent-group'"
                    :group="child"
                    nested
                    @toggle="chatStore.toggleProcessGroup"
                  >
                    <template v-for="grandchild in child.items" :key="renderItemKey(grandchild)">
                      <ToolCallRow v-if="grandchild.kind === 'tool-row'" :item="grandchild" />
                    </template>
                  </TurnProcessGroup>
                  <ToolCallRow v-else-if="child.kind === 'tool-row'" :item="child" />
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

      <!-- 回到底部浮钮：退出跟随后出现；未跟随期间来过新内容时换文案提示 -->
      <button
        v-if="!isFollowing && chatStore.messages.length > 0"
        class="absolute bottom-4 right-6 z-10 flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-md transition-colors hover:bg-gray-50"
        @click="followAndScrollToBottom"
      >
        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
        </svg>
        {{ hasNewBelow ? '有新内容' : '回到底部' }}
      </button>
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
      :agent-label="chatStore.pendingConfirmation.agentLabel"
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
        <!-- chip 区：引用 chip（大纲 chip 已移至底部状态栏） -->
        <div v-if="quote" class="mb-2 flex flex-wrap items-center gap-2">
          <SelectionChip
            v-if="quote"
            :file-name="quote.name"
            :text="quote.text"
            @remove="emit('clearQuote')"
          />
        </div>
        <div class="relative">
          <!-- @大纲 指令弹层（R4） -->
          <OutlineCommandPopover
            v-if="isOutlineCommandOpen"
            ref="outlinePopoverRef"
            :outlines="outlines"
            :active-outline-path="activeOutlinePath"
            :query="outlineQuery"
            @select="handleSelectOutline"
            @close="handleCloseOutlineCommand"
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
          <!-- 园丁任务参数弹窗（要素整理参数化 W1）：锚定输入框上方，确认发当前会话 -->
          <div v-if="isGardenerDialogOpen" class="absolute bottom-full left-0 right-0 z-50 mb-2">
            <GardenerTaskDialog
              target="current"
              :chapters="chapters"
              :presets="gardenerPresets"
              @confirm="handleGardenerConfirm"
              @cancel="handleGardenerDialogCancel"
              @open-settings="handleGardenerOpenSettings"
            />
          </div>
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
                  : '输入创作指令... (Enter 发送，Shift+Enter 换行；输入 @ 切换大纲)'"
                rows="2"
                @keydown="handleKeydown"
                @input="onTextareaInput"
              />
            </div>
            <!-- 工具行：左侧权限档位，右侧发送（模式感知文案）/ 停止按钮（独立位置，仅运行中显示）。
                 思考强度入口紧贴发送按钮左侧（各家 agent 产品的习惯位），弹层右锚向上弹出 -->
            <div class="mt-1 flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <PermissionPresetPicker
                  :preset="currentPermissionPreset"
                  @select="handlePermissionPresetSelect"
                />
                <!-- 整理要素（参数弹窗入口，要素整理参数化 W1）：与斜杠命令同一入口；全局 Ctrl/Cmd+Shift+G 仍直发裸任务 -->
                <button
                  type="button"
                  class="flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-800"
                  title="整理要素库（可配任务参数；子智能体执行）；Agent 运行中自动排队"
                  @click="openGardenerDialog"
                >
                  <svg class="h-3.5 w-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
                  </svg>
                  <span>整理要素</span>
                </button>
              </div>
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
                <ReasoningEffortPicker
                  :effort="currentReasoningEffort"
                  :options="reasoningEffortOptionList"
                  :label="currentReasoningEffortLabel"
                  @select="handleReasoningEffortSelect"
                />
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
