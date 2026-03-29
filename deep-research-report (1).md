# Deep research report on fixing and upgrading the Pulse agent for low‑VRAM local models

## What’s failing now and why it happens

A core failure mode behind the “npm ENOENT” situation is that Pulse automatically runs verification commands based on **generic keywords** in the user’s objective (for example: *build*, *compile*, *lint*, *test*), even when the workspace is not a Node/JavaScript project. In the current runtime, `autoRunVerification` can trigger verification if **either** edits were made **or** the objective matches a keyword regex; this can happen during tasks like “build a Django REST API”. citeturn42view5

When that verification path runs, Pulse collects verification commands in a way that can fall back to `npm test` / `npm run build` **even if there is no `package.json`**. Specifically, `collectVerificationCommands()` checks for scripts in `package.json`, but if those are missing it still falls back to an objective keyword match and returns npm-based defaults. citeturn22view1turn49view0

Separately, Pulse’s scaffolding guidance is currently biased toward Next.js in an overly broad way: it triggers a “SCAFFOLDING” section if the objective matches `/next\.?js|next-app|scaffold|blog/i`. That last term (`blog`) makes this scaffolding hint appear for **any blog task**, including Django blog APIs, and it explicitly suggests Next.js commands and pnpm/npm behaviors. citeturn42view2turn38view0  
This strongly increases the probability that both cloud and local models will attempt Node-based commands in Python tasks.

Finally, the “task stalls with first TODO in progress” symptoms are consistent with two interacting behaviors:

- The runtime **auto-advances TODOs deterministically** after tool calls (`advanceTodoStatuses()`), but it only marks a TODO as `done` if the model had already set one to `in-progress` when successful work occurred. If no TODO was `in-progress` yet, Pulse makes the first pending TODO `in-progress` but does not mark anything as done (so you see “0/5” done). citeturn50view0turn49view1  
- If the first iteration ends up dominated by a failing verification command (example: `npm ...` not found), you may exit the loop with no “done” items visible. citeturn42view5turn22view1

## Making local models reliable on weak PCs

Pulse already contains a valuable foundation for low-VRAM operation:

- A **performance profile** system with conservative defaults for `"auto"` and an explicit `"low_vram"` mode (e.g., `numCtx: 4096`, longer cold-start budgets, and model keep-alive tuning). citeturn16view0
- An Ollama provider that supports **`num_ctx`**, **`keep_alive`**, streaming, and has a best-effort `unloadModel()` method to free VRAM when needed. citeturn14view0turn14view2
- In agent mode, Pulse will unload the planner model in Ollama when the profile says planner keep-alive is `0` and planner/editor differ. citeturn38view0turn41view0
- Pulse uses an explicit **JSON Schema (`TASK_RESPONSE_SCHEMA`)** for structured outputs with Ollama to reduce malformed JSON from local models. citeturn22view3turn12view0

However, weak-PC reliability still needs **token-budget enforcement** and **adaptive degradation** to avoid hangs/timeouts and “no action” loops.

Why token budget enforcement matters: Ollama’s docs explain that context length increases memory usage, and defaults are VRAM-dependent (for <24 GiB VRAM, it defaults to ~4k context). citeturn43view0turn43view1  
Pulse does pass a smaller `num_ctx` on low-VRAM profiles, but the runtime may still assemble prompts with multiple 4k snippets + tool logs + conversation context; without active trimming, it risks exceeding practical budgets on 4k contexts and causing slowdowns or failures under constrained VRAM. citeturn41view0turn42view4

Recommended engineering upgrades for low-VRAM local models:

Build a “prompt budgeter” that:
- Estimates tokens via a cheap heuristic (e.g., `chars / 4`) and trims in priority order: tool logs → workspace snippets → attached context → older conversation summary.
- Uses profile defaults to cap how many snippets are included (for low_vram, prefer 2–3 relevant files instead of 6). This integrates cleanly with Pulse’s existing `resolveProfileDefaults()` plumbing. citeturn16view0turn41view0

Add “adaptive context fallback” on Ollama failures:
- If Ollama returns an error that suggests context/memory pressure, retry the same call with: smaller `num_ctx`, reduced snippets, and a smaller `maxTokens`.
- If the model keeps failing, auto-switch to `fallbackModels` (Pulse already has `fallbackModels` in config). citeturn16view0turn14view0

