import * as path from "path";
import * as vscode from "vscode";

import type { AgentRuntime } from "../agent/runtime/AgentRuntime";
import type { Logger } from "../platform/vscode/Logger";

export function registerCommands(
  context: vscode.ExtensionContext,
  runtime: AgentRuntime,
  logger: Logger,
): void {
  const commandHandlers: Array<[string, (...args: unknown[]) => unknown]> = [
    ["pulse.openPanel", () => openPanel(runtime)],
    ["pulse.startNewTask", () => startNewTask(runtime)],
    ["pulse.explainSelection", () => explainSelection(runtime)],
    ["pulse.fixDiagnosticsCurrentFile", () => showDiagnosticsSummary(runtime)],
    ["pulse.refactorWorkspaceScope", () => startWorkspaceRefactor(runtime)],
    ["pulse.resumeLastSession", () => resumeLastSession(runtime)],
    ["pulse.applyProposedChanges", () => applyProposedChanges(runtime)],
    ["pulse.revertLastAgentChanges", () => revertLastChanges(runtime)],
    ["pulse.reindexWorkspace", () => reindexWorkspace(runtime)],
    ["pulse.manageMcpConnections", () => manageMcpConnections(runtime)],
    ["pulse.configureMcpServers", () => configureMcpServers()],
    ["pulse.openDiagnosticsReport", () => openDiagnostics(runtime)],
    ["pulse.selectModels", () => selectModels(runtime)],
    ["pulse.setApprovalMode", () => setApprovalMode(runtime)],
    ["pulse.listSkills", () => listSkills(runtime)],
    ["pulse.runPrepublishGuard", () => runPrepublishGuard(runtime)],
    ["pulse.searchWeb", () => searchWeb(runtime)],
    ["pulse.showGitCommitHistory", () => showGitCommitHistory(runtime)],
    [
      "pulse.showGitFileHistory",
      (filePath) => showGitFileHistory(runtime, filePath),
    ],
    ["pulse.showGitBlame", (payload) => showGitBlame(runtime, payload)],
    ["pulse.setTavilyApiKey", () => setTavilyApiKey(context)],
    ["pulse.clearTavilyApiKey", () => clearTavilyApiKey(context)],
  ];

  for (const [commandId, handler] of commandHandlers) {
    const disposable = vscode.commands.registerCommand(commandId, handler);
    context.subscriptions.push(disposable);
    logger.debug(`Registered command ${commandId}`);
  }
}

function info(message: string): void {
  void vscode.window.showInformationMessage(`Pulse: ${message}`);
}

function openPanel(runtime: AgentRuntime): void {
  const panel = vscode.window.createWebviewPanel(
    "pulse.panel",
    "Pulse",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
    },
  );

  void runtime.summary().then((summary) => {
    panel.webview.html = `<html><body style="font-family: var(--vscode-font-family); padding: 12px;">
    <h2>Pulse Panel</h2>
    <p>Runtime: ${summary.status}</p>
    <p>Ollama: ${summary.ollamaHealth}</p>
    <p>Planner model: ${summary.plannerModel}</p>
    <p>Editor model: ${summary.editorModel}</p>
    <p>Fast model: ${summary.fastModel}</p>
    <p>Use command palette for task execution and model selection.</p>
  </body></html>`;
  });
}

