import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
  },
  workspace: {
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
  },
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
}));

import { AgentRuntime } from "../src/agent/runtime/AgentRuntime";
import type { AgentConfig } from "../src/config/AgentConfig";
import type { StorageState } from "../src/db/StorageBootstrap";
import { Planner } from "../src/agent/planner/Planner";
import { OllamaProvider } from "../src/agent/model/OllamaProvider";
import { WorkspaceScanner } from "../src/agent/indexing/WorkspaceScanner";
import { SessionStore } from "../src/agent/sessions/SessionStore";
import { EditManager } from "../src/agent/edits/EditManager";
import { ImprovementEngine } from "../src/agent/improvement/ImprovementEngine";

type MockSession = {
  id: string;
  objective: string;
  title: string;
  messages: Array<{
    id?: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  }>;
  attachedFiles: string[];
  lastResult?: string;
  updatedAt: string;
};

describe("AgentRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs agent workflow without referencing an undefined plan", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-test-"),
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

    const currentSession: MockSession = {
      id: "session-1",
      objective: "Create a tiny project",
      title: "Create a tiny project",
      messages: [],
      attachedFiles: [],
      updatedAt: new Date().toISOString(),
    };

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

    vi.spyOn(
      AgentRuntime.prototype as any,
      "resolveModelOrFallback",
    ).mockResolvedValue("qwen2.5-coder:7b");
    vi.spyOn(
      AgentRuntime.prototype as any,
      "getLearnedStyleHint",
    ).mockResolvedValue("");
    vi.spyOn(
      AgentRuntime.prototype as any,
      "collectWebResearch",
    ).mockResolvedValue(null);
    vi.spyOn(
      AgentRuntime.prototype as any,
      "loadAttachedFileContext",
    ).mockResolvedValue([]);
    vi.spyOn(
      AgentRuntime.prototype as any,
      "learnFromExchange",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      AgentRuntime.prototype as any,
      "selfReflectBackground",
    ).mockImplementation(() => undefined);

    vi.spyOn(Planner.prototype, "createPlan").mockResolvedValue({
      objective: "Create a tiny project",
      assumptions: ["Workspace is available."],
      acceptanceCriteria: ["Create a project scaffold."],
      todos: [{ id: "todo_1", title: "Inspect workspace", status: "pending" }],
      steps: [],
      taskSlices: [],
      verification: [],
    });

    vi.spyOn(OllamaProvider.prototype, "chat").mockResolvedValue({
      text: JSON.stringify({
        response: "Created a starter project plan.",
        todos: [],
        toolCalls: [],
        edits: [],
        shortcuts: [],
      }),
      raw: {},
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    } as any);

    vi.spyOn(WorkspaceScanner.prototype, "findRelevantFiles").mockResolvedValue(
      [],
    );
    vi.spyOn(
      WorkspaceScanner.prototype,
      "readContextSnippets",
    ).mockResolvedValue([]);
    vi.spyOn(
      ImprovementEngine.prototype,
      "getOptimizedBehaviorHints",
    ).mockResolvedValue("");
    vi.spyOn(
      ImprovementEngine.prototype,
      "getAgentAwarenessHints",
    ).mockReturnValue("");
    vi.spyOn(EditManager.prototype, "clearPendingProposal").mockResolvedValue(
      undefined,
    );

    const sessionMethods = SessionStore.prototype as any;
    vi.spyOn(sessionMethods, "getActiveSession").mockResolvedValue(null);
    vi.spyOn(sessionMethods, "createSession").mockImplementation(
      async (...args: unknown[]) => {
        const objective = args[0] as string;
        currentSession.objective = objective;
        currentSession.title = objective;
        currentSession.messages = [];
        currentSession.attachedFiles = [];
        currentSession.updatedAt = new Date().toISOString();
        return currentSession;
      },
    );
    vi.spyOn(sessionMethods, "appendMessage").mockImplementation(
      async (...args: unknown[]) => {
        const message = args[1] as any;
        currentSession.messages.push(message);
        currentSession.updatedAt = new Date().toISOString();
      },
    );
    vi.spyOn(sessionMethods, "updateSessionResult").mockImplementation(
      async (...args: unknown[]) => {
        const resultText = args[1] as string;
        currentSession.lastResult = resultText;
        currentSession.updatedAt = new Date().toISOString();
      },
    );
    vi.spyOn(sessionMethods, "getSession").mockResolvedValue(currentSession);

    const runtime = new AgentRuntime(
      config,
      storage,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      {
        search: vi.fn(),
        formatResult: vi.fn(),
        setTavilyApiKey: vi.fn(),
        clearTavilyApiKey: vi.fn(),
        hasTavilyApiKey: vi.fn(),
      } as any,
    );

    const result = await runtime.runTask({
      objective: "Create a tiny project",
      action: "new",
    });

    expect(result.plan.objective).toBe("Create a tiny project");
    expect(result.plan.todos).toHaveLength(1);
    expect(result.responseText).toBe("Created a starter project plan.");
    expect(result.todos).toHaveLength(1);
  });

  it("restores the most recent session when no active session is stored", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-restore-session-test-"),
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

    const recentSession: MockSession = {
      id: "session-latest",
      objective: "Restore the latest conversation",
      title: "Restore the latest conversation",
      messages: [],
      attachedFiles: [],
      updatedAt: new Date().toISOString(),
    };

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

    vi.spyOn(OllamaProvider.prototype, "healthCheck").mockResolvedValue({
      ok: true,
      message: "Ollama reachable",
    } as any);
    vi.spyOn(OllamaProvider.prototype, "listModels").mockResolvedValue([]);

    const sessionMethods = SessionStore.prototype as any;
    vi.spyOn(sessionMethods, "getActiveSession").mockResolvedValue(null);
    vi.spyOn(sessionMethods, "getMostRecentSession").mockResolvedValue(
      recentSession,
    );
    const setActiveSessionSpy = vi
      .spyOn(sessionMethods, "setActiveSession")
      .mockResolvedValue(undefined);

    const runtime = new AgentRuntime(
      config,
      storage,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      {
        search: vi.fn(),
        formatResult: vi.fn(),
        setTavilyApiKey: vi.fn(),
        clearTavilyApiKey: vi.fn(),
        hasTavilyApiKey: vi.fn(),
      } as any,
    );

    await runtime.initialize();

    expect(setActiveSessionSpy).toHaveBeenCalledWith("session-latest");
  });

  it("treats short task-like prompts as agent work", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-routing-test-"),
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

    const runtime = new AgentRuntime(
      config,
      storage,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as any,
      {
        search: vi.fn(),
        formatResult: vi.fn(),
        setTavilyApiKey: vi.fn(),
        clearTavilyApiKey: vi.fn(),
        hasTavilyApiKey: vi.fn(),
      } as any,
    );

    expect((runtime as any).isSimpleConversational("fix it")).toBe(false);
    expect((runtime as any).shouldAllowEdits("fix it")).toBe(true);
    expect((runtime as any).isSimpleConversational("hello")).toBe(true);
    expect(
      (runtime as any).shouldAutoApplyProposal([{ operation: "write" }]),
    ).toBe(false);
  });

  it("builds a model-driven completion summary when evidence exists", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-summary-test-"),
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
      performanceProfile: "balanced",
      qualityTargetScore: 0.9,
    };

    const runtime = new AgentRuntime(
      config,
      storage,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as any,
      {
        search: vi.fn(),
        formatResult: vi.fn(),
        setTavilyApiKey: vi.fn(),
        clearTavilyApiKey: vi.fn(),
        hasTavilyApiKey: vi.fn(),
      } as any,
    );

    vi.spyOn(
      AgentRuntime.prototype as any,
      "resolveModelOrFallback",
    ).mockResolvedValue("qwen2.5-coder:7b");

    const summaryText =
      "The agent inspected the scroll logic, found the visibility check was too loose, updated the button state, and verified the fix with tests.";

    const chatSpy = vi
      .spyOn(OllamaProvider.prototype, "chat")
      .mockResolvedValue({
        text: summaryText,
        raw: {},
        tokenUsage: { promptTokens: 10, completionTokens: 18, totalTokens: 28 },
      } as any);

    const summary = await (runtime as any).buildTaskCompletionSummary({
      objective: "Fix the scroll button",
      rawResponseText: "Task completed.",
      todos: [{ id: "todo_1", title: "Inspect scroll logic", status: "done" }],
      toolTrace: [
        {
          tool: "read_files",
          ok: true,
          summary: "Read 2 file(s).",
          detail: "File: src/views/PulseSidebarProvider.ts\n...",
        },
        {
          tool: "run_verification",
          ok: true,
          summary: "npm test exited with 0.",
          detail: "All checks passed.",
        },
      ],
      proposal: {
        id: "proposal-1",
        objective: "Fix the scroll button",
        createdAt: new Date().toISOString(),
        edits: [
          {
            operation: "write",
            filePath: "src/views/PulseSidebarProvider.ts",
            reason: "Only show the scroll button when the chat overflows.",
          },
        ],
      },
      autoApplied: true,
      fileDiffs: [
        {
          fileName: "PulseSidebarProvider.ts",
          filePath: "src/views/PulseSidebarProvider.ts",
          isNew: false,
          isDelete: false,
          hunks: [],
          additions: 3,
          deletions: 1,
        },
      ],
      qualityScore: 0.94,
      qualityTarget: 0.9,
      meetsQualityTarget: true,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(summary).toBe(summaryText);
  });

  it("includes issue and next-step options when terminal output fails", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-summary-issue-test-"),
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

    const runtime = new AgentRuntime(
      config,
      storage,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as any,
      {
        search: vi.fn(),
        formatResult: vi.fn(),
        setTavilyApiKey: vi.fn(),
        clearTavilyApiKey: vi.fn(),
        hasTavilyApiKey: vi.fn(),
      } as any,
    );

    const summary = (runtime as any).buildTaskCompletionFallbackSummary(
      {
        objective: "Create a Next.js app",
        rawResponseText: "Task completed.",
        todos: [],
        toolTrace: [
          {
            tool: "run_terminal",
            ok: false,
            summary: "Command failed.",
            detail:
              "The directory tests contains files that could conflict: src/",
          },
        ],
        proposal: null,
        autoApplied: false,
        fileDiffs: [],
        qualityScore: 0.4,
        qualityTarget: 0.9,
        meetsQualityTarget: false,
      },
      "Task completed.",
      true,
    );

    expect(summary).toContain("## Issue");
    expect(summary).toContain("could conflict");
    expect(summary).toContain("## Next steps");
    expect(summary).toContain("empty directory");
  });

  it("reports incomplete edit tasks instead of saying nothing changed was needed", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-incomplete-edit-test-"),
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

    const runtime = new AgentRuntime(
      config,
      storage,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as any,
      {
        search: vi.fn(),
        formatResult: vi.fn(),
        setTavilyApiKey: vi.fn(),
        clearTavilyApiKey: vi.fn(),
        hasTavilyApiKey: vi.fn(),
      } as any,
    );

    const summary = (runtime as any).buildTaskCompletionFallbackSummary(
      {
        objective: "Refactor the home page layout",
        rawResponseText: "Task completed.",
        todos: [],
        toolTrace: [
          {
            tool: "run_verification",
            ok: true,
            summary: "pnpm test exited with 0.",
            detail: "All checks passed.",
          },
        ],
        proposal: null,
        autoApplied: false,
        fileDiffs: [],
        qualityScore: 0.59,
        qualityTarget: 0.9,
        meetsQualityTarget: false,
      },
      "Task completed.",
      true,
    );

    expect(summary).toContain("## Issue");
    expect(summary).toContain("requested change was not applied");
    expect(summary).toContain("## Next steps");
    expect(summary).toContain("one focused code change at a time");
  });
});
