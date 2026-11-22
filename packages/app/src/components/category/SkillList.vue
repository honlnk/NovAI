<script setup lang="ts">
import { computed, ref } from 'vue'

import type { BrokenSkillView, SkillView, SkillWarningView } from '@novai/core/services/types'
import { useSkillStore } from '../../stores/skill'
import { formatSkillFileSize } from '../../utils/skill-format'
import Tooltip from '../ui/Tooltip.vue'
import AppIcon from '../ui/AppIcon.vue'

/**
 * 技能分类面板（技能包 UI/UX 施工计划 §3.2）。
 *
 * 列表 = 合格技能（可展开文件清单）+ broken 技能（末尾灰显、行内人话原因）。
 * 文本文件（含 SKILL.md）点击走右侧现有文件详情；脚本/不支持文件灰显不可点
 * （决策 7）。删除走行尾删除入口 + 二次确认（决策 9：整夹删除不可撤销），
 * 执行在 skill store（删盘 + 刷文件树 + 重算），结果回填确认对话框。
 * 获取入口（新建/导入/让 AI 写）属阶段 2，届时接入头部操作区与空状态。
 */
const props = defineProps<{
  projectId: string
  skills: SkillView[]
  broken: BrokenSkillView[]
  isLoading: boolean
  activeFilePath?: string
}>()

const emit = defineEmits<{
  selectFile: [path: string]
  refresh: []
}>()

/** 搜索词（技能多于 8 个时显示搜索框，按名称与描述过滤——决策 11） */
const SEARCH_THRESHOLD = 8
const searchQuery = ref('')

const showSearch = computed(() => props.skills.length + props.broken.length > SEARCH_THRESHOLD)

const filteredSkills = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return props.skills
  return props.skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(q)
      || (skill.displayName?.toLowerCase().includes(q) ?? false)
      || skill.description.toLowerCase().includes(q),
  )
})

const filteredBroken = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return props.broken
  return props.broken.filter(
    (skill) => skill.name.toLowerCase().includes(q) || skill.reason.toLowerCase().includes(q),
  )
})

const hasSearchMiss = computed(
  () =>
    searchQuery.value.trim() !== ''
    && filteredSkills.value.length === 0
    && filteredBroken.value.length === 0,
)

/** 展开文件清单的技能名（同一时刻只展开一个，避免长清单叠长清单） */
const expandedSkillName = ref<string | null>(null)

function toggleExpanded(name: string) {
  expandedSkillName.value = expandedSkillName.value === name ? null : name
}

/** 技能行附属文件数文案：清单条目 + 截断数。 */
function fileCountText(skill: SkillView): string {
  const count = skill.files.length + (skill.filesOmitted ?? 0)
  return count > 0 ? `${count} 个附属文件` : '仅 SKILL.md'
}

/** warning 标记悬停文案（多条诊断换行拼接）。 */
function warningsTitle(warnings: SkillWarningView[]): string {
  return warnings.map((warning) => warning.message).join('\n')
}

/* ---------- 删除二次确认（决策 9）：执行在 skill store，结果回填对话框 ---------- */

const skillStore = useSkillStore()

const deleteTarget = ref<SkillView | BrokenSkillView | null>(null)
const isDeleteBusy = ref(false)
const deleteError = ref('')

function requestDelete(skill: SkillView | BrokenSkillView) {
  deleteTarget.value = skill
  deleteError.value = ''
}

async function confirmDelete() {
  const name = deleteTarget.value?.name
  if (!name || isDeleteBusy.value) return
  isDeleteBusy.value = true
  deleteError.value = ''
  const error = await skillStore.removeSkill(props.projectId, name)
  isDeleteBusy.value = false
  if (error) {
    deleteError.value = error.message
    return
  }
  deleteTarget.value = null
}

function cancelDelete() {
  deleteTarget.value = null
  deleteError.value = ''
}
</script>

