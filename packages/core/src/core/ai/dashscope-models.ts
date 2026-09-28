import type { ModelListPurpose } from './models-client'

/**
 * 阿里云百炼（DashScope）Embedding / Rerank 模型的内置清单。
 *
 * 背景：百炼的模型列表接口（compatible-mode/v1/models）主要返回对话类模型，
 * 不包含 embedding / rerank 模型，导致设置页「获取列表」拿不到可用选项。
 * 因此这两类模型改为内置清单直接展示（不请求 API），由本文件维护。
 *
 * 数据来源：阿里云百炼官方文档（向量化、Rerank API），整理于 2026-08。
 * 上线新模型或下线旧模型时，更新这里与文档页（ModelDocsView）会自动同步。
 */
export type DashScopeModelDoc = {
  /** 模型 ID（写入配置时使用的准确名称） */
  id: string
  /** 展示名 */
  name: string
  /** 一句话定位，用于快速决策 */
  summary: string
  /** 通俗介绍（文档页展示） */
  description: string
  /** 关键规格（文档页列表展示） */
  specs: string[]
  /** 当前推荐使用的模型 */
  recommended?: boolean
  /** 已下线的模型：不进入设置页选择列表，仅在文档页说明 */
  deprecated?: boolean
}

export const DASHSCOPE_EMBEDDING_MODELS: DashScopeModelDoc[] = [
  {
    id: 'qwen3.7-text-embedding',
    name: 'Qwen3.7 文本向量',
    summary: '最新一代文本向量模型，理解指令的能力比 v4 提升约 16%，效果优先时选它。',
    description:
      '2026 年推出的新一代文本向量模型。相比 text-embedding-v4，它在「按指令检索」上有明显提升——简单说，你告诉它「我要找描写战斗的段落」，它比你不说指令时找得更准。小说要素检索恰好是这类场景。',
    specs: [
      '走 OpenAI 兼容接口，NovAI 可直接使用',
      '指令遵循能力比 text-embedding-v4 提升约 16.4%',
    ],
    recommended: true,
  },
  {
    id: 'text-embedding-v4',
    name: '通义文本向量 v4',
    summary: '上一代主力，百语种支持，久经验证的稳妥选择。',
    description:
      '基于 Qwen3 训练的多语言文本向量模型，是目前使用最广泛的版本。支持 100 多种语言和代码，检索、聚类、分类性能都很强。如果你的向量库已经用它建过索引，继续用它保持一致即可。',
    specs: [
      '支持 100+ 种语言和代码',
      '向量维度 64~2048 可调，默认 1024（NovAI 使用默认值，一般不用管）',
      '单条文本最长 8192 token（约 5000~6000 个汉字）',
      '一次请求最多 10 条文本',
    ],
  },
  {
    id: 'text-embedding-v3',
    name: '通义文本向量 v3',
    summary: '更早一代的主力模型，仍在售；新项目建议直接用 v4 或 qwen3.7。',
    description:
      '上一代主力模型，多语言支持，默认 1024 维。性能不如 v4，但旧项目的向量库可能还在用它——换模型会导致新旧向量维度或语义空间不一致，需要重建索引。',
    specs: [
      '多语言支持，默认 1024 维',
      '单条文本最长 8192 token',
    ],
  },
]

export const DASHSCOPE_RERANK_MODELS: DashScopeModelDoc[] = [
  {
    id: 'qwen3-rerank',
    name: 'Qwen3 重排序',
    summary: '当前官方推荐，gte-rerank 的指定替代，中文效果最好。',
    description:
      '通义实验室的重排序模型，官方指定用来替代已下线的 gte-rerank。支持 100 多种语言，中文场景效果好。它还支持「排序指令」（比如告诉它优先找人物相关的结果），NovAI 暂未用到这个能力，用的是默认排序策略。',
    specs: [
      '支持 100+ 种语言',
      '单条文本最长 4000 token，一次最多 500 条',
      '单次请求总量上限 12 万 token',
      'gte-rerank 的官方推荐替代',
    ],
    recommended: true,
  },
  {
    id: 'gte-rerank-v2',
    name: 'GTE 重排序 v2',
    summary: '上一代模型，仍在售；单次请求的总 token 上限更紧（3 万）。',
    description:
      '上一代重排序模型，支持 50 多种语言。注意它的单次请求总 token 上限是 3 万，只有 qwen3-rerank 的四分之一——NovAI 精排时会把多条候选要素拼在一起送过去，候选多的时候这个上限可能成为瓶颈。',
    specs: [
      '支持 50+ 种语言',
      '单条文本最长 4000 token，一次最多 500 条',
      '单次请求总量上限 3 万 token（比 qwen3-rerank 紧）',
    ],
  },
  {
    id: 'gte-rerank',
    name: 'GTE 重排序（已下线）',
    summary: '已于 2026-05-30 下线，无法再调用；请换用 qwen3-rerank。',
    description:
      '最早期的重排序模型，官方已于 2026 年 5 月 30 日下线。如果你的旧配置里还填着它，Rerank 会静默不生效或报错，请改为 qwen3-rerank。',
    specs: ['2026-05-30 已下线', '官方推荐替代：qwen3-rerank'],
    deprecated: true,
  },
]

/**
 * 识别阿里云 DashScope（百炼）地址，包括国际站。
 * 从 models-client 收敛到此单一实现，rerank 请求与内置清单判断共用。
 */
export function isDashScopeBaseUrl(baseUrl: string) {
  return /dashscope(-intl)?\.aliyuncs\.com/.test(baseUrl)
}

/** 内置清单覆盖的模型用途（llm / completion 走 API 拉取，不在此列）。 */
type BuiltinModelPurpose = 'embedding' | 'rerank'

/** 内置清单中可写入配置的模型 ID（排除已下线模型）。 */
export function listDashScopeModelIds(purpose: BuiltinModelPurpose): string[] {
  const docs = purpose === 'embedding' ? DASHSCOPE_EMBEDDING_MODELS : DASHSCOPE_RERANK_MODELS
  return docs.filter((model) => !model.deprecated).map((model) => model.id)
}

/**
 * 百炼 + embedding / rerank 场景返回内置清单（不请求 API）。
 * 其余场景（非百炼地址、或 llm / completion 用途）返回 null，表示应走 API 拉取。
 */
export function resolveDashScopeBuiltinModels(
  baseUrl: string,
  purpose: ModelListPurpose,
): string[] | null {
  if (purpose !== 'embedding' && purpose !== 'rerank') {
    return null
  }

  if (!isDashScopeBaseUrl(baseUrl)) {
    return null
  }

  return listDashScopeModelIds(purpose)
}
