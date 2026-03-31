# Pulse AI Agent — Full Code Audit Report

> **Scope:** Full static analysis of `OchiengPaul442/pulse` (v0.0.91)
> **Date:** March 31, 2026
> **Verdict:** The architectural bones are solid. The execution is riddled with debt that will cap quality and kill UX at scale. Here is every problem, ranked by severity, with no sugarcoating.

---

## 1. CRITICAL — Streaming is Broken in Agent Mode

**File:** `src/agent/runtime/AgentRuntime.ts` — `runAgentWorkflow()` → provider.chat `onChunk`

**What it is:**
In `ask` mode (line ~1027) and the non-edit conversation path (line ~1164), `onChunk` correctly calls both `emitReasoningChunk` AND `emitStreamChunk`, which pipes tokens to the UI in real time.

In `runAgentWorkflow()` (line ~2944) — the path that runs for ALL agent tasks — `onChunk` only calls `emitReasoningPulse()`. It **never calls `emitStreamChunk`**. The sidebar callback registered at `PulseSidebarProvider.ts:132` receives zero tokens during the entire agent loop.

**Impact:** Every agent-mode task gives the user a blank, frozen UI until the full response is computed. This is the single biggest UX failure in the codebase. Users staring at a spinner for 30–90 seconds with no feedback is a product killer.

**Fix:**
```ts
onChunk: (chunk) => {
  this.emitReasoningPulse("Reasoning through tools and code changes...");
  this.emitStreamChunk(chunk); // ADD THIS
},
```

---

## 2. CRITICAL — God Object: `AgentRuntime.ts` is 5,460 Lines

**File:** `src/agent/runtime/AgentRuntime.ts`

This is the worst architectural decision in the codebase. One class owns:
- Session lifecycle management
- Model selection and fallback
- Tool execution (15+ tools, each with inline logic)
- Permission policy enforcement
- Git integration
- Self-improvement orchestration
- Plan creation orchestration
- Conversation history building
- File path normalization (4 separate methods)
- Web search gating logic
- Package manager detection
- Project type detection
- Terminal command sanitization
- Verification workflow
- Token accounting
- Progress/stream/terminal callbacks

This violates every principle of maintainability. You cannot test individual concerns, you cannot swap implementations, and every new feature gets bolted onto a class that is already incomprehensible. The previous audit already flagged this. It has not been fixed.

**Direct consequences right now:**
- `executeSingleToolCall()` alone is ~400 lines of nested `if` chains. Adding a new tool requires editing the God Object.
- Changing permission logic touches session logic touches token logic. Everything is coupled.
- Unit testing is nearly impossible without mocking 12+ collaborators.

**Required decomposition (minimum viable):**
```
AgentRuntime           → thin orchestrator only (~300 lines)
ToolExecutor           → all tool call dispatch
WorkflowEngine         → the agent loop logic
SessionManager         → session CRUD, history, context building
PathResolver           → all workspace path normalization
ProjectDetector        → detectProjectType, detectCommandEcosystem, detectPackageManager
StreamBroadcaster      → progress, stream, token callbacks
```

---

## 3. CRITICAL — Pre-flight Operations Are Sequential, Not Parallel

**File:** `AgentRuntime.ts` — `runAgentWorkflow()` lines ~2676–2720

The agent workflow starts with a `Promise.all` that looks like it parallelizes:
```ts
const [plannerModel, editorModel, candidateFiles, episodes, webResearch, styleHintAgent, improvementHintsAgent] = await Promise.all([...]);
```

This is good. **But then it immediately awaits session loading sequentially:**
```ts
const session = await sessionPromise;
const [rawContextSnippets, attachedContext, conversationHistory] = await Promise.all([...]);
```

The second batch blocks on the session completing before it even starts. And `sessionPromise` was only started because it was captured before the first `Promise.all`. The root problem: model resolution, file scanning, and session loading are not a single unified parallel group — they're two sequential waterfalls wearing a parallelism costume.

Additionally, `initialize()` runs `healthCheck()` then `listModels()` sequentially. There is no reason these can't be batched.

