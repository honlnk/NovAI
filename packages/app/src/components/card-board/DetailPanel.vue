<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { CardConflictField, CardSessionGuard } from '../../stores/card-board'
import { buildConflictDiff } from '../../utils/conflict-diff'
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
 * 交互约定（阶段 2 无保存心智）：
 * - 头部名称输入 + 预览/编辑两态分段控件；正文区（预览/编辑的具体形态）
 *   由 #content 插槽按 detailMode 注入（计划是 Markdown/textarea，伏笔是
 *   读者视角/作者真相双区）。
 * - 分组按钮：选中态读取已生效列 key（保存成功才切换）；待保存状态用中性底
 *   与点状等待标记（不伪装成已生效），点击只登记待保存状态（两秒后随本卡
 *   整体保存），不立即移动卡片。
 * - 底部信息行与正文编辑器同规格（轻量灰字一行）：左保存状态（已保存/
 *   等待保存/正在保存/保存失败+重试/保存冲突），右更新时间；无删除入口
 *   （删除功能暂停，恢复时在领域面板重新接线）。
 *
 * 冲突与守护（阶段 3，非阻塞）：
 * - 有冲突时列按钮下方常驻紧凑琥珀条（唯一，连续外部修改不堆叠），「比较并
 *   处理」展开整页字段比较：短字段红绿并排，长正文字段单栏差异块（字级高亮、
 *   未改动折叠）；四个出口 = 返回继续编辑 / 另存副本 / 采用磁盘版本（两击
 *   确认）/ 采用我的当前内容（两击确认），有损采用由调用方完成。
 * - 守护（文件被删除/重命名且有待写内容）置顶横幅：恢复为副本（表单）或
 *   放弃并关闭；守护期间名称输入冻结（写入已被引擎拒绝，不伪装可编辑）。
 */
const props = defineProps<{
  /** 当前卡片 id（删除两步确认/两击确认随切卡清残留） */
  cardId: string
  /** 头部名称输入框展示值（卡片名草稿 ?? 卡片名，由调用方组合） */
  titleValue: string
  titlePlaceholder: string
  /** 领域列按钮（顺序即展示顺序）；点击登记待保存状态（节奏卡传空数组） */
  columns: ReadonlyArray<{ key: string; label: string }>
  /** 当前已生效列 key（保存成功后随卡片更新，与看板同源） */
  activeColumnKey: string
  /** 待保存状态列 key（等待标记；null = 无状态修改） */
  pendingColumnKey: string | null
  /** 详情视图态（预览/编辑，随卡片编辑会话恢复） */
  detailMode: DetailMode
  /** 保存状态（clean=已保存 / pending=等待保存 / saving=正在保存 / failed / conflict） */
  savePhase: 'clean' | 'pending' | 'saving' | 'failed' | 'conflict'
  /** 冲突视图（有冲突即非 null；expanded = 已展开整页比较） */
  conflict: { probing: boolean; missing: boolean; unreadable?: string; expanded: boolean } | null
  /** 冲突字段比较（领域 store 组合的 mine/disk 展示文本；无差异字段在这里过滤） */
  conflictFields: ReadonlyArray<CardConflictField>
  /** 守护信息（删除/重命名；null = 无守护） */
  guard: CardSessionGuard | null
  actionError: string
  /** 底部展示的更新时间（空串隐藏） */
  updatedAt: string
  testidPrefix: string
}>()

const emit = defineEmits<{
  close: []
  updateTitle: [title: string]
  setDetailMode: [mode: DetailMode]
  /** 状态按钮点击：登记待保存状态（领域 store 的 updateDraftStatus） */
  selectStatus: [columnKey: string]
  /** 状态条「重试」：手动重试失败写入 */
  retrySave: []
  /** 紧凑条「比较并处理」：重读磁盘并展开整页比较 */
  expandConflict: []
  /** 展开区「返回继续编辑」：收起比较（冲突保留，再入口持久） */
  collapseConflict: []
  /** 采用磁盘版本（按钮已两击确认）：先读后清，读失败保持展开态 */
  adoptDisk: []
  /** 采用我的当前内容（按钮已两击确认）：最新快照整份覆盖原卡 */
  adoptMine: []
  /** 另存副本：用人工视角完整卡按名称新建（不覆盖原卡、不解冲突） */
  saveCopy: [name: string]
  /** 守护出口「恢复为副本」：同 saveCopy 语义，成功后由调用方清理守护会话 */
  restoreAsCopy: [name: string]
  /** 守护出口「放弃并关闭」：丢弃保留的未落盘现场并关闭详情 */
  discardGuard: []
}>()

