import { ref } from 'vue'

/**
 * ReasoningCollapse 折叠状态机（composable，组件只做渲染接线）。
 *
 * 自动态：思考中（流式且正文未开始）默认展开；正文开始（thinking 翻 false）自动收起。
 * 手动态：用户点击后固定为手动值，不再跟随自动态（历史消息 thinking 恒 false → 默认收起，点击展开/收起）。
 * manual 必须是 ref：组件里 expanded 走 computed，普通闭包变量无法触发重算。
 */
export function createReasoningCollapseState() {
  const manual = ref<boolean | null>(null)

  return {
    /** 用户点击切换；传入当前有效展开态，翻转后固化为手动值 */
    toggle(currentExpanded: boolean): void {
      manual.value = !currentExpanded
    },
    /** 有效展开态：手动值优先，未手动时跟随自动态（思考中展开，正文开始收起） */
    expanded(thinking: boolean): boolean {
      return manual.value ?? thinking
    },
  }
}

export type ReasoningCollapseState = ReturnType<typeof createReasoningCollapseState>
