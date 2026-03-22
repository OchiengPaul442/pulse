import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebSearchService } from "../src/agent/search/WebSearchService";

function createSecretStorage(initialValue?: string) {
  const store = new Map<string, string>();
  if (initialValue) {
    store.set("pulse.tavily.apiKey", initialValue);
  }

  return {
    keys: async () => [...store.keys()],
    get: async (key: string) => store.get(key),
    store: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    onDidChange: () => ({ dispose: () => undefined }),
  } as any;
}

describe("WebSearchService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses Tavily when the API key is stored", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);

        if (url.includes("api.tavily.com")) {
          expect(init?.headers).toMatchObject({
            Authorization: "Bearer tvly-test-key",
          });

          return new Response(
            JSON.stringify({
              query: "current TypeScript docs",
              answer: "Use the official docs.",
              results: [
                {
                  title: "TypeScript",
                  url: "https://www.typescriptlang.org/docs/",
                  content: "Official documentation.",
                  score: 0.95,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const service = new WebSearchService(createSecretStorage("tvly-test-key"), {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      dispose: () => undefined,
    });

    const result = await service.search("current TypeScript docs", {
      maxResults: 3,
    });

    expect(result.provider).toBe("tavily");
    expect(result.answer).toBe("Use the official docs.");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.source).toBe("tavily");
  });

  it("falls back to DuckDuckGo when no Tavily key is available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);

        if (url.includes("duckduckgo.com")) {
          return new Response(
            JSON.stringify({
              Heading: "DuckDuckGo",
              AbstractText: "Instant answer summary.",
              AbstractURL: "https://duckduckgo.com/",
              RelatedTopics: [
                {
                  Text: "DuckDuckGo homepage",
                  FirstURL: "https://duckduckgo.com/",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const service = new WebSearchService(createSecretStorage(), {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      dispose: () => undefined,
    });

    const result = await service.search("DuckDuckGo instant answer", {
      maxResults: 3,
    });

    expect(result.provider).toBe("duckduckgo");
    expect(result.answer).toBe("Instant answer summary.");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.source).toBe("duckduckgo");
  });
});
