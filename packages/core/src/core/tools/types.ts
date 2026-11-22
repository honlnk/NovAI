import type { ProjectSnapshot } from '../../types/project'
import type { FileChangeCoords, FileChangeRecord } from '../../types/chat'
import type { ElementType } from '../../types/rag'
import type { PlanStatus } from '../../types/plans'
import type { ForeshadowingStatus } from '../../types/foreshadowing'
import type { RhythmHook, RhythmMood, RhythmPayoff, RhythmStatus } from '../../types/rhythm'
import type { KnowledgePlatformName } from './knowledge-platforms'

/**
 * core 工具注册表（tools/index.ts 的 `Record<CoreToolName, …>` 全键约束）的键集合。
 * DelegateToElementManager 不在此列：它是会话层组装的委派工具（需要 confirm/signal/事件转发闭包），
 * 不是纯 ToolRuntime 可驱动的 core 工具——其名字进 AgentToolName / ChatToolName / ToolNameView。
 */
export type CoreToolName =
  | 'ReadFile'
  | 'EditFile'
  | 'CreateFile'
  | 'RenameFile'
  | 'DeleteFile'
  | 'ListDirectory'
  | 'FindFiles'
  | 'SearchFiles'
  | 'RagSearch'
  | 'LoadElements'
  | 'ListPlans'
  | 'ReadPlan'
  | 'CreatePlan'
  | 'UpdatePlan'
  | 'DeletePlan'
  | 'ListForeshadowing'
  | 'ReadForeshadowing'
  | 'ReadForeshadowingForPlanning'
  | 'CreateForeshadowing'
  | 'UpdateForeshadowing'
  | 'DeleteForeshadowing'
  | 'ForeshadowingCheck'
  | 'ForeshadowingSync'
  | 'RhythmList'
  | 'RhythmRead'
  | 'RhythmCreate'
  | 'RhythmUpdate'
  | 'RhythmDelete'
  | 'RhythmCheck'
  | 'RhythmSync'
  | 'RhythmCurve'
  | 'RelationList'
  | 'RelationRead'
  | 'RelationCreate'
  | 'RelationUpdate'
  | 'RelationDelete'
  | 'RelationQuery'
  | 'RelationCheck'
  | 'TimelineList'
  | 'TimelineRead'
  | 'TimelineCreatePoint'
  | 'TimelineCreateSpan'
  | 'TimelineUpdate'
  | 'TimelineDelete'
  | 'GetFileChangeHistory'
  | 'WebSearch'
  | 'WebFetch'
  | 'KnowledgeLookup'

export type ToolRuntime = {
  project: ProjectSnapshot
  readFileStates?: Map<string, ReadFileState>
  /**
   * 会话改动账本的只读取口（GetFileChangeHistory 用）。
   * getter 形态：账本每次累积都不可变重建数组，引用快照会过期，读时取最新。
   */
  getChangeLedger?: () => readonly FileChangeRecord[]
  /**
   * 联网搜索的匿名身份（localStorage UUID，app 层注入）：
   * linkseek 托管档绿灯用它认配额（X-NovAI-Client-Id）；缺失时服务端按 IP 计。
   */
  webClientId?: string
  /**
   * 当前工具调用的 id（执行层注入）：会话层组装的工具（如 AskUserQuestion）用它把
   * 自己的挂起请求与模型侧 tool-call 关联。纯 core 工具不消费。
   */
  toolCallId?: string
}

export type ToolCall<TName extends CoreToolName = CoreToolName, TInput = unknown> = {
  id: string
  name: TName
  input: TInput
  createdAt: string
}

export type ToolResult<TName extends CoreToolName = CoreToolName, TOutput = unknown> = {
  callId: string
  name: TName
  ok: boolean
  output?: TOutput
  error?: string
  summary: string
  createdAt: string
}

export type ToolExecution<TName extends CoreToolName = CoreToolName, TInput = unknown, TOutput = unknown> = {
  call: ToolCall<TName, TInput>
  result: ToolResult<TName, TOutput>
}

/**
 * 工具层声明的结构化文件变更，由写工具在执行成功后产出。
 * service 层据此推导 changedFiles，不再依赖工具结果文本反推。
 */
export type FileChange =
  | { type: 'created'; path: string }
  | { type: 'updated'; path: string }
  | { type: 'renamed'; fromPath: string; toPath: string }
  /** deleted 带被删行数（只带数字不带内容：原文去回收站 trashPath 看，账本会话落盘不重复存） */
  | { type: 'deleted'; path: string; trashPath?: string; linesRemoved?: number }

/**
 * 片段级 diff（改动账本 FileChangeRecord 的唯一 diff 载体，抄 dsh 写时 before/after 机制）：
 * 只存被替换的片段，不存整文件。created 时 oldText 为 ''（全新内容），deleted/renamed 不产生 diff。
 * modelView 里的 tool 消息不挂 diff（模型不需要逐行 diff，省 token）。
 */
export type ChangeDiff = {
  /** 被替换掉的原文片段；CreateFile 时为 '' */
  oldText: string
  /** 替换后的新片段；DeleteFile 时为 '' */
  newText: string
  linesAdded: number
  linesRemoved: number
}

/**
 * 写工具执行前构造的确认预览，用于「写入前确认」流程。
 * create/edit 携带完整文本用于 diff；rename/delete 仅路径级预览。
 */
