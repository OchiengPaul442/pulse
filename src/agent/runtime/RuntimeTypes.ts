import type { EditProposal } from "../edits/EditManager";
import type { TaskPlan } from "../planner/Planner";

export interface RuntimeTaskResult {
  sessionId: string;
  objective: string;
  plan: TaskPlan;
  responseText: string;
  proposal: EditProposal | null;
}

export interface ExplainResult {
  text: string;
  model: string;
}
