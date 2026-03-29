import { describe, expect, it, vi } from "vitest";

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

  it("falls back to cmd for chained commands on Windows shells", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const executor = new TerminalExecutor();
    vi.spyOn(executor as any, "findWindowsShell").mockReturnValue(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );

    const shell = (executor as any).resolveShellCommand(
      "node --version && npm --version",
    );

    expect(shell.executable.toLowerCase()).toContain("cmd.exe");
    expect(shell.args).toContain("/c");
  });
});
