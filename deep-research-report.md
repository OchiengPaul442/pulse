# Deep research report on improving Pulse agent performance and reliability on low‑VRAM local models

## What you’re observing and why it’s reproducible

Your screenshot showing **“Task not completed”**, a **missed quality target (0.64 / 0.90)**, and a terminal **ENOENT** aligns with how the current runtime summarizes incomplete edit-like tasks when no edits were actually applied and the quality gate is not met. In particular, the runtime builds an “issue + next steps” block when it classifies an objective as an edit intent yet detects no applied edits (or diffs) and sees a missed quality score threshold. citeturn39view4turn42view1

Separately, the symptom you describe—**the agent generates “tasks/TODOs” but then appears to stop rather than execute them**—also maps to the current agent-loop control flow: if the model returns **no tool calls and no edits**, the loop will stop after a small number of “no-action” iterations even when TODOs remain pending. citeturn39view1turn38view1

Finally, the “local model on an 8GB VRAM PC feels like it doesn’t load / hangs” symptom is consistent with **multi-model workflows** + **default model keep-alive behavior** + **context-length memory costs**. Ollama keeps models resident for a default window and can load multiple models concurrently when memory allows; on low VRAM, that often forces queuing, unloading, CPU offloading, or long load times. citeturn45view2turn45view1

## How Pulse is currently structured

Pulse is implemented as a **local AI coding agent** (packaged as a codebase you’re maintaining), with an agent runtime that can operate in “ask”, “plan”, and “agent” modes. Its model backend is an Ollama provider, and its “agent mode” builds a plan and then runs an iterative loop where the model returns JSON containing TODOs, tool calls, and edits. citeturn1view0turn40view3turn38view1

Key components (as they exist today):

The planner generates structured plan JSON using the provider’s chat interface (requesting JSON output). It normalizes the plan and ensures TODOs are present even if the model response is weak. citeturn13view2turn13view3

The runtime’s agent workflow explicitly resolves a **planner model** and an **editor model**, creates a plan with the planner model, then enters an agent loop driven by the editor model. This is a strength for cloud setups but becomes risky on 8GB machines if both models stay loaded. citeturn40view3turn45view2

The runtime’s agent loop expects the model to return valid JSON and then parses it with a “best-effort” parser that attempts to fix common local-model JSON mistakes. Tool calls and TODOs are normalized from multiple possible JSON field names (e.g., `todos`, `tasks`, `steps`). citeturn38view1turn19view3turn42view2

On the provider side, the Ollama implementation posts to `/api/chat` with streaming enabled and sets generation options like temperature and `num_predict` (via `maxTokens`). It also queries `/api/tags` and `/api/ps` to list local and running models. citeturn8view0turn9view1

## Why low‑VRAM local models struggle with the current design

### Multi-model residency and Ollama’s default keep-alive

Ollama keeps models loaded in memory for faster subsequent requests, with a default “kept in memory” period. Via API usage, `keep_alive` can force immediate unload (`0`) or keep loaded (`-1`), and the API parameter overrides server defaults. citeturn45view2turn45view0

Pulse’s agent workflow uses at least **two distinct roles (planner + editor)** for agent mode (and may use others in the broader runtime), which is typically fine on cloud GPUs but frequently problematic on 8GB VRAM. If the planner model remains loaded while the editor model begins loading, Ollama may be forced to queue requests until it can unload prior models or spill to CPU. Ollama’s docs explicitly note that concurrent model loads on GPU require each model to fit fully in VRAM, otherwise requests queue until memory is available. citeturn45view2turn40view3

### Context length scales memory requirements

Ollama documents that context length is the number of tokens held in memory, and that increasing context length increases memory requirements. It also states it defaults context length based on VRAM tiers (e.g., <24 GiB VRAM defaults to 4k context). citeturn45view1turn45view2

This matters because “agentic” workflows naturally want larger context windows (workspace snippets, tool results, conversation history). On an 8GB GPU, pushing context beyond the default can quickly force offloading to CPU and degrade responsiveness, especially if more than one model is competing for VRAM. citeturn45view1turn45view2

### Tight per-iteration model timeout for slow local inference

