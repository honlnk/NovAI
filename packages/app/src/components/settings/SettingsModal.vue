<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ProjectConfigView } from '@novai/core/services/types'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import PasswordInput from '../ui/PasswordInput.vue'

const props = defineProps<{
  projectId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const settingsStore = useSettingsStore()
const projectStore = useProjectStore()

const activeTab = ref<'llm' | 'embedding' | 'rerank' | 'completion' | 'project'>('llm')

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

const completionForm = ref({
  enabled: false,
  baseUrl: 'https://api.deepseek.com/beta',
  apiKey: '',
  model: 'deepseek-chat',
  debounceMs: 600,
  maxTokens: 64,
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
    if (settingsStore.config.completion) {
      completionForm.value = {
        enabled: settingsStore.config.completion.enabled ?? false,
        baseUrl: settingsStore.config.completion.baseUrl ?? 'https://api.deepseek.com/beta',
        apiKey: settingsStore.config.completion.apiKey ?? '',
        model: settingsStore.config.completion.model ?? 'deepseek-chat',
        debounceMs: settingsStore.config.completion.debounceMs ?? 600,
        maxTokens: settingsStore.config.completion.maxTokens ?? 64,
      }
    }
    if (settingsStore.config.settings) {
      applyProjectSettings(settingsStore.config.settings)
    }
  }
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
  const saved = await settingsStore.saveConfig(projectId.value, { llm: llmForm.value })
  syncCurrentProjectConfig(saved)
}

async function handleSaveEmbedding() {
  const saved = await settingsStore.saveConfig(projectId.value, { embedding: embeddingForm.value })
  syncCurrentProjectConfig(saved)
}

async function handleSaveRerank() {
  const saved = await settingsStore.saveConfig(projectId.value, { rerank: rerankForm.value })
  syncCurrentProjectConfig(saved)
}

async function handleSaveCompletion() {
  const saved = await settingsStore.saveConfig(projectId.value, { completion: completionForm.value })
  syncCurrentProjectConfig(saved)
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
  syncCurrentProjectConfig(savedConfig)
  testResult.value = {
    ok: true,
    message: '项目设置已保存',
  }
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
              { key: 'completion', label: '输入补全' },
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

          <!-- 输入补全配置 -->
          <div v-if="activeTab === 'completion'" class="space-y-4">
            <div class="flex items-center gap-3">
              <label class="text-sm font-medium text-gray-700">启用输入补全</label>
              <button
                :class="[
                  'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                  completionForm.enabled ? 'bg-gray-900' : 'bg-gray-300',
                ]"
                @click="completionForm.enabled = !completionForm.enabled"
              >
                <span
                  :class="[
                    'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                    completionForm.enabled ? 'translate-x-6' : 'translate-x-1',
                  ]"
                />
              </button>
            </div>
            <div v-if="completionForm.enabled" class="space-y-4">
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-700">API 地址</label>
                <p class="mb-1 text-xs text-gray-500">DeepSeek FIM 补全需带 /beta，如 https://api.deepseek.com/beta</p>
                <input
                  v-model="completionForm.baseUrl"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="https://api.deepseek.com/beta"
                />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-700">API Key</label>
                <PasswordInput v-model="completionForm.apiKey" placeholder="sk-..." />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-700">模型名称</label>
                <input
                  v-model="completionForm.model"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="deepseek-chat"
                />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-700">防抖时长（毫秒）</label>
                <p class="mb-1 text-xs text-gray-500">停顿该时长后才发起补全请求，平衡响应性与成本</p>
                <input
                  v-model.number="completionForm.debounceMs"
                  type="number"
                  min="200"
                  max="3000"
                  step="100"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-gray-700">单次最大 Token</label>
                <p class="mb-1 text-xs text-gray-500">提示词补全不需要长，建议保持较小值以控制成本</p>
                <input
                  v-model.number="completionForm.maxTokens"
                  type="number"
                  min="16"
                  max="256"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
            <div class="pt-2">
              <button
                type="button"
                class="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
                @click="handleSaveCompletion"
              >
                保存
              </button>
            </div>
          </div>

          <!-- 项目设置 -->
          <div v-if="activeTab === 'project'" class="space-y-6">
            <!-- 生成设置 -->
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
