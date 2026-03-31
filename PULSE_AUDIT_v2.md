# Pulse AI Agent — Full Code Audit Report (v0.0.92)

> **Date:** March 31, 2026  
> **Repo:** `OchiengPaul442/pulse`  
> **Focus:** "Extension appears disabled — Ollama not detected, past conversations don't load"  
> **Verdict:** Several regressions and new bugs introduced during the refactor. Some audit-v1 issues were fixed well. New structural problems were introduced. The agent-disabled symptom has four distinct root causes documented below.

---

## Part 1 — Why the Extension Appears Disabled / Broken on Startup

These are the bugs directly causing the reported symptoms.

---

### BUG-01 [CRITICAL] — `activate()` Has No Error Handling — Any Startup Failure Silently Kills the Extension

**File:** `src/extension.ts`

```ts
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ...
  await runtime.initialize();  // ← if this throws, the whole extension dies silently
  // ...
}
```

`activate()` is a bare `async` function with zero `try/catch`. If **any** of these throw — `bootstrapStorage`, `runtime.initialize()`, or the WebSearchService constructor — VS Code catches the unhandled rejection and marks the extension as failed. The sidebar never registers. The user sees nothing, no error message, no indication of what happened.

`runtime.initialize()` calls `provider.healthCheck()` then `provider.listModels()`. On a cold Ollama start or a slow machine, `listModels()` can time out (5s default). If it throws for any reason, the entire extension activation fails.