**Impact:** 500ms–1500ms of unnecessary latency on every agent task start, on hardware you're already fighting (local Ollama).

---

## 4. HIGH — `batch_edit` Uses String Replace, Not Structural Edit

**File:** `AgentRuntime.ts` — `executeSingleToolCall` → `batch_edit`

```ts
const newContent = content.replace(search, replace ?? "");
```

This uses JavaScript's `String.replace()`, which:
1. Replaces only the **first** occurrence
2. Has no indentation awareness
3. Fails silently if the search text doesn't match exactly (whitespace differences, line ending differences)
4. Has no conflict detection

For a coding agent whose core value proposition is editing files correctly, this is a liability. If the model generates a search string with slightly different whitespace than the actual file, the edit silently fails. The agent then loops, burns tokens, and often gives up.

**Fix:** Implement a proper search-normalize-replace that strips leading/trailing whitespace per-line before matching. Consider a unified diff approach or AST-based edits for typed languages.

---

## 5. HIGH — `MemoryStore` Has a Single-Writer Race Condition

**File:** `src/agent/memory/MemoryStore.ts`

The store loads state into `this.cache`, mutates it, and saves. There is no write queue or mutex. The `SessionStore` has a `writeQueue: Promise<void>` pattern — `MemoryStore` does not.

If `addEpisode` and `setPreference` are called concurrently (which happens — `selfReflectBackground` fires async after every task), both calls read the same stale cache, one overwrites the other's changes on save.

**Fix:** Add the same `writeQueue` pattern already used in `SessionStore`:
```ts
private writeQueue: Promise<void> = Promise.resolve();

private enqueueWrite(fn: (state: MemoryState) => Promise<void>): Promise<void> {
  this.writeQueue = this.writeQueue.then(() => fn(this.stateCache!));
  return this.writeQueue;
}
```

---

## 6. HIGH — Self-Learn Loop is Architecturally Unsound

**File:** `AgentRuntime.ts` — `startSelfLearnLoop()` + `ImprovementEngine`

The self-learn loop runs `improvementEngine.runSelfImprovementCycle()` every 45 seconds unconditionally while the agent is active. Problems:

1. **No backpressure.** If the cycle takes longer than 45 seconds (it calls the model), the next `setInterval` fires and you get concurrent model calls from the background loop racing with user tasks. This will cause unpredictable Ollama load spikes.

2. **`ImprovementEngine.reflectOnTask` is fire-and-forget.** It's called via `selfReflectBackground` which swallows all errors. There is zero observability into whether self-improvement is actually working.

3. **The "learning" is shallow.** The learned strategies are regex-matched prompt hints stored in JSON. There's no validation that injected hints actually improve outcomes. The `successRate` check (disable if < 0.3) is the only feedback signal, and it's computed over a rolling window of un-controlled trials. This is not self-improvement — it's prompt pollution with a slow-burn filter.

4. **`runSelfImprovementCycle` is not implemented in the visible code.** The `ImprovementEngine` header is shown but the actual cycle method wasn't in the sampled output. If it calls the model, it will consume VRAM on a machine that can barely handle one inference at a time.

**Fix:** Replace `setInterval` with a debounced post-task trigger. Only run after a task completes, not on a timer. Add concurrency guard: if a user task is running, skip the cycle.

---

## 7. HIGH — `buildConversationHistory` Summarizes Only User Messages

**File:** `AgentRuntime.ts` — `buildConversationHistory()`

When conversation exceeds 40 messages, older messages are "summarised" by:
```ts
if (m.role === "user") {
  const trimmed = m.content.slice(0, 200)...
  keyPoints.push(`- User: ${trimmed}`);
}
```

**Assistant messages are silently dropped.** The model loses all context of what it previously said — its own code suggestions, explanations, and decisions. The user's questions are kept but the agent's answers are gone. This causes the agent to repeat work, contradict its own previous outputs, and lose track of what it already applied.

**Fix:** Include assistant message summaries too, or use a proper sliding window that keeps the last N tokens of both roles, not just user turns.

---

## 8. HIGH — Tool Execution Is Sequential Inside the Agent Loop

**File:** `AgentRuntime.ts` — `executeTaskToolCalls()`

