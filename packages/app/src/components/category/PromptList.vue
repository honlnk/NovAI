<script setup lang="ts">
import { computed } from 'vue'
import type { ProjectFileNodeView } from '@novai/core/services/types'
import { pickDirectoryChildren } from '../../utils/file-tree'

const props = defineProps<{
  files: ProjectFileNodeView[]
  activeFilePath?: string
  /** 当前激活的写作大纲路径，null 表示未激活任何大纲 */
  activeOutlinePath: string | null
}>()

const emit = defineEmits<{
  selectFile: [path: string]
  /** 切换激活大纲，path 为 null 表示关闭大纲 */
  changeOutline: [path: string | null]
}>()

/**
 * prompts/ 目录的直接子项。
 * 通常包含：system.md（系统提示词文件）+ outlines/（大纲子目录）。
 */
const promptRootChildren = computed(() => pickDirectoryChildren(props.files, 'prompts'))

/** 系统提示词：prompts/system.md */
const systemPrompt = computed<ProjectFileNodeView | null>(() => {
  return promptRootChildren.value.find(
    n => n.kind === 'file' && n.path === 'prompts/system.md',
  ) ?? null
})

/** 项目总览：prompts/NovAI.md。非空时以背景提醒注入（user-role reminder），可手动编辑或用 /生成项目记忆 刷新 */
const novaiOverview = computed<ProjectFileNodeView | null>(() => {
  return promptRootChildren.value.find(
    n => n.kind === 'file' && n.path === 'prompts/NovAI.md',
  ) ?? null
})

/** 要素库规范：prompts/ELEMENT.md。只注入要素管理员子代理（/管理要素），不进主 Agent 提示词栈 */
const elementSchema = computed<ProjectFileNodeView | null>(() => {
  return promptRootChildren.value.find(
    n => n.kind === 'file' && n.path === 'prompts/ELEMENT.md',
  ) ?? null
})

/** 写作大纲：prompts/outlines/ 目录下的所有 .md 文件（拉平） */
const outlines = computed<ProjectFileNodeView[]>(() => {
  const outlineChildren = pickDirectoryChildren(props.files, 'prompts/outlines')
  return outlineChildren.filter(n => n.kind === 'file' && n.path.endsWith('.md'))
})

function isOutlineActive(path: string): boolean {
  return props.activeOutlinePath === path
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="px-4 py-3">
      <h2 class="text-sm font-semibold text-white">提示词</h2>
    </div>

    <div class="flex-1 overflow-y-auto px-2 pb-2">
      <!-- 系统提示词 -->
      <div class="mb-2">
        <p class="px-2 py-1 text-xs font-medium uppercase tracking-wide text-gray-500">系统提示词</p>
        <button
          v-if="systemPrompt"
          :class="[
            'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
            systemPrompt.path === activeFilePath
              ? 'bg-white/15 text-white'
              : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
          ]"
          @click="emit('selectFile', systemPrompt.path)"
        >
          <span class="shrink-0">📄</span>
          <span class="truncate">{{ systemPrompt.name }}</span>
          <span class="ml-auto shrink-0 text-xs text-gray-500">恒激活</span>
        </button>
        <p v-else class="px-2 py-2 text-xs text-gray-600">
          未找到系统提示词（prompts/system.md）
        </p>
      </div>

      <!-- 项目总览 -->
      <div class="mb-2">
        <p class="px-2 py-1 text-xs font-medium uppercase tracking-wide text-gray-500">项目总览</p>
        <button
          v-if="novaiOverview"
          :class="[
            'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
            novaiOverview.path === activeFilePath
              ? 'bg-white/15 text-white'
              : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
          ]"
          @click="emit('selectFile', novaiOverview.path)"
        >
          <span class="shrink-0">📋</span>
          <span class="truncate">{{ novaiOverview.name }}</span>
          <span class="ml-auto shrink-0 text-xs text-gray-500">背景注入</span>
        </button>
        <p v-else class="px-2 py-2 text-xs text-gray-600">
          未找到项目总览（prompts/NovAI.md）
        </p>
      </div>

      <!-- 要素库规范 -->
      <div class="mb-2">
        <p class="px-2 py-1 text-xs font-medium uppercase tracking-wide text-gray-500">要素规范</p>
        <button
          v-if="elementSchema"
          :class="[
            'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
            elementSchema.path === activeFilePath
              ? 'bg-white/15 text-white'
              : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
          ]"
          @click="emit('selectFile', elementSchema.path)"
        >
          <span class="shrink-0">📚</span>
          <span class="truncate">{{ elementSchema.name }}</span>
          <span class="ml-auto shrink-0 text-xs text-gray-500">要素管理专用</span>
        </button>
        <p v-else class="px-2 py-2 text-xs text-gray-600">
          未找到要素规范（prompts/ELEMENT.md），修复项目后会自动补齐
        </p>
      </div>

      <!-- 写作大纲 -->
      <div>
        <p class="px-2 py-1 text-xs font-medium uppercase tracking-wide text-gray-500">写作大纲</p>

        <!-- 大纲列表为空 -->
        <p
          v-if="outlines.length === 0"
          class="px-2 py-2 text-xs text-gray-600"
        >
          暂无大纲，在 prompts/outlines/ 下新增 .md 文件即可
        </p>

        <ul v-else class="space-y-0.5">
          <li v-for="node in outlines" :key="node.path">
            <!-- 大纲项：点击预览，右侧标记控制激活态 -->
            <button
              :class="[
                'group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                node.path === activeFilePath
                  ? 'bg-white/15 text-white'
                  : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
              ]"
              @click="emit('selectFile', node.path)"
            >
              <span class="shrink-0">📜</span>
              <span class="flex-1 truncate">{{ node.name }}</span>
              <!-- 已激活：绿色实心点，点击关闭 -->
              <span
                v-if="isOutlineActive(node.path)"
                class="shrink-0 text-xs text-green-400"
                role="button"
                title="当前激活大纲，点击关闭"
                aria-label="关闭当前大纲"
                @click.stop="emit('changeOutline', null)"
                >●</span>
              <!-- 未激活：空心点，hover 显示，点击激活 -->
              <button
                v-else
                class="shrink-0 rounded px-1 text-xs text-gray-600 opacity-0 transition-opacity hover:text-gray-300 group-hover:opacity-100"
                title="设为当前大纲"
                @click.stop="emit('changeOutline', node.path)"
                >○</button>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
