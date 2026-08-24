<script setup lang="ts">
import ToggleSwitch from '../ui/ToggleSwitch.vue'

/**
 * 项目设置面板：生成 / RAG / 对话 / 校对整理的数值参数与调试开关。
 * 分组间用 border-t 分隔（照抄 gpt-image-studio 的面板内二级分区规范）。
 */
defineProps<{
  form: {
    proofreadDefaultChapters: number
    organizeDefaultChapters: number
    generationRecentChapters: number
    ragCandidateLimit: number
    ragContextMaxItems: number
    conversationTokenLimit: number
    compressionKeepRecentTurns: number
    enableDebugLogging: boolean
  }
}>()
</script>

<template>
  <section aria-labelledby="project-settings-title">
    <h3 id="project-settings-title" class="text-base font-semibold text-gray-900">项目设置</h3>
    <p class="mt-1 text-sm leading-relaxed text-gray-500">
      生成上下文、RAG 检索与对话行为的项目级参数。更改会自动保存。
    </p>

    <div class="mt-4 space-y-4">
      <!-- 生成设置 -->
      <div>
        <h4 class="text-sm font-semibold text-gray-900">生成设置</h4>
        <div class="mt-3 space-y-4">
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700">生成上下文章节数</label>
            <input
              v-model.number="form.generationRecentChapters"
              type="number"
              min="0"
              max="20"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            />
            <p class="mt-1.5 text-xs text-gray-500">生成时携带最近 N 章的原文作为上下文</p>
          </div>
        </div>
      </div>

      <!-- RAG 设置 -->
      <div class="border-t border-gray-200 pt-5">
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
            <label class="mb-1 block text-sm font-medium text-gray-700">对话上下文 Token 上限</label>
            <input
              v-model.number="form.conversationTokenLimit"
              type="number"
              min="1000"
              max="200000"
              step="1000"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            />
            <p class="mt-1.5 text-xs text-gray-500">接近上限时触发上下文压缩</p>
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
            <p class="mt-1.5 text-xs text-gray-500">上下文压缩时保留最近 N 轮对话的原文</p>
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

      <!-- 校对与整理 -->
      <div class="border-t border-gray-200 pt-5">
        <h4 class="text-sm font-semibold text-gray-900">校对与整理</h4>
        <div class="mt-3 space-y-4">
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700">校对默认章节数</label>
            <input
              v-model.number="form.proofreadDefaultChapters"
              type="number"
              min="1"
              max="50"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            />
            <p class="mt-1.5 text-xs text-gray-500">自动校对最近 N 章</p>
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700">整理默认章节数</label>
            <input
              v-model.number="form.organizeDefaultChapters"
              type="number"
              min="1"
              max="50"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            />
            <p class="mt-1.5 text-xs text-gray-500">自动整理最近 N 章</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
