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

  it("selects terminal investigation for failed command output", () => {
    const registry = new SkillRegistry();
    const selected = registry.selectForObjective(
      "pnpm create next-app failed with terminal output and conflict errors",
    );

    expect(
      selected.selected.some((skill) => skill.id === "terminalInvestigation"),
    ).toBe(true);
  });

  it("avoids overlapping tool coverage across selected skills", () => {
    const registry = new SkillRegistry();
    const selected = registry.selectForObjective(
      "generate a feature, edit files, and run diagnostics",
      5,
    );

    const coveredTools = new Set<string>();
    for (const skill of selected.selected) {
      for (const tool of skill.tools) {
        expect(coveredTools.has(tool)).toBe(false);
        coveredTools.add(tool);
      }
    }
  });
});