async function explainSelection(runtime: AgentRuntime): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Pulse: No active editor.");
    return;
  }

  const selectedText = editor.document.getText(editor.selection).trim();
  if (!selectedText) {
    void vscode.window.showWarningMessage(
      "Pulse: Select code to explain first.",
    );
    return;
  }

  const result = await runtime.explainText(selectedText);
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: `# Pulse Explanation\n\nModel: ${result.model}\n\n${result.text}`,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function openDiagnostics(runtime: AgentRuntime): Promise<void> {
  const content = await runtime.diagnosticsReportMarkdown();
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function startNewTask(runtime: AgentRuntime): Promise<void> {
  const objective = await vscode.window.showInputBox({
    title: "Pulse: Start New Task",
    prompt: "Describe the task objective",
    ignoreFocusOut: true,
  });

  if (!objective) {
    return;
  }

  const result = await runtime.runTask(objective);
  const proposalSummary = result.proposal
    ? `\n\n## Pending Edits\n\n${result.proposal.edits.map((e) => `- [${e.operation ?? "write"}] ${e.filePath}${e.targetPath ? ` -> ${e.targetPath}` : ""}`).join("\n")}`
    : "\n\nNo pending edits were proposed.";
  const todoSummary =
    result.todos.length > 0
      ? `\n\n## TODOs\n\n${result.todos.map((todo) => `- [${todo.status}] ${todo.title}${todo.detail ? ` — ${todo.detail}` : ""}`).join("\n")}`
      : "\n\nNo todos were generated.";
  const toolSummary = result.toolSummary
    ? `\n\n## Tools Used\n\n${result.toolSummary}`
    : "";
  const qualitySummary =
    typeof result.qualityScore === "number"
      ? `\n\n## Quality\n\nScore: ${result.qualityScore.toFixed(2)} / ${(result.qualityTarget ?? 0.9).toFixed(2)}\nTarget met: ${result.meetsQualityTarget ? "yes" : "no"}`
      : "";

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: `# Pulse Task Result\n\nSession: ${result.sessionId}\n\n## Objective\n\n${result.objective}\n\n## Plan\n\n\`\`\`json\n${JSON.stringify(result.plan, null, 2)}\n\`\`\`\n\n## Response\n\n${result.responseText}${todoSummary}${proposalSummary}${toolSummary}${qualitySummary}`,
  });

  await vscode.window.showTextDocument(doc, { preview: false });
}

async function startWorkspaceRefactor(runtime: AgentRuntime): Promise<void> {
  const objective = await vscode.window.showInputBox({
    title: "Pulse: Workspace Refactor",
    prompt: "Describe the refactor objective",
    ignoreFocusOut: true,
  });

  if (!objective) {
    return;
  }

  await startNewTaskWithObjective(runtime, objective);
}

