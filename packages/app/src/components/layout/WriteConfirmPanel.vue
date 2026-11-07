<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { FileChangeConfirmationView } from '@novai/core/services/types'
import { hashContent } from '@novai/core'

import { useProjectStore } from '../../stores/project'
import PanelHeader from './PanelHeader.vue'
import {
  buildPendingReplaceSegments,
  type TextHighlightSegment,
} from '../../composables/useChangeHighlights'

/**
 * 内容写入确认面板（交互优化计划 §8）：新建与正文编辑确认从聊天黄色双块卡迁入
 * 现有右侧内容面板——全文只读展示局部红绿差异（绿 = 候选新内容，红 = 将被替换的
 * 原文，均未写盘），底部固定「同意写入 / 拒绝」。聊天区只留「等待审阅」标记与
 * 返回入口；离开（关闭面板）不取消请求。
 *
 * 版本复检（§8「确认前重新校验版本」）：面板打开与点击「同意写入」时各读一次磁盘，
 * 候选原文消失 / 文件被外部修改 / create 目标已被占用时暂停并展示失配原因，由用户
 * 决定重新校验、仍要同意（以真实工具结果为准——EditFile 自身的旧文匹配闸仍然生效）
 * 或拒绝。同意/拒绝只唤醒 Agent Loop，真实写盘由工具执行（服务层不把本地点击当成已执行）。
 */
const props = defineProps<{
  /** 当前待审阅的 create/edit 确认（队首） */
  confirmation: FileChangeConfirmationView
  /** 激活会话待确认总数（「第 x / 共 n 项」用） */
  totalCount: number
}>()

const emit = defineEmits<{
  confirm: []
  reject: []
  close: []
}>()

const projectStore = useProjectStore()

/** 内容类候选（create/edit）：本面板只服务这两类，rename/delete 走输入区接管（§8） */
const candidate = computed(() => {
  const c = props.confirmation.confirmation
  return c.kind === 'create' || c.kind === 'edit' ? c : null
})
const isCreate = computed(() => candidate.value?.kind === 'create')

/** 目标文件当前磁盘内容（create 时探测占用；读不到为 null） */
const diskFile = ref<{ content: string; hash: string } | null>(null)
const loadingDisk = ref(false)
/** 版本失配状态：idle 正常；changed = 文件被外部修改但候选原文仍在；missing = 候选原文已不存在 / 目标已被占用 */
const staleState = ref<'idle' | 'changed' | 'missing'>('idle')
/** 防重复提交（§8 每个请求独立锁定提交） */
const deciding = ref(false)

/** 预览切分段：edit 在磁盘内容上定位候选原文；create 整篇候选内容绿显 */
const segments = computed<TextHighlightSegment[] | null>(() => {
  const c = candidate.value
  if (!c) return null
  if (c.kind === 'create') {
    return c.content === '' ? [] : [{ kind: 'green' as const, text: c.content }]
  }
  if (diskFile.value === null) return null
  return buildPendingReplaceSegments(
    diskFile.value.content,
    c.oldText,
    c.newText,
    c.replaceAll === true,
  )
})

/** 替换处数（replaceAll 或多处匹配时的「共 k 处」提示） */
const replaceCount = computed(() => {
  const c = candidate.value
  if (c?.kind !== 'edit' || !segments.value) return 0
  return segments.value.filter((seg) => seg.kind === 'red').length
})

const fileName = computed(() => {
  const path = candidate.value?.path ?? ''
  return path.split('/').pop() ?? path
})

async function loadDisk() {
  const c = candidate.value
  if (!c) return
  loadingDisk.value = true
  try {
    const file = await projectStore.peekFile(c.path)
    diskFile.value = file ? { content: file.content, hash: hashContent(file.content) } : null
    // 重新载入后重算失配状态：候选原文仍在即恢复可正常同意
    if (c.kind === 'edit') {
      staleState.value =
        file && file.content.includes(c.oldText)
          ? 'idle'
          : 'missing'
    } else {
      staleState.value = file ? 'missing' : 'idle'
    }
  } finally {
    loadingDisk.value = false
  }
}

watch(
  () => props.confirmation.id,
  () => {
    staleState.value = 'idle'
    void loadDisk()
  },
  { immediate: true },
)

/**
 * 同意写入：先做确认前版本复检（§8），失配则暂停展示原因，由用户决定；
 * 版本相符才唤醒 Agent Loop 交给工具真实执行。
 */
async function handleConfirm() {
  const c = candidate.value
  if (!c || deciding.value || staleState.value !== 'idle') return
  deciding.value = true
  try {
    const fresh = await projectStore.peekFile(c.path)
    if (c.kind === 'edit') {
      if (!fresh || !fresh.content.includes(c.oldText)) {
        staleState.value = 'missing'
        return
      }
      if (hashContent(fresh.content) !== diskFile.value?.hash) {
        staleState.value = 'changed'
        diskFile.value = { content: fresh.content, hash: hashContent(fresh.content) }
        return
      }
    } else if (fresh) {
      staleState.value = 'missing'
      return
    }
    emit('confirm')
  } finally {
    deciding.value = false
  }
}