```ts
const settled = await Promise.allSettled(
  limitedCalls.map((call) => this.executeSingleToolCall(call, objective, signal))
);
```

This looks parallel, but `executeSingleToolCall` for `run_terminal` calls `executeTerminalCommand`, which is inherently sequential (one process at a time). For read-only tools (`read_files`, `search_files`, `list_dir`, `workspace_scan`), there is genuine parallelism potential.

More critically: the model can only issue up to 5 tool calls per iteration (`limitedCalls = toolCalls.slice(0, 5)`), but this cap is silent. The model doesn't know it was truncated. If it issued 7 calls and 2 were silently dropped, it will produce incorrect reasoning on the next iteration about what was executed.

**Fix:** Return an observation for truncated calls so the model knows calls were dropped.

---

## 9. MEDIUM — `Planner` Calls the Model and Silently Falls Back

**File:** `src/agent/planner/Planner.ts`

```ts
try {
  const response = await this.provider.chat({...});
  const parsed = JSON.parse(response.text) as Partial<TaskPlan>;
  return normalizePlan(parsed, objective);
} catch {
  return fallbackPlan(objective);
}
```

Any failure — network timeout, OOM, bad JSON — silently swallows the error and returns a generic 3-step plan. The user gets no indication that planning failed. The agent then proceeds with a fallback plan that has no relationship to the actual objective. This degrades task quality invisibly.

**Fix:** At minimum, log the failure. Better: propagate a `PlanningFailure` flag to the runtime so the UI can warn the user that the plan is a fallback.

---

## 10. MEDIUM — `batch_edit` Only Does First-Occurrence Replace

Already noted in #4 but worth calling out again separately: `String.replace(search, replace)` replaces only the **first** match. If the LLM generates an edit that needs to replace a pattern appearing multiple times in a file, only the first occurrence is changed. The agent will observe the file and see the remaining occurrences, loop, and waste iterations.

---

## 11. MEDIUM — `reconcileTodoProgress` Can Mask Regressions

**File:** `AgentRuntime.ts` — `reconcileTodoProgress()`

The logic prevents todos from regressing (done → in-progress), which is correct in principle. But it does this by overriding what the model returned. If the model genuinely needs to revisit a "done" task (e.g. it realized the previous edit was wrong), the reconciler will force `done` status and the model cannot communicate the regression to the user.

This is particularly dangerous for iterative refactors where the model needs multiple passes over the same todo.

---

## 12. MEDIUM — No Retry Budget for Failed Tool Calls

When a tool call fails, `critiqueContext` is injected with `"## TOOL FAILURES — INVESTIGATE AND RETRY"`. But there is no cap on how many times the agent can retry the exact same failing tool. If `run_terminal` fails repeatedly (e.g. wrong working directory), the agent will loop through all `MAX_AGENT_ITERATIONS` retrying the same command, burning tokens and time.

**Fix:** Track tool failure counts per tool name per session. After 3 consecutive failures for the same tool, inject a harder stop: "This tool has failed 3 times. Do not call it again. Use an alternative approach."

---

## 13. MEDIUM — `detectPackageManager` Uses Synchronous `existsSync`

**File:** `AgentRuntime.ts` — `detectPackageManager()`

```ts
const hasPnpm = existsSync(path.join(fsPath, "pnpm-lock.yaml"));
```

`existsSync` is a blocking synchronous filesystem call inside an async extension host. In VS Code, this blocks the extension host thread. For projects on network drives or slow disks, this will freeze the UI.

**Fix:** Use `vscode.workspace.fs.stat()` with `await`, consistent with the rest of the codebase.

---

## 14. MEDIUM — Token Accounting is Inaccurate

**File:** `AgentRuntime.ts` — `consumeTokens()`

Token accounting depends entirely on `response.tokenUsage` returned by the provider. The `OllamaProvider` populates this from `prompt_eval_count` and `eval_count` in the Ollama response. But:

1. In streaming mode, Ollama only sends these counts in the final chunk. If the stream is aborted mid-way, token counts are never recorded.
2. The `explainText()` method explicitly resets `tokensConsumed` back to the snapshot after completing, meaning explain calls don't count toward the budget at all — even though they consume real VRAM.
3. Background self-reflection calls (`selfReflectBackground`) consume tokens but are not tracked because they go through `improvementEngine` directly.

