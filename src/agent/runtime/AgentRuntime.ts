import * as path from "path";
import * as vscode from "vscode";

import type { AgentConfig } from "../../config/AgentConfig";
import type { StorageState } from "../../db/StorageBootstrap";
import type { Logger } from "../../platform/vscode/Logger";
import { EditManager, type ProposedEdit } from "../edits/EditManager";
import { WorkspaceScanner } from "../indexing/WorkspaceScanner";
import { McpManager } from "../mcp/McpManager";
import { OllamaProvider } from "../model/OllamaProvider";
import type { ModelSummary, ProviderHealth } from "../model/ModelProvider";
import { MemoryStore } from "../memory/MemoryStore";
import { Planner } from "../planner/Planner";
import { SkillRegistry, type SkillManifest } from "../skills/SkillRegistry";
import type { ExplainResult, RuntimeTaskResult } from "./RuntimeTypes";
import { SessionStore } from "../sessions/SessionStore";
import { VerificationRunner } from "../verification/VerificationRunner";

export interface RuntimeSummary {
  status: "ready" | "degraded";
  plannerModel: string;
  editorModel: string;
  fastModel: string;
  embeddingModel: string;
  approvalMode: "strict" | "balanced" | "fast";
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

  private currentConfig: AgentConfig;

  private health: ProviderHealth = { ok: false, message: "Not checked" };

  private availableModels: ModelSummary[] = [];

  private tokensConsumed = 0;

  public constructor(
    config: AgentConfig,
    private readonly storage: StorageState,
    private readonly logger: Logger,
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
  }

  public async initialize(): Promise<void> {
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

  public async refreshProviderState(): Promise<void> {
    this.health = await this.provider.healthCheck();
    if (this.health.ok) {
      this.availableModels = await this.provider.listModels();
      this.availableModels = this.mergeConfiguredModels(this.availableModels);
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

  public async selectModel(role: ModelRole, modelName: string): Promise<void> {
    const models = await this.listAvailableModels();
    if (!models.some((model) => model.name === modelName)) {
      throw new Error(
        `Model ${modelName} is not available locally. Sync models and try again.`,
      );
    }

    const cfg = vscode.workspace.getConfiguration("pulse");
    const targetKey =
      role === "planner"
        ? "models.planner"
        : role === "editor"
          ? "models.editor"
          : role === "fast"
            ? "models.fast"
            : "models.embedding";

    await cfg.update(
      targetKey,
      modelName,
      vscode.ConfigurationTarget.Workspace,
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

  public async runTask(objective: string): Promise<RuntimeTaskResult> {
    const session = await this.sessionStore.createSession(objective, {
      planner: this.currentConfig.plannerModel,
      editor: this.currentConfig.editorModel,
      fast: this.currentConfig.fastModel,
    });

    const plannerModel = await this.resolveModelOrFallback(
      this.currentConfig.plannerModel,
    );
    const editorModel = await this.resolveModelOrFallback(
      this.currentConfig.editorModel,
    );

    const plan = await this.planner.createPlan(objective, plannerModel);
    const selectedSkills = this.skillRegistry.selectForObjective(objective);
    const candidateFiles = await this.scanner.findRelevantFiles(objective, 8);
    const contextSnippets = await this.scanner.readContextSnippets(
      candidateFiles.slice(0, 4),
      2400,
    );
    const episodes =
      this.currentConfig.memoryMode === "off"
        ? []
        : await this.memoryStore.latestEpisodes(3);

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
      "Selected skills:",
      this.skillRegistry.summarizeSelection(selectedSkills),
      "Skill manifests:",
      JSON.stringify(selectedSkills.selected, null, 2),
      "Plan:",
      JSON.stringify(plan, null, 2),
      "Recent episodic memory:",
      JSON.stringify(episodes, null, 2),
      "Context snippets:",
      JSON.stringify(contextSnippets, null, 2),
    ].join("\n\n");

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

    const proposal =
      normalizedEdits.length > 0
        ? await this.editManager.setPendingProposal(objective, normalizedEdits)
        : null;

    await this.sessionStore.updateSessionResult(session.id, parsed.response);
    if (this.currentConfig.memoryMode !== "off") {
      await this.memoryStore.addEpisode(
        objective,
        parsed.response.slice(0, 400),
      );
    }

    return {
      sessionId: session.id,
      objective,
      plan,
      responseText: parsed.response,
      proposal,
    };
  }

  public async applyPendingEdits(userApproved = false): Promise<string> {
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
    return this.currentConfig.approvalMode;
  }

  public async setApprovalMode(
    mode: "strict" | "balanced" | "fast",
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("pulse");
    await cfg.update(
      "behavior.approvalMode",
      mode,
      vscode.ConfigurationTarget.Workspace,
    );
    this.currentConfig.approvalMode = mode;
    await this.memoryStore.setPreference("approval.mode", mode);
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
    }));
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

    this.tokensConsumed += Math.max(usage.totalTokens, 0);
  }

  private async resolveModelOrFallback(primary: string): Promise<string> {
    const models = await this.listAvailableModels();
    const names = new Set(models.map((model) => model.name));
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

    if (models[0]?.name) {
      this.logger.warn(
        `Model ${primary} unavailable. Falling back to first discovered model ${models[0].name}.`,
      );
      return models[0].name;
    }

    return primary;
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
