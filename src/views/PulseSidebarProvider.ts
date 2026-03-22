import * as vscode from "vscode";

import type { AgentRuntime } from "../agent/runtime/AgentRuntime";
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

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async (message: { type?: string; payload?: unknown }) => {
        try {
          if (message.type === "loadDashboard") {
            const summary = await this.runtime.summary();
            const sessions = await this.runtime.listRecentSessions();
            const mcpServers = this.runtime.getConfiguredMcpServers();
            await webviewView.webview.postMessage({
              type: "runtimeSummary",
              payload: summary,
            });
            await webviewView.webview.postMessage({
              type: "sessions",
              payload: sessions,
            });
            await webviewView.webview.postMessage({
              type: "mcpServers",
              payload: mcpServers,
            });

            if (summary.ollamaHealth.toLowerCase().includes("reachable")) {
              const models = await this.runtime.listAvailableModels();
              await webviewView.webview.postMessage({
                type: "models",
                payload: models,
              });
            }
            return;
          }

          if (message.type === "ping") {
            const summary = await this.runtime.summary();
            await webviewView.webview.postMessage({
              type: "runtimeSummary",
              payload: summary,
            });
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
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    const csp = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <style>
    /* ─── Reset ─────────────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    /* ─── Tokens ─────────────────────────────────────────────────── */
    :root {
      --amber:      #f59e0b;
      --amber-bg:   rgba(245,158,11,0.12);
      --amber-bdr:  rgba(245,158,11,0.30);
      --green:      #22c55e;
      --green-bg:   rgba(34,197,94,0.10);
      --green-bdr:  rgba(34,197,94,0.28);
      --red:        var(--vscode-errorForeground, #f87171);
      --red-bg:     rgba(248,113,113,0.08);
      --red-bdr:    rgba(248,113,113,0.28);
      --r-sm: 8px;
      --r-md: 14px;
      --r-lg: 20px;
      --spd: 180ms;
    }

    /* ─── Layout ─────────────────────────────────────────────────── */
    html, body {
      height: 100%;
      font-family: var(--vscode-font-family, "Segoe UI", system-ui, sans-serif);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      overflow: hidden;
    }

    #root {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    /* ─── Header ─────────────────────────────────────────────────── */
    .hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px 9px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.18));
      flex-shrink: 0;
    }

    .hdr-left { display: flex; align-items: center; gap: 7px; }

    .brand {
      font-size: 13px; font-weight: 700;
      letter-spacing: 0.8px; text-transform: uppercase;
    }

    .hdr-right { display: flex; align-items: center; gap: 6px; }

    .badge {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 11px; font-weight: 600;
      padding: 2px 8px; border-radius: 999px; border: 1px solid;
    }
    .badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .badge.on  { color: var(--green); border-color: var(--green-bdr); background: var(--green-bg); }
    .badge.off { color: var(--red);   border-color: var(--red-bdr);   background: var(--red-bg); }

    .icon-btn {
      width: 26px; height: 26px;
      border: none; background: transparent;
      color: var(--vscode-foreground); opacity: .55;
      cursor: pointer; border-radius: var(--r-sm);
      display: flex; align-items: center; justify-content: center;
      font-size: 15px; transition: opacity var(--spd), background var(--spd);
    }
    .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.14)); }

    /* ─── Settings drawer ───────────────────────────────────────── */
    #settingsDrawer {
      display: none; flex-direction: column; gap: 8px;
      padding: 10px 12px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.18));
      flex-shrink: 0; background: var(--vscode-sideBar-background);
    }
    #settingsDrawer.open { display: flex; }

    .srow { display: grid; grid-template-columns: 68px 1fr; align-items: center; gap: 8px; }

    .slabel {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .5px; color: var(--vscode-descriptionForeground);
    }

    input[type="text"], select, textarea {
      width: 100%;
      padding: 5px 7px;
      border-radius: var(--r-sm);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,.2));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font: 12px var(--vscode-font-family);
    }

    input[type="text"]::placeholder, textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    select { cursor: pointer; }

    textarea {
      resize: vertical;
      min-height: 38px;
    }

    .sbtns { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }

    .section {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.12));
    }

    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .section-copy {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.45;
    }

    .mcp-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }

    .mcp-count {
      margin-left: auto;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .6px;
      color: var(--vscode-descriptionForeground);
    }

    .mcp-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 230px;
      overflow: auto;
      padding-right: 2px;
    }

    .mcp-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      border-radius: var(--r-md);
      border: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.18));
      background: linear-gradient(180deg, rgba(128,128,128,.04), rgba(128,128,128,.01));
    }

    .mcp-card-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .mcp-card-title { flex: 1; min-width: 0; }

    .mcp-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.18));
      font-size: 10px;
      font-weight: 700;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: .5px;
    }

    .mcp-grid {
      display: grid;
      grid-template-columns: 1fr 130px;
      gap: 6px;
    }

    .mcp-grid.triple {
      grid-template-columns: 1fr 1fr 1fr;
    }

    .mcp-note {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.35;
    }

    .mcp-empty {
      padding: 12px;
      border-radius: var(--r-md);
      border: 1px dashed var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.22));
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-align: center;
    }

    /* ─── Main scroll area ─────────────────────────────────────── */
    #main {
      flex: 1; overflow-y: auto; overflow-x: hidden;
      scroll-behavior: smooth;
    }

    /* ─── Home view ─────────────────────────────────────────────── */
    #homeView { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    #homeView.hidden, #chatView.hidden { display: none; }

    .new-btn {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; padding: 10px 14px;
      border-radius: var(--r-md);
      border: 1.5px dashed var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.25));
      background: transparent;
      color: var(--vscode-foreground);
      font: 600 13px var(--vscode-font-family); cursor: pointer; opacity: .65;
      transition: all var(--spd);
    }
    .new-btn:hover { opacity: 1; border-style: solid; border-color: var(--amber); background: var(--amber-bg); }

    .sec-title {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .7px; color: var(--vscode-descriptionForeground);
      padding: 0 2px;
    }

    .sessions {
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.14));
    }

    .sitem {
      display: flex; align-items: center; justify-content: space-between;
      padding: 9px 4px; cursor: pointer;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.1));
      border-radius: var(--r-sm); transition: background var(--spd);
    }
    .sitem:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.08)); }

    .sitem-title {
      font-size: 13px; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;
    }
    .sitem-time {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      margin-left: 8px; flex-shrink: 0;
    }

    /* ─── Chat view ─────────────────────────────────────────────── */
    #chatView { padding: 10px 12px 4px; display: flex; flex-direction: column; gap: 10px; }

    .back-btn {
      display: inline-flex; align-items: center; gap: 4px;
      border: none; background: none;
      color: var(--amber); font: 600 11px var(--vscode-font-family);
      cursor: pointer; opacity: .8; padding: 0 0 2px; width: fit-content;
    }
    .back-btn:hover { opacity: 1; }

    /* ─── Message bubbles ───────────────────────────────────────── */
    #messages { display: flex; flex-direction: column; gap: 10px; }

    .msg { max-width: 88%; }
    .msg.user  { align-self: flex-end; }
    .msg.agent { align-self: flex-start; }

    .bubble {
      padding: 9px 13px; border-radius: var(--r-md);
      line-height: 1.55; font-size: 13px; word-break: break-word;
    }
    .msg.user  .bubble { background: var(--amber); color: #fff; border-bottom-right-radius: 3px; }
    .msg.agent .bubble {
      background: var(--vscode-input-background, rgba(128,128,128,.1));
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,.15));
      border-bottom-left-radius: 3px;
    }

    .bubble code {
      font-family: var(--vscode-editor-font-family, "Cascadia Code", monospace);
      font-size: 11.5px;
      background: rgba(0,0,0,.16);
      padding: 1px 5px; border-radius: 4px;
    }
    .bubble pre {
      font-family: var(--vscode-editor-font-family, "Cascadia Code", monospace);
      font-size: 11.5px; line-height: 1.45;
      background: rgba(0,0,0,.18); border-radius: var(--r-sm);
      padding: 9px 11px; margin: 7px 0;
      overflow-x: auto; white-space: pre-wrap;
    }

    .msg-time {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      margin-top: 3px; padding: 0 2px;
    }
    .msg.user .msg-time { text-align: right; }

    /* ─── Typing indicator ──────────────────────────────────────── */
    #typing { align-self: flex-start; display: none; }
    #typing.on { display: block; }

    .typing-bubble {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 10px 13px; border-radius: var(--r-md); border-bottom-left-radius: 3px;
      background: var(--vscode-input-background, rgba(128,128,128,.1));
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,.15));
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

    /* ─── Empty state ───────────────────────────────────────────── */
    .empty {
      text-align: center; padding: 28px 12px;
      color: var(--vscode-descriptionForeground);
    }
    .empty-icon { font-size: 28px; margin-bottom: 8px; opacity: .45; }
    .empty-h { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
    .empty-p { font-size: 12px; opacity: .7; }

    /* ─── Pending edits banner ──────────────────────────────────── */
    #editsBanner {
      display: none; margin: 4px 12px 0;
      padding: 9px 11px; border-radius: var(--r-md);
      background: var(--amber-bg); border: 1px solid var(--amber-bdr);
      align-items: center; justify-content: space-between; gap: 8px;
      flex-shrink: 0;
    }
    #editsBanner.on { display: flex; }

    .banner-txt { font-size: 12px; font-weight: 600; color: var(--amber); flex: 1; }
    .banner-acts { display: flex; gap: 5px; }

    /* ─── Composer ──────────────────────────────────────────────── */
    .composer {
      padding: 8px 12px 12px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.18));
      flex-shrink: 0;
    }

    .input-shell {
      display: flex; align-items: flex-end; gap: 8px;
      padding: 7px 9px;
      border-radius: var(--r-lg);
      border: 1.5px solid var(--vscode-input-border, rgba(128,128,128,.22));
      background: var(--vscode-input-background);
      transition: border-color var(--spd);
    }
    .input-shell:focus-within { border-color: var(--amber); }

    textarea {
      flex: 1; border: none; background: none; outline: none;
      color: var(--vscode-input-foreground);
      font: 13px var(--vscode-font-family);
      resize: none; min-height: 21px; max-height: 96px; line-height: 1.5;
      overflow-y: auto;
    }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }

    .send-btn {
      width: 30px; height: 30px; min-width: 30px;
      border: none; border-radius: 50%;
      background: var(--amber); color: #fff;
      font-size: 15px; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      opacity: .35; transition: opacity var(--spd), transform var(--spd), background var(--spd);
    }
    .send-btn.active { opacity: 1; }
    .send-btn.active:hover { background: #d97706; transform: scale(1.08); }

    .meta { display: flex; align-items: center; justify-content: space-between; padding: 5px 1px 0; }
    .chips { display: flex; gap: 5px; }

    .token-row { display: flex; justify-content: flex-end; padding: 6px 2px 0; }
    .token-wrap { display: inline-flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .token-ring {
      width: 26px; height: 26px; border-radius: 50%;
      background: conic-gradient(var(--amber) 0deg, rgba(128,128,128,.18) 0deg);
      display: inline-flex; align-items: center; justify-content: center; position: relative;
    }
    .token-ring::after {
      content: ""; position: absolute; width: 18px; height: 18px; border-radius: 50%;
      background: var(--vscode-sideBar-background);
    }
    .token-value { position: relative; z-index: 1; font-size: 8.5px; font-weight: 700; color: var(--vscode-foreground); }

    .chip {
      font-size: 10px; font-weight: 600;
      padding: 2px 7px; border-radius: 999px;
      border: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.2));
      color: var(--vscode-descriptionForeground);
      cursor: pointer; white-space: nowrap;
      max-width: 110px; overflow: hidden; text-overflow: ellipsis;
      transition: all var(--spd);
    }
    .chip:hover { border-color: var(--amber); color: var(--amber); background: var(--amber-bg); }

    .status-txt { font-size: 10px; color: var(--vscode-descriptionForeground); }

    /* ─── Generic buttons ───────────────────────────────────────── */
    .btn {
      font: 600 11px var(--vscode-font-family);
      padding: 5px 10px; border-radius: var(--r-sm);
      border: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.22));
      background: transparent; color: var(--vscode-foreground);
      cursor: pointer; transition: all var(--spd);
    }
    .btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.12)); }
    .btn.primary { background: var(--amber); border-color: var(--amber); color: #fff; }
    .btn.primary:hover { background: #d97706; border-color: #d97706; }
    .btn.danger  { color: var(--red); border-color: var(--red-bdr); }
    .btn.danger:hover  { background: var(--red-bg); }
    .btn.sm { padding: 4px 8px; font-size: 11px; }

    /* ─── Animations ───────────────────────────────────────────── */
    @keyframes fadein {
      from { opacity: 0; transform: translateY(5px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .fadein { animation: fadein 240ms ease forwards; }

    /* ─── Scrollbar ────────────────────────────────────────────── */
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(128,128,128,.28); border-radius: 99px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,.5); }
  </style>
</head>
<body>
<div id="root">

  <!-- ── Header ──────────────────────────────────────────────── -->
  <header class="hdr">
    <div class="hdr-left">
      <span class="brand">Workspace Agent</span>
    </div>
    <div class="hdr-right">
      <span id="statusBadge" class="badge off">
        <span class="badge-dot"></span><span id="statusTxt">Offline</span>
      </span>
      <button id="btnSettings" class="icon-btn" title="Model and MCP settings">&#9881;</button>
      <button id="btnRefresh"  class="icon-btn" title="Refresh">&#8635;</button>
    </div>
  </header>

  <!-- ── Settings drawer ─────────────────────────────────────── -->
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
        Edit servers inline, save to workspace settings, then use the status report to verify transport health.
      </div>
      <div class="mcp-toolbar">
        <button id="btnAddMcp" class="btn">Add server</button>
        <button id="btnReloadMcp" class="btn">Reload</button>
        <button id="btnSaveMcp" class="btn primary">Save changes</button>
        <button id="btnOpenMcpSettings" class="btn">Open settings</button>
        <button id="btnManageMcp" class="btn">View status</button>
      </div>
      <div id="mcpList" class="mcp-list"></div>
      <div class="mcp-note">Stdio servers use a command and optional args. HTTP/SSE servers use a URL.</div>
    </div>
  </div>

  <!-- ── Main scrollable area ────────────────────────────────── -->
  <div id="main">

    <!-- Home view -->
    <div id="homeView">
      <div style="padding:12px; display:flex; flex-direction:column; gap:10px;">
        <button id="btnNewChat" class="new-btn">
          <span style="font-size:16px; line-height:1;">+</span> New conversation
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
    </div>

    <!-- Chat view -->
    <div id="chatView" class="hidden">
      <div style="padding:10px 12px 4px; display:flex; flex-direction:column; gap:10px;">
        <button id="btnBack" class="back-btn">&#8592; Back</button>
        <div id="messages"></div>
        <div id="typing">
          <div class="typing-bubble">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          </div>
        </div>
      </div>
    </div>

  </div><!-- /main -->

  <!-- ── Pending edits banner ────────────────────────────────── -->
  <div id="editsBanner">
    <span id="bannerTxt" class="banner-txt">Pending edits ready</span>
    <div class="banner-acts">
      <button id="btnApply"  class="btn primary sm">Apply</button>
      <button id="btnRevert" class="btn danger sm">Revert</button>
    </div>
  </div>

  <!-- ── Composer ────────────────────────────────────────────── -->
  <div class="composer">
    <div class="input-shell">
      <textarea id="taskInput" placeholder="Ask Pulse anything about your code…" rows="1"></textarea>
      <button id="btnSend" class="send-btn" title="Send  (Enter)">&#8593;</button>
    </div>
    <div class="meta">
      <div class="chips">
        <span id="chipModel" class="chip" title="Active planner model">–</span>
        <span id="chipMode"  class="chip" title="Click to cycle approval mode">balanced</span>
      </div>
      <span id="statusLine" class="status-txt">Ready</span>
    </div>
    <div class="token-row">
      <div class="token-wrap" title="Token usage in this Pulse runtime session">
        <span id="tokenRing" class="token-ring"><span id="tokenValue" class="token-value">0%</span></span>
        <span id="tokenLabel">0 / 0</span>
      </div>
    </div>
  </div>

</div><!-- /root -->

<script nonce="${nonce}">
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  // ── Element refs ──────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const statusBadge  = $('statusBadge');
  const statusTxt    = $('statusTxt');
  const btnSettings  = $('btnSettings');
  const btnRefresh   = $('btnRefresh');
  const settingsDrawer = $('settingsDrawer');
  const roleSelect   = $('roleSelect');
  const modelSelect  = $('modelSelect');
  const btnSyncModels= $('btnSyncModels');
  const btnApplyModel= $('btnApplyModel');
  const btnAddMcp    = $('btnAddMcp');
  const btnReloadMcp = $('btnReloadMcp');
  const btnSaveMcp   = $('btnSaveMcp');
  const btnOpenMcpSettings = $('btnOpenMcpSettings');
  const btnManageMcp = $('btnManageMcp');
  const mcpList      = $('mcpList');
  const mcpCount     = $('mcpCount');
  const homeView     = $('homeView');
  const chatView     = $('chatView');
  const btnNewChat   = $('btnNewChat');
  const btnBack      = $('btnBack');
  const sessionList  = $('sessionList');
  const messages     = $('messages');
  const typing       = $('typing');
  const editsBanner  = $('editsBanner');
  const bannerTxt    = $('bannerTxt');
  const btnApply     = $('btnApply');
  const btnRevert    = $('btnRevert');
  const taskInput    = $('taskInput');
  const btnSend      = $('btnSend');
  const chipModel    = $('chipModel');
  const chipMode     = $('chipMode');
  const statusLine   = $('statusLine');
  const tokenRing    = $('tokenRing');
  const tokenValue   = $('tokenValue');
  const tokenLabel   = $('tokenLabel');

  // ── State ─────────────────────────────────────────────────────────────
  let summary  = null;
  let models   = [];
  let mcpServers = [];
  let history  = [];   // { role:'user'|'agent', text:string, ts:number }
  let inChat   = false;

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
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 96) + 'px';
  }

  function scrollBottom() {
    requestAnimationFrame(() => { $('main').scrollTop = 9999999; });
  }

  function normalizeMcpServer(server) {
    const transport = String(server?.transport || 'stdio');
    const args = Array.isArray(server?.args)
      ? server.args.map((item) => String(item))
      : typeof server?.args === 'string'
        ? server.args.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
        : [];

    return {
      id: String(server?.id || ''),
      enabled: server?.enabled !== false,
      trust: String(server?.trust || 'workspace'),
      transport,
      command: String(server?.command || ''),
      url: String(server?.url || ''),
      args,
    };
  }

  function parseArgs(text) {
    const raw = String(text || '').trim();
    if (!raw) {
      return [];
    }

    if (raw.startsWith('[')) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error('Arguments must be a JSON array or one argument per line.');
      }
      return parsed.map((item) => String(item));
    }

    return raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }

  function renderMcpServers(list) {
    mcpServers = (list || []).map(normalizeMcpServer);
    mcpCount.textContent = mcpServers.length === 1 ? '1 configured' : mcpServers.length + ' configured';

    if (!mcpServers.length) {
      mcpList.innerHTML = '<div class="mcp-empty fadein">No MCP servers yet. Add one to connect Pulse to tools, resources, and prompts.</div>';
      return;
    }

    mcpList.innerHTML = '';
    mcpServers.forEach((server, index) => {
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
        '  <div class="mcp-card-title">',
        '    <input type="text" data-field="id" placeholder="filesystem" value="' + esc(server.id) + '" />',
        '  </div>',
        '  <label class="mcp-chip" title="Enable or disable this server">',
        '    <input type="checkbox" data-field="enabled" ' + (server.enabled ? 'checked' : '') + ' />',
        '    Enabled',
        '  </label>',
        '  <button type="button" class="btn danger sm" data-action="remove">Remove</button>',
        '</div>',
        '<div class="mcp-grid triple">',
        '  <select data-field="transport">',
        '    <option value="stdio">stdio</option>',
        '    <option value="http">http</option>',
        '    <option value="sse">sse</option>',
        '  </select>',
        '  <select data-field="trust">',
        '    <option value="workspace">workspace</option>',
        '    <option value="user">user</option>',
        '    <option value="system">system</option>',
        '  </select>',
        '  <div class="mcp-chip">' + esc(endpointLabel) + '</div>',
        '</div>',
        '<input type="text" data-field="endpoint" placeholder="' + esc(endpointLabel) + '" value="' + esc(endpointValue) + '" />',
        '<textarea data-field="args" placeholder="[&quot;-y&quot;, &quot;@modelcontextprotocol/server-filesystem&quot;, &quot;\${workspaceFolder}&quot;]">' + esc((server.args || []).join('\n')) + '</textarea>',
        '<div class="mcp-note">' + esc(note) + '</div>',
      ].join('');

      const transportSelect = card.querySelector('select[data-field="transport"]');
      const trustSelect = card.querySelector('select[data-field="trust"]');
      const endpointInput = card.querySelector('input[data-field="endpoint"]');
      const argsInput = card.querySelector('textarea[data-field="args"]');
      const enabledInput = card.querySelector('input[data-field="enabled"]');
      transportSelect.value = server.transport;
      trustSelect.value = server.trust;

      const syncEndpointState = () => {
        const isStdio = transportSelect.value === 'stdio';
        endpointInput.placeholder = isStdio ? 'Command' : 'URL';
        argsInput.style.display = isStdio ? 'block' : 'none';
      };

      transportSelect.addEventListener('change', syncEndpointState);
      syncEndpointState();

      card._read = () => ({
        id: String(card.querySelector('input[data-field="id"]').value || '').trim(),
        enabled: Boolean(enabledInput.checked),
        trust: String(trustSelect.value || 'workspace'),
        transport: String(transportSelect.value || 'stdio'),
        command: String(transportSelect.value === 'stdio' ? endpointInput.value || '' : ''),
        url: String(transportSelect.value === 'stdio' ? '' : endpointInput.value || ''),
        args: parseArgs(String(argsInput.value || '')),
      });

      card.querySelector('[data-action="remove"]').addEventListener('click', () => {
        const currentServers = snapshotMcpServers();
        currentServers.splice(index, 1);
        renderMcpServers(currentServers);
      });

      mcpList.appendChild(card);
    });
  }

  function collectMcpServers() {
    const cards = [...mcpList.querySelectorAll('.mcp-card')];
    const collected = [];

    for (const card of cards) {
      const reader = card._read;
      if (typeof reader !== 'function') {
        continue;
      }

      const server = reader();
      if (!server.id) {
        continue;
      }

      if (server.transport === 'stdio' && !server.command) {
        throw new Error('Each stdio MCP server needs a command.');
      }

      if ((server.transport === 'http' || server.transport === 'sse') && !server.url) {
        throw new Error('Each HTTP or SSE MCP server needs a URL.');
      }

      collected.push(server);
    }

    return collected;
  }

  function snapshotMcpServers() {
    const cards = [...mcpList.querySelectorAll('.mcp-card')];
    return cards
      .map((card) => (typeof card._read === 'function' ? card._read() : null))
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
    if (!history.length) {
      messages.innerHTML =
        '<div class="empty fadein">' +
        '<div class="empty-icon">&#9889;</div>' +
        '<div class="empty-h">Ready to help</div>' +
        '<div class="empty-p">Describe what you want to build or fix</div></div>';
      return;
    }
    messages.innerHTML = '';
    for (const m of history) {
      const div = document.createElement('div');
      div.className = 'msg ' + m.role + ' fadein';

      // Minimal markdown: fenced code blocks then inline code
      let html = esc(m.text);
      html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre>$1</pre>');
      html = html.replace(/\`([^\`\\n]+)\`/g,
        '<code>$1</code>');
      html = html.replace(/\\n/g, '<br>');

      const ts = m.ts ? relTime(new Date(m.ts).toISOString()) : '';
      div.innerHTML =
        '<div class="bubble">' + html + '</div>' +
        '<div class="msg-time">' + esc(ts) + '</div>';
      messages.appendChild(div);
    }
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
      d.innerHTML =
        '<span class="sitem-title">' + esc(s.title || s.id) + '</span>' +
        '<span class="sitem-time">'  + esc(relTime(s.updatedAt)) + '</span>';
      sessionList.appendChild(d);
    }
  }

  // ── Render summary ────────────────────────────────────────────────────
  function renderSummary(s) {
    summary = s;
    const ok = String(s?.ollamaHealth || '').toLowerCase().includes('reachable');
    statusBadge.className = 'badge ' + (ok ? 'on' : 'off');
    statusTxt.textContent  = ok ? 'Online' : 'Offline';

    const model = s?.plannerModel || '';
    chipModel.textContent = model.split(':')[0].slice(0, 14) || '–';
    chipModel.title = 'Planner: ' + (model || 'none');
    chipMode.textContent = s?.approvalMode || 'balanced';

    const hasPending = !!s?.hasPendingEdits;
    editsBanner.classList.toggle('on', hasPending);
    if (hasPending) bannerTxt.textContent = 'Pending file edits — review before applying';

    const pct = Number.isFinite(s?.tokenUsagePercent)
      ? Math.max(0, Math.min(100, s.tokenUsagePercent))
      : 0;
    tokenRing.style.background =
      'conic-gradient(var(--amber) ' + (pct * 3.6) + 'deg, rgba(128,128,128,.18) 0deg)';
    tokenValue.textContent = pct + '%';
    tokenLabel.textContent = (s?.tokensConsumed ?? 0) + ' / ' + (s?.tokenBudget ?? 0);

    statusLine.textContent = ok
      ? (s?.modelCount
          ? s.modelCount + ' models, MCP ' + (s?.mcpHealthy ?? 0) + '/' + (s?.mcpConfigured ?? 0)
          : 'Ollama ready')
      : 'Ollama offline';
  }

  // ── Update model dropdown ────────────────────────────────────────────
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
    if (models.some(m => m.name === prev)) modelSelect.value = prev;
  }

  // ── Send task ─────────────────────────────────────────────────────────
  function sendTask() {
    const text = taskInput.value.trim();
    if (!text) return;

    taskInput.value = '';
    taskInput.style.height = 'auto';
    btnSend.classList.remove('active');

    history.push({ role: 'user', text, ts: Date.now() });
    renderMessages();
    showChat();

    typing.classList.add('on');
    scrollBottom();
    statusLine.textContent = 'Thinking…';

    vscode.postMessage({ type: 'runTask', payload: text });
  }

  // ── Event listeners ───────────────────────────────────────────────────
  taskInput.addEventListener('input', () => {
    autoGrow(taskInput);
    btnSend.classList.toggle('active', taskInput.value.trim().length > 0);
  });

  taskInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTask(); }
  });

  btnSend.addEventListener('click', sendTask);

  btnNewChat.addEventListener('click', () => {
    history = [];
    renderMessages();
    showChat();
    taskInput.focus();
  });

  btnBack.addEventListener('click', showHome);

  btnSettings.addEventListener('click', () => settingsDrawer.classList.toggle('open'));
  btnRefresh.addEventListener('click',  () => vscode.postMessage({ type: 'loadDashboard' }));

  btnSyncModels.addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));

  btnAddMcp.addEventListener('click', () => {
    mcpServers = [...snapshotMcpServers(), normalizeMcpServer({ enabled: true, trust: 'workspace', transport: 'stdio', args: [] })];
    renderMcpServers(mcpServers);
  });

  btnReloadMcp.addEventListener('click', () => {
    vscode.postMessage({ type: 'reloadMcpServers' });
  });

  btnSaveMcp.addEventListener('click', () => {
    try {
      const collected = collectMcpServers();
      vscode.postMessage({ type: 'saveMcpServers', payload: collected });
    } catch (error) {
      vscode.postMessage({ type: 'actionResult', payload: 'Error: ' + (error instanceof Error ? error.message : String(error)) });
    }
  });

  btnOpenMcpSettings.addEventListener('click', () => {
    vscode.postMessage({ type: 'configureMcpServers' });
  });

  btnManageMcp.addEventListener('click', () => {
    vscode.postMessage({ type: 'manageMcpConnections' });
  });

  btnApplyModel.addEventListener('click', () => {
    const role  = roleSelect.value;
    const model = modelSelect.value;
    if (!model) return;
    vscode.postMessage({ type: 'setModel', payload: { role, model } });
  });

  chipMode.addEventListener('click', () => {
    const modes = ['strict', 'balanced', 'fast'];
    const idx  = modes.indexOf(summary?.approvalMode || 'balanced');
    const next = modes[(idx + 1) % modes.length];
    vscode.postMessage({ type: 'setApprovalMode', payload: next });
  });

  btnApply.addEventListener('click', () => {
    if (!confirm('Apply the pending file edits to your workspace?')) return;
    vscode.postMessage({ type: 'applyPending', payload: true });
  });

  btnRevert.addEventListener('click', () => {
    if (!confirm('Revert the last applied transaction?')) return;
    vscode.postMessage({ type: 'revertLast', payload: true });
  });

  // ── Message handler ───────────────────────────────────────────────────
  window.addEventListener('message', ({ data }) => {
    const { type, payload } = data || {};

    if (type === 'runtimeSummary') renderSummary(payload);

    if (type === 'models') updateModels(payload);

    if (type === 'mcpServers') renderMcpServers(payload);

    if (type === 'sessions') renderSessions(payload);

    if (type === 'taskResult') {
      typing.classList.remove('on');
      const text = payload?.responseText || JSON.stringify(payload, null, 2);
      history.push({ role: 'agent', text, ts: Date.now() });
      renderMessages();
      scrollBottom();
      statusLine.textContent = payload?.proposedEdits
        ? payload.proposedEdits + ' file edit(s) pending'
        : 'Done';
      vscode.postMessage({ type: 'loadDashboard' });
    }

    if (type === 'actionResult') {
      typing.classList.remove('on');
      history.push({ role: 'agent', text: String(payload), ts: Date.now() });
      renderMessages();
      scrollBottom();
      statusLine.textContent = 'Done';
      vscode.postMessage({ type: 'loadDashboard' });
    }
  });

  // ── Bootstrap ─────────────────────────────────────────────────────────
  vscode.postMessage({ type: 'loadDashboard' });
}());
</script>
</body>
</html>`;
  }
}