export type WriteConfirmation =
  | { kind: 'create'; path: string; content: string }
  | { kind: 'edit'; path: string; oldText: string; newText: string; /** 全部替换：确认面板按候选原文在当前文件的所有出现处预览 */ replaceAll?: boolean }
  | { kind: 'rename'; fromPath: string; toPath: string }
  | { kind: 'delete'; path: string }

/**
 * 工具定义。TName 放宽为 string（不锁 CoreToolName）：会话层组装的工具（如 DelegateToElementManager）
 * 名字在 AgentToolName 联合里而不进 core 注册表，同样以本形状定义；core 注册表的键约束在
 * tools/index.ts 显式保持。
 */
export type ToolDefinition<TName extends string, TInput, TOutput> = {
  name: TName
  description: string
  validateInput(input: unknown): TInput
  run(input: TInput, runtime: ToolRuntime): Promise<TOutput>
  summarizeInput(input: TInput): string
  summarizeOutput(output: TOutput): string
  /**
   * 写工具用它声明结构化文件变更；只读工具不实现。
   * 返回 undefined 表示该 output 不产生文件变更。
   */
  extractFileChange?(output: TOutput): FileChange | undefined
  /**
   * 写工具用它产出片段级 diff（改动账本用）；EditFile/CreateFile 实现，RenameFile/DeleteFile 不实现。
   * 返回 undefined 表示该 output 无 diff 可存。
   */
  extractChangeDiff?(output: TOutput): ChangeDiff | undefined
  /**
   * 写工具用它产出定位坐标（逐处行范围 + 前后版本，交互优化计划 §7）；EditFile/CreateFile 实现。
   * 返回 undefined 表示该 output 无坐标可存（旧记录形态，界面降级为片段差异）。
   */
  extractChangeCoords?(output: TOutput): FileChangeCoords | undefined
  /**
   * 主变更之外顺带改动的其他文件（如关系工具为要素懒分配标识写回 frontmatter、
   * 删除要素级联更新关系账本）。每条各进一条变更账本记录，界面同样收到实时变更通知。
   */
  extractExtraFileChanges?(output: TOutput): FileChange[] | undefined
  /**
   * 写工具用它构造写入前确认预览；只读工具不实现。
   * 入参是经过 validateInput 校验的强类型 input，执行前调用。
   */
  buildConfirmation?(input: TInput): WriteConfirmation
}

export type ReadFileInput = {
  path: string
  offset?: number
  limit?: number
}

export type ReadFileOutput = {
  path: string
  content: string
  numberedContent: string
  readFileState: ReadFileState
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
  /** 第三道闸命中：返回内容达单次字节上限被截断（用 offset=endLine+1 继续读）。 */
  truncatedByBytes?: boolean
  empty: boolean
  offsetBeyondEnd: boolean
  fileSizeBytes: number
  notice?: string
}

export type ReadFileState = {
  path: string
  contentHash: string
  lastModified: string
  fileSizeBytes: number
  /** 该状态由哪个工具产生（运行时内存标记，不参与新鲜度判断） */
  sourceTool?: 'Read' | 'Edit'
}

export type EditFileInput = {
  path: string
  oldText: string
  newText: string
  replaceAll?: boolean
  readFileState?: ReadFileState
}

export type EditFileOutput = {
  path: string
  occurrences: number
  contentLength: number
  linesAdded: number
  linesRemoved: number
  /** 实际应用的原文片段（经 findActualText/preserveQuoteStyle 校正，非模型入参原样）；改动账本 diff 用 */
  oldText: string
  /** 实际写入的新片段 */
  newText: string
  /** 定位坐标（§7）：逐处行范围 + 前后版本，extractChangeCoords 转交改动账本；模型视图不消费 */
  coords?: FileChangeCoords
}

export type CreateFileInput = {
  path: string
  content: string
}

export type CreateFileOutput = {
  path: string
  contentLength: number
  linesAdded: number
  created: true
  /** 新建的完整内容；改动账本 diff 用（oldText 为 ''，全绿） */
  content: string
  /** 定位坐标（§7）：整文件落盘范围（无 beforeVersion，新建没有原文） */
  coords?: FileChangeCoords
}

export type RenameFileInput = {
  fromPath: string
  toPath: string
}

export type RenameFileOutput = {
  fromPath: string
  toPath: string
  contentLength: number
}

export type DeleteFileInput = {
  path: string
}

export type DeleteFileOutput = {
  path: string
  trashPath: string
  contentLength: number
  linesRemoved: number
  /** 删除要素文件时级联移除的引用关系数（非要素文件为 0） */
  removedRelationCount: number
  /** 级联清理失败原因（文件已删除但引用关系未清理）；成功或无需级联时为空串 */
  relationCascadeError: string
  /** 删除要素文件时级联移除的时间线引用数（参与者 + 情节关联，非要素文件为 0） */
  removedTimelineRefCount: number
  /** 时间线级联清理失败原因（成功或无需级联时为空串） */
  timelineCascadeError: string
}

export type ListDirectoryInput = {
  path?: string
}

export type ListDirectoryEntry = {
  name: string
  path: string
  kind: 'file' | 'directory'
  /** 遗留字段：内部/点开头条目已整体对模型隐藏（无开关），恒为 false；保留以避免下游类型级联改动 */
  hidden: boolean
}

export type ListDirectoryOutput = {
  path: string
  entries: ListDirectoryEntry[]
}

export type FindFilesInput = {
  pattern: string
  path?: string
  limit?: number
}

