# Pulse — Local AI Coding Agent for VS Code

> A privacy-first, fully offline AI coding agent powered by your own local models via [Ollama](https://ollama.com).

---

## What is Pulse?

Pulse is a VS Code extension that gives you a personal AI coding assistant that runs **entirely on your machine** — no API keys, no cloud, no data leaving your computer. It connects to locally running Ollama models and acts as a real coding agent: it reads your workspace, plans multi-step tasks, writes and edits files, remembers past sessions, and learns from your feedback.

---

## Features

| Capability                 | Details                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| **Chat interface**         | Conversational sidebar with message history                                |
| **Code editing**           | Create, rewrite, delete, and move files with staged approvals              |
| **Local models**           | Works with any Ollama model (Llama 3, Mistral, Qwen, DeepSeek Coder, etc.) |
| **Multi-model routing**    | Assign different models to planner, editor, fast, and embedding roles      |
| **Token budget indicator** | Circular progress indicator in the composer for consumed token budget      |
| **Session memory**         | Conversations are persisted and resumable across VS Code sessions          |
| **Episodic learning**      | Builds a rolling memory of past tasks to improve future responses          |
| **Approval modes**         | Strict (always confirm), Balanced, or Fast (auto-apply)                    |
| **Safe reverts**           | Every applied edit creates a snapshot — one click to undo                  |
| **MCP support**            | Visibility into configured MCP servers                                     |
| **Skills registry**        | Built-in skill manifests with objective-based skill routing                |
| **Prepublish guard**       | One-command release readiness checks for model/MCP/diagnostics state       |
| **Workspace diagnostics**  | Reads VS Code error diagnostics into context                               |

---

## Requirements

- **VS Code** `1.90.0` or later
- **[Ollama](https://ollama.com)** running locally (default: `http://localhost:11434`)
- At least one pulled model, e.g.:
  ```bash
  ollama pull qwen2.5-coder:7b
  ollama pull deepseek-coder-v2:latest
  ```

---

## Getting Started

1. Install the extension from the VS Code marketplace or VSIX file.
2. Start Ollama: `ollama serve`
3. Open the **Pulse** panel in the Activity Bar (lightning bolt icon).
4. The status badge at the top turns **Online** when Ollama is reachable.
5. Type your first task in the composer at the bottom and press **Enter**.

---

## Usage

### Chat composer

Type any request in the bottom input and press **Enter** (or the send button). Examples:

- _"Add input validation to the login form"_
- _"Explain what this function does"_
- _"Refactor the auth module to use async/await"_
- _"Create a new utility file for date formatting"_

### Applying edits

When Pulse proposes file changes, an amber banner appears at the top of the composer. Click **Apply** to write the changes to disk, or **Revert** to undo the last applied transaction.

### Approval modes

Click the **approval mode chip** (bottom left of the composer) to cycle through:

- `strict` — always confirm before applying
- `balanced` — confirm destructive operations
- `fast` — apply edits automatically without prompts

### Model settings

Click the **⚙ gear icon** in the header to open the model settings drawer. Select a role (Planner, Editor, Fast, Embedding) and a model from your local Ollama library, then click **Apply**.

---

## Command Palette

All actions are also available via `Ctrl+Shift+P` / `Cmd+Shift+P`:

| Command                            | Description                                  |
| ---------------------------------- | -------------------------------------------- |
| `Pulse: Open Panel`                | Open the Pulse sidebar                       |
| `Pulse: Start New Task`            | Run a task from a quick-pick input           |
| `Pulse: Explain Selection`         | Explain the current editor selection         |
| `Pulse: Apply Proposed Changes`    | Apply staged file edits                      |
| `Pulse: Revert Last Agent Changes` | Undo the last applied transaction            |
| `Pulse: Select Models`             | Open model role assignment                   |
| `Pulse: Set Approval Mode`         | Change the approval mode                     |
| `Pulse: List Skills`               | Show loaded skills and routing metadata      |
| `Pulse: Run Prepublish Guard`      | Run publish-readiness checks and open report |
| `Pulse: Re-index Workspace`        | Re-scan workspace files                      |
| `Pulse: Open Diagnostics Report`   | View a full runtime diagnostic report        |

---

## Configuration

All settings live under the `pulse.*` namespace in VS Code settings:

```jsonc
{
  // Ollama server URL
  "pulse.ollama.baseUrl": "http://localhost:11434",

  // Model assignments
  "pulse.models.planner": "qwen2.5-coder:14b",
  "pulse.models.editor": "deepseek-coder-v2:16b",
  "pulse.models.fast": "qwen2.5-coder:7b",
  "pulse.models.embedding": "nomic-embed-text:latest",
  "pulse.models.fallbacks": ["qwen2.5-coder:7b"],

  // Approval mode: "strict" | "balanced" | "fast"
  "pulse.behavior.approvalMode": "balanced",

  // Memory: "off" | "session" | "workspace+episodic"
  "pulse.behavior.memoryMode": "workspace+episodic",
}
```

### Verify local models

1. Start Ollama:

   ```bash
   ollama serve
   ```

2. Check local tags:

   ```bash
   ollama list
   ```

3. In Pulse, click **Sync models** in the settings drawer. Pulse merges installed + running models and validates selected model names.

### Verify MCP configuration

Pulse validates each enabled MCP server in diagnostics:

- `stdio` transport: command must exist in `PATH`
- `http` / `sse` transport: URL must be syntactically valid

Open `Pulse: Manage MCP Connections` or `Pulse: Open Diagnostics Report` to inspect status and details.

---

## Build and Package

```bash
npm install
npm run compile
npm run test
npm run package
```

Install the generated VSIX locally:

1. Open VS Code Command Palette.
2. Run `Extensions: Install from VSIX...`.
3. Pick the generated `pulse-agent-<version>.vsix`.

---

## Publish to VS Code Marketplace

1. Create a publisher in Azure DevOps Marketplace.
2. Create a Personal Access Token with Marketplace publish scope.
3. Login with `vsce`:

   ```bash
   npx vsce login <publisher-name>
   ```

4. Ensure `publisher` in `package.json` matches your publisher ID.
5. Bump extension version:

   ```bash
   npm version patch
   ```

6. Publish:

   ```bash
   npx vsce publish
   ```

Tip: run `npx vsce package` before publish to validate packaging output.

---

## Privacy & Security

- All model inference runs **locally** through Ollama — no data is sent to any external server.
- File edits are sandboxed to the open workspace folder.
- Deleted files are moved to the OS trash (recoverable), never permanently deleted.
- Snapshots of every modified file are stored locally before any edit is applied.

---

## Architecture

```
VS Code Extension Host
├── PulseSidebarProvider   — Chat UI webview
├── AgentRuntime           — Orchestrator
│   ├── OllamaProvider     — HTTP client for local models
│   ├── Planner            — JSON task plan generation
│   ├── WorkspaceScanner   — File discovery & context extraction
│   ├── EditManager        — Staged edits with snapshot revert
│   ├── SessionStore       — Session persistence (JSON)
│   ├── MemoryStore        — Episodic memory & preferences
│   ├── VerificationRunner — VS Code diagnostics reader
│   └── McpManager         — MCP server config visibility
│   └── SkillRegistry      — Built-in skills and objective routing
└── registerCommands       — Command palette bindings
```

---

## License

MIT

```text
vscode-local-agent/
  package.json
  tsconfig.json
  esbuild.mjs
  src/
    extension.ts
    commands/
    views/
    webview/
    config/
    agent/
      orchestrator/
      planner/
      runtime/
      policies/
      tools/
      memory/
      sessions/
      traces/
      edits/
      verification/
      model/
      mcp/
      indexing/
    platform/
      vscode/
      git/
      terminal/
      fs/
      diagnostics/
    db/
    test/
  media/
  scripts/
  docs/
```

## Outcome

Use these docs as the exact spec pack you hand to your coding agent so it can implement the product phase by phase with minimal ambiguity.
