import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";

import type { AgentRuntime } from "../agent/runtime/AgentRuntime";
import type { RuntimeSummary } from "../agent/runtime/AgentRuntime";
import type { Logger } from "../platform/vscode/Logger";

export class PulseSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "pulse.sidebar";

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
    const pushState = async (): Promise<void> => {
      // Refresh Ollama health — errors here are non-fatal
      try {
        await this.runtime.refreshProviderState();
      } catch (err) {
        this.logger.warn(
          `refreshProviderState failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Always post runtimeSummary — even a degraded one — so the badge updates
      let summary;
      try {
        summary = await this.runtime.summary();
      } catch (err) {
        this.logger.warn(
          `runtime.summary() failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        summary = {
          status: "degraded" as const,
          ollamaReachable: false,
          conversationMode: "agent" as const,
          plannerModel: "unknown",
          editorModel: "unknown",
          fastModel: "unknown",
          embeddingModel: "unknown",
          approvalMode: "balanced" as const,
          permissionMode: "default" as const,
          storagePath: "",
          ollamaHealth: `Error: ${err instanceof Error ? err.message : String(err)}`,
          modelCount: 0,
          activeSessionId: null,
          hasPendingEdits: false,
          tokenBudget: 32000,
          tokensConsumed: 0,
          tokenUsagePercent: 0,
          mcpConfigured: 0,
          mcpHealthy: 0,
        };
      }
      void webviewView.webview.postMessage({
        type: "runtimeSummary",
        payload: summary,
      });

      // Secondary data — each isolated so one failure can't block the rest
      const sessions = await this.runtime.listRecentSessions().catch(() => []);
      void webviewView.webview.postMessage({
        type: "sessions",
        payload: sessions,
      });
      void webviewView.webview.postMessage({
        type: "mcpServers",
        payload: this.runtime.getConfiguredMcpServers(),
      });
      if (summary?.ollamaReachable) {
        const models = await this.runtime.listAvailableModels().catch(() => []);
        void webviewView.webview.postMessage({
          type: "models",
          payload: models,
        });
      }
    };

    // Forward agent progress steps to the webview as they arrive
    this.runtime.setProgressCallback((step) => {
      void webviewView.webview.postMessage({
        type: "thinkingStep",
        payload: step,
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
            await this.runtime.refreshProviderState();
            const models = await this.runtime.listAvailableModels();
            await webviewView.webview.postMessage({
              type: "models",
              payload: models,
            });
            return;
          }

          if (
            message.type === "runTask" &&
            typeof message.payload === "string"
          ) {
            const result = await this.runtime.runTask(message.payload);
            await webviewView.webview.postMessage({
              type: "taskResult",
              payload: {
                responseText: result.responseText,
                sessionId: result.sessionId,
                proposedEdits: result.proposal?.edits.length ?? 0,
              },
            });

            const sessions = await this.runtime.listRecentSessions();
            await webviewView.webview.postMessage({
              type: "sessions",
              payload: sessions,
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
                label: "$(search) Search workspace files\u2026",
                description: "Filter and pick from workspace",
                value: "search",
              });
              choices.push({
                label: "$(folder) Attach entire workspace",
                description: path.basename(workspaceFolder.fsPath),
                value: "workspace-root",
              });
            }
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
            } else if (pickedMode.value === "search" && workspaceFolder) {
              const files = await vscode.workspace.findFiles(
                "**/*.{ts,js,tsx,jsx,mts,mjs,py,go,rs,java,cs,cpp,c,h,md,json,yaml,yml,toml,sh,sql,env,txt,css,html,svelte,vue}",
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
            } else {
              const picked = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: true,
                canSelectMany: true,
                defaultUri: workspaceFolder ?? undefined,
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
            await webviewView.webview.postMessage({
              type: "actionResult",
              payload: "Started a new conversation.",
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
    const initialSummaryJson = JSON.stringify(initialSummary ?? null).replace(
      /</g,
      "\\u003c",
    );
    const initialStatusText = initialOnline ? "Online" : "Offline";
    const initialStatusClass = initialOnline ? "on" : "off";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --amber: #f59e0b; --amber-bg: rgba(245,158,11,0.10); --amber-bdr: rgba(245,158,11,0.28);
      --amber-glow: rgba(245,158,11,0.14);
      --green: #22c55e; --green-bg: rgba(34,197,94,0.08); --green-bdr: rgba(34,197,94,0.24);
      --red: var(--vscode-errorForeground, #f87171); --red-bg: rgba(248,113,113,0.06); --red-bdr: rgba(248,113,113,0.24);
      --border: var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.15));
      --bg2: var(--vscode-input-background, rgba(128,128,128,.08));
      --fg: var(--vscode-foreground); --fg2: var(--vscode-descriptionForeground);
      --r: 10px; --spd: 140ms;
    }
    html, body { height: 100%; font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 13px; color: var(--fg); background: var(--vscode-sideBar-background); overflow: hidden; }
    #root { display: flex; flex-direction: column; height: 100%; }
    button { font-family: inherit; }

    /* ── Header ─── */
    .hdr { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .hdr-right { display: flex; align-items: center; gap: 4px; }
    .badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 1px solid; }
    .badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .badge.on { color: var(--green); border-color: var(--green-bdr); background: var(--green-bg); }
    .badge.off { color: var(--red); border-color: var(--red-bdr); background: var(--red-bg); }
    .icon-btn { width: 24px; height: 24px; border: none; background: transparent; color: var(--fg); opacity: .45; cursor: pointer; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 14px; transition: opacity var(--spd), background var(--spd); }
    .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.12)); }

    #fatalBanner { display: none; margin: 8px 12px 0; padding: 8px 10px; border-radius: var(--r); border: 1px solid var(--red-bdr); background: var(--red-bg); font-size: 12px; line-height: 1.4; white-space: pre-wrap; }
    #fatalBanner.on { display: block; }

    /* ── Settings drawer ─── */
    #settingsDrawer { display: none; flex-direction: column; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; max-height: 60vh; overflow-y: auto; }
    #settingsDrawer.open { display: flex; }
    .srow { display: grid; grid-template-columns: 68px 1fr; align-items: center; gap: 8px; }
    .slabel { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--fg2); }
    input[type="text"], select, textarea { width: 100%; padding: 5px 7px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg2); color: var(--vscode-input-foreground); font: 12px var(--vscode-font-family); }
    select { cursor: pointer; }
    textarea { resize: vertical; min-height: 38px; }
    .sbtns { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }
    .section { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .section-copy { color: var(--fg2); font-size: 11px; line-height: 1.4; }
    .mcp-toolbar { display: flex; flex-wrap: wrap; gap: 6px; }
    .mcp-count { margin-left: auto; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--fg2); }
    .mcp-list { display: flex; flex-direction: column; gap: 8px; max-height: 200px; overflow: auto; }
    .mcp-card { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: var(--r); border: 1px solid var(--border); background: rgba(128,128,128,.03); }
    .mcp-card-head { display: flex; align-items: center; gap: 8px; }
    .mcp-card-title { flex: 1; min-width: 0; }
    .mcp-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border); font-size: 10px; font-weight: 700; color: var(--fg2); text-transform: uppercase; letter-spacing: .4px; }
    .mcp-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
    .mcp-note { font-size: 10px; color: var(--fg2); line-height: 1.3; }
    .mcp-empty { padding: 10px; border-radius: var(--r); border: 1px dashed var(--border); color: var(--fg2); font-size: 11px; text-align: center; }

    /* ── Main scroll area ─── */
    #main { flex: 1; overflow-y: auto; overflow-x: hidden; scroll-behavior: smooth; }
    #homeView { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    #homeView.hidden, #chatView.hidden { display: none; }

    .sec-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; color: var(--fg2); padding: 0 2px; }
    .sessions { border-top: 1px solid var(--border); }
    .sitem { display: flex; align-items: center; justify-content: space-between; padding: 8px 6px; cursor: pointer; border-bottom: 1px solid var(--border); border-radius: 6px; gap: 8px; transition: background var(--spd); }
    .sitem:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.07)); }
    .sitem-title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
    .sitem-time { font-size: 11px; color: var(--fg2); flex-shrink: 0; }
    .session-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .session-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
    .session-count { font-size: 10px; color: var(--fg2); }
    .session-delete { width: 22px; height: 22px; border: 1px solid transparent; border-radius: 999px; background: transparent; color: var(--fg2); cursor: pointer; opacity: .6; transition: all var(--spd); font-size: 12px; }
    .session-delete:hover { opacity: 1; color: var(--red); border-color: var(--red-bdr); background: var(--red-bg); }

    /* ── Chat view ─── */
    #chatView { padding: 8px 12px 4px; display: flex; flex-direction: column; gap: 8px; }
    .back-btn { display: inline-flex; align-items: center; gap: 4px; border: none; background: none; color: var(--amber); font: 600 11px var(--vscode-font-family); cursor: pointer; opacity: .8; padding: 0; width: fit-content; }
    .back-btn:hover { opacity: 1; }

    /* ── Messages ─── */
    #messages { display: flex; flex-direction: column; gap: 8px; }
    .msg { max-width: 92%; position: relative; }
    .msg.user { align-self: flex-end; }
    .msg.agent { align-self: flex-start; width: 100%; }
    .bubble { padding: 8px 12px; border-radius: var(--r); line-height: 1.5; font-size: 13px; word-break: break-word; user-select: text; -webkit-user-select: text; position: relative; }
    .msg.user .bubble { background: var(--amber); color: #fff; border-bottom-right-radius: 3px; }
    .msg.agent .bubble { background: var(--bg2); border: 1px solid var(--border); border-bottom-left-radius: 3px; }
    .bubble code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; background: rgba(0,0,0,.15); padding: 1px 4px; border-radius: 3px; }
    .bubble pre { font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; line-height: 1.45; background: rgba(0,0,0,.18); border-radius: 6px; padding: 8px 10px; margin: 6px 0; overflow-x: auto; white-space: pre-wrap; position: relative; }
    .bubble pre code { background: none; padding: 0; }
    .bubble h1, .bubble h2, .bubble h3 { margin: 8px 0 4px; font-size: 13px; font-weight: 700; }
    .bubble ul, .bubble ol { margin: 4px 0; padding-left: 18px; }
    .bubble p { margin: 4px 0; }
    .msg-footer { display: flex; align-items: center; justify-content: space-between; gap: 4px; margin-top: 2px; padding: 0 2px; }
    .msg.user .msg-footer { justify-content: flex-end; }
    .msg-time { font-size: 10px; color: var(--fg2); }
    .copy-btn { border: none; background: transparent; color: var(--fg2); cursor: pointer; font-size: 11px; opacity: 0; transition: opacity var(--spd); padding: 1px 4px; border-radius: 4px; }
    .copy-btn:hover { opacity: 1 !important; background: rgba(128,128,128,.12); }
    .msg:hover .copy-btn { opacity: .6; }

    /* ── Thinking panel ─── */
    .thinking-panel { align-self: flex-start; width: 100%; overflow: hidden; font-size: 12px; }
    .thinking-panel.hidden { display: none; }
    .thinking-header { display: flex; align-items: center; gap: 6px; padding: 4px 2px; cursor: pointer; user-select: none; }
    .thinking-spinner { width: 13px; height: 13px; flex-shrink: 0; position: relative; }
    .thinking-spinner::before { content: ''; position: absolute; inset: 0; border-radius: 50%; border: 2px solid rgba(128,128,128,.15); border-top-color: var(--fg); animation: spin 700ms linear infinite; }
    .thinking-panel.done .thinking-spinner::before { animation: none; border-color: transparent; }
    .thinking-panel.done .thinking-spinner::after { content: '\\2713'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: var(--green); }
    @keyframes spin { to { transform: rotate(360deg); } }
    #thinkingTitle { flex: 1; font-size: 11px; font-weight: 500; color: var(--fg2); }
    .thinking-panel:not(.done) #thinkingTitle { color: var(--fg); }
    .thinking-chevron { font-size: 10px; color: var(--fg2); opacity: .5; transition: transform 120ms ease; }
    .thinking-chevron.expanded { transform: rotate(180deg); }
    .thinking-steps { display: flex; flex-direction: column; gap: 0; padding: 2px 0 6px 20px; max-height: 160px; overflow-y: auto; border-left: 1.5px solid rgba(128,128,128,.12); margin-left: 6px; }
    .thinking-steps.collapsed { display: none; }
    .thinking-step { display: flex; align-items: baseline; gap: 5px; padding: 1px 6px; color: var(--fg2); }
    .thinking-step-icon { flex-shrink: 0; font-size: 9px; }
    .thinking-step-body { display: flex; flex-direction: column; min-width: 0; }
    .thinking-step-label { font-size: 11px; font-weight: 500; color: var(--fg); }
    .thinking-step-detail { font-size: 10px; opacity: .5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .thinking-step-time { font-size: 9px; opacity: .35; margin-left: auto; flex-shrink: 0; }

    /* ── Popups ─── */
    .popup { position: absolute; bottom: calc(100% + 4px); left: 0; z-index: 200; background: var(--vscode-editorWidget-background, var(--bg2)); border: 1px solid var(--border); border-radius: var(--r); display: flex; flex-direction: column; gap: 1px; padding: 4px; min-width: 140px; box-shadow: 0 4px 14px rgba(0,0,0,.2); }
    .popup.hidden { display: none; }
    .popup-opt { display: flex; align-items: center; gap: 7px; padding: 6px 10px; border-radius: 6px; border: none; background: transparent; color: var(--fg); cursor: pointer; font: 12px var(--vscode-font-family); text-align: left; transition: background var(--spd); }
    .popup-opt:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.1)); }
    .popup-opt.active { font-weight: 700; }
    .popup-opt.active::after { content: '\\2713'; margin-left: auto; font-size: 11px; opacity: .6; }

    .model-popup { position: absolute; bottom: calc(100% + 4px); left: 0; z-index: 200; background: var(--vscode-editorWidget-background, var(--bg2)); border: 1px solid var(--border); border-radius: var(--r); min-width: 180px; max-height: 220px; overflow-y: auto; box-shadow: 0 4px 14px rgba(0,0,0,.2); }
    .model-popup.hidden { display: none; }
    .model-popup-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--fg2); padding: 7px 10px 4px; }
    .model-popup-list { display: flex; flex-direction: column; gap: 1px; padding: 2px 4px 4px; }

    /* ── Permission popup ─── */
    .perm-popup { position: absolute; bottom: calc(100% + 4px); left: 0; z-index: 200; background: var(--vscode-editorWidget-background, var(--bg2)); border: 1px solid var(--border); border-radius: var(--r); min-width: 220px; box-shadow: 0 4px 14px rgba(0,0,0,.2); padding: 4px; }
    .perm-popup.hidden { display: none; }
    .perm-opt { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 6px; border: none; background: transparent; color: var(--fg); cursor: pointer; font: 12px var(--vscode-font-family); text-align: left; transition: background var(--spd); width: 100%; }
    .perm-opt:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.1)); }
    .perm-opt.active { font-weight: 600; }
    .perm-opt-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }
    .perm-opt-text { display: flex; flex-direction: column; gap: 1px; }
    .perm-opt-title { font-size: 12px; font-weight: 600; }
    .perm-opt-desc { font-size: 10px; color: var(--fg2); line-height: 1.3; }
    .perm-opt.active .perm-opt-title::after { content: ' \\2713'; font-size: 10px; opacity: .6; }

    /* ── Empty state ─── */
    .empty { text-align: center; padding: 24px 12px; color: var(--fg2); }
    .empty-icon { font-size: 26px; margin-bottom: 6px; opacity: .4; }
    .empty-h { font-size: 13px; font-weight: 600; margin-bottom: 3px; }
    .empty-p { font-size: 12px; opacity: .6; }

    /* ── Pending edits banner ─── */
    #editsBanner { display: none; margin: 4px 12px 0; padding: 8px 10px; border-radius: var(--r); background: var(--amber-bg); border: 1px solid var(--amber-bdr); align-items: center; justify-content: space-between; gap: 8px; flex-shrink: 0; }
    #editsBanner.on { display: flex; }
    .banner-txt { font-size: 12px; font-weight: 600; color: var(--amber); flex: 1; }
    .banner-acts { display: flex; gap: 5px; }

    /* ── Composer ─── */
    .composer { padding: 6px 12px 8px; border-top: 1px solid var(--border); flex-shrink: 0; }
    .composer-box { position: relative; border-radius: 14px; border: 1.5px solid var(--vscode-input-border, rgba(128,128,128,.22)); background: var(--bg2); transition: border-color var(--spd), box-shadow var(--spd); }
    .composer-box:focus-within { border-color: var(--amber); box-shadow: 0 0 0 2.5px var(--amber-glow); }
    .composer-box textarea { display: block; width: 100%; min-height: 46px; max-height: 160px; padding: 10px 12px 2px; background: none; border: none; outline: none; color: var(--vscode-input-foreground); font: 13px/1.5 var(--vscode-font-family); resize: none; overflow-y: auto; }
    .composer-box textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .composer-inner-row { display: flex; align-items: center; justify-content: space-between; padding: 3px 8px 6px; gap: 4px; }
    .chips { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }

    .mode-chip { border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--fg2); cursor: pointer; font: 700 10px var(--vscode-font-family); letter-spacing: .4px; text-transform: uppercase; padding: 2px 8px; transition: all var(--spd); white-space: nowrap; }
    .mode-chip:hover { border-color: var(--amber); color: var(--amber); background: var(--amber-bg); }
    .mode-chip.active { border-color: var(--amber); color: #fff; background: var(--amber); }

    .chip { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--fg2); cursor: pointer; white-space: nowrap; max-width: 110px; overflow: hidden; text-overflow: ellipsis; transition: all var(--spd); background: transparent; }
    .chip:hover { border-color: var(--amber); color: var(--amber); background: var(--amber-bg); }
    .chip.attach { color: var(--amber); border-style: dashed; }

    .send-btn { width: 28px; height: 28px; min-width: 28px; border: none; border-radius: 8px; background: var(--amber); color: #fff; font-size: 14px; line-height: 1; cursor: default; display: flex; align-items: center; justify-content: center; transition: opacity var(--spd), transform var(--spd); opacity: .25; }
    .send-btn:not([disabled]) { opacity: 1; cursor: pointer; }
    .send-btn:not([disabled]):hover { background: #d97706; transform: scale(1.05); }

    /* ── Permission bar (GitHub Copilot style) ─── */
    .perm-bar { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 2px; gap: 6px; }
    .perm-selector { position: relative; }
    .perm-btn { display: inline-flex; align-items: center; gap: 4px; border: none; background: transparent; color: var(--fg2); cursor: pointer; font: 500 11px var(--vscode-font-family); padding: 2px 6px; border-radius: 4px; transition: all var(--spd); }
    .perm-btn:hover { color: var(--fg); background: rgba(128,128,128,.08); }
    .perm-btn-icon { font-size: 12px; }
    .perm-btn-chevron { font-size: 8px; opacity: .5; }

    .attachment-row { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; padding: 0 0 4px; }
    .attachment-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--fg2); }

    /* ── Generic buttons ─── */
    .btn { font: 600 11px var(--vscode-font-family); padding: 4px 9px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; transition: all var(--spd); }
    .btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.1)); }
    .btn.primary { background: var(--amber); border-color: var(--amber); color: #fff; }
    .btn.primary:hover { background: #d97706; }
    .btn.danger { color: var(--red); border-color: var(--red-bdr); }
    .btn.danger:hover { background: var(--red-bg); }
    .btn.sm { padding: 3px 7px; font-size: 10px; }

    @keyframes fadein { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
    .fadein { animation: fadein 180ms ease forwards; }
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(128,128,128,.2); border-radius: 99px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,.35); }
  </style>
</head>
<body>
<div id="root">

  <header class="hdr">
    <span id="statusBadge" class="badge ${initialStatusClass}">
      <span class="badge-dot"></span><span id="statusTxt">${initialStatusText}</span>
    </span>
    <div class="hdr-right">
      <button id="btnNewChat" class="icon-btn" title="New conversation">&#43;</button>
      <button id="btnSettings" class="icon-btn" title="Settings">&#9881;</button>
      <button id="btnRefresh" class="icon-btn" title="Refresh">&#8635;</button>
    </div>
  </header>

  <div id="fatalBanner" role="alert"></div>

  <div id="settingsDrawer">
    <div class="srow"><span class="slabel">Role</span><select id="roleSelect"><option value="planner">Planner</option><option value="editor">Editor</option><option value="fast">Fast</option><option value="embedding">Embedding</option></select></div>
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
          <span class="thinking-spinner"></span>
          <span id="thinkingTitle">Thinking\u2026</span>
          <span id="thinkingChevron" class="thinking-chevron expanded">\u25BE</span>
        </div>
        <div id="thinkingSteps" class="thinking-steps"></div>
      </div>
    </div>
  </div>

  <div id="editsBanner">
    <span id="bannerTxt" class="banner-txt">Pending edits ready</span>
    <div class="banner-acts">
      <button id="btnApply" class="btn primary sm">Apply</button>
      <button id="btnRevert" class="btn danger sm">Revert</button>
    </div>
  </div>

  <div class="composer">
    <div class="composer-box">
      <textarea id="taskInput" placeholder="Ask Pulse anything about your code\u2026" rows="2" aria-label="Message"></textarea>
      <div class="composer-inner-row">
        <div class="chips">
          <button id="chipMode" type="button" class="mode-chip active" title="Switch mode">AGENT</button>
          <div id="modePopup" class="popup hidden">
            <button type="button" class="popup-opt" data-mode="agent">&#9889; Agent</button>
            <button type="button" class="popup-opt" data-mode="ask">&#128172; Ask</button>
            <button type="button" class="popup-opt" data-mode="plan">&#128203; Plan</button>
          </div>
          <button id="chipModel" type="button" class="chip" title="Active model">\u2013</button>
          <div id="modelPopup" class="model-popup hidden">
            <div class="model-popup-title">Switch model</div>
            <div id="modelPopupList" class="model-popup-list"></div>
          </div>
          <button id="btnAttach" type="button" class="chip attach" title="Attach files">+ attach</button>
        </div>
        <button id="btnSend" class="send-btn" title="Send (Enter)" disabled>&#8593;</button>
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
            <span class="perm-opt-text"><span class="perm-opt-title">Default Approvals</span><span class="perm-opt-desc">Pulse uses your configured settings</span></span>
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
  var roleSelect = D('roleSelect'), modelSelect = D('modelSelect');
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

  // State
  var summary = null, models = [], mcpServers = [];
  var chatHistory = [], attachedFiles = [];
  var conversationMode = 'agent', inChat = false;
  var activeModelName = '', permMode = 'default';
  var thinkingSteps = [], thinkingStartTime = null;
  var modePopupOpen = false, modelPopupOpen = false, permPopupOpen = false;
  var isBusy = false;

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
  function scrollBottom() { requestAnimationFrame(function() { var el = D('main'); if (el) el.scrollTop = 999999; }); }
  function on(el, evt, fn) { if (el) el.addEventListener(evt, fn); }

  // Markdown rendering
  function renderMarkdown(raw) {
    var html = esc(raw);
    html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, function(_, lang, code) {
      return '<pre><code>' + code + '</code></pre>';
    });
    html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
    html = html.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
    html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/\\n/g, '<br>');
    html = html.replace(/<pre><code>(.*?)<\\/code><\\/pre>/gs, function(match) {
      return match.replace(/<br>/g, '\\n');
    });
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
    if (taskInput) {
      taskInput.placeholder = conversationMode === 'ask' ? 'Ask Pulse a question\u2026'
        : conversationMode === 'plan' ? 'Describe the change you want planned\u2026'
        : 'Ask Pulse anything about your code\u2026';
    }
  }

  // Popups
  function closeAllPopups() { closeModePopup(); closeModelPopup(); closePermPopup(); }
  function openModePopup() { closeAllPopups(); D('modePopup').classList.remove('hidden'); modePopupOpen = true; }
  function closeModePopup() { var p = D('modePopup'); if (p) p.classList.add('hidden'); modePopupOpen = false; }
  function openModelPopup() {
    closeAllPopups();
    var popup = D('modelPopup'), list = D('modelPopupList');
    if (!popup || !list) return;
    list.innerHTML = '';
    if (!models.length) { list.innerHTML = '<div style="padding:8px 10px;font-size:11px;opacity:.5">No models</div>'; }
    else { models.forEach(function(m) {
      var btn = document.createElement('button'); btn.type = 'button';
      btn.className = 'popup-opt' + (m.name === activeModelName ? ' active' : '');
      btn.textContent = m.name; btn.title = m.name;
      btn.addEventListener('click', function(e) { e.stopPropagation(); activeModelName = m.name;
        if (chipModel) { chipModel.textContent = m.name.split(':')[0].slice(0,14) || '\u2013'; chipModel.title = m.name; }
        vscode.postMessage({ type: 'setModel', payload: { role: 'planner', model: m.name } }); closeModelPopup(); });
      list.appendChild(btn);
    }); }
    popup.classList.remove('hidden'); modelPopupOpen = true;
  }
  function closeModelPopup() { var p = D('modelPopup'); if (p) p.classList.add('hidden'); modelPopupOpen = false; }
  function openPermPopup() { closeAllPopups(); var p = D('permPopup'); if (p) { updatePermUI(permMode); p.classList.remove('hidden'); } permPopupOpen = true; }
  function closePermPopup() { var p = D('permPopup'); if (p) p.classList.add('hidden'); permPopupOpen = false; }
  document.addEventListener('click', closeAllPopups);

  // Thinking
  function startThinking() {
    thinkingSteps = []; thinkingStartTime = Date.now();
    var panel = D('thinkingPanel'), steps = D('thinkingSteps'), title = D('thinkingTitle'), chev = D('thinkingChevron');
    if (!panel) return;
    panel.classList.remove('hidden', 'done');
    if (steps) { steps.innerHTML = ''; steps.classList.remove('collapsed'); }
    if (title) title.textContent = 'Thinking\u2026';
    if (chev) { chev.textContent = '\u25BE'; chev.classList.add('expanded'); }
  }
  function addThinkingStep(step) {
    thinkingSteps.push(step);
    var steps = D('thinkingSteps');
    if (!steps) return;
    var elapsed = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) + 's' : '';
    var div = document.createElement('div'); div.className = 'thinking-step';
    div.innerHTML = '<span class="thinking-step-icon">' + esc(step.icon || '\u00b7') + '</span>' +
      '<div class="thinking-step-body"><span class="thinking-step-label">' + esc(step.step || '') + '</span>' +
      (step.detail ? '<span class="thinking-step-detail">' + esc(step.detail) + '</span>' : '') + '</div>' +
      '<span class="thinking-step-time">' + esc(elapsed) + '</span>';
    steps.appendChild(div); scrollBottom();
  }
  function finishThinking() {
    var panel = D('thinkingPanel'), title = D('thinkingTitle'), steps = D('thinkingSteps'), chev = D('thinkingChevron');
    if (!panel) return;
    panel.classList.add('done');
    var elapsed = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) : '';
    var count = thinkingSteps.length;
    if (title) title.textContent = 'Thought for ' + (elapsed ? elapsed + 's' : '') + (count ? ' \u00b7 ' + count + ' step' + (count !== 1 ? 's' : '') : '');
    if (steps) steps.classList.add('collapsed');
    if (chev) { chev.textContent = '\u25B8'; chev.classList.remove('expanded'); }
    isBusy = false;
  }
  function toggleThinking() {
    var steps = D('thinkingSteps'), chev = D('thinkingChevron');
    if (!steps) return;
    var collapsed = steps.classList.toggle('collapsed');
    if (chev) { chev.textContent = collapsed ? '\u25B8' : '\u25BE'; chev.classList.toggle('expanded', !collapsed); }
  }

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

  // Render messages
  function renderMessages() {
    if (!chatHistory.length) {
      messages.innerHTML = '<div class="empty fadein"><div class="empty-icon">&#9889;</div><div class="empty-h">Ready to help</div><div class="empty-p">Describe what you want to build or fix</div></div>';
      return;
    }
    messages.innerHTML = '';
    for (var i = 0; i < chatHistory.length; i++) {
      var m = chatHistory[i];
      var div = document.createElement('div');
      var role = m.role === 'assistant' ? 'agent' : m.role;
      div.className = 'msg ' + role + ' fadein';
      var text = m.text || m.content || '';
      var html = renderMarkdown(text);
      var rawTs = m.ts || m.createdAt || null;
      var ts = rawTs ? relTime(new Date(rawTs).toISOString()) : '';
      div.innerHTML = '<div class="bubble">' + html + '</div>' +
        '<div class="msg-footer">' +
        '<span class="msg-time">' + esc(ts) + '</span>' +
        '<button class="copy-btn" title="Copy message">\uD83D\uDCCB</button>' +
        '</div>';
      (function(t, el) {
        el.querySelector('.copy-btn').addEventListener('click', function(e) {
          e.stopPropagation();
          var target = e.currentTarget;
          navigator.clipboard.writeText(t).then(function() {
            target.textContent = '\u2713';
            setTimeout(function() { target.textContent = '\uD83D\uDCCB'; }, 1200);
          });
        });
      })(text, div);
      messages.appendChild(div);
    }
  }

  function renderAttachments(files) {
    attachedFiles = Array.isArray(files) ? files.slice() : [];
    if (!attachmentRow) return;
    if (!attachedFiles.length) { attachmentRow.innerHTML = ''; return; }
    attachmentRow.innerHTML = '<span class="attachment-label">Attached</span>' +
      attachedFiles.map(function(f) { return '<span class="chip" title="' + esc(f) + '">' + esc(f.split(/[\\\\/]/).pop()) + '</span>'; }).join('');
  }

  function renderSessions(list) {
    list = list || [];
    if (!list.length) { sessionList.innerHTML = '<div class="empty"><div class="empty-icon">&#128172;</div><div class="empty-h">No conversations yet</div><div class="empty-p">Type a message below to begin</div></div>'; return; }
    sessionList.innerHTML = '';
    for (var i = 0; i < list.length; i++) {
      (function(s) {
        var d = document.createElement('div'); d.className = 'sitem'; d.dataset.sessionId = String(s.id || '');
        d.innerHTML = '<span class="sitem-title">' + esc(s.title || s.id) + '</span><div class="session-actions"><div class="session-meta"><span class="sitem-time">' + esc(relTime(s.updatedAt)) + '</span><span class="session-count">' + esc(String(s.messageCount || 0)) + ' msgs</span></div><button type="button" class="session-delete" title="Delete">&#128465;</button></div>';
        d.addEventListener('click', function() { if (s.id) vscode.postMessage({ type: 'openSession', payload: s.id }); });
        d.querySelector('.session-delete').addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); vscode.postMessage({ type: 'deleteSessionRequest', payload: s.id }); });
        sessionList.appendChild(d);
      })(list[i]);
    }
  }

  function renderLoadedSession(session) {
    if (!session) return;
    attachedFiles = session.attachedFiles || [];
    renderAttachments(attachedFiles);
    if (Array.isArray(session.messages) && session.messages.length > 0) {
      chatHistory = session.messages.map(function(m) { return { role: m.role, content: m.content, ts: m.createdAt }; });
    } else {
      chatHistory = [{ role: 'user', text: session.objective || session.title || 'Session', ts: session.updatedAt || Date.now() }];
      if (session.lastResult) chatHistory.push({ role: 'assistant', text: session.lastResult, ts: session.updatedAt || Date.now() });
    }
    renderMessages(); showChat();
  }

  function handleSessionDeleted(payload) {
    if (payload && payload.wasActive) { chatHistory = []; attachedFiles = []; renderAttachments(attachedFiles); renderMessages(); showHome(); }
  }

  // Render summary
  function renderSummary(s) {
    summary = s;
    var ok = s && (Boolean(s.ollamaReachable) || s.status === 'ready');
    statusBadge.className = 'badge ' + (ok ? 'on' : 'off');
    statusTxt.textContent = ok ? 'Online' : 'Offline';
    renderConversationMode((s && s.conversationMode) || 'agent');
    if (s && s.permissionMode) updatePermUI(s.permissionMode);
    var model = (s && s.plannerModel) || '';
    activeModelName = model;
    chipModel.textContent = model.split(':')[0].slice(0, 14) || '\u2013';
    chipModel.title = model || 'none';
    var hasPending = s && s.hasPendingEdits;
    editsBanner.classList.toggle('on', Boolean(hasPending));
    if (hasPending) bannerTxt.textContent = 'Pending file edits \u2014 review before applying';
  }

  function updateModels(list) {
    models = list || [];
    var prev = modelSelect.value;
    modelSelect.innerHTML = '';
    if (!models.length) { modelSelect.innerHTML = '<option value="">No models found</option>'; return; }
    for (var i = 0; i < models.length; i++) { var o = document.createElement('option'); o.value = models[i].name; o.text = models[i].name; modelSelect.appendChild(o); }
    if (models.some(function(m) { return m.name === prev; })) modelSelect.value = prev;
  }

  // Send task
  function sendTask() {
    var text = taskInput.value.trim();
    if (!text || isBusy) return;
    taskInput.value = ''; taskInput.style.height = 'auto'; btnSend.disabled = true;
    isBusy = true;
    chatHistory.push({ role: 'user', text: text, ts: Date.now() });
    renderMessages(); showChat(); startThinking(); scrollBottom();
    vscode.postMessage({ type: 'runTask', payload: text });
  }

  // Event listeners
  on(taskInput, 'input', function() { autoGrow(taskInput); btnSend.disabled = taskInput.value.trim().length === 0; });
  on(taskInput, 'keydown', function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTask(); } });
  on(btnSend, 'click', sendTask);

  on(btnNewChat, 'click', function() { chatHistory = []; attachedFiles = []; renderAttachments(attachedFiles); renderMessages(); showChat(); vscode.postMessage({ type: 'newConversation' }); taskInput.focus(); });
  on(btnBack, 'click', showHome);
  on(btnAttach, 'click', function() { vscode.postMessage({ type: 'attachContext' }); });
  on(btnSettings, 'click', function() { settingsDrawer.classList.toggle('open'); });
  on(btnRefresh, 'click', function() { vscode.postMessage({ type: 'ping' }); });

  on(chipMode, 'click', function(e) { e.stopPropagation(); modePopupOpen ? closeModePopup() : openModePopup(); });
  (function() { var p = D('modePopup'); if (!p) return; p.querySelectorAll('.popup-opt').forEach(function(btn) { btn.addEventListener('click', function(e) { e.stopPropagation(); var m = btn.dataset.mode; if (m && m !== conversationMode) vscode.postMessage({ type: 'setConversationMode', payload: m }); closeModePopup(); }); }); }());
  on(chipModel, 'click', function(e) { e.stopPropagation(); modelPopupOpen ? closeModelPopup() : openModelPopup(); });
  on(D('thinkingToggle'), 'click', function(e) { e.stopPropagation(); toggleThinking(); });

  // Permission bar
  on(permBtn, 'click', function(e) { e.stopPropagation(); permPopupOpen ? closePermPopup() : openPermPopup(); });
  (function() { var p = D('permPopup'); if (!p) return; p.querySelectorAll('.perm-opt').forEach(function(btn) { btn.addEventListener('click', function(e) { e.stopPropagation(); var m = btn.dataset.perm; if (m) { vscode.postMessage({ type: 'setPermissionMode', payload: m }); updatePermUI(m); } closePermPopup(); }); }); }());

  on(btnSyncModels, 'click', function() { vscode.postMessage({ type: 'refreshModels' }); });
  on(btnApplyModel, 'click', function() { var r = roleSelect.value, m = modelSelect.value; if (m) vscode.postMessage({ type: 'setModel', payload: { role: r, model: m } }); });
  on(btnAddMcp, 'click', function() { mcpServers = snapshotMcpServers().concat([normalizeMcpServer({ enabled: true, trust: 'workspace', transport: 'stdio', args: [] })]); renderMcpServers(mcpServers); });
  on(btnReloadMcp, 'click', function() { vscode.postMessage({ type: 'reloadMcpServers' }); });
  on(btnOpenMcpSettings, 'click', function() { vscode.postMessage({ type: 'configureMcpServers' }); });
  on(btnManageMcp, 'click', function() { vscode.postMessage({ type: 'manageMcpConnections' }); });
  on(btnSaveMcp, 'click', function() { try { vscode.postMessage({ type: 'saveMcpServers', payload: collectMcpServers() }); } catch(e) {} });

  // Edits banner
  var applyPending = false, revertPending = false;
  function resetBannerBtns() { applyPending = false; revertPending = false; btnApply.textContent = 'Apply'; btnApply.className = 'btn primary sm'; btnRevert.textContent = 'Revert'; btnRevert.className = 'btn danger sm'; }
  on(btnApply, 'click', function() { if (!applyPending) { applyPending = true; btnApply.textContent = 'Confirm?'; return; } resetBannerBtns(); vscode.postMessage({ type: 'applyPending', payload: true }); });
  on(btnRevert, 'click', function() { if (!revertPending) { revertPending = true; btnRevert.textContent = 'Confirm?'; return; } resetBannerBtns(); vscode.postMessage({ type: 'revertLast', payload: true }); });

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
    if (type === 'taskResult') {
      finishThinking();
      var text = (payload && payload.responseText) || JSON.stringify(payload, null, 2);
      chatHistory.push({ role: 'agent', text: text, ts: Date.now() });
      renderMessages(); scrollBottom();
      vscode.postMessage({ type: 'ping' });
      return;
    }
    if (type === 'actionResult') {
      finishThinking();
      var txt = String(payload || '');
      if (txt && txt.indexOf('Approval mode set') !== 0 && txt.indexOf('Permission mode set') !== 0 && txt.indexOf('Updated ') !== 0 && txt.indexOf('Mode set to') !== 0 && txt.indexOf('MCP servers updated') !== 0) {
        chatHistory.push({ role: 'agent', text: txt, ts: Date.now() });
        renderMessages(); scrollBottom();
      }
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

  } catch (error) {
    surfaceFatalError(error instanceof Error ? error.stack || error.message : String(error));
  }
}());
</script>
</body>
</html>`;
  }
}
