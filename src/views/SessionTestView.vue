<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

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
} from '../core/fs/project-fs'
import { runChatTurn } from '../core/chat/session'
import { useChatStore } from '../stores/chat'

import type { ProjectConfig, ProjectFileContent, ProjectInspection, ProjectSnapshot, TreeNode } from '../types/project'

const projectName = ref('我的测试小说')
const currentProject = ref<ProjectSnapshot | null>(null)
const pendingHandle = ref<FileSystemDirectoryHandle | null>(null)
const inspection = ref<ProjectInspection | null>(null)
const activeFile = ref<ProjectFileContent | null>(null)
const status = ref('这里用于验证第一阶段会话引擎。')
const instruction = ref('把这一章结尾改得更紧张一点，并保持悬疑感。')
const systemPrompt = ref('你是一名长篇小说写作助手，输出中文 Markdown。')
const isBusy = ref(false)
const chatStore = useChatStore()

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

const projectLabel = computed(() => currentProject.value?.rootName ?? inspection.value?.rootName ?? '未选择项目')
const canRepair = computed(() => pendingHandle.value && inspection.value && !inspection.value.canLoad)
const groupedReadableFiles = computed(() => groupReadableFiles(flattenReadableFiles(currentProject.value?.tree ?? [])))
const currentTargetLabel = computed(() => {
  if (!chatStore.currentTarget) {
    return '未推导'
  }

  const target = chatStore.currentTarget
  return target.primaryPath ? `${target.displayName} (${target.primaryPath})` : target.displayName
})
const toolMessages = computed(() =>
  (chatStore.session?.messages ?? []).filter(
    (message) => message.kind === 'tool-call' || message.kind === 'tool-result',
  ),
)
const errorMessages = computed(() =>
  (chatStore.session?.messages ?? []).filter((message) => message.kind === 'error'),
)
const contextMessages = computed(() =>
  (chatStore.session?.messages ?? []).filter((message) => message.kind === 'context-summary'),
)

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
  if (!pendingHandle.value) {
    status.value = '请先选择一个目录'
    return
  }

  await runTask(async () => {
    const snapshot = await repairProject(pendingHandle.value!)
    await activateProject(snapshot, `已修复并打开项目「${snapshot.name}」`)
  }, '修复项目失败')
}

async function onOpenFile(path: string) {
  if (!currentProject.value) {
    status.value = '请先创建或打开项目'
    return
  }

  await runTask(async () => {
    activeFile.value = await readProjectFile(currentProject.value!, path)
    chatStore.syncDefaultTarget(currentProject.value!.id, activeFile.value?.path)
    status.value = `已打开文件：${path}`
  }, '打开文件失败')
}

async function onRunTurn() {
  if (!currentProject.value) {
    chatStore.setRunStatus('请先创建或打开项目')
    return
  }

  if (!instruction.value.trim()) {
    chatStore.setRunStatus('请先输入本轮用户意图')
    return
  }

  await runTask(async () => {
    chatStore.setRunStatus('正在执行本轮 Agent...')

    const currentSession = chatStore.ensureSession(currentProject.value!.id)
    const result = await runChatTurn({
      session: currentSession,
      input: {
        instruction: instruction.value.trim(),
        project: currentProject.value!,
        config: configDraft,
        systemPrompt: systemPrompt.value,
        activeFilePath: activeFile.value?.path,
      },
    })

    chatStore.setSession(result.session)
    chatStore.setRunStatus(
      result.writtenPath
        ? `本轮执行完成，已写回 ${result.writtenPath}`
        : '本轮执行完成，未修改任何文件',
    )
    await refreshProjectFiles(result.writtenPath)
  }, '执行会话失败')
}

async function activateProject(snapshot: ProjectSnapshot, message: string) {
  currentProject.value = snapshot
  pendingHandle.value = snapshot.handle
  inspection.value = await inspectProject(snapshot.handle)
  applyConfigDraft(snapshot.config)
  systemPrompt.value = await readSystemPrompt(snapshot.handle)
  chatStore.resetSession(snapshot.id)
  await openInitialFile(snapshot)
  chatStore.syncDefaultTarget(snapshot.id, activeFile.value?.path)
  status.value = message
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

  const nextPath = preferredPath || activeFile.value?.path || findFirstReadableFile(nextTree)
  if (nextPath) {
    activeFile.value = await readProjectFile(currentProject.value, nextPath)
    chatStore.syncDefaultTarget(currentProject.value.id, activeFile.value?.path)
  }
}

async function openInitialFile(snapshot: ProjectSnapshot) {
  const firstReadablePath = findFirstReadableFile(snapshot.tree)

  if (!firstReadablePath) {
    activeFile.value = null
    chatStore.syncDefaultTarget(snapshot.id, null)
    return
  }

  activeFile.value = await readProjectFile(snapshot, firstReadablePath)
  chatStore.syncDefaultTarget(snapshot.id, activeFile.value?.path)
}

