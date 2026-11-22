<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
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

/**
 * 矮屏滚动提示：滚动区上/下缘还有被遮住的内容时亮起发光带（双向对称）。
 * 纯 CSS 判定不了「是否可滚动」，由 scroll 事件 + ResizeObserver 维护该状态。
 */
const scrollArea = ref<HTMLElement | null>(null)
const canScrollUp = ref(false)
const canScrollDown = ref(false)

function updateScrollHint() {
  const el = scrollArea.value
  if (!el) return
  // 1px 容差防浮点误差；滚到头（该侧没有隐藏内容）即熄灭
  canScrollUp.value = el.scrollTop > 1
  canScrollDown.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1
}

let hintObserver: ResizeObserver | null = null

onMounted(() => {
  const el = scrollArea.value
  if (!el) return
  el.addEventListener('scroll', updateScrollHint, { passive: true })
  // 观察滚动区自身（视口/布局变化）与两个内容组（将来增删图标项），高度变化后重算
  const observer = new ResizeObserver(updateScrollHint)
  hintObserver = observer
  observer.observe(el)
  Array.from(el.children).forEach((child) => observer.observe(child))
})

onBeforeUnmount(() => {
  scrollArea.value?.removeEventListener('scroll', updateScrollHint)
  hintObserver?.disconnect()
  hintObserver = null
})
</script>

<template>
  <!-- z-[46]：显式层级让分类抽屉（z-[45]）收起时从工具栏下方滑过而不是盖过它；
       仍低于全屏弹窗/tooltip 的 z-50（z 序：遮罩 40 < 抽屉 45 < 工具栏 46 < 弹窗 50） -->
  <!-- 矮屏溢出（两段式）：分隔线 + 设置 + 返回首页固定在底座、矮屏也不消失；
       其余内容在中部滚动区内滚动。滚动区内部仍是 flex sticky-footer 模式——
       不用 justify-between（负剩余空间下起点侧溢出不可达），动作组用 mt-auto：
       规范规定 auto margin 在剩余空间为负时按 0 处理，空间充裕时动作组贴底
       （视觉同 justify-between），溢出时与分类组合拢、区内滚动。 -->
  <nav class="z-[46] flex w-14 shrink-0 flex-col border-r border-white/10 bg-[#171717] py-2">
    <!-- 中部滚动区：外包 relative 壳挂发光提示层——提示层不能放进滚动容器，
         否则 absolute bottom-0 会锚到内容末端、随内容一起滚走 -->
    <div class="relative flex min-h-0 flex-1 flex-col">
      <div ref="scrollArea" class="flex min-h-0 flex-1 flex-col items-center overflow-y-auto">
        <!-- 顶部分类图标 -->
        <div class="flex shrink-0 flex-col items-center gap-1">
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

        <!-- 底部动作项：功能占位（mt-auto：贴底，溢出时自动合拢参与滚动区内滚动） -->
        <div class="mt-auto flex shrink-0 flex-col items-center gap-1">
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
        </div>
      </div>

      <!-- 发光提示（双向）：该侧还有被遮住的内容时亮起；不挡点击/悬停、不随内容滚动。
           各向越界 8px 贴住视觉边界——顶部贴 nav 顶缘（py-2）、底部亮缘正对分隔线
           （底座 pt-1 + 分隔线 my-1），光从「内容消失线」发出 -->
      <div
        aria-hidden="true"
        :class="[
          'pointer-events-none absolute inset-x-0 -top-2 h-8 bg-linear-to-b from-white/15 via-white/5 to-transparent transition-opacity duration-200',
          canScrollUp ? 'opacity-100' : 'opacity-0',
        ]"
      />
      <div
        aria-hidden="true"
        :class="[
          'pointer-events-none absolute inset-x-0 -bottom-2 h-8 bg-linear-to-t from-white/15 via-white/5 to-transparent transition-opacity duration-200',
          canScrollDown ? 'opacity-100' : 'opacity-0',
        ]"
      />
    </div>

    <!-- 固定底座：分隔线 + 设置 + 返回首页（矮屏也始终可见可点） -->
    <div class="flex shrink-0 flex-col items-center gap-1 pt-1">
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
