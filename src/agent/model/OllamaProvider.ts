import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ModelSummary,
  ProviderHealth,
} from "./ModelProvider";

interface OllamaTagModel {
  name: string;
  size?: number;
  modified_at?: string;
}

interface OllamaTagsResponse {
  models?: OllamaTagModel[];
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaPsModel {
  name?: string;
  model?: string;
  size?: number;
  modified_at?: string;
}

interface OllamaPsResponse {
  models?: OllamaPsModel[];
}

export class OllamaProvider implements ModelProvider {
  public constructor(private readonly baseUrl: string) {}

  public async healthCheck(): Promise<ProviderHealth> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
      });
      if (!response.ok) {
        return {
          ok: false,
          message: `Ollama unavailable (HTTP ${response.status})`,
        };
      }

      return {
        ok: true,
        message: "Ollama reachable",
      };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error ? error.message : "Unknown Ollama error",
      };
    }
  }

  public async listModels(): Promise<ModelSummary[]> {
    const [localModels, runningModels] = await Promise.all([
      this.fetchLocalModels(),
      this.fetchRunningModels(),
    ]);

    return dedupeAndSortModels([...localModels, ...runningModels]);
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: false,
        options: {
          temperature: request.temperature ?? 0.1,
        },
        format: request.format,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama chat failed (HTTP ${response.status})`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    const text = data.message?.content?.trim() ?? "";
    const promptTokens = Number.isFinite(data.prompt_eval_count)
      ? Number(data.prompt_eval_count)
      : 0;
    const completionTokens = Number.isFinite(data.eval_count)
      ? Number(data.eval_count)
      : 0;

    return {
      text,
      raw: data,
      tokenUsage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };
  }

  private async fetchLocalModels(): Promise<ModelSummary[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Failed to list Ollama models (HTTP ${response.status})`);
    }

    const data = (await response.json()) as OllamaTagsResponse;
    const models = data.models ?? [];
    return models.map((model) => ({
      name: model.name,
      sizeBytes: model.size,
      modifiedAt: model.modified_at,
      source: "local" as const,
    }));
  }

  private async fetchRunningModels(): Promise<ModelSummary[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/ps`, { method: "GET" });
      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as OllamaPsResponse;
      const models = data.models ?? [];
      return models
        .map((model) => ({
          name: typeof model.name === "string" ? model.name : model.model,
          sizeBytes: model.size,
          modifiedAt: model.modified_at,
          source: "running" as const,
        }))
        .filter(
          (model): model is ModelSummary =>
            typeof model.name === "string" && model.name.length > 0,
        );
    } catch {
      return [];
    }
  }
}

function dedupeAndSortModels(models: ModelSummary[]): ModelSummary[] {
  const byName = new Map<string, ModelSummary>();
  for (const model of models) {
    const existing = byName.get(model.name);
    if (!existing) {
      byName.set(model.name, model);
      continue;
    }

    byName.set(model.name, {
      name: model.name,
      sizeBytes: model.sizeBytes ?? existing.sizeBytes,
      modifiedAt: model.modifiedAt ?? existing.modifiedAt,
      source:
        existing.source === "local" || model.source === "local"
          ? "local"
          : existing.source === "running" || model.source === "running"
            ? "running"
            : existing.source,
    });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
