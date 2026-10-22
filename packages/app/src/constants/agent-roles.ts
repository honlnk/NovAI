import type { AgentRoleId } from '@novai/core/services/types'

/**
 * 会话角色的 UI 展示元数据（core 角色声明的 app 侧投影）：
 * label 用于会话列表分组头、直聊横幅；icon 为组件内 svg 图标键。
 * 新增角色时在此补一条映射（与 core 的 AGENT_ROLES 注册声明对应）。
 */
export const AGENT_ROLE_META: Record<AgentRoleId, {
  label: string
  /** 会话列表分组头/横幅图标键（组件内按 key 渲染 svg） */
  icon: 'chat' | 'library'
  /** 直聊横幅的角色范围说明（仅特化角色用） */
  scopeNote?: string
  /** 直聊会话的输入框 placeholder */
  inputPlaceholder?: string
}> = {
  main: {
    label: '主智能体',
    icon: 'chat',
  },
  'element-manager': {
    label: '要素管理员',
    icon: 'library',
    scopeNote: '仅可管理 elements/ 目录',
    inputPlaceholder: '向要素管理员描述任务… (Enter 发送，Shift+Enter 换行)',
  },
}
