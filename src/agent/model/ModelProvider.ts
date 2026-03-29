export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatMessageContent[];
}

/** Multi-modal content block (text or image). */
export interface ChatMessageContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: "auto" | "low" | "high" };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  format?: "json" | Record<string, unknown>;
  signal?: AbortSignal;
  /** Streaming callback: called with each text delta as it arrives. */
  onChunk?: (text: string) => void;
  /** Ollama keep_alive: seconds to keep model loaded. 0 = unload immediately, -1 = keep forever. */
  keepAlive?: number;
  /** Ollama num_ctx: context window size in tokens. */
  numCtx?: number;
}

export interface ChatResponse {
  text: string;
  raw?: unknown;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ProviderHealth {
  ok: boolean;
  message: string;
}

export interface ModelSummary {
  name: string;
  sizeBytes?: number;
  modifiedAt?: string;
  source?: "local" | "running" | "configured";
  supportsVision?: boolean;
}

/** Provider interface that all model backends must implement. */
export interface ModelProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  healthCheck(): Promise<ProviderHealth>;
  listModels(): Promise<ModelSummary[]>;
  /** Returns the provider type identifier (e.g. "ollama", "openai", "custom"). */
  readonly providerType: string;
}

/** Known provider types. */
export type ProviderType = "ollama" | "openai" | "anthropic" | "custom";

export interface ModelProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  healthCheck(): Promise<ProviderHealth>;
  listModels(): Promise<ModelSummary[]>;
}
