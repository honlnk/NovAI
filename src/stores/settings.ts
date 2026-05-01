import { ref } from 'vue'
import { defineStore } from 'pinia'

import {
  getConfig,
  readSystemPrompt,
  testEmbedding,
  testLlm,
  testRerank,
  updateConfig,
  writeSystemPrompt,
} from '../services/settings-service'
import type {
  ConnectionTestResultView,
  EmbeddingConfigView,
  LlmConfigView,
  ProjectConfigPatch,
  ProjectConfigView,
  RerankConfigView,
} from '../services/types'

export const useSettingsStore = defineStore('settings', () => {
  const config = ref<ProjectConfigView | null>(null)
  const systemPrompt = ref('')
  const isBusy = ref(false)
  const errorMessage = ref('')
  const statusMessage = ref('等待打开项目')
  const lastConnectionTest = ref<ConnectionTestResultView | null>(null)

  async function loadSettings(projectId: string) {
    return runSettingsAction(async () => {
      const [nextConfig, nextSystemPrompt] = await Promise.all([
        getConfig(projectId),
        readSystemPrompt(projectId),
      ])

      config.value = nextConfig
      systemPrompt.value = nextSystemPrompt
      statusMessage.value = '项目配置已载入'

      return {
        config: nextConfig,
        systemPrompt: nextSystemPrompt,
      }
    })
  }

  async function saveConfig(projectId: string, patch: ProjectConfigPatch) {
    return runSettingsAction(async () => {
      const savedConfig = await updateConfig(projectId, patch)

      config.value = savedConfig
      statusMessage.value = '项目配置已保存'

      return savedConfig
    })
  }

  async function saveSystemPrompt(projectId: string, content: string) {
    return runSettingsAction(async () => {
      await writeSystemPrompt(projectId, content)
      systemPrompt.value = content
      statusMessage.value = '系统提示词已保存'
    })
  }

  async function testLlmConfig(input: LlmConfigView) {
    return runConnectionTest(() => testLlm(input))
  }

  async function testEmbeddingConfig(input: EmbeddingConfigView) {
    return runConnectionTest(() => testEmbedding(input))
  }

  async function testRerankConfig(input: RerankConfigView) {
    return runConnectionTest(() => testRerank(input))
  }

  function resetSettings() {
    config.value = null
    systemPrompt.value = ''
    lastConnectionTest.value = null
    errorMessage.value = ''
    statusMessage.value = '等待打开项目'
  }

  async function runConnectionTest(action: () => Promise<ConnectionTestResultView>) {
    return runSettingsAction(async () => {
      const result = await action()

      lastConnectionTest.value = result
      statusMessage.value = result.message

      return result
    })
  }

  async function runSettingsAction<T>(action: () => Promise<T>) {
    errorMessage.value = ''
    isBusy.value = true

    try {
      return await action()
    } catch (error) {
      errorMessage.value = toMessage(error, '设置操作失败')
      return null
    } finally {
      isBusy.value = false
    }
  }

  return {
    config,
    errorMessage,
    isBusy,
    lastConnectionTest,
    statusMessage,
    systemPrompt,
    loadSettings,
    resetSettings,
    saveConfig,
    saveSystemPrompt,
    testEmbeddingConfig,
    testLlmConfig,
    testRerankConfig,
  }
})

function toMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message
  }

  return fallback
}
