import * as https from "https";
import * as http from "http";
import type {
  ChatMessage,
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

interface SimpleResponse {
  ok: boolean;
  status: number;
  body?: NodeJS.ReadableStream;
  text(): Promise<string>;
  json(): Promise<any>;
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const CHAT_TIMEOUT_MS = 300_000;

/**
 * Transform OpenAI-style multi-part messages into Ollama's format.
 * Ollama expects vision images in `messages[].images` as base64 strings,
 * not as OpenAI `image_url` content blocks.
 */
function toOllamaMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return { role: m.role, content: m.content };
    }

    const parts = m.content;
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
    const images = parts
      .filter((p) => p.type === "image_url")
      .map((p) => p.image_url?.url ?? "")
      .filter(Boolean)
      .map((url) => (url.startsWith("data:") ? (url.split(",")[1] ?? "") : url))
      .filter(Boolean);

    return {
      role: m.role,
      content: text,
      ...(images.length > 0 ? { images } : {}),
    };
  });
}

export class OllamaProvider implements ModelProvider {
  public readonly providerType = "ollama" as const;

  public constructor(private readonly baseUrl: string) {}

  public async healthCheck(): Promise<ProviderHealth> {
    const { signal, cleanup } = this.createSignalWithTimeout(
      undefined,
      DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await this.fetchFromCandidates("/api/tags", {
        method: "GET",
        signal,
        timeoutMs: DEFAULT_TIMEOUT_MS,
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
    } finally {
      cleanup();
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
    const { signal, cleanup } = this.createSignalWithTimeout(
      request.signal,
      CHAT_TIMEOUT_MS,
    );
    try {
      const ollamaOptions: Record<string, unknown> = {
        temperature: request.temperature ?? 0.1,
        ...(typeof request.maxTokens === "number"
          ? { num_predict: request.maxTokens }
          : {}),
        ...(typeof request.numCtx === "number"
          ? { num_ctx: request.numCtx }
          : {}),
      };

      const body: Record<string, unknown> = {
        model: request.model,
        messages: toOllamaMessages(request.messages),
        stream: true,
        options: ollamaOptions,
        format: request.format,
      };

      // Ollama keep_alive control: 0 = unload immediately, -1 = keep forever
      if (typeof request.keepAlive === "number") {
        body.keep_alive = request.keepAlive;
      }

      const response = await this.fetchFromCandidates("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        signal,
        timeoutMs: CHAT_TIMEOUT_MS,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const detail = extractOllamaError(body);
        throw new Error(
          detail
            ? `Ollama chat failed (HTTP ${response.status}): ${detail}`
            : `Ollama chat failed (HTTP ${response.status})`,
        );
      }

      if (!response.body) {
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

      return this.consumeStream(response, request.onChunk);
    } finally {
      cleanup();
    }
  }

  /**
   * Unload a model from Ollama's memory by sending an empty chat with keep_alive=0.
   * This frees VRAM so another model can load. Best-effort; failures are silent.
   */
  public async unloadModel(model: string): Promise<void> {
    try {
      await this.fetchFromCandidates("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        timeoutMs: DEFAULT_TIMEOUT_MS,
        body: JSON.stringify({
          model,
          messages: [],
          keep_alive: 0,
        }),
      });
    } catch {
      // Best-effort unload — model may not be loaded or Ollama may be unreachable
    }
  }

  private async fetchLocalModels(): Promise<ModelSummary[]> {
    const response = await this.fetchFromCandidates("/api/tags", {
      method: "GET",
      timeoutMs: DEFAULT_TIMEOUT_MS,
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
        timeoutMs: DEFAULT_TIMEOUT_MS,
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
    init: RequestOptions,
  ): Promise<SimpleResponse> {
    const candidates = this.getCandidateBaseUrls();
    if (candidates.length === 1) {
      return this.makeRequest(this.buildUrl(candidates[0], path), init);
    }

    const attempts = candidates.map((baseUrl) =>
      this.makeRequest(this.buildUrl(baseUrl, path), init),
    );

    try {
      return await Promise.any(attempts);
    } catch (error) {
      if (error instanceof AggregateError && error.errors.length > 0) {
        const first = error.errors[0];
        throw first instanceof Error ? first : new Error(String(first));
      }

      throw error instanceof Error
        ? error
        : new Error("Failed to connect to Ollama");
    }
  }

  private async makeRequest(
    urlStr: string,
    init: RequestOptions,
  ): Promise<SimpleResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleResolve = (value: SimpleResponse): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const settleReject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const parsedUrl = new URL(urlStr);
      const isHttps = parsedUrl.protocol === "https:";
      const client = isHttps ? https : http;
      const timeoutMs = Math.max(1, init.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const options: http.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: init.method || "GET",
        headers: init.headers as Record<string, string>,
        timeout: timeoutMs,
      };

      if (init.signal?.aborted) {
        settleReject(new Error("Aborted"));
        return;
      }

      const req = client.request(options, (res) => {
        let data = "";
        let finished = false;
        let finishResolve: (() => void) | null = null;
        let finishReject: ((error: unknown) => void) | null = null;
        const finishedPromise = new Promise<void>(
          (resolveFinished, rejectFinished) => {
            finishResolve = resolveFinished;
            finishReject = rejectFinished;
          },
        );

        const complete = (): void => {
          if (finished) {
            return;
          }
          finished = true;
          finishResolve?.();
        };

        const fail = (error: unknown): void => {
          if (finished) {
            return;
          }
          finished = true;
          finishReject?.(error);
        };

        res.on("data", (chunk) => {
          data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });
        res.on("end", () => {
          complete();
        });
        res.on("error", (error) => {
          fail(error);
          settleReject(error);
        });

        const statusCode = res.statusCode ?? 0;
        const response: SimpleResponse = {
          ok: statusCode >= 200 && statusCode < 300,
          status: statusCode,
          body: res,
          text: async () => {
            await finishedPromise;
            return data;
          },
          json: async () => {
            await finishedPromise;
            try {
              return JSON.parse(data);
            } catch (error) {
              throw new Error(
                `Invalid JSON from Ollama: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          },
        };
        settleResolve(response);
      });

      req.on("error", (err) => {
        settleReject(err);
      });
      req.on("timeout", () => {
        req.destroy(
          new Error(`Request timed out after ${timeoutMs}ms: ${urlStr}`),
        );
      });

      if (init.signal) {
        init.signal.addEventListener("abort", () => {
          req.destroy(new Error("Aborted"));
        });
      }

      if (init.body) {
        req.write(init.body);
      }
      req.end();
    });
  }

  private async consumeStream(
    response: SimpleResponse,
    onChunk?: (text: string) => void,
  ): Promise<ChatResponse> {
    const stream = response.body;
    if (!stream) {
      return {
        text: "",
        raw: {},
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }

    return new Promise<ChatResponse>((resolve, reject) => {
      let buffer = "";
      let fullText = "";
      let promptTokens = 0;
      let completionTokens = 0;

      const flushLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        try {
          const chunk = JSON.parse(trimmed) as OllamaChatResponse;
          const delta = chunk.message?.content ?? "";
          if (delta) {
            fullText += delta;
            onChunk?.(delta);
          }
          promptTokens = chunk.prompt_eval_count ?? promptTokens;
          completionTokens = chunk.eval_count ?? completionTokens;
        } catch {
          // Skip malformed streaming chunk.
        }
      };

      stream.on("data", (chunk: unknown) => {
        buffer +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Buffer).toString("utf8");

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          flushLine(buffer.slice(0, newlineIndex));
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");
        }
      });

      stream.on("end", () => {
        flushLine(buffer);
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

      stream.on("error", (error) => {
        reject(error);
      });
    });
  }

  private createSignalWithTimeout(
    inputSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const safeTimeoutMs = Math.max(1, timeoutMs);
    const timer = setTimeout(() => {
      controller.abort();
    }, safeTimeoutMs);

    const onAbort = (): void => {
      controller.abort();
    };

    if (inputSignal) {
      if (inputSignal.aborted) {
        controller.abort();
      } else {
        inputSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        inputSignal?.removeEventListener("abort", onAbort);
      },
    };
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

export function extractOllamaError(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: unknown;
      message?: unknown;
      detail?: unknown;
    };
    const details = [parsed.error, parsed.message, parsed.detail]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    if (details.length > 0) {
      return details[0];
    }
  } catch {
    // fall back to plain text below
  }

  return trimmed.slice(0, 240);
}
