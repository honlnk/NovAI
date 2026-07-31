import { ref } from 'vue'

import { streamInlineCompletion } from '@novai/core/services/completion-service'
import type { CompletionConfigView } from '@novai/core/services/types'

/**
 * 对话输入框 AI 补全（FIM）的前端编排。
 *
 * 职责：防抖触发、中断上一轮未完成请求、累积 ghost text 建议、逐段接受（中文分词）。
 * 状态集中在模块级单例 ref，多组件共享同一份。不写入任何 store，与对话流程解耦。
 *
 * 交互约定（由调用方 ChatPanel 实现）：
 * - 用户输入时调用 scheduleCompletion 触发（防抖 + abort 上一次）。
 * - Tab 调用 acceptNextSegment 吞掉建议的下一个分词单位，返回是否还有剩余。
 * - Esc / 发送 / 切换输入时调用 clearSuggestion 丢弃建议。
 */

/**
 * Intl.Segmenter 的本地最小类型定义。
 *
 * 运行时（Chromium）支持 Intl.Segmenter，但当前 TS lib（ES2020）未包含其类型，
 * 这里用最小契约代替，避免改动全局 lib 配置。
 */
interface SegmentData {
  segment: string
  isWordLike: boolean
}
interface SegmenterLike {
  segment(input: string): Iterable<SegmentData>
}

/** Intl 构造器类型断言（绕开 lib 缺失的 Segmenter 类型）。 */
const IntlWithSegmenter = Intl as unknown as typeof Intl & {
  Segmenter?: new (locale: string, options: { granularity: 'word' }) => SegmenterLike
}

/** 用 Intl.Segmenter 把建议切成分词单位（中文按词/短语，而非硬按空格）。 */
let segmenter: SegmenterLike | null = null

function getSegmenter(): SegmenterLike | null {
  if (segmenter) {
    return segmenter
  }

  // 部分旧环境无 Intl.Segmenter；降级为按字符回退。
  if (typeof IntlWithSegmenter.Segmenter !== 'undefined') {
    segmenter = new IntlWithSegmenter.Segmenter('zh', { granularity: 'word' })
    return segmenter
  }

  return null
}

/**
 * 取出建议的首个分词单位及其剩余部分。
 *
 * 优先用 Intl.Segmenter（中文按词/短语切分）；环境不支持时按字符回退。
 *
 * 切分策略：把首个「实质段」（非纯空白）连同它前面紧邻的空白一起吞下。
 * 这样英文词间空格不会丢失（拼回 inputText 时正确），中文无空格不受影响。
 * 若首个实质段是标点，则把它和紧随的下一个词合并成一段吞下（避免标点单独占一次 Tab）。
 */
export function splitFirstSegment(suggestion: string): { first: string; rest: string } {
  if (!suggestion) {
    return { first: '', rest: '' }
  }

  const seg = getSegmenter()
  if (seg) {
    let offset = 0
    for (const { segment, isWordLike } of seg.segment(suggestion)) {
      // 纯空白段：累计，等遇到实质段时一起吞（保证词间空格不丢）
      if (segment.trim() === '') {
        offset += segment.length
        continue
      }

      const segmentEnd = offset + segment.length

      // 首个实质段。若是标点，尝试合并到下一个词一起吞（含中间空白）。
      if (!isWordLike) {
        const merged = mergePunctuationWithNextWord(seg, suggestion)
        if (merged) {
          return merged
        }
      }

      // 默认：吞掉开头的空白（累计在 offset）+ 当前实质段，保证词间空格不丢
      const first = suggestion.slice(0, segmentEnd)
      return { first, rest: suggestion.slice(segmentEnd) }
    }
    // 全是空白
    return { first: '', rest: '' }
  }

  // 降级：按字符（非空白）回退
  const trimmed = suggestion.replace(/^\s+/, '')
  const firstChar = trimmed[0]
  if (!firstChar) {
    return { first: '', rest: '' }
  }
  return { first: firstChar, rest: trimmed.slice(1) }
}

/**
 * 当首个实质段是标点时，尝试把它和紧随其后的第一个词合并吞下（连同标点前的空白与中间空白）。
 * 从 suggestion 开头扫描，返回 null 表示没有后续词可合并（按原样只吞标点段）。
 */
