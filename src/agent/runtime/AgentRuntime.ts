import * as crypto from "crypto";
import * as path from "path";
import { existsSync } from "fs";
import * as vscode from "vscode";

import type {
  AgentConfig,
  AgentPersona,
  McpServerConfig,
  PermissionMode,
} from "../../config/AgentConfig";
import type { StorageState } from "../../db/StorageBootstrap";
import type { Logger } from "../../platform/vscode/Logger";
import {
  EditManager,
  type EditProposal,
  type ProposedEdit,
} from "../edits/EditManager";
import { computeFileDiff, type FileDiffResult } from "../edits/DiffEngine";
import { WorkspaceScanner } from "../indexing/WorkspaceScanner";
import { McpManager, type McpServerStatus } from "../mcp/McpManager";
import { OllamaProvider } from "../model/OllamaProvider";
import type {
  ChatMessage,
  ChatMessageContent,
  ModelProvider,
  ModelSummary,
  ProviderHealth,
} from "../model/ModelProvider";
import { MemoryStore } from "../memory/MemoryStore";
import {
  PermissionPolicy,
  classifyAction,
  fromLegacyApprovalMode,
  toLegacyApprovalMode,
} from "../permissions/PermissionPolicy";
import type { PermissionDecision } from "../permissions/PermissionPolicy";
import { Planner } from "../planner/Planner";
import {
  WebSearchService,
  type WebSearchResponse,
} from "../search/WebSearchService";
import { SkillRegistry, type SkillManifest } from "../skills/SkillRegistry";
import { GitService } from "../../platform/git/GitService";
import { ImprovementEngine } from "../improvement/ImprovementEngine";
import {
  TerminalExecutor,
  type TerminalExecResult,
} from "../terminal/TerminalExecutor";
import type { TaskPlan } from "../planner/Planner";
import type {
  ConversationMessage,
  ConversationMode,
  RuntimeTaskResult,
  AgentProgressStep,
  TokenSnapshot,
  RunTaskRequest,
  ExplainResult,
} from "./RuntimeTypes";
import { SessionStore } from "../sessions/SessionStore";
import type { SessionRecord } from "../sessions/SessionStore";
import { VerificationRunner } from "../verification/VerificationRunner";
import {
  assessTaskQuality,
  buildTaskRefinementPrompt,
  estimateCommandTimeout,
  formatCompactTodos,
  formatShortcutHints,
  formatToolObservations,
  isSafeTerminalCommand,
  parseTaskResponse,
  TARGET_TASK_QUALITY_SCORE,
  type TaskQualityAssessment,
  type TaskModelResponse,
  type TaskToolCall,
  type TaskToolName,
  type TaskToolObservation,
  type TaskTodo,
} from "./TaskProtocols";

export interface RuntimeSummary {
  status: "ready" | "degraded";
  ollamaReachable: boolean;
  conversationMode: ConversationMode;
  persona: string;
  plannerModel: string;
  editorModel: string;
  fastModel: string;
  embeddingModel: string;
  approvalMode: "strict" | "balanced" | "fast";
  permissionMode: PermissionMode;
  storagePath: string;
  ollamaHealth: string;
  modelCount: number;
  activeSessionId: string | null;
  hasPendingEdits: boolean;
  pendingEditCount: number;
  tokenBudget: number;
  tokensConsumed: number;
  tokenUsagePercent: number;
  learningProgressPercent: number;
  mcpConfigured: number;
  mcpHealthy: number;
  selfLearnEnabled: boolean;
}

export interface RecentSessionItem {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  attachmentCount: number;
}

export interface PrepublishGuardResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  markdown: string;
}

type ModelRole = "planner" | "editor" | "fast" | "embedding";

export class AgentRuntime {
  private readonly provider: ModelProvider;

  private readonly planner: Planner;

  private readonly scanner: WorkspaceScanner;

  private readonly sessionStore: SessionStore;

  private readonly memoryStore: MemoryStore;

  private readonly editManager: EditManager;

  private readonly verifier: VerificationRunner;

  private readonly mcpManager: McpManager;

  private readonly skillRegistry: SkillRegistry;

  private readonly webSearch: WebSearchService;

  private readonly permissionPolicy: PermissionPolicy;

  private readonly gitService: GitService;

  private readonly improvementEngine: ImprovementEngine;

  private readonly terminalExecutor: TerminalExecutor;

  private currentConfig: AgentConfig;

  private health: ProviderHealth = { ok: false, message: "Not checked" };

  private availableModels: ModelSummary[] = [];

  private tokensConsumed = 0;

  private activeTokenSessionId: string | null = null;

  private progressCallback: ((step: AgentProgressStep) => void) | null = null;

  private tokenCallback: ((snapshot: TokenSnapshot) => void) | null = null;

  private readonly workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;

  /** Simple concurrency gate — only one task runs at a time. */
  private taskQueue: Promise<RuntimeTaskResult> = Promise.resolve(
    null as unknown as RuntimeTaskResult,
  );

  /** AbortController for the currently running task. */
  private abortController: AbortController | null = null;

  /** Self-learn background loop timer. */
  private selfLearnTimer: ReturnType<typeof setInterval> | null = null;

  private mcpStatusCache: {
    checkedAt: number;
    statuses: McpServerStatus[];
  } | null = null;

  private mcpStatusPromise: Promise<McpServerStatus[]> | null = null;

  private readonly packageScriptsCache = new Map<
    string,
    Record<string, string> | null
  >();

  /** Tool enable/disable map set from the UI. All tools enabled by default. */
  private enabledToolsMap: Record<string, boolean> = {};

  /** Last terminal execution result for get_terminal_output tool. */
  private lastTerminalResult: TerminalExecResult | null = null;

  public constructor(
    config: AgentConfig,
    private readonly storage: StorageState,
    private readonly logger: Logger,
    webSearch: WebSearchService,
    provider?: ModelProvider,
  ) {
    this.currentConfig = {
      ...config,
      openaiModels: Array.isArray(config.openaiModels)
        ? [...config.openaiModels]
        : [],
      fallbackModels: Array.isArray(config.fallbackModels)
        ? [...config.fallbackModels]
        : [],
      mcpServers: Array.isArray(config.mcpServers)
        ? [...config.mcpServers]
        : [],
    };
    this.provider = provider ?? new OllamaProvider(config.ollamaBaseUrl);
    this.planner = new Planner(this.provider);
    this.scanner = new WorkspaceScanner();
    this.sessionStore = new SessionStore(storage.sessionsPath);
    this.memoryStore = new MemoryStore(storage.memoriesPath);
    this.editManager = new EditManager(storage.editsPath, storage.snapshotsDir);
    this.verifier = new VerificationRunner();
    this.mcpManager = new McpManager(config.mcpServers);
    this.skillRegistry = new SkillRegistry();
    this.webSearch = webSearch;
    this.permissionPolicy = new PermissionPolicy(config.permissionMode);
    this.gitService = new GitService();
    this.improvementEngine = new ImprovementEngine(storage.improvementPath);
    this.terminalExecutor = new TerminalExecutor();
  }

  public setProgressCallback(
    cb: ((step: AgentProgressStep) => void) | null,
  ): void {
    this.progressCallback = cb;
  }

  public setTokenCallback(
    cb: ((snapshot: TokenSnapshot) => void) | null,
  ): void {
    this.tokenCallback = cb;
  }

  private streamCallback: ((chunk: string) => void) | null = null;

  public setStreamCallback(cb: ((chunk: string) => void) | null): void {
    this.streamCallback = cb;
  }

  private emitStreamChunk(chunk: string): void {
    this.streamCallback?.(chunk);
  }

  private emitProgress(step: string, detail?: string, icon = "\u25B8"): void {
    this.progressCallback?.({ icon, step, detail });
  }

  private emitFilePatch(filename: string, lineCount: number): void {
    this.progressCallback?.({
      icon: "✏️",
      step: "Generating patch",
      detail: filename,
      kind: "file_patch",
      file: filename,
      lineCount,
    });
  }

  private emitFilePatched(filename: string, linesAdded: number): void {
    this.progressCallback?.({
      icon: "✅",
      step: "Edited",
      detail: filename,
      kind: "file_patched",
      file: filename,
      linesAdded,
      linesRemoved: 0,
    });
  }

  private terminalOutputCallback:
    | ((data: {
        command: string;
        output: string;
        exitCode: number | null;
      }) => void)
    | null = null;

  public setTerminalOutputCallback(
    cb:
      | ((data: {
          command: string;
          output: string;
          exitCode: number | null;
        }) => void)
      | null,
  ): void {
    this.terminalOutputCallback = cb;
  }

  private emitTerminalRun(command: string): void {
    this.progressCallback?.({
      icon: "\u25B6",
      step: "Terminal",
      detail: command,
      kind: "terminal",
    });
  }

  private emitReasoningChunk(chunk: string): void {
    this.progressCallback?.({
      icon: "\u25B8",
      step: "Reasoning",
      detail: chunk.slice(0, 240),
      kind: "reasoning",
    });
  }

  private emitTodoUpdate(todos: TaskTodo[]): void {
    this.progressCallback?.({
      icon: "\u2611",
      step: "Updating tasks",
      kind: "todo_update",
      todos,
    });
  }

  private emitFilesChanged(
    files: Array<{ path: string; additions: number; deletions: number }>,
  ): void {
    this.progressCallback?.({
      icon: "\uD83D\uDCC4",
      step: "Files changed",
      kind: "files_changed",
      files,
    });
  }

  private emitTokenUpdate(): void {
    if (!this.tokenCallback) return;
    const budget = this.currentConfig.maxContextTokens;
    const consumed = this.tokensConsumed;
    const percent =
      budget > 0 ? Math.min(100, Math.round((consumed / budget) * 100)) : 0;
    this.tokenCallback({ consumed, budget, percent });
  }

  /** Persona-aware system prompt prefix. */
  private getPersonaPrompt(): string {
    const persona = this.currentConfig.persona ?? "software-engineer";
    const prompts: Record<string, string> = {
      "software-engineer":
        "You are Pulse, a senior software engineer AI assistant. " +
        "You write clean, maintainable, well-tested code. " +
        "You follow SOLID principles, favor simple solutions, and always consider edge cases. " +
        "You think like an engineer: break problems down, validate assumptions, and build incrementally.",
      "data-scientist":
        "You are Pulse, an expert data scientist AI assistant. " +
        "You excel at data analysis, statistical modeling, machine learning, and visualization. " +
        "You write efficient data pipelines, use pandas/numpy/sklearn idiomatically, and clearly explain your analytical reasoning. " +
        "You validate data quality, check for bias, and present results with appropriate statistical rigor.",
      designer:
        "You are Pulse, a UI/UX design-focused AI assistant. " +
        "You have deep expertise in user interface design, accessibility, CSS, design systems, and visual hierarchy. " +
        "You create beautiful, responsive, accessible interfaces. " +
        "You think about user flows, interaction patterns, and maintain design consistency.",
      "devops-engineer":
        "You are Pulse, a senior DevOps/infrastructure AI assistant. " +
        "You excel at CI/CD pipelines, containerization, cloud infrastructure, monitoring, and deployment automation. " +
        "You write reliable Dockerfiles, Kubernetes manifests, and IaC templates. " +
        "You prioritize security, observability, and reliability in every decision.",
      researcher:
        "You are Pulse, an AI research assistant. " +
        "You excel at deep investigation, literature review, code analysis, and systematic problem-solving. " +
        "You are thorough and methodical — you gather evidence before drawing conclusions. " +
        "You cite sources, compare approaches, and present findings with clarity and nuance.",
      "full-stack-developer":
        "You are Pulse, a full-stack developer AI assistant. " +
        "You build complete applications end-to-end — frontend, backend, database, and API layers. " +
        "You understand React, Node.js, Python, SQL, REST, GraphQL, and modern web architecture. " +
        "You write production-ready code with proper error handling, validation, and security.",
    };
    return prompts[persona] ?? prompts["software-engineer"];
  }

  /** Get the current persona. */
  public getPersona(): AgentPersona {
    return this.currentConfig.persona ?? "software-engineer";
  }

  /** Set the active persona. */
  public async setPersona(persona: AgentPersona): Promise<void> {
    await this.updateSetting("behavior.persona", persona);
    this.currentConfig.persona = persona;
  }

  public async initialize(): Promise<void> {
    this.health = await this.provider.healthCheck();
    if (this.health.ok) {
      try {
        this.availableModels = await this.provider.listModels();
        this.availableModels = this.mergeConfiguredModels(this.availableModels);
        await this.alignConfiguredModelsToAvailableModels();
      } catch (error) {
        this.logger.warn(`Failed to list models: ${stringifyError(error)}`);
      }
    }

    const activeSession = await this.sessionStore.getActiveSession();
    if (!activeSession) {
      const recentSession = await this.sessionStore.getMostRecentSession();
      if (recentSession) {
        await this.sessionStore.setActiveSession(recentSession.id);
        this.logger.info(
          `Restored recent session ${recentSession.id} on startup`,
        );
      }
    }

    this.logger.info("AgentRuntime initialized");
    this.logger.debug(`Planner model: ${this.currentConfig.plannerModel}`);
    this.logger.debug(`Editor model: ${this.currentConfig.editorModel}`);
    this.logger.debug(`Fast model: ${this.currentConfig.fastModel}`);
    this.logger.debug(`Storage path: ${this.storage.storageDir}`);
    this.logger.info(`Ollama health: ${this.health.message}`);

    if (this.currentConfig.selfLearnEnabled) {
      this.startSelfLearnLoop();
    }
  }

  public async refreshProviderState(): Promise<void> {
    this.health = await this.provider.healthCheck();
    if (this.health.ok) {
      try {
        this.availableModels = await this.provider.listModels();
        this.availableModels = this.mergeConfiguredModels(this.availableModels);
        await this.alignConfiguredModelsToAvailableModels();
      } catch (error) {
        this.logger.warn(
          `Failed to refresh Ollama models: ${stringifyError(error)}`,
        );
        this.availableModels = this.mergeConfiguredModels([]);
        this.health = {
          ok: true,
          message: `Ollama reachable (model discovery failed: ${stringifyError(error)})`,
        };
      }
      return;
    }

    this.availableModels = this.mergeConfiguredModels([]);
  }

  public async listAvailableModels(): Promise<ModelSummary[]> {
    if (this.availableModels.length === 0) {
      await this.refreshProviderState();
    }
    return this.availableModels;
  }

