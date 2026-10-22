import { appendUserMessage, createModelView, setSystemMessage } from './model-view'
import { query } from './query'
import { createAgentTools, type AgentRunnableTool, type AgentRunnableToolMap } from './tools'
import { PROJECT_STRUCTURE_SECTION } from './prompt'
import type { ConfirmHandler, TaggedToolExecutionEvent, WriteConfirmationRequest } from './tool-execution'
import { readElementSchema } from '../fs/project-fs'
import type { ProjectConfig, ProjectSnapshot } from '../../types/project'

/**
 * 要素管理员子代理（一次性、每次全新上下文，《要素园丁子代理设计》v3 起源）。
 *
 * 提示词拼装与主 Agent 同款分层（升级 W2）：system = 身份（含模型名）+ 项目结构段
 * （与主 Agent 共用 PROJECT_STRUCTURE_SECTION）+ 白名单内工具使用规则 + Notes 铁律 + 汇报格式；
 * prompts/ELEMENT.md 以 user-role `<system-reminder>` 恒注入（一次性上下文无去重需求，D2/D3），
 * 提示词家族其余文件（system.md / NovAI.md / outlines/）一律不进要素管理员上下文。
 * 工具白名单 + elements/ 写路径闸在运行层强制，不依赖模型自觉。
 */

/**
 * 要素管理员 profile（D8 声明式）：子智能体的身份、工具白名单、写入范围的单一声明处。
 * 仅是代码组织方式（内置常量）——NovAI 的子智能体是产品内置角色，不开放用户自定义，
 * 不引入 ZCode 式 markdown profile 扫描机制（讨论记录拍板）。
 */
const ELEMENT_MANAGER_PROFILE = {
  /** 身份段：含模型名（与主 Agent 同款句式）；模型未知时退化为无模型名版本。 */
  identity(model?: string): string {
    return model
      ? `你是 NovAI 要素管理员，一个使用 ${model} 模型驱动的子智能体，专门负责管理小说项目的要素库（elements/ 目录）。`
      : '你是 NovAI 要素管理员，一个子智能体，专门负责管理小说项目的要素库（elements/ 目录）。'
  },
  /** 完整工具白名单（按 D4 从主 Agent 14 条规则裁剪对应工具集）。 */
  tools: [
    'ListDirectory',
    'FindFiles',
    'ReadFile',
    'RagSearch',
    'CreateFile',
    'EditFile',
    'RenameFile',
  ] as const,
  /** 可写工具（白名单子集）：入口集合，运行层再强制 writeScope 路径闸。 */
  writableTools: ['CreateFile', 'EditFile', 'RenameFile'] as const,
  /** 写入范围：可写工具的目标路径前缀（路径闸判据）。 */
  writeScope: 'elements/',
} as const

/** ELEMENT.md 缺失时的兜底提示（正常路径 repair 已补齐；防御性不阻塞运行）。 */
const SCHEMA_MISSING_NOTE = '（规范文件 prompts/ELEMENT.md 缺失，按上述内置守则工作）'

/** 固定四段汇报格式（D6：「合并与迁移说明」扩写重命名说明；「建议删除」只谈删除——重命名已属分内事）。 */
const REPORT_FORMAT_SECTION = `任务结束时输出固定结构汇报：
## 改动文件清单
（每个文件一句话说明改了什么）
## 合并与迁移说明
（哪些条目被合并进哪里、依据是什么；重命名了哪些文件、理由是什么）
## 存疑事项
（需要用户拍板的疑似重复/冲突；没有则写「无」）
## 建议删除
（建议用户手动删除的文件及理由；没有则写「无」）`

/**
 * 工具使用规则段（D4）：不整抄主 Agent 的 14 条，只写白名单内工具——
 * 删 WebSearch/WebFetch/KnowledgeLookup/DeleteFile（白名单外）、章节编号规则（不写章节）；
 * 保留 spill 说明（读长要素文件同样会撞超限）；CreateFile 条目去掉章节正文口径只留要素文件相关。
 */