/** 有损采用的两击确认（disk/mine；收起比较或切卡清残留） */
const confirmAdopt = ref<'disk' | 'mine' | null>(null)

/** 冲突副本表单（目标名；默认带「（副本）」后缀） */
const copyFormOpen = ref(false)
const copyName = ref('')

/** 守护「恢复为副本」表单 */
const guardCopyOpen = ref(false)
const guardCopyName = ref('')

/** 长正文字段的未改动折叠区展开状态（跨字段用字段 key 前缀隔离） */
const expandedFolds = ref(new Set<string>())

watch(
  () => props.cardId,
  () => {
    confirmAdopt.value = null
    copyFormOpen.value = false
    guardCopyOpen.value = false
  },
)

watch(
  () => props.conflict?.expanded,
  () => {
    confirmAdopt.value = null
    expandedFolds.value = new Set()
  },
)

/* ---------- 详情操作 ---------- */

function onTitleInput(event: Event) {
  emit('updateTitle', (event.target as HTMLInputElement).value)
}

/** 保存状态条文案（§六.1 无保存心智：等待保存 / 正在保存 / 已保存；异常单独解释） */
const saveStatusLabel = computed(() => {
  switch (props.savePhase) {
    case 'saving': return '正在保存'
    case 'pending': return '等待保存'
    case 'failed': return '保存失败'
    case 'conflict': return '保存冲突'
    default: return '已保存'
  }
})

/** 待保存状态按钮是否显示等待标记（已生效列不重复标记） */
function isPendingColumn(columnKey: string): boolean {
  return props.pendingColumnKey === columnKey && columnKey !== props.activeColumnKey
}

/** 有差异的短字段（红绿并排）；一致字段折叠为一行统计 */
const changedShortFields = computed(() =>
  props.conflictFields.filter((field) => field.kind === 'short' && field.mine !== field.disk),
)
const unchangedFieldCount = computed(() =>
  props.conflictFields.filter((field) => field.mine === field.disk).length,
)

/** 长正文字段的单栏差异块（复用正文冲突比较：上下文灰显/折叠/红绿对+字级高亮） */
const longFieldDiffs = computed(() => {
  if (!props.conflict?.expanded) {
    return []
  }
  return props.conflictFields
    .filter((field) => field.kind === 'long' && field.mine !== field.disk)
    .map((field) => ({ key: field.key, label: field.label, diff: buildConflictDiff(field.mine, field.disk) }))
})

