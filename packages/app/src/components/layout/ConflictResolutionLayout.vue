<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * 冲突处理布局（六个模块右侧详情布局统一计划 阶段 1）：展开比较的统一结构——
 * 冲突说明区、探测／缺失／不可读状态区、内容比较区、副本表单区与四个出口的
 * 相对位置、间距及有损采用的两击确认。文件（整份正文比较）与卡片（字段比较）
 * 只通过插槽与文案注入差异；计算差异、执行采用或创建副本仍由调用方负责。
 *
 * 界面状态（两击确认、副本名输入）由本组件持有；切换对象或收起冲突时随
 * scopeKey 变化清理。副本表单开合受控于 copyOpen（失败保持打开、成功由调用
 * 方关闭的文件语义需要外部控制）。
 */
const props = withDefaults(
  defineProps<{
    /** 折叠态／确认态作用域（路径+冲突代次 / 卡片id+展开态）：变化即清理 */
    scopeKey: string
    /** 正在读取磁盘版本（读取在途不能退出冲突态，也不提供有损采用） */
    probing?: boolean
    /** 磁盘版本已不存在 */
    missing?: boolean
    /** 磁盘读取失败原因（null = 读取成功） */
    unreadable?: string | null
    /** 副本表单（受控开合；空名禁用提交） */
    copyOpen?: boolean
    /** 打开表单时的默认副本名 */
    defaultCopyName?: string
    /** 副本名输入提示（文件：副本文件路径；卡片：新卡片名称） */
    copyPlaceholder?: string
    /** 打开表单按钮文案 */
    copyOpenLabel?: string
    /** 提交按钮文案 */
    copySubmitLabel?: string
    /** 提交进行中文案（空值不切换） */
    copyBusyLabel?: string
    /** 副本保存进行中（禁用提交与「采用我的」） */
    copyBusy?: boolean
    /** 副本保存错误（表单上方红字；空值不渲染） */
    copyError?: string
    /** 副本已保存提示（表单上方绿字；空值不渲染） */
    copySavedNote?: string
    /** 表单下方说明 */
    copyHint?: string
    /** 副本名输入附加样式（文件路径表单传 font-mono） */
    copyInputClass?: string
    /** 返回按钮文案 */
    backLabel?: string
    /** 两种有损采用（第一击确认、第二击执行）文案 */
    adoptDiskLabel?: string
    adoptDiskConfirmLabel?: string
    adoptMineLabel?: string
    adoptMineConfirmLabel?: string
  }>(),
  {
    probing: false,
    missing: false,
    unreadable: null,
    copyOpen: false,
    defaultCopyName: '',
    copyPlaceholder: '副本名称',
    copyOpenLabel: '另存为副本',
    copySubmitLabel: '保存副本',
    copyBusyLabel: '保存中…',
    copyBusy: false,
    copyError: '',
    copySavedNote: '',
    copyHint: '',
    copyInputClass: '',
    backLabel: '返回继续编辑',
    adoptDiskLabel: '采用磁盘版本',
    adoptDiskConfirmLabel: '确认放弃我的修改，采用磁盘版本',
    adoptMineLabel: '采用我的内容',
    adoptMineConfirmLabel: '确认覆盖磁盘，采用我的内容',
  },
)

const emit = defineEmits<{
  back: []
  /** 请求打开副本表单（调用方准备默认名后置 copyOpen=true） */
  openCopy: []
  closeCopy: []
  /** 副本名非空时提交 */
  submitCopy: [name: string]
  /** 有损采用（已两击确认） */
  adoptDisk: []
  adoptMine: []
}>()

/** 有损采用的两击确认步（disk/mine；scopeKey 变化或返回时清残留） */
const confirmAdopt = ref<'disk' | 'mine' | null>(null)

/** 副本名（打开表单时回填默认名；提交后由调用方决定关闭与否） */
const copyName = ref('')

watch(
  () => props.scopeKey,
  () => {
    confirmAdopt.value = null
  },
)

watch(
  () => props.copyOpen,
  (open) => {
    if (open) {
      copyName.value = props.defaultCopyName
    }
  },
  { immediate: true },
)

function onAdopt(kind: 'disk' | 'mine') {
  if (confirmAdopt.value !== kind) {
    confirmAdopt.value = kind
    return
  }
  confirmAdopt.value = null
  if (kind === 'disk') {
    emit('adoptDisk')
  } else {
    emit('adoptMine')
  }
}

