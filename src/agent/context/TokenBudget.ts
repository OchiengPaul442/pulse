/**
 * Token budget tracker with automatic reset and usage estimation.
 *
 * Inspired by Claw's ContextGuard approach: estimate token usage from
 * character counts (1 token ≈ 4 chars), track cumulative consumption,
 * and auto-reset when nearing the budget ceiling.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TokenSnapshot {
  consumed: number;
  budget: number;
  percent: number;
}

export class TokenBudget {
  private consumed = 0;
  private readonly autoResetThreshold: number;

  constructor(
    private budget: number = 32_768,
    autoResetFraction = 0.9,
  ) {
    this.autoResetThreshold = Math.floor(budget * autoResetFraction);
  }

  /** Rough token estimate: 1 token per 4 characters. */
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** Estimate tokens for a message array (system + user + assistant). */
  static estimateMessages(
    messages: Array<{ role: string; content: string | unknown[] }>,
  ): number {
    let total = 0;
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        total += TokenBudget.estimateTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block &&
            typeof block === "object" &&
            "text" in block &&
            typeof (block as { text: string }).text === "string"
          ) {
            total += TokenBudget.estimateTokens(
              (block as { text: string }).text,
            );
          }
        }
      }
    }
    return total;
  }

  /** Record token consumption from an API response. */
  consume(usage: TokenUsage): void {
    this.consumed += usage.totalTokens;
  }

  /** Record a raw token count. */
  consumeRaw(tokens: number): void {
    this.consumed += tokens;
  }

  /** True when consumed tokens have reached the auto-reset threshold. */
  isNearLimit(): boolean {
    return this.consumed >= this.autoResetThreshold;
  }

  /** True when budget is fully exhausted. */
  isExhausted(): boolean {
    return this.consumed >= this.budget;
  }

  /** Remaining tokens before exhaustion. */
  remaining(): number {
    return Math.max(0, this.budget - this.consumed);
  }

  /** Reset consumption (new session or context compaction). */
  reset(): void {
    this.consumed = 0;
  }

  /** Reconfigure the budget ceiling. */
  setBudget(newBudget: number): void {
    this.budget = newBudget;
    this.consumed = Math.min(this.consumed, newBudget);
  }

  /** Snapshot for UI display. */
  snapshot(): TokenSnapshot {
    return {
      consumed: this.consumed,
      budget: this.budget,
      percent:
        this.budget > 0 ? Math.round((this.consumed / this.budget) * 100) : 0,
    };
  }
}