export type FindFilesOutput = {
  pattern: string
  path: string
  /** 未超限 = 全部匹配（修改时间降序）；超限 = 跨顶层目录采样页 */
  filenames: string[]
  numFiles: number
  truncated: boolean
  /** 超限时的完整匹配总数 */
  totalMatches?: number
  /** 采样页覆盖的顶层目录数（相对搜索根） */
  sampledTopLevelDirs?: number
  /** 完整结果覆盖的顶层目录总数 */
  totalTopLevelDirs?: number
  /** 完整列表的 spill 落盘路径（写入失败时缺省） */
  spillPath?: string
}

export type SearchFilesInput = {
  /** 搜索词；默认字面匹配，regex: true 时按 JS 正则解释 */
  query: string
  /** 搜索范围（项目内目录相对路径），默认项目根目录 */
  path?: string
  /** 单个正向 glob 过滤文件名（如 *.txt）；拒绝 ! 取反与逗号列表 */
  include?: string
  /** true 时 query 按 JS 正则解释；默认 false（字面匹配） */
  regex: boolean
  /** 匹配行前后各带 N 行上下文；默认 2，范围 0-5 */
  contextLines: number
  /** 返回匹配数上限；默认 100，最大 500 */
  limit: number
}

export type SearchFilesOutput = {
  query: string
  path: string
  include?: string
  regex: boolean
  contextLines: number
  /** D8 格式渲染好的匹配正文（超限时为前 limit 处的预览页） */
  content: string
  /** content 中包含的匹配数（≤ limit） */
  shownMatches: number
  totalMatches: number
  truncated: boolean
  /** 完整结果的 spill 落盘路径（写入失败时缺省） */
  spillPath?: string
}

export type RagSearchInput = {
  query: string
  topK?: number
  finalLimit?: number
  filters?: {
    type?: Array<'character' | 'location' | 'entity' | 'plot' | 'worldbuilding'>
    tags?: string[]
    lastUpdatedChapter?: string
  }
}

export type RagSearchOutput = {
  query: string
  recalledCount: number
  returnedCount: number
  usedRerank: boolean
  candidates: Array<{
    id: string
    sourcePath: string
    type: 'character' | 'location' | 'entity' | 'plot' | 'worldbuilding'
    name: string
    summary: string
    retrievalText: string
    tags: string[]
    lastUpdatedChapter: string
    relatedChapters: string[]
    score?: number
    rerankScore?: number
  }>
}

export type LoadElementsInput = {
  /** 要加载的要素名数组（来自上下文中的要素清单） */
  names: string[]
}

/** 单个要素的加载结果；未找到时只带 name 与 notFound 标记，不抛错。 */
export type LoadedElement = {
  name: string
  type?: ElementType
  sourcePath?: string
  content?: string
  notFound?: true
}

export type LoadElementsOutput = {
  elements: LoadedElement[]
}

/** ===== 创作计划板工具（计划 §AI 工具） ===== */

export type ListPlansInput = {
  status?: PlanStatus
}

export type ListPlansOutput = {
  plans: Array<{
    id: string
    title: string
    status: PlanStatus
    order: number
    updatedAt: string
    summary: string
  }>
  totalCount: number
}

export type ReadPlanInput = {
  id: string
}

export type ReadPlanOutput =
  | {
      id: string
      notFound: true
    }
  | {
      id: string
      status: PlanStatus
      order: number
      title: string
      body: string
      sourcePath: string
      contentHash: string
      updatedAt: string
    }

export type CreatePlanInput = {
  body: string
  status?: PlanStatus
}

export type CreatePlanOutput = {
  id: string
  title: string
  status: PlanStatus
  order: number
  sourcePath: string
  /** 完整文件内容（frontmatter + 正文）；改动账本 diff 用 */
  content: string
  contentLength: number
  linesAdded: number
  created: true
}

export type UpdatePlanInput = {
  id: string
  body?: string
  status?: PlanStatus
  /** 移动到目标列某卡片之后；null = 列末尾；undefined = 不动位置 */
  afterId?: string | null
  /** 上次 ReadPlan 返回的 contentHash；正文替换必传（防覆盖外部修改） */
  expectedContentHash?: string
}

export type UpdatePlanOutput = {
  id: string
  title: string
  status: PlanStatus
  order: number
  sourcePath: string
  /** 更新后的完整文件内容 */
  content: string
  contentLength: number
}

export type DeletePlanInput = {
  id: string
}

export type DeletePlanOutput = {
  id: string
  sourcePath: string
  trashPath: string
  contentLength: number
  linesRemoved: number
}

/** ===== 伏笔工具（主 Agent 专属，要素管理员不装配；创作心智模块计划 §五） ===== */

export type ListForeshadowingInput = {
  status?: ForeshadowingStatus
}

export type ListForeshadowingOutput = {
  foreshadowing: Array<{
    id: string
    name: string
    status: ForeshadowingStatus
    plantedAt: string
    payoffWindow: [string, string] | null
    isRedHerring: boolean
    updatedAt: string
    /** 读者视角摘要（不含作者真相）。 */
    summary: string
  }>
  totalCount: number
}

export type ReadForeshadowingInput = {
  id: string
}

/**
 * 写正文链路的读取结果：永远不含作者真相（正文为读者视角形态，带隐藏提示）。
 * 真相要拿 ForeshadowingReadForPlanning（规划阶段专用）。
 */
