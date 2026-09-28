<script setup lang="ts">
import { computed, onMounted } from 'vue'

import { useIndexStore, getIndexStatusClass, getIndexStatusLabel } from '../../stores/index'
import { useToast } from '../../composables/useToast'

/**
 * 向量索引独立管理页（模态框）。
 *
 * 恢复 2026-06 设置页中的「向量索引」卡片（187e0b2 设置重构时被遗漏），
 * 与设置弹窗解耦，由活动栏「向量索引」按钮单独打开。
 * 状态与构建复用 indexStore（与底部状态栏共享同一份响应式 meta），
 * v-if 按需挂载，打开时 refresh 一次保证读取最新磁盘状态。
 */
const props = defineProps<{
  projectId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const indexStore = useIndexStore()
const toast = useToast()

const status = computed(() => indexStore.status)
const meta = computed(() => indexStore.indexMeta)
const isBusy = computed(() => indexStore.isBusy)

/** 未初始化（status === null）单独出一档文案与样式，其余复用状态字典。 */
const statusLabel = computed(() => (status.value ? getIndexStatusLabel(status.value) : '未初始化'))
const statusClass = computed(() =>
  status.value
    ? getIndexStatusClass(status.value)
    : 'bg-gray-100 text-gray-500 ring-gray-200',
)

/** 状态说明文案：异常/过期带原因，构建中给进行时提示，其余给常规说明。 */
const statusMessage = computed(() => {
  if (isBusy.value) {
    return '正在构建索引，逐个要素文件调用 Embedding，请稍候…'
  }
  if (!meta.value) {
    return '当前项目还没有索引记录，点击「构建索引」开始首次构建（需先在设置中配置 Embedding）'
  }
  if (status.value === 'error' || status.value === 'stale') {
    return meta.value.lastError ?? '索引需要重建'
  }
  if (status.value === 'empty') {
    return '索引构建完成，但当前项目下还没有可索引的要素文件'
  }
  if (status.value === 'ready') {
    return '索引可用，Agent 可通过 RagSearch 召回要素作为写作上下文'
  }
  return ''
})

/** 构建按钮文案：未初始化是首次构建，其余是全量重建。 */
const buildButtonText = computed(() => (status.value === null ? '构建索引' : '重建索引'))

onMounted(() => {
  indexStore.refresh(props.projectId)
})

async function handleBuild() {
  const result = await indexStore.rebuild(props.projectId)
  if (result) {
    toast.success(result.message)
  } else {
    toast.error(indexStore.errorMessage || '重建索引失败')
  }
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无'
}
</script>

<template>
  <!-- 遮罩层 -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    @click.self="emit('close')"
  >
    <!-- 模态框主体 -->
    <div class="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
      <!-- 顶栏 -->
      <header class="flex shrink-0 items-center justify-between border-b border-gray-200 px-6 py-4">
        <div>
          <h2 class="text-lg font-semibold text-gray-900">向量索引</h2>
          <p class="mt-0.5 text-xs text-gray-500">
            对项目要素文件做向量化，供写作前语义召回
          </p>
        </div>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          title="关闭"
          @click="emit('close')"
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>

      <!-- 内容区 -->
      <div class="flex-1 overflow-y-auto px-6 py-4">
        <!-- 状态与操作 -->
        <div class="rounded-lg border border-gray-200 bg-white p-4">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="text-sm font-semibold text-gray-800">当前状态</h3>
                <span
                  :class="['rounded-full px-2 py-0.5 text-xs font-medium ring-1', statusClass]"
                >
                  {{ isBusy ? '构建中' : statusLabel }}
                </span>
              </div>
              <p class="mt-1 text-xs text-gray-500">{{ statusMessage }}</p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <button
                class="rounded-lg bg-gray-100 px-3 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-200 disabled:opacity-40"
                :disabled="isBusy"
                title="刷新索引状态"
                @click="indexStore.refresh(projectId)"
              >
                刷新
              </button>
              <button
                class="rounded-lg bg-gray-900 px-3 py-1.5 text-sm text-white transition-colors hover:bg-gray-700 disabled:opacity-40"
                :disabled="isBusy"
                :title="status === null ? '开始首次构建（全量）' : '清空后全量重建，会重新调用 Embedding'"
                @click="handleBuild"
              >
                {{ buildButtonText }}
              </button>
            </div>
          </div>
        </div>

        <!-- 索引详情 -->
        <div class="mt-4 grid grid-cols-2 gap-2 text-xs text-gray-600">
          <div class="rounded-md bg-gray-50 px-3 py-2">
            <div class="text-gray-400">文档数</div>
            <div class="mt-1 font-medium text-gray-800">{{ meta?.documentCount ?? 0 }}</div>
          </div>
          <div class="rounded-md bg-gray-50 px-3 py-2">
            <div class="text-gray-400">向量维度</div>
            <div class="mt-1 font-medium text-gray-800">{{ meta?.embeddingDim || '—' }}</div>
          </div>
          <div class="rounded-md bg-gray-50 px-3 py-2">
            <div class="text-gray-400">Embedding 模型</div>
            <div class="mt-1 truncate font-medium text-gray-800" :title="meta?.embeddingModel">
              {{ meta?.embeddingModel || '—' }}
            </div>
          </div>
          <div class="rounded-md bg-gray-50 px-3 py-2">
            <div class="text-gray-400">Rerank 模型</div>
            <div class="mt-1 truncate font-medium text-gray-800" :title="meta?.rerankModel">
              {{ meta?.rerankModel || '未配置' }}
            </div>
          </div>
          <div class="rounded-md bg-gray-50 px-3 py-2">
            <div class="text-gray-400">最近构建</div>
            <div class="mt-1 font-medium text-gray-800">{{ formatDate(meta?.lastBuildAt) }}</div>
          </div>
          <div class="rounded-md bg-gray-50 px-3 py-2">
            <div class="text-gray-400">最近全量重建</div>
            <div class="mt-1 font-medium text-gray-800">{{ formatDate(meta?.lastFullRebuildAt) }}</div>
          </div>
        </div>

        <!-- 说明 -->
        <p class="mt-4 text-xs leading-5 text-gray-500">
          索引对象为要素文件（人物/地点/实体/时间线/剧情/世界观），不含章节正文。全量重建会清空现有向量后逐文件重新调用
          Embedding（未变更内容不会在增量场景外被跳过）；日常要素写入后索引会自动标记「部分过期」，
          届时点击重建即可增量刷新。
        </p>
      </div>
    </div>
  </div>
</template>
