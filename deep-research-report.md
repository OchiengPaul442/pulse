# Pulse Repository Deep Technical Research Report

Pulse is already close to a “Codex-style” coding agent: it has structured-output schemas for local models, a multi-iteration agent loop with stall recovery, tool execution with observations, and low‑VRAM performance profiles. citeturn38view0turn26view0turn16view8 The primary reliability gaps that explain your screenshots are **(a)** TODO execution not being *deterministically bound* to tool outcomes (so TODOs remain “in-progress” even when work succeeded), **(b)** terminal execution failing in ways that look like “npm ENOENT” because the extension host environment can’t reliably resolve executables or `cwd`, and **(c)** missing PDF ingestion in the attachment pipeline (so “file upload + scan” cannot work as expected). citeturn26view0turn34view4turn33view3turn33view4

Assumptions (explicit): local environment is VS Code extension host running Node; OS may be Windows/macOS/Linux; local inference is via Ollama at a configurable base URL; “weak PC” means ≈8GB VRAM and models that may OOM at larger contexts; you want safe defaults but still “fast” behavior when user toggles bypass approvals.

## Repository architecture and current execution model

Pulse is implemented as a VS Code extension with an agent runtime that runs a plan→execute loop, emitting structured progress updates (thinking steps, TODO updates, terminal output) to the webview UI. citeturn36view6turn28view2 The key components relevant to your failures:

The agent loop is mainly inside `src/agent/runtime/AgentRuntime.ts` via `runAgentWorkflow(...)`. It:
- Creates a plan (`Planner.createPlan`) using **profile defaults** (`resolveProfileDefaults`) including `keepAlive` and `numCtx`, and (for low VRAM) intends to unload models between phases to avoid VRAM contention. citeturn28view2turn16view8turn32view0  
- Runs iterative “editor” turns where the model must return JSON matching `TASK_RESPONSE_SCHEMA` (structured outputs), then executes `toolCalls`, applies edits, and attempts to auto-advance TODO statuses. citeturn38view0turn26view0  
- Includes stall handling: if there are too many “no-action” iterations, it auto-injects a `workspace_scan` tool result to re-ground weak local models. citeturn26view0turn16view8  

The structured output system is defined in `src/agent/runtime/TaskProtocols.ts`:
- It defines `TASK_RESPONSE_SCHEMA` and notes it is meant to reduce malformed outputs for local models (deepseek-r1, qwen2.5-coder) by passing a JSON schema into Ollama’s `format` parameter. citeturn38view0turn32view0  
- The schema currently includes `{ response, todos, toolCalls, edits, shortcuts }` and requires all of them. citeturn38view2  

Terminal execution is split across:
- `AgentRuntime.executeTerminalCommand(...)` which applies policy checks and “safe command” checks. citeturn30view1turn25view0  
- `src/agent/terminal/TerminalExecutor.ts`, which executes commands via `child_process.spawn(..., { shell: true })`, capturing output with a timeout. citeturn34view4turn34view6  

Multimodal images are supported in-chat as OpenAI-style `image_url` content blocks (`ChatMessageContent`), with an Ollama adapter that converts `image_url` data URLs into `messages[].images` base64 strings. citeturn10view10turn32view0 The UI stores dropped images as a `{ name, dataUrl }` and queues them for the runtime. citeturn10view13turn28view2

File attachments are handled by `src/agent/attachments/AttachmentManager.ts`, but it currently focuses on reading **text-like** workspace files and explicitly returns `null` for `binary` and `image` types; it has no PDF-specific ingestion path. citeturn33view4turn33view5turn33view3

## Discovered issues with locations, root causes, and severity

The table below is prioritized by how directly it maps to your screenshots (“TODO stuck”, “npm ENOENT”, “file/image/PDF upload not scanning”), then by security and long-term maintainability.

### Issue inventory

