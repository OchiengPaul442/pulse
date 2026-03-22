import * as vscode from "vscode";

import type { AgentRuntime } from "../agent/runtime/AgentRuntime";
import type { Logger } from "../platform/vscode/Logger";

export function registerCommands(
  context: vscode.ExtensionContext,
  runtime: AgentRuntime,
  logger: Logger,
): void {
  const commandHandlers: Array<[string, () => unknown]> = [
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
    ["pulse.openDiagnosticsReport", () => openDiagnostics(runtime)],
    ["pulse.selectModels", () => selectModels(runtime)],
    ["pulse.setApprovalMode", () => setApprovalMode(runtime)],
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

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: `# Pulse Task Result\n\nSession: ${result.sessionId}\n\n## Objective\n\n${result.objective}\n\n## Plan\n\n\`\`\`json\n${JSON.stringify(result.plan, null, 2)}\n\`\`\`\n\n## Response\n\n${result.responseText}${proposalSummary}`,
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
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: `# Pulse Task Result\n\nSession: ${result.sessionId}\n\n## Objective\n\n${result.objective}\n\n## Response\n\n${result.responseText}`,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function resumeLastSession(runtime: AgentRuntime): Promise<void> {
  const summary = await runtime.resumeLastSessionSummary();
  await vscode.window.showInformationMessage(`Pulse: ${summary}`);
}

async function applyProposedChanges(runtime: AgentRuntime): Promise<void> {
  const mode = runtime.getApprovalMode();
  const pendingSummary = await runtime.getPendingProposalSummary();
  if (mode !== "fast") {
    const decision = await vscode.window.showWarningMessage(
      `Pulse will apply pending proposal.\n\n${pendingSummary}`,
      { modal: true },
      "Apply",
    );

    if (decision !== "Apply") {
      return;
    }
  }

  const result = await runtime.applyPendingEdits();
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
  const summary = runtime.mcpSummary();
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: `# Pulse MCP Status\n\n\`\`\`text\n${summary}\n\`\`\`\n`,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
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
    ["strict", "balanced", "fast"],
    {
      title: "Pulse Approval Mode",
      placeHolder: "Choose approval mode for write actions",
    },
  );

  if (!mode) {
    return;
  }

  await runtime.setApprovalMode(mode as "strict" | "balanced" | "fast");
  await vscode.window.showInformationMessage(
    `Pulse: Approval mode set to ${mode}`,
  );
}