Pulse currently enforces a per-iteration timeout for the agent loop (`ITERATION_TIMEOUT_MS = 90_000`), which is often borderline for local runs when the model has to load weights or when CPU-offloading occurs. If the model doesn’t produce a response within that window, the iteration aborts and the workflow can terminate early. citeturn38view1turn45view2

### The “model must propose tool calls” assumption is too strong for weaker local models

The loop is built around the model emitting `toolCalls` and/or `edits` to make progress. If a local model instead emits only narrative text or incomplete JSON (causing parse fallback), the loop can hit the “no tool calls and no edits” branch repeatedly. After a small number of iterations, it exits even if TODOs remain. citeturn39view1turn42view1turn38view1

## Findings in the code that directly explain the TODO-stall behavior

### Early exit after repeated “no-action” iterations

When `observations.length === 0` (no executed tool calls) and no edits occurred, the agent loop contains a break condition that triggers after a couple of iterations, even if TODOs are still pending. The code attempts to “nudge” the model via critique text if pending TODOs remain, but it still breaks once the no-action threshold is hit. citeturn39view1turn38view1

This specific behavior matches your description: the agent can show TODOs (“tasks”) but then stop because the local model isn’t producing tool calls reliably or quickly enough. citeturn39view1turn42view2

### The quality target is high and biased toward tool use + verification + edits

The task-quality scorer targets `0.9` and awards substantial points for: presence of TODOs, tool calls, collected tool observations, verification running, and produced edits. Without tool calls and verification, a model can easily land around ~0.6-ish even if it wrote a plausible response—especially for “edit intent” objectives. citeturn41view0turn42view1

This is consistent with your screenshot’s approximate 0.64 score and the resulting “Task not completed” framing. citeturn39view4turn42view1

### You can enforce stronger JSON compliance than “format: json” by using schema

Ollama’s `/api/chat` accepts `format` as either `json` or a JSON schema, which is materially more enforceable than just asking for JSON in text instructions. citeturn45view0

Pulse currently requests JSON and includes “start with { end with }” instructions, but schema-driven output would reduce the “local model returns almost-JSON” failure mode that causes toolCalls to be missing after parsing. citeturn38view1turn42view2turn45view0

## Recommendations to optimize Pulse for 8GB VRAM local models

### Add an explicit low‑VRAM execution profile and make it “safe by default”

A practical target on 8GB VRAM is: **one model loaded at a time**, **small context**, **no background model consumers while a task is running**, and **longer timeouts**. Ollama provides both API-level and server-level controls (context length, keep-alive behavior, concurrency limits) that directly map to these goals. citeturn45view2turn45view1turn45view0

Concretely:

Implement per-request configuration in the provider so Pulse can send:

- `keep_alive: 0` for “one-shot” planner calls and for unloading models after use (to avoid planner + editor co-residency). Ollama documents `keep_alive=0` as the “unload immediately” setting. citeturn45view2turn45view0  
- `options.num_ctx` to explicitly constrain context window size for low-VRAM profiles (Ollama supports the `num_ctx` parameter when using the API). citeturn45view2turn45view0

Expose these in Pulse settings (e.g., `performance.profile = auto|low_vram|balanced|high_vram`) and default `auto` to conservative behavior unless the user opts into higher VRAM use. (This is recommended because Ollama’s own defaults already change by VRAM tier, and your agent adds additional token pressure.) citeturn45view1turn45view2

### Ensure multi-model workflows don’t keep multiple models resident

Pulse’s agent mode currently resolves `plannerModel` and `editorModel`, uses the planner to create a plan, then uses the editor to iterate in the agent loop. On low VRAM, you should prefer either:

- a single shared model for both roles, or  
- planner calls with `keep_alive=0`, then editor calls with a longer keep-alive (or default), and optionally an explicit unload at task end. citeturn40view3turn45view2

Ollama’s docs also describe how it queues requests when memory is insufficient to load new models, and how parallel requests scale memory by `OLLAMA_NUM_PARALLEL * OLLAMA_CONTEXT_LENGTH`. That means “keep one model + num_parallel=1 + smaller num_ctx” is the most reliable low‑VRAM posture. citeturn45view2turn45view1

### Increase or adapt timeouts for local model load latency