function applyConfigDraft(config: ProjectConfig) {
  configDraft.version = config.version
  configDraft.project = { ...config.project }
  configDraft.llm = { ...config.llm }
  configDraft.embedding = { ...config.embedding }
  configDraft.rerank = { ...config.rerank }
  configDraft.settings = { ...config.settings }
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
    const message = error instanceof Error ? error.message : fallback
    status.value = message
    chatStore.setRunStatus(message)
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
    <h1>NovAI Session Lab</h1>
    <p>第一阶段会话引擎测试页，先验证 Agent Loop，不追求正式视觉稿。</p>
    <p>当前项目：{{ projectLabel }}</p>
    <p>状态：{{ status }}</p>

    <div>
      <label>
        <span>项目名称</span>
        <input v-model="projectName" type="text" />
      </label>
      <button :disabled="isBusy" @click="onCreateProject">创建项目</button>
      <button :disabled="isBusy" @click="onOpenProject">打开项目</button>
      <button v-if="canRepair" :disabled="isBusy" @click="onRepairProject">修复项目结构</button>
    </div>

    <table width="100%">
      <tbody>
        <tr>
          <td width="25%" valign="top">
            <h2>项目文件</h2>
            <div v-for="group in groupedReadableFiles" :key="group.groupName">
              <h3>{{ group.groupName }}</h3>
              <div v-for="item in group.items" :key="item.path">
                <button @click="onOpenFile(item.path)">
                  {{ activeFile?.path === item.path ? '当前: ' : '' }}{{ item.path }}
                </button>
              </div>
            </div>
          </td>

          <td width="45%" valign="top">
            <h2>会话区</h2>
            <div>
              <div v-if="(chatStore.session?.messages?.length ?? 0) === 0">
                <p>还没有会话消息。</p>
              </div>

              <article
                v-for="message in chatStore.session?.messages ?? []"
                :key="message.id"
              >
                <strong>{{ message.role }} / {{ message.kind }}</strong>
                <p v-if="message.kind === 'text'">{{ message.text }}</p>
                <p v-else-if="message.kind === 'action-summary'">{{ message.summary }}</p>
                <p v-else-if="message.kind === 'tool-call'">{{ message.toolName }}: {{ message.inputSummary }}</p>
                <p v-else-if="message.kind === 'tool-result'">{{ message.toolName }}: {{ message.resultSummary }}</p>
                <p v-else-if="message.kind === 'context-summary'">{{ message.summary }}</p>
                <p v-else>{{ message.message }}</p>
              </article>
            </div>

            <hr />

            <div>
              <p>{{ chatStore.runStatus }}</p>
              <label>
                <span>用户意图</span>
                <textarea v-model="instruction" rows="6" cols="60" />
              </label>
              <div>
                <button :disabled="isBusy" @click="onRunTurn">运行一轮</button>
              </div>
            </div>
          </td>

          <td width="30%" valign="top">
            <h2>本轮状态</h2>
            <p>默认目标：{{ currentTargetLabel }}</p>
            <p>会话状态：{{ chatStore.session?.status ?? 'idle' }}</p>
            <p>任务类型：{{ chatStore.session?.lastTaskType ?? '未判定' }}</p>
            <p>最近写回：{{ chatStore.session?.lastWrittenPath ?? '暂无' }}</p>
            <p>RAG 候选：{{ chatStore.session?.lastRagResult?.total ?? 0 }}</p>

            <h3>上下文摘要</h3>
            <div v-if="contextMessages.length === 0">
              <p>当前还没有上下文摘要。</p>
            </div>
            <ul v-else>
              <li v-for="message in contextMessages" :key="message.id">
                [{{ message.createdAt }}] {{ message.summary }}
              </li>
            </ul>

            <h3>工具轨迹</h3>
            <div v-if="toolMessages.length === 0">
              <p>当前还没有工具调用记录。</p>
            </div>
            <ul v-else>
              <li v-for="message in toolMessages" :key="message.id">
                <span v-if="message.kind === 'tool-call'">
                  [{{ message.createdAt }}] CALL {{ message.toolName }} -> {{ message.inputSummary }}
                </span>
                <span v-else>
                  [{{ message.createdAt }}] RESULT {{ message.toolName }} -> {{ message.resultSummary }}
                </span>
              </li>
            </ul>

            <h3>错误</h3>
            <div v-if="errorMessages.length === 0">
              <p>当前没有错误消息。</p>
            </div>
            <ul v-else>
              <li v-for="message in errorMessages" :key="message.id">
                [{{ message.createdAt }}] {{ message.message }}
              </li>
            </ul>

            <h3>当前草稿</h3>
            <pre>{{ chatStore.session?.currentDraftText || '本轮还没有生成内容' }}</pre>

            <h3>当前文件预览</h3>
            <pre>{{ activeFile?.content || '请先打开一个文件' }}</pre>
          </td>
        </tr>
      </tbody>
    </table>
  </main>
</template>
