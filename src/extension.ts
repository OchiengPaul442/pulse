import * as vscode from "vscode";

import { AgentRuntime } from "./agent/runtime/AgentRuntime";
import { registerCommands } from "./commands/registerCommands";
import { getAgentConfig } from "./config/AgentConfig";
import { bootstrapStorage } from "./db/StorageBootstrap";
import { createLogger } from "./platform/vscode/Logger";
import { PulseSidebarProvider } from "./views/PulseSidebarProvider";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const logger = createLogger();
  context.subscriptions.push({ dispose: () => logger.dispose() });

  logger.info("Activating Pulse extension...");

  const config = getAgentConfig();
  const storage = await bootstrapStorage(context, logger);
  const runtime = new AgentRuntime(config, storage, logger);
  await runtime.initialize();

  const sidebarProvider = new PulseSidebarProvider(
    context.extensionUri,
    runtime,
    logger,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PulseSidebarProvider.viewType,
      sidebarProvider,
    ),
  );

  registerCommands(context, runtime, logger);

  logger.info("Pulse extension activated.");
}

export function deactivate(): void {
  // No-op for now. Disposables are tracked in context subscriptions.
}
