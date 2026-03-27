# Pulse Agent — Performance & Architecture Audit

> **Scope:** Load time, first-response latency, and request throughput  
> **Files audited:** All 25 TypeScript source files (~9,700 lines)  
> **Date:** March 2026

---

## Executive Summary

The agent has a working architecture but ships with **5 critical latency killers** that compound on every single user request. In the worst case (agent mode, web search triggered), a user waits through a sequential waterfall of **8–10 async operations before the LLM even starts** — then receives the full response in one block with zero streaming feedback.

The fixes below are ranked by impact. Start at #1.

---

## Critical Issues (Fix These First)

### 1. No Streaming — Biggest UX Impact

**File:** `src/agent/model/OllamaProvider.ts`  
**Line:** ~104

```typescript
// Current — users stare at a blank screen for the entire LLM generation
body: JSON.stringify({
  model: request.model,
  messages: request.messages,
  stream: false,  // ← THIS IS THE PROBLEM
  ...
})
```

Ollama fully supports streaming via NDJSON (newline-delimited JSON). With `stream: false`, the user sees **nothing** until the model has finished generating every single token. For a 200-token response with a 7B model, that's 8–15 seconds of silence.

**Impact:** Every request in every mode is affected.

**Fix — Add streaming to `ChatRequest` and implement it in the provider:**

```typescript
// src/agent/model/ModelProvider.ts — add to ChatRequest interface
export interface ChatRequest {
  // ... existing fields ...
  stream?: boolean;
  onChunk?: (text: string) => void; // streaming callback
}
```

```typescript
// src/agent/model/OllamaProvider.ts — replace non-streaming chat()
public async chat(request: ChatRequest): Promise<ChatResponse> {
  const { signal, cleanup } = this.createSignalWithTimeout(request.signal, CHAT_TIMEOUT_MS);

  try {
    const response = await this.fetchFromCandidates("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      timeoutMs: CHAT_TIMEOUT_MS,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: true, // ALWAYS stream
        options: {
          temperature: request.temperature ?? 0.1,
          ...(typeof request.maxTokens === "number" ? { num_predict: request.maxTokens } : {}),
        },
        format: request.format,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Ollama chat failed (HTTP ${response.status}): ${extractOllamaError(body)}`);
    }

    return this.consumeStream(response, request.onChunk);
  } finally {
    cleanup();
  }
}

private async consumeStream(
  response: SimpleResponse,
  onChunk?: (text: string) => void,
): Promise<ChatResponse> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body for streaming");

  const decoder = new TextDecoder();
  let fullText = "";
  let promptTokens = 0;
  let completionTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value).split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const chunk = JSON.parse(line) as OllamaChatResponse;
        const delta = chunk.message?.content ?? "";
        if (delta) {
          fullText += delta;
          onChunk?.(delta);
        }
        if (chunk.done) {
          promptTokens = chunk.prompt_eval_count ?? 0;
          completionTokens = chunk.eval_count ?? 0;
        }
      } catch { /* skip malformed chunk */ }
    }
  }

  return {
    text: fullText.trim(),
    raw: {},
    tokenUsage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
  };
}
```

**In `AgentRuntime`, wire the chunk callback to `progressCallback`:**

```typescript
// In executeTask() — ask mode example
const response = await this.provider.chat({
  model,
  signal,
  messages: [...],
  maxTokens: 2048,
  onChunk: (text) => this.progressCallback?.({ icon: "✨", step: "Streaming", detail: text }),
});
```

Then in the webview, render streamed chunks incrementally instead of waiting for the final `RuntimeTaskResult`. This single change will make the agent feel **dramatically faster** even if the underlying LLM speed doesn't change.

---

### 2. Sequential Pre-flight Waterfall Before Every LLM Call

**File:** `src/agent/runtime/AgentRuntime.ts`  
**Lines:** ~713–730 (ask mode), ~882–890 (agent/convo mode)

Every request runs this sequential chain before calling the LLM:

```typescript
// Current — each line waits for the previous one to finish
const model = await this.resolveModelOrFallback(this.currentConfig.fastModel);
const styleHint = await this.getLearnedStyleHint(objective, mode);
const improvementHints = await this.improvementEngine.getOptimizedBehaviorHints(objective, mode);
const agentAwareness = this.improvementEngine.getAgentAwarenessHints(); // sync, fine
const webResearch = await this.collectWebResearch(objective, mode); // ← worst offender
```

These four calls are **completely independent** of each other. The web research call alone can take 1–3 seconds on a slow connection.

**Fix — Parallelize everything that is independent:**

```typescript
// Parallelized pre-flight — all 4 run concurrently
const [model, styleHint, improvementHints, webResearch] = await Promise.all([
  this.resolveModelOrFallback(this.currentConfig.fastModel),
  this.getLearnedStyleHint(objective, mode),
  this.improvementEngine.getOptimizedBehaviorHints(objective, mode),
  this.collectWebResearch(objective, mode),
]);
const agentAwareness = this.improvementEngine.getAgentAwarenessHints(); // sync
```

Apply the same pattern in `runAgentWorkflow` where `scanWorkspace`, `findRelevantFiles`, `memoryStore.latestEpisodes`, `collectWebResearch`, and `getLearnedStyleHint` all run sequentially today:

```typescript
// runAgentWorkflow — parallel context gathering
const [
  plannerModel,
  editorModel,
  candidateFiles,
  episodes,
  webResearch,
  styleHintAgent,
  improvementHintsAgent,
] = await Promise.all([
  this.resolveModelOrFallback(this.currentConfig.plannerModel),
  this.resolveModelOrFallback(this.currentConfig.editorModel),
  this.scanner.findRelevantFiles(objective, 8),
  this.currentConfig.memoryMode === "off" ? Promise.resolve([]) : this.memoryStore.latestEpisodes(3),
  this.collectWebResearch(objective, "agent"),
  this.getLearnedStyleHint(objective, "agent"),
  this.improvementEngine.getOptimizedBehaviorHints(objective, "agent"),
]);
```

**Estimated time savings: 1–4 seconds per request.**

---

### 3. Web Search Fires on Almost Every Developer Question

**File:** `src/agent/runtime/AgentRuntime.ts`  
**Lines:** `shouldUseWebSearch()` method, ~1615–1655

```typescript
// Current — these tokens trigger web search in ask mode:
const timeSensitiveSignals = [
  "api",        // ← "how does the API work" → web search
  "docs",       // ← "where are the docs" → web search
  "version",    // ← "what version of X" → web search
  "best",       // ← "what's the best pattern" → web search
  ...
];

