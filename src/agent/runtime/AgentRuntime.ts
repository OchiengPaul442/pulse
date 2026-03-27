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
import { WorkspaceScanner } from "../indexing/WorkspaceScanner";
import { McpManager, type McpServerStatus } from "../mcp/McpManager";
import { OllamaProvider } from "../model/OllamaProvider";
import type { ModelSummary, ProviderHealth } from "../model/ModelProvider";
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
} from "./RuntimeTypes";
import { SessionStore } from "../sessions/SessionStore";
import type { SessionRecord } from "../sessions/SessionStore";
import { VerificationRunner } from "../verification/VerificationRunner";
import {
  assessTaskQuality,
  buildTaskRefinementPrompt,
  formatCompactTodos,
  formatShortcutHints,
  formatToolObservations,
  isSafeTerminalCommand,
  parseTaskResponse,
  TARGET_TASK_QUALITY_SCORE,
  type TaskQualityAssessment,
  type TaskModelResponse,
  type TaskToolCall,
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
  private readonly provider: OllamaProvider;

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

  public constructor(
    config: AgentConfig,
    private readonly storage: StorageState,
    private readonly logger: Logger,
    webSearch: WebSearchService,
  ) {
    this.currentConfig = { ...config };
    this.provider = new OllamaProvider(config.ollamaBaseUrl);
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

  private emitProgress(step: string, detail?: string, icon = "⚡"): void {
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

  private emitTerminalRun(command: string): void {
    this.progressCallback?.({
      icon: "🖥️",
      step: "Terminal",
      detail: command,
      kind: "terminal",
    });
  }

  private emitReasoningChunk(chunk: string): void {
    this.progressCallback?.({
      icon: "✨",
      step: "Reasoning",
      detail: chunk.slice(0, 240),
      kind: "reasoning",
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
    return [...this.currentConfig.mcpServers];
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

  private async executeTask(
    request: RunTaskRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeTaskResult> {
    const objective = request.objective;
    const checkAborted = () => {
      if (signal?.aborted) throw new Error("__TASK_CANCELLED__");
    };
    checkAborted();
    this.emitProgress("Starting", "Initializing session context", "🚀");
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
      this.emitProgress("Scanning workspace", "Listing project files", "🔍");
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
      this.emitProgress("Ask mode", "Preparing conversational response", "💬");
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
          "🌐",
        );
      }
      this.emitProgress("Generating response", model, "✨");
      const taskStart = Date.now();
      checkAborted();
      const response = await this.provider.chat({
        model,
        signal,
        onChunk: (chunk) => {
          this.emitReasoningChunk(chunk);
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
          {
            role: "user" as const,
            content: objective,
          },
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
      this.emitProgress("Plan mode", "Preparing structured plan", "📋");
      const [plannerModel, webResearch] = await Promise.all([
        this.resolveModelOrFallback(this.currentConfig.plannerModel),
        this.collectWebResearch(objective, mode),
      ]);
      if (webResearch) {
        this.emitProgress(
          "Web research",
          webResearch.query ?? "searching",
          "🌐",
        );
      }
      this.emitProgress("Building plan", plannerModel, "🧠");
      const plan = await this.planner.createPlan(objective, plannerModel);
      this.emitProgress("Saving plan artifact", undefined, "💾");
      const artifactPath = await this.writePlanArtifact(
        objective,
        plan,
        webResearch,
      );
      const responseText = [
        `Plan mode active. Wrote ${artifactPath ? `plan artifact to ${artifactPath}` : "a plan summary"}.`,
        "This mode does not make code changes.",
        webResearch
          ? "Latest web research was included in the plan artifact."
          : "No web research was needed for this plan.",
        "",
        JSON.stringify(plan, null, 2),
      ].join("\n");

      await this.persistTaskResult(session.id, objective, responseText, mode);

      return {
        sessionId: session.id,
        objective,
        plan,
        responseText,
        proposal: null,
        artifactPath: artifactPath ?? undefined,
      };
    }

    if (!allowEdits) {
      this.emitProgress(
        "Generating response",
        this.currentConfig.fastModel,
        "✨",
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
          {
            role: "user" as const,
            content: objective,
          },
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
          steps: [],
          taskSlices: [],
          verification: [],
        },
        responseText: response.text,
        proposal: null,
      };
    }

    this.emitProgress("Agent mode", "Analyzing request", "🧠");
    const taskStartAgent = Date.now();
    const agentResult = await this.runAgentWorkflow(
      objective,
      session.id,
      signal,
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
    const decision = this.permissionPolicy.evaluate({
      action: "terminal_exec",
      description: `Run terminal command: ${command}`,
    });
    const safeCommand = isSafeTerminalCommand(command);
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
      this.logger.info(`Terminal exec blocked by policy: ${command}`);
      return null;
    }

    this.logger.info(`Executing terminal command: ${command}`);
    if (options?.visible) {
      this.terminalExecutor.runInVisibleTerminal(command);
      return {
        exitCode: 0,
        output: "",
        command,
        durationMs: 0,
        timedOut: false,
      };
    }
    return this.terminalExecutor.execute(command, options);
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

    await this.sessionStore.setActiveSession(sessionId);
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
    return messages.slice(-8).map((message) => ({
      role: message.role,
      content: message.content,
    }));
  }

  private async loadAttachedFileContext(
    paths: string[],
  ): Promise<Array<{ path: string; content: string }>> {
    if (paths.length === 0) {
      return [];
    }

    const expandedPaths = await this.expandAttachmentPaths(paths.slice(0, 8));
    return this.scanner.readContextSnippets(expandedPaths.slice(0, 8), 2400);
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
    // Simple greetings, small talk, and conversational messages don't need
    // the full agent workflow — route them to the lighter conversation path.
    if (this.isSimpleConversational(objective)) {
      return false;
    }
    // Otherwise, always allow edits in agent mode. The permission policy
    // controls whether the user must approve before applying.
    return true;
  }

  private isSimpleConversational(objective: string): boolean {
    const trimmed = objective.trim();
    // Very short messages (< 12 chars) that don't contain code-like signals
    if (trimmed.length < 12 && !/[{}<>/\\=]/.test(trimmed)) {
      return true;
    }
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
    return greetings.includes(lower);
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
    const explicitSearchIntent = [
      "search the web",
      "look it up online",
      "find online",
      "check the internet",
      "browse for",
    ];

    const timeSensitiveSignals = [
      "latest version",
      "release notes",
      "changelog",
      "what changed",
      "current price",
      "pricing",
      "breaking change",
      "migration guide",
      "this week",
      "today",
      "just released",
      "just announced",
      "official docs",
    ];

    if (
      this.matchesAny(normalized, explicitSearchIntent) ||
      this.matchesAny(normalized, timeSensitiveSignals)
    ) {
      return true;
    }

    if (mode === "ask") {
      return this.matchesAny(normalized, [
        "what is",
        "who is",
        "how to",
        "how do i",
        "compare",
        "recommend",
        "should i",
      ]);
    }

    return (
      mode === "agent" &&
      this.matchesAny(normalized, [
        "package",
        "dependency",
        "sdk",
        "library",
        "framework",
        "docs",
        "release notes",
        "version",
      ])
    );
  }

  private matchesAny(text: string, tokens: string[]): boolean {
    return tokens.some((token) => {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  ): Promise<{
    plan: TaskPlan;
    responseText: string;
    todos: TaskTodo[];
    shortcuts: string[];
    proposal: EditProposal | null;
    autoApplied: boolean;
    toolTrace: TaskToolObservation[];
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
      this.emitProgress("Web research", webResearch.query ?? "searching", "🌐");
    }

    const session = await sessionPromise;
    const [contextSnippets, attachedContext, conversationHistory] =
      await Promise.all([
        this.scanner.readContextSnippets(candidateFiles.slice(0, 4), 2400),
        this.loadAttachedFileContext(session?.attachedFiles ?? []),
        this.buildConversationHistory(session?.messages ?? []),
      ]);
    const selectedSkills = this.skillRegistry.selectForObjective(objective);
    const skillsSummary = this.skillRegistry.summarizeSelection(selectedSkills);
    const optionalShortcuts =
      this.skillRegistry.buildOptionalShortcuts(selectedSkills);
    const shortcutSummary = formatShortcutHints(optionalShortcuts);
    this.emitProgress("Building plan", plannerModel, "🧠");
    const plan = await this.planner.createPlan(objective, plannerModel);

    const buildPrompt = (
      toolContext: string,
      critiqueContext: string,
    ): string =>
      [
        this.getPersonaPrompt(),
        "You are running in autonomous agent mode inside VS Code.",
        "You have access to workspace context, terminal verification, web research, and file edits.",
        ...(styleHintAgent ? [styleHintAgent] : []),
        ...(improvementHintsAgent ? [improvementHintsAgent] : []),
        ...(agentAwarenessAgent ? [agentAwarenessAgent] : []),
        shortcutSummary ? shortcutSummary : "",
        "",
        "## Operating rules",
        "- Always create a short todo list before making changes.",
        "- Keep TODOs to 3-5 short, imperative lines.",
        "- CRITICAL: When the user asks you to run, execute, or create something with a command, call run_terminal IMMEDIATELY with that exact command. Never write a numbered list of instructions when you can use a tool to do the work.",
        "- Use tools only when you are at least 0.90 confident they will improve accuracy.",
        "- Read the workspace context carefully before editing or running commands.",
        "- Use tool calls when you need more evidence. Do not guess if a tool can answer the question.",
        "- Prefer one high-signal tool over multiple low-confidence calls.",
        "- Prefer small, targeted edits over broad rewrites.",
        "- Keep the current workspace as the only edit target.",
        "- Use terminal verification for builds, tests, diagnostics, or other safe checks.",
        "- If you need to explain a decision, keep the explanation brief and concrete.",
        "- If refinement feedback is present, revise the previous answer to address it.",
        `- Aim for a quality score of at least ${TARGET_TASK_QUALITY_SCORE.toFixed(2)} before finalizing.`,
        "",
        "## Response format",
        "Return strict JSON with these fields. Use ONE tool per toolCall entry — never join tool names with |.",
        '{"response":"Brief summary of what was done","todos":[{"id":"todo_1","title":"Run scaffold command","status":"pending","detail":"Use run_terminal to execute pnpm create next-app"}],"shortcuts":["read","scan","verify"],"toolCalls":[{"tool":"run_terminal","args":{"command":"pnpm test"},"reason":"Verify current state before making changes"}],"edits":[]}',
        "Each toolCall must have a single tool name from: workspace_scan, read_files, run_terminal, run_verification, web_search, git_diff, mcp_status, diagnostics.",
        "",
        "## Tool guidance",
        "- workspace_scan: inspect the workspace when you need more file-level context.",
        "- read_files: request specific file paths you want summarized or inspected.",
        "- run_terminal: execute terminal commands directly. Use this when the user asks to run, execute, build, create, or scaffold anything.",
        "- run_verification: use for tests, lint, build, and diagnostics after edits.",
        "- web_search: use when the answer depends on current external docs or releases.",
        "- git_diff: inspect the repository changes or file diffs.",
        "- mcp_status: inspect MCP connectivity and configuration health.",
        "- diagnostics: inspect active VS Code diagnostics.",
        "",
        "## Context",
        `Objective: ${objective}`,
        `Skills: ${skillsSummary}`,
        `Plan: ${JSON.stringify(plan, null, 2)}`,
        plan.todos.length > 0
          ? `Current todo draft: ${JSON.stringify(plan.todos, null, 2)}`
          : "",
        episodes.length > 0
          ? `Recent memory: ${JSON.stringify(episodes, null, 2)}`
          : "",
        `Workspace files: ${JSON.stringify(contextSnippets, null, 2)}`,
        attachedContext.length > 0
          ? `Attached files: ${JSON.stringify(attachedContext, null, 2)}`
          : "",
        webResearch
          ? `Web research: ${JSON.stringify(webResearch, null, 2)}`
          : "",
        toolContext
          ? `Tool observations from the last round:\n${toolContext}`
          : "",
        critiqueContext
          ? `Refinement feedback from the evaluator:\n${critiqueContext}`
          : "",
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
    let toolContext = "";
    let critiqueContext = "";
    let requestedVerification = false;
    let finalAssessment: TaskQualityAssessment | null = null;

    // Keep the refinement loop short so edit tasks stay responsive.
    for (let iteration = 0; iteration < 2; iteration += 1) {
      this.emitProgress("Generating response", editorModel, "✨");
      checkAborted();
      const response = await this.provider.chat({
        model: editorModel,
        format: "json",
        signal,
        messages: [
          {
            role: "system",
            content:
              "Follow instructions exactly and produce valid JSON only. Do not include markdown fences.",
          },
          ...conversationHistory,
          {
            role: "user",
            content: buildPrompt(toolContext, critiqueContext),
          },
        ],
        maxTokens: 3072,
      });
      this.consumeTokens(response.tokenUsage);

      parsed = parseTaskResponse(response.text);
      if (parsed.todos.length === 0) {
        parsed.todos = plan.todos;
      }
      if (parsed.shortcuts.length === 0) {
        parsed.shortcuts = optionalShortcuts;
      }

      requestedVerification ||= parsed.toolCalls.some(
        (call) => call.tool === "run_verification",
      );

      const observations =
        parsed.toolCalls.length > 0
          ? await this.executeTaskToolCalls(parsed.toolCalls, objective, signal)
          : [];

      if (observations.length > 0) {
        toolTrace.push(...observations);
        toolContext = formatToolObservations(toolTrace.slice(-5));
        this.emitProgress(
          "Tool results",
          `${observations.length} observation(s) collected`,
          "🛠️",
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

      if (finalAssessment.meetsTarget || iteration === 2) {
        break;
      }

      critiqueContext = buildTaskRefinementPrompt(
        objective,
        parsed,
        finalAssessment,
        observations,
      );
    }

    const normalizedEdits = parsed.edits
      .map((edit) =>
        normalizeEditPath(edit, vscode.workspace.workspaceFolders ?? []),
      )
      .filter((edit): edit is ProposedEdit => edit !== null);

    if (normalizedEdits.length > 0) {
      for (const edit of normalizedEdits) {
        const basename = path.basename(edit.filePath);
        const lineCount = (edit.content ?? "").split("\n").length;
        this.emitFilePatch(basename, lineCount);
      }
    }

    const proposal =
      normalizedEdits.length > 0
        ? await this.editManager.setPendingProposal(objective, normalizedEdits)
        : null;

    if (proposal) {
      for (const edit of normalizedEdits) {
        const basename = path.basename(edit.filePath);
        const linesAdded = (edit.content ?? "").split("\n").length;
        this.emitFilePatched(basename, linesAdded);
      }
    }

    let autoApplied = false;
    if (proposal && this.shouldAutoApplyProposal(normalizedEdits)) {
      this.emitProgress("Auto-applying edits", "Safe workspace edits", "✅");
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
      responseText: parsed.response || "Task completed.",
      todos: parsed.todos.length > 0 ? parsed.todos : plan.todos,
      shortcuts:
        parsed.shortcuts.length > 0 ? parsed.shortcuts : optionalShortcuts,
      proposal: autoApplied ? null : proposal,
      autoApplied,
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

  private async executeSingleToolCall(
    call: TaskToolCall,
    objective: string,
    signal?: AbortSignal,
  ): Promise<TaskToolObservation[]> {
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
        2400,
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
            .slice(0, 5000),
        },
      ];
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
      const result = await this.executeTerminalCommand(command, {
        cwd: workspaceRoot ?? undefined,
        timeoutMs: 120_000,
        purpose: "tool",
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
      this.emitProgress("Verification", command, "🧪");
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

  private shouldAutoApplyProposal(edits: ProposedEdit[]): boolean {
    if (this.permissionPolicy.getMode() === "strict") {
      return false;
    }

    if (this.permissionPolicy.getMode() === "full") {
      return true;
    }

    if (this.currentConfig.conversationMode !== "agent") {
      return false;
    }

    return (
      edits.length > 0 &&
      edits.every((edit) => (edit.operation ?? "write") === "write")
    );
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
