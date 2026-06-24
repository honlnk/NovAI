<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { scanChaptersForOrganize, applyChapterOrganize } from '@novai/core/services/organize-service'
import type { ChapterOrganizeItem, ChapterOrganizeResult } from '@novai/core/services/organize-service'
import { useProjectStore } from '../../stores/project'
import { useToast } from '../../composables/useToast'

const props = defineProps<{
  projectId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const projectStore = useProjectStore()
const toast = useToast()

/** 可编辑的整理计划（用户可改建议名） */
const items = ref<ChapterOrganizeItem[]>([])
const compliantCount = ref(0)
const isLoading = ref(true)
const isApplying = ref(false)
/** scan / apply 的错误，非 item 级错误 */
const errorMessage = ref('')

/**
 * 模态框采用 v-if 按需挂载，每次打开重新触发 onMounted 扫描磁盘，
 * 保证计划基于最新文件状态。
 */
onMounted(async () => {
  await loadPlan()
})

async function loadPlan() {
  isLoading.value = true
  errorMessage.value = ''
  try {
    const plan = await scanChaptersForOrganize(props.projectId)
    items.value = plan.items
    compliantCount.value = plan.compliantCount
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    isLoading.value = false
  }
}

const needsReviewCount = computed(() => items.value.filter((item) => item.needsReview).length)

/** 用户编辑某项的建议标题后，重新拼装规范文件名 */
function updateSuggestedTitle(item: ChapterOrganizeItem, title: string) {
  const trimmed = title.trim()
  if (!trimmed) {
    return // 空标题不允许，保留原值不动（提交时再校验）
  }
  // 从当前 suggestedName 解析编号，重新格式化
  const numberMatch = /第(\d+)章/.exec(item.suggestedName)
  const number = numberMatch ? Number(numberMatch[1]) : 1
  const match = /^第(\d+)章-(.+)\.txt$/.exec(item.suggestedName)
  if (match) {
    const num = Number(match[1])
    const padded = String(num).padStart(3, '0')
    item.suggestedName = `第${padded}章-${trimmed}.txt`
    item.suggestedPath = `chapters/${item.suggestedName}`
  }
}

/** 校验：建议名是否合法（非空且符合规范），返回首个不合法项的错误信息 */
function validateItems(): string | null {
  for (const item of items.value) {
    if (!/^第\d{3,}章-.+\.txt$/.test(item.suggestedName)) {
      return `建议名不合规：${item.currentName} → ${item.suggestedName}（需形如 第NNN章-标题.txt）`
    }
  }
  // 检查建议名之间是否重复
  const seen = new Set<string>()
  for (const item of items.value) {
    if (seen.has(item.suggestedPath)) {
      return `建议名重复：${item.suggestedName}（多个文件指向同一目标）`
    }
    seen.add(item.suggestedPath)
  }
  return null
}

const canApply = computed(() => !isLoading.value && !isApplying.value && items.value.length > 0)

async function handleApply() {
  const validationError = validateItems()
  if (validationError) {
    toast.error(validationError)
    return
  }

  isApplying.value = true
  try {
    const results: ChapterOrganizeResult[] = await applyChapterOrganize(
      props.projectId,
      items.value.map((item) => ({
        currentPath: item.currentPath,
        suggestedPath: item.suggestedPath,
      })),
    )

    const failed = results.filter((r) => !r.ok)
    const succeeded = results.filter((r) => r.ok)

    // 刷新文件树，让列表反映改名结果
    await projectStore.refreshTree()

    if (failed.length === 0) {
      toast.success(`已完成 ${succeeded.length} 个章节的整理`)
      emit('close')
    } else {
      const firstError = failed[0]?.error ?? '未知错误'
      toast.error(`${succeeded.length} 个成功，${failed.length} 个失败：${firstError}`)
      // 部分失败：重新扫描剩余待整理项
      await loadPlan()
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '章节整理失败')
  } finally {
    isApplying.value = false
  }
}
</script>

<template>
  <!-- 遮罩层 -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    @click.self="emit('close')"
  >
    <!-- 模态框主体 -->
    <div class="flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
      <!-- 顶栏 -->
      <header class="flex shrink-0 items-center justify-between border-b border-gray-200 px-6 py-4">
        <div>
          <h2 class="text-lg font-semibold text-gray-900">章节整理</h2>
          <p class="mt-0.5 text-xs text-gray-500">
            将不规范章节统一为「第NNN章-标题.txt」格式
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
        <!-- 加载中 -->
        <div v-if="isLoading" class="flex h-full items-center justify-center text-gray-400">
          正在扫描章节...
        </div>

        <!-- 错误 -->
        <div v-else-if="errorMessage" class="flex h-full flex-col items-center justify-center gap-3 text-gray-500">
          <p class="text-sm">{{ errorMessage }}</p>
          <button
            class="rounded-lg bg-gray-100 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-200"
            @click="loadPlan"
          >
            重新扫描
          </button>
        </div>

        <!-- 无需整理 -->
        <div v-else-if="items.length === 0" class="flex h-full flex-col items-center justify-center gap-2 text-gray-500">
          <svg class="h-10 w-10 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p class="text-sm">
            全部 {{ compliantCount }} 个章节已符合规范，无需整理
          </p>
        </div>

        <!-- 待整理列表 -->
        <div v-else>
          <!-- 概要 -->
          <div class="mb-4 rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-600">
            发现 <span class="font-semibold text-gray-900">{{ items.length }}</span> 个待整理章节，
            <span v-if="needsReviewCount > 0">其中 <span class="font-semibold text-amber-600">{{ needsReviewCount }}</span> 个缺标题（已用正文首行兜底，请核对）；</span>
            另有 {{ compliantCount }} 个已符合规范。
          </div>

          <!-- 表头 -->
          <div class="mb-2 grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-2 text-xs font-medium text-gray-400">
            <span>当前文件名</span>
            <span></span>
            <span>建议文件名（可编辑）</span>
          </div>

          <!-- 列表项 -->
          <ul class="space-y-2">
            <li
              v-for="item in items"
              :key="item.currentPath"
              :class="[
                'grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-lg border px-3 py-2.5',
                item.needsReview ? 'border-amber-200 bg-amber-50/50' : 'border-gray-200 bg-white',
              ]"
            >
              <!-- 当前名 -->
              <div class="min-w-0">
                <p class="truncate text-sm text-gray-700">{{ item.currentName }}</p>
                <p class="mt-0.5 text-xs text-gray-400">
                  <span v-if="item.reason === 'extension'">需转为 .txt</span>
                  <span v-else>命名不规范</span>
                </p>
              </div>

              <!-- 箭头 -->
              <svg class="h-4 w-4 shrink-0 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              </svg>

              <!-- 建议名（可编辑） -->
              <div class="min-w-0">
                <input
                  :value="item.suggestedName"
                  :class="[
                    'w-full rounded border bg-white px-2 py-1 text-sm outline-none transition-colors focus:border-blue-400 focus:ring-1 focus:ring-blue-100',
                    item.needsReview ? 'border-amber-300' : 'border-gray-200',
                  ]"
                  :title="item.needsReview ? '缺标题，已用正文首行兜底，可手动修改' : ''"
                  @input="updateSuggestedTitle(item, ($event.target as HTMLInputElement).value)"
                >
                <p v-if="item.needsReview" class="mt-0.5 text-xs text-amber-500">⚠ 正文兜底，请核对</p>
              </div>
            </li>
          </ul>
        </div>
      </div>

      <!-- 底栏 -->
      <footer class="flex shrink-0 items-center justify-between border-t border-gray-200 px-6 py-4">
        <span class="text-xs text-gray-400">改名不可撤销，整理前请确认建议名</span>
        <div class="flex gap-2">
          <button
            class="rounded-lg px-4 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100"
            @click="emit('close')"
          >
            取消
          </button>
          <button
            :disabled="!canApply"
            :class="[
              'rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors',
              canApply ? 'bg-blue-600 hover:bg-blue-700' : 'cursor-not-allowed bg-gray-300',
            ]"
            @click="handleApply"
          >
            {{ isApplying ? '整理中...' : `全部转换（${items.length}）` }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>