if (mode === "ask") {
  return ["what is", "who is", "how to", "how do i", "compare", "recommend", "best", "should i"]
    .some(token => normalized.includes(token));
}
```

The word `"api"` alone in `timeSensitiveSignals` means "how does useEffect's API work?" or "explain the fetch API" **both trigger a web search call** — adding 0.5–3 seconds to responses that don't need it at all. The model already knows this information.

**Fix — Tighten the signal list. Web search should only trigger for explicit, time-sensitive information gaps:**

```typescript
private shouldUseWebSearch(objective: string, mode: ConversationMode): boolean {
  const normalized = objective.toLowerCase();

  // Only trigger for genuinely time-sensitive, external-dependency queries
  const hardTriggers = [
    "latest version", "release notes", "changelog", "what changed",
    "current price", "pricing", "breaking change", "migration guide",
    "this week", "today", "just released", "just announced",
  ];

  if (hardTriggers.some(token => normalized.includes(token))) {
    return true;
  }

  // Explicit web intent only
  const explicitWebIntent = [
    "search the web", "look it up online", "find online",
    "check the internet", "browse for",
  ];

  if (explicitWebIntent.some(token => normalized.includes(token))) {
    return true;
  }

  // In agent mode: only for package/dependency resolution where currency matters
  if (mode === "agent") {
    return ["install package", "which version", "npm install", "latest stable"].some(
      token => normalized.includes(token),
    );
  }

  return false;
}
```

This change alone eliminates a 0.5–3s async HTTP call from the majority of ask-mode requests.

---

### 4. `fetchFromCandidates` Tries Loopback Aliases Sequentially

**File:** `src/agent/model/OllamaProvider.ts`  
**Lines:** `fetchFromCandidates()` method, ~220–240

```typescript
// Current — tries localhost, then 127.0.0.1, then ::1 one by one
for (const baseUrl of this.getCandidateBaseUrls()) {
  try {
    const response = await this.makeRequest(this.buildUrl(baseUrl, path), init);
    return response; // ← first success wins
  } catch (error) {
    lastError = error; // ← waits for full timeout before moving on
  }
}
```

If `localhost` fails (e.g., DNS resolves to IPv6 on a machine that has Ollama bound to IPv4), the code waits for the full timeout (5 seconds for health checks) before trying `127.0.0.1`. That's a 5-second startup delay that happens on every extension activation on misconfigured machines.

**Fix — Race all candidates in parallel, take the first winner:**

```typescript
private async fetchFromCandidates(
  path: string,
  init: RequestOptions,
): Promise<SimpleResponse> {
  const candidates = this.getCandidateBaseUrls();
  if (candidates.length === 1) {
    return this.makeRequest(this.buildUrl(candidates[0], path), init);
  }

  return Promise.any(
    candidates.map(baseUrl => this.makeRequest(this.buildUrl(baseUrl, path), init))
  ).catch(() => {
    throw new Error("Failed to connect to Ollama on any candidate URL");
  });
}
```

**Estimated startup savings: 0–5 seconds on misconfigured hosts. Zero cost on well-configured hosts.**

---

### 5. `AgentRuntime` is a 2,806-Line God Object

**File:** `src/agent/runtime/AgentRuntime.ts`

This class owns:
- Session lifecycle management
- Model resolution and fallback logic
- Conversation history building
- Web search orchestration
- Agent workflow orchestration (plan → loop → tool execution → edit proposal)
- Permission policy evaluation
- Terminal command execution
- Workspace scanning and inventory
- Self-improvement triggers
- MCP status management
- Token tracking
- Git service delegation
- Attachment path normalization

That is **14 distinct responsibilities in one class**. Beyond being an architectural problem, it is a performance problem: any change to a hot path requires understanding 2,800 lines of interleaved concerns, so optimization is avoided or done incorrectly.

**Fix — Extract into focused, replaceable services:**

```
src/agent/runtime/
  AgentRuntime.ts           ← orchestrator only, ~400 lines
  TaskExecutor.ts           ← executeTask() + mode routing
  AgentWorkflowEngine.ts    ← runAgentWorkflow() + tool loop
  ContextBuilder.ts         ← pre-flight: styleHint, history, attached files, web research
  PostTaskWriter.ts         ← session writes, memory, learn-from-exchange
