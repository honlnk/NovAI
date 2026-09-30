# AGENTS.md

## Purpose

NovAI is intended to evolve toward an agentic novel-writing tool, closer to the interaction model of Vibe Coding tools than to a traditional chat app.

The core loop should be:

1. The user expresses intent in natural language.
2. The AI maintains task context.
3. The AI uses tools to read and write project files.
4. Story artifacts are saved into the local project filesystem.
5. The conversation acts as the collaboration interface, not the primary storage for story content.

## Product Direction

When making implementation decisions, prefer this framing:

- The chat UI is an agent control surface.
- The AI should operate on files, not mainly emit long final text into the chat stream.
- Chapters, prompts, and elements belong in files.
- Conversation history is for collaboration, clarification, planning, and action summaries.
- Generated story content should be previewed in file/content panels and written back to the project.

This means NovAI should gradually move away from a simple "single prompt -> single response" flow and toward a tool-using agent workflow for story creation and revision.

## Repository Layout

pnpm monorepo (`packageManager` pinned to pnpm@10.21.0, workspace globs `packages/*`):

- `packages/core` (`@novai/core`) — framework-agnostic engine, consumed directly as TypeScript source (its `exports` point at `src/`, no build step). Key areas: Agent loop (`src/core/agent`), tool system (`src/core/tools`), LLM/embedding clients (`src/core/llm`, `src/core/embedding`), RAG (`src/core/rag`, built on Orama), and the services layer (`src/services/` — agent-service, file-service, element-service, rag-service, settings-service, project-service, …).
- `packages/app` (`@novai/app`) — Vue 3 + Pinia + vue-router + Tailwind CSS 4 front end. Stores in `src/stores`, views in `src/views`, components grouped by domain (`chat`, `settings`, `rag`, `file-tree`, `category`, `layout`, `ui`).
- `docs/` — git submodule holding the documentation center (see Documentation Map below).
- Root also holds `CLAUDE.md`, `CONTRIBUTING.md`, `INTERFACE.md`, `folder-alias.json` / `private-folder-alias.json`.

## Commands

Run from the repo root:

- `pnpm dev` — Vite dev server for `@novai/app` (the user keeps theirs at http://localhost:5173; never start another — see Local Development Environment).
- `pnpm test` — `vitest run` across the workspace. Tests are co-located as `*.test.ts` next to sources under `packages/**/src/**` (include pattern in root `vitest.config.ts`).
- `pnpm typecheck` — `tsc --build` project-wide. Per-package: `pnpm --filter @novai/app typecheck` (vue-tsc), `pnpm --filter @novai/core typecheck`.
- `pnpm build` — vue-tsc + vite build for the app.

## Architecture Boundaries

- `@novai/core` must stay UI-agnostic: no Vue, no DOM, no store imports. It exposes only the root, `./services/*`, and `./types/*` subpaths (see `packages/core/package.json`).
- `@novai/app` reaches core exclusively through that services layer; the UI↔core contract is specified in `docs/architecture/UI协作接口契约设计.md`.
- Agent Loop terminology and structure follow the DeepSeek Harness reference (decision `docs/decisions/0005`): compaction, spill, scope permissions, turn/step loop, StreamChunk.

## Reference Repository

For implementation reference and comparative study, keep this external repository available next to the NovAI repo:

- `/Users/honlnk/project/deepseek-harness`

This repository is intentionally cloned outside the NovAI git repository so that:

- it does not affect NovAI git status,
- it is not accidentally committed,
- it can still be read and compared during development.

It is the operative reference for Agent Loop internals (decision `0005`): compaction, spill, scope permissions, turn/step loop, StreamChunk.

## Documentation Map

`docs/` (git submodule) is organized as `product/` / `architecture/` / `decisions/` / `plans/` / `project/` / `archive/` — start at `docs/README.md` for the full index and reading order. Key points:

- Current status lives in `docs/project/当前进度.md`; update it as work lands (long-task phase gates require docs synced).
- Settled trade-offs go in `docs/decisions/`; in-flight construction plans and wave gates (W0–W6) live in `docs/plans/` — read the relevant plan before touching an area it covers.
- Several older docs carry an implementation-status warning at the top; trust code over stale sections (see Working Rule).

## Local Development Environment

Standing facts about this machine's dev setup. Check these before starting any server or doing browser/UI verification:

- The user keeps a dev server running at **http://localhost:5173** (their own `pnpm dev`). For browser/UI verification, open this URL directly. **Never start another dev server or invent a different port** — a browser tab pointed at a dead port (e.g. a stale 5199 from an old session) shows a blank page and is not evidence the app is broken.
- If a page looks blank or broken, first check whether anything is listening on the expected port (e.g. `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/`) before touching anything else.
- The standing test project lives at **`~/note/test-novel`**, with models already configured in its `novel.config.json`. Use it for real-machine / UI verification (open it via 「打开项目」or「恢复项目」). Its API keys are read at runtime only and must never be copied into any file in this repository.

## Working Rule

When documentation and code appear to conflict, prefer the clarified product intent above:

- NovAI is not just a workspace with a chat box.
- NovAI should become a conversation-driven AI agent for writing stories through tools and files.

## Workflow Discipline

These rules govern how AI agents interact with git in this repository. They are non-negotiable.

### 0. Commit message format (enforced by commitlint + husky)

`type(scope): 中文说明` — e.g. `feat(view): 完成首页布局`. Allowed types: feat / fix / docs / refactor / test / chore / build / ci / perf / style / revert. Scope suggestions are in `CONTRIBUTING.md`.

### 1. Commit only with user approval — except staged commits on long tasks

**Default (small work):** do **not** run `git commit` after finishing code. Write the code, run verification (`pnpm test` / `pnpm typecheck`), and **stop**. Report what was done and let the user review. Commit only when the user explicitly says to commit (e.g. "提交一下", "commit it"). If the change spans multiple logical units, propose the commit grouping and let the user confirm first.

**Long-task exception:** when a task is large-scale and phased (multiple steps/waves, wide blast radius), staged commits are expected rather than one giant commit at the end. The agent should:

- announce the staged-commit plan up front, when starting (or when the task grows into) a long task;
- commit at each completed phase gate only — gate = tests + typecheck green + docs synced; never commit work-in-progress mid-phase;
- keep one commit per logical unit, and report every hash as it lands.

When a commit touches the `docs` submodule, commit the submodule first, then advance the parent-repo pointer.

### 2. Never push — that is the user's job

- Do **not** run `git push` on your own initiative, and do not prompt the user about pushing (no "需要我 push 吗?" reminders). Just state the local commit status and stop.

### 3. Do not modify shared/global project files without permission

High-blast-radius files require a stop-and-ask before editing. This applies to:

- Workspace-level configs: `tsconfig.json`, `vitest.config.ts`, `commitlint.config.mjs`, `pnpm-workspace.yaml`, root `package.json` scripts
- App skeleton: router, `stores/index.ts`, `components/ui/**`, global CSS / Tailwind entry, `App.vue` / `main.ts`
- The instruction files themselves: `AGENTS.md`, `CLAUDE.md`

The rule: when in doubt about whether a file is "shared/global", treat it as shared and ask first.
