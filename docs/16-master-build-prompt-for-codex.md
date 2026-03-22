# Master Build Prompt for GPT-5.3 CODEX or Any Strong Coding Agent

Use the following prompt as the master instruction set for the coding agent that will implement this product.

---

## Role

You are building a production-grade VS Code extension named `<PROJECT_NAME>` that acts as an **agentic local coding assistant**. It runs local models through Ollama, supports MCP servers, manages sessions and memory, performs safe multi-file edits, and behaves like a serious coding agent rather than a simple chat wrapper.

## Product requirements

Implement the system described in the Markdown docs in this folder. Read all docs before coding. Do not skip architecture or safety requirements.

Core requirements:

- VS Code extension installable as VSIX
- activates and starts like a normal extension
- sidebar view and/or webview panel
- command palette commands
- Ollama local model integration
- structured planning and execution
- multi-file edit engine with diff preview
- session persistence and resume
- workspace scanning and code understanding
- MCP client support for tools/resources/prompts
- verification workflows
- local persistence using SQLite
- tests across unit, integration, and extension layers

## Engineering rules

1. Use TypeScript throughout unless a narrow helper truly needs something else.
2. Use clean architecture and strong module boundaries.
3. Keep model providers abstracted behind interfaces.
4. Keep MCP integration modular.
5. Keep prompts versioned and isolated from orchestration logic.
6. Keep all writes auditable and reversible.
7. Build phases incrementally and keep the extension runnable after every milestone.
8. Add tests for every meaningful behavior.
9. Prefer minimal correct diffs over broad rewrites.
10. Never fake verification results.

## Delivery process

Work in phases:

### Phase 0
Create project scaffold, extension activation, commands, UI shell, config, logging, database bootstrap.

### Phase 1
Implement Ollama provider, health checks, streaming, structured outputs, model routing config.

### Phase 2
Implement workspace scanner, file tools, search tools, symbol extraction, diagnostics reader, git reader.

### Phase 3
Implement patch engine, diff preview, apply/revert transactions, syntax checks.

### Phase 4
Implement planner, executor, verification runner, approvals, task lifecycle.

### Phase 5
Implement sessions, checkpoints, memories, feedback capture.

### Phase 6
Implement MCP manager, server configuration, tool/resource/prompt bridge, trust controls.

### Phase 7
Implement evaluation harness, golden tasks, diagnostics report, performance improvements.

### Phase 8
Package as VSIX and document local installation.

## Output expectations for each phase

For each phase:
- explain what you will build
- list files to create or modify
- implement code
- explain key design choices briefly
- run tests or checks
- report known limitations honestly

## Coding constraints

- Do not introduce unnecessary frameworks.
- Keep dependencies minimal and justified.
- Prefer explicit types.
- Add docstrings/comments where the logic is non-obvious.
- Keep UI lightweight and native-feeling.
- Build for maintainability first, then extra polish.

## Safety constraints

- No writes outside the workspace without explicit approval path.
- No destructive shell commands.
- No automatic secret logging.
- No hidden background self-modification.
- No broad recursive file rewrites without explanation and preview.

## Quality bar

The extension should feel like a dependable coding agent:
- can inspect code deeply
- can plan before acting
- can apply coherent multi-file changes
- can verify outcomes
- can resume later
- can improve through recorded feedback and memory
- can be extended with MCP servers cleanly

## First task

Start by generating the full repository scaffold and Phase 0 implementation with:
- `package.json`
- extension activation
- commands
- sidebar or panel shell
- config schema
- storage bootstrap
- logging
- test harness setup

Then stop and summarize what was created, what remains, and the exact next steps for Phase 1.

---

## Optional follow-up instruction

After initial scaffold generation, continue phase by phase only after confirming each phase builds cleanly and tests pass.

## Non-negotiable standard

You are not building a demo.
You are building a real, installable, extensible local coding agent.
