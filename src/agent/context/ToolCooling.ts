/**
 * Tool cooling / rate-limiting system.
 *
 * Prevents runaway tool invocations by enforcing:
 *   - Per-tool cooldown (minimum ms between consecutive uses)
 *   - Per-turn cap (max invocations of a single tool per agent turn)
 *   - Global turn cap (max total tool calls per agent turn)
 *   - Failure tracking (auto-disable tools with consecutive failures)
 *
 * Inspired by Claw's resilience layer — classify failures and back off.
 */

export interface CoolingConfig {
  /** Default cooldown between consecutive uses of the same tool (ms). */
  defaultCooldownMs?: number;
  /** Per-tool cooldown overrides by tool name (ms). */
  toolCooldowns?: Record<string, number>;
  /** Max invocations of a single tool per turn. */
  maxPerToolPerTurn?: number;
  /** Max total tool calls per turn. */
  maxTotalPerTurn?: number;
  /** Consecutive failures before auto-disabling a tool. */
  maxConsecutiveFailures?: number;
  /** Auto-disable cooldown after max failures (ms). Default 60 000. */
  failureDisableDurationMs?: number;
}

interface ToolState {
  lastUsedAt: number;
  turnCount: number;
  consecutiveFailures: number;
  disabledUntil: number;
}

export class ToolCooling {
  private readonly config: Required<CoolingConfig>;
  private readonly tools = new Map<string, ToolState>();
  private turnTotal = 0;

  constructor(config: CoolingConfig = {}) {
    this.config = {
      defaultCooldownMs: config.defaultCooldownMs ?? 200,
      toolCooldowns: config.toolCooldowns ?? {},
      maxPerToolPerTurn: config.maxPerToolPerTurn ?? 8,
      maxTotalPerTurn: config.maxTotalPerTurn ?? 15,
      maxConsecutiveFailures: config.maxConsecutiveFailures ?? 3,
      failureDisableDurationMs: config.failureDisableDurationMs ?? 60_000,
    };
  }

  /** Reset per-turn counters. Call at the start of each agent turn. */
  resetTurn(): void {
    this.turnTotal = 0;
    for (const state of this.tools.values()) {
      state.turnCount = 0;
    }
  }

  /** Reset all state (new session). */
  resetAll(): void {
    this.tools.clear();
    this.turnTotal = 0;
  }

  /**
   * Check whether a tool is allowed to execute right now.
   * Returns `{ allowed: true }` or `{ allowed: false, reason, retryAfterMs? }`.
   */
  check(toolName: string): CoolingCheckResult {
    const now = Date.now();
    const state = this.getOrCreate(toolName);

    // Failure-disabled?
    if (state.disabledUntil > now) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" temporarily disabled after ${this.config.maxConsecutiveFailures} consecutive failures. Retry in ${Math.ceil((state.disabledUntil - now) / 1000)}s.`,
        retryAfterMs: state.disabledUntil - now,
      };
    }

    // Global turn cap
    if (this.turnTotal >= this.config.maxTotalPerTurn) {
      return {
        allowed: false,
        reason: `Max tool calls per turn reached (${this.config.maxTotalPerTurn}). Wait for the next turn.`,
      };
    }

    // Per-tool turn cap
    if (state.turnCount >= this.config.maxPerToolPerTurn) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" hit per-turn limit (${this.config.maxPerToolPerTurn}).`,
      };
    }

    // Cooldown
    const cooldown =
      this.config.toolCooldowns[toolName] ?? this.config.defaultCooldownMs;
    const elapsed = now - state.lastUsedAt;
    if (elapsed < cooldown) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" on cooldown (${cooldown - elapsed}ms remaining).`,
        retryAfterMs: cooldown - elapsed,
      };
    }

    return { allowed: true };
  }

  /** Record a successful tool invocation. */
  recordSuccess(toolName: string): void {
    const state = this.getOrCreate(toolName);
    state.lastUsedAt = Date.now();
    state.turnCount++;
    state.consecutiveFailures = 0;
    this.turnTotal++;
  }

  /** Record a failed tool invocation. */
  recordFailure(toolName: string): void {
    const state = this.getOrCreate(toolName);
    state.lastUsedAt = Date.now();
    state.turnCount++;
    state.consecutiveFailures++;
    this.turnTotal++;

    if (state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      state.disabledUntil = Date.now() + this.config.failureDisableDurationMs;
    }
  }

  /** Manually re-enable a tool that was failure-disabled. */
  reenable(toolName: string): void {
    const state = this.tools.get(toolName);
    if (state) {
      state.disabledUntil = 0;
      state.consecutiveFailures = 0;
    }
  }

  /** Get diagnostic info for all tracked tools. */
  diagnostics(): ToolCoolingDiagnostic[] {
    const now = Date.now();
    const result: ToolCoolingDiagnostic[] = [];
    for (const [name, state] of this.tools) {
      result.push({
        name,
        turnCount: state.turnCount,
        consecutiveFailures: state.consecutiveFailures,
        disabled: state.disabledUntil > now,
        disabledRemainingMs:
          state.disabledUntil > now ? state.disabledUntil - now : 0,
      });
    }
    return result;
  }

  private getOrCreate(toolName: string): ToolState {
    let state = this.tools.get(toolName);
    if (!state) {
      state = {
        lastUsedAt: 0,
        turnCount: 0,
        consecutiveFailures: 0,
        disabledUntil: 0,
      };
      this.tools.set(toolName, state);
    }
    return state;
  }
}

export interface CoolingCheckResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export interface ToolCoolingDiagnostic {
  name: string;
  turnCount: number;
  consecutiveFailures: number;
  disabled: boolean;
  disabledRemainingMs: number;
}
