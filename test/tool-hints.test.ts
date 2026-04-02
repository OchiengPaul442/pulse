import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  languages: {
    getDiagnostics: () => [],
  },
  DiagnosticSeverity: { Error: 1, Warning: 2, Information: 3 },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}));

import { ToolRegistry } from "../src/agent/tooling/ToolRegistry";
import { SkillRegistry } from "../src/agent/skills/SkillRegistry";
import { VerificationRunner } from "../src/agent/verification/VerificationRunner";

describe("Tool hints integration", () => {
  it("includes compact tool hints in SkillRegistry summaries when registry provided", () => {
    const tr = new ToolRegistry();
    tr.register(
      "dummy_tool",
      { type: "object", properties: { foo: { type: "string" } } },
      "A dummy tool",
      "Tool `dummy_tool` args: { foo: string } - example prompt hint",
    );

    const sr = new SkillRegistry(tr);
    const selection = sr.selectForObjective(
      "run diagnostics and inspect files",
    );
    const summary = sr.summarizeSelection(selection);

    expect(summary).toContain("Tool hints");
    expect(summary).toContain("dummy_tool");
  });

  it("VerificationRunner appends compact tool hints to diagnostics summary", () => {
    const vr = new VerificationRunner();
    const toolHints = "- dummy_tool: example hint\n- another_tool: second hint";
    const res = vr.runDiagnostics(toolHints);
    expect(res.summary).toContain("Tool hints");
    expect(res.summary).toContain("dummy_tool");
  });
});
