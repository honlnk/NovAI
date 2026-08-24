<script setup lang="ts">
import ModelEndpointFields from './ModelEndpointFields.vue'
import ToggleSwitch from '../ui/ToggleSwitch.vue'

/**
 * 输入补全配置面板：对话输入框的 Copilot 式 ghost text（DeepSeek FIM）。
 */
defineProps<{
  form: {
    enabled: boolean
    baseUrl: string
    apiKey: string
    model: string
    debounceMs: number
    maxTokens: number
  }
}>()

const emit = defineEmits<{
  /** enabled 开关变化需要立即保存（不经防抖），由父级 flush 落盘 */
  'save-immediately': []
}>()
</script>

<template>
  <section aria-labelledby="completion-settings-title">
    <h3 id="completion-settings-title" class="text-base font-semibold text-gray-900">输入补全</h3>
    <p class="mt-1 text-sm leading-relaxed text-gray-500">
      对话输入框的 Copilot 式灰色补全建议（Tab 逐段接受），只服务于提示词编写。探索性功能，可随时关闭。更改会自动保存。
    </p>

    <div class="mt-4 space-y-4">
      <div class="flex items-start justify-between gap-4 rounded-lg border border-gray-200 px-3 py-2.5">
        <div>
          <span class="block text-sm font-medium text-gray-900">启用输入补全</span>
          <p class="mt-0.5 text-xs text-gray-500">关闭后输入框行为与原生完全一致</p>
        </div>
        <ToggleSwitch v-model="form.enabled" @update:model-value="emit('save-immediately')" />
      </div>

      <template v-if="form.enabled">
        <ModelEndpointFields
          :form="form"
          purpose="completion"
          base-url-hint="DeepSeek FIM 补全需带 /beta 前缀"
          model-placeholder="deepseek-chat"
        />

        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700">防抖时长（毫秒）</label>
          <input
            v-model.number="form.debounceMs"
            type="number"
            min="200"
            max="3000"
            step="100"
            class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
          />
          <p class="mt-1.5 text-xs text-gray-500">停顿该时长后才发起补全请求，平衡响应性与成本</p>
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700">单次最大 Token</label>
          <input
            v-model.number="form.maxTokens"
            type="number"
            min="16"
            max="256"
            class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
          />
          <p class="mt-1.5 text-xs text-gray-500">提示词补全不需要长，建议保持较小值以控制成本</p>
        </div>
      </template>
    </div>
  </section>
</template>
