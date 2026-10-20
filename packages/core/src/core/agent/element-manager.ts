import { appendUserMessage, createModelView, setSystemMessage } from './model-view'
import { query } from './query'
import { createAgentTools, type AgentRunnableTool, type AgentRunnableToolMap } from './tools'
import type { ConfirmHandler, TaggedToolExecutionEvent, WriteConfirmationRequest } from './tool-execution'
import { readElementSchema } from '../fs/project-fs'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

/**
 * 要素管理员子代理（一次性、每次全新上下文，《要素园丁子代理设计》v3）。
 *
 * 提示词栈只有两层：硬编码 persona + prompts/ELEMENT.md 全文（§7.4）——
 * 提示词家族其余文件（system.md / NovAI.md / scenes/）一律不进要素管理员上下文。
 * 工具白名单 + elements/ 写路径闸在运行层强制，不依赖模型自觉。
 */

/** 要素管理员角色定义（硬编码，不可让渡的边界都在这里；工作细则在 ELEMENT.md）。 */
export const ELEMENT_MANAGER_PERSONA = `你是小说要素库的要素管理员，负责维护 elements/ 目录下的事实性要素文件。

铁律：
- 你从不修改 chapters/ 正文，也从不修改 prompts/ 下的任何文件（包括随本提示词注入的要素规范本身）。
- 你只能写入 elements/ 下的文件；其余一切只读。
- 合并同名/近名要素时保留旧文件全部事实；存疑不合并，列入汇报交用户拍板。
- 不删除、不重命名任何文件；确需删除/改名的列入汇报交用户处理。

任务结束时输出固定结构汇报：
## 改动文件清单
（每个文件一句话说明改了什么）
## 合并与迁移说明
（哪些条目被合并进哪里、依据是什么）
## 存疑事项
（需要用户拍板的疑似重复/冲突；没有则写「无」）
## 建议删除
（建议用户手动删除或改名的文件及理由；没有则写「无」）`

/** ELEMENT.md 缺失时的兜底提示（正常路径 repair 已补齐；防御性不阻塞运行）。 */
const SCHEMA_MISSING_NOTE = '（规范文件 prompts/ELEMENT.md 缺失，按上述内置守则工作）'

/**
 * 组装要素管理员 system prompt：persona + ELEMENT.md 全文，仅此两层。
 * schema 为空串时附缺失提示，不阻塞。
 */
export function buildElementManagerSystemPrompt(elementSchema: string): string {
  const schema = elementSchema.trim()
  return [
    ELEMENT_MANAGER_PERSONA,
    '',
    '---',
    '',
    '【本书要素规范（prompts/ELEMENT.md）】',
    '',
    schema || SCHEMA_MISSING_NOTE,
  ].join('\n')
}

/** 要素管理员可写工具（其余全项目只读）：入口是这两个，路径闸再强制 elements/ 前缀。 */
const ELEMENT_MANAGER_WRITABLE_TOOLS = ['CreateFile', 'EditFile'] as const

/** 要素管理员完整工具白名单（设计 §3.2 拍板：无 DeleteFile / RenameFile / GetFileChangeHistory / Web 工具 / 委派工具）。 */
const ELEMENT_MANAGER_TOOL_WHITELIST = [
  'ListDirectory',
  'FindFiles',
  'ReadFile',
  'RagSearch',
  ...ELEMENT_MANAGER_WRITABLE_TOOLS,
] as const

/**
 * 组装要素管理员工具面：全量工具表按白名单过滤，可写工具包一层 validateInput 路径闸——
 * 写目标不在 elements/ 下直接报错回灌（运行层强制，模型越界请求只会收到失败结果）。
 */
export function createElementManagerTools(): AgentRunnableToolMap {
  const full = createAgentTools()
  const tools: AgentRunnableToolMap = {}
  for (const name of ELEMENT_MANAGER_TOOL_WHITELIST) {
    const tool = full[name]
    if (!tool) {
      throw new Error(`要素管理员工具白名单引用了未注册工具：${name}`)
    }
    tools[name] = tool
  }
  for (const name of ELEMENT_MANAGER_WRITABLE_TOOLS) {
    tools[name] = guardElementsScope(tools[name]!)
  }
  return tools
}

/** 把可写工具的 validateInput 包上 elements/ 前缀闸（大小写不敏感；文件名本身保留大小写）。 */
function guardElementsScope(tool: AgentRunnableTool): AgentRunnableTool {
  return {
    ...tool,
    core: {
      ...tool.core,
      validateInput(input: unknown) {
        const validated = tool.core.validateInput(input)
        const path = (validated as { path?: unknown }).path
        if (typeof path !== 'string' || !path.toLowerCase().startsWith('elements/')) {
          throw new Error('要素管理员只能写入 elements/ 下的要素文件；该位置只读。如需改动请列入汇报交用户处理。')
        }
        return validated
      },
    },
  }
}

