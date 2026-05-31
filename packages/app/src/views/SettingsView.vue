<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useProjectStore } from '../stores/project'
import { useSettingsStore } from '../stores/settings'

const route = useRoute()
const router = useRouter()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()

const projectId = computed(() => route.params.id as string)
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
  proofreadChapterCount: 3,
  organizeChapterCount: 10,
  generationContextChapterCount: 3,
  rag粗检索返回条数: 20,
  rerank保留条数: 8,
  对话上下文Token上限: 8000,
  压缩保留轮数: 5,
})

const isTesting = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)

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
  }
})

function handleBack() {
  router.push(`/project/${projectId.value}`)
}

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
</script>

<template>
  <div class="flex h-screen flex-col bg-gray-50">
    <!-- 顶栏 -->
    <header class="flex items-center gap-4 border-b border-gray-200 bg-white px-6 py-4">
      <button
        class="flex items-center gap-2 text-sm text-gray-600 transition-colors hover:text-gray-900"
        @click="handleBack"
      >
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
        返回项目
      </button>
      <h1 class="text-lg font-semibold text-gray-900">项目设置</h1>
    </header>

    <!-- 选项卡 -->
    <div class="border-b border-gray-200 bg-white px-6">
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

    <!-- 内容区域 -->
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
            <input
              v-model="llmForm.apiKey"
              type="password"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
              class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
              :disabled="isTesting"
              @click="handleTestLlm"
            >
              {{ isTesting ? '测试中...' : '测试连接' }}
            </button>
            <button
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
            <input
              v-model="embeddingForm.apiKey"
              type="password"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
              class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
              :disabled="isTesting"
              @click="handleTestEmbedding"
            >
              {{ isTesting ? '测试中...' : '测试连接' }}
            </button>
            <button
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
              <input
                v-model="rerankForm.apiKey"
                type="password"
                class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
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
              class="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"
              @click="handleSaveRerank"
            >
              保存
            </button>
          </div>
        </div>

        <!-- 项目设置 -->
        <div v-if="activeTab === 'project'" class="space-y-4">
          <p class="text-sm text-gray-500">项目设置功能开发中...</p>
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
</template>
