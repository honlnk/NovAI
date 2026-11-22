import type { AgentRunnableTool } from './tools'
import type { AgentToolName } from './messages'

/**
 * Agent 主动提问工具（《Agent 主动提问工具计划》）。
 *
 * 服务创作协作：Agent 在任务执行中途遇到「不问清就没法继续」的分叉时，提出一个
 * 结构化问题（单选/多选/自由文本），任务在工具内挂起等用户作答，答案作为工具
 * 结果回灌模型、原任务继续。区别于两条既有链路——不是写文件前的权限确认
 * （confirm 链），也不替代普通聊天里的自由提问（普通文本回复仍在）。
 *
 * 与 DelegateToElementManager 同款组装形态：依赖当前会话的提问回调（会话层闭包，
 * 经 RoleToolContext 注入），不进 core 纯工具注册表；仅主智能体工具面装配它，
 * 要素管理员直聊/委派会话不装（计划「角色、权限与生命周期」）。
 */

/** 一次提问的候选项：短标签 + 一句影响说明（说明可为空）。 */
export type AskUserQuestionOption = {
  label: string
  /** 选择该项意味着什么（一句）；空字符串省略 */
  description?: string
}

export type AskUserQuestionInput = {
  question: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
}

/** 提问的结局：用户提交了回答 / 用户跳过（或停止、异常——均归为取消）。 */
export type AskUserQuestionOutcome = 'answered' | 'cancelled'

export type AskUserQuestionOutput = {
  /** 用户所选候选项的标签数组（多选完整保留；纯文本回答时为空数组） */
  selectedLabels: string[]
  /** 用户补充的自由文本（可只选不写、只写不选、两者并存） */
  text: string
  outcome: AskUserQuestionOutcome
}

/**
 * 提问回调（会话层实现并注入）：广播待回答请求 → 等待 UI 调 respondQuestion /
 * skipQuestion → resolve。取消（跳过/停止/异常）resolve 为 outcome: 'cancelled'。
 */
export type AskUserQuestionHandler = (input: {
  question: AskUserQuestionInput
  toolCallId: string
}) => Promise<AskUserQuestionOutput>

/**
 * 输入校验（计划「输入校验」节）：
 * - 问题正文去首尾空白后非空；
 * - 候选项标签非空、不重复；影响说明可为空；
 * - 非法参数抛可理解错误（由工具执行层转为失败结果回灌模型修正重试，不中断会话）。
 */
export function validateAskUserQuestionInput(input: unknown): AskUserQuestionInput {
  if (!input || typeof input !== 'object') {
    throw new Error('AskUserQuestion 参数必须是包含 question 的对象')
  }
  const record = input as Record<string, unknown>

  const question = typeof record.question === 'string' ? record.question.trim() : ''
  if (!question) {
    throw new Error('question 不能为空：问题正文应简洁、具体，能在项目上下文中理解')
  }

  const header = typeof record.header === 'string' ? record.header.trim() : ''

  let options: AskUserQuestionOption[] | undefined
  if (record.options !== undefined) {
    if (!Array.isArray(record.options)) {
      throw new Error('options 必须是候选项数组，每项包含 label 与可选 description')
    }
    if (record.options.length === 0) {
      throw new Error('options 不能是空数组：纯开放问题请省略 options 字段')
    }
    if (record.options.length > 6) {
      throw new Error('options 最多 6 项：候选项用于降低选择成本，过多反而提高阅读负担')
    }
    const labels = new Set<string>()
    options = record.options.map((raw) => {
      if (!raw || typeof raw !== 'object') {
        throw new Error('候选项必须是包含 label 的对象')
      }
      const option = raw as Record<string, unknown>
      const label = typeof option.label === 'string' ? option.label.trim() : ''
      if (!label) {
        throw new Error('候选项 label 不能为空')
      }
      if (labels.has(label)) {
        throw new Error(`候选项 label 重复：${label}`)
      }
      labels.add(label)
      const description = typeof option.description === 'string' ? option.description.trim() : ''
      return description ? { label, description } : { label }
    })
  }

  const multiSelect = record.multiSelect === true

  return {
    question,
    ...(header ? { header } : {}),
    ...(options ? { options } : {}),
    ...(multiSelect ? { multiSelect: true } : {}),
  }
}

