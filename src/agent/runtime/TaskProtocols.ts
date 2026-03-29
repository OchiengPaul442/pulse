import type { ProposedEdit } from "../edits/EditManager";

export const TARGET_TASK_QUALITY_SCORE = 0.9;

/**
 * JSON Schema for structured output mode. When passed to Ollama's `format`
 * parameter, the model is constrained to emit only valid JSON matching this
 * schema, which eliminates markdown fencing and malformed output on local
 * models like deepseek-r1 and qwen2.5-coder.
 */
export const TASK_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    activeTodoId: { type: "string" },
    response: { type: "string" },
    todos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          status: {
            type: "string",
            enum: ["pending", "in-progress", "blocked", "done"],
          },
          detail: { type: "string" },
        },
        required: ["id", "title", "status"],
      },
    },
    toolCalls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tool: { type: "string" },
          args: { type: "object" },
          reason: { type: "string" },
          todoId: { type: "string" },
          expectedOutcome: { type: "string" },
        },
        required: ["tool", "args"],
      },
    },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          content: { type: "string" },
          operation: { type: "string" },
          reason: { type: "string" },
        },
        required: ["filePath"],
      },
    },
    shortcuts: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["response", "todos", "toolCalls", "edits", "shortcuts"],
};

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
  | "create_file"
  | "delete_file"
  | "search_files"
  | "list_dir"
  | "run_terminal"
  | "run_verification"
  | "web_search"
  | "git_diff"
  | "mcp_status"
  | "diagnostics"
  | "batch_edit"
  | "rename_file"
  | "find_references"
  | "file_search"
  | "get_problems"
  | "get_terminal_output";

export interface TaskToolCall {
  tool: TaskToolName;
  args: Record<string, unknown>;
  reason?: string;
  todoId?: string;
  expectedOutcome?: string;
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
  scan: "workspace_scan",
  read_files: "read_files",
  read_file: "read_files",
  inspect_files: "read_files",
  view_file: "read_files",
  open_file: "read_files",
  get_file: "read_files",
  file_read: "read_files",
  cat: "read_files",
  create_file: "create_file",
  write_file: "create_file",
  new_file: "create_file",
  save_file: "create_file",
  file_write: "create_file",
  file_create: "create_file",
  edit_file: "create_file",
  update_file: "create_file",
  delete_file: "delete_file",
  remove_file: "delete_file",
  rm: "delete_file",
  file_delete: "delete_file",
  search_files: "search_files",
  grep: "search_files",
  find_in_files: "search_files",
  search: "search_files",
  search_code: "search_files",
  find: "search_files",
  ripgrep: "search_files",
  list_dir: "list_dir",
  list_directory: "list_dir",
  ls: "list_dir",
  dir: "list_dir",
  readdir: "list_dir",
  run_terminal: "run_terminal",
  terminal: "run_terminal",
  shell: "run_terminal",
  execute_terminal: "run_terminal",
  terminal_exec: "run_terminal",
  exec: "run_terminal",
  execute: "run_terminal",
  run_command: "run_terminal",
  command: "run_terminal",
  bash: "run_terminal",
  cmd: "run_terminal",
  run: "run_terminal",
  run_verification: "run_verification",
  verification: "run_verification",
  verify: "run_verification",
  test: "run_verification",
  build: "run_verification",
  lint: "run_verification",
  check: "run_verification",
  web_search: "web_search",
  search_web: "web_search",
  browse: "web_search",
  internet: "web_search",
  google: "web_search",
  git_diff: "git_diff",
  git_status: "git_diff",
  git: "git_diff",
  diff: "git_diff",
  mcp_status: "mcp_status",
  mcp: "mcp_status",
  diagnostics: "diagnostics",
  run_diagnostics: "diagnostics",
  check_errors: "diagnostics",
  errors: "diagnostics",
  batch_edit: "batch_edit",
  multi_edit: "batch_edit",
  multi_file_edit: "batch_edit",
  edit_files: "batch_edit",
  rename_file: "rename_file",
  rename: "rename_file",
  move_file: "rename_file",
  mv: "rename_file",
  find_references: "find_references",
  references: "find_references",
  usages: "find_references",
  find_usages: "find_references",
  file_search: "file_search",
  find_file: "file_search",
  locate_file: "file_search",
  glob: "file_search",
  get_problems: "get_problems",
  problems: "get_problems",
  get_errors: "get_problems",
  lsp_errors: "get_problems",
  get_terminal_output: "get_terminal_output",
  terminal_output: "get_terminal_output",
  terminal_last: "get_terminal_output",
  // Common local model hallucinations / alternate names
  write: "create_file",
  create: "create_file",
  read: "read_files",
  delete: "delete_file",
  remove: "delete_file",
  install: "run_terminal",
  test_project: "run_verification",
  build_project: "run_verification",
};

