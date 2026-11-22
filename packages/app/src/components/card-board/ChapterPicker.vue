<script setup lang="ts">
/**
 * 共用章节选择器（作者字段控制权计划阶段 1，计划 §三.4）。
 *
 * 单选 / 多选共用骨架：可搜索（数字按全本章号等值匹配）、键盘上下/回车/Esc、
 * 已选标签（多选可删除与重排）、选择器内真实新建章节。旧值经解析层呈现
 * 「位置缺失 / 恢复展示 / 待消歧 / 无法解析」，绝不自动改绑。
 *
 * 组件是哑件：目录条目、加载状态与创建执行器都由接线层注入（useChapterCatalog），
 * 便于组件测试直接控制输入输出。收起不保存——已选项按当前卡片的保存规则处理。
 */
import { computed, ref, watch } from 'vue'

import type { ChapterCatalogEntry } from '@novai/core/types/chapters'
import { filterChapterEntries } from '@novai/core/services/chapter-service'
import {
  appendUniqueValue,
  describeChapterValue,
  moveValueAt,
  nextHighlightIndex,
  removeValueAt,
  validateCreateForm,
} from './chapter-picker-state'
import type { ChapterCreateHandler } from './chapter-picker-state'

const props = withDefaults(defineProps<{
  /** 多选（关联章节等保留作者顺序的列表字段）；默认单选 */
  multiple?: boolean
  modelValue: string | string[] | null
  entries: readonly ChapterCatalogEntry[]
  /** 目录是否已随项目载入；未就绪时只显示原始引用，不显示缺失/消歧结论 */
  catalogReady?: boolean
  loading?: boolean
  loadError?: string | null
  /** 是否提供「新建章节」入口（实际回收章节等事实字段必须关闭） */
  allowCreate?: boolean
  /** 单选清除按钮（计划位置类字段的「暂不指定」出口；埋设章节等必填字段关闭） */
  clearable?: boolean
  placeholder?: string
  disabled?: boolean
  /** 会话键（项目 + 卡片）：变化即重置搜索与新建现场，晚到结果不串卡 */
  sessionKey?: string
  /** 新建表单的默认章号建议（当前最大章号 + 1） */
  suggestedNumber?: number | null
  createHandler?: ChapterCreateHandler | null
}>(), {
  multiple: false,
  catalogReady: true,
  loading: false,
  loadError: null,
  allowCreate: true,
  clearable: false,
  placeholder: '搜索章号或标题…',
  disabled: false,
  sessionKey: '',
  suggestedNumber: null,
  createHandler: null,
})

const emit = defineEmits<{
  'update:modelValue': [value: string | string[] | null]
  'retry-load': []
}>()

const inputRef = ref<HTMLInputElement | null>(null)
const open = ref(false)
const query = ref('')
const highlightIndex = ref<number | null>(null)
const notice = ref<{ text: string; tone: 'ok' | 'warn' | 'danger' } | null>(null)
const createForm = ref({
  visible: false,
  numberText: '',
  title: '',
  error: '' as string | null,
  busy: false,
})

const multiValues = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []))
const singleValue = computed(() => (typeof props.modelValue === 'string' ? props.modelValue : null))

const duplicateNumbers = computed(() => {
  const seen = new Set<number>()
  const duplicated = new Set<number>()
  for (const entry of props.entries) {
    if (seen.has(entry.number)) {
      duplicated.add(entry.number)
    }
    seen.add(entry.number)
  }
  return duplicated
})

const filtered = computed(() => filterChapterEntries(props.entries, query.value))

function describe(ref: string | null): { text: string; badge: { label: string; tone: 'warn' | 'danger' } | null } {
  return describeChapterValue(
    { entries: [...props.entries], duplicateNumbers: duplicateNumbers.value, maxNumber: null },
    props.catalogReady,
    ref,
  )
}

function padNumber(number: number): string {
  return String(number).padStart(3, '0')
}

function selectEntry(entry: ChapterCatalogEntry): void {
  if (props.disabled) {
    return
  }

  if (props.multiple) {
    emit('update:modelValue', appendUniqueValue(multiValues.value, entry.ref))
    return
  }

  emit('update:modelValue', entry.ref)
  open.value = false
  query.value = ''
  highlightIndex.value = null
}

function removeTag(index: number): void {
  emit('update:modelValue', removeValueAt(multiValues.value, index))
}

function moveTag(index: number, delta: 1 | -1): void {
  emit('update:modelValue', moveValueAt(multiValues.value, index, delta))
}