```

This decomposition makes it possible to:
1. Parallelize `ContextBuilder` naturally (all its inputs are independent)
2. Test `AgentWorkflowEngine` in isolation without spinning up a full runtime
3. Swap `PostTaskWriter` for a batched/debounced variant

---

## High-Priority Issues

### 6. Five Sequential Post-Task Writes After Every LLM Response

**File:** `src/agent/runtime/AgentRuntime.ts`  
Multiple locations in `executeTask()`

```typescript
// After every single response — 5 sequential disk writes:
await this.sessionStore.appendMessage(session.id, { role: "assistant", ... });
await this.sessionStore.updateSessionResult(session.id, response.text);
await this.editManager.clearPendingProposal();
await this.learnFromExchange(objective, response.text, mode);
if (this.currentConfig.memoryMode !== "off") {
  await this.memoryStore.addEpisode(objective, response.text.slice(0, 400));
}
```

These all run after the LLM finishes, delaying when the result is returned to the UI. Only `appendMessage` and `updateSessionResult` are blocking-critical (the UI needs the session updated). The rest can be fire-and-forget.

**Fix — Only await what the UI needs, run the rest in the background:**

```typescript
// Await only what UI requires immediately
await Promise.all([
  this.sessionStore.appendMessage(session.id, { role: "assistant", content: response.text, createdAt: new Date().toISOString() }),
  this.sessionStore.updateSessionResult(session.id, response.text),
]);

