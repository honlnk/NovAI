export const DEFAULT_SYSTEM_PROMPT = `# SYSTEM Prompt

在这里定义整部小说的基调、叙事视角、文风偏好与创作约束。

## 文件格式约定
- 章节正文写入 chapters/*.txt，正文使用纯文本。
- 章节文件名形如 第001章-章节标题.txt，编号至少 3 位补零，标题非空。
- 章节正文不要使用 Markdown 标题、列表、引用、分割线等格式符号。
- 人物、地点、实体、情节、时间线、世界观等要素写入 elements/**/*.md。
- SYSTEM 与 SCENE 提示词写入 prompts/**/*.md。`

export const DEFAULT_SCENE_PROMPT = `# Scene Prompt

在这里为具体章节记录本场景目标、冲突、登场人物与氛围。`

/**
 * 要素库规范 `prompts/ELEMENT.md` 的默认内容（《要素园丁子代理设计》§7.3 六节定稿文本）。
 *
 * 定位：本书要素库的「宪法」——园丁子代理的全部机构记忆（它每次全新上下文，只注入本文件）；
 * 用户可自由修改，改坏时模板分节说明有 core `templates.ts` 代码兜底。
 * 内容必须与代码资产保持一致：frontmatter 字段（types/elements.ts）、
 * 六类目录职责、五类模板分节名（core/elements/templates.ts）。
 */
export const DEFAULT_ELEMENT_SCHEMA = `# 要素库规范（ELEMENT.md）

这是本书要素库的整理规范。它只注入给「园丁」子代理（/整理要素 与要素整理任务专用），不进入主创作 Agent 的提示词。可以自由修改——园丁每次都以全新上下文启动，这份文件就是它全部的工作守则。

## 六类目录职责与边界

- \`elements/characters/\`：人物。一人一文件。
- \`elements/locations/\`：地点。一地一文件。
- \`elements/entities/\`：具体实体——武器、武功、坐骑、丹药、信物、法器、书籍等会被点名、持有或发生状态变化的东西。
- \`elements/plots/\`：剧情事件。一个独立事件一文件，不写「本章剧情」式的章节总纲。
- \`elements/timeline/\`：时间线阶段。一个故事阶段一文件，记录该阶段内的事件经过与后续影响。
- \`elements/worldbuilding/\`：世界观——抽象规则与体系（力量体系、社会制度、种族设定、地理总览等）。
- entities 与 worldbuilding 的分界：会被具体持有、点名、损耗、转移的东西归 entities；作为背景规则被引用的体系归 worldbuilding。拿不准时归 worldbuilding，并在汇报中注明。

## 命名规范

- 一人一文件、一地一文件、一物一文件；文件名即要素名（如 \`elements/characters/云溪.md\`）。
- 文件名与 frontmatter 的 name 字段保持一致。
- 同一要素的别名、称号、化名写进正文，不另开文件；近名是否同一要素由你语义判断，存疑不合并。

## frontmatter 维护规范

要素文件以 YAML frontmatter 开头，字段：id / type / name / summary / tags / lastUpdatedChapter / relatedChapters / updatedAt。整理时：

- tags：去除重复与无意义标签；标签是可检索的分类词，不写成要素类型名。
- relatedChapters：与已有列表取并集，绝不覆盖丢失已有章节；格式如「第12章」。
- lastUpdatedChapter：取涉及章节中最新的一章。
- summary：一句话概括该要素当前状态；合并信息后同步更新。
- updatedAt：整理时更新为当前时间。

## 链接约定

- 素材 → 章节：在正文里直接写章节文件路径（如 \`chapters/第012章-夜探剑冢.txt\`）。
- 素材 ↔ 素材：正文里用双方括号引用要素名（如 \`[[云溪]]\`、\`[[青冥剑]]\`）。
- 章节正文内不写任何链接——链接只存在于 elements/ 下的素材文件中。

## 园丁工作守则

- 合并同名/近名要素时，保留旧文件中的全部事实信息，新信息按模板小节归位，不允许静默丢弃。
- 存疑不合并：不能确信两条目是同一要素时，保持原样并列入汇报的「存疑事项」。
- 不删除任何文件。确需删除或改名的，列入汇报的「建议删除」交用户处理。
- 从不修改 chapters/ 正文，也不修改 prompts/ 下的任何文件（包括本文件）。
- 不做章节的初次批量提取——那是 /提取要素 的职责；你只治理存量要素库。
- 每次任务结束输出固定结构的汇报：改动文件清单 / 合并与迁移说明 / 存疑事项（待用户拍板）/ 建议删除。

## 模板结构说明

五类要素的 body 分节模板（创建新要素文件或补齐缺失小节时按此结构）：

- character（人物）：基本信息 / 简介 / 称呼规则 / 外貌与性格 / 人物关系 / 行为边界 / 相关剧情 / 状态变化
- location（地点）：基本信息 / 简介 / 空间位置 / 可见性与可达性 / 地点关系 / 相关剧情 / 状态变化
- entity（实体）：基本信息 / 简介 / 外观或表现 / 来历 / 当前归属 / 能力或用途 / 剧情关联 / 状态变化
- plot（剧情）：基本信息 / 核心事件 / 关键细节 / 登场人物 / 情感落点 / 暗线铺垫 / 关联要素
- timeline（时间线）：基本信息（必含「故事内时间」「所属阶段」）/ 事件经过 / 涉及要素 / 后续影响
- worldbuilding（世界观）：无固定模板，按规则体系自行组织分节。`

