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
    }));
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

    return {
      text,
      raw: data,
    };
  }
}
