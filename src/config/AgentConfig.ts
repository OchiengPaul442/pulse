import * as vscode from "vscode";

export type ApprovalMode = "strict" | "balanced" | "fast";

export interface AgentConfig {
  ollamaBaseUrl: string;
  plannerModel: string;
  editorModel: string;
  fastModel: string;
  embeddingModel: string;
  fallbackModels: string[];
  approvalMode: ApprovalMode;
  allowTerminalExecution: boolean;
  autoRunVerification: boolean;
  maxContextTokens: number;
  memoryMode: "off" | "session" | "workspace+episodic";
  indexingEnabled: boolean;
  indexingMode: "light" | "hybrid";
  mcpServers: Array<Record<string, unknown>>;
  telemetryOptIn: boolean;
}

export function getAgentConfig(): AgentConfig {
  const cfg = vscode.workspace.getConfiguration("pulse");

  return {
    ollamaBaseUrl: cfg.get<string>("ollama.baseUrl", "http://localhost:11434"),
    plannerModel: cfg.get<string>("models.planner", "qwen2.5-coder:14b"),
    editorModel: cfg.get<string>("models.editor", "deepseek-coder-v2:16b"),
    fastModel: cfg.get<string>("models.fast", "qwen2.5-coder:7b"),
    embeddingModel: cfg.get<string>("models.embedding", "nomic-embed-text"),
    fallbackModels: cfg.get<string[]>("models.fallbacks", ["qwen2.5-coder:7b"]),
    approvalMode: cfg.get<ApprovalMode>("behavior.approvalMode", "balanced"),
    allowTerminalExecution: cfg.get<boolean>(
      "behavior.allowTerminalExecution",
      false,
    ),
    autoRunVerification: cfg.get<boolean>("behavior.autoRunVerification", true),
    maxContextTokens: cfg.get<number>("behavior.maxContextTokens", 32000),
    memoryMode: cfg.get<"off" | "session" | "workspace+episodic">(
      "behavior.memoryMode",
      "workspace+episodic",
    ),
    indexingEnabled: cfg.get<boolean>("indexing.enabled", true),
    indexingMode: cfg.get<"light" | "hybrid">("indexing.mode", "hybrid"),
    mcpServers: cfg.get<Array<Record<string, unknown>>>("mcp.servers", []),
    telemetryOptIn: cfg.get<boolean>("telemetry.optIn", false),
  };
}
