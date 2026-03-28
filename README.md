# Pulse Agent

> Local offline AI coding agent for VS Code powered by Ollama.

Pulse turns VS Code into a local coding agent that can read your workspace, plan multi-step tasks, propose edits, run safe terminal commands, and remember prior work without sending your code to a cloud service.

## What It’s Good At

- Workspace-aware coding help.
- File edits with a review and revert flow.
- Ask, Plan, and Agent modes.
- Local Ollama models with role-based routing.
- Session memory and background self-learning.
- MCP server visibility and configuration.
- Drag-and-drop file attachments.
- Tool enable and disable controls in the settings drawer.

## Quick Start

1. Install VS Code 1.90.0 or later.
2. Install and start Ollama.
3. Pull the recommended models.
4. Open the Pulse sidebar from the Activity Bar.
5. Send a task and review the proposal before applying changes.

Recommended models:

- Planner: `deepseek-r1:7b`
- Editor: `qwen2.5-coder:7b`
- Fast: `qwen2.5-coder:7b`
- Embeddings: `nomic-embed-text:latest`
- Fallbacks: `qwen2.5-coder:7b`, `nemotron-mini:latest`

## How To Use Pulse Well

- Give one clear objective at a time.
- State constraints, file names, and the expected outcome.
- Attach the files that matter, or drag and drop them into the composer.
- Use Ask for explanations, Plan for roadmaps, and Agent for edits.
- Keep changes small and verify them before moving on.
- Review the proposal banner before keeping changes.
- Use the tool settings panel to disable anything you do not want the agent to use.
- If you are improving Pulse itself, update the runtime, tests, settings, and docs together.

## Good Improvement Workflow

- Change prompts or model defaults when the agent starts behaving inconsistently.
- Add or update tests for protocol parsing, tool routing, and model fallback behavior.
- Keep the README and package metadata in sync with any user-facing change.
- Run compile and test before packaging or publishing.

## Core Commands

- `Pulse: Open Panel`
- `Pulse: Start New Task`
- `Pulse: Explain Selection`
- `Pulse: Apply Proposed Changes`
- `Pulse: Revert Last Agent Changes`
- `Pulse: Select Models`
- `Pulse: Set Approval Mode`
- `Pulse: List Skills`
- `Pulse: Reindex Workspace`
- `Pulse: Open Diagnostics Report`
- `Pulse: Manage MCP Connections`
- `Pulse: Configure MCP Servers`
- `Pulse: Search the Web`
- `Pulse: Run Prepublish Guard`

## Key Settings

```jsonc
{
  "pulse.ollama.baseUrl": "http://127.0.0.1:11434",
  "pulse.models.planner": "deepseek-r1:7b",
  "pulse.models.editor": "qwen2.5-coder:7b",
  "pulse.models.fast": "qwen2.5-coder:7b",
  "pulse.models.embedding": "nomic-embed-text:latest",
  "pulse.models.fallbacks": ["qwen2.5-coder:7b", "nemotron-mini:latest"],
  "pulse.behavior.permissionMode": "default",
  "pulse.behavior.selfLearn": true,
  "pulse.behavior.maxContextTokens": 32768,
  "pulse.behavior.memoryMode": "workspace+episodic",
  "pulse.search.maxResults": 5,
}
```

The sidebar settings drawer also includes model selection, MCP server management, self-learn, and tool enable or disable controls.

## Publishing

1. Set `publisher` in `package.json` to your Marketplace publisher.
2. Run `npm run compile`, `npm test`, and `npm run package`.
3. Publish with `npx vsce publish`.
4. Install the generated VSIX from the `versions` folder if you want to test locally.

## Privacy

Pulse runs locally, uses Ollama for model access, stores session data in VS Code storage, and keeps Tavily API keys in Secret Storage.