const staleExplain = computed(() => {
  if (staleState.value === 'changed') {
    return '文件在审阅期间被外部修改，上方预览已按最新内容重算。可以重新校验后再决定，或仍交由工具按真实文件内容执行。'
  }
  if (isCreate.value) {
    return '目标文件已存在，无法按「新建」写入。'
  }
  return '候选原文在当前文件中已找不到（文件可能被外部修改）。'
})
</script>

<template>
  <div v-if="candidate" class="flex min-h-0 flex-1 flex-col">
    <PanelHeader @close="emit('close')">
      <template #leading>
        <h2 class="truncate text-sm font-semibold text-gray-800">
          {{ isCreate ? '新建文件确认' : '编辑确认' }}
        </h2>
        <span class="shrink-0 text-xs text-gray-500">{{ fileName }}</span>
        <span
          class="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700"
        >待审阅 {{ totalCount }} 项</span>
      </template>
    </PanelHeader>

    <!-- 请求说明行：谁请求、动哪个文件、何种操作（§8 顶部说明） -->
    <div class="shrink-0 border-b border-gray-100 px-4 py-2 text-xs text-gray-500">
      <span class="font-medium text-gray-600">{{ props.confirmation.title }}</span>
      <span class="mx-1 text-gray-300">·</span>
      <span>{{ props.confirmation.summary }}</span>
      <span
        v-if="props.confirmation.agentLabel"
        class="ml-1 rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-500"
      >{{ props.confirmation.agentLabel }}</span>
      <span class="ml-1 font-mono text-[10px] text-gray-400">{{ candidate.path }}</span>
      <span v-if="replaceCount > 1" class="ml-1 text-amber-600">（共 {{ replaceCount }} 处替换）</span>
    </div>

    <!-- 版本失配提示（§8「失配则暂停并展示新版本与候选差异」）：不自动决定，给出出口 -->
    <div
      v-if="staleState !== 'idle'"
      class="flex shrink-0 items-start gap-1.5 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800"
      role="alert"
    >
      <svg class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
      <div class="min-w-0 flex-1">
        <p>{{ staleExplain }}</p>
        <div class="mt-1 flex gap-2">
          <button
            type="button"
            class="rounded border border-amber-300 bg-white px-2 py-0.5 font-medium text-amber-800 hover:bg-amber-100"
            @click="loadDisk"
          >重新校验</button>
          <button
            type="button"
            class="rounded px-2 py-0.5 font-medium text-amber-800 underline-offset-2 hover:underline"
            @click="emit('confirm')"
          >仍要同意（以工具结果为准）</button>
        </div>
      </div>
    </div>

    <!-- 全文只读预览：绿 = 候选新内容，红 = 将被替换的原文（均未写盘） -->
    <div class="relative min-h-0 flex-1 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-4 mx-4 my-3">
      <div v-if="loadingDisk" class="py-8 text-center text-xs text-gray-400">正在读取目标文件…</div>
      <pre
        v-else-if="segments"
        class="change-hl-scope whitespace-pre-wrap text-sm leading-6 text-gray-800"
      ><span
        v-for="(seg, index) in segments"
        :key="index"
        :class="seg.kind === 'green' ? 'confirm-hl-green' : seg.kind === 'red' ? 'confirm-hl-red' : ''"
      >{{ seg.text }}</span></pre>
      <div v-else class="py-8 text-center text-xs text-gray-400">
        目标文件当前不可读（可能已不存在），可拒绝此请求或让工具按真实结果执行。
      </div>
    </div>

    <!-- 底部固定操作（§8）：同意写入 / 拒绝；拒绝不写入，Agent 收到拒绝结果后可调整 -->
    <div class="flex shrink-0 items-center justify-between gap-3 border-t border-gray-200 px-4 py-3">
      <p class="min-w-0 text-[11px] leading-4 text-gray-400">
        拒绝不写入；同意后由 Agent 真实执行写盘，结果以工具返回为准。
      </p>
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
          @click="emit('reject')"
        >拒绝</button>
        <button
          type="button"
          class="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="staleState !== 'idle' || deciding || loadingDisk"
          @click="handleConfirm"
        >同意写入</button>
      </div>
    </div>
  </div>
</template>

<!-- 全局样式：确认预览的红绿段与定位高亮（§7）同语系，但语义独立（未写盘的候选内容） -->
<style>
.confirm-hl-green {
  background-color: rgb(187 247 208 / 0.9);
  border-radius: 2px;
}
.confirm-hl-red {
  background-color: rgb(254 202 202 / 0.9);
  text-decoration: line-through;
  text-decoration-color: rgb(220 38 38 / 0.55);
  border-radius: 2px;
}
</style>
