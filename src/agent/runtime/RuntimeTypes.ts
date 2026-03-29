import type { FileDiffResult } from "../edits/DiffEngine";
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
  images?: Array<{ name: string; dataUrl: string }>;
}

export type ConversationMode = "agent" | "ask" | "plan";

export interface AgentProgressStep {
  icon: string;
  step: string;
  detail?: string;
  /** Distinguishes how the UI renders this step */
  kind?:
    | "step"
    | "reasoning"
    | "file_patch"
    | "file_patched"
    | "terminal"
    | "tool"
    | "todo_update"
    | "files_changed";
  /** For file_patch / file_patched: the file's basename */
  file?: string;
  /** For file_patch: total line count of new content */
  lineCount?: number;
  /** For file_patched: lines added (new content line count) */
  linesAdded?: number;
  /** For file_patched: lines removed (0 when not computed) */
  linesRemoved?: number;
  /** For todo_update: current state of all todos */
  todos?: TaskTodo[];
  /** For files_changed: list of changed files with stats */
  files?: Array<{ path: string; additions: number; deletions: number }>;
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
  fileDiffs?: FileDiffResult[];
  qualityScore?: number;
  qualityTarget?: number;
  meetsQualityTarget?: boolean;
}

export interface ExplainResult {
  text: string;
  model: string;
}
