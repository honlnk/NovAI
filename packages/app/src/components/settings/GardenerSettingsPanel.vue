<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { getGardenerPresets, saveGardenerPresets } from '@novai/core/services/settings-service'
import type { GardenerPresetView } from '@novai/core/services/types'
import { GARDENER_PRESET_OPTIONS } from '../../constants/permission-presets'
import { reasoningEffortOptions } from '../../constants/reasoning-efforts'
import ModelEndpointFields from './ModelEndpointFields.vue'
import ToggleSwitch from '../ui/ToggleSwitch.vue'

/**
 * 园丁（要素整理子代理）配置面板（Phase 2 计划 W1）。
 *
 * 两项独立覆盖，缺省全部动态继承主 Agent 当前配置（每次委派时取值）：
 * - 模型覆盖：整理是高认知负荷任务（语义合并/去重/归位），常需要配比主对话更强的模型；
 * - 确认档位：裁剪三档（仅审阅/素材静默/完全静默，园丁只能写 elements/）。
 * 开关关闭 = 删除对应覆盖回退继承；模型覆盖四项填全才生效（残缺块由 core normalize 剔除）。
 *
 * 任务快捷选项（要素整理参数化 W2）走独立读写链（.novai/gardener-presets.json，
 * 不在 novel.config.json），编辑即写文件——文件小，不做防抖。
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

// ===== 任务快捷选项（要素整理参数化 W2） =====

const presets = ref<GardenerPresetView[]>([])
const presetError = ref('')
/** 编辑器状态：null = 列表态；index 为 -1 表示新建，>=0 为编辑既有项 */
const presetEditor = ref<{ index: number; label: string; prompt: string } | null>(null)

onMounted(async () => {
  try {
    presets.value = await getGardenerPresets(props.projectId)
  } catch {
    // 读取失败降级为空列表（fs 层已把文件缺失/损坏容错为空，这里只兜 service 层异常）
    presets.value = []
  }
})

function startCreatePreset() {
  presetEditor.value = { index: -1, label: '', prompt: '' }
  presetError.value = ''
}

function startEditPreset(index: number) {
  const preset = presets.value[index]
  presetEditor.value = { index, label: preset.label, prompt: preset.prompt }
  presetError.value = ''
}

async function savePresetEditor() {
  const editor = presetEditor.value
  if (!editor) return
  if (!editor.label.trim() || !editor.prompt.trim()) {
    presetError.value = '名称与提示语都需填写'
    return
  }
  const next = presets.value.map((preset) => ({ ...preset }))
  const item = { label: editor.label, prompt: editor.prompt }
  if (editor.index === -1) {
    next.push(item)
  } else {
    next[editor.index] = item
  }
  try {
    presets.value = await saveGardenerPresets(props.projectId, next)
    presetEditor.value = null
    presetError.value = ''
  } catch {
    presetError.value = '保存失败，请重试'
  }
}

async function removePreset(index: number) {
  try {
    presets.value = await saveGardenerPresets(
      props.projectId,
      presets.value.filter((_, i) => i !== index),
    )
  } catch {
    presetError.value = '删除失败，请重试'
  }
}
</script>

<template>
  <section aria-labelledby="gardener-settings-title">
    <h3 id="gardener-settings-title" class="text-base font-semibold text-gray-900">要素整理</h3>
    <p class="mt-1 text-sm leading-relaxed text-gray-500">
      要素整理是一个专用子智能体：由主 Agent 委派，专门负责整理 elements/ 要素库；运行时自动注入
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
              要素整理子智能体写文件时的确认策略；关闭则跟随主 Agent 档位
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
              v-for="option in GARDENER_PRESET_OPTIONS"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
          <p class="mt-1.5 text-xs text-gray-500">
            {{ GARDENER_PRESET_OPTIONS.find((option) => option.value === form.permissionPreset)?.hint }}
          </p>
        </div>
      </div>

      <!-- 任务快捷选项（要素整理参数化 W2）：.novai/gardener-presets.json 独立读写，编辑即写文件 -->
      <div class="border-t border-gray-100 pt-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <span class="block text-sm font-medium text-gray-900">任务快捷选项</span>
            <p class="mt-0.5 text-xs text-gray-500">
              「整理要素」弹窗中可勾选，勾选项会作为任务要求拼进委派消息；保存立即生效
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 cursor-pointer rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
            @click="startCreatePreset"
          >
            新建选项
          </button>
        </div>

        <ul v-if="presets.length > 0" class="mt-3 space-y-1.5">
          <li
            v-for="(preset, index) in presets"
            :key="`${preset.label}-${index}`"
            class="flex items-center gap-2 rounded-lg border border-gray-100 px-3 py-2"
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-gray-800">{{ preset.label }}</span>
              <span class="block truncate text-xs text-gray-400">{{ preset.prompt }}</span>
            </span>
            <button
              type="button"
              class="shrink-0 cursor-pointer rounded-lg px-2 py-1 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
              @click="startEditPreset(index)"
            >
              编辑
            </button>
            <button
              type="button"
              class="shrink-0 cursor-pointer rounded-lg px-2 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-50 hover:text-red-600"
              @click="removePreset(index)"
            >
              删除
            </button>
          </li>
        </ul>
        <p v-else class="mt-3 rounded-lg border border-dashed border-gray-200 px-3 py-3 text-center text-xs text-gray-400">
          还没有快捷选项；新建后可在弹窗中一键附加常用任务要求
        </p>

        <!-- 编辑器（新建/编辑共用） -->
        <div v-if="presetEditor" class="mt-3 space-y-2 rounded-lg border border-gray-200 p-3">
          <input
            v-model="presetEditor.label"
            type="text"
            class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            placeholder="选项名称（如：只更新变更章节）"
          >
          <textarea
            v-model="presetEditor.prompt"
            rows="2"
            class="w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            placeholder="勾选后拼进任务消息的提示语"
          />
          <p v-if="presetError" class="text-xs text-red-500">{{ presetError }}</p>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100"
              @click="presetEditor = null"
            >
              取消
            </button>
            <button
              type="button"
              class="cursor-pointer rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-gray-700"
              @click="savePresetEditor"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
