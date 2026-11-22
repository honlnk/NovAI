<script setup lang="ts">
import type { Category } from '../../constants/category'
import Tooltip from '../ui/Tooltip.vue'
import AppIcon from '../ui/AppIcon.vue'

defineProps<{
  activeCategory: Category
}>()

const emit = defineEmits<{
  select: [category: Category]
  openSettings: []
  backToHome: []
  /** 功能占位项：暂未实现，仅保留入口 */
  proofread: []
  organize: []
  version: []
  /** 管理要素：单击触发（入口重构 W2 起父级为无操作占位，W4 接管为直聊会话） */
  'element-manager': []
  /** 打开向量索引独立管理页（RagIndexModal） */
  rag: []
  /** 打开关系图谱弹窗（RelationModal） */
  relation: []
  /** 打开时间轴弹窗（TimelineModal） */
  timeline: []
}>()

/**
 * 顶部分类项（设置走单独的 openSettings，不在此列）。
 * 顺序按产品决策：对话 → 章节 → 要素 → 提示词 → 技能 → 计划 → 伏笔（提示词之后、设置之前）。
 * 技能排在提示词之后、计划之前（技能包 UI/UX 施工计划决策 3）。
 */
const categoryItems: { key: Category; label: string; icon: string }[] = [
  { key: 'conversation', label: '对话', icon: 'chat' },
  { key: 'chapter', label: '章节', icon: 'book' },
  { key: 'element', label: '要素', icon: 'tag' },
  { key: 'prompt', label: '提示词', icon: 'note' },
  { key: 'skill', label: '技能', icon: 'skill' },
  { key: 'plan', label: '计划', icon: 'clipboard' },
  { key: 'foreshadowing', label: '伏笔', icon: 'foreshadowing' },
  { key: 'rhythm', label: '节奏', icon: 'rhythm' },
]

/**
 * 底部功能项。
 * enabled 标记是否已实现：已实现的正常态可点击，未实现的灰一档提示「即将推出」。
 * 顺序对应原 FileTreeSidebar 底部：校对 → 章节整理 → 版本管理，管理要素与向量索引为后补。
 */
const actionItems: { key: 'proofread' | 'organize' | 'version' | 'element-manager' | 'rag' | 'relation' | 'timeline'; label: string; icon: string; enabled: boolean }[] = [
  { key: 'proofread', label: '校对', icon: 'check', enabled: false },
  // 章节整理的机械改名工具已下线（2026-09-21）：它是未来 AI 整理模块的前置基建，
  // 待该模块立计划开发时再启用；命名规范的工具层强制不受影响。
  { key: 'organize', label: '章节整理', icon: 'list', enabled: false },
  { key: 'version', label: '版本管理', icon: 'branch', enabled: false },
  // 管理要素：与聊天输入框工具栏同款委派入口，区别在于固定在全新会话中发送，
  // 不占用当前会话的上下文。图标与 ChatPanel 工具栏按钮同为叶子。
  { key: 'element-manager', label: '管理要素', icon: 'library', enabled: true },
  { key: 'rag', label: '向量索引', icon: 'database', enabled: true },
  // 关系图谱：人物/势力/地点关系的可视化画布与登记入口（关系图谱施工计划 §六）
  { key: 'relation', label: '关系图谱', icon: 'network', enabled: true },
  // 时间线：事件账本的时间轴弹窗入口（时间线 JSON 化改造施工计划 §9.4）
  { key: 'timeline', label: '时间线', icon: 'timeline', enabled: true },
]

/**
 * 模板里不能直接动态调 emit（联合类型无法匹配 emit 重载），
 * 在 script 里集中分发。
 */
function emitAction(key: 'proofread' | 'organize' | 'version' | 'element-manager' | 'rag' | 'relation' | 'timeline') {
  switch (key) {
    case 'proofread': emit('proofread'); break
    case 'organize': emit('organize'); break
    case 'version': emit('version'); break
    case 'element-manager': emit('element-manager'); break
    case 'rag': emit('rag'); break
    case 'relation': emit('relation'); break
    case 'timeline': emit('timeline'); break
  }
}
</script>

