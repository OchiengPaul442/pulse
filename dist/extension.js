"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode11 = __toESM(require("vscode"));

// src/agent/runtime/AgentRuntime.ts
var path2 = __toESM(require("path"));
var vscode6 = __toESM(require("vscode"));

// src/agent/edits/EditManager.ts
var path = __toESM(require("path"));
var vscode = __toESM(require("vscode"));
var EditManager = class {
  constructor(editsPath, snapshotsDir) {
    this.editsPath = editsPath;
    this.snapshotsDir = snapshotsDir;
  }
  async setPendingProposal(objective, edits) {
    const state = await this.load();
    const proposal = {
      id: crypto.randomUUID(),
      objective,
      edits,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    state.pendingProposal = proposal;
    await this.save(state);
    return proposal;
  }
  async getPendingProposal() {
    const state = await this.load();
    return state.pendingProposal;
  }
  async clearPendingProposal() {
    const state = await this.load();
    state.pendingProposal = null;
    await this.save(state);
  }
  async applyPending() {
    const state = await this.load();
    const proposal = state.pendingProposal;
    if (!proposal || proposal.edits.length === 0) {
      return null;
    }
    const undoActions = [];
    for (const edit of proposal.edits) {
      const op = edit.operation ?? "write";
      if (op === "write") {
        const filePath = this.normalizeAndAssertInWorkspace(edit.filePath);
        const before = await this.captureSnapshot(filePath);
        await this.ensureParentDir(filePath);
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(filePath),
          Buffer.from(edit.content ?? "", "utf8")
        );
        undoActions.push({
          type: "write",
          path: filePath,
          before
        });
        continue;
      }
      if (op === "delete") {
        const filePath = this.normalizeAndAssertInWorkspace(edit.filePath);
        const before = await this.captureSnapshot(filePath);
        if (before.exists) {
          await vscode.workspace.fs.delete(vscode.Uri.file(filePath), {
            recursive: true,
            useTrash: true
          });
        }
        undoActions.push({
          type: "delete",
          path: filePath,
          before
        });
        continue;
      }
      if (op === "move") {
        if (!edit.targetPath) {
          continue;
        }
        const from = this.normalizeAndAssertInWorkspace(edit.filePath);
        const to = this.normalizeAndAssertInWorkspace(edit.targetPath);
        const fromBefore = await this.captureSnapshot(from);
        const toBefore = await this.captureSnapshot(to);
        if (!fromBefore.exists) {
          continue;
        }
        await this.ensureParentDir(to);
        if (toBefore.exists) {
          await vscode.workspace.fs.delete(vscode.Uri.file(to), {
            recursive: true,
            useTrash: true
          });
        }
        await vscode.workspace.fs.rename(
          vscode.Uri.file(from),
          vscode.Uri.file(to),
          {
            overwrite: false
          }
        );
        undoActions.push({
          type: "move",
          from,
          to,
          fromBefore,
          toBefore
        });
      }
    }
    const txId = crypto.randomUUID();
    const backupsPath = path.join(this.snapshotsDir, `${txId}.json`);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(backupsPath),
      Buffer.from(JSON.stringify({ proposal, undoActions }, null, 2), "utf8")
    );
    const applied = {
      id: txId,
      objective: proposal.objective,
      backupsPath,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    state.pendingProposal = null;
    state.lastApplied = applied;
    await this.save(state);
    return applied;
  }
  async revertLastApplied() {
    const state = await this.load();
    const last = state.lastApplied;
    if (!last) {
      return null;
    }
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.file(last.backupsPath)
    );
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const undoActions = parsed.undoActions ?? Object.entries(parsed.backups ?? {}).map(
      ([filePath, content]) => ({
        type: "write",
        path: filePath,
        before: {
          exists: true,
          isDirectory: false,
          content
        }
      })
    );
    for (let i = undoActions.length - 1; i >= 0; i -= 1) {
      const action = undoActions[i];
      if (action.type === "write") {
        await this.restoreSnapshot(action.path, action.before);
        continue;
      }
      if (action.type === "delete") {
        await this.restoreSnapshot(action.path, action.before);
        continue;
      }
      if (action.type === "move") {
        const fromExists = await this.pathExists(action.from);
        const toExists = await this.pathExists(action.to);
        if (!fromExists && toExists) {
          await this.ensureParentDir(action.from);
          await vscode.workspace.fs.rename(
            vscode.Uri.file(action.to),
            vscode.Uri.file(action.from),
            { overwrite: false }
          );
        }
        await this.restoreSnapshot(action.from, action.fromBefore);
        await this.restoreSnapshot(action.to, action.toBefore);
      }
    }
    state.lastApplied = null;
    await this.save(state);
    return last;
  }
  normalizeAndAssertInWorkspace(filePath) {
    const normalized = path.normalize(filePath);
    const folders = vscode.workspace.workspaceFolders ?? [];
    const inWorkspace = folders.some((folder) => {
      const root = path.normalize(folder.uri.fsPath) + path.sep;
      return normalized === path.normalize(folder.uri.fsPath) || normalized.startsWith(root);
    });
    if (!inWorkspace) {
      throw new Error(`Refusing to edit outside workspace: ${normalized}`);
    }
    return normalized;
  }
  async pathExists(filePath) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      return true;
    } catch {
      return false;
    }
  }
  async captureSnapshot(filePath) {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      if ((stat.type & vscode.FileType.Directory) !== 0) {
        return {
          exists: true,
          isDirectory: true
        };
      }
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(filePath)
      );
      return {
        exists: true,
        isDirectory: false,
        content: Buffer.from(bytes).toString("utf8")
      };
    } catch {
      return {
        exists: false,
        isDirectory: false
      };
    }
  }
  async restoreSnapshot(filePath, snapshot) {
    const exists = await this.pathExists(filePath);
    if (!snapshot.exists) {
      if (exists) {
        await vscode.workspace.fs.delete(vscode.Uri.file(filePath), {
          recursive: true,
          useTrash: true
        });
      }
      return;
    }
    if (snapshot.isDirectory) {
      if (!exists) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(filePath));
      }
      return;
    }
    await this.ensureParentDir(filePath);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      Buffer.from(snapshot.content ?? "", "utf8")
    );
  }
  async ensureParentDir(filePath) {
    const dir = path.dirname(filePath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
  }
  async load() {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.file(this.editsPath)
    );
    const raw = Buffer.from(bytes).toString("utf8");
    const parsed = JSON.parse(raw);
    return {
      pendingProposal: parsed.pendingProposal ?? null,
      lastApplied: parsed.lastApplied ?? null
    };
  }
  async save(state) {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(this.editsPath),
      Buffer.from(JSON.stringify(state, null, 2), "utf8")
    );
  }
};