<template>
  <div class="relative flex h-full flex-col">
    <!-- 头部：分组标题带数量 + 刷新（决策 11；导入/新建入口属阶段 2） -->
    <div class="flex items-center justify-between px-4 py-3">
      <h2 class="text-sm font-semibold text-white">已安装技能 · {{ skills.length + broken.length }}</h2>
      <div class="flex items-center gap-1">
        <Tooltip text="刷新技能" :delay="300" preferred-placement="bottom">
          <button
            class="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="isLoading"
            aria-label="刷新技能"
            data-testid="skill-refresh-button"
            @click="emit('refresh')"
          >
            <AppIcon name="refresh-cw" :size="16" :class="['h-4 w-4', isLoading ? 'animate-spin' : '']" />
          </button>
        </Tooltip>
        <!-- 移动端关闭：由 CategoryPanel 注入 -->
        <slot name="mobile-close" />
      </div>
    </div>

    <!-- 搜索框（技能多于 8 个时显示，决策 11） -->
    <div v-if="showSearch" class="px-3 pb-2">
      <div class="flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-1.5">
        <AppIcon name="search" :size="14" class="h-3.5 w-3.5 shrink-0 text-gray-500" />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜索技能名称或描述"
          class="w-full bg-transparent text-xs text-gray-200 placeholder-gray-600 focus:outline-none"
          data-testid="skill-search-input"
        />
      </div>
    </div>

    <div class="flex-1 overflow-y-auto px-2 pb-2">
      <!-- 首载提示；已有列表时刷新保留列表（标题行图标转圈即可） -->
      <p v-if="isLoading && skills.length === 0 && broken.length === 0" class="px-2 py-2 text-xs text-gray-600">
        正在读取技能…
      </p>

      <!-- 空状态：说明技能是什么（§3.2；三个获取入口按钮属阶段 2） -->
      <div
        v-else-if="skills.length === 0 && broken.length === 0"
        class="flex flex-col gap-2 px-3 py-6 text-xs leading-relaxed text-gray-500"
        data-testid="skill-empty-state"
      >
        <p>技能是可复用的写作方法包（一个文件夹 + SKILL.md）。AI 会在任务相符时自动加载，你也可以在输入框用 <span class="rounded bg-white/10 px-1 text-gray-300">#技能名</span> 点名使用。</p>
        <p>当前项目还没有任何技能。</p>
      </div>

      <template v-else>
        <!-- 合格技能列表 -->
        <ul class="space-y-0.5" data-testid="skill-list">
          <li v-for="skill in filteredSkills" :key="skill.name">
            <div
              :class="[
                'group rounded-md px-2 py-1.5 transition-colors',
                activeFilePath?.startsWith(`${skill.directory}/`) ? 'bg-white/10' : 'hover:bg-white/5',
              ]"
            >
              <!-- 技能行：主体点击展开文件清单；行尾更多（删除）独立点击 -->
              <div class="flex items-start">
                <button
                  class="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                  :aria-expanded="expandedSkillName === skill.name"
                  data-testid="skill-row"
                  @click="toggleExpanded(skill.name)"
                >
                  <span class="flex w-full items-center gap-1.5">
                    <AppIcon name="sparkles" :size="15" class="h-[15px] w-[15px] shrink-0 text-gray-400" />
                    <span class="truncate text-sm text-gray-200">{{ skill.name }}</span>
                    <!-- frontmatter name 与文件夹名不同：副标显示 -->
                    <span v-if="skill.displayName && skill.displayName !== skill.name" class="shrink-0 truncate text-xs text-gray-600">{{ skill.displayName }}</span>
                    <!-- warning 标记（悬停看原因，决策 8） -->
                    <span
                      v-if="skill.warnings.length > 0"
                      class="shrink-0 text-amber-400"
                      :title="warningsTitle(skill.warnings)"
                      :aria-label="`提示：${warningsTitle(skill.warnings)}`"
                      data-testid="skill-warning-mark"
                    ><AppIcon name="circle-alert" :size="12" /></span>
                    <span class="ml-auto flex shrink-0 items-center gap-1 pl-1">
                      <span class="text-xs text-gray-600">{{ fileCountText(skill) }}</span>
                      <AppIcon
                        name="chevron-right"
                        :size="12"
                        class="h-3 w-3 text-gray-600 transition-transform"
                        :class="expandedSkillName === skill.name ? 'rotate-90' : ''"
                      />
                    </span>
                  </span>
                  <span class="line-clamp-2 pl-[21px] text-xs leading-relaxed text-gray-500">{{ skill.description }}</span>
                </button>
                <!-- 行尾更多：删除技能（hover 浮现；触屏恒显） -->
                <button
                  class="shrink-0 rounded p-1 text-gray-600 opacity-0 transition-opacity hover:text-gray-300 focus-visible:opacity-100 group-hover:opacity-100 max-lg:opacity-100"
                  :aria-label="`删除技能：${skill.name}`"
                  :title="`删除技能：${skill.name}`"
                  data-testid="skill-delete-button"
                  @click="requestDelete(skill)"
                >
                  <AppIcon name="trash" :size="13" class="h-[13px] w-[13px]" />
                </button>
              </div>

              <!-- 文件清单（清单首项是 SKILL.md，§3.2） -->
              <div v-if="expandedSkillName === skill.name" class="mt-1 ml-[21px] space-y-0.5 border-l border-white/10 pl-2" data-testid="skill-file-list">
                <button
                  :class="[
                    'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors',
                    skill.skillFilePath === activeFilePath
                      ? 'bg-white/15 text-white'
                      : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
                  ]"
                  data-testid="skill-file-entry"
                  @click.stop="emit('selectFile', skill.skillFilePath)"
                >
                  <AppIcon name="file-text" :size="13" class="h-[13px] w-[13px] shrink-0" />
                  <span class="truncate">SKILL.md</span>
                  <span class="ml-auto shrink-0 text-gray-600">技能正文</span>
                </button>
                <template v-for="file in skill.files" :key="file.path">
                  <!-- 脚本/不支持文件：灰显标已忽略，不可点开（决策 7） -->
                  <div
                    v-if="file.kind !== 'text'"
                    class="flex w-full cursor-default items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-gray-600"
                    :title="file.kind === 'script' ? '已忽略：NovAI 不执行脚本' : '不支持的文件类型'"
                    data-testid="skill-file-ignored"
                  >
                    <AppIcon name="file-text" :size="13" class="h-[13px] w-[13px] shrink-0 opacity-50" />
                    <span class="truncate">{{ file.path }}</span>
                    <span class="ml-auto shrink-0">{{ file.kind === 'script' ? '已忽略：不执行脚本' : '不支持的文件类型' }}</span>
                  </div>
                  <button
                    v-else
                    :class="[
                      'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors',
                      `${skill.directory}/${file.path}` === activeFilePath
                        ? 'bg-white/15 text-white'
                        : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
                    ]"
                    data-testid="skill-file-entry"
                    @click.stop="emit('selectFile', `${skill.directory}/${file.path}`)"
                  >
                    <AppIcon name="file-text" :size="13" class="h-[13px] w-[13px] shrink-0" />
                    <span class="truncate">{{ file.path }}</span>
                    <span class="ml-auto shrink-0 text-gray-600">{{ formatSkillFileSize(file.size) }}</span>
                  </button>
                </template>
                <p v-if="skill.filesOmitted" class="px-1.5 py-0.5 text-xs text-gray-600">其余 {{ skill.filesOmitted }} 个文件未列出</p>
              </div>
            </div>
          </li>
        </ul>

        <!-- broken 技能：列表末尾灰显，行内人话原因（决策 8） -->
        <ul v-if="filteredBroken.length > 0" class="mt-2 space-y-0.5" data-testid="skill-broken-list">
          <li v-for="skill in filteredBroken" :key="skill.name" class="rounded-md px-2 py-1.5">
            <div class="flex w-full flex-col gap-0.5 text-left">
              <span class="flex w-full items-center gap-1.5">
                <AppIcon name="sparkles" :size="15" class="h-[15px] w-[15px] shrink-0 text-gray-700" />
                <span class="truncate text-sm text-gray-600">{{ skill.name }}</span>
                <span class="ml-auto shrink-0 text-xs text-gray-700">AI 看不见</span>
              </span>
              <span class="pl-[21px] text-xs leading-relaxed text-gray-600" data-testid="skill-broken-reason">{{ skill.reason }}</span>
              <span class="flex items-start gap-2 pl-[21px]">
                <button
                  v-if="skill.skillFilePath"
                  class="shrink-0 rounded px-1 py-0.5 text-xs text-gray-400 underline decoration-gray-700 underline-offset-2 transition-colors hover:text-gray-200"
                  data-testid="skill-broken-fix"
                  @click="emit('selectFile', skill.skillFilePath)"
                >打开 SKILL.md 修复</button>
                <button
                  class="shrink-0 rounded px-1 py-0.5 text-xs text-gray-600 underline decoration-gray-700 underline-offset-2 transition-colors hover:text-red-400"
                  :aria-label="`删除技能：${skill.name}`"
                  data-testid="skill-broken-delete"
                  @click="requestDelete(skill)"
                >删除</button>
              </span>
            </div>
          </li>
        </ul>

        <!-- 搜索无结果 -->
        <p v-if="hasSearchMiss" class="px-2 py-2 text-xs text-gray-600">
          没有匹配「{{ searchQuery.trim() }}」的技能
        </p>
      </template>
    </div>

    <!-- 删除二次确认（决策 9：整夹删除不可撤销） -->
    <div
      v-if="deleteTarget"
      class="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="删除技能确认"
      data-testid="skill-delete-dialog"
    >
      <div class="w-full max-w-xs rounded-lg border border-white/10 bg-[#1f1f1f] p-4 shadow-xl">
        <h3 class="mb-2 text-sm font-semibold text-white">删除技能</h3>
        <p class="mb-1 text-xs leading-relaxed text-gray-300">
          将删除 <span class="rounded bg-white/10 px-1 font-mono text-[11px]">skills/{{ deleteTarget.name }}/</span> 整个文件夹（含全部附属文件），不可撤销。
        </p>
        <p v-if="deleteError" class="mb-2 text-xs text-red-400" data-testid="skill-delete-error">{{ deleteError }}</p>
        <div class="mt-3 flex justify-end gap-2">
          <button
            class="rounded-md px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="isDeleteBusy"
            @click="cancelDelete"
          >
            取消
          </button>
          <button
            class="rounded-md bg-red-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="isDeleteBusy"
            data-testid="skill-delete-confirm"
            @click="confirmDelete"
          >
            {{ isDeleteBusy ? '删除中…' : '删除' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
