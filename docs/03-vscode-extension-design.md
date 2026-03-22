# VS Code Extension Design

## Goals

The extension should install and start like any normal VS Code extension, with clear commands, settings, and optional views.

## Activation strategy

Use activation events for the scenarios that matter most:

- on startup finished for lightweight initialization
- on command usage for full activation
- on view open for UI loading
- optionally on workspace presence for indexing kick-off

Do not perform heavy indexing in the activation path. Start minimal, then defer non-critical work.

## Extension contributions

### Commands
Provide commands such as:

- Agent: Open Panel
- Agent: Start New Task
- Agent: Explain Selection
- Agent: Fix Diagnostics in Current File
- Agent: Refactor Workspace Scope
- Agent: Resume Last Session
- Agent: Apply Proposed Changes
- Agent: Revert Last Agent Changes
- Agent: Reindex Workspace
- Agent: Manage MCP Connections

### Views
Recommended view containers:

- **Activity Bar view** for sessions/tasks/history
- **Sidebar tree** for plans, tools, memories, MCP servers
- **Webview panel** for richer chat/task workflow and diff summaries

### Settings
Contribute settings for:

- default planner model
- default editor model
- default embedding model
- Ollama base URL
- allow terminal execution
- allow write without confirmation
- auto-run tests after edits
- max context tokens
- indexing strategy
- MCP server definitions
- telemetry opt-in
- memory mode
- approval mode

## Startup behavior

On first start:

1. register commands and views
2. load configuration
3. verify Ollama connection
4. load persisted sessions
5. load MCP definitions
6. warm caches lazily
7. mark extension ready

On workspace open:

1. detect workspace roots
2. compute lightweight file map
3. schedule background indexing
4. restore last workspace session if enabled

## Extension file layout

```text
src/
  extension.ts
  commands/
  views/
  webview/
  config/
  platform/vscode/
```

## Webview recommendations

Use the webview for:

- conversation/task UI
- plan display
- step execution progress
- rich diff previews
- approval cards
- memory timeline
- evaluation summaries

Keep webview logic separate from core agent runtime. The UI should consume message-based APIs from the extension host.

## UX principles

- show what the agent is doing
- show which files are being read
- show why edits are proposed
- show verification before success claims
- avoid noisy background interruptions
- keep approvals easy and explicit
- maintain keyboard accessibility

## Commands and workflows

### Explain selection
- user highlights code
- command gathers selection + surrounding symbols
- model produces explanation and dependencies
- response appears in panel

### Fix diagnostics in current file
- gather active diagnostics
- read file and nearby symbols
- plan fix
- propose patch
- run file-specific verification if possible
- show diff and summary

### Workspace feature implementation
- request clarified into acceptance criteria
- planner creates phased steps
- context builder gathers relevant files
- executor performs edits file by file
- verifier runs tests/build
- session stores result

## Packaging notes

Bundle the extension for performance.
Keep node-side dependencies small and predictable.
Treat native binaries carefully.
Support VSIX packaging for local install first, then marketplace publication later.
