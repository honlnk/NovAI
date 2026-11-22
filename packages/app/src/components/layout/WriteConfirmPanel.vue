<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { FileChangeConfirmationView } from '@novai/core/services/types'
import { RELATION_LEDGER_PATH } from '@novai/core/types/relation'
import { TIMELINE_LEDGER_PATH } from '@novai/core/types/timeline'
import { hashContent } from '@novai/core'

import { useProjectStore } from '../../stores/project'
import PanelHeader from './PanelHeader.vue'
import AppIcon from '../ui/AppIcon.vue'
import {
  buildPendingReplaceSegments,
  type TextHighlightSegment,
} from '../../composables/useChangeHighlights'
import { getFileDraftEntry, type DraftEntry } from '../../composables/useFileDrafts'
import {
  getEditorSession,
  requestEditorSave,
  settleEditorSave,
} from '../../composables/editor-session'
import { buildLineDiffRows, countLineDiff } from '../../utils/text-diff'
import { applyEditCandidate, resolveConfirmDraftBranch, type ConfirmDraftBranch } from '../../utils/confirm-draft'
import { suggestCopyPath } from '../../utils/file-tree'
import { applyDraftAfterSave, resolveDraftAfterSave } from '../../utils/save-outcome'

/**
 * 内容写入确认面板（交互优化计划 §8 + 数据安全计划 §3-5）：新建与正文编辑确认
 * 从聊天黄色双块卡迁入现有右侧内容面板——全文只读展示局部红绿差异（绿 = 候选
 * 新内容，红 = 将被替换的原文，均未写盘），底部固定「同意写入 / 拒绝」。聊天区
 * 只留「等待审阅」标记与返回入口；离开（关闭面板）不取消请求。
 *
 * 人工草稿接入（§3-5 五分支 / §五.4 统一保存会话）：按「磁盘版本」与「人工
 * 草稿」两条信息分别判断——
 * - 无草稿：保留现有候选差异与版本复检，可直接同意；
 * - 有草稿（磁盘未变/已变）：默认并列展示「人工草稿 × AI 候选写盘结果」，阻止
 *   直接同意——磁盘写入不会自动保存人工草稿；先「保存草稿后重审」（统一保存
 *   会话立即收口，磁盘已变时进版本比较、不强写）或「另存副本后放弃当前内容」
 *   （副本只存操作开始时快照、二次确认）再重新校验；磁盘已变时额外说明三方关系；
 * - 磁盘读取失败与文件不存在分开提示；无法确认安全时默认不能同意。
 *
 * 版本复检（§8「确认前重新校验版本」）：面板打开与点击「同意写入」时各读一次磁盘，
 * 候选原文消失 / 文件被外部修改 / create 目标已被占用时暂停并展示失配原因，由用户
 * 决定重新校验、仍要同意（以真实工具结果为准——EditFile 自身的旧文匹配闸仍然生效）
 * 或拒绝。同意/拒绝只唤醒 Agent Loop，真实写盘由工具执行（服务层不把本地点击当成
 * 已执行）。「仍要同意」不绕过草稿冲突，也不绕过工具自身的原文匹配与版本保护。
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

/**
 * 追加式账本确认（create 候选指向 relations.json / timeline.json）：账本是
 * 读改写的追加式 JSON，目标存在是常态而非占用冲突——工具执行走各自服务层的
 * 版本校验，不会覆盖既有条目，面板不按「新建不覆盖」规则阻止。
 */
const APPEND_LEDGER_PATHS = [RELATION_LEDGER_PATH, TIMELINE_LEDGER_PATH] as const
const isAppendLedger = computed(() => APPEND_LEDGER_PATHS.some((path) => candidate.value?.path.startsWith(path) ?? false))

/** 目标文件当前磁盘内容（create 时探测占用；读不到为 null） */
const diskFile = ref<{ content: string; hash: string } | null>(null)
/** 磁盘读取失败原因（与「文件不存在」分开提示，§3-5） */
const diskUnreadableMessage = ref('')
const loadingDisk = ref(false)
/** 版本失配状态：idle 正常；changed = 文件被外部修改但候选原文仍在；missing = 候选原文已不存在 / 目标已被占用 */
const staleState = ref<'idle' | 'changed' | 'missing'>('idle')
/** 防重复提交（§8 每个请求独立锁定提交） */
const deciding = ref(false)