export function parseTaskResponse(raw: string): TaskModelResponse {
  // Try direct JSON parse first
  const directParsed = tryParseJson(raw);
  if (directParsed) {
    return buildModelResponse(directParsed, raw);
  }

  // Try extracting JSON from markdown code fences or surrounding text
  const extracted = extractJsonFromText(raw);
  if (extracted) {
    return buildModelResponse(extracted, raw);
  }

  const trimmedRaw = raw.trim();
  const looseResponse = extractLooseResponseText(trimmedRaw);

  // Final fallback: treat the entire raw text as a plain response
  return {
    response:
      looseResponse ??
      (looksStructuredTaskPayloadText(trimmedRaw)
        ? "Task response received."
        : trimmedRaw.length > 0
          ? trimmedRaw
          : "Task completed."),
    todos: [],
    toolCalls: [],
    edits: [],
    shortcuts: [],
  };
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  const escapedNewlines = escapeNewlinesInJsonStrings(trimmed);
  try {
    return JSON.parse(escapedNewlines) as Record<string, unknown>;
  } catch {
    // Try fixing common local-model JSON issues:
    // trailing commas, single quotes, unquoted keys, control chars
    try {
      const fixed = escapedNewlines
        // Strip control characters that break JSON (keep newlines/tabs)
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
        // Remove trailing commas before } or ]
        .replace(/,\s*([\]}])/g, "$1")
        // Fix unquoted keys
        .replace(/(['"])?(\w+)(['"])?\s*:/g, '"$2":')
        // Fix single-quoted string values
        .replace(/:\s*'([^']*)'/g, ': "$1"')
        // Fix undefined → null
        .replace(/:\s*undefined\b/g, ": null");
      return JSON.parse(fixed) as Record<string, unknown>;
    } catch {
      // Last resort: aggressive sanitization
      try {
        const sanitized = escapedNewlines
          .replace(/[\r\n]+/g, " ")
          .replace(/,\s*([\]}])/g, "$1")
          .replace(/(['"])?(\w+)(['"])?\s*:/g, '"$2":')
          .replace(/:\s*'([^']*)'/g, ': "$1"');
        return JSON.parse(sanitized) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
}

function escapeNewlinesInJsonStrings(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      output += char;
      continue;
    }

    if (inString && char === "\n") {
      output += "\\n";
      continue;
    }

    if (inString && char === "\r") {
      continue;
    }

    output += char;
  }

  return output;
}

function extractJsonFromText(text: string): Record<string, unknown> | null {
  // Try markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    const parsed = tryParseJson(fenceMatch[1]);
    if (parsed) {
      return parsed;
    }
  }

  // Try finding the first { ... } block in the text (deepest balanced brace match)
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    const parsed = tryParseJson(candidate);
    if (parsed && hasTaskPayloadShape(parsed)) {
      return parsed;
    }
  }

  // Some local models emit top-level key/value JSON fragments without
  // outer braces, e.g. "response": "...", "toolCalls": [...].
  // Wrap and parse so tool calls are still executed.
  const wrappedFragment = wrapTopLevelJsonFragment(text);
  if (wrappedFragment) {
    const parsed = tryParseJson(wrappedFragment);
    if (parsed) {
      return parsed;
    }
  }

  // Try to reconstruct a response from plain-text patterns models sometimes use
  const toolCallMatch = text.match(
    /tool[_\s]*(?:call|use|execute)[s]?\s*[:=]\s*(.+)/i,
  );
  const responseMatch = text.match(
    /(?:^|\n)(?:response|answer|result)\s*[:=]\s*(.+)/i,
  );
  if (toolCallMatch || responseMatch) {
    const synthetic: Record<string, unknown> = {};
    if (responseMatch) {
      synthetic.response = responseMatch[1].trim();
    }
    return Object.keys(synthetic).length > 0 ? synthetic : null;
  }

  return null;
}

