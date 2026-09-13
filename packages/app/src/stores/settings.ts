import { ref } from 'vue'
import { defineStore } from 'pinia'

import {
  getConfig,
  testCompletion,
  testEmbedding,
  testLlm,
  testRerank,
  updateConfig,
} from '@novai/core/services/settings-service'
import type {
  CompletionConfigView,
  ConnectionTestResultView,
  EmbeddingConfigView,
  LlmConfigView,
  ProjectConfigPatch,
  ProjectConfigView,
  RerankConfigView,
} from '@novai/core/services/types'

export const useSettingsStore = defineStore('settings', () => {
  const config = ref<ProjectConfigView | null>(null)
  const isBusy = ref(false)
  const errorMessage = ref('')
  const statusMessage = ref('等待打开项目')
  const lastConnectionTest = ref<ConnectionTestResultView | null>(null)

  async function loadSettings(projectId: string) {
    return runSettingsAction(async () => {
      const nextConfig = await getConfig(projectId)

      config.value = nextConfig
      statusMessage.value = '项目配置已载入'

      return {
        config: nextConfig,
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

  async function testLlmConfig(input: LlmConfigView) {
    return runConnectionTest(() => testLlm(input))
  }

  async function testEmbeddingConfig(input: EmbeddingConfigView) {
    return runConnectionTest(() => testEmbedding(input))
  }

  async function testRerankConfig(input: Pick<RerankConfigView, 'baseUrl' | 'apiKey' | 'model'>) {
    return runConnectionTest(() => testRerank(input))
  }

  async function testCompletionConfig(
    input: Pick<CompletionConfigView, 'baseUrl' | 'apiKey' | 'model'>,
  ) {
    return runConnectionTest(() => testCompletion(input))
  }

  function resetSettings() {
    config.value = null
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
    loadSettings,
    resetSettings,
    saveConfig,
    testCompletionConfig,
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
