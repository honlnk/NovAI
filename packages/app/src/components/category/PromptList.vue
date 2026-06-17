<script setup lang="ts">
import { computed } from 'vue'
import type { ProjectFileNodeView } from '@novai/core/services/types'
import { pickDirectoryChildren } from '../../utils/file-tree'

const props = defineProps<{
  files: ProjectFileNodeView[]
  activeFilePath?: string
  /** 当前激活的场景提示词路径，null 表示未激活任何场景 */
  activeScenePromptPath: string | null
}>()

const emit = defineEmits<{
  selectFile: [path: string]
  /** 切换激活场景，path 为 null 表示关闭场景 */
  changeScene: [path: string | null]
}>()

/**
 * prompts/ 目录的直接子项。
 * 通常包含：system.md（系统提示词文件）+ scenes/（场景提示词子目录）。
 */
const promptRootChildren = computed(() => pickDirectoryChildren(props.files, 'prompts'))

/** 系统提示词：prompts/system.md */
const systemPrompt = computed<ProjectFileNodeView | null>(() => {
  return promptRootChildren.value.find(
    n => n.kind === 'file' && n.path === 'prompts/system.md',
  ) ?? null
})

/** 场景提示词：prompts/scenes/ 目录下的所有 .md 文件（拉平） */
const scenePrompts = computed<ProjectFileNodeView[]>(() => {
  const sceneChildren = pickDirectoryChildren(props.files, 'prompts/scenes')
  return sceneChildren.filter(n => n.kind === 'file' && n.path.endsWith('.md'))
})

function isSceneActive(path: string): boolean {
  return props.activeScenePromptPath === path
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

      <!-- 场景提示词 -->
      <div>
        <p class="px-2 py-1 text-xs font-medium uppercase tracking-wide text-gray-500">场景提示词</p>

        <!-- 场景列表为空 -->
        <p
          v-if="scenePrompts.length === 0"
          class="px-2 py-2 text-xs text-gray-600"
        >
          暂无场景提示词，在 prompts/scenes/ 下新增 .md 文件即可
        </p>

        <ul v-else class="space-y-0.5">
          <li v-for="node in scenePrompts" :key="node.path">
            <!-- 场景项：点击预览，右侧标记控制激活态 -->
            <button
              :class="[
                'group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                node.path === activeFilePath
                  ? 'bg-white/15 text-white'
                  : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
              ]"
              @click="emit('selectFile', node.path)"
            >
              <span class="shrink-0">🎬</span>
              <span class="flex-1 truncate">{{ node.name }}</span>
              <!-- 已激活：绿色实心点，点击关闭 -->
              <span
                v-if="isSceneActive(node.path)"
                class="shrink-0 text-xs text-green-400"
                title="当前激活场景，点击关闭"
                @click.stop="emit('changeScene', null)"
              >●</span>
              <!-- 未激活：空心点，hover 显示，点击激活 -->
              <button
                v-else
                class="shrink-0 rounded px-1 text-xs text-gray-600 opacity-0 transition-opacity hover:text-gray-300 group-hover:opacity-100"
                title="设为当前场景"
                @click.stop="emit('changeScene', node.path)"
              >○</button>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
