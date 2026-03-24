/**
 * Self-improvement architecture for Pulse agent.
 * Tracks task outcomes, feedback, and failure patterns for analysis.
 * Privacy-conscious: opt-in only, no user content in telemetry.
 */
import * as vscode from "vscode";

export interface TaskOutcome {
  id: string;
  timestamp: string;
  objective: string;
  mode: "agent" | "ask" | "plan";
  model: string;
  /** Whether the task completed without errors. */
  success: boolean;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Number of edits proposed. */
  editsProposed: number;
  /** Number of edits applied. */
  editsApplied: number;
  /** Optional user feedback: thumbs-up/down. */
  feedback?: "positive" | "negative";
  /** Optional failure reason (no user content). */
  failureReason?: string;
  /** Skill IDs that were activated. */
  skillsUsed: string[];
  /** Token usage. */
  tokensUsed: number;
}

export interface ImprovementStats {
  totalTasks: number;
  successRate: number;
  averageDurationMs: number;
  positiveRate: number;
  negativeRate: number;
  topFailureReasons: Array<{ reason: string; count: number }>;
  tasksByMode: Record<string, number>;
}

interface ImprovementState {
  outcomes: TaskOutcome[];
}

export class ImprovementEngine {
  public constructor(private readonly storagePath: string) {}

  /**
   * Record a task outcome for tracking and analysis.
   */
  public async recordOutcome(outcome: TaskOutcome): Promise<void> {
    const state = await this.load();
    state.outcomes.push(outcome);

    // Keep bounded — retain last 200 outcomes
    if (state.outcomes.length > 200) {
      state.outcomes = state.outcomes.slice(-200);
    }

    await this.save(state);
  }

  /**
   * Record user feedback on a specific task outcome.
   */
  public async recordFeedback(
    outcomeId: string,
    feedback: "positive" | "negative",
  ): Promise<boolean> {
    const state = await this.load();
    const found = state.outcomes.find((o) => o.id === outcomeId);
    if (!found) return false;
    found.feedback = feedback;
    await this.save(state);
    return true;
  }

  /**
   * Compute aggregate statistics from recorded outcomes.
   */
  public async getStats(): Promise<ImprovementStats> {
    const state = await this.load();
    const outcomes = state.outcomes;

    if (outcomes.length === 0) {
      return {
        totalTasks: 0,
        successRate: 0,
        averageDurationMs: 0,
        positiveRate: 0,
        negativeRate: 0,
        topFailureReasons: [],
        tasksByMode: {},
      };
    }

    const total = outcomes.length;
    const successes = outcomes.filter((o) => o.success).length;
    const withFeedback = outcomes.filter((o) => o.feedback);
    const positives = withFeedback.filter(
      (o) => o.feedback === "positive",
    ).length;
    const negatives = withFeedback.filter(
      (o) => o.feedback === "negative",
    ).length;
    const avgDuration =
      outcomes.reduce((sum, o) => sum + o.durationMs, 0) / total;

    // Failure reason clustering
    const failureMap = new Map<string, number>();
    for (const o of outcomes) {
      if (o.failureReason) {
        failureMap.set(
          o.failureReason,
          (failureMap.get(o.failureReason) ?? 0) + 1,
        );
      }
    }
    const topFailureReasons = [...failureMap.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Tasks by mode
    const tasksByMode: Record<string, number> = {};
    for (const o of outcomes) {
      tasksByMode[o.mode] = (tasksByMode[o.mode] ?? 0) + 1;
    }

    return {
      totalTasks: total,
      successRate: successes / total,
      averageDurationMs: Math.round(avgDuration),
      positiveRate:
        withFeedback.length > 0 ? positives / withFeedback.length : 0,
      negativeRate:
        withFeedback.length > 0 ? negatives / withFeedback.length : 0,
      topFailureReasons,
      tasksByMode,
    };
  }

  /**
   * Get recent outcomes for inspection.
   */
  public async recentOutcomes(limit = 10): Promise<TaskOutcome[]> {
    const state = await this.load();
    return state.outcomes.slice(-limit);
  }

  private async load(): Promise<ImprovementState> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(this.storagePath),
      );
      const raw = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(raw) as ImprovementState;
      return { outcomes: parsed.outcomes ?? [] };
    } catch {
      return { outcomes: [] };
    }
  }

  private async save(state: ImprovementState): Promise<void> {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(this.storagePath),
      Buffer.from(JSON.stringify(state, null, 2), "utf8"),
    );
  }
}
