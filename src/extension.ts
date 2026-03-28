import * as vscode from "vscode";

import { AgentRuntime } from "./agent/runtime/AgentRuntime";
import { registerCommands } from "./commands/registerCommands";
import { getAgentConfig, ProviderType } from "./config/AgentConfig";
import { bootstrapStorage } from "./db/StorageBootstrap";
import { createLogger } from "./platform/vscode/Logger";
import { ModelProvider } from "./agent/model/ModelProvider";
import { OllamaProvider } from "./agent/model/OllamaProvider";
import { OpenAICompatibleProvider } from "./agent/model/OpenAICompatibleProvider";
import { WebSearchService } from "./agent/search/WebSearchService";
import { PulseSidebarProvider } from "./views/PulseSidebarProvider";

function createProvider(
  type: ProviderType,
  ollamaBaseUrl: string,
  openaiBaseUrl: string,
  openaiApiKey: string,
  openaiModels: string[],
): ModelProvider {
  switch (type) {
    case "openai":
    case "anthropic":
    case "custom":
      return new OpenAICompatibleProvider({
        baseUrl: openaiBaseUrl,
        apiKey: openaiApiKey,
        models: openaiModels,
      });
    case "ollama":
    default:
      return new OllamaProvider(ollamaBaseUrl);
  }
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const logger = createLogger();
  context.subscriptions.push({ dispose: () => logger.dispose() });

  logger.info("Activating Pulse extension...");

  const config = getAgentConfig();
  const provider = createProvider(
    config.providerType,
    config.ollamaBaseUrl,
    config.openaiBaseUrl,
    config.openaiApiKey,
    config.openaiModels,
  );
  const storage = await bootstrapStorage(context, logger);
  const webSearchService = new WebSearchService(context.secrets, logger);
  const runtime = new AgentRuntime(
    config,
    storage,
    logger,
    webSearchService,
    provider,
  );
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
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  registerCommands(context, runtime, logger);

  logger.info("Pulse extension activated.");
}

export function deactivate(): void {
  // No-op for now. Disposables are tracked in context subscriptions.
}