export type ReadForeshadowingOutput =
  | { id: string; notFound: true }
  | {
      id: string
      name: string
      status: ForeshadowingStatus
      plantedAt: string
      payoffWindow: [string, string] | null
      relatedCharacters: string[]
      relatedEntities: string[]
      relatedChapters: string[]
      isRedHerring: boolean
      resolvedAt: string | null
      abandonedReason: string | null
      /** 读者视角正文（作者真相已剥离）。 */
      body: string
      sourcePath: string
      contentHash: string
      updatedAt: string
      truthHidden: true
    }

/** 规划阶段的完整读取结果（含作者真相与完整正文）。 */
export type ReadForeshadowingForPlanningOutput =
  | { id: string; notFound: true }
  | {
      id: string
      name: string
      status: ForeshadowingStatus
      plantedAt: string
      payoffWindow: [string, string] | null
      relatedCharacters: string[]
      relatedEntities: string[]
      relatedChapters: string[]
      isRedHerring: boolean
      resolvedAt: string | null
      abandonedReason: string | null
      /** 完整正文（读者视角 + 作者真相两节）。 */
      body: string
      /** 作者真相节内容（单独字段方便直接取用）。 */
      authorTruth: string
      sourcePath: string
      contentHash: string
      updatedAt: string
    }

export type CreateForeshadowingInput = {
  name: string
  /** 读者视角（当时可见事实）：伏笔登记时必须写下读者当时能看到什么。 */
  readerView: string
  /** 作者真相（剧透）；可省略后补。 */
  authorTruth?: string
  plantedAt: string
  status?: ForeshadowingStatus
  payoffWindow?: [string, string]
  relatedCharacters?: string[]
  relatedEntities?: string[]
  isRedHerring?: boolean
}

export type CreateForeshadowingOutput = {
  id: string
  name: string
  status: ForeshadowingStatus
  sourcePath: string
  /** 完整文件内容（frontmatter + 正文）；改动账本 diff 用。 */
  content: string
  contentLength: number
  linesAdded: number
  created: true
}

export type UpdateForeshadowingInput = {
  id: string
  name?: string
  readerView?: string
  /** 空串 = 清除真相节。 */
  authorTruth?: string
  status?: ForeshadowingStatus
  plantedAt?: string
  payoffWindow?: [string, string] | null
  relatedCharacters?: string[]
  relatedEntities?: string[]
  /** 追加暗示历史章节（去重保序）。 */
  addRelatedChapters?: string[]
  isRedHerring?: boolean
  resolvedAt?: string | null
  abandonedReason?: string | null
  afterId?: string | null
  /** 上次读取返回的 contentHash；改正文（readerView/authorTruth）时必传。 */
  expectedContentHash?: string
}

export type UpdateForeshadowingOutput = {
  id: string
  name: string
  status: ForeshadowingStatus
  sourcePath: string
  content: string
  contentLength: number
}

export type DeleteForeshadowingInput = {
  id: string
}

export type DeleteForeshadowingOutput = {
  id: string
  sourcePath: string
  trashPath: string
  contentLength: number
  linesRemoved: number
}

/**
 * 写前检查（§六 写第 N 章前）：回收窗口覆盖本章且未收的伏笔 + 本章已关联的伏笔。
 * 只读、只含读者视角——写作链路的防剧透边界不变（要真相用 ReadForeshadowingForPlanning）。
 * 章号匹配简化为「第N章」数值比较（全本连续编号；卷内独立编号的作品可能漏报/误报）。
 */
export type ForeshadowingCheckInput = {
  /** 章节编号（正整数），如 12 表示第 12 章。 */
  chapter: number
}

export type ForeshadowingCheckCard = {
  id: string
  name: string
  status: ForeshadowingStatus
  plantedAt: string
  payoffWindow: [string, string] | null
  /** 读者视角摘要（不含作者真相）。 */
  summary: string
}

export type ForeshadowingCheckOutput = {
  chapter: number
  /** 预计本章回收：窗口起点章号 ≤ N ≤ 窗口终点章号，且状态未揭晓/解决/放弃。 */
  dueForPayoff: ForeshadowingCheckCard[]
  /** 本章已关联：埋设章或暗示历史命中本章（写作时保持读者已知事实一致）。 */
  relatedToChapter: Array<ForeshadowingCheckCard & {
    /** 命中方式：planted=埋设章 / mentioned=暗示历史提及。 */
    matchedBy: 'planted' | 'mentioned'
    relatedChapters: string[]
  }>
  guidance: string
}

/**
 * 写后同步（§六 写完第 N 章后）：组装提案所需的完整上下文——本章关联伏笔（含
 * 作者真相与 contentHash，供直接走 UpdateForeshadowing）+ 该收未收提醒 + 回收
 * 当量标准。只读不落盘：提案由模型整理后交作者审阅，作者批准再走带确认的
 * CreateForeshadowing / UpdateForeshadowing（一条确认链路，不做批量审批 UI）。
 */
export type ForeshadowingSyncInput = {
  /** 章节编号（正整数）。 */
  chapter: number
}

export type ForeshadowingSyncCard = {
  id: string
  name: string
  status: ForeshadowingStatus
  plantedAt: string
  relatedChapters: string[]
  payoffWindow: [string, string] | null
  isRedHerring: boolean
  resolvedAt: string | null
  /** 读者视角正文（含本节因为评估要对照「读者已知什么」）。 */
  readerBody: string
  /** 作者真相正文（写后评估属于规划链路，允许可见）。 */
  authorTruth: string
  /** 供随后 UpdateForeshadowing 直接回传 expectedContentHash。 */
  contentHash: string
}