| Issue | Location (file + code location) | Severity | Root cause | What to change |
|---|---|---:|---|---|
| TODOs can remain “in-progress” after work succeeds, making the agent appear stalled | `src/agent/runtime/AgentRuntime.ts` (agent loop calls `advanceTodoStatuses(...)` after tool observations) | **Critical** | TODO status is not *deterministically* tied to tool execution results; schema/tool calls don’t carry a `todoId` binding, so auto-advancement is heuristic and fails on weak models | Add `todoId` (or `todoIds`) into `toolCalls[]` schema + runtime marks TODO done/blocked based on tool results; stop relying only on model-chosen statuses |
| Agent can run Node-related commands (npm/pnpm) during Python/Django scaffolding, leading to “npm ENOENT” and aborting progress | `src/agent/runtime/TaskProtocols.ts` (`isSafeTerminalCommand` allowlists npm/pnpm/yarn + scaffolding patterns); `AgentRuntime.executeTerminalCommand` runs safe commands in non-strict modes | **Critical** | No deterministic “stack/intent gate” before executing a terminal command; allowlist includes both Python and Node, so a weak model can choose the wrong ecosystem | Add project-type detection and command-to-stack gating; if mismatch, return a structured failure observation and force a recovery iteration |
| Terminal execution can fail with ENOENT due to invalid `cwd` or missing executable resolution, and the agent treats it as fatal instead of recoverable | `src/agent/terminal/TerminalExecutor.ts` uses `spawn(command, { cwd, shell: true })`; execution errors become tool failures | **High** | Spawn ENOENT commonly happens if `cwd` does not exist or the command is not resolvable in the extension host PATH; no preflight checks | Add preflight for `cwd` existence + executable existence + “login shell” execution strategy; improve error classification and recovery |
| Default permission mode auto-approves **terminal_exec** and **multi_file_edit**, which is risky and makes approvals inconsistent with user expectations | `src/agent/permissions/PermissionPolicy.ts` SAFE_ACTIONS includes `"terminal_exec"` and `"multi_file_edit"` | **High** | “default” mode is functionally permissive; this clashes with safe defaults and makes it easy for the agent to run environment-changing commands without explicit consent | Move to a safer default: auto-approve read operations only; require user approval for `terminal_exec` and multi-file edits unless “bypass” is enabled |
| `AttachmentManager` does not ingest PDFs; image/binary content is dropped (null), so “upload & scan PDF” can’t work | `src/agent/attachments/AttachmentManager.ts` returns null for `image`/`binary`; no “pdf” handling (no `pdf` matches) | **High** | No PDF pipeline: no extraction, no OCR, no page rasterization; attachments are treated as “text snippets only” | Add an ingestion interface supporting: PDF text extraction → OCR fallback → vision fallback; implement limits & chunking |
| UI supports drag-drop images (data URLs), but there’s no unified “document pipeline” to compress/resize images for weak GPUs or limit payloads | `src/views/PulseSidebarProvider.ts` queues `{ name, dataUrl }`; runtime sends as `image_url` | **High** | Data URLs can be huge; without resizing and limits, local models may OOM or slow dramatically | Add client-side resizing + max count/size; add runtime-side enforcement and truncation |
| Verification runner only inspects VS Code diagnostics, which is insufficient to validate scaffolding (Django, Node) | `src/agent/verification/VerificationRunner.ts` uses `vscode.languages.getDiagnostics()` only | **Medium** | Diagnostics do not equal “project builds/tests pass”; users expect `run_verification` to run commands appropriate to the project type | Add project-aware verification command selection and execute via terminal with safe defaults |
| Safe terminal allowlist includes `curl`/`wget` which enables data exfiltration and remote execution patterns | `src/agent/runtime/TaskProtocols.ts` safe patterns contain `curl` and `wget` | **Medium** | “Non-destructive read” assumption is unsafe: curl/wget can upload data or fetch scripts | Remove or require explicit approval; keep only “download into workspace” with strict constraints if needed |
| OpenAI-compatible provider may not enforce JSON schema structured outputs the same way Ollama does | `src/agent/model/OpenAICompatibleProvider.ts` (provider path) + schema reliance in runtime | **Medium** | `format` as JSON schema is an Ollama capability; OpenAI-compatible servers differ, so schema reliability can degrade on cloud APIs | Add provider capability flags; use JSON mode/function calling where supported; otherwise improve parsing + retries |
| Background self-learn loop can degrade responsiveness on weak machines | `AgentRuntime.ts` self-learn runs every 45s | **Medium** | Additional compute and potential model calls compete for VRAM/time | Disable by default on `low_vram` profile; ensure it doesn’t run during active tasks |
| Attachment directory expansion can pull too many files and pollute context if limits aren’t strict | `AttachmentManager.expandDirectory(...)` shallow limit + exclusions | **Low** | Directory scanning can still include irrelevant files | Tighten patterns; integrate with project detector + ignore lists |

Evidence notes:
- The agent loop executes tool calls, applies edits, then calls an auto-advance function and stall recovery logic. citeturn26view0  
- The tool schema does **not** include any `todoId` binding. citeturn38view2  
- Node ecosystem commands are explicitly allowlisted as “safe terminal commands” (including scaffolding). citeturn25view0turn14view0  
- Terminal execution uses `spawn(... { shell: true, cwd })` and times out via `child.kill()` but does not preflight executables/cwd. citeturn34view4turn34view6  
- AttachmentManager has no PDF path and returns null for binary/image content. citeturn33view4turn33view3  
- Ollama adapter supports `messages[].images` conversion and forwards `format`, `num_ctx`, and `keep_alive`. citeturn32view0turn39search0turn39search4turn39search32  

