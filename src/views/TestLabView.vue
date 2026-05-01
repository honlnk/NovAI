<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import { previewElementExtraction } from '../services/element-service'
import { writeChapter } from '../services/file-service'
import { streamGeneration } from '../services/generation-service'
import {
  inspectIndex,
  rebuildIndex,
  runRagDebug,
} from '../services/rag-service'
import { useProjectStore } from '../stores/project'
import { useSettingsStore } from '../stores/settings'
import type {
  ElementExtractionResultView,
  GenerationContextDraftView,
  ProjectConfigView,
  ProjectFileNodeView,
  ProjectIndexMetaView,
  RetrievalExplanationView,
} from '../services/types'

const projectName = ref('我的测试小说')
const status = ref('这里先作为 AI 功能测试页使用。')
const connectionStatus = ref('还没有测试连接。')
const generationStatus = ref('还没有开始生成。')
const isBusy = ref(false)
const isStreaming = ref(false)
const systemPrompt = ref('你是一名长篇小说写作助手，输出中文 Markdown。')
const instruction = ref('写一段测试内容：主角深夜走进废弃藏书楼，发现一封来自十年前的信。')
const chapterFileName = ref('chapter-test.md')
const result = ref('')
const lastSavedChapterPath = ref('')
const rerankStatus = ref('还没有测试 Rerank 连接。')
const indexStatusMessage = ref('还没有读取索引状态。')
const ragStatus = ref('还没有执行 RAG 调试流程。')
const extractionStatus = ref('还没有执行要素提取预览。')
const projectIndexMeta = ref<ProjectIndexMetaView | null>(null)
const ragDraft = ref<GenerationContextDraftView | null>(null)
const retrievalExplanations = ref<RetrievalExplanationView[]>([])
const extractionPreview = ref<ElementExtractionResultView | null>(null)
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()

const configDraft = reactive<ProjectConfigView>({
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
  },
})

const currentProject = computed(() => projectStore.currentProject)
const activeFile = computed(() => projectStore.activeFile)
const projectLabel = computed(() => currentProject.value?.rootName ?? '未选择项目')
const configPreview = computed(() => JSON.stringify(configDraft, null, 2))
const readableFiles = computed(() => flattenReadableFiles(currentProject.value?.files ?? []))
const groupedReadableFiles = computed(() => groupReadableFiles(readableFiles.value))
const indexMetaPreview = computed(() => JSON.stringify(projectIndexMeta.value, null, 2))
const ragDraftPreview = computed(() => JSON.stringify(ragDraft.value, null, 2))
const extractionPreviewText = computed(() => JSON.stringify(extractionPreview.value, null, 2))
const retrievalExplanationPreview = computed(() => JSON.stringify(retrievalExplanations.value, null, 2))

function applyConfigDraft(config: ProjectConfigView) {
  configDraft.version = config.version
  configDraft.project = { ...config.project }
  configDraft.llm = { ...config.llm }
  configDraft.embedding = { ...config.embedding }
  configDraft.rerank = { ...config.rerank }
  configDraft.settings = { ...config.settings }
}

async function onCreateProject() {
  await runTask(async () => {
    const project = await projectStore.createNewProject(projectName.value.trim() || '我的测试小说')

    if (project) {
      await activateProjectView(`已创建并打开项目「${project.name}」`)
    }
  }, '创建项目失败')
}

async function onOpenProject() {
  await runTask(async () => {
    const project = await projectStore.openExistingProject()

    if (project) {
      await activateProjectView(`已打开项目「${project.name}」`)
    }
  }, '打开项目失败')
}

async function onSaveConfig() {
  if (!currentProject.value) {
    status.value = '请先创建或打开项目'
    return
  }

  await runTask(async () => {
    const savedConfig = await settingsStore.saveConfig(currentProject.value!.id, {
      project: {
        ...configDraft.project,
        name: configDraft.project.name || currentProject.value!.rootName,
      },
      llm: { ...configDraft.llm },
      embedding: { ...configDraft.embedding },
      rerank: { ...configDraft.rerank },
      settings: { ...configDraft.settings },
    })

    if (savedConfig) {
      applyConfigDraft(savedConfig)
      projectStore.updateCurrentProjectConfig(savedConfig)
      status.value = '配置已保存到 novel.config.json'
    }
  }, '保存配置失败')
}

async function onSaveSystemPrompt() {
  if (!currentProject.value) {
    status.value = '请先创建或打开项目'
    return
  }

  await runTask(async () => {
    await settingsStore.saveSystemPrompt(currentProject.value!.id, systemPrompt.value)
    status.value = 'system.md 已保存'
  }, '保存 system prompt 失败')
}

async function onTestLlm() {
  connectionStatus.value = '正在测试 LLM 连接...'
  const checked = await settingsStore.testLlmConfig(configDraft.llm)
  connectionStatus.value = checked?.message ?? settingsStore.errorMessage
}

