import type { EditProposal } from "../edits/EditManager";
import type { TaskPlan } from "../planner/Planner";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export type ConversationMode = "agent" | "ask" | "plan";

export interface AgentProgressStep {
  icon: string;
  step: string;
  detail?: string;
}

export interface RuntimeTaskResult {
  sessionId: string;
  objective: string;
  plan: TaskPlan;
  responseText: string;
  proposal: EditProposal | null;
  artifactPath?: string;
}

export interface ExplainResult {
  text: string;
  model: string;
}
