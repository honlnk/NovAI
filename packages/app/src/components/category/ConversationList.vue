<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ChatSessionSummaryView } from '@novai/core/services/types'
import { AGENT_ROLE_META } from '../../constants/agent-roles'
import { CONVERSATION_FILTER_META, useConversationFilter, type ConversationFilter } from '../../composables/useConversationFilter'
import AppIcon from '../ui/AppIcon.vue'

const props = defineProps<{
  sessions: ChatSessionSummaryView[]
  activeSessionId: string | null
  /** 有待确认卡片的会话 id 集（徽标；委派中的要素管理员会话等用户打开确认） */
  pendingConfirmationIds?: Set<string>
  /** 有待回答提问卡的会话 id 集（徽标；蓝色中性样式，与 amber 待确认区分） */
  pendingQuestionIds?: Set<string>
  /** 实时运行中的会话 id 集（事件驱动；「进行中」筛选与徽标来源） */
  runningIds?: Set<string>
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  create: []
  rename: [sessionId: string, title: string]
  /** 归档（轻提示与撤销由外层统一处理） */
  archive: [sessionId: string]
  /** 恢复归档（归档区与撤销共用；只清标记，不动现场） */
  unarchive: [sessionId: string]
  /** 永久删除（仅已归档项提供，外层危险确认） */
  remove: [sessionId: string]
}>()

// 搜索与筛选：模块级单例（「查看已归档」动作跨组件触达）
const { search, filter } = useConversationFilter()

/**
 * 「待处理」判定：实时待确认/待回答集合，或落盘快照停在待确认态。
 * 快照 waiting-user 不算——driver 每次正常收敛都落 waiting-user（等用户发言是
 * 会话的常态），拿它当兜底会让所有聊完的会话都常驻「待处理」。
 */
function isPending(session: ChatSessionSummaryView): boolean {
  return props.pendingConfirmationIds?.has(session.sessionId) === true
    || props.pendingQuestionIds?.has(session.sessionId) === true
    || session.status === 'awaiting-confirmation'
}

/** 筛选 + 标题搜索后的平铺列表（updatedAt 降序由 store 保证） */
const filteredSessions = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return props.sessions.filter((session) => {
    if (keyword && !session.title.toLowerCase().includes(keyword)) {
      return false
    }
    if (filter.value === 'archived') {
      return session.archivedAt !== undefined
    }
    // 非归档区一律隐藏已归档（归档只改变默认可见性）
    if (session.archivedAt !== undefined) {
      return false
    }
    if (filter.value === 'active') {
      return props.runningIds?.has(session.sessionId) === true
    }
    if (filter.value === 'pending') {
      return isPending(session)
    }
    return true
  })
})

/** 列表为空的文案：区分「没有对话」「筛选/搜索无结果」「归档区为空」 */
const emptyText = computed(() => {
  if (props.sessions.length === 0) {
    return { title: '还没有对话', hint: '点击「新对话」开始创作' }
  }
  if (search.value.trim()) {
    return { title: '没有匹配的对话', hint: '换个关键词试试' }
  }
  if (filter.value === 'archived') {
    return { title: '没有已归档的对话', hint: '在对话的「更多」菜单里归档' }
  }
  if (filter.value === 'active') {
    return { title: '没有进行中的对话', hint: '发送消息后这里会显示运行状态' }
  }
  if (filter.value === 'pending') {
    return { title: '没有待处理的对话', hint: '有确认或提问等待时这里会显示' }
  }
  return { title: '没有对话', hint: '点击「新对话」开始创作' }
})

/** 行内状态徽标：优先实时事件态，快照 status 兜底（刷新后实时集为空）。快照 running 不标——刷新后 driver 注册表已空，必然没在跑。 */
function statusBadge(session: ChatSessionSummaryView): { label: string; class: string; title: string } | null {
  if (props.runningIds?.has(session.sessionId)) {
    return { label: '进行中', class: 'bg-green-500/15 text-green-300', title: '该会话正在执行任务' }
  }
  if (props.pendingConfirmationIds?.has(session.sessionId) || session.status === 'awaiting-confirmation') {
    return { label: '待确认', class: 'bg-amber-500/15 text-amber-300', title: '该会话有等待确认的写操作，点开处理' }
  }
  if (props.pendingQuestionIds?.has(session.sessionId)) {
    return { label: '待回答', class: 'bg-blue-500/15 text-blue-300', title: '该会话有等待回答的提问，点开处理' }
  }
  if (session.status === 'error') {
    return { label: '异常', class: 'bg-red-500/15 text-red-300', title: '该会话上一轮执行出错' }
  }
  return null
}

