# Product Specification

## Product name
Choose a working name such as:

- LocalForge
- CodePilot Local
- Ollama Coder Agent
- VertexSmith
- HomeCodex

## Vision

Build a personal AI coding agent that runs primarily on local models through Ollama and integrates deeply with VS Code. It must handle coding requests with planning, tool use, multi-file changes, session continuity, workspace scanning, code understanding, and iterative self-improvement.

## Primary use cases

1. Explain unfamiliar code in the current file or across the repo
2. Implement a feature from a plain-English request
3. Refactor code across multiple files
4. Fix build failures or diagnostics
5. Add tests for changed behavior
6. Search the workspace semantically and structurally
7. Generate migrations or boilerplate
8. Review diffs before applying
9. Resume previous sessions after restart
10. Use external MCP servers for repo search, browser tasks, databases, docs, issue trackers, CI, and custom tools

## Non-goals for v1

- autonomous background commits without review
- direct production deploy actions by default
- unrestricted shell execution
- silent modification of files outside workspace roots
- uncontrolled internet browsing
- opaque hidden edits

## User stories

### Workspace understanding
As a developer, I want the agent to understand my codebase before editing it, so changes are consistent with my architecture.

### Safe editing
As a developer, I want to review proposed changes before they are applied, especially for multi-file edits.

### Session continuity
As a developer, I want to close VS Code, reopen it later, and continue from the same active task and context.

### Model flexibility
As a developer, I want to choose different local models for planning, editing, embeddings, and summaries.

### Extensibility
As a developer, I want to plug in MCP servers and custom tools without rewriting the whole agent.

### Continuous improvement
As a developer, I want the system to learn from what worked, what I reverted, and what I accepted.

## Success criteria

### Functional
- Can answer questions about the current file, selection, symbols, and workspace
- Can produce structured plans with explicit steps
- Can perform safe multi-file edits
- Can run verification steps such as tests, linters, or builds
- Can connect to one or more MCP servers
- Can store and restore sessions
- Can maintain workspace memory and user preferences

### Quality
- High edit precision
- Clear change previews
- Low accidental file churn
- Fast context retrieval
- Graceful recovery from model or tool failure
- Minimal hallucinated APIs and paths

### UX
- Feels native to VS Code
- Has understandable permissions and approvals
- Offers a compact sidebar and optional rich panel
- Works well with keyboard-driven workflows

## v1 feature set

### Mandatory
- chat/task input box
- current file and workspace context collection
- Ollama model adapter
- plan mode and act mode
- tools for read/search/edit/diagnostics/git/terminal
- patch preview and apply
- session persistence
- memory capture
- MCP client integration
- config screen or settings contribution
- extension activation and startup flow
- telemetry opt-in only
- test suite

### Nice to have
- voice shortcuts
- subagent decomposition
- architecture map graph
- code map visualization
- browser-based doc retrieval tool
- pair-program mode
- continuous background indexing

## Quality bar

The agent should behave more like a senior engineering assistant than an autocomplete engine:

- asks for scope when needed
- breaks large tasks into steps
- cites evidence from workspace files
- distinguishes assumptions from facts
- avoids editing unrelated files
- verifies before claiming success
