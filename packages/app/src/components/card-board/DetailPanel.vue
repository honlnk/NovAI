<script setup lang="ts">
import { ref, watch } from 'vue'

import type { DetailMode } from '../plan/detail-mode'
import Tooltip from '../ui/Tooltip.vue'
import PanelHeader from '../layout/PanelHeader.vue'
import AppIcon from '../ui/AppIcon.vue'

/**
 * 卡片详情面板骨架（创作心智模块施工计划 §10.5，自计划模块上提泛化）：
 * 右侧内容面板的卡片内容类型，头部沿用文件面板的头部规格，浅色视觉。
 * 草稿、编辑模式与冲突真值都在各领域的 card-board store（卡片级编辑会话），
 * 本组件只展示与转发。
 *
 * 交互约定：
 * - 头部名称输入 + 预览/编辑两态分段控件；正文区（预览/编辑的具体形态）
 *   由 #content 插槽按 detailMode 注入（计划是 Markdown/textarea，伏笔是
 *   读者视角/作者真相双区）。
 * - 分组按钮高亮读取 moveCard 同步后的当前列 key（与看板同源）。
 * - 删除进回收站，两步确认；保存与删除同在底部操作行。
 */
const props = defineProps<{
  /** 当前卡片 id（删除两步确认随切卡清残留） */
  cardId: string
  /** 头部名称输入框展示值（卡片名草稿 ?? 卡片名，由调用方组合） */
  titleValue: string
  titlePlaceholder: string
  /** 领域列按钮（顺序即展示顺序）；点击即移动到该列 */
  columns: ReadonlyArray<{ key: string; label: string }>
  /** 当前卡片所在列 key（与看板同源） */
  activeColumnKey: string
  /** 详情视图态（预览/编辑，随卡片编辑会话恢复） */
  detailMode: DetailMode
  isSaving: boolean
  /** 外部修改提醒是否在展示（重新读取/保留草稿） */
  hasConflict: boolean
  actionError: string
  hasUnsavedChanges: boolean
  /** 底部展示的更新时间（空串隐藏） */
  updatedAt: string
  /** 删除按钮文案（如「删除（移入回收站）」） */
  deleteLabel: string
  testidPrefix: string
}>()

const emit = defineEmits<{
  close: []
  updateTitle: [title: string]
  setDetailMode: [mode: DetailMode]
  saveDraft: []
  reloadFromConflict: []
  keepDraft: []
  moveCard: [columnKey: string]
  removeCard: []
}>()

/** 删除两步确认（随卡片切换清残留；草稿与视图态恢复由 store 负责） */
const isDeleteConfirmOpen = ref(false)

watch(
  () => props.cardId,
  () => {
    isDeleteConfirmOpen.value = false
  },
)

/* ---------- 详情操作 ---------- */