/** 角色小标签：特化角色显示（主角色不标，平铺列表里保持干净） */
function roleLabel(session: ChatSessionSummaryView): string | null {
  if (!session.agent || session.agent === 'main') {
    return null
  }
  return AGENT_ROLE_META[session.agent]?.label ?? session.agent
}

// ---------- 更多菜单（⋯）：悬停 / 键盘聚焦 / 触屏均可达 ----------

const openMenuId = ref<string | null>(null)

function toggleMenu(sessionId: string) {
  openMenuId.value = openMenuId.value === sessionId ? null : sessionId
}

function closeMenu() {
  openMenuId.value = null
}

function onDocumentClick(event: MouseEvent) {
  if (!(event.target instanceof Element)) {
    return
  }
  // 点在菜单或其按钮内不关闭（菜单项自身处理）；点其他区域关闭
  if (event.target.closest('[data-session-menu]')) {
    return
  }
  closeMenu()
}

onMounted(() => document.addEventListener('click', onDocumentClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))

function onMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeMenu()
  }
}

// ---------- 内联重命名（保留既有交互） ----------

const renamingId = ref<string | null>(null)
const renameDraft = ref('')

function startRename(session: ChatSessionSummaryView) {
  closeMenu()
  renamingId.value = session.sessionId
  renameDraft.value = session.title
}

function commitRename(sessionId: string) {
  // 防重入：Enter 会先触发 keydown 提交，随即 input 卸载又触发 blur。
  // 第一次提交后 renamingId 已置 null，第二次进入直接返回，避免重复 emit。
  if (renamingId.value === null) {
    return
  }

  const title = renameDraft.value.trim()
  renamingId.value = null
  if (title) {
    emit('rename', sessionId, title)
  }
}

function cancelRename() {
  renamingId.value = null
}

/** 永久删除（仅已归档项；删除不可撤销，原生 confirm 是计划保留的危险确认） */
function confirmRemove(session: ChatSessionSummaryView) {
  closeMenu()
  if (window.confirm(`确定永久删除「${session.title}」吗？归档的对话删除后不可恢复。`)) {
    emit('remove', session.sessionId)
  }
}