  private async updateSetting(key: string, value: unknown): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("pulse");
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    try {
      await cfg.update(key, value, target);
    } catch {
      await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    }
  }

  public async selectModel(role: ModelRole, modelName: string): Promise<void> {
    const models = await this.listAvailableModels();
    if (!models.some((model) => model.name === modelName)) {
      throw new Error(
        `Model ${modelName} is not available locally. Sync models and try again.`,
      );
    }

    const targetKey =
      role === "planner"
        ? "models.planner"
        : role === "editor"
          ? "models.editor"
          : role === "fast"
            ? "models.fast"
            : "models.embedding";

    await this.updateSetting(targetKey, modelName);

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

  public getConfiguredMcpServers(): McpServerConfig[] {
    return [...(this.currentConfig.mcpServers ?? [])];
  }

  public async setConfiguredMcpServers(
    servers: McpServerConfig[],
  ): Promise<void> {
    await this.updateSetting("mcp.servers", servers);

    this.currentConfig.mcpServers = [...servers];
    this.mcpManager.updateServerDefinitions(servers);
    this.mcpStatusCache = null;
    this.mcpStatusPromise = null;
    this.logger.info(`Updated MCP server definitions (${servers.length})`);
  }

  public async explainText(input: string): Promise<ExplainResult> {
    this.resetTokenUsage();
    const model = await this.resolveModelOrFallback(
      this.currentConfig.fastModel,
    );
    const response = await this.provider.chat({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are Pulse, a senior coding assistant. Explain code accurately and concisely with practical details.",
        },
        {
          role: "user",
          content: input,
        },
      ],
    });
    this.consumeTokens(response.tokenUsage);

    return {
      text: response.text,
      model,
    };
  }

  private classifyObjective(objective: string): string {
    const lower = objective.toLowerCase();
    if (/fix|bug|error|crash|fail/.test(lower)) return "debug";
    if (/add|create|implement|build|write/.test(lower)) return "feature";
    if (/explain|how|what|why|describe/.test(lower)) return "explain";
    if (/refactor|improve|clean|simplify|rename/.test(lower)) return "refactor";
    return "general";
  }

  private async learnFromExchange(
    objective: string,
    responseText: string,
    mode: ConversationMode,
  ): Promise<void> {
    if (this.currentConfig.memoryMode === "off") return;
    const hasCode = responseText.includes("```");
    const isDetailed = responseText.length > 600;
    const objectiveType = this.classifyObjective(objective);
    const style = hasCode ? "code" : isDetailed ? "detailed" : "concise";
    await this.memoryStore.setPreference(
      `learned.${objectiveType}.${mode}`,
      JSON.stringify({ style, ts: new Date().toISOString() }),
    );
  }

  private async getLearnedStyleHint(
    objective: string,
    mode: ConversationMode,
  ): Promise<string> {
    if (this.currentConfig.memoryMode === "off") return "";
    const objectiveType = this.classifyObjective(objective);
    const raw = await this.memoryStore.getPreference(
      `learned.${objectiveType}.${mode}`,
    );
    if (!raw) return "";
    try {
      const parsed = JSON.parse(raw) as { style?: string };
      if (parsed.style === "code") {
        return "The user prefers responses with code examples for this type of request.";
      }
      if (parsed.style === "detailed") {
        return "The user prefers detailed, thorough responses for this type of request.";
      }
      if (parsed.style === "concise") {
        return "The user prefers concise, to-the-point responses for this type of request.";
      }
    } catch {
      // ignore malformed
    }
    return "";
  }

  private isWorkspaceDiscoveryObjective(objective: string): boolean {
    const lower = objective.toLowerCase();
    const asksForInventory =
      /\b(what files|list files|show files|scan project|scan repo|scan workspace|project structure|workspace structure|what can you see|what do you see|what is in this project|what's in this project|repo contents|codebase contents|file tree)\b/.test(
        lower,
      ) ||
      /\bscan\b.*\b(files|repo|workspace|project|codebase)\b/.test(lower) ||
      /\b(files|repo|workspace|project|codebase)\b.*\bscan\b/.test(lower);
    const isEditIntent =
      /\b(edit|change|implement|fix|refactor|create|write|update|add|remove|delete|move)\b/.test(
        lower,
      );
    return asksForInventory && !isEditIntent;
  }

  private async buildWorkspaceInventory(limit = 250): Promise<{
    totalFiles: number;
    listedFiles: string[];
    truncated: boolean;
  }> {
    const stats = await this.scanner.scanWorkspace();
    const root = this.workspaceRoot?.fsPath ?? null;
    const absoluteFiles = await this.scanner.listWorkspaceFiles(limit);
    const listedFiles = absoluteFiles.map((filePath) =>
      root ? path.relative(root, filePath).replace(/\\/g, "/") : filePath,
    );

    return {
      totalFiles: stats.totalFiles,
      listedFiles,
      truncated: stats.totalFiles > listedFiles.length,
    };
  }

  private formatWorkspaceInventoryResponse(
    inventory: {
      totalFiles: number;
      listedFiles: string[];
      truncated: boolean;
    },
    objective: string,
  ): string {
    const lines = [
      `I scanned the workspace for: ${objective}`,
      `I can see ${inventory.totalFiles} file${inventory.totalFiles === 1 ? "" : "s"} in this workspace.`,
      "",
      "Files I found:",
      ...inventory.listedFiles.map((filePath) => `- ${filePath}`),
    ];

    if (inventory.truncated) {
      lines.push(
        "",
        "The list above is truncated to the first batch of files. I can keep drilling into any folder or file type you want.",
      );
    }

    return lines.join("\n");
  }

  /** Cancel the currently running task, if any. */
  public cancelTask(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  /** Enable or disable the background self-learn loop. */
  public async setSelfLearn(enabled: boolean): Promise<void> {
    await this.updateSetting("behavior.selfLearn", enabled);
    this.currentConfig.selfLearnEnabled = enabled;
    if (enabled) {
      this.startSelfLearnLoop();
    } else {
      this.stopSelfLearnLoop();
    }
  }

  private startSelfLearnLoop(): void {
    if (this.selfLearnTimer) return; // already running
    // Run an improvement cycle every 45 seconds while self-learn is active
    this.selfLearnTimer = setInterval(() => {
      this.improvementEngine.runSelfImprovementCycle().catch((err) => {
        this.logger.warn(`Self-learn cycle error: ${err}`);
      });
    }, 45_000);
    this.logger.info("Self-learn loop started (every 45s)");
  }

  private stopSelfLearnLoop(): void {
    if (this.selfLearnTimer) {
      clearInterval(this.selfLearnTimer);
      this.selfLearnTimer = null;
      this.logger.info("Self-learn loop stopped");
    }
  }

  public runTask(request: string | RunTaskRequest): Promise<RuntimeTaskResult> {
    // Enqueue — ensures only one task runs at a time.
    // Earlier tasks must finish (or fail) before the next one starts.
    const normalizedRequest =
      typeof request === "string" ? { objective: request } : request;
    const controller = new AbortController();
    this.abortController = controller;
    this.taskQueue = this.taskQueue
      .catch(() => {})
      .then(() => {
        if (controller.signal.aborted) {
          return this.makeCancelledResult(normalizedRequest.objective);
        }
        return this.executeTask(normalizedRequest, controller.signal);
      })
      .finally(() => {
        if (this.abortController === controller) this.abortController = null;
      });
    return this.taskQueue;
  }

  private makeCancelledResult(objective: string): RuntimeTaskResult {
    return {
      sessionId: "",
      objective,
      plan: {
        objective,
        assumptions: [],
        acceptanceCriteria: [],
        todos: [],
        steps: [],
        taskSlices: [],
        verification: [],
      },
      todos: [],
      responseText: "Task cancelled.",
      proposal: null,
    };
  }

  private buildUserMessage(
    text: string,
    images?: Array<{ name: string; dataUrl: string }>,
  ): ChatMessage {
    if (!images || images.length === 0) {
      return { role: "user", content: text };
    }
    const parts: ChatMessageContent[] = [{ type: "text", text }];
    for (const img of images) {
      parts.push({
        type: "image_url",
        image_url: { url: img.dataUrl, detail: "auto" },
      });
    }
    return { role: "user", content: parts };
  }

  private async executeTask(
    request: RunTaskRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeTaskResult> {
    const objective = request.objective;
    const checkAborted = () => {
      if (signal?.aborted) throw new Error("__TASK_CANCELLED__");
    };
    checkAborted();
    this.emitProgress("Starting", "Initializing session context", "\u25B8");
    let session = await this.sessionStore.getActiveSession();
    if (!session) {
      session = await this.sessionStore.createSession(objective, {
        planner: this.currentConfig.plannerModel,
        editor: this.currentConfig.editorModel,
        fast: this.currentConfig.fastModel,
      });
    }

    if (this.activeTokenSessionId !== session.id) {
      this.activeTokenSessionId = session.id;
      this.resetTokenUsage();
    } else {
      // Auto-reset context window when approaching budget (like Copilot does)
      const budget = Math.max(this.currentConfig.maxContextTokens, 1);
      const usageRatio = this.tokensConsumed / budget;
      if (usageRatio >= 0.9) {
        this.emitProgress(
          "Context reset",
          "Token budget reached, resetting context window",
          "\u21BB",
        );
        this.resetTokenUsage();
      }
    }

    if (request.messageId) {
      if (request.action === "edit") {
        await this.sessionStore.updateMessage(
          session.id,
          request.messageId,
          objective,
        );
        await this.sessionStore.truncateAfterMessage(
          session.id,
          request.messageId,
          false,
        );
      } else if (request.action === "retry") {
        await this.sessionStore.truncateAfterMessage(
          session.id,
          request.messageId,
          true,
        );
      }

      session = (await this.sessionStore.getSession(session.id)) ?? session;
    }

    if (request.action !== "edit" && request.action !== "retry") {
      const userTurn: ConversationMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: objective,
        createdAt: new Date().toISOString(),
      };
      await this.sessionStore.appendMessage(session.id, userTurn);
    }

    const mode = this.currentConfig.conversationMode;
    const allowEdits = mode === "agent" && this.shouldAllowEdits(objective);
    const attachedFiles = session.attachedFiles ?? [];
    const attachedContext = await this.loadAttachedFileContext(attachedFiles);
    const conversationHistory = await this.buildConversationHistory(
      session.messages,
    );
    const inventoryRequest = this.isWorkspaceDiscoveryObjective(objective);

    if (inventoryRequest) {
      this.emitProgress(
        "Scanning workspace",
        "Listing project files",
        "\u25CB",
      );
      const inventory = await this.buildWorkspaceInventory(250);
      const responseText = this.formatWorkspaceInventoryResponse(
        inventory,
        objective,
      );

      await this.persistTaskResult(session.id, objective, responseText, mode);

      return {
        sessionId: session.id,
        objective,
        plan: {
          objective,
          assumptions: [
            "The user asked for a workspace inventory or file scan.",
            "A direct inventory is more reliable than a model-generated summary.",
          ],
          acceptanceCriteria: [
            "The response lists workspace files or explains the scan clearly.",
            "No file edits are proposed.",
          ],
          todos: [],
          steps: [],
          taskSlices: [],
          verification: [],
        },
        todos: [],
        responseText,
        proposal: null,
      };
    }

    if (mode === "ask") {
      this.emitProgress(
        "Ask mode",
        "Preparing conversational response",
        "\u25CB",
      );
      const [model, styleHint, improvementHints, webResearch] =
        await Promise.all([
          this.resolveModelOrFallback(this.currentConfig.fastModel),
          this.getLearnedStyleHint(objective, mode),
          this.improvementEngine.getOptimizedBehaviorHints(objective, mode),
          this.collectWebResearch(objective, mode),
        ]);
      const agentAwareness = this.improvementEngine.getAgentAwarenessHints();
      if (webResearch) {
        this.emitProgress(
          "Web research",
          webResearch.query ?? "searching",
          "\u25CB",
        );
      }
      this.emitProgress("Generating response", model, "\u25B8");
      const taskStart = Date.now();
      checkAborted();
      const response = await this.provider.chat({
        model,
        signal,
        onChunk: (chunk) => {
          this.emitReasoningChunk(chunk);
          this.emitStreamChunk(chunk);
        },
        messages: [
          {
            role: "system" as const,
            content:
              this.getPersonaPrompt() +
              " You are in Ask mode. Be conversational, answer questions, and explain context. Do not propose code edits, terminal commands, or plan artifacts." +
              (styleHint ? " " + styleHint : "") +
              (improvementHints ? " " + improvementHints : "") +
              (agentAwareness ? " " + agentAwareness : ""),
          },
          ...conversationHistory,
          ...(webResearch
            ? [
                {
                  role: "system" as const,
                  content: this.formatWebResearchContext(webResearch),
                },
              ]
            : []),
          ...(attachedContext.length > 0
            ? [
                {
                  role: "system" as const,
                  content: this.formatAttachedContext(attachedContext),
                },
              ]
            : []),
          this.buildUserMessage(objective, request.images),
        ],
        maxTokens: 2048,
      });
      this.consumeTokens(response.tokenUsage);

      await this.persistTaskResult(session.id, objective, response.text, mode);

      // Self-improvement: reflect on this task
      const taskDuration = Date.now() - taskStart;
      this.selfReflectBackground(
        session.id,
        objective,
        response.text,
        true,
        taskDuration,
        mode,
        model,
        0,
        0,
      );

      return {
        sessionId: session.id,
        objective,
        plan: {
          objective,
          assumptions: ["Ask mode used; no edits or plan artifacts requested."],
          acceptanceCriteria: [
            "The answer stays conversational and accurate.",
            "No file edits, terminal commands, or plan artifacts are produced.",
          ],
          todos: [],
          steps: [],
          taskSlices: [],
          verification: [],
        },
        todos: [],
        responseText: response.text,
        proposal: null,
      };
    }

    if (mode === "plan") {
      this.emitProgress("Plan mode", "Preparing structured plan", "\u25A0");
      const [plannerModel, webResearch] = await Promise.all([
        this.resolveModelOrFallback(this.currentConfig.plannerModel),
        this.collectWebResearch(objective, mode),
      ]);
      if (webResearch) {
        this.emitProgress(
          "Web research",
          webResearch.query ?? "searching",
          "\u25CB",
        );
      }
      this.emitProgress("Building plan", plannerModel, "\u25A0");
      const plan = await this.planner.createPlan(objective, plannerModel);
      this.emitProgress("Saving plan artifact", undefined, "\u25CB");
      const artifactPath = await this.writePlanArtifact(
        objective,
        plan,
        webResearch,
      );
      const responseText = [
        `**Plan mode active.** ${artifactPath ? `Wrote plan artifact to \`${artifactPath}\`.` : "Generated a plan summary."}`,
        "This mode does not make code changes.",
        webResearch
          ? "Latest web research was included in the plan artifact."
          : "",
        "",
        `**Objective:** ${plan.objective || objective}`,
        plan.assumptions.length > 0
          ? `\n**Assumptions:**\n${plan.assumptions.map((a: string) => `- ${a}`).join("\n")}`
          : "",
        plan.steps.length > 0
          ? `\n**Steps:**\n${plan.steps.map((s, i) => `${i + 1}. ${s.goal}`).join("\n")}`
          : "",
        plan.todos.length > 0
          ? `\n**Todos:**\n${plan.todos.map((t) => `- [${t.status === "done" ? "x" : " "}] ${t.title}`).join("\n")}`
          : "",
        plan.acceptanceCriteria.length > 0
          ? `\n**Acceptance criteria:**\n${plan.acceptanceCriteria.map((c: string) => `- ${c}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      await this.persistTaskResult(session.id, objective, responseText, mode);

      return {
        sessionId: session.id,
        objective,
        plan,
        todos: plan.todos,
        responseText,
        proposal: null,
        artifactPath: artifactPath ?? undefined,
      };
    }

    if (!allowEdits) {
      this.emitProgress(
        "Generating response",
        this.currentConfig.fastModel,
        "\u25B8",
      );
      const [model, styleHintConvo, improvementHintsConvo] = await Promise.all([
        this.resolveModelOrFallback(this.currentConfig.fastModel),
        this.getLearnedStyleHint(objective, mode),
        this.improvementEngine.getOptimizedBehaviorHints(objective, mode),
      ]);
      const agentAwarenessConvo =
        this.improvementEngine.getAgentAwarenessHints();
      const taskStartConvo = Date.now();
      checkAborted();
      const response = await this.provider.chat({
        model,
        signal,
        onChunk: (chunk) => {
          this.emitReasoningChunk(chunk);
          this.emitStreamChunk(chunk);
        },
        messages: [
          {
            role: "system" as const,
            content:
              this.getPersonaPrompt() +
              " Answer the user's question directly and concisely. " +
              "If they ask about code or their project, use any attached context to give a specific, accurate answer. " +
              "Do not propose file edits in this mode." +
              (styleHintConvo ? " " + styleHintConvo : "") +
              (improvementHintsConvo ? " " + improvementHintsConvo : "") +
              (agentAwarenessConvo ? " " + agentAwarenessConvo : ""),
          },
          ...conversationHistory,
          ...(attachedContext.length > 0
            ? [
                {
                  role: "system" as const,
                  content: [
                    "Attached workspace context:",
                    ...attachedContext.map(
                      (snippet) => `File: ${snippet.path}\n${snippet.content}`,
                    ),
                  ].join("\n\n"),
                },
              ]
            : []),
          this.buildUserMessage(objective, request.images),
        ],
        maxTokens: 2048,
      });
      this.consumeTokens(response.tokenUsage);

      await this.persistTaskResult(session.id, objective, response.text, mode);

      const taskDurConvo = Date.now() - taskStartConvo;
      this.selfReflectBackground(
        session.id,
        objective,
        response.text,
        true,
        taskDurConvo,
        mode,
        model,
        0,
        0,
      );

      return {
        sessionId: session.id,
        objective,
        plan: {
          objective,
          assumptions: [
            "General conversation path used; no file edits requested.",
          ],
          acceptanceCriteria: [
            "The response directly answers the request.",
            "No file edits are proposed unless explicitly requested.",
          ],
          todos: [],
          steps: [],
          taskSlices: [],
          verification: [],
        },
        todos: [],
        responseText: response.text,
        proposal: null,
      };
    }

    this.emitProgress("Agent mode", "Analyzing request", "\u25B8");
    const taskStartAgent = Date.now();
    const agentResult = await this.runAgentWorkflow(
      objective,
      session.id,
      signal,
      request.images,
    );

    await this.persistTaskResult(
      session.id,
      objective,
      agentResult.responseText,
      mode,
    );

    const taskDurAgent = Date.now() - taskStartAgent;
    const proposedEditCount = agentResult.proposal?.edits.length ?? 0;
    const appliedEditCount = agentResult.autoApplied
      ? proposedEditCount
      : agentResult.proposal
        ? proposedEditCount
        : 0;
    this.selfReflectBackground(
      session.id,
      objective,
      agentResult.responseText,
      true,
      taskDurAgent,
      mode,
      this.currentConfig.editorModel,
      proposedEditCount,
      appliedEditCount,
    );

    return {
      sessionId: session.id,
      objective,
      plan: agentResult.plan,
      responseText: agentResult.responseText,
      todos: agentResult.todos,
      proposal: agentResult.autoApplied ? null : agentResult.proposal,
      autoApplied: agentResult.autoApplied,
      fileDiffs: agentResult.fileDiffs,
      toolSummary: formatToolObservations(agentResult.toolTrace),
      toolTrace: agentResult.toolTrace,
    };
  }

  /**
   * Apply pending edits. The permission policy is the single authority
   * for whether approval is needed. When `userApproved` is true the caller
   * has already obtained consent from the user.
   * In "full" (bypass) mode, edits are auto-approved without any prompt.
   */
  public async applyPendingEdits(userApproved = false): Promise<string> {
    const decision = this.permissionPolicy.evaluate({
      action: "multi_file_edit",
      description: "Apply pending edit proposal",
    });

    // In full mode, always auto-approve
    const isBypass = this.permissionPolicy.getMode() === "full";
    if (!decision.allowed && !userApproved && !isBypass) {
      return "Approval required before applying pending edits.";
    }

    // Record approval if the user explicitly approved or bypass mode
    if ((userApproved || isBypass) && !decision.allowed) {
      this.permissionPolicy.recordDecision(
        {
          action: "multi_file_edit",
          description: "Apply pending edit proposal",
        },
        true,
        true,
      );
    }

    const result = await this.editManager.applyPending();
    if (!result) {
      return "No pending proposal to apply.";
    }

    // Refresh git SCM after edits (non-fatal if not a git repo)
    try {
      const isGit = await this.gitService.isGitRepository();
      if (isGit) {
        await this.gitService.refreshScm();
      }
    } catch {
      /* non-fatal — project may not use git */
    }

    if (this.currentConfig.memoryMode !== "off") {
      await this.memoryStore.addEpisode(
        "apply_pending_edits",
        `Applied transaction ${result.id}`,
      );
    }

    this.packageScriptsCache.clear();

    return `Applied transaction ${result.id}.`;
  }

  public async acceptFileEdit(filePath: string): Promise<string> {
    const ok = await this.editManager.acceptFile(filePath);
    if (!ok) return "File not found in pending proposal.";
    this.packageScriptsCache.clear();
    return `Accepted edit for ${path.basename(filePath)}.`;
  }

  public async rejectFileEdit(filePath: string): Promise<string> {
    const ok = await this.editManager.rejectFile(filePath);
    if (!ok) return "File not found in pending proposal.";
    return `Rejected edit for ${path.basename(filePath)}.`;
  }

  public async revertLastAppliedEdits(): Promise<string> {
    const reverted = await this.editManager.revertLastApplied();
    if (!reverted) {
      return "No applied transaction to revert.";
    }

    if (this.currentConfig.memoryMode !== "off") {
      await this.memoryStore.addEpisode(
        "revert_last_transaction",
        `Reverted transaction ${reverted.id}`,
      );
    }

    this.packageScriptsCache.clear();

    return `Reverted transaction ${reverted.id}.`;
  }

  public getApprovalMode(): "strict" | "balanced" | "fast" {
    return toLegacyApprovalMode(this.permissionPolicy.getMode());
  }

  public async setApprovalMode(
    mode: "strict" | "balanced" | "fast",
  ): Promise<void> {
    const permMode = fromLegacyApprovalMode(mode);
    await this.setPermissionMode(permMode);
  }

  // ── Permission Mode ─────────────────────────────────────────────

  public getPermissionMode(): PermissionMode {
    return this.permissionPolicy.getMode();
  }

  public async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionPolicy.setMode(mode);
    this.currentConfig.permissionMode = mode;
    await this.updateSetting("behavior.permissionMode", mode);

    // Keep legacy approvalMode in sync for backward compat
    const legacy = toLegacyApprovalMode(mode);
    this.currentConfig.approvalMode = legacy;
    await this.updateSetting("behavior.approvalMode", legacy);
    await this.memoryStore.setPreference("permission.mode", mode);
  }

  /**
   * Evaluate a permission request through the centralized policy.
   * UI layers should call this instead of checking approvalMode directly.
   */
  public evaluatePermission(
    action: string,
    description: string,
  ): PermissionDecision {
    return this.permissionPolicy.evaluate({
      action: classifyAction(action),
      description,
    });
  }

  /**
   * Check whether pending edits need user approval per the policy.
   * In "full" (bypass) mode, never require approval.
   */
  public needsApprovalForEdits(): boolean {
    if (this.permissionPolicy.getMode() === "full") {
      return false;
    }
    const decision = this.permissionPolicy.evaluate({
      action: "multi_file_edit",
      description: "Apply pending edit proposal",
    });
    return !decision.allowed;
  }

  // ── Terminal Execution ──────────────────────────────────────────

  public getTerminalExecutor(): TerminalExecutor {
    return this.terminalExecutor;
  }

  /**
   * Execute a terminal command with permission checks.
   * In full/bypass mode, auto-executes. Otherwise asks for approval.
   */
  public async executeTerminalCommand(
    command: string,
    options?: {
      cwd?: string;
      timeoutMs?: number;
      visible?: boolean;
      purpose?: "tool" | "verification" | "manual";
    },
  ): Promise<TerminalExecResult | null> {
    // Auto-fix known bad commands before execution
    let sanitized = command;
    // pnpm doesn't support -y flag on init
    sanitized = sanitized.replace(/\bpnpm\s+init\s+-y\b/g, "pnpm init");
    // Normalize quoted paths for shell compatibility
    if (sanitized !== command) {
      this.logger.info(`Command sanitized: "${command}" → "${sanitized}"`);
    }

    const decision = this.permissionPolicy.evaluate({
      action: "terminal_exec",
      description: `Run terminal command: ${sanitized}`,
    });
    const safeCommand = isSafeTerminalCommand(sanitized);
    // Safe commands always run in non-strict mode.
    // Unsafe commands require allowTerminalExecution or autoRunVerification.
    const mode = this.permissionPolicy.getMode();
    const canAutoRunSafeCommand =
      mode !== "strict" &&
      (safeCommand ||
        (options?.purpose === "verification" &&
          this.currentConfig.autoRunVerification) ||
        (options?.purpose === "tool" &&
          this.currentConfig.allowTerminalExecution));

    if (!decision.allowed && !canAutoRunSafeCommand) {
      this.logger.info(`Terminal exec blocked by policy: ${sanitized}`);
      return null;
    }

    this.logger.info(`Executing terminal command: ${sanitized}`);
    if (options?.visible) {
      this.terminalExecutor.runInVisibleTerminal(sanitized);
      return {
        exitCode: 0,
        output: "",
        command: sanitized,
        durationMs: 0,
        timedOut: false,
      };
    }
    // Show agent commands in a visible terminal for user awareness
    const showInTerminal = options?.purpose === "tool";
    return this.terminalExecutor.execute(sanitized, {
      ...options,
      showInTerminal,
    });
  }

  // ── Git Service ─────────────────────────────────────────────────

  public getGitService(): GitService {
    return this.gitService;
  }

  // ── Improvement Engine ──────────────────────────────────────────

  public getImprovementEngine(): ImprovementEngine {
    return this.improvementEngine;
  }

  public async getPendingProposalSummary(): Promise<string> {
    const proposal = await this.editManager.getPendingProposal();
    if (!proposal) {
      return "No pending edit proposal.";
    }

    const lines = proposal.edits.map(
      (edit) =>
        `- [${edit.operation ?? "write"}] ${edit.filePath}${edit.targetPath ? ` -> ${edit.targetPath}` : ""}${edit.reason ? ` (${edit.reason})` : ""}`,
    );
    return [`Pending proposal: ${proposal.objective}`, ...lines].join("\n");
  }

  public async resumeLastSessionSummary(): Promise<string> {
    const active = await this.sessionStore.getActiveSession();
    if (!active) {
      return "No active session available.";
    }

    return [
      `Session: ${active.id}`,
      `Title: ${active.title}`,
      `Updated: ${active.updatedAt}`,
      `Last result: ${active.lastResult ?? "None"}`,
    ].join("\n");
  }

  public async listRecentSessions(limit = 6): Promise<RecentSessionItem[]> {
    const sessions = await this.sessionStore.listSessions();
    return sessions.slice(0, limit).map((session) => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      messageCount: session.messages?.length ?? 0,
      attachmentCount: session.attachedFiles?.length ?? 0,
    }));
  }

  public async openSession(sessionId: string): Promise<SessionRecord | null> {
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      return null;
    }

    await this.editManager.clearPendingProposal();
    await this.sessionStore.setActiveSession(sessionId);
    this.activeTokenSessionId = sessionId;
    this.resetTokenUsage();
    return session;
  }

  public async attachFilesToActiveSession(
    paths: string[],
  ): Promise<SessionRecord | null> {
    const trimmed = paths
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => this.normalizeAttachmentPath(value));
    if (trimmed.length === 0) {
      return null;
    }

    let session = await this.sessionStore.getActiveSession();
    if (!session) {
      session = await this.sessionStore.createSession("Attached context", {
        planner: this.currentConfig.plannerModel,
        editor: this.currentConfig.editorModel,
        fast: this.currentConfig.fastModel,
      });
    }

    const nextFiles = Array.from(
      new Set([...(session.attachedFiles ?? []), ...trimmed]),
    );
    await this.sessionStore.setAttachedFiles(session.id, nextFiles);
    return this.sessionStore.getSession(session.id);
  }

  public getConversationMode(): ConversationMode {
    return this.currentConfig.conversationMode;
  }

  /** Alias for sidebar drag-and-drop. */
  public async attachFiles(paths: string[]): Promise<void> {
    await this.attachFilesToActiveSession(paths);
  }

  /** Update the set of enabled tools from the UI tool config panel. */
  public setEnabledTools(map: Record<string, boolean>): void {
    this.enabledToolsMap = { ...map };
  }

  /** Check if a specific tool is enabled by the user. */
  public isToolEnabled(toolId: string): boolean {
    if (Object.keys(this.enabledToolsMap).length === 0) return true;
    return this.enabledToolsMap[toolId] !== false;
  }

  public async setConversationMode(mode: ConversationMode): Promise<void> {
    await this.updateSetting("behavior.conversationMode", mode);
    this.currentConfig.conversationMode = mode;
  }

  public async deleteSession(sessionId: string): Promise<{
    deleted: boolean;
    wasActive: boolean;
  }> {
    const active = await this.sessionStore.getActiveSession();
    const wasActive = active?.id === sessionId;
    const deleted = await this.sessionStore.deleteSession(sessionId);

    if (deleted && wasActive) {
      await this.sessionStore.clearActiveSession();
      await this.editManager.clearPendingProposal();
      this.activeTokenSessionId = null;
      this.resetTokenUsage();
    }

    return { deleted, wasActive };
  }

  public async startNewConversation(): Promise<void> {
    await this.sessionStore.clearActiveSession();
    await this.editManager.clearPendingProposal();
    this.activeTokenSessionId = null;
    this.resetTokenUsage();
  }

  public listAvailableSkills(): SkillManifest[] {
    return this.skillRegistry.list();
  }

  public async reindexWorkspace(): Promise<string> {
    const stats = await this.scanner.scanWorkspace();
    return `Indexed ${stats.totalFiles} files at ${stats.indexedAt}`;
  }

  public diagnosticsSummary(): string {
    const result = this.verifier.runDiagnostics();
    return result.summary;
  }

  public async mcpSummary(): Promise<string> {
    const servers = await this.getMcpStatuses(true);
    if (servers.length === 0) {
      return "No MCP servers configured.";
    }

    return servers
      .map(
        (server) =>
          `${server.id}: ${server.state} (transport=${server.transport}, trust=${server.trust}) - ${server.detail}`,
      )
      .join("\n");
  }

  public async diagnosticsReportMarkdown(): Promise<string> {
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
      `- Skills registry: ${this.skillRegistry.list().length} skills`,
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
      "```",
    ].join("\n");
  }

  public async researchWeb(query: string): Promise<WebSearchResponse> {
    return this.webSearch.search(query, {
      maxResults: this.getWebSearchResultLimit(),
    });
  }

  public async runPrepublishGuard(): Promise<PrepublishGuardResult> {
    await this.refreshProviderState();

    const diagnostics = this.verifier.runDiagnostics();
    const pending = await this.editManager.getPendingProposal();
    const mcpStatuses = await this.getMcpStatuses(true);
    const models = await this.listAvailableModels();
    const modelNames = new Set(models.map((model) => model.name));
    const requiredModels = [
      this.currentConfig.plannerModel,
      this.currentConfig.editorModel,
      this.currentConfig.fastModel,
    ];
    const missingRequired = requiredModels.filter(
      (model) => !modelNames.has(model),
    );
    const enabledMcp = mcpStatuses.filter((row) => row.enabled);
    const brokenMcp = enabledMcp.filter((row) => row.state === "error");
    const skills = this.skillRegistry.list();

    const checks: Array<{ name: string; ok: boolean; detail: string }> = [
      {
        name: "Ollama reachable",
        ok: this.health.ok,
        detail: this.health.message,
      },
      {
        name: "Local models discovered",
        ok: models.length > 0,
        detail:
          models.length > 0
            ? `${models.length} model(s) available.`
            : "No local models discovered.",
      },
      {
        name: "Configured models available",
        ok: missingRequired.length === 0,
        detail:
          missingRequired.length === 0
            ? "Planner/editor/fast models are present locally."
            : `Missing configured model(s): ${missingRequired.join(", ")}`,
      },
      {
        name: "MCP connections healthy",
        ok: brokenMcp.length === 0,
        detail:
          brokenMcp.length === 0
            ? `Enabled MCP servers: ${enabledMcp.length}, no errors.`
            : brokenMcp.map((row) => `${row.id}: ${row.detail}`).join("; "),
      },
      {
        name: "No pending edits",
        ok: pending === null,
        detail:
          pending === null
            ? "No pending edit proposal in queue."
            : `Pending proposal exists: ${pending.objective}`,
      },
      {
        name: "Diagnostics are clean",
        ok: !diagnostics.hasErrors,
        detail: diagnostics.summary,
      },
      {
        name: "Skills registry loaded",
        ok: skills.length > 0,
        detail: `${skills.length} skill(s) available.`,
      },
    ];

    const ok = checks.every((check) => check.ok);
    const markdown = [
      "# Pulse Prepublish Guard",
      "",
      `- Overall: ${ok ? "PASS" : "FAIL"}`,
      `- Timestamp: ${new Date().toISOString()}`,
      "",
      "## Checks",
      "",
      ...checks.map(
        (check) =>
          `- [${check.ok ? "PASS" : "FAIL"}] ${check.name} - ${check.detail}`,
      ),
      "",
      "## Skills",
      "",
      ...skills.map((skill) => `- ${skill.name} (${skill.id})`),
    ].join("\n");

    return { ok, checks, markdown };
  }

  public async summary(): Promise<RuntimeSummary> {
    const active = await this.sessionStore.getActiveSession();
    const pending = await this.editManager.getPendingProposal();
    const mcpStatuses = await this.getMcpStatuses();
    const mcpConfigured = mcpStatuses.filter((s) => s.enabled).length;
    const mcpHealthy = mcpStatuses.filter(
      (s) => s.state === "configured",
    ).length;
    const learningStats = await this.improvementEngine.getStats();
    const tokenBudget = Math.max(this.currentConfig.maxContextTokens, 1);
    const tokenUsagePercent = Math.min(
      100,
      Math.round((this.tokensConsumed / tokenBudget) * 100),
    );
    const learningProgressPercent = Math.min(
      100,
      Math.round(learningStats.performanceScore * 100),
    );

    return {
      status: this.health.ok ? "ready" : "degraded",
      ollamaReachable: this.health.ok,
      conversationMode: this.currentConfig.conversationMode,
      persona: this.currentConfig.persona ?? "software-engineer",
      plannerModel: this.currentConfig.plannerModel,
      editorModel: this.currentConfig.editorModel,
      fastModel: this.currentConfig.fastModel,
      embeddingModel: this.currentConfig.embeddingModel,
      approvalMode: this.currentConfig.approvalMode,
      permissionMode: this.permissionPolicy.getMode(),
      storagePath: this.storage.storageDir,
      ollamaHealth: this.health.message,
      modelCount: this.availableModels.length,
      activeSessionId: active?.id ?? null,
      hasPendingEdits: pending !== null,
      pendingEditCount: pending?.edits.length ?? 0,
      tokenBudget,
      tokensConsumed: this.tokensConsumed,
      tokenUsagePercent,
      learningProgressPercent,
      mcpConfigured,
      mcpHealthy,
      selfLearnEnabled: this.currentConfig.selfLearnEnabled ?? false,
    };
  }

  private async getMcpStatuses(force = false): Promise<McpServerStatus[]> {
    const now = Date.now();
    const cacheTtlMs = 15_000;
    if (
      !force &&
      this.mcpStatusCache &&
      now - this.mcpStatusCache.checkedAt < cacheTtlMs
    ) {
      return this.mcpStatusCache.statuses;
    }

    if (this.mcpStatusPromise) {
      return this.mcpStatusPromise;
    }

    this.mcpStatusPromise = this.mcpManager
      .listServerStatus()
      .then((statuses) => {
        this.mcpStatusCache = {
          checkedAt: Date.now(),
          statuses,
        };
        return statuses;
      })
      .catch((error) => {
        this.logger.warn(`Failed to load MCP status: ${stringifyError(error)}`);
        return this.mcpStatusCache?.statuses ?? [];
      })
      .finally(() => {
        this.mcpStatusPromise = null;
      });

    return this.mcpStatusPromise;
  }

  private mergeConfiguredModels(discovered: ModelSummary[]): ModelSummary[] {
    const merged = new Map<string, ModelSummary>();
    for (const model of discovered) {
      merged.set(model.name, model);
    }

    const configuredModels = [
      this.currentConfig.plannerModel,
      this.currentConfig.editorModel,
      this.currentConfig.fastModel,
      this.currentConfig.embeddingModel,
      ...this.currentConfig.fallbackModels,
    ];

    for (const configured of configuredModels) {
      if (!configured || merged.has(configured)) {
        continue;
      }

      merged.set(configured, {
        name: configured,
        source: "configured",
      });
    }

    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private consumeTokens(
    usage:
      | {
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
        }
      | undefined,
  ): void {
    if (!usage) {
      return;
    }

    const budget = Math.max(this.currentConfig.maxContextTokens, 1);
    this.tokensConsumed = Math.min(
      budget,
      this.tokensConsumed + Math.max(usage.totalTokens, 0),
    );
    this.emitTokenUpdate();
  }

  private resetTokenUsage(): void {
    this.tokensConsumed = 0;
    this.emitTokenUpdate();
  }

  /**
   * Fire-and-forget self-reflection after a task completes.
   * Runs in background so it never blocks the response to the user.
   */
  private selfReflectBackground(
    sessionId: string,
    objective: string,
    responseText: string,
    success: boolean,
    durationMs: number,
    mode: ConversationMode,
    model: string,
    editsProposed: number,
    editsApplied: number,
  ): void {
    const outcomeId = `${sessionId}_${Date.now()}`;
    void (async () => {
      try {
        await this.improvementEngine.recordOutcome({
          id: outcomeId,
          timestamp: new Date().toISOString(),
          objective: objective.slice(0, 200),
          mode,
          model,
          success,
          durationMs,
          editsProposed,
          editsApplied,
          skillsUsed: [],
          tokensUsed: this.tokensConsumed,
        });
        await this.improvementEngine.reflectOnTask(
          outcomeId,
          objective,
          responseText,
          success,
          durationMs,
        );
      } catch {
        // Self-improvement is best-effort, never block the user
      }
    })();
  }

  private async resolveModelOrFallback(primary: string): Promise<string> {
    const models = await this.listAvailableModels();
    const usableModels = models.filter(
      (model) => model.source === "local" || model.source === "running",
    );
    const names = new Set(usableModels.map((model) => model.name));

    if (names.has(primary)) {
      return primary;
    }

    for (const fallback of this.currentConfig.fallbackModels) {
      if (names.has(fallback)) {
        this.logger.warn(
          `Model ${primary} unavailable. Falling back to ${fallback}.`,
        );
        return fallback;
      }
    }

    if (usableModels[0]?.name) {
      this.logger.warn(
        `Model ${primary} unavailable. Falling back to first discovered model ${usableModels[0].name}.`,
      );
      return usableModels[0].name;
    }

    return primary;
  }

  private async alignConfiguredModelsToAvailableModels(): Promise<void> {
    const usableModels = this.availableModels.filter(
      (model) => model.source === "local" || model.source === "running",
    );
    if (usableModels.length === 0) {
      return;
    }

    const preferred =
      usableModels.find((model) => model.name === "qwen2.5-coder:7b") ??
      usableModels[0];

    const updates: Array<Thenable<void>> = [];
    const cfg = vscode.workspace.getConfiguration("pulse");

    if (
      !usableModels.some(
        (model) => model.name === this.currentConfig.plannerModel,
      )
    ) {
      this.currentConfig.plannerModel = preferred.name;
      updates.push(
        cfg.update(
          "models.planner",
          preferred.name,
          vscode.ConfigurationTarget.Workspace,
        ),
      );
    }

    if (
      !usableModels.some(
        (model) => model.name === this.currentConfig.editorModel,
      )
    ) {
      this.currentConfig.editorModel = preferred.name;
      updates.push(
        cfg.update(
          "models.editor",
          preferred.name,
          vscode.ConfigurationTarget.Workspace,
        ),
      );
    }

    if (
      !usableModels.some((model) => model.name === this.currentConfig.fastModel)
    ) {
      this.currentConfig.fastModel = preferred.name;
      updates.push(
        cfg.update(
          "models.fast",
          preferred.name,
          vscode.ConfigurationTarget.Workspace,
        ),
      );
    }

    await Promise.all(updates);
  }

  private async buildConversationHistory(
    messages: ConversationMessage[] = [],
  ): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const MAX_RECENT = 40;
    const SUMMARY_THRESHOLD = 50;

    if (messages.length <= MAX_RECENT) {
      return messages.map((m) => ({ role: m.role, content: m.content }));
    }

    const older = messages.slice(0, messages.length - MAX_RECENT);
    const recent = messages.slice(-MAX_RECENT);

    const keyPoints: string[] = [];
    for (const m of older) {
      if (m.role === "user") {
        const trimmed = m.content.slice(0, 200).replace(/\n+/g, " ").trim();
        if (trimmed) {
          keyPoints.push(`- User: ${trimmed}`);
        }
      }
    }

    const summaryText =
      keyPoints.length > 0
        ? `[Conversation context — ${older.length} earlier messages summarised]\n` +
          keyPoints.slice(-SUMMARY_THRESHOLD).join("\n")
        : `[Conversation context — ${older.length} earlier messages omitted for brevity]`;

    const history: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: summaryText },
    ];

    for (const m of recent) {
      history.push({ role: m.role, content: m.content });
    }

    return history;
  }

  private async loadAttachedFileContext(
    paths: string[],
  ): Promise<Array<{ path: string; content: string }>> {
    if (paths.length === 0) {
      return [];
    }

    const expandedPaths = await this.expandAttachmentPaths(paths.slice(0, 8));
    return this.scanner.readContextSnippets(expandedPaths.slice(0, 8), 4000);
  }

  private async expandAttachmentPaths(paths: string[]): Promise<string[]> {
    const expanded: string[] = [];

    for (const item of paths) {
      const absolutePath = this.resolveAttachmentPath(item);
      if (!absolutePath) {
        continue;
      }

      try {
        const stats = await vscode.workspace.fs.stat(
          vscode.Uri.file(absolutePath),
        );
        if (stats.type === vscode.FileType.Directory) {
          const folderUri = vscode.Uri.file(absolutePath);
          const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folderUri, "**/*"),
            "**/{node_modules,dist,.git}/**",
            20,
          );
          expanded.push(...files.map((file) => file.fsPath));
          continue;
        }

        expanded.push(absolutePath);
      } catch {
        // Skip unreadable attachments.
      }
    }

    return Array.from(new Set(expanded));
  }

  private resolveAttachmentPath(value: string): string | null {
    if (path.isAbsolute(value)) {
      return value;
    }

    if (!this.workspaceRoot) {
      return null;
    }

    return path.join(this.workspaceRoot.fsPath, value);
  }

  private normalizeAttachmentPath(value: string): string {
    const absolute = path.isAbsolute(value)
      ? value
      : this.workspaceRoot
        ? path.join(this.workspaceRoot.fsPath, value)
        : value;

    if (this.workspaceRoot) {
      const relative = path.relative(this.workspaceRoot.fsPath, absolute);
      if (
        relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
      ) {
        return relative;
      }
    }

    return absolute;
  }

  private formatAttachedContext(
    attachedContext: Array<{ path: string; content: string }>,
  ): string {
    return [
      "Attached workspace context:",
      ...attachedContext.map(
        (snippet) =>
          `File: ${this.normalizeDisplayPath(snippet.path)}\n${snippet.content}`,
      ),
    ].join("\n\n");
  }

  private normalizeDisplayPath(filePath: string): string {
    if (this.workspaceRoot && path.isAbsolute(filePath)) {
      const relative = path.relative(this.workspaceRoot.fsPath, filePath);
      if (
        relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
      ) {
        return relative;
      }
    }

    return filePath;
  }

  private async writePlanArtifact(
    objective: string,
    plan: TaskPlan,
    webResearch: WebSearchResponse | null,
  ): Promise<string | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return null;
    }

    const planDir = vscode.Uri.joinPath(workspaceFolder.uri, ".pulse", "plans");
    await vscode.workspace.fs.createDirectory(planDir);

    const slug =
      objective
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "plan";
    const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}.md`;
    const planPath = vscode.Uri.joinPath(planDir, fileName);
    const markdown = [
      `# ${objective}`,
      "",
      "## Objective",
      "",
      plan.objective,
      "",
      "## Assumptions",
      "",
      ...plan.assumptions.map((item) => `- ${item}`),
      "",
      "## Acceptance Criteria",
      "",
      ...plan.acceptanceCriteria.map((item) => `- ${item}`),
      "",
      "## TODOs",
      "",
      ...plan.todos.map(
        (todo) =>
          `- [${todo.status}] ${todo.title}${todo.detail ? ` — ${todo.detail}` : ""}`,
      ),
      "",
      "## Steps",
      "",
      ...plan.steps.map(
        (step, index) =>
          `${index + 1}. ${step.goal} (${step.tools.join(", ")})\n   - Expected: ${step.expectedOutput}`,
      ),
      "",
      "## Task Slices",
      "",
      ...plan.taskSlices.map((slice, index) =>
        [
          `${index + 1}. ${slice.title}`,
          `   - Scope: ${slice.scope}`,
          `   - Deliverable: ${slice.deliverable}`,
          `   - Steps: ${slice.steps.join("; ")}`,
          `   - Acceptance: ${slice.acceptanceCriteria.join("; ")}`,
        ].join("\n"),
      ),
      webResearch
        ? [
            "",
            "## Web Research",
            "",
            `Provider: ${webResearch.provider}`,
            `Query: ${webResearch.query}`,
            webResearch.answer ? `Answer: ${webResearch.answer}` : null,
            webResearch.note ? `Note: ${webResearch.note}` : null,
            ...(webResearch.results.length > 0
              ? [
                  "Results:",
                  ...webResearch.results.map(
                    (result) =>
                      `- ${result.title}\n  ${result.url}\n  ${result.content}`,
                  ),
                ]
              : []),
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n")
        : "",
      "",
      "## Verification",
      "",
      ...plan.verification.map((item) => `- ${item.type}: ${item.command}`),
      "",
    ].join("\n");

    await vscode.workspace.fs.writeFile(
      planPath,
      Buffer.from(markdown, "utf8"),
    );
    return this.normalizeDisplayPath(planPath.fsPath);
  }

  private shouldAllowEdits(objective: string): boolean {
    // Pure conversation can skip the full agent workflow.
    // Task-like prompts, even if short, should still go through tools.
    if (this.isSimpleConversational(objective)) {
      return false;
    }
    // Otherwise, always allow edits in agent mode. The permission policy
    // controls whether the user must approve before applying.
    return true;
  }

  private isSimpleConversational(objective: string): boolean {
    const trimmed = objective.trim();
    const lower = trimmed
      .toLowerCase()
      .replace(/[!?.]+$/, "")
      .trim();
    const greetings = [
      "hello",
      "hi",
      "hey",
      "yo",
      "sup",
      "howdy",
      "greetings",
      "good morning",
      "good afternoon",
      "good evening",
      "good night",
      "thanks",
      "thank you",
      "ty",
      "thx",
      "bye",
      "goodbye",
      "see you",
      "later",
      "ok",
      "okay",
      "sure",
      "yes",
      "no",
      "yep",
      "nope",
      "got it",
      "what can you do",
      "who are you",
      "what are you",
      "help",
      "help me",
    ];
    if (greetings.includes(lower)) {
      return true;
    }

    if (this.isTaskLikeObjective(lower)) {
      return false;
    }

    return trimmed.length < 12 && !/[{}<>/\\=]/.test(trimmed);
  }

  private isTaskLikeObjective(objectiveLower: string): boolean {
    return /\b(fix|bug|error|issue|task|tool|skill|code|project|workspace|file|edit|update|change|add|remove|implement|refactor|rename|move|test|build|run|install|debug|diagnose|search|read|scan)\b/.test(
      objectiveLower,
    );
  }

  private async collectWebResearch(
    objective: string,
    mode: ConversationMode,
  ): Promise<WebSearchResponse | null> {
    if (!this.shouldUseWebSearch(objective, mode)) {
      return null;
    }

    try {
      return await this.webSearch.search(objective, {
        maxResults: this.getWebSearchResultLimit(),
      });
    } catch (error) {
      this.logger.warn(`Web search failed: ${stringifyError(error)}`);
      return null;
    }
  }

  private shouldUseWebSearch(
    objective: string,
    mode: ConversationMode,
  ): boolean {
    const normalized = objective.toLowerCase();

    // Skip web search if the query is clearly about local workspace files or code
    const localCodeSignals = [
      "this file",
      "this code",
      "my code",
      "my project",
      "my app",
      "the codebase",
      "refactor",
      "rename",
      "move to",
      "delete the",
      "add a method",
      "add a function",
      "fix the error",
      "fix the bug",
      "fix this",
      "fix my",
      "implement",
      "create a component",
      "create a file",
      "write a test",
      "add tests",
      "src/",
      "./",
      ".ts",
      ".js",
      ".py",
      ".java",
      ".go",
      ".rs",
    ];
    if (this.matchesAny(normalized, localCodeSignals)) {
      return false;
    }

    const explicitSearchIntent = [
      "search the web",
      "search online",
      "look it up online",
      "find online",
      "check the internet",
      "browse for",
      "google",
      "web search",
    ];

    const timeSensitiveSignals = [
      "latest version of",
      "latest release",
      "newest version",
      "release notes for",
      "changelog for",
      "breaking change in",
      "migration guide for",
      "just released",
      "just announced",
      "official docs for",
      "official documentation for",
    ];

    if (
      this.matchesAny(normalized, explicitSearchIntent) ||
      this.matchesAny(normalized, timeSensitiveSignals)
    ) {
      return true;
    }

    // In ask mode, only search for genuinely external knowledge queries
    if (mode === "ask") {
      return this.matchesAny(normalized, [
        "compare .* vs",
        "difference between .* and",
        "alternative to",
        "recommend a",
        "best practice for",
        "tutorial for",
      ]);
    }

    // In agent mode, only search for package/dependency resolution
    return (
      mode === "agent" &&
      this.matchesAny(normalized, [
        "install .* package",
        "add .* dependency",
        "upgrade .* to",
        "migrate from .* to",
      ])
    );
  }

  private matchesAny(text: string, patterns: string[]): boolean {
    return patterns.some((pattern) => {
      // If pattern contains regex metacharacters like .*, use it as-is
      if (/[.*+?^${}()|[\]\\]/.test(pattern) && pattern.includes(".*")) {
        return new RegExp(pattern, "i").test(text);
      }
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i").test(text);
    });
  }

  private formatWebResearchContext(result: WebSearchResponse): string {
    const lines = [
      `Web search provider: ${result.provider}`,
      `Query: ${result.query}`,
    ];

    if (result.answer) {
      lines.push(`Answer: ${result.answer}`);
    }

    if (result.note) {
      lines.push(`Note: ${result.note}`);
    }

    if (result.results.length > 0) {
      lines.push("Results:");
      for (const entry of result.results.slice(0, 5)) {
        lines.push(`- ${entry.title}`);
        lines.push(`  ${entry.url}`);
        lines.push(`  ${entry.content}`);
      }
    }

    return lines.join("\n");
  }

  private async persistTaskResult(
    sessionId: string,
    objective: string,
    responseText: string,
    mode: ConversationMode,
  ): Promise<void> {
    await Promise.all([
      this.sessionStore.appendMessage(sessionId, {
        role: "assistant",
        content: responseText,
        createdAt: new Date().toISOString(),
      }),
      this.sessionStore.updateSessionResult(sessionId, responseText),
    ]);

    void Promise.all([
      this.editManager.clearPendingProposal(),
      this.learnFromExchange(objective, responseText, mode),
      this.currentConfig.memoryMode !== "off"
        ? this.memoryStore.addEpisode(objective, responseText.slice(0, 400))
        : Promise.resolve(),
    ]).catch((error) => {
      this.logger.warn(`Post-task write failed: ${stringifyError(error)}`);
    });
  }

  private async runAgentWorkflow(
    objective: string,
    sessionId: string,
    signal?: AbortSignal,
    images?: Array<{ name: string; dataUrl: string }>,
  ): Promise<{
    plan: TaskPlan;
    responseText: string;
    todos: TaskTodo[];
    shortcuts: string[];
    proposal: EditProposal | null;
    autoApplied: boolean;
    fileDiffs?: FileDiffResult[];
    toolTrace: TaskToolObservation[];
    qualityScore?: number;
    qualityTarget?: number;
    meetsQualityTarget?: boolean;
  }> {
    const checkAborted = () => {
      if (signal?.aborted) {
        throw new Error("__TASK_CANCELLED__");
      }
    };

    checkAborted();

    const sessionPromise = this.sessionStore.getSession(sessionId);
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
      this.currentConfig.memoryMode === "off"
        ? Promise.resolve([])
        : this.memoryStore.latestEpisodes(3),
      this.collectWebResearch(objective, "agent"),
      this.getLearnedStyleHint(objective, "agent"),
      this.improvementEngine.getOptimizedBehaviorHints(objective, "agent"),
    ]);
    const agentAwarenessAgent = this.improvementEngine.getAgentAwarenessHints();
    if (webResearch) {
      this.emitProgress(
        "Web research",
        webResearch.query ?? "searching",
        "\u25CB",
      );
    }

    const session = await sessionPromise;
    const [contextSnippets, attachedContext, conversationHistory] =
      await Promise.all([
        this.scanner.readContextSnippets(candidateFiles.slice(0, 6), 4000),
        this.loadAttachedFileContext(session?.attachedFiles ?? []),
        this.buildConversationHistory(session?.messages ?? []),
      ]);
    const selectedSkills = this.skillRegistry.selectForObjective(objective);
    const skillsSummary = this.skillRegistry.summarizeSelection(selectedSkills);
    const optionalShortcuts =
      this.skillRegistry.buildOptionalShortcuts(selectedSkills);
    const shortcutSummary = formatShortcutHints(optionalShortcuts);
    const primarySkillName = selectedSkills.primary?.name ?? "None";
    this.emitProgress("Building plan", plannerModel, "\u25A0");
    const plan = await this.planner.createPlan(objective, plannerModel);

    const buildPrompt = (
      toolContext: string,
      critiqueContext: string,
    ): string =>
      [
        this.getPersonaPrompt(),
        "You are an autonomous coding agent inside VS Code. You MUST return valid JSON only, no markdown.",
        ...(styleHintAgent ? [styleHintAgent] : []),
        ...(improvementHintsAgent ? [improvementHintsAgent] : []),
        ...(agentAwarenessAgent ? [agentAwarenessAgent] : []),
        shortcutSummary ? shortcutSummary : "",
        `Primary skill: ${primarySkillName}`,
        skillsSummary ? `Skills:\n${skillsSummary}` : "",
        "",
        /next\.?js|next-app|scaffold|blog/i.test(objective)
          ? [
              "## SCAFFOLDING",
              "- Use the framework's official scaffold command first.",
              "- For Next.js, prefer `pnpm create next-app@latest . --ts --tailwind --eslint --app`.",
              "- Do not use `pnpm init -y`; pnpm init does not support the -y flag.",
              "- Create dummy data and blog components only after the scaffold succeeds.",
              "",
            ].join("\n")
          : "",
        "## WORKFLOW",
        "1. Read/search files BEFORE editing. Never guess contents.",
        "2. Work through todos ONE at a time: mark current 'in-progress', execute it with tool calls, mark 'done'.",
        "3. After run_terminal, ALWAYS check output. If errors: diagnose and fix before proceeding.",
        "4. Use create_file tool for new files (preferred — gives immediate feedback). Use batch_edit for modifying existing files.",
        "5. On failure: analyze error → try alternatives → never give up on first attempt.",
        "6. Never delete files unless explicitly asked. Contain fixes — don't break other code.",
        "7. You get MULTIPLE turns. Each turn you can make tool calls. Use them!",
        "8. Do not repeat the same tool call, edit, todo text, or summary wording unless the inputs changed or you are intentionally retrying after a new error.",
        "9. Prefer the smallest fresh next action. One successful step is better than repeating the same plan.",
        "",
        "## TODO RULES",
        "- Create 3-5 actionable todos upfront. Update statuses EVERY turn.",
        "- Statuses: 'pending' | 'in-progress' | 'done' | 'blocked'",
        "- ONE 'in-progress' at a time. Complete it, mark 'done', then start next.",
        "- Do NOT try to complete all todos in one turn. Focus on ONE at a time.",
        "",
        "## JSON FORMAT (STRICT)",
        '{"response":"<brief explanation>","todos":[{"id":"todo_1","title":"...","status":"pending"}],"toolCalls":[{"tool":"<name>","args":{...}}],"edits":[],"shortcuts":[]}',
        "- 'response': brief explanation of what you're doing this turn.",
        "- 'toolCalls': actions for THIS turn only. You'll get results and can continue.",
        "- 'edits': use ONLY for batch file modifications. Prefer create_file tool for new files.",
        "- If toolCalls present: you get another turn with results.",
        "- If no toolCalls and all todos done: write final summary in response.",
        "",
        "## TOOL EXAMPLES",
        'Create a file: {"tool":"create_file","args":{"filePath":"src/index.ts","content":"..."}}',
        'Run command: {"tool":"run_terminal","args":{"command":"npm install"}}',
        'Read files: {"tool":"read_files","args":{"paths":["package.json"]}}',
        'List directory: {"tool":"list_dir","args":{"path":"."}}',
        "",
        "## ALL TOOLS",
        "workspace_scan, read_files {paths:[]}, create_file {filePath,content}, delete_file {filePath}",
        "search_files {query}, list_dir {path}, run_terminal {command}, run_verification",
        "web_search {query}, git_diff {filePath?}, diagnostics, get_terminal_output",
        "batch_edit {edits:[{filePath,search,replace}]}, rename_file {oldPath,newPath}",
        "find_references {symbol}, file_search {pattern}, get_problems {filePath?}",
        "",
        "## CONTEXT",
        `Objective: ${objective}`,
        plan.todos.length > 0
          ? `Plan todos: ${JSON.stringify(plan.todos)}`
          : "",
        episodes.length > 0 ? `Memory: ${JSON.stringify(episodes)}` : "",
        `Workspace:\n${contextSnippets.map((s) => `${s.path}\n${s.content}`).join("\n\n")}`,
        attachedContext.length > 0
          ? `Attached:\n${attachedContext.map((s) => `${s.path}\n${s.content}`).join("\n\n")}`
          : "",
        webResearch ? `Web research: ${JSON.stringify(webResearch)}` : "",
        toolContext ? `Tool results:\n${toolContext}` : "",
        critiqueContext ? `Feedback:\n${critiqueContext}` : "",
      ]
        .filter((value) => value.length > 0)
        .join("\n");

    let parsed: TaskModelResponse = {
      response: "",
      todos: plan.todos,
      toolCalls: [],
      edits: [],
      shortcuts: optionalShortcuts,
    };
    const toolTrace: TaskToolObservation[] = [];
    const allAccumulatedEdits: ProposedEdit[] = [];
    const toolCreatedFiles: Array<{
      path: string;
      additions: number;
      deletions: number;
    }> = [];
    let toolContext = "";
    let critiqueContext = "";
    let requestedVerification = false;
    let finalAssessment: TaskQualityAssessment | null = null;

    // Build a compact follow-up prompt for iterations > 0.
    // This avoids resending full workspace/conversation context, saving tokens.
    const buildCompactPrompt = (
      toolCtx: string,
      critiqueCtx: string,
      currentTodos: TaskTodo[],
    ): string =>
      [
        "You are an autonomous coding agent inside VS Code. Return valid JSON only.",
        `Objective: ${objective}`,
        "",
        "## CURRENT TODO STATUS",
        currentTodos.length > 0
          ? currentTodos
              .map(
                (t) =>
                  `- [${t.status === "done" ? "x" : t.status === "in-progress" ? ">" : " "}] ${t.title}`,
              )
              .join("\n")
          : "No todos yet.",
        "",
        "## INSTRUCTIONS",
        "- Work on the NEXT pending todo. Mark it in-progress, complete it, mark it done.",
        "- Use create_file tool for new files. Use batch_edit for modifying existing files.",
        "- Do not repeat exact tool calls, edits, or todo text already shown in tool results.",
        "- If a prior tool call succeeded, move forward instead of replaying it.",
        "- After completing a todo, update its status to done and proceed to the next.",
        "- When ALL todos are done, write a final summary in response with NO toolCalls.",
        "",
        "## JSON FORMAT",
        '{"response":"...","todos":[...],"toolCalls":[...],"edits":[],"shortcuts":[]}',
        "",
        toolCtx ? `## TOOL RESULTS\n${toolCtx}` : "",
        critiqueCtx ? `## FEEDBACK\n${critiqueCtx}` : "",
      ]
        .filter((v) => v.length > 0)
        .join("\n");

    // Agent loop: iterates until all todos are done, quality meets target,
    // or max iterations reached. Each iteration can produce tool calls,
    // file edits, or both. Edits are applied immediately so the agent
    // can continue working on remaining todos without stopping.
    const MAX_AGENT_ITERATIONS = 10;
    const ITERATION_TIMEOUT_MS = 90_000;
    for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration += 1) {
      this.emitProgress(
        iteration === 0 ? "Generating response" : "Continuing",
        `${editorModel} (step ${iteration + 1})`,
        "\u25B8",
      );
      checkAborted();

      // Per-iteration timeout to prevent stalling
      const iterationAbort = new AbortController();
      const timeoutId = setTimeout(
        () => iterationAbort.abort(),
        ITERATION_TIMEOUT_MS,
      );
      // Forward parent abort to iteration controller
      const onParentAbort = () => iterationAbort.abort();
      signal?.addEventListener("abort", onParentAbort, { once: true });

      // Use full prompt on first iteration, compact prompt for follow-ups
      // to reduce token usage significantly on subsequent iterations.
      const isFollowUp = iteration > 0;
      const promptText = isFollowUp
        ? buildCompactPrompt(toolContext, critiqueContext, parsed.todos)
        : buildPrompt(toolContext, critiqueContext);

      let response;
      try {
        response = await this.provider.chat({
          model: editorModel,
          format: "json",
          signal: iterationAbort.signal,
          onChunk: (chunk) => {
            this.emitReasoningChunk(chunk);
          },
          messages: isFollowUp
            ? [
                {
                  role: "system",
                  content:
                    "You are a coding agent. Return ONLY valid JSON: {response, todos, toolCalls, edits, shortcuts}. No markdown. Start with { end with }.",
                },
                this.buildUserMessage(promptText),
              ]
            : [
                {
                  role: "system",
                  content:
                    "You are a coding agent. You MUST return ONLY valid JSON with these fields: response, todos, toolCalls, edits, shortcuts. No markdown fences. No text outside the JSON object. Start your response with { and end with }.",
                },
                ...conversationHistory,
                this.buildUserMessage(
                  promptText,
                  iteration === 0 ? images : undefined,
                ),
              ],
          maxTokens: isFollowUp ? 2048 : 3072,
        });
      } catch (err: unknown) {
        if (iterationAbort.signal.aborted && !signal?.aborted) {
          // Iteration-level timeout — log and break out with whatever we have
          this.emitProgress(
            "Timeout",
            `Iteration ${iteration + 1} timed out`,
            "⚠️",
          );
          break;
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onParentAbort);
      }
      this.consumeTokens(response.tokenUsage);

      // Auto-reset context if budget exhausted mid-loop
      const midBudget = Math.max(this.currentConfig.maxContextTokens, 1);
      if (this.tokensConsumed / midBudget >= 0.95) {
        this.emitProgress(
          "Context reset",
          "Token budget near limit, resetting for next iteration",
          "\u21BB",
        );
        this.resetTokenUsage();
      }

      parsed = parseTaskResponse(response.text);
      if (parsed.todos.length === 0) {
        parsed.todos = plan.todos;
      }
      if (parsed.shortcuts.length === 0) {
        parsed.shortcuts = optionalShortcuts;
      }

      // Emit progressive todo updates so the UI shows them evolving
      if (parsed.todos.length > 0) {
        this.emitTodoUpdate(parsed.todos);
      }

      requestedVerification ||= parsed.toolCalls.some(
        (call) => call.tool === "run_verification",
      );

      const observations =
        parsed.toolCalls.length > 0
          ? await this.executeTaskToolCalls(parsed.toolCalls, objective, signal)
          : [];

      // Track files created/modified via tool calls (create_file, batch_edit)
      for (const obs of observations) {
        if (
          obs.ok &&
          (obs.tool === "create_file" || obs.tool === "batch_edit")
        ) {
          const createdPath = obs.detail ?? obs.summary;
          const pathMatch = createdPath.match(
            /(?:Created|Edited|Modified)\s+(?:file:\s*)?(.+)/i,
          );
          if (pathMatch) {
            toolCreatedFiles.push({
              path: pathMatch[1].trim(),
              additions: 1,
              deletions: 0,
            });
          }
        }
      }

      // Apply edits[] immediately during the loop so the agent can
      // continue working on remaining todos without stopping.
      if (parsed.edits.length > 0) {
        const editResults = await this.applyIterationEdits(
          parsed.edits,
          objective,
        );
        observations.push(...editResults);
        allAccumulatedEdits.push(...parsed.edits);
        parsed.edits = []; // Clear so they aren't re-processed after loop
      }

      // Auto-advance todo statuses based on completed work
      this.advanceTodoStatuses(parsed.todos, observations);

      // Error recovery: if tool calls failed, inject failure context so LLM
      // can diagnose and try alternatives on the next iteration
      const failedObs = observations.filter((o) => !o.ok);
      if (
        failedObs.length > 0 &&
        observations.length > 0 &&
        parsed.toolCalls.length > 0
      ) {
        const failSummary = failedObs
          .map((o) => `[FAILED] ${o.tool}: ${o.summary}`)
          .join("\n");
        critiqueContext =
          (critiqueContext ? critiqueContext + "\n\n" : "") +
          "## TOOL FAILURES — INVESTIGATE AND RETRY\n" +
          "The following tool calls failed. Do NOT give up. Analyze the error, find the root cause, and try an alternative approach:\n" +
          failSummary;
      }

      if (observations.length > 0) {
        toolTrace.push(...observations);
        toolContext = formatToolObservations(toolTrace.slice(-5));
        this.emitProgress(
          "Tool results",
          `${observations.length} observation(s) collected`,
          "\u25CB",
        );
      }

      finalAssessment = assessTaskQuality(parsed, {
        objective,
        toolTrace: observations,
        editCount: parsed.edits.length,
        verificationRan: observations.some(
          (observation) =>
            observation.tool === "run_verification" && observation.ok,
        ),
        isEditTask: this.isLikelyEditTaskObjective(objective),
      });

      // Check if all todos are completed
      const pendingTodos = parsed.todos.filter(
        (t) => t.status === "pending" || t.status === "in-progress",
      );
      const allTodosDone = parsed.todos.length > 0 && pendingTodos.length === 0;

      // If work was done this iteration (tool calls or edits), continue
      // so the LLM can observe results and proceed to next todo.
      if (observations.length > 0) {
        if (failedObs.length === 0) {
          critiqueContext = "";
        }
        // Low-end models can mark everything done too early; require at
        // least a couple of iterations before accepting completion.
        if (allTodosDone && iteration >= 2) {
          break;
        }
        continue;
      }

      // No tool calls AND no edits this iteration — LLM is done acting.
      // Break if all todos complete, quality sufficient, or enough iterations.
      if (allTodosDone || finalAssessment.meetsTarget || iteration >= 2) {
        break;
      }

      // Still have pending todos but LLM didn't produce actions — nudge it
      if (pendingTodos.length > 0) {
        critiqueContext =
          "You have pending todos that are NOT complete. " +
          "Pick the next pending todo, mark it in-progress, and use tool calls to complete it. " +
          "Do NOT stop until all todos are done.\n" +
          `Pending: ${pendingTodos.map((t) => t.title).join(", ")}`;
        continue;
      }

      critiqueContext = buildTaskRefinementPrompt(
        objective,
        parsed,
        finalAssessment,
        observations,
      );
      const recoveryNextSteps = this.summarizeIssueNextSteps(observations);
      if (recoveryNextSteps) {
        critiqueContext += "\n\n## RECOVERY GUIDANCE\n" + recoveryNextSteps;
      }
    }

    // Combine any remaining parsed.edits with edits accumulated during the loop
    const combinedEdits = [...allAccumulatedEdits, ...parsed.edits];
    const normalizedEdits = combinedEdits
      .map((edit) =>
        normalizeEditPath(edit, vscode.workspace.workspaceFolders ?? []),
      )
      .filter((edit): edit is ProposedEdit => edit !== null);

    // Deduplicate by filePath (keep last version of each file)
    const editsByPath = new Map<string, ProposedEdit>();
    for (const edit of normalizedEdits) {
      editsByPath.set(edit.filePath, edit);
    }
    const dedupedEdits = Array.from(editsByPath.values());

    // ── Compute file diffs ────────────────────
    // For edits applied during the loop, files are already on disk.
    // Read current content for diff display.
    const fileDiffs: FileDiffResult[] = [];
    for (const edit of dedupedEdits) {
      const basename = path.basename(edit.filePath);
      const lineCount = (edit.content ?? "").split("\n").length;
      this.emitFilePatch(basename, lineCount);

      // Read current file content (may have been written during loop)
      let currentContent: string | null = null;
      try {
        const uri = vscode.Uri.file(edit.filePath);
        const raw = await vscode.workspace.fs.readFile(uri);
        currentContent = Buffer.from(raw).toString("utf8");
      } catch {
        // File doesn't exist — may have been deleted or never created
      }
      const newContent =
        (edit.operation ?? "write") === "delete"
          ? null
          : (edit.content ?? currentContent ?? "");
      // For files written during loop, old content is empty (new file)
      const oldContent = allAccumulatedEdits.some(
        (e) => e.filePath === edit.filePath,
      )
        ? null
        : currentContent;
      fileDiffs.push(computeFileDiff(edit.filePath, oldContent, newContent));
    }

    // Also include files created via tool calls (create_file) in the
    // files-changed list for UI consistency
    const allFileChanges = [
      ...fileDiffs.map((d) => ({
        path: d.filePath ?? d.fileName ?? "",
        additions: d.additions ?? 0,
        deletions: d.deletions ?? 0,
      })),
      ...toolCreatedFiles.filter(
        (f) => !fileDiffs.some((d) => (d.filePath ?? d.fileName) === f.path),
      ),
    ];

    if (allFileChanges.length > 0) {
      this.emitFilesChanged(allFileChanges);
    }

    // Only create proposals for edits NOT yet applied during the loop
    const unappliedEdits = parsed.edits
      .map((edit) =>
        normalizeEditPath(edit, vscode.workspace.workspaceFolders ?? []),
      )
      .filter((edit): edit is ProposedEdit => edit !== null);

    const proposal =
      unappliedEdits.length > 0
        ? await this.editManager.setPendingProposal(objective, unappliedEdits)
        : null;

    if (proposal) {
      for (const edit of unappliedEdits) {
        const basename = path.basename(edit.filePath);
        const linesAdded = (edit.content ?? "").split("\n").length;
        this.emitFilePatched(basename, linesAdded);
      }
    }

    // Edits applied during the loop are already on disk
    let autoApplied = allAccumulatedEdits.length > 0;
    if (proposal && this.shouldAutoApplyProposal(unappliedEdits)) {
      this.emitProgress(
        "Auto-applying edits",
        "Safe workspace edits",
        "\u2713",
      );
      await this.applyPendingEdits(true);
      autoApplied = true;
    }

    if (
      this.currentConfig.autoRunVerification &&
      (normalizedEdits.length > 0 ||
        /\b(fix|bug|error|test|build|compile|lint|diagnos|fail)\b/i.test(
          objective,
        )) &&
      !requestedVerification
    ) {
      const verificationObservations = await this.runVerificationWorkflow(
        objective,
        signal,
      );
      if (verificationObservations.length > 0) {
        toolTrace.push(...verificationObservations);
      }
    }

    return {
      plan: {
        ...plan,
        todos: parsed.todos.length > 0 ? parsed.todos : plan.todos,
      },
      responseText: await this.buildTaskCompletionSummary({
        objective,
        rawResponseText: parsed.response || "Task completed.",
        todos: parsed.todos.length > 0 ? parsed.todos : plan.todos,
        toolTrace,
        proposal,
        autoApplied,
        fileDiffs: fileDiffs.length > 0 ? fileDiffs : undefined,
        qualityScore: finalAssessment?.score,
        qualityTarget: finalAssessment?.target,
        meetsQualityTarget: finalAssessment?.meetsTarget,
      }),
      todos: parsed.todos.length > 0 ? parsed.todos : plan.todos,
      shortcuts:
        parsed.shortcuts.length > 0 ? parsed.shortcuts : optionalShortcuts,
      proposal: autoApplied ? null : proposal,
      autoApplied,
      fileDiffs: fileDiffs.length > 0 ? fileDiffs : undefined,
      toolTrace,
      qualityScore: finalAssessment?.score,
      qualityTarget: finalAssessment?.target,
      meetsQualityTarget: finalAssessment?.meetsTarget,
    };
  }

  private async executeTaskToolCalls(
    toolCalls: TaskToolCall[],
    objective: string,
    signal?: AbortSignal,
  ): Promise<TaskToolObservation[]> {
    const limitedCalls = toolCalls.slice(0, 5);
    const settled = await Promise.allSettled(
      limitedCalls.map((call) =>
        this.executeSingleToolCall(call, objective, signal),
      ),
    );

    const observations: TaskToolObservation[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        observations.push(...result.value);
        return;
      }

      observations.push({
        tool: limitedCalls[index].tool,
        ok: false,
        summary: `Tool execution failed: ${stringifyError(result.reason)}`,
        detail: limitedCalls[index].reason,
      });
    });

    return observations;
  }

  private async buildTaskCompletionSummary(params: {
    objective: string;
    rawResponseText: string;
    todos: TaskTodo[];
    toolTrace: TaskToolObservation[];
    proposal: EditProposal | null;
    autoApplied: boolean;
    fileDiffs?: FileDiffResult[];
    qualityScore?: number;
    qualityTarget?: number;
    meetsQualityTarget?: boolean;
  }): Promise<string> {
    const raw = params.rawResponseText.trim();
    const generic = this.isGenericTaskResponse(raw);
    const hasEvidence =
      params.toolTrace.length > 0 ||
      (params.proposal?.edits.length ?? 0) > 0 ||
      (params.fileDiffs?.length ?? 0) > 0;

    if (!hasEvidence) {
      return raw;
    }

    const fallback = this.buildTaskCompletionFallbackSummary(
      params,
      raw,
      generic,
    );

    try {
      const summaryModel = await this.resolveModelOrFallback(
        this.currentConfig.fastModel,
      );
      const context = this.buildTaskSummaryContext(params, raw);
      const response = await this.provider.chat({
        model: summaryModel,
        temperature: 0.2,
        maxTokens: 260,
        messages: [
          {
            role: "system",
            content:
              "You write concise closing summaries for a VS Code coding agent. Summarize what happened in 2-4 sentences, focusing on outcomes and key actions. Do NOT list TODOs, file changes, or verification details — those are shown separately. Use plain markdown, no JSON, no code fences. Be specific to the task. If there was a failure, state what failed and suggest recovery options.",
          },
          {
            role: "user",
            content: context,
          },
        ],
      });
      this.consumeTokens(response.tokenUsage);

      const generated = this.cleanGeneratedSummary(response.text);
      if (generated) {
        return this.normalizeTaskSummaryPresentation(generated);
      }
    } catch (err) {
      this.logger.warn(
        `Task summary generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return this.normalizeTaskSummaryPresentation(fallback);
  }

  private buildTaskCompletionFallbackSummary(
    params: {
      objective: string;
      rawResponseText: string;
      todos: TaskTodo[];
      toolTrace: TaskToolObservation[];
      proposal: EditProposal | null;
      autoApplied: boolean;
      fileDiffs?: FileDiffResult[];
      qualityScore?: number;
      qualityTarget?: number;
      meetsQualityTarget?: boolean;
    },
    raw: string,
    generic: boolean,
  ): string {
    // Keep the response text clean — TODOs, file changes, verification
    // are shown in dedicated UI drawers, not dumped into the chat bubble.
    const sections: string[] = [];
    const hasIncompleteTodos = params.todos.some(
      (todo) => todo.status !== "done",
    );
    const intro = hasIncompleteTodos
      ? "Task not completed."
      : generic
        ? "Task completed."
        : raw;
    sections.push(intro);

    const incompleteEditTask = this.summarizeIncompleteEditTask(params);
    if (incompleteEditTask) {
      sections.push("## Issue");
      sections.push(incompleteEditTask.issue);
      if (incompleteEditTask.nextSteps.length > 0) {
        sections.push("## Next steps");
        sections.push(
          ...incompleteEditTask.nextSteps.map((step) => `- ${step}`),
        );
      }
    }

    const issueSummary = this.summarizeIssueCompact(params.toolTrace);
    if (issueSummary) {
      sections.push("## Issue");
      sections.push(issueSummary);
      const nextSteps = this.summarizeIssueNextSteps(params.toolTrace);
      if (nextSteps) {
        sections.push("## Next steps");
        sections.push(nextSteps);
      }
    }

    // TODOs, file changes, and verification are rendered in dedicated
    // UI drawers — do NOT append them to the chat bubble text.

    return sections.join("\n");
  }

  private buildTaskSummaryContext(
    params: {
      objective: string;
      rawResponseText: string;
      todos: TaskTodo[];
      toolTrace: TaskToolObservation[];
      proposal: EditProposal | null;
      autoApplied: boolean;
      fileDiffs?: FileDiffResult[];
      qualityScore?: number;
      qualityTarget?: number;
      meetsQualityTarget?: boolean;
    },
    raw: string,
  ): string {
    const sections: string[] = [
      `Objective: ${params.objective}`,
      `Agent response: ${raw}`,
    ];

    const incompleteEditTask = this.summarizeIncompleteEditTask(params);
    if (incompleteEditTask) {
      sections.push(`Issue: ${incompleteEditTask.issue}`);
      sections.push(`Next steps: ${incompleteEditTask.nextSteps.join("; ")}`);
    }

    const issueSummary = this.summarizeIssueCompact(params.toolTrace);
    if (issueSummary) {
      sections.push(`## Issue\n${issueSummary}`);
      const nextSteps = this.summarizeIssueNextSteps(params.toolTrace);
      if (nextSteps) {
        sections.push(`## Next steps\n${nextSteps}`);
      }
    }

    const todoSummary = this.summarizeTodosCompact(params.todos);
    if (todoSummary) {
      sections.push(`## TODOs\n${todoSummary}`);
    }

    const toolSummary = this.summarizeEvidenceCompact(params.toolTrace);
    if (toolSummary) {
      sections.push(`## What I found\n${toolSummary}`);
    }

    const changeSummary = this.summarizeChangesCompact(
      params.proposal,
      params.fileDiffs,
      params.autoApplied,
    );
    if (changeSummary) {
      sections.push(`## What changed\n${changeSummary}`);
    }

    const verificationSummary = this.summarizeVerificationCompact(
      params.toolTrace,
      params.qualityScore,
      params.qualityTarget,
      params.meetsQualityTarget,
    );
    if (verificationSummary) {
      sections.push(`## Verification\n${verificationSummary}`);
    }

    sections.push(
      "Write a concise closing summary in 2-4 sentences.",
      "Focus on: what was done (or what failed), key outcomes, and any next steps.",
      "Do NOT list TODOs, file changes, or verification results — those are shown separately in the UI.",
      "If there was a failure or quality gap, explain what went wrong and suggest 1-2 recovery options.",
      "Return plain markdown only. Be specific to this task, avoid generic boilerplate.",
    );

    return sections.filter((value) => value.length > 0).join("\n\n");
  }

  private cleanGeneratedSummary(text: string): string {
    let trimmed = text.trim();
    if (!trimmed) {
      return "";
    }

    // Strip JSON wrappers the model may have emitted
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          if (
            typeof parsed.response === "string" &&
            parsed.response.length > 0
          ) {
            trimmed = parsed.response;
          } else if (typeof parsed.summary === "string") {
            trimmed = parsed.summary;
          } else if (typeof parsed.text === "string") {
            trimmed = parsed.text;
          }
        }
      } catch {
        // Not valid JSON, continue
      }
    }

    const stripped = trimmed
      .replace(/^```(?:markdown|md)?\s*/i, "")
      .replace(/\s*```$/i, "")
      // Remove any "TODOs:" / "Files changed:" / "Verification:" sections
      .replace(
        /\n##?\s*(TODOs?|Tasks?|Files?\s+changed|Verification|What I found|What changed|Changes made)[\s\S]*?(?=\n##|$)/gi,
        "",
      )
      .trim();

    if (this.isGenericTaskResponse(stripped)) {
      return "";
    }

    return this.normalizeTaskSummaryPresentation(stripped);
  }

  private normalizeTaskSummaryPresentation(text: string): string {
    const lines = text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line, index, items) => line.length > 0 || items[index - 1] !== "",
      );

    const normalized: string[] = [];
    for (const line of lines) {
      if (!line) {
        if (normalized[normalized.length - 1] !== "") {
          normalized.push("");
        }
        continue;
      }

      const headingMatch = line.match(/^#{1,3}\s*(.+)$/);
      if (headingMatch) {
        normalized.push(`${headingMatch[1].trim()}:`);
        continue;
      }

      const bulletMatch = line.match(/^[*-]\s+(.+)$/);
      if (bulletMatch) {
        normalized.push(`• ${bulletMatch[1].trim()}`);
        continue;
      }

      const numberedMatch = line.match(/^\d+\.\s+(.+)$/);
      if (numberedMatch) {
        normalized.push(`• ${numberedMatch[1].trim()}`);
        continue;
      }

      normalized.push(line);
    }

    return normalized
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private summarizeTodosCompact(todos: TaskTodo[]): string {
    if (todos.length === 0) {
      return "";
    }

    return todos
      .slice(0, 5)
      .map((todo) => {
        const title = todo.title.trim();
        if (title.length === 0) {
          return "";
        }
        const detail = this.firstUsefulLine(todo.detail);
        return detail ? `${title} (${detail})` : title;
      })
      .filter((entry) => entry.length > 0)
      .join("; ");
  }

  private summarizeIncompleteEditTask(params: {
    objective: string;
    proposal: EditProposal | null;
    fileDiffs?: FileDiffResult[];
    qualityScore?: number;
    qualityTarget?: number;
    meetsQualityTarget?: boolean;
  }): { issue: string; nextSteps: string[] } | null {
    if (!this.isEditIntent(params.objective)) {
      return null;
    }

    const hasEdits =
      (params.proposal?.edits.length ?? 0) > 0 ||
      (params.fileDiffs?.length ?? 0) > 0;
    if (hasEdits) {
      return null;
    }

    const qualityMissed =
      typeof params.qualityScore === "number" &&
      typeof params.qualityTarget === "number" &&
      params.qualityScore < params.qualityTarget;

    const issue = qualityMissed
      ? `The requested change was not applied and the quality target was missed (${params.qualityScore?.toFixed(2)} / ${params.qualityTarget?.toFixed(2)}).`
      : "The requested change was not applied.";

    const nextSteps = qualityMissed
      ? [
          "narrow the task to the exact file or refactor scope",
          "ask for one focused code change at a time",
          "rerun the task after confirming the expected outcome",
        ]
      : [
          "narrow the task to the exact file or refactor scope",
          "ask the agent to produce a pending proposal before applying changes",
          "rerun after confirming the intended behavior or acceptance criteria",
        ];

    return {
      issue,
      nextSteps,
    };
  }

  private isEditIntent(objective: string): boolean {
    return /\b(fix|bug|error|crash|test|build|compile|refactor|implement|add|update|remove|replace|rewrite|clean\s*up|cleanup|modify|change)\b/i.test(
      objective,
    );
  }

  private summarizeIssueCompact(observations: TaskToolObservation[]): string {
    const failedObservations = observations.filter(
      (observation) => !observation.ok,
    );
    if (failedObservations.length === 0) {
      return "";
    }

    const primaryObservation =
      failedObservations.find(
        (observation) => observation.tool === "run_terminal",
      ) ?? failedObservations[0];
    const rawIssue =
      this.firstUsefulLine(primaryObservation.detail) ??
      primaryObservation.summary;
    const issueText = rawIssue.replace(/^Error:\s*/i, "").trim();
    return issueText;
  }

  private summarizeIssueNextSteps(observations: TaskToolObservation[]): string {
    const failedObservations = observations.filter(
      (observation) => !observation.ok,
    );
    if (failedObservations.length === 0) {
      return "";
    }

    const primaryObservation =
      failedObservations.find(
        (observation) => observation.tool === "run_terminal",
      ) ?? failedObservations[0];
    const rawIssue =
      this.firstUsefulLine(primaryObservation.detail) ??
      primaryObservation.summary;
    const issueText = rawIssue.replace(/^Error:\s*/i, "").trim();
    const nextSteps = this.suggestNextStepsForIssue(
      issueText,
      primaryObservation.tool,
    );

    if (nextSteps.length === 0) {
      return "";
    }

    return nextSteps.map((step) => `- ${step}`).join("\n");
  }

  private isGenericTaskResponse(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return (
      normalized.length === 0 ||
      normalized === "task completed." ||
      normalized === "task completed" ||
      normalized === "completed." ||
      normalized === "done." ||
      normalized === "done"
    );
  }

  private summarizeEvidenceCompact(
    observations: TaskToolObservation[],
  ): string {
    const importantTools = new Set([
      "workspace_scan",
      "read_files",
      "search_files",
      "list_dir",
      "diagnostics",
      "get_problems",
      "find_references",
      "file_search",
      "web_search",
      "mcp_status",
      "get_terminal_output",
    ]);

    const lines = observations
      .filter(
        (observation) => observation.ok && importantTools.has(observation.tool),
      )
      .slice(-5)
      .map((observation) => {
        const detail = this.firstUsefulLine(observation.detail);
        if (detail && detail !== observation.summary) {
          return `${observation.summary} ${detail}`;
        }
        return observation.summary;
      });

    return lines.filter((line) => line.length > 0).join("; ");
  }

  private summarizeChangesCompact(
    proposal: EditProposal | null,
    fileDiffs?: FileDiffResult[],
    autoApplied = false,
  ): string {
    const items: string[] = [];
    const diffs = fileDiffs ?? [];

    if (diffs.length > 0) {
      for (const diff of diffs.slice(0, 5)) {
        const status = diff.isNew
          ? "new"
          : diff.isDelete
            ? "deleted"
            : "updated";
        items.push(
          `${diff.fileName} (${status}, +${diff.additions}/-${diff.deletions})`,
        );
      }
    } else if (proposal?.edits.length) {
      for (const edit of proposal.edits.slice(0, 5)) {
        const op = edit.operation ?? "write";
        const target = edit.targetPath ? ` -> ${edit.targetPath}` : "";
        const reason = edit.reason ? ` — ${edit.reason}` : "";
        items.push(
          `${op}: ${this.normalizeDisplayPath(edit.filePath)}${target}${reason}`,
        );
      }
    }

    if (items.length === 0 && autoApplied) {
      return "Changes were auto-applied successfully.";
    }

    if (items.length === 0) {
      return "No file changes were required.";
    }

    return items.join("; ");
  }

  private summarizeVerificationCompact(
    observations: TaskToolObservation[],
    qualityScore?: number,
    qualityTarget?: number,
    meetsQualityTarget?: boolean,
  ): string {
    const verification = observations.filter(
      (observation) => observation.tool === "run_verification",
    );

    const lines: string[] = [];
    for (const item of verification.slice(-3)) {
      const detail = this.firstUsefulLine(item.detail);
      lines.push(
        detail && detail !== item.summary
          ? `${item.summary} ${detail}`
          : item.summary,
      );
    }

    if (typeof qualityScore === "number") {
      const target = qualityTarget ?? TARGET_TASK_QUALITY_SCORE;
      lines.push(
        `Quality score ${qualityScore.toFixed(2)} / ${target.toFixed(2)} (${meetsQualityTarget ? "target met" : "below target"})`,
      );
    }

    return lines.filter((line) => line.length > 0).join("; ");
  }

  private suggestNextStepsForIssue(
    issueText: string,
    tool: TaskToolName,
  ): string[] {
    const normalized = issueText.toLowerCase();
    const suggestions: string[] = [];

    if (
      normalized.includes("could conflict") ||
      normalized.includes("already contains") ||
      normalized.includes("conflict") ||
      normalized.includes("directory")
    ) {
      suggestions.push("retry in an empty directory or a fresh subfolder");
      suggestions.push("move or rename the conflicting files first");
      suggestions.push("rerun the command after the workspace is clean");
    } else if (
      normalized.includes("could not determine executable") ||
      normalized.includes("couldn't determine executable") ||
      normalized.includes("executable")
    ) {
      suggestions.push("run the package binary through pnpm exec or npx");
      suggestions.push("verify the dependency is installed locally first");
      suggestions.push("check the command name and package version");
    } else if (
      normalized.includes("pnpm init -y") ||
      normalized.includes("unknown option 'y'") ||
      (normalized.includes("unknown option") && normalized.includes("init"))
    ) {
      suggestions.push(
        "use pnpm init without -y, or npm init -y if npm is the target",
      );
      suggestions.push(
        "for Next.js scaffolds, use create-next-app instead of init",
      );
      suggestions.push("verify the scaffold command before retrying");
    } else if (
      normalized.includes("next-app") ||
      normalized.includes("next.js") ||
      normalized.includes("nextjs") ||
      normalized.includes("scaffold") ||
      normalized.includes("create a blog")
    ) {
      suggestions.push("use create-next-app to scaffold the project first");
      suggestions.push(
        "create dummy data only after the app scaffold succeeds",
      );
      suggestions.push(
        "confirm the project root and package manager before retrying",
      );
    } else if (
      normalized.includes("enoent") ||
      normalized.includes("not found") ||
      normalized.includes("is not recognized")
    ) {
      suggestions.push("confirm the command exists in the current shell");
      suggestions.push("install the missing dependency or tool");
      suggestions.push("rerun from the project root with the correct path");
    } else if (tool === "run_terminal") {
      suggestions.push(
        "inspect the terminal output again for the failing line",
      );
      suggestions.push("adjust the command or working directory and retry");
      suggestions.push("run verification again after the fix");
    }

    return Array.from(new Set(suggestions)).slice(0, 3);
  }

  private firstUsefulLine(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const line = value
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);

    if (!line) {
      return undefined;
    }

    return line.length > 180 ? `${line.slice(0, 177)}...` : line;
  }

  private async executeSingleToolCall(
    call: TaskToolCall,
    objective: string,
    signal?: AbortSignal,
  ): Promise<TaskToolObservation[]> {
    // Check if this tool has been disabled by the user in the tool config panel
    if (!this.isToolEnabled(call.tool)) {
      return [
        {
          tool: call.tool,
          ok: false,
          summary: `Tool "${call.tool}" is disabled in tool settings.`,
          detail: "The user has disabled this tool. Use a different approach.",
        },
      ];
    }

    const workspaceRoot = this.workspaceRoot?.fsPath ?? null;
    const checkAborted = () => {
      if (signal?.aborted) {
        throw new Error("__TASK_CANCELLED__");
      }
    };

    checkAborted();

    if (call.tool === "workspace_scan") {
      const inventory = await this.buildWorkspaceInventory(250);
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Found ${inventory.totalFiles} file(s) in the workspace.`,
          detail: inventory.listedFiles.slice(0, 20).join("\n"),
        },
      ];
    }

    if (call.tool === "read_files") {
      const requestedPaths = this.extractStringList(
        call.args.paths,
        call.args.files,
        call.args.filePaths,
        call.args.path,
      );
      const resolvedPaths = requestedPaths
        .map((item) => this.resolveWorkspacePath(item))
        .filter((item): item is string => Boolean(item));
      const snippets = await this.scanner.readContextSnippets(
        resolvedPaths.slice(0, 8),
        6000,
      );
      return [
        {
          tool: call.tool,
          ok: snippets.length > 0,
          summary:
            snippets.length > 0
              ? `Read ${snippets.length} file(s).`
              : "No readable files were returned.",
          detail: snippets
            .map(
              (snippet) =>
                `File: ${this.normalizeDisplayPath(snippet.path)}\n${snippet.content}`,
            )
            .join("\n\n")
            .slice(0, 8000),
        },
      ];
    }

    if (call.tool === "create_file") {
      const filePath = this.firstString(call.args.filePath, call.args.path);
      const content = this.firstString(call.args.content) ?? "";
      if (!filePath) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: "No file path was provided for create_file.",
          },
        ];
      }
      const resolved = this.resolveWorkspacePath(filePath);
      if (!resolved) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: `Path "${filePath}" is outside the workspace.`,
          },
        ];
      }
      try {
        const uri = vscode.Uri.file(resolved);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
        return [
          {
            tool: call.tool,
            ok: true,
            summary: `Created file: ${this.normalizeDisplayPath(resolved)}`,
          },
        ];
      } catch (err) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: `Failed to create file: ${stringifyError(err)}`,
          },
        ];
      }
    }

    if (call.tool === "delete_file") {
      const filePath = this.firstString(call.args.filePath, call.args.path);
      if (!filePath) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: "No file path was provided for delete_file.",
          },
        ];
      }
      const resolved = this.resolveWorkspacePath(filePath);
      if (!resolved) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: `Path "${filePath}" is outside the workspace.`,
          },
        ];
      }
      try {
        const uri = vscode.Uri.file(resolved);
        await vscode.workspace.fs.delete(uri);
        return [
          {
            tool: call.tool,
            ok: true,
            summary: `Deleted file: ${this.normalizeDisplayPath(resolved)}`,
          },
        ];
      } catch (err) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: `Failed to delete file: ${stringifyError(err)}`,
          },
        ];
      }
    }

    if (call.tool === "search_files") {
      const query =
        this.firstString(
          call.args.query,
          call.args.pattern,
          call.args.search,
        ) ?? "";
      if (!query) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: "No search query was provided.",
          },
        ];
      }
      const results = await this.scanner.searchFileContents(query, 8);
      return [
        {
          tool: call.tool,
          ok: results.length > 0,
          summary:
            results.length > 0
              ? `Found matches in ${results.length} file(s).`
              : "No matches found.",
          detail: results
            .map(
              (r) =>
                `File: ${this.normalizeDisplayPath(r.path)}\n${r.matches.join("\n---\n")}`,
            )
            .join("\n\n")
            .slice(0, 5000),
        },
      ];
    }

    if (call.tool === "list_dir") {
      const dirPath =
        this.firstString(call.args.path, call.args.directory, call.args.dir) ??
        ".";
      const resolved = this.resolveWorkspacePath(dirPath);
      if (!resolved) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: `Path "${dirPath}" is outside the workspace.`,
          },
        ];
      }
      try {
        const uri = vscode.Uri.file(resolved);
        const entries = await vscode.workspace.fs.readDirectory(uri);
        const listing = entries
          .slice(0, 50)
          .map(([name, type]) =>
            type === vscode.FileType.Directory ? `${name}/` : name,
          )
          .join("\n");
        return [
          {
            tool: call.tool,
            ok: true,
            summary: `Listed ${entries.length} entries in ${this.normalizeDisplayPath(resolved)}.`,
            detail: listing,
          },
        ];
      } catch (err) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: `Failed to list directory: ${stringifyError(err)}`,
          },
        ];
      }
    }

    if (call.tool === "run_terminal") {
      const command = this.firstString(call.args.command, call.args.cmd);
      if (!command) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: "No terminal command was provided.",
          },
        ];
      }

      if (
        !isSafeTerminalCommand(command) &&
        !this.currentConfig.allowTerminalExecution
      ) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: "Terminal execution is disabled for unsafe commands.",
            detail: command,
          },
        ];
      }

      this.emitTerminalRun(command);
      const terminalTimeout = estimateCommandTimeout(command);
      const result = await this.executeTerminalCommand(command, {
        cwd: workspaceRoot ?? undefined,
        timeoutMs: terminalTimeout,
        purpose: "tool",
      });
      // Store for get_terminal_output tool
      if (result) {
        this.lastTerminalResult = result;
      }
      // Emit terminal output for chat display
      this.terminalOutputCallback?.({
        command,
        output: result ? result.output.slice(0, 5000) : "",
        exitCode: result?.exitCode ?? null,
      });
      return [
        {
          tool: call.tool,
          ok: result !== null && result.exitCode === 0,
          summary: result
            ? `Exit ${result.exitCode ?? "unknown"} in ${result.durationMs}ms.`
            : "Terminal command was blocked.",
          detail: result ? result.output.slice(0, 5000) : command,
        },
      ];
    }

    if (call.tool === "run_verification") {
      return this.runVerificationWorkflow(objective, signal, call.args);
    }

    if (call.tool === "web_search") {
      const query = this.firstString(call.args.query) ?? objective;
      const result = await this.researchWeb(query);
      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Web search returned ${result.results.length} result(s).`,
          detail: this.webSearch.formatResult(result).slice(0, 5000),
        },
      ];
    }

    if (call.tool === "git_diff") {
      const filePath = this.firstString(call.args.filePath, call.args.path);
      if (filePath) {
        const diff = await this.gitService.getFileDiff(
          this.resolveWorkspacePath(filePath) ?? filePath,
        );
        return [
          {
            tool: call.tool,
            ok: diff !== null,
            summary: diff
              ? `Loaded diff for ${this.normalizeDisplayPath(diff.path)}.`
              : "No diff available.",
            detail: diff?.diff.slice(0, 5000),
          },
        ];
      }

      const diffSummary = await this.gitService.getDiffSummary();
      return [
        {
          tool: call.tool,
          ok: diffSummary.isGitRepo,
          summary: diffSummary.summary,
          detail: JSON.stringify(diffSummary, null, 2).slice(0, 5000),
        },
      ];
    }

    if (call.tool === "mcp_status") {
      const summary = await this.mcpSummary();
      return [
        {
          tool: call.tool,
          ok: true,
          summary: "Loaded MCP connection summary.",
          detail: summary.slice(0, 5000),
        },
      ];
    }

    if (call.tool === "diagnostics") {
      const diagnostics = this.verifier.runDiagnostics();
      return [
        {
          tool: call.tool,
          ok: !diagnostics.hasErrors,
          summary: diagnostics.summary,
          detail: JSON.stringify(diagnostics, null, 2),
        },
      ];
    }

    if (call.tool === "batch_edit") {
      const editList = Array.isArray(call.args.edits) ? call.args.edits : [];
      if (editList.length === 0) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: "No edits provided for batch_edit.",
          },
        ];
      }

      const results: string[] = [];
      let successCount = 0;
      let failCount = 0;

      for (const edit of editList.slice(0, 20)) {
        const filePath = this.firstString(edit.filePath, edit.path);
        const search = this.firstString(edit.search, edit.oldText, edit.find);
        const replace = this.firstString(
          edit.replace,
          edit.newText,
          edit.replacement,
        );

        if (!filePath || search === null || search === undefined) {
          results.push(`SKIP: Missing filePath or search text`);
          failCount++;
          continue;
        }

        const resolved = this.resolveWorkspacePath(filePath);
        if (!resolved) {
          results.push(`FAIL: ${filePath} — outside workspace`);
          failCount++;
          continue;
        }

        try {
          const uri = vscode.Uri.file(resolved);
          const raw = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(raw).toString("utf8");

          if (!content.includes(search)) {
            results.push(
              `FAIL: ${this.normalizeDisplayPath(resolved)} — search text not found`,
            );
            failCount++;
            continue;
          }

          const newContent = content.replace(search, replace ?? "");
          await vscode.workspace.fs.writeFile(
            uri,
            Buffer.from(newContent, "utf8"),
          );
          results.push(`OK: ${this.normalizeDisplayPath(resolved)}`);
          successCount++;

          this.emitFilePatched(
            path.basename(resolved),
            newContent.split("\n").length,
          );
        } catch (err) {
          results.push(
            `FAIL: ${this.normalizeDisplayPath(resolved)} — ${stringifyError(err)}`,
          );
          failCount++;
        }
      }

      return [
        {
          tool: call.tool,
          ok: successCount > 0,
          summary: `Batch edit: ${successCount} succeeded, ${failCount} failed out of ${editList.length} edit(s).`,
          detail: results.join("\n"),
        },
      ];
    }

    // ── rename_file: Rename or move a file ──────────────────────────
    if (call.tool === "rename_file") {
      const oldPath = this.firstString(
        call.args.oldPath,
        call.args.filePath,
        call.args.from,
        call.args.path,
      );
      const newPath = this.firstString(
        call.args.newPath,
        call.args.to,
        call.args.destination,
        call.args.target,
      );

      if (!oldPath || !newPath) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: "rename_file requires both oldPath and newPath.",
          },
        ];
      }

      const resolvedOld = this.resolveWorkspacePath(oldPath);
      const resolvedNew = this.resolveWorkspacePath(newPath);
      if (!resolvedOld || !resolvedNew) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: "Path resolves outside workspace.",
          },
        ];
      }

      try {
        const oldUri = vscode.Uri.file(resolvedOld);
        const newUri = vscode.Uri.file(resolvedNew);

        // Ensure parent directory exists
        const parentDir = path.dirname(resolvedNew);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(parentDir));

        await vscode.workspace.fs.rename(oldUri, newUri, {
          overwrite: false,
        });
        return [
          {
            tool: call.tool,
            ok: true,
            summary: `Renamed ${this.normalizeDisplayPath(resolvedOld)} → ${this.normalizeDisplayPath(resolvedNew)}`,
          },
        ];
      } catch (err) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: `Failed to rename: ${stringifyError(err)}`,
          },
        ];
      }
    }

    // ── find_references: Find symbol usages across workspace ────────
    if (call.tool === "find_references") {
      const symbol = this.firstString(
        call.args.symbol,
        call.args.query,
        call.args.name,
        call.args.pattern,
      );
      if (!symbol) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: "find_references requires a symbol name.",
          },
        ];
      }

      // Use workspace text search to find references
      const searchResults = await this.scanner.searchFileContents(symbol, 30);
      if (!searchResults || searchResults.length === 0) {
        return [
          {
            tool: call.tool,
            ok: true,
            summary: `No references found for "${symbol}".`,
          },
        ];
      }

      const formatted = searchResults
        .map(
          (r: { path: string; matches: string[] }) =>
            `${this.normalizeDisplayPath(r.path)}:\n${r.matches.join("\n")}`,
        )
        .join("\n\n");

      return [
        {
          tool: call.tool,
          ok: true,
          summary: `Found ${searchResults.length} file(s) with references to "${symbol}".`,
          detail: formatted.slice(0, 6000),
        },
      ];
    }

    // ── file_search: Find files by glob pattern ─────────────────────
    if (call.tool === "file_search") {
      const pattern = this.firstString(
        call.args.pattern,
        call.args.glob,
        call.args.query,
        call.args.name,
      );
      if (!pattern) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: "file_search requires a pattern (e.g. **/*.ts).",
          },
        ];
      }

      try {
        const files = await vscode.workspace.findFiles(
          pattern,
          "**/{node_modules,dist,.git,build,out,.next}/**",
          50,
        );

        if (files.length === 0) {
          return [
            {
              tool: call.tool,
              ok: true,
              summary: `No files matching "${pattern}".`,
            },
          ];
        }

        const paths = files.map((f) => this.normalizeDisplayPath(f.fsPath));
        return [
          {
            tool: call.tool,
            ok: true,
            summary: `Found ${files.length} file(s) matching "${pattern}".`,
            detail: paths.join("\n"),
          },
        ];
      } catch (err) {
        return [
          {
            tool: call.tool,
            ok: false,
            summary: `file_search failed: ${stringifyError(err)}`,
          },
        ];
      }
    }

    // ── get_problems: Retrieve VS Code problems/diagnostics ─────────
    if (call.tool === "get_problems") {
      const filePath = this.firstString(
        call.args.filePath,
        call.args.path,
        call.args.file,
      );

      const allDiagnostics: string[] = [];
      let errorCount = 0;
      let warningCount = 0;

      if (filePath) {
        // Scoped to a specific file
        const resolved = this.resolveWorkspacePath(filePath);
        if (resolved) {
          const uri = vscode.Uri.file(resolved);
          const diags = vscode.languages.getDiagnostics(uri);
          for (const d of diags.slice(0, 50)) {
            const severity =
              d.severity === vscode.DiagnosticSeverity.Error
                ? "ERROR"
                : d.severity === vscode.DiagnosticSeverity.Warning
                  ? "WARN"
                  : "INFO";
            if (d.severity === vscode.DiagnosticSeverity.Error) errorCount++;
            if (d.severity === vscode.DiagnosticSeverity.Warning)
              warningCount++;
            allDiagnostics.push(
              `[${severity}] ${this.normalizeDisplayPath(resolved)}:${d.range.start.line + 1}: ${d.message}`,
            );
          }
        }
      } else {
        // All workspace diagnostics
        const diagnosticCollection = vscode.languages.getDiagnostics();
        for (const [uri, diags] of diagnosticCollection) {
          for (const d of diags.slice(0, 20)) {
            const severity =
              d.severity === vscode.DiagnosticSeverity.Error
                ? "ERROR"
                : d.severity === vscode.DiagnosticSeverity.Warning
                  ? "WARN"
                  : "INFO";
            if (d.severity === vscode.DiagnosticSeverity.Error) errorCount++;
            if (d.severity === vscode.DiagnosticSeverity.Warning)
              warningCount++;
            allDiagnostics.push(
              `[${severity}] ${this.normalizeDisplayPath(uri.fsPath)}:${d.range.start.line + 1}: ${d.message}`,
            );
          }
        }
      }

      return [
        {
          tool: call.tool,
          ok: errorCount === 0,
          summary: `${errorCount} error(s), ${warningCount} warning(s) found.`,
          detail:
            allDiagnostics.length > 0
              ? allDiagnostics.slice(0, 100).join("\n")
              : "No problems found.",
        },
      ];
    }

    // ── get_terminal_output: Retrieve last terminal command output ───
    if (call.tool === "get_terminal_output") {
      const lastResult = this.lastTerminalResult;
      if (!lastResult) {
        return [
          {
            tool: call.tool,
            ok: true,
            summary: "No recent terminal output available.",
          },
        ];
      }

      return [
        {
          tool: call.tool,
          ok: lastResult.exitCode === 0,
          summary: `Last command: "${lastResult.command}" (exit ${lastResult.exitCode ?? "unknown"})`,
          detail: lastResult.output.slice(0, 6000),
        },
      ];
    }

    return [
      {
        tool: call.tool,
        ok: false,
        summary: "Unsupported tool call.",
      },
    ];
  }

  private async runVerificationWorkflow(
    objective: string,
    signal?: AbortSignal,
    args?: Record<string, unknown>,
  ): Promise<TaskToolObservation[]> {
    const observations: TaskToolObservation[] = [];
    const commands = await this.collectVerificationCommands(objective, args);
    if (commands.length === 0) {
      observations.push({
        tool: "run_verification",
        ok: false,
        summary: "No safe verification command could be inferred.",
      });
      return observations;
    }

    const checkAborted = () => {
      if (signal?.aborted) {
        throw new Error("__TASK_CANCELLED__");
      }
    };

    for (const command of commands.slice(0, 3)) {
      checkAborted();
      this.emitProgress("Verification", command, "\u25CB");
      const result = await this.executeTerminalCommand(command, {
        cwd: this.workspaceRoot?.fsPath,
        timeoutMs: 120_000,
        purpose: "verification",
      });

      if (!result) {
        observations.push({
          tool: "run_verification",
          ok: false,
          summary: `Blocked verification command: ${command}`,
        });
        continue;
      }

      observations.push({
        tool: "run_verification",
        ok: result.exitCode === 0,
        summary: `${command} exited with ${result.exitCode ?? "unknown"}.`,
        detail: result.output.slice(0, 5000),
      });
    }

    return observations;
  }

  private async collectVerificationCommands(
    objective: string,
    args?: Record<string, unknown>,
  ): Promise<string[]> {
    const explicit = this.extractStringList(
      args?.commands,
      args?.command,
      args?.scripts,
    ).filter((command) => isSafeTerminalCommand(command));
    if (explicit.length > 0) {
      return explicit;
    }

    const packageJsonPath = this.workspaceRoot
      ? path.join(this.workspaceRoot.fsPath, "package.json")
      : null;
    const scripts = packageJsonPath
      ? await this.readPackageScripts(packageJsonPath)
      : null;

    const candidateScripts = [
      "test",
      "lint",
      "typecheck",
      "build",
      "compile",
    ].filter((name) => Boolean(scripts?.[name]));

    if (candidateScripts.length > 0) {
      return candidateScripts.map((script) => {
        const manager = this.detectPackageManager();
        if (manager === "pnpm") {
          return `pnpm run ${script}`;
        }
        if (manager === "yarn") {
          return `yarn run ${script}`;
        }
        return `npm run ${script}`;
      });
    }

    const lowered = objective.toLowerCase();
    if (
      /\b(test|bug|fix|error|fail|diagnos|compile|build|lint)\b/.test(lowered)
    ) {
      const manager = this.detectPackageManager();
      if (manager === "pnpm") {
        return ["pnpm test", "pnpm run build"];
      }
      if (manager === "yarn") {
        return ["yarn test", "yarn build"];
      }
      return ["npm test", "npm run build"];
    }

    return [];
  }

  /**
   * Apply edits from the current loop iteration immediately to disk.
   * Returns observations so the loop treats them as completed work.
   */
  private async applyIterationEdits(
    edits: ProposedEdit[],
    objective: string,
  ): Promise<TaskToolObservation[]> {
    const observations: TaskToolObservation[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

    for (const edit of edits) {
      const normalized = normalizeEditPath(edit, workspaceFolders);
      if (!normalized) {
        observations.push({
          tool: "create_file",
          ok: false,
          summary: `Invalid edit path: ${edit.filePath}`,
        });
        continue;
      }

      const op = normalized.operation ?? "write";
      try {
        if (op === "write") {
          const uri = vscode.Uri.file(normalized.filePath);
          // Ensure parent directory exists
          const dir = path.dirname(normalized.filePath);
          try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
          } catch {
            /* directory may already exist */
          }
          await vscode.workspace.fs.writeFile(
            uri,
            Buffer.from(normalized.content ?? "", "utf8"),
          );
          const basename = path.basename(normalized.filePath);
          this.emitFilePatched(
            basename,
            (normalized.content ?? "").split("\n").length,
          );
          observations.push({
            tool: "create_file",
            ok: true,
            summary: `Created file: ${this.normalizeDisplayPath(normalized.filePath)}`,
          });
        } else if (op === "delete") {
          const uri = vscode.Uri.file(normalized.filePath);
          await vscode.workspace.fs.delete(uri, { useTrash: true });
          observations.push({
            tool: "delete_file",
            ok: true,
            summary: `Deleted file: ${this.normalizeDisplayPath(normalized.filePath)}`,
          });
        }
      } catch (err) {
        observations.push({
          tool: "create_file",
          ok: false,
          summary: `Failed to write ${edit.filePath}: ${stringifyError(err)}`,
        });
      }
    }

    return observations;
  }

  /**
   * Auto-advance todo statuses based on work completed in the current iteration.
   * If tools/edits succeeded and there's a todo in-progress, mark it done.
   * If no todo is in-progress, mark the first pending todo as in-progress.
   */
  private advanceTodoStatuses(
    todos: TaskTodo[],
    observations: TaskToolObservation[],
  ): void {
    if (todos.length === 0) return;

    const hasSuccessfulWork = observations.some((o) => o.ok);
    const inProgressTodo = todos.find((t) => t.status === "in-progress");

    if (hasSuccessfulWork && inProgressTodo) {
      // Mark in-progress todo as done since work succeeded
      inProgressTodo.status = "done";
    }

    // Ensure there's always one in-progress todo if pending ones remain
    const stillPending = todos.filter((t) => t.status === "pending");
    if (
      stillPending.length > 0 &&
      !todos.some((t) => t.status === "in-progress")
    ) {
      stillPending[0].status = "in-progress";
    }

    // Emit updated statuses
    this.emitTodoUpdate(todos);
  }

  private shouldAutoApplyProposal(edits: ProposedEdit[]): boolean {
    if (this.permissionPolicy.getMode() === "full") {
      return true;
    }

    return false;
  }

  private async readPackageScripts(
    packageJsonPath: string,
  ): Promise<Record<string, string> | null> {
    if (this.packageScriptsCache.has(packageJsonPath)) {
      return this.packageScriptsCache.get(packageJsonPath) ?? null;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(packageJsonPath),
      );
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
        scripts?: Record<string, unknown>;
      };

      if (!parsed.scripts || typeof parsed.scripts !== "object") {
        return null;
      }

      const scripts = Object.fromEntries(
        Object.entries(parsed.scripts).flatMap(([name, value]) =>
          typeof value === "string" ? [[name, value]] : [],
        ),
      );
      this.packageScriptsCache.set(packageJsonPath, scripts);
      return scripts;
    } catch {
      this.packageScriptsCache.set(packageJsonPath, null);
      return null;
    }
  }

  private detectPackageManager(): "npm" | "pnpm" | "yarn" {
    if (!this.workspaceRoot) {
      return "npm";
    }

    const fsPath = this.workspaceRoot.fsPath;
    const hasPnpm = existsSync(path.join(fsPath, "pnpm-lock.yaml"));
    if (hasPnpm) {
      return "pnpm";
    }

    const hasYarn = existsSync(path.join(fsPath, "yarn.lock"));
    if (hasYarn) {
      return "yarn";
    }

    return "npm";
  }

  private resolveWorkspacePath(value: string): string | null {
    if (!value.trim()) {
      return null;
    }

    if (path.isAbsolute(value)) {
      return value;
    }

    if (!this.workspaceRoot) {
      return null;
    }

    return path.join(this.workspaceRoot.fsPath, value);
  }

  private extractStringList(...values: unknown[]): string[] {
    const output: string[] = [];
    for (const value of values) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
          output.push(trimmed);
        }
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item.trim()) {
            output.push(item.trim());
          }
        }
      }
    }

    return output;
  }

  private firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    return undefined;
  }

  private isLikelyEditTaskObjective(objective: string): boolean {
    return /\b(fix|bug|error|crash|test|build|compile|lint|diagnos|fail|refactor|implement|add|update|remove|delete|write|create|edit)\b/i.test(
      objective,
    );
  }

  private getWebSearchResultLimit(): number {
    const configured = Number(
      vscode.workspace
        .getConfiguration("pulse")
        .get<number>("search.maxResults", 5),
    );

    return Number.isFinite(configured)
      ? Math.max(1, Math.min(10, configured))
      : 5;
  }
}

function normalizeEditPath(
  edit: ProposedEdit,
  folders: readonly vscode.WorkspaceFolder[],
): ProposedEdit | null {
  const root = folders[0]?.uri.fsPath;
  if (!root) {
    return null;
  }

  const normalizeSingle = (p: string): string =>
    path.isAbsolute(p) ? p : path.join(root, p);

  return {
    ...edit,
    filePath: normalizeSingle(edit.filePath),
    targetPath: edit.targetPath ? normalizeSingle(edit.targetPath) : undefined,
  };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