async function startNewTaskWithObjective(
  runtime: AgentRuntime,
  objective: string,
): Promise<void> {
  const result = await runtime.runTask(objective);
  const todoSummary =
    result.todos.length > 0
      ? `\n\n## TODOs\n\n${result.todos.map((todo) => `- [${todo.status}] ${todo.title}${todo.detail ? ` — ${todo.detail}` : ""}`).join("\n")}`
      : "";
  const toolSummary = result.toolSummary
    ? `\n\n## Tools Used\n\n${result.toolSummary}`
    : "";
  const qualitySummary =
    typeof result.qualityScore === "number"
      ? `\n\n## Quality\n\nScore: ${result.qualityScore.toFixed(2)} / ${(result.qualityTarget ?? 0.9).toFixed(2)}\nTarget met: ${result.meetsQualityTarget ? "yes" : "no"}`
      : "";
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: `# Pulse Task Result\n\nSession: ${result.sessionId}\n\n## Objective\n\n${result.objective}\n\n## Response\n\n${result.responseText}${todoSummary}${toolSummary}${qualitySummary}`,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function resumeLastSession(runtime: AgentRuntime): Promise<void> {
  const summary = await runtime.resumeLastSessionSummary();
  await vscode.window.showInformationMessage(`Pulse: ${summary}`);
}

async function applyProposedChanges(runtime: AgentRuntime): Promise<void> {
  const needsApproval = runtime.needsApprovalForEdits();
  let approved = !needsApproval;

  if (needsApproval) {
    const pendingSummary = await runtime.getPendingProposalSummary();
    const decision = await vscode.window.showWarningMessage(
      `Pulse will apply pending proposal.\n\n${pendingSummary}`,
      { modal: true },
      "Apply",
    );

    if (decision !== "Apply") {
      return;
    }

    approved = true;
  }

  const result = await runtime.applyPendingEdits(approved);
  await vscode.window.showInformationMessage(`Pulse: ${result}`);
}

async function revertLastChanges(runtime: AgentRuntime): Promise<void> {
  const decision = await vscode.window.showWarningMessage(
    "Pulse will revert the last applied transaction.",
    { modal: true },
    "Revert",
  );

  if (decision !== "Revert") {
    return;
  }

  const result = await runtime.revertLastAppliedEdits();
  await vscode.window.showInformationMessage(`Pulse: ${result}`);
}

async function reindexWorkspace(runtime: AgentRuntime): Promise<void> {
  const result = await runtime.reindexWorkspace();
  await vscode.window.showInformationMessage(`Pulse: ${result}`);
}

async function manageMcpConnections(runtime: AgentRuntime): Promise<void> {
  const summary = await runtime.mcpSummary();
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: `# Pulse MCP Status\n\n\`\`\`text\n${summary}\n\`\`\`\n`,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function configureMcpServers(): Promise<void> {
  try {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "pulse.mcp.servers",
    );
  } catch {
    void vscode.window.showWarningMessage(
      "Pulse: open Settings and search for pulse.mcp.servers to configure MCP servers.",
    );
  }
}

async function showDiagnosticsSummary(runtime: AgentRuntime): Promise<void> {
  await vscode.window.showInformationMessage(
    `Pulse: ${runtime.diagnosticsSummary()}`,
  );
}

async function selectModels(runtime: AgentRuntime): Promise<void> {
  const models = await runtime.listAvailableModels();
  if (models.length === 0) {
    await vscode.window.showWarningMessage(
      "Pulse: No Ollama models discovered. Verify Ollama is running.",
    );
    return;
  }

  const role = await vscode.window.showQuickPick(
    ["planner", "editor", "fast", "embedding"],
    {
      title: "Select model role",
      placeHolder: "Choose the model slot to update",
    },
  );

  if (!role) {
    return;
  }

  const picked = await vscode.window.showQuickPick(
    models.map((m) => ({
      label: m.name,
      description: m.modifiedAt ?? "",
    })),
    {
      title: `Select ${role} model`,
      placeHolder: "Choose from locally available Ollama models",
    },
  );

  if (!picked) {
    return;
  }

  await runtime.selectModel(
    role as "planner" | "editor" | "fast" | "embedding",
    picked.label,
  );
  await vscode.window.showInformationMessage(
    `Pulse: Updated ${role} model to ${picked.label}`,
  );
}

async function setApprovalMode(runtime: AgentRuntime): Promise<void> {
  const mode = await vscode.window.showQuickPick(
    [
      { label: "full", description: "Auto-approve everything (Autopilot)" },
      {
        label: "default",
        description: "Auto-approve safe local actions, prompt for sensitive",
      },
      { label: "strict", description: "Prompt for every action" },
    ],
    {
      title: "Pulse Permission Mode",
      placeHolder: "Choose permission mode for agent actions",
    },
  );

  if (!mode) {
    return;
  }

  await runtime.setPermissionMode(mode.label as "full" | "default" | "strict");
  await vscode.window.showInformationMessage(
    `Pulse: Permission mode set to ${mode.label}`,
  );
}

async function listSkills(runtime: AgentRuntime): Promise<void> {
  const skills = runtime.listAvailableSkills();
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: [
      "# Pulse Skills Registry",
      "",
      ...skills.map(
        (skill) =>
          `- **${skill.name}** (\`${skill.id}\`): ${skill.description}\\n  - Keywords: ${skill.keywords.join(", ")}\\n  - Tools: ${skill.tools.join(", ")}`,
      ),
    ].join("\n"),
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function runPrepublishGuard(runtime: AgentRuntime): Promise<void> {
  const report = await runtime.runPrepublishGuard();
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: report.markdown,
  });
  await vscode.window.showTextDocument(doc, { preview: false });

  if (report.ok) {
    await vscode.window.showInformationMessage(
      "Pulse: Prepublish guard passed.",
    );
  } else {
    await vscode.window.showWarningMessage(
      "Pulse: Prepublish guard failed. Review the generated report.",
    );
  }
}