function buildElementManagerToolRules(): string {
  return [
    '工具使用规则：',
    '- 所有工具 path 都是项目根目录内部的相对路径；不要把项目文件夹名写进 path。查看项目根目录时，ListDirectory 不传 path 或传空字符串。',
    '- ReadFile 用于读取 .md、.json、.txt 文件，返回带行号内容；默认最多读取 2000 行，单次返回有约 50KB 字节上限。长文件或已知目标位置时，使用 offset/limit 分段读取；超限截断时按提示的 offset 继续。',
    '- 单个工具结果过长时，系统会把完整内容存入 .novel/spill/ 目录，上下文中只留预览和取回指引；指引中的路径可用 ReadFile 以 offset/limit 分段读回省略的部分。',
    '- EditFile 用于精确替换已有文件中的片段。oldText 必须来自 ReadFile 结果，但不要包含行号前缀；保留原文缩进，尽量提供足够上下文避免误替换。新增文件请用 CreateFile。',
    '- CreateFile 用于创建不存在的新文件；目标已存在时会失败。要素文件使用 .md，文件名即要素名。',
    '- RenameFile 用于重命名或移动单个 .md、.json、.txt 文件；源文件必须存在，目标文件不能存在，父目录会自动创建。重命名要素文件需在汇报中说明理由。',
    '- ListDirectory 用于查看某个已存在目录的直接子项；不传 path 时查看项目根目录。它不会读取文件正文。探索目录结构时先看目录清单，不要为了探索而批量读取文件。',
    '- FindFiles 用于按 glob 模式递归查找文件路径，例如 **/*.md、elements/characters/*.md。它不会读取文件正文；找到候选文件后再用 ReadFile 精读。',
    '- RagSearch 用于从项目要素索引中语义检索人物、地点、实体、剧情、时间线、世界观设定；返回的 sourcePath 可用于后续 ReadFile 精读。',
    '- 可以连续使用多个工具完成任务。完成工具调用后，继续根据工具结果判断是否还需要下一步。',
  ].join('\n')
}

/** Notes 段（ZCode 式铁律，从旧 persona 抽出）：不可让渡的边界都在这里，工作细则在 ELEMENT.md。 */
function buildElementManagerNotes(): string {
  return [
    'Notes:',
    '- 你只能写入 elements/ 下的文件；其余一切只读。',
    '- 合并同名/近名要素时保留旧文件全部事实；存疑不合并，列入汇报交用户拍板。',
    '- 你可以重命名 elements/ 下的要素文件，重命名需在汇报中说明理由；不删除任何文件，确需删除的列入汇报交用户处理。',
    '- 从不修改 chapters/ 正文，也不修改 prompts/ 下的任何文件。',
  ].join('\n')
}

/**
 * 组装要素管理员 system prompt：身份 + 项目结构 + 工具规则 + Notes + 汇报格式，五段分层。
 * ELEMENT.md 不进 system（改 user-role reminder 恒注入，D2）。
 */
export function buildElementManagerSystemPrompt(input: { model?: string }): string {
  return [
    ELEMENT_MANAGER_PROFILE.identity(input.model?.trim() || undefined),
    '',
    PROJECT_STRUCTURE_SECTION,
    '',
    buildElementManagerToolRules(),
    '',
    buildElementManagerNotes(),
    '',
    REPORT_FORMAT_SECTION,
  ].join('\n')
}

/**
 * ELEMENT.md reminder（D2/D3 拆板）：一次性上下文恒注入，无 digest 去重、
 * 无「未修改默认模板不注入」——默认模板本身就是完整工作守则，未修改 ≠ 无内容。
 */
export function buildElementSchemaReminder(content: string): string {
  return `<system-reminder>\n以下是本书要素规范（prompts/ELEMENT.md），作为工作守则。\n\n${content.trim()}\n</system-reminder>`
}

/**
 * 组装要素管理员工具面：全量工具表按 profile 白名单过滤，可写工具包一层 validateInput 路径闸——
 * 写目标不在 elements/ 下直接报错回灌（运行层强制，模型越界请求只会收到失败结果）。
 */
export function createElementManagerTools(): AgentRunnableToolMap {
  const full = createAgentTools()
  const tools: AgentRunnableToolMap = {}
  for (const name of ELEMENT_MANAGER_PROFILE.tools) {
    const tool = full[name]
    if (!tool) {
      throw new Error(`要素管理员工具白名单引用了未注册工具：${name}`)
    }
    tools[name] = tool
  }
  for (const name of ELEMENT_MANAGER_PROFILE.writableTools) {
    tools[name] = guardElementsScope(tools[name]!)
  }
  return tools
}

