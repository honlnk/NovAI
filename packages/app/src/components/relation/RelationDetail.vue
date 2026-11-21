<script setup lang="ts">
/**
 * 关系详情区（关系图谱施工计划 §六）：右侧内嵌面板，三个形态——
 * - 新建关系表单（RelationCreate 面板：两端选择器 + 类型 + 描述）；
 * - 编辑中的关系（save-session 会话：两秒自动保存、状态灯、失败重试、
 *   冲突冻结 + 四出口：采用磁盘 / 采用我的 / 返回编辑 / 重新读取）；
 * - 空态（引导点击边或新建）。
 * 删除带两击确认；切选/关闭前的收口由 store 的 openDetail/closeDetail 负责。
 */
import { computed, ref } from 'vue'

import { useRelationStore, RELATION_TYPE_SUGGESTIONS } from '../../stores/relation'
import type { RelationElementOptionView } from '@novai/core/services/relation-service'
import type { RelationRecord } from '@novai/core/types/relation'
import type { SaveSessionPhase } from '../../composables/save-session'
import type { DetailSavePhase } from '../layout/detail-save-phase'
import SaveStatusLight from '../layout/SaveStatusLight.vue'
import RelationNodePicker from './RelationNodePicker.vue'

const store = useRelationStore()

const session = computed(() => store.detailSession)

/** 引擎阶段 → 状态灯五态（守护/恢复未校验沿用「等待保存」口径，与卡片域一致） */
function toLightPhase(phase: SaveSessionPhase): DetailSavePhase {
  if (phase === 'conflict') return 'conflict'
  if (phase === 'saving') return 'saving'
  if (phase === 'failed') return 'failed'
  if (phase === 'clean') return 'clean'
  return 'pending'
}

const lightPhase = computed(() => toLightPhase(store.detailPhase(session.value)))

/** 冲突携带的磁盘版本（引擎不透明字段，此处取回领域形状） */
const conflictDisk = computed<RelationRecord | null>(() => {
  const disk = session.value?.conflict?.disk
  return disk ? (disk as { relation: RelationRecord }).relation : null
})

const TYPE_DATALIST_ID = 'relation-type-suggestions'

/** 端点节点键 → 展示名（画布节点 > 选择器缓存 > 键本身） */
function nodeLabel(key: string): string {
  return store.nodeLabelOf(key)
}

/* ---------- 编辑输入 ---------- */

function updateField(field: 'type' | 'description', value: string) {
  if (store.selectedRelationId) {
    store.setDetailDraft(store.selectedRelationId, { [field]: value })
  }
}

/* ---------- 冲突出口 ---------- */

const confirmAdopt = ref<'disk' | 'mine' | null>(null)
const busy = ref(false)

async function adoptDisk() {
  if (confirmAdopt.value !== 'disk') {
    confirmAdopt.value = 'disk'
    return
  }
  confirmAdopt.value = null
  busy.value = true
  try {
    await store.adoptDiskVersion()
  } finally {
    busy.value = false
  }
}

async function adoptMine() {
  if (confirmAdopt.value !== 'mine') {
    confirmAdopt.value = 'mine'
    return
  }
  confirmAdopt.value = null
  busy.value = true
  try {
    const result = await store.overwriteWithMine()
    if (!result.ok && result.message) {
      // 失败信息走状态区（store 的 actionError 由 save-session 结果回填）
    }
  } finally {
    busy.value = false
  }
}

/* ---------- 删除（两击确认） ---------- */

const confirmDelete = ref(false)

async function removeRelation() {
  if (!confirmDelete.value) {
    confirmDelete.value = true
    return
  }
  confirmDelete.value = false
  await store.removeRelation(store.selectedRelationId)
}

/* ---------- 新建表单 ---------- */

const createFromLabel = ref('')
const createToLabel = ref('')

function onFromSelect(option: RelationElementOptionView) {
  createFromLabel.value = `${option.name}（${option.type}）`
}

function onToSelect(option: RelationElementOptionView) {
  createToLabel.value = `${option.name}（${option.type}）`
}

