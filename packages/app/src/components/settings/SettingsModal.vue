<script setup lang="ts">
import { nextTick, onMounted, reactive, ref, watch } from 'vue'

import type { ProjectConfigPatch, ProjectConfigView } from '@novai/core/services/types'
import BaseModal from '../ui/BaseModal.vue'
import CompletionSettingsPanel from './CompletionSettingsPanel.vue'
import EmbeddingSettingsPanel from './EmbeddingSettingsPanel.vue'
import LlmSettingsPanel from './LlmSettingsPanel.vue'
import ProjectSettingsPanel from './ProjectSettingsPanel.vue'
import RerankSettingsPanel from './RerankSettingsPanel.vue'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useToast } from '../../composables/useToast'

const props = defineProps<{
  projectId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const settingsStore = useSettingsStore()
const projectStore = useProjectStore()
const toast = useToast()

type SettingsTab = 'llm' | 'embedding' | 'rerank' | 'completion' | 'project'

const TABS: Array<{ key: SettingsTab; label: string }> = [
  { key: 'llm', label: 'LLM 配置' },
  { key: 'embedding', label: 'Embedding 配置' },
  { key: 'rerank', label: 'Rerank 配置' },
  { key: 'completion', label: '输入补全' },
  { key: 'project', label: '项目设置' },
]

const TAB_STORAGE_KEY = 'novai:settings-tab'
const AUTO_SAVE_DEBOUNCE_MS = 600

const activeTab = ref<SettingsTab>(restoreTab())

// 表单状态（reactive 引用直接传给面板，字段修改经 watch 触发自动保存）
const llmForm = reactive({
  baseUrl: '',
  apiKey: '',
  model: '',
  protocol: 'openai' as 'openai' | 'openai-responses' | 'anthropic' | 'gemini',
})

const embeddingForm = reactive({
  baseUrl: '',
  apiKey: '',
  model: '',
})

const rerankForm = reactive({
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  mode: 'text' as 'text' | 'multimodal',
  topN: 8,
})

const completionForm = reactive({
  enabled: false,
  baseUrl: 'https://api.deepseek.com/beta',
  apiKey: '',
  model: 'deepseek-chat',
  debounceMs: 600,
  maxTokens: 64,
})

const projectForm = reactive({
  proofreadDefaultChapters: 3,
  organizeDefaultChapters: 10,
  generationRecentChapters: 3,
  ragCandidateLimit: 20,
  ragContextMaxItems: 8,
  conversationTokenLimit: 8000,
  compressionKeepRecentTurns: 5,
  enableDebugLogging: false,
})

/** 自动保存状态，聚合展示在 footer 左侧。 */
type SaveState = 'idle' | 'saving' | 'saved' | 'error'
const saveState = ref<SaveState>('idle')

/** 回填表单期间挂起自动保存，避免磁盘数据回写触发一轮无意义保存。 */
let isInitializing = false
let saveTimer: ReturnType<typeof setTimeout> | undefined
let pendingPatch: ProjectConfigPatch | null = null

/**
 * 模态框采用 v-if 按需挂载，每次打开都会重新触发 onMounted，
 * 从而保证配置始终从磁盘读取最新值；关闭前 flush 未落盘的修改。
 */
onMounted(async () => {
  isInitializing = true
  await settingsStore.loadSettings(props.projectId)

  const config = settingsStore.config
  if (config) {
    Object.assign(llmForm, {
      baseUrl: config.llm?.baseUrl ?? '',
      apiKey: config.llm?.apiKey ?? '',
      model: config.llm?.model ?? '',
      protocol: config.llm?.protocol ?? 'openai',
    })
    Object.assign(embeddingForm, {
      baseUrl: config.embedding?.baseUrl ?? '',
      apiKey: config.embedding?.apiKey ?? '',
      model: config.embedding?.model ?? '',
    })
    Object.assign(rerankForm, {
      enabled: config.rerank?.enabled ?? false,
      baseUrl: config.rerank?.baseUrl ?? '',
      apiKey: config.rerank?.apiKey ?? '',
      model: config.rerank?.model ?? '',
      mode: config.rerank?.mode ?? 'text',
      topN: config.rerank?.topN ?? 8,
    })
    Object.assign(completionForm, {
      enabled: config.completion?.enabled ?? false,
      baseUrl: config.completion?.baseUrl ?? 'https://api.deepseek.com/beta',
      apiKey: config.completion?.apiKey ?? '',
      model: config.completion?.model ?? 'deepseek-chat',
      debounceMs: config.completion?.debounceMs ?? 600,
      maxTokens: config.completion?.maxTokens ?? 64,
    })
    const settings = config.settings
    if (settings) {
      Object.assign(projectForm, {
        proofreadDefaultChapters: settings.proofreadDefaultChapters ?? 3,
        organizeDefaultChapters: settings.organizeDefaultChapters ?? 10,
        generationRecentChapters: settings.generationRecentChapters ?? 3,
        ragCandidateLimit: settings.ragCandidateLimit ?? 20,
        ragContextMaxItems: settings.ragContextMaxItems ?? 8,
        conversationTokenLimit: settings.conversationTokenLimit ?? 8000,
        compressionKeepRecentTurns: settings.compressionKeepRecentTurns ?? 5,
        enableDebugLogging: settings.enableDebugLogging ?? false,
      })
    }
  }

  await nextTick()
  isInitializing = false
})

watch(llmForm, () => scheduleSave({ llm: { ...llmForm } }))
watch(embeddingForm, () => scheduleSave({ embedding: { ...embeddingForm } }))
watch(rerankForm, () => scheduleSave({ rerank: { ...rerankForm } }))
watch(completionForm, () => scheduleSave({ completion: { ...completionForm } }))
watch(projectForm, () => scheduleSave({ settings: { ...projectForm } }))

watch(activeTab, (tab) => {
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab)
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级，仅影响 tab 记忆
  }
})

