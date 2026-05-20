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
  ConnectionTestResultView,
  EmbeddingConfigView,
  LlmConfigView,
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
  config: RerankConfigView,
): Promise<ConnectionTestResultView> {
  return testRerankConnection({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  })
}
