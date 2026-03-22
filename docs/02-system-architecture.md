# System Architecture

## Top-level architecture

```text
VS Code Extension Host
├── Command Layer
├── Sidebar / Webview UI
├── Agent Orchestrator
│   ├── Intent Router
│   ├── Context Builder
│   ├── Planner
│   ├── Executor
│   ├── Verifier
│   ├── Memory Manager
│   └── Session Manager
├── Tool Layer
│   ├── Native VS Code Tools
│   ├── File / Search / Git / Terminal Tools
│   ├── Diagnostics / Test Tools
│   └── MCP Tool Bridge
├── Model Layer
│   ├── Ollama Adapter
│   ├── Structured Output Parser
│   ├── Fallback Model Router
│   └── Prompt Templates
├── Retrieval Layer
│   ├── Workspace Scanner
│   ├── Symbol Extractor
│   ├── Chunker
│   ├── Indexer
│   └── Reranker
└── Persistence Layer
    ├── SQLite
    ├── Filesystem Cache
    └── Config Store
```

## Architectural rules

1. Keep model access behind adapters
2. Keep tools behind explicit capability boundaries
3. Keep UI separate from orchestration
4. Keep prompts versioned and testable
5. Keep all edits auditable and reversible
6. Keep memory scoped by user, workspace, branch, and session
7. Keep risky execution behind policy gates

## Core execution loop

```text
User request
  -> classify intent
  -> define scope
  -> gather context
  -> build plan
  -> choose tools/model
  -> execute steps
  -> generate edits
  -> verify changes
  -> summarize result
  -> store trace and memory
```

## Major components

### 1. UI layer
Responsible for:

- command palette commands
- sidebar tree or activity bar view
- task/session list
- current plan display
- approval prompts
- diff previews
- settings and model selection

### 2. Orchestrator
Central brain for agentic behavior:

- intent classification
- planning vs direct answer routing
- context budget allocation
- tool sequencing
- retries and rollback
- session updates

### 3. Tool execution layer
Handles safe operations:

- file reads
- file writes
- symbol search
- regex search
- AST extraction
- diagnostics inspection
- terminal command execution
- git diff/status
- test invocation
- MCP tool calls

### 4. Retrieval/indexing layer
Provides relevant context:

- file graph
- import graph
- symbol map
- semantic chunks
- recent edits
- active diagnostics
- dependency versions

### 5. Model layer
Supports:

- local models via Ollama
- routing by task type
- streaming responses
- structured JSON outputs
- token budgeting
- failover or task downgrade

### 6. Persistence layer
Stores:

- sessions
- tasks
- traces
- diff records
- feedback
- memory items
- workspace facts
- evaluation results

## Recommended internal package boundaries

```text
src/agent/orchestrator
src/agent/runtime
src/agent/model
src/agent/tools
src/agent/memory
src/agent/mcp
src/agent/indexing
src/agent/edits
src/platform/vscode
src/platform/git
src/platform/fs
src/db
```

## Event-driven design

Use an internal event bus for:

- session started
- context gathered
- plan created
- tool started
- tool completed
- edit proposed
- edit applied
- verification passed
- verification failed
- memory stored
- session ended

This makes the system easier to debug, test, and extend later.

## Failure domains

Separate failures cleanly:

- model failure should not corrupt session state
- tool failure should not lose plan context
- partial edit failure should support rollback
- MCP connection failure should degrade gracefully
- indexing failure should fall back to direct file search
