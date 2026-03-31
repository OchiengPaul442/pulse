import type {
  TaskToolCall,
  TaskToolObservation,
} from "../runtime/TaskProtocols";

/**
 * Interface that all modular tools implement.
 * Each tool has a unique name and a handler that processes calls.
 */
export interface AgentTool {
  /** Unique identifier used in toolCalls[].tool */
  readonly name: string;
  /** Short description shown in tool config UI */
  readonly description: string;
  /** JSON Schema-style parameter hints for the system prompt */
  readonly parameterHints: string;

  execute(
    call: TaskToolCall,
    objective: string,
    signal?: AbortSignal,
  ): Promise<TaskToolObservation[]>;
}

/** Helper to safely stringify errors. */
export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Extract the first non-empty string from a list of potential values. */
export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/** Extract an array of strings from various argument formats. */
export function extractStringList(...values: unknown[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) output.push(trimmed);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          output.push(item.trim());
        }
      }
    }
  }
  return output;
}
