<script setup lang="ts">
import {
  DASHSCOPE_EMBEDDING_MODELS,
  DASHSCOPE_RERANK_MODELS,
} from '@novai/core/services/settings-service'
import type { DashScopeModelDoc } from '@novai/core/services/settings-service'

/**
 * 模型说明文档页（新标签页打开）。
 *
 * 面向普通用户，用通俗语言介绍设置页里 Embedding / Rerank 配置可选的模型。
 * 数据直接来自 core 的内置清单（dashscope-models.ts），列表与说明自动同步。
 */
const OFFICIAL_DOC_URL = 'https://help.aliyun.com/zh/model-studio/'

function copyModelId(model: DashScopeModelDoc) {
  window.navigator.clipboard?.writeText(model.id).catch(() => {})
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 py-10">
    <main class="mx-auto max-w-3xl px-6">
      <!-- 页头 -->
      <header>
        <h1 class="text-2xl font-semibold text-gray-900">模型说明 · 阿里云百炼</h1>
        <p class="mt-2 text-sm leading-relaxed text-gray-500">
          这是 NovAI 内置的模型介绍页，帮你理解设置里 Embedding 和 Rerank 该怎么选。
          本页在新标签页打开，看完直接关闭即可。
        </p>
      </header>

      <!-- 这两个配置是干什么的 -->
      <section class="mt-8 rounded-xl border border-gray-200 bg-white p-5">
        <h2 class="text-base font-semibold text-gray-900">先说清楚：这两个配置是干什么的？</h2>
        <div class="mt-3 space-y-3 text-sm leading-relaxed text-gray-700">
          <p>
            <span class="font-medium text-gray-900">Embedding（向量化）</span>：把人物、地点、剧情这些设定
            「翻译」成一串数字（向量），让电脑能按意思找到它们。NovAI 靠它实现「写到某个人物时，
            自动把相关设定找出来给 AI 参考」。它决定的是<strong>找得全不全</strong>。
          </p>
          <p>
            <span class="font-medium text-gray-900">Rerank（重排序）</span>：Embedding 找回来的结果可能混着
            不太相关的，Rerank 负责「二次精选」，把最相关的排到最前面。它决定的是<strong>排得准不准</strong>，
            是可选配置——不开也能用，开了长篇创作时上下文质量更稳。
          </p>
        </div>
        <div class="mt-4 rounded-lg bg-gray-50 px-3 py-2.5 text-sm text-gray-600">
          一句话建议：Embedding 选 <code class="rounded bg-gray-200 px-1.5 py-0.5 text-xs">text-embedding-v4</code>
          或 <code class="rounded bg-gray-200 px-1.5 py-0.5 text-xs">qwen3.7-text-embedding</code>，
          Rerank 选 <code class="rounded bg-gray-200 px-1.5 py-0.5 text-xs">qwen3-rerank</code>。
        </div>
      </section>

      <!-- Embedding 模型 -->
      <section class="mt-8">
        <h2 class="text-lg font-semibold text-gray-900">Embedding · 向量模型</h2>
        <p class="mt-1 text-sm text-gray-500">按从新到旧排列，一般选最新的就行</p>
        <div class="mt-4 space-y-4">
          <article
            v-for="model in DASHSCOPE_EMBEDDING_MODELS"
            :key="model.id"
            class="rounded-xl border border-gray-200 bg-white p-5"
          >
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="text-base font-semibold text-gray-900">{{ model.name }}</h3>
              <span
                v-if="model.recommended"
                class="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800"
              >
                推荐
              </span>
              <button
                type="button"
                title="点击复制模型 ID"
                class="cursor-pointer rounded-md bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-700 transition-colors hover:bg-gray-200"
                @click="copyModelId(model)"
              >
                {{ model.id }}
              </button>
            </div>
            <p class="mt-2 text-sm font-medium text-gray-800">{{ model.summary }}</p>
            <p class="mt-1.5 text-sm leading-relaxed text-gray-600">{{ model.description }}</p>
            <ul class="mt-3 space-y-1">
              <li v-for="spec in model.specs" :key="spec" class="flex gap-2 text-xs text-gray-500">
                <span class="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-gray-400" />
                <span>{{ spec }}</span>
              </li>
            </ul>
          </article>
        </div>
      </section>

      <!-- Rerank 模型 -->
      <section class="mt-8">
        <h2 class="text-lg font-semibold text-gray-900">Rerank · 重排序模型</h2>
        <p class="mt-1 text-sm text-gray-500">负责把检索结果按相关度重新排序</p>
        <div class="mt-4 space-y-4">
          <article
            v-for="model in DASHSCOPE_RERANK_MODELS"
            :key="model.id"
            :class="[
              'rounded-xl border bg-white p-5',
              model.deprecated ? 'border-gray-100 opacity-70' : 'border-gray-200',
            ]"
          >
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="text-base font-semibold text-gray-900">{{ model.name }}</h3>
              <span
                v-if="model.recommended"
                class="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800"
              >
                推荐
              </span>
              <span
                v-if="model.deprecated"
                class="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"
              >
                已下线
              </span>
              <button
                type="button"
                title="点击复制模型 ID"
                class="cursor-pointer rounded-md bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-700 transition-colors hover:bg-gray-200"
                @click="copyModelId(model)"
              >
                {{ model.id }}
              </button>
            </div>
            <p class="mt-2 text-sm font-medium text-gray-800">{{ model.summary }}</p>
            <p class="mt-1.5 text-sm leading-relaxed text-gray-600">{{ model.description }}</p>
            <ul class="mt-3 space-y-1">
              <li v-for="spec in model.specs" :key="spec" class="flex gap-2 text-xs text-gray-500">
                <span class="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-gray-400" />
                <span>{{ spec }}</span>
              </li>
            </ul>
          </article>
        </div>
      </section>

      <!-- 补充说明 -->
      <section class="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-5">
        <h2 class="text-sm font-semibold text-amber-900">几点补充说明</h2>
        <ul class="mt-2 space-y-2 text-sm leading-relaxed text-amber-800">
          <li>
            · 为什么没有多模态（图片/视频）向量模型？它们需要专门的调用方式，NovAI 走的是通用兼容接口，
            暂时用不上；小说创作场景纯文本也完全够。
          </li>
          <li>
            · 为什么这里只有阿里百炼的模型？设置页的「获取列表」对其他服务商会自动拉取在线列表；
            百炼的接口不返回这两类模型，所以由 NovAI 内置维护。换 Embedding 模型后记得重建索引。
          </li>
          <li> · 本页由 NovAI 根据官方文档整理，规格以官方为准：<a :href="OFFICIAL_DOC_URL" target="_blank" rel="noopener" class="font-medium underline underline-offset-2 hover:text-amber-900">阿里云百炼文档</a></li>
        </ul>
      </section>

      <footer class="mt-8 pb-4 text-center text-xs text-gray-400">NovAI · 模型说明</footer>
    </main>
  </div>
</template>
