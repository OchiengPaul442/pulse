import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";

import type { AgentRuntime } from "../agent/runtime/AgentRuntime";
import type { RuntimeSummary } from "../agent/runtime/AgentRuntime";
import type { AgentPersona } from "../config/AgentConfig";
import type { Logger } from "../platform/vscode/Logger";

export class PulseSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "pulse.sidebar";
  private pendingImages: Array<{ name: string; dataUrl: string }> = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly runtime: AgentRuntime,
    private readonly logger: Logger,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    try {
      this.resolveWebviewViewInner(webviewView);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("DEBUG: resolveWebviewView failed", err);
      this.logger.error(
        `Sidebar initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        webviewView.webview.html = `<html><body><p>Pulse failed to initialize. Check Output &gt; Pulse for details.</p></body></html>`;
      } catch {
        // Even the fallback HTML failed — nothing we can do
      }
    }
  }

  private resolveWebviewViewInner(webviewView: vscode.WebviewView): void {
    // Diagnostic: ensure this function is entered during tests
    // eslint-disable-next-line no-console
    console.error("DEBUG: resolveWebviewViewInner entered");
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    // Set HTML synchronously so webview renders immediately;
    // real state is pushed once the webview signals "webviewReady".
    webviewView.webview.html = this.buildHtml(webviewView.webview, null);

    // Use a thin wrapper around `webview.postMessage` so tests that
    // replace or mock the webview later still have their mock invoked
    // at call-time. Also log minimal diagnostics to aid failing tests.
    const post = async (msg: any) => {
      // Diagnostic for tests
      // eslint-disable-next-line no-console
      console.error(
        "DEBUG: post helper invoked",
        msg && typeof msg === "object" ? (msg as any).type : msg,
      );
      return await webviewView.webview.postMessage(msg);
    };

    // ── Push the full runtime state to the webview ─────────────────────
    let pushInFlight = false;
    let pushQueued = false;
    const fallbackSummary = (error: unknown) => ({
      status: "degraded" as const,
      ollamaReachable: false,
      conversationMode: "agent" as const,
      persona: "software-engineer",
      plannerModel: "unknown",
      editorModel: "unknown",
      fastModel: "unknown",
      embeddingModel: "unknown",
      approvalMode: "balanced" as const,
      permissionMode: "default" as const,
      storagePath: "",
      ollamaHealth: `Error: ${error instanceof Error ? error.message : String(error)}`,
      modelCount: 0,
      activeSessionId: null,
      hasPendingEdits: false,
      pendingEditCount: 0,
      tokenBudget: 32000,
      tokensConsumed: 0,
      tokenUsagePercent: 0,
      learningProgressPercent: 0,
      mcpConfigured: 0,
      mcpHealthy: 0,
      selfLearnEnabled: false,
    });

    const pushState = async (): Promise<void> => {
      if (pushInFlight) {
        pushQueued = true;
        return;
      }
      pushInFlight = true;

      try {
        // Refresh provider health BEFORE reading summary so the status
        // reflects the current Ollama state rather than stale cached health.
        await this.runtime.refreshProviderState().catch((err) => {
          this.logger.warn(
            `refreshProviderState failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });

        // Primary dashboard state
        const [summary, sessions] = await Promise.all([
          this.runtime.summary().catch((err) => {
            this.logger.warn(
              `runtime.summary() failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return fallbackSummary(err);
          }),
          this.runtime.listRecentSessions().catch(() => []),
        ]);

        void post({ type: "runtimeSummary", payload: summary });
        void post({ type: "sessions", payload: sessions });
        void post({
          type: "mcpServers",
          payload: this.runtime.getConfiguredMcpServers(),
        });

        if (summary?.ollamaReachable) {
          const models = await this.runtime
            .listAvailableModels()
            .catch(() => []);
          void post({ type: "models", payload: models });
        }
      } finally {
        pushInFlight = false;
        if (pushQueued) {
          pushQueued = false;
          void pushState();
        }
      }
    };

    const resolveWorkspaceFilePath = (filePath: string): string => {
      if (
        path.isAbsolute(filePath) ||
        !vscode.workspace.workspaceFolders?.[0]
      ) {
        return filePath;
      }

      return path.join(
        vscode.workspace.workspaceFolders[0].uri.fsPath,
        filePath,
      );
    };

    // Forward agent progress steps to the webview as they arrive
    this.runtime.setProgressCallback((step) => {
      void post({ type: "thinkingStep", payload: step });
    });

    // Forward streaming text chunks for typewriter effect
    this.runtime.setStreamCallback((chunk) => {
      void post({ type: "streamChunk", payload: chunk });
    });

    // Forward terminal output for in-chat terminal blocks
    this.runtime.setTerminalOutputCallback((data) => {
      void post({ type: "terminalOutput", payload: data });
    });

    // Forward clarification requests to the webview so the user can respond
    if (typeof this.runtime.setClarificationCallback === "function") {
      this.runtime.setClarificationCallback((payload) => {
        void post({ type: "clarificationRequest", payload });
      });
    }

    // Re-push state every time the sidebar panel becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void pushState();
      }
    });

    // Diagnostic: log handler registration
    // eslint-disable-next-line no-console
    console.error("DEBUG: registering onDidReceiveMessage");
    // eslint-disable-next-line no-console
    console.error(
      "DEBUG: onDidReceiveMessage typeof",
      typeof webviewView.webview.onDidReceiveMessage,
    );
    if (typeof webviewView.webview.onDidReceiveMessage !== "function") {
      // eslint-disable-next-line no-console
      console.error("DEBUG: onDidReceiveMessage MISSING");
    }
    webviewView.webview.onDidReceiveMessage(
      async (message: { type?: string; payload?: unknown }) => {
        try {
          // Both loadDashboard and ping use the same consolidated pushState
          if (message.type === "loadDashboard" || message.type === "ping") {
            await pushState();
            return;
          }

          if (message.type === "webviewReady") {
            // Webview signals it's ready — push state immediately
            await pushState();
            return;
          }

          if (message.type === "refreshModels") {
            await this.runtime.refreshProviderState(true);
            const models = await this.runtime.listAvailableModels();
            await post({ type: "models", payload: models });
            return;
          }

          if (message.type === "runTask") {
            const request =
              typeof message.payload === "string"
                ? { objective: message.payload, action: "new" as const }
                : message.payload !== null &&
                    typeof message.payload === "object"
                  ? (() => {
                      const payload = message.payload as {
                        objective?: unknown;
                        action?: unknown;
                        messageId?: unknown;
                      };
                      const objective =
                        typeof payload.objective === "string"
                          ? payload.objective
                          : "";
                      if (!objective) return null;
                      const action =
                        payload.action === "edit" ||
                        payload.action === "retry" ||
                        payload.action === "new"
                          ? (payload.action as "edit" | "retry" | "new")
                          : ("new" as const);
                      const messageId =
                        typeof payload.messageId === "string" &&
                        payload.messageId.length > 0
                          ? payload.messageId
                          : undefined;
                      return {
                        objective,
                        action,
                        messageId,
                      } as import("../agent/runtime/RuntimeTypes").RunTaskRequest;
                    })()
                  : null;

            if (!request) {
              await post({
                type: "taskResult",
                payload: {
                  responseText: "Error: Invalid task payload.",
                  sessionId: "",
                  proposedEdits: 0,
                  cancelled: false,
                },
              });
              return;
            }

            if (this.pendingImages.length > 0) {
              request.images = [...this.pendingImages];
              this.pendingImages = [];
            }

            try {
              const result = await this.runtime.runTask(request);
              // Only show the actual response text in the chat bubble.
              // TODOs, tool summaries, quality scores are tracked in the
              // thinking panel — don't dump them into the message.
              const taskText = result.responseText;
              await post({
                type: "taskResult",
                payload: {
                  responseText: taskText,
                  sessionId: result.sessionId,
                  proposedEdits: result.proposal?.edits.length ?? 0,
                  cancelled: result.responseText === "Task cancelled.",
                  autoApplied: result.autoApplied === true,
                  todos: result.todos,
                  toolSummary: result.toolSummary,
                  fileDiffs: result.fileDiffs ?? [],
                },
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const cancelled =
                msg.includes("__TASK_CANCELLED__") ||
                msg.includes("cancelled") ||
                msg.includes("Aborted");
              await post({
                type: "taskResult",
                payload: {
                  responseText: cancelled ? "Task cancelled." : `Error: ${msg}`,
                  sessionId: "",
                  proposedEdits: 0,
                  cancelled,
                },
              });
            }

            const sessions = await this.runtime
              .listRecentSessions()
              .catch(() => []);
            await post({ type: "sessions", payload: sessions });
            return;
          }

          if (message.type === "clarificationResponse") {
            // UI -> runtime: user answered a clarification prompt
            try {
              this.runtime.receiveClarificationResponse(message.payload);
            } catch (err) {
              this.logger.warn(
                `Failed to deliver clarification response: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            return;
          }

          if (message.type === "rerunTerminal") {
            // User requested to rerun a terminal command via the UI
            try {
              const payload = message.payload as
                | { command?: unknown }
                | unknown;
              if (payload && typeof payload === "object") {
                const cmd =
                  typeof (payload as any).command === "string"
                    ? (payload as any).command
                    : "";
                if (cmd) {
                  const result = await this.runtime.executeTerminalCommand(
                    cmd,
                    {
                      purpose: "manual",
                      visible: false,
                    },
                  );
                  const out = result
                    ? {
                        command: result.command,
                        output: result.output,
                        exitCode: result.exitCode,
                      }
                    : {
                        command: cmd,
                        output: "Terminal execution blocked or failed.",
                        exitCode: null,
                      };
                  await post({ type: "terminalOutput", payload: out });
                }
              }
            } catch (err) {
              this.logger.warn(`Failed to rerun terminal: ${String(err)}`);
            }
            return;
          }

          if (message.type === "cancelTask") {
            this.runtime.cancelTask();
            await post({
              type: "taskResult",
              payload: {
                responseText: "Task cancelled.",
                sessionId: "",
                proposedEdits: 0,
                cancelled: true,
              },
            });
            return;
          }

          if (
            message.type === "openFile" &&
            typeof message.payload === "string" &&
            message.payload.length > 0
          ) {
            try {
              const filePath = resolveWorkspaceFilePath(message.payload);
              const uri = vscode.Uri.file(filePath);
              await vscode.window.showTextDocument(uri, { preview: true });
            } catch {
              /* ignore if file not found */
            }
            return;
          }

          if (
            message.type === "showFileHistory" &&
            typeof message.payload === "string" &&
            message.payload.length > 0
          ) {
            await vscode.commands.executeCommand(
              "pulse.showGitFileHistory",
              resolveWorkspaceFilePath(message.payload),
            );
            return;
          }

          if (
            message.type === "showFileBlame" &&
            typeof message.payload === "string" &&
            message.payload.length > 0
          ) {
            await vscode.commands.executeCommand(
              "pulse.showGitBlame",
              resolveWorkspaceFilePath(message.payload),
            );
            return;
          }

          if (
            message.type === "setSelfLearn" &&
            typeof message.payload === "boolean"
          ) {
            await this.runtime.setSelfLearn(message.payload);
            const updatedSum = await this.runtime.summary();
            await post({ type: "runtimeSummary", payload: updatedSum });
            return;
          }

          if (
            message.type === "setSummaryVerbosity" &&
            (message.payload === "compact" ||
              message.payload === "normal" ||
              message.payload === "verbose")
          ) {
            await this.runtime.setUiSummaryVerbosity(
              message.payload as "compact" | "normal" | "verbose",
            );
            const updated = await this.runtime.summary();
            await post({ type: "runtimeSummary", payload: updated });
            return;
          }

          if (
            message.type === "setShowSummaryToggle" &&
            typeof message.payload === "boolean"
          ) {
            await this.runtime.setUiShowSummaryToggle(Boolean(message.payload));
            const updated = await this.runtime.summary();
            await post({ type: "runtimeSummary", payload: updated });
            return;
          }

          if (message.type === "applyPending") {
            // Single consent path: the runtime's PermissionPolicy decides.
            // If the user already clicked "Apply" in the webview
            // (payload === true), treat it as approved.
            const userApproved = message.payload === true;
            if (!userApproved && this.runtime.needsApprovalForEdits()) {
              await post({ type: "actionResult", payload: "Apply canceled." });
              return;
            }

            const applied = await this.runtime.applyPendingEdits(userApproved);
            await post({ type: "actionResult", payload: applied });
            return;
          }

          if (message.type === "revertLast") {
            if (message.payload !== true) {
              await post({ type: "actionResult", payload: "Revert canceled." });
              return;
            }

            const reverted = await this.runtime.revertLastAppliedEdits();
            await post({ type: "actionResult", payload: reverted });
            return;
          }

          if (
            message.type === "acceptFile" &&
            typeof message.payload === "string"
          ) {
            const result = await this.runtime.acceptFileEdit(message.payload);
            await post({ type: "actionResult", payload: result });
            return;
          }

          if (
            message.type === "rejectFile" &&
            typeof message.payload === "string"
          ) {
            const result = await this.runtime.rejectFileEdit(message.payload);
            await post({ type: "actionResult", payload: result });
            return;
          }

          if (
            message.type === "setApprovalMode" &&
            (message.payload === "strict" ||
              message.payload === "balanced" ||
              message.payload === "fast")
          ) {
            await this.runtime.setApprovalMode(message.payload);
            await post({
              type: "actionResult",
              payload: `Approval mode set to ${message.payload}`,
            });
            return;
          }

          if (
            message.type === "setPermissionMode" &&
            (message.payload === "full" ||
              message.payload === "default" ||
              message.payload === "strict")
          ) {
            await this.runtime.setPermissionMode(message.payload);
            const summary = await this.runtime.summary();
            await post({ type: "runtimeSummary", payload: summary });
            return;
          }

          if (
            message.type === "setModel" &&
            typeof message.payload === "object" &&
            message.payload !== null
          ) {
            const payload = message.payload as {
              role?: unknown;
              model?: unknown;
            };

            if (
              (payload.role === "planner" ||
                payload.role === "editor" ||
                payload.role === "fast" ||
                payload.role === "embedding") &&
              typeof payload.model === "string" &&
              payload.model.length > 0
            ) {
              await this.runtime.selectModel(payload.role, payload.model);
              const summary = await this.runtime.summary();
              await post({ type: "runtimeSummary", payload: summary });
            }
            return;
          }

          if (
            message.type === "saveMcpServers" &&
            Array.isArray(message.payload)
          ) {
            await this.runtime.setConfiguredMcpServers(
              message.payload as Array<Record<string, unknown>>,
            );
            const summary = await this.runtime.summary();
            await post({ type: "runtimeSummary", payload: summary });
            return;
          }

          if (message.type === "reloadMcpServers") {
            const mcpServers = this.runtime.getConfiguredMcpServers();
            await post({ type: "mcpServers", payload: mcpServers });
            return;
          }

          if (
            message.type === "setConversationMode" &&
            (message.payload === "agent" ||
              message.payload === "ask" ||
              message.payload === "plan")
          ) {
            await this.runtime.setConversationMode(message.payload);
            await post({
              type: "runtimeSummary",
              payload: await this.runtime.summary(),
            });
            return;
          }

          if (
            message.type === "setPersona" &&
            typeof message.payload === "string"
          ) {
            await this.runtime.setPersona(message.payload as AgentPersona);
            await post({
              type: "runtimeSummary",
              payload: await this.runtime.summary(),
            });
            return;
          }

          if (
            message.type === "openSession" &&
            typeof message.payload === "string"
          ) {
            const session = await this.runtime.openSession(message.payload);
            if (!session) {
              await post({
                type: "actionResult",
                payload: "Session not found.",
              });
              return;
            }

            await post({ type: "sessionLoaded", payload: session });
            return;
          }

          if (
            message.type === "deleteSessionRequest" &&
            typeof message.payload === "string"
          ) {
            const decision = await vscode.window.showWarningMessage(
              "Delete this conversation? This cannot be undone.",
              { modal: true },
              "Delete",
              "Cancel",
            );

            if (decision !== "Delete") {
              await post({ type: "actionResult", payload: "Delete canceled." });
              return;
            }

            const result = await this.runtime.deleteSession(message.payload);
            if (!result.deleted) {
              await post({
                type: "actionResult",
                payload: "Session not found.",
              });
              return;
            }

            await post({
              type: "sessions",
              payload: await this.runtime.listRecentSessions(),
            });
            await post({
              type: "runtimeSummary",
              payload: await this.runtime.summary(),
            });
            await post({
              type: "sessionDeleted",
              payload: { wasActive: result.wasActive },
            });
            return;
          }

          if (message.type === "attachContext") {
            try {
              this.logger.info?.("attachContext invoked");
            } catch {}
            // Diagnostic log for tests
            // eslint-disable-next-line no-console
            console.error("DEBUG: attachContext invoked");
            const activeEditorUri =
              vscode.window.activeTextEditor?.document.uri ?? null;
            const workspaceFolder =
              vscode.workspace.workspaceFolders?.[0]?.uri ?? null;

            const choices: Array<vscode.QuickPickItem & { value: string }> = [];

            if (activeEditorUri) {
              choices.push({
                label: "$(file-code) Current file",
                description: path.basename(activeEditorUri.fsPath),
                value: "current-file",
              });
            }
            if (workspaceFolder) {
              choices.push({
                label: "$(files) Browse workspace files",
                description: "Pick actual files from this project",
                value: "workspace-files",
              });
              choices.push({
                label: "$(folder) Attach entire workspace",
                description: path.basename(workspaceFolder.fsPath),
                value: "workspace-root",
              });
            }
            choices.push({
              label: "$(file-media) Attach image\u2026",
              description: "Open native picker for images",
              value: "browse-image",
            });
            choices.push({
              label: "$(folder-opened) Browse filesystem\u2026",
              description: "Open native file picker",
              value: "browse",
            });

            const pickedMode = await vscode.window.showQuickPick(choices, {
              title: "Attach context",
              placeHolder: "Choose files or folders to attach as reference",
            });

            if (!pickedMode) {
              await post({
                type: "actionResult",
                payload: "Attachment canceled.",
              });
              return;
            }

            let attachedPaths: string[] = [];

            if (pickedMode.value === "current-file" && activeEditorUri) {
              attachedPaths = [activeEditorUri.fsPath];
            } else if (
              pickedMode.value === "workspace-files" &&
              workspaceFolder
            ) {
              const files = await vscode.workspace.findFiles(
                "**/*",
                "**/{node_modules,dist,build,.git,out,coverage,.pulse}/**",
                400,
              );
              const fileItems: Array<
                vscode.QuickPickItem & { fsPath: string }
              > = files
                .map((f) => ({
                  label: path.basename(f.fsPath),
                  description: path.relative(workspaceFolder.fsPath, f.fsPath),
                  fsPath: f.fsPath,
                }))
                .sort((a, b) =>
                  (a.description ?? "").localeCompare(b.description ?? ""),
                );

              if (!fileItems.length) {
                await post({
                  type: "actionResult",
                  payload: "No workspace files found to attach.",
                });
                return;
              }

              const pickedFiles = await vscode.window.showQuickPick(fileItems, {
                canPickMany: true,
                placeHolder:
                  "Type to filter — select one or more files (Space to toggle)",
                title: "Attach workspace files",
              });

              if (!pickedFiles || pickedFiles.length === 0) {
                await post({
                  type: "actionResult",
                  payload: "Attachment canceled.",
                });
                return;
              }
              attachedPaths = pickedFiles.map((item) => item.fsPath);
            } else if (pickedMode.value === "search" && workspaceFolder) {
              const files = await vscode.workspace.findFiles(
                "**/*.{ts,js,tsx,jsx,mts,mjs,py,go,rs,java,cs,cpp,c,h,md,json,yaml,yml,toml,sh,sql,env,txt,css,html,svelte,vue,png,jpg,jpeg,gif,bmp,webp,svg}",
                "**/{node_modules,dist,build,.git,out,coverage,.pulse}/**",
                300,
              );
              const fileItems: Array<
                vscode.QuickPickItem & { fsPath: string }
              > = files
                .map((f) => ({
                  label: path.basename(f.fsPath),
                  description: path.relative(workspaceFolder.fsPath, f.fsPath),
                  fsPath: f.fsPath,
                }))
                .sort((a, b) =>
                  (a.description ?? "").localeCompare(b.description ?? ""),
                );

              if (!fileItems.length) {
                await post({
                  type: "actionResult",
                  payload: "No workspace files found to attach.",
                });
                return;
              }

              const pickedFiles = await vscode.window.showQuickPick(fileItems, {
                canPickMany: true,
                placeHolder:
                  "Type to filter \u2014 select one or more files (Space to toggle)",
                title: "Attach workspace files",
              });

              if (!pickedFiles || pickedFiles.length === 0) {
                await post({
                  type: "actionResult",
                  payload: "Attachment canceled.",
                });
                return;
              }
              attachedPaths = pickedFiles.map((item) => item.fsPath);
            } else if (
              pickedMode.value === "workspace-root" &&
              workspaceFolder
            ) {
              attachedPaths = [workspaceFolder.fsPath];
            } else if (pickedMode.value === "browse-image") {
              const picked = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: true,
                defaultUri: activeEditorUri ?? workspaceFolder ?? undefined,
                openLabel: "Attach Image",
                title: "Attach images for Pulse to analyze",
                filters: {
                  Images: [
                    "png",
                    "jpg",
                    "jpeg",
                    "gif",
                    "bmp",
                    "webp",
                    "svg",
                    "avif",
                    "ico",
                  ],
                },
              });

              if (!picked || picked.length === 0) {
                await post({
                  type: "actionResult",
                  payload: "Attachment canceled.",
                });
                return;
              }
              attachedPaths = picked.map((item) => item.fsPath);
            } else {
              const picked = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: true,
                canSelectMany: true,
                defaultUri: activeEditorUri ?? workspaceFolder ?? undefined,
                openLabel: "Attach",
                title: "Attach files or folders for Pulse to read",
              });

              if (!picked || picked.length === 0) {
                await post({
                  type: "actionResult",
                  payload: "Attachment canceled.",
                });
                return;
              }
              attachedPaths = picked.map((item) => item.fsPath);
            }

            // If any chosen attachments are image files, read them as data URLs
            // so the webview can preview them and so they are included in
            // the next runTask call as vision inputs.
            if (attachedPaths.length > 0) {
              // Diagnostic log for tests
              // eslint-disable-next-line no-console
              console.error("DEBUG: attachedPaths:", attachedPaths);
              const imageExts = new Set([
                "png",
                "jpg",
                "jpeg",
                "gif",
                "bmp",
                "webp",
                "svg",
                "avif",
                "ico",
              ]);

              for (const fp of attachedPaths) {
                try {
                  const ext = path.extname(fp).replace(/^\./, "").toLowerCase();
                  if (!imageExts.has(ext)) continue;
                  // Skip huge images
                  const stat = await vscode.workspace.fs.stat(
                    vscode.Uri.file(fp),
                  );
                  if (stat.size > 10 * 1024 * 1024) continue;
                  const bytes = await vscode.workspace.fs.readFile(
                    vscode.Uri.file(fp),
                  );
                  const b64 = Buffer.from(bytes).toString("base64");
                  const mime =
                    ext === "svg"
                      ? "image/svg+xml"
                      : ext === "ico"
                        ? "image/x-icon"
                        : ext === "jpg"
                          ? "image/jpeg"
                          : `image/${ext}`;
                  const dataUrl = `data:${mime};base64,${b64}`;

                  if (!this.pendingImages) this.pendingImages = [];
                  const name = path.basename(fp);
                  // Avoid duplicates
                  if (!this.pendingImages.some((i) => i.name === name)) {
                    this.pendingImages.push({ name, dataUrl });
                    try {
                      this.logger.info?.(`posting dropImage for ${name}`);
                    } catch {}
                    // Diagnostic log for tests
                    // eslint-disable-next-line no-console
                    console.error("DEBUG: posting dropImage for", name);
                    await post({
                      type: "dropImage",
                      payload: { name, dataUrl },
                    });
                    // Sentinel to indicate the dropImage preview post has been emitted.
                    await post({
                      type: "dropImageSentinel",
                      payload: { name },
                    });
                  }
                } catch {
                  /* ignore unreadable images */
                }
              }
            }

            if (attachedPaths.length === 0) {
              await post({
                type: "actionResult",
                payload: "No files selected.",
              });
              return;
            }

            const session =
              await this.runtime.attachFilesToActiveSession(attachedPaths);
            if (!session) {
              await post({
                type: "actionResult",
                payload:
                  "Unable to attach — start a conversation first or send a message.",
              });
              return;
            }

            await post({
              type: "runtimeSummary",
              payload: await this.runtime.summary(),
            });
            await post({
              type: "sessionAttachments",
              payload: session.attachedFiles ?? [],
            });
            await post({
              type: "actionResult",
              payload: `Attached ${session.attachedFiles?.length ?? 0} file(s).`,
            });
            return;
          }

          if (message.type === "newConversation") {
            await this.runtime.startNewConversation();
            await post({
              type: "runtimeSummary",
              payload: await this.runtime.summary(),
            });
            return;
          }

          if (message.type === "webviewError") {
            this.logger.error(
              `Sidebar webview error: ${String(message.payload ?? "unknown error")}`,
            );
            return;
          }

          if (message.type === "manageMcpConnections") {
            await vscode.commands.executeCommand("pulse.manageMcpConnections");
            return;
          }

          if (message.type === "configureMcpServers") {
            await vscode.commands.executeCommand("pulse.configureMcpServers");
            return;
          }

          if (message.type === "dropFiles") {
            const paths = Array.isArray(message.payload) ? message.payload : [];
            if (paths.length === 0) return;

            const workspaceFolder =
              vscode.workspace.workspaceFolders?.[0]?.uri ?? null;
            const resolvedPaths: string[] = [];
            for (const p of paths) {
              if (typeof p !== "string" || !p.trim()) continue;
              const sanitized = p.trim();
              const resolved = this.resolveDroppedAttachmentPath(
                sanitized,
                workspaceFolder,
              );
              if (resolved) resolvedPaths.push(resolved);
            }

            if (resolvedPaths.length > 0) {
              await this.runtime.attachFiles(resolvedPaths);
              await post({
                type: "sessionAttachments",
                payload: resolvedPaths,
              });
              await post({
                type: "actionResult",
                payload: `Attached ${resolvedPaths.length} file(s) via drop.`,
              });
            }
            return;
          }

          if (message.type === "dropImage") {
            const img = message.payload as {
              name?: string;
              dataUrl?: string;
            } | null;
            if (
              img &&
              typeof img.name === "string" &&
              typeof img.dataUrl === "string"
            ) {
              if (!this.pendingImages) {
                this.pendingImages = [];
              }
              this.pendingImages.push({ name: img.name, dataUrl: img.dataUrl });
            }
            return;
          }

          if (message.type === "removeImage") {
            const imgName =
              typeof message.payload === "string" ? message.payload : "";
            if (this.pendingImages && imgName) {
              this.pendingImages = this.pendingImages.filter(
                (img: { name: string }) => img.name !== imgName,
              );
            }
            return;
          }

          if (
            message.type === "setEnabledTools" &&
            message.payload &&
            typeof message.payload === "object"
          ) {
            this.runtime.setEnabledTools(
              message.payload as Record<string, boolean>,
            );
            return;
          }
        } catch (error) {
          this.logger.error("Sidebar message handling failed", error);
          await post({
            type: "actionResult",
            payload: `Error: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
    );
    // eslint-disable-next-line no-console
    console.error("DEBUG: registered onDidReceiveMessage");

    // ── Proactive initial push ──────────────────────────────────────
    // Don't rely on the webview's loadDashboard message (race condition).
    // Kick off an initial push from the extension host side.
    void pushState();
    setTimeout(() => void pushState(), 250);
  }

  private resolveDroppedAttachmentPath(
    value: string,
    workspaceFolder: vscode.Uri | null,
  ): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^file:\/\//i.test(trimmed)) {
      try {
        return vscode.Uri.parse(trimmed).fsPath;
      } catch {
        return null;
      }
    }

    if (path.isAbsolute(trimmed)) {
      return path.normalize(trimmed);
    }

    if (workspaceFolder) {
      return path.normalize(
        vscode.Uri.joinPath(workspaceFolder, trimmed).fsPath,
      );
    }

    return null;
  }

  private buildHtml(
    webview: vscode.Webview,
    initialSummary: RuntimeSummary | null,
  ): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = webview.cspSource;
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.css"),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.js"),
    );
    const initialOnline = Boolean(
      initialSummary &&
      (initialSummary.ollamaReachable || initialSummary.status === "ready"),
    );
    const initialSummaryJson = JSON.stringify(initialSummary ?? null)
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;");
    const initialStatusText = initialOnline ? "Online" : "Offline";
    const initialStatusClass = initialOnline ? "on" : "off";
    const initialModel = initialSummary?.plannerModel ?? "";
    const initialModelLabel =
      initialModel.split(":")[0].slice(0, 14) || "\u2013";
    const initialModelTitle = initialModel || "Active model";
    const htmlEscape = (value: string): string =>
      String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${csp}; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}' ${csp};"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link rel="stylesheet" href="${cssUri}"/>
</head>
<body>
<div id="root" data-initial-summary="${initialSummaryJson}">
  <div class="drop-overlay" id="dropOverlay"><span class="drop-overlay-icon">&#128206;</span><span class="drop-overlay-label">Drop files to attach</span><span class="drop-overlay-hint">Images &amp; source files supported</span></div>

  <header class="hdr">
    <div class="hdr-left">
      <span id="statusBadge" class="badge ${initialStatusClass}">
        <span class="badge-dot"></span><span id="statusTxt">${initialStatusText}</span>
      </span>
      <span id="learningBadge" class="badge progress">Learning 0%</span>
    </div>
    <div class="hdr-right">
      <button id="btnNewChat" class="icon-btn" title="New conversation">&#43;</button>
      <button id="btnSettings" class="icon-btn" title="Settings">&#9881;</button>
      <button id="btnRefresh" class="icon-btn" title="Refresh">&#8635;</button>
    </div>
  </header>

  <div id="fatalBanner" role="alert"></div>

  <div id="settingsDrawer">
    <div class="srow"><span class="slabel">Persona</span><select id="personaSelect"><option value="software-engineer">Software Engineer</option><option value="full-stack-developer">Full-Stack Developer</option><option value="data-scientist">Data Scientist</option><option value="designer">Designer</option><option value="devops-engineer">DevOps Engineer</option><option value="researcher">Researcher</option></select></div>
    <div class="srow"><span class="slabel">Model</span><select id="modelSelect"></select></div>
    <div class="srow" id="summaryRow"><span class="slabel">Summary</span>
      <select id="summaryVerbositySelect">
        <option value="compact">Compact</option>
        <option value="normal">Normal</option>
        <option value="verbose">Verbose</option>
      </select>
    </div>
    <div class="srow" id="compactSummaryRow">
      <div class="self-learn-info">
        <div class="self-learn-label">Compact Summaries</div>
        <div class="self-learn-desc">Shorter, more compact responses</div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" id="compactSummaryToggle" />
        <span class="toggle-track"></span>
      </label>
    </div>
    <div class="sbtns"><button id="btnSyncModels" class="btn">Sync models</button><button id="btnApplyModel" class="btn primary">Apply</button></div>
    <div class="section">
      <div class="section-head"><span class="slabel">MCP Servers</span><span id="mcpCount" class="mcp-count">0 configured</span></div>
      <div class="section-copy">Edit servers inline, save to workspace settings.</div>
      <div class="mcp-toolbar">
        <button id="btnAddMcp" class="btn">Add server</button>
        <button id="btnReloadMcp" class="btn">Reload</button>
        <button id="btnSaveMcp" class="btn primary">Save</button>
        <button id="btnOpenMcpSettings" class="btn">Open settings</button>
        <button id="btnManageMcp" class="btn">Status</button>
      </div>
      <div id="mcpList" class="mcp-list"></div>
      <div class="mcp-note">Stdio servers use a command + optional args. HTTP/SSE servers use a URL.</div>
    </div>
    <div class="srow self-learn-row">
      <div class="self-learn-info">
        <div class="self-learn-label">&#9889; Self-Learn</div>
        <div class="self-learn-desc">Improve from past sessions in the background</div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" id="selfLearnToggle" />
        <span class="toggle-track"></span>
      </label>
    </div>
    <div class="tool-config-section">
      <div class="tool-config-header">
        <span class="slabel">Agent Tools</span>
        <div class="tool-config-actions">
          <button id="btnToolsAll" type="button">Select All</button>
          <button id="btnToolsNone" type="button">Deselect All</button>
        </div>
      </div>
      <div class="section-copy">Choose which tools the agent can use during tasks.</div>
      <div id="toolConfigList" class="tool-config-list"></div>
    </div>
  </div>

  <div id="main">
    <div id="homeView">
      <div class="sec-title">Recent Conversations</div>
      <div id="sessionList" class="sessions">
        <div class="empty"><div class="empty-icon">&#128172;</div><div class="empty-h">No conversations yet</div><div class="empty-p">Type a message below to begin</div></div>
      </div>
    </div>
    <div id="chatView" class="hidden">
      <button id="btnBack" class="back-btn">&#8592; Back</button>
      <div id="attachmentRow" class="attachment-row"></div>
      <div id="messages"></div>
      <div id="thinkingPanel" class="thinking-panel hidden">
        <div class="thinking-header" id="thinkingToggle">
          <span id="thinkingTitle">Thinking\u2026</span>
          <span id="thinkingElapsed" class="thinking-elapsed"></span>
          <button class="steps-toggle-btn" id="stepsToggleBtn" title="Show/hide steps">&#9660;</button>
        </div>
        <div id="stepsList" class="steps-list"></div>
      </div>
    </div>
  </div>

  <button id="scrollBtn" title="Scroll to bottom">&#8595;</button>

  <div id="editsBanner">
    <span id="bannerTxt" class="banner-txt">Pending edits ready</span>
    <div class="banner-acts">
      <button id="btnApply" class="btn primary sm">Approve</button>
      <button id="btnRevert" class="btn danger sm">Reject</button>
    </div>
  </div>

  <div id="todoDrawer">
    <div class="todo-drawer-header" id="todoDrawerToggle">
      <span class="todo-drawer-header-left"><span class="todo-drawer-icon">&#9745;</span> Tasks</span>
      <span style="display:flex;align-items:center;gap:6px"><span id="todoDrawerCount" class="todo-drawer-count"></span><span class="todo-drawer-chevron" id="todoDrawerChevron">&#9660;</span></span>
    </div>
    <div class="todo-drawer-list" id="todoDrawerList"></div>
  </div>

  <div id="filesDrawer">
    <div class="files-drawer-header" id="filesDrawerToggle">
      <span class="files-drawer-header-left"><span class="files-drawer-icon">&#128196;</span> Files changed</span>
      <span style="display:flex;align-items:center;gap:6px"><span id="filesDrawerCount" class="files-drawer-count"></span><span class="files-drawer-chevron" id="filesDrawerChevron">&#9660;</span></span>
    </div>
    <div class="files-drawer-list" id="filesDrawerList"></div>
  </div>

  <div class="composer">
    <div class="composer-box" id="composerBox">
      <textarea id="taskInput" placeholder="Ask Pulse anything about your code\u2026" rows="2" aria-label="Message"></textarea>
      <div class="composer-inner-row">
        <div class="chips">
          <button id="btnAttach" type="button" class="attach-plus" title="Attach files or images">&#43;</button>
          <button id="chipMode" type="button" class="mode-chip active" title="Switch mode">AGENT</button>
          <div id="modePopup" class="popup hidden">
            <button type="button" class="popup-opt" data-mode="agent">&#9889; Agent</button>
            <button type="button" class="popup-opt" data-mode="ask">&#128172; Ask</button>
            <button type="button" class="popup-opt" data-mode="plan">&#128203; Plan</button>
          </div>
          <button id="chipModel" type="button" class="chip" title="${htmlEscape(initialModelTitle)}">${htmlEscape(initialModelLabel)}</button>
          <div id="modelPopup" class="model-popup hidden">
            <div class="model-popup-title">Switch model</div>
            <div id="modelPopupList" class="model-popup-list"></div>
          </div>
        </div>
        <button id="btnSend" type="button" class="send-btn" title="Send (Enter)" disabled><svg class="send-arrow" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
      </div>
    </div>
    <!-- Permission bar — GitHub Copilot style -->
    <div class="perm-bar">
      <div class="perm-selector">
        <button id="permBtn" type="button" class="perm-btn">
          <span id="permBtnIcon" class="perm-btn-icon">&#9741;</span>
          <span id="permBtnLabel">Default Approvals</span>
          <span class="perm-btn-chevron">&#9662;</span>
        </button>
        <div id="permPopup" class="perm-popup hidden">
          <button type="button" class="perm-opt" data-perm="default">
            <span class="perm-opt-icon">&#9741;</span>
            <span class="perm-opt-text"><span class="perm-opt-title">Default Approvals</span><span class="perm-opt-desc">Auto-approve file edits &amp; terminal. Prompt for deletes &amp; installs.</span></span>
          </button>
          <button type="button" class="perm-opt" data-perm="full">
            <span class="perm-opt-icon">&#9888;</span>
            <span class="perm-opt-text"><span class="perm-opt-title">Bypass Approvals</span><span class="perm-opt-desc">All actions are auto-approved</span></span>
          </button>
          <button type="button" class="perm-opt" data-perm="strict">
            <span class="perm-opt-icon">&#128274;</span>
            <span class="perm-opt-text"><span class="perm-opt-title">Require Approvals</span><span class="perm-opt-desc">Prompt for every action</span></span>
          </button>
        </div>
      </div>
      <div id="tokenRing" class="token-ring" title="Token usage">
        <svg viewBox="0 0 36 36" class="token-ring-svg">
          <circle class="token-ring-bg" cx="18" cy="18" r="15.9" fill="none" stroke-width="2.5"/>
          <circle id="tokenRingArc" class="token-ring-fg" cx="18" cy="18" r="15.9" fill="none" stroke-width="2.5" stroke-dasharray="0 100" stroke-linecap="round" transform="rotate(-90 18 18)"/>
        </svg>
        <span id="tokenRingPct" class="token-ring-pct">0%</span>
      </div>
    </div>
  </div>

</div>

<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
