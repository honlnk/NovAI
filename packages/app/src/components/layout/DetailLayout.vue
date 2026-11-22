<script setup lang="ts">
import PanelHeader from './PanelHeader.vue'
import SaveStatusLight from './SaveStatusLight.vue'
import ViewModeToggle from './ViewModeToggle.vue'
import DetailFooterBar from './DetailFooterBar.vue'
import type { DetailMode } from './detail-mode'
import type { DetailSavePhase } from './detail-save-phase'

/**
 * 统一详情布局（六个模块右侧详情布局统一计划 阶段 2）：六个模块右侧详情的
 * 唯一布局——公共头部（标题在左、保存状态紧随、预览／编辑在右）、消息区、
 * 领域工具区、主内容区与底部信息行的显示顺序、间距与滚动边界。
 *
 * 布局只接收展示数据、发出关闭与模式切换事件并提供插槽；不读取项目、文件
 * 或卡片状态仓库，不调用保存服务，不包含任何领域分支。标题、消息、工具、
 * 正文与冲突比较的内容和业务事件由领域通过插槽注入。
 *
 * 布局规则（§三.2 最终布局规格）：
 * - 未选择内容（hasContent=false）：标题用 fallback，隐藏状态灯、模式切换
 *   与整个底部；空状态提示仍在主内容插槽；
 * - 冲突展开（conflictExpanded）：只替代常规工具区、主内容与底部；消息区
 *   常驻——守护横幅（含恢复/放弃出口）、恢复提示等必要信息不随冲突展开消失
 *   （冲突紧凑条等由领域在展开态自行隐藏）；
 * - 领域工具区无内容不渲染容器；消息出现／收起只重新分配主内容剩余高度
 *   （消息 shrink-0、主内容与冲突比较区 flex-1 内部滚动），页面级滚动只有
 *   面板一个责任方。
 */
const props = withDefaults(
  defineProps<{
    /** 当前详情视图模式（预览／编辑） */
    mode: DetailMode
    /** 是否存在已选内容（未选：隐藏状态灯、模式切换与底部） */
    hasContent: boolean
    /** 保存阶段（五态；由领域按统一优先顺序派生） */
    savePhase: DetailSavePhase
    /** 项目内真实相对路径（底部左栏；未选内容由 hasContent 隐藏整个底部） */
    path?: string | null
    /** 更新时间（底部右栏完整本地化） */
    updatedAt?: string | null
    /** 是否允许编辑（文件不可编辑类型只禁用编辑按钮，不影响预览） */
    canEdit?: boolean
    /** 编辑禁用原因（切换控件 tooltip 解释） */
    editDisabledReason?: string
    /** 可访问名称后缀（卡片传「正文」→「预览正文／编辑正文」） */
    noun?: string
    /** 未选择内容时的标题（默认「内容预览」） */
    titleFallback?: string
    /** 冲突展开接管主内容区（隐藏常规工具区、主内容与底部） */
    conflictExpanded?: boolean
    /** 保存状态灯测试标识 */
    saveTestid?: string
  }>(),
  {
    canEdit: true,
    editDisabledReason: undefined,
    noun: undefined,
    titleFallback: '内容预览',
    conflictExpanded: false,
    saveTestid: undefined,
  },
)

const emit = defineEmits<{
  close: []
  modeChange: [mode: DetailMode]
}>()
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="detail-layout">
    <PanelHeader @close="emit('close')">
      <template #leading>
        <!-- 标题：文件只读名称 / 卡片可编辑名称 / 未选 fallback -->
        <slot name="title">
          <h2 class="truncate text-sm font-semibold text-gray-800">{{ titleFallback }}</h2>
        </slot>
        <!-- 保存状态紧随标题（唯一位置；不再出现在底部） -->
        <SaveStatusLight v-if="hasContent" :phase="savePhase" :testid="saveTestid" />
        <!-- 头部元信息：字数、格式等（空间不足时优先隐藏） -->
        <slot v-if="hasContent" name="meta" />
      </template>
      <template #actions>
        <ViewModeToggle
          v-if="hasContent"
          :mode="mode"
          :noun="noun"
          :edit-disabled="!canEdit"
          :edit-disabled-reason="editDisabledReason"
          @change="emit('modeChange', $event)"
        />
      </template>
    </PanelHeader>

    <!-- 内容区：统一四边留白；消息 shrink-0 + 主内容/冲突比较 flex-1 内部滚动 -->
    <div class="flex min-h-0 flex-1 flex-col p-4">
      <!-- 消息区：守护、恢复、冲突紧凑条与失败提示（领域注入，自带容器与下间距）。
           冲突展开时常驻——守护横幅及其处理出口不能随冲突展开消失 -->
      <slot name="message" />

      <template v-if="conflictExpanded">
        <!-- 冲突比较：接管主内容区（隐藏常规工具、主内容与底部） -->
        <slot name="conflict" />
      </template>
      <template v-else>
        <!-- 领域工具区：无内容不渲染容器，不占顶部空间 -->
        <div v-if="$slots.tools" class="shrink-0 pb-2">
          <slot name="tools" />
        </div>
        <!-- 主内容区：正文、双正文、表单等（内部滚动责任方） -->
        <div class="flex min-h-0 flex-1 flex-col">
          <slot name="content" />
        </div>
        <!-- 底部信息行：左真实路径、右完整时间；不承载保存状态 -->
        <DetailFooterBar
          v-if="hasContent"
          :path="path"
          :updated-at="updatedAt"
          class="shrink-0 pt-3"
        />
      </template>
    </div>
  </div>
</template>
