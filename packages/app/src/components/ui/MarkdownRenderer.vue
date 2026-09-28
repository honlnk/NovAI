<script setup lang="ts">
import { computed } from 'vue'

import { parseMarkdownBlocks } from '../../utils/markdown-blocks'

/**
 * 块级渲染（借鉴 dsh 冻结前缀）：整篇 parse 后按顶层块分组渲染，key 取块起始行号。
 * 流式追加时前缀块 key 稳定、Vue 复用其 DOM 不重建，仅尾部块 innerHTML 更新——
 * 消除「每 token 整篇重渲 + 整棵子树重建」。streaming/settled 统一路径：
 * settled 一次渲染无回归；解析器为模块级共享单例（不再每实例各建一个）。
 */
const props = defineProps<{
  content: string
  /** 语义透传：该消息正在流式输出中（块级渲染本身已保证仅尾部块随 delta 更新，无需分支） */
  streaming?: boolean
}>()

const blocks = computed(() => parseMarkdownBlocks(props.content))
</script>

<template>
  <div class="markdown-body" :data-streaming="streaming || undefined">
    <div v-for="block in blocks" :key="block.key" class="markdown-block" v-html="block.html" />
  </div>
</template>

<style>
.markdown-body {
  font-size: 14px;
  line-height: 1.6;
  color: #1f2937;
}

.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  font-weight: 600;
  line-height: 1.25;
}

.markdown-body h1 {
  font-size: 1.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid #e5e7eb;
}

.markdown-body h2 {
  font-size: 1.25em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid #e5e7eb;
}

.markdown-body h3 {
  font-size: 1.125em;
}

.markdown-body h4 {
  font-size: 1em;
}

.markdown-body p {
  margin-top: 0;
  margin-bottom: 1em;
}

.markdown-body a {
  color: #2563eb;
  text-decoration: none;
}

.markdown-body a:hover {
  text-decoration: underline;
}

.markdown-body strong {
  font-weight: 600;
}

.markdown-body em {
  font-style: italic;
}

.markdown-body code {
  padding: 0.2em 0.4em;
  margin: 0;
  font-size: 85%;
  background-color: #f3f4f6;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}

.markdown-body pre {
  padding: 1em;
  margin-bottom: 1em;
  overflow-x: auto;
  background-color: #1f2937;
  border-radius: 8px;
}

.markdown-body pre code {
  padding: 0;
  margin: 0;
  font-size: 85%;
  background-color: transparent;
  color: #e5e7eb;
}

.markdown-body blockquote {
  padding: 0.5em 1em;
  margin: 0 0 1em 0;
  border-left: 4px solid #d1d5db;
  color: #6b7280;
}

.markdown-body ul,
.markdown-body ol {
  padding-left: 2em;
  margin-top: 0;
  margin-bottom: 1em;
}

.markdown-body li {
  margin-bottom: 0.25em;
}

.markdown-body li > ul,
.markdown-body li > ol {
  margin-top: 0.25em;
  margin-bottom: 0;
}

.markdown-body hr {
  height: 1px;
  margin: 1.5em 0;
  background-color: #e5e7eb;
  border: 0;
}

.markdown-body table {
  width: 100%;
  margin-bottom: 1em;
  border-collapse: collapse;
}

.markdown-body th,
.markdown-body td {
  padding: 0.5em 1em;
  border: 1px solid #e5e7eb;
}

.markdown-body th {
  font-weight: 600;
  background-color: #f9fafb;
}

.markdown-body img {
  max-width: 100%;
  height: auto;
}

.markdown-body del {
  color: #9ca3af;
}
</style>
