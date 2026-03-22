export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  format?: "json";
}

export interface ChatResponse {
  text: string;
  raw?: unknown;
}

export interface ProviderHealth {
  ok: boolean;
  message: string;
}

export interface ModelSummary {
  name: string;
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface ModelProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  healthCheck(): Promise<ProviderHealth>;
  listModels(): Promise<ModelSummary[]>;
}
