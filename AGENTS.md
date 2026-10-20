# AGENTS.md

## 目标定位

NovAI 的目标是演进为一个智能体化（agentic）的小说创作工具，交互模型更接近 Vibe Coding 工具，而非传统聊天应用。

核心循环应该是：

1. 用户用自然语言表达意图。
2. AI 维护任务上下文。
3. AI 使用工具读写项目文件。
4. 故事产物保存在本地项目文件系统中。
5. 对话充当协作界面，而不是故事内容的主要存储位置。

## 产品方向

做实现决策时，优先采用以下框架：

- 聊天 UI 是智能体的控制面。
- AI 应该操作文件，而不是主要往聊天流里输出长篇最终文本。
- 章节、提示词和要素都应该放在文件里。
- 对话历史用于协作、澄清、规划和行动摘要。
- 生成的故事内容应在文件/内容面板中预览，并写回项目。

这意味着 NovAI 应该逐步从简单的「单提示词 -> 单响应」流程，转向由工具驱动的智能体工作流来创作和修改故事。

## 仓库结构

pnpm monorepo（`packageManager` 固定为 pnpm@10.21.0，workspace glob 为 `packages/*`）：

- `packages/core`（`@novai/core`）—— 与框架无关的引擎，直接以 TypeScript 源码形式被消费（其 `exports` 指向 `src/`，无构建步骤）。关键区域：Agent 循环（`src/core/agent`）、工具系统（`src/core/tools`）、LLM/embedding 客户端（`src/core/llm`、`src/core/embedding`）、RAG（`src/core/rag`，基于 Orama 构建）、要素（`src/core/elements`），以及服务层（`src/services/` —— agent-service、completion-service、file-service、project-runtime、project-service、rag-service、settings-service）。
- `packages/app`（`@novai/app`）—— Vue 3 + Pinia + vue-router + Tailwind CSS 4 前端。聊天输入框是 Lexical 富文本编辑器（计划见 `docs/plans/输入框富文本化施工计划.md`）—— 优先扩展其现有的 node/decorator 体系，而不是临时摆弄 `contenteditable`。store 在 `src/stores`，视图在 `src/views`，组件按领域分组（`chat`、`settings`、`rag`、`file-tree`、`category`、`layout`、`ui`）。
- `docs/` —— 存放文档中心的 git 子模块（见下方「文档地图」）。
- 根目录还有 `CLAUDE.md`、`CONTRIBUTING.md`、`INTERFACE.md`、`folder-alias.json` / `private-folder-alias.json`。

## 常用命令

在仓库根目录运行：

- `pnpm dev` —— `@novai/app` 的 Vite 开发服务器（用户自己常驻一个在 http://localhost:5173；永远不要再起一个 —— 见「本地开发环境」）。
- `pnpm test` —— 全 workspace 跑 `vitest run`。测试以 `*.test.ts` 形式与源码同目录，位于 `packages/**/src/**` 下（include 规则见根目录 `vitest.config.ts`）。
- `pnpm typecheck` —— 全项目 `tsc --build`。按包单独跑：`pnpm --filter @novai/app typecheck`（vue-tsc）、`pnpm --filter @novai/core typecheck`。
- `pnpm build` —— app 的 vue-tsc + vite build。
- 跑单个测试文件：`pnpm exec vitest run <路径>`（例如 `pnpm exec vitest run packages/core/src/services/agent-service.session-cache.test.ts`）。
- 未配置 lint/format 脚本；commitlint + husky 只在提交时运行。

## 架构边界

- `@novai/core` 必须保持 UI 无关：不许引入 Vue、DOM、store。它只暴露根入口、`./services/*` 和 `./types/*` 子路径（见 `packages/core/package.json`）。
- `@novai/app` 只能通过该服务层访问 core；UI↔core 契约见 `docs/architecture/UI协作接口契约设计.md`。
- 本 app 是纯浏览器/Vue SPA（没有 Electron/Tauri 壳）。所有对项目文件的访问都经过 core 的 fs/project 服务 —— 绝不要在 UI 层直接读写用户的小说项目，也不要在 app 代码里使用 Node fs。
- Agent Loop 的术语和结构以 DeepSeek Harness 为参照（决策 `docs/decisions/0005`）：compaction、spill、scope permissions、turn/step loop、StreamChunk。

## 参考仓库

为实现参照和对比研究，在 NovAI 仓库旁边保留这个外部仓库：

- `/Users/honlnk/project/deepseek-harness`

该仓库刻意克隆在 NovAI git 仓库之外，以便：

- 不影响 NovAI 的 git status；
- 不会被误提交；
- 开发时仍可直接阅读和对比。

