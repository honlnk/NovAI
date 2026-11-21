<script setup lang="ts">
/**
 * 关系图谱弹窗（关系图谱施工计划 §六）：组合 WorkspaceModal 外壳，
 * 内部左画布（RelationCanvas）右详情（RelationDetail），工具条含搜索添加节点、
 * 按要素/关系类型筛选、聚焦清除、检查入口（issue 徽标 + 一键清理）、新建关系。
 *
 * 损坏态：主体替换为只读原始内容 + 「重新初始化（副本入回收站）」出口。
 * 窄屏（<lg）：详情区改纵向堆叠（画布固定高度 + 详情独立滚动）。
 */
import { computed, onMounted, ref, watch } from 'vue'

import { useRelationStore } from '../../stores/relation'
import { relationNodeKey } from '../../utils/relation-node-key'
import type { RelationElementOptionView } from '@novai/core/services/relation-service'
import type { ElementType } from '@novai/core/types/rag'
import WorkspaceModal from '../layout/WorkspaceModal.vue'
import AppIcon from '../ui/AppIcon.vue'
import RelationCanvas from './RelationCanvas.vue'
import RelationDetail from './RelationDetail.vue'

const props = defineProps<{
  projectId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const store = useRelationStore()

const isOpen = computed(() => store.projectId === props.projectId && store.loadState !== 'idle')

onMounted(() => {
  void store.open(props.projectId)
})

/* ---------- 搜索添加节点 ---------- */

const searchQuery = ref('')
const searchOptions = ref<RelationElementOptionView[]>([])
const searchOpen = ref(false)

let searchToken = 0

watch(searchQuery, async (value) => {
  const token = ++searchToken
  const text = value.trim()
  if (!text) {
    searchOptions.value = []
    return
  }
  const result = await store.searchElementOptions(text)
  if (token === searchToken) {
    searchOptions.value = result
    searchOpen.value = true
  }
})

function addNode(option: RelationElementOptionView) {
  store.addExtraNode(option)
  searchQuery.value = ''
  searchOptions.value = []
  searchOpen.value = false
}

/* ---------- 工具条 ---------- */

const ELEMENT_TYPE_OPTIONS: Array<{ value: ElementType | ''; label: string }> = [
  { value: '', label: '全部类型' },
  { value: 'character', label: '人物' },
  { value: 'location', label: '地点' },
  { value: 'entity', label: '实体' },
  { value: 'plot', label: '情节' },
  { value: 'worldbuilding', label: '世界观' },
]

const issuesOpen = ref(false)

function clearFocus() {
  store.focusedNodeId = ''
  store.selectedRelationId = ''
}

async function handleClose() {
  await store.close()
  emit('close')
}

/* ---------- 坐标去抖保存（画布回调直通 store） ---------- */

function onDragStop(nodeId: string, position: { x: number; y: number }) {
  store.recordNodePosition(nodeId, position)
}

function onNodeClick(nodeId: string) {
  // 再点一次取消聚焦
  store.focusedNodeId = store.focusedNodeId === nodeId ? '' : nodeId
}

function onEdgeClick(relationId: string) {
  void store.openDetail(relationId)
}

function onSearchFocus() {
  if (searchOptions.value.length > 0) {
    searchOpen.value = true
  }
}

function onSearchBlur() {
  setTimeout(() => {
    searchOpen.value = false
  }, 150)
}
</script>

<template>
  <WorkspaceModal
    :is-open="isOpen"
    title="关系图谱"
    :subtitle="`${store.relationCount} 条关系 · ${store.canvasNodes.length} 个节点`"
    width-class="max-w-6xl"
    height-class="h-[min(90vh,48rem)]"
    :loading="store.isLoading"
    :error="store.loadState === 'error' ? store.actionError || '加载关系图谱失败' : null"
    :empty="store.isReady && store.relationCount === 0 && store.canvasNodes.length === 0 && !store.createOpen"
    empty-text="还没有任何关系。用右上「新建关系」或让 AI 在写作时登记人物、势力、地点之间的关系。"
    @close="handleClose"
  >
    <template #actions>
      <button
        type="button"
        class="flex items-center gap-1 rounded-lg bg-gray-900 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-700"
        @click="store.openCreateForm()"
      >
        <AppIcon name="plus" :size="14" class="h-3.5 w-3.5" />
        新建关系
      </button>
    </template>

    <!-- 损坏态：只读原始内容 + 重置出口 -->
    <div v-if="store.isCorrupt" class="flex h-full flex-col gap-3 p-4">
      <div role="alert" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        关系账本文件已损坏，读取与写入都被阻止。可以查看原始内容，或把副本放入回收站后重新初始化（当前关系数据将清空）。
      </div>
      <pre class="min-h-0 flex-1 overflow-auto rounded-lg bg-gray-950 p-3 text-xs leading-relaxed text-gray-200">{{ store.corruptRaw }}</pre>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
          @click="store.reinitializeFromCorrupt()"
        >
          副本入回收站并重新初始化
        </button>
      </div>
    </div>

    <!-- 正常态：工具条 + 画布/详情 -->
    <div v-else class="flex h-full min-h-0 flex-col">
      <!-- 工具条 -->
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2">
        <div class="relative">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="搜索要素加到画布…"
            class="w-52 rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-800 outline-none focus:border-gray-500"
            aria-label="搜索要素添加到画布"
            @focus="onSearchFocus"
            @blur="onSearchBlur"
          />
          <ul
            v-if="searchOpen && searchOptions.length > 0"
            class="absolute left-0 top-full z-30 mt-1 max-h-56 w-72 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
          >
            <li v-for="option in searchOptions" :key="relationNodeKey(option)">
              <button
                type="button"
                class="flex w-full flex-col items-start px-3 py-1.5 text-left transition-colors hover:bg-gray-50"
                @mousedown.prevent="addNode(option)"
              >
                <span class="text-sm text-gray-800">
                  {{ option.name }}
                  <span class="ml-1 text-xs text-gray-400">{{ option.type }}</span>
                </span>
                <span v-if="option.summary" class="w-full truncate text-xs text-gray-400">{{ option.summary }}</span>
              </button>
            </li>
          </ul>
        </div>

        <select
          v-model="store.filterElementType"
          aria-label="按要素类型筛选"
          class="rounded-lg border border-gray-300 px-2 py-1 text-xs text-gray-700 outline-none"
        >
          <option v-for="option in ELEMENT_TYPE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <input
          v-model="store.filterRelationType"
          type="text"
          placeholder="关系类型筛选（如 盟友）"
          aria-label="按关系类型筛选"
          class="w-40 rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-800 outline-none focus:border-gray-500"
        >

        <button
          v-if="store.focusedNodeId || store.selectedRelationId"
          type="button"
          class="rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-50"
          @click="clearFocus()"
        >
          清除聚焦
        </button>

        <button
          type="button"
          :class="[
            'flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs transition-colors',
            store.issueCount > 0
              ? 'border border-amber-300 bg-amber-50 font-medium text-amber-700 hover:bg-amber-100'
              : 'border border-gray-300 text-gray-600 hover:bg-gray-50',
          ]"
          @click="issuesOpen = !issuesOpen"
        >
          <AppIcon name="circle-alert" :size="14" class="h-3.5 w-3.5" />
          数据检查
          <span v-if="store.issueCount > 0">{{ store.issueCount }}</span>
        </button>

        <span class="ml-auto text-xs text-gray-400">拖拽定位 · 点击节点聚焦 · 点击连线看详情</span>
      </div>

      <!-- 检查面板（issue 列表 + 一键清理） -->
      <div v-if="issuesOpen" class="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2.5">
        <template v-if="store.issueCount > 0">
          <ul class="mb-2 flex flex-col gap-1 text-xs text-amber-800">
            <li v-for="(issue, index) in store.graph?.issues ?? []" :key="index">
              · {{ issue.kind === 'invalid-relation'
                ? `第 ${issue.index + 1} 条关系格式非法：${issue.reason}`
                : issue.kind === 'duplicate-relation-id'
                  ? `第 ${issue.index + 1} 条关系的标识 ${issue.id} 与前面的关系重复（已隔离；清理将移除这一条）`
                  : `画布坐标键 ${issue.key} 格式非法：${issue.reason}` }}
            </li>
          </ul>
          <p class="mb-2 text-xs text-amber-700">异常数据会阻止登记、修改和删除关系（拖动坐标与删除要素时的级联清理照常，异常条目原样保留）。清理会移除这些条目。</p>
          <button
            type="button"
            class="rounded-lg border border-amber-400 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
            @click="store.cleanupIssues()"
          >
            一键清理异常条目
          </button>
        </template>
        <p v-else class="text-xs text-green-700">账本数据健康：无非法条目。</p>
      </div>

      <!-- 画布 + 详情：宽屏左右分栏；窄屏上下堆叠 -->
      <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div class="relative min-h-[16rem] flex-1 border-b border-gray-100 lg:border-b-0 lg:border-r">
          <RelationCanvas
            :nodes="store.canvasNodes"
            :edges="store.canvasEdges"
            :selected-edge-id="store.selectedRelationId"
            :focus-node-id="store.focusedNodeId"
            @drag-stop="onDragStop"
            @node-click="onNodeClick"
            @edge-click="onEdgeClick"
            @pane-click="clearFocus()"
          />
          <p v-if="store.actionError" class="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-red-50 px-3 py-1 text-xs text-red-700 shadow">
            {{ store.actionError }}
          </p>
        </div>
        <aside class="min-h-0 w-full shrink-0 lg:w-80 xl:w-96">
          <RelationDetail />
        </aside>
      </div>
    </div>
  </WorkspaceModal>
</template>
