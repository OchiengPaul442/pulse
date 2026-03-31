import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(),
    })),
  },
}));

import {
  resolveProfileDefaults,
  type AgentConfig,
} from "../src/config/AgentConfig";
import { TASK_RESPONSE_SCHEMA } from "../src/agent/runtime/TaskProtocols";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    providerType: "ollama",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    performanceProfile: "auto",
    openaiBaseUrl: "https://api.openai.com",
    openaiApiKey: "",
    openaiModels: [],
    plannerModel: "deepseek-r1:7b",
    editorModel: "qwen2.5-coder:7b",
    fastModel: "qwen2.5-coder:7b",
    embeddingModel: "nomic-embed-text:latest",
    fallbackModels: [],
    approvalMode: "balanced",
    permissionMode: "default",
    conversationMode: "agent",
    persona: "software-engineer",
    allowTerminalExecution: true,
    autoRunVerification: true,
    maxContextTokens: 32768,
    memoryMode: "workspace+episodic",
    indexingEnabled: true,
    indexingMode: "hybrid",
    mcpServers: [],
    telemetryOptIn: false,
    selfLearnEnabled: true,
    qualityTargetScore: 0.9,
    ...overrides,
  };
}

describe("resolveProfileDefaults", () => {
  it("low_vram profile has conservative defaults", () => {
    const d = resolveProfileDefaults(
      makeConfig({ performanceProfile: "low_vram" }),
    );
    expect(d.numCtx).toBe(8192);
    expect(d.plannerKeepAlive).toBe(0);
    expect(d.iterationTimeoutMs).toBe(120_000);
    expect(d.coldStartBonusMs).toBe(60_000);
    expect(d.qualityTarget).toBe(0.75);
    expect(d.useSingleModel).toBe(true);
    expect(d.firstIterationMaxTokens).toBeLessThanOrEqual(4096);
  });

  it("high_vram profile has generous defaults", () => {
    const d = resolveProfileDefaults(
      makeConfig({ performanceProfile: "high_vram" }),
    );
    expect(d.numCtx).toBeGreaterThanOrEqual(16384);
    expect(d.plannerKeepAlive).toBe(-1);
    expect(d.iterationTimeoutMs).toBe(90_000);
  });

  it("auto profile with ollama uses conservative defaults", () => {
    const d = resolveProfileDefaults(
      makeConfig({ performanceProfile: "auto", providerType: "ollama" }),
    );
    expect(d.plannerKeepAlive).toBe(0);
    expect(d.qualityTarget).toBeLessThan(0.9);
  });

  it("auto profile with openai uses balanced defaults", () => {
    const d = resolveProfileDefaults(
      makeConfig({ performanceProfile: "auto", providerType: "openai" }),
    );
    expect(d.plannerKeepAlive).toBe(-1);
    expect(d.qualityTarget).toBe(0.9);
  });

  it("respects user-supplied qualityTargetScore when lower", () => {
    const d = resolveProfileDefaults(
      makeConfig({ performanceProfile: "low_vram", qualityTargetScore: 0.6 }),
    );
    expect(d.qualityTarget).toBe(0.6);
  });
});

describe("TASK_RESPONSE_SCHEMA", () => {
  it("has all required top-level fields", () => {
    const schema = TASK_RESPONSE_SCHEMA as any;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "response",
        "todos",
        "toolCalls",
        "edits",
        "shortcuts",
      ]),
    );
    expect(schema.properties.response.type).toBe("string");
    expect(schema.properties.todos.type).toBe("array");
    expect(schema.properties.toolCalls.type).toBe("array");
    expect(schema.properties.edits.type).toBe("array");
    expect(schema.properties.shortcuts.type).toBe("array");
  });
});