// Fire-and-forget the rest — these do not affect the response
void Promise.all([
  this.editManager.clearPendingProposal(),
  this.learnFromExchange(objective, response.text, mode),
  this.currentConfig.memoryMode !== "off"
    ? this.memoryStore.addEpisode(objective, response.text.slice(0, 400))
    : Promise.resolve(),
]).catch(err => this.logger.warn(`Post-task write failed: ${err}`));
```

**Estimated savings: 30–150ms per request on each background write avoided.**

---

### 7. Agent Workflow Tool Calls Execute Sequentially in a For Loop

**File:** `src/agent/runtime/AgentRuntime.ts`  
**Lines:** `executeTaskToolCalls()` method

```typescript
// Current — each tool blocks the next one
for (const call of toolCalls.slice(0, 5)) {
  checkAborted();
  if (call.tool === "workspace_scan") { ... }
  if (call.tool === "read_files") { ... }
  // etc.
}
```

If the model requests `workspace_scan` + `read_files` + `git_diff` in one response, they execute serially. Each is fully independent.

**Fix — Group independent tools and run them in parallel. Preserve ordering for observation output only:**

```typescript
private async executeTaskToolCalls(
  toolCalls: TaskToolCall[],
  objective: string,
  signal?: AbortSignal,
): Promise<TaskToolObservation[]> {
  // Run all tool calls concurrently, up to the cap
  const settled = await Promise.allSettled(
    toolCalls.slice(0, 5).map(call => this.executeSingleToolCall(call, objective, signal))
  );

  return settled.map((result, i) =>
    result.status === "fulfilled"
      ? result.value
      : { tool: toolCalls[i].tool, ok: false, summary: String(result.reason) }
  );
}
```

Extract each `if (call.tool === ...)` branch into a private `executeSingleToolCall()` method. This is also the decomposition needed to make the God Object issue tractable.

---

### 8. `resolveModelOrFallback` May Re-trigger Full Provider Refresh

**File:** `src/agent/runtime/AgentRuntime.ts`  
**Lines:** `resolveModelOrFallback()` method

```typescript
public async listAvailableModels(): Promise<ModelSummary[]> {
  if (this.availableModels.length === 0) {
    await this.refreshProviderState(); // ← Ollama health check + model list fetch
  }
  return this.availableModels;
}
```

`resolveModelOrFallback` calls `listAvailableModels()`. In `runAgentWorkflow`, it's called **twice** (once for plannerModel, once for editorModel). If `availableModels` is somehow empty between calls (edge case: concurrent reset), it triggers two full Ollama round trips.

More importantly: on first extension load, `initialize()` populates `availableModels`. But if `initialize()` fails (Ollama not running yet), the first `runTask` will trigger `refreshProviderState` again, adding one full health-check + model-list latency (up to 10s) to the first user request.

**Fix — Resolve both models in one `listAvailableModels()` call:**

```typescript
// In runAgentWorkflow — one model list fetch, two resolutions
const models = await this.listAvailableModels();
const plannerModel = this.pickModel(models, this.currentConfig.plannerModel);
const editorModel = this.pickModel(models, this.currentConfig.editorModel);

private pickModel(models: ModelSummary[], primary: string): string {
  const usable = models.filter(m => m.source === "local" || m.source === "running");
  const names = new Set(usable.map(m => m.name));
  if (names.has(primary)) return primary;
  for (const fallback of this.currentConfig.fallbackModels) {
    if (names.has(fallback)) return fallback;
  }
  return usable[0]?.name ?? primary;
}
```

---

### 9. `shouldUseWebSearch` Keyword List is Unanchored and Too Broad

**File:** `src/agent/runtime/AgentRuntime.ts`  
**Lines:** `shouldUseWebSearch()` method

Beyond Issue #3's fix, the existing check uses `normalized.includes(token)` with no word boundaries. The token `"api"` matches "capital", "principal", "municipal" — none of which should trigger web search. The token `"best"` matches "best practices" but also "suggest the best way to write a for loop".

**Fix — Use word-boundary regex matching:**

```typescript
private matchesAny(text: string, tokens: string[]): boolean {
  return tokens.some(token => new RegExp(`\\b${escapeRegex(token)}\\b`, "i").test(text));
}
```

---

### 10. Self-Learn Timer Fires Every 45 Seconds Regardless of Idle State

**File:** `src/agent/runtime/AgentRuntime.ts`  
**Lines:** `startSelfLearnLoop()` method

```typescript
this.selfLearnTimer = setInterval(() => {
  this.improvementEngine.runSelfImprovementCycle().catch((err) => {
    this.logger.warn(`Self-learn cycle error: ${err}`);
  });
}, 45_000);
```

`runSelfImprovementCycle` reads the improvement state, analyzes outcomes, potentially generates new strategies, and writes back to disk — every 45 seconds, forever, even when the user hasn't sent a message in hours.

`reflectOnTask` in `ImprovementEngine` makes an LLM call (via `provider.chat`) inside the cycle for high-value tasks. This adds background LLM load that competes with user requests.

**Fix — Replace interval with activity-gated scheduling:**

```typescript
private lastTaskCompletedAt: number | null = null;