function toggleFold(fieldKey: string, blockId: number) {
  const id = `${fieldKey}:${blockId}`
  const next = new Set(expandedFolds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  expandedFolds.value = next
}

function isFoldExpanded(fieldKey: string, blockId: number): boolean {
  return expandedFolds.value.has(`${fieldKey}:${blockId}`)
}

function openCopyForm() {
  copyName.value = `${props.titleValue}（副本）`
  copyFormOpen.value = true
}

function submitCopy() {
  const name = copyName.value.trim()
  if (!name) {
    return
  }
  copyFormOpen.value = false
  emit('saveCopy', name)
}

function openGuardCopyForm() {
  guardCopyName.value = `${props.titleValue}（副本）`
  guardCopyOpen.value = true
}

function submitGuardCopy() {
  const name = guardCopyName.value.trim()
  if (!name) {
    return
  }
  emit('restoreAsCopy', name)
}

function onAdoptDisk() {
  if (confirmAdopt.value !== 'disk') {
    confirmAdopt.value = 'disk'
    return
  }
  confirmAdopt.value = null
  emit('adoptDisk')
}

function onAdoptMine() {
  if (confirmAdopt.value !== 'mine') {
    confirmAdopt.value = 'mine'
    return
  }
  confirmAdopt.value = null
  emit('adoptMine')
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
          :readonly="guard !== null"
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

    <!-- 内容区：守护横幅 + 分组列按钮 + 领域字段/正文（内部滚动）+ 底部操作行；
         冲突展开比较时整页替换（列按钮与底部行隐藏） -->
    <div class="flex min-h-0 flex-1 flex-col px-4">
      <!-- 守护横幅（阶段 3）：文件被删/重命名且有待写内容，写入已被引擎拒绝 -->
      <div
        v-if="guard"
        class="my-2 flex shrink-0 flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2.5"
        role="alert"
      >
        <div class="flex items-start gap-2">
          <AppIcon name="triangle-alert" :size="15" class="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div class="min-w-0 flex-1 text-xs leading-5 text-amber-800">
            <template v-if="guard.kind === 'deleted'">
              <p class="font-medium">「{{ titleValue }}」已被删除{{ guard.trashPath ? '并移入回收站' : '' }}</p>
              <p class="text-amber-700">你尚未写入的修改已完整保留，不会被自动丢弃；可恢复为一张新卡片，或放弃。</p>
              <p v-if="guard.trashPath" class="truncate text-[11px] text-amber-600" :title="guard.trashPath">
                原文在回收站：{{ guard.trashPath }}
              </p>
            </template>
            <template v-else>
              <p class="font-medium">「{{ titleValue }}」的文件已被重命名</p>
              <p class="truncate text-[11px] text-amber-600" :title="guard.toPath">新位置：{{ guard.toPath }}</p>
              <p class="text-amber-700">你尚未写入的修改仍完整保留；可恢复为一张新卡片，或放弃。</p>
            </template>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            v-if="!guardCopyOpen"
            type="button"
            class="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-500"
            @click="openGuardCopyForm"
          >
            恢复为新卡片
          </button>
          <button
            type="button"
            class="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
            @click="emit('discardGuard')"
          >
            放弃并关闭
          </button>
        </div>
        <!-- 恢复为副本表单：用领域新建能力落一张新卡（同名由服务层唯一化） -->
        <div v-if="guardCopyOpen" class="flex flex-col gap-1.5">
          <div class="flex items-center gap-2">
            <input
              v-model="guardCopyName"
              type="text"
              class="min-w-0 flex-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs text-gray-800 focus:border-amber-500 focus:outline-none"
              placeholder="新卡片名称"
            >
            <button
              type="button"
              class="shrink-0 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-40"
              :disabled="!guardCopyName.trim()"
              @click="submitGuardCopy"
            >
              保存为新卡片
            </button>
            <button
              type="button"
              class="shrink-0 rounded-md px-1.5 py-1 text-xs text-gray-500 hover:underline"
              @click="guardCopyOpen = false"
            >
              取消
            </button>
          </div>
          <p class="text-[11px] text-gray-400">新卡片是独立创建，不恢复原文件；保存成功后这里的保留现场会关闭。</p>
        </div>
      </div>

      <!-- 冲突展开比较（阶段 3 整页）：字段为比较单位，仅长正文用单栏差异块 -->
      <div
        v-if="conflict?.expanded"
        class="flex min-h-0 flex-1 flex-col gap-3 rounded-lg border border-red-200 bg-white p-3"
        role="alert"
      >
        <div class="shrink-0">
          <p class="text-sm font-semibold text-gray-800">这张卡片有两个版本：文件已被 AI 或外部编辑器修改</p>
          <p class="mt-1.5 text-xs leading-5 text-gray-600">
            你的修改与磁盘上的新版本都完整保留，查看期间互不覆盖：
            <span class="text-red-600">红色 = 你的当前内容</span>（采用磁盘版本会丢失），
            <span class="text-green-700">绿色 = 磁盘新版本</span>（采用你的内容会替换它）。
          </p>
        </div>

        <!-- 正在读取磁盘版本（读取在途不能先退出冲突态） -->
        <div v-if="conflict.probing" class="shrink-0 rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-500">
          正在读取磁盘上的新版本…
        </div>

        <div v-else-if="conflict.missing" class="shrink-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          这张卡片的文件在磁盘上已不存在（可能已被删除）。你的修改仍完整保留，可另存为新卡片后放弃原现场。
        </div>

        <div v-else-if="conflict.unreadable" class="shrink-0 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          磁盘读取失败：{{ conflict.unreadable }}。你的修改仍完整保留，可返回编辑或另存为新卡片；读取成功前不能采用磁盘版本。
        </div>

        <template v-else>
          <!-- 字段比较：短字段红绿并排；无差异字段折叠为一行统计 -->
          <p v-if="changedShortFields.length === 0 && longFieldDiffs.length === 0" class="shrink-0 text-xs text-gray-500">
            两个版本的字段内容一致（可能只有结尾换行等格式差异）。
          </p>
          <p v-if="unchangedFieldCount > 0" class="shrink-0 text-xs text-gray-400">
            其余 {{ unchangedFieldCount }} 个字段两版一致。
          </p>

          <div class="min-h-0 flex-1 overflow-y-auto rounded-md border border-gray-200 bg-white p-2">
            <!-- 短字段：单行红绿并排 -->
            <div
              v-for="field in changedShortFields"
              :key="field.key"
              class="mb-2 flex flex-col gap-0.5 border-b border-gray-100 pb-2 last:border-b-0"
            >
              <p class="px-2 text-[11px] font-medium text-gray-500">{{ field.label }}</p>
              <div class="whitespace-pre-wrap rounded-sm px-2 text-xs leading-5 conflict-para-del">
                我的：{{ field.mine || '（空）' }}
              </div>
              <div class="whitespace-pre-wrap rounded-sm px-2 text-xs leading-5 conflict-para-add">
                磁盘：{{ field.disk || '（空）' }}
              </div>
            </div>

            <!-- 长正文字段：单栏差异块（上下文灰显/折叠可展开/红绿对+字级高亮） -->
            <div v-for="entry in longFieldDiffs" :key="entry.key" class="mb-3 last:mb-0">
              <p class="mb-1 px-2 text-[11px] font-medium text-gray-500">{{ entry.label }}</p>
              <p v-if="entry.diff.degraded" class="px-2 pb-1 text-[11px] text-amber-700">
                两版差异过大，整块对比（红 = 仅你的内容，绿 = 仅磁盘）。
              </p>
              <p v-else class="px-2 pb-1 text-[11px] text-gray-400">
                修改 {{ entry.diff.stats.changed }} 段、新增 {{ entry.diff.stats.added }} 段、删除 {{ entry.diff.stats.removed }} 段。
              </p>
              <template v-for="(block, index) in entry.diff.blocks" :key="index">
                <template v-if="block.kind === 'context'">
                  <div
                    v-for="(line, lineIndex) in block.lines"
                    :key="lineIndex"
                    class="whitespace-pre-wrap px-2 text-xs leading-5 text-gray-400"
                  >{{ line }}&nbsp;</div>
                </template>
                <template v-else-if="block.kind === 'fold'">
                  <div v-if="isFoldExpanded(entry.key, block.id)">
                    <div
                      v-for="(line, lineIndex) in block.lines"
                      :key="lineIndex"
                      class="whitespace-pre-wrap px-2 text-xs leading-5 text-gray-400"
                    >{{ line }}&nbsp;</div>
                    <button
                      type="button"
                      class="my-1 w-full rounded border border-gray-100 bg-gray-50 px-2 py-1 text-[11px] text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                      @click="toggleFold(entry.key, block.id)"
                    >
                      收起 {{ block.count }} 段未改动内容
                    </button>
                  </div>
                  <button
                    v-else
                    type="button"
                    class="my-1 w-full rounded border border-gray-100 bg-gray-50 px-2 py-1 text-[11px] text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                    @click="toggleFold(entry.key, block.id)"
                  >
                    ⋯ 展开 {{ block.count }} 段未改动内容
                  </button>
                </template>
                <div v-else class="my-1 flex flex-col gap-0.5">
                  <div v-for="(pair, pairIndex) in block.pairs" :key="pairIndex" class="flex flex-col gap-0.5">
                    <!-- 原段落（仅我的内容）：红底；有字级变换时只加深实际被替换的字 -->
                    <div v-if="pair.old !== undefined" class="whitespace-pre-wrap rounded-sm px-2 text-xs leading-5 conflict-para-del">
                      <template v-if="pair.inline">
                        <template v-for="(seg, segIndex) in pair.inline" :key="segIndex">
                          <span v-if="seg.kind !== 'add'" :class="seg.kind === 'del' ? 'conflict-inline-del' : ''">{{ seg.text }}</span>
                        </template>
                      </template>
                      <template v-else>{{ pair.old }}</template>
                    </div>
                    <!-- 新段落（仅磁盘）：绿底；有字级变换时只加深实际新增的字 -->
                    <div v-if="pair.new !== undefined" class="whitespace-pre-wrap rounded-sm px-2 text-xs leading-5 conflict-para-add">
                      <template v-if="pair.inline">
                        <template v-for="(seg, segIndex) in pair.inline" :key="segIndex">
                          <span v-if="seg.kind !== 'del'" :class="seg.kind === 'add' ? 'conflict-inline-add' : ''">{{ seg.text }}</span>
                        </template>
                      </template>
                      <template v-else>{{ pair.new }}</template>
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </template>

        <!-- 另存副本表单：领域新建语义，不覆盖原卡、不解决冲突 -->
        <div v-if="copyFormOpen" class="flex shrink-0 flex-col gap-1.5">
          <div class="flex items-center gap-2">
            <input
              v-model="copyName"
              type="text"
              class="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 focus:border-blue-500 focus:outline-none"
              placeholder="新卡片名称"
            >
            <button
              type="button"
              class="shrink-0 rounded-md bg-gray-900 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
              :disabled="!copyName.trim()"
              @click="submitCopy"
            >
              保存为新卡片
            </button>
            <button
              type="button"
              class="shrink-0 rounded-md px-1.5 py-1 text-xs text-gray-500 hover:underline"
              @click="copyFormOpen = false"
            >
              取消
            </button>
          </div>
          <p class="text-[11px] text-gray-400">新卡片独立创建，不覆盖任何已有卡片；保存后本冲突仍保留。</p>
        </div>

        <!-- 四个出口：返回编辑 / 另存副本 / 两种需二次确认的有损采用 -->
        <div class="flex shrink-0 flex-wrap items-center gap-2 border-t border-gray-100 pt-2">
          <button
            type="button"
            class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
            @click="emit('collapseConflict')"
          >
            返回继续编辑
          </button>
          <button
            v-if="!copyFormOpen"
            type="button"
            class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
            @click="openCopyForm"
          >
            将我的内容另存为新卡片
          </button>
          <template v-if="!conflict.missing && !conflict.unreadable && !conflict.probing">
            <span class="min-w-0 flex-1" />
            <button
              type="button"
              class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
              :class="confirmAdopt === 'disk'
                ? 'bg-red-600 text-white hover:bg-red-500'
                : 'border border-red-200 bg-white text-red-700 hover:bg-red-50'"
              @click="onAdoptDisk"
            >
              {{ confirmAdopt === 'disk' ? '确认放弃我的修改，采用磁盘版本' : '采用磁盘版本' }}
            </button>
            <button
              type="button"
              class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
              :class="confirmAdopt === 'mine'
                ? 'bg-red-600 text-white hover:bg-red-500'
                : 'border border-red-200 bg-white text-red-700 hover:bg-red-50'"
              @click="onAdoptMine"
            >
              {{ confirmAdopt === 'mine' ? '确认覆盖磁盘，采用我的内容' : '采用我的内容' }}
            </button>
          </template>
        </div>
        <p class="shrink-0 text-[11px] leading-4 text-gray-400">
          两种「采用」都是有损选择，需要点两次确认；应用不会替你决定，也不提供自动合并。
        </p>
      </div>

      <template v-else>
        <!-- 分组列按钮（头部下方固定区，选中态与看板同源；待保存状态用等待标记；
             守护与冲突展开时隐藏） -->
        <div v-if="!guard" class="flex shrink-0 flex-wrap gap-1.5 pb-2 pt-3">
          <button
            v-for="column in columns"
            :key="column.key"
            :class="[
              'flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors',
              activeColumnKey === column.key
                ? 'bg-gray-900 text-white'
                : isPendingColumn(column.key)
                  ? 'bg-gray-200 text-gray-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
            ]"
            :title="isPendingColumn(column.key) ? '两秒后随本卡片一起保存' : undefined"
            @click="emit('selectStatus', column.key)"
          >
            <span
              v-if="isPendingColumn(column.key)"
              class="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-500"
            />
            {{ column.label }}
          </button>
        </div>

        <!-- 冲突紧凑状态条（非阻塞，唯一）：自动保存冻结，比较再入口持久 -->
        <div
          v-if="conflict"
          class="mb-3 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2"
          role="alert"
        >
          <AppIcon name="triangle-alert" :size="14" class="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <p class="min-w-0 flex-1 text-xs leading-5 text-amber-800">
            这张卡片有两个版本：文件已被 AI 或外部编辑器修改，你尚未写入的修改已保留并暂停自动保存。
          </p>
          <button
            type="button"
            class="shrink-0 rounded-md bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-200"
            :data-testid="`${testidPrefix}-detail-conflict-compare`"
            @click="emit('expandConflict')"
          >
            比较并处理
          </button>
        </div>

        <!-- 正文区：预览/编辑的具体形态由领域注入（双击进入编辑由领域自定） -->
        <slot name="content" :detail-mode="detailMode" :frozen="guard !== null" />

        <p v-if="actionError" class="shrink-0 pt-1 text-xs text-red-600">{{ actionError }}</p>

        <!-- 底部信息行（与正文编辑器的文件信息行同规格）：左保存状态，右更新时间 -->
        <div class="flex shrink-0 items-center justify-between py-3 text-xs text-gray-500">
          <span
            class="flex shrink-0 items-center gap-1"
            :class="{
              'text-gray-400': savePhase === 'clean',
              'text-amber-600': savePhase === 'pending',
              'text-blue-600': savePhase === 'saving',
              'text-amber-700': savePhase === 'conflict',
              'text-red-600': savePhase === 'failed',
            }"
            :data-testid="`${testidPrefix}-detail-save-status`"
          >
            <span
              v-if="savePhase === 'pending'"
              class="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500"
            />
            {{ saveStatusLabel }}
            <button
              v-if="savePhase === 'failed'"
              class="ml-1 rounded-md border border-red-200 bg-white px-2 py-0.5 text-xs text-red-600 transition-colors hover:bg-red-50"
              :data-testid="`${testidPrefix}-detail-retry`"
              @click="emit('retrySave')"
            >
              重试
            </button>
          </span>
          <span v-if="updatedAt" class="shrink-0">
            更新于 {{ formatTime(updatedAt) }}
          </span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 冲突比较（阶段 3，与正文 FilePanelBody 同规格）：段落级底色 + 字级加深。
   红系 = 仅我的内容（原段落），绿系 = 仅磁盘（新段落）；未改动上下文灰显。 */
.conflict-para-del {
  background-color: rgb(254 226 226 / 0.55);
  border-left: 2px solid rgb(248 113 113);
  color: rgb(127 29 29);
}

.conflict-para-add {
  background-color: rgb(220 252 231 / 0.6);
  border-left: 2px solid rgb(74 222 128);
  color: rgb(20 83 45);
}

.conflict-inline-del {
  background-color: rgb(254 178 178 / 0.85);
  border-radius: 2px;
  font-weight: 500;
}

.conflict-inline-add {
  background-color: rgb(134 239 172 / 0.85);
  border-radius: 2px;
  font-weight: 500;
}
</style>
