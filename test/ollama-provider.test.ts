import { PassThrough } from "stream";
import type * as http from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OllamaProvider } from "../src/agent/model/OllamaProvider";

function fakeResponse(statusCode: number, body: string) {
  const stream = new PassThrough();
  (stream as any).statusCode = statusCode;
  (stream as any).headers = {};
  process.nextTick(() => stream.end(body));
  return stream;
}

let mockRequestImpl: (options: any, callback?: (res: any) => void) => any;

vi.mock("http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("http")>();
  return {
    ...actual,
    request: (...args: any[]) => mockRequestImpl(args[0], args[1]),
  };
});

describe("OllamaProvider", () => {
  beforeEach(() => {
    mockRequestImpl = (options: any, callback?: (res: any) => void) => {
      const hostname = options.hostname ?? "localhost";
      const urlPath = options.path ?? "";

      const listeners: Record<string, Function[]> = {};
      const req = {
        destroy: vi.fn(),
        write: vi.fn(),
        on(event: string, fn: Function) {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(fn);
          return req;
        },
        emit(event: string, ...args: any[]) {
          for (const fn of listeners[event] ?? []) fn(...args);
        },
        end() {
          // Simulate localhost ECONNREFUSED
          if (hostname === "localhost") {
            process.nextTick(() => {
              req.emit(
                "error",
                new Error("connect ECONNREFUSED 127.0.0.1:11434"),
              );
            });
            return;
          }

          let body = '{"error":"not found"}';
          let status = 404;

          if (urlPath.includes("/api/tags")) {
            body = JSON.stringify({
              models: [
                {
                  name: "qwen2.5-coder:7b",
                  size: 123,
                  modified_at: "2026-03-22T00:00:00Z",
                },
              ],
            });
            status = 200;
          } else if (urlPath.includes("/api/ps")) {
            body = JSON.stringify({
              models: [
                {
                  name: "deepseek-coder-v2:16b",
                  size: 456,
                  modified_at: "2026-03-22T00:00:00Z",
                },
              ],
            });
            status = 200;
          } else if (urlPath.includes("/api/chat")) {
            body = JSON.stringify({
              message: { content: "ok" },
              prompt_eval_count: 2,
              eval_count: 1,
            });
            status = 200;
          }

          const res = fakeResponse(status, body);
          if (callback) callback(res);
        },
      };

      return req;
    };
  });

  afterEach(() => {
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

  it("parses streamed chat chunks and ignores malformed lines", async () => {
    mockRequestImpl = (options: any, callback?: (res: any) => void) => {
      const urlPath = options.path ?? "";
      const listeners: Record<string, Function[]> = {};
      const req = {
        destroy: vi.fn(),
        write: vi.fn(),
        on(event: string, fn: Function) {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(fn);
          return req;
        },
        emit(event: string, ...args: any[]) {
          for (const fn of listeners[event] ?? []) fn(...args);
        },
        end() {
          let body = "";
          let status = 200;

          if (urlPath.includes("/api/chat")) {
            body =
              '{"message":{"content":"hel"},"prompt_eval_count":4}\n' +
              "not json\n" +
              '{"message":{"content":"lo"},"eval_count":3}\n' +
              '{"message":{"content":" world"},"done":true,"prompt_eval_count":4,"eval_count":3}\n';
          }

          const res = fakeResponse(status, body);
          if (callback) callback(res);
        },
      };

      return req;
    };

    const provider = new OllamaProvider("http://127.0.0.1:11434");
    const chunks: string[] = [];
    const chat = await provider.chat({
      model: "qwen2.5-coder:7b",
      messages: [{ role: "user", content: "ping" }],
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(chat.text).toBe("hello world");
    expect(chunks).toEqual(["hel", "lo", " world"]);
    expect(chat.tokenUsage).toEqual({
      promptTokens: 4,
      completionTokens: 3,
      totalTokens: 7,
    });
  });
});
