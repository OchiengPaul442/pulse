import { describe, expect, it } from "vitest";

import { Planner } from "../src/agent/planner/Planner";
import type { ModelProvider } from "../src/agent/model/ModelProvider";

class ThrowingProvider implements ModelProvider {
  public readonly providerType = "ollama";

  public async chat(): Promise<{ text: string }> {
    throw new Error("boom");
  }

  public async healthCheck(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: "ok" };
  }

  public async listModels(): Promise<Array<{ name: string }>> {
    return [{ name: "model-a" }];
  }
}

describe("Planner", () => {
  it("falls back to a safe local plan when provider fails", async () => {
    const planner = new Planner(new ThrowingProvider());
    const plan = await planner.createPlan("Add tests", "model-a");

    expect(plan.objective).toBe("Add tests");
    expect(plan.todos.length).toBeGreaterThan(0);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.assumptions.length).toBeGreaterThan(0);
    expect(plan.isFallback).toBe(true);
    expect(plan.todos[0]?.title).toMatch(/inspect/i);
    expect(plan.todos[1]?.title).not.toBe("Implement the requested changes");
  });

  it("does not force todos for simple direct tasks", async () => {
    const planner = new Planner(new ThrowingProvider());
    const plan = await planner.createPlan(
      "Show git history for src/extension.ts",
      "model-a",
    );

    expect(plan.isFallback).toBe(true);
    expect(plan.todos).toEqual([]);
  });
});
