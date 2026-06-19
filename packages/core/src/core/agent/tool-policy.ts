/**
 * 用户即时工具约束（Agent 控制能力 Step 5）。
 *
 * 从用户本轮 instruction 解析出工具策略，在执行层强制禁用被约束的工具。
 * 不依赖 system prompt 的软提示——模型即使无视约束，执行层也会拦住。
 */

export type ToolPolicy = {
  /** 是否允许读取类工具（ReadFile/ListDirectory/FindFiles/RagSearch） */
  allowRead: boolean
  /** 是否允许写入类工具（EditFile/CreateFile/RenameFile/DeleteFile） */
  allowWrite: boolean
}

/** 默认策略：全部允许。无约束关键词时不影响任何现有行为。 */
export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  allowRead: true,
  allowWrite: true,
}

// 否定前缀：出现在动作词之前表示禁用
const NEGATIONS = ['不要', '不用', '无需', '别', '禁止', '不能', '不可以', '请勿']

// 读取类动作词（命中则可能禁读）
const READ_ACTIONS = ['读', '看', '查', '找', '翻', '浏览', '扫描', '检索', '读取', '查看', '查找', '读取文件', '阅读']

// 写入类动作词（命中则可能禁写）
const WRITE_ACTIONS = ['写', '改', '建', '删', '动', '修', '创建', '新建', '修改', '删除', '重命名', '写入', '改动', '保存']

/**
 * 从用户 instruction 解析工具策略。
 *
 * 识别"否定词 + 读/写动作词"的组合：
 * - "不要读任何文件" → allowRead: false
 * - "别改文件" → allowWrite: false
 * - "直接回答，不要查文件" → allowRead: false
 *
 * 漏判只是没禁（执行层是兜底，不出错）；误判风险通过要求"否定+动作"成对出现来降低。
 */
export function parseToolPolicy(instruction: string): ToolPolicy {
  const text = instruction.trim()
  if (!text) {
    return DEFAULT_TOOL_POLICY
  }

  // 找出所有否定词位置，检查其后（窗口内）是否出现动作词
  const hasReadDenial = hasNegationBeforeAction(text, READ_ACTIONS)
  const hasWriteDenial = hasNegationBeforeAction(text, WRITE_ACTIONS)

  // "不要碰文件/别动文件"这类用通用动词的全禁表达（同时禁读禁写）
  const hasGenericDenial = /(?:不要|别|禁止|请勿)\s*(?:碰|动)\s*(?:任何|所有)?\s*文件/.test(text)

  return {
    allowRead: !(hasReadDenial || hasGenericDenial),
    allowWrite: !(hasWriteDenial || hasGenericDenial),
  }
}

/**
 * 检查文本中是否存在"否定词 + 动作词（在窗口内）"的组合。
 * 窗口设为 6 个字符，覆盖"不要读取文件""别去查"等间隔表达。
 */
function hasNegationBeforeAction(text: string, actions: string[]): boolean {
  for (const negation of NEGATIONS) {
    let fromIndex = 0
    while (true) {
      const negIndex = text.indexOf(negation, fromIndex)
      if (negIndex === -1) {
        break
      }
      // 取否定词后 6 个字符的窗口
      const window = text.slice(negIndex + negation.length, negIndex + negation.length + 6)
      if (actions.some((action) => window.includes(action))) {
        return true
      }
      fromIndex = negIndex + 1
    }
  }
  return false
}

/**
 * 判定某工具是否被策略禁用。
 * 用 isReadOnly 二分，不硬编码工具名——未来加新工具自动归类。
 */
export function isToolDisabledByPolicy(
  tool: { isReadOnly: boolean },
  policy: ToolPolicy,
): boolean {
  if (tool.isReadOnly) {
    return !policy.allowRead
  }
  return !policy.allowWrite
}

/**
 * 生成面向模型的拒绝说明，回灌 tool result 让模型理解为何失败。
 */
export function describePolicyDenial(
  tool: { isReadOnly: boolean },
  policy: ToolPolicy,
): string {
  if (tool.isReadOnly && !policy.allowRead) {
    return '用户本轮要求不要读取或查找文件'
  }
  if (!tool.isReadOnly && !policy.allowWrite) {
    return '用户本轮要求不要修改、创建或删除文件'
  }
  return '该工具本轮被用户约束禁用'
}

/**
 * 工具可见性过滤：被禁工具不发给模型，从源头减少无效的工具调用往返。
 * 返回仍可用的工具列表（保留 isReadOnly/schema 等字段）。
 */
export function filterAvailableTools<T extends { isReadOnly: boolean }>(
  tools: T[],
  policy: ToolPolicy | undefined,
): T[] {
  if (!policy) {
    return tools
  }
  return tools.filter((tool) => !isToolDisabledByPolicy(tool, policy))
}

/**
 * 生成面向模型的约束声明，注入 system prompt / user context，
 * 让模型在 prompt 层也感知本轮约束（软约束，减少尝试调用被禁工具）。
 * 无约束时返回空字符串。
 */
export function describeActivePolicy(policy: ToolPolicy): string {
  const denied: string[] = []
  if (!policy.allowRead) {
    denied.push('读取类工具（ReadFile / ListDirectory / FindFiles / RagSearch）')
  }
  if (!policy.allowWrite) {
    denied.push('写入类工具（EditFile / CreateFile / RenameFile / DeleteFile）')
  }
  if (denied.length === 0) {
    return ''
  }
  return `【本轮工具约束】用户本轮已禁用：${denied.join('、')}。请用纯对话回答，或向用户确认是否解除限制；不要尝试绕过该约束。`
}