它是 Agent Loop 内部机制的现行参照（决策 `0005`）：compaction、spill、scope permissions、turn/step loop、StreamChunk。

## 文档地图

`docs/`（git 子模块）按 `product/` / `architecture/` / `decisions/` / `plans/` / `project/` / `archive/` 组织 —— 完整索引和阅读顺序从 `docs/README.md` 开始。要点：

- 当前进度在 `docs/project/当前进度.md`；工作落地时同步更新（长任务阶段门禁要求文档同步）。
- 已敲定的取舍放入 `docs/decisions/`；进行中的施工计划和波次门禁（W0–W6）在 `docs/plans/` —— 改动某个计划覆盖的区域之前，先读对应计划。
- 一些旧文档顶部带实现状态警告；对过时章节，以代码为准（见「工作准则」）。

## 本地开发环境

本机开发环境的既有事实。启动任何服务器或做浏览器/UI 验证之前，先查这里：

- 用户常驻一个开发服务器在 **http://localhost:5173**（他们自己的 `pnpm dev`）。做浏览器/UI 验证时直接打开这个 URL。**永远不要再起一个开发服务器或编造别的端口** —— 浏览器标签页指向一个死端口（例如旧会话残留的 5199）时只会显示空白页，那不是应用坏了的证据。
- 如果页面看起来空白或异常，先检查预期端口上有没有服务在监听（例如 `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/`），再动其他东西。
- 常驻测试项目位于 **`~/note/test-novel`**，其 `novel.config.json` 里已配置好模型。真机/UI 验证用它（通过「打开项目」或「恢复项目」打开）。它的 API key 只在运行时读取，绝不能复制进本仓库的任何文件。

## 工作准则

当文档与代码看似冲突时，以上面澄清后的产品意图为准：

- NovAI 不只是一个带聊天框的工作区。
- NovAI 应该成为一个由对话驱动、通过工具和文件来写故事的 AI 智能体。

## 指令文件

本仓库带两份内容刻意重叠的 AI 指令文件：

- `AGENTS.md`（本文件）—— 权威的工作区指令。
- `CLAUDE.md` —— 给 Claude Code 的指引；部分内容与本文件重复，另附单测命令示例。

改其中一个时，检查同一事实是否也出现在另一个里，保持两者一致。两者都是「先问再改」文件（见「工作流纪律」§3）。

## 工作流纪律

以下规则约束 AI 智能体在本仓库中的 git 操作，没有商量余地。

### 0. 提交信息格式（commitlint + husky 强制）

`type(scope): 中文说明` —— 例如 `feat(view): 完成首页布局`。允许的 type：feat / fix / docs / refactor / test / chore / build / ci / perf / style / revert。scope 建议见 `CONTRIBUTING.md`。

### 1. 只有用户批准才能提交 —— 长任务的分阶段提交除外

**默认（小改动）：** 写完代码后**不要**执行 `git commit`。写代码、跑验证（`pnpm test` / `pnpm typecheck`），然后**停下**。汇报做了什么，交给用户审查。只有当用户明确说提交时才提交（例如「提交一下」「commit it」）。如果改动横跨多个逻辑单元，先提出提交分组方案，让用户确认。

**长任务例外：** 当任务是大规模、分阶段的（多个步骤/波次、影响面大）时，期望分阶段提交，而不是最后攒一个巨型提交。智能体应该：

- 在开始时（或任务变成长任务时）提前宣布分阶段提交计划；
- 只在每个完成的阶段门禁处提交 —— 门禁 = 测试 + typecheck 全绿 + 文档已同步；绝不提交阶段中途的半成品；
- 保持每个逻辑单元一个提交，每落地一个就汇报对应 hash。

当提交涉及 `docs` 子模块时，先提交子模块，再推进父仓库指针。

### 2. 永不 push —— 那是用户的事

- 不要主动执行 `git push`，也不要就 push 一事提醒用户（不要来一句「需要我 push 吗？」）。只需说明本地提交状态，然后停下。

### 3. 未经许可不要改动共享/全局项目文件

影响面大的文件需要先停下来问再改。适用于：

- 工作区级配置：`tsconfig.json`、`vitest.config.ts`、`commitlint.config.mjs`、`pnpm-workspace.yaml`、根 `package.json` 的 scripts
- 应用骨架：router、`stores/index.ts`、`components/ui/**`、全局 CSS / Tailwind 入口、`App.vue` / `main.ts`
- 指令文件本身：`AGENTS.md`、`CLAUDE.md`

规则：拿不准一个文件算不算「共享/全局」时，按共享处理，先问。