**Fix — wrap the entire body:**
```ts
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = createLogger();
  context.subscriptions.push({ dispose: () => logger.dispose() });
  try {
    // ... all existing code ...
    logger.info("Pulse extension activated.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Pulse failed to activate: ${msg}`);
    void vscode.window.showErrorMessage(
      `Pulse failed to start: ${msg}. Check Output > Pulse for details.`
    );
    // Still register the sidebar with a degraded state so the user sees something
    // instead of a completely blank panel.
  }
}
```

---

### BUG-02 [CRITICAL] — `ImprovementEngine` Storage Is Bootstrapped Without Required Fields — Causes `undefined` Crashes at Runtime

**File:** `src/db/StorageBootstrap.ts` (line 51) vs `src/agent/improvement/ImprovementEngine.ts` (lines 87–90)

The storage bootstrap creates `improvement.json` with:
```ts
await ensureJsonFile(improvementPath, { outcomes: [] });
```

But `ImprovementState` requires three fields:
```ts
interface ImprovementState {
  outcomes: TaskOutcome[];
  strategies: LearnedStrategy[];   // ← MISSING from initial file
  reflections: SelfReflection[];   // ← MISSING from initial file
}
```

When `ImprovementEngine.load()` reads the existing `{ outcomes: [] }` file (for any existing install), `state.strategies` and `state.reflections` are `undefined`. Any call to `state.strategies.find(...)`, `state.reflections.some(...)`, or `evolveStrategies()` will throw `TypeError: Cannot read properties of undefined`.

This crash happens inside `selfReflectBackground()` which runs after every task. Since it's fire-and-forget, the error is swallowed — but it means **self-improvement never works and every post-task write to the improvement store fails silently**.

More critically, `getStats()` and `getOptimizedBehaviorHints()` are called during task execution. If `load()` returns a state with undefined arrays and those methods don't guard against it, you get runtime crashes inside the agent loop.

**Fix — add a migration guard in `load()`:**
```ts
private normalizeState(raw: Partial<ImprovementState>): ImprovementState {
  return {
    outcomes: raw.outcomes ?? [],
    strategies: raw.strategies ?? [],
    reflections: raw.reflections ?? [],
  };
}
```

And fix the bootstrap:
```ts
await ensureJsonFile(improvementPath, { outcomes: [], strategies: [], reflections: [] });
```

---

### BUG-03 [CRITICAL] — `StreamBroadcaster` Is Wired for Registration But All Emission Still Goes Through Duplicate Private Methods in `AgentRuntime`

**File:** `src/agent/runtime/AgentRuntime.ts` — all `private emit*()` methods

The refactor extracted `StreamBroadcaster` correctly for _registration_ (callbacks are set on the broadcaster). But `AgentRuntime` still has **47 calls** to its own private `emitProgress`, `emitFilePatch`, `emitFilePatched`, `emitTerminalRun`, `emitTodoUpdate`, `emitFilesChanged`, and `emitTokenUpdate` — which fire the **old direct `this.progressCallback?.()`** path, not the broadcaster.

Meanwhile `ToolExecutor` correctly uses `this.broadcaster.emitTerminalRun()`, `this.broadcaster.emitFilePatched()`, and `this.broadcaster.emitProgress()`.

The result: **two separate callback chains exist**. The broadcaster has the registered callback from the sidebar. The `AgentRuntime` private methods call `this.progressCallback` directly, which is also set — but `emitTokenUpdate` calls `this.tokenCallback` directly while the broadcaster's `emitTokenUpdate` calls the token callback registered on the broadcaster. Both callbacks point to the same function right now (because `setProgressCallback` sets both), but this is fragile and breaks the moment the broadcaster is used exclusively.

**Actual impact now:** The broadcaster's `emitTokenUpdate(consumed, budget)` signature takes two parameters. `AgentRuntime.emitTokenUpdate()` calls `this.tokenCallback({ consumed, budget, percent })` computing `percent` inline. These are not the same call. If the callback reference ever diverges (e.g. after a hot-reload), token updates stop working.

**Fix:** Delete all private `emit*` methods from `AgentRuntime`. Route all emission through `this.broadcaster.*`.

---

### BUG-04 [HIGH] — Session Restore Depends on `runtimeSummary` Arriving Before the Webview Is Ready — Race Condition Causes Blank Chat on Startup

**File:** `media/sidebar.js` (line 929–931) + `src/views/PulseSidebarProvider.ts`

The session auto-restore works like this:
1. Sidebar JS fires `webviewReady` + `loadDashboard` on boot
2. Extension host calls `pushState()` which fetches summary + sessions
3. Sidebar receives `runtimeSummary` → `renderSummary()` → if `s.activeSessionId && !autoRestoreSessionAttempted`, fires `openSession`

**The race:** `pushState()` calls `runtime.summary()` which calls `sessionStore.getActiveSession()`. But `runtime.initialize()` already set the active session. So the session ID should be there. The problem is timing:

The sidebar HTML is generated by `buildHtml()` using the initial `summary` fetched via `void this.runtime.summary().then(...)`. This is async — the HTML might be built with `initialSummary = null` if the `.summary()` call hasn't resolved yet when `buildHtml` is called with the catch path (`null`).

With `null` initial summary, the webview bootstraps with no `initialSummary`, and `renderSummary` isn't called on boot. The first `pushState()` must complete and deliver `runtimeSummary` over the message channel. If there's any hiccup in that first `postMessage` (e.g., webview not yet accepting messages), the session is never restored.

The proactive `setTimeout(() => void pushState(), 250)` partially mitigates this, and the 800ms / 3000ms pings in the JS partially cover it too. But this is defence-in-depth on top of a fundamentally broken initialization order.

**Fix:** In `resolveWebviewView`, wait for the HTML to be set before registering message handlers, and guarantee an initial `pushState()` only after `webviewView.webview.html` has been assigned:
```ts
const summary = await this.runtime.summary().catch(() => null);
webviewView.webview.html = this.buildHtml(webviewView.webview, summary);
// Now register handlers and push state
```
Currently the HTML assignment is inside a `void ... .then(...)` — it's fire-and-forget. Handlers are registered before HTML is set.

---

### BUG-05 [HIGH] — `truncateAfterMessage` Has Inverted `includeMessage` Logic

**File:** `src/agent/sessions/SessionStore.ts` (line 165–186)

```ts
found.messages = found.messages.slice(
  0,
  includeMessage ? index : index + 1,  // ← INVERTED
);
```

The parameter is named `includeMessage`. When `includeMessage = true`, the intent is to **include** the message at `index` in the truncated result. `slice(0, index)` **excludes** the element at `index`. When `includeMessage = false`, `slice(0, index + 1)` **includes** it.

The logic is backwards. Call sites:
- Edit path: `truncateAfterMessage(id, msgId, false)` → should keep message, gets `slice(0, index+1)` → correct by accident  
- Retry path: `truncateAfterMessage(id, msgId, true)` → should remove message, gets `slice(0, index)` → correct by accident

Both call sites happen to work because both pass the opposite of what the parameter name implies. This is a ticking time bomb — any new call site following the documented semantics will produce silent data corruption.

**Fix:**
```ts
// Rename parameter to removeMessage for clarity, or fix the logic:
found.messages = found.messages.slice(0, includeMessage ? index + 1 : index);
```

---

### BUG-06 [HIGH] — `onStartupFinished` Activation Event Means Extension Loads After VS Code UI Is Painted — User Sees Blank Sidebar for Several Seconds

**File:** `package.json` (line 27)

```json
"activationEvents": ["onStartupFinished"]
```

`onStartupFinished` fires after VS Code has fully started — meaning after all extensions have activated and the editor is idle. For users who open a workspace directly, this can be **3–8 seconds** after the sidebar panel is visible. During that window, the sidebar shows nothing because the webview provider isn't registered yet.

The correct event for a sidebar extension is:
```json
"activationEvents": ["onView:pulse.sidebar"]
```

This activates the extension exactly when the sidebar panel is first shown, with no unnecessary delay.

Alternatively, VS Code 1.74+ supports omitting `activationEvents` entirely for extensions that declare view contributions — VS Code auto-activates them on view open. But `onStartupFinished` is specifically wrong here.

---

## Part 2 — Remaining Issues from Previous Audit (Status Check)

| Previous Issue | Status |
|---|---|
| Streaming broken in agent mode (BUG-01 v1) | ✅ **FIXED** — `emitStreamChunk` now called in agent loop `onChunk` |
| AgentRuntime God Object 5,460 lines | ✅ **Partially fixed** — extracted `PathResolver`, `ProjectDetector`, `StreamBroadcaster`, `ToolExecutor`. Now 4,560 lines. Still too large but improved |
| Pre-flight operations not parallel | ✅ **FIXED** — `runAgentWorkflow` now includes `sessionStore.getSession` in the single `Promise.all` |
| `batch_edit` first-occurrence only | ✅ **FIXED** — now uses `replaceAll` with whitespace normalization fallback |
| `MemoryStore` race condition | ✅ **FIXED** — `writeQueue` added |
| Self-learn loop no backpressure | ✅ **FIXED** — interval increased to 120s, concurrency guard added |
| Conversation history drops assistant messages | ✅ **FIXED** — both user and assistant messages now summarized |
| Silent tool call truncation | ✅ **FIXED** — tool failure retry budget with hard-stop per tool added |
| Planner silently falls back | ✅ **FIXED** — `isFallback` flag propagated, progress event emitted |
| `existsSync` blocking call | ✅ **FIXED** — `ProjectDetector` uses async `vscode.workspace.fs.stat` |
| `reconcileTodoProgress` masks regressions | ✅ **FIXED** — allows regression when model provides explicit detail |

---

## Part 3 — New Issues Introduced by the Refactor

---

### BUG-07 [HIGH] — `AgentRuntime` Registers Callbacks on Both Itself and `StreamBroadcaster` — Dual State

**File:** `src/agent/runtime/AgentRuntime.ts` (lines 182, 287–303)

`AgentRuntime` still stores `this.progressCallback`, `this.tokenCallback`, and `this.streamCallback` as private fields. `setProgressCallback()` sets both `this.progressCallback` AND `this.broadcaster.setProgressCallback(cb)`. This means two objects hold the same callback reference.

When `AgentRuntime` private `emit*` methods fire, they use `this.progressCallback`. When `ToolExecutor` fires events, it uses `this.broadcaster.emitProgress`. If these ever diverge (e.g., if `setProgressCallback(null)` is called to unregister), only one side gets nulled.

This is a latent consistency bug. The broadcaster pattern was added but the old pattern wasn't removed.

---

### BUG-08 [HIGH] — `ToolExecutor.executeToolCalls` Still Silently Truncates to 5 Tool Calls

**File:** `src/agent/runtime/ToolExecutor.ts` (line 82–94)

```ts
public async executeToolCalls(toolCalls: TaskToolCall[], ...): Promise<TaskToolObservation[]> {
  const limitedCalls = toolCalls.slice(0, 5);
  // ...
}
```

The truncation was carried over from the old code. If the model issues 6+ tool calls in one turn, the last ones are silently dropped. The model never learns they were dropped and produces incorrect follow-up reasoning. This was flagged in v1 audit as unresolved.

**Fix:** For each dropped call, append a synthetic failed observation:
```ts
for (let i = 5; i < toolCalls.length; i++) {
  observations.push({
    tool: toolCalls[i].tool,
    ok: false,
    summary: `Tool call dropped: maximum 5 calls per turn. This call was not executed.`,
  });
}
```

---

### BUG-09 [MEDIUM] — `StreamBroadcaster` Is Partially Unused — `ToolExecutor` Uses It, `AgentRuntime` Doesn't

As documented in BUG-03 and BUG-07, `StreamBroadcaster` is only used by `ToolExecutor`. `AgentRuntime` still emits directly via `this.progressCallback`. This means the refactor is half-done and creates confusion about which path is authoritative.

The `StreamBroadcaster` class has `emitProgress`, `emitFilePatch`, `emitFilePatched`, `emitTerminalRun`, `emitTodoUpdate`, `emitFilesChanged`, `emitReasoningChunk`, `emitReasoningPulse`, and `emitTokenUpdate` — all fully implemented — but most are never called from `AgentRuntime`.

---

### BUG-10 [MEDIUM] — `ToolExecutor` Constructor Accepts `TerminalOutputCallback` Indirectly Through `StreamBroadcaster` But Runtime Wires It Separately

**File:** `src/agent/runtime/AgentRuntime.ts` (lines 353, 403) + `ToolExecutor`

`AgentRuntime.setTerminalOutputCallback()` sets both `this.terminalOutputCallback` (unused — no field with that name exists anymore in AgentRuntime) and `this.broadcaster.setTerminalOutputCallback()`. The `ToolExecutor` uses `this.broadcaster.emitTerminalOutput(...)`. This chain is correct, but the fact that `AgentRuntime` still has a `private terminalOutputCallback` field (line 339–348) that is never used for emission is dead code that creates confusion.

---

### BUG-11 [MEDIUM] — `fallbackSummary` in `PulseSidebarProvider` Is Missing `pendingEditCount` Field

**File:** `src/views/PulseSidebarProvider.ts` (line 41–63)

The `fallbackSummary` object created when `runtime.summary()` fails is missing `pendingEditCount`. The `RuntimeSummary` interface requires it (line 104). This means any code in the webview that reads `summary.pendingEditCount` on a degraded state gets `undefined` instead of `0`, causing potential NaN arithmetic in the UI.

```ts
const fallbackSummary = (error: unknown) => ({
  // ...
  hasPendingEdits: false,
  // pendingEditCount: 0,  ← MISSING
  // ...
});
```

---

### BUG-12 [MEDIUM] — `PulseSidebarProvider.resolveWebviewView` Is a 900-Line Async Function With No Internal Error Boundary

**File:** `src/views/PulseSidebarProvider.ts`

`resolveWebviewView` is a single function handling: HTML generation, state push, progress callbacks, stream callbacks, terminal callbacks, visibility changes, and all 30+ message types from the webview. The outer `try/catch` is inside `onDidReceiveMessage`, so errors in the initial setup (pushState, callback registration) are unhandled.

If `pushState()` throws (e.g. `runtime.summary()` throws during the initial load), the error propagates up as an unhandled promise rejection. The sidebar panel appears but is functionally dead.

---

### BUG-13 [MEDIUM] — `ImprovementEngine.runSelfImprovementCycle` Calls `reflectOnTask` With Empty `responseText`

**File:** `src/agent/improvement/ImprovementEngine.ts` (line 570)

```ts
await this.reflectOnTask(
  latest.id,
  latest.objective,
  "",          // ← empty responseText
  latest.success,
  latest.durationMs,
);
```

`reflectOnTask` presumably uses `responseText` to generate insights about what the agent did. Passing an empty string means the self-improvement cycle generates reflections with no actual content to reflect on, producing generic or hallucinated insights. This undermines the entire self-improvement system.

---

### BUG-14 [LOW] — `SessionStore.truncateAfterMessage` Parameter Name Is Semantically Inverted (Confirmed)

As documented in BUG-05. The parameter is named `includeMessage` but the slice logic is inverted. Both existing call sites produce correct results by coincidence (they pass the opposite boolean of what the name implies). Any future developer adding a call will introduce a bug.

---

### BUG-15 [LOW] — `ToolExecutor` Is 1,041 Lines — Same God Object Pattern Repeating

**File:** `src/agent/runtime/ToolExecutor.ts`

The tool executor extracted the tool dispatch logic but is already 1,041 lines. Each tool handler (15+ tools) is implemented as a long inline `if` chain. The same architectural problem that led to `AgentRuntime` bloating will recur here within a few feature additions.

Each tool should be its own class or handler function. A tool registry pattern (map from tool name → handler function) would make this testable and extensible.

---

### BUG-16 [LOW] — `PulseSidebarProvider` Is Still 3,011 Lines — Unchanged from v1 Audit

The sidebar was flagged in v1. It remains at 3,011 lines with no decomposition. This is lower priority but blocks testability.

---

## Part 4 — Fix Priority Order for AI Agent Execution

Execute in this exact order. Each item is a bounded, verifiable task.

### Phase 1 — Make the Extension Actually Work (1–2 days)

**Fix 1: Wrap `activate()` in try/catch** (`src/extension.ts`)  
Wrap the entire `activate` body in `try/catch`. On error, log via logger AND show a `vscode.window.showErrorMessage` with the message. Ensure the sidebar provider is still registered even if `runtime.initialize()` fails, using a degraded runtime state.

**Fix 2: Fix ImprovementEngine storage schema** (`src/db/StorageBootstrap.ts` + `src/agent/improvement/ImprovementEngine.ts`)  
Change `ensureJsonFile(improvementPath, { outcomes: [] })` to `{ outcomes: [], strategies: [], reflections: [] }`. Add a `normalizeState()` guard in `ImprovementEngine.load()` that fills missing arrays with `[]` so existing installs don't crash.

**Fix 3: Fix `activationEvents`** (`package.json`)  
Change `"onStartupFinished"` to `"onView:pulse.sidebar"`. This alone will fix the "blank panel on startup" symptom for many users.

**Fix 4: Fix `resolveWebviewView` HTML/handler ordering** (`src/views/PulseSidebarProvider.ts`)  
Make the `summary()` call synchronous to the HTML assignment. Change the `void ... .then()` pattern to `await`, so HTML is set before any handlers are registered. Wrap in try/catch that falls back to `buildHtml(webview, null)`.

**Fix 5: Fix `fallbackSummary` missing `pendingEditCount`** (`src/views/PulseSidebarProvider.ts`)  
Add `pendingEditCount: 0` to the `fallbackSummary` object on line 41.

**Fix 6: Fix `truncateAfterMessage` inverted logic** (`src/agent/sessions/SessionStore.ts`)  
Change `includeMessage ? index : index + 1` to `includeMessage ? index + 1 : index`. Add a comment explaining the semantics. Verify both call sites still produce correct behavior after the fix.

### Phase 2 — Fix Structural Inconsistencies (2–3 days)

**Fix 7: Remove dual callback state from `AgentRuntime`**  
Delete `private progressCallback`, `private tokenCallback`, `private streamCallback`, `private terminalOutputCallback` fields from `AgentRuntime`. Route all `set*Callback` methods to only set on `this.broadcaster`. Replace all 47 private `emit*` calls with `this.broadcaster.emit*` equivalents.

**Fix 8: Fix silent tool call truncation in `ToolExecutor`**  
After `limitedCalls = toolCalls.slice(0, 5)`, loop over any dropped calls and add synthetic `ok: false` observations with a "call dropped" message.

**Fix 9: Fix `ImprovementEngine.runSelfImprovementCycle` empty responseText**  
Store the `responseText` in `TaskOutcome` and use it in `reflectOnTask`. Alternatively, skip reflection in the background cycle and only reflect when called from `selfReflectBackground` which has the actual response text.

### Phase 3 — Architecture (ongoing)

**Fix 10: Decompose `ToolExecutor` into a tool registry**  
Create a `ToolHandler` interface and a `Map<string, ToolHandler>`. Register each tool (workspace_scan, read_files, create_file, etc.) as a separate handler object. `executeSingleToolCall` becomes a simple dispatch lookup.

**Fix 11: Decompose `PulseSidebarProvider`**  
Extract: `ChatMessageRenderer`, `SessionListRenderer`, `SettingsDrawerHandler`, `FileAttachmentHandler`. The provider becomes a thin message router.

---

## Part 5 — Summary Table

| ID | Issue | Severity | Effort |
|---|---|---|---|
| BUG-01 | `activate()` has no error handling — any startup throw kills extension | **CRITICAL** | 30 min |
| BUG-02 | `ImprovementEngine` missing `strategies`/`reflections` in bootstrap → runtime crash | **CRITICAL** | 1 hour |
| BUG-03 | `StreamBroadcaster` registered but emit bypassed — dual callback state | **CRITICAL** | 4 hours |
| BUG-04 | Session restore race condition — summary may arrive before webview is ready | **HIGH** | 2 hours |
| BUG-05 | `truncateAfterMessage` logic is semantically inverted | **HIGH** | 30 min |
| BUG-06 | `onStartupFinished` wrong activation event — blank sidebar for seconds | **HIGH** | 5 min |
| BUG-07 | Dual callback registration in runtime and broadcaster | **HIGH** | 4 hours |
| BUG-08 | Tool call truncation to 5 is still silent — model gets no feedback | **MEDIUM** | 1 hour |
| BUG-09 | `StreamBroadcaster` half-wired — `AgentRuntime` still emits directly | **MEDIUM** | (see BUG-07) |
| BUG-10 | Dead `terminalOutputCallback` field in `AgentRuntime` | **MEDIUM** | 30 min |
| BUG-11 | `fallbackSummary` missing `pendingEditCount` field | **MEDIUM** | 5 min |
| BUG-12 | `resolveWebviewView` 900-line function with no internal error boundary | **MEDIUM** | 2 hours |
| BUG-13 | `runSelfImprovementCycle` reflects on empty responseText | **MEDIUM** | 2 hours |
| BUG-14 | `truncateAfterMessage` parameter name semantically inverted (confirmed) | **LOW** | (see BUG-05) |
| BUG-15 | `ToolExecutor` already 1,041 lines — same God Object pattern recurring | **LOW** | 1 week |
| BUG-16 | `PulseSidebarProvider` still 3,011 lines | **LOW** | 1 week |

---

## What to Tell Your AI Agent

Provide these instructions verbatim:

```
Fix the following issues in the Pulse VS Code extension at OchiengPaul442/pulse in this exact order:

