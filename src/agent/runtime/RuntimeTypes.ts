import type { EditProposal } from "../edits/EditManager";
import type { TaskPlan } from "../planner/Planner";
import type { TaskTodo } from "./TaskProtocols";
import type { TaskToolObservation } from "./TaskProtocols";

export interface ConversationMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface RunTaskRequest {
  objective: string;
  action?: "new" | "edit" | "retry";
  messageId?: string;
}

export type ConversationMode = "agent" | "ask" | "plan";

export interface AgentProgressStep {
  icon: string;
  step: string;
  detail?: string;
}

/** Lightweight token-usage snapshot pushed to the webview in real time. */
export interface TokenSnapshot {
  consumed: number;
  budget: number;
  percent: number;
}

export interface RuntimeTaskResult {
  sessionId: string;
  objective: string;
  plan: TaskPlan;
  todos: TaskTodo[];
  shortcuts?: string[];
  responseText: string;
  proposal: EditProposal | null;
  artifactPath?: string;
  autoApplied?: boolean;
  toolSummary?: string;
  toolTrace?: TaskToolObservation[];
  qualityScore?: number;
  qualityTarget?: number;
  meetsQualityTarget?: boolean;
}

export interface ExplainResult {
  text: string;
  model: string;
}
