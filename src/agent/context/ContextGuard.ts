/**
 * Context Guard — 3-stage overflow protection.
 *
 * Adapted from Claw's resilience pattern:
 *   Stage 1: Try the API call as-is.
 *   Stage 2: Truncate oversized tool results (head-only).
 *   Stage 3: Compact (summarize) old messages, keeping recent context.
 *
 * If all stages fail, throw so the caller can report the failure.
 */

import { TokenBudget } from "./TokenBudget";

export interface CompactableMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ContextGuardOptions {
  /** Max token budget (defaults to 180 000, matching Claw). */
  maxTokens?: number;
  /** Fraction of budget for single tool result (default 0.3). */
  maxToolOutputFraction?: number;
  /** Minimum recent messages to preserve during compaction (default 6). */
  minRecentMessages?: number;
  /** Fraction of messages to compress during compaction (default 0.5). */
  compressFraction?: number;
}

export class ContextGuard {
  private readonly maxTokens: number;
  private readonly maxToolOutputFraction: number;
  private readonly minRecentMessages: number;
  private readonly compressFraction: number;

  constructor(opts: ContextGuardOptions = {}) {
    this.maxTokens = opts.maxTokens ?? 180_000;
    this.maxToolOutputFraction = opts.maxToolOutputFraction ?? 0.3;
    this.minRecentMessages = opts.minRecentMessages ?? 6;
    this.compressFraction = opts.compressFraction ?? 0.5;
  }

  // ── Stage 2: Truncate tool outputs ─────────────────────────────────

  /**
   * Head-only truncation of a tool result string.
   * Keeps the first N characters (budget * fraction * 4 chars/token).
   */
  truncateToolOutput(result: string): string {
    const maxChars = Math.floor(
      this.maxTokens * 4 * this.maxToolOutputFraction,
    );
    if (result.length <= maxChars) return result;
    const head = result.slice(0, maxChars);
    return (
      head +
      `\n\n[... truncated (${result.length} chars total, showing first ${maxChars}) ...]`
    );
  }

  // ── Stage 3: Compact message history ───────────────────────────────

  /**
   * Compress old messages into a summary block, keeping the most recent
   * messages intact so the model has nearby context.
   *
   * @param messages      Full message history.
   * @param summarizer    Async callback that produces a summary string
   *                      from a batch of old messages.
   * @returns             Compacted message array (summary + recent).
   */
  async compactHistory(
    messages: CompactableMessage[],
    summarizer: (old: CompactableMessage[]) => Promise<string>,
  ): Promise<CompactableMessage[]> {
    const total = messages.length;
    if (total <= this.minRecentMessages) return messages;

    const keepCount = Math.max(this.minRecentMessages, Math.floor(total * 0.2));
    const compressCount = Math.min(
      Math.max(2, Math.floor(total * this.compressFraction)),
      total - keepCount,
    );
    if (compressCount < 2) return messages;

    const old = messages.slice(0, compressCount);
    const recent = messages.slice(compressCount);

    const summary = await summarizer(old);

    return [
      {
        role: "system" as const,
        content: `[Conversation summary — earlier messages compacted]\n${summary}`,
      },
      ...recent,
    ];
  }

  // ── Budget check ───────────────────────────────────────────────────

  /** Estimate whether messages fit within the token budget. */
  fitsInBudget(messages: CompactableMessage[]): boolean {
    return TokenBudget.estimateMessages(messages) < this.maxTokens;
  }

  /**
   * Serialize messages for summarization (used by compactHistory).
   * Returns a flat text block with role prefixes.
   */
  static serializeForSummary(messages: CompactableMessage[]): string {
    return messages
      .map((m) => {
        const prefix = m.role === "user" ? "[User]" : "[Assistant]";
        const text =
          typeof m.content === "string"
            ? m.content.slice(0, 2000)
            : String(m.content).slice(0, 2000);
        return `${prefix}: ${text}`;
      })
      .join("\n");
  }
}
