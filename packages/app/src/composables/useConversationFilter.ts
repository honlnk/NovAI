import { ref } from 'vue'

/**
 * 对话列表的搜索与筛选状态（交互优化计划 §3）。
 * 模块级单例（同 useToast 的先例）：列表组件读写，「已归档」提示里的
 * 「查看已归档」动作也经它切换筛选，不需要跨组件转发 ref。
 */
export type ConversationFilter = 'all' | 'active' | 'pending' | 'archived'

export const CONVERSATION_FILTER_META: Array<{ key: ConversationFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'pending', label: '待处理' },
  { key: 'archived', label: '已归档' },
]

const search = ref('')
const filter = ref<ConversationFilter>('all')

export function useConversationFilter() {
  /** 跳到「已归档」筛选并清空搜索（归档提示「查看已归档」动作的入口） */
  function showArchived() {
    search.value = ''
    filter.value = 'archived'
  }

  return { search, filter, showArchived }
}
