import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("vscode", () => {
  const workspace: any = {
    workspaceFolders: [],
    fs: {
      readFile: vi.fn(),
      stat: vi.fn(),
      createDirectory: vi.fn(),
      writeFile: vi.fn(),
      delete: vi.fn(),
      rename: vi.fn(),
    },
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
  };

  return {
    Uri: { file: (p: string) => ({ fsPath: p }) },
    workspace,
    commands: { executeCommand: vi.fn() },
    window: {
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      activeTextEditor: null,
    },
    secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
    extensions: { all: [] },
  };
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../src/agent/runtime/AgentRuntime";
import type { AgentConfig } from "../src/config/AgentConfig";

describe("Attached context trimming", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("limits expanded attachments and characters per file based on config", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-attach-test-"),
    );
    const storage: any = {
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
      plannerModel: "m:1",
      editorModel: "m:1",
      fastModel: "m:1",
      embeddingModel: "embed:latest",
      fallbackModels: [],
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
      persistenceScope: "global",
      uiSummaryVerbosity: "normal",
      uiShowSummaryToggle: true,
      // set config limits explicitly
      maxAttachedFiles: 3,
      maxCharsPerFile: 50,
    } as any;

    const runtime = new AgentRuntime(
      config,
      storage,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      {
        search: vi.fn(),
        formatResult: vi.fn(),
        setTavilyApiKey: vi.fn(),
        clearTavilyApiKey: vi.fn(),
        hasTavilyApiKey: vi.fn(),
      } as any,
    );

    // The ContextManager now handles file limiting. Mock the contextManager's buildContext method.
    const buildCtxSpy = vi
      .spyOn((runtime as any).contextManager, "buildContext")
      .mockResolvedValue({
        files: [
          {
            relativePath: "one.txt",
            sizeBytes: 100,
            tokenEstimate: 25,
            truncated: true,
          },
          {
            relativePath: "two.txt",
            sizeBytes: 100,
            tokenEstimate: 25,
            truncated: true,
          },
          {
            relativePath: "three.txt",
            sizeBytes: 100,
            tokenEstimate: 25,
            truncated: true,
          },
        ],
        totalTokens: 75,
        serialized:
          "<attached_context>\n--- one.txt\n" +
          "a".repeat(50) +
          "\n\n--- two.txt\n" +
          "b".repeat(50) +
          "\n\n--- three.txt\n" +
          "c".repeat(50) +
          "\n</attached_context>",
      });

    // Mock pathResolver.resolveAttachment so paths pass through
    vi.spyOn(
      (runtime as any).pathResolver,
      "resolveAttachment",
    ).mockImplementation((p: string) => "/a/" + p);

    const inputPaths = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const result = await (runtime as any).loadAttachedFileContext(inputPaths);

    // buildContext should have been called with resolved paths
    expect(buildCtxSpy).toHaveBeenCalledTimes(1);
    const resolvedArg = buildCtxSpy.mock.calls[0][0];
    expect(Array.isArray(resolvedArg)).toBe(true);

    // Result should contain the files from the mocked snapshot
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(3);
    expect(result[0].path).toBe("one.txt");
  });
});
