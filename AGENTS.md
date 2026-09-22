# AGENTS.md

## Purpose

NovAI is intended to evolve toward an agentic novel-writing tool, closer to the interaction model of Claude Code / Vibe Coding tools than to a traditional chat app.

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

## Reference Repository

For implementation reference and comparative study, keep this external repository available next to the NovAI repo:

- `/Users/honlnk/project/claude-code`

This repository is intentionally cloned outside the NovAI git repository so that:

- it does not affect NovAI git status,
- it is not accidentally committed,
- it can still be read and compared during development.

When useful, study that repository for patterns such as:

- agent loop design,
- conversation state management,
- tool invocation structure,
- streaming interaction flow,
- file-oriented execution behavior.

## Working Rule

When documentation and code appear to conflict, prefer the clarified product intent above:

- NovAI is not just a workspace with a chat box.
- NovAI should become a conversation-driven AI agent for writing stories through tools and files.

## Workflow Discipline

These rules govern how AI agents interact with git in this repository. They are non-negotiable.

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