/** 目标路径的人工草稿条目（§3-5 草稿维度） */
const draftEntry = ref<DraftEntry | null>(null)
/** 草稿分支（none/clean/diverged/unreadable/missing；判定见 utils/confirm-draft） */
const draftBranch = ref<ConfirmDraftBranch>('none')
/** 草稿处理动作（保存/副本）在途与失败反馈 */
const draftActionBusy = ref(false)
const draftActionError = ref('')
/** 副本改名输入（目标被占用时展开） */
const copyTarget = ref('')
const copyRenameOpen = ref(false)
/** 副本保存二次确认（§五.4：明确「原文件内容仍未写完」后才执行） */
const copySaveConfirmed = ref(false)
const copySavedNotice = ref('')

const canDirectConfirm = computed(() => draftBranch.value === 'none')

const projectId = computed(() => projectStore.currentProject?.id ?? null)

/** 有草稿时并列展示「人工草稿 × AI 候选写盘结果」的行级差异（红=仅草稿，绿=仅候选结果） */
const draftConflictRows = computed(() => {
  const c = candidate.value
  const entry = draftEntry.value
  const disk = diskFile.value
  if (!c || !entry || !disk) {
    return null
  }
  const applied = applyEditCandidate(disk.content, c)
  return buildLineDiffRows(entry.content, applied)
})

/** 磁盘已变时的三方关系说明（人工基线 × 当前磁盘差异统计） */
const baselineDrift = computed(() => {
  const entry = draftEntry.value
  const disk = diskFile.value
  if (!entry || !disk || draftBranch.value !== 'draft-diverged') {
    return null
  }
  return countLineDiff(entry.baseContent, disk.content)
})