## Concrete fixes with code patches and exact edits

The changes below are designed to be minimal but high leverage. They are grouped by severity and directly address the screenshot symptoms (TODO stalls + “npm ENOENT”) while improving local-model robustness.

### Deterministic TODO execution binding

**Goal:** Never let TODO progress depend only on the model’s status text. Instead, bind tool calls to TODOs and auto-update statuses deterministically.

**Edit:** `src/agent/runtime/TaskProtocols.ts` — extend schema + types.

Current schema shape is `toolCalls[].{ tool, args, reason }`. citeturn38view2

**Patch (diff):**
```diff
diff --git a/src/agent/runtime/TaskProtocols.ts b/src/agent/runtime/TaskProtocols.ts
@@
 export const TASK_RESPONSE_SCHEMA: Record<string, unknown> = {
   type: "object",
   properties: {
+    activeTodoId: { type: "string" },
     response: { type: "string" },
@@
     toolCalls: {
       type: "array",
       items: {
         type: "object",
         properties: {
           tool: { type: "string" },
           args: { type: "object" },
           reason: { type: "string" },
+          todoId: { type: "string" },
+          expectedOutcome: { type: "string" },
         },
-        required: ["tool", "args"],
+        required: ["tool", "args", "todoId"],
       },
     },
@@
-  required: ["response", "todos", "toolCalls", "edits", "shortcuts"],
+  required: ["response", "todos", "toolCalls", "edits", "shortcuts"],
 };

@@
 export interface TaskToolCall {
   tool: TaskToolName;
   args: Record<string, unknown>;
   reason?: string;
+  todoId?: string;
+  expectedOutcome?: string;
 }
```

**Edit:** `src/agent/runtime/AgentRuntime.ts` — after observing tool results, update TODOs based on tool result + `todoId` instead of heuristics.

The loop currently executes tool calls and then calls `advanceTodoStatuses(parsed.todos, observations)`. citeturn26view0

**Patch (add helper + use it):**
```diff
diff --git a/src/agent/runtime/AgentRuntime.ts b/src/agent/runtime/AgentRuntime.ts
@@
   const observations = parsed.toolCalls.length > 0
     ? await this.executeTaskToolCalls(parsed.toolCalls, objective, signal)
     : [];
@@
-  // Auto-advance todo statuses based on completed work
-  this.advanceTodoStatuses(parsed.todos, observations);
+  // Deterministic TODO updates: bind tool outcomes to todoId if provided.
+  this.applyTodoOutcomesFromToolCalls(parsed.todos, parsed.toolCalls, observations);
+  this.emitTodoUpdate(parsed.todos);

@@
+private applyTodoOutcomesFromToolCalls(
+  todos: TaskTodo[],
+  calls: TaskToolCall[],
+  observations: TaskToolObservation[],
+): void {
+  if (todos.length === 0 || calls.length === 0 || observations.length === 0) return;
+  const byTodo = new Map<string, { ok: boolean; summary: string }[]>();
+  for (let i = 0; i < calls.length; i++) {
+    const todoId = (calls[i] as any).todoId;
+    if (typeof todoId !== "string" || !todoId.trim()) continue;
+    const obs = observations[i] ?? null;
+    if (!obs) continue;
+    const list = byTodo.get(todoId) ?? [];
+    list.push({ ok: obs.ok, summary: obs.summary });
+    byTodo.set(todoId, list);
+  }
+  for (const todo of todos) {
+    const events = byTodo.get(todo.id);
+    if (!events || events.length === 0) continue;
+    const anyFail = events.some((e) => !e.ok);
+    const anyOk = events.some((e) => e.ok);
+    if (anyFail) {
+      todo.status = "blocked";
+      todo.detail = `Tool failure: ${events.find((e) => !e.ok)?.summary ?? "unknown error"}`;
+      continue;
+    }
+    if (anyOk) {
+      // If tools succeeded for this todo, mark as done.
+      todo.status = "done";
+      if (!todo.detail) todo.detail = "Completed via tool execution.";
+    }
+  }
+}
```

**Why this fixes your screenshot:** if “Initialize repository” is associated with file writes or git init, it will be marked done as soon as those tool calls succeed, rather than staying stuck in “in-progress.” The schema change forces models to bind every tool call to a TODO, which is crucial for weaker local models. citeturn38view2turn26view0

### Project-type detection and command gating to prevent wrong-ecosystem commands

Pulse already *tells* the model “Never run npm/pnpm/yarn in non-Node projects,” but it does not enforce this before executing. citeturn27view5turn25view0