async function onTestEmbedding() {
  connectionStatus.value = '正在测试 Embedding 连接...'
  const checked = await settingsStore.testEmbeddingConfig(configDraft.embedding)
  connectionStatus.value = checked?.message ?? settingsStore.errorMessage
}

async function onTestRerank() {
  rerankStatus.value = '正在测试 Rerank 连接...'
  const checked = await settingsStore.testRerankConfig(configDraft.rerank)
  rerankStatus.value = checked?.message ?? settingsStore.errorMessage
}

async function onGenerate() {
  result.value = ''
  generationStatus.value = '正在发起流式生成...'
  isStreaming.value = true

  try {
    await streamGeneration(
      {
        baseUrl: configDraft.llm.baseUrl,
        apiKey: configDraft.llm.apiKey,
        model: configDraft.llm.model,
        systemPrompt: systemPrompt.value,
        instruction: instruction.value,
      },
      (event) => {
        if (event.type === 'start') {
          generationStatus.value = '已连接模型，开始接收流式输出...'
        }

        if (event.type === 'delta') {
          result.value += event.text
        }

        if (event.type === 'finish') {
          result.value = event.text
          generationStatus.value = '生成完成'
          isStreaming.value = false
        }

        if (event.type === 'error') {
          generationStatus.value = event.message
          isStreaming.value = false
        }
      },
    )
  } catch (error) {
    generationStatus.value = error instanceof Error ? error.message : '生成失败'
    isStreaming.value = false
  }
}

async function onSaveChapter() {
  if (!currentProject.value) {
    status.value = '请先创建或打开项目'
    return
  }

  if (!result.value.trim()) {
    generationStatus.value = '当前没有可保存的生成结果'
    return
  }

  await runTask(async () => {
    const savedFile = await writeChapter(currentProject.value!.id, chapterFileName.value, result.value)

    lastSavedChapterPath.value = savedFile.path
    chapterFileName.value = savedFile.name
    generationStatus.value = `已保存章节：${savedFile.name}`
    await refreshProjectFiles(savedFile.path)
  }, '保存章节失败')
}

async function onInspectIndexMeta() {
  if (!currentProject.value) {
    indexStatusMessage.value = '请先创建或打开项目'
    return
  }

  await runTask(async () => {
    projectIndexMeta.value = await inspectIndex(currentProject.value!.id)
    indexStatusMessage.value = projectIndexMeta.value
      ? `已读取索引状态：${projectIndexMeta.value.status}`
      : '当前项目还没有索引元信息'
  }, '读取索引状态失败')
}

async function onBuildIndexSkeleton() {
  if (!currentProject.value) {
    indexStatusMessage.value = '请先创建或打开项目'
    return
  }

  await runTask(async () => {
    const built = await rebuildIndex(currentProject.value!.id)
    projectIndexMeta.value = await inspectIndex(currentProject.value!.id)
    indexStatusMessage.value = built.message
  }, '触发索引构建失败')
}

async function onRunRagDemo() {
  if (!currentProject.value) {
    ragStatus.value = '请先创建或打开项目'
    return
  }

  await runTask(async () => {
    ragStatus.value = '正在执行 RAG 调试流程...'

    const debug = await runRagDebug(currentProject.value!.id, instruction.value.trim())

    ragDraft.value = debug.draft
    retrievalExplanations.value = debug.explanations
    ragStatus.value = debug.recalledCount > 0
      ? `RAG 调试完成，当前召回 ${debug.recalledCount} 条候选`
      : 'RAG 调试完成：当前索引为空，暂时没有可召回候选'
  }, '执行 RAG 调试失败')
}

async function onPreviewElementExtraction() {
  const chapterMarkdown = result.value.trim() || activeFile.value?.content || ''

  if (!chapterMarkdown) {
    extractionStatus.value = '请先生成章节结果，或先打开一个可预览文件'
    return
  }

  await runTask(async () => {
    extractionPreview.value = await previewElementExtraction({
      chapterMarkdown,
      chapterPath: activeFile.value?.path || lastSavedChapterPath.value || '',
      systemPrompt: systemPrompt.value,
    })

    const total =
      extractionPreview.value.characters.length +
      extractionPreview.value.locations.length +
      extractionPreview.value.timeline.length +
      extractionPreview.value.plots.length +
      extractionPreview.value.worldbuilding.length

    extractionStatus.value = total > 0
      ? `要素提取预览完成，共得到 ${total} 条候选`
      : '要素提取预览完成：当前仍是占位结果'
  }, '执行要素提取预览失败')
}

