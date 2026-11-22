<script setup lang="ts">
import { computed, ref } from 'vue'

import type { SkillImportCandidateView, SkillImportOutcomeView } from '@novai/core/services/types'
import AppIcon from '../ui/AppIcon.vue'

/**
 * 技能合集导入对话框（决策 12，参照 ZCode 导入对话框）：
 * 所选文件夹根下没有 SKILL.md 时，列出其一级子文件夹中含 SKILL.md 的技能供
 * 勾选（全选/取消全选），已存在的标「同名已存在」不可勾选。确认后执行导入，
 * 结果态逐个可见（成功 ✓ / 同名跳过），列表重算由 store 完成后关闭。
 *
 * 单技能来源（根下有 SKILL.md）不走本对话框——直接导入。
 */
const props = defineProps<{
  /** 所选文件夹名（标题展示） */
  sourceName: string
  candidates: SkillImportCandidateView[]
}>()

const emit = defineEmits<{
  /** 确认导入（勾选的 folderName 列表） */
  confirm: [folderNames: string[]]
  close: []
}>()

/** 勾选集（同名已存在的不可选，初始化即排除） */
const selectable = computed(() => props.candidates.filter((c) => !c.hasConflict))
const selected = ref<Set<string>>(new Set(selectable.value.map((c) => c.folderName)))

const allSelected = computed(
  () => selectable.value.length > 0 && selectable.value.every((c) => selected.value.has(c.folderName)),
)

function toggle(folderName: string) {
  const next = new Set(selected.value)
  if (next.has(folderName)) {
    next.delete(folderName)
  } else {
    next.add(folderName)
  }
  selected.value = next
}

function toggleAll() {
  selected.value = allSelected.value
    ? new Set()
    : new Set(selectable.value.map((c) => c.folderName))
}

/** 导入执行态：confirm 后由父组件调服务，结果回来经 complete 展示 */
const outcome = ref<SkillImportOutcomeView | null>(null)
const importError = ref('')

async function handleConfirm() {
  if (selected.value.size === 0 || outcome.value) return
  emit('confirm', [...selected.value])
}

/** 父组件回报导入结果（成功）；结果态逐个可见，用户点完成关闭 */
function complete(result: SkillImportOutcomeView) {
  outcome.value = result
}

/** 父组件回报导入失败（目录选择器到导入间源不可读等）；错误显示，允许重试或关闭 */
function fail(error: unknown) {
  importError.value = error instanceof Error ? error.message : '导入失败'
}

defineExpose({ complete, fail })

function isImported(folderName: string): boolean {
  return outcome.value?.imported.includes(folderName) ?? false
}

function isSkipped(folderName: string): boolean {
  return outcome.value?.skipped.some((s) => s.folderName === folderName) ?? false
}
</script>

<template>
  <div
    class="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="导入技能合集"
    data-testid="skill-import-dialog"
  >
    <div class="flex max-h-[80%] w-full max-w-sm flex-col rounded-lg border border-white/10 bg-[#1f1f1f] shadow-xl">
      <div class="flex items-center justify-between px-4 pb-2 pt-4">
        <h3 class="text-sm font-semibold text-white">导入技能合集</h3>
        <button
          class="rounded p-1 text-gray-500 transition-colors hover:bg-white/10 hover:text-gray-300"
          aria-label="关闭"
          data-testid="skill-import-close"
          @click="emit('close')"
        >
          <AppIcon name="x" :size="14" class="h-3.5 w-3.5" />
        </button>
      </div>
      <p class="px-4 pb-2 text-xs text-gray-500">
        在 <span class="rounded bg-white/10 px-1 font-mono text-[11px]">{{ sourceName }}/</span> 中找到
        {{ candidates.length }} 个技能，勾选要导入的：
      </p>

      <!-- 候选列表：勾选 + 同名已存在不可选 -->
      <div class="min-h-0 flex-1 overflow-y-auto px-2" data-testid="skill-import-candidates">
        <label
          v-for="candidate in candidates"
          :key="candidate.folderName"
          :class="[
            'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
            candidate.hasConflict ? 'cursor-not-allowed text-gray-600' : 'cursor-pointer text-gray-300 hover:bg-white/5',
          ]"
        >
          <input
            v-if="!candidate.hasConflict"
            type="checkbox"
            class="h-3.5 w-3.5 accent-emerald-500"
            :checked="selected.has(candidate.folderName) || isImported(candidate.folderName)"
            :disabled="outcome !== null"
            :data-testid="`skill-import-check-${candidate.folderName}`"
            @change="toggle(candidate.folderName)"
          />
          <span v-else class="flex h-3.5 w-3.5 items-center justify-center"><AppIcon name="lock" :size="11" class="h-[11px] w-[11px] text-gray-700" /></span>
          <span class="min-w-0 flex-1 truncate">{{ candidate.folderName }}</span>
          <!-- 状态徽标：同名已存在（不可选）/ 导入成功 / 跳过 -->
          <span v-if="candidate.hasConflict" class="shrink-0 text-xs text-gray-600" data-testid="skill-import-conflict">同名已存在</span>
          <span v-else-if="isImported(candidate.folderName)" class="shrink-0 text-xs text-emerald-400" data-testid="skill-import-done">已导入</span>
          <span v-else-if="isSkipped(candidate.folderName)" class="shrink-0 text-xs text-gray-500" data-testid="skill-import-skipped">已跳过</span>
        </label>
      </div>

      <p v-if="importError" class="px-4 pt-2 text-xs text-red-400" data-testid="skill-import-error">{{ importError }}</p>

      <!-- 底部：全选切换（结果态隐藏）+ 确认/完成 -->
      <div class="flex items-center justify-between border-t border-white/10 px-4 py-3">
        <button
          v-if="outcome === null"
          class="text-xs text-gray-500 underline decoration-gray-700 underline-offset-2 transition-colors hover:text-gray-300"
          data-testid="skill-import-toggle-all"
          @click="toggleAll"
        >
          {{ allSelected ? '取消全选' : '全选' }}
        </button>
        <span v-else class="text-xs text-gray-500">
          已导入 {{ outcome.imported.length }} 个<template v-if="outcome.skipped.length > 0">，跳过 {{ outcome.skipped.length }} 个同名</template>
        </span>
        <button
          v-if="outcome === null"
          class="rounded-md bg-emerald-600/90 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="selected.size === 0"
          data-testid="skill-import-confirm"
          @click="handleConfirm"
        >
          导入所选（{{ selected.size }}）
        </button>
        <button
          v-else
          class="rounded-md bg-white/10 px-3 py-1.5 text-xs font-medium text-gray-200 transition-colors hover:bg-white/20"
          data-testid="skill-import-finish"
          @click="emit('close')"
        >
          完成
        </button>
      </div>
    </div>
  </div>
</template>
