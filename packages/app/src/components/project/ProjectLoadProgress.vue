<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '../ui/AppIcon.vue'
import { getPhaseRange } from '../../utils/project-load-progress'
import type { ProjectLoadProgressView } from '../../utils/project-load-progress'

/**
 * 打开类动作（打开 / 恢复 / 新建项目）的进度面板（《项目打开进度与移动端授权修复计划》§5）。
 *
 * - `panel`：一张卡片。首页原位替换「恢复项目」横幅，或放在新建对话框的名称输入框下方。
 * - `page`：铺满屏幕的白色底层加居中的同一张卡片，用于小说页内的恢复过程。
 *
 * 进度条：已完成部分实心，当前阶段的区间铺流动条纹。阶段与文案见计划「已拍死的取舍」第 8 条。
 */
const props = withDefaults(defineProps<{
  progress: ProjectLoadProgressView
  variant?: 'panel' | 'page'
}>(), {
  variant: 'panel',
})

const title = computed(() => {
  const name = props.progress.projectName
  if (!name) {
    return '正在打开项目…'
  }
  return props.progress.action === 'create'
    ? `正在创建「${name}」…`
    : `正在打开「${name}」…`
})

const phaseLabel = computed(() => {
  switch (props.progress.phase) {
    case 'permission':
      return '等待授权'
    case 'structure':
      return props.progress.action === 'create' ? '创建项目结构' : '检查项目结构'
    case 'scan':
      return '扫描文件'
    case 'activate':
      return '即将完成'
    default:
      return '载入工作区'
  }
})

/** 阶段明细的前半句；检查项目结构另有「刚处理完的路径」单独渲染。 */
const detail = computed(() => {
  const { phase, action } = props.progress
  switch (phase) {
    case 'permission':
      return action === 'create' ? '请选择存放项目的文件夹' : '请在弹窗中允许访问项目文件夹'
    case 'activate':
      return '正在记录本次打开'
    case 'scan': {
      const files = props.progress.files ?? 0
      const directories = props.progress.directories ?? 0
      const where = props.progress.currentPath
        ? `正在扫描 ${props.progress.currentPath}/`
        : '正在扫描项目根目录'
      return `已扫描 ${files} 个文件、${directories} 个文件夹；${where}`
    }
    case 'workspace':
      return '正在载入工作区…'
    default:
      return ''
  }
})

const stepLabel = computed(() => {
  if (props.progress.phase !== 'structure' || props.progress.total === undefined) {
    return ''
  }
  return `${props.progress.current ?? 0} / ${props.progress.total}`
})

const lastPath = computed(() => {
  if (props.progress.phase !== 'structure') {
    return ''
  }
  return props.progress.currentPath ?? ''
})

/** 条纹区间 = 当前阶段的区间；实心部分盖在它上面。 */
const stripeStyle = computed(() => {
  const [start, end] = getPhaseRange(props.progress.phase)
  return { left: `${start}%`, width: `${end - start}%` }
})
</script>

<template>
  <div :class="variant === 'page' ? 'fixed inset-0 z-[70] flex items-center justify-center bg-white px-6' : ''">
    <section
      class="rounded-lg border border-blue-200 bg-blue-50 p-4"
      :class="variant === 'page' ? 'w-full max-w-md shadow-sm' : ''"
      role="status"
      aria-busy="true"
      data-testid="project-load-card"
    >
      <div class="flex items-start justify-between gap-3">
        <p class="min-w-0 break-words text-sm font-medium text-blue-900" data-testid="project-load-title">
          {{ title }}
        </p>
        <span
          class="shrink-0 rounded-md border border-blue-200 bg-white px-2 py-0.5 text-xs font-medium text-blue-700"
          data-testid="project-load-phase"
        >
          {{ phaseLabel }}
        </span>
      </div>

      <div
        class="relative mt-3 h-2 overflow-hidden rounded-full bg-blue-100"
        role="progressbar"
        aria-label="项目打开进度"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="progress.percent"
      >
        <span class="project-load-stripes absolute inset-y-0" :style="stripeStyle" />
        <span class="absolute inset-y-0 left-0 bg-blue-600" :style="{ width: `${progress.percent}%` }" />
      </div>

      <p class="mt-2 text-xs leading-5 text-blue-700" data-testid="project-load-detail">
        <template v-if="stepLabel">{{ stepLabel }}</template>
        <template v-if="stepLabel && lastPath">
          <span class="mx-1.5 text-blue-300">·</span>
        </template>
        <span v-if="lastPath" class="break-all">{{ lastPath }}</span>
        <template v-if="stepLabel && detail">
          <span class="mx-1.5 text-blue-300">·</span>
        </template>
        <template v-if="detail">{{ detail }}</template>
      </p>
    </section>
  </div>
</template>

<style scoped>
/* 当前阶段区间的流动条纹：斜纹沿水平方向循环平移一个周期（16px / cos45°） */
.project-load-stripes {
  background-image: repeating-linear-gradient(
    -45deg,
    rgba(37, 99, 235, 0.3) 0 8px,
    rgba(37, 99, 235, 0.1) 8px 16px
  );
  animation: project-load-flow 0.9s linear infinite;
}

@keyframes project-load-flow {
  from {
    background-position: 0 0;
  }
  to {
    background-position: 22.63px 0;
  }
}

/* 系统开启「减少动态效果」：流动条改为静态半透明 */
@media (prefers-reduced-motion: reduce) {
  .project-load-stripes {
    animation: none;
    background-image: none;
    background-color: rgba(37, 99, 235, 0.18);
  }
}
</style>
