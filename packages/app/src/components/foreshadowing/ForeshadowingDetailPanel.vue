<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import type { ForeshadowingCardView, ForeshadowingStatusView } from '@novai/core/services/types'
import { FORESHADOWING_STATUSES, FORESHADOWING_STATUS_LABELS } from '@novai/core/types/foreshadowing'
import type { CardConflictField, CardSessionGuard } from '../../stores/card-board'
import CardConflictBar from '../card-board/CardConflictBar.vue'
import CardConflictResolution from '../card-board/CardConflictResolution.vue'
import CardGuardNotice from '../card-board/CardGuardNotice.vue'
import CardSaveFailure from '../card-board/CardSaveFailure.vue'
import CardStatusTools from '../card-board/CardStatusTools.vue'
import type { DetailMode } from '../layout/detail-mode'
import DetailLayout from '../layout/DetailLayout.vue'
import PlainBodySurface from '../layout/PlainBodySurface.vue'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'

/**
 * 伏笔详情面板：统一详情布局（components/layout/DetailLayout.vue）的伏笔领域
 * 装配（§七：埋设章节/回收窗口/关联角色/关联物品/暗示历史/回收当量字段区 +
 * 读者视角与作者真相双正文区，作者真相走警示表面）。UI 是作者界面，作者真相
 * 直接展示（标注「作者视角」）；状态按钮为完整 6 状态（frontmatter 粒度），
 * 与看板展示列模式解耦。结构字段（埋设章节/回收窗口等）的修改走 AI 工具或
 * 直接编辑文件，面板内只读展示——正文三件（名/读者视角/作者真相）走草稿保存。
 * 「已放弃」不走两秒延迟：进入原因操作态，明确确认后原子写入状态与原因（阶段 4）。
 */
const props = defineProps<{
  activeCard: ForeshadowingCardView
  draftName: string | null
  draftReaderView: string | null
  draftAuthorTruth: string | null
  /** 待保存的普通状态（状态按钮等待标记）；null = 无状态修改 */
  draftStatus: ForeshadowingStatusView | null
  detailMode: DetailMode
  savePhase: 'clean' | 'pending' | 'saving' | 'failed' | 'conflict'
  /** 冲突视图（阶段 3：紧凑条与展开比较驱动） */
  conflict: { probing: boolean; missing: boolean; unreadable?: string; expanded: boolean } | null
  /** 冲突字段比较（store 按领域字段组合好的 mine/disk 文本） */
  conflictFields: ReadonlyArray<CardConflictField>
  /** 守护信息（删除/重命名；null = 无守护） */
  guard: CardSessionGuard | null
  /** 待确认的放弃操作态（null = 不在操作态；原因输入绑定） */
  abandonIntent: { reason: string } | null
  /** 确认放弃可点（字段收口完成 clean）；收口中/冲突时禁用 */
  canConfirmAbandon: boolean
  /** 确认放弃进行中（防重复提交） */
  isConfirmingAbandon: boolean
  actionError: string
}>()

const emit = defineEmits<{
  close: []
  updateDraftName: [name: string]
  updateDraftReaderView: [readerView: string]
  updateDraftAuthorTruth: [authorTruth: string]
  updateDraftStatus: [status: ForeshadowingStatusView]
  /** 进入放弃操作态（「已放弃」状态选择的拦截出口，不登记状态） */
  startAbandon: []
  updateAbandonReason: [reason: string]
  cancelAbandon: []
  confirmAbandon: []
  setDetailMode: [mode: DetailMode]
  retrySave: []
  expandConflict: []
  collapseConflict: []
  adoptDisk: []
  adoptMine: []
  saveCopy: [name: string]
  restoreAsCopy: [name: string]
  discardGuard: []
}>()

const statusButtons = computed(() =>
  FORESHADOWING_STATUSES.map((status) => ({ key: status, label: FORESHADOWING_STATUS_LABELS[status] })),
)

/** 头部名称输入展示值（草稿优先） */
const titleValue = computed(() => props.draftName ?? props.activeCard.name)

/** 读者视角展示值：有草稿显示草稿 */
const readerValue = computed(() => props.draftReaderView ?? props.activeCard.readerBody)
/** 作者真相展示值：有草稿显示草稿 */
const truthValue = computed(() => props.draftAuthorTruth ?? props.activeCard.authorTruth)

const payoffWindowText = computed(() =>
  props.activeCard.payoffWindow
    ? `${props.activeCard.payoffWindow[0]} ~ ${props.activeCard.payoffWindow[1]}`
    : '未设定',
)

const abandonReasonInput = ref<HTMLTextAreaElement | null>(null)
// 进入操作态默认聚焦原因输入（计划 §四.1：输入框默认聚焦）。immediate 覆盖
// 「拖入已放弃列」路径——面板挂载时操作态已在，靠变更触发会漏掉这次聚焦
watch(
  () => props.abandonIntent,
  async (intent) => {
    if (intent !== null) {
      await nextTick()
      abandonReasonInput.value?.focus()
    }
  },
  { flush: 'post', immediate: true },
)