function onTitleInput(event: Event) {
  emit('updateTitle', (event.target as HTMLInputElement).value)
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
  <div class="flex min-h-0 flex-1 flex-col" :data-testid="`${testidPrefix}-detail`">
    <PanelHeader @close="emit('close')">
      <template #leading>
        <input
          type="text"
          class="min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-sm font-semibold text-gray-800 placeholder-gray-400 outline-none transition-colors hover:bg-gray-100 focus:bg-gray-100"
          :placeholder="titlePlaceholder"
          :data-testid="`${testidPrefix}-detail-title`"
          :value="titleValue"
          @input="onTitleInput"
        >
      </template>
      <template #actions>
        <!-- 预览/编辑 两态分段控件（与文件面板头部控件同规格，无「原始」模式） -->
        <div class="flex items-center rounded-lg border border-gray-200 bg-gray-50 p-0.5">
          <Tooltip
            v-for="mode in [
              { key: 'preview', label: '预览' },
              { key: 'edit', label: '编辑' },
            ]"
            :key="mode.key"
            :text="mode.label"
            :delay="300"
            preferred-placement="bottom"
          >
            <button
              :aria-label="`${mode.label}正文`"
              :class="[
                'flex items-center justify-center rounded-md p-1.5 transition-colors',
                detailMode === mode.key
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              ]"
              :data-testid="mode.key === 'edit' ? `${testidPrefix}-detail-edit` : undefined"
              @click="emit('setDetailMode', mode.key as DetailMode)"
            >
              <!-- 预览（眼睛） -->
              <AppIcon v-if="mode.key === 'preview'" name="eye" :size="16" class="h-4 w-4" />
              <!-- 编辑（铅笔） -->
              <AppIcon name="square-pen" :size="16" class="h-4 w-4" v-else />
            </button>
          </Tooltip>
        </div>
      </template>
    </PanelHeader>

    <!-- 内容区：分组列按钮 + 领域字段/正文（内部滚动）+ 底部操作行 -->
    <div class="flex min-h-0 flex-1 flex-col px-4">
      <!-- 分组列按钮（头部下方固定区，选中态与看板同源） -->
      <div class="flex shrink-0 flex-wrap gap-1.5 pb-2 pt-3">
        <button
          v-for="column in columns"
          :key="column.key"
          :class="[
            'rounded-md px-2 py-1 text-xs transition-colors',
            activeColumnKey === column.key
              ? 'bg-gray-900 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
          ]"
          @click="emit('moveCard', column.key)"
        >
          {{ column.label }}
        </button>
      </div>

      <!-- 外部修改提醒：用户选择重新读取或保留草稿 -->
      <div v-if="hasConflict" class="shrink-0 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
        <p>这个文件已被外部修改（AI 或编辑器）。当前草稿不会覆盖它。</p>
        <div class="mt-2 flex gap-2">
          <button class="rounded bg-amber-100 px-2 py-1 text-amber-800 hover:bg-amber-200" @click="emit('reloadFromConflict')">
            重新读取
          </button>
          <button class="rounded bg-gray-100 px-2 py-1 text-gray-600 hover:bg-gray-200" @click="emit('keepDraft')">
            保留草稿继续编辑
          </button>
        </div>
      </div>

      <!-- 正文区：预览/编辑的具体形态由领域注入（双击进入编辑由领域自定） -->
      <slot name="content" :detail-mode="detailMode" />

      <p v-if="actionError" class="shrink-0 pt-1 text-xs text-red-600">{{ actionError }}</p>

      <!-- 底部操作行：保存 + 未保存标记 + 更新时间 + 删除（同一行，宽度不足换行） -->
      <div class="flex shrink-0 flex-wrap items-center gap-2 py-3">
        <button
          class="rounded-lg bg-gray-900 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
          :disabled="!hasUnsavedChanges || isSaving"
          :data-testid="`${testidPrefix}-detail-save`"
          @click="emit('saveDraft')"
        >
          {{ isSaving ? '保存中…' : '保存' }}
        </button>
        <span v-if="hasUnsavedChanges" class="flex items-center gap-1 text-xs text-amber-600">
          <span class="h-1.5 w-1.5 rounded-full bg-amber-500" />
          未保存
        </span>
        <span v-if="updatedAt" class="text-[10px] text-gray-400">
          更新于 {{ formatTime(updatedAt) }}
        </span>

        <span class="ml-auto">
          <button
            v-if="!isDeleteConfirmOpen"
            class="rounded-lg border border-gray-200 bg-white px-3 py-1 text-xs text-red-600 transition-colors hover:bg-red-50"
            @click="isDeleteConfirmOpen = true"
          >
            {{ deleteLabel }}
          </button>
          <span v-else class="flex items-center gap-1.5 text-xs text-gray-500">
            <span>移入回收站？</span>
            <button class="rounded bg-red-600 px-2 py-1 text-white hover:bg-red-500" @click="emit('removeCard')">删除</button>
            <button class="rounded bg-gray-100 px-2 py-1 text-gray-600 hover:bg-gray-200" @click="isDeleteConfirmOpen = false">取消</button>
          </span>
        </span>
      </div>
    </div>
  </div>
</template>
