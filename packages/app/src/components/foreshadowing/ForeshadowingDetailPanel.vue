<script setup lang="ts">
import { computed } from 'vue'

import type { ForeshadowingCardView, ForeshadowingStatusView } from '@novai/core/services/types'
import { FORESHADOWING_STATUSES, FORESHADOWING_STATUS_LABELS } from '@novai/core/types/foreshadowing'
import type { DetailMode } from '../plan/detail-mode'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'
import DetailPanel from '../card-board/DetailPanel.vue'

/**
 * 伏笔详情面板：通用详情骨架的伏笔领域装配（§七：埋设章节/回收窗口/关联角色/
 * 关联物品/暗示历史/回收当量字段区 + 读者视角与作者真相双正文区）。UI 是作者
 * 界面，作者真相直接展示（标注「作者视角」）；状态按钮为完整 6 状态（frontmatter
 * 粒度），与看板展示列模式解耦。结构字段（埋设章节/回收窗口等）的修改走 AI 工具
 * 或直接编辑文件，面板内只读展示——正文三件（名/读者视角/作者真相）走草稿保存。
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
  conflictNotice: unknown | null
  actionError: string
}>()

const emit = defineEmits<{
  close: []
  updateDraftName: [name: string]
  updateDraftReaderView: [readerView: string]
  updateDraftAuthorTruth: [authorTruth: string]
  updateDraftStatus: [status: ForeshadowingStatusView]
  setDetailMode: [mode: DetailMode]
  retrySave: []
  reloadFromConflict: []
  keepDraft: []
  removeCard: [id: string]
}>()

const statusButtons = computed(() =>
  FORESHADOWING_STATUSES.map((status) => ({ key: status, label: FORESHADOWING_STATUS_LABELS[status] })),
)

/** 读者视角展示值：有草稿显示草稿 */
const readerValue = computed(() => props.draftReaderView ?? props.activeCard.readerBody)
/** 作者真相展示值：有草稿显示草稿 */
const truthValue = computed(() => props.draftAuthorTruth ?? props.activeCard.authorTruth)

const payoffWindowText = computed(() =>
  props.activeCard.payoffWindow
    ? `${props.activeCard.payoffWindow[0]} ~ ${props.activeCard.payoffWindow[1]}`
    : '未设定',
)

function onReaderInput(event: Event) {
  emit('updateDraftReaderView', (event.target as HTMLTextAreaElement).value)
}

function onTruthInput(event: Event) {
  emit('updateDraftAuthorTruth', (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <DetailPanel
    :card-id="activeCard.id"
    :title-value="draftName ?? activeCard.name"
    title-placeholder="伏笔名"
    :columns="statusButtons"
    :active-column-key="activeCard.status"
    :pending-column-key="draftStatus"
    :detail-mode="detailMode"
    :save-phase="savePhase"
    :has-conflict="conflictNotice !== null"
    :action-error="actionError"
    :updated-at="activeCard.updatedAt"
    delete-label="删除（移入回收站）"
    testid-prefix="foreshadowing"
    @close="emit('close')"
    @update-title="emit('updateDraftName', $event)"
    @set-detail-mode="emit('setDetailMode', $event)"
    @select-status="(columnKey) => emit('updateDraftStatus', columnKey as ForeshadowingStatusView)"
    @retry-save="emit('retrySave')"
    @reload-from-conflict="emit('reloadFromConflict')"
    @keep-draft="emit('keepDraft')"
    @remove-card="emit('removeCard', activeCard.id)"
  >
    <template #content="{ detailMode: mode }">
      <!-- 结构字段区（只读；修改走 AI 工具或直接编辑文件） -->
      <dl class="mt-2 grid shrink-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs">
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
        <dt v-if="activeCard.abandonedReason" class="text-gray-500">放弃原因</dt>
        <dd v-if="activeCard.abandonedReason" class="text-gray-800">{{ activeCard.abandonedReason }}</dd>
      </dl>

      <!-- 读者视角：写正文章节时读者已知的事实 -->
      <div class="mt-2 min-h-16 flex-1 basis-1/2 overflow-hidden">
        <p class="mb-1 text-[11px] font-medium text-gray-500">读者视角（当时可见事实）</p>
        <div
          v-if="mode === 'preview'"
          class="h-[calc(100%-1.25rem)] overflow-y-auto rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
          data-testid="foreshadowing-detail-reader"
          @dblclick="emit('setDetailMode', 'edit')"
        >
          <MarkdownRenderer v-if="readerValue" :content="readerValue" />
          <p v-else class="text-sm text-gray-400">双击或点击「编辑」补写读者当时看到的事实。</p>
        </div>
        <textarea
          v-else
          :value="draftReaderView ?? activeCard.readerBody"
          class="h-[calc(100%-1.25rem)] w-full resize-none rounded-md border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="埋设当时读者能看到的事实（不含剧透）。"
          data-testid="foreshadowing-detail-reader-input"
          @input="onReaderInput"
        />
      </div>

      <!-- 作者真相：剧透区，UI 是作者界面直接展示（§七），AI 工具链路才有遮蔽 -->
      <div class="mt-2 min-h-16 flex-1 basis-1/2 overflow-hidden">
        <p class="mb-1 flex items-center gap-1 text-[11px] font-medium text-amber-600">
          作者视角（真相 / 剧透）
        </p>
        <div
          v-if="mode === 'preview'"
          class="h-[calc(100%-1.25rem)] overflow-y-auto rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
          data-testid="foreshadowing-detail-truth"
          @dblclick="emit('setDetailMode', 'edit')"
        >
          <MarkdownRenderer v-if="truthValue" :content="truthValue" />
          <p v-else class="text-sm text-amber-500">这条伏笔还没登记真相（可后补）。</p>
        </div>
        <textarea
          v-else
          :value="draftAuthorTruth ?? activeCard.authorTruth"
          class="h-[calc(100%-1.25rem)] w-full resize-none rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2 text-sm leading-relaxed text-gray-800 placeholder-gray-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          placeholder="作者知道的真相——回收时的钥匙。"
          data-testid="foreshadowing-detail-truth-input"
          @input="onTruthInput"
        />
      </div>
    </template>
  </DetailPanel>
</template>