Keep-alive strategy by profile should be more explicitly “single-model-first” on weak machines:
- Use `useSingleModel` in low_vram more aggressively: if planner and editor are different, consider forcing planner calls to reuse the editor model for that session (or offer this as a low_vram option). You already have the scaffolding in `ProfileDefaults.useSingleModel`. citeturn16view0turn41view0

Also, keep_alive is a key knob for local performance: Ollama documents that `keep_alive` controls how long a model stays in memory, with `0` unloading immediately and negative values keeping models loaded. citeturn43view1turn14view0  
Pulse already sets keep-alive per profile; the recommended enhancement is not changing the knob, but making it **reactive**: if VRAM-constrained systems are failing to load models, default editor keep-alive should drop from 300 seconds down to 0 for those cases, and rely on smaller models. citeturn16view0turn14view2

## Fixing the task loop, TODO state, and “stalls”

Pulse’s current loop is structurally solid (multi-iteration agent loop, deterministic bootstrap when no actions occur, structured outputs on Ollama, and automatic TODO advancement). citeturn23view5turn23view1turn22view3  
But the observed UX (“first TODO in progress and then nothing”) typically comes from a mismatch between **model-controlled TODO state** and **runtime-controlled TODO state**, plus early termination due to misfired verification.

Key improvement: make TODO completion less dependent on the model setting `in-progress` correctly.

Right now, `advanceTodoStatuses()` completes the `in-progress` TODO when there was successful work, and ensures there is always one `in-progress` TODO if pending remain. citeturn49view1turn50view0  
But if the model never marked a TODO as `in-progress` before the first successful tool call, Pulse won’t mark anything as `done`, so “0/5” persists. citeturn49view1turn50view0

Recommended change (small, high-impact):
- If `hasSuccessfulWork` and **no TODO is `in-progress`**, promote the first `pending` TODO to `done`, then set the next `pending` to `in-progress`. This matches the user-visible expectation that a successful iteration “completed something” even if the model forgot state.

Example patch (conceptual):

```ts
private advanceTodoStatuses(todos: TaskTodo[], observations: TaskToolObservation[]): void {
  if (todos.length === 0) return;

  const hasSuccessfulWork = observations.some((o) => o.ok);
  const inProgress = todos.find((t) => t.status === "in-progress");
  const pending = todos.filter((t) => t.status === "pending");

  if (hasSuccessfulWork) {
    if (inProgress) {
      inProgress.status = "done";
    } else if (pending.length > 0) {
      // If the model never set in-progress, assume we just executed the first pending item.
      pending[0].status = "done";
    }
  }

  const stillPending = todos.filter((t) => t.status === "pending");
  if (stillPending.length > 0 && !todos.some((t) => t.status === "in-progress")) {
    stillPending[0].status = "in-progress";
  }

  this.emitTodoUpdate(todos);
}
```

A larger (more “Codex-like”) redesign is to make the runtime drive the TODO executor:
- Runtime selects the active TODO.
- Model returns tool calls for **only that TODO**, not the entire TODO list.
- Runtime marks TODO done when tool results satisfy its acceptance criteria.

This requires evolving the schema: add a required `activeTodoId` and require each tool call to include `todoId`. The repo already uses a JSON schema for tool calls via `TASK_RESPONSE_SCHEMA`, so you can enforce this reliably for Ollama. citeturn12view1turn22view3  
This is one of the highest-leverage changes for weak local models, because it reduces cognitive load and prompt size: the model only sees the current step and relevant tool outputs.

## Terminal execution and permission handling

### The real root cause of “npm ENOENT” in Django tasks

There are two independent causes:

- Auto-run verification can decide to run `npm ...` simply because the objective contains “build/compile/test…”. citeturn42view5turn22view1  
- The scaffolding hint is triggered by `blog`, which pushes Next.js/npm tooling into the system prompt for unrelated stacks. citeturn42view2turn38view0

Both must be fixed to stop accidental `npm` calls on Python tasks.

### Terminal reliability

Pulse’s terminal executor uses `child_process.spawn()` with `shell: true` and captures stdout/stderr to return output. citeturn9view0  
This is a sane approach for a coding agent because it allows the model to read output and retry.

But you should add two missing robustness layers:

