<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import { testEmbeddingConnection } from '../core/embedding/client'
import {
  createProject,
  findFirstReadableFile,
  inspectProject,
  isFileSystemAccessSupported,
  pickProjectDirectory,
  readProjectFile,
  readSystemPrompt,
  repairProject,
  rescanProject,
  writeChapterFile,
  writeProjectConfig,
  writeSystemPrompt,
} from '../core/fs/project-fs'
import { testLlmConnection, streamChatCompletion } from '../core/llm/client'
import type { ProjectConfig, ProjectFileContent, ProjectInspection, ProjectSnapshot, TreeNode } from '../types/project'

const projectName = ref('我的测试小说')
const currentProject = ref<ProjectSnapshot | null>(null)
const pendingHandle = ref<FileSystemDirectoryHandle | null>(null)
const inspection = ref<ProjectInspection | null>(null)
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
const activeFile = ref<ProjectFileContent | null>(null)

const configDraft = reactive<ProjectConfig>({
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
  settings: {
    generationRecentChapters: 3,
    ragCandidateLimit: 20,
    proofreadDefaultChapters: 3,
    organizeDefaultChapters: 10,
    conversationTokenLimit: 12000,
    compressionKeepRecentTurns: 5,
  },
})

const canRepair = computed(() => pendingHandle.value && inspection.value && !inspection.value.canLoad)
const projectLabel = computed(() => currentProject.value?.rootName ?? inspection.value?.rootName ?? '未选择项目')
const configPreview = computed(() => JSON.stringify(configDraft, null, 2))
const readableFiles = computed(() => flattenReadableFiles(currentProject.value?.tree ?? []))
const groupedReadableFiles = computed(() => groupReadableFiles(readableFiles.value))

function applyConfigDraft(config: ProjectConfig) {
  configDraft.version = config.version
  configDraft.project = { ...config.project }
  configDraft.llm = { ...config.llm }
  configDraft.embedding = { ...config.embedding }
  configDraft.settings = { ...config.settings }
}

async function onCreateProject() {
  await runTask(async () => {
    const snapshot = await createProject(projectName.value.trim() || '我的测试小说')
    await activateProject(snapshot, `已创建并打开项目「${snapshot.name}」`)
  }, '创建项目失败')
}

async function onOpenProject() {
  await runTask(async () => {
    const handle = await pickProjectDirectory()
    pendingHandle.value = handle
    currentProject.value = null
    inspection.value = await inspectProject(handle)

    if (inspection.value.canLoad) {
      const snapshot = await repairProject(handle)
      await activateProject(snapshot, `已打开项目「${snapshot.name}」`)
      return
    }

    status.value = `目录「${handle.name}」缺少必要文件，可点击“修复项目结构”补齐`
  }, '打开项目失败')
}

async function onRepairProject() {
  const handle = pendingHandle.value

  if (!handle) {
    status.value = '请先选择一个目录'
    return
  }

  await runTask(async () => {
    const snapshot = await repairProject(handle)
    await activateProject(snapshot, `已修复并打开项目「${snapshot.name}」`)
  }, '修复项目失败')
}

async function onSaveConfig() {
  if (!currentProject.value) {
    status.value = '请先创建或打开项目'
    return
  }

  await runTask(async () => {
    const savedConfig = await writeProjectConfig(currentProject.value!.handle, {
      ...configDraft,
      project: {
        ...configDraft.project,
        name: configDraft.project.name || currentProject.value!.rootName,
      },
      llm: { ...configDraft.llm },
      embedding: { ...configDraft.embedding },
      settings: { ...configDraft.settings },
    })

    applyConfigDraft(savedConfig)
    currentProject.value = {
      ...currentProject.value!,
      name: savedConfig.project.name,
      config: savedConfig,
    }
    status.value = '配置已保存到 novel.config.json'
  }, '保存配置失败')
}

async function onSaveSystemPrompt() {
  if (!currentProject.value) {
    status.value = '请先创建或打开项目'
    return
  }

  await runTask(async () => {
    await writeSystemPrompt(currentProject.value!.handle, systemPrompt.value)
    status.value = 'system.md 已保存'
  }, '保存 system prompt 失败')
}