async function searchWeb(runtime: AgentRuntime): Promise<void> {
  const query = await vscode.window.showInputBox({
    title: "Pulse: Search the Web",
    prompt: "Enter a web search query",
    ignoreFocusOut: true,
  });

  if (!query) {
    return;
  }

  try {
    const result = await runtime.researchWeb(query);
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: formatWebSearchMarkdown(result),
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (error) {
    await vscode.window.showWarningMessage(
      `Pulse: Web search failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function showGitCommitHistory(runtime: AgentRuntime): Promise<void> {
  const git = runtime.getGitService();
  if (!(await git.isGitRepository())) {
    await vscode.window.showWarningMessage(
      "Pulse: This workspace is not a git repository.",
    );
    return;
  }

  const [entries, status] = await Promise.all([
    git.getLog(20),
    git.getStatus(),
  ]);
  if (entries.length === 0) {
    await vscode.window.showInformationMessage(
      "Pulse: No commit history is available.",
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: [
      "# Pulse Git Commit History",
      "",
      `Branch: ${status.branch}`,
      "",
      ...entries.map(
        (entry) =>
          `- \`${entry.hash.slice(0, 8)}\` ${entry.date} — ${entry.message}`,
      ),
    ].join("\n"),
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function showGitFileHistory(
  runtime: AgentRuntime,
  explicitFilePath?: unknown,
): Promise<void> {
  const git = runtime.getGitService();
  if (!(await git.isGitRepository())) {
    await vscode.window.showWarningMessage(
      "Pulse: This workspace is not a git repository.",
    );
    return;
  }

  const filePath = await resolveGitTargetFile(runtime, explicitFilePath);
  if (!filePath) {
    return;
  }

  const displayPath =
    vscode.workspace.asRelativePath(filePath, false) || filePath;
  const history = await git.getFileHistory(filePath, 20);
  if (history.length === 0) {
    await vscode.window.showInformationMessage(
      `Pulse: No git history found for ${displayPath}.`,
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: [
      "# Pulse Git File History",
      "",
      `File: ${displayPath}`,
      "",
      ...history.map(
        (entry) =>
          `- \`${entry.hash.slice(0, 8)}\` ${entry.date} ${entry.author} — ${entry.message}`,
      ),
    ].join("\n"),
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function showGitBlame(
  runtime: AgentRuntime,
  payload?: unknown,
): Promise<void> {
  const git = runtime.getGitService();
  if (!(await git.isGitRepository())) {
    await vscode.window.showWarningMessage(
      "Pulse: This workspace is not a git repository.",
    );
    return;
  }

  const parsed =
    typeof payload === "string"
      ? { filePath: payload }
      : isUriLike(payload)
        ? { filePath: payload.fsPath }
        : payload && typeof payload === "object"
          ? (payload as { filePath?: unknown; line?: unknown })
          : {};

  const filePath = await resolveGitTargetFile(runtime, parsed.filePath);
  if (!filePath) {
    return;
  }

  let line =
    typeof parsed.line === "number" && Number.isFinite(parsed.line)
      ? Math.max(1, Math.floor(parsed.line))
      : undefined;

  const activeEditor = vscode.window.activeTextEditor;
  if (
    !line &&
    activeEditor?.document.uri.scheme === "file" &&
    path.normalize(activeEditor.document.uri.fsPath) ===
      path.normalize(filePath)
  ) {
    line = activeEditor.selection.active.line + 1;
  }

  const blame = await git.getFileBlame(filePath, line);
  const displayPath =
    vscode.workspace.asRelativePath(filePath, false) || filePath;
  if (!blame || blame.length === 0) {
    await vscode.window.showInformationMessage(
      `Pulse: No blame information found for ${displayPath}.`,
    );
    return;
  }

  const visibleLines = blame.slice(0, line ? 1 : 40);
  const truncated = !line && blame.length > visibleLines.length;
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: [
      "# Pulse Git Blame",
      "",
      `File: ${displayPath}`,
      ...(line ? [`Line: ${line}`, ""] : [""]),
      ...visibleLines.map(
        (entry) =>
          `- Line ${entry.lineNumber}: \`${entry.commit.slice(0, 8)}\` ${entry.author} — ${entry.summary || "(no summary)"}\n  ${entry.text}`,
      ),
      ...(truncated
        ? [
            "",
            `_Showing the first ${visibleLines.length} blamed lines out of ${blame.length}._`,
          ]
        : []),
    ].join("\n"),
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function resolveGitTargetFile(
  runtime: AgentRuntime,
  explicitFilePath?: unknown,
): Promise<string | undefined> {
  const directPath = extractFilePathFromArg(explicitFilePath);
  if (directPath) {
    return resolveWorkspaceFilePath(directPath);
  }

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor?.document.uri.scheme === "file") {
    return activeEditor.document.uri.fsPath;
  }

  const diffSummary = await runtime.getGitService().getDiffSummary();
  if (diffSummary.isGitRepo && diffSummary.changedFiles.length > 0) {
    const picked = await vscode.window.showQuickPick(
      diffSummary.changedFiles.slice(0, 50).map((change) => ({
        label: change.relativePath,
        description: change.status,
      })),
      {
        title: "Pulse: Choose a file",
        placeHolder: "Select a git-tracked file to inspect",
      },
    );
    if (picked) {
      return resolveWorkspaceFilePath(picked.label);
    }
  }

  await vscode.window.showWarningMessage(
    "Pulse: Open a file or select one from git changes first.",
  );
  return undefined;
}

function resolveWorkspaceFilePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? path.join(root, filePath) : filePath;
}

function extractFilePathFromArg(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (isUriLike(value)) {
    return value.fsPath;
  }

  if (
    value &&
    typeof value === "object" &&
    "filePath" in value &&
    typeof (value as { filePath?: unknown }).filePath === "string"
  ) {
    return (value as { filePath: string }).filePath;
  }

  return undefined;
}

function isUriLike(value: unknown): value is { fsPath: string } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { fsPath?: unknown }).fsPath === "string"
  );
}

async function setTavilyApiKey(
  context: vscode.ExtensionContext,
): Promise<void> {
  const apiKey = await vscode.window.showInputBox({
    title: "Pulse: Set Tavily API Key",
    prompt: "Paste your Tavily API key",
    password: true,
    ignoreFocusOut: true,
  });

  if (!apiKey) {
    return;
  }

  await context.secrets.store("pulse.tavily.apiKey", apiKey.trim());
  await vscode.window.showInformationMessage(
    "Pulse: Tavily API key saved in VS Code Secret Storage. You can also set PULSE_TAVILY_API_KEY as an environment variable.",
  );
}

async function clearTavilyApiKey(
  context: vscode.ExtensionContext,
): Promise<void> {
  const decision = await vscode.window.showWarningMessage(
    "Pulse will remove the saved Tavily API key from VS Code Secret Storage.",
    { modal: true },
    "Remove",
  );

  if (decision !== "Remove") {
    return;
  }

  await context.secrets.delete("pulse.tavily.apiKey");
  await vscode.window.showInformationMessage("Pulse: Tavily API key removed.");
}

function formatWebSearchMarkdown(
  result: Awaited<ReturnType<AgentRuntime["researchWeb"]>>,
): string {
  const lines = [
    "# Pulse Web Search",
    "",
    `Query: ${result.query}`,
    `Provider: ${result.provider}`,
  ];

  if (result.answer) {
    lines.push(`Answer: ${result.answer}`);
  }

  if (result.note) {
    lines.push(`Note: ${result.note}`);
  }

  lines.push("", "## Results");

  if (result.results.length === 0) {
    lines.push("- No results returned.");
    return lines.join("\n");
  }

  for (const entry of result.results) {
    lines.push(
      `- ${entry.title}`,
      `  - Source: ${entry.source}`,
      `  - URL: ${entry.url}`,
      `  - ${entry.content}`,
    );
  }

  return lines.join("\n");
}