/** 预览切分段：edit 在磁盘内容上定位候选原文；create 整篇候选内容绿显 */
const segments = computed<TextHighlightSegment[] | null>(() => {
  const c = candidate.value
  if (!c) return null
  if (c.kind === 'create') {
    return c.content === '' ? [] : [{ kind: 'green' as const, text: c.content }]
  }
  if (isAppendLedger.value) {
    // 账本（关系/时间线）的更新确认：oldText 是展示用占位符，磁盘里定位不到也不该定位——
    // 直接展示要改的字段（绿），否则会落到「目标文件不可读」兜底文案误导作者
    const itemLabel = c.path.startsWith(TIMELINE_LEDGER_PATH) ? '事件' : '关系'
    return [
      { kind: 'plain' as const, text: `将修改这条${itemLabel}的以下字段（实际差异以执行结果为准）：\n` },
      { kind: 'green' as const, text: c.newText },
    ]
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

/** 探测代次（F6 验收3）：确认甲尚未读完时切到确认乙/另一项目，甲的读取结果不进入乙的预览 */
let probeGeneration = 0

async function loadDisk() {
  const c = candidate.value
  const projectIdNow = projectId.value
  if (!c || !projectIdNow) return
  const confirmationId = props.confirmation.id
  const path = c.path
  const generation = ++probeGeneration
  loadingDisk.value = true
  diskUnreadableMessage.value = ''
  draftActionError.value = ''
  try {
    draftEntry.value = getFileDraftEntry(projectIdNow, c.path) ?? null
    const probe = await projectStore.probeFile(c.path, projectIdNow)
    // 读取期间已切到别的确认/项目：本次结果过期，直接丢弃
    if (
      generation !== probeGeneration
      || projectId.value !== projectIdNow
      || props.confirmation.id !== confirmationId
      || candidate.value?.path !== path
    ) {
      return
    }
    if (probe.kind === 'ok') {
      const file = probe.file
      diskFile.value = { content: file.content, hash: hashContent(file.content) }
    } else {
      diskFile.value = null
      if (probe.kind === 'unreadable') {
        diskUnreadableMessage.value = probe.message
      }
    }
    // 原样传探测结果，create 语义统一在 resolveConfirmDraftBranch 判定：目标不存在 =
    // 正常空目标；目标存在 = 被占用（追加式账本除外，磁盘真实内容仍进上方预览）。
    // 旧实现把 create+missing 映射成 { ok, '' }，又被判定为「ok + create = 占用」，
    // 新建不存在的文件时同意按钮死锁。
    draftBranch.value = resolveConfirmDraftBranch({
      probe: probe.kind === 'ok' ? { kind: 'ok', content: probe.file.content } : { kind: probe.kind },
      draftEntry: draftEntry.value,
      isCreate: isCreate.value,
      createAppendLedger: isAppendLedger.value,
    })
    // 版本失配（审阅期间外部修改/候选原文消失）：与草稿维度并列判断
    if (probe.kind === 'ok' && c.kind === 'edit') {
      // 账本（关系/时间线）的更新/删除确认：候选原文是展示用占位符，磁盘包含性检查不适用
      // （版本一致性由工具执行期的账本内容哈希校验兜底）
      staleState.value = isAppendLedger.value || probe.file.content.includes(c.oldText) ? 'idle' : 'missing'
    } else if (probe.kind === 'ok' && c.kind === 'create') {
      // create 探测到内容 = 目标被占用；追加式账本确认除外（目标存在是常态）
      staleState.value = isAppendLedger.value ? 'idle' : 'missing'
    } else {
      staleState.value = 'idle' // missing/unreadable 由草稿分支横幅独立提示
    }
  } finally {
    loadingDisk.value = false
  }
}

watch(
  () => [props.confirmation.id, projectId.value, candidate.value?.path] as const,
  () => {
    staleState.value = 'idle'
    draftBranch.value = 'none'
    draftEntry.value = null
    copySavedNotice.value = ''
    copyRenameOpen.value = false
    copySaveConfirmed.value = false
    copyTarget.value = ''
    void loadDisk()
  },
  { immediate: true },
)

/**
 * 「保存人工草稿后重审」（§五.4 统一保存会话）：走编辑会话的立即收口（用户
 * 主动触发），磁盘已变化时撞版本校验进入正文版本比较——绝不绕过校验强写。
 * 保存成功草稿随之清除、重新校验；进入冲突/守护/失败时提示先在正文面板处理。
 */
async function handleSaveDraft() {
  const c = candidate.value
  const entry = draftEntry.value
  const targetProjectId = projectId.value
  if (!c || !entry || !targetProjectId || draftActionBusy.value) return
  const confirmationId = props.confirmation.id
  draftActionBusy.value = true
  draftActionError.value = ''
  try {
    await requestEditorSave(targetProjectId, c.path, { trigger: 'manual' })
    // 保存归属固定于发起时的项目与确认；跨项目返回不得触碰新现场
    if (props.confirmation.id !== confirmationId || projectId.value !== targetProjectId) {
      return
    }
    const session = getEditorSession(targetProjectId, c.path)
    if (session?.guard) {
      draftActionError.value = '文件已被删除或重命名：请先在正文面板选择草稿去向，再回来审阅。'
      return
    }
    if (session?.conflict) {
      draftActionError.value = '磁盘正文已被修改，已进入两个版本比较：请先在正文面板完成版本选择，再回来重新审阅。'
      return
    }
    if (session?.failure) {
      draftActionError.value = session.failure.message
      return
    }
    copySavedNotice.value = ''
    await loadDisk()
  } finally {
    draftActionBusy.value = false
  }
}

/**
 * 「另存副本后放弃当前内容」（§五.4）：草稿以新建文件语义另存副本（不覆盖任何
 * 已有文件，占用时要求改名），需二次确认（原文件内容仍未写完）。副本只保存
 * 操作开始时的快照，成功后只清除这份快照——等待期间新增输入保留并进入重审，
 * 不能被一并删除。
 */
async function handleKeepCopyDraft() {
  const c = candidate.value
  const entry = draftEntry.value
  const targetProjectId = projectId.value
  if (!c || !entry || !targetProjectId || draftActionBusy.value) return
  if (!copyTarget.value.trim()) {
    draftActionError.value = '请填写副本文件名'
    return
  }
  if (!copySaveConfirmed.value) {
    // 二次确认：明确告知原文件内容仍未写完
    copySaveConfirmed.value = true
    return
  }
  draftActionBusy.value = true
  draftActionError.value = ''
  const confirmationId = props.confirmation.id
  const snapshot = entry.content
  try {
    const outcome = await projectStore.createFileCopy(copyTarget.value.trim(), snapshot, { projectId: targetProjectId })
    if (props.confirmation.id !== confirmationId || projectId.value !== targetProjectId) {
      // 已切确认：副本按新建语义照常存在，反馈不污染新确认
      return
    }
    if (!outcome.ok) {
      copySaveConfirmed.value = false
      draftActionError.value = outcome.exists ? `「${copyTarget.value.trim()}」已存在，请换个名字` : outcome.message
      return
    }
    copySavedNotice.value = `已另存副本：${copyTarget.value.trim()}（原文件正文仍未写完，可重新审阅）`
    // 只清本次落盘快照：等待期间若草稿已更新，保留更新并按副本内容重定基线
    applyDraftAfterSave(
      targetProjectId,
      c.path,
      resolveDraftAfterSave(getFileDraftEntry(targetProjectId, c.path)?.content, snapshot),
    )
    copySaveConfirmed.value = false
    copyRenameOpen.value = false
    await loadDisk()
    await projectStore.refreshTree()
  } finally {
    draftActionBusy.value = false
  }
}

function openCopyRename() {
  const c = candidate.value
  if (!c) return
  copyTarget.value = suggestCopyPath(projectStore.currentProject?.files ?? [], c.path)
  copyRenameOpen.value = true
  copySaveConfirmed.value = false
  draftActionError.value = ''
}

/**
 * 同意写入：先做确认前版本复检（§8），失配则暂停展示原因，由用户决定；
 * 版本相符才唤醒 Agent Loop 交给工具真实执行。有人工草稿时不得直接同意
 * （§3-5 阻止危险同意——「仍要同意」同样不绕过草稿冲突）。
 */
async function handleConfirm() {
  const c = candidate.value
  const targetProjectId = projectId.value
  if (!c || !targetProjectId || deciding.value) return
  // 「文件不存在」横幅内的「仍要同意」也走本复检（不直接 emit）：有人工草稿或
  // 磁盘不可读时仍不能同意；missing 分支放行由下方 fresh 复核决定。
  if (!canDirectConfirm.value && draftBranch.value !== 'missing') return
  const confirmationId = props.confirmation.id
  const path = c.path
  deciding.value = true
  try {
    // 自动保存可能恰好在审阅期间落盘（§五.4）：先等在途写盘出结果，
    // 复检结论基于最新磁盘与最新未落盘内容，不拿在途瞬间的旧状态判定。
    await settleEditorSave(targetProjectId, path)
    if (
      props.confirmation.id !== confirmationId
      || projectId.value !== targetProjectId
    ) {
      return
    }
    // 正文版本冲突/守护未解决前，AI 候选保持等待（§五.4 不两套面板各自强写）
    const session = getEditorSession(targetProjectId, path)
    if (session?.conflict) {
      draftActionError.value = '此文件有两个版本尚未处理：请先在正文面板完成版本选择，再回来同意。'
      await loadDisk()
      return
    }
    if (session?.guard) {
      draftActionError.value = '文件已被删除或重命名：请先在正文面板选择草稿去向，再回来同意。'
      await loadDisk()
      return
    }
    const fresh = await projectStore.probeFile(c.path, targetProjectId)
    // 复检期间切确认/项目/目标路径：旧结果不进入新现场确认或触发同意。
    if (
      props.confirmation.id !== confirmationId
      || candidate.value?.path !== path
      || projectId.value !== targetProjectId
    ) {
      return
    }
    // 草稿表是运行期权威：归属核对后再读一次，不能凭初始快照绕过后来出现的草稿。
    const freshDraftEntry = getFileDraftEntry(targetProjectId, c.path) ?? null
    draftEntry.value = freshDraftEntry
    if (fresh.kind === 'unreadable') {
      diskUnreadableMessage.value = fresh.message
      draftBranch.value = 'unreadable'
      return
    }
    if (fresh.kind === 'missing') {
      if (c.kind === 'create' && isAppendLedger.value) {
        // 追加式账本确认：账本尚不存在 = 首条条目落账（工具负责建账本），正常放行
        emit('confirm')
        return
      }
      if (c.kind === 'create') {
        // 新建目标不存在是正常前提。有人工草稿仍先处理草稿；此前因目标被占用
        // 而暂停、复检时已释放的，回到正常新建确认重审，不直接写入。
        if (freshDraftEntry) {
          draftBranch.value = resolveConfirmDraftBranch({ probe: { kind: 'missing' }, draftEntry: freshDraftEntry, isCreate: true })
          diskFile.value = null
          staleState.value = 'idle'
          return
        }
        if (draftBranch.value === 'missing' || diskFile.value !== null) {
          draftBranch.value = 'none'
          diskFile.value = null
          staleState.value = 'idle'
          return
        }
        emit('confirm')
        return
      }
      if (draftBranch.value === 'missing' && diskFile.value === null && !freshDraftEntry) {
        // 编辑目标在初次复检和本次明确「仍要同意」时均不存在，交给工具真实执行。
        emit('confirm')
        return
      }
      if (draftBranch.value === 'missing' && diskFile.value !== null && freshDraftEntry) {
        draftBranch.value = freshDraftEntry.baseContent === diskFile.value.content ? 'draft-clean' : 'draft-diverged'
      } else {
        draftBranch.value = 'missing'
      }
      staleState.value = 'missing'
      return
    }
    if (c.kind === 'create') {
      diskFile.value = { content: fresh.file.content, hash: hashContent(fresh.file.content) }
      if (isAppendLedger.value) {
        // 追加式账本确认：复检只刷新磁盘预览，目标存在不构成「新建被占用」
        emit('confirm')
        return
      }
      staleState.value = 'missing'
      draftBranch.value = 'missing'
      return
    }
    if (freshDraftEntry) {
      // 无论初次审阅还是「仍要同意」，最新人工草稿都必须先处理。
      draftBranch.value = freshDraftEntry.baseContent === fresh.file.content ? 'draft-clean' : 'draft-diverged'
      diskFile.value = { content: fresh.file.content, hash: hashContent(fresh.file.content) }
      staleState.value = isAppendLedger.value || fresh.file.content.includes(c.oldText) ? 'idle' : 'missing'
      return
    }
    if (draftBranch.value === 'missing' && diskFile.value === null) {
      // 已明确点击「文件不存在→仍要同意」，但复检时文件已恢复：按最新版本重新审阅。
      diskFile.value = { content: fresh.file.content, hash: hashContent(fresh.file.content) }
      draftBranch.value = 'none'
      staleState.value = isAppendLedger.value || fresh.file.content.includes(c.oldText) ? 'idle' : 'missing'
      return
    }
    if (c.kind === 'edit') {
      if (isAppendLedger.value) {
        // 账本（关系/时间线）更新/删除确认：候选原文是展示用占位符，包含性/中途变更检查不适用——
        // 复检磁盘可读即放行，版本一致性由工具执行期的账本内容哈希校验兜底
        diskFile.value = { content: fresh.file.content, hash: hashContent(fresh.file.content) }
        emit('confirm')
        return
      }
      if (!fresh.file.content.includes(c.oldText)) {
        staleState.value = 'missing'
        return
      }
      if (hashContent(fresh.file.content) !== diskFile.value?.hash) {
        staleState.value = 'changed'
        diskFile.value = { content: fresh.file.content, hash: hashContent(fresh.file.content) }
        return
      }
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

    <!-- 人工草稿分支横幅（§3-5）：有草稿阻止直接同意，先处理草稿再重审 -->
    <div
      v-if="draftBranch === 'draft-clean' || draftBranch === 'draft-diverged'"
      class="flex shrink-0 flex-col gap-2 border-b border-amber-200 bg-amber-50/80 px-4 py-2.5"
      role="alert"
    >
      <div class="flex items-start gap-1.5 text-xs text-amber-800">
        <AppIcon name="triangle-alert" :size="14" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
        <div class="min-w-0 flex-1 leading-5">
          <p class="font-medium">这个文件有你尚未写入正文的内容</p>
          <p v-if="draftBranch === 'draft-clean'">
            同意写入只改磁盘正文，不会自动保存你的内容；自动保存随后会落盘（或点下方立即收口），
            落盘后重新校验即可同意。
          </p>
          <p v-else>
            磁盘正文在你编辑之后已被修改（AI 或外部）。三方关系：你的草稿基于较早的磁盘版本
            <span v-if="baselineDrift">（与当前磁盘相差 {{ baselineDrift.onlyLeft + baselineDrift.onlyRight }} 行）</span>，
            当前磁盘即将被写入 AI 候选。禁止直接同意——先处理草稿，再重新校验。
          </p>
        </div>
      </div>
      <p v-if="draftActionError" class="pl-5 text-xs text-red-600">{{ draftActionError }}</p>
      <p v-if="copySavedNotice" class="pl-5 text-xs text-green-700">{{ copySavedNotice }}</p>
      <div v-if="draftEntry" class="flex flex-wrap items-center gap-2 pl-5">
        <button
          type="button"
          class="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-40"
          :disabled="draftActionBusy"
          @click="handleSaveDraft"
        >
          {{ draftActionBusy ? '处理中…' : '保存草稿后重审' }}
        </button>
        <button
          v-if="!copyRenameOpen"
          type="button"
          class="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
          @click="openCopyRename"
        >
          另存副本后放弃当前内容
        </button>
        <template v-if="copyRenameOpen">
          <input
            v-model="copyTarget"
            type="text"
            class="min-w-0 flex-1 rounded-md border border-amber-300 bg-white px-2 py-1 font-mono text-xs text-gray-800 focus:border-amber-500 focus:outline-none"
            placeholder="副本文件路径"
          >
          <button
            type="button"
            class="shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-white transition-colors disabled:opacity-40"
            :class="copySaveConfirmed ? 'bg-red-600 hover:bg-red-500' : 'bg-amber-600 hover:bg-amber-500'"
            :disabled="draftActionBusy || !copyTarget.trim()"
            @click="handleKeepCopyDraft"
          >
            {{ copySaveConfirmed ? '确认另存（原文件内容仍未写完）' : '保存副本' }}
          </button>
          <button
            type="button"
            class="shrink-0 rounded-md px-1.5 py-1 text-xs text-amber-700 hover:underline"
            @click="copyRenameOpen = false; draftActionError = ''"
          >
            取消
          </button>
        </template>
      </div>
    </div>

    <!-- 磁盘读取失败（§3-5 与文件不存在分开提示）：无法确认安全，默认不能同意 -->
    <div
      v-if="draftBranch === 'unreadable'"
      class="flex shrink-0 items-start gap-1.5 border-b border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700"
      role="alert"
    >
      <AppIcon name="triangle-alert" :size="14" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
      <div class="min-w-0 flex-1 leading-5">
        <p class="font-medium">磁盘读取失败：{{ diskUnreadableMessage || '未知原因' }}</p>
        <p>无法确认写入是否安全，默认不能同意。可重新校验，或拒绝此请求。</p>
      </div>
      <button
        type="button"
        class="shrink-0 rounded border border-red-300 bg-white px-2 py-0.5 font-medium text-red-700 hover:bg-red-100"
        @click="loadDisk"
      >重新校验</button>
    </div>

    <!-- 文件不存在（与读取失败分开）：沿用版本失配出口 -->
    <div
      v-if="draftBranch === 'missing'"
      class="flex shrink-0 items-start gap-1.5 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800"
      role="alert"
    >
      <AppIcon name="triangle-alert" :size="14" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
      <div class="min-w-0 flex-1 leading-5">
        <p>{{ isCreate ? '目标文件已存在，无法按「新建」写入。' : '目标文件在磁盘上已不存在。' }}</p>
        <p v-if="isCreate">可拒绝此请求，或等待目标路径释放后重新校验；新建操作不会覆盖已有文件。</p>
        <p v-else>可拒绝此请求，或仍要同意（以真实工具结果为准，工具会自行报错或按实际情况执行）。</p>
      </div>
      <div class="flex shrink-0 gap-2">
        <button
          type="button"
          class="rounded border border-amber-300 bg-white px-2 py-0.5 font-medium text-amber-800 hover:bg-amber-100"
          @click="loadDisk"
        >重新校验</button>
        <button
          v-if="!isCreate"
          type="button"
          class="rounded px-2 py-0.5 font-medium text-amber-800 underline-offset-2 hover:underline"
          @click="handleConfirm"
        >仍要同意（以工具结果为准）</button>
      </div>
    </div>

    <!-- 版本失配提示（§8「失配则暂停并展示新版本与候选差异」）：不自动决定，给出出口。
         有草稿分支时「仍要同意」隐藏（§3-5 不绕过草稿冲突） -->
    <div
      v-if="staleState !== 'idle' && draftBranch === 'none'"
      class="flex shrink-0 items-start gap-1.5 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800"
      role="alert"
    >
      <AppIcon name="triangle-alert" :size="14" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
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
            @click="handleConfirm"
          >仍要同意（以工具结果为准）</button>
        </div>
      </div>
    </div>

    <!-- 全文只读预览：有草稿时并列「人工草稿 × AI 候选写盘结果」（§3-5）；
         无草稿保持「绿 = 候选新内容，红 = 将被替换的原文」（均未写盘） -->
    <div class="relative min-h-0 flex-1 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-4 mx-4 my-3">
      <div v-if="loadingDisk" class="py-8 text-center text-xs text-gray-400">正在读取目标文件…</div>

      <!-- 有草稿：两栏并列对比（红=仅人工草稿，绿=仅 AI 候选结果） -->
      <template v-else-if="draftConflictRows && (draftBranch === 'draft-clean' || draftBranch === 'draft-diverged')">
        <div class="grid grid-cols-2 gap-2 overflow-hidden" :style="{ maxHeight: '100%' }">
          <div class="flex flex-col rounded border border-gray-200 bg-white">
            <p class="border-b border-gray-100 bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-600">人工草稿（未保存）</p>
            <div class="overflow-y-auto p-2">
              <div
                v-for="(row, index) in draftConflictRows"
                :key="`l${index}`"
                class="whitespace-pre-wrap text-xs leading-5"
                :class="row.kind === 'left' ? 'confirm-draft-red' : 'text-gray-400'"
              >{{ row.kind === 'right' ? '' : row.text }}&nbsp;</div>
            </div>
          </div>
          <div class="flex flex-col rounded border border-gray-200 bg-white">
            <p class="border-b border-gray-100 bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-600">AI 写入后的结果（未写盘）</p>
            <div class="overflow-y-auto p-2">
              <div
                v-for="(row, index) in draftConflictRows"
                :key="`r${index}`"
                class="whitespace-pre-wrap text-xs leading-5"
                :class="row.kind === 'right' ? 'confirm-hl-green' : 'text-gray-400'"
              >{{ row.kind === 'left' ? '' : row.text }}&nbsp;</div>
            </div>
          </div>
        </div>
      </template>

      <!-- 无草稿：现有候选差异预览 -->
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

    <!-- 底部固定操作（§8）：同意写入 / 拒绝；有人工草稿时同意被阻止（§3-5） -->
    <div class="flex shrink-0 items-center justify-between gap-3 border-t border-gray-200 px-4 py-3">
      <p class="min-w-0 text-[11px] leading-4 text-gray-400">
        {{ canDirectConfirm
          ? '拒绝不写入；同意后由 Agent 真实执行写盘，结果以工具返回为准。'
          : '目标文件有你的未保存草稿（或磁盘不可读）：先处理上方草稿分支，才能同意写入。' }}
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
          :disabled="staleState !== 'idle' || deciding || loadingDisk || !canDirectConfirm"
          :title="canDirectConfirm ? undefined : '先处理人工草稿（或等待磁盘可读）才能同意'"
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

/* 草稿×候选两栏对比中的「仅人工草稿」行：是保留内容而非被替换文本，不加删除线 */
.confirm-draft-red {
  background-color: rgb(254 202 202 / 0.7);
  border-radius: 2px;
  color: rgb(153 27 27);
}
</style>