- **Executable preflight**: before running `npm test` (or `python -m pytest`), check if the executable exists in PATH and provide a clear tool observation suggesting fallback commands if missing. This prevents repeated “command not found” loops.
- **Environment parity**: on Windows in particular, VS Code extension host PATH can differ from the user’s interactive shell PATH (common after installing tools). Terminal execution should detect command-not-found and propose “restart VS Code” as a remediation, not just “install npm”.

### Permission model correctness

Your permission policy *classification* is already designed to treat installs as sensitive:
- `classifyAction()` identifies `npm install`, `pip install`, etc. as `"package_install"`. citeturn18view0
- The UI copy claims “Prompt for deletes & installs”. citeturn29view0turn18view0

But `executeTerminalCommand()` currently evaluates permissions using a **hardcoded** action `"terminal_exec"` rather than classifying the command. That means install commands can be auto-approved as “terminal exec,” contradicting the policy intent. citeturn36view2turn18view0

Fix (minimum patch):
- Replace the permission request action with `classifyAction(sanitized)`.

```ts
const action = classifyAction(sanitized);
const decision = this.permissionPolicy.evaluate({
  action,
  description: `Run terminal command: ${sanitized}`,
});
```

Then adjust the “safe command” logic to avoid treat installs as auto-run just because they match `isSafeTerminalCommand()`. Right now, your safe-command allowlist includes package manager install commands (npm install, pip install, etc.). citeturn13view0  
If you want “prompt for installs,” you should either:
- Remove install patterns from `isSafeTerminalCommand()`, or
- Keep them “safe” in the destructive sense, but still require approval for `"package_install"`.

Finally, add a user-visible approval flow for commands that are blocked by policy. Today, blocked commands return `null` and show up as “Terminal command was blocked,” with no in-chat prompt to approve once/trust for session. citeturn36view2turn37view0  
The webview already supports approval UX for pending edits; extend the same pattern to terminal approvals. citeturn30view2turn36view3

## File, image, and PDF attachments that actually work

### What works today

The sidebar supports attaching and dropping files, and it separately supports “dropImage” events that store a base64 `dataUrl` and forward it to the runtime on the next task. citeturn30view2turn28view0

However, there are two major gaps.

### Gap one: Ollama vision message format mismatch

Pulse represents images using OpenAI-style multi-part message content with `{ type: "image_url", image_url: { url: ... } }`. citeturn31view0turn26view0  
But Ollama’s `/api/chat` vision support expects base64 images in **`messages[].images`**, not OpenAI `image_url` blocks. citeturn33view0turn33view1  
So even if the UI successfully sends images, Ollama models may not receive them in a usable way.

Fix: in `OllamaProvider.chat()`, transform messages so that:
- `content` becomes the concatenation of text parts
- `images` becomes an array of base64 strings extracted from `data:` URLs (strip the prefix)

Conceptual adapter:

```ts
function toOllamaMessages(messages: ChatMessage[]): any[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };

    const parts = m.content;
    const text = parts.filter(p => p.type === "text").map(p => p.text ?? "").join("\n");
    const images = parts
      .filter(p => p.type === "image_url")
      .map(p => (p.image_url?.url ?? ""))
      .filter(Boolean)
      .map((url) => url.startsWith("data:")
        ? url.split(",")[1] ?? ""   // base64 payload
        : url                       // if you later allow raw base64
      )
      .filter(Boolean);

    return { role: m.role, content: text, images: images.length ? images : undefined };
  });
}
```

This aligns with Ollama’s documented payload shape for vision. citeturn33view0turn33view1

### Gap two: PDF and “scanning”

You already have an `AttachmentManager` that classifies extensions and enforces limits, but it treats non-text as `binary` and returns `content: null`, and PDF isn’t considered a readable text extension. citeturn25view0  
Separately, the runtime’s attached context loader reads files as UTF‑8 snippets via `WorkspaceScanner.readContextSnippets()`, which won’t extract meaningful text from PDFs and image-based documents. citeturn26view3turn40view0

To support “PDF view/edit app” workflows and make attachments genuinely useful:

- Add a document ingestion layer that detects `.pdf` attachments and extracts text (first N pages), with a clear “truncated” marker.
- For scanned PDFs (images), provide two fallback paths:
  - If a vision model is available, convert the pages to images and send via vision. (Heavier, but accurate.)
  - If no vision model, optionally OCR through a local OCR engine (configurable, off by default for performance).