Pulse’s 90-second per-iteration abort is likely too aggressive for “cold start” times on local machines (especially if the model was unloaded, or if it spills to CPU). The fix is either:

- increase the timeout in low‑VRAM mode, or  
- implement a two-phase approach: allow a longer timeout for iteration 0 (“load + first token”), then shorter timeouts for subsequent iterations. citeturn38view1turn45view2

A key point: if you also change keep_alive behavior (unloading planner and other models), the editor model’s first load becomes the dominant latency—so iteration 0 needs to accommodate that. citeturn45view2turn40view3

### Make tool-use less dependent on the LLM by adding a deterministic “bootstrap tool step”

To prevent the “TODOs appear but nothing executes” failure mode, add a controller fallback:

If the model returns TODOs but **no toolCalls** for N iterations, Pulse should automatically run an initial evidence-gathering tool call sequence based on task type—e.g., workspace scan + read a few relevant files—then re-prompt with concrete context. This directly addresses the weak-local-model pattern where it cannot reliably emit tool call JSON even when prompted. citeturn39view1turn42view2turn40view3

This is also consistent with the design goal of making the agent behave more like tool-rich coding agents: you don’t rely on the model to “remember” to call basic tools before it can reason; you provide the evidence by default. citeturn45view0turn38view1

### Use JSON schema output to improve tool call reliability

Because Ollama `/api/chat` supports `format` as **either `json` or a JSON schema**, Pulse can provide a schema that enforces:

- `todos` array of objects with `id`, `title`, `status`, `detail?`  
- `toolCalls` array with enumerated tool names and typed args  
- `edits` array with required `filePath`, `operation`, and content rules  
- `shortcuts` array of strings citeturn45view0turn42view1turn42view2

This reduces parsing failures and significantly lowers the odds that local models generate “almost JSON” that becomes “no toolCalls” after parsing. citeturn42view2turn38view1

### Make the quality gate configurable and “profile-aware”

Right now the target is `0.9`, and the scoring gives large weight to tool usage, verification, and edits. For small local models, that target can be unrealistic and can cause unnecessary “Task not completed” results. citeturn41view0turn42view1turn39view4

What to change:

- Add `quality.targetScore` to settings, defaulting differently per profile (`low_vram` might target 0.75–0.85; cloud/high VRAM can remain 0.9).  
- Consider gating completion on “TODOs done + no blocked tool failures” rather than strictly numeric score in low_vram mode. citeturn42view1turn39view1

### Fix naming and UI clarity

Pulse emits a progress event labeled “Updating tasks” even though the object is a TODO list (and the protocol uses “TODOs” heavily). Renaming this label to “Updating TODOs” and presenting TODO status changes clearly helps users understand that this is a checklist driving the agent loop, not a separate “task” concept. citeturn16view1turn42view1turn38view1

## A copy‑paste implementation prompt to refactor Pulse for low‑VRAM local models

This is the prompt you can give to a coding agent (including Pulse itself, or a GPT‑Code‑style coding agent) to implement the fixes and restructuring in your repository.

