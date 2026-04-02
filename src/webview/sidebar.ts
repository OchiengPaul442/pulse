/* ──────────────────────────────────────────────────────────────────────────
 *  Pulse Sidebar Webview — TypeScript Source
 *  Compiled by esbuild → dist/sidebar.js (IIFE, browser target)
 * ────────────────────────────────────────────────────────────────────────── */

// ── VS Code webview API declaration ───────────────────────────────────────
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// ── Interfaces ────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: string;
  text: string;
  content?: string;
  ts: number | string | null;
  isHtml?: boolean;
  fileDiffs?: FileDiff[] | null;
  autoApplied?: boolean;
}

interface FileDiff {
  fileName?: string;
  filePath?: string;
  isNew?: boolean;
  isDelete?: boolean;
  additions?: number;
  deletions?: number;
  hunks?: DiffHunk[];
}

interface DiffHunk {
  lines: DiffLine[];
}

interface DiffLine {
  type: "add" | "remove" | "context";
  oldLine?: number | null;
  newLine?: number | null;
  content: string;
}

interface SessionItem {
  id: string;
  title?: string;
  updatedAt: string;
  messageCount?: number;
}

interface LoadedSession {
  attachedFiles?: string[];
  messages?: Array<{
    id?: string;
    role: string;
    content: string;
    createdAt?: string;
  }>;
  objective?: string;
  title?: string;
  lastResult?: string;
  updatedAt?: string;
}

interface RuntimeSummary {
  ollamaReachable?: boolean;
  status?: string;
  conversationMode?: string;
  permissionMode?: string;
  persona?: string;
  selfLearnEnabled?: boolean;
  uiSummaryVerbosity?: string;
  uiShowSummaryToggle?: boolean;
  plannerModel?: string;
  hasPendingEdits?: boolean;
  pendingEditCount?: number;
  learningProgressPercent?: number;
  tokenUsagePercent?: number;
  activeSessionId?: string | null;
}

interface ModelInfo {
  name: string;
  source?: string;
  supportsVision?: boolean;
}

interface McpServerConfig {
  id: string;
  enabled: boolean;
  trust: string;
  transport: string;
  command: string;
  url: string;
  args: string[];
}

interface ToolDef {
  id: string;
  name: string;
  desc: string;
}

interface ComposeState {
  mode: "new" | "edit" | "retry";
  messageId: string;
  messageIndex: number;
}

interface ThinkingStep {
  kind?: string;
  step?: string;
  detail?: string;
  icon?: string;
  file?: string;
  lineCount?: number;
  linesAdded?: number;
  linesRemoved?: number;
  todos?: TodoItem[];
  files?: FileChangedItem[];
}

interface TodoItem {
  status?: string;
  task?: string;
  title?: string;
  text?: string;
}

interface FileChangedItem {
  path?: string;
  file?: string;
  filePath?: string;
  fileName?: string;
  additions?: number;
  deletions?: number;
  linesAdded?: number;
  linesRemoved?: number;
}

interface PendingRequest {
  action: string;
  messageId: string;
}

// ── Fatal error surface (available before try block) ──────────────────────

function surfaceFatalError(msg: string): void {
  const b = document.getElementById("fatalBanner");
  if (b) {
    b.textContent = msg;
    b.classList.add("on");
  }
}

// ── Main entry ────────────────────────────────────────────────────────────