function mergePunctuationWithNextWord(
  seg: SegmenterLike,
  suggestion: string,
): { first: string; rest: string } | null {
  let consumed = ''
  for (const { segment, isWordLike } of seg.segment(suggestion)) {
    // 遇到词就合并并返回（含此前累计的标点与空白）
    if (isWordLike) {
      consumed += segment
      return { first: consumed, rest: suggestion.slice(consumed.length) }
    }
    // 标点或空白都先累计（标点 + 中间空白 + 词 一起吞）
    consumed += segment
  }
  // 走到结尾都没遇到词
  return null
}

/** 当前 ghost text 建议（灰色文字） */
const suggestion = ref('')
/** 是否正在请求补全 */
const isFetching = ref(false)
/** 错误信息（仅用于调试，一般不展示给用户） */
const errorMessage = ref('')

/** 进行中的请求控制器；仅 isFetching 期间存在 */
let activeController: AbortController | null = null
/** 防抖定时器 */
let debounceTimer: ReturnType<typeof setTimeout> | null = null
/** 发起请求时锁定的配置快照，避免异步竞态用过期配置 */
let activeConfig: CompletionConfigView | null = null

/**
 * 调度一次补全。内部清防抖 + abort 上一次，配置未启用或前缀为空则直接返回。
 *
 * @param fullText 输入框完整文本
 * @param cursor   光标位置（selectionStart）
 * @param config   当前补全配置
 */
function scheduleCompletion(fullText: string, cursor: number, config: CompletionConfigView | null | undefined) {
  cancelPending()

  if (!config?.enabled) {
    suggestion.value = ''
    return
  }

  const prefix = fullText.slice(0, cursor)
  const suffix = fullText.slice(cursor)

  if (!prefix.trim()) {
    suggestion.value = ''
    return
  }

  activeConfig = config
  debounceTimer = setTimeout(() => {
    void requestCompletion(prefix, suffix)
  }, config.debounceMs)
}

async function requestCompletion(prefix: string, suffix: string) {
  if (!activeConfig) {
    return
  }

  // 新请求前 abort 上一次
  activeController?.abort()
  activeController = new AbortController()

  isFetching.value = true
  suggestion.value = ''

  try {
    const fullText = await streamInlineCompletion(
      activeConfig,
      {
        prompt: prefix,
        suffix: suffix || undefined,
        signal: activeController.signal,
      },
      (event) => {
        if (event.type === 'delta') {
          suggestion.value += event.text
        }
      },
    )

    // 流式期间已累积，但若非流式兜底返回了完整文本则覆盖
    if (fullText && !suggestion.value) {
      suggestion.value = fullText
    }
  } catch (error) {
    // 用户主动取消（继续打字 / Esc / 切换）：静默，不清 suggestion（由调用方按场景丢弃）
    if (!isAbortError(error)) {
      errorMessage.value = error instanceof Error ? error.message : '补全请求失败'
    }
  } finally {
    isFetching.value = false
    activeController = null
  }
}

/**
 * 逐段接受：吞掉建议的首个分词单位，返回已接受文本与是否还有剩余。
 *
 * 调用方拿到 accepted 后拼到 inputText 末尾、光标后移；
 * hasMore 为 false 时表示建议已吃完，调用方应清空状态。
 */
function acceptNextSegment(): { accepted: string; hasMore: boolean } {
  if (!suggestion.value) {
    return { accepted: '', hasMore: false }
  }

  const { first, rest } = splitFirstSegment(suggestion.value)
  suggestion.value = rest
  return { accepted: first, hasMore: rest.length > 0 }
}

/** 丢弃当前建议并取消进行中的请求 */
function clearSuggestion() {
  suggestion.value = ''
  cancelPending()
}

/** 清防抖 + abort 进行中的请求（不清 suggestion，由调用方决定） */
function cancelPending() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (activeController) {
    activeController.abort()
    activeController = null
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true
  }
  // CompletionAbortedError 带 aborted 标记
  if (error && typeof error === 'object' && 'aborted' in error && (error as { aborted: unknown }).aborted === true) {
    return true
  }
  return false
}

export function useInlineCompletion() {
  return {
    suggestion,
    isFetching,
    errorMessage,
    scheduleCompletion,
    acceptNextSegment,
    clearSuggestion,
    cancelPending,
  }
}
