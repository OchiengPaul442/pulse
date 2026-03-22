# Build Roadmap

## Phase 0: foundations
Goal: make the project runnable

Deliverables:
- monorepo or clean single-package setup
- extension scaffold
- command registration
- sidebar/webview shell
- config loading
- SQLite bootstrap
- logging and event bus

Exit criteria:
- extension installs locally
- command opens panel
- settings persist
- logs visible

## Phase 1: local model adapter
Goal: get reliable Ollama connectivity

Deliverables:
- Ollama provider
- health check
- streaming chat
- structured output validation
- model list discovery
- prompt registry

Exit criteria:
- can send task and receive streamed structured answer
- handles timeouts and unavailable model cleanly

## Phase 2: workspace understanding
Goal: read the codebase well

Deliverables:
- file tree scanner
- ripgrep integration
- symbol extraction
- diagnostics reader
- git status reader
- lightweight index cache

Exit criteria:
- can answer “where is X defined” and “what files are relevant” reliably

## Phase 3: editing engine
Goal: safe patch application

Deliverables:
- patch schema
- diff preview
- apply/revert transaction
- syntax validation
- current-file and multi-file edit support

Exit criteria:
- can update multiple files and revert safely

## Phase 4: planning and agent workflows
Goal: become agentic

Deliverables:
- planner
- structured task lifecycle
- executor
- approval flow
- verification flow

Exit criteria:
- can plan, act, verify, summarize

## Phase 5: sessions and memory
Goal: continuity and improvement

Deliverables:
- session persistence
- checkpoints
- episodic memory
- workspace facts
- feedback capture

Exit criteria:
- can resume task after restart and recall project conventions

## Phase 6: MCP integration
Goal: extensibility

Deliverables:
- MCP manager
- server config UI
- tool/resource/prompt bridge
- trust policies

Exit criteria:
- can call at least two MCP servers safely

## Phase 7: evaluation and hardening
Goal: production-quality reliability

Deliverables:
- golden task suite
- trace viewer
- failure analytics
- performance tuning
- docs cleanup

Exit criteria:
- stable on representative repos
- acceptable success and revert rates

## Phase 8: packaging and release
Goal: install like a normal extension

Deliverables:
- versioned VSIX build
- extension icon/banner
- changelog
- local install docs
- release workflow

Exit criteria:
- clean install and startup in VS Code
