# Ollama Integration

## Goal

Use Ollama as the local model provider for planning, editing, summarization, embeddings, and optional tool-calling.

## Adapter design

Create a provider interface:

```ts
export interface ModelProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat(request: ChatRequest): AsyncIterable<StreamEvent>;
  embed?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  healthCheck(): Promise<ProviderHealth>;
}
```

Then implement:

```ts
class OllamaProvider implements ModelProvider
```

## Supported capabilities to design for

- chat completions
- streaming
- structured outputs
- tool calling
- embeddings
- health checks
- model list discovery

## Configuration

Support settings like:

```json
{
  "agent.ollama.baseUrl": "http://localhost:11434",
  "agent.models.planner": "qwen2.5-coder:7b",
  "agent.models.editor": "qwen2.5-coder:7b",
  "agent.models.fast": "nemotron-mini:latest",
  "agent.models.embedding": "nomic-embed-text:latest",
  "agent.models.fallbacks": ["deepseek-r1:7b", "nemotron-mini:latest"]
}
```

## Model routing strategy

Use different models for different jobs:

### Planner model

Best for:

- long reasoning
- task decomposition
- repo-level change planning

### Editor model

Best for:

- code patch generation
- exact API usage
- test writing
- refactoring

### Fast model

Best for:

- quick explanations
- renaming suggestions
- command generation
- short follow-ups

### Embedding model

Best for:

- semantic retrieval
- workspace memory
- change history recall

## Prompting strategy

Always provide:

- role and task
- scope
- constraints
- allowed tools
- expected output schema
- repository conventions
- stop conditions

## Structured outputs

Enforce schemas for:

- plan objects
- tool decisions
- edit proposals
- patch metadata
- verification summaries
- memory extraction

Never rely on free-form text alone for critical execution decisions.

## Context budgeting

Split context into layers:

1. instruction layer
2. task layer
3. repo rules
4. focused code context
5. retrieved memories
6. tool history

Use truncation priorities so code context wins over old conversation filler.

## Failure handling

Common failures:

- model unavailable
- timeout
- malformed JSON
- hallucinated filenames
- oversized context
- inconsistent edits

Mitigations:

- provider health checks
- JSON repair with validation
- bounded retries
- fallback model
- reduce scope automatically
- request more context only when necessary

## Warm-up

On extension startup or first use:

- ping Ollama
- optionally preload configured models
- cache model capability metadata
- surface clear error message if unavailable

## Performance guidance

- cache static repo rules
- deduplicate repeated file reads
- stream long responses
- use smaller model for triage
- use larger model only for planning/editing when needed
- avoid embedding every file on the critical path

## Online research

For research-heavy objectives, enrich the task prompt with web results before planning.

Recommended approach:

1. Try Tavily first for agent-friendly web search and answer synthesis.
2. Store the Tavily API key in VS Code Secret Storage so it survives reloads and workspace switches.
3. Fall back to DuckDuckGo Instant Answer API when no Tavily key is present or Tavily fails.
4. Keep the result count small and only pull search context when the objective suggests current or external information is needed.

For this extension, the user-facing command to save the key is `Pulse: Set Tavily API Key`, and the runtime also honors `PULSE_TAVILY_API_KEY`.