function clearAll(): void {
  emit('update:modelValue', props.multiple ? [] : null)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    open.value = true
    highlightIndex.value = nextHighlightIndex(
      highlightIndex.value,
      filtered.value.length,
      event.key === 'ArrowDown' ? 1 : -1,
    )
    return
  }

  if (event.key === 'Enter') {
    const highlighted = highlightIndex.value !== null ? filtered.value[highlightIndex.value] : undefined
    if (open.value && highlighted) {
      event.preventDefault()
      selectEntry(highlighted)
    }
    return
  }

  if (event.key === 'Escape') {
    open.value = false
    highlightIndex.value = null
  }
}

/** 焦点离开组件才收起下拉（焦点在下拉内移动不收起）。 */
function onFocusOut(event: FocusEvent): void {
  const container = event.currentTarget as HTMLElement | null
  if (container && event.relatedTarget instanceof Node && container.contains(event.relatedTarget)) {
    return
  }
  open.value = false
  highlightIndex.value = null
}

function beginCreate(): void {
  createForm.value = {
    visible: true,
    numberText: props.suggestedNumber !== null && props.suggestedNumber !== undefined
      ? String(props.suggestedNumber)
      : '',
    title: '',
    error: null,
    busy: false,
  }
}

function closeCreate(): void {
  createForm.value = { visible: false, numberText: '', title: '', error: null, busy: false }
}

async function submitCreate(): Promise<void> {
  if (createForm.value.busy || props.disabled) {
    return
  }

  const validated = validateCreateForm(createForm.value.numberText, createForm.value.title)
  if (!validated.ok) {
    createForm.value.error = validated.error
    return
  }

  // 本地先核对：已有同章号章节时改为选择它，不发起创建请求（计划 §三.4）
  const occupied = props.entries.filter(entry => entry.number === validated.chapterNumber)
  if (occupied.length === 1) {
    selectEntry(occupied[0]!)
    notice.value = { text: `第${padNumber(validated.chapterNumber)}章 已存在，已改为选择该章节`, tone: 'warn' }
    closeCreate()
    return
  }
  if (occupied.length > 1) {
    createForm.value.error = '该章号存在多个章节（历史重号），请在列表中消歧选择'
    return
  }

  if (!props.createHandler) {
    createForm.value.error = '当前环境不支持创建章节'
    return
  }

  const sessionAtSubmit = props.sessionKey
  createForm.value.busy = true
  createForm.value.error = null

  const outcome = await props.createHandler({
    chapterNumber: validated.chapterNumber,
    title: validated.title,
  })

  // 切卡 / 切项目后晚到的创建结果不回填新现场
  if (props.sessionKey !== sessionAtSubmit) {
    return
  }

  createForm.value.busy = false

  switch (outcome.kind) {
    case 'created':
      selectEntry(outcome.entry)
      notice.value = { text: `已创建 第${padNumber(outcome.entry.number)}章 ${outcome.entry.title}`, tone: 'ok' }
      closeCreate()
      break
    case 'number-taken':
      if (outcome.existing.length === 1) {
        // 已有同章号章节时改为选择它，不重复创建（计划 §三.4）
        selectEntry(outcome.existing[0]!)
        notice.value = { text: `第${padNumber(outcome.existing[0]!.number)}章 已存在，已改为选择该章节`, tone: 'warn' }
        closeCreate()
      } else {
        createForm.value.error = '该章号存在多个章节（历史重号），请在列表中消歧选择'
      }
      break
    case 'invalid-number':
      createForm.value.error = outcome.message
      break
    case 'failed':
      createForm.value.error = outcome.message
      break
    case 'stale':
      closeCreate()
      break
  }
}

/** 会话键变化（切卡 / 切项目）：搜索、高亮与新建现场全部重置。 */
watch(() => props.sessionKey, () => {
  open.value = false
  query.value = ''
  highlightIndex.value = null
  notice.value = null
  closeCreate()
})
</script>