// src/agent/indexing/WorkspaceScanner.ts
var vscode2 = __toESM(require("vscode"));
var WorkspaceScanner = class {
  async scanWorkspace() {
    const files = await vscode2.workspace.findFiles(
      "**/*",
      "**/{node_modules,dist,.git}/**",
      5e3
    );
    return {
      totalFiles: files.length,
      indexedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  async findRelevantFiles(query, limit = 12) {
    const lowered = query.toLowerCase();
    const files = await vscode2.workspace.findFiles(
      "**/*",
      "**/{node_modules,dist,.git}/**",
      3e3
    );
    const ranked = files.map((f) => f.fsPath).filter((p) => p.toLowerCase().includes(lowered)).slice(0, limit);
    if (ranked.length > 0) {
      return ranked;
    }
    return files.map((f) => f.fsPath).slice(0, limit);
  }
  async readContextSnippets(paths, maxChars = 4e3) {
    const snippets = [];
    for (const path4 of paths) {
      try {
        const bytes = await vscode2.workspace.fs.readFile(vscode2.Uri.file(path4));
        const text = Buffer.from(bytes).toString("utf8");
        snippets.push({
          path: path4,
          content: text.slice(0, maxChars)
        });
      } catch {
      }
    }
    return snippets;
  }
};

// src/agent/mcp/McpManager.ts
var import_child_process = require("child_process");
var McpManager = class {
  constructor(serverDefs) {
    this.serverDefs = serverDefs;
  }
  async listServerStatus() {
    const statuses = [];
    for (const server of this.serverDefs) {
      const id = String(server.id ?? "unknown");
      const enabled = Boolean(server.enabled ?? false);
      const trust = String(server.trust ?? "unknown");
      const transport = String(server.transport ?? "stdio");
      if (!enabled) {
        statuses.push({
          id,
          enabled,
          trust,
          transport,
          state: "disabled",
          detail: "Server is disabled by configuration."
        });
        continue;
      }
      if (transport === "stdio") {
        const command = typeof server.command === "string" ? server.command.trim() : "";
        if (!command) {
          statuses.push({
            id,
            enabled,
            trust,
            transport,
            state: "error",
            detail: "Missing required stdio command."
          });
          continue;
        }
        if (!isCommandAvailable(command)) {
          statuses.push({
            id,
            enabled,
            trust,
            transport,
            state: "error",
            detail: `Command not found in PATH: ${command}`
          });
          continue;
        }
        statuses.push({
          id,
          enabled,
          trust,
          transport,
          state: "configured",
          detail: "Stdio command is available."
        });
        continue;
      }
      if (transport === "sse" || transport === "http") {
        const url = typeof server.url === "string" ? server.url.trim() : "";
        if (!url) {
          statuses.push({
            id,
            enabled,
            trust,
            transport,
            state: "error",
            detail: "Missing required server url."
          });
          continue;
        }
        try {
          new URL(url);
          statuses.push({
            id,
            enabled,
            trust,
            transport,
            state: "configured",
            detail: "Remote MCP URL appears valid."
          });
        } catch {
          statuses.push({
            id,
            enabled,
            trust,
            transport,
            state: "error",
            detail: `Invalid URL: ${url}`
          });
        }
        continue;
      }
      statuses.push({
        id,
        enabled,
        trust,
        transport,
        state: "error",
        detail: `Unsupported transport: ${transport}`
      });
    }
    return statuses;
  }
};
function isCommandAvailable(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = (0, import_child_process.spawnSync)(probe, [command], {
    stdio: "ignore",
    shell: false
  });
  return result.status === 0;
}

// src/agent/model/OllamaProvider.ts
var OllamaProvider = class {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  async healthCheck() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET"
      });
      if (!response.ok) {
        return {
          ok: false,
          message: `Ollama unavailable (HTTP ${response.status})`
        };
      }
      return {
        ok: true,
        message: "Ollama reachable"
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Unknown Ollama error"
      };
    }
  }
  async listModels() {
    const [localModels, runningModels] = await Promise.all([
      this.fetchLocalModels(),
      this.fetchRunningModels()
    ]);
    return dedupeAndSortModels([...localModels, ...runningModels]);
  }
  async chat(request) {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: false,
        options: {
          temperature: request.temperature ?? 0.1
        },
        format: request.format
      })
    });
    if (!response.ok) {
      throw new Error(`Ollama chat failed (HTTP ${response.status})`);
    }
    const data = await response.json();
    const text = data.message?.content?.trim() ?? "";
    const promptTokens = Number.isFinite(data.prompt_eval_count) ? Number(data.prompt_eval_count) : 0;
    const completionTokens = Number.isFinite(data.eval_count) ? Number(data.eval_count) : 0;
    return {
      text,
      raw: data,
      tokenUsage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens
      }
    };
  }
  async fetchLocalModels() {
    const response = await fetch(`${this.baseUrl}/api/tags`, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Failed to list Ollama models (HTTP ${response.status})`);
    }
    const data = await response.json();
    const models = data.models ?? [];
    return models.map((model) => ({
      name: model.name,
      sizeBytes: model.size,
      modifiedAt: model.modified_at,
      source: "local"
    }));
  }
  async fetchRunningModels() {
    try {
      const response = await fetch(`${this.baseUrl}/api/ps`, { method: "GET" });
      if (!response.ok) {
        return [];
      }
      const data = await response.json();
      const models = data.models ?? [];
      return models.map((model) => ({
        name: typeof model.name === "string" ? model.name : model.model,
        sizeBytes: model.size,
        modifiedAt: model.modified_at,
        source: "running"
      })).filter(
        (model) => typeof model.name === "string" && model.name.length > 0
      );
    } catch {
      return [];
    }
  }
};
function dedupeAndSortModels(models) {
  const byName = /* @__PURE__ */ new Map();
  for (const model of models) {
    const existing = byName.get(model.name);
    if (!existing) {
      byName.set(model.name, model);
      continue;
    }
    byName.set(model.name, {
      name: model.name,
      sizeBytes: model.sizeBytes ?? existing.sizeBytes,
      modifiedAt: model.modifiedAt ?? existing.modifiedAt,
      source: existing.source === "local" || model.source === "local" ? "local" : existing.source === "running" || model.source === "running" ? "running" : existing.source
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// src/agent/memory/MemoryStore.ts
var vscode3 = __toESM(require("vscode"));
var MemoryStore = class {
  constructor(memoriesPath) {
    this.memoriesPath = memoriesPath;
  }
  async addEpisode(objective, summary) {
    const state = await this.load();
    state.episodic.unshift({
      id: crypto.randomUUID(),
      objective,
      summary,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    state.episodic = state.episodic.slice(0, 80);
    await this.save(state);
  }
  async setPreference(key, value) {
    const state = await this.load();
    state.preferences[key] = value;
    await this.save(state);
  }
  async getPreference(key) {
    const state = await this.load();
    return state.preferences[key];
  }
  async latestEpisodes(limit = 5) {
    const state = await this.load();
    return state.episodic.slice(0, limit);
  }
  async load() {
    const bytes = await vscode3.workspace.fs.readFile(
      vscode3.Uri.file(this.memoriesPath)
    );
    const raw = Buffer.from(bytes).toString("utf8");
    const parsed = JSON.parse(raw);
    return {
      workspaceFacts: parsed.workspaceFacts ?? [],
      episodic: parsed.episodic ?? [],
      preferences: parsed.preferences ?? {}
    };
  }
  async save(state) {
    await vscode3.workspace.fs.writeFile(
      vscode3.Uri.file(this.memoriesPath),
      Buffer.from(JSON.stringify(state, null, 2), "utf8")
    );
  }
};

// src/agent/planner/Planner.ts
var Planner = class {
  constructor(provider) {
    this.provider = provider;
  }
  async createPlan(objective, model) {
    const prompt = [
      "Create a concise JSON plan for a coding agent task.",
      "Return valid JSON only with fields: objective, assumptions, steps, verification.",
      "Each step must contain id, goal, tools, expectedOutput.",
      `Task objective: ${objective}`
    ].join("\n");
    try {
      const response = await this.provider.chat({
        model,
        format: "json",
        messages: [
          {
            role: "system",
            content: "You are a planning engine for a VS Code coding agent."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      });
      const parsed = JSON.parse(response.text);
      return normalizePlan(parsed, objective);
    } catch {
      return fallbackPlan(objective);
    }
  }
};
function normalizePlan(plan, objective) {
  return {
    objective: plan.objective ?? objective,
    assumptions: plan.assumptions ?? [
      "Workspace files are available and readable."
    ],
    steps: (plan.steps ?? []).map((step, index) => ({
      id: step.id ?? `step_${index + 1}`,
      goal: step.goal ?? "Execute task step",
      tools: step.tools ?? ["read_file"],
      expectedOutput: step.expectedOutput ?? "Progress towards objective"
    })),
    verification: plan.verification ?? [
      {
        type: "diagnostics",
        command: "Inspect editor diagnostics for touched files"
      }
    ]
  };
}
function fallbackPlan(objective) {
  return {
    objective,
    assumptions: [
      "No reliable structured plan response from model; fallback plan used."
    ],
    steps: [
      {
        id: "step_1",
        goal: "Gather relevant workspace context",
        tools: ["search", "read_file"],
        expectedOutput: "Candidate files and local evidence"
      },
      {
        id: "step_2",
        goal: "Generate implementation or explanation",
        tools: ["model.chat"],
        expectedOutput: "Actionable response"
      }
    ],
    verification: [
      {
        type: "diagnostics",
        command: "Inspect diagnostics and summarize next actions"
      }
    ]
  };
}

// src/agent/sessions/SessionStore.ts
var vscode4 = __toESM(require("vscode"));
var SessionStore = class {
  constructor(sessionsPath) {
    this.sessionsPath = sessionsPath;
  }
  async createSession(objective, modelProfile) {
    const state = await this.load();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const record = {
      id: crypto.randomUUID(),
      title: objective.slice(0, 80),
      objective,
      createdAt: now,
      updatedAt: now,
      modelProfile
    };
    state.sessions.unshift(record);
    state.activeSessionId = record.id;
    await this.save(state);
    return record;
  }
  async getActiveSession() {
    const state = await this.load();
    if (!state.activeSessionId) {
      return null;
    }
    return state.sessions.find((s) => s.id === state.activeSessionId) ?? null;
  }
  async updateSessionResult(sessionId, result) {
    const state = await this.load();
    const found = state.sessions.find((s) => s.id === sessionId);
    if (!found) {
      return;
    }
    found.lastResult = result;
    found.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.save(state);
  }
  async listSessions() {
    const state = await this.load();
    return state.sessions;
  }
  async load() {
    const bytes = await vscode4.workspace.fs.readFile(
      vscode4.Uri.file(this.sessionsPath)
    );
    const raw = Buffer.from(bytes).toString("utf8");
    const parsed = JSON.parse(raw);
    return {
      activeSessionId: parsed.activeSessionId ?? null,
      sessions: parsed.sessions ?? []
    };
  }
  async save(state) {
    await vscode4.workspace.fs.writeFile(
      vscode4.Uri.file(this.sessionsPath),
      Buffer.from(JSON.stringify(state, null, 2), "utf8")
    );
  }
};

// src/agent/verification/VerificationRunner.ts
var vscode5 = __toESM(require("vscode"));
var VerificationRunner = class {
  runDiagnostics() {
    const allDiagnostics = vscode5.languages.getDiagnostics();
    let errorCount = 0;
    for (const [, diagnostics] of allDiagnostics) {
      for (const diagnostic of diagnostics) {
        if (diagnostic.severity === vscode5.DiagnosticSeverity.Error) {
          errorCount += 1;
        }
      }
    }
    return {
      diagnosticsCount: allDiagnostics.reduce(
        (acc, [, diagnostics]) => acc + diagnostics.length,
        0
      ),
      hasErrors: errorCount > 0,
      summary: errorCount > 0 ? `${errorCount} error diagnostics currently active.` : "No error diagnostics reported."
    };
  }
};

// src/agent/runtime/AgentRuntime.ts
var AgentRuntime = class {
  constructor(config, storage, logger) {
    this.storage = storage;
    this.logger = logger;
    this.currentConfig = { ...config };
    this.provider = new OllamaProvider(config.ollamaBaseUrl);
    this.planner = new Planner(this.provider);
    this.scanner = new WorkspaceScanner();
    this.sessionStore = new SessionStore(storage.sessionsPath);
    this.memoryStore = new MemoryStore(storage.memoriesPath);
    this.editManager = new EditManager(storage.editsPath, storage.snapshotsDir);
    this.verifier = new VerificationRunner();
    this.mcpManager = new McpManager(config.mcpServers);
  }
  provider;
  planner;
  scanner;
  sessionStore;
  memoryStore;
  editManager;
  verifier;
  mcpManager;
  currentConfig;
  health = { ok: false, message: "Not checked" };
  availableModels = [];
  tokensConsumed = 0;
  async initialize() {
    this.health = await this.provider.healthCheck();
    if (this.health.ok) {
      try {
        this.availableModels = await this.provider.listModels();
        this.availableModels = this.mergeConfiguredModels(this.availableModels);
      } catch (error) {
        this.logger.warn(`Failed to list models: ${stringifyError(error)}`);
      }
    }
    this.logger.info("AgentRuntime initialized");
    this.logger.debug(`Planner model: ${this.currentConfig.plannerModel}`);
    this.logger.debug(`Editor model: ${this.currentConfig.editorModel}`);
    this.logger.debug(`Fast model: ${this.currentConfig.fastModel}`);
    this.logger.debug(`Storage path: ${this.storage.storageDir}`);
    this.logger.info(`Ollama health: ${this.health.message}`);
  }
  async refreshProviderState() {
    this.health = await this.provider.healthCheck();
    if (this.health.ok) {
      this.availableModels = await this.provider.listModels();
      this.availableModels = this.mergeConfiguredModels(this.availableModels);
      return;
    }
    this.availableModels = this.mergeConfiguredModels([]);
  }
  async listAvailableModels() {
    if (this.availableModels.length === 0) {
      await this.refreshProviderState();
    }
    return this.availableModels;
  }
  async selectModel(role, modelName) {
    const models = await this.listAvailableModels();
    if (!models.some((model) => model.name === modelName)) {
      throw new Error(
        `Model ${modelName} is not available locally. Sync models and try again.`
      );
    }
    const cfg = vscode6.workspace.getConfiguration("pulse");
    const targetKey = role === "planner" ? "models.planner" : role === "editor" ? "models.editor" : role === "fast" ? "models.fast" : "models.embedding";
    await cfg.update(
      targetKey,
      modelName,
      vscode6.ConfigurationTarget.Workspace
    );
    if (role === "planner") {
      this.currentConfig.plannerModel = modelName;
    } else if (role === "editor") {
      this.currentConfig.editorModel = modelName;
    } else if (role === "fast") {
      this.currentConfig.fastModel = modelName;
    } else {
      this.currentConfig.embeddingModel = modelName;
    }
    await this.memoryStore.setPreference(`model.${role}`, modelName);
    this.logger.info(`Updated ${role} model to ${modelName}`);
  }
  async explainText(input) {
    const model = await this.resolveModelOrFallback(
      this.currentConfig.fastModel
    );
    const response = await this.provider.chat({
      model,
      messages: [
        {
          role: "system",
          content: "You are Pulse, a senior coding assistant. Explain code accurately and concisely with practical details."
        },
        {
          role: "user",
          content: input
        }
      ]
    });
    this.consumeTokens(response.tokenUsage);
    return {
      text: response.text,
      model
    };
  }
  async runTask(objective) {
    const session = await this.sessionStore.createSession(objective, {
      planner: this.currentConfig.plannerModel,
      editor: this.currentConfig.editorModel,
      fast: this.currentConfig.fastModel
    });
    const plannerModel = await this.resolveModelOrFallback(
      this.currentConfig.plannerModel
    );
    const editorModel = await this.resolveModelOrFallback(
      this.currentConfig.editorModel
    );
    const plan = await this.planner.createPlan(objective, plannerModel);
    const candidateFiles = await this.scanner.findRelevantFiles(objective, 8);
    const contextSnippets = await this.scanner.readContextSnippets(
      candidateFiles.slice(0, 4),
      2400
    );
    const episodes = this.currentConfig.memoryMode === "off" ? [] : await this.memoryStore.latestEpisodes(3);
    const prompt = [
      "You are Pulse, an agentic coding assistant working inside VS Code.",
      "Operating rules:",
      "- Prefer minimal, targeted edits over broad rewrites.",
      "- Keep behavior backward compatible unless the objective requires change.",
      "- Never propose edits outside the current workspace.",
      "- If requirements are ambiguous, state assumptions explicitly in the response.",
      "Solve the objective using the context below.",
      "If edits are needed, return strict JSON with fields:",
      '{"response":"string","edits":[{"operation":"write|delete|move","filePath":"relative/or/absolute","targetPath":"required for move","content":"required for write","reason":"string"}]}.',
      "If no edits are needed, return JSON with edits as empty array.",
      "Allowed operations:",
      "- write: create or replace a file",
      "- delete: remove a file or folder",
      "- move: move/rename a file path to targetPath",
      `Objective: ${objective}`,
      "Plan:",
      JSON.stringify(plan, null, 2),
      "Recent episodic memory:",
      JSON.stringify(episodes, null, 2),
      "Context snippets:",
      JSON.stringify(contextSnippets, null, 2)
    ].join("\n\n");
    const response = await this.provider.chat({
      model: editorModel,
      format: "json",
      messages: [
        {
          role: "system",
          content: "Follow instructions exactly and produce valid JSON. Do not include markdown fences. Optimize for correctness, minimal diffs, and safe file operations."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });
    this.consumeTokens(response.tokenUsage);
    const parsed = parseTaskResponse(response.text);
    const normalizedEdits = parsed.edits.map(
      (edit) => normalizeEditPath(edit, vscode6.workspace.workspaceFolders ?? [])
    ).filter((edit) => edit !== null);
    const proposal = normalizedEdits.length > 0 ? await this.editManager.setPendingProposal(objective, normalizedEdits) : null;
    await this.sessionStore.updateSessionResult(session.id, parsed.response);
    if (this.currentConfig.memoryMode !== "off") {
      await this.memoryStore.addEpisode(
        objective,
        parsed.response.slice(0, 400)
      );
    }
    return {
      sessionId: session.id,
      objective,
      plan,
      responseText: parsed.response,
      proposal
    };
  }
  async applyPendingEdits(userApproved = false) {
    if (this.currentConfig.approvalMode !== "fast" && !userApproved) {
      return "Approval required before applying pending edits.";
    }
    const result = await this.editManager.applyPending();
    if (!result) {
      return "No pending proposal to apply.";
    }
    if (this.currentConfig.memoryMode !== "off") {
      await this.memoryStore.addEpisode(
        "apply_pending_edits",
        `Applied transaction ${result.id}`
      );
    }
    return `Applied transaction ${result.id}.`;
  }
  async revertLastAppliedEdits() {
    const reverted = await this.editManager.revertLastApplied();
    if (!reverted) {
      return "No applied transaction to revert.";
    }
    if (this.currentConfig.memoryMode !== "off") {
      await this.memoryStore.addEpisode(
        "revert_last_transaction",
        `Reverted transaction ${reverted.id}`
      );
    }
    return `Reverted transaction ${reverted.id}.`;
  }
  getApprovalMode() {
    return this.currentConfig.approvalMode;
  }
  async setApprovalMode(mode) {
    const cfg = vscode6.workspace.getConfiguration("pulse");
    await cfg.update(
      "behavior.approvalMode",
      mode,
      vscode6.ConfigurationTarget.Workspace
    );
    this.currentConfig.approvalMode = mode;
    await this.memoryStore.setPreference("approval.mode", mode);
  }
  async getPendingProposalSummary() {
    const proposal = await this.editManager.getPendingProposal();
    if (!proposal) {
      return "No pending edit proposal.";
    }
    const lines = proposal.edits.map(
      (edit) => `- [${edit.operation ?? "write"}] ${edit.filePath}${edit.targetPath ? ` -> ${edit.targetPath}` : ""}${edit.reason ? ` (${edit.reason})` : ""}`
    );
    return [`Pending proposal: ${proposal.objective}`, ...lines].join("\n");
  }
  async resumeLastSessionSummary() {
    const active = await this.sessionStore.getActiveSession();
    if (!active) {
      return "No active session available.";
    }
    return [
      `Session: ${active.id}`,
      `Title: ${active.title}`,
      `Updated: ${active.updatedAt}`,
      `Last result: ${active.lastResult ?? "None"}`
    ].join("\n");
  }
  async listRecentSessions(limit = 6) {
    const sessions = await this.sessionStore.listSessions();
    return sessions.slice(0, limit).map((session) => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt
    }));
  }
  async reindexWorkspace() {
    const stats = await this.scanner.scanWorkspace();
    return `Indexed ${stats.totalFiles} files at ${stats.indexedAt}`;
  }
  diagnosticsSummary() {
    const result = this.verifier.runDiagnostics();
    return result.summary;
  }
  async mcpSummary() {
    const servers = await this.mcpManager.listServerStatus();
    if (servers.length === 0) {
      return "No MCP servers configured.";
    }
    return servers.map(
      (server) => `${server.id}: ${server.state} (transport=${server.transport}, trust=${server.trust}) - ${server.detail}`
    ).join("\n");
  }
  async diagnosticsReportMarkdown() {
    const pendingSummary = await this.getPendingProposalSummary();
    const activeSession = await this.resumeLastSessionSummary();
    const mcp = await this.mcpSummary();
    const diagnostics = this.diagnosticsSummary();
    return [
      "# Pulse Diagnostics Report",
      "",
      `- Status: ${this.health.ok ? "ready" : "degraded"}`,
      `- Ollama: ${this.health.message}`,
      `- Planner model: ${this.currentConfig.plannerModel}`,
      `- Editor model: ${this.currentConfig.editorModel}`,
      `- Fast model: ${this.currentConfig.fastModel}`,
      `- Storage: ${this.storage.storageDir}`,
      `- Available models: ${this.availableModels.length}`,
      "",
      "## Active Session",
      "",
      "```text",
      activeSession,
      "```",
      "",
      "## Pending Edits",
      "",
      "```text",
      pendingSummary,
      "```",
      "",
      "## Diagnostics",
      "",
      "```text",
      diagnostics,
      "```",
      "",
      "## MCP",
      "",
      "```text",
      mcp,
      "```"
    ].join("\n");
  }
  async summary() {
    const active = await this.sessionStore.getActiveSession();
    const pending = await this.editManager.getPendingProposal();
    const mcpStatuses = await this.mcpManager.listServerStatus();
    const mcpConfigured = mcpStatuses.filter((s) => s.enabled).length;
    const mcpHealthy = mcpStatuses.filter(
      (s) => s.state === "configured"
    ).length;
    const tokenBudget = Math.max(this.currentConfig.maxContextTokens, 1);
    const tokenUsagePercent = Math.min(
      100,
      Math.round(this.tokensConsumed / tokenBudget * 100)
    );
    return {
      status: this.health.ok ? "ready" : "degraded",
      plannerModel: this.currentConfig.plannerModel,
      editorModel: this.currentConfig.editorModel,
      fastModel: this.currentConfig.fastModel,
      embeddingModel: this.currentConfig.embeddingModel,
      approvalMode: this.currentConfig.approvalMode,
      storagePath: this.storage.storageDir,
      ollamaHealth: this.health.message,
      modelCount: this.availableModels.length,
      activeSessionId: active?.id ?? null,
      hasPendingEdits: pending !== null,
      tokenBudget,
      tokensConsumed: this.tokensConsumed,
      tokenUsagePercent,
      mcpConfigured,
      mcpHealthy
    };
  }
  mergeConfiguredModels(discovered) {
    const merged = /* @__PURE__ */ new Map();
    for (const model of discovered) {
      merged.set(model.name, model);
    }
    const configuredModels = [
      this.currentConfig.plannerModel,
      this.currentConfig.editorModel,
      this.currentConfig.fastModel,
      this.currentConfig.embeddingModel,
      ...this.currentConfig.fallbackModels
    ];
    for (const configured of configuredModels) {
      if (!configured || merged.has(configured)) {
        continue;
      }
      merged.set(configured, {
        name: configured,
        source: "configured"
      });
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  consumeTokens(usage) {
    if (!usage) {
      return;
    }
    this.tokensConsumed += Math.max(usage.totalTokens, 0);
  }
  async resolveModelOrFallback(primary) {
    const models = await this.listAvailableModels();
    const names = new Set(models.map((model) => model.name));
    if (names.has(primary)) {
      return primary;
    }
    for (const fallback of this.currentConfig.fallbackModels) {
      if (names.has(fallback)) {
        this.logger.warn(
          `Model ${primary} unavailable. Falling back to ${fallback}.`
        );
        return fallback;
      }
    }
    if (models[0]?.name) {
      this.logger.warn(
        `Model ${primary} unavailable. Falling back to first discovered model ${models[0].name}.`
      );
      return models[0].name;
    }
    return primary;
  }
};
function parseTaskResponse(raw) {
  try {
    const parsed = JSON.parse(raw);
    const response = typeof parsed.response === "string" ? parsed.response : "Task completed.";
    const edits = [];
    for (const edit of parsed.edits ?? []) {
      if (typeof edit.filePath !== "string") {
        continue;
      }
      const operation = edit.operation === "delete" || edit.operation === "move" ? edit.operation : "write";
      if (operation === "write" && typeof edit.content !== "string") {
        continue;
      }
      if (operation === "move" && typeof edit.targetPath !== "string") {
        continue;
      }
      edits.push({
        operation,
        filePath: edit.filePath,
        targetPath: typeof edit.targetPath === "string" ? edit.targetPath : void 0,
        content: typeof edit.content === "string" ? edit.content : void 0,
        reason: typeof edit.reason === "string" ? edit.reason : void 0
      });
    }
    return { response, edits };
  } catch {
    return {
      response: raw,
      edits: []
    };
  }
}
function normalizeEditPath(edit, folders) {
  const root = folders[0]?.uri.fsPath;
  if (!root) {
    return null;
  }
  const normalizeSingle = (p) => path2.isAbsolute(p) ? p : path2.join(root, p);
  return {
    ...edit,
    filePath: normalizeSingle(edit.filePath),
    targetPath: edit.targetPath ? normalizeSingle(edit.targetPath) : void 0
  };
}
function stringifyError(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/commands/registerCommands.ts
var vscode7 = __toESM(require("vscode"));
function registerCommands(context, runtime, logger) {
  const commandHandlers = [
    ["pulse.openPanel", () => openPanel(runtime)],
    ["pulse.startNewTask", () => startNewTask(runtime)],
    ["pulse.explainSelection", () => explainSelection(runtime)],
    ["pulse.fixDiagnosticsCurrentFile", () => showDiagnosticsSummary(runtime)],
    ["pulse.refactorWorkspaceScope", () => startWorkspaceRefactor(runtime)],
    ["pulse.resumeLastSession", () => resumeLastSession(runtime)],
    ["pulse.applyProposedChanges", () => applyProposedChanges(runtime)],
    ["pulse.revertLastAgentChanges", () => revertLastChanges(runtime)],
    ["pulse.reindexWorkspace", () => reindexWorkspace(runtime)],
    ["pulse.manageMcpConnections", () => manageMcpConnections(runtime)],
    ["pulse.openDiagnosticsReport", () => openDiagnostics(runtime)],
    ["pulse.selectModels", () => selectModels(runtime)],
    ["pulse.setApprovalMode", () => setApprovalMode(runtime)]
  ];
  for (const [commandId, handler] of commandHandlers) {
    const disposable = vscode7.commands.registerCommand(commandId, handler);
    context.subscriptions.push(disposable);
    logger.debug(`Registered command ${commandId}`);
  }
}
function openPanel(runtime) {
  const panel = vscode7.window.createWebviewPanel(
    "pulse.panel",
    "Pulse",
    vscode7.ViewColumn.Beside,
    {
      enableScripts: true
    }
  );
  void runtime.summary().then((summary) => {
    panel.webview.html = `<html><body style="font-family: var(--vscode-font-family); padding: 12px;">
    <h2>Pulse Panel</h2>
    <p>Runtime: ${summary.status}</p>
    <p>Ollama: ${summary.ollamaHealth}</p>
    <p>Planner model: ${summary.plannerModel}</p>
    <p>Editor model: ${summary.editorModel}</p>
    <p>Fast model: ${summary.fastModel}</p>
    <p>Use command palette for task execution and model selection.</p>
  </body></html>`;
  });
}
async function explainSelection(runtime) {
  const editor = vscode7.window.activeTextEditor;
  if (!editor) {
    void vscode7.window.showWarningMessage("Pulse: No active editor.");
    return;
  }
  const selectedText = editor.document.getText(editor.selection).trim();
  if (!selectedText) {
    void vscode7.window.showWarningMessage(
      "Pulse: Select code to explain first."
    );
    return;
  }
  const result = await runtime.explainText(selectedText);
  const doc = await vscode7.workspace.openTextDocument({
    language: "markdown",
    content: `# Pulse Explanation

Model: ${result.model}

${result.text}`
  });
  await vscode7.window.showTextDocument(doc, { preview: false });
}
async function openDiagnostics(runtime) {
  const content = await runtime.diagnosticsReportMarkdown();
  const doc = await vscode7.workspace.openTextDocument({
    language: "markdown",
    content
  });
  await vscode7.window.showTextDocument(doc, { preview: false });
}
async function startNewTask(runtime) {
  const objective = await vscode7.window.showInputBox({
    title: "Pulse: Start New Task",
    prompt: "Describe the task objective",
    ignoreFocusOut: true
  });
  if (!objective) {
    return;
  }
  const result = await runtime.runTask(objective);
  const proposalSummary = result.proposal ? `

## Pending Edits

${result.proposal.edits.map((e) => `- [${e.operation ?? "write"}] ${e.filePath}${e.targetPath ? ` -> ${e.targetPath}` : ""}`).join("\n")}` : "\n\nNo pending edits were proposed.";
  const doc = await vscode7.workspace.openTextDocument({
    language: "markdown",
    content: `# Pulse Task Result

Session: ${result.sessionId}

## Objective

${result.objective}

## Plan

\`\`\`json
${JSON.stringify(result.plan, null, 2)}
\`\`\`

## Response

${result.responseText}${proposalSummary}`
  });
  await vscode7.window.showTextDocument(doc, { preview: false });
}
async function startWorkspaceRefactor(runtime) {
  const objective = await vscode7.window.showInputBox({
    title: "Pulse: Workspace Refactor",
    prompt: "Describe the refactor objective",
    ignoreFocusOut: true
  });
  if (!objective) {
    return;
  }
  await startNewTaskWithObjective(runtime, objective);
}
async function startNewTaskWithObjective(runtime, objective) {
  const result = await runtime.runTask(objective);
  const doc = await vscode7.workspace.openTextDocument({
    language: "markdown",
    content: `# Pulse Task Result

Session: ${result.sessionId}

## Objective

${result.objective}

## Response

${result.responseText}`
  });
  await vscode7.window.showTextDocument(doc, { preview: false });
}
async function resumeLastSession(runtime) {
  const summary = await runtime.resumeLastSessionSummary();
  await vscode7.window.showInformationMessage(`Pulse: ${summary}`);
}
async function applyProposedChanges(runtime) {
  const mode = runtime.getApprovalMode();
  const pendingSummary = await runtime.getPendingProposalSummary();
  let approved = false;
  if (mode !== "fast") {
    const decision = await vscode7.window.showWarningMessage(
      `Pulse will apply pending proposal.

${pendingSummary}`,
      { modal: true },
      "Apply"
    );
    if (decision !== "Apply") {
      return;
    }
    approved = true;
  }
  const result = await runtime.applyPendingEdits(approved);
  await vscode7.window.showInformationMessage(`Pulse: ${result}`);
}
async function revertLastChanges(runtime) {
  const decision = await vscode7.window.showWarningMessage(
    "Pulse will revert the last applied transaction.",
    { modal: true },
    "Revert"
  );
  if (decision !== "Revert") {
    return;
  }
  const result = await runtime.revertLastAppliedEdits();
  await vscode7.window.showInformationMessage(`Pulse: ${result}`);
}
async function reindexWorkspace(runtime) {
  const result = await runtime.reindexWorkspace();
  await vscode7.window.showInformationMessage(`Pulse: ${result}`);
}
async function manageMcpConnections(runtime) {
  const summary = await runtime.mcpSummary();
  const doc = await vscode7.workspace.openTextDocument({
    language: "markdown",
    content: `# Pulse MCP Status

\`\`\`text
${summary}
\`\`\`
`
  });
  await vscode7.window.showTextDocument(doc, { preview: false });
}
async function showDiagnosticsSummary(runtime) {
  await vscode7.window.showInformationMessage(
    `Pulse: ${runtime.diagnosticsSummary()}`
  );
}
async function selectModels(runtime) {
  const models = await runtime.listAvailableModels();
  if (models.length === 0) {
    await vscode7.window.showWarningMessage(
      "Pulse: No Ollama models discovered. Verify Ollama is running."
    );
    return;
  }
  const role = await vscode7.window.showQuickPick(
    ["planner", "editor", "fast", "embedding"],
    {
      title: "Select model role",
      placeHolder: "Choose the model slot to update"
    }
  );
  if (!role) {
    return;
  }
  const picked = await vscode7.window.showQuickPick(
    models.map((m) => ({
      label: m.name,
      description: m.modifiedAt ?? ""
    })),
    {
      title: `Select ${role} model`,
      placeHolder: "Choose from locally available Ollama models"
    }
  );
  if (!picked) {
    return;
  }
  await runtime.selectModel(
    role,
    picked.label
  );
  await vscode7.window.showInformationMessage(
    `Pulse: Updated ${role} model to ${picked.label}`
  );
}
async function setApprovalMode(runtime) {
  const mode = await vscode7.window.showQuickPick(
    ["strict", "balanced", "fast"],
    {
      title: "Pulse Approval Mode",
      placeHolder: "Choose approval mode for write actions"
    }
  );
  if (!mode) {
    return;
  }
  await runtime.setApprovalMode(mode);
  await vscode7.window.showInformationMessage(
    `Pulse: Approval mode set to ${mode}`
  );
}

// src/config/AgentConfig.ts
var vscode8 = __toESM(require("vscode"));
function getAgentConfig() {
  const cfg = vscode8.workspace.getConfiguration("pulse");
  return {
    ollamaBaseUrl: cfg.get("ollama.baseUrl", "http://localhost:11434"),
    plannerModel: cfg.get("models.planner", "qwen2.5-coder:14b"),
    editorModel: cfg.get("models.editor", "deepseek-coder-v2:16b"),
    fastModel: cfg.get("models.fast", "qwen2.5-coder:7b"),
    embeddingModel: cfg.get("models.embedding", "nomic-embed-text"),
    fallbackModels: cfg.get("models.fallbacks", ["qwen2.5-coder:7b"]),
    approvalMode: cfg.get("behavior.approvalMode", "balanced"),
    allowTerminalExecution: cfg.get(
      "behavior.allowTerminalExecution",
      false
    ),
    autoRunVerification: cfg.get("behavior.autoRunVerification", true),
    maxContextTokens: cfg.get("behavior.maxContextTokens", 32e3),
    memoryMode: cfg.get(
      "behavior.memoryMode",
      "workspace+episodic"
    ),
    indexingEnabled: cfg.get("indexing.enabled", true),
    indexingMode: cfg.get("indexing.mode", "hybrid"),
    mcpServers: cfg.get("mcp.servers", []),
    telemetryOptIn: cfg.get("telemetry.optIn", false)
  };
}

// src/db/StorageBootstrap.ts
var vscode9 = __toESM(require("vscode"));
var path3 = __toESM(require("path"));
async function bootstrapStorage(context, logger) {
  const storageDir = context.globalStorageUri.fsPath;
  const tracesDir = path3.join(storageDir, "traces");
  const snapshotsDir = path3.join(storageDir, "snapshots");
  const dbPath = path3.join(storageDir, "db.sqlite");
  const sessionsPath = path3.join(storageDir, "sessions.json");
  const memoriesPath = path3.join(storageDir, "memories.json");
  const editsPath = path3.join(storageDir, "edits.json");
  await vscode9.workspace.fs.createDirectory(vscode9.Uri.file(storageDir));
  await vscode9.workspace.fs.createDirectory(vscode9.Uri.file(tracesDir));
  await vscode9.workspace.fs.createDirectory(vscode9.Uri.file(snapshotsDir));
  try {
    await vscode9.workspace.fs.stat(vscode9.Uri.file(dbPath));
  } catch {
    await vscode9.workspace.fs.writeFile(
      vscode9.Uri.file(dbPath),
      new Uint8Array()
    );
  }
  await ensureJsonFile(sessionsPath, { activeSessionId: null, sessions: [] });
  await ensureJsonFile(memoriesPath, {
    workspaceFacts: [],
    episodic: [],
    preferences: {}
  });
  await ensureJsonFile(editsPath, { pendingProposal: null, lastApplied: null });
  logger.info(`Storage initialized at ${storageDir}`);
  return {
    storageDir,
    dbPath,
    tracesDir,
    snapshotsDir,
    sessionsPath,
    memoriesPath,
    editsPath
  };
}
async function ensureJsonFile(filePath, initialValue) {
  try {
    await vscode9.workspace.fs.stat(vscode9.Uri.file(filePath));
  } catch {
    await vscode9.workspace.fs.writeFile(
      vscode9.Uri.file(filePath),
      Buffer.from(JSON.stringify(initialValue, null, 2), "utf8")
    );
  }
}

// src/platform/vscode/Logger.ts
var vscode10 = __toESM(require("vscode"));
function createLogger() {
  const channel = vscode10.window.createOutputChannel("Pulse");
  function format(level, message) {
    return `${(/* @__PURE__ */ new Date()).toISOString()} [${level}] ${message}`;
  }
  return {
    info(message) {
      channel.appendLine(format("INFO", message));
    },
    warn(message) {
      channel.appendLine(format("WARN", message));
    },
    error(message, error) {
      const suffix = error instanceof Error ? ` | ${error.message}` : error ? ` | ${String(error)}` : "";
      channel.appendLine(format("ERROR", `${message}${suffix}`));
    },
    debug(message) {
      channel.appendLine(format("DEBUG", message));
    },
    dispose() {
      channel.dispose();
    }
  };
}

// src/views/PulseSidebarProvider.ts
var PulseSidebarProvider = class {
  constructor(extensionUri, runtime, logger) {
    this.extensionUri = extensionUri;
    this.runtime = runtime;
    this.logger = logger;
  }
  static viewType = "pulse.sidebar";
  resolveWebviewView(webviewView) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        try {
          if (message.type === "loadDashboard") {
            const summary = await this.runtime.summary();
            const sessions = await this.runtime.listRecentSessions();
            await webviewView.webview.postMessage({
              type: "runtimeSummary",
              payload: summary
            });
            await webviewView.webview.postMessage({
              type: "sessions",
              payload: sessions
            });
            if (summary.ollamaHealth.toLowerCase().includes("reachable")) {
              const models = await this.runtime.listAvailableModels();
              await webviewView.webview.postMessage({
                type: "models",
                payload: models
              });
            }
            return;
          }
          if (message.type === "ping") {
            const summary = await this.runtime.summary();
            await webviewView.webview.postMessage({
              type: "runtimeSummary",
              payload: summary
            });
            return;
          }
          if (message.type === "refreshModels") {
            await this.runtime.refreshProviderState();
            const models = await this.runtime.listAvailableModels();
            await webviewView.webview.postMessage({
              type: "models",
              payload: models
            });
            return;
          }
          if (message.type === "runTask" && typeof message.payload === "string") {
            const result = await this.runtime.runTask(message.payload);
            await webviewView.webview.postMessage({
              type: "taskResult",
              payload: {
                responseText: result.responseText,
                sessionId: result.sessionId,
                proposedEdits: result.proposal?.edits.length ?? 0
              }
            });
            const sessions = await this.runtime.listRecentSessions();
            await webviewView.webview.postMessage({
              type: "sessions",
              payload: sessions
            });
            return;
          }
          if (message.type === "applyPending") {
            if (message.payload !== true && this.runtime.getApprovalMode() !== "fast") {
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload: "Apply canceled."
              });
              return;
            }
            const applied = await this.runtime.applyPendingEdits(
              message.payload === true
            );
            await webviewView.webview.postMessage({
              type: "actionResult",
              payload: applied
            });
            return;
          }
          if (message.type === "revertLast") {
            if (message.payload !== true) {
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload: "Revert canceled."
              });
              return;
            }
            const reverted = await this.runtime.revertLastAppliedEdits();
            await webviewView.webview.postMessage({
              type: "actionResult",
              payload: reverted
            });
            return;
          }
          if (message.type === "setApprovalMode" && (message.payload === "strict" || message.payload === "balanced" || message.payload === "fast")) {
            await this.runtime.setApprovalMode(message.payload);
            await webviewView.webview.postMessage({
              type: "actionResult",
              payload: `Approval mode set to ${message.payload}`
            });
            return;
          }
          if (message.type === "setModel" && typeof message.payload === "object" && message.payload !== null) {
            const payload = message.payload;
            if ((payload.role === "planner" || payload.role === "editor" || payload.role === "fast" || payload.role === "embedding") && typeof payload.model === "string" && payload.model.length > 0) {
              await this.runtime.selectModel(payload.role, payload.model);
              const summary = await this.runtime.summary();
              await webviewView.webview.postMessage({
                type: "runtimeSummary",
                payload: summary
              });
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload: `Updated ${payload.role} model to ${payload.model}`
              });
            }
            return;
          }
        } catch (error) {
          this.logger.error("Sidebar message handling failed", error);
          await webviewView.webview.postMessage({
            type: "actionResult",
            payload: `Error: ${error instanceof Error ? error.message : String(error)}`
          });
        }
      }
    );
  }
  buildHtml(webview) {
    const nonce = String(Date.now());
    const csp = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <style>
    /* \u2500\u2500\u2500 Reset \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    /* \u2500\u2500\u2500 Tokens \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    :root {
      --amber:      #f59e0b;
      --amber-bg:   rgba(245,158,11,0.12);
      --amber-bdr:  rgba(245,158,11,0.30);
      --green:      #22c55e;
      --green-bg:   rgba(34,197,94,0.10);
      --green-bdr:  rgba(34,197,94,0.28);
      --red:        var(--vscode-errorForeground, #f87171);
      --red-bg:     rgba(248,113,113,0.08);
      --red-bdr:    rgba(248,113,113,0.28);
      --r-sm: 8px;
      --r-md: 14px;
      --r-lg: 20px;
      --spd: 180ms;
    }

    /* \u2500\u2500\u2500 Layout \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    html, body {
      height: 100%;
      font-family: var(--vscode-font-family, "Segoe UI", system-ui, sans-serif);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      overflow: hidden;
    }

    #root {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    /* \u2500\u2500\u2500 Header \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    .hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px 9px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.18));
      flex-shrink: 0;
    }

    .hdr-left { display: flex; align-items: center; gap: 7px; }

    .logo {
      width: 24px; height: 24px;
      background: var(--amber);
      border-radius: 7px;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 900; color: #fff;
      letter-spacing: -0.5px;
      flex-shrink: 0;
    }

    .brand {
      font-size: 13px; font-weight: 700;
      letter-spacing: 0.8px; text-transform: uppercase;
    }

    .hdr-right { display: flex; align-items: center; gap: 6px; }

    .badge {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 11px; font-weight: 600;
      padding: 2px 8px; border-radius: 999px; border: 1px solid;
    }
    .badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .badge.on  { color: var(--green); border-color: var(--green-bdr); background: var(--green-bg); }
    .badge.off { color: var(--red);   border-color: var(--red-bdr);   background: var(--red-bg); }

    .icon-btn {
      width: 26px; height: 26px;
      border: none; background: transparent;
      color: var(--vscode-foreground); opacity: .55;
      cursor: pointer; border-radius: var(--r-sm);
      display: flex; align-items: center; justify-content: center;
      font-size: 15px; transition: opacity var(--spd), background var(--spd);
    }
    .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.14)); }

    /* \u2500\u2500\u2500 Settings drawer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    #settingsDrawer {
      display: none; flex-direction: column; gap: 8px;
      padding: 10px 12px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.18));
      flex-shrink: 0; background: var(--vscode-sideBar-background);
    }
    #settingsDrawer.open { display: flex; }

    .srow { display: grid; grid-template-columns: 68px 1fr; align-items: center; gap: 8px; }

    .slabel {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .5px; color: var(--vscode-descriptionForeground);
    }

    select {
      width: 100%; padding: 5px 7px;
      border-radius: var(--r-sm);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,.2));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font: 12px var(--vscode-font-family); cursor: pointer;
    }

    .sbtns { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }

    /* \u2500\u2500\u2500 Main scroll area \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    #main {
      flex: 1; overflow-y: auto; overflow-x: hidden;
      scroll-behavior: smooth;
    }

    /* \u2500\u2500\u2500 Home view \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    #homeView { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    #homeView.hidden, #chatView.hidden { display: none; }

    .new-btn {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; padding: 10px 14px;
      border-radius: var(--r-md);
      border: 1.5px dashed var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.25));
      background: transparent;
      color: var(--vscode-foreground);
      font: 600 13px var(--vscode-font-family); cursor: pointer; opacity: .65;
      transition: all var(--spd);
    }
    .new-btn:hover { opacity: 1; border-style: solid; border-color: var(--amber); background: var(--amber-bg); }

    .sec-title {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .7px; color: var(--vscode-descriptionForeground);
      padding: 0 2px;
    }

    .sessions {
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.14));
    }

    .sitem {
      display: flex; align-items: center; justify-content: space-between;
      padding: 9px 4px; cursor: pointer;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.1));
      border-radius: var(--r-sm); transition: background var(--spd);
    }
    .sitem:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.08)); }

    .sitem-title {
      font-size: 13px; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;
    }
    .sitem-time {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      margin-left: 8px; flex-shrink: 0;
    }

    /* \u2500\u2500\u2500 Chat view \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    #chatView { padding: 10px 12px 4px; display: flex; flex-direction: column; gap: 10px; }

    .back-btn {
      display: inline-flex; align-items: center; gap: 4px;
      border: none; background: none;
      color: var(--amber); font: 600 11px var(--vscode-font-family);
      cursor: pointer; opacity: .8; padding: 0 0 2px; width: fit-content;
    }
    .back-btn:hover { opacity: 1; }

    /* \u2500\u2500\u2500 Message bubbles \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    #messages { display: flex; flex-direction: column; gap: 10px; }

    .msg { max-width: 88%; }
    .msg.user  { align-self: flex-end; }
    .msg.agent { align-self: flex-start; }

    .bubble {
      padding: 9px 13px; border-radius: var(--r-md);
      line-height: 1.55; font-size: 13px; word-break: break-word;
    }
    .msg.user  .bubble { background: var(--amber); color: #fff; border-bottom-right-radius: 3px; }
    .msg.agent .bubble {
      background: var(--vscode-input-background, rgba(128,128,128,.1));
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,.15));
      border-bottom-left-radius: 3px;
    }

    .bubble code {
      font-family: var(--vscode-editor-font-family, "Cascadia Code", monospace);
      font-size: 11.5px;
      background: rgba(0,0,0,.16);
      padding: 1px 5px; border-radius: 4px;
    }
    .bubble pre {
      font-family: var(--vscode-editor-font-family, "Cascadia Code", monospace);
      font-size: 11.5px; line-height: 1.45;
      background: rgba(0,0,0,.18); border-radius: var(--r-sm);
      padding: 9px 11px; margin: 7px 0;
      overflow-x: auto; white-space: pre-wrap;
    }

    .msg-time {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      margin-top: 3px; padding: 0 2px;
    }
    .msg.user .msg-time { text-align: right; }

    /* \u2500\u2500\u2500 Typing indicator \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    #typing { align-self: flex-start; display: none; }
    #typing.on { display: block; }

    .typing-bubble {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 10px 13px; border-radius: var(--r-md); border-bottom-left-radius: 3px;
      background: var(--vscode-input-background, rgba(128,128,128,.1));
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,.15));
    }
    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--vscode-descriptionForeground, rgba(128,128,128,.7));
      animation: bounce 1.1s infinite ease-in-out;
    }
    .dot:nth-child(2) { animation-delay: .18s; }
    .dot:nth-child(3) { animation-delay: .36s; }
    @keyframes bounce {
      0%,60%,100% { transform: translateY(0); opacity: .5; }
      30%          { transform: translateY(-5px); opacity: 1; }
    }

    /* \u2500\u2500\u2500 Empty state \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    .empty {
      text-align: center; padding: 28px 12px;
      color: var(--vscode-descriptionForeground);
    }
    .empty-icon { font-size: 28px; margin-bottom: 8px; opacity: .45; }
    .empty-h { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
    .empty-p { font-size: 12px; opacity: .7; }

    /* \u2500\u2500\u2500 Pending edits banner \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    #editsBanner {
      display: none; margin: 4px 12px 0;
      padding: 9px 11px; border-radius: var(--r-md);
      background: var(--amber-bg); border: 1px solid var(--amber-bdr);
      align-items: center; justify-content: space-between; gap: 8px;
      flex-shrink: 0;
    }
    #editsBanner.on { display: flex; }

    .banner-txt { font-size: 12px; font-weight: 600; color: var(--amber); flex: 1; }
    .banner-acts { display: flex; gap: 5px; }

    /* \u2500\u2500\u2500 Composer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    .composer {
      padding: 8px 12px 12px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.18));
      flex-shrink: 0;
    }

    .input-shell {
      display: flex; align-items: flex-end; gap: 8px;
      padding: 7px 9px;
      border-radius: var(--r-lg);
      border: 1.5px solid var(--vscode-input-border, rgba(128,128,128,.22));
      background: var(--vscode-input-background);
      transition: border-color var(--spd);
    }
    .input-shell:focus-within { border-color: var(--amber); }

    textarea {
      flex: 1; border: none; background: none; outline: none;
      color: var(--vscode-input-foreground);
      font: 13px var(--vscode-font-family);
      resize: none; min-height: 21px; max-height: 96px; line-height: 1.5;
      overflow-y: auto;
    }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }

    .send-btn {
      width: 30px; height: 30px; min-width: 30px;
      border: none; border-radius: 50%;
      background: var(--amber); color: #fff;
      font-size: 15px; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      opacity: .35; transition: opacity var(--spd), transform var(--spd), background var(--spd);
    }
    .send-btn.active { opacity: 1; }
    .send-btn.active:hover { background: #d97706; transform: scale(1.08); }

    .meta { display: flex; align-items: center; justify-content: space-between; padding: 5px 1px 0; }
    .chips { display: flex; gap: 5px; }

    .token-row { display: flex; justify-content: flex-end; padding: 6px 2px 0; }
    .token-wrap { display: inline-flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .token-ring {
      width: 26px; height: 26px; border-radius: 50%;
      background: conic-gradient(var(--amber) 0deg, rgba(128,128,128,.18) 0deg);
      display: inline-flex; align-items: center; justify-content: center; position: relative;
    }
    .token-ring::after {
      content: ""; position: absolute; width: 18px; height: 18px; border-radius: 50%;
      background: var(--vscode-sideBar-background);
    }
    .token-value { position: relative; z-index: 1; font-size: 8.5px; font-weight: 700; color: var(--vscode-foreground); }

    .chip {
      font-size: 10px; font-weight: 600;
      padding: 2px 7px; border-radius: 999px;
      border: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.2));
      color: var(--vscode-descriptionForeground);
      cursor: pointer; white-space: nowrap;
      max-width: 110px; overflow: hidden; text-overflow: ellipsis;
      transition: all var(--spd);
    }
    .chip:hover { border-color: var(--amber); color: var(--amber); background: var(--amber-bg); }

    .status-txt { font-size: 10px; color: var(--vscode-descriptionForeground); }

    /* \u2500\u2500\u2500 Generic buttons \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    .btn {
      font: 600 11px var(--vscode-font-family);
      padding: 5px 10px; border-radius: var(--r-sm);
      border: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.22));
      background: transparent; color: var(--vscode-foreground);
      cursor: pointer; transition: all var(--spd);
    }
    .btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.12)); }
    .btn.primary { background: var(--amber); border-color: var(--amber); color: #fff; }
    .btn.primary:hover { background: #d97706; border-color: #d97706; }
    .btn.danger  { color: var(--red); border-color: var(--red-bdr); }
    .btn.danger:hover  { background: var(--red-bg); }
    .btn.sm { padding: 4px 8px; font-size: 11px; }

    /* \u2500\u2500\u2500 Animations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    @keyframes fadein {
      from { opacity: 0; transform: translateY(5px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .fadein { animation: fadein 240ms ease forwards; }

    /* \u2500\u2500\u2500 Scrollbar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(128,128,128,.28); border-radius: 99px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,.5); }
  </style>
</head>
<body>
<div id="root">

  <!-- \u2500\u2500 Header \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 -->
  <header class="hdr">
    <div class="hdr-left">
      <div class="logo">P</div>
      <span class="brand">Pulse</span>
    </div>
    <div class="hdr-right">
      <span id="statusBadge" class="badge off">
        <span class="badge-dot"></span><span id="statusTxt">Offline</span>
      </span>
      <button id="btnSettings" class="icon-btn" title="Model settings">&#9881;</button>
      <button id="btnRefresh"  class="icon-btn" title="Refresh">&#8635;</button>
    </div>
  </header>

  <!-- \u2500\u2500 Settings drawer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 -->
  <div id="settingsDrawer">
    <div class="srow">
      <span class="slabel">Role</span>
      <select id="roleSelect">
        <option value="planner">Planner</option>
        <option value="editor">Editor</option>
        <option value="fast">Fast</option>
        <option value="embedding">Embedding</option>
      </select>
    </div>
    <div class="srow">
      <span class="slabel">Model</span>
      <select id="modelSelect"></select>
    </div>
    <div class="sbtns">
      <button id="btnSyncModels" class="btn">Sync models</button>
      <button id="btnApplyModel" class="btn primary">Apply</button>
    </div>
  </div>

  <!-- \u2500\u2500 Main scrollable area \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 -->
  <div id="main">

    <!-- Home view -->
    <div id="homeView">
      <div style="padding:12px; display:flex; flex-direction:column; gap:10px;">
        <button id="btnNewChat" class="new-btn">
          <span style="font-size:16px; line-height:1;">+</span> New conversation
        </button>
        <div class="sec-title">Recent Conversations</div>
        <div id="sessionList" class="sessions">
          <div class="empty">
            <div class="empty-icon">&#128172;</div>
            <div class="empty-h">No conversations yet</div>
            <div class="empty-p">Type a task below to begin</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Chat view -->
    <div id="chatView" class="hidden">
      <div style="padding:10px 12px 4px; display:flex; flex-direction:column; gap:10px;">
        <button id="btnBack" class="back-btn">&#8592; Back</button>
        <div id="messages"></div>
        <div id="typing">
          <div class="typing-bubble">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          </div>
        </div>
      </div>
    </div>

  </div><!-- /main -->

  <!-- \u2500\u2500 Pending edits banner \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 -->
  <div id="editsBanner">
    <span id="bannerTxt" class="banner-txt">Pending edits ready</span>
    <div class="banner-acts">
      <button id="btnApply"  class="btn primary sm">Apply</button>
      <button id="btnRevert" class="btn danger sm">Revert</button>
    </div>
  </div>

  <!-- \u2500\u2500 Composer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 -->
  <div class="composer">
    <div class="input-shell">
      <textarea id="taskInput" placeholder="Ask Pulse anything about your code\u2026" rows="1"></textarea>
      <button id="btnSend" class="send-btn" title="Send  (Enter)">&#8593;</button>
    </div>
    <div class="meta">
      <div class="chips">
        <span id="chipModel" class="chip" title="Active planner model">\u2013</span>
        <span id="chipMode"  class="chip" title="Click to cycle approval mode">balanced</span>
      </div>
      <span id="statusLine" class="status-txt">Ready</span>
    </div>
    <div class="token-row">
      <div class="token-wrap" title="Token usage in this Pulse runtime session">
        <span id="tokenRing" class="token-ring"><span id="tokenValue" class="token-value">0%</span></span>
        <span id="tokenLabel">0 / 0</span>
      </div>
    </div>
  </div>

</div><!-- /root -->

<script nonce="${nonce}">
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  // \u2500\u2500 Element refs \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const $ = id => document.getElementById(id);
  const statusBadge  = $('statusBadge');
  const statusTxt    = $('statusTxt');
  const btnSettings  = $('btnSettings');
  const btnRefresh   = $('btnRefresh');
  const settingsDrawer = $('settingsDrawer');
  const roleSelect   = $('roleSelect');
  const modelSelect  = $('modelSelect');
  const btnSyncModels= $('btnSyncModels');
  const btnApplyModel= $('btnApplyModel');
  const homeView     = $('homeView');
  const chatView     = $('chatView');
  const btnNewChat   = $('btnNewChat');
  const btnBack      = $('btnBack');
  const sessionList  = $('sessionList');
  const messages     = $('messages');
  const typing       = $('typing');
  const editsBanner  = $('editsBanner');
  const bannerTxt    = $('bannerTxt');
  const btnApply     = $('btnApply');
  const btnRevert    = $('btnRevert');
  const taskInput    = $('taskInput');
  const btnSend      = $('btnSend');
  const chipModel    = $('chipModel');
  const chipMode     = $('chipMode');
  const statusLine   = $('statusLine');
  const tokenRing    = $('tokenRing');
  const tokenValue   = $('tokenValue');
  const tokenLabel   = $('tokenLabel');

  // \u2500\u2500 State \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  let summary  = null;
  let models   = [];
  let history  = [];   // { role:'user'|'agent', text:string, ts:number }
  let inChat   = false;

  // \u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function relTime(iso) {
    const d = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!isFinite(d) || d < 1) return 'just now';
    if (d < 60) return d + 'm ago';
    const h = Math.round(d / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 96) + 'px';
  }

  function scrollBottom() {
    requestAnimationFrame(() => { $('main').scrollTop = 9999999; });
  }

  // \u2500\u2500 Navigation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function showHome() {
    inChat = false;
    homeView.classList.remove('hidden');
    chatView.classList.add('hidden');
  }

  function showChat() {
    inChat = true;
    homeView.classList.add('hidden');
    chatView.classList.remove('hidden');
    scrollBottom();
  }

  // \u2500\u2500 Render messages \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function renderMessages() {
    if (!history.length) {
      messages.innerHTML =
        '<div class="empty fadein">' +
        '<div class="empty-icon">&#9889;</div>' +
        '<div class="empty-h">Ready to help</div>' +
        '<div class="empty-p">Describe what you want to build or fix</div></div>';
      return;
    }
    messages.innerHTML = '';
    for (const m of history) {
      const div = document.createElement('div');
      div.className = 'msg ' + m.role + ' fadein';

      // Minimal markdown: fenced code blocks then inline code
      let html = esc(m.text);
      html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre>$1</pre>');
      html = html.replace(/\`([^\`\\n]+)\`/g,
        '<code>$1</code>');
      html = html.replace(/\\n/g, '<br>');

      const ts = m.ts ? relTime(new Date(m.ts).toISOString()) : '';
      div.innerHTML =
        '<div class="bubble">' + html + '</div>' +
        '<div class="msg-time">' + esc(ts) + '</div>';
      messages.appendChild(div);
    }
  }

  // \u2500\u2500 Render session list \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function renderSessions(list) {
    list = list || [];
    if (!list.length) {
      sessionList.innerHTML =
        '<div class="empty"><div class="empty-icon">&#128172;</div>' +
        '<div class="empty-h">No conversations yet</div>' +
        '<div class="empty-p">Type a task below to begin</div></div>';
      return;
    }
    sessionList.innerHTML = '';
    for (const s of list) {
      const d = document.createElement('div');
      d.className = 'sitem';
      d.innerHTML =
        '<span class="sitem-title">' + esc(s.title || s.id) + '</span>' +
        '<span class="sitem-time">'  + esc(relTime(s.updatedAt)) + '</span>';
      sessionList.appendChild(d);
    }
  }

  // \u2500\u2500 Render summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function renderSummary(s) {
    summary = s;
    const ok = String(s?.ollamaHealth || '').toLowerCase().includes('reachable');
    statusBadge.className = 'badge ' + (ok ? 'on' : 'off');
    statusTxt.textContent  = ok ? 'Online' : 'Offline';

    const model = s?.plannerModel || '';
    chipModel.textContent = model.split(':')[0].slice(0, 14) || '\u2013';
    chipModel.title = 'Planner: ' + (model || 'none');
    chipMode.textContent = s?.approvalMode || 'balanced';

    const hasPending = !!s?.hasPendingEdits;
    editsBanner.classList.toggle('on', hasPending);
    if (hasPending) bannerTxt.textContent = 'Pending file edits \u2014 review before applying';

    const pct = Number.isFinite(s?.tokenUsagePercent)
      ? Math.max(0, Math.min(100, s.tokenUsagePercent))
      : 0;
    tokenRing.style.background =
      'conic-gradient(var(--amber) ' + (pct * 3.6) + 'deg, rgba(128,128,128,.18) 0deg)';
    tokenValue.textContent = pct + '%';
    tokenLabel.textContent = (s?.tokensConsumed ?? 0) + ' / ' + (s?.tokenBudget ?? 0);

    statusLine.textContent = ok
      ? (s?.modelCount
          ? s.modelCount + ' models, MCP ' + (s?.mcpHealthy ?? 0) + '/' + (s?.mcpConfigured ?? 0)
          : 'Ollama ready')
      : 'Ollama offline';
  }

  // \u2500\u2500 Update model dropdown \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function updateModels(list) {
    models = list || [];
    const prev = modelSelect.value;
    modelSelect.innerHTML = '';
    if (!models.length) {
      modelSelect.innerHTML = '<option value="">No models found</option>';
      return;
    }
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.name; o.text = m.name;
      modelSelect.appendChild(o);
    }
    if (models.some(m => m.name === prev)) modelSelect.value = prev;
  }

  // \u2500\u2500 Send task \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function sendTask() {
    const text = taskInput.value.trim();
    if (!text) return;

    taskInput.value = '';
    taskInput.style.height = 'auto';
    btnSend.classList.remove('active');

    history.push({ role: 'user', text, ts: Date.now() });
    renderMessages();
    showChat();

    typing.classList.add('on');
    scrollBottom();
    statusLine.textContent = 'Thinking\u2026';

    vscode.postMessage({ type: 'runTask', payload: text });
  }

  // \u2500\u2500 Event listeners \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  taskInput.addEventListener('input', () => {
    autoGrow(taskInput);
    btnSend.classList.toggle('active', taskInput.value.trim().length > 0);
  });

  taskInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTask(); }
  });

  btnSend.addEventListener('click', sendTask);

  btnNewChat.addEventListener('click', () => {
    history = [];
    renderMessages();
    showChat();
    taskInput.focus();
  });

  btnBack.addEventListener('click', showHome);

  btnSettings.addEventListener('click', () => settingsDrawer.classList.toggle('open'));
  btnRefresh.addEventListener('click',  () => vscode.postMessage({ type: 'loadDashboard' }));

  btnSyncModels.addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));

  btnApplyModel.addEventListener('click', () => {
    const role  = roleSelect.value;
    const model = modelSelect.value;
    if (!model) return;
    vscode.postMessage({ type: 'setModel', payload: { role, model } });
  });

  chipMode.addEventListener('click', () => {
    const modes = ['strict', 'balanced', 'fast'];
    const idx  = modes.indexOf(summary?.approvalMode || 'balanced');
    const next = modes[(idx + 1) % modes.length];
    vscode.postMessage({ type: 'setApprovalMode', payload: next });
  });

  btnApply.addEventListener('click', () => {
    if (!confirm('Apply the pending file edits to your workspace?')) return;
    vscode.postMessage({ type: 'applyPending', payload: true });
  });

  btnRevert.addEventListener('click', () => {
    if (!confirm('Revert the last applied transaction?')) return;
    vscode.postMessage({ type: 'revertLast', payload: true });
  });

  // \u2500\u2500 Message handler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  window.addEventListener('message', ({ data }) => {
    const { type, payload } = data || {};

    if (type === 'runtimeSummary') renderSummary(payload);

    if (type === 'models') updateModels(payload);

    if (type === 'sessions') renderSessions(payload);

    if (type === 'taskResult') {
      typing.classList.remove('on');
      const text = payload?.responseText || JSON.stringify(payload, null, 2);
      history.push({ role: 'agent', text, ts: Date.now() });
      renderMessages();
      scrollBottom();
      statusLine.textContent = payload?.proposedEdits
        ? payload.proposedEdits + ' file edit(s) pending'
        : 'Done';
      vscode.postMessage({ type: 'loadDashboard' });
    }

    if (type === 'actionResult') {
      typing.classList.remove('on');
      history.push({ role: 'agent', text: String(payload), ts: Date.now() });
      renderMessages();
      scrollBottom();
      statusLine.textContent = 'Done';
      vscode.postMessage({ type: 'loadDashboard' });
    }
  });

  // \u2500\u2500 Bootstrap \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  vscode.postMessage({ type: 'loadDashboard' });
}());
</script>
</body>
</html>`;
  }
};

// src/extension.ts
async function activate(context) {
  const logger = createLogger();
  context.subscriptions.push({ dispose: () => logger.dispose() });
  logger.info("Activating Pulse extension...");
  const config = getAgentConfig();
  const storage = await bootstrapStorage(context, logger);
  const runtime = new AgentRuntime(config, storage, logger);
  await runtime.initialize();
  const sidebarProvider = new PulseSidebarProvider(
    context.extensionUri,
    runtime,
    logger
  );
  context.subscriptions.push(
    vscode11.window.registerWebviewViewProvider(
      PulseSidebarProvider.viewType,
      sidebarProvider
    )
  );
  registerCommands(context, runtime, logger);
  logger.info("Pulse extension activated.");
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