try {
  const vscode = acquireVsCodeApi();

  const rootEl = document.getElementById("root") as HTMLElement;
  const initialSummary: RuntimeSummary | null = JSON.parse(
    rootEl.dataset.initialSummary || "null",
  );

  const D = (id: string): HTMLElement | null => document.getElementById(id);

  // ── DOM refs ──────────────────────────────────────────────────────────
  const statusBadge = D("statusBadge")!;
  const statusTxt = D("statusTxt")!;
  const btnSettings = D("btnSettings");
  const btnRefresh = D("btnRefresh");
  const btnNewChat = D("btnNewChat");
  const settingsDrawer = D("settingsDrawer")!;
  const personaSelect = D("personaSelect") as HTMLSelectElement | null;
  const modelSelect = D("modelSelect") as HTMLSelectElement;
  const summaryVerbositySelect = D(
    "summaryVerbositySelect",
  ) as HTMLSelectElement | null;
  const compactSummaryToggle = D(
    "compactSummaryToggle",
  ) as HTMLInputElement | null;
  const compactSummaryRow = D("compactSummaryRow");
  const btnSyncModels = D("btnSyncModels");
  const btnApplyModel = D("btnApplyModel");
  const btnAddMcp = D("btnAddMcp");
  const btnReloadMcp = D("btnReloadMcp");
  const btnSaveMcp = D("btnSaveMcp");
  const btnOpenMcpSettings = D("btnOpenMcpSettings");
  const btnManageMcp = D("btnManageMcp");
  const mcpList = D("mcpList")!;
  const mcpCount = D("mcpCount")!;
  const homeView = D("homeView")!;
  const chatView = D("chatView")!;
  const btnBack = D("btnBack");
  const attachmentRow = D("attachmentRow");
  const sessionList = D("sessionList")!;
  const messagesEl = D("messages")!;
  const editsBanner = D("editsBanner")!;
  const bannerTxt = D("bannerTxt")!;
  const btnApply = D("btnApply")!;
  const btnRevert = D("btnRevert")!;
  const chipMode = D("chipMode");
  const chipModel = D("chipModel")!;
  const taskInput = D("taskInput") as HTMLTextAreaElement | null;
  const btnSend = D("btnSend") as HTMLButtonElement;
  const btnAttach = D("btnAttach");
  const permBtn = D("permBtn");
  const permBtnIcon = D("permBtnIcon");
  const permBtnLabel = D("permBtnLabel");
  const scrollBtn = D("scrollBtn");
  const selfLearnToggle = D("selfLearnToggle") as HTMLInputElement | null;
  const learningBadge = D("learningBadge");
  const todoDrawer = D("todoDrawer");
  const todoDrawerList = D("todoDrawerList");
  const todoDrawerCount = D("todoDrawerCount");
  const filesDrawer = D("filesDrawer");
  const filesDrawerList = D("filesDrawerList");
  const filesDrawerCount = D("filesDrawerCount");

  // ── State ─────────────────────────────────────────────────────────────
  let summary: RuntimeSummary | null = null;
  let models: ModelInfo[] = [];
  let mcpServers: McpServerConfig[] = [];
  let chatHistory: ChatMessage[] = [];
  let attachedFiles: string[] = [];
  let conversationMode = "agent";
  let inChat = false;
  let activeModelName = "";
  let permMode = "default";
  let autoRestoreSessionAttempted = false;
  let offlineRetryTimer: ReturnType<typeof setInterval> | null = null;
  let thinkingSteps: ThinkingStep[] = [];
  let thinkingStartTime: number | null = null;
  let modePopupOpen = false;
  let modelPopupOpen = false;
  let permPopupOpen = false;
  let isBusy = false;
  let composeState: ComposeState = {
    mode: "new",
    messageId: "",
    messageIndex: -1,
  };
  let pendingRequest: PendingRequest | null = null;
  let streamBuffer = "";
  let streamBubble: HTMLElement | null = null;
  let streamChunkQueue: string[] = [];
  let streamFlushTimer: ReturnType<typeof setInterval> | null = null;
  let streamRenderBuffer = "";
  let currentTodos: TodoItem[] = [];
  let currentFiles: FileChangedItem[] = [];
  let todoDrawerCollapsed = true;
  let filesDrawerCollapsed = true;

  // ── Drawer renderers ──────────────────────────────────────────────────

  function renderTodoDrawer(todos: TodoItem[]): void {
    if (
      !todoDrawer ||
      !todoDrawerList ||
      !Array.isArray(todos) ||
      !todos.length
    ) {
      if (todoDrawer) todoDrawer.classList.remove("visible");
      return;
    }
    currentTodos = todos;
    let doneCount = 0;
    todoDrawerList.innerHTML = "";

    for (const t of todos) {
      const status = String(t.status || "pending").toLowerCase();
      const isDone = status === "done" || status === "completed";
      const isActive = status === "in-progress" || status === "in_progress";
      const isBlocked = status === "blocked" || status === "failed";
      if (isDone) doneCount++;

      const statusClass = isDone
        ? "done"
        : isActive
          ? "in-progress"
          : isBlocked
            ? "blocked"
            : "pending";
      const item = document.createElement("div");
      item.className = "todo-item" + (isActive ? " active" : "");

      const iconEl = document.createElement("span");
      iconEl.className = "todo-icon " + statusClass;
      if (isDone) iconEl.textContent = "\u2713";
      else if (isBlocked) iconEl.textContent = "\u2717";
      else if (!isActive) iconEl.textContent = "\u25CB";

      const titleEl = document.createElement("span");
      titleEl.className =
        "todo-title" + (isDone ? " done" : isBlocked ? " blocked" : "");
      titleEl.textContent = t.task || t.title || t.text || "";

      item.appendChild(iconEl);
      item.appendChild(titleEl);
      todoDrawerList.appendChild(item);
    }

    if (todoDrawerCount)
      todoDrawerCount.textContent = doneCount + "/" + todos.length;
    todoDrawer.classList.add("visible");
    todoDrawer.classList.toggle("collapsed", todoDrawerCollapsed);
  }

  function renderFilesDrawer(files: FileChangedItem[]): void {
    if (
      !filesDrawer ||
      !filesDrawerList ||
      !Array.isArray(files) ||
      !files.length
    ) {
      if (filesDrawer) filesDrawer.classList.remove("visible");
      return;
    }
    currentFiles = files;
    filesDrawerList.innerHTML = "";

    for (const f of files) {
      const fpath = String(f.path || f.file || f.filePath || f.fileName || "");
      const basename = fpath.split(/[\\/]/).pop() || fpath;
      const added = parseInt(String(f.additions || f.linesAdded || 0), 10) || 0;
      const removed =
        parseInt(String(f.deletions || f.linesRemoved || 0), 10) || 0;

      const item = document.createElement("div");
      item.className = "file-item";
      item.dataset.filepath = fpath;

      const iconSpan = '<span class="file-item-icon">\uD83D\uDCCB</span>';
      const nameSpan =
        '<span class="file-item-name" title="' +
        esc(fpath) +
        '">' +
        esc(basename) +
        "</span>";
      const statsSpan =
        '<span class="file-item-stats">' +
        (added > 0 ? '<span class="file-stat-add">+' + added + "</span>" : "") +
        (removed > 0
          ? '<span class="file-stat-del">\u2212' + removed + "</span>"
          : "") +
        "</span>";
      const actionsSpan =
        '<span class="file-item-actions">' +
        '<button class="file-item-btn" type="button" data-action="history" title="Show git history">History</button>' +
        '<button class="file-item-btn" type="button" data-action="blame" title="Show git blame">Blame</button>' +
        "</span>";

      item.innerHTML = iconSpan + nameSpan + statsSpan + actionsSpan;
      item.addEventListener(
        "click",
        ((p: string) => () => {
          vscode.postMessage({ type: "openFile", payload: p });
        })(fpath),
      );

      const historyBtn = item.querySelector('[data-action="history"]');
      if (historyBtn) {
        historyBtn.addEventListener(
          "click",
          ((p: string) => (event: Event) => {
            event.stopPropagation();
            vscode.postMessage({ type: "showFileHistory", payload: p });
          })(fpath),
        );
      }
      const blameBtn = item.querySelector('[data-action="blame"]');
      if (blameBtn) {
        blameBtn.addEventListener(
          "click",
          ((p: string) => (event: Event) => {
            event.stopPropagation();
            vscode.postMessage({ type: "showFileBlame", payload: p });
          })(fpath),
        );
      }
      filesDrawerList.appendChild(item);
    }

    if (filesDrawerCount) {
      filesDrawerCount.textContent =
        files.length + " file" + (files.length === 1 ? "" : "s");
    }
    filesDrawer.classList.add("visible");
    filesDrawer.classList.toggle("collapsed", filesDrawerCollapsed);
  }

  function resetDrawers(): void {
    currentTodos = [];
    currentFiles = [];
    if (todoDrawer) {
      todoDrawer.classList.remove("visible");
      if (todoDrawerList) todoDrawerList.innerHTML = "";
      if (todoDrawerCount) todoDrawerCount.textContent = "";
    }
    if (filesDrawer) {
      filesDrawer.classList.remove("visible");
      if (filesDrawerList) filesDrawerList.innerHTML = "";
      if (filesDrawerCount) filesDrawerCount.textContent = "";
    }
  }

  // ── Structured payload detection ──────────────────────────────────────

  function looksLikeStructuredAgentPayload(text: string): boolean {
    const trimmed = String(text || "").trim();
    if (!trimmed) return false;
    return (
      trimmed.charAt(0) === "{" ||
      trimmed.charAt(0) === "[" ||
      /"(?:response|todos|toolCalls|edits|shortcuts)"\s*:/.test(trimmed)
    );
  }

  function extractStructuredResponseText(text: string): string {
    const trimmed = String(text || "").trim();
    if (!looksLikeStructuredAgentPayload(trimmed)) return trimmed;

    const candidates: string[] = [];
    if (trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[") {
      candidates.push(trimmed);
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed.response === "string")
          return parsed.response;
        if (parsed && typeof parsed.summary === "string") return parsed.summary;
        if (parsed && typeof parsed.text === "string") return parsed.text;
      } catch {
        // not valid JSON
      }
    }

    const matches = trimmed.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
    if (matches) {
      for (let j = matches.length - 1; j >= 0; j--) {
        try {
          const entry = JSON.parse(matches[j]);
          if (entry && typeof entry.response === "string")
            return entry.response;
        } catch {
          // skip
        }
      }
    }

    return trimmed;
  }

  function isPlanningPlaceholderText(text: string): boolean {
    const normalized = String(text || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    if (!normalized) return false;
    return (
      /^scanning (the )?workspace\b/.test(normalized) ||
      /^workspace scanned\b/.test(normalized) ||
      /^i(?:'ll| will)? .*\bunderstand (?:the )?(?:project|workspace)\b/.test(
        normalized,
      )
    );
  }

  function cleanAgentResponseText(text: string): string {
    let cleaned = extractStructuredResponseText(text);
    cleaned = cleaned.replace(
      /##\s*(TODOs?|Tasks?|What I found|What changed|Verification|Changes made|Files? changed)[\s\S]*?(?=\n##|$)/gi,
      "",
    );
    cleaned = cleaned
      .replace(/<break\s*\/?>/gi, "\n")
      .replace(/<\/break>/gi, "\n")
      .trim();
    if (isPlanningPlaceholderText(cleaned)) return "";
    return cleaned;
  }

  // ── Utility helpers ───────────────────────────────────────────────────

  function esc(s: string): string {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function relTime(iso: string): string {
    const d = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!isFinite(d) || d < 1) return "just now";
    if (d < 60) return d + "m ago";
    const h = Math.round(d / 60);
    return h < 24 ? h + "h ago" : Math.round(h / 24) + "d ago";
  }

  function autoGrow(el: HTMLTextAreaElement): void {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  function updateScrollButton(): void {
    if (!scrollBtn) return;
    const el = D("main");
    let show = false;
    if (inChat && el) {
      const overflow = el.scrollHeight > el.clientHeight + 8;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
      show = overflow && !atBottom;
    }
    scrollBtn.classList.toggle("visible", show);
  }

  function scheduleScrollButtonUpdate(): void {
    requestAnimationFrame(updateScrollButton);
  }

  function scrollBottom(): void {
    requestAnimationFrame(() => {
      const el = D("main");
      if (el) el.scrollTop = el.scrollHeight;
      updateScrollButton();
    });
  }

  function on(el: HTMLElement | null, evt: string, fn: EventListener): void {
    if (el) el.addEventListener(evt, fn);
  }

  function makeMessageId(): string {
    return (
      "msg_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function resetComposeState(): void {
    composeState = { mode: "new", messageId: "", messageIndex: -1 };
    if (taskInput) {
      taskInput.placeholder =
        conversationMode === "ask"
          ? "Ask Pulse a question\u2026"
          : conversationMode === "plan"
            ? "Describe the change you want planned\u2026"
            : "Ask Pulse anything about your code\u2026";
    }
    if (btnSend) btnSend.title = "Send (Enter)";
  }

  function beginEditMessage(messageId: string, messageIndex: number): void {
    const item = chatHistory[messageIndex];
    if (!item || item.role !== "user") return;
    composeState = { mode: "edit", messageId, messageIndex };
    if (taskInput) {
      taskInput.value = item.text || item.content || "";
      autoGrow(taskInput);
      taskInput.focus();
      taskInput.setSelectionRange(
        taskInput.value.length,
        taskInput.value.length,
      );
      taskInput.placeholder = "Edit message and resend\u2026";
    }
    if (btnSend) btnSend.title = "Save & Send";
  }

  function beginRetryMessage(messageId: string, messageIndex: number): void {
    const responseItem = chatHistory[messageIndex];
    if (!responseItem) return;
    let sourceText = "";
    for (let i = messageIndex - 1; i >= 0; i--) {
      if (chatHistory[i].role === "user") {
        sourceText = chatHistory[i].text || chatHistory[i].content || "";
        break;
      }
    }
    composeState = { mode: "retry", messageId, messageIndex };
    if (taskInput) {
      taskInput.value = sourceText;
      autoGrow(taskInput);
      taskInput.focus();
      taskInput.setSelectionRange(
        taskInput.value.length,
        taskInput.value.length,
      );
      taskInput.placeholder = "Retrying the last request\u2026";
    }
    if (btnSend) btnSend.title = "Retry";
    sendTask();
  }

  // ── Markdown rendering ────────────────────────────────────────────────

  function renderMarkdown(raw: string): string {
    if (!raw) return "";
    raw = raw.replace(/<break\s*\/?>/gi, "\n").replace(/<\/break>/gi, "\n");
    raw = raw.replace(
      /^\s*\{[\s\S]*?"response"\s*:\s*"[\s\S]*?"[\s\S]*?\}\s*$/gm,
      (match) => {
        try {
          const obj = JSON.parse(match);
          return obj.response || match;
        } catch {
          return match;
        }
      },
    );

    const blocks: string[] = [];
    let blockIdx = 0;

    let stripped = raw.replace(
      /```(\w*)\n([\s\S]*?)```/g,
      (_, lang: string, code: string) => {
        const label = lang || "code";
        const bid = "cb-" + blockIdx;
        const placeholder = "%%CODEBLOCK_" + blockIdx++ + "%%";
        blocks.push(
          '<div class="code-block"><div class="code-header"><span class="code-lang">' +
            esc(label) +
            "</span>" +
            '<button class="code-copy" data-bid="' +
            bid +
            '">Copy</button></div>' +
            '<pre id="' +
            bid +
            '"><code>' +
            esc(code) +
            "</code></pre></div>",
        );
        return placeholder;
      },
    );

    stripped = stripped.replace(/```([\s\S]*?)```/g, (_, code: string) => {
      const bid = "cb-" + blockIdx;
      const placeholder = "%%CODEBLOCK_" + blockIdx++ + "%%";
      blocks.push(
        '<div class="code-block"><pre id="' +
          bid +
          '"><code>' +
          esc(code) +
          "</code></pre></div>",
      );
      return placeholder;
    });

    let html = esc(stripped);
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
    html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
    html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
    html = html.replace(/((?:<li>.*?<\/li>\n?)+)/g, "<ul>$1</ul>");
    html = html.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" title="$2">$1</a>',
    );
    html = html.replace(/\n/g, "<br>");
    html = html.replace(/(<br\s*\/?>){3,}/gi, "<br><br>");
    html = html.replace(
      /(<\/(?:h[1-6]|ul|ol|li|div|pre|blockquote)>)\s*<br>/gi,
      "$1",
    );
    html = html.replace(
      /<br>\s*(<(?:h[1-6]|ul|ol|li|div|pre|blockquote)[> ])/gi,
      "$1",
    );

    for (let bi = 0; bi < blocks.length; bi++) {
      html = html.replace("%%CODEBLOCK_" + bi + "%%", blocks[bi]);
    }
    return html;
  }

  // ── Permission labels ─────────────────────────────────────────────────

  const PERM_LABELS: Record<string, { icon: string; label: string }> = {
    default: { icon: "\u2625", label: "Default Approvals" },
    full: { icon: "\u26A0", label: "Bypass Approvals" },
    strict: { icon: "\uD83D\uDD12", label: "Require Approvals" },
  };

  function updatePermUI(mode: string): void {
    permMode = mode || "default";
    const info = PERM_LABELS[permMode] || PERM_LABELS["default"];
    if (permBtnIcon) permBtnIcon.textContent = info.icon;
    if (permBtnLabel) permBtnLabel.textContent = info.label;
    const popup = D("permPopup");
    if (popup) {
      popup.querySelectorAll<HTMLButtonElement>(".perm-opt").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.perm === permMode);
      });
    }
  }

  // ── Conversation mode ─────────────────────────────────────────────────

  function renderConversationMode(mode: string): void {
    conversationMode = mode || "agent";
    if (chipMode) chipMode.textContent = conversationMode.toUpperCase();
    const popup = D("modePopup");
    if (popup) {
      popup.querySelectorAll<HTMLButtonElement>(".popup-opt").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === conversationMode);
      });
    }
    if (taskInput && composeState.mode === "new") {
      taskInput.placeholder =
        conversationMode === "ask"
          ? "Ask Pulse a question\u2026"
          : conversationMode === "plan"
            ? "Describe the change you want planned\u2026"
            : "Ask Pulse anything about your code\u2026";
    }
  }

  // ── Popups ────────────────────────────────────────────────────────────

  function closeAllPopups(): void {
    closeModePopup();
    closeModelPopup();
    closePermPopup();
  }

  function openModePopup(): void {
    closeAllPopups();
    const p = D("modePopup");
    if (p) p.classList.remove("hidden");
    modePopupOpen = true;
  }

  function closeModePopup(): void {
    const p = D("modePopup");
    if (p) p.classList.add("hidden");
    modePopupOpen = false;
  }

  function sourceLabelForModel(model: ModelInfo): string {
    if (!model || !model.source) return "Compatible";
    if (model.source === "running") return "Running";
    if (model.source === "local") return "Local";
    return "Configured";
  }

  function sourceBadgeClassForModel(model: ModelInfo): string {
    if (!model || !model.source) return "configured";
    return model.source === "running"
      ? "running"
      : model.source === "local"
        ? "local"
        : "configured";
  }

  function describeModelTooltip(model: ModelInfo): string {
    if (!model || !model.name) return "Model";
    const parts = [
      model.name,
      "Usable with the current agent",
      "Source: " + sourceLabelForModel(model),
    ];
    if (model.supportsVision) parts.push("Supports vision/image tasks");
    return parts.join(" \u2014 ");
  }

  function describeModelOption(model: ModelInfo): string {
    if (!model || !model.name) return "";
    const labels = ["Ready", sourceLabelForModel(model)];
    if (model.supportsVision) labels.push("Vision");
    return model.name + " \u2014 " + labels.join(" \u00b7 ");
  }

  function createModelBadge(label: string, className: string): HTMLSpanElement {
    const badge = document.createElement("span");
    badge.className = "model-badge " + className;
    badge.textContent = label;
    return badge;
  }

  function openModelPopup(): void {
    closeAllPopups();
    const popup = D("modelPopup");
    const list = D("modelPopupList");
    if (!popup || !list) return;
    list.innerHTML = "";

    if (!models.length) {
      list.innerHTML =
        '<div style="padding:8px 10px;font-size:11px;opacity:.5">No models</div>';
    } else {
      for (const m of models) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "model-item" + (m.name === activeModelName ? " active" : "");
        btn.title = describeModelTooltip(m);
        btn.addEventListener(
          "click",
          ((model: ModelInfo) => (e: Event) => {
            e.stopPropagation();
            activeModelName = model.name;
            if (chipModel) {
              chipModel.textContent =
                model.name.split(":")[0].slice(0, 14) || "\u2013";
              chipModel.title = model.name;
            }
            vscode.postMessage({
              type: "setModel",
              payload: { role: "planner", model: model.name },
            });
            vscode.postMessage({
              type: "setModel",
              payload: { role: "editor", model: model.name },
            });
            vscode.postMessage({
              type: "setModel",
              payload: { role: "fast", model: model.name },
            });
            closeModelPopup();
          })(m),
        );

        const row = document.createElement("div");
        row.className = "model-item-row";
        const name = document.createElement("span");
        name.className = "model-item-name";
        name.textContent = m.name;
        row.appendChild(name);
        if (m.name === activeModelName)
          row.appendChild(createModelBadge("Active", "active"));
        btn.appendChild(row);

        const badges = document.createElement("div");
        badges.className = "model-item-badges";
        badges.appendChild(createModelBadge("Agent-ready", "ready"));
        badges.appendChild(
          createModelBadge(sourceLabelForModel(m), sourceBadgeClassForModel(m)),
        );
        if (m.supportsVision)
          badges.appendChild(createModelBadge("Vision", "vision"));
        btn.appendChild(badges);
        list.appendChild(btn);
      }
    }

    popup.classList.remove("hidden");
    modelPopupOpen = true;
  }

  function closeModelPopup(): void {
    const p = D("modelPopup");
    if (p) p.classList.add("hidden");
    modelPopupOpen = false;
  }

  function openPermPopup(): void {
    closeAllPopups();
    const p = D("permPopup");
    if (p) {
      updatePermUI(permMode);
      p.classList.remove("hidden");
    }
    permPopupOpen = true;
  }

  function closePermPopup(): void {
    const p = D("permPopup");
    if (p) p.classList.add("hidden");
    permPopupOpen = false;
  }

  document.addEventListener("click", closeAllPopups);

  // ── Thinking panel ────────────────────────────────────────────────────

  let thinkingTimer: ReturnType<typeof setInterval> | null = null;
  let stepsCollapsed = false;

  const reasoningLabels = [
    "Thinking\u2026",
    "Reasoning\u2026",
    "Analyzing\u2026",
    "Checking\u2026",
    "Processing\u2026",
  ];
  let reasoningLabelIdx = 0;
  let reasoningLabelTimer: ReturnType<typeof setInterval> | null = null;

  function startReasoningLabelCycle(labelEl: HTMLElement): void {
    if (reasoningLabelTimer) return;
    reasoningLabelTimer = setInterval(() => {
      reasoningLabelIdx = (reasoningLabelIdx + 1) % reasoningLabels.length;
      if (labelEl) labelEl.textContent = reasoningLabels[reasoningLabelIdx];
    }, 1800);
  }

  function stopReasoningLabelCycle(): void {
    if (reasoningLabelTimer) {
      clearInterval(reasoningLabelTimer);
      reasoningLabelTimer = null;
    }
    reasoningLabelIdx = 0;
  }

  function resetThinkingPanel(): void {
    if (thinkingTimer) {
      clearInterval(thinkingTimer);
      thinkingTimer = null;
    }
    stopReasoningLabelCycle();
    thinkingSteps = [];
    thinkingStartTime = null;
    stepsCollapsed = false;

    const panel = D("thinkingPanel");
    const title = D("thinkingTitle");
    const elapsed = D("thinkingElapsed");
    const list = D("stepsList");
    if (!panel) return;
    panel.classList.add("hidden");
    panel.classList.remove("done", "steps-collapsed");
    if (title) title.textContent = "Thinking\u2026";
    if (elapsed) elapsed.textContent = "";
    if (list) list.innerHTML = "";

    if (messagesEl) {
      const inlineThinkings = messagesEl.querySelectorAll(".inline-thinking");
      for (const it of inlineThinkings) it.parentNode?.removeChild(it);
    }
  }

  function startThinking(): void {
    thinkingSteps = [];
    thinkingStartTime = Date.now();
    stepsCollapsed = false;

    const panel = D("thinkingPanel");
    const title = D("thinkingTitle");
    const elapsed = D("thinkingElapsed");
    const list = D("stepsList");
    if (!panel) return;
    panel.classList.remove("hidden", "done", "steps-collapsed");
    if (title) title.textContent = "Thinking\u2026";
    if (elapsed) elapsed.textContent = "";
    if (list) list.innerHTML = "";

    if (thinkingTimer) clearInterval(thinkingTimer);
    thinkingTimer = setInterval(() => {
      if (elapsed && thinkingStartTime) {
        const s = ((Date.now() - thinkingStartTime) / 1000).toFixed(0);
        elapsed.textContent = s + "s";
      }
    }, 1000);
  }

  function addThinkingStep(step: ThinkingStep): void {
    thinkingSteps.push(step);
    const title = D("thinkingTitle");
    const list = D("stepsList");
    const kind = step.kind || "step";
    const label = step.step || "Processing";
    if (!list) return;

    // Drawer updates
    if (kind === "todo_update") {
      renderTodoDrawer(step.todos || []);
      return;
    }
    if (kind === "files_changed") {
      renderFilesDrawer(step.files || []);
      return;
    }

    if (kind === "reasoning") {
      const active = list.querySelector(".step-reasoning-active");
      if (active) {
        const rt = active.querySelector(".step-reasoning-text");
        if (rt) {
          const incoming = String(step.detail || "");
          if (!incoming.trim()) {
            scrollBottom();
            return;
          }
          const current = rt.textContent || "";
          const normalizedIncoming = incoming.replace(/\s+/g, " ").trim();
          const normalizedTail = current
            .slice(Math.max(0, current.length - normalizedIncoming.length - 4))
            .replace(/\s+/g, " ")
            .trim();
          const isPlaceholder =
            /^(Reasoning through tools and code changes|Thinking through the next action)\.\.\.$/i.test(
              normalizedIncoming,
            );
          if (
            (normalizedIncoming && normalizedTail === normalizedIncoming) ||
            (isPlaceholder && current.indexOf(incoming) >= 0)
          ) {
            scrollBottom();
            return;
          }
          const joiner =
            current && !/\s$/.test(current) && !/^\s/.test(incoming) ? " " : "";
          const appended = current + joiner + incoming;
          rt.textContent =
            appended.length > 800
              ? appended.slice(appended.length - 800)
              : appended;
        }
        scrollBottom();
        return;
      }

      const item = document.createElement("div");
      item.className = "step-item step-reasoning step-reasoning-active";
      const labelEl = document.createElement("span");
      labelEl.className = "step-reasoning-label";
      labelEl.textContent = reasoningLabels[0];
      const textEl = document.createElement("span");
      textEl.className = "step-reasoning-text";
      textEl.textContent = step.detail || "";
      item.appendChild(labelEl);
      item.appendChild(textEl);
      list.appendChild(item);
      if (title) title.textContent = "Generating\u2026";
      startReasoningLabelCycle(labelEl);
      scrollBottom();
      return;
    }

    // Seal previous reasoning block
    const prevActive = list.querySelector(".step-reasoning-active");
    if (prevActive) {
      prevActive.classList.remove("step-reasoning-active");
      const prevLabel = prevActive.querySelector(".step-reasoning-label");
      if (prevLabel) prevLabel.textContent = "Thought";
      stopReasoningLabelCycle();
    }

    const item = document.createElement("div");
    item.className = "step-item step-" + kind;

    if (kind === "file_patch") {
      if (title) title.textContent = "Generating patch\u2026";
      item.innerHTML =
        '<span class="step-icon">&#9998;</span>' +
        '<span class="step-label">Generating patch</span>' +
        '<span class="step-line-count">(' +
        esc(String(step.lineCount || 0)) +
        " lines) in&nbsp;</span>" +
        '<span class="step-file-name">' +
        esc(step.file || "") +
        "</span>";
    } else if (kind === "file_patched") {
      if (title) title.textContent = "Edited " + (step.file || "");
      item.innerHTML =
        '<span class="step-icon" style="color:var(--green)">&#10003;</span>' +
        '<span class="step-label">Edited</span>' +
        '<span class="step-file-name">' +
        esc(step.file || "") +
        "</span>" +
        '<span class="step-diff-added">+' +
        esc(String(step.linesAdded || 0)) +
        "</span>" +
        '<span class="step-diff-removed">\u2212' +
        esc(String(step.linesRemoved || 0)) +
        "</span>";
    } else if (kind === "terminal") {
      if (title) title.textContent = "Running terminal";
      item.innerHTML =
        '<span class="step-icon">&#9654;</span>' +
        '<span class="step-cmd">$ ' +
        esc(step.detail || step.step || "") +
        "</span>";
    } else {
      if (title) title.textContent = label;
      item.innerHTML =
        '<span class="step-icon">' +
        esc(step.icon || "\u25cf") +
        "</span>" +
        '<span class="step-label">' +
        esc(label) +
        "</span>" +
        (step.detail
          ? '<span class="step-detail">' + esc(step.detail) + "</span>"
          : "");
    }

    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
    scrollBottom();
  }

  function finishThinking(cancelled?: boolean): void {
    const panel = D("thinkingPanel");
    const title = D("thinkingTitle");
    const elapsed = D("thinkingElapsed");
    const list = D("stepsList");

    if (thinkingTimer) {
      clearInterval(thinkingTimer);
      thinkingTimer = null;
    }
    if (!panel) return;
    panel.classList.add("done");
    stepsCollapsed = true;
    panel.classList.add("steps-collapsed");
    stopReasoningLabelCycle();

    if (list) {
      const ar = list.querySelector(".step-reasoning-active");
      if (ar) {
        ar.classList.remove("step-reasoning-active");
        const arLabel = ar.querySelector(".step-reasoning-label");
        if (arLabel) arLabel.textContent = "Thought";
      }
    }

    const sec = thinkingStartTime
      ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1)
      : "0";
    const count = thinkingSteps.length;
    if (title) {
      title.textContent = cancelled
        ? "Cancelled after " + sec + "s"
        : "Completed in " +
          sec +
          "s \u00b7 " +
          count +
          " step" +
          (count !== 1 ? "s" : "");
    }
    if (elapsed) elapsed.textContent = "";
    setBusyMode(false);

    // Move thinking panel into messages as inline clone
    if (panel && messagesEl && count > 0) {
      const inlineThinking = panel.cloneNode(true) as HTMLElement;
      inlineThinking.removeAttribute("id");
      inlineThinking.className =
        "thinking-panel done steps-collapsed inline-thinking";
      const idEls = inlineThinking.querySelectorAll("[id]");
      for (const el of idEls) el.removeAttribute("id");

      const clonedToggleBtn = inlineThinking.querySelector(".steps-toggle-btn");
      if (clonedToggleBtn) {
        clonedToggleBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          inlineThinking.classList.toggle("steps-collapsed");
        });
      }
      messagesEl.appendChild(inlineThinking);
      panel.classList.add("hidden");
    }
  }

  on(D("stepsToggleBtn"), "click", (e) => {
    e.stopPropagation();
    const panel = D("thinkingPanel");
    if (!panel) return;
    stepsCollapsed = !stepsCollapsed;
    panel.classList.toggle("steps-collapsed", stepsCollapsed);
  });

  // Drawer toggles
  on(D("todoDrawerToggle"), "click", () => {
    todoDrawerCollapsed = !todoDrawerCollapsed;
    if (todoDrawer)
      todoDrawer.classList.toggle("collapsed", todoDrawerCollapsed);
  });
  on(D("filesDrawerToggle"), "click", () => {
    filesDrawerCollapsed = !filesDrawerCollapsed;
    if (filesDrawer)
      filesDrawer.classList.toggle("collapsed", filesDrawerCollapsed);
  });

  // ── Diff rendering ────────────────────────────────────────────────────

  const DIFF_MAX_LINES = 200;

  function renderDiffCards(diffs: FileDiff[], isAutoApplied?: boolean): string {
    if (!diffs || !diffs.length) return "";
    const statusLabel = isAutoApplied ? "Applied" : "Pending";
    let h = '<div class="diff-section">';
    h +=
      '<div style="font-size:11px;font-weight:600;color:var(--fg2);margin-bottom:4px">' +
      esc(
        diffs.length + " file" + (diffs.length === 1 ? "" : "s") + " changed",
      ) +
      ' \u2014 <span style="color:var(--accent)">' +
      esc(statusLabel) +
      "</span></div>";

    for (let i = 0; i < diffs.length; i++) {
      const d = diffs[i];
      const fname = d.fileName || d.filePath || "unknown";
      let badge = "";
      if (d.isNew) badge = '<span class="diff-card-new">NEW</span>';
      else if (d.isDelete) badge = '<span class="diff-card-del">DEL</span>';

      h += '<div class="diff-card" data-diff-idx="' + i + '">';
      h += '<div class="diff-card-header">';
      h += '<span class="diff-card-arrow">\u25B6</span>';
      h += '<span class="diff-card-file">' + esc(fname) + "</span>";
      h += badge;
      h += '<span class="diff-card-badge">';
      if ((d.additions ?? 0) > 0)
        h += '<span class="diff-stat-add">+' + d.additions + "</span>";
      if ((d.deletions ?? 0) > 0)
        h += '<span class="diff-stat-del">\u2212' + d.deletions + "</span>";
      h += "</span></div>";

      h += '<div class="diff-content">';
      if (d.hunks && d.hunks.length) {
        h += '<table class="diff-table">';
        let linesRendered = 0;
        for (
          let hi = 0;
          hi < d.hunks.length && linesRendered < DIFF_MAX_LINES;
          hi++
        ) {
          const hunk = d.hunks[hi];
          if (hi > 0) {
            h +=
              '<tr class="diff-tr-sep"><td class="diff-ln" colspan="2"></td><td class="diff-code" style="color:var(--fg3);font-style:italic;padding:2px 6px">\u22EE</td></tr>';
          }
          for (
            let li = 0;
            li < hunk.lines.length && linesRendered < DIFF_MAX_LINES;
            li++
          ) {
            const ln = hunk.lines[li];
            const cls =
              ln.type === "add"
                ? "diff-tr-add"
                : ln.type === "remove"
                  ? "diff-tr-del"
                  : "diff-tr-ctx";
            const olNum = ln.oldLine != null ? String(ln.oldLine) : "";
            const nlNum = ln.newLine != null ? String(ln.newLine) : "";
            h += '<tr class="' + cls + '">';
            h += '<td class="diff-ln">' + esc(olNum) + "</td>";
            h += '<td class="diff-ln">' + esc(nlNum) + "</td>";
            h += '<td class="diff-code">' + esc(ln.content) + "</td>";
            h += "</tr>";
            linesRendered++;
          }
        }
        h += "</table>";
        if (linesRendered >= DIFF_MAX_LINES) {
          h +=
            '<div class="diff-truncated">Diff truncated \u2014 showing first ' +
            DIFF_MAX_LINES +
            " lines</div>";
        }
      }
      h += "</div>";

      if (!isAutoApplied) {
        h +=
          '<div class="diff-file-actions" data-diff-file="' +
          esc(d.filePath || fname) +
          '">';
        h +=
          '<button class="btn primary xs diff-file-accept" title="Accept this file">&#10003; Accept</button>';
        h +=
          '<button class="btn danger xs diff-file-reject" title="Reject this file">&#10007; Reject</button>';
        h += "</div>";
      }
      h += "</div>";
    }

    if (!isAutoApplied) {
      h += '<div class="diff-actions">';
      h += '<button class="btn primary sm diff-keep-btn">Keep All</button>';
      h += '<button class="btn danger sm diff-undo-btn">Discard All</button>';
      h += "</div>";
    }
    h += "</div>";
    return h;
  }

  // ── SVG icons ─────────────────────────────────────────────────────────

  const SVG_RETRY =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>';
  const SVG_COPY =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>';
  const SVG_COPY_OK =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg>';
  const SVG_EDIT =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/></svg>';

  // ── Message rendering ─────────────────────────────────────────────────

  function renderMessages(): void {
    if (!chatHistory.length) {
      messagesEl.innerHTML =
        '<div class="empty fadein"><div class="empty-icon">&#9889;</div><div class="empty-h">What should I work on?</div><div class="empty-p">Describe the bug, change, or feature.</div><div class="empty-hints"><span class="empty-hint">&ldquo;Fix the failing tests&rdquo;</span><span class="empty-hint">&ldquo;Refactor the auth flow&rdquo;</span><span class="empty-hint">&ldquo;Add /api/users&rdquo;</span></div></div>';
      scheduleScrollButtonUpdate();
      return;
    }
    messagesEl.innerHTML = "";

    for (let i = 0; i < chatHistory.length; i++) {
      const m = chatHistory[i];
      if (!m.id) m.id = makeMessageId();

      const div = document.createElement("div");
      const role = m.role === "assistant" ? "agent" : m.role;
      div.className = "msg " + role + " fadein";
      div.dataset.messageId = String(m.id || "");
      div.dataset.messageIndex = String(i);

      // Terminal blocks
      if (m.role === "terminal" && m.isHtml) {
        div.innerHTML = m.text || "";
        const termHeader = div.querySelector(
          ".terminal-chat-header",
        ) as HTMLElement | null;
        if (termHeader) {
          termHeader.addEventListener("click", function (this: HTMLElement, e) {
            e.stopPropagation();
            const block = this.parentElement;
            if (block) {
              const output = block.querySelector(".terminal-chat-output");
              if (output) output.classList.toggle("hidden");
              block.classList.toggle("open");
            }
          });
          const rerunBtn = termHeader.querySelector(".terminal-rerun");
          if (rerunBtn) {
            rerunBtn.addEventListener("click", function (this: HTMLElement, e) {
              e.stopPropagation();
              const header = this.closest(".terminal-chat-header");
              const cmd = header ? header.getAttribute("data-command") : "";
              if (cmd)
                vscode.postMessage({
                  type: "rerunTerminal",
                  payload: { command: cmd },
                });
            });
          }
          const copyBtn = termHeader.querySelector(".terminal-copy");
          if (copyBtn) {
            copyBtn.addEventListener("click", function (this: HTMLElement, e) {
              e.stopPropagation();
              const header = this.closest(".terminal-chat-header");
              const cmd = header ? header.getAttribute("data-command") : "";
              if (cmd && navigator.clipboard) {
                navigator.clipboard.writeText(cmd).then(() => {
                  const prev = (this as HTMLElement).textContent;
                  (this as HTMLElement).textContent = "\u2713";
                  setTimeout(() => {
                    (this as HTMLElement).textContent = prev;
                  }, 1200);
                });
              }
            });
          }
        }
        messagesEl.appendChild(div);
        continue;
      }

      if (
        composeState.mode === "edit" &&
        String(m.id || "") === String(composeState.messageId || "")
      ) {
        div.classList.add("editing");
      }

      const text = m.text || m.content || "";
      let html = renderMarkdown(text);
      if (m.fileDiffs && m.fileDiffs.length > 0) {
        html += renderDiffCards(m.fileDiffs, m.autoApplied);
      }

      const rawTs = m.ts || null;
      const ts = rawTs
        ? relTime(
            new Date(typeof rawTs === "number" ? rawTs : rawTs).toISOString(),
          )
        : "";
      const footerActions =
        role === "agent"
          ? '<button class="retry-btn" title="Retry">' +
            SVG_RETRY +
            '</button><button class="copy-btn" title="Copy message">' +
            SVG_COPY +
            "</button>"
          : '<button class="retry-btn edit-btn" title="Edit message">' +
            SVG_EDIT +
            '</button><button class="copy-btn" title="Copy message">' +
            SVG_COPY +
            "</button>";

      div.innerHTML =
        '<div class="bubble">' +
        html +
        "</div>" +
        '<div class="msg-footer">' +
        '<span class="msg-time">' +
        esc(ts) +
        "</span>" +
        '<div style="display:flex;gap:2px;align-items:center">' +
        footerActions +
        "</div>" +
        "</div>";

      // Wire message action buttons
      ((t: string, el: HTMLElement, msgRole: string) => {
        el.querySelector(".copy-btn")?.addEventListener("click", (e) => {
          e.stopPropagation();
          const target = e.currentTarget as HTMLElement;
          navigator.clipboard.writeText(t).then(() => {
            target.innerHTML = SVG_COPY_OK;
            setTimeout(() => {
              target.innerHTML = SVG_COPY;
            }, 1400);
          });
        });

        if (msgRole === "user") {
          const editBtn = el.querySelector(".edit-btn");
          if (editBtn) {
            editBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              beginEditMessage(
                String(el.dataset.messageId || ""),
                Number(el.dataset.messageIndex || -1),
              );
            });
          }
          el.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            beginEditMessage(
              String(el.dataset.messageId || ""),
              Number(el.dataset.messageIndex || -1),
            );
          });
        }

        if (msgRole === "agent") {
          const retryBtn = el.querySelector(".retry-btn");
          if (retryBtn) {
            retryBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              if (isBusy) return;
              beginRetryMessage(
                String(el.dataset.messageId || ""),
                Number(el.dataset.messageIndex || -1),
              );
            });
          }

          // Diff card toggles
          const diffHeaders = el.querySelectorAll(".diff-card-header");
          for (const dh of diffHeaders) {
            dh.addEventListener("click", function (this: HTMLElement, e) {
              e.stopPropagation();
              const card = this.parentElement;
              if (card) card.classList.toggle("open");
            });
          }

          // Diff Keep / Discard
          const keepBtn = el.querySelector(".diff-keep-btn");
          if (keepBtn) {
            keepBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              vscode.postMessage({ type: "applyPending", payload: true });
              const sec = el.querySelector(".diff-actions");
              if (sec)
                sec.innerHTML =
                  '<span style="font-size:11px;color:var(--green);font-weight:600">\u2713 Applied</span>';
            });
          }
          const discardBtn = el.querySelector(".diff-undo-btn");
          if (discardBtn) {
            discardBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              vscode.postMessage({ type: "revertLast", payload: true });
              const sec = el.querySelector(".diff-actions");
              if (sec)
                sec.innerHTML =
                  '<span style="font-size:11px;color:var(--red);font-weight:600">\u2717 Discarded</span>';
            });
          }

          // Per-file accept/reject
          const fileAcceptBtns = el.querySelectorAll(".diff-file-accept");
          for (const fab of fileAcceptBtns) {
            fab.addEventListener("click", function (this: HTMLElement, e) {
              e.stopPropagation();
              const actionsDiv = this.parentElement as HTMLElement | null;
              const filePath = actionsDiv?.dataset.diffFile ?? "";
              if (filePath) {
                vscode.postMessage({ type: "acceptFile", payload: filePath });
                if (actionsDiv)
                  actionsDiv.innerHTML =
                    '<span style="font-size:10px;color:var(--green);font-weight:600">\u2713 Accepted</span>';
              }
            });
          }
          const fileRejectBtns = el.querySelectorAll(".diff-file-reject");
          for (const frb of fileRejectBtns) {
            frb.addEventListener("click", function (this: HTMLElement, e) {
              e.stopPropagation();
              const actionsDiv = this.parentElement as HTMLElement | null;
              const filePath = actionsDiv?.dataset.diffFile ?? "";
              if (filePath) {
                vscode.postMessage({ type: "rejectFile", payload: filePath });
                if (actionsDiv)
                  actionsDiv.innerHTML =
                    '<span style="font-size:10px;color:var(--red);font-weight:600">\u2717 Rejected</span>';
              }
            });
          }
        }
      })(text, div, role);

      messagesEl.appendChild(div);
    }
    scheduleScrollButtonUpdate();
  }

  // ── Attachment rendering ──────────────────────────────────────────────

  function renderAttachments(files: string[]): void {
    attachedFiles = Array.isArray(files) ? files.slice() : [];
    if (!attachmentRow) return;
    if (!attachedFiles.length && !attachmentRow.querySelector(".img-preview")) {
      attachmentRow.innerHTML = "";
      return;
    }

    let html =
      '<span class="attachment-label">Attached</span>' +
      attachedFiles
        .map(
          (f) =>
            '<span class="chip" title="' +
            esc(f) +
            '">' +
            esc(f.split(/[\\\\/]/).pop() || f) +
            "</span>",
        )
        .join("");

    const existing = attachmentRow.querySelectorAll(".img-preview");
    attachmentRow.innerHTML = html;
    for (const p of existing) attachmentRow.appendChild(p);
  }

  function addImagePreview(name: string, dataUrl: string): void {
    if (!attachmentRow) return;
    if (!attachmentRow.querySelector(".attachment-label")) {
      const label = document.createElement("span");
      label.className = "attachment-label";
      label.textContent = "Attached";
      attachmentRow.insertBefore(label, attachmentRow.firstChild);
    }

    const wrap = document.createElement("span");
    wrap.className = "img-preview";
    wrap.title = name;
    wrap.innerHTML =
      '<img src="' +
      dataUrl +
      '" class="img-thumb" /><span class="img-name">' +
      esc(name) +
      '</span><button class="img-remove" title="Remove">&times;</button>';
    wrap.querySelector(".img-remove")!.addEventListener("click", (e) => {
      e.stopPropagation();
      wrap.parentNode?.removeChild(wrap);
      vscode.postMessage({ type: "removeImage", payload: name });
    });
    attachmentRow.appendChild(wrap);
  }

  // ── Session rendering ─────────────────────────────────────────────────

  function renderSessions(list: SessionItem[]): void {
    list = list || [];
    if (!list.length) {
      sessionList.innerHTML =
        '<div class="empty"><div class="empty-icon">&#128172;</div><div class="empty-h">No conversations yet</div><div class="empty-p">Start typing below to begin your first session</div></div>';
      return;
    }
    sessionList.innerHTML = "";
    const VISIBLE_LIMIT = 4;
    const visibleCount = Math.min(list.length, VISIBLE_LIMIT);

    for (let i = 0; i < visibleCount; i++) {
      sessionList.appendChild(createSessionItem(list[i]));
    }

    if (list.length > VISIBLE_LIMIT) {
      const remaining = list.length - VISIBLE_LIMIT;
      const loadMore = document.createElement("button");
      loadMore.className = "load-more-btn";
      loadMore.textContent = "Load more (" + remaining + ")";
      loadMore.addEventListener("click", () => {
        loadMore.remove();
        for (let j = VISIBLE_LIMIT; j < list.length; j++) {
          const d = createSessionItem(list[j]);
          d.classList.add("fadein");
          sessionList.appendChild(d);
        }
      });
      sessionList.appendChild(loadMore);
    }
  }

  function createSessionItem(s: SessionItem): HTMLElement {
    const d = document.createElement("div");
    d.className = "sitem";
    d.dataset.sessionId = String(s.id || "");
    d.innerHTML =
      '<span class="sitem-title">' +
      esc(s.title || s.id) +
      "</span>" +
      '<div class="session-actions"><div class="session-meta"><span class="sitem-time">' +
      esc(relTime(s.updatedAt)) +
      '</span><span class="session-count">' +
      esc(String(s.messageCount || 0)) +
      " msgs</span></div>" +
      '<button type="button" class="session-delete" title="Delete">&#128465;</button></div>';

    d.addEventListener("click", () => {
      if (s.id) vscode.postMessage({ type: "openSession", payload: s.id });
    });
    d.querySelector(".session-delete")!.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: "deleteSessionRequest", payload: s.id });
    });
    return d;
  }

  function renderLoadedSession(session: LoadedSession): void {
    if (!session) return;
    pendingRequest = null;
    resetComposeState();
    resetDrawers();
    resetThinkingPanel();
    resetBannerBtns();
    if (editsBanner) editsBanner.classList.remove("on");
    if (bannerTxt) bannerTxt.textContent = "Pending edits ready";
    attachedFiles = session.attachedFiles || [];
    renderAttachments(attachedFiles);

    if (Array.isArray(session.messages) && session.messages.length > 0) {
      chatHistory = session.messages.map((m) => ({
        id: m.id || makeMessageId(),
        role: m.role,
        text: m.content,
        ts: m.createdAt || null,
      }));
    } else {
      chatHistory = [
        {
          id: makeMessageId(),
          role: "user",
          text: session.objective || session.title || "Session",
          ts: session.updatedAt || null,
        },
      ];
      if (session.lastResult) {
        chatHistory.push({
          id: makeMessageId(),
          role: "assistant",
          text: session.lastResult,
          ts: session.updatedAt || null,
        });
      }
    }
    renderMessages();
    showChat();
  }

  function handleSessionDeleted(payload: { wasActive?: boolean }): void {
    if (payload && payload.wasActive) {
      chatHistory = [];
      attachedFiles = [];
      resetComposeState();
      resetDrawers();
      resetThinkingPanel();
      resetBannerBtns();
      if (editsBanner) editsBanner.classList.remove("on");
      if (bannerTxt) bannerTxt.textContent = "Pending edits ready";
      renderAttachments(attachedFiles);
      renderMessages();
      showHome();
    }
  }

  // ── Summary rendering ─────────────────────────────────────────────────

  function renderSummary(s: RuntimeSummary): void {
    summary = s;
    const ok = s && (Boolean(s.ollamaReachable) || s.status === "ready");
    statusBadge.className = "badge " + (ok ? "on" : "off");
    statusTxt.textContent = ok ? "Online" : "Offline";
    renderConversationMode((s && s.conversationMode) || "agent");
    if (s && s.permissionMode) updatePermUI(s.permissionMode);
    if (s && s.persona && personaSelect) personaSelect.value = s.persona;
    if (s && typeof s.selfLearnEnabled === "boolean" && selfLearnToggle)
      selfLearnToggle.checked = s.selfLearnEnabled;
    if (s && s.uiSummaryVerbosity && summaryVerbositySelect)
      summaryVerbositySelect.value = s.uiSummaryVerbosity;

    if (compactSummaryToggle) {
      compactSummaryToggle.checked =
        (s && s.uiSummaryVerbosity === "compact") || false;
      if (compactSummaryRow && typeof s.uiShowSummaryToggle === "boolean") {
        compactSummaryRow.style.display = s.uiShowSummaryToggle ? "" : "none";
      }
    }

    const model = (s && s.plannerModel) || "";
    activeModelName = model;
    chipModel.textContent = model.split(":")[0].slice(0, 14) || "\u2013";
    chipModel.title = model || "none";

    const hasPending = s && s.hasPendingEdits;
    editsBanner.classList.toggle("on", Boolean(hasPending));
    if (hasPending) {
      const eCount =
        s && typeof s.pendingEditCount === "number" ? s.pendingEditCount : 0;
      bannerTxt.textContent =
        eCount > 0
          ? eCount +
            " file" +
            (eCount === 1 ? "" : "s") +
            " changed \u2014 review before approving"
          : "Pending file edits \u2014 review before approving";
    }

    if (learningBadge) {
      const learningPct =
        s && typeof s.learningProgressPercent === "number"
          ? s.learningProgressPercent
          : 0;
      learningBadge.textContent =
        "Learning " + Math.max(0, Math.min(100, Math.round(learningPct))) + "%";
      learningBadge.title = "Self-improvement progress from recent tasks";
      learningBadge.style.display = learningPct > 0 ? "" : "none";
    }

    if (s && typeof s.tokenUsagePercent === "number")
      updateTokenRing(s.tokenUsagePercent);

    if (s && s.activeSessionId && !inChat && !autoRestoreSessionAttempted) {
      autoRestoreSessionAttempted = true;
      vscode.postMessage({ type: "openSession", payload: s.activeSessionId });
    }

    if (!ok && !offlineRetryTimer) {
      offlineRetryTimer = setInterval(() => {
        vscode.postMessage({ type: "ping" });
      }, 5000);
    }
    if (ok && offlineRetryTimer) {
      clearInterval(offlineRetryTimer);
      offlineRetryTimer = null;
    }
  }

  // ── Token ring ────────────────────────────────────────────────────────

  function updateTokenRing(pct: number): void {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    const ring = D("tokenRing");
    const arc = D("tokenRingArc");
    const label = D("tokenRingPct");
    if (ring) ring.classList.toggle("visible", pct > 0);
    if (arc) arc.setAttribute("stroke-dasharray", pct + " " + (100 - pct));
    if (label) label.textContent = pct + "%";
  }

  function updateModels(list: ModelInfo[]): void {
    models = list || [];
    const prev = modelSelect.value;
    modelSelect.innerHTML = "";

    if (!models.length) {
      modelSelect.innerHTML = '<option value="">No models found</option>';
      return;
    }
    for (const model of models) {
      const o = document.createElement("option");
      o.value = model.name;
      o.text = describeModelOption(model);
      o.title = describeModelTooltip(model);
      modelSelect.appendChild(o);
    }
    if (models.some((m) => m.name === prev)) modelSelect.value = prev;
  }

  // ── Send task ─────────────────────────────────────────────────────────

  const sendArrowSvg =
    '<svg class="send-arrow" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';

  function setBusyMode(busy: boolean): void {
    isBusy = busy;
    if (busy) {
      btnSend.disabled = false;
      btnSend.classList.add("stop");
      btnSend.title = "Stop";
      btnSend.innerHTML = "&#9632;";
    } else {
      btnSend.classList.remove("stop");
      btnSend.title =
        composeState.mode === "edit"
          ? "Save & Send"
          : composeState.mode === "retry"
            ? "Retry"
            : "Send (Enter)";
      btnSend.innerHTML = sendArrowSvg;
      btnSend.disabled = taskInput ? taskInput.value.trim().length === 0 : true;
    }
  }

  function sendTask(): void {
    if (isBusy) {
      vscode.postMessage({ type: "cancelTask" });
      setBusyMode(false);
      finishThinking();
      return;
    }
    if (!taskInput) return;
    const text = taskInput.value.trim();
    if (!text) return;

    const action = composeState.mode || "new";
    const messageId = composeState.messageId || "";
    let messageIndex = composeState.messageIndex;

    if (action === "edit" && messageId) {
      if (
        messageIndex < 0 ||
        !chatHistory[messageIndex] ||
        String(chatHistory[messageIndex].id || "") !== messageId
      ) {
        messageIndex = -1;
        for (let j = chatHistory.length - 1; j >= 0; j--) {
          if (String(chatHistory[j].id || "") === messageId) {
            messageIndex = j;
            break;
          }
        }
      }
      if (messageIndex >= 0) {
        chatHistory[messageIndex].text = text;
        chatHistory[messageIndex].content = text;
        chatHistory = chatHistory.slice(0, messageIndex + 1);
      }
      renderMessages();
    }

    taskInput.value = "";
    taskInput.style.height = "auto";
    setBusyMode(true);
    pendingRequest = { action, messageId };

    if (action === "new") {
      chatHistory.push({
        id: makeMessageId(),
        role: "user",
        text,
        ts: Date.now(),
      });
      renderMessages();
    }

    showChat();
    startThinking();
    resetDrawers();
    scrollBottom();
    vscode.postMessage({
      type: "runTask",
      payload: { objective: text, action, messageId },
    });

    // Clear image previews after sending
    if (attachmentRow) {
      const imgPreviews = attachmentRow.querySelectorAll(".img-preview");
      for (const ip of imgPreviews) ip.parentNode?.removeChild(ip);
    }
    resetComposeState();
  }

  // ── Event listeners ───────────────────────────────────────────────────

  on(taskInput, "input", () => {
    if (taskInput) autoGrow(taskInput);
    if (!isBusy && taskInput)
      btnSend.disabled = taskInput.value.trim().length === 0;
  });
  on(taskInput, "keydown", (e) => {
    if (
      (e as KeyboardEvent).key === "Enter" &&
      !(e as KeyboardEvent).shiftKey
    ) {
      e.preventDefault();
      sendTask();
    }
  });
  on(btnSend, "click", sendTask);

  // Scroll-to-bottom button
  (() => {
    const mainEl = D("main");
    if (mainEl) mainEl.addEventListener("scroll", updateScrollButton);
    on(scrollBtn, "click", scrollBottom);
  })();

  // Code-copy event delegation
  on(messagesEl, "click", (e) => {
    const btn = e.target as HTMLElement;
    if (!btn?.classList?.contains("code-copy")) return;
    e.stopPropagation();
    const header = btn.parentNode as HTMLElement | null;
    const block = header?.nextElementSibling;
    if (block && block.tagName === "PRE") {
      navigator.clipboard.writeText(block.textContent || "").then(() => {
        const prev = btn.textContent;
        btn.textContent = "\u2713 Copied";
        setTimeout(() => {
          btn.textContent = prev;
        }, 1500);
      });
    }
  });

  // Self-learn toggle
  on(selfLearnToggle, "change", () => {
    if (selfLearnToggle)
      vscode.postMessage({
        type: "setSelfLearn",
        payload: selfLearnToggle.checked,
      });
  });

  // Summary verbosity select
  on(summaryVerbositySelect, "change", () => {
    if (summaryVerbositySelect)
      vscode.postMessage({
        type: "setSummaryVerbosity",
        payload: summaryVerbositySelect.value,
      });
  });

  // Compact summary toggle
  on(compactSummaryToggle, "change", () => {
    if (!compactSummaryToggle) return;
    const nv = compactSummaryToggle.checked ? "compact" : "normal";
    if (summaryVerbositySelect) summaryVerbositySelect.value = nv;
    vscode.postMessage({ type: "setSummaryVerbosity", payload: nv });
  });

  // ── Drag-and-drop file attach ─────────────────────────────────────────
  (() => {
    const dropOverlay = D("dropOverlay");
    if (!dropOverlay) return;
    let dragCounter = 0;

    document.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragCounter++;
      if (dragCounter === 1) dropOverlay.classList.add("active");
    });
    document.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dropOverlay.classList.remove("active");
      }
    });
    document.addEventListener("dragover", (e) => {
      e.preventDefault();
    });
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      dragCounter = 0;
      dropOverlay.classList.remove("active");

      const items = e.dataTransfer?.items;
      if (!items || !items.length) return;
      const paths: string[] = [];
      const imageFiles: File[] = [];

      const uriList = e.dataTransfer?.getData("text/uri-list") || "";
      if (uriList.trim()) {
        uriList.split(/\r?\n/).forEach((line) => {
          const value = line.trim();
          if (value && value.charAt(0) !== "#") paths.push(value);
        });
      }

      const plainText = e.dataTransfer?.getData("text/plain") || "";
      if (plainText.trim()) {
        plainText.split(/\r?\n/).forEach((line) => {
          const value = line.trim();
          if (value && value.indexOf("file:") === 0) paths.push(value);
        });
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file && file.name) {
            const ext = (file.name.split(".").pop() || "").toLowerCase();
            const isImage =
              ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].indexOf(
                ext,
              ) !== -1;
            if (isImage && file.size < 10 * 1024 * 1024) {
              imageFiles.push(file);
            } else {
              paths.push((file as any).path || file.name);
            }
          }
        } else if (
          item.kind === "string" &&
          (item.type === "text/plain" || item.type === "text/uri-list")
        ) {
          item.getAsString((s) => {
            if (s?.trim()) {
              s.split(/\r?\n/).forEach((line) => {
                const value = line.trim();
                if (value && value.charAt(0) !== "#") {
                  vscode.postMessage({ type: "dropFiles", payload: [value] });
                }
              });
            }
          });
        }
      }

      if (paths.length > 0)
        vscode.postMessage({ type: "dropFiles", payload: paths });

      imageFiles.forEach((imgFile) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = ev.target?.result;
          if (typeof dataUrl === "string") {
            addImagePreview(imgFile.name, dataUrl);
            vscode.postMessage({
              type: "dropImage",
              payload: { name: imgFile.name, dataUrl },
            });
          }
        };
        reader.readAsDataURL(imgFile);
      });
    });
  })();

  // ── Paste image handler ───────────────────────────────────────────────
  if (taskInput) {
    taskInput.addEventListener("paste", (e) => {
      const items = (e as ClipboardEvent).clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image/") === 0) {
          const file = items[i].getAsFile();
          if (!file) continue;
          const name = file.name || "pasted-image.png";
          const reader = new FileReader();
          reader.onload = (ev) => {
            const dataUrl = ev.target?.result;
            if (typeof dataUrl === "string") {
              addImagePreview(name, dataUrl);
              vscode.postMessage({
                type: "dropImage",
                payload: { name, dataUrl },
              });
            }
          };
          reader.readAsDataURL(file);
        }
      }
    });
  }

  // ── Tool configuration panel ──────────────────────────────────────────

  const TOOL_DEFS: ToolDef[] = [
    {
      id: "workspace_scan",
      name: "Workspace Scan",
      desc: "Discover project files and structure",
    },
    {
      id: "read_files",
      name: "Read Files",
      desc: "Read source file contents for context",
    },
    {
      id: "create_file",
      name: "Create File",
      desc: "Create new files in the workspace",
    },
    {
      id: "delete_file",
      name: "Delete File",
      desc: "Remove files from the workspace",
    },
    {
      id: "search_files",
      name: "Search Files",
      desc: "Regex search across workspace files",
    },
    {
      id: "list_dir",
      name: "List Directory",
      desc: "List contents of a directory",
    },
    {
      id: "run_terminal",
      name: "Terminal",
      desc: "Run shell commands (build, test, install)",
    },
    {
      id: "run_verification",
      name: "Verification",
      desc: "Run diagnostics and linting checks",
    },
    {
      id: "web_search",
      name: "Web Search",
      desc: "Search the internet for documentation",
    },
    { id: "git_diff", name: "Git Diff", desc: "View source control changes" },
    { id: "mcp_status", name: "MCP Status", desc: "Check MCP server health" },
    {
      id: "diagnostics",
      name: "Diagnostics",
      desc: "Retrieve active editor diagnostics",
    },
    {
      id: "batch_edit",
      name: "Batch Edit",
      desc: "Apply targeted changes to multiple files at once",
    },
    {
      id: "rename_file",
      name: "Rename/Move",
      desc: "Rename or move files in the workspace",
    },
    {
      id: "find_references",
      name: "Find References",
      desc: "Find all usages of a symbol across the workspace",
    },
    {
      id: "file_search",
      name: "File Search",
      desc: "Find files by name or glob pattern",
    },
    {
      id: "get_problems",
      name: "Problems",
      desc: "Get VS Code diagnostics and errors",
    },
    {
      id: "get_terminal_output",
      name: "Terminal Output",
      desc: "Get the last terminal command output",
    },
    {
      id: "write_file",
      name: "Write File",
      desc: "Write or overwrite a file with full content",
    },
    {
      id: "replace_in_file",
      name: "Replace in File",
      desc: "Targeted search-and-replace within a file",
    },
    {
      id: "grep_search",
      name: "Grep Search",
      desc: "Regex or literal search across workspace files",
    },
    {
      id: "get_definitions",
      name: "Go to Definition",
      desc: "LSP-backed symbol definition lookup",
    },
    {
      id: "get_references",
      name: "Find References (LSP)",
      desc: "LSP-backed find all references to a symbol",
    },
    {
      id: "get_document_symbols",
      name: "Document Symbols",
      desc: "List all symbols in a file (functions, classes, etc.)",
    },
    {
      id: "rename_symbol",
      name: "Rename Symbol",
      desc: "LSP-backed rename a symbol across the workspace",
    },
    {
      id: "git_commit",
      name: "Git Commit",
      desc: "Stage files and create a git commit",
    },
    {
      id: "git_status",
      name: "Git Status",
      desc: "Show current working tree status",
    },
    { id: "git_log", name: "Git Log", desc: "Show recent commit history" },
    {
      id: "git_file_history",
      name: "Git File History",
      desc: "Inspect commit history for a specific file",
    },
    {
      id: "git_blame",
      name: "Git Blame",
      desc: "Inspect blame details for a file or line",
    },
    {
      id: "git_branch",
      name: "Git Branch",
      desc: "Create, list, or switch branches",
    },
  ];

  const enabledTools: Record<string, boolean> = {};
  TOOL_DEFS.forEach((t) => {
    enabledTools[t.id] = true;
  });

  function renderToolConfig(): void {
    const list = D("toolConfigList");
    if (!list) return;
    list.innerHTML = TOOL_DEFS.map((t) => {
      const checked = enabledTools[t.id] !== false ? " checked" : "";
      return (
        '<div class="tool-config-item"><label><input type="checkbox" data-tool="' +
        esc(t.id) +
        '"' +
        checked +
        " />" +
        esc(t.name) +
        '</label></div><div class="tool-config-desc">' +
        esc(t.desc) +
        "</div>"
      );
    }).join("");

    list
      .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((cb) => {
        cb.addEventListener("change", () => {
          enabledTools[cb.dataset.tool!] = cb.checked;
          vscode.postMessage({
            type: "setEnabledTools",
            payload: enabledTools,
          });
        });
      });
  }

  renderToolConfig();

  on(D("btnToolsAll"), "click", () => {
    TOOL_DEFS.forEach((t) => {
      enabledTools[t.id] = true;
    });
    renderToolConfig();
    vscode.postMessage({ type: "setEnabledTools", payload: enabledTools });
  });
  on(D("btnToolsNone"), "click", () => {
    TOOL_DEFS.forEach((t) => {
      enabledTools[t.id] = false;
    });
    renderToolConfig();
    vscode.postMessage({ type: "setEnabledTools", payload: enabledTools });
  });

  // ── MCP utilities ─────────────────────────────────────────────────────

  function normalizeMcpServer(s: Partial<McpServerConfig>): McpServerConfig {
    const t = String(s.transport || "stdio");
    let args: string[] = [];
    if (Array.isArray(s.args)) args = s.args.map(String);
    else if (typeof s.args === "string") {
      args = (s.args as string)
        .split(/\r?\n/)
        .map((a: string) => a.trim())
        .filter(Boolean);
    }
    return {
      id: String(s.id || ""),
      enabled: s.enabled !== false,
      trust: String(s.trust || "workspace"),
      transport: t,
      command: String(s.command || ""),
      url: String(s.url || ""),
      args,
    };
  }

  function parseArgs(text: string): string[] {
    const raw = String(text || "").trim();
    if (!raw) return [];
    if (raw.charAt(0) === "[") {
      const p = JSON.parse(raw);
      if (!Array.isArray(p)) throw new Error("Args must be JSON array");
      return p.map(String);
    }
    return raw
      .split(/\r?\n/)
      .map((a) => a.trim())
      .filter(Boolean);
  }

  function renderMcpServers(list: Partial<McpServerConfig>[]): void {
    mcpServers = (list || []).map(normalizeMcpServer);
    mcpCount.textContent =
      mcpServers.length === 1
        ? "1 configured"
        : mcpServers.length + " configured";

    if (!mcpServers.length) {
      mcpList.innerHTML =
        '<div class="mcp-empty fadein">No MCP servers. Add one to connect tools.</div>';
      return;
    }
    mcpList.innerHTML = "";

    mcpServers.forEach((server, idx) => {
      const card = document.createElement("div") as HTMLElement & {
        _read?: () => McpServerConfig;
      };
      card.className = "mcp-card fadein";
      card.dataset.index = String(idx);

      const epLabel = server.transport === "stdio" ? "Command" : "URL";
      const epValue =
        server.transport === "stdio" ? server.command : server.url;

      card.innerHTML =
        '<div class="mcp-card-head"><div class="mcp-card-title"><input type="text" data-field="id" placeholder="server-name" value="' +
        esc(server.id) +
        '" /></div><label class="mcp-chip"><input type="checkbox" data-field="enabled" ' +
        (server.enabled ? "checked" : "") +
        '/> On</label><button type="button" class="btn danger sm" data-action="remove">Remove</button></div>' +
        '<div class="mcp-grid"><select data-field="transport"><option value="stdio">stdio</option><option value="http">http</option><option value="sse">sse</option></select><select data-field="trust"><option value="workspace">workspace</option><option value="user">user</option><option value="system">system</option></select><div class="mcp-chip">' +
        esc(epLabel) +
        "</div></div>" +
        '<input type="text" data-field="endpoint" placeholder="' +
        esc(epLabel) +
        '" value="' +
        esc(epValue) +
        '" />' +
        '<textarea data-field="args" placeholder="[&quot;arg1&quot;, &quot;arg2&quot;]">' +
        esc((server.args || []).join("\n")) +
        "</textarea>";

      const ts = card.querySelector(
        'select[data-field="transport"]',
      ) as HTMLSelectElement;
      const trs = card.querySelector(
        'select[data-field="trust"]',
      ) as HTMLSelectElement;
      const ep = card.querySelector(
        'input[data-field="endpoint"]',
      ) as HTMLInputElement;
      const ar = card.querySelector(
        'textarea[data-field="args"]',
      ) as HTMLTextAreaElement;
      const en = card.querySelector(
        'input[data-field="enabled"]',
      ) as HTMLInputElement;

      ts.value = server.transport;
      trs.value = server.trust;

      const syncEp = () => {
        ep.placeholder = ts.value === "stdio" ? "Command" : "URL";
        ar.style.display = ts.value === "stdio" ? "block" : "none";
      };
      ts.addEventListener("change", syncEp);
      syncEp();

      card._read = () => ({
        id: String(
          (card.querySelector('input[data-field="id"]') as HTMLInputElement)
            .value || "",
        ).trim(),
        enabled: Boolean(en.checked),
        trust: String(trs.value || "workspace"),
        transport: String(ts.value || "stdio"),
        command: String(ts.value === "stdio" ? ep.value || "" : ""),
        url: String(ts.value === "stdio" ? "" : ep.value || ""),
        args: parseArgs(String(ar.value || "")),
      });

      card
        .querySelector('[data-action="remove"]')!
        .addEventListener("click", () => {
          const cur = snapshotMcpServers();
          cur.splice(idx, 1);
          renderMcpServers(cur);
        });

      mcpList.appendChild(card);
    });
  }

  function collectMcpServers(): McpServerConfig[] {
    return Array.from(mcpList.querySelectorAll(".mcp-card"))
      .map((c) =>
        typeof (c as any)._read === "function" ? (c as any)._read() : null,
      )
      .filter(Boolean)
      .filter((s: McpServerConfig) => {
        if (!s.id) return false;
        if (s.transport === "stdio" && !s.command)
          throw new Error("Stdio server needs a command.");
        if ((s.transport === "http" || s.transport === "sse") && !s.url)
          throw new Error("HTTP/SSE server needs a URL.");
        return true;
      });
  }

  function snapshotMcpServers(): McpServerConfig[] {
    return Array.from(mcpList.querySelectorAll(".mcp-card"))
      .map((c) =>
        typeof (c as any)._read === "function" ? (c as any)._read() : null,
      )
      .filter(Boolean);
  }

  // ── Navigation ────────────────────────────────────────────────────────

  function showHome(): void {
    inChat = false;
    homeView.classList.remove("hidden");
    chatView.classList.add("hidden");
  }

  function showChat(): void {
    inChat = true;
    homeView.classList.add("hidden");
    chatView.classList.remove("hidden");
    scrollBottom();
  }

  // ── Toolbar buttons ───────────────────────────────────────────────────

  on(btnNewChat, "click", () => {
    autoRestoreSessionAttempted = true;
    chatHistory = [];
    attachedFiles = [];
    pendingRequest = null;
    resetComposeState();
    resetDrawers();
    resetThinkingPanel();
    resetBannerBtns();
    if (editsBanner) editsBanner.classList.remove("on");
    if (bannerTxt) bannerTxt.textContent = "Pending edits ready";
    renderAttachments(attachedFiles);
    renderMessages();
    showChat();
    vscode.postMessage({ type: "newConversation" });
    if (taskInput) taskInput.focus();
  });

  on(btnBack, "click", showHome);
  on(btnAttach, "click", () => {
    vscode.postMessage({ type: "attachContext" });
  });
  on(btnSettings, "click", () => {
    settingsDrawer.classList.toggle("open");
  });
  on(btnRefresh, "click", () => {
    vscode.postMessage({ type: "ping" });
  });

  on(chipMode, "click", (e) => {
    e.stopPropagation();
    modePopupOpen ? closeModePopup() : openModePopup();
  });

  (() => {
    const p = D("modePopup");
    if (!p) return;
    p.querySelectorAll<HTMLButtonElement>(".popup-opt").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const m = btn.dataset.mode;
        if (m && m !== conversationMode)
          vscode.postMessage({ type: "setConversationMode", payload: m });
        closeModePopup();
      });
    });
  })();

  on(chipModel, "click", (e) => {
    e.stopPropagation();
    modelPopupOpen ? closeModelPopup() : openModelPopup();
  });

  // Permission bar
  on(permBtn, "click", (e) => {
    e.stopPropagation();
    permPopupOpen ? closePermPopup() : openPermPopup();
  });

  (() => {
    const p = D("permPopup");
    if (!p) return;
    p.querySelectorAll<HTMLButtonElement>(".perm-opt").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const m = btn.dataset.perm;
        if (m) {
          vscode.postMessage({ type: "setPermissionMode", payload: m });
          updatePermUI(m);
        }
        closePermPopup();
      });
    });
  })();

  on(btnSyncModels, "click", () => {
    vscode.postMessage({ type: "refreshModels" });
  });
  on(btnApplyModel, "click", () => {
    const m = modelSelect.value;
    if (m) {
      vscode.postMessage({
        type: "setModel",
        payload: { role: "planner", model: m },
      });
      vscode.postMessage({
        type: "setModel",
        payload: { role: "editor", model: m },
      });
      vscode.postMessage({
        type: "setModel",
        payload: { role: "fast", model: m },
      });
    }
  });
  on(personaSelect, "change", () => {
    if (personaSelect)
      vscode.postMessage({ type: "setPersona", payload: personaSelect.value });
  });

  on(btnAddMcp, "click", () => {
    mcpServers = snapshotMcpServers().concat([
      normalizeMcpServer({
        enabled: true,
        trust: "workspace",
        transport: "stdio",
        args: [],
      }),
    ]);
    renderMcpServers(mcpServers);
  });
  on(btnReloadMcp, "click", () => {
    vscode.postMessage({ type: "reloadMcpServers" });
  });
  on(btnOpenMcpSettings, "click", () => {
    vscode.postMessage({ type: "configureMcpServers" });
  });
  on(btnManageMcp, "click", () => {
    vscode.postMessage({ type: "manageMcpConnections" });
  });
  on(btnSaveMcp, "click", () => {
    try {
      vscode.postMessage({
        type: "saveMcpServers",
        payload: collectMcpServers(),
      });
    } catch {}
  });

  // Edits banner
  function resetBannerBtns(): void {
    btnApply.textContent = "Approve";
    btnApply.className = "btn primary sm";
    btnRevert.textContent = "Reject";
    btnRevert.className = "btn danger sm";
  }

  on(btnApply, "click", () => {
    resetBannerBtns();
    vscode.postMessage({ type: "applyPending", payload: true });
  });
  on(btnRevert, "click", () => {
    resetBannerBtns();
    vscode.postMessage({ type: "revertLast", payload: true });
  });

  // ── Message handler ───────────────────────────────────────────────────

  window.addEventListener("message", (event) => {
    const data = event.data || {};
    const type: string = data.type;
    const payload: any = data.payload;

    if (type === "runtimeSummary") {
      renderSummary(payload);
      return;
    }
    if (type === "models") {
      updateModels(payload);
      return;
    }
    if (type === "mcpServers") {
      renderMcpServers(payload);
      return;
    }
    if (type === "sessions") {
      renderSessions(payload);
      return;
    }
    if (type === "sessionLoaded") {
      renderLoadedSession(payload);
      return;
    }
    if (type === "sessionDeleted") {
      handleSessionDeleted(payload);
      return;
    }
    if (type === "sessionAttachments") {
      renderAttachments(payload);
      return;
    }

    if (type === "dropImage") {
      if (payload?.name && payload?.dataUrl)
        addImagePreview(payload.name, payload.dataUrl);
      return;
    }

    if (type === "thinkingStep") {
      addThinkingStep(payload);
      return;
    }

    if (type === "terminalOutput") {
      if (payload && typeof payload.command === "string") {
        const termId = makeMessageId();
        const exitOk = payload.exitCode === 0;
        const termHtml =
          '<div class="terminal-chat-block' +
          (exitOk ? "" : " terminal-error") +
          '">' +
          '<div class="terminal-chat-header" data-termid="' +
          esc(termId) +
          '" data-command="' +
          esc(payload.command) +
          '">' +
          '<span class="terminal-chat-icon">&#9654;</span>' +
          '<span class="terminal-chat-cmd">$ ' +
          esc(payload.command) +
          "</span>" +
          '<span class="terminal-chat-status">' +
          (exitOk
            ? "\u2713"
            : "\u2717 exit " +
              (payload.exitCode != null ? payload.exitCode : "?")) +
          "</span>" +
          '<span class="terminal-chat-actions">' +
          '<button class="terminal-action-btn terminal-rerun" title="Re-run">\u21BB</button>' +
          '<button class="terminal-action-btn terminal-copy" title="Copy">\u2398</button>' +
          "</span>" +
          '<span class="terminal-chat-toggle">\u25BC</span>' +
          "</div>" +
          '<pre class="terminal-chat-output hidden">' +
          esc(payload.output || "(no output)") +
          "</pre></div>";

        chatHistory.push({
          id: termId,
          role: "terminal",
          text: termHtml,
          ts: Date.now(),
          isHtml: true,
        });
        renderMessages();
        scrollBottom();
      }
      return;
    }

    if (type === "clarificationRequest") {
      const q = payload?.question
        ? String(payload.question)
        : "Clarification needed";
      const opts: string[] = Array.isArray(payload?.options)
        ? payload.options
        : [
            "Inspect logs",
            "Attempt automatic fix and rerun",
            "Skip and continue",
          ];

      const box = document.createElement("div");
      box.className = "clarify-box fadein";
      const txtDiv = document.createElement("div");
      txtDiv.className = "clarify-text";
      txtDiv.textContent = q;
      box.appendChild(txtDiv);

      const actions = document.createElement("div");
      actions.className = "clarify-actions";
      opts.forEach((opt, oi) => {
        const btn = document.createElement("button");
        btn.className = "clarify-btn" + (oi === 0 ? " primary" : "");
        btn.textContent = opt;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          vscode.postMessage({
            type: "clarificationResponse",
            payload: { selection: opt },
          });
          box.parentNode?.removeChild(box);
        });
        actions.appendChild(btn);
      });
      box.appendChild(actions);
      messagesEl.appendChild(box);
      scrollBottom();
      return;
    }

    if (type === "streamChunk") {
      if (!isBusy) return;
      streamBuffer += payload || "";
      if (looksLikeStructuredAgentPayload(streamBuffer)) {
        if (streamFlushTimer) {
          clearInterval(streamFlushTimer);
          streamFlushTimer = null;
        }
        streamChunkQueue = [];
        streamRenderBuffer = "";
        if (streamBubble?.parentNode)
          streamBubble.parentNode.removeChild(streamBubble);
        streamBubble = null;
        return;
      }

      if (!streamBubble) {
        streamBubble = document.createElement("div");
        streamBubble.className = "msg agent fadein streaming-active";
        streamBubble.innerHTML =
          '<div class="bubble stream-bubble">' +
          '<div class="stream-placeholder">' +
          '<div class="stream-placeholder-line"></div>' +
          '<div class="stream-placeholder-line"></div>' +
          '<div class="stream-placeholder-line"></div>' +
          "</div>" +
          '<span class="stream-text" style="display:none"></span>' +
          '<span class="stream-cursor" style="display:none"></span></div>';
        messagesEl.appendChild(streamBubble);
        streamRenderBuffer = "";
      }

      streamChunkQueue.push(payload || "");
      if (!streamFlushTimer) {
        streamFlushTimer = setInterval(() => {
          if (streamChunkQueue.length === 0) {
            clearInterval(streamFlushTimer!);
            streamFlushTimer = null;
            return;
          }
          const chunk = streamChunkQueue.shift()!;
          streamRenderBuffer += chunk;
          if (streamBubble) {
            const ph = streamBubble.querySelector(".stream-placeholder");
            if (ph) ph.parentNode?.removeChild(ph);
            const textEl = streamBubble.querySelector(
              ".stream-text",
            ) as HTMLElement | null;
            const cursor = streamBubble.querySelector(
              ".stream-cursor",
            ) as HTMLElement | null;
            if (textEl) {
              textEl.style.display = "inline";
              textEl.innerHTML = renderMarkdown(streamRenderBuffer);
            }
            if (cursor) cursor.style.display = "inline-block";
          }
          scrollBottom();
        }, 18);
      }
      return;
    }

    if (type === "taskResult") {
      const isCancelled = payload?.cancelled;
      if (streamFlushTimer) {
        clearInterval(streamFlushTimer);
        streamFlushTimer = null;
      }
      streamChunkQueue = [];
      streamRenderBuffer = "";
      if (streamBubble?.parentNode)
        streamBubble.parentNode.removeChild(streamBubble);
      streamBubble = null;
      streamBuffer = "";
      finishThinking(isCancelled);

      if (!isCancelled) {
        if (payload?.todos?.length) renderTodoDrawer(payload.todos);
        if (payload?.fileDiffs?.length) renderFilesDrawer(payload.fileDiffs);

        let text: string = payload?.responseText || "Task completed.";
        text = cleanAgentResponseText(text);
        if (!text) text = "Task completed.";

        if (payload?.autoApplied && payload?.proposedEdits > 0) {
          text +=
            "\n\n\u2705 **" +
            payload.proposedEdits +
            " edit(s) auto-applied** (bypass mode active)";
        }
        if (payload?.proposedEdits > 0 && !payload?.autoApplied) {
          const fc = payload.proposedEdits;
          bannerTxt.textContent =
            fc +
            " file" +
            (fc === 1 ? "" : "s") +
            " changed \u2014 review before applying";
        }

        const diffData =
          payload?.fileDiffs?.length > 0 ? payload.fileDiffs : null;
        const wasAutoApplied = Boolean(payload?.autoApplied);
        const shouldReplaceAgent =
          pendingRequest?.action === "retry" && pendingRequest?.messageId;

        if (shouldReplaceAgent) {
          let replaced = false;
          for (let k = chatHistory.length - 1; k >= 0; k--) {
            if (
              String(chatHistory[k].id || "") ===
              String(pendingRequest!.messageId)
            ) {
              chatHistory[k].text = text;
              chatHistory[k].content = text;
              chatHistory[k].ts = Date.now();
              chatHistory[k].role = "assistant";
              chatHistory[k].fileDiffs = diffData;
              chatHistory[k].autoApplied = wasAutoApplied;
              replaced = true;
              break;
            }
          }
          if (!replaced) {
            chatHistory.push({
              id: makeMessageId(),
              role: "agent",
              text,
              ts: Date.now(),
              fileDiffs: diffData,
              autoApplied: wasAutoApplied,
            });
          }
        } else {
          chatHistory.push({
            id: makeMessageId(),
            role: "agent",
            text,
            ts: Date.now(),
            fileDiffs: diffData,
            autoApplied: wasAutoApplied,
          });
        }
        renderMessages();
        scrollBottom();
      }
      pendingRequest = null;
      vscode.postMessage({ type: "ping" });
      return;
    }

    if (type === "actionResult") {
      finishThinking(false);
      const txt = String(payload || "");
      if (
        txt &&
        txt.indexOf("Approval mode set") !== 0 &&
        txt.indexOf("Permission mode set") !== 0 &&
        txt.indexOf("Updated ") !== 0 &&
        txt.indexOf("Mode set to") !== 0 &&
        txt.indexOf("MCP servers updated") !== 0
      ) {
        chatHistory.push({
          id: makeMessageId(),
          role: "agent",
          text: txt,
          ts: Date.now(),
        });
        renderMessages();
        scrollBottom();
      }
      pendingRequest = null;
      vscode.postMessage({ type: "ping" });
      return;
    }
  });

  // ── Bootstrap ─────────────────────────────────────────────────────────

  if (initialSummary) renderSummary(initialSummary);

  window.addEventListener("error", (e) => {
    surfaceFatalError(
      e?.error
        ? String(e.error.stack || e.error.message || e.error)
        : String(e.message || "Unknown error"),
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    surfaceFatalError(
      String(
        e?.reason
          ? e.reason.stack || e.reason.message || e.reason
          : "Unhandled rejection",
      ),
    );
  });

  vscode.postMessage({ type: "webviewReady" });
  vscode.postMessage({ type: "loadDashboard" });
  setTimeout(() => {
    if (!summary) vscode.postMessage({ type: "ping" });
  }, 800);
  setTimeout(() => {
    if (!summary) vscode.postMessage({ type: "ping" });
  }, 3000);
  setInterval(() => {
    vscode.postMessage({ type: "ping" });
  }, 30000);

  // Auto-focus textarea
  window.addEventListener("focus", () => {
    if (taskInput && !isBusy) setTimeout(() => taskInput!.focus(), 0);
  });
  setTimeout(() => {
    if (taskInput) taskInput.focus();
  }, 200);
} catch (error) {
  surfaceFatalError(
    error instanceof Error ? error.stack || error.message : String(error),
  );
}
