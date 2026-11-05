<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { PlanCardSummaryView, PlanStatusView } from '@novai/core/services/types'
import { PLAN_COLUMN_LABELS } from '../../constants/plans'
import MarkdownRenderer from '../ui/MarkdownRenderer.vue'

/**
 * 计划看板主面板：占据中间主内容区（替换对话面板），四列看板 + 右侧抽屉。
 *
 * 交互约定（交互优化计划 §交互设计）：
 * - 新建走右侧抽屉（顶部 / 空状态 / 侧栏入口共用），不再在看板上方展开输入区；
 *   提交等待真实保存结果，失败保留全部输入。
 * - 详情默认渲染 Markdown 预览，双击正文或点击「编辑」进入 textarea；只有
 *   预览 / 编辑两种状态，预览显示当前草稿，切视图不清草稿。
 * - 分组按钮高亮读取 moveCard 同步后的 activeCard.status（与看板同源）。
 * - 删除进回收站，两步确认；保存与删除同在底部操作行。
 * - 正文区撑满抽屉剩余高度并内部滚动；窄屏看板横向滚动。
 */

const props = defineProps<{
  projectId: string
  board: {
    columns: Readonly<Record<PlanStatusView, readonly PlanCardSummaryView[]>>
    issues: readonly unknown[]
  } | null
  isLoading: boolean
  errorMessage: string
  selectedCardId: string | null
  showOnHold: boolean
  /** 详情面板（含草稿/冲突态） */
  activeCard: {
    id: string
    title: string
    status: PlanStatusView
    body: string
    updatedAt: string
    sourcePath: string
  } | null
  draftBody: string | null
  isSaving: boolean
  conflictNotice: { currentCard: { body: string } } | null
  actionError: string
  hasUnsavedChanges: boolean
  /** 新建抽屉（三个入口共用） */
  isCreateOpen: boolean
  newCardTitle: string
  newCardBody: string
  isCreating: boolean
}>()

const emit = defineEmits<{
  refresh: []
  openCreate: []
  closeCreate: [discard: boolean]
  updateCreateDraft: [title: string, body: string]
  submitCreate: []
  openCard: [id: string]
  closeCard: []
  updateDraft: [body: string]
  saveDraft: []
  reloadFromConflict: []
  keepDraft: []
  moveCard: [id: string, status: PlanStatusView, afterId: string | null]
  removeCard: [id: string]
  toggleOnHold: []
}>()

/** 本地视图状态（随卡片切换重置；草稿真值在 store） */
const detailMode = ref<'preview' | 'edit'>('preview')
const isDeleteConfirmOpen = ref<string | null>(null)

watch(
  () => props.activeCard?.id,
  () => {
    // 切换卡片回到预览，并清掉上一张卡片的删除确认残留
    detailMode.value = 'preview'
    isDeleteConfirmOpen.value = null
  },
)

const columns = computed(() => {
  if (!props.board) {
    return []
  }

  const entries = Object.entries(props.board.columns) as [PlanStatusView, PlanCardSummaryView[]][]
  return props.showOnHold
    ? entries.filter(([status]) => status === 'on-hold')
    : entries.filter(([status]) => status !== 'on-hold')
})

const totalCards = computed(() => {
  if (!props.board) {
    return 0
  }
  return (Object.values(props.board.columns) as PlanCardSummaryView[][])
    .reduce((total, cards) => total + cards.length, 0)
})

/** 抽屉是否展示（新建或详情二选一；新建打开时详情已被 store 关闭） */
const isDrawerOpen = computed(() => props.isCreateOpen || props.activeCard !== null)

/* ---------- 拖拽（HTML5 DnD：卡片 → 列 / 卡片之间） ---------- */

const dragCardId = ref<string | null>(null)
const dropTarget = ref<{ status: PlanStatusView; afterId: string | null } | null>(null)

function onCardDragStart(card: PlanCardSummaryView, event: DragEvent) {
  dragCardId.value = card.id
  event.dataTransfer?.setData('text/plain', card.id)
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
  }
}

function onCardDragEnd() {
  dragCardId.value = null
  dropTarget.value = null
}

/** 拖到某列的空白区：目标列为空或列尾 */
function onColumnDrop(status: PlanStatusView) {
  const id = dragCardId.value
  if (!id) {
    return
  }
  const column = props.board?.columns[status] ?? []
  const afterId = column.length > 0 ? column[column.length - 1]?.id ?? null : null
  emit('moveCard', id, status, afterId)
  onCardDragEnd()
}