async function submitCreate() {
  await store.submitCreate()
  createFromLabel.value = ''
  createToLabel.value = ''
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" aria-label="关系详情">
    <!-- 新建表单 -->
    <div v-if="store.createOpen" class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <h3 class="text-sm font-semibold text-gray-900">新建关系</h3>
      <label class="flex flex-col gap-1 text-xs text-gray-500">
        起点
        <RelationNodePicker
          v-model="store.createDraft.fromId"
          :search="store.searchElementOptions"
          :label="createFromLabel"
          placeholder="起点（搜索要素）"
          :exclude-id="store.createDraft.toId"
          @select="onFromSelect"
        />
      </label>
      <label class="flex flex-col gap-1 text-xs text-gray-500">
        终点
        <RelationNodePicker
          v-model="store.createDraft.toId"
          :search="store.searchElementOptions"
          :label="createToLabel"
          placeholder="终点（搜索要素）"
          :exclude-id="store.createDraft.fromId"
          @select="onToSelect"
        />
      </label>
      <label class="flex flex-col gap-1 text-xs text-gray-500">
        关系类型（短词）
        <input
          :value="store.createDraft.type"
          type="text"
          list="relation-create-types"
          maxlength="30"
          placeholder="盟友 / 血缘 / 隶属…"
          class="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-gray-500"
          @input="store.createDraft.type = ($event.target as HTMLInputElement).value"
        />
      </label>
      <label class="flex flex-col gap-1 text-xs text-gray-500">
        描述（可选）
        <textarea
          :value="store.createDraft.description"
          rows="3"
          placeholder="关系的细节、由来、当前张力…"
          class="resize-none rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-gray-500"
          @input="store.createDraft.description = ($event.target as HTMLTextAreaElement).value"
        />
      </label>
      <datalist :id="`relation-create-types`">
        <option v-for="suggestion in RELATION_TYPE_SUGGESTIONS" :key="suggestion" :value="suggestion" />
      </datalist>
      <p v-if="store.actionError" role="alert" class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{{ store.actionError }}</p>
      <div class="mt-auto flex gap-2">
        <button
          type="button"
          :disabled="store.createBusy"
          class="flex-1 rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-50"
          @click="submitCreate"
        >
          {{ store.createBusy ? '登记中…' : '登记关系' }}
        </button>
        <button
          type="button"
          class="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-50"
          @click="store.createOpen = false"
        >
          取消
        </button>
      </div>
    </div>

    <!-- 编辑中的关系 -->
    <div v-else-if="session && store.selectedEdge" class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header class="flex shrink-0 items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
        <span class="truncate text-xs text-gray-400">{{ store.selectedEdge.relation.id }}</span>
        <SaveStatusLight :phase="lightPhase" />
      </header>

      <div class="flex flex-col gap-3 p-4">
        <!-- 冲突冻结：四出口 -->
        <div
          v-if="session.conflict"
          role="alert"
          class="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-800"
        >
          <p class="font-medium">检测到外部修改（AI 或其他窗口改了这条关系），自动保存已冻结。</p>
          <p v-if="session.conflict.probing">正在读取磁盘最新版本…</p>
          <p v-else-if="session.conflict.missing">这条关系已在磁盘上不存在（可能已被删除）。</p>
          <p v-else-if="session.conflict.unreadable">读取磁盘版本失败：{{ session.conflict.unreadable }}</p>
          <div v-if="session.conflict.expanded && conflictDisk" class="rounded-md bg-white/70 px-2.5 py-2">
            <p class="mb-1 font-medium text-gray-700">磁盘最新版本</p>
            <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-gray-600">
              <dt>类型</dt><dd>{{ conflictDisk.type }}</dd>
              <dt>起点</dt><dd>{{ nodeLabel(conflictDisk.from.id) }}</dd>
              <dt>终点</dt><dd>{{ nodeLabel(conflictDisk.to.id) }}</dd>
              <dt>描述</dt><dd class="whitespace-pre-wrap">{{ conflictDisk.description || '（未登记）' }}</dd>
            </dl>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              v-if="!session.conflict.expanded"
              type="button"
              class="rounded-md border border-amber-400 bg-white px-2.5 py-1 font-medium text-amber-800 transition-colors hover:bg-amber-100"
              @click="store.refreshConflict()"
            >
              展开比较
            </button>
            <template v-else>
              <button
                type="button"
                :disabled="busy || session.conflict.probing || session.conflict.missing"
                class="rounded-md border border-amber-400 bg-white px-2.5 py-1 font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-50"
                @click="adoptDisk"
              >
                {{ confirmAdopt === 'disk' ? '再点一次确认放弃本地' : '采用磁盘版本' }}
              </button>
              <button
                type="button"
                :disabled="busy"
                class="rounded-md border border-amber-400 bg-white px-2.5 py-1 font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-50"
                @click="adoptMine"
              >
                {{ confirmAdopt === 'mine' ? '再点一次确认覆盖' : '采用我的当前内容' }}
              </button>
              <button
                type="button"
                class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-gray-600 transition-colors hover:bg-gray-50"
                @click="store.collapseConflict()"
              >
                返回继续编辑
              </button>
              <button
                type="button"
                class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-gray-600 transition-colors hover:bg-gray-50"
                @click="store.refreshConflict()"
              >
                重新读取
              </button>
            </template>
          </div>
        </div>

        <!-- 普通失败：原因 + 重试 -->
        <div
          v-if="session.failure"
          role="alert"
          class="flex items-center justify-between gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          <span class="min-w-0">{{ session.failure.message }}</span>
          <button type="button" class="shrink-0 rounded-md border border-red-300 px-2 py-0.5 transition-colors hover:bg-red-100" @click="store.retryDetailSave()">
            重试
          </button>
        </div>

        <label class="flex flex-col gap-1 text-xs text-gray-500">
          起点
          <RelationNodePicker
            :model-value="session.draft.fromId"
            :search="store.searchElementOptions"
            :label="nodeLabel(session.draft.fromId)"
            placeholder="起点（搜索要素）"
            :exclude-id="session.draft.toId"
            @select="store.rememberOption"
            @update:model-value="store.setDetailDraft(store.selectedRelationId, { fromId: $event })"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-gray-500">
          终点
          <RelationNodePicker
            :model-value="session.draft.toId"
            :search="store.searchElementOptions"
            :label="nodeLabel(session.draft.toId)"
            placeholder="终点（搜索要素）"
            :exclude-id="session.draft.fromId"
            @select="store.rememberOption"
            @update:model-value="store.setDetailDraft(store.selectedRelationId, { toId: $event })"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-gray-500">
          关系类型（短词，方向：起点 → 终点）
          <input
            :value="session.draft.type"
            type="text"
            :list="TYPE_DATALIST_ID"
            maxlength="30"
            class="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-gray-500"
            @input="updateField('type', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-gray-500">
          描述
          <textarea
            :value="session.draft.description"
            rows="5"
            placeholder="关系的细节、由来、当前张力…"
            class="resize-none rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-gray-500"
            @input="updateField('description', ($event.target as HTMLTextAreaElement).value)"
          />
        </label>
        <datalist :id="TYPE_DATALIST_ID">
          <option v-for="suggestion in RELATION_TYPE_SUGGESTIONS" :key="suggestion" :value="suggestion" />
        </datalist>

        <p class="text-[11px] text-gray-400">
          登记于 {{ store.selectedEdge.relation.createdAt.slice(0, 10) }}；更新于 {{ store.selectedEdge.relation.updatedAt.slice(0, 10) }}
        </p>
      </div>

      <div class="mt-auto shrink-0 border-t border-gray-100 p-3">
        <button
          type="button"
          :class="[
            'w-full rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
            confirmDelete
              ? 'bg-red-600 text-white hover:bg-red-500'
              : 'border border-red-200 text-red-600 hover:bg-red-50',
          ]"
          @click="removeRelation"
        >
          {{ confirmDelete ? '再点一次确认删除' : '删除这条关系' }}
        </button>
      </div>
    </div>

    <!-- 空态 -->
    <div v-else class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p class="text-sm text-gray-500">点击画布上的连线查看关系详情</p>
      <p class="text-xs text-gray-400">或点击上方「新建关系」登记人物、势力、地点之间的关系</p>
    </div>
  </section>
</template>
