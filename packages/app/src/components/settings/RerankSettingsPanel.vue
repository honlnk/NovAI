<script setup lang="ts">
import ModelEndpointFields from './ModelEndpointFields.vue'
import ToggleSwitch from '../ui/ToggleSwitch.vue'

/**
 * Rerank 配置面板：重排序模型（两阶段检索的精排）。
 * 协议无需选择：阿里百炼地址自动走 DashScope 原生接口，其余地址走 Jina/Cohere 风格 /rerank。
 */
defineProps<{
  form: {
    enabled: boolean
    baseUrl: string
    apiKey: string
    model: string
    mode: 'text' | 'multimodal'
    topN: number
  }
}>()

const emit = defineEmits<{
  /** enabled 开关变化需要立即保存（不经防抖），由父级 flush 落盘 */
  'save-immediately': []
}>()
</script>

<template>
  <section aria-labelledby="rerank-settings-title">
    <h3 id="rerank-settings-title" class="text-base font-semibold text-gray-900">Rerank 配置</h3>
    <p class="mt-1 text-sm leading-relaxed text-gray-500">
      重排序模型，对 RAG 粗召回结果做二次精排。更改会自动保存。
    </p>

    <div class="mt-4 space-y-4">
      <div class="flex items-start justify-between gap-4 rounded-lg border border-gray-200 px-3 py-2.5">
        <div>
          <span class="block text-sm font-medium text-gray-900">启用 Rerank</span>
          <p class="mt-0.5 text-xs text-gray-500">关闭后直接使用粗召回排序</p>
        </div>
        <ToggleSwitch v-model="form.enabled" @update:model-value="emit('save-immediately')" />
      </div>

      <template v-if="form.enabled">
        <ModelEndpointFields :form="form" purpose="rerank" model-placeholder="qwen3-rerank / gte-rerank-v2" />

        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700">保留条数</label>
          <input
            v-model.number="form.topN"
            type="number"
            min="1"
            max="50"
            class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
          />
          <p class="mt-1.5 text-xs text-gray-500">精排后保留的候选要素数量</p>
        </div>

        <div class="rounded-lg bg-gray-50 px-3 py-2.5 text-xs leading-relaxed text-gray-600">
          协议会自动适配：阿里百炼地址（dashscope.aliyuncs.com）走 DashScope 原生接口，其余地址走
          Jina/Cohere 风格的 /rerank。注意 gte-rerank 已于 2026-05 下线，推荐使用 qwen3-rerank。
        </div>
      </template>
    </div>
  </section>
</template>