async function activateProjectView(message: string) {
  if (!currentProject.value) {
    return
  }

  const settings = await settingsStore.loadSettings(currentProject.value.id)

  if (settings) {
    applyConfigDraft(settings.config)
    systemPrompt.value = settings.systemPrompt
  }

  status.value = message
}

async function onOpenFile(path: string) {
  if (!currentProject.value) {
    status.value = '请先创建或打开项目'
    return
  }

  await runTask(async () => {
    await projectStore.openFile(path)
    status.value = `已打开文件：${path}`
  }, '读取文件失败')
}

async function refreshProjectFiles(preferredPath?: string) {
  if (!currentProject.value) {
    return
  }

  await projectStore.refreshTree()

  const nextPath =
    preferredPath ||
    activeFile.value?.path ||
    findFirstReadableFile(currentProject.value.files)

  if (nextPath) {
    await projectStore.openFile(nextPath)
  }
}

async function runTask(action: () => Promise<void>, fallback: string) {
  if (!projectStore.isFileSystemSupported) {
    status.value = '当前浏览器不支持 File System Access API，请使用 Chromium 内核浏览器。'
    return
  }

  isBusy.value = true

  try {
    await action()
  } catch (error) {
    status.value = error instanceof Error ? error.message : fallback
  } finally {
    isBusy.value = false
  }
}

function flattenReadableFiles(tree: ProjectFileNodeView[]) {
  const files: Array<{ path: string; name: string }> = []
  const stack = [...tree]

  while (stack.length > 0) {
    const node = stack.shift()

    if (!node) {
      continue
    }

    if (node.kind === 'file' && /\.(md|json|txt)$/i.test(node.name)) {
      files.push({
        path: node.path,
        name: node.name,
      })
      continue
    }

    if (node.children?.length) {
      stack.unshift(...node.children)
    }
  }

  return files
}

function findFirstReadableFile(tree: ProjectFileNodeView[]) {
  return flattenReadableFiles(tree)[0]?.path ?? null
}

function groupReadableFiles(files: Array<{ path: string; name: string }>) {
  const groups = new Map<string, Array<{ path: string; name: string }>>()

  for (const file of files) {
    // 测试页只做最粗粒度分组，按顶层目录展示就足够定位文件来源。
    const groupName = file.path.includes('/') ? file.path.split('/')[0] : 'root'
    const group = groups.get(groupName) ?? []
    group.push(file)
    groups.set(groupName, group)
  }

  return Array.from(groups.entries())
    .map(([groupName, items]) => ({
      groupName,
      items: items.sort((left, right) => left.path.localeCompare(right.path, 'zh-Hans-CN')),
    }))
    .sort((left, right) => left.groupName.localeCompare(right.groupName, 'zh-Hans-CN'))
}
</script>

