<script setup lang="ts">
import { computed } from 'vue'

import { ELEMENT_MANAGER_PRESET_OPTIONS } from '../../constants/permission-presets'
import { reasoningEffortOptions } from '../../constants/reasoning-efforts'
import ModelEndpointFields from './ModelEndpointFields.vue'
import ToggleSwitch from '../ui/ToggleSwitch.vue'

/**
 * 要素管理员（要素管理子代理）配置面板（Phase 2 计划 W1）。
 *
 * 两项独立覆盖，缺省全部动态继承主 Agent 当前配置（每次委派时取值）：
 * - 模型覆盖：整理是高认知负荷任务（语义合并/去重/归位），常需要配比主对话更强的模型；
 * - 确认档位：裁剪三档（仅审阅/素材静默/完全静默，要素管理员只能写 elements/）。
 * 开关关闭 = 删除对应覆盖回退继承；模型覆盖四项填全才生效（残缺块由 core normalize 剔除）。
 */
const props = defineProps<{
  projectId: string
  form: {
    modelOverride: boolean
    baseUrl: string
    apiKey: string
    model: string
    protocol: 'openai' | 'openai-responses' | 'anthropic' | 'gemini'
    /** '' = 跟随主 Agent（缺省）；否则固定四档之一 */
    reasoningEffort: '' | 'off' | 'low' | 'high' | 'max'
    permissionOverride: boolean
    permissionPreset: 'review' | 'material' | 'full'
  }
}>()

const emit = defineEmits<{ 'save-immediately': [] }>()

/** 思考档选项 = 跟随主 Agent + 四档（按协议过滤 off，与输入区选择器同一份口径）。 */
const effortOptions = computed(() => [
  { value: '' as const, label: '跟随主 Agent', hint: '沿用主对话模型委派当时的思考档位' },
  ...reasoningEffortOptions(props.form.protocol, props.form.baseUrl),
])
</script>

<template>
  <section aria-labelledby="element-manager-settings-title">
    <h3 id="element-manager-settings-title" class="text-base font-semibold text-gray-900">要素管理</h3>
    <p class="mt-1 text-sm leading-relaxed text-gray-500">
      要素管理是一个专用子智能体：由主 Agent 委派，专门负责管理 elements/ 要素库；运行时自动注入
      prompts/ELEMENT.md 要素规范，无需手动配置提示词。
    </p>
    <p class="mt-1 text-xs text-gray-400">
      此处配置它的独立模型与确认档位；未开启的覆盖项自动跟随主 Agent 当前配置。更改会自动保存。
    </p>

    <div class="mt-4 space-y-4">
      <!-- 模型覆盖 -->
      <div class="border-t border-gray-100 pt-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <span class="block text-sm font-medium text-gray-900">独立模型配置</span>
            <p class="mt-0.5 text-xs text-gray-500">
              整理是高认知负荷任务，常需配更强的模型；关闭则跟随主 Agent 当前模型
            </p>
          </div>
          <ToggleSwitch
            v-model="form.modelOverride"
            label="独立模型配置"
            @update:model-value="emit('save-immediately')"
          />
        </div>

        <div v-if="form.modelOverride" class="mt-4 space-y-4">
          <ModelEndpointFields :form="form" purpose="llm" show-protocol />

          <!-- 思考档（独立于主 Agent 思考档；缺省跟随） -->
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700">思考强度</label>
            <select
              v-model="form.reasoningEffort"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            >
              <option
                v-for="option in effortOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
            <p class="mt-1.5 text-xs text-gray-500">
              {{ effortOptions.find((option) => option.value === form.reasoningEffort)?.hint }}
            </p>
          </div>
        </div>
      </div>

      <!-- 确认档位覆盖 -->
      <div class="border-t border-gray-100 pt-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <span class="block text-sm font-medium text-gray-900">独立确认档位</span>
            <p class="mt-0.5 text-xs text-gray-500">
              要素管理子智能体写文件时的确认策略；关闭则跟随主 Agent 档位
            </p>
          </div>
          <ToggleSwitch
            v-model="form.permissionOverride"
            label="独立确认档位"
            @update:model-value="emit('save-immediately')"
          />
        </div>

        <div v-if="form.permissionOverride" class="mt-3">
          <select
            v-model="form.permissionPreset"
            class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
          >
            <option
              v-for="option in ELEMENT_MANAGER_PRESET_OPTIONS"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
          <p class="mt-1.5 text-xs text-gray-500">
            {{ ELEMENT_MANAGER_PRESET_OPTIONS.find((option) => option.value === form.permissionPreset)?.hint }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