/**
 * 表单变化进入自动保存队列：防抖 600ms 后整组落盘。
 * 开关类字段的立即保存由面板 emit('save-immediately') 触发 flushSave。
 */
function scheduleSave(patch: ProjectConfigPatch) {
  if (isInitializing) {
    return
  }

  pendingPatch = mergePendingPatch(pendingPatch, patch)
  saveState.value = 'saving'

  if (saveTimer) {
    clearTimeout(saveTimer)
  }

  saveTimer = setTimeout(() => {
    void flushSave()
  }, AUTO_SAVE_DEBOUNCE_MS)
}

/**
 * 立即落盘当前队列中的修改。保存成功才清空队列，失败保留供重试。
 */
async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }

  if (!pendingPatch) {
    return
  }

  const patch = pendingPatch
  const saved = await settingsStore.saveConfig(props.projectId, patch)

  if (saved) {
    pendingPatch = null
    syncCurrentProjectConfig(saved)
    saveState.value = 'saved'
    return
  }

  saveState.value = 'error'
  toast.error(settingsStore.errorMessage || '设置自动保存失败')
}

/**
 * 开关切换需要立即生效（如关闭输入补全后 ChatPanel 立即停用），
 * 延后一个宏任务等 watch 先把本次修改并入队列，再整体 flush。
 */
function handleSaveImmediately() {
  setTimeout(() => {
    void flushSave()
  }, 0)
}

async function handleClose() {
  await flushSave()
  emit('close')
}

function retrySave() {
  if (saveState.value === 'error') {
    void flushSave()
  }
}

/**
 * 保存配置后同步到 projectStore.currentProject.config。
 *
 * settingsStore 与 projectStore 各持有一份配置副本，若不同步，ChatPanel 读 projectStore 侧
 * 会拿到过期数据（如输入补全开关刚打开，ChatPanel 却读不到 enabled）。
 */
