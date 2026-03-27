import type { ProposedEdit } from "../edits/EditManager";

export const TARGET_TASK_QUALITY_SCORE = 0.9;

export type TaskTodoStatus = "pending" | "in-progress" | "blocked" | "done";

export interface TaskTodo {
  id: string;
  title: string;
  status: TaskTodoStatus;
  detail?: string;
}

export type TaskToolName =
  | "workspace_scan"
  | "read_files"
  | "run_terminal"
  | "run_verification"
  | "web_search"
  | "git_diff"
  | "mcp_status"
  | "diagnostics";

export interface TaskToolCall {
  tool: TaskToolName;
  args: Record<string, unknown>;
  reason?: string;
}

export interface TaskToolObservation {
  tool: TaskToolName;
  ok: boolean;
  summary: string;
  detail?: string;
}

export interface TaskQualityAssessment {
  score: number;
  target: number;
  meetsTarget: boolean;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
}

export interface TaskQualityContext {
  objective: string;
  toolTrace: TaskToolObservation[];
  editCount: number;
  verificationRan: boolean;
  isEditTask: boolean;
}

export interface TaskModelResponse {
  response: string;
  todos: TaskTodo[];
  toolCalls: TaskToolCall[];
  edits: ProposedEdit[];
  shortcuts: string[];
}

const TOOL_ALIASES: Record<string, TaskToolName> = {
  workspace_scan: "workspace_scan",
  scan_workspace: "workspace_scan",
  list_files: "workspace_scan",
  read_files: "read_files",
  read_file: "read_files",
  inspect_files: "read_files",
  run_terminal: "run_terminal",
  terminal: "run_terminal",
  shell: "run_terminal",
  execute_terminal: "run_terminal",
  terminal_exec: "run_terminal",
  run_verification: "run_verification",
  verification: "run_verification",
  verify: "run_verification",
  web_search: "web_search",
  search_web: "web_search",
  git_diff: "git_diff",
  git_status: "git_diff",
  git: "git_diff",
  mcp_status: "mcp_status",
  mcp: "mcp_status",
  diagnostics: "diagnostics",
  run_diagnostics: "diagnostics",
};

export function parseTaskResponse(raw: string): TaskModelResponse {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const response =
      typeof parsed.response === "string" && parsed.response.trim().length > 0
        ? parsed.response.trim()
        : raw.trim().length > 0
          ? raw.trim()
          : "Task completed.";

    return {
      response,
      todos: normalizeTodos(parsed.todos),
      toolCalls: normalizeToolCalls(parsed.toolCalls),
      edits: normalizeEdits(parsed.edits),
      shortcuts: normalizeShortcuts(parsed.shortcuts),
    };
  } catch {
    return {
      response: raw.trim().length > 0 ? raw.trim() : "Task completed.",
      todos: [],
      toolCalls: [],
      edits: [],
      shortcuts: [],
    };
  }
}

export function normalizeTodos(value: unknown): TaskTodo[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry, index) => normalizeTodoEntry(entry, index))
    .filter((entry): entry is TaskTodo => entry !== null);
}

export function normalizeToolCalls(value: unknown): TaskToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeToolCall(entry))
    .filter((entry): entry is TaskToolCall => entry !== null);
}

export function normalizeEdits(value: unknown): ProposedEdit[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const edits: ProposedEdit[] = [];
  for (const edit of value) {
    if (!edit || typeof edit !== "object") {
      continue;
    }

    const candidate = edit as Record<string, unknown>;
    if (typeof candidate.filePath !== "string") {
      continue;
    }

    const operation =
      candidate.operation === "delete" || candidate.operation === "move"
        ? candidate.operation
        : "write";

    if (operation === "write" && typeof candidate.content !== "string") {
      continue;
    }

    if (operation === "move" && typeof candidate.targetPath !== "string") {
      continue;
    }

    edits.push({
      operation,
      filePath: candidate.filePath,
      targetPath:
        typeof candidate.targetPath === "string"
          ? candidate.targetPath
          : undefined,
      content:
        typeof candidate.content === "string" ? candidate.content : undefined,
      reason:
        typeof candidate.reason === "string" ? candidate.reason : undefined,
    });
  }

  return edits;
}

