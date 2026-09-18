<script setup lang="ts">
import ToggleSwitch from '../ui/ToggleSwitch.vue'

/**
 * 项目设置面板：RAG / 对话的数值参数、写工具权限档位与调试开关。
 * 分组间用 border-t 分隔（照抄 gpt-image-studio 的面板内二级分区规范）。
 */
defineProps<{
  form: {
    ragCandidateLimit: number
    ragContextMaxItems: number
    conversationTokenLimit: number
    compressionKeepRecentTurns: number
    agentMaxTurns: number
    permissionPreset: 'review' | 'chapter' | 'material' | 'chapter-material' | 'full'
    enableDebugLogging: boolean
  }
}>()

/** 写工具权限五档（与 core/agent/permission.ts 的判定规则一一对应） */
const permissionPresetOptions = [
  { value: 'review', label: '仅审阅', hint: '任何修改都弹卡确认，批一次改一次' },
  { value: 'chapter', label: '章节内容', hint: '改 chapters/ 已有章节正文免确认，其余都问' },
  { value: 'material', label: '素材内容', hint: '改 elements/ 已有要素文件免确认，其余都问' },
  { value: 'chapter-material', label: '章节 + 素材', hint: '改章节与素材免确认，新建/删除/重命名与提示词修改都问' },
  { value: 'full', label: '完全访问', hint: '所有允许的修改都免确认（.novel/ 与项目配置仍永远禁改）' },
] as const
</script>

<template>
  <section aria-labelledby="project-settings-title">
    <h3 id="project-settings-title" class="text-base font-semibold text-gray-900">项目设置</h3>
    <p class="mt-1 text-sm leading-relaxed text-gray-500">
      生成上下文、RAG 检索与对话行为的项目级参数。更改会自动保存。
    </p>

    <div class="mt-4 space-y-4">
      <!-- RAG 设置 -->
      <div>
        <h4 class="text-sm font-semibold text-gray-900">RAG 设置</h4>
        <div class="mt-3 space-y-4">
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700">粗检索返回条数</label>
            <input
              v-model.number="form.ragCandidateLimit"
              type="number"
              min="1"
              max="100"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            />
            <p class="mt-1.5 text-xs text-gray-500">粗检索阶段返回的候选要素数量</p>
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700">上下文最大条数</label>
            <input
              v-model.number="form.ragContextMaxItems"
              type="number"
              min="1"
              max="50"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            />
            <p class="mt-1.5 text-xs text-gray-500">最终拼入生成上下文的最大要素数量</p>
          </div>
        </div>
      </div>

      <!-- 对话设置 -->
      <div class="border-t border-gray-200 pt-5">
        <h4 class="text-sm font-semibold text-gray-900">对话设置</h4>
        <div class="mt-3 space-y-4">
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700">对话上下文 Token 阈值</label>
            <input
              v-model.number="form.conversationTokenLimit"
              type="number"
              min="1000"
              max="200000"
              step="1000"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            />
            <p class="mt-1.5 text-xs text-gray-500">对话历史接近此 token 量时自动压缩：早期消息浓缩为检查点摘要，近期原文保留</p>
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700">压缩保留轮数</label>
            <input
              v-model.number="form.compressionKeepRecentTurns"
              type="number"
              min="1"
              max="20"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            />
            <p class="mt-1.5 text-xs text-gray-500">自动压缩时至少保留最近 N 轮对话的原文不进摘要</p>
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700">Agent 单轮最大循环次数</label>
            <input
              v-model.number="form.agentMaxTurns"
              type="number"
              min="1"
              max="50"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            />
            <p class="mt-1.5 text-xs text-gray-500">单轮内「模型调用 + 工具执行」的回合上限；达到上限会优雅停下，继续发消息可续接</p>
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700">写工具权限档位</label>
            <select
              v-model="form.permissionPreset"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            >
              <option
                v-for="option in permissionPresetOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
            <p class="mt-1.5 text-xs text-gray-500">
              {{ permissionPresetOptions.find((o) => o.value === form.permissionPreset)?.hint }}
            </p>
          </div>
          <div class="flex items-start justify-between gap-4 rounded-lg border border-gray-200 px-3 py-2.5">
            <div>
              <span class="block text-sm font-medium text-gray-900">开发调试日志</span>
              <p class="mt-0.5 text-xs text-gray-500">记录模型配置、请求摘要和工具调用解析诊断；正式使用建议关闭</p>
            </div>
            <ToggleSwitch v-model="form.enableDebugLogging" />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
