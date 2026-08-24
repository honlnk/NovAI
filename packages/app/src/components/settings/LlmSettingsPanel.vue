<script setup lang="ts">
import ModelEndpointFields from './ModelEndpointFields.vue'

/**
 * LLM 配置面板：主对话模型（Agent 章节生成与工具调用）。
 * 支持协议选择；表单修改由父级 SettingsModal 自动保存。
 */
defineProps<{
  form: {
    baseUrl: string
    apiKey: string
    model: string
    protocol: 'openai' | 'openai-responses' | 'anthropic' | 'gemini'
  }
}>()
</script>

<template>
  <section aria-labelledby="llm-settings-title">
    <h3 id="llm-settings-title" class="text-base font-semibold text-gray-900">LLM 配置</h3>
    <p class="mt-1 text-sm leading-relaxed text-gray-500">
      主对话模型，驱动 Agent 的章节生成与工具调用。更改会自动保存。
    </p>
    <div class="mt-4">
      <ModelEndpointFields :form="form" purpose="llm" show-protocol />
    </div>
  </section>
</template>
