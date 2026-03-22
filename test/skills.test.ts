import { describe, expect, it } from "vitest";

import { SkillRegistry } from "../src/agent/skills/SkillRegistry";

describe("SkillRegistry", () => {
  it("selects relevant skills for objective text", () => {
    const registry = new SkillRegistry();
    const selected = registry.selectForObjective(
      "Fix MCP server error and run diagnostics",
    );

    expect(selected.selected.length).toBeGreaterThan(0);
    expect(selected.primary).not.toBeNull();
    expect(selected.selected.some((skill) => skill.id === "mcp")).toBe(true);
  });
});