The best practice is to keep this optional and **profile-aware**:
- In `low_vram`, default to text extraction for PDFs and avoid rasterizing pages unless explicitly requested.

## Recommended prompts, patches, and regression tests

### Prompt corrections to stop wrong-tooling bias

The current system prompt injects Next.js scaffolding hints whenever the objective includes “blog”, which is overly broad. citeturn42view2turn38view0  
Change this to either:
- Trigger Next.js scaffolding only when Next.js is explicitly referenced, **or**
- Trigger scaffolding based on detected project type (Node vs Python vs other).

A practical prompt fragment design is:

- **Base agent prompt**: tool rules, JSON-only output requirement, one-step tool usage.
- **Stack modules** injected by project detector:
  - Node module: pnpm/npm/yarn scaffolding and verification choices.
  - Python/Django module: `python -m venv`, `pip install -r requirements.txt`, `pytest`, `python manage.py test`, etc.

This reduces hallucinated npm usage in Django tasks, especially on smaller local models.

### Code-level fixes that directly address your reported failures

- Make verification language-aware and never default to npm commands without evidence of a Node project:
  - Only generate npm scripts if `package.json` exists **and** `npm` (or pnpm/yarn) is available.
  - For Python projects, look for `pyproject.toml`, `requirements.txt`, `manage.py`, and then choose Python verification commands.
  - If nothing is detected, run diagnostics-only and stop there.

This directly addresses the npm ENOENT failures caused by generic objective keywords. citeturn22view1turn42view5

- Fix terminal permission classification by using `classifyAction(command)` inside `executeTerminalCommand()`. citeturn18view0turn36view2

- Fix Ollama multimodal interop by converting `image_url` blocks into `messages[].images` base64 for `/api/chat`. citeturn31view0turn33view0turn14view0

- Improve TODO advancement to show progress even when the model forgets to set `in-progress` early. citeturn49view1turn50view0

### A “Copilot/Codex-style” improvement prompt you can embed as a developer instruction

Below is a copy-paste “internal developer prompt” you can use inside Pulse’s system prompt builder as a high-level directive (keep it stable; inject stack-specific modules separately):

```text
You are Pulse, a VS Code coding agent. Operate like an autonomous engineer.
You MUST return ONLY valid JSON matching the provided schema. No markdown.

Execution policy:
- Always pick exactly ONE active TODO and progress it with tool calls.
- Read existing files before editing. Never guess file contents.
- Prefer tool calls to gather evidence: list_dir, search_files, read_files.
- For terminal commands: run the minimal command, then ALWAYS inspect output.
- If a terminal command fails, diagnose from output and propose the smallest fix, then retry.
- Do not run package installs (npm/pip/etc.) without explicit approval or clear user intent.
- Do not assume the tech stack. Detect it from workspace evidence (package.json, pyproject.toml, requirements.txt, manage.py, etc.).
- If the environment is missing a command (ENOENT / not recognized), propose a non-terminal fallback (direct file creation/edits) whenever possible.
- Keep prompts small: include only the most relevant files and the latest tool results.
```

This prompt aligns with the repo’s structured-output approach and tool loop, but removes the “blog → Next.js” bias and explicitly forces stack detection before issuing installs/tests. citeturn42view2turn22view1turn12view1

### Regression tests you should add

To prevent these failures from returning, add automated tests around:

- Verification command selection:
  - Objective contains “build Django REST API” but no package.json → must not emit npm commands. citeturn22view1turn42view5
- Permission classification:
  - `npm install` should classify as `"package_install"` and require approval in default mode. citeturn18view0turn36view2
- Ollama vision transformation:
  - A message containing `image_url` parts should be transformed into Ollama `images[]`. citeturn31view0turn33view0turn14view0
- TODO advancement:
  - After a successful tool call, at least one TODO should become `done` even if none were `in-progress` at start (with your improved heuristic). citeturn49view1turn50view0

These fixes collectively address the exact failure shown in your screenshot (npm ENOENT halting Django scaffolding), strengthen local-model performance under low VRAM, and make file/image/PDF attachment workflows functional with Ollama’s real API contracts. citeturn22view1turn33view0turn43view0turn30view2