The token budget display in the UI is systematically understated.

---

## 15. LOW — `isSimpleConversational` Is a Fragile Keyword List

**File:** `AgentRuntime.ts` — `isSimpleConversational()`

A hardcoded list of 30+ greetings is checked with exact string matching after lowercasing. Edge cases that will incorrectly fall through:
- "Hey, help me fix this bug" → matches "hey" prefix behavior? No, `greetings.includes(lower)` requires exact match. But "help me" IS in the list, so "help me fix this bug" won't match because the full string doesn't equal "help me".
- This is probably fine for now, but it will break in surprising ways as the list grows. Replace with a small intent classifier or a more principled heuristic.

---

## 16. LOW — Tests Are Shallow and Over-Mocked

**Directory:** `test/`

There are 16 test files, which looks thorough. But:

- `agent-runtime.test.ts` mocks virtually everything (`vscode`, `OllamaProvider`, `SessionStore`, `EditManager`, etc.). The tests are validating that mocks call each other, not that the system works.
- There are no integration tests that run the actual agent loop against a real (or real-ish) Ollama instance.
- There are no tests for the streaming path.
- There are no tests for the `batch_edit` search-not-found edge case.
- The `ImprovementEngine` has no tests visible in the test directory.

Tests give a false sense of coverage. The coverage number (if measured) means nothing when the collaborators are mocked away.

---

## 17. LOW — `PulseSidebarProvider.ts` Is 3,011 Lines

**File:** `src/views/PulseSidebarProvider.ts`

The second God Object. The sidebar owns message rendering, session management UI, tool config, permission UI, file attachment handling, and webview message routing. This is the same architectural problem as `AgentRuntime.ts` at the UI layer.

---

## 18. LOW — `WorkspaceScanner.findRelevantFiles` Has No Relevance Scoring

**File:** `src/agent/indexing/WorkspaceScanner.ts`

Files are "found relevant" but the selection logic (330 lines, not fully sampled) almost certainly does basic keyword matching. There's no TF-IDF, no embedding similarity, no recency weighting. For large codebases, the 8-file context window will frequently miss the actual relevant files, causing the agent to ask `workspace_scan` and burn an iteration.

---

## Summary Table

