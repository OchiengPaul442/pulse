import * as https from "https";
import * as http from "http";
import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ModelSummary,
  ProviderHealth,
} from "./ModelProvider";

/**
 * OpenAI-compatible provider that works with:
 * - OpenAI API
 * - Azure OpenAI
 * - Together AI, Groq, Fireworks, DeepInfra
 * - Local servers: LM Studio, vLLM, text-generation-webui, LocalAI
 * - Any server implementing the OpenAI chat completions spec
 */
export class OpenAICompatibleProvider implements ModelProvider {
  public readonly providerType = "openai" as const;
  public readonly capabilities = {
    supportsJsonMode: true,
    supportsJsonSchema: false,
    supportsToolCalling: false,
    supportsVision: false,
  };

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly configuredModels: string[];

  public constructor(opts: {
    baseUrl: string;
    apiKey?: string;
    defaultModel?: string;
    models?: string[];
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.defaultModel = opts.defaultModel ?? "gpt-3.5-turbo";
    this.configuredModels = opts.models?.length ? opts.models : [];
  }

  public async healthCheck(): Promise<ProviderHealth> {
    try {
      const res = await this.request("GET", "/v1/models", undefined, 8000);
      if (res.ok) {
        return {
          ok: true,
          message: `OpenAI-compatible endpoint reachable (${this.baseUrl})`,
        };
      }
      // Some servers don't have /v1/models — try a lightweight completions call
      return {
        ok: true,
        message: `Endpoint responded with HTTP ${res.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Unreachable",
      };
    }
  }

  public async listModels(): Promise<ModelSummary[]> {
    // If user configured specific models, use those
    if (this.configuredModels.length > 0) {
      return this.configuredModels.map((name) => ({
        name,
        source: "configured" as const,
        supportsVision: /vision|gpt-4o|claude.*3|gemini|pixtral|llava/i.test(
          name,
        ),
      }));
    }

    try {
      const res = await this.request("GET", "/v1/models", undefined, 8000);
      if (!res.ok) {
        return [{ name: this.defaultModel, source: "configured" as const }];
      }
      const body = JSON.parse(res.body) as { data?: Array<{ id: string }> };
      const models = body.data ?? [];
      return models.map((m) => ({
        name: m.id,
        source: "configured" as const,
        supportsVision: /vision|gpt-4o|claude.*3|gemini|pixtral|llava/i.test(
          m.id,
        ),
      }));
    } catch {
      return [{ name: this.defaultModel, source: "configured" as const }];
    }
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model || this.defaultModel;
    const messages = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      temperature: request.temperature ?? 0.1,
    };
    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }
    if (request.format === "json") {
      body.response_format = { type: "json_object" };
    }

    const res = await this.request(
      "POST",
      "/v1/chat/completions",
      JSON.stringify(body),
      300_000,
      request.signal,
    );

    if (!res.ok) {
      const detail = this.extractError(res.body);
      throw new Error(
        `OpenAI-compatible API failed (HTTP ${res.status}): ${detail}`,
      );
    }

    // Always handle as streaming SSE
    return this.consumeSSEStream(res, request.onChunk);
  }

  private async consumeSSEStream(
    res: { stream: NodeJS.ReadableStream | null; body: string },
    onChunk?: (text: string) => void,
  ): Promise<ChatResponse> {
    const stream = res.stream;
    if (!stream) {
      // Fallback: parse as non-streaming response
      return this.parseNonStreamResponse(res.body);
    }

    return new Promise<ChatResponse>((resolve, reject) => {
      let buffer = "";
      let fullText = "";
      let promptTokens = 0;
      let completionTokens = 0;

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") return;
        if (!trimmed.startsWith("data: ")) return;
        const json = trimmed.slice(6);
        try {
          const chunk = JSON.parse(json) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            fullText += delta;
            onChunk?.(delta);
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
            completionTokens =
              chunk.usage.completion_tokens ?? completionTokens;
          }
        } catch {
          // Skip malformed chunks
        }
      };

      stream.on("data", (chunk: unknown) => {
        buffer +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Buffer).toString("utf8");
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          processLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
        }
      });

      stream.on("end", () => {
        processLine(buffer);
        resolve({
          text: fullText.trim(),
          raw: {},
          tokenUsage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          },
        });
      });

      stream.on("error", reject);
    });
  }

  private parseNonStreamResponse(body: string): ChatResponse {
    try {
      const parsed = JSON.parse(body) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };
      const text = parsed.choices?.[0]?.message?.content?.trim() ?? "";
      return {
        text,
        raw: parsed,
        tokenUsage: {
          promptTokens: parsed.usage?.prompt_tokens ?? 0,
          completionTokens: parsed.usage?.completion_tokens ?? 0,
          totalTokens: parsed.usage?.total_tokens ?? 0,
        },
      };
    } catch {
      return { text: body.trim(), raw: {} };
    }
  }

  private extractError(body: string): string {
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string };
        message?: string;
      };
      return parsed.error?.message ?? parsed.message ?? body.slice(0, 200);
    } catch {
      return body.slice(0, 200);
    }
  }

  private request(
    method: string,
    urlPath: string,
    body?: string,
    timeoutMs = 10_000,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    status: number;
    body: string;
    stream: NodeJS.ReadableStream | null;
  }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Aborted"));
        return;
      }

      let fullUrl: string;
      try {
        // Handle both absolute and relative paths
        fullUrl = urlPath.startsWith("http") ? urlPath : this.baseUrl + urlPath;
      } catch {
        fullUrl = this.baseUrl + urlPath;
      }

      const parsed = new URL(fullUrl);
      const isHttps = parsed.protocol === "https:";
      const client = isHttps ? https : http;

      const headers: Record<string, string> = {};
      if (body) headers["content-type"] = "application/json";
      if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

      const opts: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers,
        timeout: timeoutMs,
      };

      const req = client.request(opts, (res) => {
        const isStreaming =
          method === "POST" && body?.includes('"stream":true');
        if (
          isStreaming &&
          res.statusCode &&
          res.statusCode >= 200 &&
          res.statusCode < 300
        ) {
          // Return the stream directly for SSE consumption
          resolve({
            ok: true,
            status: res.statusCode ?? 200,
            body: "",
            stream: res,
          });
          return;
        }

        let data = "";
        res.on("data", (chunk) => {
          data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            body: data,
            stream: null,
          });
        });
        res.on("error", reject);
      });

      req.on("error", reject);
      req.on("timeout", () =>
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)),
      );
      if (signal) {
        signal.addEventListener(
          "abort",
          () => req.destroy(new Error("Aborted")),
          { once: true },
        );
      }
      if (body) req.write(body);
      req.end();
    });
  }
}