/** 要素管理员一次运行的产出：结构化汇报全文（persona 规定的 Markdown 结构）+ 运行状态。 */
export type ElementManagerRunResult = {
  report: string
  aborted: boolean
  toolCallCount: number
}

/**
 * 要素管理员运行配置合成（Phase 2 计划 D1/D2/D5）：
 * - 无覆盖块 → 原样返回（动态继承：每次委派时取主配置当时值）；
 * - llm 覆盖整组展开（normalize 已保证残缺块不落盘，此处覆盖字段必齐全）；
 * - permissionPreset 覆盖写进 settings——判定链（permission.ts 读
 *   project.config.settings.permissionPreset）无感知地双向生效：放宽与收紧都正确。
 *   覆盖注入做在 confirm 闭包的方案已否决（判 allow 时不会走到 confirm，只能放宽不能收紧，D1）。
 * - 合成结果仅在要素管理员运行内存中存在，不落盘；运行中主配置变更不影响本次（按次定格，D5）。
 */
export function mergeElementManagerOverrides(config: ProjectConfig): ProjectConfig {
  const elementManager = config.elementManager
  if (!elementManager) {
    return config
  }
  const llm = elementManager.llm ? { ...config.llm, ...elementManager.llm } : config.llm
  const permissionPreset = elementManager.permissionPreset ?? config.settings.permissionPreset
  return {
    ...config,
    llm,
    settings: { ...config.settings, permissionPreset },
  }
}

/**
 * 跑一次要素管理员任务：全新 ModelView（system = persona + ELEMENT.md，user = task）→
 * 复用主 Agent 的 query 循环（同压缩阈值、同 agentMaxTurns 安全阀）。
 * 配置先经 mergeElementManagerOverrides 合成（决策 3/4 的覆盖项：模型/思考档/确认档位，
 * 未覆盖项动态继承主配置——按次取值，运行中定格，D5）；合成后的 project 快照
 * 让权限判定与工具执行同步用要素管理员档位，handle 同引用零副作用。
 * 内层工具事件透传给 onEvent（带 agent: 'element-manager'），写确认透传给 confirm（带「要素管理员」标签）。
 */
export async function runElementManager(input: {
  task: string
  scope?: string
  project: ProjectSnapshot
  config: ProjectConfig
  elementSchema: string
  confirm?: ConfirmHandler
  signal?: AbortSignal
  onEvent?: (event: TaggedToolExecutionEvent) => void
}): Promise<ElementManagerRunResult> {
  const effectiveConfig = mergeElementManagerOverrides(input.config)
  const effectiveProject: ProjectSnapshot = { ...input.project, config: effectiveConfig }

  const view = createModelView()
  setSystemMessage(view, buildElementManagerSystemPrompt(input.elementSchema))

  const userLines = [
    `整理任务：${input.task}`,
    input.scope?.trim() ? `整理范围：${input.scope.trim()}` : '整理范围：整个 elements/ 要素库',
    '',
    '请按要素规范整理，结束时输出固定结构汇报。',
  ]
  appendUserMessage(view, userLines.join('\n'))

  let aborted = false
  let toolCallCount = 0

  const messages = await query({
    config: effectiveConfig,
    project: effectiveProject,
    view,
    tools: createElementManagerTools(),
    signal: input.signal,
    confirm: input.confirm,
    onEvent(event) {
      if (event.type === 'aborted') {
        aborted = true
        return
      }
      if (event.type === 'tool-call') {
        toolCallCount += 1
      }
      if (event.type === 'tool-call' || event.type === 'tool-result') {
        input.onEvent?.({ ...event, agent: 'element-manager' })
      }
    },
  })

  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  const report = lastAssistant && 'content' in lastAssistant
    ? lastAssistant.content.trim()
    : ''

  return {
    report: report || (aborted ? '（要素管理任务被停止，未产出完整汇报）' : '（子智能体未产出汇报）'),
    aborted,
    toolCallCount,
  }
}

/** /管理要素 斜杠命令的驱动 prompt（主 Agent 侧指令，照 INIT_NOVEL_PROMPT 用法）。 */
export const ELEMENT_MANAGER_TASK_PROMPT = `请立即调用 DelegateToElementManager 工具，把本次要素管理任务委派给要素管理子智能体执行，不要自己直接修改要素文件。

对 task 的要求（子智能体看不到本对话，必须自包含）：
- 整理整个 elements/ 要素库：核对同名与近名条目合并、frontmatter 规范（tags 去重、relatedChapters 取并集、lastUpdatedChapter 取最新）、正文按模板小节归位、按规范补写素材间链接。
- 子智能体会自己读写文件并对写入操作请求确认；存疑事项它会列进汇报。

收到汇报后，向用户转述要点：改了哪些文件、合并了什么、哪些存疑事项需要用户拍板、是否有建议删除的文件。`