<template>
  <!-- z-[46]：显式层级让分类抽屉（z-[45]）收起时从工具栏下方滑过而不是盖过它；
       仍低于全屏弹窗/tooltip 的 z-50（z 序：遮罩 40 < 抽屉 45 < 工具栏 46 < 弹窗 50） -->
  <nav class="z-[46] flex w-14 shrink-0 flex-col items-center justify-between border-r border-white/10 bg-[#171717] py-2">
    <!-- 顶部分类图标 -->
    <div class="flex flex-col items-center gap-1">
      <Tooltip
        v-for="item in categoryItems"
        :key="item.key"
        :text="item.label"
        preferred-placement="right"
      >
        <button
          :aria-label="item.label"
          :class="[
            'group flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
            activeCategory === item.key
              ? 'bg-white/15 text-white'
              : 'text-gray-400 hover:bg-white/10 hover:text-gray-200',
          ]"
          @click="emit('select', item.key)"
        >
          <!-- 对话 -->
          <AppIcon name="message-circle-more" :size="20" class="h-5 w-5" v-if="item.icon === 'chat'" />
          <!-- 章节 -->
          <AppIcon name="book-open" :size="20" class="h-5 w-5" v-else-if="item.icon === 'book'" />
          <!-- 要素 -->
          <AppIcon name="tag" :size="20" class="h-5 w-5" v-else-if="item.icon === 'tag'" />
          <!-- 提示词 -->
          <AppIcon name="clipboard-check" :size="20" class="h-5 w-5" v-else-if="item.icon === 'note'" />
          <!-- 技能（星火——可复用的写作方法素材） -->
          <AppIcon name="sparkles" :size="20" class="h-5 w-5" v-else-if="item.icon === 'skill'" />
          <!-- 计划（剪贴板清单） -->
          <AppIcon name="clipboard-list" :size="20" class="h-5 w-5" v-else-if="item.icon === 'clipboard'" />
          <!-- 伏笔（遮眼——隐藏的线索与真相） -->
          <AppIcon name="eye-off" :size="20" class="h-5 w-5" v-else-if="item.icon === 'foreshadowing'" />
          <!-- 节奏（心律波纹——全本节奏曲线） -->
          <AppIcon name="activity" :size="20" class="h-5 w-5" v-else />
        </button>
      </Tooltip>
    </div>

    <!-- 底部动作项：功能占位 + 设置 + 返回首页 -->
    <div class="flex flex-col items-center gap-1">
      <!-- 功能项：已实现的正常态，未实现的灰一档提示「即将推出」 -->
      <Tooltip
        v-for="item in actionItems"
        :key="item.key"
        :text="item.enabled ? item.label : `${item.label}（即将推出）`"
        :delay="300"
        preferred-placement="right"
      >
        <button
          :aria-label="item.enabled ? item.label : `${item.label}（即将推出）`"
          :class="[
            'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
            item.enabled
              ? 'text-gray-400 hover:bg-white/10 hover:text-gray-200'
              : 'text-gray-600 hover:bg-white/10 hover:text-gray-400',
          ]"
          @click="emitAction(item.key)"
        >
          <!-- 校对 -->
          <AppIcon name="circle-check" :size="20" class="h-5 w-5" v-if="item.icon === 'check'" />
          <!-- 章节整理 -->
          <AppIcon name="list" :size="20" class="h-5 w-5" v-else-if="item.icon === 'list'" />
          <!-- 版本管理 -->
          <AppIcon name="arrows-right-left" :size="20" class="h-5 w-5" v-else-if="item.icon === 'branch'" />
          <!-- 管理要素（书架，与聊天工具栏按钮同款） -->
          <AppIcon name="library" :size="20" class="h-5 w-5" v-else-if="item.icon === 'library'" />
          <!-- 向量索引（circle-stack） -->
          <AppIcon name="database" :size="20" class="h-5 w-5" v-else-if="item.icon === 'database'" />
          <!-- 关系图谱（节点连线网络） -->
          <AppIcon name="network" :size="20" class="h-5 w-5" v-else-if="item.icon === 'network'" />
          <!-- 时间线（时钟回溯——故事内时间轴） -->
          <AppIcon name="timeline" :size="20" class="h-5 w-5" v-else />
        </button>
      </Tooltip>

      <!-- 分隔线 -->
      <div class="my-1 h-px w-6 bg-white/10" />

      <Tooltip text="设置" :delay="300" preferred-placement="right">
        <button
          aria-label="设置"
          class="flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200"
          @click="emit('openSettings')"
        >
          <AppIcon name="settings" :size="20" class="h-5 w-5" />
        </button>
      </Tooltip>
      <Tooltip text="返回首页" :delay="300" preferred-placement="right">
        <button
          aria-label="返回首页"
          class="flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/10 hover:text-gray-200"
          @click="emit('backToHome')"
        >
          <AppIcon name="home" :size="20" class="h-5 w-5" />
        </button>
      </Tooltip>
    </div>
  </nav>
</template>
