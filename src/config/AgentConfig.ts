import * as vscode from "vscode";

export type ApprovalMode = "strict" | "balanced" | "fast";
export type PermissionMode = "full" | "default" | "strict";
export type ConversationMode = "agent" | "ask" | "plan";
export type AgentPersona =
  | "software-engineer"
  | "data-scientist"
  | "designer"
  | "devops-engineer"
  | "researcher"
  | "full-stack-developer";

export interface McpServerConfig {
  id?: string;
  enabled?: boolean;
  trust?: string;
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
  [key: string]: unknown;
}

export type ProviderType = "ollama" | "openai" | "anthropic" | "custom";

export type PerformanceProfile = "auto" | "low_vram" | "balanced" | "high_vram";

export interface AgentConfig {
  providerType: ProviderType;
  ollamaBaseUrl: string;
  performanceProfile: PerformanceProfile;
  /** OpenAI-compatible endpoint URL (for openai/anthropic/custom providers). */
  openaiBaseUrl: string;
  /** API key for OpenAI-compatible providers. */
  openaiApiKey: string;
  /** Comma-separated model names for non-Ollama providers. */
  openaiModels: string[];
  plannerModel: string;
  editorModel: string;
  fastModel: string;
  embeddingModel: string;
  fallbackModels: string[];
  approvalMode: ApprovalMode;
  permissionMode: PermissionMode;
  conversationMode: ConversationMode;
  persona: AgentPersona;
  allowTerminalExecution: boolean;
  autoRunVerification: boolean;
  maxContextTokens: number;
  memoryMode: "off" | "session" | "workspace+episodic";
  indexingEnabled: boolean;
  indexingMode: "light" | "hybrid";
  mcpServers: McpServerConfig[];
  telemetryOptIn: boolean;
  selfLearnEnabled: boolean;
  /** Quality score target for the agent (0-1). Profile-aware default. */
  qualityTargetScore: number;
}

export function getAgentConfig(): AgentConfig {
  const cfg = vscode.workspace.getConfiguration("pulse");
  const ollamaDefaultUrl =
    process.platform === "win32"
      ? "http://127.0.0.1:11434"
      : "http://localhost:11434";

  return {
    providerType: cfg.get<ProviderType>("provider.type", "ollama"),
    ollamaBaseUrl: cfg.get<string>("ollama.baseUrl", ollamaDefaultUrl),
    performanceProfile: cfg.get<PerformanceProfile>(
      "performance.profile",
      "auto",
    ),
    openaiBaseUrl: cfg.get<string>(
      "provider.openaiBaseUrl",
      "https://api.openai.com",
    ),
    openaiApiKey: cfg.get<string>("provider.apiKey", ""),
    openaiModels: cfg.get<string[]>("provider.models", []),
    plannerModel: cfg.get<string>("models.planner", "deepseek-r1:7b"),
    editorModel: cfg.get<string>("models.editor", "qwen2.5-coder:7b"),
    fastModel: cfg.get<string>("models.fast", "qwen2.5-coder:7b"),
    embeddingModel: cfg.get<string>(
      "models.embedding",
      "nomic-embed-text:latest",
    ),
    fallbackModels: cfg.get<string[]>("models.fallbacks", [
      "qwen2.5-coder:7b",
      "nemotron-mini:latest",
    ]),
    approvalMode: cfg.get<ApprovalMode>("behavior.approvalMode", "balanced"),
    permissionMode: cfg.get<PermissionMode>(
      "behavior.permissionMode",
      "default",
    ),
    conversationMode: cfg.get<ConversationMode>(
      "behavior.conversationMode",
      "agent",
    ),
    persona: cfg.get<AgentPersona>("behavior.persona", "software-engineer"),
    allowTerminalExecution: cfg.get<boolean>(
      "behavior.allowTerminalExecution",
      true,
    ),
    autoRunVerification: cfg.get<boolean>("behavior.autoRunVerification", true),
    maxContextTokens: cfg.get<number>("behavior.maxContextTokens", 32768),
    memoryMode: cfg.get<"off" | "session" | "workspace+episodic">(
      "behavior.memoryMode",
      "workspace+episodic",
    ),
    indexingEnabled: cfg.get<boolean>("indexing.enabled", true),
    indexingMode: cfg.get<"light" | "hybrid">("indexing.mode", "hybrid"),
    mcpServers: cfg.get<McpServerConfig[]>("mcp.servers", []),
    telemetryOptIn: cfg.get<boolean>("telemetry.optIn", false),
    selfLearnEnabled: cfg.get<boolean>("behavior.selfLearn", true),
    qualityTargetScore: cfg.get<number>("behavior.qualityTargetScore", 0.9),
  };
}

