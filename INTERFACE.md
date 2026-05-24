# NovAI UI 接口说明

最后更新：2026-05-01

本文档说明当前 NovAI 代码中 UI 层应如何使用项目能力。它面向前端协作者，重点回答三个问题：

- UI 应该依赖哪些入口？
- 当前有哪些可用接口？
- 哪些接口还只是第一版，需要后续继续收敛？

## 当前结论

当前重构已经可以作为第一版 UI 协作接口使用。

约定如下：

- UI 页面优先使用 `src/stores/*`。
- Store 通过 `src/services/*` 调用 core 能力。
- 页面和组件不要直接 import `src/core/*`。
- UI 不直接持有 `FileSystemDirectoryHandle` 或 `ProjectSnapshot`。
- 项目、文件、会话、Agent 事件都通过 `src/services/types.ts` 中的 view type 暴露。

当前已经完成迁移验证：

- `src/views/SessionTestView.vue`
- `src/views/TestLabView.vue`

## 推荐调用路径

常规 UI 使用：

```txt
Vue Component
-> Pinia Store
-> Service
-> Core
```

调试页或底层验证可以直接使用 service：

```txt
Vue Component
-> Service
-> Core
```

正式 UI 建议优先从这三个 store 开始：

```ts
import { useProjectStore } from '../stores/project'
import { useSettingsStore } from '../stores/settings'
import { useChatStore } from '../stores/chat'
```

## Store 入口

### `useProjectStore`

负责项目和文件预览状态。

常用状态：

```ts
currentProject
activeFile
lastProjectSummary
isBusy
errorMessage
statusMessage
isFileSystemSupported
```

常用动作：

```ts
createNewProject(projectName)
openExistingProject()
restoreLastOpenedProject()
loadLastProjectSummary()
forgetLastOpenedProject()
closeCurrentProject()
openFile(path)
refreshTree()
updateCurrentProjectConfig(config)
```

### `useSettingsStore`

负责配置、系统提示词和模型连接测试。

常用状态：

```ts
config
systemPrompt
lastConnectionTest
isBusy
errorMessage
statusMessage
```

常用动作：

```ts
loadSettings(projectId)
saveConfig(projectId, patch)
saveSystemPrompt(projectId, content)
testLlmConfig(config)
testEmbeddingConfig(config)
testRerankConfig(config)
resetSettings()
```

### `useChatStore`

负责 Agent 会话展示、运行状态、工具轨迹和文件变更。

常用状态：

```ts
sessionView
agentEvents
changedFiles
runStatus
currentTarget
defaultTarget
```

常用动作：

```ts
ensureSessionView(projectId)
runServiceTurn(input)
syncDefaultTarget(projectId, activeFilePath)
resetSession(projectId?)
setRunStatus(status)
```

发送一轮 Agent 指令：

```ts
const result = await chatStore.runServiceTurn({
  projectId,
  instruction,
  activeFilePath,
})
```

## Service 入口

所有 service 都在 `src/services/` 下。

| 文件 | 职责 |
|:-----|:-----|
| `project-service.ts` | 项目创建、打开、恢复、关闭、刷新、检查 |
| `file-service.ts` | 文件树、文件读取、章节写入、刷新 |
| `settings-service.ts` | 配置读写、system prompt、模型连接测试 |
| `agent-service.ts` | Agent 会话、运行一轮指令、事件映射 |
| `generation-service.ts` | 流式生成调试接口 |
| `rag-service.ts` | 索引状态、索引重建、RAG 调试 |
| `element-service.ts` | 要素提取预览 |
| `project-runtime.ts` | service 内部运行时项目注册表 |
| `mappers.ts` | core 内部结构到 UI view type 的映射 |
| `types.ts` | UI 协作接口类型 |

常规 UI 不需要直接使用 `project-runtime.ts` 或 `mappers.ts`。

## 核心 View Type

核心接口类型统一放在：

```txt
src/services/types.ts
```

常用类型：

```ts
ProjectView
ProjectFileNodeView
ProjectConfigView
ProjectConfigPatch
FileContentView
ChatSessionView
ChatMessageView
AgentUiEvent
ChangedFileView
RunAgentTurnInput
RunAgentTurnResult
NovAiError
```

