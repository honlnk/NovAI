<script setup lang="ts">
import { computed, ref } from 'vue'

import type { ConnectionTestResultView } from '@novai/core/services/types'
import PasswordInput from '../ui/PasswordInput.vue'
import { useSettingsStore } from '../../stores/settings'
import { getOrCreateClientId } from '../../utils/client-id'
import {
  SEARCH_PROVIDER_OPTIONS,
  applyProviderSwitch,
  findSearchProviderOption,
  type SearchSettingsForm,
} from '../../utils/search-settings'

/**
 * 联网搜索配置面板：四档搜索来源单选 + 端点字段（托管档零配置）+ 测试连接。
 * 表单为 reactive 对象引用，字段修改由父级 SettingsModal watch 后自动保存。
 */
const props = defineProps<{
  form: SearchSettingsForm
}>()

const settingsStore = useSettingsStore()

const activeOption = computed(() => findSearchProviderOption(props.form.provider))

const isTesting = ref(false)
const testResult = ref<ConnectionTestResultView | null>(null)

async function runTest() {
  isTesting.value = true
  testResult.value = null

  try {
    testResult.value = await settingsStore.testSearchConfig({
      provider: props.form.provider,
      baseUrl: props.form.baseUrl,
      apiKey: props.form.apiKey,
      webClientId: getOrCreateClientId(),
    })
  } finally {
    isTesting.value = false
  }
}
</script>

<template>
  <section aria-labelledby="search-settings-title">
    <h3 id="search-settings-title" class="text-base font-semibold text-gray-900">联网搜索</h3>
    <p class="mt-1 text-sm leading-relaxed text-gray-500">
      为 Agent 提供联网搜索（WebSearch）与网页抓取（WebFetch）能力。更改会自动保存。
    </p>

    <!-- 搜索来源：四档单选 -->
    <fieldset class="mt-4 space-y-2">
      <legend class="mb-1 block text-sm font-medium text-gray-700">搜索来源</legend>
      <label
        v-for="option in SEARCH_PROVIDER_OPTIONS"
        :key="option.value"
        class="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors"
        :class="
          form.provider === option.value
            ? 'border-gray-800 bg-gray-50'
            : 'border-gray-200 hover:bg-gray-50'
        "
      >
        <input
          v-model="form.provider"
          type="radio"
          name="search-provider"
          :value="option.value"
          class="mt-0.5 cursor-pointer"
          @change="applyProviderSwitch(form, option.value)"
        />
        <span>
          <span class="block text-sm font-medium text-gray-900">{{ option.label }}</span>
          <span class="mt-0.5 block text-xs leading-relaxed text-gray-500">{{ option.description }}</span>
        </span>
      </label>
    </fieldset>

    <!-- 端点字段：仅自部署 / 第三方档显示 -->
    <div v-if="activeOption.needsEndpoint" class="mt-4 space-y-4">
      <div>
        <label class="mb-1 block text-sm font-medium text-gray-700">服务地址</label>
        <input
          v-model="form.baseUrl"
          class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
          :placeholder="activeOption.baseUrlPlaceholder"
        />
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium text-gray-700">API Key</label>
        <PasswordInput v-model="form.apiKey" placeholder="sk-..." />
      </div>
    </div>

    <!-- 测试连接（四档通用；托管档测绿灯连通性） -->
    <div class="mt-4 flex flex-wrap gap-2 pt-1">
      <button
        type="button"
        class="cursor-pointer rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="isTesting"
        @click="runTest"
      >
        {{ isTesting ? '测试中…' : '测试连接' }}
      </button>
    </div>
    <div
      v-if="testResult"
      :class="['rounded-lg p-3 text-sm', testResult.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700']"
    >
      {{ testResult.message }}
    </div>
  </section>
</template>
