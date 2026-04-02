import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";

import type {
  AgentConfig,
  AgentPersona,
  McpServerConfig,
  PermissionMode,
} from "../../config/AgentConfig";
import { resolveProfileDefaults } from "../../config/AgentConfig";
import type { ProfileDefaults } from "../../config/AgentConfig";
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
import { ToolRegistry } from "../tooling/ToolRegistry";
import {
  WebSearchService,
  type WebSearchResponse,
} from "../search/WebSearchService";
import { SkillRegistry, type SkillManifest } from "../skills/SkillRegistry";
import { GitService } from "../../platform/git/GitService";
import { ImprovementEngine } from "../improvement/ImprovementEngine";
import { PathResolver } from "./PathResolver";
import { ProjectDetector } from "./ProjectDetector";
import { StreamBroadcaster } from "./StreamBroadcaster";
import { ToolExecutor } from "./ToolExecutor";
import type { ToolExecutorContext } from "./ToolExecutor";
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
  TASK_RESPONSE_SCHEMA,
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
  /** UI summary verbosity preference surfaced to the webview. */
  uiSummaryVerbosity?: "compact" | "normal" | "verbose";
  /** Whether the compact-summary toggle should be shown in the webview. */
  uiShowSummaryToggle?: boolean;
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

  private readonly pathResolver: PathResolver;

  private readonly projectDetector: ProjectDetector;

  private readonly broadcaster: StreamBroadcaster;

  private readonly toolExecutor: ToolExecutor;
  private readonly toolRegistry: ToolRegistry;

  private pendingClarificationResolver:
    | ((value: { selection?: string; [k: string]: unknown } | string) => void)
    | null = null;

  private currentConfig: AgentConfig;

  private health: ProviderHealth = { ok: false, message: "Not checked" };

  private availableModels: ModelSummary[] = [];
  private availableModelsCheckedAt = 0;
  private availableModelsRefreshPromise: Promise<void> | null = null;
  private static readonly MODEL_DISCOVERY_TTL_MS = 60_000;

  private tokensConsumed = 0;

  private activeTokenSessionId: string | null = null;

  private get workspaceRoot(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  /** Simple concurrency gate — only one task runs at a time. */
  private taskQueue: Promise<RuntimeTaskResult> = Promise.resolve(
    null as unknown as RuntimeTaskResult,
  );

  /** AbortController for the currently running task. */
  private activeTaskController: AbortController | null = null;

  /** AbortControllers for queued tasks that have not started yet. */
  private pendingTaskControllers = new Set<AbortController>();

  /** Self-learn background loop timer. */
  private selfLearnTimer: ReturnType<typeof setInterval> | null = null;

  private mcpStatusCache: {
    checkedAt: number;
    statuses: McpServerStatus[];
  } | null = null;

  private mcpStatusPromise: Promise<McpServerStatus[]> | null = null;

  /** Tool enable/disable map set from the UI. All tools enabled by default. */
  private enabledToolsMap: Record<string, boolean> = {};

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
    const toolRegistry = new ToolRegistry();
    this.toolRegistry = toolRegistry;
    this.planner = new Planner(this.provider, toolRegistry);
    this.scanner = new WorkspaceScanner();
    this.sessionStore = new SessionStore(storage.sessionsPath);
    this.memoryStore = new MemoryStore(storage.memoriesPath);
    this.editManager = new EditManager(storage.editsPath, storage.snapshotsDir);
    this.verifier = new VerificationRunner();
    this.mcpManager = new McpManager(config.mcpServers);
    this.skillRegistry = new SkillRegistry(toolRegistry);
    this.webSearch = webSearch;
    this.permissionPolicy = new PermissionPolicy(config.permissionMode);
    this.gitService = new GitService();
    this.improvementEngine = new ImprovementEngine(
      storage.improvementPath,
      toolRegistry,
    );
    this.terminalExecutor = new TerminalExecutor();
    this.pathResolver = new PathResolver(() => this.workspaceRoot);
    this.projectDetector = new ProjectDetector();
    this.broadcaster = new StreamBroadcaster();

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const toolCtx: ToolExecutorContext = {
      get workspaceRoot() {
        return self.workspaceRoot?.fsPath ?? null;
      },
      get allowTerminalExecution() {
        return self.currentConfig.allowTerminalExecution ?? false;
      },
      isToolEnabled: (tool: string) => this.isToolEnabled(tool),
      resolvePath: (value: string) => this.resolveWorkspacePath(value),
      normalizeDisplay: (filePath: string) =>
        this.normalizeDisplayPath(filePath),
      buildWorkspaceInventory: (limit: number) =>
        this.buildWorkspaceInventory(limit),
      executeTerminalCommand: (command, opts) =>
        this.executeTerminalCommand(command, opts),
      researchWeb: (query: string) => this.researchWeb(query),
      mcpSummary: () => this.mcpSummary(),
      collectVerificationCommands: (objective, args) =>
        this.collectVerificationCommands(objective, args),
    };
    this.toolExecutor = new ToolExecutor(
      toolCtx,
      this.scanner,
      this.verifier,
      this.gitService,
      this.webSearch,
      this.broadcaster,
      toolRegistry,
    );
  }

  public setProgressCallback(
    cb: ((step: AgentProgressStep) => void) | null,
  ): void {
    this.broadcaster.setProgressCallback(cb);
  }

  public setTokenCallback(
    cb: ((snapshot: TokenSnapshot) => void) | null,
  ): void {
    this.broadcaster.setTokenCallback(cb);
  }

  public setStreamCallback(cb: ((chunk: string) => void) | null): void {
    this.broadcaster.setStreamCallback(cb);
  }

  public setTerminalOutputCallback(
    cb:
      | ((data: {
          command: string;
          output: string;
          exitCode: number | null;
        }) => void)
      | null,
  ): void {
    this.broadcaster.setTerminalOutputCallback(cb);
  }

  public setClarificationCallback(
    cb: ((payload: { question: string; options?: string[] }) => void) | null,
  ): void {
    this.broadcaster.setClarificationCallback(cb);
  }

  public async requestClarification(
    question: string,
    options?: string[],
    timeoutMs = 120000,
  ): Promise<{ selection?: string } | string> {
    return new Promise((resolve) => {
      this.pendingClarificationResolver = resolve;
      try {
        this.broadcaster.emitClarificationRequest(question, options);
      } catch {}
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (this.pendingClarificationResolver) {
            this.pendingClarificationResolver({ selection: "Inspect logs" });
            this.pendingClarificationResolver = null;
          }
        }, timeoutMs);
      }
    });
  }

  public receiveClarificationResponse(payload: unknown): void {
    if (!this.pendingClarificationResolver) return;
    try {
      this.pendingClarificationResolver(payload as any);
    } catch {
      try {
        this.pendingClarificationResolver(String(payload));
      } catch {}
    }
    this.pendingClarificationResolver = null;
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

    const profileDefaults = resolveProfileDefaults(this.currentConfig);
    if (this.currentConfig.selfLearnEnabled && profileDefaults.numCtx > 4096) {
      this.startSelfLearnLoop();
    } else if (this.currentConfig.selfLearnEnabled) {
      this.logger.info(
        "Self-learn loop skipped on low-VRAM profile to improve responsiveness",
      );
    }
  }

  public async refreshProviderState(force = false): Promise<void> {
    const now = Date.now();
    if (
      !force &&
      this.availableModels.length > 0 &&
      now - this.availableModelsCheckedAt < AgentRuntime.MODEL_DISCOVERY_TTL_MS
    ) {
      return;
    }

    if (this.availableModelsRefreshPromise) {
      await this.availableModelsRefreshPromise;
      return;
    }

    this.availableModelsRefreshPromise = (async () => {
      this.health = await this.provider.healthCheck();
      if (this.health.ok) {
        try {
          this.availableModels = await this.provider.listModels();
          this.availableModels = this.mergeConfiguredModels(
            this.availableModels,
          );
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
      } else {
        this.availableModels = this.mergeConfiguredModels([]);
      }

      this.availableModelsCheckedAt = Date.now();
    })().finally(() => {
      this.availableModelsRefreshPromise = null;
    });

    await this.availableModelsRefreshPromise;
  }

  public async listAvailableModels(): Promise<ModelSummary[]> {
    if (
      this.availableModels.length === 0 ||
      Date.now() - this.availableModelsCheckedAt >=
        AgentRuntime.MODEL_DISCOVERY_TTL_MS
    ) {
      await this.refreshProviderState();
    }
    return this.availableModels;
  }

  private async updateSetting(key: string, value: unknown): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("pulse");
    // Respect the configured persistence scope when updating settings.
    const target =
      this.currentConfig && this.currentConfig.persistenceScope === "workspace"
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    try {
      await cfg.update(key, value, target);
    } catch {
      // Fallback to the other target if the preferred one fails.
      const fallback =
        target === vscode.ConfigurationTarget.Global
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
      try {
        await cfg.update(key, value, fallback);
      } catch {
        // Give up silently; settings update is non-critical.
      }
    }
  }

  public async setUiSummaryVerbosity(
    value: "compact" | "normal" | "verbose",
  ): Promise<void> {
    await this.updateSetting("ui.summaryVerbosity", value);
    this.currentConfig.uiSummaryVerbosity = value;
    try {
      await this.memoryStore.setPreference("ui.summaryVerbosity", value);
    } catch {
      // ignore
    }
  }

  public async setUiShowSummaryToggle(value: boolean): Promise<void> {
    await this.updateSetting("ui.showSummaryToggle", value);
    this.currentConfig.uiShowSummaryToggle = value;
    try {
      await this.memoryStore.setPreference(
        "ui.showSummaryToggle",
        String(value),
      );
    } catch {
      // ignore
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
    const root = this.workspaceRoot?.fsPath ?? null;
    const inventory = await this.scanner.collectWorkspaceInventory(limit);
    const listedFiles = inventory.listedFiles.map((filePath) =>
      root ? path.relative(root, filePath).replace(/\\/g, "/") : filePath,
    );

    return {
      totalFiles: inventory.totalFiles,
      listedFiles,
      truncated: inventory.truncated,
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

  private selectBootstrapFiles(
    listedFiles: string[],
    objective: string,
  ): string[] {
    const normalizedObjective = objective.toLowerCase();
    const selected: string[] = [];
    const seen = new Set<string>();
    const add = (filePath: string | undefined): void => {
      if (!filePath || seen.has(filePath)) {
        return;
      }
      seen.add(filePath);
      selected.push(filePath);
    };

    const preferred = [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "package-lock.json",
      "yarn.lock",
      "tsconfig.json",
      "README.md",
      "src/extension.ts",
      "src/index.ts",
      "src/main.ts",
      "src/app.ts",
      "src/App.tsx",
      "src/main.tsx",
      "pyproject.toml",
      "requirements.txt",
    ];

    for (const preferredPath of preferred) {
      const match = listedFiles.find(
        (filePath) =>
          filePath === preferredPath || filePath.endsWith(`/${preferredPath}`),
      );
      add(match);
      if (selected.length >= 4) {
        return selected;
      }
    }

    if (/test|vitest|jest|failing|broken|fix/i.test(normalizedObjective)) {
      for (const filePath of listedFiles) {
        if (/test|spec/i.test(filePath)) {
          add(filePath);
        }
        if (selected.length >= 4) {
          return selected;
        }
      }
    }

    for (const filePath of listedFiles) {
      if (filePath.startsWith("src/") || filePath.startsWith("test/")) {
        add(filePath);
      }
      if (selected.length >= 4) {
        break;
      }
    }

    return selected;
  }

  private async bootstrapWorkspaceContext(
    objective: string,
    signal?: AbortSignal,
  ): Promise<TaskToolObservation[]> {
    const inventory = await this.buildWorkspaceInventory(60);
    const bootstrapObservations: TaskToolObservation[] = [
      {
        tool: "workspace_scan",
        ok: true,
        summary: `Loaded workspace inventory (${inventory.totalFiles} file${inventory.totalFiles === 1 ? "" : "s"}).`,
        detail: inventory.listedFiles.slice(0, 20).join("\n"),
      },
    ];

    const bootstrapFiles = this.selectBootstrapFiles(
      inventory.listedFiles,
      objective,
    );

    if (bootstrapFiles.length > 0) {
      const readObservations = await this.executeTaskToolCalls(
        [
          {
            tool: "read_files",
            args: { paths: bootstrapFiles },
            reason:
              "Read key project files for concrete workspace bootstrap context.",
          },
        ],
        objective,
        signal,
      );
      bootstrapObservations.push(...readObservations);
    }

    return bootstrapObservations;
  }

  /** Cancel the currently running task, if any. */
  public cancelTask(): void {
    this.activeTaskController?.abort();
    for (const controller of this.pendingTaskControllers) {
      controller.abort();
    }
    this.pendingTaskControllers.clear();
  }

  /** Enable or disable the background self-learn loop. */
  public async setSelfLearn(enabled: boolean): Promise<void> {
    await this.updateSetting("behavior.selfLearn", enabled);
    this.currentConfig.selfLearnEnabled = enabled;
    if (enabled) {
      const profileDefaults = resolveProfileDefaults(this.currentConfig);
      if (profileDefaults.numCtx > 4096) {
        this.startSelfLearnLoop();
      } else {
        this.stopSelfLearnLoop();
        this.logger.info(
          "Self-learn remains disabled on low-VRAM profile to keep agent responsive",
        );
      }
    } else {
      this.stopSelfLearnLoop();
    }
  }

  /** Whether a self-learn cycle is currently running. */
  private selfLearnRunning = false;

  private startSelfLearnLoop(): void {
    if (this.selfLearnTimer) return; // already running
    // Use a longer interval (120s) with a concurrency guard to prevent
    // overlapping cycles from competing with user tasks for VRAM.
    this.selfLearnTimer = setInterval(() => {
      if (this.activeTaskController || this.selfLearnRunning) {
        return; // skip if a user task is running or a cycle is already active
      }
      this.selfLearnRunning = true;
      this.improvementEngine
        .runSelfImprovementCycle()
        .catch((err) => {
          this.logger.warn(`Self-learn cycle error: ${err}`);
        })
        .finally(() => {
          this.selfLearnRunning = false;
        });
    }, 120_000);
    this.logger.info("Self-learn loop started (every 120s, with backpressure)");
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
    this.pendingTaskControllers.add(controller);
    this.taskQueue = this.taskQueue
      .catch(() => {})
      .then(() => {
        this.pendingTaskControllers.delete(controller);
        if (controller.signal.aborted) {
          return this.makeCancelledResult(normalizedRequest.objective);
        }
        this.broadcaster.resetReasoningState();
        this.activeTaskController = controller;
        return this.executeTask(normalizedRequest, controller.signal);
      })
      .finally(() => {
        if (this.activeTaskController === controller) {
          this.activeTaskController = null;
        }
        this.pendingTaskControllers.delete(controller);
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
    const requestedObjective = request.objective;
    const checkAborted = () => {
      if (signal?.aborted) throw new Error("__TASK_CANCELLED__");
    };
    checkAborted();
    this.broadcaster.emitProgress(
      "Starting",
      "Initializing session context",
      "\u25B8",
    );
    let session = await this.sessionStore.getActiveSession();
    if (!session) {
      session = await this.sessionStore.createSession(requestedObjective, {
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
        this.broadcaster.emitProgress(
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
          requestedObjective,
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

    const continuationRequest =
      this.isContinuationObjective(requestedObjective);
    const objective = this.resolveTaskObjective(requestedObjective, session);

    if (request.action !== "edit" && request.action !== "retry") {
      const userTurn: ConversationMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: requestedObjective,
        createdAt: new Date().toISOString(),
      };
      await this.sessionStore.appendMessage(session.id, userTurn);
    }

    const mode = this.currentConfig.conversationMode;
    const allowEdits = mode === "agent" && this.shouldAllowEdits(objective);
    const attachedFiles = session.attachedFiles ?? [];
    const attachedContext = await this.loadAttachedFileContext(
      attachedFiles,
      signal,
    );
    const conversationHistory = await this.buildConversationHistory(
      session.messages,
    );
    const inventoryRequest = this.isWorkspaceDiscoveryObjective(objective);

    if (inventoryRequest) {
      this.broadcaster.emitProgress(
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
      this.broadcaster.emitProgress(
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
        this.broadcaster.emitProgress(
          "Web research",
          webResearch.query ?? "searching",
          "\u25CB",
        );
      }
      this.broadcaster.emitProgress("Generating response", model, "\u25B8");
      const taskStart = Date.now();
      checkAborted();
      const response = await this.provider.chat({
        model,
        signal,
        onChunk: (chunk) => {
          this.broadcaster.emitReasoningChunk(chunk);
          this.broadcaster.emitStreamChunk(chunk);
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
      this.broadcaster.emitProgress(
        "Plan mode",
        "Preparing structured plan",
        "\u25A0",
      );
      const [plannerModel, webResearch] = await Promise.all([
        this.resolveModelOrFallback(this.currentConfig.plannerModel),
        this.collectWebResearch(objective, mode),
      ]);
      if (webResearch) {
        this.broadcaster.emitProgress(
          "Web research",
          webResearch.query ?? "searching",
          "\u25CB",
        );
      }
      this.broadcaster.emitProgress("Building plan", plannerModel, "\u25A0");
      const plan = await this.planner.createPlan(objective, plannerModel);
      this.broadcaster.emitProgress(
        "Saving plan artifact",
        undefined,
        "\u25CB",
      );
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
        "Detailed steps, todos, assumptions, and acceptance criteria are in the plan artifact.",
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
      this.broadcaster.emitProgress(
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
          this.broadcaster.emitReasoningChunk(chunk);
          this.broadcaster.emitStreamChunk(chunk);
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

    this.broadcaster.emitProgress("Agent mode", "Analyzing request", "\u25B8");
    const taskStartAgent = Date.now();
    const agentResult = await this.runAgentWorkflow(
      objective,
      session.id,
      continuationRequest,
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

    this.projectDetector.clearCache();

    return `Applied transaction ${result.id}.`;
  }

  public async acceptFileEdit(filePath: string): Promise<string> {
    const ok = await this.editManager.acceptFile(filePath);
    if (!ok) return "File not found in pending proposal.";
    this.projectDetector.clearCache();
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

    this.projectDetector.clearCache();

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
      objective?: string;
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

    // Guard against wrong-ecosystem commands (e.g. npm in Python projects)
    const shouldGateByStack =
      options?.purpose === "tool" || options?.purpose === "verification";
    const projectRoot = options?.cwd ?? this.workspaceRoot?.fsPath;
    if (shouldGateByStack && projectRoot) {
      const projectType = await this.detectProjectType(projectRoot);
      const commandEcosystem = this.detectCommandEcosystem(sanitized);
      const crossStackAllowed = this.objectiveAllowsCrossStack(
        options?.objective ?? "",
        commandEcosystem,
      );

      if (
        projectType !== "unknown" &&
        commandEcosystem !== "unknown" &&
        !this.isCommandCompatibleWithProject(projectType, commandEcosystem) &&
        !crossStackAllowed
      ) {
        const message =
          `Blocked ${commandEcosystem} command for detected ${projectType} project. ` +
          "Use a project-compatible command or explicitly request cross-stack scaffolding.";
        this.logger.info(message);
        return {
          exitCode: 1,
          output: message,
          command: sanitized,
          durationMs: 0,
          timedOut: false,
        };
      }
    }

    const action = classifyAction(sanitized);
    const decision = this.permissionPolicy.evaluate({
      action,
      description: `Run terminal command: ${sanitized}`,
    });
    const safeCommand = isSafeTerminalCommand(sanitized);
    // Safe commands always run in non-strict mode.
    // Unsafe commands require allowTerminalExecution or autoRunVerification.
    const mode = this.permissionPolicy.getMode();
    const isInstall = action === "package_install";

    const canAutoRunNonInstall =
      mode !== "strict" &&
      !isInstall &&
      (safeCommand ||
        (options?.purpose === "verification" &&
          this.currentConfig.autoRunVerification) ||
        (options?.purpose === "tool" &&
          this.currentConfig.allowTerminalExecution));

    const canAutoRunInstall =
      mode !== "strict" &&
      isInstall &&
      safeCommand &&
      options?.purpose !== "manual" &&
      this.currentConfig.allowTerminalExecution;

    const canAutoRunSafeCommand = canAutoRunNonInstall || canAutoRunInstall;

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

    this.cancelTask();
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
      this.cancelTask();
      await this.sessionStore.clearActiveSession();
      await this.editManager.clearPendingProposal();
      this.activeTokenSessionId = null;
      this.resetTokenUsage();
    }

    return { deleted, wasActive };
  }

  public async startNewConversation(): Promise<void> {
    this.cancelTask();
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
    const toolHints = (() => {
      try {
        const regs = this.toolRegistry.list();
        const toolLines = regs
          .slice(0, 10)
          .map((r) => `- ${r.name}: ${r.prompt ?? r.description ?? ""}`);
        return toolLines.join("\n").slice(0, 1200);
      } catch {
        return "";
      }
    })();
    const result = this.verifier.runDiagnostics(toolHints);
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

    const toolHints = (() => {
      try {
        const regs = this.toolRegistry.list();
        const toolLines = regs
          .slice(0, 10)
          .map((r) => `- ${r.name}: ${r.prompt ?? r.description ?? ""}`);
        return toolLines.join("\n").slice(0, 1200);
      } catch {
        return "";
      }
    })();
    const diagnostics = this.verifier.runDiagnostics(toolHints);
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
      uiSummaryVerbosity: this.currentConfig.uiSummaryVerbosity ?? "normal",
      uiShowSummaryToggle: this.currentConfig.uiShowSummaryToggle ?? true,
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
    this.broadcaster.emitTokenUpdate(
      this.tokensConsumed,
      this.currentConfig.maxContextTokens,
    );
  }

  private resetTokenUsage(): void {
    this.tokensConsumed = 0;
    this.broadcaster.emitTokenUpdate(
      this.tokensConsumed,
      this.currentConfig.maxContextTokens,
    );
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
      } else if (m.role === "assistant") {
        const trimmed = m.content.slice(0, 200).replace(/\n+/g, " ").trim();
        if (trimmed) {
          keyPoints.push(`- Agent: ${trimmed}`);
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
    signal?: AbortSignal,
  ): Promise<Array<{ path: string; content: string }>> {
    if (paths.length === 0) {
      return [];
    }

    // Respect user-configurable limits (fallback to conservative defaults)
    const maxAttached = this.currentConfig?.maxAttachedFiles ?? 4;
    const maxChars = this.currentConfig?.maxCharsPerFile ?? 1200;

    const expandedPaths = await this.expandAttachmentPaths(
      paths.slice(0, maxAttached),
      signal,
    );

    const limited = expandedPaths.slice(0, maxAttached);
    return this.scanner.readContextSnippets(limited, maxChars, signal);
  }

  private async expandAttachmentPaths(
    paths: string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (signal?.aborted) {
      return [];
    }

    const expanded = await Promise.all(
      paths.map(async (item) => {
        if (signal?.aborted) {
          return [] as string[];
        }

        const absolutePath = this.resolveAttachmentPath(item);
        if (!absolutePath) {
          return [] as string[];
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
            return files.map((file) => file.fsPath);
          }

          return [absolutePath];
        } catch {
          // Skip unreadable attachments.
          return [] as string[];
        }
      }),
    );

    return Array.from(new Set(expanded.flat()));
  }

  private resolveAttachmentPath(value: string): string | null {
    return this.pathResolver.resolveAttachment(value);
  }

  private normalizeAttachmentPath(value: string): string {
    return this.pathResolver.normalizeAttachment(value);
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
    return this.pathResolver.normalizeDisplay(filePath);
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

  private static readonly GREETING_PATTERN =
    /^(h(ello|i|ey|owdy)|yo|sup|greetings|good\s+(morning|afternoon|evening|night)|thanks?(\s+you)?|th?x|bye|goodbye|see\s+you|later|ok(ay)?|sure|yes|no|yep|nope|got\s+it|what\s+(can\s+you\s+do|are\s+you)|who\s+are\s+you|help(\s+me)?)$/;

  private isSimpleConversational(objective: string): boolean {
    const trimmed = objective.trim();
    const lower = trimmed
      .toLowerCase()
      .replace(/[!?.,]+$/g, "")
      .trim();

    if (AgentRuntime.GREETING_PATTERN.test(lower)) {
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
    continuationRequest: boolean,
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

    const [
      plannerModel,
      editorModel,
      candidateFiles,
      episodes,
      webResearch,
      styleHintAgent,
      improvementHintsAgent,
      session,
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
      this.sessionStore.getSession(sessionId),
    ]);
    const agentAwarenessAgent = this.improvementEngine.getAgentAwarenessHints();
    if (webResearch) {
      this.broadcaster.emitProgress(
        "Web research",
        webResearch.query ?? "searching",
        "\u25CB",
      );
    }

    const [rawContextSnippets, attachedContext, conversationHistory] =
      await Promise.all([
        this.scanner.readContextSnippets(
          candidateFiles.slice(0, 6),
          4000,
          signal,
        ),
        this.loadAttachedFileContext(session?.attachedFiles ?? [], signal),
        this.buildConversationHistory(session?.messages ?? []),
      ]);

    const profileDefaults = resolveProfileDefaults(this.currentConfig);
    const planningModel = profileDefaults.useSingleModel
      ? editorModel
      : plannerModel;

    // Budget-aware context trimming for low-VRAM profiles
    const maxSnippets =
      profileDefaults.numCtx <= 4096
        ? 3
        : profileDefaults.numCtx <= 8192
          ? 5
          : 6;
    const contextSnippets = rawContextSnippets.slice(0, maxSnippets);
    const selectedSkills = this.skillRegistry.selectForObjective(objective);
    const skillsSummary = this.skillRegistry.summarizeSelection(selectedSkills);
    const optionalShortcuts =
      this.skillRegistry.buildOptionalShortcuts(selectedSkills);
    const shortcutSummary = formatShortcutHints(optionalShortcuts);
    const primarySkillName = selectedSkills.primary?.name ?? "None";
    if (planningModel !== plannerModel) {
      this.broadcaster.emitProgress(
        "Low-VRAM speed",
        `Using ${planningModel} for planning and editing`,
        "⚡",
      );
    }
    this.broadcaster.emitProgress("Building plan", planningModel, "\u25A0");
    const plan = await this.planner.createPlan(objective, planningModel, {
      keepAlive: profileDefaults.plannerKeepAlive,
      numCtx: profileDefaults.numCtx,
    });
    const shouldTrackTodos = this.shouldTrackTodosForObjective(objective);

    if (plan.isFallback) {
      this.broadcaster.emitProgress(
        "Plan fallback",
        "Planner model failed — using generic fallback plan",
        "\u26A0",
      );
    }

    // On low-VRAM profiles, unload the planner model before starting the
    // editor loop to avoid VRAM contention between two loaded models.
    if (
      profileDefaults.plannerKeepAlive === 0 &&
      planningModel !== editorModel &&
      this.provider.providerType === "ollama"
    ) {
      this.broadcaster.emitProgress(
        "Freeing VRAM",
        `Unloading ${planningModel}`,
        "\u21BB",
      );
      await (this.provider as OllamaProvider).unloadModel(planningModel);
    }

    // Prepare a compact tool-hints block derived from the ToolRegistry to
    // guide the editor model and refinement step. Keep it bounded.
    const toolHints = (() => {
      try {
        const regs = this.toolRegistry.list();
        const toolLines = regs
          .slice(0, 20)
          .map((r) => `- ${r.name}: ${r.prompt ?? r.description ?? ""}`);
        return toolLines.join("\n").slice(0, 1200);
      } catch {
        return "";
      }
    })();

    const buildPrompt = (
      toolContext: string,
      critiqueContext: string,
    ): string =>
      [
        this.getPersonaPrompt(),
        "You are an autonomous coding agent inside VS Code. You MUST return valid JSON only, no markdown.",
        "You have full workspace access: read, write, create, delete, rename files and run terminal commands.",
        "CRITICAL: You MUST use toolCalls to do work. Do NOT just respond with text. Call tools!",
        "The workspace context below is already part of this turn. Use it before repeating discovery steps.",
        continuationRequest
          ? "The user asked you to continue an in-progress task. Resume from the existing context and completed work. Do NOT restart discovery or re-ask for direction unless a blocker requires it."
          : "",
        "",
        ...(styleHintAgent ? [styleHintAgent] : []),
        ...(improvementHintsAgent ? [improvementHintsAgent] : []),
        ...(agentAwarenessAgent ? [agentAwarenessAgent] : []),
        shortcutSummary ? shortcutSummary : "",
        skillsSummary ? `Skills: ${skillsSummary}` : "",
        "",
        /next\.?js|next-app/i.test(objective)
          ? "SCAFFOLDING: Use `pnpm create next-app@latest . --ts --tailwind --eslint --app` first. Do not use `pnpm init -y`."
          : "",
        "## WORKFLOW",
        "1. Start from the provided workspace context and only call more discovery tools when they add new information.",
        "2. IMPORTANT: If the workspace already has files, read and ADAPT to them. Do NOT recreate or overwrite existing code.",
        "3. Work through todos ONE at a time: mark 'in-progress', use tool calls, mark 'done'.",
        "4. After run_terminal, check output. If errors: diagnose and fix.",
        "5. Use create_file ONLY for truly new files. Use batch_edit or replace_in_file for modifying existing files.",
        "6. On failure: analyze → try alternatives. Never give up on first attempt.",
        "7. You get MULTIPLE turns. Each turn you MUST make tool calls to do work. Do NOT skip tools!",
        "8. Detect tech stack from workspace (package.json → Node, pyproject.toml → Python, etc).",
        "9. If the workspace has existing structure, work WITHIN it — extend, fix, or modify. Do NOT start from scratch.",
        "10. Do NOT repeat the same planning sentence or generic scaffold todo list when tool results already show the next step.",
        "11. If the user already told you what to build or change, act on it directly. Do not ask for the same direction again unless the task is genuinely ambiguous or blocked.",
        "",
        "## TODO RULES",
        shouldTrackTodos
          ? "- 3-5 actionable todos. Statuses: 'pending' | 'in-progress' | 'done' | 'blocked'"
          : "- For simple direct tasks, todos may be empty and you should act immediately.",
        shouldTrackTodos
          ? "- ONE 'in-progress' at a time. Complete it, mark 'done', start next."
          : "- If todos are empty, perform the next concrete tool call immediately and finish once the evidence is collected.",
        "",
        "## JSON FORMAT",
        '{"response":"<what you are doing>","todos":[{"id":"todo_1","title":"...","status":"pending"}],"toolCalls":[{"tool":"<name>","args":{...}}],"edits":[],"shortcuts":[]}',
        "- toolCalls: actions for THIS turn. You MUST include at least one tool call per turn until all todos are done.",
        "- If toolCalls present: you get another turn with results.",
        "- ONLY when ALL todos are truly done with evidence: empty toolCalls and write summary.",
        "",
        "## TOOLS (use these in toolCalls)",
        "workspace_scan {}, read_files {paths:[]}, list_dir {path}, search_files {query}, file_search {pattern}",
        "create_directory {path}, create_file {filePath,content}, write_file {filePath,content}, delete_file {filePath}",
        "batch_edit {edits:[{filePath,search,replace}]}, replace_in_file {filePath,oldText,newText}, rename_file {oldPath,newPath}",
        "grep_search {pattern, isRegex?, includePattern?}",
        "run_terminal {command}, run_verification, get_problems {filePath?}, get_terminal_output",
        "web_search {query}, git_diff {filePath?}, diagnostics, find_references {symbol}",
        "get_definitions {filePath,line,character}, get_references {filePath,line,character}, get_document_symbols {filePath}, rename_symbol {filePath,line,character,newName}",
        "git_commit {message,files?}, git_status {}, git_log {count?}, git_file_history {filePath,count?}, git_blame {filePath,line?}, git_branch {action:'list'|'create'|'checkout',name?}",
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
        toolHints ? `Tool hints:\n${toolHints}` : "",
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
    let awaitingClarification = false;

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
          : shouldTrackTodos
            ? "No todos yet."
            : "No todo tracking required for this task.",
        "",
        "## INSTRUCTIONS",
        "- You MUST include toolCalls to do work. Do NOT respond with only text.",
        shouldTrackTodos
          ? "- Work on the NEXT pending todo. Mark it in-progress, use tool calls, mark done."
          : "- This task can be completed without a todo list if it is a single direct action. Use the next tool call immediately.",
        continuationRequest
          ? "- This is a continuation request. Resume from the existing task state and avoid another generic 'I'll inspect/check first' preamble unless the context is missing."
          : "",
        "- The current workspace context has already been gathered. Do NOT repeat workspace_scan unless the context is stale.",
        "- If the workspace already has files, ADAPT to them. Do NOT recreate existing files from scratch.",
        "- Use create_file ONLY for truly new files. Use batch_edit or replace_in_file for modifying existing files.",
        "- Do not repeat exact tool calls already shown in tool results.",
        "- If a prior tool call succeeded, move forward to the next step.",
        shouldTrackTodos
          ? "- When ALL todos are done WITH evidence from tool calls: write final summary, empty toolCalls."
          : "- When the direct task is complete with evidence from tool calls: write the final summary and leave toolCalls empty.",
        "",
        "## TOOLS",
        "workspace_scan, read_files {paths:[]}, list_dir {path}, search_files {query}, file_search {pattern}",
        "create_directory {path}, create_file {filePath,content}, write_file {filePath,content}, delete_file {filePath}",
        "batch_edit {edits:[{filePath,search,replace}]}, replace_in_file {filePath,oldText,newText}, rename_file {oldPath,newPath}",
        "grep_search {pattern, isRegex?, includePattern?}",
        "run_terminal {command}, run_verification, get_problems {filePath?}, get_terminal_output",
        "get_definitions {filePath,line,character}, get_references {filePath,line,character}, get_document_symbols {filePath}, rename_symbol {filePath,line,character,newName}",
        "git_commit {message,files?}, git_status {}, git_log {count?}, git_file_history {filePath,count?}, git_blame {filePath,line?}, git_branch {action:'list'|'create'|'checkout',name?}",
        "",
        "## JSON FORMAT",
        '{"response":"...","todos":[...],"toolCalls":[{"tool":"...","args":{...}}],"edits":[],"shortcuts":[]}',
        "",
        toolCtx ? `## TOOL RESULTS\n${toolCtx}` : "",
        toolHints
          ? `Tool hints: ${toolHints.split("\n").slice(0, 5).join("; ")}`
          : "",
        critiqueCtx ? `## FEEDBACK\n${critiqueCtx}` : "",
      ]
        .filter((v) => v.length > 0)
        .join("\n");

    // Agent loop: iterates until all todos are done, quality meets target,
    // or max iterations reached. Each iteration can produce tool calls,
    // file edits, or both. Edits are applied immediately so the agent
    // can continue working on remaining todos without stopping.
    // When the planner failed (fallback plan), auto-bootstrap the first
    // iteration with workspace_scan results so the model has concrete
    // data to work with instead of guessing from the prompt context alone.
    if (plan.isFallback) {
      this.broadcaster.emitProgress(
        "Auto-bootstrap",
        "Scanning workspace for fallback plan",
        "\u25CB",
      );
      const bootstrapObs = await this.executeTaskToolCalls(
        [{ tool: "workspace_scan", args: {} }],
        objective,
        signal,
      );
      if (bootstrapObs.length > 0) {
        toolTrace.push(...bootstrapObs);
        const maxObs = profileDefaults.numCtx <= 4096 ? 3 : 5;
        toolContext = formatToolObservations(toolTrace.slice(-maxObs));
      }
    }

    // Track whether ANY tool calls have been successfully executed
    // across all iterations — used to prevent false "all done" exits.
    let hasEverExecutedTools = false;

    const MAX_AGENT_ITERATIONS = profileDefaults.maxAgentIterations;
    let noActionCount = 0;
    let retried = false;
    const toolFailureCounts = new Map<string, number>();
    for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration += 1) {
      this.broadcaster.emitProgress(
        iteration === 0 ? "Generating response" : "Continuing",
        `${editorModel} (step ${iteration + 1})`,
        "\u25B8",
      );
      checkAborted();

      // Per-iteration timeout — give iteration 0 extra time for cold model load
      const iterationTimeoutMs =
        iteration === 0
          ? profileDefaults.iterationTimeoutMs +
            profileDefaults.coldStartBonusMs
          : profileDefaults.iterationTimeoutMs;
      const iterationAbort = new AbortController();
      const timeoutId = setTimeout(
        () => iterationAbort.abort(),
        iterationTimeoutMs,
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
        // Use JSON schema structured output for Ollama to constrain model output
        const chatFormat: "json" | Record<string, unknown> =
          this.provider.providerType === "ollama"
            ? TASK_RESPONSE_SCHEMA
            : "json";
        response = await this.provider.chat({
          model: editorModel,
          format: chatFormat,
          keepAlive: profileDefaults.editorKeepAlive,
          numCtx: profileDefaults.numCtx,
          signal: iterationAbort.signal,
          onChunk: (chunk) => {
            this.broadcaster.emitReasoningPulse(
              "Reasoning through tools and code changes...",
            );
          },
          messages: isFollowUp
            ? [
                {
                  role: "system",
                  content:
                    "You are a coding agent. Return ONLY valid JSON: {response, todos, toolCalls, edits, shortcuts}. No markdown. You MUST include toolCalls to do work. Start with { end with }.",
                },
                this.buildUserMessage(promptText),
              ]
            : [
                {
                  role: "system",
                  content:
                    "You are a coding agent. Return ONLY valid JSON: {response, todos, toolCalls, edits, shortcuts}. No markdown fences. No text outside JSON. You MUST include toolCalls array with at least one tool call to do work. Start with { end with }.",
                },
                ...conversationHistory,
                this.buildUserMessage(
                  promptText,
                  iteration === 0 ? images : undefined,
                ),
              ],
          maxTokens: isFollowUp
            ? profileDefaults.followUpMaxTokens
            : profileDefaults.firstIterationMaxTokens,
        });
      } catch (err: unknown) {
        if (iterationAbort.signal.aborted && !signal?.aborted) {
          // Iteration-level timeout — log and break out with whatever we have
          this.broadcaster.emitProgress(
            "Timeout",
            `Iteration ${iteration + 1} timed out`,
            "⚠️",
          );
          break;
        }
        // Adaptive context fallback for Ollama memory/context errors
        const errMsg =
          err instanceof Error ? err.message.toLowerCase() : String(err);
        if (
          this.provider.providerType === "ollama" &&
          /out of memory|context.*too|num_ctx|oom|alloc/i.test(errMsg) &&
          !retried
        ) {
          retried = true;
          profileDefaults.numCtx = Math.max(
            2048,
            Math.floor(profileDefaults.numCtx * 0.6),
          );
          profileDefaults.firstIterationMaxTokens = Math.max(
            1024,
            Math.floor(profileDefaults.firstIterationMaxTokens * 0.6),
          );
          profileDefaults.followUpMaxTokens = Math.max(
            768,
            Math.floor(profileDefaults.followUpMaxTokens * 0.6),
          );
          this.broadcaster.emitProgress(
            "Reducing context",
            `Retrying with num_ctx=${profileDefaults.numCtx}`,
            "\u21BB",
          );
          continue;
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
        this.broadcaster.emitProgress(
          "Context reset",
          "Token budget near limit, resetting for next iteration",
          "\u21BB",
        );
        this.resetTokenUsage();
      }

      const previousTodos = parsed.todos;
      // Determine whether to allow loose JSON heuristics based on provider capabilities.
      const caps = (
        this.provider as unknown as {
          capabilities?: {
            supportsJsonMode?: boolean;
            supportsJsonSchema?: boolean;
          };
        }
      ).capabilities;
      const allowLooseParsing = caps
        ? !(caps.supportsJsonSchema || caps.supportsJsonMode)
        : true;
      parsed = parseTaskResponse(response.text, allowLooseParsing);
      if (previousTodos.length > 0 && parsed.todos.length > 0) {
        parsed.todos = this.reconcileTodoProgress(previousTodos, parsed.todos);
      }
      if (parsed.todos.length === 0) {
        const hasNoActions =
          parsed.toolCalls.length === 0 && parsed.edits.length === 0;
        if (
          shouldTrackTodos &&
          hasNoActions &&
          parsed.response.trim().length > 0 &&
          hasEverExecutedTools
        ) {
          // Only mark todos done if the agent has actually done work
          parsed.todos = plan.todos.map((todo) => ({
            ...todo,
            status: "done" as const,
          }));
        } else if (shouldTrackTodos) {
          // No todos returned — use plan todos and keep them pending
          parsed.todos = plan.todos;
        }
      }
      if (parsed.shortcuts.length === 0) {
        parsed.shortcuts = optionalShortcuts;
      }

      // Emit progressive todo updates so the UI shows them evolving
      if (parsed.todos.length > 0) {
        this.broadcaster.emitTodoUpdate(parsed.todos);
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

      // Deterministic TODO updates when toolCalls include todoId bindings.
      this.applyTodoOutcomesFromToolCalls(
        parsed.todos,
        parsed.toolCalls,
        observations,
      );

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
        // Track consecutive failures per tool name
        for (const obs of failedObs) {
          const count = (toolFailureCounts.get(obs.tool) ?? 0) + 1;
          toolFailureCounts.set(obs.tool, count);
        }
        // Reset count for tools that succeeded
        for (const obs of observations.filter((o) => o.ok)) {
          toolFailureCounts.delete(obs.tool);
        }

        const failSummary = failedObs
          .map((o) => `[FAILED] ${o.tool}: ${o.summary}`)
          .join("\n");

        // Build hard-stop warnings for tools that have failed 3+ times
        const hardStops: string[] = [];
        for (const [tool, count] of toolFailureCounts) {
          if (count >= 3) {
            hardStops.push(
              `STOP: "${tool}" has failed ${count} times consecutively. Do NOT call it again. Use an alternative approach.`,
            );
          }
        }
        const hardStopBlock =
          hardStops.length > 0 ? "\n\n" + hardStops.join("\n") : "";

        critiqueContext =
          (critiqueContext ? critiqueContext + "\n\n" : "") +
          "## TOOL FAILURES — INVESTIGATE AND RETRY\n" +
          "The following tool calls failed. Do NOT give up. Analyze the error, find the root cause, and try an alternative approach:\n" +
          failSummary +
          hardStopBlock;

        // If a terminal command failed, surface a clarification request
        try {
          const terminalFailure = failedObs.find(
            (o) => o.tool === "run_terminal" && !o.ok,
          );
          if (terminalFailure) {
            const lastTerm = this.toolExecutor.getLastTerminalResult
              ? this.toolExecutor.getLastTerminalResult()
              : null;
            if (
              lastTerm &&
              (lastTerm.exitCode !== 0 ||
                lastTerm.timedOut ||
                lastTerm.interactivePrompt)
            ) {
              if (!awaitingClarification) {
                awaitingClarification = true;
                const excerpt = String(lastTerm.output ?? "").slice(0, 400);
                const q = `The command "${lastTerm.command}" failed (exit ${lastTerm.exitCode ?? "unknown"}). Output excerpt:\n${excerpt}\n\nHow should I proceed?`;
                const resp = await this.requestClarification(q, [
                  "Inspect logs",
                  "Attempt automatic fix and rerun",
                  "Skip and continue",
                ]);
                const sel =
                  resp && typeof resp === "object" && (resp as any).selection
                    ? (resp as any).selection
                    : resp;
                if (
                  sel === "Attempt automatic fix and rerun" ||
                  sel === "attempt_fix" ||
                  sel === "Attempt automatic fix"
                ) {
                  critiqueContext +=
                    "\nUser approved automatic fix attempts: apply reasonable fixes and rerun the failing command.";
                } else if (sel === "Skip and continue" || sel === "skip") {
                  critiqueContext += "\nUser chose to skip rerun.";
                } else {
                  critiqueContext +=
                    "\nUser requested to inspect logs before proceeding.";
                }
                awaitingClarification = false;
              }
            }
          }
        } catch (e) {
          // ignore clarification path errors
        }
      }

      if (observations.length > 0) {
        toolTrace.push(...observations);
        const maxObs = profileDefaults.numCtx <= 4096 ? 3 : 5;
        toolContext = formatToolObservations(toolTrace.slice(-maxObs));
        this.broadcaster.emitProgress(
          "Tool results",
          `${observations.length} observation(s) collected`,
          "\u25CB",
        );
      }

      finalAssessment = assessTaskQuality(
        parsed,
        {
          objective,
          toolTrace: observations,
          editCount: parsed.edits.length,
          verificationRan: observations.some(
            (observation) =>
              observation.tool === "run_verification" && observation.ok,
          ),
          isEditTask: this.isLikelyEditTaskObjective(objective),
        },
        profileDefaults.qualityTarget,
      );

      // Check if all todos are completed
      const pendingTodos = parsed.todos.filter(
        (t) => t.status === "pending" || t.status === "in-progress",
      );
      const allTodosDone = parsed.todos.length > 0 && pendingTodos.length === 0;

      // If work was done this iteration (tool calls or edits), continue
      // so the LLM can observe results and proceed to next todo.
      if (observations.length > 0) {
        hasEverExecutedTools = true;
        const hasSuccessfulObservations = observations.some((o) => o.ok);
        if (hasSuccessfulObservations) {
          noActionCount = 0;
        } else {
          noActionCount += 1;
        }
        if (failedObs.length === 0) {
          critiqueContext = "";
        }
        // Only break on all-done if real work was done across the session
        // AND at least a couple of iterations have passed (low-end models
        // may mark done too early).
        if (allTodosDone && iteration >= 2 && hasEverExecutedTools) {
          break;
        }

        if (
          pendingTodos.length > 0 &&
          noActionCount >= profileDefaults.noActionThreshold
        ) {
          this.broadcaster.emitProgress(
            "Auto-bootstrap",
            "Repeated tool failures — attaching concrete workspace context",
            "\u21BB",
          );
          const bootstrapObs = await this.bootstrapWorkspaceContext(
            objective,
            signal,
          );
          if (bootstrapObs.length > 0) {
            toolTrace.push(...bootstrapObs);
            const maxObs = profileDefaults.numCtx <= 4096 ? 3 : 5;
            toolContext = formatToolObservations(toolTrace.slice(-maxObs));
          }
          critiqueContext =
            "The previous tool attempts failed repeatedly. " +
            "Use the refreshed workspace context above and choose a smaller next step. " +
            "Complete pending todos one by one.\n" +
            `Pending: ${pendingTodos.map((t) => t.title).join(", ")}`;
          noActionCount = 0;
        }

        continue;
      }

      // No tool calls AND no edits this iteration — LLM didn't act.
      noActionCount += 1;

      // Break if genuinely complete: all todos done OR quality target met.
      // BUT only if the model has actually executed tools at some point —
      // otherwise it's just marking generic todos "done" without doing work.
      if (
        hasEverExecutedTools &&
        (allTodosDone ||
          (finalAssessment.meetsTarget && pendingTodos.length === 0))
      ) {
        break;
      }

      // If model claims "all done" but never executed a single tool call,
      // don't trust it — reset todos to pending and force workspace scan.
      if (allTodosDone && !hasEverExecutedTools) {
        this.broadcaster.emitProgress(
          "Auto-bootstrap",
          "Model claimed done without tool use — attaching concrete workspace context",
          "\u21BB",
        );
        // Reset all todos back to pending
        for (const todo of parsed.todos) {
          todo.status = "pending";
        }
        this.broadcaster.emitTodoUpdate(parsed.todos);

        const bootstrapObs = await this.bootstrapWorkspaceContext(
          objective,
          signal,
        );
        if (bootstrapObs.length > 0) {
          hasEverExecutedTools = true;
          toolTrace.push(...bootstrapObs);
          const maxObs = profileDefaults.numCtx <= 4096 ? 3 : 5;
          toolContext = formatToolObservations(toolTrace.slice(-maxObs));
        }
        critiqueContext =
          "IMPORTANT: You marked all todos done without using any tools. " +
          "That is NOT correct. You MUST use tool calls to actually do the work. " +
          "I've attached concrete workspace context for you. Now read the results above and " +
          "start working through the todos using tool calls.\n" +
          "FIRST: use the attached file/context evidence before repeating discovery.\n" +
          "THEN: use create_file, batch_edit, or run_terminal to make changes.\n" +
          `Objective: ${objective}`;
        noActionCount = 0;
        continue;
      }

      if (
        pendingTodos.length > 0 &&
        this.isPlanningPlaceholderResponse(parsed.response)
      ) {
        this.broadcaster.emitProgress(
          "Auto-bootstrap",
          "Model repeated a planning placeholder — attaching concrete workspace context",
          "\u21BB",
        );
        const bootstrapObs = await this.bootstrapWorkspaceContext(
          objective,
          signal,
        );
        if (bootstrapObs.length > 0) {
          hasEverExecutedTools = true;
          toolTrace.push(...bootstrapObs);
          const maxObs = profileDefaults.numCtx <= 4096 ? 3 : 5;
          toolContext = formatToolObservations(toolTrace.slice(-maxObs));
        }
        critiqueContext =
          "Your last response repeated a planning placeholder instead of acting on the task. " +
          "Use the concrete workspace context above. Do NOT restate that you will scan, inspect, or plan. " +
          "Pick one pending todo, mark it in-progress, and perform the next tool call immediately.\n" +
          `Pending: ${pendingTodos.map((t) => t.title).join(", ")}`;
        noActionCount = 0;
        continue;
      }

      // Deterministic bootstrap: if the model has stalled for too many
      // consecutive no-action iterations but work remains, auto-inject
      // workspace scan results so the model can observe the codebase.
      if (
        pendingTodos.length > 0 &&
        noActionCount >= profileDefaults.noActionThreshold
      ) {
        this.broadcaster.emitProgress(
          "Auto-bootstrap",
          "Model stalled — attaching concrete workspace context",
          "\u21BB",
        );
        const bootstrapObs = await this.bootstrapWorkspaceContext(
          objective,
          signal,
        );
        if (bootstrapObs.length > 0) {
          hasEverExecutedTools = true;
          toolTrace.push(...bootstrapObs);
          const maxObs = profileDefaults.numCtx <= 4096 ? 3 : 5;
          toolContext = formatToolObservations(toolTrace.slice(-maxObs));
        }
        critiqueContext =
          "You have pending todos that are NOT complete. " +
          "I have attached concrete workspace context for you. Use the results above. " +
          "Pick the next pending todo, mark it in-progress, and use tool calls to complete it. " +
          "Do NOT stop until all todos are done.\n" +
          `Pending: ${pendingTodos.map((t) => t.title).join(", ")}`;
        noActionCount = 0;
        continue;
      }

      // Still have pending todos but LLM didn't produce actions — nudge it
      if (pendingTodos.length > 0) {
        critiqueContext =
          "IMPORTANT: You returned NO tool calls. You MUST use tool calls to do work!\n" +
          "You have pending todos that are NOT complete. " +
          "Pick the next pending todo, mark it in-progress, and include toolCalls to complete it.\n" +
          'Example: {"tool":"workspace_scan","args":{}} or {"tool":"read_files","args":{"paths":["package.json"]}}\n' +
          `Pending: ${pendingTodos.map((t) => t.title).join(", ")}`;
        continue;
      }

      critiqueContext = buildTaskRefinementPrompt(
        objective,
        parsed,
        finalAssessment,
        observations,
        toolHints,
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
      this.broadcaster.emitFilePatch(basename, lineCount);

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
      this.broadcaster.emitFilesChanged(allFileChanges);
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
        this.broadcaster.emitFilePatched(basename, linesAdded);
      }
    }

    // Edits applied during the loop are already on disk
    let autoApplied = allAccumulatedEdits.length > 0;
    if (proposal && this.shouldAutoApplyProposal(unappliedEdits)) {
      this.broadcaster.emitProgress(
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

    const finalTodos =
      parsed.todos.length > 0
        ? parsed.todos
        : shouldTrackTodos
          ? plan.todos
          : [];
    if (
      finalTodos.some(
        (todo) => todo.status === "pending" || todo.status === "in-progress",
      )
    ) {
      this.finalizeIncompleteTodos(finalTodos, MAX_AGENT_ITERATIONS);
      this.broadcaster.emitTodoUpdate(finalTodos);
    }

    return {
      plan: {
        ...plan,
        todos: finalTodos,
      },
      responseText: await this.buildTaskCompletionSummary({
        objective,
        rawResponseText: parsed.response || "Task completed.",
        todos: finalTodos,
        toolTrace,
        proposal,
        autoApplied,
        fileDiffs: fileDiffs.length > 0 ? fileDiffs : undefined,
        qualityScore: finalAssessment?.score,
        qualityTarget: finalAssessment?.target,
        meetsQualityTarget: finalAssessment?.meetsTarget,
      }),
      todos: finalTodos,
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
    const allowedCalls: TaskToolCall[] = [];
    const preObservations: TaskToolObservation[] = [];

    for (const call of toolCalls) {
      try {
        const action = classifyAction(call.reason ?? call.tool);
        const desc = `Tool: ${call.tool}${call.reason ? ` — ${call.reason}` : ""}`;
        const detail = JSON.stringify(call.args ?? {}).slice(0, 2000);
        const decision = this.permissionPolicy.evaluate({
          action,
          description: desc,
          detail,
        });

        if (!decision.allowed) {
          preObservations.push({
            tool: call.tool,
            ok: false,
            summary: `Approval required: ${decision.reason}`,
            detail: call.reason,
          });
        } else {
          allowedCalls.push(call);
        }
      } catch (err) {
        preObservations.push({
          tool: call.tool,
          ok: false,
          summary: `Permission evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const execObservations =
      allowedCalls.length > 0
        ? await this.toolExecutor.executeToolCalls(
            allowedCalls,
            objective,
            signal,
          )
        : [];

    return [...preObservations, ...execObservations];
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

    const profileDefaults = resolveProfileDefaults(this.currentConfig);
    if (profileDefaults.numCtx <= 4096) {
      return this.normalizeTaskSummaryPresentation(fallback);
    }

    try {
      const summaryModel = await this.resolveModelOrFallback(
        this.currentConfig.fastModel,
      );
      const context = this.buildTaskSummaryContext(params, raw);
      const response = await this.provider.chat({
        model: summaryModel,
        temperature: 0.2,
        maxTokens: 420,
        messages: [
          {
            role: "system",
            content:
              "Produce a professional end-of-task summary modeled after GitHub Copilot Chat. Use this exact structure:\n" +
              "Progress update: one concise sentence summarizing the key outcome.\n\n" +
              "What I did:\n- 2-6 concise bullets listing concrete changes, files modified, commands run, and verification performed.\n\n" +
              "Next steps for you:\n- 2-4 concise bullets with actionable guidance, verification steps, and optional follow-ups.\n\n" +
              "Optionally offer up to two quick actions I can do next (for example: 'Add unit test', 'Open a PR').\n" +
              "Do not include code fences, JSON, or unrelated boilerplate. Be specific and mention filenames or commands when applicable.",
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
    const sections: string[] = [];
    const bullets: string[] = [];
    const doneTodos = params.todos.filter((t) => t.status === "done");
    const hasIncompleteTodos = params.todos.some(
      (todo) => todo.status !== "done",
    );
    const totalTodos = params.todos.length;

    // Outcome statement (first line)
    if (hasIncompleteTodos) {
      const completedCount = doneTodos.length;
      if (completedCount > 0) {
        sections.push(
          `Made progress on ${params.objective}, but some work is still incomplete.`,
        );
      } else {
        sections.push(`Could not finish ${params.objective}.`);
      }
    } else if (!generic && raw.length > 0 && raw.length < 200) {
      sections.push(raw);
    } else {
      sections.push(`Completed the requested work for ${params.objective}.`);
    }

    const changeSummary = this.summarizeChangesCompact(
      params.proposal,
      params.fileDiffs,
      params.autoApplied,
    );
    if (changeSummary && changeSummary !== "No file changes were required.") {
      bullets.push(`What changed: ${changeSummary}`);
    }

    const toolSummary = this.summarizeEvidenceCompact(params.toolTrace);
    if (toolSummary) {
      bullets.push(`What the agent inspected: ${toolSummary}`);
    }

    const verificationSummary = this.summarizeVerificationCompact(
      params.toolTrace,
      params.qualityScore,
      params.qualityTarget,
      params.meetsQualityTarget,
    );
    if (verificationSummary) {
      bullets.push(`Verification: ${verificationSummary}`);
    }

    const incompleteEditTask = this.summarizeIncompleteEditTask(params);
    if (incompleteEditTask) {
      bullets.push(`Issue: ${incompleteEditTask.issue}`);
      if (incompleteEditTask.nextSteps.length > 0) {
        bullets.push(
          `Next steps: ${incompleteEditTask.nextSteps.slice(0, 2).join("; ")}`,
        );
      }
    }

    const issueSummary = this.summarizeIssueCompact(params.toolTrace);
    if (issueSummary) {
      bullets.push(`Issue: ${issueSummary}`);
      const nextSteps = this.summarizeIssueNextSteps(params.toolTrace);
      if (nextSteps) {
        bullets.push(
          `Next steps: ${nextSteps
            .split("\n")
            .map((step) => step.replace(/^[-•]\s*/, "").trim())
            .filter((step) => step.length > 0)
            .slice(0, 2)
            .join("; ")}`,
        );
      }
    }

    // Build a Copilot-like structured fallback summary:
    const parts: string[] = [];
    parts.push(`Progress update: ${sections[0]}`);

    if (bullets.length > 0) {
      parts.push("");
      parts.push("What I did:");
      for (const b of bullets.slice(0, 6)) {
        if (b && b.length > 0) parts.push(`- ${b}`);
      }
    }

    // Collect concise next steps from incomplete edit analysis or issue suggestions
    const nextSteps: string[] = [];
    // Reuse the earlier `incompleteEditTask` computed above in this function.
    if (incompleteEditTask) {
      nextSteps.push(...incompleteEditTask.nextSteps.slice(0, 4));
    } else {
      const issueNext = this.summarizeIssueNextSteps(params.toolTrace);
      if (issueNext) {
        nextSteps.push(
          ...issueNext
            .split("\n")
            .map((s) => s.replace(/^[-•]\s*/, "").trim())
            .filter(Boolean),
        );
      }
    }

    if (nextSteps.length > 0) {
      parts.push("");
      parts.push("Next steps for you:");
      for (const s of nextSteps.slice(0, 4)) {
        parts.push(`- ${s}`);
      }
    } else if (bullets.length === 0) {
      parts.push("");
      parts.push("Next steps for you:");
      parts.push("- No further action required.");
    }

    return parts.join("\n");
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
      "Write a polished closing summary with one short outcome sentence followed by 2-4 markdown bullets.",
      "Focus on what the agent changed, what it checked or verified, and any issue or next step if relevant.",
      "Do not use headings, JSON, or code fences. Avoid generic boilerplate.",
      "Be specific to this task and mention concrete files, commands, or blockers when available.",
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
    rawResponseText: string;
    proposal: EditProposal | null;
    fileDiffs?: FileDiffResult[];
    qualityScore?: number;
    qualityTarget?: number;
    meetsQualityTarget?: boolean;
  }): { issue: string; nextSteps: string[] } | null {
    if (!this.isEditIntent(params.objective)) {
      return null;
    }

    if (!this.isGenericTaskResponse(params.rawResponseText)) {
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
      normalized === "done" ||
      this.isPlanningPlaceholderResponse(normalized)
    );
  }

  private isPlanningPlaceholderResponse(text: string): boolean {
    const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
    if (!normalized) {
      return false;
    }

    return [
      /^scanning (the )?workspace\b/,
      /^workspace scanned\b/,
      /^i(?:'ll| will)? (?:start by )?scan(?:ning)? (?:the )?workspace\b/,
      /^i(?:'ll| will)? .*\bunderstand (?:the )?(?:project|workspace)\b/,
      /^i(?:'ll| will)? .*\bcreate (?:a )?(?:plan|project structure)\b/,
    ].some((pattern) => pattern.test(normalized));
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
      normalized.includes("interactive prompt") ||
      normalized.includes("requires input") ||
      normalized.includes("would you like to use")
    ) {
      suggestions.push(
        "retry the command with explicit non-interactive flags such as --yes",
      );
      suggestions.push(
        "if prompts are required, run the command manually in a visible terminal",
      );
      suggestions.push(
        "continue only after the scaffold command finishes without waiting for input",
      );
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
    return this.toolExecutor.executeSingleToolCall(call, objective, signal);
  }

  private async runVerificationWorkflow(
    objective: string,
    signal?: AbortSignal,
    args?: Record<string, unknown>,
  ): Promise<TaskToolObservation[]> {
    const observations: TaskToolObservation[] = [];

    // Always start with VS Code diagnostics — fast, no process spawn, no ENOENT risk
    const toolHints = (() => {
      try {
        const regs = this.toolRegistry.list();
        const toolLines = regs
          .slice(0, 10)
          .map((r) => `- ${r.name}: ${r.prompt ?? r.description ?? ""}`);
        return toolLines.join("\n").slice(0, 1200);
      } catch {
        return "";
      }
    })();
    const diagnostics = this.verifier.runDiagnostics(toolHints);
    observations.push({
      tool: "run_verification",
      ok: !diagnostics.hasErrors,
      summary: `Diagnostics: ${diagnostics.summary}`,
      detail: JSON.stringify(diagnostics, null, 2),
    });

    const commands = await this.collectVerificationCommands(objective, args);
    if (commands.length === 0) {
      // Diagnostics only — no terminal commands available
      return observations;
    }

    const checkAborted = () => {
      if (signal?.aborted) {
        throw new Error("__TASK_CANCELLED__");
      }
    };

    for (const command of commands.slice(0, 3)) {
      checkAborted();
      this.broadcaster.emitProgress("Verification", command, "\u25CB");
      const result = await this.executeTerminalCommand(command, {
        cwd: this.workspaceRoot?.fsPath,
        timeoutMs: 120_000,
        purpose: "verification",
        objective,
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
    const explicit = ToolExecutor.extractStringList(
      args?.commands,
      args?.command,
      args?.scripts,
    ).filter((command) => isSafeTerminalCommand(command));
    if (explicit.length > 0) {
      return explicit;
    }

    const root = this.workspaceRoot?.fsPath;
    if (!root) {
      return [];
    }

    // Detect project type from workspace evidence
    const projectType = await this.detectProjectType(root);

    if (projectType === "node") {
      const packageJsonPath = path.join(root, "package.json");
      const scripts = await this.readPackageScripts(packageJsonPath);
      const candidateScripts = [
        "test",
        "lint",
        "typecheck",
        "build",
        "compile",
      ].filter((name) => Boolean(scripts?.[name]));

      if (candidateScripts.length > 0) {
        const manager = await this.detectPackageManager();
        return candidateScripts.map((script) => {
          if (manager === "pnpm") {
            return `pnpm run ${script}`;
          }
          if (manager === "yarn") {
            return `yarn run ${script}`;
          }
          return `npm run ${script}`;
        });
      }

      // Node project exists but no matching scripts — use defaults
      const manager = await this.detectPackageManager();
      if (manager === "pnpm") {
        return ["pnpm test", "pnpm run build"];
      }
      if (manager === "yarn") {
        return ["yarn test", "yarn build"];
      }
      return ["npm test", "npm run build"];
    }

    if (projectType === "python") {
      const commands: string[] = [];
      const hasDjangoManage = await this.fileExists(
        path.join(root, "manage.py"),
      );
      if (hasDjangoManage) {
        commands.push("python manage.py test");
      } else {
        commands.push("python -m pytest");
      }
      return commands;
    }

    if (projectType === "rust") {
      return ["cargo test", "cargo build"];
    }

    if (projectType === "go") {
      return ["go test ./...", "go build ./..."];
    }

    // Unknown project type — rely on diagnostics only
    return [];
  }

  /**
   * Detect the primary project type from workspace marker files.
   */
  private async detectProjectType(
    root: string,
  ): Promise<"node" | "python" | "rust" | "go" | "unknown"> {
    return this.projectDetector.detectProjectType(root);
  }

  private detectCommandEcosystem(
    command: string,
  ): "node" | "python" | "rust" | "go" | "dotnet" | "unknown" {
    return this.projectDetector.detectCommandEcosystem(command);
  }

  private isCommandCompatibleWithProject(
    projectType: "node" | "python" | "rust" | "go" | "unknown",
    commandEcosystem: "node" | "python" | "rust" | "go" | "dotnet" | "unknown",
  ): boolean {
    return this.projectDetector.isCommandCompatibleWithProject(
      projectType,
      commandEcosystem,
    );
  }

  private objectiveAllowsCrossStack(
    objective: string,
    ecosystem: "node" | "python" | "rust" | "go" | "dotnet" | "unknown",
  ): boolean {
    return this.projectDetector.objectiveAllowsCrossStack(objective, ecosystem);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    return this.projectDetector.fileExists(filePath);
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
          this.broadcaster.emitFilePatched(
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

  private reconcileTodoProgress(
    previous: TaskTodo[],
    next: TaskTodo[],
  ): TaskTodo[] {
    const previousById = new Map(previous.map((todo) => [todo.id, todo]));

    return next.map((todo) => {
      const prior =
        previousById.get(todo.id) ??
        previous.find(
          (candidate) =>
            candidate.title.trim().toLowerCase() ===
            todo.title.trim().toLowerCase(),
        );

      if (!prior) {
        return todo;
      }

      // Allow regression from done -> in-progress ONLY if the model
      // explicitly provides a detail explaining why (e.g. "previous edit was wrong").
      // Otherwise keep todo progression monotonic to avoid regressions
      // from weak-model hallucination.
      if (prior.status === "done" && todo.status !== "done") {
        if (
          todo.detail &&
          todo.status === "in-progress" &&
          /\b(revis|redo|fix|correct|wrong|broken|undo|retry)\b/i.test(
            todo.detail,
          )
        ) {
          return todo; // legitimate regression
        }
        return {
          ...todo,
          status: "done",
          detail: todo.detail ?? prior.detail,
        };
      }

      if (prior.status === "blocked" && todo.status === "pending") {
        return {
          ...todo,
          status: "blocked",
          detail: todo.detail ?? prior.detail,
        };
      }

      return todo;
    });
  }

  private applyTodoOutcomesFromToolCalls(
    todos: TaskTodo[],
    calls: TaskToolCall[],
    observations: TaskToolObservation[],
  ): void {
    if (todos.length === 0 || calls.length === 0 || observations.length === 0) {
      return;
    }

    const byTodoId = new Map<string, TaskToolObservation[]>();
    for (let index = 0; index < calls.length; index += 1) {
      const todoId = calls[index].todoId?.trim();
      if (!todoId) {
        continue;
      }
      const observation = observations[index];
      if (!observation) {
        continue;
      }
      const list = byTodoId.get(todoId) ?? [];
      list.push(observation);
      byTodoId.set(todoId, list);
    }

    if (byTodoId.size === 0) {
      return;
    }

    for (const todo of todos) {
      const todoObservations = byTodoId.get(todo.id);
      if (!todoObservations || todoObservations.length === 0) {
        continue;
      }

      const anyFailed = todoObservations.some((observation) => !observation.ok);
      if (anyFailed) {
        const failed = todoObservations.find((observation) => !observation.ok);
        todo.status = "blocked";
        if (!todo.detail) {
          todo.detail = failed?.summary ?? "Tool execution failed";
        }
        continue;
      }

      const anySucceeded = todoObservations.some(
        (observation) => observation.ok,
      );
      if (anySucceeded) {
        todo.status = "done";
      }
    }
  }

  private finalizeIncompleteTodos(
    todos: TaskTodo[],
    iterationLimit: number,
  ): void {
    for (const todo of todos) {
      if (todo.status === "pending" || todo.status === "in-progress") {
        todo.status = "blocked";
        if (!todo.detail) {
          todo.detail = `Task loop ended before completion (${iterationLimit} iteration limit reached).`;
        }
      }
    }
  }

  /**
   * Auto-advance todo statuses based on work completed in the current iteration.
   * If tools/edits succeeded and there's a todo in-progress, mark it done.
   * If no todo is in-progress, mark the first pending todo as done.
   */
  private advanceTodoStatuses(
    todos: TaskTodo[],
    observations: TaskToolObservation[],
  ): void {
    if (todos.length === 0) return;

    const hasSuccessfulWork = observations.some((o) => o.ok);
    const inProgressTodo = todos.find((t) => t.status === "in-progress");
    const pending = todos.filter((t) => t.status === "pending");

    if (hasSuccessfulWork) {
      if (inProgressTodo) {
        // Mark in-progress todo as done since work succeeded
        inProgressTodo.status = "done";
      } else if (pending.length > 0) {
        // Model never set in-progress — assume first pending was executed
        pending[0].status = "done";
      }
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
    this.broadcaster.emitTodoUpdate(todos);
  }

  private shouldAutoApplyProposal(edits: ProposedEdit[]): boolean {
    if (edits.length === 0) {
      return false;
    }

    if (this.permissionPolicy.getMode() === "full") {
      return true;
    }

    const includesDelete = edits.some(
      (edit) => (edit.operation ?? "write") === "delete",
    );
    if (includesDelete) {
      const deleteDecision = this.permissionPolicy.evaluate({
        action: "file_delete",
        description: "Apply pending edit proposal with file deletions",
      });
      return deleteDecision.allowed;
    }

    const decision = this.permissionPolicy.evaluate({
      action: "multi_file_edit",
      description: "Apply pending edit proposal",
    });
    return decision.allowed;
  }

  private async readPackageScripts(
    packageJsonPath: string,
  ): Promise<Record<string, string> | null> {
    return this.projectDetector.readPackageScripts(packageJsonPath);
  }

  private async detectPackageManager(): Promise<"npm" | "pnpm" | "yarn"> {
    return this.projectDetector.detectPackageManager(this.workspaceRoot);
  }

  private resolveWorkspacePath(value: string): string | null {
    return this.pathResolver.resolve(value);
  }

  private isLikelyEditTaskObjective(objective: string): boolean {
    return /\b(fix|bug|error|crash|test|build|compile|lint|diagnos|fail|refactor|implement|add|update|remove|delete|write|create|edit)\b/i.test(
      objective,
    );
  }

  private shouldTrackTodosForObjective(objective: string): boolean {
    const normalized = objective.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    const complexSignals =
      /\b(scaffold|bootstrap|refactor|migrate|investigate|debug|diagnos|implement|feature|workflow|architecture|workspace|project|codebase|multiple|across|end[- ]to[- ]end|failing tests?|add tests?|write tests?|run tests?|test suite|compile|build|lint|verification|regression)\b/;
    const sequencingSignals = /\b(and|then|after|before|also|plus)\b/;
    const directSignals =
      /\b(show|open|list|read|search|find|explain|summarize|check|inspect|display|blame|history|diff|status|log)\b/;
    const directTargetSignals =
      /[/\\]|:\d+|\.(ts|tsx|js|jsx|json|md|py|java|cs|go|rs)\b/;

    if (complexSignals.test(normalized)) {
      return true;
    }

    if (sequencingSignals.test(normalized) && wordCount > 6) {
      return true;
    }

    if (
      wordCount <= 8 &&
      (directSignals.test(normalized) || directTargetSignals.test(normalized))
    ) {
      return false;
    }

    return wordCount > 10;
  }

  private isContinuationObjective(objective: string): boolean {
    const normalized = objective.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    return /^(continue|proceed|go on|keep going|carry on|resume|continue please|proceed with this|keep working)$/i.test(
      normalized,
    );
  }

  private resolveTaskObjective(
    requestedObjective: string,
    session: SessionRecord | null,
  ): string {
    if (!this.isContinuationObjective(requestedObjective) || !session) {
      return requestedObjective;
    }

    const activeObjective = session.objective?.trim();
    if (activeObjective) {
      return activeObjective;
    }

    const lastUserMessage = [...(session.messages ?? [])]
      .reverse()
      .find(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          !this.isContinuationObjective(message.content),
      );

    return typeof lastUserMessage?.content === "string" &&
      lastUserMessage.content
      ? lastUserMessage.content
      : requestedObjective;
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
