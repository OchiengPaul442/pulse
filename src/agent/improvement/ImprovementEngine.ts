/**
 * Recursive self-improvement engine for Pulse agent.
 *
 * Inspired by Karpathy's autoresearch:
 *   • Run a task → measure outcome → learn → repeat
 *   • Build a persistent strategy library from successes and failures
 *   • Generate dynamic prompt optimizations based on historical patterns
 *   • Self-reflect after each task to identify improvement opportunities
 */
import * as vscode from "vscode";

export const TARGET_AGENT_QUALITY_SCORE = 0.9;

export interface TaskOutcome {
  id: string;
  timestamp: string;
  objective: string;
  mode: "agent" | "ask" | "plan";
  model: string;
  success: boolean;
  durationMs: number;
  editsProposed: number;
  editsApplied: number;
  feedback?: "positive" | "negative";
  failureReason?: string;
  skillsUsed: string[];
  tokensUsed: number;
  /** Self-assessed quality score 0-1 from reflection. */
  qualityScore?: number;
  /** Strategy IDs that contributed. */
  strategiesUsed?: string[];
}

/** A learned strategy derived from patterns in past outcomes. */
export interface LearnedStrategy {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** What kind of objective triggers this strategy. */
  triggerPattern: string;
  /** System prompt fragment to inject when this strategy matches. */
  promptHint: string;
  /** How many times this strategy has been applied. */
  timesUsed: number;
  /** Rolling success rate when this strategy was active. */
  successRate: number;
  /** If successRate drops below 0.3, the strategy is disabled. */
  enabled: boolean;
}

/** Self-reflection record after a task. */
export interface SelfReflection {
  outcomeId: string;
  timestamp: string;
  /** What went well. */
  strengths: string[];
  /** What could be improved. */
  weaknesses: string[];
  /** Actionable adjustments for next time. */
  adjustments: string[];
  qualityScore: number;
}

export interface DetectedAgent {
  id: string;
  name: string;
  version: string;
  isActive: boolean;
}

export interface ImprovementStats {
  totalTasks: number;
  successRate: number;
  averageDurationMs: number;
  positiveRate: number;
  negativeRate: number;
  topFailureReasons: Array<{ reason: string; count: number }>;
  tasksByMode: Record<string, number>;
  activeStrategies: number;
  averageQuality: number;
  performanceScore: number;
  targetScore: number;
  meetsTarget: boolean;
  improvementTrend: "improving" | "stable" | "declining";
}

interface ImprovementState {
  outcomes: TaskOutcome[];
  strategies: LearnedStrategy[];
  reflections: SelfReflection[];
}

export class ImprovementEngine {
  private stateCache: ImprovementState | null = null;

  public constructor(private readonly storagePath: string) {}

  /** Record a task outcome for tracking and analysis. */
  public async recordOutcome(outcome: TaskOutcome): Promise<void> {
    const state = await this.load();
    state.outcomes.push(outcome);
    if (state.outcomes.length > 500) {
      state.outcomes = state.outcomes.slice(-500);
    }
    await this.save(state);
  }

  /** Record user feedback on a specific task outcome. */
  public async recordFeedback(
    outcomeId: string,
    feedback: "positive" | "negative",
  ): Promise<boolean> {
    const state = await this.load();
    const found = state.outcomes.find((o) => o.id === outcomeId);
    if (!found) return false;
    found.feedback = feedback;

    // Feedback is the strongest signal — update strategy success rates
    if (found.strategiesUsed?.length) {
      for (const sid of found.strategiesUsed) {
        const strat = state.strategies.find((s) => s.id === sid);
        if (strat) {
          const relevantOutcomes = state.outcomes.filter((o) =>
            o.strategiesUsed?.includes(sid),
          );
          const successes = relevantOutcomes.filter(
            (o) => o.feedback === "positive" || o.success,
          ).length;
          strat.successRate =
            relevantOutcomes.length > 0
              ? successes / relevantOutcomes.length
              : 0.5;
          strat.enabled = strat.successRate >= 0.3;
          strat.updatedAt = new Date().toISOString();
        }
      }
    }

    await this.save(state);
    return true;
  }