**Add:** `src/agent/runtime/ProjectDetector.ts` (new file)

```ts
// src/agent/runtime/ProjectDetector.ts
import * as vscode from "vscode";

export type ProjectType = "node" | "python" | "django" | "unknown";

export interface ProjectFingerprint {
  type: ProjectType;
  signals: string[];
}

export async function detectProjectFingerprint(): Promise<ProjectFingerprint> {
  const signals: string[] = [];

  const has = async (glob: string): Promise<boolean> => {
    const found = await vscode.workspace.findFiles(glob, "**/{node_modules,dist,.git,venv,__pycache__}/**", 1);
    return found.length > 0;
  };

  const hasPackage = await has("**/package.json");
  const hasManagePy = await has("**/manage.py");
  const hasPyProject = await has("**/pyproject.toml");
  const hasReq = await has("**/requirements.txt");

  if (hasPackage) signals.push("package.json");
  if (hasManagePy) signals.push("manage.py");
  if (hasPyProject) signals.push("pyproject.toml");
  if (hasReq) signals.push("requirements.txt");

  if (hasManagePy) return { type: "django", signals };
  if (hasPyProject || hasReq) return { type: "python", signals };
  if (hasPackage) return { type: "node", signals };
  return { type: "unknown", signals };
}

export function commandEcosystem(command: string): "node" | "python" | "unknown" {
  const c = command.trim().toLowerCase();
  if (/^(npm|pnpm|yarn|npx)\b/.test(c)) return "node";
  if (/^(python|python3|pip|pip3)\b/.test(c)) return "python";
  return "unknown";
}

export function objectiveAllowsCrossStack(objective: string): boolean {
  const o = objective.toLowerCase();
  return /\b(next\.?js|react|node|npm|pnpm|yarn)\b/.test(o);
}
```

**Edit:** `src/agent/runtime/AgentRuntime.ts` — enforce gating inside `executeTerminalCommand(...)`.

`executeTerminalCommand` currently sanitizes and checks policy + `isSafeTerminalCommand`. citeturn30view1turn25view0

```diff
diff --git a/src/agent/runtime/AgentRuntime.ts b/src/agent/runtime/AgentRuntime.ts
@@
 import { resolveProfileDefaults } from "../../config/AgentConfig";
+import { detectProjectFingerprint, commandEcosystem, objectiveAllowsCrossStack } from "./ProjectDetector";

@@
 public async executeTerminalCommand(command: string, options?: {...}): Promise<TerminalExecResult> {
   let sanitized = command;
@@
+  // Project-type gate (prevents wrong-ecosystem commands on weak/incorrect models)
+  const fingerprint = await detectProjectFingerprint();
+  const eco = commandEcosystem(sanitized);
+  if (
+    fingerprint.type !== "unknown" &&
+    eco !== "unknown" &&
+    eco !== fingerprint.type &&
+    !objectiveAllowsCrossStack(options?.purpose === "tool" ? (options as any).objective ?? "" : "")
+  ) {
+    return {
+      exitCode: 1,
+      command: sanitized,
+      durationMs: 0,
+      timedOut: false,
+      output: `Blocked command (${eco}) for detected project (${fingerprint.type}). Signals: ${fingerprint.signals.join(", ")}`,
+    };
+  }
```

If you don’t want to change the `executeTerminalCommand` signature, store `objective` on the runtime for the active loop and refer to it here.

**Why this matters:** Your screenshot shows Django scaffolding with an “npm ENOENT” derail. This gate prevents “npm” from running unless the workspace is Node *or* the user objective explicitly indicates a Node task. citeturn25view0turn27view5

### Terminal execution reliability: preflight checks + better shell strategy

`TerminalExecutor.execute(...)` uses `spawn(command, { shell: true, cwd })` and the process may error with ENOENT when `cwd` is missing or the command isn’t resolvable. citeturn34view4turn39search18

**Edit:** `src/agent/terminal/TerminalExecutor.ts` — add preflight and use a login shell wrapper.

Minimal patch idea: replace `spawn(command, { shell: true, cwd })` with a stable shell executable + args, and validate `cwd`.