export type ForeshadowingSyncOutput = {
  chapter: number
  /** 章节文件路径（chapters/ 下按章号匹配；找不到为 null，伏笔上下文照常返回）。 */
  chapterPath: string | null
  /** 本章关联的伏笔（埋设/暗示命中本章），含真相。 */
  related: ForeshadowingSyncCard[]
  /** 该收未收：窗口覆盖本章、仍未揭晓/解决/放弃（提醒模型评估本章是否回收了它）。 */
  dueUnresolved: Array<{ id: string; name: string; status: ForeshadowingStatus; payoffWindow: [string, string] | null }>
  /** 回收当量标准（§六：改变 / 代价 / 重新解释，最弱的是解释）。 */
  payoffEquityStandard: string
  guidance: string
}

/** ===== 节奏卡工具（主 Agent 专属，要素管理员不装配；创作心智模块计划 §五） ===== */

export type RhythmListInput = {
  status?: RhythmStatus
  /** 章号范围筛选（含端点）：按 chapter_ref 里的「第N章」数值比较。 */
  chapterFrom?: number
  chapterTo?: number
}

export type RhythmListOutput = {
  rhythm: Array<{
    id: string
    name: string
    status: RhythmStatus
    chapterRef: string
    plannedConflict: number
    plannedMood: RhythmMood
    plannedHook: RhythmHook
    plannedPayoff: RhythmPayoff
    deviationFlag: boolean
    updatedAt: string
    /** 摘要（节奏意图首个非空行）。 */
    summary: string
  }>
  totalCount: number
}

export type RhythmReadInput = {
  id: string
}

export type RhythmReadOutput =
  | { id: string; notFound: true }
  | {
      id: string
      name: string
      status: RhythmStatus
      chapterRef: string
      plannedConflict: number
      plannedMood: RhythmMood
      plannedHook: RhythmHook
      plannedPayoff: RhythmPayoff
      plannedCharacters: string[]
      plannedNote: string
      actualConflict: number | null
      actualMood: RhythmMood | null
      actualHook: RhythmHook | null
      actualPayoff: RhythmPayoff | null
      actualNote: string | null
      deviationFlag: boolean
      deviationNote: string | null
      /** 正文三节（节奏意图 / 上下文衔接 / 作者备注）。 */
      intentBody: string
      linkBody: string
      authorNoteBody: string
      sourcePath: string
      contentHash: string
      createdAt: string
      updatedAt: string
    }

export type RhythmCreateInput = {
  /** 节奏卡名；缺省按 chapterRef 章段生成（如「第083章节奏」）。 */
  name?: string
  chapterRef: string
  plannedConflict: number
  plannedMood: RhythmMood
  plannedHook: RhythmHook
  plannedPayoff: RhythmPayoff
  plannedCharacters?: string[]
  plannedNote?: string
  intentBody?: string
  linkBody?: string
  authorNoteBody?: string
}

export type RhythmCreateOutput = {
  id: string
  name: string
  status: RhythmStatus
  sourcePath: string
  content: string
  contentLength: number
  linesAdded: number
  created: true
}

export type RhythmUpdateInput = {
  id: string
  name?: string
  chapterRef?: string
  plannedConflict?: number
  plannedMood?: RhythmMood
  plannedHook?: RhythmHook
  plannedPayoff?: RhythmPayoff
  plannedCharacters?: string[]
  plannedNote?: string
  /** 替换后的节奏意图正文；不传保持原样。 */
  intentBody?: string
  /** 替换后的上下文衔接正文；空串 = 清除该节。 */
  linkBody?: string
  /** 替换后的作者备注正文；空串 = 清除该节。 */
  authorNoteBody?: string
  /** 写后回写：实际值。传 null 清除（五项全清则节奏卡回到规划中）。 */
  actualConflict?: number | null
  actualMood?: RhythmMood | null
  actualHook?: RhythmHook | null
  actualPayoff?: RhythmPayoff | null
  actualNote?: string | null
  afterId?: string | null
  /** 上次读取返回的 contentHash；更新正文三节时必传。 */
  expectedContentHash?: string
}

export type RhythmUpdateOutput = {
  id: string
  name: string
  status: RhythmStatus
  deviationFlag: boolean
  deviationNote: string | null
  sourcePath: string
  content: string
  contentLength: number
}

export type RhythmDeleteInput = {
  id: string
}

export type RhythmDeleteOutput = {
  id: string
  sourcePath: string
  trashPath: string
  contentLength: number
  linesRemoved: number
}

/** Check/Sync 共用的节奏摘要（计划值 + 已回写的实际值）。 */
type RhythmCheckCardBase = {
  id: string
  name: string
  status: RhythmStatus
  chapterRef: string
  plannedConflict: number
  plannedMood: RhythmMood
  plannedHook: RhythmHook
  plannedPayoff: RhythmPayoff
  actualConflict: number | null
  actualMood: RhythmMood | null
  actualHook: RhythmHook | null
  actualPayoff: RhythmPayoff | null
  deviationFlag: boolean
}

export type RhythmCheckInput = {
  chapter: number
}