  /**
   * Self-reflect on a completed task. Produces a structured assessment
   * of what worked and what didn't, then stores it as a learning signal.
   */
  public async reflectOnTask(
    outcomeId: string,
    objective: string,
    responseText: string,
    success: boolean,
    durationMs: number,
  ): Promise<SelfReflection> {
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const adjustments: string[] = [];

    // Heuristic self-assessment
    const hasCode = responseText.includes("```");
    const hasExplanation = responseText.length > 200;
    const responseLen = responseText.length;
    const isDetailed = responseLen > 800;
    const isTruncated =
      responseText.endsWith("..") ||
      responseText.endsWith("…") ||
      responseLen < 50;

    if (success) strengths.push("Task completed without errors");
    else weaknesses.push("Task encountered errors during execution");

    if (hasCode && hasExplanation)
      strengths.push("Response includes both code and explanation");
    else if (hasCode && !hasExplanation)
      weaknesses.push("Code provided without sufficient explanation");
    else if (
      !hasCode &&
      objective
        .toLowerCase()
        .match(/\b(write|create|implement|fix|add|edit|build)\b/)
    )
      weaknesses.push("Expected code in response but none provided");

    if (isTruncated) {
      weaknesses.push("Response appears truncated or incomplete");
      adjustments.push("Increase token budget or reduce prompt size");
    }

    if (durationMs > 30000) {
      weaknesses.push("Response took longer than 30 seconds");
      adjustments.push(
        "Consider using a faster model or reducing context size",
      );
    }

    if (isDetailed && success) strengths.push("Thorough and detailed response");

    // Quality score based on heuristics
    let qualityScore = 0.5;
    qualityScore += success ? 0.15 : -0.15;
    qualityScore += hasCode && hasExplanation ? 0.15 : 0;
    qualityScore += isTruncated ? -0.2 : 0.1;
    qualityScore += durationMs < 15000 ? 0.1 : durationMs > 30000 ? -0.1 : 0;
    qualityScore = Math.max(0, Math.min(1, qualityScore));

    const reflection: SelfReflection = {
      outcomeId,
      timestamp: new Date().toISOString(),
      strengths,
      weaknesses,
      adjustments,
      qualityScore,
    };

    const state = await this.load();
    state.reflections.push(reflection);
    if (state.reflections.length > 200) {
      state.reflections = state.reflections.slice(-200);
    }

    // Update the outcome with the quality score
    const outcome = state.outcomes.find((o) => o.id === outcomeId);
    if (outcome) outcome.qualityScore = qualityScore;

    // Auto-generate strategies from reflection patterns
    await this.evolveStrategies(state);
    await this.save(state);

    return reflection;
  }

  /**
   * Get optimized behavior hints based on historical performance.
   * These are injected into system prompts to improve future responses.
   */
  public async getOptimizedBehaviorHints(
    objective: string,
    mode: string,
  ): Promise<string> {
    const state = await this.load();
    if (state.outcomes.length < 3) return "";

    const hints: string[] = [];

    // Find matching enabled strategies
    const lower = objective.toLowerCase();
    for (const strat of state.strategies) {
      if (!strat.enabled) continue;
      try {
        if (new RegExp(strat.triggerPattern, "i").test(lower)) {
          hints.push(strat.promptHint);
        }
      } catch {
        // invalid regex, skip
      }
    }

    // Compute recent trends
    const recent = state.outcomes.slice(-20);
    const recentSuccess =
      recent.filter((o) => o.success).length / recent.length;
    const recentReflections = state.reflections.slice(-10);

    // Aggregate common weaknesses from recent reflections
    const weaknessCount = new Map<string, number>();
    for (const r of recentReflections) {
      for (const w of r.weaknesses) {
        weaknessCount.set(w, (weaknessCount.get(w) ?? 0) + 1);
      }
    }

    // If truncation keeps happening, add a hint
    const truncCount =
      weaknessCount.get("Response appears truncated or incomplete") ?? 0;
    if (truncCount >= 2) {
      hints.push(
        "IMPORTANT: Your recent responses have been truncated. Be thorough but concise. " +
          "Prioritize completing your answer over adding extra detail.",
      );
    }

    // If code without explanation is a pattern
    const noExplainCount =
      weaknessCount.get("Code provided without sufficient explanation") ?? 0;
    if (noExplainCount >= 2) {
      hints.push(
        "Always explain your code changes briefly — what you did and why.",
      );
    }

    // If success rate is declining, inject a quality reminder
    if (recentSuccess < 0.6) {
      hints.push(
        "Focus on accuracy and completeness. Read the user's request carefully before responding.",
      );
    }

    // Mode-specific optimizations from past performance
    const modeOutcomes = state.outcomes.filter((o) => o.mode === mode);
    if (modeOutcomes.length >= 5) {
      const modeSuccess =
        modeOutcomes.filter((o) => o.success).length / modeOutcomes.length;
      if (mode === "agent" && modeSuccess < 0.7) {
        hints.push(
          "Double-check file paths and ensure edits are valid JSON before responding.",
        );
      }
    }

    return hints.length > 0 ? hints.join(" ") : "";
  }