```diff
diff --git a/src/agent/terminal/TerminalExecutor.ts b/src/agent/terminal/TerminalExecutor.ts
@@
 import { spawn } from "child_process";
+import { existsSync } from "fs";
@@
 public async execute(command: string, options?: { cwd?: string; timeoutMs?: number; showInTerminal?: boolean; }): Promise<TerminalExecResult> {
   const timeout = options?.timeoutMs ?? 30_000;
-  const cwd = options?.cwd ?? this.getWorkspaceRoot() ?? undefined;
+  let cwd = options?.cwd ?? this.getWorkspaceRoot() ?? undefined;
+  if (cwd && !existsSync(cwd)) {
+    cwd = this.getWorkspaceRoot() ?? undefined;
+  }
@@
-  const child = spawn(command, {
-    cwd,
-    shell: true,
-    windowsHide: true,
-    env: process.env,
-  });
+  const { shellExe, shellArgs } = this.wrapInShell(command);
+  const child = spawn(shellExe, shellArgs, {
+    cwd,
+    windowsHide: true,
+    env: process.env,
+  });

@@
+private wrapInShell(command: string): { shellExe: string; shellArgs: string[] } {
+  // Use a login shell on POSIX so PATH matches user expectations.
+  if (process.platform !== "win32") {
+    const shell = process.env.SHELL || "/bin/bash";
+    return { shellExe: shell, shellArgs: ["-lc", command] };
+  }
+  // Windows: use cmd.exe for broad compatibility
+  const comspec = process.env.COMSPEC || "cmd.exe";
+  return { shellExe: comspec, shellArgs: ["/d", "/s", "/c", command] };
+}
```

**Rationale & citations:** Node’s child process APIs spawn sub-processes; ENOENT is emitted when the command does not exist or `cwd` is invalid. citeturn39search6turn39search18

### Tighten “safe command” defaults to protect users and reduce wrong-scaffolding

The safe terminal allowlist includes many ecosystems and even curl/wget. citeturn25view0turn14view0

**Edit:** `src/agent/runtime/TaskProtocols.ts` — remove `curl`/`wget` from the always-safe list (or require policy approval regardless), and make scaffolding commands require explicit approval unless in “bypass/full” mode.

This is both security hardening (exfil risk) and reliability: it prevents “random scaffolding” on weak models. In practice, treat scaffolding commands like installs: require explicit user consent.

Pseudo-diff (minimal shape):
```diff
diff --git a/src/agent/runtime/TaskProtocols.ts b/src/agent/runtime/TaskProtocols.ts
@@
-  // Curl/wget for fetching (non-destructive read)
-  /\bcurl\s/,
-  /\bwget\s/,
+  // Removed: curl/wget are not safe-by-default due to exfil/remote exec patterns.
```

Then, in `AgentRuntime.executeTerminalCommand`, add:
- `isScaffold = /\b(pnpm|npm|yarn)\s+create\b|\bnpx\s+create-/.test(...)`
- if `isScaffold && permissionMode !== full`, return “approval required” even if `isSafeTerminalCommand` says true.

This aligns with the comments already present around installs/verification gating. citeturn30view3turn25view0

### Extend attachments to support PDFs and image scanning

Today, `AttachmentManager` treats images/binary as “not readable” and has no PDF ingestion. citeturn33view4turn33view3

You need a dedicated “document ingestion” abstraction:

**Add:** `src/agent/attachments/DocumentIngestor.ts` (new)
- `ingest(filePath) -> { textChunks[], images[]?, meta }`
- For PDF:
  - Attempt text extraction first (PDF.js `getTextContent()` approach is standard for PDFs that have embedded text). citeturn39search27turn39search15
  - If extracted text is low/empty, treat pages as scanned images:
    - rasterize 1–N pages to PNG
    - OCR using Tesseract (CPU, slower) or
    - send as vision images to an Ollama vision model (if configured) using `messages[].images` base64. citeturn39search15turn32view0turn39search12

**Edit:** `src/agent/attachments/AttachmentManager.ts`
- Add a new `type: "pdf"` and allow reading PDFs via `DocumentIngestor`.
- Enforce limits: `maxPdfPages`, `maxPdfBytes`, `maxTotalSizeBytes`.

Because this is more involved, the immediate “best practice” path is:
- Add **PDF text extraction first**, because it’s cheap and avoids GPU. citeturn39search27turn39search15
- Add OCR/vision only as fallback and only on limited pages.

### Ensure multimodal adapters are consistent across providers

Ollama provider already converts OpenAI-style `image_url` content blocks into Ollama’s `messages[].images` base64 format, stripping the `data:` prefix from data URLs. citeturn32view0turn10view10

Key enhancement: **centralize** this conversion so OpenAI-compatible providers can also choose a compatible representation (some accept `image_url` data URLs; some do not). This prevents “works on Ollama but not cloud” mismatch.

## Performance and memory strategies for weak local models

Pulse already implements a “performanceProfile” system, with explicit low-VRAM defaults (`numCtx=4096`, planner keep-alive `0`, editor keep-alive `300`, longer timeouts, smaller token caps). citeturn16view8 It also implements an **adaptive retry** on Ollama OOM/context failures by reducing `numCtx` and max tokens and retrying. citeturn26view0

