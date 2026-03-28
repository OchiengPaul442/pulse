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

  it("drops malformed shortcuts and rejects unknown tool aliases", () => {
    const parsed = parseTaskResponse(
      JSON.stringify({
        response: "ok",
        shortcuts: ["  read  ", "read", "", "   ", 123, "scan"],
        toolCalls: [
          { tool: "read_file", args: { path: "src/app.ts" } },
          { tool: "rm_rf", args: { path: "/" } },
        ],
      }),
    );

    expect(parsed.shortcuts).toEqual(["read", "scan"]);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]?.tool).toBe("read_files");
  });

  it("falls back safely on malformed model JSON", () => {
    const parsed = parseTaskResponse("{ not valid json");

    expect(parsed.response).toBe("{ not valid json");
    expect(parsed.todos).toEqual([]);
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.edits).toEqual([]);
    expect(parsed.shortcuts).toEqual([]);
  });

  it("distinguishes safe verification commands from destructive ones", () => {
    expect(isSafeTerminalCommand("npm test")).toBe(true);
    expect(isSafeTerminalCommand("git status --short")).toBe(true);
    expect(
      isSafeTerminalCommand('node -e "process.stdout.write(\"ok\")"'),
    ).toBe(false);
    expect(isSafeTerminalCommand("rm -rf node_modules")).toBe(false);
    // Safe chains are now allowed when every segment is individually safe
    expect(isSafeTerminalCommand("git status && echo hi")).toBe(true);
    // Pipes are allowed when the first command is safe
    expect(isSafeTerminalCommand("npm test | tee output.txt")).toBe(true);
    expect(isSafeTerminalCommand("python -m pytest > report.txt")).toBe(false);
    // Mixed safe/unsafe chains are blocked
    expect(isSafeTerminalCommand("npm test && rm -rf /")).toBe(false);
    expect(isSafeTerminalCommand("cd my-app && npm install")).toBe(true);
    expect(
      isSafeTerminalCommand("pnpm create next-app@latest my-app --yes"),
    ).toBe(true);
  });
});
