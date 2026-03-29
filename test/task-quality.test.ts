import { describe, expect, it } from "vitest";

import {
  assessTaskQuality,
  TARGET_TASK_QUALITY_SCORE,
  type TaskModelResponse,
} from "../src/agent/runtime/TaskProtocols";

describe("Task quality assessment", () => {
  it("scores complete edit tasks above the target", () => {
    const response: TaskModelResponse = {
      response: "Implemented the fix and verified the result.",
      todos: [
        { id: "todo_1", title: "Inspect files", status: "done" },
        { id: "todo_2", title: "Run tests", status: "done" },
      ],
      shortcuts: [],
      toolCalls: [
        { tool: "workspace_scan", args: {}, reason: "Need context" },
        { tool: "run_verification", args: { commands: ["npm test"] } },
      ],
      edits: [
        {
          operation: "write",
          filePath: "src/app.ts",
          content: "export const ok = true;",
        },
      ],
    };

    const assessment = assessTaskQuality(response, {
      objective: "Fix the failing test and verify the build",
      toolTrace: [
        {
          tool: "run_verification",
          ok: true,
          summary: "npm test exited successfully",
        },
      ],
      editCount: 1,
      verificationRan: true,
      isEditTask: true,
    });

    expect(assessment.meetsTarget).toBe(true);
    expect(assessment.score).toBeGreaterThanOrEqual(TARGET_TASK_QUALITY_SCORE);
  });

  it("scores weak responses below the target", () => {
    const response: TaskModelResponse = {
      response: "Done.",
      todos: [],
      shortcuts: [],
      toolCalls: [],
      edits: [],
    };

    const assessment = assessTaskQuality(response, {
      objective: "Fix the bug",
      toolTrace: [],
      editCount: 0,
      verificationRan: false,
      isEditTask: true,
    });

    expect(assessment.meetsTarget).toBe(false);
    expect(assessment.score).toBeLessThan(TARGET_TASK_QUALITY_SCORE);
  });

  it("uses a custom quality target when provided", () => {
    const response: TaskModelResponse = {
      response: "Done.",
      todos: [{ id: "1", title: "Task", status: "done" }],
      shortcuts: [],
      toolCalls: [{ tool: "workspace_scan", args: {} }],
      edits: [],
    };

    // With the default target this would fail
    const defaultAssessment = assessTaskQuality(response, {
      objective: "Check something",
      toolTrace: [{ tool: "workspace_scan", ok: true, summary: "scanned" }],
      editCount: 0,
      verificationRan: false,
      isEditTask: false,
    });
    expect(defaultAssessment.meetsTarget).toBe(false);
    expect(defaultAssessment.target).toBe(TARGET_TASK_QUALITY_SCORE);

    // With a low_vram style target of 0.5 it should pass
    const lowVramAssessment = assessTaskQuality(
      response,
      {
        objective: "Check something",
        toolTrace: [{ tool: "workspace_scan", ok: true, summary: "scanned" }],
        editCount: 0,
        verificationRan: false,
        isEditTask: false,
      },
      0.5,
    );
    expect(lowVramAssessment.meetsTarget).toBe(true);
    expect(lowVramAssessment.target).toBe(0.5);
  });
});
