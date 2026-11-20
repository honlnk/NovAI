<script setup lang="ts">
import { ref, watch } from 'vue'

import type { CardSessionGuard } from '../../stores/card-board'
import GuardBanner from '../layout/GuardBanner.vue'

/**
 * 卡片守护横幅（六个模块右侧详情布局统一计划 阶段 1，卡片展示适配器组成件）：
 * 卡片版守护装配——删除/重命名守护的文案、「恢复为新卡片」名称表单与「放弃并
 * 关闭」出口。横幅结构复用布局层 GuardBanner；副本表单开合是界面状态由本件
 * 持有（守护对象变化即清理），实际创建副本与清理由调用方负责。
 *
 * 「恢复为新卡片」是异步受控流程：提交后表单保持打开，进行中/失败原因由
 * 调用方经 restoreBusy/restoreError 回灌（进行中禁用重复提交，失败保留表单
 * 与用户自定义名称等待重试）；成功由现有守护会话清理流程关闭（guard 变化
 * 随横幅卸载，本件的守护变化 watch 亦会收起表单）。
 */
const props = withDefaults(
  defineProps<{
    guard: CardSessionGuard
    /** 卡片名（副本默认名与标题文案引用） */
    titleValue: string
    /** 「恢复为新卡片」创建进行中（禁用提交，防重复） */
    restoreBusy?: boolean
    /** 「恢复为新卡片」创建失败原因（表单内红字；空值不渲染） */
    restoreError?: string
  }>(),
  {
    restoreBusy: false,
    restoreError: '',
  },
)

const emit = defineEmits<{
  /** 「恢复为新卡片」提交：用领域新建能力落一张新卡（同名由服务层唯一化） */
  restoreAsCopy: [name: string]
  /** 「放弃并关闭」：丢弃保留的未落盘现场并关闭详情 */
  discardGuard: []
}>()

/** 守护「恢复为副本」表单（守护对象变化清残留；名称在失败重试间保留） */
const guardCopyOpen = ref(false)
const guardCopyName = ref('')

watch(
  () => props.guard,
  () => {
    guardCopyOpen.value = false
  },
)

function openGuardCopyForm() {
  guardCopyName.value = `${props.titleValue}（副本）`
  guardCopyOpen.value = true
}

function submitGuardCopy() {
  const name = guardCopyName.value.trim()
  if (!name || props.restoreBusy) {
    return
  }
  // 不在此处收起表单：结果由调用方经 restoreBusy/restoreError 回灌——失败保留
  // 表单与名称，成功由守护会话清理流程关闭横幅
  emit('restoreAsCopy', name)
}
</script>

<template>
  <GuardBanner
    :kind="guard.kind"
    :title="guard.kind === 'deleted'
      ? `「${titleValue}」已被删除${guard.trashPath ? '并移入回收站' : ''}`
      : `「${titleValue}」的文件已被重命名`"
    :description="guard.kind === 'deleted'
      ? '你尚未写入的修改已完整保留，不会被自动丢弃；可恢复为一张新卡片，或放弃。'
      : '你尚未写入的修改仍完整保留；可恢复为一张新卡片，或放弃。'"
    :detail="guard.kind === 'deleted'
      ? guard.trashPath ? { label: '原文在回收站', value: guard.trashPath } : null
      : { label: '新位置', value: guard.toPath }"
  >
    <template #actions>
      <button
        v-if="!guardCopyOpen"
        type="button"
        class="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-500"
        data-testid="card-guard-restore"
        @click="openGuardCopyForm"
      >
        恢复为新卡片
      </button>
      <button
        type="button"
        class="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
        data-testid="card-guard-discard"
        @click="emit('discardGuard')"
      >
        放弃并关闭
      </button>
    </template>
    <template #form>
      <!-- 恢复为副本表单：用领域新建能力落一张新卡（同名由服务层唯一化） -->
      <div v-if="guardCopyOpen" class="flex flex-col gap-1.5">
        <div class="flex items-center gap-2">
          <input
            v-model="guardCopyName"
            type="text"
            class="min-w-0 flex-1 rounded-md border border-amber-300 bg-white px-2 py-1 text-xs text-gray-800 focus:border-amber-500 focus:outline-none"
            placeholder="新卡片名称"
            data-testid="card-guard-copy-name"
          >
          <button
            type="button"
            class="shrink-0 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-40"
            :disabled="restoreBusy || !guardCopyName.trim()"
            data-testid="card-guard-copy-submit"
            @click="submitGuardCopy"
          >
            {{ restoreBusy ? '保存中…' : '保存为新卡片' }}
          </button>
          <button
            type="button"
            class="shrink-0 rounded-md px-1.5 py-1 text-xs text-gray-500 hover:underline"
            @click="guardCopyOpen = false"
          >
            取消
          </button>
        </div>
        <p v-if="restoreError" class="text-[11px] text-red-600" data-testid="card-guard-copy-error">{{ restoreError }}</p>
        <p class="text-[11px] text-gray-400">新卡片是独立创建，不恢复原文件；保存成功后这里的保留现场会关闭。</p>
      </div>
    </template>
  </GuardBanner>
</template>
