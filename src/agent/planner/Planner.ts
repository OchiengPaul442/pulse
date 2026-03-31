import type { ModelProvider } from "../model/ModelProvider";
import type { TaskTodo, TaskTodoStatus } from "../runtime/TaskProtocols";

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
  /** True when the planner model failed and a generic fallback plan was used. */
  isFallback?: boolean;
}

export class Planner {
  public constructor(private readonly provider: ModelProvider) {}

  public async createPlan(
    objective: string,
    model: string,
    options?: { keepAlive?: number; numCtx?: number },
  ): Promise<TaskPlan> {
    const prompt = [
      "Create a JSON plan for a coding agent task. Return valid JSON only.",
      "Fields: objective, assumptions (string[]), acceptanceCriteria (string[]), todos (array of {id, title, status}), steps (array of {id, goal, tools, expectedOutput}), taskSlices (array of {id, title, scope, steps, deliverable, acceptanceCriteria}), verification (array of {type, command}).",
      "Keep 3-5 todos with short, task-specific imperative titles.",
      "The first todo should inspect relevant workspace files, but avoid generic titles like 'Scan workspace and read relevant files'.",
      "Todo statuses: 'pending' only (the agent will update them).",
      `Task: ${objective}`,
    ].join("\n");

    try {
      const response = await this.provider.chat({
        model,
        format: "json",
        keepAlive: options?.keepAlive,
        numCtx: options?.numCtx,
        maxTokens: 1024,
        messages: [
          {
            role: "system",
            content:
              "You are a planning engine. Return ONLY valid JSON. No markdown. Start with { end with }.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const parsed = JSON.parse(response.text) as Partial<TaskPlan>;
      const plan = normalizePlan(parsed, objective);
      // Sanity check: if planner returned empty/useless todos, use fallback
      if (plan.todos.length === 0) {
        return fallbackPlan(objective);
      }
      return plan;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Planner] Plan generation failed, using fallback: ${message}`,
      );
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
  const fallbackTodos = buildFallbackTodos(objective);
  return {
    isFallback: true,
    objective,
    assumptions: [
      "No reliable structured plan response from model; fallback plan used.",
      "Agent must use tool calls to inspect the workspace before taking action.",
    ],
    acceptanceCriteria: [
      "The plan is understandable and actionable.",
      "Work is split into manageable slices.",
      "Verification is explicitly described.",
    ],
    todos: fallbackTodos,
    steps: [
      {
        id: "step_1",
        goal: "Scan workspace structure and read key files",
        tools: ["workspace_scan", "read_files", "list_dir"],
        expectedOutput: "Understanding of project structure and relevant code",
      },
      {
        id: "step_2",
        goal: "Implement the changes requested by the user",
        tools: ["create_file", "batch_edit", "run_terminal"],
        expectedOutput: "Files created or modified to fulfill the objective",
      },
      {
        id: "step_3",
        goal: "Verify changes compile and pass tests",
        tools: ["run_verification", "get_problems"],
        expectedOutput: "All checks passing or clear explanation of issues",
      },
    ],
    taskSlices: [
      {
        id: "slice_1",
        title: "Discovery and framing",
        scope: "Relevant files and request context",
        steps: [
          "Use workspace_scan to list files",
          "Use read_files to read relevant source files",
          "Identify constraints and dependencies",
        ],
        deliverable: "A scoped understanding of the task",
        acceptanceCriteria: [
          "workspace_scan tool has been called.",
          "Relevant files have been read.",
          "The task scope is clearly framed.",
        ],
      },
      {
        id: "slice_2",
        title: "Implementation",
        scope: "Target code or plan artifact",
        steps: [
          "Create or modify files to implement the objective",
          "Run verification commands to test the result",
        ],
        deliverable: "A concrete task outcome",
        acceptanceCriteria: [
          "Files have been created or modified.",
          "Verification has been attempted.",
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
    return buildFallbackTodos(objective);
  }

  return todos
    .map((todo, index): TaskTodo => {
      const statusRaw = todo.status;
      const status: TaskTodoStatus =
        statusRaw === "in-progress" ||
        statusRaw === "blocked" ||
        statusRaw === "done"
          ? statusRaw
          : "pending";
      return {
        id: todo.id ?? `todo_${index + 1}`,
        title: todo.title ?? `Task item ${index + 1}`,
        status,
        detail: todo.detail,
      };
    })
    .filter((todo) => todo.title.trim().length > 0);
}

function buildFallbackTodos(objective: string): TaskTodo[] {
  const lower = objective.toLowerCase();

  let titles: string[];
  if (
    /\b(next\.?js|scaffold|starter|bootstrap|create project|new app)\b/.test(
      lower,
    )
  ) {
    titles = [
      "Inspect the workspace and scaffold target",
      "Set up the requested app structure",
      "Verify the scaffold and fix setup issues",
    ];
  } else if (/\b(fix|bug|error|crash|failing|test)\b/.test(lower)) {
    titles = [
      "Inspect the failing area and evidence",
      "Apply the targeted fix",
      "Run verification and resolve regressions",
    ];
  } else if (/\b(refactor|rename|restructure|cleanup|clean up)\b/.test(lower)) {
    titles = [
      "Inspect the affected code paths",
      "Refactor the requested area",
      "Verify behavior and review the diff",
    ];
  } else if (/\b(add|implement|build|create|introduce)\b/.test(lower)) {
    titles = [
      "Inspect the target files and constraints",
      "Implement the requested change",
      "Verify the result and fix issues",
    ];
  } else {
    titles = [
      "Inspect relevant workspace files",
      "Make the requested change",
      "Verify and summarize the result",
    ];
  }

  return titles.map((title, index) => ({
    id: `todo_${index + 1}`,
    title,
    status: "pending",
  }));
}
