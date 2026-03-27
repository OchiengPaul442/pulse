import { describe, expect, it } from "vitest";

import { extractOllamaError } from "../src/agent/model/OllamaProvider";

describe("OllamaProvider error parsing", () => {
  it("extracts a useful message from Ollama JSON errors", () => {
    const message = extractOllamaError(
      JSON.stringify({
        error: "model requires more memory",
        detail: "load failed",
      }),
    );

    expect(message).toBe("model requires more memory");
  });

  it("falls back to plain text responses", () => {
    expect(extractOllamaError("context length exceeded")).toBe(
      "context length exceeded",
    );
  });
});
