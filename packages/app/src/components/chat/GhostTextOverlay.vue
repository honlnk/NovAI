<script setup lang="ts">
/**
 * Ghost text 覆盖层（Copilot 式内联补全）。
 *
 * 与下方 textarea 同位叠加。已输入文字由 textarea 自身渲染（正常深色），
 * 覆盖层里的已输入 span 用 invisible 仅撑布局，让灰色建议精确出现在光标后。
 * 必须与 textarea 共享 .chat-input-base 样式（字体/行高/内边距），否则灰色文字会错位。
 * pointer-events-none 确保点击穿透到 textarea。
 */
defineProps<{
  /** 已输入文本（invisible 渲染，仅用于撑出与 textarea 一致的布局） */
  inputText: string
  /** AI 建议（灰色显示在已输入文本之后） */
  suggestion: string
}>()
</script>

<template>
  <div
    class="chat-input-base pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words"
    aria-hidden="true"
  >
    <span class="invisible">{{ inputText }}</span><span class="text-gray-400">{{ suggestion }}</span>
  </div>
</template>
