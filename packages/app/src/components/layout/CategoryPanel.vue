<script setup lang="ts">
import type { BrokenSkillView, ChatSessionSummaryView, ForeshadowingCardSummaryView, PlanCardSummaryView, ProjectFileNodeView, RhythmCardSummaryView, SkillListView, SkillView } from '@novai/core/services/types'
import type { ChapterTimelineEventSummary } from '../../constants/timeline'
import type { Category } from '../../constants/category'
import ChapterList from '../category/ChapterList.vue'
import ElementList from '../category/ElementList.vue'
import PromptList from '../category/PromptList.vue'
import SkillList from '../category/SkillList.vue'
import ConversationList from '../category/ConversationList.vue'
import PlanList from '../category/PlanList.vue'
import ForeshadowingList from '../category/ForeshadowingList.vue'
import RhythmList from '../category/RhythmList.vue'
import MobilePanelClose from './MobilePanelClose.vue'

defineProps<{
  activeCategory: Category
  /** 当前项目 id（技能面板 store 动作用） */
  projectId: string
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
  /** 时间线事件摘要（章节侧栏「本章相关事件」实时反查用） */
  timelineEvents: ChapterTimelineEventSummary[]
  /** 有待回答提问卡的会话 id 集（会话列表「待回答」徽标；提问按会话路由） */
  pendingQuestionIds?: Set<string>
  /** 实时运行中的会话 id 集（会话列表「进行中」筛选与徽标） */
  runningIds?: Set<string>
  /** 技能列表（技能分类面板） */
  skills: SkillView[]
  /** 被跳过的技能（技能分类面板末尾灰显） */
  brokenSkills: BrokenSkillView[]
  /** 技能列表读取中 */
  isSkillLoading: boolean
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
  /** 打开时间轴并定位某事件详情（章节侧栏「本章相关事件」入口） */
  openTimelineEvent: [eventId: string]
  /** 刷新技能列表（技能分类标题行入口） */
  refreshSkills: []
}>()
</script>

<template>
  <aside
    :class="[
      'flex shrink-0 flex-col bg-[#171717] text-gray-100 transition-all duration-200',
      // 高度对齐右侧内容面板抽屉（ContentPanel top-0 bottom-7）：底部让出 28px 状态栏
      // z-[45]：高于遮罩(40)、低于 ActivityBar(46)——收起滑过时从工具栏下方经过
      'max-lg:fixed max-lg:top-0 max-lg:bottom-7 max-lg:left-[56px] max-lg:z-[45]',
      // 宽度折叠只属于桌面端；移动端恒为 w-64，可见性由 translate 控制
      // （否则桌面收起态泄漏到移动端：汉堡打开一个 0 宽的空抽屉）
      isOpen ? 'w-64' : 'w-0 overflow-hidden max-lg:w-64',
      // 收起位移必须超过自身宽度：面板锚在 left-[56px]，只移 -100% 会在屏幕
      // 左缘留下 56px 宽的残条，恰好盖住 ActivityBar
      isMobileOpen ? 'max-lg:translate-x-0' : 'max-lg:translate-x-[calc(-100%_-_56px)]',
    ]"
  >
    <!-- 按分类切换内容：移动端「关旧开新」的动画由抽屉本体承担
         （ProjectView selectCategory 关合抽屉），列表本身直接切换 -->
    <!-- 移动端关闭按钮经各列表的 mobile-close 插槽注入标题行右端（与既有按钮并排，不占独立行） -->
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
    >
      <template #mobile-close><MobilePanelClose @close="emit('closeMobile')" /></template>
    </ConversationList>
    <ChapterList
      v-else-if="activeCategory === 'chapter'"
      :files="files"
      :active-file-path="activeFilePath"
      :foreshadowing-cards="foreshadowingCards"
      :rhythm-cards="rhythmCards"
      :timeline-events="timelineEvents"
      @select-file="emit('selectFile', $event)"
      @open-foreshadowing="emit('openForeshadowingCard', $event)"
      @open-rhythm="emit('openRhythmCard', $event)"
      @open-timeline-event="emit('openTimelineEvent', $event)"
    >
      <template #mobile-close><MobilePanelClose @close="emit('closeMobile')" /></template>
    </ChapterList>
    <ElementList
      v-else-if="activeCategory === 'element'"
      :files="files"
      :active-file-path="activeFilePath"
      @select-file="emit('selectFile', $event)"
    >
      <template #mobile-close><MobilePanelClose @close="emit('closeMobile')" /></template>
    </ElementList>
    <PromptList
      v-else-if="activeCategory === 'prompt'"
      :files="files"
      :active-file-path="activeFilePath"
      :active-outline-path="activeOutlinePath"
      @select-file="emit('selectFile', $event)"
      @change-outline="emit('changeOutline', $event)"
    >
      <template #mobile-close><MobilePanelClose @close="emit('closeMobile')" /></template>
    </PromptList>
    <SkillList
      v-else-if="activeCategory === 'skill'"
      :project-id="projectId"
      :skills="skills"
      :broken="brokenSkills"
      :is-loading="isSkillLoading"
      :active-file-path="activeFilePath"
      @select-file="emit('selectFile', $event)"
      @refresh="emit('refreshSkills')"
    >
      <template #mobile-close><MobilePanelClose @close="emit('closeMobile')" /></template>
    </SkillList>
    <PlanList
      v-else-if="activeCategory === 'plan'"
      :cards="planCards"
      :is-loading="isPlanLoading"
      :selected-card-id="selectedPlanCardId"
      @open-board="emit('openPlanBoard')"
      @refresh="emit('refreshPlan')"
      @open-create="emit('openPlanCreate')"
      @open-card="emit('openPlanCard', $event)"
    >
      <template #mobile-close><MobilePanelClose @close="emit('closeMobile')" /></template>
    </PlanList>
    <ForeshadowingList
      v-else-if="activeCategory === 'foreshadowing'"
      :cards="foreshadowingCards"
      :is-loading="isForeshadowingLoading"
      :selected-card-id="selectedForeshadowingId"
      @open-board="emit('openForeshadowingBoard')"
      @refresh="emit('refreshForeshadowing')"
      @open-create="emit('openForeshadowingCreate')"
      @open-card="emit('openForeshadowingCard', $event)"
    >
      <template #mobile-close><MobilePanelClose @close="emit('closeMobile')" /></template>
    </ForeshadowingList>
    <RhythmList
      v-else-if="activeCategory === 'rhythm'"
      :cards="rhythmCards"
      :is-loading="isRhythmLoading"
      :selected-card-id="selectedRhythmId"
      @open-board="emit('openRhythmBoard')"
      @refresh="emit('refreshRhythm')"
      @open-create="emit('openRhythmCreate')"
      @open-card="emit('openRhythmCard', $event)"
    >
      <template #mobile-close><MobilePanelClose @close="emit('closeMobile')" /></template>
    </RhythmList>
  </aside>
</template>
