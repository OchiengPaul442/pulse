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
    window: { showInformationMessage: vi.fn(), showWarningMessage: vi.fn(), activeTextEditor: null },
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
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-attach-test-"));
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
      { search: vi.fn(), formatResult: vi.fn(), setTavilyApiKey: vi.fn(), clearTavilyApiKey: vi.fn(), hasTavilyApiKey: vi.fn() } as any,
    );

    // Spy expandAttachmentPaths to ensure it's called with sliced list
    const expandSpy = vi.spyOn(AgentRuntime.prototype as any, "expandAttachmentPaths").mockResolvedValue([
      "/a/one.txt",
      "/a/two.txt",
      "/a/three.txt",
      "/a/four.txt",
      "/a/five.txt",
    ]);

    const readSpy = vi.spyOn((runtime as any).scanner, "readContextSnippets").mockResolvedValue([
      { path: "/a/one.txt", content: "a".repeat(100) },
      { path: "/a/two.txt", content: "b".repeat(100) },
      { path: "/a/three.txt", content: "c".repeat(100) },
    ] as any);

    const inputPaths = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const result = await (runtime as any).loadAttachedFileContext(inputPaths);

    // expandAttachmentPaths should be called with only the first `maxAttachedFiles` (3)
    expect(expandSpy).toHaveBeenCalledWith(inputPaths.slice(0, 3), undefined);

    // readContextSnippets should be called with at most `maxAttachedFiles` and the configured maxCharsPerFile
    expect(readSpy).toHaveBeenCalledWith(expect.any(Array), 50, undefined);

    // Result should be the mocked snippets (unchanged)
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });
});