### Recommended low‑VRAM policy defaults

**Single-model policy (strongly recommended for 8GB VRAM):**
- Force `plannerModel === editorModel` under `low_vram` profile, even if the user config differs.
- Keep `plannerKeepAlive = 0` always, and consider `editorKeepAlive = 0` unless you are doing multi-turn tool loops. (Keeping models loaded uses VRAM; Ollama supports `keep_alive` in `/api/chat` to unload immediately with `0`). citeturn16view8turn32view0turn39search32

**Context sizing (num_ctx):**
- Start at 4096 for most 7B class models; drop to 2048 automatically on OOM patterns (Pulse already does a scaled reduction). citeturn16view8turn26view0turn39search32
- Couple `num_ctx` with an input-budgeter so you trim context snippets, attached-file excerpts, and tool traces deterministically before calling the model.

### Token-budgeter algorithm (pseudocode)

```text
inputs:
  num_ctx
  reserve_completion_tokens
  system_tokens
  history_messages (newest last)
  context_snippets (ranked high to low relevance)
  attached_context (ranked)
  tool_observations (newest last)

budget = num_ctx - reserve_completion_tokens - system_tokens
output_messages = [system]

# 1) Always include most recent user turn + current objective.
add(latest_user_turn)

# 2) Include minimal tool observations first (newest N).
obs_budget = min(budget * 0.15, tokens(tool_observations))
add(last_k(tool_observations, fit_in=obs_budget))

# 3) Include top context snippets until budget left < threshold.
while budget_remaining > min_threshold and snippets_remaining:
  add(next_snippet)

# 4) Add conversation history backwards until budget exhausted.
for msg in reverse(history_messages):
  if tokens(msg) > budget_remaining: break
  add(msg)

# 5) If still over budget, drop lowest-relevance snippet, then older history, then obs.
return output_messages
```

This pairs well with structured output (`format: schema`) because it reduces agent confusion and off-spec JSON on weak models, which Pulse already uses. citeturn38view0turn39search4turn39search20

### Model fallback rules

Pulse should extend beyond “retry with smaller `num_ctx`” into **model fallback** when repeated OOM or timeouts occur:

Fallback rule set:
- If error matches `/out of memory|oom|alloc/i` twice in a row → switch to a smaller model from a configured fallback list and reset `num_ctx` to 2048.
- If the model produces two consecutive “no-action” iterations → enforce deterministic bootstrap and then (if still no action) switch to a “tool-competent” model.

This complements the existing stall recovery and “noActionThreshold” concept. citeturn26view0turn16view8

### Ollama API usage examples

Pulse’s Ollama provider sends `options.num_ctx`, `keep_alive`, `format`, and `messages`, and streams output. citeturn32view0turn39search0turn39search4turn39search32

Example (curl) showing the key knobs:
- `options.num_ctx` controls context.
- `keep_alive` controls persistence (0 unloads, -1 keeps).
- `format` can be `"json"` or a JSON schema object for structured outputs. citeturn39search0turn39search8turn39search20turn39search32

## Multimodal and PDF pipeline redesign

### Image handling

Current flow:
- UI collects dropped images as `{ name, dataUrl }`. citeturn10view13  
- Runtime builds OpenAI-style multipart messages with `type:"image_url"` blocks containing the `dataUrl`. citeturn19view1turn10view10  
- Ollama provider converts those into `images: [base64]` and uses `/api/chat`. citeturn32view0turn39search0  

**Missing best practices for weak GPUs:**
- No enforced max image dimensions/bytes.
- No “image downscaler” or smart page sampling.

**Concrete recommendation:**
- Add a client-side downscaler: max 1024px long edge, JPEG quality ~0.75 for screenshots; limit to 2–3 images per request in `low_vram`.
- Add runtime-side enforcement to drop images beyond limits and emit an explicit observation.

### PDF ingestion options and trade-offs

| Approach | Works for | Quality | Perf on weak PC | Complexity | Notes |
|---|---|---|---|---|---|
| PDF text extraction (PDF.js) | Digital PDFs with embedded text | Good | Very good | Medium | Use `getTextContent()` per page. citeturn39search27turn39search15 |
| OCR (PDF.js render → Tesseract) | Scanned PDFs | Medium–Good | Poor–Medium (CPU heavy) | High | Strong fallback; page limits are essential. citeturn39search15 |
| Rasterize pages → Vision model | Scanned PDFs + complex layouts | High (if good vision model) | Depends (GPU/VRAM) | High | Requires vision-capable model; send pages as base64 images. citeturn39search12turn32view0 |