/**
 * 构造主动提问工具（主智能体工具面成员）。提问回调由会话层注入；未注入时
 * （测试/只读场景）直接报错回灌，让模型改用普通文本提问。
 * isReadOnly: true（不写文件、不进确认链与改动账本）；isConcurrencySafe: false
 * （一次只处理一个提问，不为并行提问设计额外队列——按现有顺序执行语义运行）。
 */
export function createAskUserQuestionTool(context: {
  askUser?: AskUserQuestionHandler
}): AgentRunnableTool<AskUserQuestionInput, AskUserQuestionOutput> {
  return {
    name: 'AskUserQuestion',
    isReadOnly: true,
    isConcurrencySafe: false,
    schema: {
      type: 'function',
      function: {
        name: 'AskUserQuestion',
        description: `在任务执行中途向用户提出一个结构化问题并等待回答，回答会作为工具结果返回，你据此继续原任务。当继续当前任务确实需要用户决策或补充信息时使用（例如剧情走向分叉、设定取舍、命名选择）；闲聊、一般讨论和不阻塞任务的问题直接用普通回复文本提出，不要用本工具。本工具不是写文件前的确认步骤，也不要每次写入前都提问。

一次调用只提一个问题。question 简洁具体、能在项目上下文中理解，不要要求用户重复已提供的设定。候选项用于降低选择成本，不限制用户只能从中选择——用户可以只填自由文本。有推荐项时排在首位。`,
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: '问题正文，简洁、具体。',
            },
            header: {
              type: 'string',
              description: '可选，短标题（例如「剧情方向」），显示在问题上方。',
            },
            options: {
              type: 'array',
              description: '可选，候选项列表（最多 6 项）。每项含 label（短标签）与可选 description（一句影响说明：选它意味着什么）。有推荐项时排在首位。纯开放问题省略本字段。',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: '候选项短标签（1-5 个词）' },
                  description: { type: 'string', description: '可选，一句话说明选该项的影响' },
                },
                required: ['label'],
                additionalProperties: false,
              },
            },
            multiSelect: {
              type: 'boolean',
              description: '可选，是否允许多选，默认单选。',
            },
          },
          required: ['question'],
          additionalProperties: false,
        },
      },
    },
    core: {
      name: 'AskUserQuestion',
      description: '向用户提出结构化问题并等待回答',
      validateInput: validateAskUserQuestionInput,
      async run(validatedInput: AskUserQuestionInput, runtime) {
        if (!context.askUser) {
          throw new Error('提问回调未注入：无法向用户提问（应在会话层装配），请改用普通回复文本提问')
        }
        return context.askUser({
          question: validatedInput,
          toolCallId: runtime.toolCallId ?? '',
        })
      },
      summarizeInput(input: AskUserQuestionInput) {
        return `向用户提问：${input.question}`
      },
      summarizeOutput(output: AskUserQuestionOutput) {
        if (output.outcome === 'cancelled') {
          return '用户跳过了该问题'
        }
        const selected = output.selectedLabels.length > 0
          ? `选择了 ${output.selectedLabels.join('、')}`
          : ''
        return [selected, output.text.trim() ? `补充：${output.text.trim()}` : '']
          .filter(Boolean)
          .join('；') || '用户已回答'
      },
    },
    formatResult(output: AskUserQuestionOutput) {
      if (output.outcome === 'cancelled') {
        return [
          '用户跳过了这个问题（未提供答案）。',
          '请在不获得该答案的情况下继续：基于已有上下文选择最合理的方案推进，或向用户说明你需要的决策。',
        ].join('\n')
      }
      const lines: string[] = ['用户已回答该问题：']
      if (output.selectedLabels.length > 0) {
        lines.push(`所选选项：${output.selectedLabels.join('、')}`)
      }
      if (output.text.trim()) {
        lines.push(`补充说明：${output.text.trim()}`)
      }
      if (output.selectedLabels.length === 0 && !output.text.trim()) {
        lines.push('（用户提交了空答案）')
      }
      lines.push('', '请基于以上回答继续原任务。')
      return lines.join('\n')
    },
  }
}

/** 提问工具名（AgentToolName 联合的成员；类型层约束用）。 */
export const ASK_USER_QUESTION_TOOL_NAME: AgentToolName = 'AskUserQuestion'
