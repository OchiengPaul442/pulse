import * as path from "path";
import * as vscode from "vscode";

import type {
  AgentConfig,
  AgentPersona,
  McpServerConfig,
  PermissionMode,
} from "../../config/AgentConfig";
import type { StorageState } from "../../db/StorageBootstrap";
import type { Logger } from "../../platform/vscode/Logger";
import { EditManager, type ProposedEdit } from "../edits/EditManager";
import { WorkspaceScanner } from "../indexing/WorkspaceScanner";
import { McpManager } from "../mcp/McpManager";
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
import type { TaskPlan } from "../planner/Planner";
import type {
  ConversationMessage,
  ExplainResult,
  ConversationMode,
  RuntimeTaskResult,
  AgentProgressStep,
  TokenSnapshot,
} from "./RuntimeTypes";
import { SessionStore } from "../sessions/SessionStore";
import type { SessionRecord } from "../sessions/SessionStore";
import { VerificationRunner } from "../verification/VerificationRunner";

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
  tokenBudget: number;
  tokensConsumed: number;
  tokenUsagePercent: number;
  mcpConfigured: number;
  mcpHealthy: number;
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

  private currentConfig: AgentConfig;

  private health: ProviderHealth = { ok: false, message: "Not checked" };

  private availableModels: ModelSummary[] = [];

  private tokensConsumed = 0;

  private progressCallback: ((step: AgentProgressStep) => void) | null = null;

  private tokenCallback: ((snapshot: TokenSnapshot) => void) | null = null;

  private readonly workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;

  /** Simple concurrency gate — only one task runs at a time. */
  private taskQueue: Promise<RuntimeTaskResult> = Promise.resolve(
    null as unknown as RuntimeTaskResult,
  );

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

  public runTask(objective: string): Promise<RuntimeTaskResult> {
    // Enqueue — ensures only one task runs at a time.
    // Earlier tasks must finish (or fail) before the next one starts.
    this.taskQueue = this.taskQueue
      .catch(() => {})
      .then(() => this.executeTask(objective));
    return this.taskQueue;
  }

  private async executeTask(objective: string): Promise<RuntimeTaskResult> {
    this.resetTokenUsage();
    this.emitProgress("Starting", "Initializing session context", "🚀");
    let session = await this.sessionStore.getActiveSession();
    if (!session) {
      session = await this.sessionStore.createSession(objective, {
        planner: this.currentConfig.plannerModel,
        editor: this.currentConfig.editorModel,
        fast: this.currentConfig.fastModel,
      });
    }

    const userTurn: ConversationMessage = {
      role: "user",
      content: objective,
      createdAt: new Date().toISOString(),
    };
    await this.sessionStore.appendMessage(session.id, userTurn);

    const mode = this.currentConfig.conversationMode;
    const allowEdits = mode === "agent" && this.shouldAllowEdits(objective);
    const attachedFiles = session.attachedFiles ?? [];
    const attachedContext = await this.loadAttachedFileContext(attachedFiles);
    const conversationHistory = await this.buildConversationHistory(session.id);
    const inventoryRequest = this.isWorkspaceDiscoveryObjective(objective);

    if (inventoryRequest) {
      this.emitProgress("Scanning workspace", "Listing project files", "🔍");
      const inventory = await this.buildWorkspaceInventory(250);
      const responseText = this.formatWorkspaceInventoryResponse(
        inventory,
        objective,
      );

      await this.sessionStore.appendMessage(session.id, {
        role: "assistant",
        content: responseText,
        createdAt: new Date().toISOString(),
      });
      await this.sessionStore.updateSessionResult(session.id, responseText);
      await this.editManager.clearPendingProposal();
      await this.learnFromExchange(objective, responseText, mode);
      if (this.currentConfig.memoryMode !== "off") {
        await this.memoryStore.addEpisode(
          objective,
          responseText.slice(0, 400),
        );
      }

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
          steps: [],
          taskSlices: [],
          verification: [],
        },
        responseText,
        proposal: null,
      };
    }

    if (mode === "ask") {
      this.emitProgress("Ask mode", "Preparing conversational response", "💬");
      const model = await this.resolveModelOrFallback(
        this.currentConfig.fastModel,
      );
      const styleHint = await this.getLearnedStyleHint(objective, mode);
      const improvementHints =
        await this.improvementEngine.getOptimizedBehaviorHints(objective, mode);
      const webResearch = await this.collectWebResearch(objective, mode);
      if (webResearch) {
        this.emitProgress(
          "Web research",
          webResearch.query ?? "searching",
          "🌐",
        );
      }
      this.emitProgress("Generating response", model, "✨");
      const taskStart = Date.now();
      const response = await this.provider.chat({
        model,
        messages: [
          {
            role: "system" as const,
            content:
              this.getPersonaPrompt() +
              " You are in Ask mode. Be conversational, answer questions, and explain context. Do not propose code edits, terminal commands, or plan artifacts." +
              (styleHint ? " " + styleHint : "") +
              (improvementHints ? " " + improvementHints : ""),
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

      await this.sessionStore.appendMessage(session.id, {
        role: "assistant",
        content: response.text,
        createdAt: new Date().toISOString(),
      });
      await this.sessionStore.updateSessionResult(session.id, response.text);
      await this.editManager.clearPendingProposal();
      await this.learnFromExchange(objective, response.text, mode);
      if (this.currentConfig.memoryMode !== "off") {
        await this.memoryStore.addEpisode(
          objective,
          response.text.slice(0, 400),
        );
      }

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
          steps: [],
          taskSlices: [],
          verification: [],
        },
        responseText: response.text,
        proposal: null,
      };
    }

    if (mode === "plan") {
      this.emitProgress("Plan mode", "Preparing structured plan", "📋");
      const plannerModel = await this.resolveModelOrFallback(
        this.currentConfig.plannerModel,
      );
      const webResearch = await this.collectWebResearch(objective, mode);
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

      await this.sessionStore.appendMessage(session.id, {
        role: "assistant",
        content: responseText,
        createdAt: new Date().toISOString(),
      });
      await this.sessionStore.updateSessionResult(session.id, responseText);
      await this.editManager.clearPendingProposal();
      await this.learnFromExchange(objective, responseText, mode);
      if (this.currentConfig.memoryMode !== "off") {
        await this.memoryStore.addEpisode(
          objective,
          responseText.slice(0, 400),
        );
      }

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
      const model = await this.resolveModelOrFallback(
        this.currentConfig.fastModel,
      );
      const styleHintConvo = await this.getLearnedStyleHint(objective, mode);
      const improvementHintsConvo =
        await this.improvementEngine.getOptimizedBehaviorHints(objective, mode);
      const taskStartConvo = Date.now();
      const response = await this.provider.chat({
        model,
        messages: [
          {
            role: "system" as const,
            content:
              this.getPersonaPrompt() +
              " Answer the user's question directly and concisely. " +
              "If they ask about code or their project, use any attached context to give a specific, accurate answer. " +
              "Do not propose file edits in this mode." +
              (styleHintConvo ? " " + styleHintConvo : "") +
              (improvementHintsConvo ? " " + improvementHintsConvo : ""),
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

      await this.sessionStore.appendMessage(session.id, {
        role: "assistant",
        content: response.text,
        createdAt: new Date().toISOString(),
      });
      await this.sessionStore.updateSessionResult(session.id, response.text);
      await this.editManager.clearPendingProposal();
      await this.learnFromExchange(objective, response.text, mode);
      if (this.currentConfig.memoryMode !== "off") {
        await this.memoryStore.addEpisode(
          objective,
          response.text.slice(0, 400),
        );
      }

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
    const plannerModel = await this.resolveModelOrFallback(
      this.currentConfig.plannerModel,
    );
    const editorModel = await this.resolveModelOrFallback(
      this.currentConfig.editorModel,
    );

    this.emitProgress("Building plan", plannerModel, "📋");
    const plan = await this.planner.createPlan(objective, plannerModel);
    const selectedSkills = this.skillRegistry.selectForObjective(objective);
    this.emitProgress("Scanning workspace", "Finding relevant files", "🔍");
    const candidateFiles = await this.scanner.findRelevantFiles(objective, 8);
    const contextSnippets = await this.scanner.readContextSnippets(
      candidateFiles.slice(0, 4),
      2400,
    );
    const episodes =
      this.currentConfig.memoryMode === "off"
        ? []
        : await this.memoryStore.latestEpisodes(3);
    const webResearch = await this.collectWebResearch(objective, mode);
    if (webResearch) {
      this.emitProgress("Web research", webResearch.query ?? "searching", "🌐");
    }
    const styleHintAgent = await this.getLearnedStyleHint(objective, mode);
    const improvementHintsAgent =
      await this.improvementEngine.getOptimizedBehaviorHints(objective, mode);

    const prompt = [
      this.getPersonaPrompt(),
      "You are running in autonomous agent mode inside VS Code.",
      "You have full access to the user's workspace and can read, write, move, and delete files.",
      ...(styleHintAgent ? [styleHintAgent] : []),
      ...(improvementHintsAgent ? [improvementHintsAgent] : []),
      "",
      "## Operating rules",
      "- You MUST act on the user's request. Do NOT ask clarifying questions unless truly ambiguous.",
      "- Read the workspace context provided below carefully before making changes.",
      "- Prefer minimal, targeted edits over broad rewrites.",
      "- Keep behavior backward compatible unless the objective requires change.",
      "- Never propose edits outside the current workspace.",
      "- If requirements are ambiguous, state your assumptions and proceed with the best approach.",
      "- When the user asks you to do something in agent mode, DO it — produce the edits.",
      "- If you need to understand more files, say which files you'd want to read and why in your response.",
      "",
      "## Response format",
      "Return strict JSON with these fields:",
      '{"response":"A clear explanation of what you did and why","edits":[...]}',
      "",
      "## Edit operations",
      "Each edit is an object with:",
      '- {"operation":"write","filePath":"relative/path","content":"full file content","reason":"why"}',
      '- {"operation":"delete","filePath":"relative/path","reason":"why"}',
      '- {"operation":"move","filePath":"old/path","targetPath":"new/path","reason":"why"}',
      "",
      "If no file changes are needed, return edits as an empty array.",
      "Always include a helpful response explaining what you did or what you found.",
      "",
      webResearch
        ? "## Web research results\n" + JSON.stringify(webResearch, null, 2)
        : "",
      `## User objective\n${objective}`,
      `\n## Skills available\n${this.skillRegistry.summarizeSelection(selectedSkills)}`,
      `\n## Plan\n${JSON.stringify(plan, null, 2)}`,
      episodes.length > 0
        ? `\n## Recent memory\n${JSON.stringify(episodes, null, 2)}`
        : "",
      `\n## Workspace files (context)\n${JSON.stringify(contextSnippets, null, 2)}`,
      attachedContext.length > 0
        ? `\n## Attached files\n${JSON.stringify(attachedContext, null, 2)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    this.emitProgress("Generating response", editorModel, "✨");
    const response = await this.provider.chat({
      model: editorModel,
      format: "json",
      messages: [
        {
          role: "system",
          content:
            "Follow instructions exactly and produce valid JSON. Do not include markdown fences. Optimize for correctness, minimal diffs, and safe file operations.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });
    this.consumeTokens(response.tokenUsage);

    const parsed = parseTaskResponse(response.text);
    const normalizedEdits = parsed.edits
      .map((edit) =>
        normalizeEditPath(edit, vscode.workspace.workspaceFolders ?? []),
      )
      .filter((edit): edit is ProposedEdit => edit !== null);

    if (normalizedEdits.length > 0) {
      this.emitProgress(
        "Preparing edits",
        `${normalizedEdits.length} file change(s)`,
        "✏️",
      );
    }

    const proposal =
      normalizedEdits.length > 0
        ? await this.editManager.setPendingProposal(objective, normalizedEdits)
        : null;

    await this.sessionStore.appendMessage(session.id, {
      role: "assistant",
      content: parsed.response,
      createdAt: new Date().toISOString(),
    });
    await this.sessionStore.updateSessionResult(session.id, parsed.response);
    await this.learnFromExchange(objective, parsed.response, mode);
    if (this.currentConfig.memoryMode !== "off") {
      await this.memoryStore.addEpisode(
        objective,
        parsed.response.slice(0, 400),
      );
    }

    const taskDurAgent = Date.now() - taskStartAgent;
    this.selfReflectBackground(
      session.id,
      objective,
      parsed.response,
      true,
      taskDurAgent,
      mode,
      editorModel,
      normalizedEdits.length,
      proposal ? normalizedEdits.length : 0,
    );

    return {
      sessionId: session.id,
      objective,
      plan,
      responseText: parsed.response,
      proposal,
    };
  }

  /**
   * Apply pending edits. The permission policy is the single authority
   * for whether approval is needed. When `userApproved` is true the caller
   * has already obtained consent from the user.
   */
  public async applyPendingEdits(userApproved = false): Promise<string> {
    const decision = this.permissionPolicy.evaluate({
      action: "multi_file_edit",
      description: "Apply pending edit proposal",
    });

    if (!decision.allowed && !userApproved) {
      return "Approval required before applying pending edits.";
    }

    // Record approval if the user explicitly approved
    if (userApproved && !decision.allowed) {
      this.permissionPolicy.recordDecision(
        {
          action: "multi_file_edit",
          description: "Apply pending edit proposal",
        },
        true,
        false,
      );
    }

    const result = await this.editManager.applyPending();
    if (!result) {
      return "No pending proposal to apply.";
    }

    // Refresh git SCM after edits
    try {
      await this.gitService.refreshScm();
    } catch {
      /* non-fatal */
    }

    if (this.currentConfig.memoryMode !== "off") {
      await this.memoryStore.addEpisode(
        "apply_pending_edits",
        `Applied transaction ${result.id}`,
      );
    }

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
   */
  public needsApprovalForEdits(): boolean {
    const decision = this.permissionPolicy.evaluate({
      action: "multi_file_edit",
      description: "Apply pending edit proposal",
    });
    return !decision.allowed;
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
      this.resetTokenUsage();
    }

    return { deleted, wasActive };
  }

  public async startNewConversation(): Promise<void> {
    await this.sessionStore.clearActiveSession();
    await this.editManager.clearPendingProposal();
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
    const servers = await this.mcpManager.listServerStatus();
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
    const mcpStatuses = await this.mcpManager.listServerStatus();
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
    const mcpStatuses = await this.mcpManager.listServerStatus();
    const mcpConfigured = mcpStatuses.filter((s) => s.enabled).length;
    const mcpHealthy = mcpStatuses.filter(
      (s) => s.state === "configured",
    ).length;
    const tokenBudget = Math.max(this.currentConfig.maxContextTokens, 1);
    const tokenUsagePercent = Math.min(
      100,
      Math.round((this.tokensConsumed / tokenBudget) * 100),
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
      tokenBudget,
      tokensConsumed: this.tokensConsumed,
      tokenUsagePercent,
      mcpConfigured,
      mcpHealthy,
    };
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
    sessionId: string,
  ): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const session = await this.sessionStore.getSession(sessionId);
    const messages = session?.messages ?? [];
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

  private shouldAllowEdits(_objective: string): boolean {
    // In agent mode, always allow edits. The permission policy controls
    // whether the user must approve before applying — not whether the
    // agent may *propose* them. This matches GitHub Copilot's behaviour
    // where agent mode always generates edits when appropriate and the
    // permission level gates the apply step.
    return true;
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
    const timeSensitiveSignals = [
      "latest",
      "current",
      "recent",
      "today",
      "this week",
      "this month",
      "web",
      "online",
      "internet",
      "search",
      "docs",
      "documentation",
      "release",
      "release notes",
      "version",
      "news",
      "pricing",
      "api",
      "what changed",
      "up to date",
      "up-to-date",
      "official",
    ];

    if (timeSensitiveSignals.some((token) => normalized.includes(token))) {
      return true;
    }

    if (mode === "ask") {
      return [
        "what is",
        "who is",
        "how to",
        "how do i",
        "compare",
        "recommend",
        "best",
        "should i",
      ].some((token) => normalized.includes(token));
    }

    return (
      mode === "agent" &&
      ["package", "dependency", "sdk", "library", "framework", "docs"].some(
        (token) => normalized.includes(token),
      )
    );
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

function parseTaskResponse(raw: string): {
  response: string;
  edits: ProposedEdit[];
} {
  try {
    const parsed = JSON.parse(raw) as {
      response?: unknown;
      edits?: Array<{
        operation?: unknown;
        filePath?: unknown;
        targetPath?: unknown;
        content?: unknown;
        reason?: unknown;
      }>;
    };

    const response =
      typeof parsed.response === "string" ? parsed.response : "Task completed.";
    const edits: ProposedEdit[] = [];
    for (const edit of parsed.edits ?? []) {
      if (typeof edit.filePath !== "string") {
        continue;
      }

      const operation =
        edit.operation === "delete" || edit.operation === "move"
          ? edit.operation
          : "write";

      if (operation === "write" && typeof edit.content !== "string") {
        continue;
      }

      if (operation === "move" && typeof edit.targetPath !== "string") {
        continue;
      }

      edits.push({
        operation,
        filePath: edit.filePath,
        targetPath:
          typeof edit.targetPath === "string" ? edit.targetPath : undefined,
        content: typeof edit.content === "string" ? edit.content : undefined,
        reason: typeof edit.reason === "string" ? edit.reason : undefined,
      });
    }

    return { response, edits };
  } catch {
    return {
      response: raw,
      edits: [],
    };
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
