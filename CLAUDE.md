# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NovAI 是一个面向长篇小说创作的 AI 工作站。核心理念：一个文件夹就是一个小说项目，AI 通过文件工具（而非聊天流）操作章节和素材。产品定位更接近 Claude Code / Vibe Coding 的 Agent 交互模型，而非传统聊天应用。

## Commands

```bash
pnpm dev          # 启动开发服务器 (Vite)
pnpm build        # 类型检查 + 构建 (vue-tsc --noEmit && vite build)
pnpm test         # 运行所有测试 (vitest run)
pnpm typecheck    # TypeScript 类型检查 (tsc --build)
```

运行单个测试文件：
```bash
pnpm exec vitest run packages/core/src/core/tools/file-tools/file-tools.test.ts
```

## Architecture

pnpm monorepo，两个包，三层架构：

```
packages/app   @novai/app   → Vue 3 前端 (Vite + Pinia + Vue Router + Tailwind CSS 4)
packages/core  @novai/core  → 业务逻辑层（无框架依赖，纯 TypeScript）
```

**数据流：** `Vue Component → Pinia Store → Service → Core Domain`

- **app/src/stores/** — 三个 Pinia store：`project`（项目/文件状态）、`chat`（Agent 会话/事件流）、`settings`（配置/模型）
- **core/src/services/** — Service 层桥接 core 类型和 UI 视图类型，管理内存中的项目运行时注册表
- **core/src/core/agent/** — Agent 循环：组装消息 → LLM 流式调用 → 解析 tool_calls → 执行工具 → 循环（最多 8 轮）
- **core/src/core/tools/** — 7 个文件工具（ReadFile/EditFile/CreateFile/RenameFile/DeleteFile/ListDirectory/FindFiles），全部基于浏览器 File System Access API
- **core/src/core/rag/** — RAG 管线（规划中/部分实现）

## Key Patterns

- **文件工具状态保护：** EditFile 要求先 ReadFile，文件变更后拒绝编辑（防陈旧写入）。测试覆盖了这些场景。
- **API 代理：** Vite dev server 内置 `/api-proxy` 中间件，通过 `x-target-base` header 转发请求到 LLM/Embedding API，解决浏览器 CORS 限制。
- **@novai/core 无构建步骤：** app 直接通过源码导入 core（见 core/package.json exports map），不需要先构建 core。
- **Agent 事件流：** AgentService 发出 `AgentUiEvent` 流供 UI 消费，实现流式响应展示。

## Commit Convention

格式：`type(scope): 中文说明`

- scope 必填，限定值：`app`, `build`, `ci`, `config`, `deps`, `docs`, `git`, `layout`, `other`, `project`, `router`, `store`, `style`, `test`, `ui`, `view`
- 说明必须包含中文字符
- 由 husky + commitlint 在 commit-msg 钩子中自动校验
- header 最大 108 字符

## Runtime Requirements

- Node.js 18+, pnpm 10+
- 浏览器需支持 File System Access API（仅 Chromium）
- `docs/` 是 git submodule，指向 NovAI-document 仓库；文档按 `product/`、`architecture/`、`decisions/`、`project/` 分层维护