function onBack() {
  confirmAdopt.value = null
  emit('back')
}

function submitCopy() {
  const name = copyName.value.trim()
  if (!name || props.copyBusy) {
    return
  }
  emit('submitCopy', name)
}
</script>

<template>
  <div
    class="flex min-h-0 flex-1 flex-col gap-3 rounded-lg border border-red-200 bg-white p-3"
    role="alert"
    data-testid="detail-conflict-resolution"
  >
    <!-- 冲突说明区：领域注入（红绿语义、路径等） -->
    <div class="shrink-0">
      <slot name="header" />
    </div>

    <!-- 读取在途 / 磁盘缺失 / 读取失败：位置与容器统一，文案由领域注入或用默认 -->
    <div v-if="probing" class="shrink-0 rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-500">
      <slot name="probing">正在检查另一版本…</slot>
    </div>
    <div v-else-if="missing" class="shrink-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <slot name="missing">目标在磁盘上已不存在。你的修改仍完整保留，可另存为副本后再处理。</slot>
    </div>
    <div v-else-if="unreadable" class="shrink-0 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      <slot name="unreadable">磁盘读取失败：{{ unreadable }}。读取成功前不能采用磁盘版本。</slot>
    </div>

    <!-- 内容比较区：文件为整份正文差异块，卡片为短字段并排 + 长字段差异块 -->
    <div v-else class="min-h-0 flex-1 overflow-y-auto rounded-md border border-gray-200 bg-white p-2">
      <slot name="compare" />
    </div>

    <p v-if="copyError" class="shrink-0 text-xs text-red-600" data-testid="detail-conflict-copy-error">{{ copyError }}</p>
    <p v-if="copySavedNote" class="shrink-0 text-xs text-green-700" data-testid="detail-conflict-copy-saved">{{ copySavedNote }}</p>

    <!-- 副本表单（受控开合；空名禁用提交） -->
    <div v-if="copyOpen" class="flex shrink-0 flex-col gap-1.5" data-testid="detail-conflict-copy-form">
      <div class="flex items-center gap-2">
        <input
          v-model="copyName"
          type="text"
          class="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 focus:border-blue-500 focus:outline-none"
          :class="copyInputClass"
          :placeholder="copyPlaceholder"
        >
        <button
          type="button"
          class="shrink-0 rounded-md bg-gray-900 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
          :disabled="copyBusy || !copyName.trim()"
          @click="submitCopy"
        >
          {{ copyBusy ? copyBusyLabel : copySubmitLabel }}
        </button>
        <button
          type="button"
          class="shrink-0 rounded-md px-1.5 py-1 text-xs text-gray-500 hover:underline"
          @click="emit('closeCopy')"
        >
          取消
        </button>
      </div>
      <p v-if="copyHint" class="text-[11px] text-gray-400">{{ copyHint }}</p>
    </div>

    <!-- 四个出口：返回 / 另存副本 / 两种需二次确认的有损采用 -->
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-t border-gray-100 pt-2">
      <button
        type="button"
        class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
        @click="onBack"
      >
        {{ backLabel }}
      </button>
      <button
        v-if="!copyOpen"
        type="button"
        class="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
        @click="emit('openCopy')"
      >
        {{ copyOpenLabel }}
      </button>
      <template v-if="!missing && !unreadable && !probing">
        <span class="min-w-0 flex-1" />
        <button
          type="button"
          class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
          :class="confirmAdopt === 'disk'
            ? 'bg-red-600 text-white hover:bg-red-500'
            : 'border border-red-200 bg-white text-red-700 hover:bg-red-50'"
          @click="onAdopt('disk')"
        >
          {{ confirmAdopt === 'disk' ? adoptDiskConfirmLabel : adoptDiskLabel }}
        </button>
        <button
          type="button"
          class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40"
          :class="confirmAdopt === 'mine'
            ? 'bg-red-600 text-white hover:bg-red-500'
            : 'border border-red-200 bg-white text-red-700 hover:bg-red-50'"
          :disabled="copyBusy"
          @click="onAdopt('mine')"
        >
          {{ confirmAdopt === 'mine' ? adoptMineConfirmLabel : adoptMineLabel }}
        </button>
      </template>
    </div>
    <p class="shrink-0 text-[11px] leading-4 text-gray-400">
      两种「采用」都是有损选择，需要点两次确认；应用不会替你决定，也不提供自动合并。
    </p>
  </div>
</template>
