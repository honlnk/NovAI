<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

import { useProjectStore } from '../stores/project'

const props = defineProps<{
  projectId: string
}>()

const projectStore = useProjectStore()
const currentProjectName = computed(() => projectStore.currentProject?.name ?? '未打开项目')

const llmFields = [
  { label: 'API 地址', placeholder: 'https://api.openai.com/v1' },
  { label: 'API Key', placeholder: 'sk-...' },
  { label: '模型名称', placeholder: 'gpt-4.1 / deepseek-chat' },
]

const embeddingFields = [
  { label: 'API 地址', placeholder: 'https://api.openai.com/v1' },
  { label: 'API Key', placeholder: 'sk-...' },
  { label: '模型名称', placeholder: 'text-embedding-3-small' },
]
</script>

<template>
  <main class="page page-settings text-ink-950">
    <section class="settings-shell">
      <header class="settings-header">
        <div>
          <p class="page-eyebrow">项目设置</p>
          <h1 class="max-w-4xl">先把模型配置和项目默认参数放到稳定位置</h1>
          <p>
            当前项目：<strong>{{ currentProjectName }}</strong> · ID：<strong>{{ props.projectId }}</strong>
          </p>
        </div>
        <RouterLink class="ghost-button ghost-button--link" :to="`/project/${props.projectId}`">
          返回工作区
        </RouterLink>
      </header>

      <div class="settings-grid">
        <section class="settings-card">
          <div class="section-heading">
            <span>LLM 配置</span>
            <span class="muted-text">首批表单骨架</span>
          </div>
          <label v-for="field in llmFields" :key="field.label" class="form-field">
            <span class="text-sm font-medium">{{ field.label }}</span>
            <input
              class="shadow-sm outline-none transition focus:border-clay-600 focus:ring-4 focus:ring-clay-100"
              type="text"
              :placeholder="field.placeholder"
            />
          </label>
          <div class="form-actions">
            <button class="ghost-button" type="button">测试连接</button>
            <button class="primary-button" type="button">保存</button>
          </div>
        </section>

        <section class="settings-card">
          <div class="section-heading">
            <span>Embedding 配置</span>
            <span class="muted-text">首批表单骨架</span>
          </div>
          <label v-for="field in embeddingFields" :key="field.label" class="form-field">
            <span class="text-sm font-medium">{{ field.label }}</span>
            <input
              class="shadow-sm outline-none transition focus:border-clay-600 focus:ring-4 focus:ring-clay-100"
              type="text"
              :placeholder="field.placeholder"
            />
          </label>
          <div class="form-actions">
            <button class="ghost-button" type="button">测试连接</button>
            <button class="primary-button" type="button">保存</button>
          </div>
        </section>

        <section class="settings-card settings-card--wide">
          <div class="section-heading">
            <span>项目默认参数</span>
            <span class="muted-text">对应 `novel.config.json`</span>
          </div>

          <div class="settings-list">
            <div class="settings-row">
              <span>生成上下文章节数</span>
              <strong>3</strong>
            </div>
            <div class="settings-row">
              <span>RAG 粗检索返回条数</span>
              <strong>20</strong>
            </div>
            <div class="settings-row">
              <span>对话上下文 Token 上限</span>
              <strong>12000</strong>
            </div>
          </div>
        </section>
      </div>
    </section>
  </main>
</template>
