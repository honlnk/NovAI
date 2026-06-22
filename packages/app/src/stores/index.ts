import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { inspectIndex, rebuildIndex, subscribeIndexChange } from '@novai/core/services/rag-service'
import type {
  IndexBuildResultView,
  IndexStatusView,
  ProjectIndexMetaView,
} from '@novai/core/services/types'

/**
 * RAG 索引状态的响应式 store。
 *
 * 持有当前项目的索引 meta，订阅 core 层事件总线自动更新
 * （要素写入标 stale / 重建完成 / 构建失败都会通过事件刷新）。
 * 状态栏与设置页共享同一份状态，避免重复请求。
 */
export const useIndexStore = defineStore('rag-index', () => {
  const indexMeta = ref<ProjectIndexMetaView | null>(null)
  const isBusy = ref(false)
  const errorMessage = ref('')

  let unsubscribe: (() => void) | null = null

  const status = computed<IndexStatusView | null>(() => indexMeta.value?.status ?? null)
  const documentCount = computed(() => indexMeta.value?.documentCount ?? 0)

  /** 索引是否处于「可点击重建」的过期/异常态。 */
  const canRebuild = computed(
    () => !isBusy.value && (status.value === 'stale' || status.value === 'error' || status.value === 'ready' || status.value === 'empty'),
  )

  async function init(projectId: string) {
    // 重新 init 前先退订旧订阅，避免泄漏。
    dispose()

    unsubscribe = subscribeIndexChange(projectId, (meta) => {
      indexMeta.value = meta
    })

    await refresh(projectId)
  }

  function dispose() {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    indexMeta.value = null
    isBusy.value = false
    errorMessage.value = ''
  }

  async function refresh(projectId: string) {
    try {
      indexMeta.value = await inspectIndex(projectId)
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '读取索引状态失败'
    }
  }

  /**
   * 重建索引。不传 sourcePaths 为全量；传入则增量（仅重建指定文件，复用未变向量）。
   * 重建过程中状态栏进入 busy 态，完成后由事件总线或显式 refresh 更新。
   */
  async function rebuild(projectId: string, sourcePaths?: string[]): Promise<IndexBuildResultView | null> {
    if (isBusy.value) {
      return null
    }

    errorMessage.value = ''
    isBusy.value = true

    try {
      const result = await rebuildIndex(projectId, sourcePaths)
      // 事件总线通常已更新 meta，这里兜底刷新一次保证一致。
      await refresh(projectId)
      return result
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '重建索引失败'
      await refresh(projectId)
      return null
    } finally {
      isBusy.value = false
    }
  }

  return {
    indexMeta,
    isBusy,
    errorMessage,
    status,
    documentCount,
    canRebuild,
    init,
    dispose,
    refresh,
    rebuild,
  }
})

const STATUS_LABELS: Record<IndexStatusView, string> = {
  empty: '空索引',
  building: '构建中',
  ready: '索引就绪',
  stale: '部分过期',
  rebuilding: '重建中',
  error: '索引异常',
}

const STATUS_CLASSES: Record<IndexStatusView, string> = {
  empty: 'bg-gray-100 text-gray-500 ring-gray-200',
  building: 'bg-blue-50 text-blue-600 ring-blue-200',
  ready: 'bg-green-50 text-green-700 ring-green-200',
  stale: 'bg-amber-50 text-amber-700 ring-amber-200',
  rebuilding: 'bg-blue-50 text-blue-600 ring-blue-200',
  error: 'bg-red-50 text-red-700 ring-red-200',
}

const STATUS_DOT_CLASSES: Record<IndexStatusView, string> = {
  empty: 'bg-gray-400',
  building: 'bg-blue-500 animate-pulse',
  ready: 'bg-green-500',
  stale: 'bg-amber-500',
  rebuilding: 'bg-blue-500 animate-pulse',
  error: 'bg-red-500',
}

export function getIndexStatusLabel(status: IndexStatusView): string {
  return STATUS_LABELS[status]
}

export function getIndexStatusClass(status: IndexStatusView): string {
  return STATUS_CLASSES[status]
}

export function getIndexStatusDotClass(status: IndexStatusView): string {
  return STATUS_DOT_CLASSES[status]
}
