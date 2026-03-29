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

  it("selects filesystem and scaffold skills for a from-scratch project prompt", () => {
    const registry = new SkillRegistry();
    const objective = `
You are an autonomous AI coding agent operating in an EMPTY project workspace.

Build a FULLSTACK BLOG PLATFORM from scratch.
Design the architecture and plan the implementation.
  Create the project structure, install dependencies, run tests, read files before editing, write new files, move or rename files when needed, and delete generated junk if necessary.
`;

    const selected = registry.selectForObjective(objective, 6);
    const selectedIds = new Set(selected.selected.map((skill) => skill.id));
    const shortcuts = registry.buildOptionalShortcuts(selected);

    expect(selectedIds.has("editing")).toBe(true);
    expect(selectedIds.has("planning")).toBe(true);
    expect(selectedIds.has("fileManagement")).toBe(true);
    expect(selectedIds.has("terminal")).toBe(true);
    expect(shortcuts).toContain("files");
    expect(shortcuts).toContain("read");
    expect(shortcuts).toContain("edit");
    expect(
      selected.selected.some((skill) => skill.tools.includes("create_file")),
    ).toBe(true);
    expect(
      selected.selected.some((skill) =>
        skill.tools.includes("create_directory"),
      ),
    ).toBe(true);
  });
});
