<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

import FileTreeNode from '../components/FileTreeNode.vue'
import { useUiStore, type WorkspacePanelMode } from '../stores/ui'
import type { ProjectFileContent, TreeNode } from '../types/project'

const props = defineProps<{
  projectId: string
  projectName: string
  tree: TreeNode[]
  activeFile: ProjectFileContent | null
  errorMessage: string
}>()

const emit = defineEmits<{
  openFile: [path: string]
  refreshTree: []
}>()

const uiStore = useUiStore()
const { panelMode, panelTitle, selectedFilePath, sidebarCollapsed } = storeToRefs(uiStore)

const actions: Array<{ key: WorkspacePanelMode; label: string }> = [
  { key: 'proofread', label: '校对' },
  { key: 'organize', label: '章节整理' },
  { key: 'version', label: '版本管理' },
  { key: 'prompt', label: '提示词草稿' },
]

const activeFileName = computed(() => selectedFilePath.value.split('/').pop() ?? '未选择文件')

function onTreeSelect(path: string) {
  uiStore.selectFile(path)
  emit('openFile', path)
}

function onActionClick(mode: WorkspacePanelMode) {
  uiStore.setPanelMode(mode)
}

const previewTitle = computed(() => props.activeFile?.name ?? activeFileName.value)
</script>

<template>
  <section class="workspace-layout text-ink-950">
    <aside class="workspace-sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="workspace-sidebar__header">
        <div>
          <p class="workspace-sidebar__eyebrow">当前项目</p>
          <h2 class="text-2xl font-semibold tracking-tight">{{ projectName }}</h2>
        </div>
        <button class="ghost-button" type="button" @click="uiStore.toggleSidebar">
          {{ sidebarCollapsed ? '展开' : '收起' }}
        </button>
      </div>

      <template v-if="!sidebarCollapsed">
        <div class="workspace-pane">
          <div class="section-heading">
            <span>文件树</span>
            <button class="text-button font-semibold" type="button" @click="emit('refreshTree')">刷新</button>
          </div>

          <div class="tree-list">
            <FileTreeNode
              v-for="node in tree"
              :key="node.path"
              :node="node"
              :selected-path="selectedFilePath"
              @select="onTreeSelect"
            />
          </div>
        </div>

        <div class="workspace-pane">
          <div class="section-heading">
            <span>功能入口</span>
          </div>

          <div class="action-list">
            <button
              v-for="action in actions"
              :key="action.key"
              class="action-item"
              :class="{ active: action.key === panelMode }"
              type="button"
              @click="onActionClick(action.key)"
            >
              {{ action.label }}
            </button>
            <RouterLink class="action-item action-item--link" :to="`/project/${props.projectId}/settings`">
              项目设置
            </RouterLink>
          </div>
        </div>
      </template>
    </aside>

    <main class="workspace-main">
      <header class="workspace-main__header">
        <div>
          <p class="workspace-sidebar__eyebrow">AI 工作区</p>
          <h1 class="max-w-3xl">对话驱动的小说创作工作台</h1>
        </div>
        <button class="primary-button" type="button" @click="uiStore.setPanelMode('generation')">
          开始生成章节
        </button>
      </header>

      <section class="chat-shell">
        <div class="chat-shell__messages">
          <article class="message-card">
            <p class="message-role">系统状态</p>
            <h3 class="text-lg font-semibold">工作台骨架已就绪</h3>
            <p>
              下一步可以依次接入项目创建、文件系统扫描、模型配置和流式生成链路。
            </p>
          </article>

          <article class="message-card message-card--accent">
            <p class="message-role">建议起点</p>
            <h3 class="text-lg font-semibold">先打通“创建项目 -> 文件树 -> 预览”</h3>
            <p>
              这会是后续模型配置、生成预览和要素写入的共同承载面。
            </p>
          </article>
        </div>

        <div class="chat-shell__composer">
          <div class="token-meter">
            <span>Token 预算</span>
            <div class="token-meter__bar">
              <span style="width: 34%" />
            </div>
            <span>34%</span>
          </div>

          <label class="composer-field">
            <span>创作指令</span>
            <textarea
              rows="5"
              class="outline-none transition focus:border-clay-600 focus:ring-4 focus:ring-clay-100"
              placeholder="例如：写第三章，主角进入密境后先发现一条废弃石阶..."
            />
          </label>

          <div class="composer-actions">
            <button class="ghost-button" type="button">压缩上下文</button>
            <button class="primary-button" type="button">发送</button>
          </div>
        </div>
      </section>
    </main>

    <aside class="workspace-panel">
      <header class="workspace-panel__header">
        <div>
          <p class="workspace-sidebar__eyebrow">{{ panelTitle }}</p>
          <h2 class="text-2xl font-semibold tracking-tight">{{ previewTitle }}</h2>
        </div>
      </header>

      <div v-if="errorMessage" class="status-banner status-banner--error">
        {{ errorMessage }}
      </div>

      <div class="preview-card">
        <template v-if="panelMode === 'preview'">
          <template v-if="activeFile">
            <p class="preview-path">{{ activeFile.path }}</p>
            <h3 class="text-lg font-semibold"># {{ activeFile.name.replace('.md', '') }}</h3>
            <pre class="preview-content rounded-2xl bg-white/40 p-4">{{ activeFile.content }}</pre>
          </template>
          <template v-else>
            <p class="preview-path">暂无文件</p>
            <h3 class="text-lg font-semibold">等待打开文件</h3>
            <p>
              从左侧文件树中选择一个 Markdown 或 JSON 文件后，这里会显示它的真实内容。
            </p>
          </template>
        </template>

        <template v-else-if="panelMode === 'generation'">
          <p class="preview-path">生成预览</p>
          <h3 class="text-lg font-semibold">流式输出区域</h3>
          <p>
            后续这里会展示章节生成中的实时文本流，并在完成后写入 `chapters/`。
          </p>
        </template>

        <template v-else>
          <p class="preview-path">{{ panelTitle }}</p>
          <h3 class="text-lg font-semibold">功能占位区</h3>
          <p>
            当前视图已预留位置，后续可以在不改整体布局的情况下继续接入对应模块。
          </p>
        </template>
      </div>
    </aside>
  </section>
</template>