export function isSafeTerminalCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return false;
  }

  const shellControlPattern = /(?:&&|\|\||;|`|\$\(|\r|\n|>|<|\|)/;
  if (shellControlPattern.test(normalized) || /(^|\s)&(?!&)/.test(normalized)) {
    return false;
  }

  const unsafePatterns = [
    /\brm\s+-rf\b/,
    /\bdel\s+\/f?\b/,
    /\bremove-item\b.*\b-recurse\b.*\b-force\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\s+-fdx\b/,
    /\bformat\s+[a-z]:/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bpoweroff\b/,
    /\bmkfs\b/,
    /\bdd\s+if=/,
    /\bnpm\s+install\b/,
    /\byarn\s+add\b/,
    /\bpnpm\s+add\b/,
    /\bpip\s+install\b/,
    /\bgo\s+get\b/,
    /\bcargo\s+add\b/,
    /\bcurl\s+https?:\/\//,
    /\bwget\s+https?:\/\//,
    /\binvoke-webrequest\b/,
    /\bremove-item\b.*\b-recurse\b/,
  ];

  if (unsafePatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const safePatterns = [
    /\bgit\s+(status|diff|log|show|blame)\b/,
    /\bnpm\s+(test|run\s+(test|build|compile|lint|typecheck|check))\b/,
    /\bnpm\s+exec\s+tsc\b/,
    /\bnpx\s+tsc\b/,
    /\bpnpm\s+(test|run\s+(test|build|compile|lint|typecheck|check))\b/,
    /\byarn\s+(test|run\s+(test|build|compile|lint|typecheck|check))\b/,
    /\btsc(\s|$)/,
    /\bvitest(\s|$)/,
    /\bpytest(\s|$)/,
    /\bpython\s+-m\s+pytest\b/,
    /\bdotnet\s+test\b/,
    /\bgo\s+test\b/,
    /\bcargo\s+test\b/,
    /\brg\b/,
    /\bls\b/,
    /\bdir\b/,
    /\bfind\b/,
  ];

  return safePatterns.some((pattern) => pattern.test(normalized));
}

export function formatToolObservations(
  observations: TaskToolObservation[],
): string {
  if (observations.length === 0) {
    return "";
  }

  return [
    "## Tool results",
    ...observations.map((observation) => {
      const lines = [
        `- [${observation.ok ? "ok" : "blocked"}] ${observation.tool}: ${observation.summary}`,
      ];
      if (observation.detail) {
        lines.push(`  ${observation.detail}`);
      }
      return lines.join("\n");
    }),
  ].join("\n");
}

export function formatCompactTodos(todos: TaskTodo[]): string {
  if (todos.length === 0) {
    return "";
  }

  const lines = ["## TODOs"];
  for (const todo of todos.slice(0, 5)) {
    const marker = todo.status === "done" ? "x" : " ";
    const detail = todo.detail ? ` — ${todo.detail}` : "";
    lines.push(`- [${marker}] ${compactText(todo.title)}${detail}`);
  }

  return lines.join("\n");
}

export function formatShortcutHints(shortcuts: string[]): string {
  const uniqueShortcuts = Array.from(
    new Set(
      shortcuts
        .map((shortcut) => compactText(shortcut))
        .filter((shortcut) => shortcut.length > 0),
    ),
  );

  if (uniqueShortcuts.length === 0) {
    return "";
  }

  return [
    "## Shortcuts",
    `Optional quick actions: ${uniqueShortcuts
      .slice(0, 6)
      .map((shortcut) => `\`${shortcut}\``)
      .join(" · ")}`,
  ].join("\n");
}

export function assessTaskQuality(
  response: TaskModelResponse,
  context: TaskQualityContext,
): TaskQualityAssessment {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const recommendations: string[] = [];
  let score = 0.35;

  if (response.response.trim().length > 0) {
    score += 0.08;
    strengths.push("Has a concrete response");
  } else {
    weaknesses.push("Missing final response text");
    recommendations.push("Always summarize what changed or what was found.");
  }

  if (response.todos.length > 0) {
    score += 0.12;
    strengths.push("Includes a todo checklist");
  } else {
    weaknesses.push("No todo checklist was produced");
    recommendations.push(
      "Generate a short todo list before and during execution.",
    );
  }

  if (response.toolCalls.length > 0) {
    score += 0.12;
    strengths.push("Requests tool-backed evidence");
  } else if (context.isEditTask) {
    weaknesses.push(
      "No tool usage was requested for a task that likely needed evidence",
    );
    recommendations.push(
      "Use workspace, file, verification, or terminal tools when the task changes code.",
    );
  }

  if (context.toolTrace.length > 0) {
    score += 0.12;
    strengths.push("Collected tool observations");
  } else if (context.isEditTask) {
    weaknesses.push("No tool observations were collected");
    recommendations.push(
      "Gather context or verification before finalizing the result.",
    );
  }

  if (context.verificationRan) {
    score += 0.16;
    strengths.push("Ran verification");
  } else if (context.isEditTask) {
    weaknesses.push("Verification did not run for an edit task");
    recommendations.push(
      "Run a safe build, test, lint, or diagnostics check before finalizing.",
    );
  }

  if (context.editCount > 0) {
    score += 0.12;
    strengths.push("Proposed workspace edits");
  } else if (context.isEditTask) {
    weaknesses.push("No edits were produced for an edit task");
    recommendations.push(
      "If the task is a bug fix or implementation, propose the smallest correct edit set.",
    );
  }

  if (response.response.length > 180) {
    score += 0.05;
    strengths.push("Provides enough explanation to be actionable");
  } else if (context.isEditTask) {
    weaknesses.push("Response is very terse for a code task");
    recommendations.push(
      "Explain the change and the verification result in one or two brief paragraphs.",
    );
  }

  if (response.toolCalls.some((call) => call.tool === "run_terminal")) {
    score += 0.05;
    strengths.push("Uses terminal execution when needed");
  }

  const blockedTools = context.toolTrace.filter(
    (observation) => !observation.ok,
  );
  if (blockedTools.length > 0) {
    score -= Math.min(0.15, blockedTools.length * 0.03);
    weaknesses.push("Some tool calls were blocked or failed");
    recommendations.push("Revise the tool choice or command before retrying.");
  }

  if (
    /\b(fix|bug|error|crash|test|build|compile|refactor|implement|add|update)\b/i.test(
      context.objective,
    )
  ) {
    score += 0.04;
  }

  score = Math.max(0, Math.min(1, score));

  return {
    score,
    target: TARGET_TASK_QUALITY_SCORE,
    meetsTarget: score >= TARGET_TASK_QUALITY_SCORE,
    strengths,
    weaknesses,
    recommendations: Array.from(new Set(recommendations)),
  };
}

export function formatTaskQualityAssessment(
  assessment: TaskQualityAssessment,
): string {
  return [
    `Quality score: ${assessment.score.toFixed(2)} / ${assessment.target.toFixed(2)}`,
    `Meets target: ${assessment.meetsTarget ? "yes" : "no"}`,
    assessment.strengths.length > 0
      ? `Strengths: ${assessment.strengths.join("; ")}`
      : "Strengths: none",
    assessment.weaknesses.length > 0
      ? `Weaknesses: ${assessment.weaknesses.join("; ")}`
      : "Weaknesses: none",
    assessment.recommendations.length > 0
      ? `Recommendations: ${assessment.recommendations.join("; ")}`
      : "Recommendations: none",
  ].join("\n");
}

export function buildTaskRefinementPrompt(
  objective: string,
  previous: TaskModelResponse,
  assessment: TaskQualityAssessment,
  observations: TaskToolObservation[],
): string {
  const toolSummary = formatToolObservations(observations);
  return [
    "You are refining a coding-agent task response.",
    "Improve the JSON so it is more complete, more accurate, and more actionable.",
    "Preserve any valid edits, todos, and tool calls that still make sense.",
    "Address the weaknesses and recommendations exactly.",
    "Return valid JSON only with fields: response, todos, toolCalls, edits.",
    `Objective: ${objective}`,
    `Previous response: ${JSON.stringify(previous, null, 2)}`,
    `Assessment:\n${formatTaskQualityAssessment(assessment)}`,
    toolSummary ? `Tool observations:\n${toolSummary}` : "",
  ]
    .filter((value) => value.length > 0)
    .join("\n");
}

function normalizeTodoEntry(entry: unknown, index: number): TaskTodo | null {
  if (typeof entry === "string") {
    const title = entry.trim();
    if (!title) {
      return null;
    }

    return {
      id: `todo_${index + 1}`,
      title,
      status: "pending",
    };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = entry as Record<string, unknown>;
  const title = firstString(
    candidate.title,
    candidate.text,
    candidate.description,
    candidate.task,
  );
  if (!title) {
    return null;
  }

  const statusRaw = firstString(candidate.status)?.toLowerCase();
  const status: TaskTodoStatus =
    statusRaw === "in-progress" ||
    statusRaw === "blocked" ||
    statusRaw === "done"
      ? statusRaw
      : "pending";

  return {
    id: firstString(candidate.id) ?? `todo_${index + 1}`,
    title: compactText(title),
    status,
    detail: firstString(candidate.detail, candidate.reason),
  };
}

function normalizeShortcuts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === "string" ? compactText(entry) : ""))
        .filter((entry) => entry.length > 0),
    ),
  );
}

function normalizeToolCall(entry: unknown): TaskToolCall | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = entry as Record<string, unknown>;
  const rawTool = firstString(candidate.tool, candidate.name, candidate.type);
  if (!rawTool) {
    return null;
  }

  const tool = TOOL_ALIASES[rawTool.toLowerCase()];
  if (!tool) {
    return null;
  }

  const args =
    candidate.args && typeof candidate.args === "object"
      ? (candidate.args as Record<string, unknown>)
      : {};

  return {
    tool,
    args,
    reason: firstString(candidate.reason, candidate.description),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function compactText(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[-*\d.\s]+/, "")
    .replace(/\b(?:please|kindly|just)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.。]+$/, "");
}
