import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OllamaProvider } from "../src/agent/model/OllamaProvider";

describe("OllamaProvider", () => {
  beforeEach(() => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);

      if (url.includes("localhost")) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      }

      if (url.includes("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "qwen2.5-coder:7b",
                size: 123,
                modified_at: "2026-03-22T00:00:00Z",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url.includes("/api/ps")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "deepseek-coder-v2:16b",
                size: 456,
                modified_at: "2026-03-22T00:00:00Z",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url.includes("/api/chat")) {
        return new Response(
          JSON.stringify({
            message: { content: "ok" },
            prompt_eval_count: 2,
            eval_count: 1,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back from localhost to an equivalent loopback host", async () => {
    const provider = new OllamaProvider("http://localhost:11434");

    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);

    const models = await provider.listModels();
    expect(models.map((model) => model.name)).toEqual([
      "deepseek-coder-v2:16b",
      "qwen2.5-coder:7b",
    ]);

    const chat = await provider.chat({
      model: "qwen2.5-coder:7b",
      messages: [{ role: "user", content: "ping" }],
    });

    expect(chat.text).toBe("ok");
    expect(chat.tokenUsage).toEqual({
      promptTokens: 2,
      completionTokens: 1,
      totalTokens: 3,
    });
  });
});