/** 状态选择出口：「已放弃」拦截进原因操作态（已放弃卡再点可登记新原因），其余走两秒延迟保存 */
function onSelectStatus(status: ForeshadowingStatusView) {
  if (status === 'abandoned') {
    emit('startAbandon')
    return
  }
  emit('updateDraftStatus', status)
}

function onTitleInput(event: Event) {
  emit('updateDraftName', (event.target as HTMLInputElement).value)
}

function onReaderInput(event: Event) {
  emit('updateDraftReaderView', (event.target as HTMLTextAreaElement).value)
}

function onTruthInput(event: Event) {
  emit('updateDraftAuthorTruth', (event.target as HTMLTextAreaElement).value)
}

function onAbandonReasonInput(event: Event) {
  emit('updateAbandonReason', (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <DetailLayout
    :mode="detailMode"
    :has-content="true"
    :save-phase="savePhase"
    :path="activeCard.sourcePath"
    :updated-at="activeCard.updatedAt"
    noun="正文"
    save-testid="foreshadowing-detail-save-status"
    :conflict-expanded="conflict?.expanded === true"
    @close="emit('close')"
    @mode-change="emit('setDetailMode', $event)"
  >
    <template #title>
      <input
        type="text"
        class="min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-sm font-semibold text-gray-800 placeholder-gray-400 outline-none transition-colors hover:bg-gray-100 focus:bg-gray-100"
        placeholder="伏笔名"
        data-testid="foreshadowing-detail-title"
        :value="titleValue"
        :readonly="guard !== null"
        @input="onTitleInput"
      >
    </template>

    <!-- 消息区：守护横幅 / 冲突紧凑条 / 保存失败（重试在消息区） -->
    <template #message>
      <CardGuardNotice
        v-if="guard"
        :guard="guard"
        :title-value="titleValue"
        @restore-as-copy="(name) => emit('restoreAsCopy', name)"
        @discard-guard="emit('discardGuard')"
      />
      <CardConflictBar
        v-if="conflict && !conflict.expanded"
        testid-prefix="foreshadowing"
        @expand="emit('expandConflict')"
      />
      <CardSaveFailure
        v-if="savePhase === 'failed'"
        testid-prefix="foreshadowing"
        :message="actionError"
        @retry="emit('retrySave')"
      />
      <p v-else-if="actionError" class="mb-3 shrink-0 text-xs text-red-600">{{ actionError }}</p>
    </template>

    <!-- 工具区：状态列按钮（守护时冻结） -->
    <template #tools>
      <CardStatusTools
        v-if="!guard"
        :columns="statusButtons"
        :active-column-key="activeCard.status"
        :pending-column-key="draftStatus"
        @select="(columnKey) => onSelectStatus(columnKey as ForeshadowingStatusView)"
      />
    </template>

    <!-- 主内容：结构字段 + 放弃操作态 / 双正文（读者视角 + 作者真相警示表面） -->
    <template #content>
      <!-- 结构字段区（只读；修改走 AI 工具或直接编辑文件） -->
      <dl class="mb-2 grid shrink-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs">
        <dt class="text-gray-500">埋设章节</dt>
        <dd class="text-gray-800">{{ activeCard.plantedAt || '未填' }}</dd>
        <dt class="text-gray-500">回收窗口</dt>
        <dd class="text-gray-800">{{ payoffWindowText }}</dd>
        <dt v-if="activeCard.relatedCharacters.length > 0" class="text-gray-500">关联角色</dt>
        <dd v-if="activeCard.relatedCharacters.length > 0" class="text-gray-800">{{ activeCard.relatedCharacters.join('、') }}</dd>
        <dt v-if="activeCard.relatedEntities.length > 0" class="text-gray-500">关联物品</dt>
        <dd v-if="activeCard.relatedEntities.length > 0" class="text-gray-800">{{ activeCard.relatedEntities.join('、') }}</dd>
        <dt v-if="activeCard.relatedChapters.length > 0" class="text-gray-500">暗示历史</dt>
        <dd v-if="activeCard.relatedChapters.length > 0" class="text-gray-800">{{ activeCard.relatedChapters.join('、') }}</dd>
        <dt v-if="activeCard.isRedHerring" class="text-gray-500">性质</dt>
        <dd v-if="activeCard.isRedHerring" class="text-gray-800">红鲱鱼（故意误导读者）</dd>
        <dt v-if="activeCard.resolvedAt" class="text-gray-500">实际回收</dt>
        <dd v-if="activeCard.resolvedAt" class="text-gray-800">{{ activeCard.resolvedAt }}</dd>
        <!-- 历史放弃原因：仅当前处于已放弃状态时醒目展示（操作态登记的是新原因，不在此显示） -->
        <template v-if="activeCard.status === 'abandoned' && activeCard.abandonedReason">
          <dt class="text-amber-600">放弃原因</dt>
          <dd class="rounded bg-amber-50 px-1.5 py-px font-medium text-amber-800">{{ activeCard.abandonedReason }}</dd>
        </template>
      </dl>

      <!-- 放弃操作态（阶段 4）：正文双区原位收起，原因登记 + 明确确认，不产生两秒计时器 -->
      <div
        v-if="abandonIntent"
        class="flex min-h-0 flex-1 flex-col rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5"
        data-testid="foreshadowing-detail-abandon"
      >
        <p class="shrink-0 text-sm font-medium text-amber-800">为什么不再回收这条伏笔？</p>
        <p class="mt-0.5 shrink-0 text-[11px] leading-4 text-amber-600">记录创作决策，避免以后误以为漏写。</p>
        <textarea
          ref="abandonReasonInput"
          :value="abandonIntent.reason"
          class="mt-2 min-h-0 w-full flex-1 resize-none rounded-md border border-amber-200 bg-white px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          placeholder="例如：这条线索已被第三章的直接说明取代，继续回收会让节奏拖沓。"
          data-testid="foreshadowing-detail-abandon-reason"
          @input="onAbandonReasonInput"
        />
        <div class="mt-2 flex shrink-0 items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100"
            data-testid="foreshadowing-detail-abandon-cancel"
            @click="emit('cancelAbandon')"
          >
            取消
          </button>
          <button
            type="button"
            :disabled="!abandonIntent.reason.trim() || !canConfirmAbandon || isConfirmingAbandon"
            class="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
            :title="canConfirmAbandon || !abandonIntent.reason.trim() ? undefined : '等本卡片未落盘内容收口后可确认'"
            data-testid="foreshadowing-detail-abandon-confirm"
            @click="emit('confirmAbandon')"
          >
            {{ isConfirmingAbandon ? '正在放弃…' : '确认放弃' }}
          </button>
        </div>
      </div>

      <!-- 读者视角：写正文章节时读者已知的事实（操作态收起） -->
      <div v-if="!abandonIntent" class="mt-2 flex min-h-16 flex-1 basis-1/2 flex-col">
        <p class="mb-1 shrink-0 text-[11px] font-medium text-gray-500">读者视角（当时可见事实）</p>
        <PlainBodySurface
          v-if="detailMode === 'preview'"
          variant="preview"
          class="flex-1"
          data-testid="foreshadowing-detail-reader"
          @dblclick="guard ? undefined : emit('setDetailMode', 'edit')"
        >
          <MarkdownRenderer v-if="readerValue" :content="readerValue" />
          <p v-else class="text-sm text-gray-400">双击或点击「编辑」补写读者当时看到的事实。</p>
        </PlainBodySurface>
        <PlainBodySurface v-else variant="edit" class="flex-1">
          <textarea
            :value="draftReaderView ?? activeCard.readerBody"
            :readonly="guard !== null"
            class="min-h-0 w-full flex-1 resize-none rounded-md border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="埋设当时读者能看到的事实（不含剧透）。"
            data-testid="foreshadowing-detail-reader-input"
            @input="onReaderInput"
          />
        </PlainBodySurface>
      </div>

      <!-- 作者真相：剧透区，UI 是作者界面直接展示（§七），AI 工具链路才有遮蔽（操作态收起） -->
      <div v-if="!abandonIntent" class="mt-2 flex min-h-16 flex-1 basis-1/2 flex-col">
        <p class="mb-1 shrink-0 text-[11px] font-medium text-amber-600">
          作者视角（真相 / 剧透）
        </p>
        <PlainBodySurface
          v-if="detailMode === 'preview'"
          variant="preview"
          tone="warning"
          class="flex-1"
          data-testid="foreshadowing-detail-truth"
          @dblclick="guard ? undefined : emit('setDetailMode', 'edit')"
        >
          <MarkdownRenderer v-if="truthValue" :content="truthValue" />
          <p v-else class="text-sm text-amber-500">这条伏笔还没登记真相（可后补）。</p>
        </PlainBodySurface>
        <PlainBodySurface v-else variant="edit" tone="warning" class="flex-1">
          <textarea
            :value="draftAuthorTruth ?? activeCard.authorTruth"
            :readonly="guard !== null"
            class="min-h-0 w-full flex-1 resize-none rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
            placeholder="作者知道的真相——回收时的钥匙。"
            data-testid="foreshadowing-detail-truth-input"
            @input="onTruthInput"
          />
        </PlainBodySurface>
      </div>
    </template>

    <!-- 冲突展开：卡片冲突处理装配（说明/字段比较/副本文案/四出口） -->
    <template #conflict>
      <CardConflictResolution
        :card-id="activeCard.id"
        :title-value="titleValue"
        :conflict="conflict!"
        :conflict-fields="conflictFields"
        @collapse="emit('collapseConflict')"
        @adopt-disk="emit('adoptDisk')"
        @adopt-mine="emit('adoptMine')"
        @save-copy="(name) => emit('saveCopy', name)"
      />
    </template>
  </DetailLayout>
</template>
