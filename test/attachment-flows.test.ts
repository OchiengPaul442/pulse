import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("vscode", () => {
  const Uri = {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({ fsPath: [base.fsPath, ...segments].join("/") }),
  };

  const workspace = {
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
    fs: {
      readFile: vi.fn(),
      stat: vi.fn(),
      createDirectory: vi.fn(),
      writeFile: vi.fn(),
      delete: vi.fn(),
      rename: vi.fn(),
    },
    findFiles: vi.fn(),
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
  } as any;

  const window = {
    showQuickPick: vi.fn(),
    showOpenDialog: vi.fn(),
    activeTextEditor: null,
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  } as any;

  return {
    Uri,
    workspace,
    window,
    commands: { executeCommand: vi.fn() },
    secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
    extensions: { all: [] },
  };
});

import * as path from "path";
import { PulseSidebarProvider } from "../src/views/PulseSidebarProvider";

describe("Attachment flows (sidebar)", () => {
  let runtime: any;
  let provider: any;
  let posted: Array<any>;
  let messageHandler: (m: any) => Promise<void> | void;
  let webview: any;
  let webviewView: any;

  beforeEach(() => {
    posted = [];
    messageHandler = () => {};

    webview = {
      cspSource: "vscode-resource:",
      asWebviewUri: (u: any) => (u && u.fsPath) || u,
      postMessage: (m: any) => {
        posted.push(m);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (cb: (m: any) => void) => {
        messageHandler = cb as any;
      },
    };

    webviewView = {
      webview,
      visible: true,
      onDidChangeVisibility: (cb: () => void) => {},
    } as any;

    runtime = {
      refreshProviderState: vi.fn().mockResolvedValue(undefined),
      summary: vi.fn().mockResolvedValue({ ollamaReachable: false, status: "ready" }),
      listRecentSessions: vi.fn().mockResolvedValue([]),
      getConfiguredMcpServers: vi.fn().mockReturnValue([]),
      listAvailableModels: vi.fn().mockResolvedValue([]),
      attachFilesToActiveSession: vi.fn().mockImplementation(async (paths: string[]) => ({ attachedFiles: paths })),
      setProgressCallback: vi.fn(),
      setStreamCallback: vi.fn(),
      setTerminalOutputCallback: vi.fn(),
      setEnabledTools: vi.fn(),
      startNewConversation: vi.fn(),
      applyPendingEdits: vi.fn().mockResolvedValue(true),
      revertLastAppliedEdits: vi.fn().mockResolvedValue(true),
      acceptFileEdit: vi.fn().mockResolvedValue(true),
      rejectFileEdit: vi.fn().mockResolvedValue(true),
      setApprovalMode: vi.fn(),
      setPermissionMode: vi.fn(),
      selectModel: vi.fn(),
      setConfiguredMcpServers: vi.fn(),
      setConversationMode: vi.fn(),
      setPersona: vi.fn(),
      openSession: vi.fn().mockResolvedValue(null),
      deleteSession: vi.fn().mockResolvedValue({ deleted: false, wasActive: false }),
    } as any;

    provider = new PulseSidebarProvider({ fsPath: "/ext" } as any, runtime as any, { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any);
    // register handlers
    (provider as any).resolveWebviewView(webviewView);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles browse-image attach: previews and sessionAttachments", async () => {
    const vscode = await import("vscode");
    // Simulate user choosing 'browse-image' in the quick pick
    (vscode.window.showQuickPick as any).mockResolvedValue({ value: "browse-image" });
    // Simulate picking two images
    (vscode.window.showOpenDialog as any).mockResolvedValue([
      { fsPath: "/workspace/images/pic1.png" },
      { fsPath: "/workspace/images/pic2.jpg" },
    ]);

    // workspace.fs.stat and readFile
    (vscode.workspace.fs.stat as any).mockResolvedValue({ size: 1024 });
    (vscode.workspace.fs.readFile as any).mockResolvedValue(Buffer.from("abc"));

    // Trigger attachContext message
    await (messageHandler as any)({ type: "attachContext" });

    // Should post dropImage previews for each image
    const dropMessages = posted.filter((m) => m.type === "dropImage");
    expect(dropMessages.length).toBeGreaterThanOrEqual(2);
    expect(dropMessages.some((m) => m.payload && m.payload.name === "pic1.png")).toBe(true);

    // pendingImages on provider should include both
    const pending = (provider as any).pendingImages || [];
    expect(pending.some((p: any) => p.name === "pic1.png")).toBe(true);
    expect(pending.some((p: any) => p.name === "pic2.jpg")).toBe(true);

    // Should call runtime.attachFilesToActiveSession with picked fsPaths
    expect(runtime.attachFilesToActiveSession).toHaveBeenCalled();
    const lastAttachArgs = (runtime.attachFilesToActiveSession as any).mock.calls[0][0];
    expect(Array.isArray(lastAttachArgs)).toBe(true);
    expect(lastAttachArgs).toEqual(["/workspace/images/pic1.png", "/workspace/images/pic2.jpg"]);

    // Should post sessionAttachments and an actionResult
    expect(posted.some((m) => m.type === "sessionAttachments")).toBe(true);
    expect(posted.some((m) => m.type === "actionResult")).toBe(true);
  });

  it("handles browse attach (non-images): attaches files, no previews", async () => {
    const vscode = await import("vscode");
    (vscode.window.showQuickPick as any).mockResolvedValue({ value: "browse" });
    (vscode.window.showOpenDialog as any).mockResolvedValue([
      { fsPath: "/workspace/docs/readme.md" },
    ]);

    // Trigger attachContext
    await (messageHandler as any)({ type: "attachContext" });

    // No dropImage messages should be posted
    expect(posted.some((m) => m.type === "dropImage")).toBe(false);

    // runtime.attachFilesToActiveSession called with the file path
    expect(runtime.attachFilesToActiveSession).toHaveBeenCalled();
    const args = (runtime.attachFilesToActiveSession as any).mock.calls[0][0];
    expect(args).toEqual(["/workspace/docs/readme.md"]);

    // Should post sessionAttachments and an actionResult
    expect(posted.some((m) => m.type === "sessionAttachments")).toBe(true);
    expect(posted.some((m) => m.type === "actionResult")).toBe(true);
  });
});