**Best-practice pipeline for Pulse:**
- Always attempt PDF text extraction first.
- If extracted text is near-empty, classify as scanned:
  - If a vision model is configured and VRAM is sufficient, do vision on 1–3 representative pages.
  - Otherwise OCR 1–3 pages with Tesseract and warn the user about performance and page limits.

### Streaming upload approach

For large PDFs/images, move from “send entire base64 in one webview message” to chunked streaming:
- UI reads the file as stream → sends chunks `{ uploadId, idx, total, bytes }`
- Extension reconstructs on disk, then ingests.
This reduces peak memory and avoids UI freezes.

## Terminal execution and permission model hardening

### Terminal failures and ENOENT reproduction

A “spawn ENOENT” can come from:
- `cwd` path does not exist → ENOENT (common with `spawn` options). citeturn39search18  
- Command is not resolvable in the process environment. citeturn39search6turn39search18  

This aligns with what your agent message described (“npm ENOENT”), and it also fits why it can happen on the extension host even if an integrated terminal can run npm (PATH mismatch). Your current executor uses `shell: true`, but still inherits extension host env without a login shell. citeturn34view4

### Approval UX flow and policy consistency

Your runtime uses centralized permission evaluation and integrates `classifyAction(...)` (good), and `executeTerminalCommand` consults policy + `isSafeTerminalCommand`. citeturn30view1turn35view1turn35view8turn25view0

However, default SAFE_ACTIONS includes terminal execution and multi-file edits, which makes “default” mode feel like bypass. citeturn35view9

**Safe defaults recommendation:**
- In `default` mode: auto-approve `file_read`, `git_read`, `workspace_scan`, `search_files`, `diagnostics`.
- Require explicit approval for: `terminal_exec`, `file_write`, `multi_file_edit`, `git_write`.
- Implement “trust for session” when a user approves a category once (PermissionPolicy already supports this). citeturn35view2

## Verification and scaffolding reliability

### Verification selection logic

Right now, `VerificationRunner` only counts diagnostics. citeturn12view0 That’s useful but not sufficient for scaffolding tasks (Django startproject, dependency installs, migrations).

**Add a project verifier that chooses commands based on detected stack:**
- Django: `python -m pip install -r requirements.txt` (optional), `python manage.py check`, `python manage.py test`
- Python (non-Django): `python -m compileall .`, `pytest -q`
- Node: use package manager scripts if present; otherwise `npm test` only if `package.json` exists.

Also: if a command requires a tool not present, return a failure observation early (executable preflight), so the loop can pick an alternative rather than stopping.

### Safe scaffolding prompts

Even with schema enforcement, weaker models can select wrong scaffolding commands because scaffolding is explicitly allowlisted as “safe.” citeturn25view0turn14view0

**Fix strategy:**
- Move scaffolding commands into an “approval required” bucket unless:
  - the workspace already signals that ecosystem, or
  - the user explicitly asked for it (objective classification).

## Tests, CI, documentation templates, and roadmap

### Tests and CI to add

Given the failure modes are mostly agent-loop correctness and terminal reliability, focus on:
- Unit tests (pure TS):
  - `parseTaskResponse` robustness for local-model patterns (`action/actions`, `tool_calls`, etc.). citeturn37view8  
  - `isSafeTerminalCommand` negative cases: `curl`, redirections, subshells. citeturn25view0  
  - Project detector fingerprints for mixtures of files.
  - TODO binding logic: toolCall(todoId) → observation(ok) marks done.
- Integration tests (mocked):
  - Tool execution pipeline with a mocked `TerminalExecutor` returning ENOENT and verifying agent continues with recovery context (rather than exiting with TODO stuck).
- Low-VRAM validation protocol:
  - Force `performanceProfile=low_vram` and run with a small coder model; verify no OOM and deterministic bootstrap triggers.

### Developer prompt template for GPT‑5.4 implementer

Use this as the PR-driving prompt in your agent-of-agents:

> You are implementing reliability and low‑VRAM performance upgrades in the Pulse VS Code extension repo.  
> Goals: (1) deterministic TODO progress bound to tool results, (2) robust terminal execution with preflight and correct shell env, (3) project-type gating to prevent wrong-ecosystem commands (npm in Django), (4) PDF + image ingestion pipeline with limits and optional OCR/vision, (5) safer permission defaults with session trust.  
> Requirements:  
> - Modify `TASK_RESPONSE_SCHEMA` to require `toolCalls[].todoId` and add optional `activeTodoId`. Update parsing normalization to accept `todo_id` aliases.  
> - Update `AgentRuntime` loop to update TODO statuses when tool calls succeed/fail using todoId mapping; emit TODO updates after each iteration.  
> - Add `ProjectDetector` and enforce command ecosystem gating before executing terminal commands unless objective explicitly requests cross-stack scaffolding.  
> - Harden `TerminalExecutor`: validate cwd exists; run commands in login shell (`bash -lc`/`cmd /c`); add clearer ENOENT classification; add kill-tree on timeout.  
> - Extend attachments: implement PDF text extraction; add OCR/vision fallback behind a config flag; enforce file/page/size limits and streaming upload strategy.  
> - Add unit tests for parsing, safe-command policy, project detector, and todo-binding.  
> Acceptance criteria:  
> - Repro case “Django REST API scaffolding” completes without running npm unless user explicitly requests Node tooling.  
> - No TODO remains stuck in-progress when corresponding tool calls succeed.  
> - Terminal ENOENT errors clearly report whether it’s missing executable vs missing cwd, and the agent continues with a recovery iteration.  
> - PDF upload returns extracted text for text PDFs; scanned PDFs fall back to OCR/vision with page limits.  
> - Default permissions do not auto-run terminal commands unless user approves or bypass is enabled.  
> Provide a PR checklist and ensure all changes are documented in README.

### Prioritized roadmap with effort estimates

Short-term (high impact, low risk):
- Deterministic TODO binding (`todoId` schema + runtime updates): **6–10 hours**
- Terminal preflight + shell wrapper + cwd validation: **6–12 hours**
- Project detector + command gating: **6–10 hours**

Medium-term:
- Permission default redesign + UX for “trust this category”: **6–12 hours**
- Project-aware verification runner executing real commands: **8–16 hours**
- Client-side image resizing + limits: **4–8 hours**

Long-term:
- Full PDF pipeline with OCR/vision fallback + streaming upload: **16–40 hours**
- Comprehensive CI + integration test harness for VS Code extension behaviors: **12–30 hours**

### Reproduction commands and remediation steps for npm ENOENT and terminal failures

Reproduce `cwd`-related ENOENT:
- Configure a terminal command with `cwd` pointing to a nonexistent path and run any command; `spawn` can emit ENOENT when `cwd` does not exist. citeturn39search18  
Remediation:
- Add `cwd` validation + fallback to workspace root (patch above).

Reproduce missing executable:
- Run `npm --version` on a system without Node/npm; command resolution fails (often as “not found” or ENOENT depending on environment). Node child_process behavior and errors are documented broadly. citeturn39search6turn39search18  
Remediation:
- Preflight `command -v npm`/`where npm` before running, and if missing, return an actionable observation (“Install Node/npm or switch to Python-only scaffolding”).

### References and prioritized sources

Primary platform docs:
- entity["organization","Ollama","local llm runner"] API `/api/chat` (messages, streaming). citeturn39search0  
- Ollama structured outputs and JSON-schema `format`. citeturn39search20turn39search4  
- Ollama `keep_alive` and `num_ctx` guidance (FAQ). citeturn39search32  
- Node.js `child_process` reference (spawn, processes, streams). citeturn39search6  
- entity["company","Microsoft","software company"] VS Code Extension API reference. citeturn39search1  

PDF/OCR background (implementation guidance):
- PDF text extraction with PDF.js (conceptual approach). citeturn39search27turn39search15  

Repo code sources (most load-bearing):
- Agent loop, stall recovery, OOM context reduction, verification auto-run hook. citeturn26view0turn28view2  
- Performance profiles and low_vram defaults. citeturn16view8  
- TASK_RESPONSE_SCHEMA and intent (local model reliability). citeturn38view0turn38view2  
- Ollama multimodal adapter (dataUrl → base64 images[]). citeturn32view0turn10view10  
- Terminal executor implementation. citeturn34view4turn34view6  
- Attachment limitations (no PDF, null for images/binary). citeturn33view3turn33view4  
- Permission policy SAFE_ACTIONS default auto-approvals. citeturn35view9  

### Mermaid flowchart for redesigned agent loop

```mermaid
flowchart TD
  A[Start task] --> B[Detect project fingerprint]
  B --> C[Bootstrap evidence: workspace_scan + problems]
  C --> D[Create plan (planner model)]
  D --> E[If low_vram: unload planner model]
  E --> F[Iteration loop]
  F --> G[Model JSON (schema) includes activeTodoId + toolCalls(todoId)]
  G --> H[Execute tool calls with preflight + permissions]
  H --> I[Update TODO statuses deterministically from tool outcomes]
  I --> J{All TODOs done?}
  J -- yes --> K[Optional verification workflow]
  J -- no --> L{No-action stall?}
  L -- yes --> C
  L -- no --> F
  K --> M[Summarize + persist]
  M --> N[End]
```