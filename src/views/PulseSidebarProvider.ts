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
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    void this.runtime
      .summary()
      .then((summary) => {
        webviewView.webview.html = this.buildHtml(webviewView.webview, summary);
      })
      .catch((error) => {
        this.logger.warn(
          `Failed to load initial sidebar summary: ${error instanceof Error ? error.message : String(error)}`,
        );
        webviewView.webview.html = this.buildHtml(webviewView.webview, null);
      });

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
        // Refresh in background so UI state can render immediately.
        void this.runtime.refreshProviderState().catch((err) => {
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

        void webviewView.webview.postMessage({
          type: "runtimeSummary",
          payload: summary,
        });
        void webviewView.webview.postMessage({
          type: "sessions",
          payload: sessions,
        });
        void webviewView.webview.postMessage({
          type: "mcpServers",
          payload: this.runtime.getConfiguredMcpServers(),
        });

        if (summary?.ollamaReachable) {
          const models = await this.runtime
            .listAvailableModels()
            .catch(() => []);
          void webviewView.webview.postMessage({
            type: "models",
            payload: models,
          });
        }
      } finally {
        pushInFlight = false;
        if (pushQueued) {
          pushQueued = false;
          void pushState();
        }
      }
    };

    // Forward agent progress steps to the webview as they arrive
    this.runtime.setProgressCallback((step) => {
      void webviewView.webview.postMessage({
        type: "thinkingStep",
        payload: step,
      });
    });

    // Forward streaming text chunks for typewriter effect
    this.runtime.setStreamCallback((chunk) => {
      void webviewView.webview.postMessage({
        type: "streamChunk",
        payload: chunk,
      });
    });

    // Forward terminal output for in-chat terminal blocks
    this.runtime.setTerminalOutputCallback((data) => {
      void webviewView.webview.postMessage({
        type: "terminalOutput",
        payload: data,
      });
    });

    // Re-push state every time the sidebar panel becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void pushState();
      }
    });

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
            await webviewView.webview.postMessage({
              type: "models",
              payload: models,
            });
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
              await webviewView.webview.postMessage({
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
              await webviewView.webview.postMessage({
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
              await webviewView.webview.postMessage({
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
            await webviewView.webview.postMessage({
              type: "sessions",
              payload: sessions,
            });
            return;
          }

          if (message.type === "cancelTask") {
            this.runtime.cancelTask();
            await webviewView.webview.postMessage({
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
              let filePath = message.payload;
              // Resolve relative paths against workspace root
              if (
                !path.isAbsolute(filePath) &&
                vscode.workspace.workspaceFolders?.[0]
              ) {
                filePath = path.join(
                  vscode.workspace.workspaceFolders[0].uri.fsPath,
                  filePath,
                );
              }
              const uri = vscode.Uri.file(filePath);
              await vscode.window.showTextDocument(uri, { preview: true });
            } catch {
              /* ignore if file not found */
            }
            return;
          }

          if (
            message.type === "setSelfLearn" &&
            typeof message.payload === "boolean"
          ) {
            await this.runtime.setSelfLearn(message.payload);
            const updatedSum = await this.runtime.summary();
            await webviewView.webview.postMessage({
              type: "runtimeSummary",
              payload: updatedSum,
            });
            return;
          }

          if (message.type === "applyPending") {
            // Single consent path: the runtime's PermissionPolicy decides.
            // If the user already clicked "Apply" in the webview
            // (payload === true), treat it as approved.
            const userApproved = message.payload === true;
            if (!userApproved && this.runtime.needsApprovalForEdits()) {
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload: "Apply canceled.",
              });
              return;
            }

            const applied = await this.runtime.applyPendingEdits(userApproved);
            await webviewView.webview.postMessage({
              type: "actionResult",
              payload: applied,
            });
            return;
          }

          if (message.type === "revertLast") {
            if (message.payload !== true) {
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload: "Revert canceled.",
              });
              return;
            }

            const reverted = await this.runtime.revertLastAppliedEdits();
            await webviewView.webview.postMessage({
              type: "actionResult",
              payload: reverted,
            });
            return;
          }

          if (
            message.type === "acceptFile" &&
            typeof message.payload === "string"
          ) {
            const result = await this.runtime.acceptFileEdit(message.payload);
            await webviewView.webview.postMessage({
              type: "actionResult",
              payload: result,
            });
            return;
          }

          if (
            message.type === "rejectFile" &&
            typeof message.payload === "string"
          ) {
            const result = await this.runtime.rejectFileEdit(message.payload);
            await webviewView.webview.postMessage({
              type: "actionResult",
              payload: result,
            });
            return;
          }

          if (
            message.type === "setApprovalMode" &&
            (message.payload === "strict" ||
              message.payload === "balanced" ||
              message.payload === "fast")
          ) {
            await this.runtime.setApprovalMode(message.payload);
            await webviewView.webview.postMessage({
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
            await webviewView.webview.postMessage({
              type: "runtimeSummary",
              payload: summary,
            });
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
              await webviewView.webview.postMessage({
                type: "runtimeSummary",
                payload: summary,
              });
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
            await webviewView.webview.postMessage({
              type: "runtimeSummary",
              payload: summary,
            });
            return;
          }

          if (message.type === "reloadMcpServers") {
            const mcpServers = this.runtime.getConfiguredMcpServers();
            await webviewView.webview.postMessage({
              type: "mcpServers",
              payload: mcpServers,
            });
            return;
          }

          if (
            message.type === "setConversationMode" &&
            (message.payload === "agent" ||
              message.payload === "ask" ||
              message.payload === "plan")
          ) {
            await this.runtime.setConversationMode(message.payload);
            await webviewView.webview.postMessage({
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
            await webviewView.webview.postMessage({
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
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload: "Session not found.",
              });
              return;
            }

            await webviewView.webview.postMessage({
              type: "sessionLoaded",
              payload: session,
            });
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
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload: "Delete canceled.",
              });
              return;
            }

            const result = await this.runtime.deleteSession(message.payload);
            if (!result.deleted) {
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload: "Session not found.",
              });
              return;
            }

            await webviewView.webview.postMessage({
              type: "sessions",
              payload: await this.runtime.listRecentSessions(),
            });
            await webviewView.webview.postMessage({
              type: "runtimeSummary",
              payload: await this.runtime.summary(),
            });
            await webviewView.webview.postMessage({
              type: "sessionDeleted",
              payload: { wasActive: result.wasActive },
            });
            return;
          }

          if (message.type === "attachContext") {
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
              await webviewView.webview.postMessage({
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
                await webviewView.webview.postMessage({
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
                await webviewView.webview.postMessage({
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
                await webviewView.webview.postMessage({
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
                await webviewView.webview.postMessage({
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
                await webviewView.webview.postMessage({
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
                await webviewView.webview.postMessage({
                  type: "actionResult",
                  payload: "Attachment canceled.",
                });
                return;
              }
              attachedPaths = picked.map((item) => item.fsPath);
            }

            if (attachedPaths.length === 0) {
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload: "No files selected.",
              });
              return;
            }

            const session =
              await this.runtime.attachFilesToActiveSession(attachedPaths);
            if (!session) {
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload:
                  "Unable to attach — start a conversation first or send a message.",
              });
              return;
            }

            await webviewView.webview.postMessage({
              type: "runtimeSummary",
              payload: await this.runtime.summary(),
            });
            await webviewView.webview.postMessage({
              type: "sessionAttachments",
              payload: session.attachedFiles ?? [],
            });
            await webviewView.webview.postMessage({
              type: "actionResult",
              payload: `Attached ${session.attachedFiles?.length ?? 0} file(s).`,
            });
            return;
          }

          if (message.type === "newConversation") {
            await this.runtime.startNewConversation();
            await webviewView.webview.postMessage({
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
              await webviewView.webview.postMessage({
                type: "sessionAttachments",
                payload: resolvedPaths,
              });
              await webviewView.webview.postMessage({
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
          await webviewView.webview.postMessage({
            type: "actionResult",
            payload: `Error: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
    );

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
    const initialOnline = Boolean(
      initialSummary &&
      (initialSummary.ollamaReachable || initialSummary.status === "ready"),
    );
    const initialSummaryJson = JSON.stringify(initialSummary ?? null)
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --accent: #475569; --accent-bg: rgba(71,85,105,0.08); --accent-bdr: rgba(71,85,105,0.22);
      --accent-glow: rgba(71,85,105,0.12); --accent-hover: #334155;
      --orange: #c27803; --orange-hover: #a36702; --orange-glow: rgba(194,120,3,0.14);
      --green: #16a34a; --green-bg: rgba(22,163,74,0.08); --green-bdr: rgba(22,163,74,0.22);
      --red: var(--vscode-errorForeground, #f87171); --red-bg: rgba(248,113,113,0.06); --red-bdr: rgba(248,113,113,0.22);
      --border: var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.12));
      --bg2: var(--vscode-input-background, rgba(128,128,128,.06));
      --bg3: rgba(128,128,128,.04);
      --fg: var(--vscode-foreground); --fg2: var(--vscode-descriptionForeground); --fg3: color-mix(in srgb, var(--fg2) 60%, transparent);
      --r: 8px; --spd: 120ms;
    }
    html, body { height: 100%; font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 13px; color: var(--fg); background: var(--vscode-sideBar-background); overflow: hidden; }
    #root { display: flex; flex-direction: column; height: 100%; }
    button { font-family: inherit; }

    /* ── Header ─── */
    .hdr { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .hdr-left { display: flex; align-items: center; gap: 6px; }
    .hdr-right { display: flex; align-items: center; gap: 2px; }
    .badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 600; padding: 1px 7px; border-radius: 999px; border: 1px solid; letter-spacing: .2px; }
    .badge-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
    .badge.on { color: var(--green); border-color: var(--green-bdr); background: var(--green-bg); }
    .badge.off { color: var(--red); border-color: var(--red-bdr); background: var(--red-bg); }
    .badge.progress { color: var(--fg2); border-color: var(--border); background: var(--bg3); font-size: 9px; }
    .icon-btn { width: 24px; height: 24px; border: none; background: transparent; color: var(--fg2); opacity: .55; cursor: pointer; border-radius: 5px; display: flex; align-items: center; justify-content: center; font-size: 14px; transition: opacity var(--spd), background var(--spd); }
    .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.1)); }

    #fatalBanner { display: none; margin: 6px 10px 0; padding: 7px 10px; border-radius: var(--r); border: 1px solid var(--red-bdr); background: var(--red-bg); font-size: 11px; line-height: 1.4; white-space: pre-wrap; }
    #fatalBanner.on { display: block; }

    /* ── Settings drawer ─── */
    #settingsDrawer { display: none; flex-direction: column; gap: 8px; padding: 10px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0; max-height: 55vh; overflow-y: auto; }
    #settingsDrawer.open { display: flex; }
    .srow { display: grid; grid-template-columns: 60px 1fr; align-items: center; gap: 6px; }
    .slabel { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--fg3); }
    input[type="text"], select, textarea { width: 100%; padding: 4px 7px; border-radius: 5px; border: 1px solid var(--border); background: var(--bg2); color: var(--vscode-input-foreground); font: 12px var(--vscode-font-family); }
    select { cursor: pointer; }
    textarea { resize: vertical; min-height: 36px; }
    .sbtns { display: flex; justify-content: flex-end; gap: 5px; margin-top: 2px; }
    .section { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .section-copy { color: var(--fg3); font-size: 10px; line-height: 1.3; }
    .mcp-toolbar { display: flex; flex-wrap: wrap; gap: 4px; }
    .mcp-count { margin-left: auto; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--fg3); }
    .mcp-list { display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow: auto; }
    .mcp-card { display: flex; flex-direction: column; gap: 5px; padding: 7px; border-radius: var(--r); border: 1px solid var(--border); background: var(--bg3); }
    .mcp-card-head { display: flex; align-items: center; gap: 6px; }
    .mcp-card-title { flex: 1; min-width: 0; }
    .mcp-chip { display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); font-size: 9px; font-weight: 700; color: var(--fg3); text-transform: uppercase; letter-spacing: .3px; }
    .mcp-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px; }
    .mcp-note { font-size: 9px; color: var(--fg3); line-height: 1.3; }
    .mcp-empty { padding: 8px; border-radius: var(--r); border: 1px dashed var(--border); color: var(--fg3); font-size: 10px; text-align: center; }

    /* ── Main scroll area ─── */
    #main { flex: 1; overflow-y: auto; overflow-x: hidden; scroll-behavior: smooth; }
    #homeView { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    #homeView.hidden, #chatView.hidden { display: none; }

    .sec-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; color: var(--fg3); padding: 0 2px 4px; }
    .sessions { }
    .sitem { display: flex; align-items: center; justify-content: space-between; padding: 7px 8px; cursor: pointer; border-radius: var(--r); gap: 8px; transition: background var(--spd); margin-bottom: 2px; }
    .sitem:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.08)); }
    .sitem-title { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
    .sitem-time { font-size: 10px; color: var(--fg3); flex-shrink: 0; }
    .session-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .session-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
    .session-count { font-size: 9px; color: var(--fg3); }
    .session-delete { width: 20px; height: 20px; border: none; border-radius: 4px; background: transparent; color: var(--fg2); cursor: pointer; opacity: 0; transition: all var(--spd); font-size: 11px; display: flex; align-items: center; justify-content: center; }
    .sitem:hover .session-delete { opacity: .5; }
    .session-delete:hover { opacity: 1 !important; color: var(--red); background: var(--red-bg); }
    .load-more-btn { display: block; width: 100%; padding: 7px 8px; margin-top: 2px; border: 1px dashed var(--border); border-radius: var(--r); background: transparent; color: var(--fg2); font: 500 11px var(--vscode-font-family); cursor: pointer; text-align: center; transition: all var(--spd); }
    .load-more-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }

    /* ── Chat view ─── */
    #chatView { padding: 6px 10px 4px; display: flex; flex-direction: column; gap: 6px; }
    .back-btn { display: inline-flex; align-items: center; gap: 3px; border: none; background: none; color: var(--fg); font: 600 11px var(--vscode-font-family); cursor: pointer; opacity: .78; padding: 2px 0; width: fit-content; transition: opacity var(--spd), color var(--spd); }
    .back-btn:hover { opacity: 1; color: var(--accent); }

    /* ── Messages ─── */
    #messages { display: flex; flex-direction: column; gap: 6px; }
    .msg { max-width: 95%; position: relative; }
    .msg.user { align-self: flex-end; }
    .msg.agent { align-self: flex-start; width: 100%; }
    .msg.editing { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r); }
    .bubble { padding: 8px 11px; border-radius: var(--r); line-height: 1.6; font-size: 13px; font-weight: 400; word-break: break-word; user-select: text; -webkit-user-select: text; position: relative; }
    .msg.user .bubble { background: linear-gradient(180deg, var(--accent) 0%, var(--accent-hover) 100%); color: #fff; border-bottom-right-radius: 2px; font-weight: 600; text-shadow: 0 1px 1px rgba(0,0,0,.18); }
    .msg.agent .bubble { background: transparent; border: none; padding: 6px 2px; color: var(--fg); }
    .bubble code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; background: rgba(128,128,128,.12); padding: 1px 4px; border-radius: 3px; }
    .msg.user .bubble code { background: rgba(255,255,255,.18); }
    .bubble h1, .bubble h2, .bubble h3 { margin: 8px 0 3px; font-size: 13px; font-weight: 700; }
    .bubble h1:first-child, .bubble h2:first-child, .bubble h3:first-child { margin-top: 1px; }
    .bubble ul, .bubble ol { margin: 2px 0; padding-left: 18px; }
    .bubble li { margin: 1px 0; }
    .bubble p { margin: 2px 0; }
    .bubble p:first-child { margin-top: 0; }
    .bubble p:last-child { margin-bottom: 0; }
    .bubble a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
    .bubble a:hover { text-decoration-thickness: 2px; }
    .msg.user .bubble a { color: #fff; }
    .bubble strong { font-weight: 700; }
    .bubble hr { border: none; border-top: 1px solid var(--border); margin: 8px 0; }
    .msg-footer { display: flex; align-items: center; justify-content: space-between; gap: 4px; margin-top: 1px; padding: 0 2px; opacity: 0; transition: opacity var(--spd); }
    .msg:hover .msg-footer { opacity: 1; }
    .msg.user .msg-footer { justify-content: flex-end; }
    .msg-time { font-size: 9px; color: var(--fg3); }
    .copy-btn, .retry-btn, .edit-btn { border: none; background: transparent; color: var(--fg); cursor: pointer; opacity: .62; transition: opacity var(--spd), color var(--spd), background var(--spd); padding: 2px; border-radius: 3px; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; line-height: 1; flex-shrink: 0; }
    .copy-btn:hover, .retry-btn:hover { opacity: 1 !important; background: rgba(128,128,128,.1); }
    .retry-btn:hover { color: var(--accent); }

    /* ── Thinking panel (Copilot-style step list) ─── */
    .thinking-panel { align-self: flex-start; width: 100%; overflow: hidden; font-size: 12px; margin: 2px 0; }
    .thinking-panel.hidden { display: none; }
    .thinking-header { display: flex; align-items: center; gap: 6px; padding: 5px 2px; cursor: default; }
    #thinkingTitle { flex: 1; font-size: 11px; font-weight: 600; color: var(--fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .thinking-panel:not(.done) #thinkingTitle {
      color: transparent;
      background: linear-gradient(90deg, var(--fg3) 0%, var(--fg) 50%, var(--fg3) 100%);
      background-size: 200% 100%;
      -webkit-background-clip: text;
      background-clip: text;
      animation: title-shimmer 1.5s linear infinite;
    }
    @keyframes title-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

    /* ── Streaming text (typewriter + text shimmer) ─── */
    .streaming-active .stream-bubble { position: relative; }
    .streaming-active .stream-text { display: inline; }
    .streaming-active .stream-cursor { display: inline-block; width: 2px; height: 1.1em; background: var(--fg); margin-left: 2px; vertical-align: text-bottom; animation: blink-cursor .7s step-end infinite; }
    @keyframes blink-cursor { 0%,100% { opacity: 1; } 50% { opacity: 0; } }

    /* Shimmer placeholder before first tokens arrive */
    .stream-placeholder { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
    .stream-placeholder-line { height: 12px; border-radius: 4px; background: linear-gradient(90deg, var(--bg3) 25%, var(--fg3) 50%, var(--bg3) 75%); background-size: 200% 100%; animation: text-shimmer 1.5s linear infinite; opacity: 0.18; }
    .stream-placeholder-line:nth-child(1) { width: 85%; }
    .stream-placeholder-line:nth-child(2) { width: 70%; }
    .stream-placeholder-line:nth-child(3) { width: 55%; }

    /* Text shimmer effect on the latest streamed words */
    .stream-text .shimmer-word { background: linear-gradient(90deg, var(--fg2), var(--fg), var(--fg2)); background-size: 200% 100%; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; animation: text-shimmer 1.8s linear infinite; }
    @keyframes text-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

    /* ── Terminal chat blocks ─── */
    .terminal-chat-block { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin: 4px 0; font-size: 12px; background: var(--bg2); }
    .terminal-chat-block.terminal-error { border-color: var(--red); }
    .terminal-chat-header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: pointer; user-select: none; }
    .terminal-chat-header:hover { background: rgba(128,128,128,.06); }
    .terminal-chat-icon { font-size: 10px; color: var(--accent); flex-shrink: 0; }
    .terminal-chat-cmd { flex: 1; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .terminal-chat-status { font-size: 10px; flex-shrink: 0; }
    .terminal-error .terminal-chat-status { color: var(--red); }
    .terminal-chat-toggle { font-size: 9px; color: var(--fg3); transition: transform var(--spd); flex-shrink: 0; }
    .terminal-chat-block.open .terminal-chat-toggle { transform: rotate(180deg); }
    .terminal-chat-output { margin: 0; padding: 8px 10px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; max-height: 300px; overflow: auto; background: rgba(0,0,0,.15); border-top: 1px solid var(--border); white-space: pre-wrap; word-break: break-all; }
    .terminal-chat-output.hidden { display: none; }
    .msg.terminal { padding: 0; }
    .thinking-elapsed { font-size: 9px; color: var(--fg3); flex-shrink: 0; font-variant-numeric: tabular-nums; }
    .steps-toggle-btn { border: none; background: transparent; color: var(--fg2); cursor: pointer; font-size: 9px; opacity: .45; padding: 1px 3px; border-radius: 3px; transition: opacity var(--spd), transform var(--spd); flex-shrink: 0; line-height: 1; }
    .steps-toggle-btn:hover { opacity: 1; background: rgba(128,128,128,.08); }
    .thinking-panel.steps-collapsed .steps-toggle-btn { transform: rotate(-90deg); }

    /* Steps list */
    .steps-list { display: flex; flex-direction: column; gap: 0; padding: 0 2px 4px 6px; max-height: 200px; overflow-y: auto; }
    .thinking-panel.steps-collapsed .steps-list { display: none; }

    /* Generic step item */
    .step-item { display: flex; align-items: center; gap: 5px; padding: 1px 2px; font-size: 11px; color: var(--fg2); min-height: 18px; }
    .step-icon { flex-shrink: 0; font-size: 10px; opacity: .65; width: 14px; text-align: center; }
    .step-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .step-detail { font-size: 9px; color: var(--fg3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }

    /* Reasoning block */
    .step-item.step-reasoning { flex-direction: column; align-items: flex-start; gap: 2px; padding: 4px 7px; background: var(--bg3); border-radius: 5px; margin: 2px 0; color: var(--fg); }
    .step-reasoning-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; color: var(--fg3); margin-bottom: 1px; }
    .step-reasoning-text { font-size: 11px; color: var(--fg2); line-height: 1.4; white-space: pre-wrap; word-break: break-word; max-height: 100px; overflow-y: auto; }
    .step-reasoning-active .step-reasoning-text {
      background: linear-gradient(90deg, var(--vscode-foreground, #ccc) 0%, rgba(255,255,255,0.85) 40%, var(--vscode-foreground, #ccc) 80%);
      background-size: 250% 100%;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      animation: reasoning-shimmer 2s linear infinite;
    }
    .step-item.step-reasoning:not(.step-reasoning-active) .step-reasoning-text {
      -webkit-text-fill-color: var(--fg2);
      background: none;
      animation: none;
    }
    @keyframes reasoning-shimmer { 0% { background-position: 250% 0; } 100% { background-position: -250% 0; } }

    /* File patch progress */
    .step-item.step-file_patch .step-icon { color: var(--orange); opacity: 1; }
    .step-file-name { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--accent); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
    .step-line-count { font-size: 9px; color: var(--fg3); }

    /* File patched (done) */
    .step-item.step-file_patched .step-icon { color: var(--green); opacity: 1; }
    .step-item.step-file_patched .step-file-name { color: var(--fg); }
    .step-diff-added { color: var(--green); font-weight: 700; font-size: 9px; flex-shrink: 0; }
    .step-diff-removed { color: var(--red); font-weight: 700; font-size: 9px; flex-shrink: 0; }

    /* Terminal command */
    .step-item.step-terminal { background: var(--bg3); border-radius: 4px; padding: 2px 7px; gap: 4px; margin: 1px 0; }
    .step-item.step-terminal .step-icon { color: var(--accent); opacity: 1; }
    .step-cmd { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── Popups ─── */
    .popup { position: absolute; bottom: calc(100% + 4px); left: 0; z-index: 200; background: var(--vscode-editorWidget-background, var(--bg2)); border: 1px solid var(--border); border-radius: var(--r); display: flex; flex-direction: column; gap: 1px; padding: 3px; min-width: 130px; box-shadow: 0 4px 16px rgba(0,0,0,.22); }
    .popup.hidden { display: none; }
    .popup-opt { display: flex; align-items: center; gap: 6px; padding: 5px 9px; border-radius: 5px; border: none; background: transparent; color: var(--fg); cursor: pointer; font: 12px var(--vscode-font-family); text-align: left; transition: background var(--spd); }
    .popup-opt:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.08)); }
    .popup-opt.active { font-weight: 700; }
    .popup-opt.active::after { content: '\\2713'; margin-left: auto; font-size: 10px; opacity: .5; }

    .model-popup { position: absolute; bottom: calc(100% + 4px); left: 0; z-index: 200; background: var(--vscode-editorWidget-background, var(--bg2)); border: 1px solid var(--border); border-radius: var(--r); min-width: 210px; max-height: 240px; overflow-y: auto; box-shadow: 0 4px 16px rgba(0,0,0,.22); scrollbar-width: none; -ms-overflow-style: none; }
    .model-popup::-webkit-scrollbar { display: none; }
    .model-popup.hidden { display: none; }
    .model-popup-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--fg3); padding: 6px 10px 3px; }
    .model-popup-list { display: flex; flex-direction: column; gap: 1px; padding: 2px 3px 3px; }
    .model-item { width: 100%; border: none; background: transparent; color: var(--fg); cursor: pointer; border-radius: 5px; padding: 6px 9px; display: flex; flex-direction: column; align-items: stretch; gap: 4px; transition: background var(--spd), color var(--spd); text-align: left; }
    .model-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.08)); }
    .model-item.active { background: var(--accent-bg); color: var(--accent); }
    .model-item-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .model-item-name { font-size: 12px; font-weight: 600; line-height: 1.2; word-break: break-word; }
    .model-item-badges { display: flex; flex-wrap: wrap; gap: 4px; }
    .model-badge { font-size: 8px; line-height: 1; padding: 3px 6px; border-radius: 999px; border: 1px solid var(--border); text-transform: uppercase; letter-spacing: .4px; opacity: .95; }
    .model-badge.ready { color: var(--green); border-color: var(--green-bdr); background: var(--green-bg); }
    .model-badge.active { color: #fff; border-color: var(--accent); background: var(--accent); }
    .model-badge.vision { color: var(--orange); border-color: var(--orange-glow); background: rgba(194,120,3,.08); }
    .model-badge.local { color: var(--fg2); }
    .model-badge.running { color: var(--green); border-color: var(--green-bdr); background: rgba(22,163,74,.06); }
    .model-badge.configured { color: var(--fg2); }

    /* ── Permission popup ─── */
    .perm-popup { position: absolute; bottom: calc(100% + 4px); left: 0; z-index: 200; background: var(--vscode-editorWidget-background, var(--bg2)); border: 1px solid var(--border); border-radius: var(--r); min-width: 200px; box-shadow: 0 4px 16px rgba(0,0,0,.22); padding: 3px; }
    .perm-popup.hidden { display: none; }
    .perm-opt { display: flex; align-items: flex-start; gap: 7px; padding: 7px 9px; border-radius: 5px; border: none; background: transparent; color: var(--fg); cursor: pointer; font: 12px var(--vscode-font-family); text-align: left; transition: background var(--spd); width: 100%; }
    .perm-opt:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.08)); }
    .perm-opt.active { font-weight: 600; }
    .perm-opt-icon { font-size: 13px; flex-shrink: 0; margin-top: 1px; }
    .perm-opt-text { display: flex; flex-direction: column; gap: 1px; }
    .perm-opt-title { font-size: 11px; font-weight: 600; }
    .perm-opt-desc { font-size: 9px; color: var(--fg3); line-height: 1.3; }
    .perm-opt.active .perm-opt-title::after { content: ' \\2713'; font-size: 9px; opacity: .5; }

    /* ── Token ring ─── */
    .token-ring { display: none; width: 28px; height: 28px; position: relative; flex-shrink: 0; }
    .token-ring.visible { display: block; }
    .token-ring-svg { width: 100%; height: 100%; }
    .token-ring-bg { stroke: rgba(128,128,128,.1); }
    .token-ring-fg { stroke: var(--orange); transition: stroke-dasharray 400ms ease; }
    .token-ring-pct { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 7px; font-weight: 700; color: var(--fg3); pointer-events: none; }

    /* ── Empty state ─── */
    .empty { text-align: center; padding: 32px 16px; color: var(--fg2); }
    .empty-icon { font-size: 28px; margin-bottom: 8px; opacity: .3; }
    .empty-h { font-size: 14px; font-weight: 600; margin-bottom: 4px; color: var(--fg); }
    .empty-p { font-size: 12px; opacity: .55; line-height: 1.4; }

    /* ── Pending edits banner ─── */
    #editsBanner { display: none; margin: 4px 10px 0; padding: 7px 10px; border-radius: var(--r); background: var(--accent-bg); border: 1px solid var(--accent-bdr); align-items: center; justify-content: space-between; gap: 6px; flex-shrink: 0; }
    #editsBanner.on { display: flex; }
    .banner-txt { font-size: 11px; font-weight: 600; color: var(--accent); flex: 1; }
    .banner-acts { display: flex; gap: 4px; }

    /* ── Diff cards ─── */
    .diff-section { margin-top: 10px; }
    .diff-card { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px; overflow: hidden; background: var(--bg); }
    .diff-card-header { display: flex; align-items: center; gap: 6px; padding: 6px 10px; cursor: pointer; user-select: none; background: var(--bg2); border-bottom: 1px solid transparent; transition: background var(--spd); }
    .diff-card-header:hover { background: var(--hover); }
    .diff-card.open .diff-card-header { border-bottom-color: var(--border); }
    .diff-card-arrow { font-size: 10px; color: var(--fg3); transition: transform 0.15s ease; flex-shrink: 0; }
    .diff-card.open .diff-card-arrow { transform: rotate(90deg); }
    .diff-card-file { font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', Consolas, monospace); font-size: 11px; color: var(--fg); font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .diff-card-badge { display: inline-flex; gap: 4px; font-size: 10px; font-weight: 700; flex-shrink: 0; }
    .diff-card-new { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: rgba(88,166,92,.15); color: var(--green); font-weight: 600; }
    .diff-card-del { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: rgba(220,80,68,.12); color: var(--red); font-weight: 600; }
    .diff-stat-add { color: var(--green); }
    .diff-stat-del { color: var(--red); }
    .diff-content { display: none; overflow-x: auto; }
    .diff-card.open .diff-content { display: block; }
    .diff-table { width: 100%; border-collapse: collapse; font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', Consolas, monospace); font-size: 11px; line-height: 1.45; }
    .diff-table td { padding: 0 6px; white-space: pre; vertical-align: top; }
    .diff-ln { width: 1%; min-width: 30px; color: var(--fg3); text-align: right; opacity: .5; user-select: none; border-right: 1px solid var(--border); }
    .diff-code { padding-left: 8px !important; }
    .diff-tr-ctx { background: transparent; }
    .diff-tr-add { background: rgba(88,166,92,.10); }
    .diff-tr-add .diff-code { color: var(--green); }
    .diff-tr-add .diff-code::before { content: '+'; margin-right: 4px; font-weight: 700; }
    .diff-tr-del { background: rgba(220,80,68,.08); }
    .diff-tr-del .diff-code { color: var(--red); }
    .diff-tr-del .diff-code::before { content: '\u2212'; margin-right: 4px; font-weight: 700; }
    .diff-tr-ctx .diff-code::before { content: ' '; margin-right: 4px; }
    .diff-actions { display: flex; gap: 6px; padding: 8px 10px; justify-content: flex-end; border-top: 1px solid var(--border); }
    .diff-file-actions { display: flex; gap: 4px; padding: 4px 10px; justify-content: flex-end; }
    .diff-file-actions .btn.xs { font-size: 10px; padding: 2px 8px; border-radius: 4px; }
    .diff-file-actions .btn.xs.primary { background: var(--green); color: #fff; border: none; cursor: pointer; }
    .diff-file-actions .btn.xs.danger { background: transparent; color: var(--red); border: 1px solid var(--red); cursor: pointer; }
    .diff-file-actions .btn.xs:hover { opacity: .85; }
    .diff-truncated { padding: 6px 10px; font-size: 10px; color: var(--fg3); font-style: italic; text-align: center; }

    /* ── Composer ─── */
    .composer { padding: 4px 10px 6px; border-top: 1px solid var(--border); flex-shrink: 0; }
    .composer-box { position: relative; border-radius: 12px; border: 1px solid var(--vscode-input-border, rgba(128,128,128,.18)); background: var(--bg2); transition: border-color var(--spd), box-shadow var(--spd); }
    .composer-box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }
    .composer-box textarea { display: block; width: 100%; min-height: 42px; max-height: 140px; padding: 9px 11px 2px; background: none; border: none; outline: none; color: var(--vscode-input-foreground); font: 13px/1.5 var(--vscode-font-family); resize: none; overflow-y: auto; }
    .composer-box textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .composer-inner-row { display: flex; align-items: center; justify-content: space-between; padding: 2px 7px 5px; gap: 3px; }
    .chips { display: flex; gap: 3px; align-items: center; flex-wrap: wrap; }

    .mode-chip { border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--fg); cursor: pointer; font: 700 9px var(--vscode-font-family); letter-spacing: .3px; text-transform: uppercase; padding: 2px 7px; transition: all var(--spd); white-space: nowrap; }
    .mode-chip:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }
    .mode-chip.active { border-color: var(--accent); color: #fff; background: var(--accent); }

    .chip { font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 999px; border: 1px solid var(--border); color: var(--fg); cursor: pointer; white-space: nowrap; max-width: 100px; overflow: hidden; text-overflow: ellipsis; transition: all var(--spd); background: transparent; }
    .chip:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }

    .attach-plus { width: 26px; height: 26px; min-width: 26px; border: 1px solid var(--border); border-radius: 50%; background: transparent; color: var(--fg); cursor: pointer; font-size: 15px; font-weight: 400; display: flex; align-items: center; justify-content: center; transition: all var(--spd); flex-shrink: 0; }
    .attach-plus:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }

    .send-btn { width: 30px; height: 30px; min-width: 30px; border: none; border-radius: 50%; background: linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%); color: #fff; font-size: 14px; line-height: 1; cursor: default; display: flex; align-items: center; justify-content: center; transition: opacity .15s ease, transform .15s ease, background .15s ease, box-shadow .15s ease; opacity: .25; box-shadow: none; }
    .send-btn:not([disabled]) { opacity: 1; cursor: pointer; box-shadow: 0 2px 8px rgba(63,185,80,.35); }
    .send-btn:not([disabled]):hover { background: linear-gradient(135deg, var(--accent-hover) 0%, var(--accent) 100%); transform: scale(1.1) translateY(-1px); box-shadow: 0 4px 14px rgba(100,116,139,.45); }
    .send-btn:not([disabled]):active { transform: scale(.95); box-shadow: 0 1px 4px rgba(63,185,80,.3); }
    .send-btn .send-arrow { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    .send-btn.stop { background: linear-gradient(135deg, #ef4444, #dc2626); opacity: 1; cursor: pointer; box-shadow: 0 2px 8px rgba(239,68,68,.35); }
    .send-btn.stop:hover { background: linear-gradient(135deg, #dc2626, #b91c1c); transform: scale(1.1) translateY(-1px); box-shadow: 0 4px 14px rgba(239,68,68,.45); }

    /* ── Drag-and-drop overlay ─── */
    .drop-overlay { display: none; position: fixed; inset: 0; z-index: 1000; border: 2px dashed var(--accent); background: rgba(63,185,80,0.06); backdrop-filter: blur(2px); align-items: center; justify-content: center; flex-direction: column; gap: 8px; pointer-events: none; transition: opacity 0.2s ease; }
    .drop-overlay.active { display: flex; animation: drop-fadein 0.15s ease forwards; }
    @keyframes drop-fadein { from { opacity: 0; } to { opacity: 1; } }
    .drop-overlay-icon { font-size: 32px; opacity: 0.7; }
    .drop-overlay-label { font: 600 13px var(--vscode-font-family); color: var(--accent); letter-spacing: .3px; }
    .drop-overlay-hint { font: 400 11px var(--vscode-font-family); color: var(--fg2); opacity: 0.7; }

    /* ── Tool config panel ─── */
    .tool-config-section { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
    .tool-config-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .tool-config-list { display: flex; flex-direction: column; gap: 2px; }
    .tool-config-item { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 5px; transition: background var(--spd); }
    .tool-config-item:hover { background: rgba(128,128,128,.06); }
    .tool-config-item label { flex: 1; font-size: 11px; color: var(--fg); cursor: pointer; display: flex; align-items: center; gap: 6px; }
    .tool-config-item input[type="checkbox"] { accent-color: var(--accent); cursor: pointer; width: 14px; height: 14px; margin: 0; flex-shrink: 0; }
    .tool-config-desc { font-size: 9px; color: var(--fg3); margin-left: 28px; margin-top: -2px; }
    .tool-config-actions { display: flex; gap: 6px; justify-content: flex-end; }
    .tool-config-actions button { font: 500 9px var(--vscode-font-family); padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border); background: transparent; color: var(--fg2); cursor: pointer; transition: all var(--spd); }
    .tool-config-actions button:hover { border-color: var(--accent); color: var(--accent); }

    /* --- Scroll-to-bottom button --- */
    #scrollBtn { position: fixed; right: 14px; bottom: 120px; z-index: 500; width: 24px; height: 24px; border-radius: 50%; background: var(--vscode-editorWidget-background, var(--bg2)); border: 1px solid var(--border); color: var(--fg2); cursor: pointer; opacity: 0; pointer-events: none; transition: opacity var(--spd), transform var(--spd); box-shadow: 0 2px 8px rgba(0,0,0,.2); display: flex; align-items: center; justify-content: center; font-size: 12px; }
    #scrollBtn.visible { opacity: 1; pointer-events: all; }
    #scrollBtn:hover { color: var(--accent); border-color: var(--accent); transform: translateY(-1px); }

    /* ── TODO Drawer (above composer) ─── */
    #todoDrawer { display: none; flex-direction: column; border-top: 1px solid var(--border); flex-shrink: 0; max-height: 220px; overflow: hidden; background: var(--vscode-sideBar-background, var(--bg)); }
    #todoDrawer.visible { display: flex; }
    .todo-drawer-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; cursor: pointer; user-select: none; font-size: 11px; font-weight: 600; color: var(--fg2); transition: background var(--spd); }
    .todo-drawer-header:hover { background: rgba(128,128,128,.08); }
    .todo-drawer-header-left { display: flex; align-items: center; gap: 6px; }
    .todo-drawer-icon { font-size: 12px; opacity: .7; }
    .todo-drawer-chevron { font-size: 8px; color: var(--fg3); transition: transform 0.15s ease; }
    #todoDrawer.collapsed .todo-drawer-chevron { transform: rotate(-90deg); }
    .todo-drawer-count { font-size: 9px; color: var(--fg3); font-weight: 500; font-variant-numeric: tabular-nums; background: rgba(128,128,128,.1); padding: 1px 6px; border-radius: 8px; }
    .todo-drawer-list { display: flex; flex-direction: column; gap: 1px; padding: 2px 8px 6px; max-height: 170px; overflow-y: auto; }
    #todoDrawer.collapsed .todo-drawer-list { display: none; }
    .todo-item { display: flex; align-items: center; gap: 8px; padding: 4px 6px; font-size: 11.5px; color: var(--fg); min-height: 22px; border-radius: 4px; transition: background var(--spd); }
    .todo-item:hover { background: rgba(128,128,128,.06); }
    .todo-item.active { background: rgba(var(--accent-rgb, 0,120,212), .08); }
    .todo-icon { flex-shrink: 0; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; border-radius: 3px; font-size: 11px; }
    .todo-icon.pending { color: var(--fg3); }
    .todo-icon.in-progress { color: var(--accent); }
    .todo-icon.done { color: var(--green); }
    .todo-icon.blocked { color: var(--red); }
    .todo-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3; }
    .todo-title.done { text-decoration: line-through; color: var(--fg3); }
    .todo-title.blocked { color: var(--red); opacity: .7; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .todo-icon.in-progress::after { content: ''; display: inline-block; width: 10px; height: 10px; border: 1.5px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }

    /* ── Files Changed Drawer (above composer) ─── */
    #filesDrawer { display: none; flex-direction: column; border-top: 1px solid var(--border); flex-shrink: 0; max-height: 180px; overflow: hidden; background: var(--vscode-sideBar-background, var(--bg)); }
    #filesDrawer.visible { display: flex; }
    .files-drawer-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; cursor: pointer; user-select: none; font-size: 11px; font-weight: 600; color: var(--fg2); transition: background var(--spd); }
    .files-drawer-header:hover { background: rgba(128,128,128,.08); }
    .files-drawer-header-left { display: flex; align-items: center; gap: 6px; }
    .files-drawer-icon { font-size: 12px; opacity: .7; }
    .files-drawer-chevron { font-size: 8px; color: var(--fg3); transition: transform 0.15s ease; }
    #filesDrawer.collapsed .files-drawer-chevron { transform: rotate(-90deg); }
    .files-drawer-count { font-size: 9px; color: var(--fg3); font-weight: 500; font-variant-numeric: tabular-nums; background: rgba(128,128,128,.1); padding: 1px 6px; border-radius: 8px; }
    .files-drawer-list { display: flex; flex-direction: column; gap: 1px; padding: 2px 8px 6px; max-height: 140px; overflow-y: auto; }
    #filesDrawer.collapsed .files-drawer-list { display: none; }
    .file-item { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 4px; font-size: 11px; color: var(--fg); cursor: pointer; transition: background var(--spd); }
    .file-item:hover { background: rgba(128,128,128,.1); }
    .file-item-icon { flex-shrink: 0; font-size: 12px; color: var(--accent); display: flex; align-items: center; }
    .file-item-name { flex: 1; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-item-stats { display: flex; gap: 6px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
    .file-stat-add { color: var(--green); font-size: 10px; font-weight: 700; }
    .file-stat-del { color: var(--red); font-size: 10px; font-weight: 700; }

    /* --- Rich code blocks --- */
    .code-block { margin: 6px 0; border-radius: 6px; overflow: hidden; border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.12)); background: var(--vscode-editor-background, rgba(0,0,0,.18)); }
    .code-header { display: flex; align-items: center; justify-content: space-between; background: rgba(0,0,0,.15); padding: 5px 10px; border-bottom: 1px solid rgba(128,128,128,.08); }
    .code-lang { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; color: var(--fg3); font-family: var(--vscode-font-family); }
    .code-copy { border: none; background: transparent; color: var(--fg3); cursor: pointer; font-size: 9px; padding: 2px 8px; border-radius: 4px; transition: all var(--spd); font-family: var(--vscode-font-family); }
    .code-copy:hover { color: var(--accent); background: rgba(128,128,128,.12); }
    .code-block pre { margin: 0; border-radius: 0; border: none; padding: 10px 12px; background: transparent; overflow-x: auto; }
    .code-block pre code { font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', Consolas, monospace); font-size: 11.5px; line-height: 1.55; color: var(--vscode-editor-foreground, var(--fg)); tab-size: 2; }
    .bubble pre { font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', Consolas, monospace); font-size: 11.5px; line-height: 1.5; background: var(--vscode-editor-background, rgba(0,0,0,.14)); border-radius: 5px; padding: 8px 10px; margin: 5px 0; overflow-x: auto; white-space: pre-wrap; position: relative; border: 1px solid rgba(128,128,128,.08); }
    .bubble pre code { background: none; padding: 0; }
    .bubble code { font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', Consolas, monospace); font-size: 11px; background: rgba(128,128,128,.1); padding: 1px 4px; border-radius: 3px; }

    /* ── Permission bar ─── */
    .perm-bar { display: flex; align-items: center; justify-content: space-between; padding: 3px 3px 1px; gap: 5px; }
    .perm-selector { position: relative; }
    .perm-btn { display: inline-flex; align-items: center; gap: 3px; border: none; background: transparent; color: var(--fg3); cursor: pointer; font: 500 10px var(--vscode-font-family); padding: 2px 5px; border-radius: 3px; transition: all var(--spd); }
    .perm-btn:hover { color: var(--fg); background: rgba(128,128,128,.06); }
    .perm-btn-icon { font-size: 11px; }
    .perm-btn-chevron { font-size: 7px; opacity: .4; }

    .attachment-row { display: flex; gap: 3px; align-items: center; flex-wrap: wrap; padding: 0 0 3px; }
    .attachment-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--fg3); }
    .img-preview { display: inline-flex; align-items: center; gap: 4px; background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 2px 6px 2px 2px; font-size: 10px; color: var(--fg2); position: relative; }
    .img-thumb { width: 28px; height: 28px; object-fit: cover; border-radius: 4px; }
    .img-name { max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .img-remove { border: none; background: none; color: var(--fg3); font-size: 14px; cursor: pointer; padding: 0 2px; line-height: 1; }
    .img-remove:hover { color: var(--red); }

    /* ── Generic buttons ─── */
    .btn { font: 600 10px var(--vscode-font-family); padding: 3px 8px; border-radius: 5px; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; transition: all var(--spd); }
    .btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.08)); }
    .btn.primary { background: linear-gradient(180deg, var(--accent) 0%, var(--accent-hover) 100%); border-color: var(--accent); color: #fff; text-shadow: 0 1px 1px rgba(0,0,0,.16); }
    .btn.primary:hover { background: linear-gradient(180deg, var(--accent-hover) 0%, var(--accent) 100%); }
    .btn.danger { color: var(--red); border-color: var(--red-bdr); }
    .btn.danger:hover { background: var(--red-bg); }
    .btn.sm { padding: 2px 6px; font-size: 9px; }

    /* ── Self-learn toggle ─── */
    .self-learn-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 2px; gap: 8px; }
    .self-learn-info { display: flex; flex-direction: column; gap: 1px; }
    .self-learn-label { font-size: 11px; font-weight: 600; color: var(--fg); }
    .self-learn-desc { font-size: 9px; color: var(--fg3); line-height: 1.3; }
    .toggle-switch { position: relative; width: 34px; height: 18px; flex-shrink: 0; }
    .toggle-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
    .toggle-track { position: absolute; inset: 0; background: rgba(128,128,128,.18); border-radius: 99px; cursor: pointer; transition: background var(--spd); }
    .toggle-track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform var(--spd); }
    .toggle-switch input:checked + .toggle-track { background: var(--accent); }
    .toggle-switch input:checked + .toggle-track::after { transform: translateX(16px); }

    /* ── Streaming cursor ─── */
    .streaming-cursor::after { content: '\\25AE'; animation: blink-cursor .6s step-end infinite; color: var(--accent); margin-left: 1px; }
    @keyframes blink-cursor { 50% { opacity: 0; } }

    @keyframes fadein { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: translateY(0); } }
    .fadein { animation: fadein 140ms ease forwards; }
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(128,128,128,.15); border-radius: 99px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,.3); }
  </style>
</head>
<body>
<div id="root">
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

<script nonce="${nonce}">
(function () {
  'use strict';
  var vscode = null;

  function surfaceFatalError(msg) {
    var b = document.getElementById('fatalBanner');
    if (b) { b.textContent = msg; b.classList.add('on'); }
    if (vscode) { try { vscode.postMessage({ type: 'webviewError', payload: msg }); } catch(_) {} }
  }

  try {
    vscode = acquireVsCodeApi();
  var initialSummary = ${initialSummaryJson};
  var D = function(id) { return document.getElementById(id); };

  // DOM refs
  var statusBadge = D('statusBadge'), statusTxt = D('statusTxt');
  var btnSettings = D('btnSettings'), btnRefresh = D('btnRefresh'), btnNewChat = D('btnNewChat');
  var settingsDrawer = D('settingsDrawer');
  var personaSelect = D('personaSelect'), modelSelect = D('modelSelect');
  var btnSyncModels = D('btnSyncModels'), btnApplyModel = D('btnApplyModel');
  var btnAddMcp = D('btnAddMcp'), btnReloadMcp = D('btnReloadMcp'), btnSaveMcp = D('btnSaveMcp');
  var btnOpenMcpSettings = D('btnOpenMcpSettings'), btnManageMcp = D('btnManageMcp');
  var mcpList = D('mcpList'), mcpCount = D('mcpCount');
  var homeView = D('homeView'), chatView = D('chatView');
  var btnBack = D('btnBack'), attachmentRow = D('attachmentRow');
  var sessionList = D('sessionList'), messages = D('messages');
  var editsBanner = D('editsBanner'), bannerTxt = D('bannerTxt');
  var btnApply = D('btnApply'), btnRevert = D('btnRevert');
  var chipMode = D('chipMode'), chipModel = D('chipModel');
  var taskInput = D('taskInput'), btnSend = D('btnSend'), btnAttach = D('btnAttach');
  var permBtn = D('permBtn'), permBtnIcon = D('permBtnIcon'), permBtnLabel = D('permBtnLabel');
  var scrollBtn = D('scrollBtn'), selfLearnToggle = D('selfLearnToggle');
  var learningBadge = D('learningBadge');
  var todoDrawer = D('todoDrawer'), todoDrawerList = D('todoDrawerList'), todoDrawerCount = D('todoDrawerCount');
  var filesDrawer = D('filesDrawer'), filesDrawerList = D('filesDrawerList'), filesDrawerCount = D('filesDrawerCount');

  // State
  var summary = null, models = [], mcpServers = [];
  var chatHistory = [], attachedFiles = [];
  var conversationMode = 'agent', inChat = false;
  var activeModelName = '', permMode = 'default';
  var autoRestoreSessionAttempted = false;
  var thinkingSteps = [], thinkingStartTime = null;
  var modePopupOpen = false, modelPopupOpen = false, permPopupOpen = false;
  var isBusy = false;
  var composeState = { mode: 'new', messageId: '', messageIndex: -1 };
  var pendingRequest = null;
  var streamBuffer = '';
  var streamBubble = null;
  var streamChunkQueue = [];
  var streamFlushTimer = null;
  var streamRenderBuffer = '';
  var currentTodos = [];
  var currentFiles = [];
  var todoDrawerCollapsed = true;
  var filesDrawerCollapsed = true;

  // --- Drawer render functions ---
  function renderTodoDrawer(todos) {
    if (!todoDrawer || !todoDrawerList || !Array.isArray(todos) || !todos.length) {
      if (todoDrawer) todoDrawer.classList.remove('visible');
      return;
    }
    currentTodos = todos;
    var doneCount = 0;
    todoDrawerList.innerHTML = '';
    for (var i = 0; i < todos.length; i++) {
      var t = todos[i];
      var status = String(t.status || 'pending').toLowerCase();
      var isDone = status === 'done' || status === 'completed';
      var isActive = status === 'in-progress' || status === 'in_progress';
      var isBlocked = status === 'blocked' || status === 'failed';
      if (isDone) doneCount++;
      var statusClass = isDone ? 'done' : isActive ? 'in-progress' : isBlocked ? 'blocked' : 'pending';
      var item = document.createElement('div');
      item.className = 'todo-item' + (isActive ? ' active' : '');
      var iconEl = document.createElement('span');
      iconEl.className = 'todo-icon ' + statusClass;
      if (isDone) iconEl.textContent = '\u2713';
      else if (isBlocked) iconEl.textContent = '\u2717';
      else if (!isActive) iconEl.textContent = '\u25CB';
      // in-progress uses CSS spinner via ::after
      var titleEl = document.createElement('span');
      titleEl.className = 'todo-title' + (isDone ? ' done' : isBlocked ? ' blocked' : '');
      titleEl.textContent = t.task || t.title || t.text || '';
      item.appendChild(iconEl);
      item.appendChild(titleEl);
      todoDrawerList.appendChild(item);
    }
    todoDrawerCount.textContent = doneCount + '/' + todos.length;
    todoDrawer.classList.add('visible');
    todoDrawer.classList.toggle('collapsed', todoDrawerCollapsed);
  }

  function renderFilesDrawer(files) {
    if (!filesDrawer || !filesDrawerList || !Array.isArray(files) || !files.length) {
      if (filesDrawer) filesDrawer.classList.remove('visible');
      return;
    }
    currentFiles = files;
    filesDrawerList.innerHTML = '';
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var fpath = String(f.path || f.file || f.filePath || f.fileName || '');
      var basename = fpath.split(/[\\/]/).pop() || fpath;
      var added = parseInt(f.additions || f.linesAdded || 0, 10) || 0;
      var removed = parseInt(f.deletions || f.linesRemoved || 0, 10) || 0;
      var item = document.createElement('div');
      item.className = 'file-item';
      item.dataset.filepath = fpath;
      var iconSpan = '<span class="file-item-icon">\uD83D\uDCCB</span>';
      var nameSpan = '<span class="file-item-name" title="' + esc(fpath) + '">' + esc(basename) + '</span>';
      var statsSpan = '<span class="file-item-stats">' +
        (added > 0 ? '<span class="file-stat-add">+' + added + '</span>' : '') +
        (removed > 0 ? '<span class="file-stat-del">\u2212' + removed + '</span>' : '') +
        '</span>';
      item.innerHTML = iconSpan + nameSpan + statsSpan;
      item.addEventListener('click', (function(p) {
        return function() { vscode.postMessage({ type: 'openFile', payload: p }); };
      })(fpath));
      filesDrawerList.appendChild(item);
    }
    filesDrawerCount.textContent = files.length + ' file' + (files.length === 1 ? '' : 's');
    filesDrawer.classList.add('visible');
    filesDrawer.classList.toggle('collapsed', filesDrawerCollapsed);
  }

  function resetDrawers() {
    currentTodos = []; currentFiles = [];
    if (todoDrawer) { todoDrawer.classList.remove('visible'); todoDrawerList.innerHTML = ''; todoDrawerCount.textContent = ''; }
    if (filesDrawer) { filesDrawer.classList.remove('visible'); filesDrawerList.innerHTML = ''; filesDrawerCount.textContent = ''; }
  }

  // Helpers
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function relTime(iso) {
    var d = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!isFinite(d) || d < 1) return 'just now';
    if (d < 60) return d + 'm ago';
    var h = Math.round(d / 60);
    return h < 24 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
  }
  function autoGrow(el) { if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; }
  function updateScrollButton() {
    if (!scrollBtn) return;
    var el = D('main');
    var show = false;
    if (inChat && el) {
      var overflow = el.scrollHeight > el.clientHeight + 8;
      var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
      show = overflow && !atBottom;
    }
    scrollBtn.classList.toggle('visible', show);
  }
  function scheduleScrollButtonUpdate() { requestAnimationFrame(updateScrollButton); }
  function scrollBottom() {
    requestAnimationFrame(function() {
      var el = D('main');
      if (el) el.scrollTop = el.scrollHeight;
      updateScrollButton();
    });
  }
  function on(el, evt, fn) { if (el) el.addEventListener(evt, fn); }
  function makeMessageId() { return 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
  function resetComposeState() { composeState = { mode: 'new', messageId: '', messageIndex: -1 }; if (taskInput) taskInput.placeholder = conversationMode === 'ask' ? 'Ask Pulse a question…' : conversationMode === 'plan' ? 'Describe the change you want planned…' : 'Ask Pulse anything about your code…'; if (btnSend) btnSend.title = 'Send (Enter)'; }
  function beginEditMessage(messageId, messageIndex) {
    var item = chatHistory[messageIndex];
    if (!item || item.role !== 'user') return;
    composeState = { mode: 'edit', messageId: messageId, messageIndex: messageIndex };
    if (taskInput) {
      taskInput.value = item.text || item.content || '';
      autoGrow(taskInput);
      taskInput.focus();
      taskInput.setSelectionRange(taskInput.value.length, taskInput.value.length);
      taskInput.placeholder = 'Edit message and resend…';
    }
    if (btnSend) {
      btnSend.title = 'Save & Send';
    }
  }
  function beginRetryMessage(messageId, messageIndex) {
    var responseItem = chatHistory[messageIndex];
    if (!responseItem) return;
    var sourceText = '';
    for (var i = messageIndex - 1; i >= 0; i--) {
      if (chatHistory[i].role === 'user') {
        sourceText = chatHistory[i].text || chatHistory[i].content || '';
        break;
      }
    }
    composeState = { mode: 'retry', messageId: messageId, messageIndex: messageIndex };
    if (taskInput) {
      taskInput.value = sourceText;
      autoGrow(taskInput);
      taskInput.focus();
      taskInput.setSelectionRange(taskInput.value.length, taskInput.value.length);
      taskInput.placeholder = 'Retrying the last request…';
    }
    if (btnSend) {
      btnSend.title = 'Retry';
    }
    sendTask();
  }

  // Markdown rendering
  function renderMarkdown(raw) {
    if (!raw) return '';
    // Strip <break> tags, thinking artifacts, and clean up model output noise
    raw = raw.replace(/<break\\s*\\/?>/gi, '\\n').replace(/<\\/break>/gi, '\\n');
    // Strip raw JSON blocks that models sometimes emit as response text
    raw = raw.replace(/^\\s*\\{[\\s\\S]*?"response"\\s*:\\s*"[\\s\\S]*?"[\\s\\S]*?\\}\\s*$/gm, function(match) {
      try { var obj = JSON.parse(match); return obj.response || match; } catch(e) { return match; }
    });
    // Extract fenced code blocks first, replace with placeholders
    var blocks = [];
    var blockIdx = 0;
    var stripped = raw.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, function(_, lang, code) {
      var label = lang || 'code';
      var bid = 'cb-' + (blockIdx);
      var placeholder = '%%CODEBLOCK_' + (blockIdx++) + '%%';
      blocks.push('<div class="code-block"><div class="code-header"><span class="code-lang">' + esc(label) + '</span>' +
        '<button class="code-copy" data-bid="' + bid + '">Copy</button></div>' +
        '<pre id="' + bid + '"><code>' + esc(code) + '</code></pre></div>');
      return placeholder;
    });
    // Also match fenced code blocks without language
    stripped = stripped.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, function(_, code) {
      var bid = 'cb-' + (blockIdx);
      var placeholder = '%%CODEBLOCK_' + (blockIdx++) + '%%';
      blocks.push('<div class="code-block"><pre id="' + bid + '"><code>' + esc(code) + '</code></pre></div>');
      return placeholder;
    });
    // Now escape the rest
    var html = esc(stripped);
    // Inline code
    html = html.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
    // Bold and italic
    html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
    // Headings
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // Lists
    html = html.replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^(\\d+)\\. (.+)$/gm, '<li>$2</li>');
    // Wrap adjacent <li> in <ul>
    html = html.replace(/((?:<li>.*?<\\/li>\\n?)+)/g, '<ul>$1</ul>');
    // Links: [text](url)
    html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" title="$2">$1</a>');
    // Newlines to br (except inside pre/code)
    html = html.replace(/\\n/g, '<br>');
    // Restore code block placeholders
    for (var bi = 0; bi < blocks.length; bi++) {
      html = html.replace('%%CODEBLOCK_' + bi + '%%', blocks[bi]);
    }
    return html;
  }

  // Permission labels
  var PERM_LABELS = {
    'default': { icon: '\u2625', label: 'Default Approvals' },
    'full':    { icon: '\u26A0', label: 'Bypass Approvals' },
    'strict':  { icon: '\uD83D\uDD12', label: 'Require Approvals' }
  };

  function updatePermUI(mode) {
    permMode = mode || 'default';
    var info = PERM_LABELS[permMode] || PERM_LABELS['default'];
    if (permBtnIcon) permBtnIcon.textContent = info.icon;
    if (permBtnLabel) permBtnLabel.textContent = info.label;
    var popup = D('permPopup');
    if (popup) {
      popup.querySelectorAll('.perm-opt').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.perm === permMode);
      });
    }
  }

  // Conversation mode
  function renderConversationMode(mode) {
    conversationMode = mode || 'agent';
    if (chipMode) chipMode.textContent = conversationMode.toUpperCase();
    var popup = D('modePopup');
    if (popup) popup.querySelectorAll('.popup-opt').forEach(function(btn) { btn.classList.toggle('active', btn.dataset.mode === conversationMode); });
    if (taskInput && composeState.mode === 'new') {
      taskInput.placeholder = conversationMode === 'ask' ? 'Ask Pulse a question\u2026'
        : conversationMode === 'plan' ? 'Describe the change you want planned\u2026'
        : 'Ask Pulse anything about your code\u2026';
    }
  }

  // Popups
  function closeAllPopups() { closeModePopup(); closeModelPopup(); closePermPopup(); }
  function openModePopup() { closeAllPopups(); var p = D('modePopup'); if (p) p.classList.remove('hidden'); modePopupOpen = true; }
  function closeModePopup() { var p = D('modePopup'); if (p) p.classList.add('hidden'); modePopupOpen = false; }
  function openModelPopup() {
    closeAllPopups();
    var popup = D('modelPopup'), list = D('modelPopupList');
    if (!popup || !list) return;
    list.innerHTML = '';
    if (!models.length) { list.innerHTML = '<div style="padding:8px 10px;font-size:11px;opacity:.5">No models</div>'; }
    else { models.forEach(function(m) {
      var btn = document.createElement('button'); btn.type = 'button';
      btn.className = 'model-item' + (m.name === activeModelName ? ' active' : '');
      btn.title = describeModelTooltip(m);
      btn.addEventListener('click', function(e) { e.stopPropagation(); activeModelName = m.name;
        if (chipModel) { chipModel.textContent = m.name.split(':')[0].slice(0,14) || '\u2013'; chipModel.title = m.name; }
        vscode.postMessage({ type: 'setModel', payload: { role: 'planner', model: m.name } });
        vscode.postMessage({ type: 'setModel', payload: { role: 'editor', model: m.name } });
        vscode.postMessage({ type: 'setModel', payload: { role: 'fast', model: m.name } });
        closeModelPopup(); });
      var row = document.createElement('div'); row.className = 'model-item-row';
      var name = document.createElement('span'); name.className = 'model-item-name'; name.textContent = m.name;
      row.appendChild(name);
      if (m.name === activeModelName) row.appendChild(createModelBadge('Active', 'active'));
      btn.appendChild(row);

      var badges = document.createElement('div'); badges.className = 'model-item-badges';
      badges.appendChild(createModelBadge('Agent-ready', 'ready'));
      badges.appendChild(createModelBadge(sourceLabelForModel(m), sourceBadgeClassForModel(m)));
      if (m.supportsVision) badges.appendChild(createModelBadge('Vision', 'vision'));
      btn.appendChild(badges);
      list.appendChild(btn);
    }); }
    popup.classList.remove('hidden'); modelPopupOpen = true;
  }
  function createModelBadge(label, className) {
    var badge = document.createElement('span');
    badge.className = 'model-badge ' + className;
    badge.textContent = label;
    return badge;
  }
  function sourceLabelForModel(model) {
    if (!model || !model.source) return 'Compatible';
    if (model.source === 'running') return 'Running';
    if (model.source === 'local') return 'Local';
    return 'Configured';
  }
  function sourceBadgeClassForModel(model) {
    if (!model || !model.source) return 'configured';
    return model.source === 'running' ? 'running' : model.source === 'local' ? 'local' : 'configured';
  }
  function describeModelTooltip(model) {
    if (!model || !model.name) return 'Model';
    var parts = [model.name, 'Usable with the current agent', 'Source: ' + sourceLabelForModel(model)];
    if (model.supportsVision) parts.push('Supports vision/image tasks');
    return parts.join(' — ');
  }
  function closeModelPopup() { var p = D('modelPopup'); if (p) p.classList.add('hidden'); modelPopupOpen = false; }
  function openPermPopup() { closeAllPopups(); var p = D('permPopup'); if (p) { updatePermUI(permMode); p.classList.remove('hidden'); } permPopupOpen = true; }
  function closePermPopup() { var p = D('permPopup'); if (p) p.classList.add('hidden'); permPopupOpen = false; }
  document.addEventListener('click', closeAllPopups);

  // Thinking — GitHub Copilot-style step list
  var thinkingTimer = null, stepsCollapsed = false;
  function resetThinkingPanel() {
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
    stopReasoningLabelCycle();
    thinkingSteps = [];
    thinkingStartTime = null;
    stepsCollapsed = false;
    var panel = D('thinkingPanel'), title = D('thinkingTitle'), elapsed = D('thinkingElapsed'), list = D('stepsList');
    if (!panel) return;
    panel.classList.add('hidden');
    panel.classList.remove('done', 'steps-collapsed');
    if (title) title.textContent = 'Thinking…';
    if (elapsed) elapsed.textContent = '';
    if (list) list.innerHTML = '';
  }

  function startThinking() {
    thinkingSteps = []; thinkingStartTime = Date.now(); stepsCollapsed = false;
    var panel = D('thinkingPanel'), title = D('thinkingTitle'), elapsed = D('thinkingElapsed'), list = D('stepsList');
    if (!panel) return;
    panel.classList.remove('hidden', 'done');
    panel.classList.remove('steps-collapsed');
    if (title) title.textContent = 'Thinking\u2026';
    if (elapsed) elapsed.textContent = '';
    if (list) list.innerHTML = '';
    if (thinkingTimer) clearInterval(thinkingTimer);
    thinkingTimer = setInterval(function() {
      if (elapsed && thinkingStartTime) {
        var s = ((Date.now() - thinkingStartTime) / 1000).toFixed(0);
        elapsed.textContent = s + 's';
      }
    }, 1000);
  }
    var reasoningLabels = ['Thinking\u2026', 'Reasoning\u2026', 'Analyzing\u2026', 'Checking\u2026', 'Processing\u2026'];
    var reasoningLabelIdx = 0;
    var reasoningLabelTimer = null;
    function startReasoningLabelCycle(labelEl) {
      if (reasoningLabelTimer) return;
      reasoningLabelTimer = setInterval(function() {
        reasoningLabelIdx = (reasoningLabelIdx + 1) % reasoningLabels.length;
        if (labelEl) labelEl.textContent = reasoningLabels[reasoningLabelIdx];
      }, 1800);
    }
    function stopReasoningLabelCycle() {
      if (reasoningLabelTimer) { clearInterval(reasoningLabelTimer); reasoningLabelTimer = null; }
      reasoningLabelIdx = 0;
    }

    function addThinkingStep(step) {
    thinkingSteps.push(step);
    var title = D('thinkingTitle'), list = D('stepsList');
    var kind = step.kind || 'step';
    var label = step.step || 'Processing';
    if (!list) return;

    // Drawer updates — render without adding a step item
    if (kind === 'todo_update') { renderTodoDrawer(step.todos || []); return; }
    if (kind === 'files_changed') { renderFilesDrawer(step.files || []); return; }

    if (kind === 'reasoning') {
      // Update the live reasoning block — APPEND new chunk to accumulated text
      var active = list.querySelector('.step-reasoning-active');
      if (active) {
        var rt = active.querySelector('.step-reasoning-text');
        if (rt) {
          var incoming = String(step.detail || '');
          if (!incoming.trim()) { scrollBottom(); return; }
          // Avoid endlessly duplicating placeholder pulse text.
          var current = rt.textContent || '';
          var normalizedIncoming = incoming.replace(/\s+/g, ' ').trim();
          var normalizedTail = current.slice(Math.max(0, current.length - normalizedIncoming.length - 4)).replace(/\s+/g, ' ').trim();
          var isPlaceholder = /^(Reasoning through tools and code changes|Thinking through the next action)\.\.\.$/i.test(normalizedIncoming);
          if ((normalizedIncoming && normalizedTail === normalizedIncoming) || (isPlaceholder && current.indexOf(incoming) >= 0)) {
            scrollBottom(); return;
          }
          // Append new tokens; keep only the last 800 chars to avoid DOM bloat
          var joiner = current && !/\s$/.test(current) && !/^\s/.test(incoming) ? ' ' : '';
          var appended = current + joiner + incoming;
          rt.textContent = appended.length > 800 ? appended.slice(appended.length - 800) : appended;
        }
        scrollBottom(); return;
      }
      var item = document.createElement('div');
      item.className = 'step-item step-reasoning step-reasoning-active';
      var labelEl = document.createElement('span');
      labelEl.className = 'step-reasoning-label';
      labelEl.textContent = reasoningLabels[0];
      var textEl = document.createElement('span');
      textEl.className = 'step-reasoning-text';
      textEl.textContent = step.detail || '';
      item.appendChild(labelEl);
      item.appendChild(textEl);
      list.appendChild(item);
      if (title) title.textContent = 'Generating\u2026';
      startReasoningLabelCycle(labelEl);
      scrollBottom(); return;
    }

    // Seal the previous reasoning block so the next reasoning chunk starts fresh
    var prevActive = list.querySelector('.step-reasoning-active');
    if (prevActive) {
      prevActive.classList.remove('step-reasoning-active');
      var prevLabel = prevActive.querySelector('.step-reasoning-label');
      if (prevLabel) prevLabel.textContent = 'Thought';
      stopReasoningLabelCycle();
    }

    var item = document.createElement('div');
    item.className = 'step-item step-' + kind;

    if (kind === 'file_patch') {
      if (title) title.textContent = 'Generating patch\u2026';
      item.innerHTML =
        '<span class="step-icon">&#9998;</span>' +
        '<span class="step-label">Generating patch</span>' +
        '<span class="step-line-count">(' + esc(String(step.lineCount || 0)) + ' lines) in&nbsp;</span>' +
        '<span class="step-file-name">' + esc(step.file || '') + '</span>';
    } else if (kind === 'file_patched') {
      if (title) title.textContent = 'Edited ' + (step.file || '');
      item.innerHTML =
        '<span class="step-icon" style="color:var(--green)">&#10003;</span>' +
        '<span class="step-label">Edited</span>' +
        '<span class="step-file-name">' + esc(step.file || '') + '</span>' +
        '<span class="step-diff-added">+' + esc(String(step.linesAdded || 0)) + '</span>' +
        '<span class="step-diff-removed">\u2212' + esc(String(step.linesRemoved || 0)) + '</span>';
    } else if (kind === 'terminal') {
      if (title) title.textContent = 'Running terminal';
      item.innerHTML =
        '<span class="step-icon">&#9654;</span>' +
        '<span class="step-cmd">$ ' + esc(step.detail || step.step || '') + '</span>';
    } else {
      // Generic step
      if (title) title.textContent = label;
      item.innerHTML =
        '<span class="step-icon">' + esc(step.icon || '\u25cf') + '</span>' +
        '<span class="step-label">' + esc(label) + '</span>' +
        (step.detail ? '<span class="step-detail">' + esc(step.detail) + '</span>' : '');
    }

    list.appendChild(item);
    // Auto-scroll the step list itself if it overflows
    list.scrollTop = list.scrollHeight;
    scrollBottom();
  }
  function finishThinking(cancelled) {
    var panel = D('thinkingPanel'), title = D('thinkingTitle'), elapsed = D('thinkingElapsed'), list = D('stepsList');
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
    if (!panel) return;
    panel.classList.add('done');
    // Unseal any active reasoning block and stop label cycling
    stopReasoningLabelCycle();
    if (list) {
      var ar = list.querySelector('.step-reasoning-active');
      if (ar) {
        ar.classList.remove('step-reasoning-active');
        var arLabel = ar.querySelector('.step-reasoning-label');
        if (arLabel) arLabel.textContent = 'Thought';
      }
    }
    var sec = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) : '0';
    var count = thinkingSteps.length;
    if (title) title.textContent = cancelled ? 'Cancelled after ' + sec + 's' : 'Completed in ' + sec + 's \u00b7 ' + count + ' step' + (count !== 1 ? 's' : '');
    if (elapsed) elapsed.textContent = '';
    setBusyMode(false);
  }
  on(D('stepsToggleBtn'), 'click', function(e) {
    e.stopPropagation();
    var panel = D('thinkingPanel'); if (!panel) return;
    stepsCollapsed = !stepsCollapsed;
    panel.classList.toggle('steps-collapsed', stepsCollapsed);
  });

  // Drawer toggles
  on(D('todoDrawerToggle'), 'click', function() {
    todoDrawerCollapsed = !todoDrawerCollapsed;
    if (todoDrawer) todoDrawer.classList.toggle('collapsed', todoDrawerCollapsed);
  });
  on(D('filesDrawerToggle'), 'click', function() {
    filesDrawerCollapsed = !filesDrawerCollapsed;
    if (filesDrawer) filesDrawer.classList.toggle('collapsed', filesDrawerCollapsed);
  });

  // MCP utils
  function normalizeMcpServer(s) {
    var t = String(s && s.transport || 'stdio');
    var args = [];
    if (Array.isArray(s && s.args)) args = s.args.map(String);
    else if (typeof (s && s.args) === 'string') args = s.args.split(/\\r?\\n/).map(function(a) { return a.trim(); }).filter(Boolean);
    return { id: String(s && s.id || ''), enabled: s && s.enabled !== false, trust: String(s && s.trust || 'workspace'), transport: t, command: String(s && s.command || ''), url: String(s && s.url || ''), args: args };
  }
  function parseArgs(text) {
    var raw = String(text || '').trim(); if (!raw) return [];
    if (raw.charAt(0) === '[') { var p = JSON.parse(raw); if (!Array.isArray(p)) throw new Error('Args must be JSON array'); return p.map(String); }
    return raw.split(/\\r?\\n/).map(function(a) { return a.trim(); }).filter(Boolean);
  }
  function renderMcpServers(list) {
    mcpServers = (list || []).map(normalizeMcpServer);
    mcpCount.textContent = mcpServers.length === 1 ? '1 configured' : mcpServers.length + ' configured';
    if (!mcpServers.length) { mcpList.innerHTML = '<div class="mcp-empty fadein">No MCP servers. Add one to connect tools.</div>'; return; }
    mcpList.innerHTML = '';
    mcpServers.forEach(function(server, idx) {
      var card = document.createElement('div'); card.className = 'mcp-card fadein'; card.dataset.index = String(idx);
      var epLabel = server.transport === 'stdio' ? 'Command' : 'URL';
      var epValue = server.transport === 'stdio' ? server.command : server.url;
      card.innerHTML = '<div class="mcp-card-head"><div class="mcp-card-title"><input type="text" data-field="id" placeholder="server-name" value="' + esc(server.id) + '" /></div><label class="mcp-chip"><input type="checkbox" data-field="enabled" ' + (server.enabled ? 'checked' : '') + '/> On</label><button type="button" class="btn danger sm" data-action="remove">Remove</button></div>' +
        '<div class="mcp-grid"><select data-field="transport"><option value="stdio">stdio</option><option value="http">http</option><option value="sse">sse</option></select><select data-field="trust"><option value="workspace">workspace</option><option value="user">user</option><option value="system">system</option></select><div class="mcp-chip">' + esc(epLabel) + '</div></div>' +
        '<input type="text" data-field="endpoint" placeholder="' + esc(epLabel) + '" value="' + esc(epValue) + '" />' +
        '<textarea data-field="args" placeholder="[\\"arg1\\", \\"arg2\\"]">' + esc((server.args || []).join('\\n')) + '</textarea>';
      var ts = card.querySelector('select[data-field="transport"]'), trs = card.querySelector('select[data-field="trust"]');
      var ep = card.querySelector('input[data-field="endpoint"]'), ar = card.querySelector('textarea[data-field="args"]');
      var en = card.querySelector('input[data-field="enabled"]');
      ts.value = server.transport; trs.value = server.trust;
      var syncEp = function() { ep.placeholder = ts.value === 'stdio' ? 'Command' : 'URL'; ar.style.display = ts.value === 'stdio' ? 'block' : 'none'; };
      ts.addEventListener('change', syncEp); syncEp();
      card._read = function() { return { id: String(card.querySelector('input[data-field="id"]').value || '').trim(), enabled: Boolean(en.checked), trust: String(trs.value || 'workspace'), transport: String(ts.value || 'stdio'), command: String(ts.value === 'stdio' ? ep.value || '' : ''), url: String(ts.value === 'stdio' ? '' : ep.value || ''), args: parseArgs(String(ar.value || '')) }; };
      card.querySelector('[data-action="remove"]').addEventListener('click', function() { var cur = snapshotMcpServers(); cur.splice(idx, 1); renderMcpServers(cur); });
      mcpList.appendChild(card);
    });
  }
  function collectMcpServers() {
    return Array.from(mcpList.querySelectorAll('.mcp-card')).map(function(c) { return typeof c._read === 'function' ? c._read() : null; }).filter(Boolean).filter(function(s) {
      if (!s.id) return false;
      if (s.transport === 'stdio' && !s.command) throw new Error('Stdio server needs a command.');
      if ((s.transport === 'http' || s.transport === 'sse') && !s.url) throw new Error('HTTP/SSE server needs a URL.');
      return true;
    });
  }
  function snapshotMcpServers() { return Array.from(mcpList.querySelectorAll('.mcp-card')).map(function(c) { return typeof c._read === 'function' ? c._read() : null; }).filter(Boolean); }

  // Navigation
  function showHome() { inChat = false; homeView.classList.remove('hidden'); chatView.classList.add('hidden'); }
  function showChat() { inChat = true; homeView.classList.add('hidden'); chatView.classList.remove('hidden'); scrollBottom(); }

  // SVG icons for message action buttons (VS Code codicon style)
  var SVG_RETRY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>';
  var SVG_COPY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>';
  var SVG_COPY_OK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg>';
  var SVG_EDIT = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/></svg>';

  /** Maximum diff lines to render per file to avoid DOM bloat */
  var DIFF_MAX_LINES = 200;

  /** Build HTML for an array of file diffs, rendered inline in chat */
  function renderDiffCards(diffs, isAutoApplied) {
    if (!diffs || !diffs.length) return '';
    var statusLabel = isAutoApplied ? 'Applied' : 'Pending';
    var h = '<div class="diff-section">';
    h += '<div style="font-size:11px;font-weight:600;color:var(--fg2);margin-bottom:4px">' + esc(diffs.length + ' file' + (diffs.length === 1 ? '' : 's') + ' changed') + ' \u2014 <span style="color:var(--accent)">' + esc(statusLabel) + '</span></div>';
    for (var i = 0; i < diffs.length; i++) {
      var d = diffs[i];
      var fname = d.fileName || d.filePath || 'unknown';
      var badge = '';
      if (d.isNew) badge = '<span class="diff-card-new">NEW</span>';
      else if (d.isDelete) badge = '<span class="diff-card-del">DEL</span>';
      h += '<div class="diff-card" data-diff-idx="' + i + '">';
      h += '<div class="diff-card-header">';
      h += '<span class="diff-card-arrow">\u25B6</span>';
      h += '<span class="diff-card-file">' + esc(fname) + '</span>';
      h += badge;
      h += '<span class="diff-card-badge">';
      if (d.additions > 0) h += '<span class="diff-stat-add">+' + d.additions + '</span>';
      if (d.deletions > 0) h += '<span class="diff-stat-del">\u2212' + d.deletions + '</span>';
      h += '</span>';
      h += '</div>';
      h += '<div class="diff-content">';
      if (d.hunks && d.hunks.length) {
        h += '<table class="diff-table">';
        var linesRendered = 0;
        for (var hi = 0; hi < d.hunks.length && linesRendered < DIFF_MAX_LINES; hi++) {
          var hunk = d.hunks[hi];
          if (hi > 0) {
            h += '<tr class="diff-tr-sep"><td class="diff-ln" colspan="2"></td><td class="diff-code" style="color:var(--fg3);font-style:italic;padding:2px 6px">\u22EE</td></tr>';
          }
          for (var li = 0; li < hunk.lines.length && linesRendered < DIFF_MAX_LINES; li++) {
            var ln = hunk.lines[li];
            var cls = ln.type === 'add' ? 'diff-tr-add' : ln.type === 'remove' ? 'diff-tr-del' : 'diff-tr-ctx';
            var olNum = ln.oldLine != null ? String(ln.oldLine) : '';
            var nlNum = ln.newLine != null ? String(ln.newLine) : '';
            h += '<tr class="' + cls + '">';
            h += '<td class="diff-ln">' + esc(olNum) + '</td>';
            h += '<td class="diff-ln">' + esc(nlNum) + '</td>';
            h += '<td class="diff-code">' + esc(ln.content) + '</td>';
            h += '</tr>';
            linesRendered++;
          }
        }
        h += '</table>';
        if (linesRendered >= DIFF_MAX_LINES) {
          h += '<div class="diff-truncated">Diff truncated \u2014 showing first ' + DIFF_MAX_LINES + ' lines</div>';
        }
      }
      h += '</div>';
      // Per-file accept/reject buttons
      if (!isAutoApplied) {
        h += '<div class="diff-file-actions" data-diff-file="' + esc(d.filePath || fname) + '">';
        h += '<button class="btn primary xs diff-file-accept" title="Accept this file">&#10003; Accept</button>';
        h += '<button class="btn danger xs diff-file-reject" title="Reject this file">&#10007; Reject</button>';
        h += '</div>';
      }
      h += '</div>';
    }
    if (!isAutoApplied) {
      h += '<div class="diff-actions">';
      h += '<button class="btn primary sm diff-keep-btn">Keep All</button>';
      h += '<button class="btn danger sm diff-undo-btn">Discard All</button>';
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  // Render messages
  function renderMessages() {
    if (!chatHistory.length) {
      messages.innerHTML = '<div class="empty fadein"><div class="empty-icon">&#9889;</div><div class="empty-h">What can I help you build?</div><div class="empty-p">Describe a task, ask a question, or paste code to get started</div></div>';
      scheduleScrollButtonUpdate();
      return;
    }
    messages.innerHTML = '';
    for (var i = 0; i < chatHistory.length; i++) {
      var m = chatHistory[i];
      if (!m.id) m.id = makeMessageId();
      var div = document.createElement('div');
      var role = m.role === 'assistant' ? 'agent' : m.role;
      div.className = 'msg ' + role + ' fadein';
      div.dataset.messageId = String(m.id || '');
      div.dataset.messageIndex = String(i);

      // Terminal blocks render as special expandable elements
      if (m.role === 'terminal' && m.isHtml) {
        div.innerHTML = m.text || '';
        // Add toggle handler for terminal blocks
        var termHeader = div.querySelector('.terminal-chat-header');
        if (termHeader) {
          termHeader.addEventListener('click', function(e) {
            e.stopPropagation();
            var block = this.parentElement;
            if (block) {
              var output = block.querySelector('.terminal-chat-output');
              if (output) output.classList.toggle('hidden');
              block.classList.toggle('open');
            }
          });
        }
        messages.appendChild(div);
        continue;
      }

      if (composeState.mode === 'edit' && String(m.id || '') === String(composeState.messageId || '')) {
        div.classList.add('editing');
      }
      var text = m.text || m.content || '';
      var html = renderMarkdown(text);
      // Append inline diff cards when available
      if (m.fileDiffs && m.fileDiffs.length > 0) {
        html += renderDiffCards(m.fileDiffs, m.autoApplied);
      }
      var rawTs = m.ts || m.createdAt || null;
      var ts = rawTs ? relTime(new Date(rawTs).toISOString()) : '';
      var footerActions = role === 'agent'
        ? '<button class="retry-btn" title="Retry">' + SVG_RETRY + '</button><button class="copy-btn" title="Copy message">' + SVG_COPY + '</button>'
        : '<button class="retry-btn edit-btn" title="Edit message">' + SVG_EDIT + '</button><button class="copy-btn" title="Copy message">' + SVG_COPY + '</button>';
      div.innerHTML = '<div class="bubble">' + html + '</div>' +
        '<div class="msg-footer">' +
        '<span class="msg-time">' + esc(ts) + '</span>' +
        '<div style="display:flex;gap:2px;align-items:center">' + footerActions + '</div>' +
        '</div>';
      (function(t, el, msgRole) {
        el.querySelector('.copy-btn').addEventListener('click', function(e) {
          e.stopPropagation();
          var target = e.currentTarget;
          navigator.clipboard.writeText(t).then(function() {
            target.innerHTML = SVG_COPY_OK;
            setTimeout(function() { target.innerHTML = SVG_COPY; }, 1400);
          });
        });
        if (msgRole === 'user') {
          var editBtn = el.querySelector('.edit-btn');
          if (editBtn) editBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            beginEditMessage(String(el.dataset.messageId || ''), Number(el.dataset.messageIndex || -1));
          });
          el.addEventListener('dblclick', function(e) {
            e.stopPropagation();
            beginEditMessage(String(el.dataset.messageId || ''), Number(el.dataset.messageIndex || -1));
          });
        }
        if (msgRole === 'agent') {
          var retryBtn = el.querySelector('.retry-btn');
          if (retryBtn) retryBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (isBusy) return;
            beginRetryMessage(String(el.dataset.messageId || ''), Number(el.dataset.messageIndex || -1));
          });
          // Diff card toggle handlers
          var diffHeaders = el.querySelectorAll('.diff-card-header');
          for (var dh = 0; dh < diffHeaders.length; dh++) {
            diffHeaders[dh].addEventListener('click', function(e) {
              e.stopPropagation();
              var card = this.parentElement;
              if (card) card.classList.toggle('open');
            });
          }
          // Diff Keep / Discard buttons
          var keepBtn = el.querySelector('.diff-keep-btn');
          if (keepBtn) keepBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            vscode.postMessage({ type: 'applyPending', payload: true });
            var sec = el.querySelector('.diff-actions');
            if (sec) sec.innerHTML = '<span style="font-size:11px;color:var(--green);font-weight:600">\u2713 Applied</span>';
          });
          var discardBtn = el.querySelector('.diff-undo-btn');
          if (discardBtn) discardBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            vscode.postMessage({ type: 'revertLast', payload: true });
            var sec = el.querySelector('.diff-actions');
            if (sec) sec.innerHTML = '<span style="font-size:11px;color:var(--red);font-weight:600">\u2717 Discarded</span>';
          });
          // Per-file accept/reject buttons
          var fileAcceptBtns = el.querySelectorAll('.diff-file-accept');
          for (var fa = 0; fa < fileAcceptBtns.length; fa++) {
            fileAcceptBtns[fa].addEventListener('click', function(e) {
              e.stopPropagation();
              var actionsDiv = this.parentElement;
              var filePath = actionsDiv ? actionsDiv.dataset.diffFile : '';
              if (filePath) {
                vscode.postMessage({ type: 'acceptFile', payload: filePath });
                if (actionsDiv) actionsDiv.innerHTML = '<span style="font-size:10px;color:var(--green);font-weight:600">\u2713 Accepted</span>';
              }
            });
          }
          var fileRejectBtns = el.querySelectorAll('.diff-file-reject');
          for (var fr = 0; fr < fileRejectBtns.length; fr++) {
            fileRejectBtns[fr].addEventListener('click', function(e) {
              e.stopPropagation();
              var actionsDiv = this.parentElement;
              var filePath = actionsDiv ? actionsDiv.dataset.diffFile : '';
              if (filePath) {
                vscode.postMessage({ type: 'rejectFile', payload: filePath });
                if (actionsDiv) actionsDiv.innerHTML = '<span style="font-size:10px;color:var(--red);font-weight:600">\u2717 Rejected</span>';
              }
            });
          }
        }
      })(text, div, role);
      messages.appendChild(div);
    }
    scheduleScrollButtonUpdate();
  }

  function renderAttachments(files) {
    attachedFiles = Array.isArray(files) ? files.slice() : [];
    if (!attachmentRow) return;
    if (!attachedFiles.length && !attachmentRow.querySelector('.img-preview')) { attachmentRow.innerHTML = ''; return; }
    var html = '<span class="attachment-label">Attached</span>' +
      attachedFiles.map(function(f) { return '<span class="chip" title="' + esc(f) + '">' + esc(f.split(/[\\\\/]/).pop()) + '</span>'; }).join('');
    // Preserve existing image previews
    var existing = attachmentRow.querySelectorAll('.img-preview');
    attachmentRow.innerHTML = html;
    for (var p = 0; p < existing.length; p++) {
      attachmentRow.appendChild(existing[p]);
    }
  }

  function addImagePreview(name, dataUrl) {
    if (!attachmentRow) return;
    // Show the label if not present
    if (!attachmentRow.querySelector('.attachment-label')) {
      var label = document.createElement('span');
      label.className = 'attachment-label';
      label.textContent = 'Attached';
      attachmentRow.insertBefore(label, attachmentRow.firstChild);
    }
    var wrap = document.createElement('span');
    wrap.className = 'img-preview';
    wrap.title = name;
    wrap.innerHTML = '<img src="' + dataUrl + '" class="img-thumb" /><span class="img-name">' + esc(name) + '</span><button class="img-remove" title="Remove">&times;</button>';
    wrap.querySelector('.img-remove').addEventListener('click', function(e) {
      e.stopPropagation();
      wrap.parentNode.removeChild(wrap);
      vscode.postMessage({ type: 'removeImage', payload: name });
    });
    attachmentRow.appendChild(wrap);
  }

  function renderSessions(list) {
    list = list || [];
    if (!list.length) { sessionList.innerHTML = '<div class="empty"><div class="empty-icon">&#128172;</div><div class="empty-h">No conversations yet</div><div class="empty-p">Start typing below to begin your first session</div></div>'; return; }
    sessionList.innerHTML = '';
    var VISIBLE_LIMIT = 4;
    var visibleCount = Math.min(list.length, VISIBLE_LIMIT);
    for (var i = 0; i < visibleCount; i++) {
      (function(s) {
        var d = document.createElement('div'); d.className = 'sitem'; d.dataset.sessionId = String(s.id || '');
        d.innerHTML = '<span class="sitem-title">' + esc(s.title || s.id) + '</span><div class="session-actions"><div class="session-meta"><span class="sitem-time">' + esc(relTime(s.updatedAt)) + '</span><span class="session-count">' + esc(String(s.messageCount || 0)) + ' msgs</span></div><button type="button" class="session-delete" title="Delete">&#128465;</button></div>';
        d.addEventListener('click', function() { if (s.id) vscode.postMessage({ type: 'openSession', payload: s.id }); });
        d.querySelector('.session-delete').addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); vscode.postMessage({ type: 'deleteSessionRequest', payload: s.id }); });
        sessionList.appendChild(d);
      })(list[i]);
    }
    if (list.length > VISIBLE_LIMIT) {
      var remaining = list.length - VISIBLE_LIMIT;
      var loadMore = document.createElement('button');
      loadMore.className = 'load-more-btn';
      loadMore.textContent = 'Load more (' + remaining + ')';
      loadMore.addEventListener('click', function() {
        loadMore.remove();
        for (var j = VISIBLE_LIMIT; j < list.length; j++) {
          (function(s) {
            var d = document.createElement('div'); d.className = 'sitem fadein'; d.dataset.sessionId = String(s.id || '');
            d.innerHTML = '<span class="sitem-title">' + esc(s.title || s.id) + '</span><div class="session-actions"><div class="session-meta"><span class="sitem-time">' + esc(relTime(s.updatedAt)) + '</span><span class="session-count">' + esc(String(s.messageCount || 0)) + ' msgs</span></div><button type="button" class="session-delete" title="Delete">&#128465;</button></div>';
            d.addEventListener('click', function() { if (s.id) vscode.postMessage({ type: 'openSession', payload: s.id }); });
            d.querySelector('.session-delete').addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); vscode.postMessage({ type: 'deleteSessionRequest', payload: s.id }); });
            sessionList.appendChild(d);
          })(list[j]);
        }
      });
      sessionList.appendChild(loadMore);
    }
  }

  function renderLoadedSession(session) {
    if (!session) return;
    pendingRequest = null;
    resetComposeState();
    resetDrawers();
    resetThinkingPanel();
    resetBannerBtns();
    if (editsBanner) editsBanner.classList.remove('on');
    if (bannerTxt) bannerTxt.textContent = 'Pending edits ready';
    attachedFiles = session.attachedFiles || [];
    renderAttachments(attachedFiles);
    if (Array.isArray(session.messages) && session.messages.length > 0) {
      chatHistory = session.messages.map(function(m) { return { id: m.id || makeMessageId(), role: m.role, text: m.content, ts: m.createdAt }; });
    } else {
      chatHistory = [{ id: makeMessageId(), role: 'user', text: session.objective || session.title || 'Session', ts: session.updatedAt || Date.now() }];
      if (session.lastResult) chatHistory.push({ id: makeMessageId(), role: 'assistant', text: session.lastResult, ts: session.updatedAt || Date.now() });
    }
    renderMessages(); showChat();
  }

  function handleSessionDeleted(payload) {
    if (payload && payload.wasActive) { chatHistory = []; attachedFiles = []; resetComposeState(); resetDrawers(); resetThinkingPanel(); resetBannerBtns(); if (editsBanner) editsBanner.classList.remove('on'); if (bannerTxt) bannerTxt.textContent = 'Pending edits ready'; renderAttachments(attachedFiles); renderMessages(); showHome(); }
  }

  // Render summary
  function renderSummary(s) {
    summary = s;
    var ok = s && (Boolean(s.ollamaReachable) || s.status === 'ready');
    statusBadge.className = 'badge ' + (ok ? 'on' : 'off');
    statusTxt.textContent = ok ? 'Online' : 'Offline';
    renderConversationMode((s && s.conversationMode) || 'agent');
    if (s && s.permissionMode) updatePermUI(s.permissionMode);
    if (s && s.persona && personaSelect) personaSelect.value = s.persona;
    if (s && typeof s.selfLearnEnabled === 'boolean' && selfLearnToggle) selfLearnToggle.checked = s.selfLearnEnabled;
    var model = (s && s.plannerModel) || '';
    activeModelName = model;
    chipModel.textContent = model.split(':')[0].slice(0, 14) || '\u2013';
    chipModel.title = model || 'none';
    var hasPending = s && s.hasPendingEdits;
    editsBanner.classList.toggle('on', Boolean(hasPending));
    if (hasPending) {
      var eCount = s && typeof s.pendingEditCount === 'number' ? s.pendingEditCount : 0;
      bannerTxt.textContent = eCount > 0 ? eCount + ' file' + (eCount === 1 ? '' : 's') + ' changed \u2014 review before approving' : 'Pending file edits \u2014 review before approving';
    }
    if (learningBadge) {
      var learningPct = s && typeof s.learningProgressPercent === 'number' ? s.learningProgressPercent : 0;
      learningBadge.textContent = 'Learning ' + Math.max(0, Math.min(100, Math.round(learningPct))) + '%';
      learningBadge.title = 'Self-improvement progress from recent tasks';
      learningBadge.style.display = learningPct > 0 ? '' : 'none';
    }
    if (s && typeof s.tokenUsagePercent === 'number') updateTokenRing(s.tokenUsagePercent);
    if (s && s.activeSessionId && !inChat && !autoRestoreSessionAttempted) {
      autoRestoreSessionAttempted = true;
      vscode.postMessage({ type: 'openSession', payload: s.activeSessionId });
    }
  }

  // Token ring
  function updateTokenRing(pct) {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    var ring = D('tokenRing'), arc = D('tokenRingArc'), label = D('tokenRingPct');
    if (ring) ring.classList.toggle('visible', pct > 0);
    if (arc) arc.setAttribute('stroke-dasharray', pct + ' ' + (100 - pct));
    if (label) label.textContent = pct + '%';
  }

  function updateModels(list) {
    models = list || [];
    var prev = modelSelect.value;
    modelSelect.innerHTML = '';
    if (!models.length) { modelSelect.innerHTML = '<option value="">No models found</option>'; return; }
    for (var i = 0; i < models.length; i++) {
      var model = models[i];
      var o = document.createElement('option');
      o.value = model.name;
      o.text = describeModelOption(model);
      o.title = describeModelTooltip(model);
      modelSelect.appendChild(o);
    }
    if (models.some(function(m) { return m.name === prev; })) modelSelect.value = prev;
  }

  function describeModelOption(model) {
    if (!model || !model.name) return '';
    var labels = ['Ready', sourceLabelForModel(model)];
    if (model.supportsVision) labels.push('Vision');
    return model.name + ' — ' + labels.join(' · ');
  }

  // Send task
  var sendArrowSvg = '<svg class="send-arrow" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';

  function setBusyMode(busy) {
    isBusy = busy;
    if (busy) {
      btnSend.disabled = false;
      btnSend.classList.add('stop');
      btnSend.title = 'Stop';
      btnSend.innerHTML = '&#9632;';
    } else {
      btnSend.classList.remove('stop');
      btnSend.title = composeState.mode === 'edit' ? 'Save & Send' : composeState.mode === 'retry' ? 'Retry' : 'Send (Enter)';
      btnSend.innerHTML = sendArrowSvg;
      btnSend.disabled = taskInput ? taskInput.value.trim().length === 0 : true;
    }
  }

  function sendTask() {
    if (isBusy) {
      vscode.postMessage({ type: 'cancelTask' });
      setBusyMode(false);
      finishThinking();
      return;
    }
    var text = taskInput.value.trim();
    if (!text) return;
    var action = composeState.mode || 'new';
    var messageId = composeState.messageId || '';
    var messageIndex = composeState.messageIndex;

    if (action === 'edit' && messageId) {
      if (messageIndex < 0 || !chatHistory[messageIndex] || String(chatHistory[messageIndex].id || '') !== messageId) {
        messageIndex = -1;
        for (var j = chatHistory.length - 1; j >= 0; j--) {
          if (String(chatHistory[j].id || '') === messageId) { messageIndex = j; break; }
        }
      }
      if (messageIndex >= 0) {
        chatHistory[messageIndex].text = text;
        chatHistory[messageIndex].content = text;
        chatHistory = chatHistory.slice(0, messageIndex + 1);
      }
      renderMessages();
    }

    taskInput.value = ''; taskInput.style.height = 'auto';
    setBusyMode(true);
    pendingRequest = { action: action, messageId: messageId };
    if (action === 'new') {
      chatHistory.push({ id: makeMessageId(), role: 'user', text: text, ts: Date.now() });
      renderMessages();
    }
    showChat(); startThinking(); resetDrawers(); scrollBottom();
    vscode.postMessage({ type: 'runTask', payload: { objective: text, action: action, messageId: messageId } });
    // Clear image previews after sending
    if (attachmentRow) {
      var imgPreviews = attachmentRow.querySelectorAll('.img-preview');
      for (var ip = 0; ip < imgPreviews.length; ip++) imgPreviews[ip].parentNode.removeChild(imgPreviews[ip]);
    }
    resetComposeState();
  }

  // Event listeners
  on(taskInput, 'input', function() { autoGrow(taskInput); if (!isBusy) btnSend.disabled = taskInput.value.trim().length === 0; });
  on(taskInput, 'keydown', function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTask(); } });
  on(btnSend, 'click', sendTask);

  // Scroll-to-bottom button
  (function() {
    var mainEl = D('main');
    if (mainEl) mainEl.addEventListener('scroll', function() {
      updateScrollButton();
    });
    on(scrollBtn, 'click', scrollBottom);
  }());

  // Code-copy event delegation (persistent)
  on(messages, 'click', function(e) {
    var btn = e.target;
    if (!btn || !btn.classList || !btn.classList.contains('code-copy')) return;
    e.stopPropagation();
    var header = btn.parentNode;
    var block = header && header.nextElementSibling;
    if (block && block.tagName === 'PRE') {
      navigator.clipboard.writeText(block.textContent || '').then(function() {
        var prev = btn.textContent;
        btn.textContent = '\u2713 Copied';
        setTimeout(function() { btn.textContent = prev; }, 1500);
      });
    }
  });

  // Self-learn toggle
  on(selfLearnToggle, 'change', function() { vscode.postMessage({ type: 'setSelfLearn', payload: selfLearnToggle.checked }); });

  // ── Drag-and-drop file attach ─────────────────────────────────
  (function() {
    var dropOverlay = D('dropOverlay');
    if (!dropOverlay) return;
    var dragCounter = 0;
    document.addEventListener('dragenter', function(e) {
      e.preventDefault();
      dragCounter++;
      if (dragCounter === 1) dropOverlay.classList.add('active');
    });
    document.addEventListener('dragleave', function(e) {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active'); }
    });
    document.addEventListener('dragover', function(e) { e.preventDefault(); });
    document.addEventListener('drop', function(e) {
      e.preventDefault();
      dragCounter = 0;
      dropOverlay.classList.remove('active');
      var items = e.dataTransfer && e.dataTransfer.items;
      if (!items || !items.length) return;
      var paths = [];
      var imageFiles = [];
      var uriList = (e.dataTransfer && e.dataTransfer.getData('text/uri-list')) || '';
      if (uriList && uriList.trim()) {
        uriList.split(/\\r?\\n/).forEach(function(line) {
          var value = line.trim();
          if (value && value.charAt(0) !== '#') paths.push(value);
        });
      }
      var plainText = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
      if (plainText && plainText.trim()) {
        plainText.split(/\\r?\\n/).forEach(function(line) {
          var value = line.trim();
          if (value && value.indexOf('file:') === 0) paths.push(value);
        });
      }
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.kind === 'file') {
          var file = item.getAsFile();
          if (file && file.name) {
            var ext = (file.name.split('.').pop() || '').toLowerCase();
            var isImage = ['png','jpg','jpeg','gif','webp','bmp','svg'].indexOf(ext) !== -1;
            if (isImage && file.size < 10 * 1024 * 1024) {
              // Read image as base64 for vision model support
              imageFiles.push(file);
            } else {
              paths.push((file && file.path) ? file.path : file.name);
            }
          }
        } else if (item.kind === 'string' && (item.type === 'text/plain' || item.type === 'text/uri-list')) {
          item.getAsString(function(s) {
            if (s && s.trim()) {
              s.split(/\\r?\\n/).forEach(function(line) {
                var value = line.trim();
                if (value && value.charAt(0) !== '#') {
                  vscode.postMessage({ type: 'dropFiles', payload: [value] });
                }
              });
            }
          });
        }
      }
      if (paths.length > 0) vscode.postMessage({ type: 'dropFiles', payload: paths });
      // Read and preview image files
      imageFiles.forEach(function(imgFile) {
        var reader = new FileReader();
        reader.onload = function(ev) {
          var dataUrl = ev.target && ev.target.result;
          if (typeof dataUrl === 'string') {
            // Show preview in attachment row
            addImagePreview(imgFile.name, dataUrl);
            // Send to backend
            vscode.postMessage({ type: 'dropImage', payload: { name: imgFile.name, dataUrl: dataUrl } });
          }
        };
        reader.readAsDataURL(imgFile);
      });
    });
  }());

  // ── Tool configuration panel ──────────────────────────────────
  var TOOL_DEFS = [
    { id: 'workspace_scan', name: 'Workspace Scan', desc: 'Discover project files and structure' },
    { id: 'read_files', name: 'Read Files', desc: 'Read source file contents for context' },
    { id: 'create_file', name: 'Create File', desc: 'Create new files in the workspace' },
    { id: 'delete_file', name: 'Delete File', desc: 'Remove files from the workspace' },
    { id: 'search_files', name: 'Search Files', desc: 'Regex search across workspace files' },
    { id: 'list_dir', name: 'List Directory', desc: 'List contents of a directory' },
    { id: 'run_terminal', name: 'Terminal', desc: 'Run shell commands (build, test, install)' },
    { id: 'run_verification', name: 'Verification', desc: 'Run diagnostics and linting checks' },
    { id: 'web_search', name: 'Web Search', desc: 'Search the internet for documentation' },
    { id: 'git_diff', name: 'Git Diff', desc: 'View source control changes' },
    { id: 'mcp_status', name: 'MCP Status', desc: 'Check MCP server health' },
    { id: 'diagnostics', name: 'Diagnostics', desc: 'Retrieve active editor diagnostics' },
    { id: 'batch_edit', name: 'Batch Edit', desc: 'Apply targeted changes to multiple files at once' },
    { id: 'rename_file', name: 'Rename/Move', desc: 'Rename or move files in the workspace' },
    { id: 'find_references', name: 'Find References', desc: 'Find all usages of a symbol across the workspace' },
    { id: 'file_search', name: 'File Search', desc: 'Find files by name or glob pattern' },
    { id: 'get_problems', name: 'Problems', desc: 'Get VS Code diagnostics and errors' },
    { id: 'get_terminal_output', name: 'Terminal Output', desc: 'Get the last terminal command output' }
  ];
  var enabledTools = {};
  TOOL_DEFS.forEach(function(t) { enabledTools[t.id] = true; });

  function renderToolConfig() {
    var list = D('toolConfigList');
    if (!list) return;
    list.innerHTML = TOOL_DEFS.map(function(t) {
      var checked = enabledTools[t.id] !== false ? ' checked' : '';
      return '<div class="tool-config-item"><label><input type="checkbox" data-tool="' + esc(t.id) + '"' + checked + ' />' + esc(t.name) + '</label></div><div class="tool-config-desc">' + esc(t.desc) + '</div>';
    }).join('');
    list.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
      cb.addEventListener('change', function() {
        enabledTools[cb.dataset.tool] = cb.checked;
        vscode.postMessage({ type: 'setEnabledTools', payload: enabledTools });
      });
    });
  }
  renderToolConfig();
  on(D('btnToolsAll'), 'click', function() { TOOL_DEFS.forEach(function(t) { enabledTools[t.id] = true; }); renderToolConfig(); vscode.postMessage({ type: 'setEnabledTools', payload: enabledTools }); });
  on(D('btnToolsNone'), 'click', function() { TOOL_DEFS.forEach(function(t) { enabledTools[t.id] = false; }); renderToolConfig(); vscode.postMessage({ type: 'setEnabledTools', payload: enabledTools }); });

  on(btnNewChat, 'click', function() { autoRestoreSessionAttempted = true; chatHistory = []; attachedFiles = []; pendingRequest = null; resetComposeState(); resetDrawers(); resetThinkingPanel(); resetBannerBtns(); if (editsBanner) editsBanner.classList.remove('on'); if (bannerTxt) bannerTxt.textContent = 'Pending edits ready'; renderAttachments(attachedFiles); renderMessages(); showChat(); vscode.postMessage({ type: 'newConversation' }); taskInput.focus(); });
  on(btnBack, 'click', showHome);
  on(btnAttach, 'click', function() { vscode.postMessage({ type: 'attachContext' }); });
  on(btnSettings, 'click', function() { settingsDrawer.classList.toggle('open'); });
  on(btnRefresh, 'click', function() { vscode.postMessage({ type: 'ping' }); });

  on(chipMode, 'click', function(e) { e.stopPropagation(); modePopupOpen ? closeModePopup() : openModePopup(); });
  (function() { var p = D('modePopup'); if (!p) return; p.querySelectorAll('.popup-opt').forEach(function(btn) { btn.addEventListener('click', function(e) { e.stopPropagation(); var m = btn.dataset.mode; if (m && m !== conversationMode) vscode.postMessage({ type: 'setConversationMode', payload: m }); closeModePopup(); }); }); }());
  on(chipModel, 'click', function(e) { e.stopPropagation(); modelPopupOpen ? closeModelPopup() : openModelPopup(); });

  // Permission bar
  on(permBtn, 'click', function(e) { e.stopPropagation(); permPopupOpen ? closePermPopup() : openPermPopup(); });
  (function() { var p = D('permPopup'); if (!p) return; p.querySelectorAll('.perm-opt').forEach(function(btn) { btn.addEventListener('click', function(e) { e.stopPropagation(); var m = btn.dataset.perm; if (m) { vscode.postMessage({ type: 'setPermissionMode', payload: m }); updatePermUI(m); } closePermPopup(); }); }); }());

  on(btnSyncModels, 'click', function() { vscode.postMessage({ type: 'refreshModels' }); });
  on(btnApplyModel, 'click', function() { var m = modelSelect.value; if (m) { vscode.postMessage({ type: 'setModel', payload: { role: 'planner', model: m } }); vscode.postMessage({ type: 'setModel', payload: { role: 'editor', model: m } }); vscode.postMessage({ type: 'setModel', payload: { role: 'fast', model: m } }); } });
  on(personaSelect, 'change', function() { vscode.postMessage({ type: 'setPersona', payload: personaSelect.value }); });
  on(btnAddMcp, 'click', function() { mcpServers = snapshotMcpServers().concat([normalizeMcpServer({ enabled: true, trust: 'workspace', transport: 'stdio', args: [] })]); renderMcpServers(mcpServers); });
  on(btnReloadMcp, 'click', function() { vscode.postMessage({ type: 'reloadMcpServers' }); });
  on(btnOpenMcpSettings, 'click', function() { vscode.postMessage({ type: 'configureMcpServers' }); });
  on(btnManageMcp, 'click', function() { vscode.postMessage({ type: 'manageMcpConnections' }); });
  on(btnSaveMcp, 'click', function() { try { vscode.postMessage({ type: 'saveMcpServers', payload: collectMcpServers() }); } catch(e) {} });

  // Edits banner
  function resetBannerBtns() { btnApply.textContent = 'Approve'; btnApply.className = 'btn primary sm'; btnRevert.textContent = 'Reject'; btnRevert.className = 'btn danger sm'; }
  on(btnApply, 'click', function() { resetBannerBtns(); vscode.postMessage({ type: 'applyPending', payload: true }); });
  on(btnRevert, 'click', function() { resetBannerBtns(); vscode.postMessage({ type: 'revertLast', payload: true }); });

  // Message handler
  window.addEventListener('message', function(event) {
    var data = event.data || {}, type = data.type, payload = data.payload;
    if (type === 'runtimeSummary') { renderSummary(payload); return; }
    if (type === 'models') { updateModels(payload); return; }
    if (type === 'mcpServers') { renderMcpServers(payload); return; }
    if (type === 'sessions') { renderSessions(payload); return; }
    if (type === 'sessionLoaded') { renderLoadedSession(payload); return; }
    if (type === 'sessionDeleted') { handleSessionDeleted(payload); return; }
    if (type === 'sessionAttachments') { renderAttachments(payload); return; }
    if (type === 'thinkingStep') { addThinkingStep(payload); return; }
    if (type === 'terminalOutput') {
      // Render terminal output as an expandable block in chat
      if (payload && typeof payload.command === 'string') {
        var termId = makeMessageId();
        var exitOk = payload.exitCode === 0;
        var termHtml = '<div class="terminal-chat-block' + (exitOk ? '' : ' terminal-error') + '">' +
          '<div class="terminal-chat-header" data-termid="' + esc(termId) + '">' +
          '<span class="terminal-chat-icon">&#9654;</span>' +
          '<span class="terminal-chat-cmd">$ ' + esc(payload.command) + '</span>' +
          '<span class="terminal-chat-status">' + (exitOk ? '\\u2713' : '\\u2717 exit ' + (payload.exitCode != null ? payload.exitCode : '?')) + '</span>' +
          '<span class="terminal-chat-toggle">\\u25BC</span>' +
          '</div>' +
          '<pre class="terminal-chat-output hidden">' + esc(payload.output || '(no output)') + '</pre>' +
          '</div>';
        chatHistory.push({ id: termId, role: 'terminal', text: termHtml, ts: Date.now(), isHtml: true });
        renderMessages(); scrollBottom();
      }
      return;
    }
    if (type === 'streamChunk') {
      if (!isBusy) return;
      streamBuffer += (payload || '');
      if (!streamBubble) {
        // Create streaming bubble with placeholder skeleton
        streamBubble = document.createElement('div');
        streamBubble.className = 'msg agent fadein streaming-active';
        streamBubble.innerHTML = '<div class="bubble stream-bubble">' +
          '<div class="stream-placeholder">' +
          '<div class="stream-placeholder-line"></div>' +
          '<div class="stream-placeholder-line"></div>' +
          '<div class="stream-placeholder-line"></div>' +
          '</div>' +
          '<span class="stream-text" style="display:none"></span>' +
          '<span class="stream-cursor" style="display:none"></span></div>';
        messages.appendChild(streamBubble);
        streamRenderBuffer = '';
      }
      // Queue chunk for smooth rendering
      streamChunkQueue.push(payload || '');
      if (!streamFlushTimer) {
        streamFlushTimer = setInterval(function() {
          if (streamChunkQueue.length === 0) {
            clearInterval(streamFlushTimer);
            streamFlushTimer = null;
            return;
          }
          // Flush queued chunks with slight smoothing
          var chunk = streamChunkQueue.shift();
          streamRenderBuffer += chunk;
          if (streamBubble) {
            // Remove placeholder once text starts flowing
            var ph = streamBubble.querySelector('.stream-placeholder');
            if (ph) ph.parentNode.removeChild(ph);
            var textEl = streamBubble.querySelector('.stream-text');
            var cursor = streamBubble.querySelector('.stream-cursor');
            if (textEl) { textEl.style.display = 'inline'; textEl.innerHTML = renderMarkdown(streamRenderBuffer); }
            if (cursor) cursor.style.display = 'inline-block';
          }
          scrollBottom();
        }, 18); // ~18ms between renders for premium smoothness
      }
      return;
    }
    if (type === 'taskResult') {
      var isCancelled = payload && payload.cancelled;
      // Flush remaining chunks immediately
      if (streamFlushTimer) { clearInterval(streamFlushTimer); streamFlushTimer = null; }
      streamChunkQueue = [];
      streamRenderBuffer = '';
      // Remove temporary streaming bubble
      if (streamBubble && streamBubble.parentNode) {
        streamBubble.parentNode.removeChild(streamBubble);
      }
      streamBubble = null;
      streamBuffer = '';
      finishThinking(isCancelled);
      if (!isCancelled) {
        // Update drawers with final state
        if (payload && payload.todos && payload.todos.length) renderTodoDrawer(payload.todos);
        if (payload && payload.fileDiffs && payload.fileDiffs.length) renderFilesDrawer(payload.fileDiffs);

        var text = (payload && payload.responseText) || 'Task completed.';
        // Clean response: strip raw JSON wrappers that models sometimes emit
        // Handle single JSON object or multiple concatenated JSON objects
        if (text && (text.charAt(0) === '{' || text.charAt(0) === '[')) {
          try {
            var parsed = JSON.parse(text);
            if (parsed && typeof parsed.response === 'string' && parsed.response.length > 0) { text = parsed.response; }
            else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              if (parsed.summary) text = String(parsed.summary);
              else if (parsed.text) text = String(parsed.text);
            }
          } catch(e) {
            // May be multiple concatenated JSON objects — extract .response from each
            var jsonParts = text.match(/\\{[^{}]*(?:\\{[^{}]*\\}[^{}]*)*\\}/g);
            if (jsonParts && jsonParts.length > 0) {
              var extracted = [];
              for (var jp = 0; jp < jsonParts.length; jp++) {
                try {
                  var p = JSON.parse(jsonParts[jp]);
                  if (p && typeof p.response === 'string' && p.response.length > 0) extracted.push(p.response);
                } catch(e2) {}
              }
              if (extracted.length > 0) text = extracted[extracted.length - 1];
            }
          }
        }
        // Strip markdown sections that duplicate drawer data
        text = text.replace(/##\\s*(TODOs?|Tasks?|What I found|What changed|Verification|Changes made|Files? changed)[\\s\\S]*?(?=\\n##|$)/gi, '');
        // Strip <break> tags
        text = text.replace(/<break\\s*\\/?>/gi, '\\n').replace(/<\\/break>/gi, '\\n');
        // Remove leading/trailing whitespace artifacts
        text = text.trim();
        // If text became empty after cleanup, use fallback
        if (!text) text = 'Task completed.';
        if (payload && payload.autoApplied && payload.proposedEdits > 0) {
          text += '\\n\\n\\u2705 **' + payload.proposedEdits + ' edit(s) auto-applied** (bypass mode active)';
        }
        // Update banner text with actual file count when pending edits exist
        if (payload && payload.proposedEdits > 0 && !payload.autoApplied) {
          var fc = payload.proposedEdits;
          bannerTxt.textContent = fc + ' file' + (fc === 1 ? '' : 's') + ' changed \u2014 review before applying';
        }
        var diffData = (payload && payload.fileDiffs && payload.fileDiffs.length > 0) ? payload.fileDiffs : null;
        var wasAutoApplied = Boolean(payload && payload.autoApplied);
        var shouldReplaceAgent = pendingRequest && pendingRequest.action === 'retry' && pendingRequest.messageId;
        if (shouldReplaceAgent) {
          var replaced = false;
          for (var k = chatHistory.length - 1; k >= 0; k--) {
            if (String(chatHistory[k].id || '') === String(pendingRequest.messageId)) {
              chatHistory[k].text = text;
              chatHistory[k].content = text;
              chatHistory[k].ts = Date.now();
              chatHistory[k].role = 'assistant';
              chatHistory[k].fileDiffs = diffData;
              chatHistory[k].autoApplied = wasAutoApplied;
              replaced = true;
              break;
            }
          }
          if (!replaced) {
            chatHistory.push({ id: makeMessageId(), role: 'agent', text: text, ts: Date.now(), fileDiffs: diffData, autoApplied: wasAutoApplied });
          }
        } else {
          chatHistory.push({ id: makeMessageId(), role: 'agent', text: text, ts: Date.now(), fileDiffs: diffData, autoApplied: wasAutoApplied });
        }
        renderMessages(); scrollBottom();
      }
      pendingRequest = null;
      vscode.postMessage({ type: 'ping' });
      return;
    }
    if (type === 'actionResult') {
      finishThinking(false);
      var txt = String(payload || '');
      if (txt && txt.indexOf('Approval mode set') !== 0 && txt.indexOf('Permission mode set') !== 0 && txt.indexOf('Updated ') !== 0 && txt.indexOf('Mode set to') !== 0 && txt.indexOf('MCP servers updated') !== 0) {
        chatHistory.push({ id: makeMessageId(), role: 'agent', text: txt, ts: Date.now() });
        renderMessages(); scrollBottom();
      }
      pendingRequest = null;
      vscode.postMessage({ type: 'ping' });
      return;
    }
  });

  // Bootstrap
  if (initialSummary) renderSummary(initialSummary);
  window.addEventListener('error', function(e) { surfaceFatalError(e && e.error ? String(e.error.stack || e.error.message || e.error) : String(e.message || 'Unknown error')); });
  window.addEventListener('unhandledrejection', function(e) { surfaceFatalError(String(e && e.reason ? (e.reason.stack || e.reason.message || e.reason) : 'Unhandled rejection')); });
  vscode.postMessage({ type: 'webviewReady' });
  vscode.postMessage({ type: 'loadDashboard' });
  setTimeout(function() { if (!summary) vscode.postMessage({ type: 'ping' }); }, 800);
  setTimeout(function() { if (!summary) vscode.postMessage({ type: 'ping' }); }, 3000);
  setInterval(function() { vscode.postMessage({ type: 'ping' }); }, 30000);

  // Auto-focus the textarea when the webview gains focus (fixes VS Code sidebar focus)
  window.addEventListener('focus', function() {
    if (taskInput && !isBusy) { setTimeout(function() { taskInput.focus(); }, 0); }
  });
  // Give initial focus so user can type immediately
  setTimeout(function() { if (taskInput) taskInput.focus(); }, 200);

  } catch (error) {
    surfaceFatalError(error instanceof Error ? error.stack || error.message : String(error));
  }
}());
</script>
</body>
</html>`;
  }
}