async function onTestLlm() {
  connectionStatus.value = '正在测试 LLM 连接...'
  const checked = await testLlmConnection({
    baseUrl: configDraft.llm.baseUrl,
    apiKey: configDraft.llm.apiKey,
    model: configDraft.llm.model,
  })
  connectionStatus.value = checked.message
}

async function onTestEmbedding() {
  connectionStatus.value = '正在测试 Embedding 连接...'
  const checked = await testEmbeddingConnection({
    baseUrl: configDraft.embedding.baseUrl,
    apiKey: configDraft.embedding.apiKey,
    model: configDraft.embedding.model,
  })
  connectionStatus.value = checked.message
}

async function onGenerate() {
  result.value = ''
  generationStatus.value = '正在发起流式生成...'
  isStreaming.value = true

  try {
    await streamChatCompletion(
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
    const savedName = await writeChapterFile(currentProject.value!.handle, chapterFileName.value, result.value)
    lastSavedChapterPath.value = `chapters/${savedName}`
    chapterFileName.value = savedName
    generationStatus.value = `已保存章节：${savedName}`
    await refreshProjectFiles(`chapters/${savedName}`)
  }, '保存章节失败')
}

async function activateProject(snapshot: ProjectSnapshot, message: string) {
  // 项目一旦激活，就把测试页需要的状态一次性同步过来，避免每块区域各自再读一遍文件。
  currentProject.value = snapshot
  pendingHandle.value = snapshot.handle
  inspection.value = await inspectProject(snapshot.handle)
  applyConfigDraft(snapshot.config)
  systemPrompt.value = await readSystemPrompt(snapshot.handle)
  await openInitialFile(snapshot)
  status.value = message
}

async function onOpenFile(path: string) {
  if (!currentProject.value) {
    status.value = '请先创建或打开项目'
    return
  }

  await runTask(async () => {
    activeFile.value = await readProjectFile(currentProject.value!, path)
    status.value = `已打开文件：${path}`
  }, '读取文件失败')
}

async function refreshProjectFiles(preferredPath?: string) {
  if (!currentProject.value) {
    return
  }

  const nextTree = await rescanProject(currentProject.value)
  currentProject.value = {
    ...currentProject.value,
    tree: nextTree,
  }

  const nextPath =
    preferredPath ||
    activeFile.value?.path ||
    findFirstReadableFile(nextTree)

  if (nextPath) {
    // 保存章节后优先打开新文件；否则尽量维持当前预览文件不跳走。
    activeFile.value = await readProjectFile(currentProject.value, nextPath)
  } else {
    activeFile.value = null
  }
}

async function openInitialFile(snapshot: ProjectSnapshot) {
  const firstReadablePath = findFirstReadableFile(snapshot.tree)

  if (!firstReadablePath) {
    activeFile.value = null
    return
  }

  activeFile.value = await readProjectFile(snapshot, firstReadablePath)
}

async function runTask(action: () => Promise<void>, fallback: string) {
  if (!isFileSystemAccessSupported()) {
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

function flattenReadableFiles(tree: TreeNode[]) {
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
      <p>
        目录检查结果：
        {{ inspection ? (inspection.canLoad ? '可直接打开' : inspection.issues.join('、')) : '还未选择目录' }}
      </p>
      <button type="button" :disabled="isBusy" @click="onCreateProject">创建小说</button>
      <button type="button" :disabled="isBusy" @click="onOpenProject">打开小说</button>
      <button type="button" :disabled="isBusy || !canRepair" @click="onRepairProject">修复项目结构</button>
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
      <button type="button" :disabled="isBusy || !currentProject" @click="onSaveConfig">保存配置</button>
      <pre>{{ configPreview }}</pre>
    </section>

    <section>
      <h2>连接测试</h2>
      <p>{{ connectionStatus }}</p>
      <button type="button" @click="onTestLlm">测试 LLM</button>
      <button type="button" @click="onTestEmbedding">测试 Embedding</button>
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
