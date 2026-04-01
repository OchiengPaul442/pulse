import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("vscode", () => {
  const workspace: Record<string, unknown> = {
    workspaceFolders: [],
    fs: {
      createDirectory: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      delete: vi.fn(),
      rename: vi.fn(),
      stat: vi.fn(),
    },
    getConfiguration: vi.fn(() => ({
      get: vi.fn(),
    })),
  };
  return {
    Uri: {
      file: (fsPath: string) => ({ fsPath }),
    },
    workspace,
    commands: {
      executeCommand: vi.fn(),
    },
    window: {
      activeTextEditor: null,
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
    },
    secrets: {
      get: vi.fn(),
      store: vi.fn(),
      delete: vi.fn(),
    },
    extensions: {
      all: [],
    },
  };
});

import { AgentRuntime } from "../src/agent/runtime/AgentRuntime";
import type { AgentConfig } from "../src/config/AgentConfig";
import type { StorageState } from "../src/db/StorageBootstrap";

function makeRuntime(): AgentRuntime {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pulse-audit-fix-test-"),
  );
  const storage: StorageState = {
    storageDir: tempRoot,
    dbPath: path.join(tempRoot, "db.sqlite"),
    tracesDir: path.join(tempRoot, "traces"),
    snapshotsDir: path.join(tempRoot, "snapshots"),
    sessionsPath: path.join(tempRoot, "sessions.json"),
    memoriesPath: path.join(tempRoot, "memories.json"),
    editsPath: path.join(tempRoot, "edits.json"),
    improvementPath: path.join(tempRoot, "improvement.json"),
  };
  fs.mkdirSync(storage.tracesDir, { recursive: true });
  fs.mkdirSync(storage.snapshotsDir, { recursive: true });

  const config: AgentConfig = {
    ollamaBaseUrl: "http://127.0.0.1:11434",
    plannerModel: "qwen2.5-coder:7b",
    editorModel: "qwen2.5-coder:7b",
    fastModel: "qwen2.5-coder:7b",
    embeddingModel: "nomic-embed-text",
    fallbackModels: ["qwen2.5-coder:7b"],
    approvalMode: "balanced",
    permissionMode: "default",
    conversationMode: "agent",
    persona: "software-engineer",
    allowTerminalExecution: false,
    autoRunVerification: false,
    maxContextTokens: 16384,
    memoryMode: "off",
    indexingEnabled: false,
    indexingMode: "light",
    mcpServers: [],
    telemetryOptIn: false,
    selfLearnEnabled: false,
    providerType: "ollama",
    openaiBaseUrl: "",
    openaiApiKey: "",
    openaiModels: [],
    performanceProfile: "auto",
    qualityTargetScore: 0.9,
  };

  return new AgentRuntime(
    config,
    storage,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    {
      search: vi.fn(),
      formatResult: vi.fn(),
      setTavilyApiKey: vi.fn(),
      clearTavilyApiKey: vi.fn(),
      hasTavilyApiKey: vi.fn(),
    } as any,
  );
}