/** 相对时间：今天显示 HH:mm，今年显示 MM-DD，更早显示完整日期 */
function formatRelativeTime(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  const sameYear = date.getFullYear() === now.getFullYear()
  if (sameYear) {
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }
  return date.toLocaleDateString('zh-CN')
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-between px-4 py-3">
      <h2 class="text-sm font-semibold text-white">对话</h2>
      <button
        class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
        title="开始新对话"
        @click="emit('create')"
      >
        <AppIcon name="plus" :size="14" class="h-3.5 w-3.5" />
        <span>新对话</span>
      </button>
    </div>

    <!-- 标题搜索 -->
    <div class="px-3 pb-2">
      <div class="relative">
        <AppIcon name="search" :size="14" class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
        <input
          v-model="search"
          type="search"
          placeholder="搜索对话标题"
          class="w-full rounded-md border border-white/10 bg-white/5 py-1.5 pl-8 pr-2 text-xs text-gray-200 outline-none transition-colors placeholder:text-gray-500 focus:border-white/25"
        >
      </div>
    </div>

    <!-- 筛选 tab：全部 / 进行中 / 待处理 / 已归档 -->
    <div class="flex gap-1 px-3 pb-2" role="tablist" aria-label="会话筛选">
      <button
        v-for="meta in CONVERSATION_FILTER_META"
        :key="meta.key"
        role="tab"
        :aria-selected="filter === meta.key"
        :class="[
          'rounded-full px-2.5 py-1 text-xs transition-colors',
          filter === meta.key
            ? 'bg-white/15 text-white'
            : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
        ]"
        @click="filter = meta.key as ConversationFilter"
      >
        {{ meta.label }}
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-2 pb-2">
      <!-- 空状态（区分无对话 / 筛选无结果 / 归档区为空） -->
      <div v-if="filteredSessions.length === 0" class="px-2 py-8 text-center">
        <AppIcon name="message-circle-more" :size="40" class="mx-auto mb-3 h-10 w-10 text-gray-600" />
        <p class="mb-1 text-sm text-gray-400">{{ emptyText.title }}</p>
        <p class="text-xs text-gray-500">{{ emptyText.hint }}</p>
      </div>

      <!-- 会话列表（平铺，按最近实际活动排序；角色用小标签区分） -->
      <ul v-else class="space-y-0.5">
        <li v-for="session in filteredSessions" :key="session.sessionId" class="group relative">
          <!-- 重命名态：内联输入框 -->
          <div
            v-if="renamingId === session.sessionId"
            class="flex items-center rounded-md bg-white/10 px-2 py-1.5"
          >
            <input
              v-model="renameDraft"
              class="min-w-0 flex-1 rounded bg-transparent text-sm text-white outline-none placeholder:text-gray-500"
              placeholder="会话标题"
              @keydown.enter="commitRename(session.sessionId)"
              @keydown.esc="cancelRename"
              @blur="commitRename(session.sessionId)"
            >
          </div>

          <!-- 展示态：会话卡片 -->
          <template v-else>
            <button
              :class="[
                'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors',
                session.sessionId === activeSessionId
                  ? 'bg-white/15 text-white'
                  : 'text-gray-300 hover:bg-white/10 hover:text-white',
              ]"
              @click="emit('select', session.sessionId); closeMenu()"
            >
              <AppIcon name="message-circle-more" :size="16" class="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <p class="truncate text-sm" :class="session.archivedAt !== undefined ? 'text-gray-400' : ''">{{ session.title }}</p>
                  <span
                    v-if="roleLabel(session)"
                    class="inline-flex shrink-0 items-center rounded bg-violet-500/15 px-1 py-0.5 text-[10px] leading-none text-violet-300"
                  >{{ roleLabel(session) }}</span>
                  <span
                    v-if="statusBadge(session)"
                    class="inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] leading-none"
                    :class="statusBadge(session)!.class"
                    :title="statusBadge(session)!.title"
                  >{{ statusBadge(session)!.label }}</span>
                </div>
                <p class="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                  <span>{{ formatRelativeTime(session.updatedAt) }}</span>
                  <span>·</span>
                  <span>{{ session.messageCount }} 条</span>
                </p>
              </div>
            </button>

            <!-- 更多菜单（⋯）：悬停 / 键盘聚焦可见，触屏常显 -->
            <div
              class="absolute right-1 top-1.5 flex items-center"
              data-session-menu
            >
              <button
                aria-label="更多操作"
                :aria-expanded="openMenuId === session.sessionId"
                :class="[
                  'rounded p-1 text-gray-400 transition-opacity hover:bg-white/15 hover:text-white',
                  openMenuId === session.sessionId ? 'opacity-100' : 'opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100',
                ]"
                @click.stop="toggleMenu(session.sessionId)"
                @keydown="onMenuKeydown"
              >
                <AppIcon name="dots-vertical" :size="16" class="h-4 w-4" />
              </button>

              <!-- 下拉菜单 -->
              <div
                v-if="openMenuId === session.sessionId"
                class="absolute right-0 top-7 z-20 w-36 overflow-hidden rounded-lg border border-white/10 bg-[#202020] py-1 shadow-xl"
                role="menu"
              >
                <button
                  role="menuitem"
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-200 transition-colors hover:bg-white/10"
                  @click="startRename(session)"
                >
                  <AppIcon name="square-pen" :size="14" class="h-3.5 w-3.5 text-gray-400" />
                  重命名
                </button>
                <button
                  v-if="session.archivedAt === undefined"
                  role="menuitem"
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-200 transition-colors hover:bg-white/10"
                  @click="closeMenu(); emit('archive', session.sessionId)"
                >
                  <AppIcon name="archive" :size="14" class="h-3.5 w-3.5 text-gray-400" />
                  归档
                </button>
                <template v-else>
                  <button
                    role="menuitem"
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-200 transition-colors hover:bg-white/10"
                    @click="closeMenu(); emit('unarchive', session.sessionId)"
                  >
                    <AppIcon name="refresh-cw" :size="14" class="h-3.5 w-3.5 text-gray-400" />
                    恢复
                  </button>
                  <button
                    role="menuitem"
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-300 transition-colors hover:bg-red-500/15"
                    @click="confirmRemove(session)"
                  >
                    <AppIcon name="trash" :size="14" class="h-3.5 w-3.5" />
                    永久删除
                  </button>
                </template>
              </div>
            </div>
          </template>
        </li>
      </ul>
    </div>
  </div>
</template>