/** 写前检查：本章计划节奏 + 前后章节奏（前一章带实际值——衔接主要看上一章落地的温度）。 */
export type RhythmCheckOutput = {
  chapter: number
  /** 本章节奏卡（一章一卡；无卡为 null，guidance 会提示）。 */
  planned: (RhythmCheckCardBase & { intentBody: string }) | null
  /** 章号小于本章的最近一张卡。 */
  previous: RhythmCheckCardBase | null
  /** 章号大于本章的最近一张卡。 */
  next: RhythmCheckCardBase | null
  guidance: string
}

export type RhythmSyncInput = {
  chapter: number
}

/**
 * 写后同步：组装回写提案上下文——本章节奏卡完整内容（含 contentHash，批准后
 * RhythmUpdate 直接回传）+ 当前偏差阈值与判定规则。只读不落盘，与
 * ForeshadowingSync 同一口径（提案给作者审阅，批准后走带确认的 RhythmUpdate）。
 */
export type RhythmSyncOutput =
  | { chapter: number; notFound: true; guidance: string }
  | {
      chapter: number
      id: string
      name: string
      status: RhythmStatus
      chapterRef: string
      plannedConflict: number
      plannedMood: RhythmMood
      plannedHook: RhythmHook
      plannedPayoff: RhythmPayoff
      plannedCharacters: string[]
      intentBody: string
      linkBody: string
      authorNoteBody: string
      actualConflict: number | null
      actualMood: RhythmMood | null
      actualHook: RhythmHook | null
      actualPayoff: RhythmPayoff | null
      deviationFlag: boolean
      deviationNote: string | null
      contentHash: string
      /** 当前生效的冲突强度偏差阈值（来自项目设置，默认 3）。 */
      conflictThreshold: number
      deviationRules: string
      guidance: string
    }

export type RhythmCurveInput = {
  chapterFrom?: number
  chapterTo?: number
}

/** 节奏曲线：范围内每章的计划/实际对照（按章号升序），供「最近节奏怎么样」类总结。 */
export type RhythmCurveOutput = {
  curve: Array<
    RhythmCheckCardBase & {
      updatedAt: string
      /** 节奏意图首个非空行摘要。 */
      summary: string
    }
  >
  totalCount: number
  /** 实际范围（缺省侧开放时显示用）。 */
  chapterFrom: number | null
  chapterTo: number | null
  guidance: string
}

/* ---------- 关系图谱（关系图谱施工计划 §五：主 Agent 专属七工具） ---------- */

/** 工具入参的节点定位：要素用稳定标识或「类型 + 精确名称」二选一；事件用 kind: 'event' + eventId。 */
export type RelationNodeInput = {
  kind?: 'element' | 'event'
  id?: string
  /** 事件端点的时间线事件标识（kind: 'event' 时必填，EVT- 开头） */
  eventId?: string
  type?: string
  name?: string
}

/** 已解析的节点摘要（List/Read/Query 输出用）。 */
export type RelationNodeSummary = {
  kind: 'element' | 'event'
  id: string
  /** 解析出的要素名；无法解析时为空串 */
  name: string
  /** 解析出的要素类型；无法解析时为空串 */
  type: string
}

export type RelationSummaryItem = {
  id: string
  from: RelationNodeSummary
  to: RelationNodeSummary
  type: string
  description: string
  updatedAt: string
}

export type RelationListInput = {
  /** 筛选：任一端为该类型要素（character/location/entity/plot/worldbuilding） */
  elementType?: string
  /** 筛选：关系类型精确匹配 */
  relationType?: string
}

export type RelationListOutput = {
  relations: RelationSummaryItem[]
  totalCount: number
  truncated: boolean
  guidance: string
}

export type RelationReadInput = {
  id: string
}

export type RelationReadOutput =
  | { notFound: true; id: string }
  | {
    id: string
    from: RelationNodeSummary
    to: RelationNodeSummary
    type: string
    description: string
    createdAt: string
    updatedAt: string
    /** 端点无法解析时的提示（悬空引用处理建议） */
    resolutionNote: string
  }

export type RelationCreateInput = {
  from: RelationNodeInput
  to: RelationNodeInput
  type: string
  description?: string
}

export type RelationCreateOutput = {
  id: string
  from: RelationNodeSummary
  to: RelationNodeSummary
  type: string
  description: string
  /** 本次新建的账本文件（首条关系） */
  created: boolean
  sourcePath: string
  /** 本次为要素懒分配的标识（要素文件 frontmatter 已写入） */
  assignedElementIds: { sourcePath: string; id: string }[]
  linesAdded: number
  linesRemoved: number
}

export type RelationUpdateInput = {
  id: string
  type?: string
  description?: string
  from?: RelationNodeInput
  to?: RelationNodeInput
}

export type RelationUpdateOutput = {
  id: string
  from: RelationNodeSummary
  to: RelationNodeSummary
  type: string
  description: string
  /** 修改前的关系摘要（变更账本 oldText 用） */
  previous: { from: RelationNodeSummary; to: RelationNodeSummary; type: string; description: string }
  /** 本次为要素懒分配的标识（改端点到无标识要素时） */
  assignedElementIds: { sourcePath: string; id: string }[]
  linesAdded: number
  linesRemoved: number
}

export type RelationDeleteInput = {
  id: string
}

export type RelationDeleteOutput = {
  id: string
  type: string
  fromName: string
  toName: string
  linesAdded: number
  linesRemoved: number
}

