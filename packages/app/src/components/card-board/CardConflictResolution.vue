<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { CardConflictField } from '../../stores/card-board'
import ConflictResolutionLayout from '../layout/ConflictResolutionLayout.vue'
import CardConflictCompare from './CardConflictCompare.vue'

/**
 * 卡片冲突处理装配（六个模块右侧详情布局统一计划 阶段 3，卡片展示适配器组成件）：
 * 三类卡片共用的展开比较区——卡片文案的冲突说明与三态文案、字段比较内容、
 * 「另存为新卡片」副本文案与四出口事件。两击确认、副本表单结构由布局层
 * ConflictResolutionLayout 承接；本件只持有卡片副本表单开合（切卡清理），
 * 比较内容引用 CardConflictCompare（折叠随作用域复位）。执行采用、新建副本
 * 仍由领域 store 负责。
 */
const props = defineProps<{
  /** 当前卡片 id（副本表单开合、两击确认随切卡清理） */
  cardId: string
  /** 卡片名（副本默认名引用） */
  titleValue: string
  /** 冲突视图（本组件仅在 expanded 时挂载） */
  conflict: { probing: boolean; missing: boolean; unreadable?: string; expanded: boolean }
  /** 冲突字段比较（store 组合的 mine/disk 展示文本） */
  conflictFields: ReadonlyArray<CardConflictField>
}>()

const emit = defineEmits<{
  /** 展开区「返回继续编辑」：收起比较（冲突保留，再入口持久） */
  collapse: []
  /** 采用磁盘版本（按钮已两击确认）：先读后清，读失败保持展开态 */
  adoptDisk: []
  /** 采用我的当前内容（按钮已两击确认）：最新快照整份覆盖原卡 */
  adoptMine: []
  /** 另存副本：用人工视角完整卡按名称新建（不覆盖原卡、不解冲突） */
  saveCopy: [name: string]
}>()

/** 卡片副本表单开合（卡片无落盘等待：提交即关；切卡清残留） */
const copyOpen = ref(false)

watch(
  () => props.cardId,
  () => {
    copyOpen.value = false
  },
)

/** 两击确认与折叠复位的统一作用域：卡片 id + 展开态 */
const scopeKey = computed(() => `${props.cardId}:${props.conflict.expanded}`)

/** 副本默认名（布局在表单打开时回填；「（副本）」后缀与文件侧一致） */
const defaultCopyName = computed(() => `${props.titleValue}（副本）`)
</script>

<template>
  <ConflictResolutionLayout
    :scope-key="scopeKey"
    :probing="conflict.probing"
    :missing="conflict.missing"
    :unreadable="conflict.unreadable ?? null"
    :copy-open="copyOpen"
    :default-copy-name="defaultCopyName"
    copy-placeholder="新卡片名称"
    copy-open-label="将我的内容另存为新卡片"
    copy-submit-label="保存为新卡片"
    copy-hint="新卡片独立创建，不覆盖任何已有卡片；保存后本冲突仍保留。"
    back-label="返回继续编辑"
    adopt-disk-label="采用磁盘版本"
    adopt-disk-confirm-label="确认放弃我的修改，采用磁盘版本"
    adopt-mine-label="采用我的内容"
    adopt-mine-confirm-label="确认覆盖磁盘，采用我的内容"
    @back="emit('collapse')"
    @open-copy="copyOpen = true"
    @close-copy="copyOpen = false"
    @submit-copy="(name) => { copyOpen = false; emit('saveCopy', name) }"
    @adopt-disk="emit('adoptDisk')"
    @adopt-mine="emit('adoptMine')"
  >
    <template #header>
      <p class="text-sm font-semibold text-gray-800">这张卡片有两个版本：文件已被 AI 或外部编辑器修改</p>
      <p class="mt-1.5 text-xs leading-5 text-gray-600">
        你的修改与磁盘上的新版本都完整保留，查看期间互不覆盖：
        <span class="text-red-600">红色 = 你的当前内容</span>（采用磁盘版本会丢失），
        <span class="text-green-700">绿色 = 磁盘新版本</span>（采用你的内容会替换它）。
      </p>
    </template>

    <template #probing>正在读取磁盘上的新版本…</template>
    <template #missing>
      这张卡片的文件在磁盘上已不存在（可能已被删除）。你的修改仍完整保留，可另存为新卡片后放弃原现场。
    </template>
    <template #unreadable>
      磁盘读取失败：{{ conflict.unreadable }}。你的修改仍完整保留，可返回编辑或另存为新卡片；读取成功前不能采用磁盘版本。
    </template>

    <template #compare>
      <CardConflictCompare :conflict-fields="conflictFields" :fold-scope="scopeKey" />
    </template>
  </ConflictResolutionLayout>
</template>
