<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { useChatStore } from '../stores/chat'
import { useProjectStore } from '../stores/project'
import { useSettingsStore } from '../stores/settings'

import type { ChangedFileView, ProjectFileNodeView } from '../services/types'

const projectName = ref('我的测试小说')
const status = ref('这里用于验证第一阶段会话引擎。')
const instruction = ref('把这一章结尾改得更紧张一点，并保持悬疑感。')
const isBusy = ref(false)
const chatStore = useChatStore()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()

const currentProject = computed(() => projectStore.currentProject)
const activeFile = computed(() => projectStore.activeFile)
const lastProjectSummary = computed(() => projectStore.lastProjectSummary)
const projectLabel = computed(() => currentProject.value?.rootName ?? '未选择项目')
const canRestoreLastProject = computed(() => Boolean(lastProjectSummary.value && !currentProject.value))
const groupedReadableFiles = computed(() => groupReadableFiles(flattenReadableFiles(currentProject.value?.files ?? [])))
const currentTargetLabel = computed(() => {
  if (!chatStore.currentTarget) {
    return '未推导'
  }

  const target = chatStore.currentTarget
  return target.primaryPath ? `${target.displayName} (${target.primaryPath})` : target.displayName
})
const toolMessages = computed(() =>
  (chatStore.sessionView?.messages ?? []).filter(
    (message) => message.kind === 'tool-call' || message.kind === 'tool-result',
  ),
)
const errorMessages = computed(() =>
  (chatStore.sessionView?.messages ?? []).filter((message) => message.kind === 'error'),
)
const contextMessages = computed(() =>
  (chatStore.sessionView?.messages ?? []).filter((message) => message.kind === 'context-summary'),
)
const agentMessageCount = computed(() => chatStore.agentEvents.length)
const toolCallCount = computed(() =>
  (chatStore.sessionView?.messages ?? []).filter((message) => message.kind === 'tool-call').length,
)
const toolResultCount = computed(() =>
  (chatStore.sessionView?.messages ?? []).filter((message) => message.kind === 'tool-result').length,
)

onMounted(() => {
  void initializeLastProject()
})

async function initializeLastProject() {
  if (!projectStore.isFileSystemSupported) {
    return
  }

  const summary = await projectStore.loadLastProjectSummary()

  if (summary) {
    status.value = `检测到上次项目「${summary.name}」，可点击“恢复上次项目”继续。`
  }
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

async function onRestoreLastProject() {
  await runTask(async () => {
    const project = await projectStore.restoreLastOpenedProject()

    if (project) {
      await activateProjectView(`已恢复上次项目「${project.name}」`)
    }
  }, '恢复上次项目失败')
}

async function onForgetLastProject() {
  await runTask(async () => {
    await projectStore.forgetLastOpenedProject()
    status.value = '已忘记上次项目记录'
  }, '忘记上次项目失败')
}

async function onOpenFile(path: string) {
  if (!currentProject.value) {
    status.value = '请先创建或打开项目'
    return
  }

  await runTask(async () => {
    await projectStore.openFile(path)
    chatStore.syncDefaultTarget(currentProject.value!.id, activeFile.value?.path)
    status.value = `已打开文件：${path}`
  }, '打开文件失败')
}

async function onCloseProject() {
  const project = currentProject.value

  if (!project) {
    status.value = '当前没有打开的项目'
    return
  }

  await runTask(async () => {
    await projectStore.closeCurrentProject()
    chatStore.resetSession()
    settingsStore.resetSettings()
    status.value = `已关闭项目「${project.name}」`
  }, '关闭项目失败')
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

    const result = await chatStore.runServiceTurn({
      projectId: currentProject.value!.id,
      instruction: instruction.value.trim(),
      activeFilePath: activeFile.value?.path,
    })
    await refreshProjectFiles(resolvePreferredPath(result.changedFiles))
  }, '执行会话失败')
}

async function refreshProjectFiles(preferredPath?: string) {
  if (!currentProject.value) {
    return
  }

  await projectStore.refreshTree()

  const nextPath = preferredPath || activeFile.value?.path || findFirstReadableFile(currentProject.value.files)
  if (nextPath) {
    await projectStore.openFile(nextPath)
    chatStore.syncDefaultTarget(currentProject.value.id, activeFile.value?.path)
  }
}