export type RelationQueryInput = {
  /** 单个要素稳定标识：返回与它直接相连的全部关系 */
  elementId?: string
  /** 一组要素稳定标识：返回两端都在集合内的关系（两对象间 / 当前场景人物） */
  elementIds?: string[]
}

export type RelationQueryOutput = {
  relations: RelationSummaryItem[]
  totalCount: number
  truncated: boolean
  guidance: string
}

export type RelationCheckInput = Record<string, never>

export type RelationCheckOutput = {
  ok: boolean
  issues: Array<{
    kind: string
    detail: string
  }>
  totalCount: number
  guidance: string
}

/* ---------- 时间线事件账本（时间线 JSON 化施工计划阶段 2：主 Agent 专属六工具） ---------- */

/** 工具入参的要素定位：稳定标识或「类型 + 精确名称」二选一（参与者四类 + 情节）。 */
export type TimelineElementRefInput = {
  id?: string
  type?: string
  name?: string
}

export type TimelineParticipantEntryInput = TimelineElementRefInput & {
  /** 该要素在本事件中的角色（如 主谋、目击者） */
  role?: string
}

/** 明确时间：年必填；历法自由文本，季节/月/日可选（系统不换算历法语义）。 */
export type TimelineStoryTimeInput = {
  calendar?: string
  year: number
  season?: string
  month?: number
  day?: number
}

/** 相对时间：锚定另一事件 + 偏移量（系统不换算，open 单位短词）。 */
export type TimelineRelativeTimeInput = {
  anchorEventId: string
  offset: number
  unit: string
  direction: 'before' | 'after'
}

export type TimelineChapterRefInput = {
  chapterNumber: number
  mode: 'current' | 'recall' | 'prophecy' | 'dream'
}

/** 事件详情写入（create / update 共用；update 语义下 undefined = 不改动、null = 清空可空字段）。 */
export type TimelineEventPatchInput = {
  title?: string
  summary?: string
  storyTime?: TimelineStoryTimeInput | null
  relativeTime?: TimelineRelativeTimeInput | null
  participants?: TimelineParticipantEntryInput[]
  plots?: TimelineElementRefInput[]
  chapters?: TimelineChapterRefInput[]
  /** 因果前驱事件标识（EVT- 开头，来自 TimelineList/TimelineRead 返回） */
  causedBy?: string[]
}

/** 插入定位：列表首/尾，或相对锚标记之前/之后（at 为 before/after 时 anchorMarkerId 必填）。 */
export type TimelinePositionInput = {
  at: 'first' | 'last' | 'before' | 'after'
  anchorMarkerId?: string
}

export type TimelineListInput = {
  /** 单个参与者要素稳定标识 */
  participantElementId?: string
  /** 一组参与者要素稳定标识（当前场景出场人物） */
  participantElementIds?: string[]
  /** 关联情节的要素稳定标识 */
  plotId?: string
  /** 按本章号过滤（事件关联的章节里含该章号） */
  chapterNumber?: number
  /** 明确时间年份范围（含两端；无明确时间的事件不命中） */
  yearFrom?: number
  yearTo?: number
}

/** 列表摘要条目：区间事件只出现一次（kind='span'，携带开始标记标识）。 */
export type TimelineEventSummaryItem = {
  eventId: string
  /** point / span 的开始标记标识（定位插入位置用） */
  markerId: string
  kind: 'point' | 'span'
  /** 列表顺序序号（展示用） */
  ordinal: number
  title: string
  summary: string
  /** 明确时间（原文字段直出）；null = 无明确时间 */
  storyTime: TimelineStoryTimeInput | null
  relativeTime: TimelineRelativeTimeInput | null
  /** 参与者（名称解析失败时 name 为空串） */
  participants: Array<{ id: string; name: string; type: string; role: string }>
  /** 关联情节（名称解析失败时 name 为空串） */
  plots: Array<{ id: string; name: string }>
  chapters: TimelineChapterRefInput[]
  /** 因果前驱的事件标识 */
  causedBy: string[]
}

export type TimelineListOutput = {
  events: TimelineEventSummaryItem[]
  totalCount: number
  truncated: boolean
  guidance: string
}

export type TimelineReadInput = {
  eventId: string
  /** 同时返回锚点前后各 N 条标记的局部上下文（默认 3，上限 30；插入定位用） */
  contextCount?: number
}

export type TimelineNeighborItem = {
  markerId: string
  eventId: string
  kind: 'point' | 'start' | 'end'
  /** end 标记无详情，title 为空串 */
  title: string
  ordinal: number
}

/** 事件详情视图（Read/Update 输出共用）：详情字段直出 + 引用解析为名称。 */
export type TimelineEventDetailView = {
  title: string
  summary: string
  storyTime: TimelineStoryTimeInput | null
  relativeTime: TimelineRelativeTimeInput | null
  participants: Array<{ id: string; name: string; type: string; role: string }>
  plots: Array<{ id: string; name: string }>
  chapters: TimelineChapterRefInput[]
  causedBy: string[]
  createdAt: string
  updatedAt: string
}

