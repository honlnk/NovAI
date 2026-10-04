<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * Ghost text 覆盖层（Copilot 式内联补全；富文本化 W2 起对准 Lexical 编辑器宿主）。
 *
 * 已输入文字由编辑器宿主渲染（正常深色），覆盖层里的已输入 span 用 invisible
 * 仅撑布局，让灰色建议精确出现在光标后。pointer-events-none 确保点击穿透。
 *
 * 对齐机制（W2 健壮化，移植自 dsh-input-assist 的 contenteditable 适配）：
 * - 度量复制：不再只靠「共享 .chat-input-base 类」的隐式约定——每次同步时从宿主
 *   计算样式复制 15 项排版度量（字体/字距/行高/四向 padding/换行规则等），
 *   宿主样式漂移时镜像自愈；
 * - 滚动同步：宿主超 200px 上限后内部滚动，覆盖层（overflow:hidden）程序化
 *   scrollTop/scrollLeft 跟随——修掉旧 textarea 时代「正文滚了幽灵字没滚」的
 *   存量错位 bug。监听宿主 scroll + 窗口 resize，文本/建议变化后亦同步一次。
 * - 段落对齐前提：编辑器段落 <p> margin 已在 .chat-input-editable 归零，
 *   与本层「纯文本 \n 分行」一致。
 */
const props = defineProps<{
  /** 已输入文本（纯文本投影，invisible 渲染，仅用于撑出与编辑器一致的布局） */
  inputText: string
  /** AI 建议（灰色显示在已输入文本之后） */
  suggestion: string
  /** 对准的编辑器宿主元素（度量与滚动的真值来源） */
  host: HTMLElement | null
}>()

const rootRef = ref<HTMLElement | null>(null)

/** 度量清单（照 dsh-input-assist copyMirrorMetrics）：影响换行与内边距的全部计算样式 */
const MIRROR_STYLE_PROPS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textRendering',
  'textTransform',
  'tabSize',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'overflowWrap',
  'wordBreak',
] as const

function copyMetrics(host: HTMLElement, el: HTMLElement): void {
  const computed = getComputedStyle(host)
  for (const prop of MIRROR_STYLE_PROPS) {
    el.style[prop] = computed[prop]
  }
  el.style.boxSizing = 'border-box'
}

function syncFromHost(): void {
  const root = rootRef.value
  if (!root || !props.host) return
  copyMetrics(props.host, root)
  root.scrollTop = props.host.scrollTop
  root.scrollLeft = props.host.scrollLeft
}

function onHostScroll(): void {
  syncFromHost()
}

function onWindowResize(): void {
  syncFromHost()
}

watch(
  () => props.host,
  (host, previous) => {
    previous?.removeEventListener('scroll', onHostScroll)
    host?.addEventListener('scroll', onHostScroll)
    void nextTick(syncFromHost)
  },
  { immediate: true },
)

watch([() => props.inputText, () => props.suggestion], () => {
  // 文本/建议更新后 DOM 渲染完成再同步（布局可能因换行变化）
  void nextTick(syncFromHost)
})

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  void nextTick(syncFromHost)
})

onBeforeUnmount(() => {
  props.host?.removeEventListener('scroll', onHostScroll)
  window.removeEventListener('resize', onWindowResize)
})
</script>

<template>
  <div
    ref="rootRef"
    class="chat-input-base pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words"
    aria-hidden="true"
  >
    <span class="invisible">{{ inputText }}</span><span class="text-gray-400">{{ suggestion }}</span>
  </div>
</template>
