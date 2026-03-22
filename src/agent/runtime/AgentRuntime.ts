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
import type { ExplainResult, RuntimeTaskResult } from "./RuntimeTypes";
import { SessionStore } from "../sessions/SessionStore";
import { VerificationRunner } from "../verification/VerificationRunner";

export interface RuntimeSummary {
  status: "ready" | "degraded";
  plannerModel: string;
  editorModel: string;
  fastModel: string;
  approvalMode: "strict" | "balanced" | "fast";
  storagePath: string;
  ollamaHealth: string;
  modelCount: number;
  activeSessionId: string | null;
  hasPendingEdits: boolean;
}

export interface RecentSessionItem {
  id: string;
  title: string;
  updatedAt: string;
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

  private currentConfig: AgentConfig;

  private health: ProviderHealth = { ok: false, message: "Not checked" };

  private availableModels: ModelSummary[] = [];

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
  }

  public async initialize(): Promise<void> {
    this.health = await this.provider.healthCheck();
    if (this.health.ok) {
      try {
        this.availableModels = await this.provider.listModels();
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
    }
  }

  public async listAvailableModels(): Promise<ModelSummary[]> {
    if (this.availableModels.length === 0 && this.health.ok) {
      this.availableModels = await this.provider.listModels();
    }
    return this.availableModels;
  }

  public async selectModel(role: ModelRole, modelName: string): Promise<void> {
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
    const response = await this.provider.chat({
      model: this.currentConfig.fastModel,
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

    return {
      text: response.text,
      model: this.currentConfig.fastModel,
    };
  }

  public async runTask(objective: string): Promise<RuntimeTaskResult> {
    const session = await this.sessionStore.createSession(objective, {
      planner: this.currentConfig.plannerModel,
      editor: this.currentConfig.editorModel,
      fast: this.currentConfig.fastModel,
    });

    const plan = await this.planner.createPlan(
      objective,
      this.currentConfig.plannerModel,
    );
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
      JSON.stringify(contextSnippets, null, 2),
    ].join("\n\n");

    const response = await this.provider.chat({
      model: this.currentConfig.editorModel,
      format: "json",
      messages: [
        {
          role: "system",
          content:
            "Follow instructions exactly and produce valid JSON. Do not include markdown fences.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

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

  public async applyPendingEdits(): Promise<string> {
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

  public async reindexWorkspace(): Promise<string> {
    const stats = await this.scanner.scanWorkspace();
    return `Indexed ${stats.totalFiles} files at ${stats.indexedAt}`;
  }

  public diagnosticsSummary(): string {
    const result = this.verifier.runDiagnostics();
    return result.summary;
  }

  public mcpSummary(): string {
    const servers = this.mcpManager.listServerStatus();
    if (servers.length === 0) {
      return "No MCP servers configured.";
    }

    return servers
      .map(
        (server) =>
          `${server.id}: ${server.state} (transport=${server.transport}, trust=${server.trust})`,
      )
      .join("\n");
  }

  public async diagnosticsReportMarkdown(): Promise<string> {
    const pendingSummary = await this.getPendingProposalSummary();
    const activeSession = await this.resumeLastSessionSummary();
    const mcp = this.mcpSummary();
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
      "```",
    ].join("\n");
  }

  public async summary(): Promise<RuntimeSummary> {
    const active = await this.sessionStore.getActiveSession();
    const pending = await this.editManager.getPendingProposal();
    return {
      status: this.health.ok ? "ready" : "degraded",
      plannerModel: this.currentConfig.plannerModel,
      editorModel: this.currentConfig.editorModel,
      fastModel: this.currentConfig.fastModel,
      approvalMode: this.currentConfig.approvalMode,
      storagePath: this.storage.storageDir,
      ollamaHealth: this.health.message,
      modelCount: this.availableModels.length,
      activeSessionId: active?.id ?? null,
      hasPendingEdits: pending !== null,
    };
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