| # | Issue | Severity | Effort to Fix |
|---|-------|----------|---------------|
| 1 | Agent-mode streaming is broken | **CRITICAL** | 1 line |
| 2 | God Object AgentRuntime (5,460 lines) | **CRITICAL** | 2–3 weeks |
| 3 | Pre-flight operations not truly parallel | **CRITICAL** | 1–2 days |
| 4 | `batch_edit` silent first-only replace | **HIGH** | 1 day |
| 5 | `MemoryStore` race condition | **HIGH** | 2 hours |
| 6 | Self-learn loop has no backpressure | **HIGH** | 1 day |
| 7 | Conversation history drops assistant messages | **HIGH** | 2 hours |
| 8 | Tool call truncation is silent | **HIGH** | 2 hours |
| 9 | Planner silently falls back on failure | **MEDIUM** | 2 hours |
| 10 | `batch_edit` first-occurrence only (same as #4) | **MEDIUM** | (see #4) |
| 11 | `reconcileTodoProgress` masks valid regressions | **MEDIUM** | 1 day |
| 12 | No retry budget for repeated tool failures | **MEDIUM** | 4 hours |
| 13 | `existsSync` blocks extension host thread | **MEDIUM** | 1 hour |
| 14 | Token accounting systematically understated | **MEDIUM** | 1 day |
| 15 | `isSimpleConversational` is a fragile list | **LOW** | 4 hours |
| 16 | Tests are shallow/over-mocked | **LOW** | 1 week |
| 17 | `PulseSidebarProvider` is 3,011 lines | **LOW** | 1–2 weeks |
| 18 | `WorkspaceScanner` has no real relevance scoring | **LOW** | 1 week |

---

## Recommended Fix Sequence for AI Agent

If you are using an AI coding agent to implement these fixes, execute them in this exact order. Each item is a standalone, verifiable unit of work:

### Phase 1 — Quick Wins (1–2 days)
These are surgical changes with zero architectural risk:

1. **Fix streaming in agent mode** (`AgentRuntime.ts` line ~2944): Add `this.emitStreamChunk(chunk)` inside the `onChunk` callback in `runAgentWorkflow`.

2. **Fix MemoryStore race condition** (`MemoryStore.ts`): Add a `writeQueue: Promise<void>` property and chain all writes through it, matching the `SessionStore` pattern.

3. **Fix silent tool truncation** (`AgentRuntime.ts`): After `limitedCalls = toolCalls.slice(0, 5)`, check if `toolCalls.length > 5` and append a synthetic `ok: false` observation for each dropped call with message "Tool call dropped: agent issued too many calls in one turn."

4. **Fix assistant message dropout** (`AgentRuntime.ts` — `buildConversationHistory`): When summarizing older messages, include assistant messages with `- Agent: ${m.content.slice(0, 200)}` alongside user messages.

5. **Fix `existsSync` blocking call** (`AgentRuntime.ts` — `detectPackageManager`): Replace with `await vscode.workspace.fs.stat(...)` calls, consistent with the rest of the file.

6. **Fix Planner silent fallback** (`Planner.ts`): Add a `logger.warn()` call in the catch block and return the fallback plan with a flag `{ ...fallbackPlan(objective), isFallback: true }`. Surface this flag in the runtime as a progress event.

### Phase 2 — High-Impact Fixes (3–5 days)
These require more care but are bounded:

7. **Fix `batch_edit` search matching**: Normalize whitespace before matching. Replace `content.replace(search, replace)` with a normalize-then-replace that trims leading/trailing whitespace per line. Add `content.replaceAll(search, replace ?? "")` at minimum to handle multiple occurrences.

8. **Fix self-learn loop backpressure**: Remove `setInterval`. Instead, call `improvementEngine.runSelfImprovementCycle()` at the end of `executeTask()` only if no other task is running (check `activeTaskController` is null). Add a concurrency flag to prevent overlapping cycles.

9. **Add tool failure retry budget**: Add a `toolFailureCounts: Map<string, number>` to `runAgentWorkflow`. Increment on each failed observation. When count >= 3 for any tool, inject hard stop text into `critiqueContext` and do not allow further calls to that tool in this session.

10. **Parallelize pre-flight operations**: In `runAgentWorkflow`, collapse the two-stage `Promise.all` + sequential `await sessionPromise` into a single `Promise.all` where session loading, model resolution, file scanning, episodes, web research, and hints all run concurrently.

### Phase 3 — Architecture (2–3 weeks)
These require planning before coding:

11. **Decompose `AgentRuntime`** into: `ToolExecutor`, `WorkflowEngine`, `PathResolver`, `ProjectDetector`, `StreamBroadcaster`. Start by extracting `executeSingleToolCall` and everything it calls into `ToolExecutor`. This is the highest-value decomposition.

12. **Decompose `PulseSidebarProvider`** into separate view components for: chat, session list, tool config, file attachments.

13. **Replace `WorkspaceScanner.findRelevantFiles`** with embedding-based similarity using the configured embedding model (already in config). The scaffolding for `embeddingModel` exists but is unused for search.

14. **Write real integration tests** that spin up a mock Ollama server (or use a test fixture) and run the full agent loop. Test the streaming path, the batch_edit path, and the todo reconciliation path with realistic model responses.

---

## Bottom Line

The agent is not production-ready as-is. Issues #1 and #3 alone mean every agent-mode task gives the user a frozen, silent UI for up to 90 seconds. Issue #2 means the codebase will become unmaintainable within 2–3 more features. Issues #4, #5, and #7 mean the agent's most critical operations — editing files, remembering context, building conversation history — have correctness bugs.

The good news: 6 of the 18 issues are fixable in under a day each. Fix those first, ship them, then tackle the architectural debt in a planned refactor sprint.

Do not add features until Phase 1 is done. You are building on a leaky foundation.
