import * as vscode from "vscode";

import { AgentRuntime } from "./agent/runtime/AgentRuntime";
import { InlineCompletionProvider } from "./agent/completions/InlineCompletionProvider";
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

  try {
    logger.info("Activating Pulse extension...");

    const config = getAgentConfig();
    const provider = createProvider(
      config.providerType,
      config.ollamaBaseUrl,
      config.openaiBaseUrl,
      config.openaiApiKey,
      config.openaiModels,
    );
    const storage = await bootstrapStorage(
      context,
      logger,
      config.persistenceScope ?? "global",
    );
    const webSearchService = new WebSearchService(context.secrets, logger);
    const runtime = new AgentRuntime(
      config,
      storage,
      logger,
      webSearchService,
      provider,
    );

    // Register sidebar and commands BEFORE initialize() so the UI is
    // always available — even if the provider health check fails or times out.
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

    // Register inline completion provider for ghost-text suggestions
    if (config.providerType === "ollama") {
      const completionProvider = new InlineCompletionProvider(
        config.ollamaBaseUrl,
        config.fastModel || config.editorModel || "qwen2.5-coder:7b",
      );
      context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
          { pattern: "**" },
          completionProvider,
        ),
      );
    }

    // Initialize in background — failures leave the UI in degraded mode
    // rather than killing the entire extension.
    await runtime.initialize().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Runtime initialization failed: ${msg}`);
      vscode.window.showWarningMessage(
        `Pulse initialized in degraded mode: ${msg}`,
      );
    });

    logger.info("Pulse extension activated.");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Pulse activation failed: ${msg}`);
    vscode.window.showErrorMessage(`Pulse failed to activate: ${msg}`);
  }
}

export function deactivate(): void {
  // No-op for now. Disposables are tracked in context subscriptions.
}
