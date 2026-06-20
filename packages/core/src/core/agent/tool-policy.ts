/**
 * 用户即时工具约束（Agent 控制能力 Step 5）。
 *
 * 从用户本轮 instruction 解析出工具策略，在执行层强制禁用被约束的工具。
 * 不依赖 system prompt 的软提示——模型即使无视约束，执行层也会拦住。
 */

import { normalizeProjectPath } from '../tools/path'

export type ToolPolicy = {
  /** 是否允许读取类工具（ReadFile/ListDirectory/FindFiles/RagSearch） */
  allowRead: boolean
  /** 是否允许写入类工具（EditFile/CreateFile/RenameFile/DeleteFile） */
  allowWrite: boolean
  /**
   * 路径约束：写工具的路径必须落在此文件上。
   * - EditFile/CreateFile/DeleteFile 的 path 必须等于此值；
   * - RenameFile 整个禁用（重命名/移动会让「当前文件」概念失效）；
   * - undefined 表示无路径约束。
   */
  allowedWritePath?: string
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
 * 也识别正面表达（"只读/只看不改"）和路径约束（"只改当前文件"）：
 * - "只读不改" / "只看不写" → allowWrite: false
 * - "只改当前文件" / "就在这个文件改" → allowedWritePath（需传入 activeFilePath）
 *
 * 漏判只是没禁（执行层是兜底，不出错）；误判风险通过要求"否定+动作"成对出现来降低。
 */
export function parseToolPolicy(instruction: string, activeFilePath?: string | null): ToolPolicy {
  const text = instruction.trim()
  if (!text) {
    return DEFAULT_TOOL_POLICY
  }

  // 找出所有否定词位置，检查其后（窗口内）是否出现动作词
  const hasReadDenial = hasNegationBeforeAction(text, READ_ACTIONS)
  const hasWriteDenial = hasNegationBeforeAction(text, WRITE_ACTIONS)

  // "不要碰文件/别动文件"这类用通用动词的全禁表达（同时禁读禁写）
  const hasGenericDenial = /(?:不要|别|禁止|请勿)\s*(?:碰|动)\s*(?:任何|所有)?\s*文件/.test(text)

  // 正面表达："只/仅 + 读/看/分析/讨论 + (可选否定) + 写/改/动/修"，如"只读不改""只看不写""只分析不修改"。
  // 这类表达意图是"只读不写"，应禁用写入工具。
  const hasReadOnlyIntent = /(?:只|仅)\s*(?:读|看|分析|讨论).{0,4}(?:不|别|勿)\s*(?:写|改|动|修|改文件|动文件|修改)/.test(text)
    || /(?:只|仅)\s*(?:不|别)\s*(?:写|改|动|修|改文件|动文件|修改)/.test(text)

  // 路径约束："只改当前文件""就在这个文件改""别动其他文件"——意图把写入限制在当前文件。
  // 单独成句的"只改当前文件"也匹配（不要求否定词）。
  const hasCurrentFileIntent = /(?:只|仅|就)\s*(?:在|于)?\s*(?:当前|这个|本|当前这个)\s*文件\s*(?:里|内|中)?\s*(?:改|写|动|修|编辑|操作)/.test(text)
    || /(?:只|仅|就)\s*(?:改|写|动|修|编辑|操作|动)\s*(?:当前|这个|本|当前这个)\s*文件/.test(text)
    || /(?:不要|别|无需|不用)\s*(?:动|改|碰|写)\s*(?:其他|其它|别的)\s*文件?/.test(text)
    || /(?:只|仅)\s*(?:动|改|碰|写|操作)\s*(?:当前|这个|本)\s*(?:一个)?\s*文件/.test(text)

  const allowRead = !(hasReadDenial || hasGenericDenial)

  const policy: ToolPolicy = {
    allowRead,
    // allowWrite 初始值见下方路径约束分支的覆盖逻辑。
    allowWrite: !(hasWriteDenial || hasGenericDenial || hasReadOnlyIntent),
  }

  // 路径约束：用户意图把写入限制在当前文件。
  // - 有 activeFilePath：设白名单路径，allowWrite 保持 true（允许写，只是限定在当前文件）。
  //   注意此时若 hasWriteDenial 误命中（如「别动其他文件」被识别为全禁写），路径约束是更具体的意图，
  //   应覆盖全禁写——语义是「能动当前文件」而非「全禁写」。
  // - 无 activeFilePath：无法确定白名单，保守降级为全禁写。
  if (hasCurrentFileIntent) {
    if (activeFilePath) {
      try {
        policy.allowedWritePath = normalizeProjectPath(activeFilePath)
        policy.allowWrite = true
      } catch {
        // activeFilePath 本身不合法（理论上不应发生），降级为禁写。
        policy.allowWrite = false
      }
    } else {
      policy.allowWrite = false
    }
  }

  return policy
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
 *
 * 注意：此函数只处理读/写布尔级别的约束。路径级约束（allowedWritePath）
 * 由 isWriteBlockedByPathPolicy 在执行层处理（那里能拿到工具的 input 路径）。
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
 * 判定写工具是否被路径级约束拦截。
 * 在执行层调用（此时 validatedInput 已规整）：
 * - policy 无 allowedWritePath → 不拦；
 * - RenameFile → 恒拦（重命名/移动不在「只改当前文件」覆盖范围内）；
 * - EditFile/CreateFile/DeleteFile → path 不等于 allowedWritePath 则拦；
 * - 只读工具 → 不拦（路径约束只管写）。
 */
export function isWriteBlockedByPathPolicy(
  toolName: string,
  validatedInput: unknown,
  policy: ToolPolicy | undefined,
): { blocked: boolean; reason?: string } {
  if (!policy?.allowedWritePath) {
    return { blocked: false }
  }

  const allowed = policy.allowedWritePath

  if (toolName === 'RenameFile') {
    return {
      blocked: true,
      reason: `用户本轮要求只修改当前文件（${allowed}），重命名/移动不在该约束覆盖范围内`,
    }
  }

  if (toolName === 'EditFile' || toolName === 'CreateFile' || toolName === 'DeleteFile') {
    const inputPath = readPathField(validatedInput)
    if (inputPath !== undefined && inputPath !== allowed) {
      return {
        blocked: true,
        reason: `用户本轮要求只修改当前文件（${allowed}），不要改动其他文件`,
      }
    }
  }

  return { blocked: false }
}

/** 从已校验的工具 input 中提取 path 字段（EditFile/CreateFile/DeleteFile 统一用 path）。 */
function readPathField(validatedInput: unknown): string | undefined {
  if (validatedInput && typeof validatedInput === 'object' && 'path' in validatedInput) {
    const value = (validatedInput as { path: unknown }).path
    return typeof value === 'string' ? value : undefined
  }
  return undefined
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
 *
 * 注意：路径级约束（allowedWritePath）在此层无法处理——它需要知道工具的具体路径，
 * 而可见性过滤发生在调用前。路径约束由执行层 isWriteBlockedByPathPolicy 兜底。
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

  if (denied.length === 0 && !policy.allowedWritePath) {
    return ''
  }

  const lines: string[] = []
  if (denied.length > 0) {
    lines.push(`用户本轮已禁用：${denied.join('、')}`)
  }
  if (policy.allowedWritePath) {
    lines.push(`写入操作仅限当前文件（${policy.allowedWritePath}），RenameFile（重命名/移动）不可用`)
  }

  return `【本轮工具约束】${lines.join('；')}。请用纯对话回答，或向用户确认是否解除限制；不要尝试绕过该约束。`
}