// Call this after each task completes
private schedulePostTaskLearning(): void {
  this.lastTaskCompletedAt = Date.now();
  // Run once, 30 seconds after the last task, if no new task has started
  setTimeout(() => {
    if (this.lastTaskCompletedAt && Date.now() - this.lastTaskCompletedAt >= 29_000) {
      this.improvementEngine.runSelfImprovementCycle().catch(() => {});
    }
  }, 30_000);
}
```

This way learning only happens after actual task activity, not on a blind 45-second heartbeat.

---

## Medium-Priority Issues

### 11. `SessionStore` Has No In-Memory Read Cache

**File:** `src/agent/sessions/SessionStore.ts`

`SessionStore` has a `writeQueue` to serialize writes, but its `load()` reads from disk on every public method call: `getActiveSession()`, `getSession()`, `appendMessage()`, `updateSessionResult()`, etc. In a single `executeTask()` call, `load()` is called 4–6 times.

**Fix — Add a simple in-memory sessions cache, invalidated on write:**

```typescript
export class SessionStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private cache: SessionsFile | null = null; // ← add this

  private async load(): Promise<SessionsFile> {
    if (this.cache) return this.cache; // ← cache hit
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(this.sessionsPath));
      this.cache = JSON.parse(Buffer.from(bytes).toString("utf8")) as SessionsFile;
      return this.cache;
    } catch {
      this.cache = { activeSessionId: null, sessions: [] };
      return this.cache;
    }
  }

  private async save(state: SessionsFile): Promise<void> {
    this.cache = state; // ← update cache before write
    this.writeQueue = this.writeQueue.then(() =>
      vscode.workspace.fs.writeFile(
        vscode.Uri.file(this.sessionsPath),
        Buffer.from(JSON.stringify(state, null, 2), "utf8"),
      )
    );
    return this.writeQueue;
  }
}
```

`ImprovementEngine` already does this correctly with `stateCache`. `SessionStore` and `MemoryStore` should match the pattern.

---

### 12. Extension Activation Awaits Sequentially

**File:** `src/extension.ts`

```typescript
// Current — each line blocks the next
const config = getAgentConfig();
const storage = await bootstrapStorage(context, logger);        // disk IO
const webSearchService = new WebSearchService(context.secrets, logger);
const runtime = new AgentRuntime(config, storage, logger, webSearchService);
await runtime.initialize();                                     // Ollama HTTP call
```

`bootstrapStorage` (disk IO) and `runtime.initialize()` (Ollama health check) are both I/O-bound and could overlap if `initialize()` were split into a sync constructor phase and an async background initialization:

**Fix — Move `runtime.initialize()` to a non-blocking background task:**

```typescript
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = createLogger();
  context.subscriptions.push({ dispose: () => logger.dispose() });

  const [config, storage] = await Promise.all([
    Promise.resolve(getAgentConfig()),
    bootstrapStorage(context, logger),
  ]);

  const webSearchService = new WebSearchService(context.secrets, logger);
  const runtime = new AgentRuntime(config, storage, logger, webSearchService);

  // Register UI immediately — don't block on Ollama being ready
  const sidebarProvider = new PulseSidebarProvider(context.extensionUri, runtime, logger);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PulseSidebarProvider.viewType, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  registerCommands(context, runtime, logger);

  // Initialize in background — UI shows "connecting to Ollama" state
  runtime.initialize().catch(err => logger.warn(`Runtime init failed: ${err}`));

  logger.info("Pulse extension activated.");
}
```

This cuts the perceived activation time from "wait for Ollama" to "instant", with the sidebar showing a degraded/loading state while Ollama connects.

---

### 13. Agent Workflow Always Runs the Full Planner Before the First LLM Call

**File:** `src/agent/runtime/AgentRuntime.ts`  
**Lines:** `runAgentWorkflow()` — `planner.createPlan()` call

In agent mode, the flow is:

1. `planner.createPlan()` — LLM call #1
2. Gather context (workspace scan, memory, web research)
3. Agent LLM loop — LLM calls #2, #3, #4 (up to 3 iterations)

For simple edit tasks ("fix the typo on line 42"), the full planner is unnecessary and adds one full LLM round trip. The plan is then passed into the agent prompt where it's largely redundant since the agent reasons independently.

**Fix — Gate the planner on task complexity:**

```typescript
private requiresFullPlan(objective: string): boolean {
  const lower = objective.toLowerCase();
  // Simple, targeted tasks skip the planner
  const simplePatterns = /\b(fix typo|rename|move file|add comment|format|lint)\b/;
  if (simplePatterns.test(lower) && objective.length < 120) return false;
  return true;
}

// In runAgentWorkflow:
const plan = requiresFullPlan(objective)
  ? await this.planner.createPlan(objective, plannerModel)
  : buildTrivialPlan(objective);