  /** Compute aggregate statistics from recorded outcomes. */
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
        activeStrategies: 0,
        averageQuality: 0,
        performanceScore: 0,
        targetScore: TARGET_AGENT_QUALITY_SCORE,
        meetsTarget: false,
        improvementTrend: "stable",
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

    const tasksByMode: Record<string, number> = {};
    for (const o of outcomes) {
      tasksByMode[o.mode] = (tasksByMode[o.mode] ?? 0) + 1;
    }

    const scored = outcomes.filter((o) => typeof o.qualityScore === "number");
    const avgQuality =
      scored.length > 0
        ? scored.reduce((s, o) => s + (o.qualityScore ?? 0), 0) / scored.length
        : 0;

    // Trend: compare last 10 vs previous 10
    let trend: "improving" | "stable" | "declining" = "stable";
    if (outcomes.length >= 20) {
      const prev10 = outcomes.slice(-20, -10);
      const last10 = outcomes.slice(-10);
      const prevRate = prev10.filter((o) => o.success).length / 10;
      const lastRate = last10.filter((o) => o.success).length / 10;
      if (lastRate - prevRate > 0.15) trend = "improving";
      else if (prevRate - lastRate > 0.15) trend = "declining";
    }

    const activeStrategies = state.strategies.filter((s) => s.enabled).length;
    const performanceScore =
      Math.round((successes / total) * 60 + avgQuality * 40) / 100;

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
      activeStrategies,
      averageQuality: Math.round(avgQuality * 100) / 100,
      performanceScore,
      targetScore: TARGET_AGENT_QUALITY_SCORE,
      meetsTarget: performanceScore >= TARGET_AGENT_QUALITY_SCORE,
      improvementTrend: trend,
    };
  }

  /** Get recent outcomes for inspection. */
  public async recentOutcomes(limit = 10): Promise<TaskOutcome[]> {
    const state = await this.load();
    return state.outcomes.slice(-limit);
  }

  /** Get active strategies. */
  public async getActiveStrategies(): Promise<LearnedStrategy[]> {
    const state = await this.load();
    return state.strategies.filter((s) => s.enabled);
  }

  /**
   * Detect other AI coding agents installed in VS Code.
   * Records their presence so Pulse can learn from coexisting environments.
   */
  public detectInstalledAgents(): DetectedAgent[] {
    const knownAgentExtensions: Array<{
      id: string;
      displayName: string;
    }> = [
      { id: "github.copilot", displayName: "GitHub Copilot" },
      { id: "github.copilot-chat", displayName: "GitHub Copilot Chat" },
      { id: "sourcegraph.cody-ai", displayName: "Sourcery Cody" },
      { id: "continue.continue", displayName: "Continue" },
      { id: "codeium.codeium", displayName: "Codeium" },
      { id: "tabnine.tabnine-vscode", displayName: "Tabnine" },
      {
        id: "amazonwebservices.aws-toolkit-vscode",
        displayName: "AWS CodeWhisperer",
      },
      { id: "cursor.cursor", displayName: "Cursor" },
      { id: "aider.aider", displayName: "Aider" },
      { id: "saoudrizwan.claude-dev", displayName: "Claude Dev" },
      { id: "rooveterinaryinc.roo-cline", displayName: "Roo Cline" },
      { id: "supermaven.supermaven", displayName: "Supermaven" },
    ];

    const detected: DetectedAgent[] = [];
    for (const known of knownAgentExtensions) {
      const ext = vscode.extensions.getExtension(known.id);
      if (ext) {
        detected.push({
          id: known.id,
          name: known.displayName,
          version: ext.packageJSON?.version ?? "unknown",
          isActive: ext.isActive,
        });
      }
    }
    return detected;
  }

  /**
   * Generate enhanced behavior hints considering detected agents.
   * If Copilot or similar is active, Pulse focuses on complementary strengths.
   */
  public getAgentAwarenessHints(): string {
    const agents = this.detectInstalledAgents();
    if (agents.length === 0) return "";

    const active = agents.filter((a) => a.isActive);
    if (active.length === 0) return "";

    const hints: string[] = [];
    const hasCopilot = active.some((a) => a.id.startsWith("github.copilot"));
    const hasCody = active.some((a) => a.id === "sourcegraph.cody-ai");
    const hasContinue = active.some((a) => a.id === "continue.continue");

    if (hasCopilot) {
      hints.push(
        "GitHub Copilot is active. Focus on multi-file edits, architecture decisions, and complex refactoring that go beyond inline completions.",
      );
    }
    if (hasCody) {
      hints.push(
        "Cody is active for code search. Focus on execution, planning, and automated workflows.",
      );
    }
    if (hasContinue) {
      hints.push(
        "Continue is active. Focus on autonomous task execution and file editing rather than chat-only responses.",
      );
    }

    return hints.join(" ");
  }

  /**
   * Run one full self-improvement cycle: reflect on recent outcomes and evolve strategies.
   * Called by the background self-learn loop.
   */
  public async runSelfImprovementCycle(): Promise<void> {
    const state = await this.load();
    if (state.outcomes.length === 0) return;
    // Reflect on the most recent outcome if not already reflected
    const latest = state.outcomes[state.outcomes.length - 1];
    if (latest && !state.reflections.some((r) => r.outcomeId === latest.id)) {
      await this.reflectOnTask(
        latest.id,
        latest.objective,
        "",
        latest.success,
        latest.durationMs,
      );
    }
    // Evolve strategies from all accumulated data
    const freshState = await this.load();
    await this.evolveStrategies(freshState);
    await this.save(freshState);
  }

  // ── Private: strategy evolution ────────────────────────────────

  /**
   * Analyze recent outcomes and reflections to create or update strategies.
   * This is the core "self-improvement loop".
   */
  private async evolveStrategies(state: ImprovementState): Promise<void> {
    if (state.outcomes.length < 5) return;

    const recent = state.outcomes.slice(-30);

    // Pattern: detect objective categories that consistently fail
    const categoryMap = new Map<string, { success: number; total: number }>();
    for (const o of recent) {
      const cat = this.categorizeObjective(o.objective);
      const entry = categoryMap.get(cat) ?? { success: 0, total: 0 };
      entry.total++;
      if (o.success) entry.success++;
      categoryMap.set(cat, entry);
    }

    for (const [category, stats] of categoryMap) {
      if (stats.total < 3) continue;
      const rate = stats.success / stats.total;
      const stratId = `auto_${category}`;
      const existing = state.strategies.find((s) => s.id === stratId);

      if (rate < 0.5 && !existing) {
        // Create a new corrective strategy
        state.strategies.push({
          id: stratId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          triggerPattern: this.categoryToPattern(category),
          promptHint: this.categoryToHint(category, rate),
          timesUsed: 0,
          successRate: rate,
          enabled: true,
        });
      } else if (existing) {
        existing.successRate = rate;
        existing.enabled = rate >= 0.3;
        existing.updatedAt = new Date().toISOString();
        existing.promptHint = this.categoryToHint(category, rate);
      }
    }

    // Prune old disabled strategies
    state.strategies = state.strategies
      .filter(
        (s) => s.enabled || Date.now() - Date.parse(s.updatedAt) < 7 * 86400000,
      )
      .slice(-30);
  }

  private categorizeObjective(objective: string): string {
    const lower = objective.toLowerCase();
    if (/\b(fix|bug|error|crash|debug)\b/.test(lower)) return "debug";
    if (/\b(add|create|implement|build|write|new)\b/.test(lower))
      return "feature";
    if (/\b(explain|how|what|why|describe|tell)\b/.test(lower))
      return "explain";
    if (/\b(refactor|improve|clean|simplify|rename|optimize)\b/.test(lower))
      return "refactor";
    if (/\b(test|spec|coverage|assert)\b/.test(lower)) return "testing";
    if (/\b(deploy|docker|ci|pipeline|infra)\b/.test(lower)) return "devops";
    if (/\b(design|ui|ux|style|css|layout)\b/.test(lower)) return "design";
    if (/\b(data|csv|sql|model|train|dataset)\b/.test(lower)) return "data";
    return "general";
  }

  private categoryToPattern(category: string): string {
    const patterns: Record<string, string> = {
      debug: "\\b(fix|bug|error|crash|debug)\\b",
      feature: "\\b(add|create|implement|build|write|new)\\b",
      explain: "\\b(explain|how|what|why|describe)\\b",
      refactor: "\\b(refactor|improve|clean|simplify)\\b",
      testing: "\\b(test|spec|coverage|assert)\\b",
      devops: "\\b(deploy|docker|ci|pipeline)\\b",
      design: "\\b(design|ui|ux|style|css)\\b",
      data: "\\b(data|csv|sql|model|train)\\b",
      general: ".",
    };
    return patterns[category] ?? ".";
  }

  private categoryToHint(category: string, successRate: number): string {
    const quality = successRate < 0.3 ? "very poor" : "below average";
    const hints: Record<string, string> = {
      debug: `Your ${quality} success rate on debugging tasks suggests you should: read error messages more carefully, check stack traces, and verify fixes compile before responding.`,
      feature: `Your ${quality} success rate on feature tasks suggests you should: plan the implementation first, check existing patterns in the codebase, and produce complete working code.`,
      explain: `Your ${quality} success rate on explanation tasks suggests you should: be more thorough, include specific code references, and structure explanations clearly.`,
      refactor: `Your ${quality} success rate on refactoring tasks suggests you should: make minimal changes, preserve behavior, and explain each change.`,
      testing: `Your ${quality} success rate on testing tasks suggests you should: use the project's existing test framework, cover edge cases, and ensure tests actually run.`,
      devops: `Your ${quality} success rate on DevOps tasks suggests you should: be precise with configurations, validate syntax, and reference official documentation patterns.`,
      design: `Your ${quality} success rate on design tasks suggests you should: focus on visual consistency, use the project's existing design system, and provide complete CSS/markup.`,
      data: `Your ${quality} success rate on data tasks suggests you should: validate data structures, handle edge cases, and be precise with queries/transformations.`,
      general: `Your recent task success rate is ${quality}. Focus on reading instructions carefully and providing complete, accurate responses.`,
    };
    return hints[category] ?? hints.general;
  }

  private async load(): Promise<ImprovementState> {
    if (this.stateCache) return this.stateCache;
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(this.storagePath),
      );
      const raw = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(raw) as Partial<ImprovementState>;
      this.stateCache = {
        outcomes: parsed.outcomes ?? [],
        strategies: parsed.strategies ?? [],
        reflections: parsed.reflections ?? [],
      };
      return this.stateCache;
    } catch {
      this.stateCache = { outcomes: [], strategies: [], reflections: [] };
      return this.stateCache;
    }
  }

  private async save(state: ImprovementState): Promise<void> {
    this.stateCache = state;
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(this.storagePath),
      Buffer.from(JSON.stringify(state, null, 2), "utf8"),
    );
  }
}
