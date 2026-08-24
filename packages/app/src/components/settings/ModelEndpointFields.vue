<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { listModels } from '@novai/core/services/settings-service'
import type {
  ConnectionTestResultView,
  ListModelsResultView,
  ModelListPurposeView,
} from '@novai/core/services/types'
import PasswordInput from '../ui/PasswordInput.vue'
import { useSettingsStore } from '../../stores/settings'

/**
 * 模型端点配置的共享字段组（借鉴 duet 的模型配置交互）。
 *
 * 覆盖：API 协议选择（可选，仅 LLM）、API 地址、API Key、模型名。
 * 模型名支持「获取列表」拉取下拉选择（按用途过滤 + 显示全部切换），手输永远允许。
 * 同时提供统一的「测试连接」按钮（基于拉取模型列表实现）。
 *
 * form 为 reactive 对象引用，字段修改由父级面板 watch 后自动保存。
 */
const props = defineProps<{
  form: {
    baseUrl: string
    apiKey: string
    model: string
    protocol?: 'openai' | 'openai-responses' | 'anthropic' | 'gemini'
  }
  purpose: ModelListPurposeView
  /** 是否显示 API 协议选择（仅 LLM 配置使用） */
  showProtocol?: boolean
  baseUrlPlaceholder?: string
  baseUrlHint?: string
  apiKeyPlaceholder?: string
  modelPlaceholder?: string
}>()

const settingsStore = useSettingsStore()
const router = useRouter()

/** embedding / rerank 有内置模型说明文档页可跳转。 */
const isModelDocsSupported = computed(
  () => props.purpose === 'embedding' || props.purpose === 'rerank',
)

/** 协议选项三合一：切换协议时联动替换默认地址（不覆盖用户自定义地址）。 */
const PROTOCOL_OPTIONS = [
  { value: 'openai' as const, label: 'OpenAI 兼容', baseUrl: 'https://api.deepseek.com/v1' },
  { value: 'openai-responses' as const, label: 'OpenAI Responses', baseUrl: 'https://api.openai.com/v1' },
  { value: 'anthropic' as const, label: 'Anthropic', baseUrl: 'https://api.anthropic.com' },
  { value: 'gemini' as const, label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
]

const modelFieldRef = ref<HTMLElement | null>(null)
const isLoadingModels = ref(false)
const modelsResult = ref<ListModelsResultView | null>(null)
const modelsError = ref('')
const isDropdownOpen = ref(false)
const showAllModels = ref(false)

const isTesting = ref(false)
const testResult = ref<ConnectionTestResultView | null>(null)

/** 生成链路仅实现 openai（Chat Completions 兼容），其余协议需提示。 */
const isNonChatCompletionsProtocol = computed(
  () => props.showProtocol && props.form.protocol && props.form.protocol !== 'openai',
)

const activeProtocolLabel = computed(
  () => PROTOCOL_OPTIONS.find((option) => option.value === props.form.protocol)?.label ?? '',
)

/** 下拉展示的模型：默认按用途过滤，可切换全量；再按输入内容做子串过滤。 */
const visibleModels = computed(() => {
  if (!modelsResult.value) {
    return []
  }

  const source = showAllModels.value ? modelsResult.value.models : modelsResult.value.filtered
  const keyword = props.form.model.trim().toLowerCase()

  if (!keyword) {
    return source
  }

  return source.filter((model) => model.toLowerCase().includes(keyword))
})

const hasFilteredDifference = computed(
  () =>
    modelsResult.value !== null &&
    modelsResult.value.models.length !== modelsResult.value.filtered.length,
)

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentMouseDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleDocumentMouseDown)
})

function handleDocumentMouseDown(event: MouseEvent) {
  if (modelFieldRef.value && !modelFieldRef.value.contains(event.target as Node)) {
    isDropdownOpen.value = false
  }
}

/**
 * 协议切换联动：当前地址为空或等于任一协议默认地址时，替换为新协议默认地址。
 * 用户自定义的地址（如中转站）不会被覆盖。
 */
function onProtocolChange() {
  const currentBaseUrl = props.form.baseUrl.trim()
  const isDefaultUrl =
    !currentBaseUrl || PROTOCOL_OPTIONS.some((option) => option.baseUrl === currentBaseUrl)

  if (!isDefaultUrl) {
    return
  }

  const next = PROTOCOL_OPTIONS.find((option) => option.value === props.form.protocol)
  if (next) {
    props.form.baseUrl = next.baseUrl
  }
}

async function loadModels() {
  modelsError.value = ''

  if (!props.form.baseUrl.trim()) {
    modelsError.value = '请先填写 API 地址'
    return
  }

  if (!props.form.apiKey.trim()) {
    modelsError.value = '请先填写 API Key'
    return
  }

  isLoadingModels.value = true
  modelsResult.value = null

  try {
    const result = await listModels({
      baseUrl: props.form.baseUrl,
      apiKey: props.form.apiKey,
      protocol: props.showProtocol ? props.form.protocol : undefined,
      purpose: props.purpose,
    })

    modelsResult.value = result
    showAllModels.value = false
    isDropdownOpen.value = true

    if (result.models.length === 0) {
      modelsError.value = '上游未返回任何模型'
    }
  } catch (error) {
    modelsError.value = error instanceof Error ? error.message : '拉取模型列表失败'
  } finally {
    isLoadingModels.value = false
  }
}

function pickModel(model: string) {
  props.form.model = model
  isDropdownOpen.value = false
}

function openModelDocs() {
  window.open(router.resolve({ name: 'model-docs' }).href, '_blank')
}