describe("Audit fix: buildConversationHistory includes assistant messages", () => {
  it("includes both user and assistant messages in the summary", async () => {
    const runtime = makeRuntime();

    const messages = [];
    // Create > 40 messages to trigger summarisation
    for (let i = 0; i < 50; i++) {
      messages.push({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} content`,
        createdAt: new Date().toISOString(),
      });
    }

    const buildHistory = (runtime as any).buildConversationHistory.bind(
      runtime,
    );
    const history = await buildHistory(messages);

    // The first message should be a summary that includes Agent: entries
    const summaryMessage = history[0];
    expect(summaryMessage.content).toContain("Agent:");
    expect(summaryMessage.content).toContain("User:");
  });
});

describe("Audit fix: reconcileTodoProgress allows valid regression", () => {
  it("prevents regression without justification", () => {
    const reconcile = (AgentRuntime.prototype as any).reconcileTodoProgress;

    const previous = [{ id: "todo_1", title: "Fix bug", status: "done" }];
    const next = [{ id: "todo_1", title: "Fix bug", status: "in-progress" }];

    const result = reconcile(previous, next);
    expect(result[0].status).toBe("done");
  });

  it("allows regression with explicit revision detail", () => {
    const reconcile = (AgentRuntime.prototype as any).reconcileTodoProgress;

    const previous = [{ id: "todo_1", title: "Fix bug", status: "done" }];
    const next = [
      {
        id: "todo_1",
        title: "Fix bug",
        status: "in-progress",
        detail: "Previous fix was wrong, need to revise",
      },
    ];

    const result = reconcile(previous, next);
    expect(result[0].status).toBe("in-progress");
  });
});

describe("Audit fix: executeTaskToolCalls reports dropped calls", () => {
  it("generates observations for dropped tool calls beyond limit", async () => {
    const runtime = makeRuntime();
    const execute = (runtime as any).executeTaskToolCalls.bind(runtime);

    // Mock executeSingleToolCall to return a simple observation
    (runtime as any).executeSingleToolCall = vi
      .fn()
      .mockResolvedValue([
        { tool: "read_files", ok: true, summary: "Read file ok" },
      ]);

    const sevenCalls = Array.from({ length: 7 }, (_, i) => ({
      tool: "read_files" as const,
      args: { path: `file${i}.ts` },
      reason: `Read file ${i}`,
    }));

    const observations = await execute(sevenCalls, "test", undefined);

    // Should have 5 executed + 2 dropped
    const droppedObs = observations.filter((o: any) =>
      o.summary.includes("dropped"),
    );
    expect(droppedObs).toHaveLength(2);
    expect(droppedObs[0].ok).toBe(false);
  });
});

describe("Audit fix: isSimpleConversational regex-based matching", () => {
  function check(input: string): boolean {
    return (AgentRuntime.prototype as any).isSimpleConversational.call(
      {
        isTaskLikeObjective: (AgentRuntime.prototype as any)
          .isTaskLikeObjective,
      },
      input,
    );
  }

  it("detects basic greetings", () => {
    expect(check("hello")).toBe(true);
    expect(check("Hi!")).toBe(true);
    expect(check("hey")).toBe(true);
    expect(check("Good morning!")).toBe(true);
    expect(check("thank you")).toBe(true);
    expect(check("thanks")).toBe(true);
    expect(check("what can you do")).toBe(true);
    expect(check("help me")).toBe(true);
  });

  it("rejects task-like messages even if they start with a greeting", () => {
    expect(check("hey, fix this bug")).toBe(false);
    expect(check("help me fix the tests")).toBe(false);
    expect(check("hi, can you refactor this file")).toBe(false);
  });

  it("rejects clearly task-oriented input", () => {
    expect(check("fix the login page")).toBe(false);
    expect(check("add a new test for the parser")).toBe(false);
    expect(check("run the build")).toBe(false);
  });
});

describe("Audit fix: self-learn loop backpressure", () => {
  it("sets selfLearnRunning flag on runtime", () => {
    const runtime = makeRuntime();
    expect((runtime as any).selfLearnRunning).toBe(false);
  });
});

describe("Audit fix: detectPackageManager is async", () => {
  it("returns a promise", () => {
    const runtime = makeRuntime();
    const result = (runtime as any).detectPackageManager("/some/path");
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("Audit fix: Planner fallback plan has isFallback flag", () => {
  it("fallback plan includes isFallback: true", async () => {
    const { Planner } = await import("../src/agent/planner/Planner.js");
    const failingProvider = {
      chat: vi.fn().mockRejectedValue(new Error("model unavailable")),
    };
    const planner = new Planner(failingProvider as any);
    const plan = await planner.createPlan("do something", "test-model");
    expect(plan.isFallback).toBe(true);
    expect(plan.objective).toBe("do something");
  });
});

describe("Audit fix: agent placeholder responses are treated as generic", () => {
  it("marks repeated workspace-scan summaries as generic task responses", () => {
    const runtime = makeRuntime();

    expect(
      (runtime as any).isGenericTaskResponse(
        "Workspace scanned; only .vscode/settings.json exists.",
      ),
    ).toBe(true);
  });
});

describe("Audit fix: runtime only tracks todos for complex work", () => {
  it("skips todos for simple direct git inspection tasks", () => {
    const runtime = makeRuntime();

    expect(
      (runtime as any).shouldTrackTodosForObjective(
        "Show git blame for src/extension.ts",
      ),
    ).toBe(false);
    expect(
      (runtime as any).shouldTrackTodosForObjective(
        "Implement a new authentication flow across the workspace",
      ),
    ).toBe(true);
  });
});
