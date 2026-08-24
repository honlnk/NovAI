<script setup lang="ts">
import ModelEndpointFields from './ModelEndpointFields.vue'

/**
 * Embedding 配置面板：向量化模型（RAG 索引构建）。
 * 协议业界已统一为 OpenAI 兼容（阿里百炼 compatible-mode 同样兼容），无需协议选择。
 */
defineProps<{
  form: {
    baseUrl: string
    apiKey: string
    model: string
  }
}>()
</script>

<template>
  <section aria-labelledby="embedding-settings-title">
    <h3 id="embedding-settings-title" class="text-base font-semibold text-gray-900">Embedding 配置</h3>
    <p class="mt-1 text-sm leading-relaxed text-gray-500">
      向量化模型，用于构建要素的 RAG 索引。协议为 OpenAI 兼容（阿里百炼填 compatible-mode 地址即可）。更改会自动保存。
    </p>
    <div class="mt-4">
      <ModelEndpointFields :form="form" purpose="embedding" model-placeholder="text-embedding-v4" />
    </div>
  </section>
</template>