export type DelegateToElementManagerInput = {
  task: string
  scope?: string
}

export type DelegateToElementManagerOutput = ElementManagerRunResult

/**
 * 构造委派工具（主 Agent 工具面成员；confirm/signal/事件转发由 session 层闭包注入——
 * 这些运行态在 ToolRuntime 里不存在，也不该存在）。
 *
 * 外层语义：isReadOnly（本工具不直接写文件；写确认全部发生在要素管理员内层工具上，
 * 与主 Agent 共用同一条确认链）、isConcurrencySafe: false（长任务，串行）。
 */
export function createDelegateToElementManagerTool(context: {
  confirm?: ConfirmHandler
  signal?: AbortSignal
  /** 要素管理员内层工具事件外发（session 层转聊天消息，事件自带 agent: 'element-manager'） */
  onSubagentEvent?: (event: TaggedToolExecutionEvent) => void
}): AgentRunnableTool<DelegateToElementManagerInput, DelegateToElementManagerOutput> {
  const confirm = context.confirm
    ? (request: WriteConfirmationRequest) =>
        context.confirm!({ ...request, agentLabel: '要素管理' })
    : undefined

  return {
    name: 'DelegateToElementManager',
    isReadOnly: true,
    isConcurrencySafe: false,
    schema: {
      type: 'function',
      function: {
        name: 'DelegateToElementManager',
        description: `委派要素管理子智能体整理 elements/ 要素库（合并重复条目、规范 frontmatter、补写链接）。子智能体看不到当前对话，task 必须自包含：写清任务目标、范围与注意事项。它会实际读写文件、逐次请求写确认，并返回结构化汇报（改动清单/合并说明/存疑事项/建议删除）。不适合写作或章节修改。

何时该委派：本轮写作新增要素条目较多（新人物/新地点/新设定连续出现）、人物状态或关系显著变化、设定出现前后矛盾、或用户提到「对不上/重复/记混了」等信号时，值得委派。改动轻微（只微调一两处、无新增实体）、要素无实质变化、或本会话已整理过且之后无新改动时，不要委派。

委派前先建议：主动整理前先在回复末尾用一句话说明观察到的信号、建议管理要素（委派本工具执行），经用户同意后再调用，不要未经同意静默发起。用户明确要求整理（含 /管理要素）时直接委派。`,
        parameters: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: '委派给子智能体的任务描述，必须自包含（子智能体看不到本对话）。例如：整理第 12 章涉及的要素，重点核对角色甲的人物卡是否有重复条目。',
            },
            scope: {
              type: 'string',
              description: '可选，圈定整理范围（文件或子目录）；缺省为整个 elements/ 要素库。',
            },
          },
          required: ['task'],
          additionalProperties: false,
        },
      },
    },
    core: {
      name: 'DelegateToElementManager',
      description: '委派要素管理子智能体管理要素库',
      validateInput(input: unknown): DelegateToElementManagerInput {
        if (!input || typeof input !== 'object') {
          throw new Error('DelegateToElementManager 参数必须是包含 task 的对象')
        }
        const record = input as Record<string, unknown>
        const task = typeof record.task === 'string' ? record.task.trim() : ''
        if (!task) {
          throw new Error('task 不能为空：委派给子智能体的任务描述（子智能体看不到本对话，须自包含）')
        }
        const scope = typeof record.scope === 'string' ? record.scope.trim() : ''
        return { task, ...(scope ? { scope } : {}) }
      },
      async run(validatedInput: DelegateToElementManagerInput, runtime) {
        const elementSchema = await readElementSchema(runtime.project.handle)
        return runElementManager({
          task: validatedInput.task,
          ...(validatedInput.scope ? { scope: validatedInput.scope } : {}),
          project: runtime.project,
          config: runtime.project.config,
          elementSchema,
          ...(confirm ? { confirm } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.onSubagentEvent ? { onEvent: context.onSubagentEvent } : {}),
        })
      },
      summarizeInput(input: DelegateToElementManagerInput) {
        const scope = input.scope ? `（范围：${input.scope}）` : ''
        return `委派要素管理员整理${scope}：${input.task}`
      },
      summarizeOutput(output: DelegateToElementManagerOutput) {
        return output.aborted
          ? `要素管理任务被停止（已执行 ${output.toolCallCount} 次工具调用）`
          : `要素管理完成（${output.toolCallCount} 次工具调用）`
      },
    },
    formatResult(output: DelegateToElementManagerOutput) {
      return [
        output.aborted
          ? '⚠️ 要素管理任务被用户停止，以下为部分完成的汇报。'
          : '要素管理完成，汇报如下。',
        '',
        output.report,
      ].join('\n')
    },
  }
}
