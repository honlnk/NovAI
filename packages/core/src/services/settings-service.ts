import { testCompletionConnection } from '../core/ai/completion-client'
import { filterModelsByPurpose, listAvailableModels } from '../core/ai/models-client'
import { resolveDashScopeBuiltinModels } from '../core/ai/dashscope-models'

export type { DashScopeModelDoc } from '../core/ai/dashscope-models'
export {
  DASHSCOPE_EMBEDDING_MODELS,
  DASHSCOPE_RERANK_MODELS,
} from '../core/ai/dashscope-models'
import { testRerankConnection } from '../core/ai/rerank-client'
import { testEmbeddingConnection } from '../core/embedding/client'
import {
  readProjectConfig,
  readSystemPrompt as readCoreSystemPrompt,
  writeProjectConfig,
  writeSystemPrompt as writeCoreSystemPrompt,
} from '../core/fs/project-fs'
import { testLlmConnection } from '../core/llm/client'

import {
  requireRuntimeProject,
  setRuntimeProject,
} from './project-runtime'
import { toProjectConfigView } from './mappers'
import type {
  CompletionConfigView,
  ConnectionTestResultView,
  EmbeddingConfigView,
  ListModelsInputView,
  ListModelsResultView,
  LlmConfigView,
  ModelListPurposeView,
  ProjectConfigPatch,
  ProjectConfigView,
  RerankConfigView,
} from './types'

export async function getConfig(projectId: string): Promise<ProjectConfigView> {
  const project = requireRuntimeProject(projectId)
  return toProjectConfigView(await readProjectConfig(project.handle))
}

export async function updateConfig(
  projectId: string,
  patch: ProjectConfigPatch,
): Promise<ProjectConfigView> {
  const project = requireRuntimeProject(projectId)
  const currentConfig = await readProjectConfig(project.handle)
  const nextConfig: ProjectConfigView = {
    ...currentConfig,
    project: {
      ...currentConfig.project,
      ...patch.project,
    },
    llm: {
      ...currentConfig.llm,
      ...patch.llm,
    },
    embedding: {
      ...currentConfig.embedding,
      ...patch.embedding,
    },
    rerank: {
      ...currentConfig.rerank,
      ...patch.rerank,
    },
    completion: {
      ...currentConfig.completion,
      ...patch.completion,
    },
    settings: {
      ...currentConfig.settings,
      ...patch.settings,
    },
  }

  const savedConfig = await writeProjectConfig(project.handle, nextConfig)

  setRuntimeProject({
    ...project,
    name: savedConfig.project.name || project.rootName,
    config: savedConfig,
  })

  return toProjectConfigView(savedConfig)
}

export async function readSystemPrompt(projectId: string): Promise<string> {
  const project = requireRuntimeProject(projectId)
  return readCoreSystemPrompt(project.handle)
}

export async function writeSystemPrompt(
  projectId: string,
  content: string,
): Promise<void> {
  const project = requireRuntimeProject(projectId)
  await writeCoreSystemPrompt(project.handle, content)
}

export async function testLlm(config: LlmConfigView): Promise<ConnectionTestResultView> {
  return testLlmConnection({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    protocol: config.protocol,
  })
}

export async function testEmbedding(
  config: EmbeddingConfigView,
): Promise<ConnectionTestResultView> {
  return testEmbeddingConnection({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  })
}

export async function testRerank(
  config: Pick<RerankConfigView, 'baseUrl' | 'apiKey' | 'model'>,
): Promise<ConnectionTestResultView> {
  return testRerankConnection({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  })
}

export async function testCompletion(
  config: Pick<CompletionConfigView, 'baseUrl' | 'apiKey' | 'model'>,
): Promise<ConnectionTestResultView> {
  return testCompletionConnection({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  })
}

/**
 * 拉取模型服务的可用模型列表（用于设置页「获取列表」下拉）。
 * 直接使用表单当前填写的信息，不要求配置已保存。
 * 指定 purpose 时同时返回按用途过滤后的子集，调用方可两者切换展示。
 *
 * 百炼（DashScope）的 embedding / rerank 模型不走 API 拉取——百炼列表接口
 * 不返回这两类模型——直接使用内置清单（见 dashscope-models.ts）。
 */
export async function listModels(
  input: ListModelsInputView & { purpose?: ModelListPurposeView },
): Promise<ListModelsResultView> {
  const builtinModels = resolveDashScopeBuiltinModels(input.baseUrl, input.purpose ?? 'llm')

  if (builtinModels) {
    return { models: builtinModels, filtered: builtinModels, source: 'builtin' }
  }

  const { models } = await listAvailableModels({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    protocol: input.protocol,
  })

  return {
    models,
    filtered: input.purpose ? filterModelsByPurpose(models, input.purpose) : models,
    source: 'api',
  }
}