async function activateProjectView(message: string) {
  const project = currentProject.value

  if (!project) {
    return
  }

  if (!activeFile.value && project.activeFilePath) {
    await projectStore.openFile(project.activeFilePath)
  }

  await settingsStore.loadSettings(project.id)
  chatStore.resetSession(project.id)
  chatStore.syncDefaultTarget(project.id, activeFile.value?.path)
  status.value = message
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
    const message = error instanceof Error ? error.message : fallback
    status.value = message
    chatStore.setRunStatus(message)
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

function resolvePreferredPath(changes: ChangedFileView[]) {
  const lastChange = changes[changes.length - 1]

  if (!lastChange) {
    return undefined
  }

  if (lastChange.type === 'created' || lastChange.type === 'updated') {
    return lastChange.path
  }

  if (lastChange.type === 'renamed') {
    return lastChange.toPath
  }

  return undefined
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
      <button :disabled="isBusy || !currentProject" @click="onCloseProject">关闭项目</button>
      <button :disabled="isBusy || !canRestoreLastProject" @click="onRestoreLastProject">恢复上次项目</button>
      <button :disabled="isBusy || !lastProjectSummary" @click="onForgetLastProject">忘记上次项目</button>
    </div>

    <p v-if="lastProjectSummary">
      上次项目：{{ lastProjectSummary.name }}（{{ lastProjectSummary.rootName }}）
    </p>

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
              <div v-if="(chatStore.sessionView?.messages?.length ?? 0) === 0">
                <p>还没有会话消息。</p>
              </div>

              <article
                v-for="message in chatStore.sessionView?.messages ?? []"
                :key="message.id"
              >
                <strong>{{ message.role }} / {{ message.kind }}</strong>
                <p v-if="message.kind === 'text'">{{ message.text }}</p>
                <p v-else-if="message.kind === 'action-summary'">{{ message.text }}</p>
                <p v-else-if="message.kind === 'tool-call'">{{ message.toolName }}: {{ message.text }}</p>
                <p v-else-if="message.kind === 'tool-result'">{{ message.toolName }}: {{ message.text }}</p>
                <p v-else-if="message.kind === 'context-summary'">{{ message.text }}</p>
                <p v-else>{{ message.text }}</p>
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
                <button :disabled="isBusy" @click="onRunTurn">发送给 Agent</button>
              </div>
            </div>
          </td>

          <td width="30%" valign="top">
            <h2>Agent 状态</h2>
            <p>默认目标：{{ currentTargetLabel }}</p>
            <p>会话状态：{{ chatStore.sessionView?.status ?? 'idle' }}</p>
            <p>Agent 消息：{{ agentMessageCount }}</p>
            <p>工具调用：{{ toolCallCount }}</p>
            <p>工具结果：{{ toolResultCount }}</p>
            <p>最近变更：{{ chatStore.changedFiles.length > 0 ? `${chatStore.changedFiles.length} 个文件` : '暂无' }}</p>

            <h3>上下文摘要</h3>
            <div v-if="contextMessages.length === 0">
              <p>当前还没有上下文摘要。</p>
            </div>
            <ul v-else>
              <li v-for="message in contextMessages" :key="message.id">
                [{{ message.createdAt }}] {{ message.text }}
              </li>
            </ul>

            <h3>工具轨迹</h3>
            <div v-if="toolMessages.length === 0">
              <p>当前还没有工具调用记录。</p>
            </div>
            <ul v-else>
              <li v-for="message in toolMessages" :key="message.id">
                <span v-if="message.kind === 'tool-call'">
                  [{{ message.createdAt }}] CALL {{ 'toolName' in message ? message.toolName : '' }} -> {{ message.text }}
                </span>
                <span v-else>
                  [{{ message.createdAt }}] RESULT {{ 'toolName' in message ? message.toolName : '' }} -> {{ message.text }}
                </span>
              </li>
            </ul>

            <h3>错误</h3>
            <div v-if="errorMessages.length === 0">
              <p>当前没有错误消息。</p>
            </div>
            <ul v-else>
              <li v-for="message in errorMessages" :key="message.id">
                [{{ message.createdAt }}] {{ message.text }}
              </li>
            </ul>

            <h3>模型流式输出</h3>
            <pre>{{ chatStore.sessionView?.currentDraftText || '本轮还没有模型输出' }}</pre>

            <h3>当前文件预览</h3>
            <pre>{{ activeFile?.content || '请先打开一个文件' }}</pre>
          </td>
        </tr>
      </tbody>
    </table>
  </main>
</template>