### 文件变更

当前 Agent 运行结果中的文件变更统一使用：

```ts
type ChangedFileView =
  | { type: 'created'; path: string }
  | { type: 'updated'; path: string }
  | { type: 'renamed'; fromPath: string; toPath: string }
  | { type: 'deleted'; path: string; trashPath?: string }
```

注意：当前 `changedFiles` 仍由 `agent-service` 根据工具调用和工具结果文本保守推导。后续应改为由 core 工具层直接返回结构化变更结果。

## Agent 事件

Agent 运行时会通过 `AgentUiEvent` 向 UI 回传事件：

```ts
type AgentUiEvent =
  | { type: 'run-start'; runId: string; sessionId: string }
  | { type: 'message'; message: ChatMessageView }
  | { type: 'assistant-delta'; text: string; fullText: string }
  | { type: 'model-start'; step: number }
  | { type: 'model-finish'; step: number; toolCallCount: number; finishReason?: string }
  | { type: 'tool-call'; toolCall: ToolCallView }
  | { type: 'tool-result'; toolResult: ToolResultView }
  | { type: 'file-changed'; file: ChangedFileView }
  | { type: 'confirmation-required'; request: FileChangeConfirmationView }
  | { type: 'run-error'; error: NovAiError }
  | { type: 'run-finish'; result: RunAgentTurnResult }
```

当前已可用于展示：

- 用户消息
- 上下文摘要
- assistant 流式输出
- 工具调用记录
- 工具结果记录
- 文件变更
- 运行完成 / 运行错误

当前预留但尚未完整落地：

- `confirmation-required`
- `model-start`
- `model-finish`
- `stopRun`

## 项目打开流程

推荐 UI 流程：

```ts
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()
const chatStore = useChatStore()

const project = await projectStore.openExistingProject()

if (project) {
  await settingsStore.loadSettings(project.id)
  chatStore.resetSession(project.id)
  chatStore.syncDefaultTarget(project.id, projectStore.activeFile?.path)
}
```

说明：

- `openExistingProject()` 内部会选择目录并打开项目。
- 当前打开项目时会温和补齐默认结构。
- UI 不需要直接调用 `repairProject()`。

## 文件预览流程

```ts
await projectStore.openFile(path)
chatStore.syncDefaultTarget(project.id, projectStore.activeFile?.path)
```

文件路径统一使用项目内相对路径，例如：

```txt
chapters/chapter-001.md
prompts/system.md
elements/characters/foo.md
```

## Agent 执行后刷新文件

推荐在 Agent 执行完成后根据 `changedFiles` 刷新文件树：

```ts
const result = await chatStore.runServiceTurn({
  projectId,
  instruction,
  activeFilePath,
})

await projectStore.refreshTree()
```

如果需要打开最近变更文件，按如下规则取路径：

```ts
function resolvePreferredPath(changes: ChangedFileView[]) {
  const lastChange = changes[changes.length - 1]

  if (!lastChange) return undefined
  if (lastChange.type === 'created' || lastChange.type === 'updated') return lastChange.path
  if (lastChange.type === 'renamed') return lastChange.toPath
  return undefined
}
```

## 当前限制

这套接口已经可以开始 UI 协作，但仍是第一版：

- Agent 停止运行尚未实现。
- 写工具执行前确认尚未实现。
- 文件 diff 预览尚未实现。
- `changedFiles` 仍是 service 层推导，不是工具层结构化输出。
- Agent 会话还没有持久化。
- RAG 调试接口已存在，但 `RagSearch` 尚未作为正式 Agent 工具接入。
- 要素提取当前仍是预览/占位能力。

## 协作规则

为了减少多人协作冲突，建议遵守：

- UI 页面只依赖 stores 和 services。
- 新 UI 组件不要直接 import `src/core/*`。
- 新增 UI 需要的数据，优先扩展 `services/types.ts` 和 mapper。
- core 内部结构变化时，尽量只修改 service / mapper，不让页面跟着改。
- 如果需要新增业务动作，优先新增 service，再由 store 适配 UI 状态。

更详细的设计记录见：

```txt
docs/UI协作接口契约设计.md
```
