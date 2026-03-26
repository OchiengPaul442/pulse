import { describe, expect, it } from "vitest";

import { Planner } from "../src/agent/planner/Planner";
import type { ModelProvider } from "../src/agent/model/ModelProvider";

class ThrowingProvider implements ModelProvider {
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
  });
});
