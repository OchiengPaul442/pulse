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

export interface AgentConfig {
  ollamaBaseUrl: string;
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
}

export function getAgentConfig(): AgentConfig {
  const cfg = vscode.workspace.getConfiguration("pulse");
  const ollamaDefaultUrl =
    process.platform === "win32"
      ? "http://127.0.0.1:11434"
      : "http://localhost:11434";

  return {
    ollamaBaseUrl: cfg.get<string>("ollama.baseUrl", ollamaDefaultUrl),
    plannerModel: cfg.get<string>("models.planner", "qwen2.5-coder:7b"),
    editorModel: cfg.get<string>("models.editor", "qwen2.5-coder:7b"),
    fastModel: cfg.get<string>("models.fast", "qwen2.5-coder:7b"),
    embeddingModel: cfg.get<string>("models.embedding", "nomic-embed-text"),
    fallbackModels: cfg.get<string[]>("models.fallbacks", ["qwen2.5-coder:7b"]),
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
      false,
    ),
    autoRunVerification: cfg.get<boolean>("behavior.autoRunVerification", true),
    maxContextTokens: cfg.get<number>("behavior.maxContextTokens", 16384),
    memoryMode: cfg.get<"off" | "session" | "workspace+episodic">(
      "behavior.memoryMode",
      "workspace+episodic",
    ),
    indexingEnabled: cfg.get<boolean>("indexing.enabled", true),
    indexingMode: cfg.get<"light" | "hybrid">("indexing.mode", "hybrid"),
    mcpServers: cfg.get<McpServerConfig[]>("mcp.servers", []),
    telemetryOptIn: cfg.get<boolean>("telemetry.optIn", false),
  };
}
