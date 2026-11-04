<script setup lang="ts">
import type { ChatSessionSummaryView, PlanCardSummaryView, ProjectFileNodeView } from '@novai/core/services/types'
import type { Category } from '../../constants/category'
import ChapterList from '../category/ChapterList.vue'
import ElementList from '../category/ElementList.vue'
import PromptList from '../category/PromptList.vue'
import ConversationList from '../category/ConversationList.vue'
import PlanList from '../category/PlanList.vue'

defineProps<{
  activeCategory: Category
  files: ProjectFileNodeView[]
  activeFilePath?: string
  activeOutlinePath: string | null
  /** 历史会话列表（对话分类面板用） */
  sessions: ChatSessionSummaryView[]
  /** 当前激活会话 id（对话分类面板高亮用） */
  activeSessionId: string | null
  /** 有待确认卡片的会话 id 集（会话列表「待确认」徽标；确认链按会话路由） */
  pendingConfirmationIds?: Set<string>
  /** 计划卡片摘要（计划分类面板计数与最近列表用） */
  planCards: PlanCardSummaryView[]
  /** 计划板读取中 */
  isPlanLoading: boolean
  /** 有待回答提问卡的会话 id 集（会话列表「待回答」徽标；提问按会话路由） */
  pendingQuestionIds?: Set<string>
  /** 移动端抽屉是否展开（沿用现有响应式方案） */
  isMobileOpen: boolean
  /** 面板是否展开（桌面端折叠/展开） */
  isOpen: boolean
}>()

const emit = defineEmits<{
  selectFile: [path: string]
  changeOutline: [path: string | null]
  closeMobile: []
  selectSession: [sessionId: string]
  createSession: []
  renameSession: [sessionId: string, title: string]
  deleteSession: [sessionId: string]
  /** 打开主内容区计划看板 */
  openPlanBoard: []
  /** 新建计划（在主内容区看板新建输入） */
  createPlan: []
  /** 打开某张计划卡片详情 */
  openPlanCard: [id: string]
}>()
</script>

<template>
  <aside
    :class="[
      'flex shrink-0 flex-col bg-[#171717] text-gray-100 transition-all duration-200',
      'max-lg:fixed max-lg:inset-y-0 max-lg:left-[56px] max-lg:z-50',
      isOpen ? 'w-64' : 'w-0 overflow-hidden',
      isMobileOpen ? 'max-lg:translate-x-0' : 'max-lg:-translate-x-full',
    ]"
  >
    <!-- 移动端关闭按钮 -->
    <button
      aria-label="关闭分类面板"
      class="absolute right-2 top-2 z-10 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-white lg:hidden"
      @click="emit('closeMobile')"
    >
      <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>

    <!-- 按分类切换内容 -->
    <ConversationList
      v-if="activeCategory === 'conversation'"
      :sessions="sessions"
      :active-session-id="activeSessionId"
      :pending-confirmation-ids="pendingConfirmationIds"
      :pending-question-ids="pendingQuestionIds"
      @select="emit('selectSession', $event)"
      @create="emit('createSession')"
      @rename="(sessionId, title) => emit('renameSession', sessionId, title)"
      @remove="emit('deleteSession', $event)"
    />
    <ChapterList
      v-else-if="activeCategory === 'chapter'"
      :files="files"
      :active-file-path="activeFilePath"
      @select-file="emit('selectFile', $event)"
    />
    <ElementList
      v-else-if="activeCategory === 'element'"
      :files="files"
      :active-file-path="activeFilePath"
      @select-file="emit('selectFile', $event)"
    />
    <PromptList
      v-else-if="activeCategory === 'prompt'"
      :files="files"
      :active-file-path="activeFilePath"
      :active-outline-path="activeOutlinePath"
      @select-file="emit('selectFile', $event)"
      @change-outline="emit('changeOutline', $event)"
    />
    <PlanList
      v-else-if="activeCategory === 'plan'"
      :cards="planCards"
      :is-loading="isPlanLoading"
      @open-board="emit('openPlanBoard')"
      @create="emit('createPlan')"
      @open-card="emit('openPlanCard', $event)"
    />
  </aside>
</template>
