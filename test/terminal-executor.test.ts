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
});
