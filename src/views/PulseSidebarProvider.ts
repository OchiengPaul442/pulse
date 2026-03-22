import * as crypto from "crypto";
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
          plannerModel: "unknown",
          editorModel: "unknown",
          fastModel: "unknown",
          embeddingModel: "unknown",
          approvalMode: "balanced" as const,
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
            if (
              message.payload !== true &&
              this.runtime.getApprovalMode() !== "fast"
            ) {
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload: "Apply canceled.",
              });
              return;
            }

            const applied = await this.runtime.applyPendingEdits(
              message.payload === true,
            );
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
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload: `Updated ${payload.role} model to ${payload.model}`,
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
            await webviewView.webview.postMessage({
              type: "actionResult",
              payload: "MCP servers updated.",
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
            const picked = await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectFolders: true,
              canSelectMany: true,
              openLabel: "Attach context",
              title: "Attach files or folders for Pulse to read",
            });

            if (!picked || picked.length === 0) {
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload: "Attachment canceled.",
              });
              return;
            }

            const session = await this.runtime.attachFilesToActiveSession(
              picked.map((item) => item.fsPath),
            );
            if (!session) {
              await webviewView.webview.postMessage({
                type: "actionResult",
                payload: "Unable to attach files.",
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
    const initialStatusLine = initialOnline
      ? initialSummary && initialSummary.modelCount
        ? `${initialSummary.modelCount} model${
            initialSummary.modelCount !== 1 ? "s" : ""
          }, MCP ${initialSummary.mcpHealthy}/${initialSummary.mcpConfigured}`
        : "Ollama ready"
      : "Ollama offline — check settings";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --amber:      #f59e0b;
      --amber-bg:   rgba(245,158,11,0.12);
      --amber-bdr:  rgba(245,158,11,0.30);
      --amber-glow: rgba(245,158,11,0.14);
      --green:      #22c55e;
      --green-bg:   rgba(34,197,94,0.10);
      --green-bdr:  rgba(34,197,94,0.28);
      --red:        var(--vscode-errorForeground, #f87171);
      --red-bg:     rgba(248,113,113,0.08);
      --red-bdr:    rgba(248,113,113,0.28);
      --border:     var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.18));
      --r-sm: 8px; --r-md: 14px; --r-lg: 18px;
      --spd: 160ms;
    }

    html, body {
      height: 100%;
      font-family: var(--vscode-font-family, "Segoe UI", system-ui, sans-serif);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      overflow: hidden;
    }
    #root { display: flex; flex-direction: column; height: 100%; }

    /* ── Header ─────────────────────────────────────────────────── */
    .hdr {
      display: flex; align-items: center; justify-content: space-between;
      padding: 9px 12px 8px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .hdr-right { display: flex; align-items: center; gap: 5px; }

    .badge {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 11px; font-weight: 600;
      padding: 2px 8px; border-radius: 999px; border: 1px solid;
    }
    .badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .badge.on  { color: var(--green); border-color: var(--green-bdr); background: var(--green-bg); }
    .badge.off { color: var(--red);   border-color: var(--red-bdr);   background: var(--red-bg); }

    .fatal-banner {
      display: none;
      margin: 10px 12px 0;
      padding: 10px 12px;
      border-radius: var(--r-md);
      border: 1px solid var(--red-bdr);
      background: var(--red-bg);
      color: var(--vscode-foreground);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .fatal-banner.on { display: block; }

    .icon-btn {
      width: 24px; height: 24px; border: none; background: transparent;
      color: var(--vscode-foreground); opacity: .5; cursor: pointer;
      border-radius: var(--r-sm);
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; transition: opacity var(--spd), background var(--spd);
    }
    .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.14)); }

    /* ── Settings drawer ────────────────────────────────────────── */
    #settingsDrawer {
      display: none; flex-direction: column; gap: 8px;
      padding: 10px 12px 12px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    #settingsDrawer.open { display: flex; }

    .srow { display: grid; grid-template-columns: 68px 1fr; align-items: center; gap: 8px; }
    .slabel {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .5px; color: var(--vscode-descriptionForeground);
    }

    input[type="text"], select, textarea {
      width: 100%; padding: 5px 7px;
      border-radius: var(--r-sm);
      border: 1px solid var(--border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font: 12px var(--vscode-font-family);
    }
    input[type="text"]::placeholder, textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    select { cursor: pointer; }
    textarea { resize: vertical; min-height: 38px; }

    .sbtns { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }

    .section {
      display: flex; flex-direction: column; gap: 6px;
      padding-top: 8px; border-top: 1px solid var(--border);
    }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .section-copy { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }

    .mcp-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .mcp-count {
      margin-left: auto; font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .6px;
      color: var(--vscode-descriptionForeground);
    }
    .mcp-list { display: flex; flex-direction: column; gap: 8px; max-height: 230px; overflow: auto; padding-right: 2px; }
    .mcp-card {
      display: flex; flex-direction: column; gap: 8px; padding: 10px;
      border-radius: var(--r-md); border: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(128,128,128,.04), rgba(128,128,128,.01));
    }
    .mcp-card-head { display: flex; align-items: center; gap: 8px; }
    .mcp-card-title { flex: 1; min-width: 0; }
    .mcp-chip {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border);
      font-size: 10px; font-weight: 700; color: var(--vscode-descriptionForeground);
      text-transform: uppercase; letter-spacing: .5px;
    }
    .mcp-grid { display: grid; grid-template-columns: 1fr 130px; gap: 6px; }
    .mcp-grid.triple { grid-template-columns: 1fr 1fr 1fr; }
    .mcp-note { font-size: 10px; color: var(--vscode-descriptionForeground); line-height: 1.35; }
    .mcp-empty {
      padding: 12px; border-radius: var(--r-md);
      border: 1px dashed var(--border);
      color: var(--vscode-descriptionForeground); font-size: 11px; text-align: center;
    }

    /* ── Main scroll area ───────────────────────────────────────── */
    #main { flex: 1; overflow-y: auto; overflow-x: hidden; scroll-behavior: smooth; }

    /* ── Home view ──────────────────────────────────────────────── */
    #homeView { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    #homeView.hidden, #chatView.hidden { display: none; }

    .new-btn {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; padding: 10px 14px;
      border-radius: var(--r-md);
      border: 1.5px dashed var(--border);
      background: transparent; color: var(--vscode-foreground);
      font: 600 13px var(--vscode-font-family); cursor: pointer; opacity: .65;
      transition: all var(--spd);
    }
    .new-btn:hover { opacity: 1; border-style: solid; border-color: var(--amber); background: var(--amber-bg); }

    .sec-title {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .7px; color: var(--vscode-descriptionForeground); padding: 0 2px;
    }
    .sessions { border-top: 1px solid var(--border); }
    .sitem {
      display: flex; align-items: center; justify-content: space-between;
      padding: 9px 6px; cursor: pointer;
      border-bottom: 1px solid var(--border);
      border-radius: var(--r-sm); transition: background var(--spd);
    }
    .sitem:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.08)); }
    .sitem {
      gap: 8px;
    }
    .sitem-title {
      font-size: 13px; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;
    }
    .sitem-time { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 8px; flex-shrink: 0; }
    .session-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .session-meta {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 2px;
    }
    .session-count {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .session-delete {
      width: 22px;
      height: 22px;
      border: 1px solid transparent;
      border-radius: 999px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      opacity: .7;
      transition: opacity var(--spd), background var(--spd), color var(--spd), border-color var(--spd);
    }
    .session-delete:hover {
      opacity: 1;
      color: var(--red);
      border-color: var(--red-bdr);
      background: var(--red-bg);
    }
    .session-delete.confirming {
      color: #fff;
      border-color: var(--red);
      background: var(--red);
      opacity: 1;
    }

    /* ── Chat view ──────────────────────────────────────────────── */
    #chatView { padding: 10px 12px 4px; display: flex; flex-direction: column; gap: 10px; }

    .back-btn {
      display: inline-flex; align-items: center; gap: 4px;
      border: none; background: none; color: var(--amber);
      font: 600 11px var(--vscode-font-family); cursor: pointer; opacity: .8;
      padding: 0 0 2px; width: fit-content;
    }
    .back-btn:hover { opacity: 1; }

    /* ── Messages ───────────────────────────────────────────────── */
    #messages { display: flex; flex-direction: column; gap: 10px; }
    .msg { max-width: 90%; }
    .msg.user  { align-self: flex-end; }
    .msg.agent { align-self: flex-start; }
    .bubble {
      padding: 9px 13px; border-radius: var(--r-md);
      line-height: 1.55; font-size: 13px; word-break: break-word;
    }
    .msg.user  .bubble { background: var(--amber); color: #fff; border-bottom-right-radius: 3px; }
    .msg.agent .bubble {
      background: var(--vscode-input-background, rgba(128,128,128,.1));
      border: 1px solid var(--border); border-bottom-left-radius: 3px;
    }
    .bubble code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px; background: rgba(0,0,0,.16); padding: 1px 5px; border-radius: 4px;
    }
    .bubble pre {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px; line-height: 1.45;
      background: rgba(0,0,0,.18); border-radius: var(--r-sm);
      padding: 9px 11px; margin: 7px 0; overflow-x: auto; white-space: pre-wrap;
    }
    .msg-time { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 3px; padding: 0 2px; }
    .msg.user .msg-time { text-align: right; }

    /* ── Typing indicator ───────────────────────────────────────── */
    #typing { align-self: flex-start; display: none; }
    #typing.on { display: block; }
    .typing-bubble {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 10px 13px; border-radius: var(--r-md); border-bottom-left-radius: 3px;
      background: var(--vscode-input-background, rgba(128,128,128,.1));
      border: 1px solid var(--border);
    }
    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--vscode-descriptionForeground, rgba(128,128,128,.7));
      animation: bounce 1.1s infinite ease-in-out;
    }
    .dot:nth-child(2) { animation-delay: .18s; }
    .dot:nth-child(3) { animation-delay: .36s; }
    @keyframes bounce {
      0%,60%,100% { transform: translateY(0); opacity: .5; }
      30%          { transform: translateY(-5px); opacity: 1; }
    }

    /* ── Empty state ────────────────────────────────────────────── */
    .empty { text-align: center; padding: 28px 12px; color: var(--vscode-descriptionForeground); }
    .empty-icon { font-size: 28px; margin-bottom: 8px; opacity: .45; }
    .empty-h { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
    .empty-p { font-size: 12px; opacity: .7; }

    /* ── Pending edits banner ───────────────────────────────────── */
    #editsBanner {
      display: none; margin: 4px 12px 0;
      padding: 9px 11px; border-radius: var(--r-md);
      background: var(--amber-bg); border: 1px solid var(--amber-bdr);
      align-items: center; justify-content: space-between; gap: 8px; flex-shrink: 0;
    }
    #editsBanner.on { display: flex; }
    .banner-txt { font-size: 12px; font-weight: 600; color: var(--amber); flex: 1; }
    .banner-acts { display: flex; gap: 5px; }

    /* ── Composer (Codex / Copilot-style) ───────────────────────── */
    .composer {
      padding: 8px 12px 10px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }

    /* Main input card — border glows amber on focus */
    .composer-box {
      position: relative;
      border-radius: var(--r-lg);
      border: 1.5px solid var(--vscode-input-border, rgba(128,128,128,.25));
      background: var(--vscode-input-background);
      transition: border-color var(--spd), box-shadow var(--spd);
    }
    .composer-box:focus-within {
      border-color: var(--amber);
      box-shadow: 0 0 0 3px var(--amber-glow);
    }

    /* Textarea sits flush inside the box — no own border */
    .composer-box textarea {
      display: block; width: 100%;
      min-height: 52px; max-height: 180px;
      padding: 12px 14px 4px;
      background: none; border: none; outline: none;
      color: var(--vscode-input-foreground);
      font: 13px/1.55 var(--vscode-font-family);
      resize: none; overflow-y: auto;
    }
    .composer-box textarea::placeholder { color: var(--vscode-input-placeholderForeground); }

    /* Bottom row inside the box: chips on left, send on right */
    .composer-inner-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 10px 8px; gap: 6px;
    }

    .chips { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }

    .chip {
      font-size: 10px; font-weight: 600;
      padding: 3px 8px; border-radius: 999px;
      border: 1px solid var(--border);
      color: var(--vscode-descriptionForeground);
      cursor: pointer; white-space: nowrap;
      max-width: 120px; overflow: hidden; text-overflow: ellipsis;
      transition: all var(--spd); background: transparent;
    }
    .chip:hover { border-color: var(--amber); color: var(--amber); background: var(--amber-bg); }
    .chip.attach {
      color: var(--amber);
      border-style: dashed;
    }
    .chip.attach:hover { border-color: var(--amber); background: var(--amber-bg); }
    .attachment-row {
      display: flex;
      gap: 5px;
      align-items: center;
      flex-wrap: wrap;
      padding: 0 10px 8px;
    }
    .attachment-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .6px;
      color: var(--vscode-descriptionForeground);
    }
    .attachment-empty {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      opacity: .7;
    }

    /* Send button — rounded square, disabled until text is typed */
    .send-btn {
      width: 30px; height: 30px; min-width: 30px;
      border: none; border-radius: 10px;
      background: var(--amber); color: #fff;
      font-size: 15px; line-height: 1; cursor: default;
      display: flex; align-items: center; justify-content: center;
      transition: opacity var(--spd), transform var(--spd), background var(--spd);
      opacity: .3;
    }
    .send-btn:not([disabled]) { opacity: 1; cursor: pointer; }
    .send-btn:not([disabled]):hover { background: #d97706; transform: scale(1.06); }

    /* Status / token row below the box */
    .composer-foot {
      display: flex; align-items: center; justify-content: space-between;
      padding: 5px 2px 0; gap: 8px;
    }
    .status-txt { font-size: 10px; color: var(--vscode-descriptionForeground); }

    .token-wrap { display: inline-flex; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .token-ring {
      width: 24px; height: 24px; border-radius: 50%;
      background: conic-gradient(var(--amber) 0deg, rgba(128,128,128,.18) 0deg);
      display: inline-flex; align-items: center; justify-content: center; position: relative;
    }
    .token-ring::after {
      content: ""; position: absolute; width: 16px; height: 16px; border-radius: 50%;
      background: var(--vscode-sideBar-background);
    }
    .token-value { position: relative; z-index: 1; font-size: 8px; font-weight: 700; color: var(--vscode-foreground); }

    /* ── Generic buttons ────────────────────────────────────────── */
    .btn {
      font: 600 11px var(--vscode-font-family);
      padding: 5px 10px; border-radius: var(--r-sm);
      border: 1px solid var(--border);
      background: transparent; color: var(--vscode-foreground);
      cursor: pointer; transition: all var(--spd);
    }
    .btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.12)); }
    .btn.primary { background: var(--amber); border-color: var(--amber); color: #fff; }
    .btn.primary:hover { background: #d97706; border-color: #d97706; }
    .btn.danger  { color: var(--red); border-color: var(--red-bdr); }
    .btn.danger:hover  { background: var(--red-bg); }
    .btn.sm { padding: 4px 8px; font-size: 10px; }

    @keyframes fadein {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .fadein { animation: fadein 220ms ease forwards; }

    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(128,128,128,.25); border-radius: 99px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,.45); }
  </style>
</head>
<body>
<div id="root">

  <!-- ── Header ── -->
  <header class="hdr">
    <span id="statusBadge" class="badge ${initialStatusClass}">
      <span class="badge-dot"></span><span id="statusTxt">${initialStatusText}</span>
    </span>
    <div class="hdr-right">
      <button id="btnSettings" class="icon-btn" title="Settings">&#9881;</button>
      <button id="btnRefresh"  class="icon-btn" title="Refresh status">&#8635;</button>
    </div>
  </header>

  <div id="fatalBanner" class="fatal-banner" role="alert"></div>

  <!-- ── Settings drawer ── -->
  <div id="settingsDrawer">
    <div class="srow">
      <span class="slabel">Role</span>
      <select id="roleSelect">
        <option value="planner">Planner</option>
        <option value="editor">Editor</option>
        <option value="fast">Fast</option>
        <option value="embedding">Embedding</option>
      </select>
    </div>
    <div class="srow">
      <span class="slabel">Model</span>
      <select id="modelSelect"></select>
    </div>
    <div class="sbtns">
      <button id="btnSyncModels" class="btn">Sync models</button>
      <button id="btnApplyModel" class="btn primary">Apply</button>
    </div>

    <div class="section">
      <div class="section-head">
        <span class="slabel">MCP Servers</span>
        <span id="mcpCount" class="mcp-count">0 configured</span>
      </div>
      <div class="section-copy">
        Edit servers inline, save to workspace settings, then verify transport health.
      </div>
      <div class="mcp-toolbar">
        <button id="btnAddMcp"          class="btn">Add server</button>
        <button id="btnReloadMcp"       class="btn">Reload</button>
        <button id="btnSaveMcp"         class="btn primary">Save changes</button>
        <button id="btnOpenMcpSettings" class="btn">Open settings</button>
        <button id="btnManageMcp"       class="btn">View status</button>
      </div>
      <div id="mcpList" class="mcp-list"></div>
      <div class="mcp-note">Stdio servers use a command + optional args. HTTP/SSE servers use a URL.</div>
    </div>
  </div>

  <!-- ── Main scrollable area ── -->
  <div id="main">

    <div id="homeView">
      <button id="btnNewChat" class="new-btn">
        <span style="font-size:16px;line-height:1">+</span> New conversation
      </button>
      <div class="sec-title">Recent Conversations</div>
      <div id="sessionList" class="sessions">
        <div class="empty">
          <div class="empty-icon">&#128172;</div>
          <div class="empty-h">No conversations yet</div>
          <div class="empty-p">Type a task below to begin</div>
        </div>
      </div>
    </div>

    <div id="chatView" class="hidden">
      <button id="btnBack" class="back-btn">&#8592; Back</button>
      <div id="attachmentRow" class="attachment-row"></div>
      <div id="messages"></div>
      <div id="typing">
        <div class="typing-bubble">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        </div>
      </div>
    </div>

  </div>

  <!-- ── Pending edits banner ── -->
  <div id="editsBanner">
    <span id="bannerTxt" class="banner-txt">Pending edits ready</span>
    <div class="banner-acts">
      <button id="btnApply"  class="btn primary sm">Apply</button>
      <button id="btnRevert" class="btn danger sm">Revert</button>
    </div>
  </div>

  <!-- ── Composer (Codex / Copilot-style) ── -->
  <div class="composer">
    <div class="composer-box">
      <textarea id="taskInput"
                placeholder="Ask Pulse anything about your code\u2026"
                rows="2"
                aria-label="Message"></textarea>
      <div class="composer-inner-row">
        <div class="chips">
          <span id="chipMode"  class="chip" title="Click to cycle approval mode">balanced</span>
          <span id="chipModel" class="chip" title="Active planner model">\u2013</span>
          <button id="btnAttach" type="button" class="chip attach" title="Attach files or folders">+ attach</button>
        </div>
        <button id="btnSend" class="send-btn" title="Send (Enter)" disabled>&#8593;</button>
      </div>
    </div>
    <div class="composer-foot">
      <span id="statusLine" class="status-txt">${initialStatusLine}</span>
      <div class="token-wrap" title="Token usage this session">
        <div id="tokenRing" class="token-ring">
          <span id="tokenValue" class="token-value">0%</span>
        </div>
        <span id="tokenLabel">0 / 0</span>
      </div>
    </div>
  </div>

</div>

<script nonce="${nonce}">
(function () {
  'use strict';
  let vscode = null;

  function surfaceFatalError(message) {
    const banner = $('fatalBanner');
    if (banner) {
      banner.textContent = message;
      banner.classList.add('on');
    }
    const status = $('statusLine');
    if (status) {
      status.textContent = message.slice(0, 120);
    }
    const badge = $('statusBadge');
    const statusTxt = $('statusTxt');
    if (badge) {
      badge.className = 'badge off';
    }
    if (statusTxt) {
      statusTxt.textContent = 'Error';
    }
    if (vscode) {
      try {
        vscode.postMessage({ type: 'webviewError', payload: message });
      } catch (_) {
        // Ignore secondary failures while surfacing the original error.
      }
    }
  }

  try {
    vscode = acquireVsCodeApi();
  const initialSummary = ${initialSummaryJson};

  // ── DOM refs ──────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const statusBadge    = $('statusBadge');
  const statusTxt      = $('statusTxt');
  const btnSettings    = $('btnSettings');
  const btnRefresh     = $('btnRefresh');
  const settingsDrawer = $('settingsDrawer');
  const roleSelect     = $('roleSelect');
  const modelSelect    = $('modelSelect');
  const btnSyncModels  = $('btnSyncModels');
  const btnApplyModel  = $('btnApplyModel');
  const btnAddMcp      = $('btnAddMcp');
  const btnReloadMcp   = $('btnReloadMcp');
  const btnSaveMcp     = $('btnSaveMcp');
  const btnOpenMcpSettings = $('btnOpenMcpSettings');
  const btnManageMcp   = $('btnManageMcp');
  const mcpList        = $('mcpList');
  const mcpCount       = $('mcpCount');
  const homeView       = $('homeView');
  const chatView       = $('chatView');
  const btnNewChat     = $('btnNewChat');
  const btnBack        = $('btnBack');
  const attachmentRow  = $('attachmentRow');
  const sessionList    = $('sessionList');
  const messages       = $('messages');
  const typing         = $('typing');
  const editsBanner    = $('editsBanner');
  const bannerTxt      = $('bannerTxt');
  const btnApply       = $('btnApply');
  const btnRevert      = $('btnRevert');
  const taskInput      = $('taskInput');
  const btnSend        = $('btnSend');
  const chipModel      = $('chipModel');
  const chipMode       = $('chipMode');
  const btnAttach      = $('btnAttach');
  const statusLine     = $('statusLine');
  const tokenRing      = $('tokenRing');
  const tokenValue     = $('tokenValue');
  const tokenLabel     = $('tokenLabel');

  // ── State ─────────────────────────────────────────────────────────────
  let summary     = null;
  let models      = [];
  let mcpServers  = [];
  let chatHistory = [];
  let attachedFiles = [];
  let inChat      = false;

  // ── Helpers ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function relTime(iso) {
    const d = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!isFinite(d) || d < 1) return 'just now';
    if (d < 60) return d + 'm ago';
    const h = Math.round(d / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }

  function scrollBottom() {
    requestAnimationFrame(() => {
      const el = $('main');
      if (el) el.scrollTop = 999999;
    });
  }

  function on(el, evt, fn) {
    if (!el) { console.warn('[Pulse] missing element for:', evt); return; }
    el.addEventListener(evt, fn);
  }

  function normalizeMcpServer(server) {
    const transport = String(server && server.transport || 'stdio');
    let args = [];
    if (Array.isArray(server && server.args)) {
      args = server.args.map(function(a) { return String(a); });
    } else if (typeof (server && server.args) === 'string') {
      args = server.args.split(/\\r?\\n/).map(function(a) { return a.trim(); }).filter(Boolean);
    }
    return {
      id:        String(server && server.id || ''),
      enabled:   server && server.enabled !== false,
      trust:     String(server && server.trust || 'workspace'),
      transport: transport,
      command:   String(server && server.command || ''),
      url:       String(server && server.url || ''),
      args:      args,
    };
  }

  function parseArgs(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    if (raw.charAt(0) === '[') {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Args must be a JSON array or one per line.');
      return parsed.map(function(a) { return String(a); });
    }
    return raw.split(/\\r?\\n/).map(function(a) { return a.trim(); }).filter(Boolean);
  }

  function renderMcpServers(list) {
    mcpServers = (list || []).map(normalizeMcpServer);
    mcpCount.textContent = mcpServers.length === 1 ? '1 configured' : mcpServers.length + ' configured';
    if (!mcpServers.length) {
      mcpList.innerHTML = '<div class="mcp-empty fadein">No MCP servers yet. Add one to connect Pulse to tools.</div>';
      return;
    }
    mcpList.innerHTML = '';
    mcpServers.forEach(function(server, index) {
      const card = document.createElement('div');
      card.className = 'mcp-card fadein';
      card.dataset.index = String(index);
      const endpointLabel = server.transport === 'stdio' ? 'Command' : 'URL';
      const endpointValue = server.transport === 'stdio' ? server.command : server.url;
      const note = server.transport === 'stdio'
        ? 'Use one argument per line or paste JSON array syntax.'
        : 'Remote servers should use a valid URL.';
      card.innerHTML = [
        '<div class="mcp-card-head">',
        '  <div class="mcp-card-title"><input type="text" data-field="id" placeholder="filesystem" value="' + esc(server.id) + '" /></div>',
        '  <label class="mcp-chip" title="Enable/disable"><input type="checkbox" data-field="enabled" ' + (server.enabled ? 'checked' : '') + ' /> Enabled</label>',
        '  <button type="button" class="btn danger sm" data-action="remove">Remove</button>',
        '</div>',
        '<div class="mcp-grid triple">',
        '  <select data-field="transport"><option value="stdio">stdio</option><option value="http">http</option><option value="sse">sse</option></select>',
        '  <select data-field="trust"><option value="workspace">workspace</option><option value="user">user</option><option value="system">system</option></select>',
        '  <div class="mcp-chip">' + esc(endpointLabel) + '</div>',
        '</div>',
        '<input type="text" data-field="endpoint" placeholder="' + esc(endpointLabel) + '" value="' + esc(endpointValue) + '" />',
        '<textarea data-field="args" placeholder="[\&quot;-y\&quot;, \&quot;@mcp/server\&quot;]">' + esc((server.args || []).join('\\n')) + '</textarea>',
        '<div class="mcp-note">' + esc(note) + '</div>',
      ].join('');

      const transportSelect = card.querySelector('select[data-field="transport"]');
      const trustSelect     = card.querySelector('select[data-field="trust"]');
      const endpointInput   = card.querySelector('input[data-field="endpoint"]');
      const argsInput       = card.querySelector('textarea[data-field="args"]');
      const enabledInput    = card.querySelector('input[data-field="enabled"]');
      transportSelect.value = server.transport;
      trustSelect.value     = server.trust;

      const syncEndpoint = function() {
        const isStdio = transportSelect.value === 'stdio';
        endpointInput.placeholder = isStdio ? 'Command' : 'URL';
        argsInput.style.display   = isStdio ? 'block' : 'none';
      };
      transportSelect.addEventListener('change', syncEndpoint);
      syncEndpoint();

      card._read = function() {
        return {
          id:        String(card.querySelector('input[data-field="id"]').value || '').trim(),
          enabled:   Boolean(enabledInput.checked),
          trust:     String(trustSelect.value || 'workspace'),
          transport: String(transportSelect.value || 'stdio'),
          command:   String(transportSelect.value === 'stdio' ? endpointInput.value || '' : ''),
          url:       String(transportSelect.value === 'stdio' ? '' : endpointInput.value || ''),
          args:      parseArgs(String(argsInput.value || '')),
        };
      };

      card.querySelector('[data-action="remove"]').addEventListener('click', function() {
        const cur = snapshotMcpServers();
        cur.splice(index, 1);
        renderMcpServers(cur);
      });
      mcpList.appendChild(card);
    });
  }

  function collectMcpServers() {
    const cards = Array.from(mcpList.querySelectorAll('.mcp-card'));
    const out = [];
    for (const card of cards) {
      if (typeof card._read !== 'function') continue;
      const s = card._read();
      if (!s.id) continue;
      if (s.transport === 'stdio' && !s.command) throw new Error('Each stdio server needs a command.');
      if ((s.transport === 'http' || s.transport === 'sse') && !s.url) throw new Error('Each HTTP/SSE server needs a URL.');
      out.push(s);
    }
    return out;
  }

  function snapshotMcpServers() {
    return Array.from(mcpList.querySelectorAll('.mcp-card'))
      .map(function(card) { return typeof card._read === 'function' ? card._read() : null; })
      .filter(Boolean);
  }

  // ── Navigation ────────────────────────────────────────────────────────
  function showHome() {
    inChat = false;
    homeView.classList.remove('hidden');
    chatView.classList.add('hidden');
  }

  function showChat() {
    inChat = true;
    homeView.classList.add('hidden');
    chatView.classList.remove('hidden');
    scrollBottom();
  }

  // ── Render messages ───────────────────────────────────────────────────
  function renderMessages() {
    if (!chatHistory.length) {
      messages.innerHTML =
        '<div class="empty fadein">' +
        '<div class="empty-icon">&#9889;</div>' +
        '<div class="empty-h">Ready to help</div>' +
        '<div class="empty-p">Describe what you want to build or fix</div></div>';
      return;
    }
    messages.innerHTML = '';
    for (const m of chatHistory) {
      const div = document.createElement('div');
      const role = m.role === 'assistant' ? 'agent' : m.role;
      div.className = 'msg ' + role + ' fadein';
      let html = esc(m.text ?? m.content ?? '');
      // Minimal markdown: fenced code blocks then inline code
      html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre>$1</pre>');
      html = html.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
      html = html.replace(/\\n/g, '<br>');
      const rawTs = m.ts ?? m.createdAt ?? null;
      const ts = rawTs ? relTime(new Date(rawTs).toISOString()) : '';
      div.innerHTML =
        '<div class="bubble">' + html + '</div>' +
        '<div class="msg-time">' + esc(ts) + '</div>';
      messages.appendChild(div);
    }
  }

  function renderAttachments(files) {
    attachedFiles = Array.isArray(files) ? files.slice() : [];
    if (!attachmentRow) return;
    if (!attachedFiles.length) {
      attachmentRow.innerHTML =
        '<span class="attachment-label">Attached</span>' +
        '<span class="attachment-empty">No files attached</span>';
      return;
    }

    attachmentRow.innerHTML =
      '<span class="attachment-label">Attached</span>' +
      attachedFiles.map(function(filePath) {
        return '<span class="chip" title="' + esc(filePath) + '">' + esc(filePath) + '</span>';
      }).join('');
  }

  // ── Render session list ───────────────────────────────────────────────
  function renderSessions(list) {
    list = list || [];
    if (!list.length) {
      sessionList.innerHTML =
        '<div class="empty"><div class="empty-icon">&#128172;</div>' +
        '<div class="empty-h">No conversations yet</div>' +
        '<div class="empty-p">Type a task below to begin</div></div>';
      return;
    }
    sessionList.innerHTML = '';
    for (const s of list) {
      const d = document.createElement('div');
      d.className = 'sitem';
      d.dataset.sessionId = String(s.id || '');
      d.innerHTML =
        '<span class="sitem-title">' + esc(s.title || s.id) + '</span>' +
        '<div class="session-actions">' +
          '<div class="session-meta">' +
            '<span class="sitem-time">'  + esc(relTime(s.updatedAt)) + '</span>' +
            '<span class="session-count">' + esc(String(s.messageCount || 0)) + ' msg' + (Number(s.messageCount) === 1 ? '' : 's') + (Number(s.attachmentCount) ? ', ' + Number(s.attachmentCount) + ' attach' + (Number(s.attachmentCount) === 1 ? '' : 'ments') : '') + '</span>' +
          '</div>' +
          '<button type="button" class="session-delete" title="Delete conversation" aria-label="Delete conversation">&#128465;</button>' +
        '</div>';
      d.addEventListener('click', function() {
        if (s.id) {
          vscode.postMessage({ type: 'openSession', payload: s.id });
        }
      });
      const deleteButton = d.querySelector('.session-delete');
      deleteButton.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ type: 'deleteSessionRequest', payload: s.id });
      });
      sessionList.appendChild(d);
    }
  }

  function renderLoadedSession(session) {
    if (!session) return;
    attachedFiles = session.attachedFiles || [];
    renderAttachments(attachedFiles);
    if (Array.isArray(session.messages) && session.messages.length > 0) {
      chatHistory = session.messages.map(function(message) {
        return {
          role: message.role,
          content: message.content,
          ts: message.createdAt,
        };
      });
    } else {
      chatHistory = [{
        role: 'user',
        text: session.objective || session.title || 'Session',
        ts: session.updatedAt || Date.now(),
      }];

      if (session.lastResult) {
        chatHistory.push({
          role: 'assistant',
          text: session.lastResult,
          ts: session.updatedAt || Date.now(),
        });
      }
    }

    renderMessages();
    showChat();
    statusLine.textContent = 'Loaded session';
  }

  function handleSessionDeleted(payload) {
    if (payload && payload.wasActive) {
      chatHistory = [];
      attachedFiles = [];
      renderAttachments(attachedFiles);
      renderMessages();
      showHome();
      statusLine.textContent = 'Deleted conversation';
    }
  }

  // ── Render runtime summary ────────────────────────────────────────────
  function renderSummary(s) {
    summary = s;
    const ok = s && (Boolean(s.ollamaReachable) || s.status === 'ready');
    statusBadge.className = 'badge ' + (ok ? 'on' : 'off');
    statusTxt.textContent  = ok ? 'Online' : 'Offline';

    const model = (s && s.plannerModel) || '';
    chipModel.textContent = model.split(':')[0].slice(0, 14) || '\u2013';
    chipModel.title       = 'Planner: ' + (model || 'none');
    chipMode.textContent  = (s && s.approvalMode) || 'balanced';

    const hasPending = s && s.hasPendingEdits;
    editsBanner.classList.toggle('on', Boolean(hasPending));
    if (hasPending) bannerTxt.textContent = 'Pending file edits \u2014 review before applying';

    const pct = (s && Number.isFinite(s.tokenUsagePercent))
      ? Math.max(0, Math.min(100, s.tokenUsagePercent)) : 0;
    tokenRing.style.background =
      'conic-gradient(var(--amber) ' + (pct * 3.6) + 'deg, rgba(128,128,128,.18) 0deg)';
    tokenValue.textContent = pct + '%';
    tokenLabel.textContent = ((s && s.tokensConsumed) || 0) + ' / ' + ((s && s.tokenBudget) || 0);

    if (ok) {
      statusLine.textContent = (s && s.modelCount)
        ? s.modelCount + ' model' + (s.modelCount !== 1 ? 's' : '') +
          ', MCP ' + ((s && s.mcpHealthy) || 0) + '/' + ((s && s.mcpConfigured) || 0)
        : 'Ollama ready';
    } else {
      statusLine.textContent = 'Ollama offline \u2014 check settings';
    }
  }

  // ── Update model dropdown ─────────────────────────────────────────────
  function updateModels(list) {
    models = list || [];
    const prev = modelSelect.value;
    modelSelect.innerHTML = '';
    if (!models.length) {
      modelSelect.innerHTML = '<option value="">No models found</option>';
      return;
    }
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.name; o.text = m.name;
      modelSelect.appendChild(o);
    }
    if (models.some(function(m) { return m.name === prev; })) modelSelect.value = prev;
  }

  // ── Send task ─────────────────────────────────────────────────────────
  function sendTask() {
    const text = taskInput.value.trim();
    if (!text) return;

    taskInput.value = '';
    taskInput.style.height = 'auto';
    btnSend.disabled = true;

    chatHistory.push({ role: 'user', text: text, ts: Date.now() });
    renderMessages();
    showChat();

    typing.classList.add('on');
    scrollBottom();
    statusLine.textContent = 'Thinking\u2026';

    vscode.postMessage({ type: 'runTask', payload: text });
  }

  // ── Event listeners ───────────────────────────────────────────────────
  on(taskInput, 'input', function() {
    autoGrow(taskInput);
    btnSend.disabled = taskInput.value.trim().length === 0;
  });

  on(taskInput, 'keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTask(); }
  });

  on(btnSend, 'click', sendTask);

  on(btnNewChat, 'click', function() {
    chatHistory = [];
    attachedFiles = [];
    renderAttachments(attachedFiles);
    renderMessages();
    showChat();
    vscode.postMessage({ type: 'newConversation' });
    taskInput.focus();
  });

  on(btnBack,     'click', showHome);
  on(btnAttach,   'click', function() { vscode.postMessage({ type: 'attachContext' }); });
  on(btnSettings, 'click', function() { settingsDrawer.classList.toggle('open'); });
  on(btnRefresh,  'click', function() { vscode.postMessage({ type: 'ping' }); });

  on(btnSyncModels, 'click', function() { vscode.postMessage({ type: 'refreshModels' }); });

  on(btnAddMcp, 'click', function() {
    mcpServers = snapshotMcpServers().concat([normalizeMcpServer({ enabled: true, trust: 'workspace', transport: 'stdio', args: [] })]);
    renderMcpServers(mcpServers);
  });

  on(btnReloadMcp,       'click', function() { vscode.postMessage({ type: 'reloadMcpServers' }); });
  on(btnOpenMcpSettings, 'click', function() { vscode.postMessage({ type: 'configureMcpServers' }); });
  on(btnManageMcp,       'click', function() { vscode.postMessage({ type: 'manageMcpConnections' }); });

  on(btnSaveMcp, 'click', function() {
    try {
      vscode.postMessage({ type: 'saveMcpServers', payload: collectMcpServers() });
    } catch (e) {
      statusLine.textContent = 'Error: ' + (e instanceof Error ? e.message : String(e));
    }
  });

  on(btnApplyModel, 'click', function() {
    const role  = roleSelect.value;
    const model = modelSelect.value;
    if (model) vscode.postMessage({ type: 'setModel', payload: { role: role, model: model } });
  });

  on(chipMode, 'click', function() {
    const modes = ['strict','balanced','fast'];
    const idx   = modes.indexOf((summary && summary.approvalMode) || 'balanced');
    vscode.postMessage({ type: 'setApprovalMode', payload: modes[(idx + 1) % modes.length] });
  });

  // Two-step confirmation (window.confirm is blocked in VS Code webviews)
  let applyPending = false, revertPending = false;
  function resetBannerBtns() {
    applyPending  = false; revertPending = false;
    btnApply.textContent  = 'Apply';  btnApply.className  = 'btn primary sm';
    btnRevert.textContent = 'Revert'; btnRevert.className = 'btn danger sm';
  }

  on(btnApply, 'click', function() {
    if (!applyPending) { applyPending = true; btnApply.textContent = 'Confirm apply?'; return; }
    resetBannerBtns();
    vscode.postMessage({ type: 'applyPending', payload: true });
  });

  on(btnRevert, 'click', function() {
    if (!revertPending) { revertPending = true; btnRevert.textContent = 'Confirm revert?'; return; }
    resetBannerBtns();
    vscode.postMessage({ type: 'revertLast', payload: true });
  });

  // ── Message handler ───────────────────────────────────────────────────
  window.addEventListener('message', function(event) {
    const data = event.data || {};
    const type    = data.type;
    const payload = data.payload;

    if (type === 'runtimeSummary') { renderSummary(payload); return; }
    if (type === 'models')         { updateModels(payload); return; }
    if (type === 'mcpServers')     { renderMcpServers(payload); return; }
    if (type === 'sessions')       { renderSessions(payload); return; }
    if (type === 'sessionLoaded')  { renderLoadedSession(payload); return; }
    if (type === 'sessionDeleted') { handleSessionDeleted(payload); return; }
    if (type === 'sessionAttachments') { renderAttachments(payload); return; }

    if (type === 'taskResult') {
      typing.classList.remove('on');
      const text = (payload && payload.responseText) || JSON.stringify(payload, null, 2);
      chatHistory.push({ role: 'agent', text: text, ts: Date.now() });
      renderMessages();
      scrollBottom();
      statusLine.textContent = (payload && payload.proposedEdits)
        ? payload.proposedEdits + ' file edit(s) pending'
        : 'Done';
      vscode.postMessage({ type: 'ping' });
      return;
    }

    if (type === 'actionResult') {
      typing.classList.remove('on');
      chatHistory.push({ role: 'agent', text: String(payload), ts: Date.now() });
      renderMessages();
      scrollBottom();
      const txt = String(payload || 'Done');
      const isError = txt.toLowerCase().indexOf('error:') === 0;
      statusLine.textContent = isError ? txt.slice(0, 60) : 'Done';
      if (!isError) { vscode.postMessage({ type: 'ping' }); }
      return;
    }
  });

    // ── Bootstrap: signal ready, request state, then auto-refresh ──────
    if (initialSummary) {
      renderSummary(initialSummary);
    }

    window.addEventListener('error', function(event) {
      const message = event && event.error
        ? String(event.error.stack || event.error.message || event.error)
        : String(event.message || 'Unknown webview error');
      surfaceFatalError(message);
    });

    window.addEventListener('unhandledrejection', function(event) {
      const message = String(
        event && event.reason
          ? (event.reason.stack || event.reason.message || event.reason)
          : 'Unhandled rejection',
      );
      surfaceFatalError(message);
    });

    vscode.postMessage({ type: 'webviewReady' });
    vscode.postMessage({ type: 'loadDashboard' });
    // Retry shortly in case the initial messages were lost due to timing
    setTimeout(function() {
      if (!summary) { vscode.postMessage({ type: 'ping' }); }
    }, 800);
    setTimeout(function() {
      if (!summary) { vscode.postMessage({ type: 'ping' }); }
    }, 3000);
    setInterval(function() { vscode.postMessage({ type: 'ping' }); }, 30000);
  } catch (error) {
    surfaceFatalError(
      error instanceof Error ? error.stack || error.message : String(error),
    );
  }

}());
</script>
</body>
</html>`;
  }
}