/** Profile-aware runtime constants resolved from the performance profile. */
export interface ProfileDefaults {
  /** Context window size to pass as num_ctx to Ollama. */
  numCtx: number;
  /** keep_alive value for planner calls (seconds, 0 = unload immediately). */
  plannerKeepAlive: number;
  /** keep_alive value for editor calls (-1 = keep loaded). */
  editorKeepAlive: number;
  /** Per-iteration timeout in milliseconds for the agent loop. */
  iterationTimeoutMs: number;
  /** Extra time budget (ms) added to iteration 0 for cold model loads. */
  coldStartBonusMs: number;
  /** Maximum agent loop iterations. */
  maxAgentIterations: number;
  /** Quality score target override. */
  qualityTarget: number;
  /** Whether to use the same model for planner and editor. */
  useSingleModel: boolean;
  /** Max tokens for first agent iteration. */
  firstIterationMaxTokens: number;
  /** Max tokens for follow-up agent iterations. */
  followUpMaxTokens: number;
  /** Maximum number of no-action iterations before deterministic bootstrap. */
  noActionThreshold: number;
}

export function resolveProfileDefaults(config: AgentConfig): ProfileDefaults {
  const profile = config.performanceProfile;

  if (profile === "low_vram") {
    return {
      numCtx: 4096,
      plannerKeepAlive: 0,
      editorKeepAlive: 300,
      iterationTimeoutMs: 180_000,
      coldStartBonusMs: 120_000,
      maxAgentIterations: 12,
      qualityTarget:
        config.qualityTargetScore < 0.9 ? config.qualityTargetScore : 0.75,
      useSingleModel: config.plannerModel === config.editorModel,
      firstIterationMaxTokens: 2048,
      followUpMaxTokens: 1536,
      noActionThreshold: 3,
    };
  }

  if (profile === "balanced") {
    return {
      numCtx: 8192,
      plannerKeepAlive: 30,
      editorKeepAlive: -1,
      iterationTimeoutMs: 120_000,
      coldStartBonusMs: 60_000,
      maxAgentIterations: 12,
      qualityTarget: config.qualityTargetScore,
      useSingleModel: false,
      firstIterationMaxTokens: 3072,
      followUpMaxTokens: 2048,
      noActionThreshold: 3,
    };
  }

  if (profile === "high_vram") {
    return {
      numCtx: 16384,
      plannerKeepAlive: -1,
      editorKeepAlive: -1,
      iterationTimeoutMs: 90_000,
      coldStartBonusMs: 30_000,
      maxAgentIterations: 12,
      qualityTarget: config.qualityTargetScore,
      useSingleModel: false,
      firstIterationMaxTokens: 4096,
      followUpMaxTokens: 3072,
      noActionThreshold: 2,
    };
  }

  // "auto" — assume low-VRAM conservatism for local Ollama, balanced otherwise
  if (config.providerType === "ollama") {
    return {
      numCtx: 4096,
      plannerKeepAlive: 0,
      editorKeepAlive: 300,
      iterationTimeoutMs: 180_000,
      coldStartBonusMs: 120_000,
      maxAgentIterations: 12,
      qualityTarget:
        config.qualityTargetScore < 0.9 ? config.qualityTargetScore : 0.8,
      useSingleModel: config.plannerModel === config.editorModel,
      firstIterationMaxTokens: 2048,
      followUpMaxTokens: 1536,
      noActionThreshold: 3,
    };
  }

  // Non-Ollama auto → balanced
  return {
    numCtx: 8192,
    plannerKeepAlive: -1,
    editorKeepAlive: -1,
    iterationTimeoutMs: 120_000,
    coldStartBonusMs: 60_000,
    maxAgentIterations: 12,
    qualityTarget: config.qualityTargetScore,
    useSingleModel: false,
    firstIterationMaxTokens: 3072,
    followUpMaxTokens: 2048,
    noActionThreshold: 3,
  };
}
