import type { AgentProgressStep, TokenSnapshot } from "./RuntimeTypes.js";
import type { TaskTodo } from "./TaskProtocols.js";

/**
 * Centralised callback management for streaming chunks, progress updates,
 * terminal output, token budget, and todo updates.
 *
 * Extracted from `AgentRuntime` to isolate UI broadcast logic.
 */
export class StreamBroadcaster {
  private progressCallback: ((step: AgentProgressStep) => void) | null = null;
  private tokenCallback: ((snapshot: TokenSnapshot) => void) | null = null;
  private streamCallback: ((chunk: string) => void) | null = null;
  private terminalOutputCallback:
    | ((data: {
        command: string;
        output: string;
        exitCode: number | null;
      }) => void)
    | null = null;

  private lastReasoningPulseAt = 0;
  private lastReasoningPulseMessage = "";

  // ── Callback registration ──────────────────────────────────────

  public setProgressCallback(
    cb: ((step: AgentProgressStep) => void) | null,
  ): void {
    this.progressCallback = cb;
  }

  public setTokenCallback(
    cb: ((snapshot: TokenSnapshot) => void) | null,
  ): void {
    this.tokenCallback = cb;
  }

  public setStreamCallback(cb: ((chunk: string) => void) | null): void {
    this.streamCallback = cb;
  }

  public setTerminalOutputCallback(
    cb:
      | ((data: {
          command: string;
          output: string;
          exitCode: number | null;
        }) => void)
      | null,
  ): void {
    this.terminalOutputCallback = cb;
  }

  // ── Stream & progress emitters ─────────────────────────────────

  public emitStreamChunk(chunk: string): void {
    this.streamCallback?.(chunk);
  }

  public emitProgress(step: string, detail?: string, icon = "\u25B8"): void {
    this.progressCallback?.({ icon, step, detail });
  }

  public emitFilePatch(filename: string, lineCount: number): void {
    this.progressCallback?.({
      icon: "✏️",
      step: "Generating patch",
      detail: filename,
      kind: "file_patch",
      file: filename,
      lineCount,
    });
  }

  public emitFilePatched(filename: string, linesAdded: number): void {
    this.progressCallback?.({
      icon: "✅",
      step: "Edited",
      detail: filename,
      kind: "file_patched",
      file: filename,
      linesAdded,
      linesRemoved: 0,
    });
  }

  public emitTerminalRun(command: string): void {
    this.progressCallback?.({
      icon: "\u25B6",
      step: "Terminal",
      detail: command,
      kind: "terminal",
    });
  }

  public emitTerminalOutput(
    command: string,
    output: string,
    exitCode: number | null,
  ): void {
    this.terminalOutputCallback?.({ command, output, exitCode });
  }

  public emitReasoningChunk(chunk: string): void {
    const cleaned = this.sanitizeReasoningChunk(chunk);
    if (!cleaned) return;

    this.progressCallback?.({
      icon: "\u25B8",
      step: "Reasoning",
      detail: cleaned.slice(0, 240),
      kind: "reasoning",
    });
  }

  public emitReasoningPulse(
    message = "Thinking through the next action...",
  ): void {
    const cleaned = this.sanitizeReasoningChunk(message);
    if (!cleaned) return;

    const now = Date.now();
    const repeated = cleaned === this.lastReasoningPulseMessage;
    const minIntervalMs = repeated ? 6000 : 1200;
    if (now - this.lastReasoningPulseAt < minIntervalMs) return;
    this.lastReasoningPulseAt = now;
    this.lastReasoningPulseMessage = cleaned;

    this.progressCallback?.({
      icon: "\u25B8",
      step: "Reasoning",
      detail: cleaned,
      kind: "reasoning",
    });
  }

  public emitTodoUpdate(todos: TaskTodo[]): void {
    this.progressCallback?.({
      icon: "\u2611",
      step: "Updating TODOs",
      kind: "todo_update",
      todos,
    });
  }

  public emitFilesChanged(
    files: Array<{ path: string; additions: number; deletions: number }>,
  ): void {
    this.progressCallback?.({
      icon: "\uD83D\uDCC4",
      step: "Files changed",
      kind: "files_changed",
      files,
    });
  }

  public emitTokenUpdate(consumed: number, budget: number): void {
    if (!this.tokenCallback) return;
    const percent =
      budget > 0 ? Math.min(100, Math.round((consumed / budget) * 100)) : 0;
    this.tokenCallback({ consumed, budget, percent });
  }

  // ── Helpers ────────────────────────────────────────────────────

  public sanitizeReasoningChunk(chunk: string): string {
    const trimmed = chunk.trim();
    if (!trimmed) return "";

    if (/^[\s{}\[\]",:]+$/.test(trimmed)) return "";

    if (
      (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
      /"(response|todos|toolCalls|tool_calls|edits|shortcuts)"/i.test(trimmed)
    ) {
      return "";
    }

    return trimmed;
  }
}
