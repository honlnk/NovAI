<script setup lang="ts">
/**
 * Ghost text 覆盖层（Copilot 式内联补全）。
 *
 * 与下方 Lexical 编辑器宿主同位叠加（富文本化 W1 前是 textarea）。已输入文字由
 * 编辑器自身渲染（正常深色），覆盖层里的已输入 span 用 invisible 仅撑布局，
 * 让灰色建议精确出现在光标后。必须与编辑器宿主共享 .chat-input-base 样式
 * （字体/行高/内边距），否则灰色文字会错位。pointer-events-none 确保点击穿透。
 * 注：覆盖层按纯文本投影渲染（段落 join '\n'），编辑器段落 <p> margin 已归零对齐。
 */
defineProps<{
  /** 已输入文本（纯文本投影，invisible 渲染，仅用于撑出与编辑器一致的布局） */
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
