import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi, afterEach } from "vitest";

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
    vi.spyOn(
      AgentRuntime.prototype as any,
      "bootstrapWorkspaceContext",
    ).mockResolvedValue([]);

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

  it("deduplicates model discovery refreshes", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-model-cache-test-"),
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

    const provider = {
      providerType: "ollama",
      healthCheck: vi.fn().mockResolvedValue({ ok: true, message: "ok" }),
      listModels: vi
        .fn()
        .mockResolvedValue([{ name: "qwen2.5-coder:7b", source: "local" }]),
      chat: vi.fn(),
    } as any;

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
      provider,
    );

    await Promise.all([
      runtime.refreshProviderState(true),
      runtime.refreshProviderState(true),
    ]);

    expect(provider.healthCheck).toHaveBeenCalledTimes(1);
    expect(provider.listModels).toHaveBeenCalledTimes(1);

    await runtime.listAvailableModels();
    expect(provider.listModels).toHaveBeenCalledTimes(1);
  });

  it("creates directories and nested files with filesystem tools", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-filesystem-tools-test-"),
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

    const vscodeApi = await import("vscode");
    const previousWorkspaceFolders = vscodeApi.workspace.workspaceFolders;
    (vscodeApi.workspace as any).workspaceFolders = [
      { uri: { fsPath: tempRoot } },
    ] as any;
    const createDirectory = vi.mocked(vscodeApi.workspace.fs.createDirectory);
    const writeFile = vi.mocked(vscodeApi.workspace.fs.writeFile);

    try {
      const runtime = new AgentRuntime(
        {
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
        },
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

      const createDirResult = await (runtime as any).executeSingleToolCall(
        { tool: "create_directory", args: { path: "backend/src" } },
        "Build from scratch",
      );
      expect(createDirResult[0]?.ok).toBe(true);
      expect(createDirectory).toHaveBeenCalledWith({
        fsPath: path.join(tempRoot, "backend", "src"),
      });

      const createFileResult = await (runtime as any).executeSingleToolCall(
        {
          tool: "create_file",
          args: {
            filePath: "backend/src/app.py",
            content: "print('hello world')",
          },
        },
        "Build from scratch",
      );
      expect(createFileResult[0]?.ok).toBe(true);
      expect(createDirectory).toHaveBeenCalledWith({
        fsPath: path.join(tempRoot, "backend", "src"),
      });
      expect(writeFile).toHaveBeenCalledWith(
        { fsPath: path.join(tempRoot, "backend", "src", "app.py") },
        Buffer.from("print('hello world')", "utf8"),
      );

      // Reset tool cooling so the second call isn't rate-limited
      (runtime as any).toolCooling.resetAll();

      const emptyFileResult = await (runtime as any).executeSingleToolCall(
        {
          tool: "create_file",
          args: {
            filePath: "backend/src/empty.py",
            content: "",
          },
        },
        "Build from scratch",
      );
      expect(emptyFileResult[0]?.ok).toBe(false);
      expect(emptyFileResult[0]?.summary).toContain(
        "create_file requires non-empty content",
      );
      expect(writeFile).toHaveBeenCalledTimes(1);
    } finally {
      (vscodeApi.workspace as any).workspaceFolders = previousWorkspaceFolders;
    }
  });

  it("counts token usage during explainText", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-explain-token-test-"),
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

    const provider = {
      providerType: "ollama",
      healthCheck: vi.fn(),
      listModels: vi.fn(),
      chat: vi.fn().mockResolvedValue({
        text: "Explanation text.",
        tokenUsage: {
          promptTokens: 25,
          completionTokens: 10,
          totalTokens: 35,
        },
      }),
    } as any;

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
      provider,
    );

    (runtime as any).availableModels = [
      { name: config.fastModel, source: "local" },
    ];
    (runtime as any).availableModelsCheckedAt = Date.now();
    (runtime as any).tokenBudget.consumeRaw(480);
    (runtime as any).activeTokenSessionId = "session-a";

    const tokenUpdates: Array<{
      consumed: number;
      budget: number;
      percent: number;
    }> = [];
    runtime.setTokenCallback((snapshot) => tokenUpdates.push(snapshot));

    const result = await runtime.explainText("const value = 1;");

    expect(result.text).toBe("Explanation text.");
    // Token accounting now correctly accumulates explain tokens via TokenBudget
    expect((runtime as any).tokenBudget.snapshot().consumed).toBe(480 + 35);
    expect(provider.chat).toHaveBeenCalledTimes(1);
    // Token callback should have been called with the updated total
    expect(tokenUpdates.length).toBeGreaterThan(0);
  });

  it("cancels queued tasks instead of starting them after abort", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-cancel-queue-test-"),
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

    const executeTaskSpy = vi
      .spyOn(AgentRuntime.prototype as any, "executeTask")
      .mockImplementation(async (_request: unknown, signal?: any) => {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("__TASK_CANCELLED__")),
            { once: true },
          );
        });
        return {
          sessionId: "session",
          objective: "queued task",
          plan: {
            objective: "queued task",
            assumptions: [],
            acceptanceCriteria: [],
            todos: [],
            steps: [],
            taskSlices: [],
            verification: [],
          },
          todos: [],
          responseText: "Task cancelled.",
          proposal: null,
        } as any;
      });

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

    const first = runtime.runTask({ objective: "first", action: "new" });
    await vi.waitFor(() => expect(executeTaskSpy).toHaveBeenCalledTimes(1));
    const second = runtime.runTask({ objective: "second", action: "new" });

    runtime.cancelTask();

    await expect(first).rejects.toThrow("__TASK_CANCELLED__");
    const secondResult = await second;
    expect(secondResult.responseText).toBe("Task cancelled.");
    expect(executeTaskSpy).toHaveBeenCalledTimes(1);
  });

  it("cancels an active task when opening a different session", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-open-session-cancel-test-"),
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

    const executeTaskSpy = vi
      .spyOn(AgentRuntime.prototype as any, "executeTask")
      .mockImplementation(async (_request: unknown, signal?: any) => {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("__TASK_CANCELLED__")),
            { once: true },
          );
        });
        return {
          sessionId: "session",
          objective: "session switch",
          plan: {
            objective: "session switch",
            assumptions: [],
            acceptanceCriteria: [],
            todos: [],
            steps: [],
            taskSlices: [],
            verification: [],
          },
          todos: [],
          responseText: "Task cancelled.",
          proposal: null,
        } as any;
      });

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

    const firstTask = runtime.runTask({ objective: "first", action: "new" });
    await vi.waitFor(() => expect(executeTaskSpy).toHaveBeenCalledTimes(1));

    const secondSession = await (runtime as any).sessionStore.createSession(
      "second session",
      {
        planner: config.plannerModel,
        editor: config.editorModel,
        fast: config.fastModel,
      },
    );

    await runtime.openSession(secondSession.id);

    await expect(firstTask).rejects.toThrow("__TASK_CANCELLED__");
    expect(executeTaskSpy).toHaveBeenCalledTimes(1);
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
    ).toBe(true);
    expect(
      (runtime as any).shouldAutoApplyProposal([{ operation: "delete" }]),
    ).toBe(false);

    (runtime as any).permissionPolicy.setMode("strict");
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

    expect(summary).toContain("- Issue:");
    expect(summary).toContain("could conflict");
    expect(summary).toContain("- Next steps:");
    expect(summary).toContain("empty directory");
  });

  it("writes a detailed fallback summary for successful work instead of a generic status line", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-summary-success-test-"),
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
            tool: "workspace_scan",
            ok: true,
            summary: "Loaded workspace inventory (8 files).",
            detail: "package.json",
          },
          {
            tool: "run_verification",
            ok: true,
            summary: "pnpm build exited with 0.",
            detail: "Build succeeded.",
          },
        ],
        proposal: null,
        autoApplied: true,
        fileDiffs: [
          {
            fileName: "app/page.tsx",
            filePath: "app/page.tsx",
            isNew: false,
            isDelete: false,
            hunks: [],
            additions: 18,
            deletions: 3,
          },
        ],
        qualityScore: 0.94,
        qualityTarget: 0.9,
        meetsQualityTarget: true,
      },
      "Task completed.",
      true,
    );

    expect(summary).toContain(
      "Completed the requested work for Create a Next.js app.",
    );
    expect(summary).toContain("- What changed:");
    expect(summary).toContain("app/page.tsx");
    expect(summary).toContain("- Verification:");
  });

  it("keeps plan mode chat output concise instead of duplicating the full plan", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-plan-mode-test-"),
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
      conversationMode: "plan",
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

    const plannerSpy = vi
      .spyOn(Planner.prototype, "createPlan")
      .mockResolvedValue({
        objective: "Build a blog platform",
        assumptions: ["Use a clean workspace."],
        acceptanceCriteria: ["Project is scaffolded."],
        todos: [
          {
            id: "todo-1",
            title: "Scaffold the app",
            status: "done",
          },
        ],
        steps: [
          {
            goal: "Create the project structure",
            tools: ["create_file"],
            expectedOutput: "A scaffolded app.",
          },
        ],
        taskSlices: [],
        verification: [],
      } as any);

    const writePlanSpy = vi
      .spyOn(AgentRuntime.prototype as any, "writePlanArtifact")
      .mockResolvedValue(null);
    const collectResearchSpy = vi
      .spyOn(AgentRuntime.prototype as any, "collectWebResearch")
      .mockResolvedValue(null);
    const persistSpy = vi
      .spyOn(AgentRuntime.prototype as any, "persistTaskResult")
      .mockResolvedValue(undefined);
    vi.spyOn(
      AgentRuntime.prototype as any,
      "resolveModelOrFallback",
    ).mockResolvedValue("qwen2.5-coder:7b");

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

    const result = await runtime.runTask({
      objective: "Build a blog platform",
      action: "new",
    });

    expect(plannerSpy).toHaveBeenCalledTimes(1);
    expect(writePlanSpy).toHaveBeenCalledTimes(1);
    expect(collectResearchSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(result.responseText).toContain("Plan mode active.");
    expect(result.responseText).not.toContain("**Objective:**");
    expect(result.responseText).not.toContain("**Steps:**");
    expect(result.responseText).not.toContain("**Todos:**");
    expect(result.responseText).not.toContain("**Acceptance criteria:**");
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

    expect(summary).toContain("- Issue:");
    expect(summary).toContain("requested change was not applied");
    expect(summary).toContain("- Next steps:");
    expect(summary).toContain("one focused code change at a time");
  });

  it("treats bare continue requests as a continuation of the active objective", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pulse-runtime-continue-test-"),
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
      id: "session-continue-1",
      objective: "Edit the homepage to add a header and footer",
      title: "Edit the homepage to add a header and footer",
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
      conversationMode: "plan",
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

    const plannerSpy = vi
      .spyOn(Planner.prototype, "createPlan")
      .mockResolvedValue({
        objective: currentSession.objective,
        assumptions: [],
        acceptanceCriteria: [],
        todos: [],
        steps: [],
        taskSlices: [],
        verification: [],
      } as any);
    vi.spyOn(
      AgentRuntime.prototype as any,
      "writePlanArtifact",
    ).mockResolvedValue(null);
    vi.spyOn(
      AgentRuntime.prototype as any,
      "collectWebResearch",
    ).mockResolvedValue(null);
    vi.spyOn(
      AgentRuntime.prototype as any,
      "persistTaskResult",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      AgentRuntime.prototype as any,
      "resolveModelOrFallback",
    ).mockResolvedValue("qwen2.5-coder:7b");

    const sessionMethods = SessionStore.prototype as any;
    vi.spyOn(sessionMethods, "getActiveSession").mockResolvedValue(
      currentSession,
    );
    vi.spyOn(sessionMethods, "appendMessage").mockResolvedValue(undefined);
    vi.spyOn(sessionMethods, "getSession").mockResolvedValue(currentSession);

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

    const result = await runtime.runTask({
      objective: "continue",
      action: "new",
    });

    expect(plannerSpy).toHaveBeenCalledWith(
      currentSession.objective,
      expect.any(String),
    );
    expect(result.objective).toBe(currentSession.objective);
  });
});