/**
 * 项目总览 prompts/NovAI.md 的默认骨架。
 *
 * 作用类似 Claude Code 的 CLAUDE.md：项目级累积记忆，每轮注入到 Agent 的 system prompt。
 * 它回答“写到哪了、有哪些人物、哪些伏笔待回收、风格约定是什么”，让 Agent 不必每轮从零重建项目上下文。
 *
 * 新建项目时写入空骨架，用户可手动补充，或用 /生成项目记忆 让 Agent 扫描后填充。
 * 段落结构应与 init-novel-prompt.ts 的生成结构保持一致，便于手动与自动两种维护方式无缝衔接。
 */
export const DEFAULT_NOVAI_OVERVIEW = `# 项目总览（NovAI.md）

这是本小说项目的项目级记忆。每轮 Agent 运行都会读取它作为上下文，让它知道“写到哪了、有哪些人物和设定、哪些伏笔待回收”。
可以手动编辑，也可以在输入框用 /生成项目记忆 让 Agent 扫描全项目后自动更新。

## 作品概述

- 一句话简介：待补充
- 题材类型：待补充
- 当前状态：待补充

## 章节进度

- 已完成章节：待补充
- 当前主线：待补充
- 当前卡点：待补充

## 主要人物

- 待补充

## 世界观速览

- 待补充

## 伏笔追踪

- 已埋设：待补充
- 已回收：待补充

## 风格约定

- 叙事人称：待补充
- 时态：待补充
- 文风：待补充`

export const DEFAULT_CONFIG = {
  version: 1,
  project: {
    name: '',
    createdAt: '',
    updatedAt: '',
  },
  llm: {
    baseUrl: '',
    apiKey: '',
    model: '',
    protocol: 'openai',
  },
  embedding: {
    baseUrl: '',
    apiKey: '',
    model: '',
  },
  rerank: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    mode: 'text',
    topN: 8,
  },
  completion: {
    enabled: false,
    baseUrl: 'https://api.deepseek.com/beta',
    apiKey: '',
    model: 'deepseek-chat',
    debounceMs: 600,
    maxTokens: 64,
  },
  search: {
    provider: 'linkseek-hosted',
    baseUrl: '',
    apiKey: '',
  },
  settings: {
    ragCandidateLimit: 20,
    ragContextMaxItems: 8,
    conversationTokenLimit: 12000,
    compressionKeepRecentTurns: 5,
    agentMaxTurns: 0,
    permissionPreset: 'chapter-material',
    embeddingTextVersion: 1,
    enableDebugLogging: false,
    activeScenePromptPath: null,
  },
} as const

/** 写工具权限档位的合法值表与默认值（档位语义见 types/project.ts 的 PermissionPreset）。 */
export const PERMISSION_PRESETS = ['review', 'chapter', 'material', 'chapter-material', 'full'] as const

export const DEFAULT_PERMISSION_PRESET = DEFAULT_CONFIG.settings.permissionPreset

export function isPermissionPreset(value: unknown): value is (typeof PERMISSION_PRESETS)[number] {
  return typeof value === 'string' && (PERMISSION_PRESETS as readonly string[]).includes(value)
}

/** 联网搜索来源档位的合法值表与默认值（档位语义见 types/project.ts 的 SearchProviderKind）。 */
export const SEARCH_PROVIDERS = [
  'linkseek-hosted',
  'linkseek-selfhost',
  'exa',
  'perplexity',
] as const

export function isSearchProvider(value: unknown): value is (typeof SEARCH_PROVIDERS)[number] {
  return typeof value === 'string' && (SEARCH_PROVIDERS as readonly string[]).includes(value)
}

/** 思考强度档位的合法值表（档位语义见 types/ai.ts 的 ReasoningEffort；未配置 = 请求层按 off 解析）。 */
export const REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const

export function isReasoningEffort(value: unknown): value is (typeof REASONING_EFFORTS)[number] {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}

export function createDefaultConfig(projectName: string) {
  const now = new Date().toISOString()

  return {
    ...DEFAULT_CONFIG,
    project: {
      name: projectName,
      createdAt: now,
      updatedAt: now,
    },
  }
}

export function createDefaultManifest(projectId: string) {
  const now = new Date().toISOString()

  return {
    version: 1,
    projectId,
    createdAt: now,
    lastOpenedAt: now,
  }
}