/** 拖到某卡片上：插到该卡片之后 */
function onCardDrop(status: PlanStatusView, afterCard: PlanCardSummaryView) {
  const id = dragCardId.value
  if (!id || id === afterCard.id) {
    onCardDragEnd()
    return
  }
  emit('moveCard', id, status, afterCard.id)
  onCardDragEnd()
}

/* ---------- 详情操作 ---------- */

const draftValue = computed(() => props.draftBody ?? props.activeCard?.body ?? '')

function onDraftInput(event: Event) {
  emit('updateDraft', (event.target as HTMLTextAreaElement).value)
}

function confirmDelete(id: string) {
  isDeleteConfirmOpen.value = id
}

function doDelete(id: string) {
  isDeleteConfirmOpen.value = null
  emit('removeCard', id)
}

function formatTime(iso: string): string {
  if (!iso) {
    return '未知时间'
  }
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-[#1e1e1e] text-gray-100">
    <!-- 顶栏：标题 + 计数 + 搁置筛选 + 刷新 + 新建 -->
    <header class="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3">
      <h1 class="text-sm font-semibold text-white">创作计划板</h1>
      <span class="text-xs text-gray-500">{{ totalCards }} 张卡片</span>

      <button
        :class="[
          'rounded-md px-2 py-1 text-xs transition-colors',
          showOnHold ? 'bg-white/20 text-white' : 'bg-white/10 text-gray-300 hover:bg-white/15',
        ]"
        aria-label="查看已搁置的卡片"
        @click="emit('toggleOnHold')"
      >
        已搁置
      </button>

      <div class="ml-auto flex items-center gap-2">
        <button
          class="rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-gray-300 transition-colors hover:bg-white/15"
          aria-label="重新扫描计划目录"
          @click="emit('refresh')"
        >
          刷新
        </button>
        <button
          class="rounded-md bg-blue-600/80 px-2.5 py-1.5 text-xs text-white transition-colors hover:bg-blue-600"
          aria-label="新建计划"
          data-testid="plan-new-card-button"
          @click="emit('openCreate')"
        >
          + 新建计划
        </button>
      </div>
    </header>

    <!-- 错误横幅（看板级错误） -->
    <p v-if="errorMessage" class="shrink-0 bg-red-500/10 px-4 py-2 text-xs text-red-300">
      {{ errorMessage }}
    </p>

    <!-- 主体：横向滚动看板 + 右侧抽屉（新建 / 详情） -->
    <div class="flex min-h-0 min-w-0 flex-1">
      <!-- 看板列区 -->
      <div
        v-if="isLoading"
        class="flex flex-1 items-center justify-center text-sm text-gray-500"
      >
        正在读取计划…
      </div>
      <div
        v-else-if="totalCards === 0"
        class="flex flex-1 flex-col items-center justify-center gap-3"
      >
        <p class="text-sm text-gray-500">还没有计划。把准备安排的剧情、伏笔、灵感或待补设定记下来。</p>
        <button
          class="rounded-md bg-blue-600/80 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-600"
          data-testid="plan-empty-create"
          @click="emit('openCreate')"
        >
          新建一条计划
        </button>
      </div>
      <div v-else class="flex flex-1 gap-3 overflow-x-auto p-4">
        <section
          v-for="[status, cards] in columns"
          :key="status"
          class="flex w-64 shrink-0 flex-col rounded-lg bg-white/5"
          @dragover.prevent
          @drop.prevent="onColumnDrop(status)"
        >
          <header class="flex items-center gap-2 px-3 py-2.5">
            <h2 class="text-xs font-semibold text-gray-300">{{ PLAN_COLUMN_LABELS[status] }}</h2>
            <span class="rounded-full bg-white/10 px-1.5 text-[10px] text-gray-400">{{ cards.length }}</span>
          </header>

          <div class="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
            <p v-if="cards.length === 0" class="px-1 py-4 text-center text-xs text-gray-600">
              拖卡片到这里
            </p>

            <article
              v-for="card in cards"
              :key="card.id"
              :class="[
                'group cursor-pointer rounded-md border border-white/10 bg-[#252525] p-2.5 transition-colors hover:border-white/25',
                dragCardId === card.id ? 'opacity-40' : '',
                selectedCardId === card.id ? 'border-blue-500/60' : '',
                dropTarget?.status === status && dropTarget.afterId === card.id ? 'border-t-2 border-t-blue-500' : '',
              ]"
              draggable="true"
              data-testid="plan-card"
              @click="emit('openCard', card.id)"
              @dragstart="onCardDragStart(card, $event)"
              @dragend="onCardDragEnd"
              @dragover.prevent="dropTarget = { status, afterId: card.id }"
              @dragleave="dropTarget = null"
              @drop.prevent.stop="onCardDrop(status, card)"
            >
              <p class="text-sm font-medium text-gray-100">{{ card.title || '（无标题）' }}</p>
              <p v-if="card.summary && card.summary !== card.title" class="mt-1 line-clamp-3 text-xs text-gray-500">
                {{ card.summary }}
              </p>
              <p class="mt-1.5 text-[10px] text-gray-600">{{ formatTime(card.updatedAt) }}</p>
            </article>
          </div>
        </section>
      </div>

      <!-- 右侧抽屉：新建模式 -->
      <aside
        v-if="isCreateOpen"
        class="flex w-80 shrink-0 flex-col border-l border-white/10 bg-[#232323]"
        data-testid="plan-create-drawer"
      >
        <header class="flex shrink-0 items-center gap-2 px-4 py-3">
          <h2 class="flex-1 text-sm font-semibold text-white">新建计划</h2>
          <button
            class="rounded-md p-1 text-gray-500 transition-colors hover:bg-white/10 hover:text-gray-200"
            aria-label="关闭新建计划"
            @click="emit('closeCreate', false)"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div class="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
          <input
            type="text"
            class="w-full rounded-md bg-white/5 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 outline-none focus:bg-white/10"
            placeholder="计划名（保存后默认进入收集箱）"
            data-testid="plan-new-card-title"
            :value="newCardTitle"
            @input="emit('updateCreateDraft', ($event.target as HTMLInputElement).value, newCardBody)"
          >
          <textarea
            class="min-h-0 w-full flex-1 resize-none rounded-md bg-white/5 px-3 py-2 text-sm leading-relaxed text-gray-100 placeholder-gray-600 outline-none focus:bg-white/10"
            placeholder="正文（Markdown，可留空）"
            data-testid="plan-new-card-input"
            :value="newCardBody"
            @input="emit('updateCreateDraft', newCardTitle, ($event.target as HTMLTextAreaElement).value)"
          />

          <p v-if="actionError" class="shrink-0 text-xs text-red-300">{{ actionError }}</p>

          <div class="flex shrink-0 items-center gap-2">
            <button
              class="rounded-md bg-blue-600/80 px-3 py-1.5 text-xs text-white transition-colors hover:bg-blue-600 disabled:opacity-50"
              :disabled="isCreating || (!newCardTitle.trim() && !newCardBody.trim())"
              data-testid="plan-new-card-submit"
              @click="emit('submitCreate')"
            >
              {{ isCreating ? '创建中…' : '创建' }}
            </button>
            <button
              class="rounded-md bg-white/10 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:bg-white/15"
              @click="emit('closeCreate', false)"
            >
              取消
            </button>
          </div>
        </div>
      </aside>

      <!-- 右侧抽屉：详情模式 -->
      <aside
        v-else-if="activeCard"
        class="flex w-80 shrink-0 flex-col border-l border-white/10 bg-[#232323]"
        data-testid="plan-detail"
      >
        <header class="flex shrink-0 items-center gap-2 px-4 py-3">
          <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-white">{{ activeCard.title || '（无标题）' }}</h2>
          <div class="flex shrink-0 items-center rounded-md bg-white/5 p-0.5">
            <button
              :class="[
                'rounded px-2 py-0.5 text-[11px] transition-colors',
                detailMode === 'preview' ? 'bg-white/20 text-white' : 'text-gray-400 hover:text-gray-200',
              ]"
              aria-label="预览正文"
              @click="detailMode = 'preview'"
            >
              预览
            </button>
            <button
              :class="[
                'rounded px-2 py-0.5 text-[11px] transition-colors',
                detailMode === 'edit' ? 'bg-white/20 text-white' : 'text-gray-400 hover:text-gray-200',
              ]"
              aria-label="编辑正文"
              data-testid="plan-detail-edit"
              @click="detailMode = 'edit'"
            >
              编辑
            </button>
          </div>
          <button
            class="rounded-md p-1 text-gray-500 transition-colors hover:bg-white/10 hover:text-gray-200"
            aria-label="关闭详情"
            @click="emit('closeCard')"
          >
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <!-- 状态控件（固定区，不随正文滚动） -->
        <div class="flex shrink-0 flex-wrap gap-1.5 px-4 pb-2">
          <button
            v-for="(label, value) in PLAN_COLUMN_LABELS"
            :key="value"
            :class="[
              'rounded-md px-2 py-1 text-xs transition-colors',
              activeCard.status === value
                ? 'bg-blue-600/80 text-white'
                : 'bg-white/10 text-gray-300 hover:bg-white/20',
            ]"
            @click="emit('moveCard', activeCard.id, value as PlanStatusView, null)"
          >
            {{ label }}
          </button>
        </div>

        <!-- 正文区：撑满剩余高度、内部滚动 -->
        <div class="flex min-h-0 flex-1 flex-col px-4">
          <!-- 外部修改提醒：用户选择重新读取或保留草稿 -->
          <div v-if="conflictNotice" class="shrink-0 rounded-md bg-amber-500/10 p-3 text-xs text-amber-200">
            <p>这个计划文件已被外部修改（AI 或编辑器）。当前草稿不会覆盖它。</p>
            <div class="mt-2 flex gap-2">
              <button class="rounded bg-amber-500/20 px-2 py-1 hover:bg-amber-500/30" @click="emit('reloadFromConflict')">
                重新读取
              </button>
              <button class="rounded bg-white/10 px-2 py-1 hover:bg-white/20" @click="emit('keepDraft')">
                保留草稿继续编辑
              </button>
            </div>
          </div>

          <!-- 预览态：渲染 Markdown（显示当前草稿），双击进入编辑 -->
          <div
            v-if="detailMode === 'preview'"
            class="markdown-body markdown-body--dark min-h-0 flex-1 overflow-y-auto rounded-md bg-white/5 px-3 py-2 text-sm"
            data-testid="plan-detail-preview"
            @dblclick="detailMode = 'edit'"
          >
            <MarkdownRenderer v-if="draftValue" :content="draftValue" />
            <p v-else class="text-gray-600">双击或点击「编辑」开始书写正文。</p>
          </div>

          <!-- 编辑态：多行文本框（不做实时渲染） -->
          <textarea
            v-else
            :value="draftValue"
            class="min-h-0 w-full flex-1 resize-none rounded-md bg-white/5 px-3 py-2 text-sm leading-relaxed text-gray-100 placeholder-gray-600 outline-none focus:bg-white/10"
            placeholder="自由记录正文；支持 Markdown。"
            data-testid="plan-detail-body"
            @input="onDraftInput"
          />

          <p v-if="actionError" class="shrink-0 py-1 text-xs text-red-300">{{ actionError }}</p>

          <!-- 底部操作行：保存 + 未保存标记 + 删除（同一行） -->
          <div class="flex shrink-0 flex-wrap items-center gap-2 py-3">
            <button
              class="rounded-md bg-blue-600/80 px-3 py-1.5 text-xs text-white transition-colors hover:bg-blue-600 disabled:opacity-50"
              :disabled="!hasUnsavedChanges || isSaving"
              data-testid="plan-detail-save"
              @click="emit('saveDraft')"
            >
              {{ isSaving ? '保存中…' : '保存' }}
            </button>
            <span v-if="hasUnsavedChanges" class="text-xs text-amber-300">未保存</span>
            <span v-if="activeCard.updatedAt" class="text-[10px] text-gray-600">
              更新于 {{ formatTime(activeCard.updatedAt) }}
            </span>

            <span class="ml-auto">
              <button
                v-if="isDeleteConfirmOpen !== activeCard.id"
                class="rounded-md bg-white/5 px-3 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/10"
                @click="confirmDelete(activeCard.id)"
              >
                删除（移入回收站）
              </button>
              <span v-else class="flex items-center gap-1.5 text-xs text-gray-400">
                <span>移入回收站？</span>
                <button class="rounded bg-red-500/20 px-2 py-1 text-red-200 hover:bg-red-500/30" @click="doDelete(activeCard.id)">删除</button>
                <button class="rounded bg-white/10 px-2 py-1 hover:bg-white/20" @click="isDeleteConfirmOpen = null">取消</button>
              </span>
            </span>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>