1. src/extension.ts — Wrap the entire activate() body in try/catch. 
   On catch: call logger.error() and vscode.window.showErrorMessage() with the error. 
   Do not let the unhandled rejection kill the extension.

2. src/db/StorageBootstrap.ts line 51 — Change:
     { outcomes: [] }
   To:
     { outcomes: [], strategies: [], reflections: [] }

3. src/agent/improvement/ImprovementEngine.ts — In the load() method, after parsing the 
   JSON, normalize the result through a function that defaults missing arrays to []:
     outcomes: parsed.outcomes ?? []
     strategies: parsed.strategies ?? []
     reflections: parsed.reflections ?? []

4. package.json line 27 — Change:
     "onStartupFinished"
   To:
     "onView:pulse.sidebar"

5. src/views/PulseSidebarProvider.ts — In resolveWebviewView(), change the 
   void this.runtime.summary().then(...) pattern to await with try/catch, 
   so webviewView.webview.html is assigned synchronously before any handlers 
   are registered. Add try/catch that falls back to buildHtml(webview, null).

6. src/views/PulseSidebarProvider.ts — Add pendingEditCount: 0 to the fallbackSummary 
   object (around line 41).

7. src/agent/sessions/SessionStore.ts line 183 — Fix the truncation logic:
   Change: includeMessage ? index : index + 1
   To:     includeMessage ? index + 1 : index
   Verify both call sites (edit path passes false, retry path passes true) 
   still behave correctly after the fix.

After completing these 7 fixes, run the TypeScript checker (npm run check) 
and fix any type errors before committing.
```