export type TimelineReadOutput =
  | { notFound: true; eventId: string }
  | {
    eventId: string
    markerId: string
    kind: 'point' | 'span'
    event: TimelineEventDetailView
    /** 事件版本令牌（TimelineUpdate 冲突判定用，内容决定跨读取稳定） */
    version: string
    /** 因果前驱事件标题（锚事件缺失时对应项为 null） */
    causedByTitles: Array<string | null>
    /** 相对时间锚事件标题；undefined = 无相对时间；null = 锚事件已删除（失效） */
    relativeAnchorTitle: string | null | undefined
    /** 锚点前后局部上下文（含自身，按列表顺序） */
    neighbors: TimelineNeighborItem[]
    /** 账本基线内容哈希（TimelineUpdate 冲突判定用） */
    contentHash: string | null
  }

export type TimelineCreatePointInput = {
  event: TimelineEventPatchInput
  /** 缺省 = 追加到列表末尾 */
  position?: TimelinePositionInput
}

export type TimelineCreateSpanInput = {
  event: TimelineEventPatchInput
  startPosition: TimelinePositionInput
  /** 必须位于开始位置之后（可跨任意多事件，表达并行与嵌套） */
  endPosition: TimelinePositionInput
}

export type TimelineCreateOutput = {
  eventId: string
  markerId: string
  /** 区间事件的结束标记标识 */
  endMarkerId: string
  kind: 'point' | 'span'
  title: string
  /** 账本文件是否为本次新建（变更账本 created/updated 区分用） */
  created: boolean
  sourcePath: string
  contentHash: string
  /** 本次为要素懒分配的标识（要素文件 frontmatter 已写入） */
  assignedElementIds: Array<{ sourcePath: string; id: string }>
  linesAdded: number
  linesRemoved: number
}

export type TimelineUpdateInput = {
  eventId: string
  /** 调用方持有的账本基线内容哈希（TimelineRead.contentHash）；与磁盘不一致即冲突 */
  expectedContentHash?: string
  title?: string
  summary?: string
  storyTime?: TimelineStoryTimeInput | null
  relativeTime?: TimelineRelativeTimeInput | null
  participants?: TimelineParticipantEntryInput[]
  plots?: TimelineElementRefInput[]
  chapters?: TimelineChapterRefInput[]
  causedBy?: string[]
}

export type TimelineUpdateOutput = {
  eventId: string
  title: string
  /** 修改后的事件详情 */
  event: TimelineEventDetailView
  /** 修改前的事件详情（变更账本 oldText 用） */
  previous: TimelineEventDetailView
  contentHash: string
  assignedElementIds: Array<{ sourcePath: string; id: string }>
  linesAdded: number
  linesRemoved: number
}

export type TimelineDeleteInput = {
  eventId: string
}

export type TimelineDeleteOutput = {
  eventId: string
  title: string
  kind: 'point' | 'span'
  /** 删除的标记数（点事件 1，区间事件 2） */
  removedMarkers: number
  /** 其他事件 causedBy 中指向该事件的引用清除计数（已自动级联） */
  cascadedCausedBy: number
  /** 仍以该事件为相对时间锚的事件（锚保留、待作者改绑；空数组 = 无） */
  anchoredEvents: Array<{ eventId: string; title: string }>
  /** 因该事件删除而被级联移除的关系条数（引用它的关系账本条目） */
  removedEventRelations: number
  /** 关系级联失败时的错误信息（空串 = 成功） */
  eventRelationCascadeError: string
  linesAdded: number
  linesRemoved: number
}

export type GetFileChangeHistoryInput = {
  /** 返回条数上限：默认 20，最大 100 */
  limit: number
  /** 只看某个文件（含改名前后名称） */
  path?: string
  /** 只看某一轮（runId） */
  runId?: string
}
export type GetFileChangeHistoryOutput = {
  /** 纯文本清单（新→旧逐条），末尾「共 N 条记录」 */
  content: string
  /** 过滤后的总记录数 */
  totalCount: number
  /** 实际返回条数 */
  returnedCount: number
}

export type WebSearchInput = {
  /** 1-4 条搜索 query（多 query 并发 + 去重合并） */
  queries: string[]
}

export type WebSearchOutput = {
  queries: string[]
  /** provider 生成的答案摘要（仅生成式后端有） */
  content?: string
  sources: Array<{
    title: string
    url: string
    snippet: string
    publishedAt?: string
  }>
  /** 合并后超出上限被截断 */
  truncated: boolean
}

export type WebFetchInput = {
  url: string
}

export type WebFetchOutput = {
  /** 模型给的原始 URL */
  url: string
  /** 重定向链终点 */
  finalUrl?: string
  /** 终点 HTTP 状态码（后端不提供时缺省） */
  statusCode?: number
  /** 正文（markdown；超 50,000 字符截断并附提示） */
  content: string
  truncated: boolean
  /** 'browser' = 服务端浏览器渲染；缺省视为 http */
  renderedBy?: 'http' | 'browser'
  /** 服务端附带提示（如渲染升级失败的降级说明） */
  notice?: string
}

export type KnowledgeLookupInput = {
  /** 平台名（knowledge-platforms.ts 映射表的键） */
  platform: KnowledgePlatformName
  /** 条目名（非自然语言问题；MDN 为斜杠路径） */
  term: string
}

export type KnowledgeLookupOutput = {
  platform: string
  term: string
  /** 模板渲染后的实际请求 URL */
  url: string
  /** 重定向链终点（维基未命中判定依据：停留在 Special: 页） */
  finalUrl?: string
  statusCode?: number
  /** false = 未命中（HTTP 4xx/5xx 或维基停在搜索页），content 为引导文案 */
  found: boolean
  content: string
  truncated: boolean
  renderedBy?: 'http' | 'browser'
  notice?: string
}