<template>
  <div
    class="chapter-picker"
    :data-testid="'chapter-picker'"
    @focusout="onFocusOut"
  >
    <!-- 已选展示：不依赖下一次列表读取（未就绪时显示原始引用） -->
    <ul v-if="multiple" class="chapter-picker-tags" data-testid="chapter-picker-tags">
      <li
        v-for="(value, index) in multiValues"
        :key="`${sessionKey}:${index}:${value}`"
        class="chapter-picker-tag"
        :class="`tone-${describe(value).badge?.tone ?? 'ok'}`"
        :data-testid="`chapter-picker-tag-${index}`"
      >
        <span class="chapter-picker-tag-text">{{ describe(value).text }}</span>
        <span v-if="describe(value).badge" class="chapter-picker-tag-badge">{{ describe(value).badge?.label }}</span>
        <span class="chapter-picker-tag-tools">
          <button
            type="button"
            class="chapter-picker-tag-move"
            :disabled="disabled || index === 0"
            :aria-label="`上移第 ${index + 1} 项`"
            :data-testid="`chapter-picker-tag-up-${index}`"
            @click="moveTag(index, -1)"
          >↑</button>
          <button
            type="button"
            class="chapter-picker-tag-move"
            :disabled="disabled || index === multiValues.length - 1"
            :aria-label="`下移第 ${index + 1} 项`"
            :data-testid="`chapter-picker-tag-down-${index}`"
            @click="moveTag(index, 1)"
          >↓</button>
          <button
            type="button"
            class="chapter-picker-tag-remove"
            :disabled="disabled"
            :aria-label="`删除第 ${index + 1} 项`"
            :data-testid="`chapter-picker-tag-remove-${index}`"
            @click="removeTag(index)"
          >×</button>
        </span>
      </li>
      <li v-if="multiValues.length > 0 && !disabled" class="chapter-picker-tags-clear">
        <button type="button" data-testid="chapter-picker-clear" @click="clearAll">清空</button>
      </li>
    </ul>
    <p v-else-if="singleValue !== null || catalogReady" class="chapter-picker-single" :class="`tone-${describe(singleValue).badge?.tone ?? 'ok'}`">
      <span class="chapter-picker-tag-text">{{ describe(singleValue).text }}</span>
      <span v-if="describe(singleValue).badge" class="chapter-picker-tag-badge">{{ describe(singleValue).badge?.label }}</span>
      <button
        v-if="clearable && singleValue !== null && !disabled"
        type="button"
        class="chapter-picker-tag-remove"
        data-testid="chapter-picker-clear"
        aria-label="清除所选章节"
        @click="clearAll"
      >×</button>
    </p>

    <input
      ref="inputRef"
      v-model="query"
      type="text"
      class="chapter-picker-input"
      :placeholder="placeholder"
      :disabled="disabled"
      data-testid="chapter-picker-input"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @focusin="open = true"
      @keydown="onKeydown"
    >

    <p v-if="notice" class="chapter-picker-notice" :class="`tone-${notice.tone}`" data-testid="chapter-picker-notice">
      {{ notice.text }}
    </p>

    <div v-if="open" class="chapter-picker-dropdown" data-testid="chapter-picker-dropdown">
      <p v-if="loading" class="chapter-picker-hint" data-testid="chapter-picker-loading">读取章节中…</p>

      <div v-else-if="loadError" class="chapter-picker-error" data-testid="chapter-picker-load-error">
        <span>{{ loadError }}</span>
        <button type="button" data-testid="chapter-picker-retry" @click="emit('retry-load')">重试</button>
      </div>

      <template v-else>
        <ul v-if="filtered.length > 0" class="chapter-picker-options" role="listbox" data-testid="chapter-picker-options">
          <li
            v-for="(option, index) in filtered"
            :key="option.path"
            role="option"
            :aria-selected="highlightIndex === index"
            :class="{ 'is-highlighted': highlightIndex === index }"
            :data-testid="`chapter-picker-option-${index}`"
            @mousedown.prevent
            @click="selectEntry(option)"
            @mouseenter="highlightIndex = index"
          >
            <span class="chapter-picker-option-number">第{{ padNumber(option.number) }}章</span>
            <span class="chapter-picker-option-title">{{ option.title }}</span>
            <span v-if="option.directory" class="chapter-picker-option-directory">{{ option.directory }}</span>
            <span v-if="duplicateNumbers.has(option.number)" class="chapter-picker-option-duplicate">章号重复</span>
          </li>
        </ul>
        <p v-else class="chapter-picker-hint" data-testid="chapter-picker-empty">没有匹配的章节</p>

        <div v-if="allowCreate && !disabled" class="chapter-picker-create" data-testid="chapter-picker-create-area">
          <button
            v-if="!createForm.visible"
            type="button"
            data-testid="chapter-picker-create-toggle"
            @click="beginCreate"
          >新建章节</button>

          <form v-else class="chapter-picker-create-form" @submit.prevent="submitCreate">
            <label class="chapter-picker-create-field">
              章号
              <input
                v-model="createForm.numberText"
                type="text"
                inputmode="numeric"
                data-testid="chapter-picker-create-number"
                :disabled="createForm.busy"
              >
            </label>
            <label class="chapter-picker-create-field">
              标题（可选）
              <input
                v-model="createForm.title"
                type="text"
                data-testid="chapter-picker-create-title"
                :disabled="createForm.busy"
              >
            </label>
            <p v-if="createForm.error" class="chapter-picker-error-text" data-testid="chapter-picker-create-error">
              {{ createForm.error }}
            </p>
            <div class="chapter-picker-create-actions">
              <button
                type="submit"
                data-testid="chapter-picker-create-submit"
                :disabled="createForm.busy"
              >{{ createForm.busy ? '创建中…' : '创建并选择' }}</button>
              <button
                type="button"
                data-testid="chapter-picker-create-cancel"
                :disabled="createForm.busy"
                @click="closeCreate"
              >收起</button>
            </div>
          </form>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.chapter-picker {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.chapter-picker-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.chapter-picker-tag,
.chapter-picker-single {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  border-radius: 0.375rem;
  border: 1px solid var(--color-border, #d1d5db);
  background: var(--color-surface, #f9fafb);
  padding: 0.125rem 0.5rem;
  font-size: 0.75rem;
  line-height: 1.5rem;
}

.chapter-picker-tag.tone-warn,
.chapter-picker-single.tone-warn {
  border-color: #f59e0b;
  background: #fffbeb;
}

.chapter-picker-tag.tone-danger,
.chapter-picker-single.tone-danger {
  border-color: #ef4444;
  background: #fef2f2;
}

.chapter-picker-tag-badge {
  color: #92400e;
  font-size: 0.6875rem;
}

.chapter-picker-tag.tone-danger .chapter-picker-tag-badge {
  color: #b91c1c;
}

.chapter-picker-tag-tools {
  display: inline-flex;
  gap: 0.125rem;
}

.chapter-picker-tag-tools button,
.chapter-picker-tags-clear button {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0 0.125rem;
  font-size: 0.75rem;
  line-height: 1;
}

.chapter-picker-tag-tools button:disabled,
.chapter-picker-tags-clear button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.chapter-picker-tags-clear button {
  color: #6b7280;
  text-decoration: underline;
}

.chapter-picker-input {
  width: 100%;
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 0.375rem;
  padding: 0.25rem 0.5rem;
  font-size: 0.8125rem;
}

.chapter-picker-notice {
  margin: 0;
  font-size: 0.75rem;
}

.chapter-picker-notice.tone-ok {
  color: #047857;
}

.chapter-picker-notice.tone-warn {
  color: #92400e;
}

.chapter-picker-notice.tone-danger {
  color: #b91c1c;
}

.chapter-picker-dropdown {
  position: absolute;
  z-index: 30;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 0.25rem;
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 0.5rem;
  background: var(--color-surface, #ffffff);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
  max-height: 18rem;
  overflow-y: auto;
  padding: 0.375rem;
}

.chapter-picker-options {
  list-style: none;
  margin: 0;
  padding: 0;
}

.chapter-picker-options li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
  cursor: pointer;
  font-size: 0.8125rem;
}

.chapter-picker-options li.is-highlighted {
  background: var(--color-surface-active, #eef2ff);
}

.chapter-picker-option-number {
  font-weight: 600;
  white-space: nowrap;
}

.chapter-picker-option-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chapter-picker-option-directory {
  color: #6b7280;
  font-size: 0.6875rem;
}

.chapter-picker-option-duplicate {
  color: #b91c1c;
  font-size: 0.6875rem;
}

.chapter-picker-hint,
.chapter-picker-error {
  margin: 0;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  color: #6b7280;
}

.chapter-picker-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  color: #b91c1c;
}

.chapter-picker-error button {
  border: 1px solid currentColor;
  border-radius: 0.375rem;
  background: transparent;
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0 0.5rem;
}

.chapter-picker-create {
  border-top: 1px solid var(--color-border, #e5e7eb);
  margin-top: 0.25rem;
  padding-top: 0.375rem;
}

.chapter-picker-create > button {
  border: none;
  background: transparent;
  color: #4f46e5;
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
  text-decoration: underline;
}

.chapter-picker-create-form {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.chapter-picker-create-field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
}

.chapter-picker-create-field input {
  flex: 1;
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 0.375rem;
  padding: 0.1875rem 0.375rem;
  font-size: 0.8125rem;
}

.chapter-picker-error-text {
  margin: 0;
  color: #b91c1c;
  font-size: 0.75rem;
}

.chapter-picker-create-actions {
  display: flex;
  gap: 0.5rem;
}

.chapter-picker-create-actions button {
  border-radius: 0.375rem;
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0.1875rem 0.625rem;
}

.chapter-picker-create-actions button[type='submit'] {
  border: 1px solid #4f46e5;
  background: #4f46e5;
  color: #ffffff;
}

.chapter-picker-create-actions button[type='submit']:disabled {
  cursor: wait;
  opacity: 0.6;
}

.chapter-picker-create-actions button[type='button'] {
  border: 1px solid var(--color-border, #d1d5db);
  background: transparent;
}
</style>
