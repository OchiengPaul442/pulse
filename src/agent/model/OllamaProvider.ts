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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.fetchFromCandidates("/api/tags", {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timer);
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
      clearTimeout(timer);
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
    const response = await this.fetchFromCandidates("/api/chat", {
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
    const response = await this.fetchFromCandidates("/api/tags", {
      method: "GET",
    });
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
      const response = await this.fetchFromCandidates("/api/ps", {
        method: "GET",
      });
      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as OllamaPsResponse;
      const models = data.models ?? [];
      return models.flatMap((model) => {
        const name =
          typeof model.name === "string" && model.name.length > 0
            ? model.name
            : typeof model.model === "string" && model.model.length > 0
              ? model.model
              : "";

        if (!name) {
          return [];
        }

        return [
          {
            name,
            sizeBytes: model.size,
            modifiedAt: model.modified_at,
            source: "running" as const,
          },
        ];
      });
    } catch {
      return [];
    }
  }

  private async fetchFromCandidates(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    let lastError: unknown;

    for (const baseUrl of this.getCandidateBaseUrls()) {
      try {
        const response = await fetch(this.buildUrl(baseUrl, path), init);
        return response;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to connect to Ollama");
  }

  private getCandidateBaseUrls(): string[] {
    const candidates = new Set<string>();
    const normalizedBaseUrl = this.normalizeBaseUrl(this.baseUrl);
    candidates.add(normalizedBaseUrl);

    try {
      const parsed = new URL(normalizedBaseUrl);
      for (const hostname of this.getLoopbackAliases(parsed.hostname)) {
        const alias = new URL(parsed.toString());
        alias.hostname = hostname;
        candidates.add(this.normalizeBaseUrl(alias.toString()));
      }
    } catch {
      return [normalizedBaseUrl];
    }

    return [...candidates];
  }

  private getLoopbackAliases(hostname: string): string[] {
    if (hostname === "localhost") {
      return ["127.0.0.1", "::1"];
    }

    if (hostname === "127.0.0.1") {
      return ["localhost", "::1"];
    }

    if (hostname === "::1") {
      return ["localhost", "127.0.0.1"];
    }

    return [];
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  }

  private buildUrl(baseUrl: string, path: string): string {
    return new URL(path, baseUrl).toString();
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
