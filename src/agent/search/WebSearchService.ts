import type { SecretStorage } from "vscode";

import type { Logger } from "../../platform/vscode/Logger";

const TAVILY_SECRET_KEY = "pulse.tavily.apiKey";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const DUCKDUCKGO_SEARCH_URL = "https://api.duckduckgo.com/";

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  source: "tavily" | "duckduckgo";
  score?: number;
}

export interface WebSearchResponse {
  query: string;
  provider: "tavily" | "duckduckgo";
  answer?: string;
  results: WebSearchResult[];
  note?: string;
}

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilySearchResponse {
  query?: string;
  answer?: string;
  results?: TavilySearchResult[];
  response_time?: number;
}

interface DuckDuckGoRelatedTopic {
  Text?: string;
  FirstURL?: string;
  Result?: string;
  Topics?: DuckDuckGoRelatedTopic[];
}

interface DuckDuckGoResponse {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: DuckDuckGoRelatedTopic[];
}

export class WebSearchService {
  public constructor(
    private readonly secrets: SecretStorage,
    private readonly logger: Logger,
  ) {}

  public async setTavilyApiKey(apiKey: string): Promise<void> {
    const normalized = apiKey.trim();
    if (!normalized) {
      throw new Error("Tavily API key cannot be empty.");
    }

    await this.secrets.store(TAVILY_SECRET_KEY, normalized);
  }

  public async clearTavilyApiKey(): Promise<void> {
    await this.secrets.delete(TAVILY_SECRET_KEY);
  }

  public async hasTavilyApiKey(): Promise<boolean> {
    return Boolean(await this.getTavilyApiKey());
  }

  public async search(
    query: string,
    options: { maxResults?: number } = {},
  ): Promise<WebSearchResponse> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error("Search query cannot be empty.");
    }

    const maxResults = clamp(options.maxResults ?? 5, 1, 10);
    const tavilyApiKey = await this.getTavilyApiKey();

    if (tavilyApiKey) {
      try {
        return await this.searchWithTavily(
          normalizedQuery,
          tavilyApiKey,
          maxResults,
        );
      } catch (error) {
        this.logger.warn(
          `Tavily search failed, falling back to DuckDuckGo: ${stringifyError(error)}`,
        );
      }
    }

    return this.searchWithDuckDuckGo(normalizedQuery, maxResults);
  }

  public formatResult(result: WebSearchResponse): string {
    const lines = [`Query: ${result.query}`, `Provider: ${result.provider}`];

    if (result.answer) {
      lines.push(`Answer: ${result.answer}`);
    }

    if (result.note) {
      lines.push(`Note: ${result.note}`);
    }

    lines.push("", "Results:");
    if (result.results.length === 0) {
      lines.push("- No results returned.");
      return lines.join("\n");
    }

    for (const entry of result.results) {
      lines.push(`- ${entry.title}`, `  ${entry.url}`, `  ${entry.content}`);
    }

    return lines.join("\n");
  }

  private async getTavilyApiKey(): Promise<string | undefined> {
    const envKey = process.env.PULSE_TAVILY_API_KEY?.trim();
    if (envKey) {
      return envKey;
    }

    const storedKey = await this.secrets.get(TAVILY_SECRET_KEY);
    return storedKey?.trim() || undefined;
  }

  private async searchWithTavily(
    query: string,
    apiKey: string,
    maxResults: number,
  ): Promise<WebSearchResponse> {
    const response = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        include_answer: true,
        include_raw_content: false,
        include_images: false,
        max_results: maxResults,
      }),
    });

    if (!response.ok) {
      throw new Error(`Tavily search failed (HTTP ${response.status})`);
    }

    const data = (await response.json()) as TavilySearchResponse;
    return {
      query: data.query ?? query,
      provider: "tavily",
      answer: data.answer?.trim() || undefined,
      results: (data.results ?? []).slice(0, maxResults).map((entry) => ({
        title: entry.title?.trim() || entry.url || "Untitled result",
        url: entry.url?.trim() || "",
        content: entry.content?.trim() || "",
        source: "tavily" as const,
        score: entry.score,
      })),
      note: "Tavily provides agent-oriented search with answer synthesis.",
    };
  }

  private async searchWithDuckDuckGo(
    query: string,
    maxResults: number,
  ): Promise<WebSearchResponse> {
    const url = new URL(DUCKDUCKGO_SEARCH_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "1");
    url.searchParams.set("no_redirect", "1");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo search failed (HTTP ${response.status})`);
    }

    const data = (await response.json()) as DuckDuckGoResponse;
    const results = flattenDuckDuckGoTopics(data.RelatedTopics ?? [])
      .slice(0, maxResults)
      .map((entry) => ({
        title: entry.text || entry.url || "DuckDuckGo result",
        url: entry.url || data.AbstractURL || "",
        content: entry.text || entry.result || data.AbstractText || "",
        source: "duckduckgo" as const,
      }))
      .filter((entry) => entry.url.length > 0 || entry.content.length > 0);

    return {
      query,
      provider: "duckduckgo",
      answer: data.AbstractText?.trim() || undefined,
      results,
      note:
        data.Heading?.trim() ||
        "DuckDuckGo Instant Answer API is a lightweight fallback, not full web search.",
    };
  }
}

function flattenDuckDuckGoTopics(
  topics: DuckDuckGoRelatedTopic[],
): Array<{ text?: string; url?: string; result?: string }> {
  const results: Array<{ text?: string; url?: string; result?: string }> = [];

  for (const topic of topics) {
    if (topic.Topics?.length) {
      results.push(...flattenDuckDuckGoTopics(topic.Topics));
      continue;
    }

    results.push({
      text: topic.Text,
      url: topic.FirstURL,
      result: topic.Result,
    });
  }

  return results;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
