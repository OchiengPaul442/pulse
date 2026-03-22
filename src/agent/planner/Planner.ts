import type { ModelProvider } from "../model/ModelProvider";

export interface PlanStep {
  id: string;
  goal: string;
  tools: string[];
  expectedOutput: string;
}

export interface TaskPlan {
  objective: string;
  assumptions: string[];
  steps: PlanStep[];
  verification: Array<{ type: string; command: string }>;
}

export class Planner {
  public constructor(private readonly provider: ModelProvider) {}

  public async createPlan(objective: string, model: string): Promise<TaskPlan> {
    const prompt = [
      "Create a concise JSON plan for a coding agent task.",
      "Return valid JSON only with fields: objective, assumptions, steps, verification.",
      "Each step must contain id, goal, tools, expectedOutput.",
      `Task objective: ${objective}`,
    ].join("\n");

    try {
      const response = await this.provider.chat({
        model,
        format: "json",
        messages: [
          {
            role: "system",
            content: "You are a planning engine for a VS Code coding agent.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const parsed = JSON.parse(response.text) as Partial<TaskPlan>;
      return normalizePlan(parsed, objective);
    } catch {
      return fallbackPlan(objective);
    }
  }
}

function normalizePlan(plan: Partial<TaskPlan>, objective: string): TaskPlan {
  return {
    objective: plan.objective ?? objective,
    assumptions: plan.assumptions ?? [
      "Workspace files are available and readable.",
    ],
    steps: (plan.steps ?? []).map((step, index) => ({
      id: step.id ?? `step_${index + 1}`,
      goal: step.goal ?? "Execute task step",
      tools: step.tools ?? ["read_file"],
      expectedOutput: step.expectedOutput ?? "Progress towards objective",
    })),
    verification: plan.verification ?? [
      {
        type: "diagnostics",
        command: "Inspect editor diagnostics for touched files",
      },
    ],
  };
}

function fallbackPlan(objective: string): TaskPlan {
  return {
    objective,
    assumptions: [
      "No reliable structured plan response from model; fallback plan used.",
    ],
    steps: [
      {
        id: "step_1",
        goal: "Gather relevant workspace context",
        tools: ["search", "read_file"],
        expectedOutput: "Candidate files and local evidence",
      },
      {
        id: "step_2",
        goal: "Generate implementation or explanation",
        tools: ["model.chat"],
        expectedOutput: "Actionable response",
      },
    ],
    verification: [
      {
        type: "diagnostics",
        command: "Inspect diagnostics and summarize next actions",
      },
    ],
  };
}