async function runTest() {
  isTesting.value = true
  testResult.value = null

  try {
    const input = {
      baseUrl: props.form.baseUrl,
      apiKey: props.form.apiKey,
      model: props.form.model,
    }

    if (props.purpose === 'llm') {
      testResult.value = await settingsStore.testLlmConfig({ ...input, protocol: props.form.protocol ?? 'openai' })
    } else if (props.purpose === 'embedding') {
      testResult.value = await settingsStore.testEmbeddingConfig(input)
    } else if (props.purpose === 'rerank') {
      testResult.value = await settingsStore.testRerankConfig(input)
    } else {
      testResult.value = await settingsStore.testCompletionConfig(input)
    }
  } finally {
    isTesting.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- API 协议（仅 LLM） -->
    <div v-if="showProtocol">
      <label class="mb-1 block text-sm font-medium text-gray-700">API 协议</label>
      <select
        v-model="form.protocol"
        class="w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
        @change="onProtocolChange"
      >
        <option v-for="option in PROTOCOL_OPTIONS" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <p class="mt-1.5 text-xs text-gray-500">决定拉取模型列表与测试连接的接口形态</p>
    </div>

    <!-- 非 Chat Completions 协议提示：生成链路尚未适配 -->
    <div v-if="isNonChatCompletionsProtocol" class="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
      对话生成链路暂仅支持 OpenAI 兼容协议；选择 {{ activeProtocolLabel }}
      协议后可正常拉取模型列表与测试连接，但 Agent 生成仍需使用 OpenAI 兼容的服务。
    </div>

    <!-- API 地址 -->
    <div>
      <label class="mb-1 block text-sm font-medium text-gray-700">API 地址</label>
      <input
        v-model="form.baseUrl"
        class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
        :placeholder="baseUrlPlaceholder ?? 'https://api.deepseek.com/v1'"
      />
      <p v-if="baseUrlHint" class="mt-1.5 text-xs text-gray-500">{{ baseUrlHint }}</p>
    </div>

    <!-- API Key -->
    <div>
      <label class="mb-1 block text-sm font-medium text-gray-700">API Key</label>
      <PasswordInput v-model="form.apiKey" :placeholder="apiKeyPlaceholder ?? 'sk-...'" />
    </div>

    <!-- 模型名 + 获取列表 -->
    <div ref="modelFieldRef" class="relative">
      <div class="mb-1 flex items-center justify-between">
        <label class="block text-sm font-medium text-gray-700">模型名称</label>
        <div class="flex items-center gap-1">
          <button
            v-if="isModelDocsSupported"
            type="button"
            class="rounded-lg px-2 py-1 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
            @click="openModelDocs"
          >
            模型说明
          </button>
          <button
            type="button"
            class="rounded-lg px-2 py-1 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isLoadingModels"
            @click="loadModels"
          >
            <svg v-if="isLoadingModels" class="mr-1 inline-block h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {{ isLoadingModels ? '获取中…' : '获取列表' }}
          </button>
        </div>
      </div>
      <div class="flex rounded-lg border border-gray-300 bg-white focus-within:border-gray-500">
        <input
          v-model="form.model"
          class="min-w-0 flex-1 rounded-l-lg bg-transparent px-3 py-2 text-sm text-gray-900 outline-none"
          :placeholder="modelPlaceholder ?? '可手输，或点击右上「获取列表」选择'"
          @focus="modelsResult && (isDropdownOpen = true)"
        />
      </div>
      <p v-if="modelsError" class="mt-1.5 text-xs text-red-600">{{ modelsError }}</p>
      <p v-else-if="modelsResult?.source === 'builtin'" class="mt-1.5 text-xs text-gray-500">
        已列出百炼推荐模型 {{ modelsResult.models.length }} 个（百炼接口不提供此类模型列表，清单由 NovAI 维护，
        详见「模型说明」）
      </p>
      <p v-else-if="modelsResult" class="mt-1.5 text-xs text-gray-500">
        已获取 {{ modelsResult.models.length }} 个模型，可从下拉选择或手动输入
      </p>

      <!-- 模型下拉浮层 -->
      <div
        v-if="isDropdownOpen && modelsResult"
        class="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
      >
        <div class="flex items-center justify-between border-b border-gray-100 px-3 py-2">
          <span class="text-xs text-gray-500">共 {{ visibleModels.length }} 个可选</span>
          <button
            v-if="hasFilteredDifference"
            type="button"
            class="text-xs font-medium text-gray-500 hover:text-gray-800"
            @click="showAllModels = !showAllModels"
          >
            {{ showAllModels ? '只看本配置相关' : `显示全部 ${modelsResult.models.length} 个` }}
          </button>
        </div>
        <div class="max-h-56 overflow-y-auto">
          <button
            v-for="model in visibleModels"
            :key="model"
            type="button"
            class="block w-full cursor-pointer px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50"
            @mousedown.prevent="pickModel(model)"
          >
            {{ model }}
          </button>
          <p v-if="visibleModels.length === 0" class="px-3 py-3 text-sm text-gray-400">
            未找到匹配的模型，可手动输入或切换显示全部
          </p>
        </div>
      </div>
    </div>

    <!-- 测试连接 -->
    <div class="flex flex-wrap gap-2 pt-1">
      <button
        type="button"
        class="cursor-pointer rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="isTesting"
        @click="runTest"
      >
        {{ isTesting ? '测试中…' : '测试连接' }}
      </button>
    </div>

    <!-- 测试结果 -->
    <div
      v-if="testResult"
      :class="['rounded-lg p-3 text-sm', testResult.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700']"
    >
      {{ testResult.message }}
    </div>
  </div>
</template>
