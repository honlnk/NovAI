export const DEFAULT_SYSTEM_PROMPT = `# SYSTEM Prompt

在这里定义整部小说的基调、叙事视角、文风偏好与创作约束。

## 文件格式约定
- 章节正文写入 chapters/*.txt，正文使用纯文本。
- 章节文件第一行写章节标题，例如：第001章 章节标题。
- 章节正文不要使用 Markdown 标题、列表、引用、分割线等格式符号。
- 人物、地点、实体、情节、时间线、世界观等要素写入 elements/**/*.md。
- SYSTEM 与 SCENE 提示词写入 prompts/**/*.md。`

export const DEFAULT_SCENE_PROMPT = `# Scene Prompt

在这里为具体章节记录本场景目标、冲突、登场人物与氛围。`

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
  settings: {
    generationRecentChapters: 3,
    ragCandidateLimit: 20,
    ragContextMaxItems: 8,
    proofreadDefaultChapters: 3,
    organizeDefaultChapters: 10,
    conversationTokenLimit: 12000,
    compressionKeepRecentTurns: 5,
    embeddingTextVersion: 1,
    enableBackgroundIndexing: true,
    enableDebugLogging: false,
    activeScenePromptPath: null,
  },
} as const

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
