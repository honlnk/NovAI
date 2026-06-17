<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { inspectIndex, rebuildIndex } from '@novai/core/services/rag-service'
import type { ProjectIndexMetaView } from '@novai/core/services/types'
import PasswordInput from '../ui/PasswordInput.vue'

const props = defineProps<{
  projectId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const settingsStore = useSettingsStore()

const activeTab = ref<'llm' | 'embedding' | 'rerank' | 'project'>('llm')

// 表单状态
const llmForm = ref({
  baseUrl: '',
  apiKey: '',
  model: '',
})

const embeddingForm = ref({
  baseUrl: '',
  apiKey: '',
  model: '',
})

const rerankForm = ref({
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  mode: 'text' as 'text' | 'multimodal',
  topN: 8,
})

const projectForm = ref({
  proofreadDefaultChapters: 3,
  organizeDefaultChapters: 10,
  generationRecentChapters: 3,
  ragCandidateLimit: 20,
  ragContextMaxItems: 8,
  conversationTokenLimit: 8000,
  compressionKeepRecentTurns: 5,
  enableDebugLogging: false,
})

const isTesting = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)
const isIndexBusy = ref(false)
const indexMeta = ref<ProjectIndexMetaView | null>(null)
const indexStatusMessage = ref('尚未读取索引状态')

const projectId = computed(() => props.projectId)

/**
 * 模态框采用 v-if 按需挂载，每次打开都会重新触发 onMounted，
 * 从而保证配置与索引状态始终从磁盘读取最新值，无需额外刷新逻辑。
 */
onMounted(async () => {
  await settingsStore.loadSettings(projectId.value)

  // 填充表单
  if (settingsStore.config) {
    llmForm.value = {
      baseUrl: settingsStore.config.llm?.baseUrl ?? '',
      apiKey: settingsStore.config.llm?.apiKey ?? '',
      model: settingsStore.config.llm?.model ?? '',
    }
    embeddingForm.value = {
      baseUrl: settingsStore.config.embedding?.baseUrl ?? '',
      apiKey: settingsStore.config.embedding?.apiKey ?? '',
      model: settingsStore.config.embedding?.model ?? '',
    }
    if (settingsStore.config.rerank) {
      rerankForm.value = {
        enabled: settingsStore.config.rerank.enabled ?? false,
        baseUrl: settingsStore.config.rerank.baseUrl ?? '',
        apiKey: settingsStore.config.rerank.apiKey ?? '',
        model: settingsStore.config.rerank.model ?? '',
        mode: settingsStore.config.rerank.mode ?? 'text',
        topN: settingsStore.config.rerank.topN ?? 8,
      }
    }
    if (settingsStore.config.settings) {
      applyProjectSettings(settingsStore.config.settings)
    }
  }

  await handleInspectIndex()
})

async function handleTestLlm() {
  isTesting.value = true
  testResult.value = null
  try {
    const result = await settingsStore.testLlmConfig(llmForm.value)
    testResult.value = result
  } finally {
    isTesting.value = false
  }
}

async function handleTestEmbedding() {
  isTesting.value = true
  testResult.value = null
  try {
    const result = await settingsStore.testEmbeddingConfig(embeddingForm.value)
    testResult.value = result
  } finally {
    isTesting.value = false
  }
}

async function handleSaveLlm() {
  await settingsStore.saveConfig(projectId.value, { llm: llmForm.value })
}

async function handleSaveEmbedding() {
  await settingsStore.saveConfig(projectId.value, { embedding: embeddingForm.value })
}

async function handleSaveRerank() {
  await settingsStore.saveConfig(projectId.value, { rerank: rerankForm.value })
}

async function handleSaveProject() {
  testResult.value = null

  const savedConfig = await settingsStore.saveConfig(projectId.value, {
    settings: { ...projectForm.value },
  })

  if (!savedConfig) {
    testResult.value = {
      ok: false,
      message: settingsStore.errorMessage || '项目设置保存失败',
    }
    return
  }

  applyProjectSettings(savedConfig.settings)
  testResult.value = {
    ok: true,
    message: '项目设置已保存',
  }
}