function wrapTopLevelJsonFragment(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("{")) {
    return null;
  }

  const hasStructuredKeys =
    /["']?(response|todos|toolCalls|tool_calls|edits|shortcuts)["']?\s*:/i.test(
      trimmed,
    );
  if (!hasStructuredKeys) {
    return null;
  }

  const normalized = trimmed.replace(/^[\s,]+/, "").replace(/[\s,]+$/, "");
  if (!normalized) {
    return null;
  }

  return `{${normalized}}`;
}

function hasTaskPayloadShape(parsed: Record<string, unknown>): boolean {
  const expectedKeys = [
    "response",
    "todos",
    "toolCalls",
    "tool_calls",
    "edits",
    "shortcuts",
    "message",
    "text",
    "answer",
    "summary",
    "action",
    "actions",
  ];
  return expectedKeys.some((key) =>
    Object.prototype.hasOwnProperty.call(parsed, key),
  );
}

function looksStructuredTaskPayloadText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  return /["']?(response|todos|toolCalls|tool_calls|edits|shortcuts)["']?\s*:/i.test(
    trimmed,
  );
}

function extractLooseResponseText(text: string): string | null {
  if (!text) {
    return null;
  }

  const quotedMatch = text.match(/["']response["']\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (quotedMatch?.[1]) {
    return decodeJsonLikeString(quotedMatch[1]);
  }

  const singleQuotedMatch = text.match(
    /["']response["']\s*:\s*'((?:\\.|[^'\\])*)'/i,
  );
  if (singleQuotedMatch?.[1]) {
    return decodeJsonLikeString(singleQuotedMatch[1]);
  }

  return null;
}

function decodeJsonLikeString(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\")
    .trim();
}

function buildModelResponse(
  parsed: Record<string, unknown>,
  raw: string,
): TaskModelResponse {
  let response =
    typeof parsed.response === "string" && parsed.response.trim().length > 0
      ? parsed.response.trim()
      : "";

  // If no response field is present, try other common field names models use
  if (
    !response &&
    typeof parsed.message === "string" &&
    parsed.message.trim().length > 0
  ) {
    response = parsed.message.trim();
  }
  if (
    !response &&
    typeof parsed.text === "string" &&
    parsed.text.trim().length > 0
  ) {
    response = parsed.text.trim();
  }
  if (
    !response &&
    typeof parsed.answer === "string" &&
    parsed.answer.trim().length > 0
  ) {
    response = parsed.answer.trim();
  }

  // Only use raw text as fallback if it doesn't look like JSON
  if (!response) {
    const trimmedRaw = raw.trim();
    if (trimmedRaw.startsWith("{") || trimmedRaw.startsWith("[")) {
      response = "Task completed.";
    } else {
      response = trimmedRaw.length > 0 ? trimmedRaw : "Task completed.";
    }
  }

  // Support local model patterns: single tool call at top level
  // e.g. {"tool":"create_file","args":{...},"response":"..."}
  let toolCalls = normalizeToolCalls(parsed.toolCalls ?? parsed.tool_calls);
  if (
    toolCalls.length === 0 &&
    typeof parsed.tool === "string" &&
    parsed.tool.trim().length > 0
  ) {
    const singleCall = normalizeToolCall({
      tool: parsed.tool,
      args: parsed.args ?? parsed.arguments ?? {},
      reason: parsed.reason,
    });
    if (singleCall) {
      toolCalls = [singleCall];
    }
  }

  // Support "action"/"actions" as alias for toolCalls (common local model pattern)
  if (toolCalls.length === 0) {
    const actionSource = parsed.action ?? parsed.actions;
    if (actionSource) {
      const actionCalls = normalizeToolCalls(
        Array.isArray(actionSource) ? actionSource : [actionSource],
      );
      if (actionCalls.length > 0) {
        toolCalls = actionCalls;
      }
    }
  }

  return {
    response,
    todos: normalizeTodos(parsed.todos ?? parsed.tasks ?? parsed.steps),
    toolCalls,
    edits: normalizeEdits(parsed.edits ?? parsed.files ?? parsed.changes),
    shortcuts: normalizeShortcuts(parsed.shortcuts),
  };
}

export function normalizeTodos(value: unknown): TaskTodo[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeBySignature(
    value
      .map((entry, index) => normalizeTodoEntry(entry, index))
      .filter((entry): entry is TaskTodo => entry !== null),
    (todo) =>
      [todo.id, todo.title.toLowerCase(), todo.status, todo.detail ?? ""]
        .join("|")
        .toLowerCase(),
  );
}

export function normalizeToolCalls(value: unknown): TaskToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeBySignature(
    value
      .map((entry) => normalizeToolCall(entry))
      .filter((entry): entry is TaskToolCall => entry !== null),
    (call) =>
      `${call.tool}|${call.todoId ?? ""}|${call.expectedOutcome ?? ""}|${stableStringify(call.args)}`,
  );
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

  return dedupeBySignature(edits, (edit) =>
    [
      edit.operation ?? "write",
      edit.filePath,
      edit.targetPath ?? "",
      edit.content ?? "",
    ].join("|"),
  );
}

export function isSafeTerminalCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return false;
  }

  // Allow && and || chains — split and validate each segment independently
  if (/&&|\|\|/.test(normalized)) {
    const segments = normalized.split(/\s*(?:&&|\|\|)\s*/).filter(Boolean);
    return (
      segments.length > 0 &&
      segments.every((seg) => isSafeSingleCommand(seg.trim()))
    );
  }

  // Allow simple pipes where the first command is safe (piping is read-only)
  if (/\|/.test(normalized) && !/\|\|/.test(normalized)) {
    const first = normalized.split(/\s*\|\s*/)[0].trim();
    return isSafeSingleCommand(first);
  }

  return isSafeSingleCommand(normalized);
}

function isSafeSingleCommand(normalized: string): boolean {
  if (!normalized) {
    return false;
  }

  // Block dangerous shell operators (subshells, background, redirection)
  const shellControlPattern = /(?:;|`|\$\(|\r|\n|>|<)/;
  if (shellControlPattern.test(normalized) || /(^|\s)&(?!&)/.test(normalized)) {
    return false;
  }

  // Block truly destructive commands
  const unsafePatterns = [
    /\brm\s+-rf\s+[/~]/, // rm -rf on root/home paths only
    /\bdel\s+\/f?\s+[/\\]/, // Windows force-delete root paths
    /\bremove-item\b.*\b-recurse\b.*\b-force\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\s+-fdx\b/,
    /\bgit\s+push\s+.*--force\b/,
    /\bformat\s+[a-z]:/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bpoweroff\b/,
    /\bmkfs\b/,
    /\bdd\s+if=/,
    /\binvoke-webrequest\b/,
    /\bremove-item\b.*\b-recurse\b/,
  ];

  if (unsafePatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const safePatterns = [
    // Directory navigation
    /^cd\b/,
    // Git read-only operations
    /\bgit\s+(status|diff|log|show|blame|branch|stash\s+list)\b/,
    // Git write operations that are safe within a project
    /\bgit\s+(add|commit|checkout|switch|stash|pull|fetch|init)\b/,
    // Node.js ecosystem — build, test, run, install
    /\bnpm\s+(test|run|exec|install|ci|ls|outdated|audit|init)\b/,
    /\bnpx\s+\S/,
    /\bpnpm\s+(test|run|install|add|exec|ls|audit|dlx|create|init)\b/,
    /\byarn\s+(test|run|install|add|dlx|audit|create)\b/,
    // TypeScript / JavaScript tooling
    /\btsc(\s|$)/,
    /\bvitest(\s|$)/,
    /\bjest(\s|$)/,
    /\beslint(\s|$)/,
    /\bprettier(\s|$)/,
    /\bbiome(\s|$)/,
    // Python ecosystem
    /\bpython\b/,
    /\bpython3\b/,
    /\bpip\s+(install|list|show|freeze)\b/,
    /\bpip3\s+(install|list|show|freeze)\b/,
    /\bpytest(\s|$)/,
    /\buvicorn(\s|$)/,
    /\bflask(\s|$)/,
    /\bmypy(\s|$)/,
    /\bruff(\s|$)/,
    /\bblack(\s|$)/,
    // .NET
    /\bdotnet\s+(test|build|run|restore|new|add)\b/,
    // Go
    /\bgo\s+(test|build|run|vet|mod|get|fmt)\b/,
    // Rust
    /\bcargo\s+(test|build|run|check|clippy|add|fmt)\b/,
    // File inspection commands
    /\bcat\s/,
    /\bhead\s/,
    /\btail\s/,
    /\bwc\s/,
    /\bgrep\s/,
    /\brg\b/,
    /\bfind\s/,
    /\bls\b/,
    /\bdir\b/,
    /\btree\b/,
    /\bpwd\b/,
    /\becho\s/,
    /\bwhich\s/,
    /\bwhere\s/,
    // File manipulation (within project)
    /\bmkdir\s/,
    /\btouch\s/,
    /\bcp\s/,
    /\bmv\s/,
    // Docker read commands
    /\bdocker\s+(ps|images|logs|inspect)\b/,
    // Scaffolding / project-creation commands
    /\b(pnpm|npm|yarn)\s+create\b/,
    /\bnpx\s+create-/,
    /\bpnpm\s+dlx\s+create-/,
    // Make
    /\bmake(\s|$)/,
    // Curl/wget for fetching (non-destructive read)
    /\bcurl\s/,
    /\bwget\s/,
  ];

  return safePatterns.some((pattern) => pattern.test(normalized));
}

/**
 * Estimate an appropriate timeout for a terminal command.
 * Long-running commands (scaffolding, installs) get 5 minutes; others 2 minutes.
 */
export function estimateCommandTimeout(command: string): number {
  const lower = command.toLowerCase();
  const longRunningPatterns = [
    /\b(pnpm|npm|yarn)\s+create\b/,
    /\bnpx\s+create-/,
    /\bpnpm\s+dlx\s+create-/,
    /\bnpm\s+(install|ci)\b/,
    /\bpnpm\s+(install|add)\b/,
    /\byarn\s+(install|add)\b/,
    /\bpip3?\s+install\b/,
    /\bcargo\s+(build|test)\b/,
    /\bdotnet\s+(build|restore|new)\b/,
    /\bgo\s+(build|test|mod)\b/,
    /\bdocker\s+build\b/,
  ];
  if (longRunningPatterns.some((p) => p.test(lower))) {
    return 300_000; // 5 minutes
  }
  return 120_000; // 2 minutes
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
  qualityTarget?: number,
): TaskQualityAssessment {
  const target = qualityTarget ?? TARGET_TASK_QUALITY_SCORE;
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
    target,
    meetsTarget: score >= target,
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
    "Return valid JSON only with fields: response, todos, toolCalls, edits, shortcuts.",
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
    statusRaw === "in_progress" ||
    statusRaw === "active" ||
    statusRaw === "working" ||
    statusRaw === "running"
      ? "in-progress"
      : statusRaw === "blocked" ||
          statusRaw === "failed" ||
          statusRaw === "error"
        ? "blocked"
        : statusRaw === "done" ||
            statusRaw === "completed" ||
            statusRaw === "complete" ||
            statusRaw === "finished"
          ? "done"
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
  // Handle string-only tool calls (e.g. "create_file" instead of {tool:"create_file",args:{}})
  if (typeof entry === "string") {
    const tool = TOOL_ALIASES[entry.trim().toLowerCase()];
    if (!tool) {
      return null;
    }
    return { tool, args: {} };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = entry as Record<string, unknown>;
  const rawTool = firstString(
    candidate.tool,
    candidate.name,
    candidate.type,
    candidate.function,
    candidate.action,
  );
  if (!rawTool) {
    return null;
  }

  const tool = TOOL_ALIASES[rawTool.toLowerCase()];
  if (!tool) {
    return null;
  }

  // Support multiple argument field names local models may use
  let args: Record<string, unknown> = {};
  const argsSource =
    candidate.args ??
    candidate.arguments ??
    candidate.params ??
    candidate.parameters ??
    candidate.input;
  if (argsSource && typeof argsSource === "object") {
    args = argsSource as Record<string, unknown>;
  } else {
    // If no args object, try extracting known arg names from the top level
    // This handles: {"tool":"create_file","filePath":"...","content":"..."}
    const knownArgNames = [
      "filePath",
      "path",
      "content",
      "command",
      "cmd",
      "query",
      "paths",
      "files",
      "pattern",
      "search",
      "replace",
      "edits",
      "oldPath",
      "newPath",
      "symbol",
      "directory",
      "dir",
    ];
    for (const argName of knownArgNames) {
      if (candidate[argName] !== undefined && argName !== "tool") {
        args[argName] = candidate[argName];
      }
    }
  }

  return {
    tool,
    args,
    reason: firstString(candidate.reason, candidate.description),
    todoId: firstString(
      candidate.todoId,
      candidate.todo_id,
      candidate.todo,
      candidate.taskId,
      candidate.task_id,
    ),
    expectedOutcome: firstString(
      candidate.expectedOutcome,
      candidate.expected_outcome,
    ),
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

function dedupeBySignature<T>(items: T[], signature: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const key = signature(item).trim();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
    )
    .join(",")}}`;
}
