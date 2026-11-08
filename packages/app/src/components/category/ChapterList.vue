<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ForeshadowingCardSummaryView, ProjectFileNodeView } from '@novai/core/services/types'
import { chapterRelatedForeshadowing, FORESHADOWING_STATUS_SHORT_LABELS } from '../../constants/foreshadowing'
import { pickDirectoryChildren } from '../../utils/file-tree'
import AppIcon from '../ui/AppIcon.vue'

const props = defineProps<{
  files: ProjectFileNodeView[]
  activeFilePath?: string
  /** 全量伏笔摘要（实时反查「本章相关伏笔」用；不传则不显示该区块） */
  foreshadowingCards?: ForeshadowingCardSummaryView[]
}>()

const emit = defineEmits<{
  selectFile: [path: string]
  openForeshadowing: [id: string]
}>()

/**
 * chapters/ 目录的直接子项（保持层级，可能含子目录「卷/部」+ 章节文件）。
 * 章节页本身展示这个平铺列表；子目录通过展开/折叠渲染其子项。
 */
const chapterNodes = computed(() => pickDirectoryChildren(props.files, 'chapters'))

const hasChapters = computed(() => chapterNodes.value.length > 0)

/**
 * 本章相关伏笔（施工计划 §七）：根据伏笔 frontmatter 实时反查——埋设章是本章，
 * 或暗示历史包含本章。不写入章节文件，章节正文保持纯净（§九）。
 */
const relatedForeshadowing = computed(() =>
  chapterRelatedForeshadowing(props.foreshadowingCards ?? [], props.activeFilePath),
)

/** 每个目录节点的展开状态，key = 目录 path */
const expandedDirs = ref<Set<string>>(new Set())

function toggleDir(path: string) {
  if (expandedDirs.value.has(path)) {
    expandedDirs.value.delete(path)
  } else {
    expandedDirs.value.add(path)
  }
}

function isDirExpanded(path: string) {
  return expandedDirs.value.has(path)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="px-4 py-3">
      <h2 class="text-sm font-semibold text-white">章节</h2>
    </div>

    <div class="flex-1 overflow-y-auto px-2 pb-2">
      <!-- 本章相关伏笔：选中章节后实时反查（frontmatter），不写入章节文件 -->
      <div v-if="relatedForeshadowing.length" class="mb-2 rounded-md bg-white/5 px-2 py-2" data-testid="chapter-related-foreshadowing">
        <p class="px-1 pb-1 text-xs font-medium text-gray-500">本章相关伏笔</p>
        <ul class="space-y-0.5">
          <li v-for="card in relatedForeshadowing" :key="card.id">
            <button
              class="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200"
              @click="emit('openForeshadowing', card.id)"
            >
              <AppIcon name="eye-off" :size="12" class="h-3 w-3 shrink-0 text-gray-600" />
              <span class="flex-1 truncate">{{ card.name }}</span>
              <span class="shrink-0 text-gray-600">{{ FORESHADOWING_STATUS_SHORT_LABELS[card.status] }}</span>
            </button>
          </li>
        </ul>
      </div>

      <!-- 空状态：chapters/ 目录为空或不存在 -->
      <div v-if="!hasChapters" class="px-2 py-8 text-center">
        <p class="mb-1 text-sm text-gray-400">还没有章节</p>
        <p class="text-xs text-gray-500">在对话框输入指令，让 AI 开始第一章吧</p>
      </div>

      <!-- 章节列表：平铺渲染 chapters/ 直接子项 -->
      <ul v-else class="space-y-0.5">
        <li v-for="node in chapterNodes" :key="node.path">
          <!-- 目录节点（卷/部）：可折叠的分组标题 -->
          <button
            v-if="node.kind === 'directory'"
            class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200"
            @click="toggleDir(node.path)"
          >
            <AppIcon name="chevron-right" :size="14" :class="['h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform', isDirExpanded(node.path) ? 'rotate-90' : '']" />
            <AppIcon v-if="isDirExpanded(node.path)" name="folder-open" :size="16" class="h-4 w-4 shrink-0 text-gray-500" />
            <AppIcon v-else name="folder" :size="16" class="h-4 w-4 shrink-0 text-gray-500" />
            <span class="flex-1 truncate">{{ node.name }}</span>
            <span class="shrink-0 text-xs text-gray-500">{{ node.children?.length ?? 0 }}</span>
          </button>

          <!-- 目录展开后的子项 -->
          <ul
            v-if="node.kind === 'directory' && isDirExpanded(node.path) && node.children?.length"
            class="mb-1 ml-3 border-l border-white/10 pl-2"
          >
            <li v-for="child in node.children" :key="child.path">
              <button
                v-if="child.kind === 'file'"
                :class="[
                  'flex w-full items-center rounded-md px-2 py-1 text-left text-xs transition-colors',
                  child.path === activeFilePath
                    ? 'bg-white/15 text-white'
                    : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
                ]"
                @click="emit('selectFile', child.path)"
              >
                <span class="truncate">{{ child.name }}</span>
              </button>
            </li>
          </ul>

          <!-- 文件节点（章节）：直接渲染 -->
          <button
            v-if="node.kind === 'file'"
            :class="[
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
              node.path === activeFilePath
                ? 'bg-white/15 text-white'
                : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
            ]"
            @click="emit('selectFile', node.path)"
          >
            <AppIcon name="file-text" :size="16" class="h-4 w-4 shrink-0 text-gray-500" />
            <span class="truncate">{{ node.name }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
