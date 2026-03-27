import type { ModelProvider } from "../model/ModelProvider";
import type { TaskTodo } from "../runtime/TaskProtocols";

export interface PlanStep {
  id: string;
  goal: string;
  tools: string[];
  expectedOutput: string;
}

export interface TaskSlice {
  id: string;
  title: string;
  scope: string;
  steps: string[];
  deliverable: string;
  acceptanceCriteria: string[];
}

export interface TaskPlan {
  objective: string;
  assumptions: string[];
  acceptanceCriteria: string[];
  todos: TaskTodo[];
  steps: PlanStep[];
  taskSlices: TaskSlice[];
  verification: Array<{ type: string; command: string }>;
}

export class Planner {
  public constructor(private readonly provider: ModelProvider) {}

  public async createPlan(objective: string, model: string): Promise<TaskPlan> {
    const prompt = [
      "Create a rigorous JSON plan for a coding agent task.",
      "Return valid JSON only with fields: objective, assumptions, acceptanceCriteria, todos, steps, taskSlices, verification.",
      "Each step must contain id, goal, tools, expectedOutput.",
      "Each todo must contain id, title, status, and optionally detail.",
      "Keep todo titles short, imperative, and concrete. Use at most 5 todo items.",
      "If detail is needed, keep it to one short clause.",
      "Each taskSlice must contain id, title, scope, steps, deliverable, acceptanceCriteria.",
      "Make acceptance criteria observable and testable.",
      "Task slices should be small enough to implement and verify independently.",
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
    acceptanceCriteria: plan.acceptanceCriteria ?? [
      "The implementation matches the stated objective.",
      "Changes are scoped to the intended files or workflow artifacts.",
      "Verification steps are defined and actionable.",
    ],
    todos: normalizeTodos(plan.todos, objective),
    steps: (plan.steps ?? []).map((step, index) => ({
      id: step.id ?? `step_${index + 1}`,
      goal: step.goal ?? "Execute task step",
      tools: step.tools ?? ["read_file"],
      expectedOutput: step.expectedOutput ?? "Progress towards objective",
    })),
    taskSlices: (plan.taskSlices ?? []).map((slice, index) => ({
      id: slice.id ?? `slice_${index + 1}`,
      title: slice.title ?? "Implementation slice",
      scope: slice.scope ?? "Workspace scope",
      steps: slice.steps ?? [
        "Inspect relevant files",
        "Apply targeted changes",
      ],
      deliverable: slice.deliverable ?? "A verified incremental result",
      acceptanceCriteria: slice.acceptanceCriteria ?? [
        "The slice is independently understandable.",
      ],
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
    acceptanceCriteria: [
      "The plan is understandable and actionable.",
      "Work is split into manageable slices.",
      "Verification is explicitly described.",
    ],
    todos: [
      {
        id: "todo_1",
        title: "Inspect workspace context",
        status: "pending",
      },
      {
        id: "todo_2",
        title: "Make the smallest correct change",
        status: "pending",
      },
      {
        id: "todo_3",
        title: "Verify the result",
        status: "pending",
      },
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
    taskSlices: [
      {
        id: "slice_1",
        title: "Discovery and framing",
        scope: "Relevant files and request context",
        steps: [
          "Inspect the workspace context",
          "Identify constraints and dependencies",
        ],
        deliverable: "A scoped understanding of the task",
        acceptanceCriteria: [
          "Relevant context has been identified.",
          "The task scope is clearly framed.",
        ],
      },
      {
        id: "slice_2",
        title: "Action and verification",
        scope: "Target code or plan artifact",
        steps: ["Produce the implementation or plan", "Verify the result"],
        deliverable: "A concrete task outcome",
        acceptanceCriteria: [
          "The output is actionable.",
          "Verification guidance is present.",
        ],
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

function normalizeTodos(
  todos: Partial<TaskTodo>[] | undefined,
  objective: string,
): TaskTodo[] {
  if (!todos || todos.length === 0) {
    return [
      {
        id: "todo_1",
        title: "Review workspace context",
        status: "pending",
      },
      {
        id: "todo_2",
        title: "Apply the smallest correct change",
        status: "pending",
      },
      {
        id: "todo_3",
        title: "Run verification",
        status: "pending",
      },
    ];
  }

  return todos
    .map((todo, index) => ({
      id: todo.id ?? `todo_${index + 1}`,
      title: todo.title ?? `Task item ${index + 1}`,
      status:
        todo.status === "in-progress" ||
        todo.status === "blocked" ||
        todo.status === "done"
          ? todo.status
          : "pending",
      detail: todo.detail,
    }))
    .filter((todo) => todo.title.trim().length > 0);
}