```text
You are a principal engineer tasked with optimizing and hardening the Pulse codebase (repo: https://github.com/OchiengPaul442/pulse) so it runs reliably and fast on LOCAL Ollama models on consumer PCs with ~8GB VRAM (e.g., DeepSeek/Qwen family models) while maintaining compatibility with cloud/off-device Ollama usage.

Non-negotiable goals
- The agent must NOT stall after creating TODOs. If TODOs exist, the agent must actively progress them (tool calls and/or edits) until completion or a clearly explained failure state.
- The agent must be robust to weaker local models that sometimes fail to emit perfect JSON/toolCalls even when prompted.
- The agent must avoid multi-model VRAM contention. On low VRAM, ensure only ONE heavyweight model is loaded at a time.
- The agent must remain responsive: longer timeouts where needed (initial load), streaming where possible, graceful abort/cancel.
- Behave like a top-tier coding agent: inspect repo, gather evidence, apply edits safely, verify, summarize outcomes.

Scope: scan the entire repo, but focus especially on:
- src/agent/runtime/AgentRuntime.ts
- src/agent/runtime/TaskProtocols.ts
- src/agent/model/OllamaProvider.ts
- src/agent/planner/Planner.ts
- any config + UI code that affects model selection, timeouts, tool execution, and TODO display.

Deliverables
1) Low-VRAM performance profile
   - Add a new setting: pulse.performance.profile = "auto" | "low_vram" | "balanced" | "high_vram".
   - In low_vram: enforce ONE loaded model at a time, smaller context (num_ctx), num_parallel=1 behavior, and appropriate timeouts.
   - Document recommended Ollama server env vars for low VRAM users (OLLAMA_CONTEXT_LENGTH, OLLAMA_MAX_LOADED_MODELS=1, OLLAMA_NUM_PARALLEL=1).

2) OllamaProvider enhancements (critical)
   - Extend ChatRequest + provider.chat() to support:
     - keep_alive (duration string/seconds/0/-1)
     - options.num_ctx (and optionally other Ollama runtime options)
     - tools / function tool schema if needed
   - Implement a helper to UNLOAD a model by calling /api/chat with empty messages + keep_alive=0 OR by passing keep_alive=0 on requests that should unload immediately.
   - Ensure planner calls can unload immediately in low_vram profile to avoid planner+editor co-residency.

3) Fix the TODO-stall / early-exit bug in agent loop
   - In AgentRuntime.runAgentWorkflow() agent loop:
     - Remove or modify the early break condition that stops after ~2 “no toolCalls/no edits” iterations even if pending TODOs remain.
     - Add a deterministic bootstrap: if pending TODOs remain and the model returns no toolCalls, automatically run a minimal evidence-gathering tool sequence (workspace_scan + read_files of top relevant files) and re-prompt with tool results.
     - Do NOT exit the loop while TODOs are pending unless:
       (a) max iterations reached AND you return a structured failure report, or
       (b) user cancelled.
   - Make ITERATION_TIMEOUT_MS profile-aware (longer for iteration 0 on low_vram).

4) Stronger structured output for local models
   - Use Ollama /api/chat “format” with a JSON SCHEMA (not just "json") for agent-mode calls.
   - Define a schema that enforces { response, todos, toolCalls, edits, shortcuts } with correct types and constraints.
   - Keep parseTaskResponse as a fallback, but schema-first should be the default.

5) Quality gate improvements
   - Make TARGET_TASK_QUALITY_SCORE configurable via settings; set a lower default for low_vram profile.
   - Adjust assessTaskQuality inputs in AgentRuntime to use aggregated tool trace and real edit counts (not cleared arrays).
   - Completion criteria should prioritize: “TODOs done + no critical failures” over a single rigid score in low_vram.

6) Naming + UI clarity
   - Rename “Updating tasks” events and UI labels to “Updating TODOs”.
   - Ensure the UI clearly shows: pending / in-progress / blocked / done, and updates continuously during the agent loop.

7) Verification improvements
   - Ensure run_verification is safe and project-aware:
     - Prefer VS Code diagnostics and lightweight checks by default.
     - Only run npm/pnpm commands if package.json exists and scripts are detected, and the terminal tool confirms the command exists.
   - If a verification command fails with ENOENT, provide recovery steps and try an alternative verification method suitable for the project type.

Engineering approach / rules
- First: map the current workflow (planner -> plan.todos -> agent loop -> tool calls -> edits -> verify -> summary). Identify failure modes with low-VRAM + weak JSON.
- Add unit tests or lightweight integration tests around:
  - parseTaskResponse JSON recovery
  - agent loop not exiting with pending TODOs
  - keep_alive / unload logic called on model switches in low_vram
- Keep changes incremental and well-documented.
- Update README or docs for the new performance profile and recommended local-model configuration.

Acceptance criteria (must pass)
- On a machine configured for low_vram profile, the agent:
  - completes a multi-step coding task without freezing after TODO creation
  - never leaves TODOs pending without a clear failure report
  - avoids loading planner+editor models concurrently (confirmed via /api/ps or ollama ps)
  - handles at least one “weak JSON” response from a local model and still continues progress using schema + bootstrap tools
  - produces a final concise summary of outcomes, and separately tracks TODOs/tool results/verification.

Output required from you
- A PR-style response:
  - list of modified files and rationale
  - code diffs/patches
  - any new settings + defaults
  - test plan and how to validate on low VRAM
  - updated documentation sections
```

