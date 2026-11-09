<script setup lang="ts">
import type { ChatSessionSummaryView, ForeshadowingCardSummaryView, PlanCardSummaryView, ProjectFileNodeView, RhythmCardSummaryView } from '@novai/core/services/types'
import type { Category } from '../../constants/category'
import ChapterList from '../category/ChapterList.vue'
import ElementList from '../category/ElementList.vue'
import PromptList from '../category/PromptList.vue'
import ConversationList from '../category/ConversationList.vue'
import PlanList from '../category/PlanList.vue'
import ForeshadowingList from '../category/ForeshadowingList.vue'
import RhythmList from '../category/RhythmList.vue'
import AppIcon from '../ui/AppIcon.vue'

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
  /** 当前打开详情的计划卡片 id（侧栏最近计划选中态与详情一致） */
  selectedPlanCardId?: string | null
  /** 伏笔卡片摘要（伏笔分类面板计数与最近列表用） */
  foreshadowingCards: ForeshadowingCardSummaryView[]
  /** 伏笔板读取中 */
  isForeshadowingLoading: boolean
  /** 当前打开详情的伏笔 id（侧栏最近列表选中态与详情一致） */
  selectedForeshadowingId?: string | null
  /** 节奏卡摘要（节奏分类面板计数与最近列表用） */
  rhythmCards: RhythmCardSummaryView[]
  /** 节奏板读取中 */
  isRhythmLoading: boolean
  /** 当前打开详情的节奏卡 id（侧栏最近列表选中态与详情一致） */
  selectedRhythmId?: string | null
  /** 有待回答提问卡的会话 id 集（会话列表「待回答」徽标；提问按会话路由） */
  pendingQuestionIds?: Set<string>
  /** 实时运行中的会话 id 集（会话列表「进行中」筛选与徽标） */
  runningIds?: Set<string>
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
  archiveSession: [sessionId: string]
  unarchiveSession: [sessionId: string]
  deleteSession: [sessionId: string]
  /** 打开主内容区计划看板 */
  openPlanBoard: []
  /** 刷新计划（左侧标题行入口，布局统一计划 D7） */
  refreshPlan: []
  /** 打开某张计划卡片详情 */
  openPlanCard: [id: string]
  /** 新建计划（侧栏摘要卡下方入口） */
  openPlanCreate: []
  /** 打开主内容区伏笔看板 */
  openForeshadowingBoard: []
  /** 刷新伏笔（左侧标题行入口） */
  refreshForeshadowing: []
  /** 打开某条伏笔详情 */
  openForeshadowingCard: [id: string]
  /** 登记伏笔（侧栏摘要卡下方入口） */
  openForeshadowingCreate: []
  /** 打开主内容区节奏看板 */
  openRhythmBoard: []
  /** 刷新节奏卡（左侧标题行入口） */
  refreshRhythm: []
  /** 打开某张节奏卡详情 */
  openRhythmCard: [id: string]
  /** 规划节奏卡（侧栏摘要卡下方入口） */
  openRhythmCreate: []
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
      <AppIcon name="x" :size="16" class="h-4 w-4" />
    </button>

    <!-- 按分类切换内容 -->
    <ConversationList
      v-if="activeCategory === 'conversation'"
      :sessions="sessions"
      :active-session-id="activeSessionId"
      :pending-confirmation-ids="pendingConfirmationIds"
      :pending-question-ids="pendingQuestionIds"
      :running-ids="runningIds"
      @select="emit('selectSession', $event)"
      @create="emit('createSession')"
      @rename="(sessionId, title) => emit('renameSession', sessionId, title)"
      @archive="emit('archiveSession', $event)"
      @unarchive="emit('unarchiveSession', $event)"
      @remove="emit('deleteSession', $event)"
    />
    <ChapterList
      v-else-if="activeCategory === 'chapter'"
      :files="files"
      :active-file-path="activeFilePath"
      :foreshadowing-cards="foreshadowingCards"
      :rhythm-cards="rhythmCards"
      @select-file="emit('selectFile', $event)"
      @open-foreshadowing="emit('openForeshadowingCard', $event)"
      @open-rhythm="emit('openRhythmCard', $event)"
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
      :selected-card-id="selectedPlanCardId"
      @open-board="emit('openPlanBoard')"
      @refresh="emit('refreshPlan')"
      @open-create="emit('openPlanCreate')"
      @open-card="emit('openPlanCard', $event)"
    />
    <ForeshadowingList
      v-else-if="activeCategory === 'foreshadowing'"
      :cards="foreshadowingCards"
      :is-loading="isForeshadowingLoading"
      :selected-card-id="selectedForeshadowingId"
      @open-board="emit('openForeshadowingBoard')"
      @refresh="emit('refreshForeshadowing')"
      @open-create="emit('openForeshadowingCreate')"
      @open-card="emit('openForeshadowingCard', $event)"
    />
    <RhythmList
      v-else-if="activeCategory === 'rhythm'"
      :cards="rhythmCards"
      :is-loading="isRhythmLoading"
      :selected-card-id="selectedRhythmId"
      @open-board="emit('openRhythmBoard')"
      @refresh="emit('refreshRhythm')"
      @open-create="emit('openRhythmCreate')"
      @open-card="emit('openRhythmCard', $event)"
    />
  </aside>
</template>