```

---

## Low-Priority / Code Quality Issues

### 14. `collectVerificationCommands` Reads `package.json` on Every Verification Run

**File:** `src/agent/runtime/AgentRuntime.ts`  
`readPackageScripts()` reads and parses `package.json` from disk every time verification is triggered.

**Fix:** Cache the result for the duration of a session with a simple `Map<string, Record<string, string>>` keyed by `packageJsonPath`. Invalidate when edits are applied.

---

### 15. `buildConversationHistory` Loads the Full Session to Get the Last 8 Messages

**File:** `src/agent/runtime/AgentRuntime.ts`  
`buildConversationHistory()` fetches the full `SessionRecord` (which includes all messages, attachedFiles, and metadata) just to call `.slice(-8)` on messages. In a long session with 50+ messages, this deserializes the entire JSON blob for 8 items.

**Fix:** Add a `getRecentMessages(sessionId, limit)` method to `SessionStore` that extracts only the tail without loading the full record into memory.

---

### 16. `ImprovementEngine.reflectOnTask` Makes a Blind LLM Call in the Background

**File:** `src/agent/improvement/ImprovementEngine.ts`  
`reflectOnTask` is called via `selfReflectBackground` after every task. It makes a `provider.chat()` call. This is a concurrency issue: if the user sends a fast follow-up message, the reflection LLM call competes with the user's task for the Ollama connection.

**Fix:** Add a minimum delay and an active-task guard:

```typescript
private selfReflectBackground(...): void {
  // Don't reflect if a new task is already queued
  const scheduledAt = Date.now();
  setTimeout(() => {
    if (this.abortController !== null) return; // new task is running, skip
    // ... existing reflect logic ...
  }, 5_000);
}
```

---

### 17. `getAgentAwarenessHints` Runs `detectInstalledAgents` on Every Request

**File:** `src/agent/improvement/ImprovementEngine.ts`  
`getAgentAwarenessHints()` is called synchronously on every request and internally calls `detectInstalledAgents()`, which scans VS Code extensions via `vscode.extensions.all`. This is a synchronous iteration over the full extension list.

**Fix:** Cache the result for the session lifecycle — the installed extension list doesn't change mid-session:

```typescript
private agentAwarenessCache: string | null = null;

public getAgentAwarenessHints(): string {
  if (this.agentAwarenessCache !== null) return this.agentAwarenessCache;
  this.agentAwarenessCache = this.computeAgentAwarenessHints();
  return this.agentAwarenessCache;
}
```

---

## Implementation Priority

| # | Issue | Effort | Impact | Do First |
|---|-------|--------|--------|----------|
| 1 | Add streaming | High | Critical | Yes |
| 2 | Parallelize pre-flight awaits | Low | Critical | Yes |
| 3 | Tighten web search triggers | Low | High | Yes |
| 4 | Race loopback candidates in parallel | Low | Medium | Yes |
| 5 | Decompose God Object | High | Architecture | Ongoing |
| 6 | Fire-and-forget post-task writes | Low | Medium | Yes |
| 7 | Parallelize tool calls | Medium | Medium | Next |
| 8 | Single model list fetch | Low | Low-Med | Next |
| 9 | Word-boundary web search matching | Low | Low | Next |
| 10 | Activity-gated self-learn | Low | Medium | Next |
| 11 | SessionStore read cache | Low | Medium | Next |
| 12 | Non-blocking extension activation | Low | High | Yes |
| 13 | Gate full planner on complexity | Medium | Medium | Later |
| 14 | Cache package.json reads | Low | Low | Later |
| 15 | `getRecentMessages` on SessionStore | Low | Low | Later |
| 16 | Guard background reflection LLM calls | Low | Medium | Next |
| 17 | Cache `getAgentAwarenessHints` | Low | Low | Later |

---

## Estimated Total Latency Improvement

With issues 1–4, 6, and 12 fixed:

| Scenario | Before | After (estimate) |
|----------|--------|-----------------|
| Extension activation (Ollama running) | 2–4s blocked | ~0s (background) |
| Extension activation (Ollama not running) | 5–15s blocked | ~0s (background) |
| Ask mode — simple question | 3–8s blank wait | Tokens stream in <1s |
| Ask mode — web search triggered | 5–12s blank wait | Tokens stream in <1s, research parallel |
| Agent mode — simple edit | 8–20s blank wait | Tokens stream in 2–4s |
| Agent mode — complex task | 20–60s blank wait | Tokens stream in 3–6s |

The numbers above assume no change to model size or Ollama throughput. They reflect eliminating unnecessary sequential waits and adding visible streaming feedback. The actual generation speed is determined by the hardware running Ollama — that is outside the agent's control.

---

*Audit performed against commit on `main` branch as of March 2026.*