function syncCurrentProjectConfig(saved: ProjectConfigView | null) {
  if (saved) {
    projectStore.updateCurrentProjectConfig(saved)
  }
}

function mergePendingPatch(
  current: ProjectConfigPatch | null,
  next: ProjectConfigPatch,
): ProjectConfigPatch {
  if (!current) {
    return next
  }

  const merged: ProjectConfigPatch = { ...current }

  for (const key of Object.keys(next) as Array<keyof ProjectConfigPatch>) {
    const nextGroup = next[key]
    if (nextGroup === undefined) {
      continue
    }

    const currentGroup = current[key]
    merged[key] =
      currentGroup && typeof currentGroup === 'object'
        ? ({ ...(currentGroup as object), ...(nextGroup as object) } as never)
        : (nextGroup as never)
  }

  return merged
}

function restoreTab(): SettingsTab {
  try {
    const stored = window.localStorage.getItem(TAB_STORAGE_KEY)
    if (stored && TABS.some((tab) => tab.key === stored)) {
      return stored as SettingsTab
    }
  } catch {
    // localStorage 不可用时回退默认 tab
  }

  return 'llm'
}
</script>

<template>
  <BaseModal
    :is-open="true"
    backdrop-class="bg-black/50 px-3"
    content-class="flex h-[min(88vh,44rem)] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
    aria-labelledby="settings-title"
    @close="handleClose"
  >
    <!-- 顶栏：标题 + 关闭 -->
    <header class="flex shrink-0 items-start justify-between border-b border-gray-200 px-5 py-4">
      <h2 id="settings-title" class="text-lg font-semibold text-gray-900">项目设置</h2>
      <button
        type="button"
        title="关闭"
        class="cursor-pointer rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
        @click="handleClose"
      >
        <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </header>

    <!-- 主体：左侧竖排导航 + 右侧滚动内容 -->
    <div class="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav
        class="flex shrink-0 gap-1 overflow-x-auto border-b border-gray-200 bg-gray-50 p-2 md:w-44 md:flex-col md:border-r md:border-b-0"
        aria-label="设置分类"
      >
        <button
          v-for="tab in TABS"
          :key="tab.key"
          type="button"
          class="shrink-0 cursor-pointer rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors"
          :class="
            activeTab === tab.key
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:bg-white hover:text-gray-800'
          "
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </nav>

      <div class="min-h-0 flex-1 overflow-y-auto p-5">
        <LlmSettingsPanel v-if="activeTab === 'llm'" :form="llmForm" />
        <EmbeddingSettingsPanel v-else-if="activeTab === 'embedding'" :form="embeddingForm" />
        <RerankSettingsPanel
          v-else-if="activeTab === 'rerank'"
          :form="rerankForm"
          @save-immediately="handleSaveImmediately"
        />
        <CompletionSettingsPanel
          v-else-if="activeTab === 'completion'"
          :form="completionForm"
          @save-immediately="handleSaveImmediately"
        />
        <ProjectSettingsPanel v-else :form="projectForm" />
      </div>
    </div>

    <!-- 底栏：自动保存状态 + 关闭 -->
    <footer class="flex shrink-0 items-center justify-between border-t border-gray-200 px-5 py-4">
      <p
        class="text-xs"
        :class="{
          'text-gray-400': saveState === 'idle',
          'text-gray-500': saveState === 'saving',
          'text-green-600': saveState === 'saved',
          'cursor-pointer font-medium text-red-600 hover:text-red-700': saveState === 'error',
        }"
        @click="retrySave"
      >
        <span v-if="saveState === 'idle'">更改会自动保存</span>
        <span v-else-if="saveState === 'saving'">保存中…</span>
        <span v-else-if="saveState === 'saved'">已自动保存</span>
        <span v-else>自动保存失败，点击重试</span>
      </p>
      <button
        type="button"
        class="cursor-pointer rounded-lg bg-black px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
        @click="handleClose"
      >
        关闭
      </button>
    </footer>
  </BaseModal>
</template>