/**
 * 把可写工具的 validateInput 包上 elements/ 前缀闸（大小写不敏感；文件名本身保留大小写）。
 * RenameFile 入参是 fromPath/toPath（无 path 字段），W3 起双向都必须落在 elements/ 内。
 */
function guardElementsScope(tool: AgentRunnableTool): AgentRunnableTool {
  return {
    ...tool,
    core: {
      ...tool.core,
      validateInput(input: unknown) {
        const validated = tool.core.validateInput(input)
        const record = validated as Record<string, unknown>
        const withinScope = (path: unknown) =>
          typeof path === 'string' && path.toLowerCase().startsWith(ELEMENT_MANAGER_PROFILE.writeScope)
        if (tool.name === 'RenameFile') {
          if (!withinScope(record.fromPath) || !withinScope(record.toPath)) {
            throw new Error('要素管理员只能重命名 elements/ 下的要素文件；源文件与目标文件都必须在 elements/ 内。')
          }
          return validated
        }
        if (!withinScope(record.path)) {
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
 * 跑一次要素管理员任务：全新 ModelView（system = 分层拼装；user = ELEMENT.md reminder + 任务）→
 * 复用主 Agent 的 query 循环（同压缩阈值、同 agentMaxTurns 安全阀）。
 * 配置先经 mergeElementManagerOverrides 合成（决策 3/4 的覆盖项：模型/思考档/确认档位，
 * 未覆盖项动态继承主配置——按次取值，运行中定格，D5）；合成后的 project 快照
 * 让权限判定与工具执行同步用要素管理员档位，handle 同引用零副作用；身份段模型名随合成后配置取值。
 * 内层工具事件透传给 onEvent（带 agent: 'element-manager'），写确认透传给 confirm（带「要素管理」标签）。
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
  setSystemMessage(view, buildElementManagerSystemPrompt({ model: effectiveConfig.llm.model }))

  // ELEMENT.md 恒注入为 user-role reminder（D2/D3：一次性上下文无去重需求；默认模板即有效守则）
  appendUserMessage(view, buildElementSchemaReminder(input.elementSchema.trim() || SCHEMA_MISSING_NOTE))

  const userLines = [
    `管理任务：${input.task}`,
    input.scope?.trim() ? `管理范围：${input.scope.trim()}` : '管理范围：整个 elements/ 要素库',
    '',
    '请按要素规范管理，结束时输出固定结构汇报。',
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

/** /管理要素 斜杠命令的驱动 prompt（入口重构 W1 瘦身为一句：「自包含」等约束由
 *  DelegateToElementManager 工具 description 承载，提示词不重复）。 */
export const ELEMENT_MANAGER_TASK_PROMPT = `请调用 DelegateToElementManager 委派要素管理员处理以下要素管理需求：`

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
        description: `委派要素管理子智能体管理 elements/ 要素库（合并重复条目、规范 frontmatter、补写链接、重命名要素文件）。子智能体看不到当前对话，task 必须自包含：写清任务目标、范围与注意事项。它会实际读写文件、逐次请求写确认，并返回结构化汇报（改动清单/合并说明/存疑事项/建议删除）。不适合写作或章节修改。

何时该委派：本轮写作新增要素条目较多（新人物/新地点/新设定连续出现）、人物状态或关系显著变化、设定出现前后矛盾、要素文件命名不当、或用户提到「对不上/重复/记混了」等信号时，值得委派。改动轻微（只微调一两处、无新增实体）、要素无实质变化、或本会话已整理过且之后无新改动时，不要委派。

委派前先建议：主动管理前先在回复末尾用一句话说明观察到的信号、建议管理要素（委派本工具执行），经用户同意后再调用，不要未经同意静默发起。用户明确要求管理（含 /管理要素）时直接委派。`,
        parameters: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: '委派给子智能体的任务描述，必须自包含（子智能体看不到本对话）。例如：管理第 12 章涉及的要素，重点核对角色甲的人物卡是否有重复条目。',
            },
            scope: {
              type: 'string',
              description: '可选，圈定管理范围（文件或子目录）；缺省为整个 elements/ 要素库。',
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
        return `委派要素管理员管理${scope}：${input.task}`
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