<template>
  <main>
    <h1>NovAI Test Lab</h1>
    <p>这个页面只用来测试 AI 功能，不做正式 UI。</p>
    <p>{{ status }}</p>
    <p>当前项目：{{ projectLabel }}</p>

    <section>
      <h2>项目入口</h2>
      <label>
        <span>项目名称</span>
        <input v-model="projectName" type="text" style="width: 100%" />
      </label>
      <button type="button" :disabled="isBusy" @click="onCreateProject">创建小说</button>
      <button type="button" :disabled="isBusy" @click="onOpenProject">打开小说</button>
    </section>

    <section>
      <h2>配置读写</h2>
      <label>
        <span>项目名</span>
        <input v-model="configDraft.project.name" type="text" style="width: 100%" />
      </label>
      <label>
        <span>LLM API 地址</span>
        <input v-model="configDraft.llm.baseUrl" type="text" style="width: 100%" />
      </label>
      <label>
        <span>LLM API Key</span>
        <input v-model="configDraft.llm.apiKey" type="text" style="width: 100%" />
      </label>
      <label>
        <span>LLM 模型</span>
        <input v-model="configDraft.llm.model" type="text" style="width: 100%" />
      </label>
      <label>
        <span>Embedding API 地址</span>
        <input v-model="configDraft.embedding.baseUrl" type="text" style="width: 100%" />
      </label>
      <label>
        <span>Embedding API Key</span>
        <input v-model="configDraft.embedding.apiKey" type="text" style="width: 100%" />
      </label>
      <label>
        <span>Embedding 模型</span>
        <input v-model="configDraft.embedding.model" type="text" style="width: 100%" />
      </label>
      <label>
        <span>Rerank 启用</span>
        <input v-model="configDraft.rerank.enabled" type="checkbox" />
      </label>
      <label>
        <span>Rerank API 地址</span>
        <input v-model="configDraft.rerank.baseUrl" type="text" style="width: 100%" />
      </label>
      <label>
        <span>Rerank API Key</span>
        <input v-model="configDraft.rerank.apiKey" type="text" style="width: 100%" />
      </label>
      <label>
        <span>Rerank 模型</span>
        <input v-model="configDraft.rerank.model" type="text" style="width: 100%" />
      </label>
      <label>
        <span>Rerank 模式</span>
        <select v-model="configDraft.rerank.mode" style="width: 100%">
          <option value="text">text</option>
          <option value="multimodal">multimodal</option>
        </select>
      </label>
      <label>
        <span>Rerank TopN</span>
        <input v-model.number="configDraft.rerank.topN" type="number" min="1" style="width: 100%" />
      </label>
      <label>
        <span>RAG 最终上下文条数</span>
        <input v-model.number="configDraft.settings.ragContextMaxItems" type="number" min="1" style="width: 100%" />
      </label>
      <label>
        <span>Embedding 模板版本</span>
        <input v-model.number="configDraft.settings.embeddingTextVersion" type="number" min="1" style="width: 100%" />
      </label>
      <label>
        <span>后台索引更新</span>
        <input v-model="configDraft.settings.enableBackgroundIndexing" type="checkbox" />
      </label>
      <button type="button" :disabled="isBusy || !currentProject" @click="onSaveConfig">保存配置</button>
      <pre>{{ configPreview }}</pre>
    </section>

    <section>
      <h2>连接测试</h2>
      <p>{{ connectionStatus }}</p>
      <p>{{ rerankStatus }}</p>
      <button type="button" @click="onTestLlm">测试 LLM</button>
      <button type="button" @click="onTestEmbedding">测试 Embedding</button>
      <button type="button" @click="onTestRerank">测试 Rerank</button>
    </section>

    <section>
      <h2>System Prompt</h2>
      <textarea v-model="systemPrompt" rows="8" style="width: 100%" />
      <button type="button" :disabled="isBusy || !currentProject" @click="onSaveSystemPrompt">保存 system.md</button>
    </section>

    <section>
      <h2>Instruction</h2>
      <textarea v-model="instruction" rows="6" style="width: 100%" />
    </section>

    <section>
      <h2>流式生成</h2>
      <p>{{ generationStatus }}</p>
      <button type="button" :disabled="isStreaming" @click="onGenerate">开始生成</button>
    </section>

    <section>
      <h2>Result</h2>
      <pre>{{ result || '还没有结果' }}</pre>
    </section>

    <section>
      <h2>章节写入</h2>
      <label>
        <span>章节文件名</span>
        <input v-model="chapterFileName" type="text" style="width: 100%" />
      </label>
      <button type="button" :disabled="isBusy || !currentProject || isStreaming" @click="onSaveChapter">保存到 chapters</button>
      <p>{{ lastSavedChapterPath || '还没有保存章节文件' }}</p>
    </section>

    <section>
      <h2>索引状态</h2>
      <p>{{ indexStatusMessage }}</p>
      <button type="button" :disabled="isBusy || !currentProject" @click="onInspectIndexMeta">读取索引状态</button>
      <button type="button" :disabled="isBusy || !currentProject" @click="onBuildIndexSkeleton">触发索引构建</button>
      <pre>{{ indexMetaPreview || '还没有索引状态数据' }}</pre>
    </section>

    <section>
      <h2>RAG 调试</h2>
      <p>{{ ragStatus }}</p>
      <button type="button" :disabled="isBusy || !currentProject" @click="onRunRagDemo">执行 RAG 调试</button>
      <h3>上下文草稿</h3>
      <pre>{{ ragDraftPreview || '还没有 RAG 草稿数据' }}</pre>
      <h3>命中解释</h3>
      <pre>{{ retrievalExplanationPreview || '还没有命中解释数据' }}</pre>
    </section>

    <section>
      <h2>要素提取预览</h2>
      <p>{{ extractionStatus }}</p>
      <button type="button" :disabled="isBusy" @click="onPreviewElementExtraction">执行要素提取预览</button>
      <pre>{{ extractionPreviewText || '还没有要素提取结果' }}</pre>
    </section>

    <section>
      <h2>项目文档</h2>
      <p>{{ readableFiles.length > 0 ? `共加载 ${readableFiles.length} 个可预览文件` : '当前项目还没有可预览文件' }}</p>
      <div v-if="readableFiles.length > 0">
        <div v-for="group in groupedReadableFiles" :key="group.groupName">
          <h3>{{ group.groupName }}</h3>
          <div>
            <button
              v-for="file in group.items"
              :key="file.path"
              type="button"
              @click="onOpenFile(file.path)"
            >
              {{ file.name }} ({{ file.path }})
            </button>
          </div>
        </div>
      </div>
    </section>

    <section>
      <h2>文件预览</h2>
      <p>{{ activeFile ? activeFile.path : '还没有打开文件' }}</p>
      <pre>{{ activeFile ? activeFile.content : '当前没有可预览的文件内容' }}</pre>
    </section>

  </main>
</template>
