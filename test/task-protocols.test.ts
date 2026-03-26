import { describe, expect, it } from "vitest";

import {
  isSafeTerminalCommand,
  parseTaskResponse,
} from "../src/agent/runtime/TaskProtocols";

describe("TaskProtocols", () => {
  it("normalizes task responses with todos, tool calls, and edits", () => {
    const payload = {
      response: "Investigated the issue.",
      todos: ["Inspect runtime", { title: "Run tests", status: "done" }],
      toolCalls: [
        { tool: "read_file", args: { path: "src/app.ts" } },
        { tool: "run_terminal", args: { command: "npm test" } },
      ],
      edits: [
        {
          operation: "write",
          filePath: "src/app.ts",
          content: "export const ok = true;",
        },
      ],
    };

    const parsed = parseTaskResponse(JSON.stringify(payload));

    expect(parsed.response).toBe("Investigated the issue.");
    expect(parsed.todos).toHaveLength(2);
    expect(parsed.todos[0]?.title).toBe("Inspect runtime");
    expect(parsed.toolCalls).toHaveLength(2);
    expect(parsed.toolCalls[0]?.tool).toBe("read_files");
    expect(parsed.toolCalls[1]?.tool).toBe("run_terminal");
    expect(parsed.edits).toHaveLength(1);
    expect(parsed.edits[0]?.filePath).toBe("src/app.ts");
  });

  it("distinguishes safe verification commands from destructive ones", () => {
    expect(isSafeTerminalCommand("npm test")).toBe(true);
    expect(
      isSafeTerminalCommand('node -e "process.stdout.write(\"ok\")"'),
    ).toBe(false);
    expect(isSafeTerminalCommand("rm -rf node_modules")).toBe(false);
  });
});