async function handleInspectIndex() {
  isIndexBusy.value = true
  try {
    indexMeta.value = await inspectIndex(projectId.value)
    indexStatusMessage.value = indexMeta.value
      ? `当前状态：${getIndexStatusLabel(indexMeta.value.status)}`
      : '当前项目还没有索引记录'
  } catch (error) {
    indexStatusMessage.value = error instanceof Error ? error.message : '读取索引状态失败'
  } finally {
    isIndexBusy.value = false
  }
}

async function handleRebuildIndex() {
  isIndexBusy.value = true
  testResult.value = null
  indexStatusMessage.value = '正在重建向量索引...'

  try {
    const result = await rebuildIndex(projectId.value)
    indexMeta.value = await inspectIndex(projectId.value)
    indexStatusMessage.value = result.message
    testResult.value = {
      ok: result.status === 'ready' || result.status === 'empty',
      message: result.message,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '重建索引失败'
    indexStatusMessage.value = message
    testResult.value = {
      ok: false,
      message,
    }
  } finally {
    isIndexBusy.value = false
  }
}

function getIndexStatusLabel(status: ProjectIndexMetaView['status']) {
  switch (status) {
    case 'ready': return '可用'
    case 'empty': return '空索引'
    case 'building': return '构建中'
    case 'rebuilding': return '重建中'
    case 'stale': return '已过期'
    case 'error': return '错误'
    default: return status
  }
}

function getIndexStatusClass(status?: ProjectIndexMetaView['status']) {
  switch (status) {
    case 'ready': return 'bg-green-50 text-green-700 ring-green-200'
    case 'stale': return 'bg-amber-50 text-amber-700 ring-amber-200'
    case 'error': return 'bg-red-50 text-red-700 ring-red-200'
    case 'building':
    case 'rebuilding': return 'bg-blue-50 text-blue-700 ring-blue-200'
    default: return 'bg-gray-50 text-gray-700 ring-gray-200'
  }
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString('zh-CN') : '暂无'
}

function applyProjectSettings(settings: NonNullable<typeof settingsStore.config>['settings']) {
  projectForm.value = {
    proofreadDefaultChapters: settings.proofreadDefaultChapters ?? 3,
    organizeDefaultChapters: settings.organizeDefaultChapters ?? 10,
    generationRecentChapters: settings.generationRecentChapters ?? 3,
    ragCandidateLimit: settings.ragCandidateLimit ?? 20,
    ragContextMaxItems: settings.ragContextMaxItems ?? 8,
    conversationTokenLimit: settings.conversationTokenLimit ?? 8000,
    compressionKeepRecentTurns: settings.compressionKeepRecentTurns ?? 5,
    enableDebugLogging: settings.enableDebugLogging ?? false,
  }
}
</script>

<template>
  <!-- 遮罩层 -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    @click.self="emit('close')"
  >
    <!-- 模态框主体 -->
    <div class="flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
      <!-- 顶栏：标题 + 关闭按钮 -->
      <header class="flex shrink-0 items-center justify-between border-b border-gray-200 px-6 py-4">
        <h2 class="text-lg font-semibold text-gray-900">项目设置</h2>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          title="关闭"
          @click="emit('close')"
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>

      <!-- 选项卡（固定顶部，不随内容滚动） -->
      <div class="shrink-0 border-b border-gray-200 px-6">
        <nav class="flex gap-6">
          <button
            v-for="tab in [
              { key: 'llm', label: 'LLM 配置' },
              { key: 'embedding', label: 'Embedding 配置' },
              { key: 'rerank', label: 'Rerank 配置' },
              { key: 'project', label: '项目设置' },
            ]"
            :key="tab.key"
            :class="[
              'border-b-2 px-1 py-3 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700',
            ]"
            @click="activeTab = tab.key as typeof activeTab"
          >
            {{ tab.label }}
          </button>
        </nav>
      </div>

      <!-- 内容区域：整体滚动 -->
      <main class="flex-1 overflow-y-auto p-6">
        <div class="mx-auto max-w-2xl">
          <!-- LLM 配置 -->
          <div v-if="activeTab === 'llm'" class="space-y-4">
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">API 地址</label>
              <input
                v-model="llmForm.baseUrl"
                class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">API Key</label>
              <PasswordInput
                v-model="llmForm.apiKey"
                placeholder="sk-..."
              />
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">模型名称（可选）</label>
              <input
                v-model="llmForm.model"
                class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="gpt-4o"
              />
            </div>
            <div class="flex gap-3 pt-2">
              <button
                type="button"
                class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                :disabled="isTesting"
                @click="handleTestLlm"
              >
                {{ isTesting ? '测试中...' : '测试连接' }}
              </button>
              <button
                type="button"
                class="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
                @click="handleSaveLlm"
              >
                保存
              </button>
            </div>
          </div>

          <!-- Embedding 配置 -->
          <div v-if="activeTab === 'embedding'" class="space-y-4">
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">API 地址</label>
              <input
                v-model="embeddingForm.baseUrl"
                class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">API Key</label>
              <PasswordInput
                v-model="embeddingForm.apiKey"
                placeholder="sk-..."
              />
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">模型名称（可选）</label>
              <input
                v-model="embeddingForm.model"
                class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="text-embedding-3-small"
              />
            </div>
            <div class="flex gap-3 pt-2">
              <button
                type="button"
                class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                :disabled="isTesting"
                @click="handleTestEmbedding"
              >
                {{ isTesting ? '测试中...' : '测试连接' }}
              </button>
              <button
                type="button"
                class="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
                @click="handleSaveEmbedding"
              >
                保存
              </button>
            </div>
          </div>

          <!-- Rerank 配置 -->
          <div v-if="activeTab === 'rerank'" class="space-y-4">
            <div class="flex items-center gap-3">
              <label class="text-sm font-medium text-gray-700">启用 Rerank</label>
              <button
                :class="[
                  'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                  rerankForm.enabled ? 'bg-gray-900' : 'bg-gray-300',
                ]"
                @click="rerankForm.enabled = !rerankForm.enabled"
              >
                <span
                  :class="[
                    'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                    rerankForm.enabled ? 'translate-x-6' : 'translate-x-1',
                  ]"
                />
              </button>
            </div>
            <div v-if="rerankForm.enabled" class="space-y-4">
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-700">API 地址</label>
                <input
                  v-model="rerankForm.baseUrl"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-700">API Key</label>
                <PasswordInput v-model="rerankForm.apiKey" />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-700">模型名称</label>
                <input
                  v-model="rerankForm.model"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-700">保留条数</label>
                <input
                  v-model.number="rerankForm.topN"
                  type="number"
                  min="1"
                  max="50"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
            <div class="pt-2">
              <button
                type="button"
                class="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
                @click="handleSaveRerank"
              >
                保存
              </button>
            </div>
          </div>

          <!-- 项目设置 -->
          <div v-if="activeTab === 'project'" class="space-y-6">
            <!-- 生成设置 -->
            <div>
              <h3 class="mb-3 text-sm font-semibold text-gray-800">生成设置</h3>
              <div class="space-y-4">
                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700">生成上下文章节数</label>
                  <p class="mb-1 text-xs text-gray-500">生成时携带最近 N 章的原文作为上下文</p>
                  <input
                    v-model.number="projectForm.generationRecentChapters"
                    type="number"
                    min="0"
                    max="20"
                    class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>

            <!-- RAG 设置 -->
            <div>
              <h3 class="mb-3 text-sm font-semibold text-gray-800">RAG 设置</h3>
              <div class="space-y-4">
                <div class="rounded-lg border border-gray-200 bg-white p-4">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <h4 class="text-sm font-semibold text-gray-800">向量索引</h4>
                        <span
                          :class="[
                            'rounded-full px-2 py-0.5 text-xs font-medium ring-1',
                            getIndexStatusClass(indexMeta?.status),
                          ]"
                        >
                          {{ indexMeta ? getIndexStatusLabel(indexMeta.status) : '未创建' }}
                        </span>
                      </div>
                      <p class="mt-1 text-xs text-gray-500">{{ indexStatusMessage }}</p>
                    </div>
                    <div class="flex shrink-0 items-center gap-1">
                      <button
                        class="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 disabled:opacity-40"
                        :disabled="isIndexBusy"
                        title="刷新索引状态"
                        @click="handleInspectIndex"
                      >
                        <svg
                          v-if="isIndexBusy"
                          class="h-4 w-4 animate-spin"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        <svg v-else class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v6h6M20 20v-6h-6M5.5 15A7 7 0 0018 18.5M18.5 9A7 7 0 006 5.5" />
                        </svg>
                      </button>
                      <button
                        class="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 disabled:opacity-40"
                        :disabled="isIndexBusy"
                        title="重建向量索引"
                        @click="handleRebuildIndex"
                      >
                        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.5v15m7.5-7.5h-15" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  <div class="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-600">
                    <div class="rounded-md bg-gray-50 px-3 py-2">
                      <div class="text-gray-400">文档数</div>
                      <div class="mt-1 font-medium text-gray-800">{{ indexMeta?.documentCount ?? 0 }}</div>
                    </div>
                    <div class="rounded-md bg-gray-50 px-3 py-2">
                      <div class="text-gray-400">向量维度</div>
                      <div class="mt-1 font-medium text-gray-800">{{ indexMeta?.embeddingDim ?? 0 }}</div>
                    </div>
                    <div class="rounded-md bg-gray-50 px-3 py-2">
                      <div class="text-gray-400">Embedding 模型</div>
                      <div class="mt-1 truncate font-medium text-gray-800">{{ indexMeta?.embeddingModel || '暂无' }}</div>
                    </div>
                    <div class="rounded-md bg-gray-50 px-3 py-2">
                      <div class="text-gray-400">最近构建</div>
                      <div class="mt-1 truncate font-medium text-gray-800">{{ formatDate(indexMeta?.lastBuildAt) }}</div>
                    </div>
                  </div>

                  <p v-if="indexMeta?.lastError" class="mt-3 text-xs text-red-600">
                    {{ indexMeta.lastError }}
                  </p>
                </div>

                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700">粗检索返回条数</label>
                  <p class="mb-1 text-xs text-gray-500">粗检索阶段返回的候选要素数量</p>
                  <input
                    v-model.number="projectForm.ragCandidateLimit"
                    type="number"
                    min="1"
                    max="100"
                    class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700">上下文最大条数</label>
                  <p class="mb-1 text-xs text-gray-500">最终拼入生成上下文的最大要素数量</p>
                  <input
                    v-model.number="projectForm.ragContextMaxItems"
                    type="number"
                    min="1"
                    max="50"
                    class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>

            <!-- 对话设置 -->
            <div>
              <h3 class="mb-3 text-sm font-semibold text-gray-800">对话设置</h3>
              <div class="space-y-4">
                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700">对话上下文 Token 上限</label>
                  <p class="mb-1 text-xs text-gray-500">接近上限时触发上下文压缩</p>
                  <input
                    v-model.number="projectForm.conversationTokenLimit"
                    type="number"
                    min="1000"
                    max="200000"
                    step="1000"
                    class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700">压缩保留轮数</label>
                  <p class="mb-1 text-xs text-gray-500">上下文压缩时保留最近 N 轮对话的原文</p>
                  <input
                    v-model.number="projectForm.compressionKeepRecentTurns"
                    type="number"
                    min="1"
                    max="20"
                    class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <label class="flex items-start gap-3 rounded-lg border border-gray-200 px-3 py-3">
                  <input
                    v-model="projectForm.enableDebugLogging"
                    type="checkbox"
                    class="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span>
                    <span class="block text-sm font-medium text-gray-700">开发调试日志</span>
                    <span class="block text-xs text-gray-500">记录模型配置、请求摘要和工具调用解析诊断；正式使用建议关闭</span>
                  </span>
                </label>
              </div>
            </div>

            <!-- 校对与整理设置 -->
            <div>
              <h3 class="mb-3 text-sm font-semibold text-gray-800">校对与整理</h3>
              <div class="space-y-4">
                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700">校对默认章节数</label>
                  <p class="mb-1 text-xs text-gray-500">自动校对最近 N 章</p>
                  <input
                    v-model.number="projectForm.proofreadDefaultChapters"
                    type="number"
                    min="1"
                    max="50"
                    class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700">整理默认章节数</label>
                  <p class="mb-1 text-xs text-gray-500">自动整理最近 N 章</p>
                  <input
                    v-model.number="projectForm.organizeDefaultChapters"
                    type="number"
                    min="1"
                    max="50"
                    class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>

            <!-- 保存按钮 -->
            <div class="pt-2">
              <button
                type="button"
                class="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
                @click="handleSaveProject"
              >
                保存
              </button>
            </div>
          </div>

          <!-- 测试结果提示 -->
          <div
            v-if="testResult"
            :class="[
              'mt-4 rounded-lg p-4',
              testResult.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800',
            ]"
          >
            {{ testResult.message }}
          </div>
        </div>
      </main>
    </div>
  </div>
</template>
