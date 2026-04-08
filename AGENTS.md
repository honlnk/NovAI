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

- `/Users/honlnk/project/claude-code-sound`

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
