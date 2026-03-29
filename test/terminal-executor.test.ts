import { describe, expect, it } from "vitest";

import { TerminalExecutor } from "../src/agent/terminal/TerminalExecutor";

describe("TerminalExecutor", () => {
  it("runs a simple command and captures output", async () => {
    const executor = new TerminalExecutor();
    const result = await executor.execute(
      `node -e "process.stdout.write('ok')"`,
      {
        timeoutMs: 10_000,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("ok");
  });

  it("returns actionable output for missing executables", async () => {
    const executor = new TerminalExecutor();
    const result = await executor.execute(
      "pulse-command-that-does-not-exist-anywhere --version",
      {
        timeoutMs: 10_000,
      },
    );

    expect(result.exitCode).toBe(127);
    expect(result.output.toLowerCase()).toContain("executable not found");
  });
});
