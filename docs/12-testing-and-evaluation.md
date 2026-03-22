# Testing and Evaluation

## Testing layers

### Unit tests
Cover:
- prompt assembly
- JSON schema validation
- model adapter parsing
- tool routing
- policy checks
- memory extraction
- diff application

### Integration tests
Cover:
- Ollama health and chat adapter
- MCP connection lifecycle
- workspace scanning
- multi-file patch application
- session resume

### Extension tests
Cover:
- command registration
- view rendering
- activation
- settings behavior
- webview messaging

### End-to-end task tests
Use fixture repos and evaluate:
- feature implementation
- bug fixing
- refactors
- test generation
- repo explanation

## Golden task suite

Create a benchmark repo set with tasks like:

- rename service across project
- fix failing test
- add endpoint and tests
- migrate config key
- explain architecture slice
- refactor duplicated helper
- add loading state to UI component

## Metrics

### Task metrics
- success rate
- verification pass rate
- time to completion
- retries required
- rollback frequency

### Edit metrics
- acceptance rate
- revert rate
- changed lines per successful task
- unrelated file touch rate

### Retrieval metrics
- relevant file recall
- context hit rate
- memory usefulness score

### Model metrics
- malformed output rate
- tool selection quality
- latency
- token usage

## Evaluation harness

Build a runner that:

1. loads fixture repo
2. runs task through agent API
3. captures trace
4. applies edits in temp copy
5. runs verification
6. scores result
7. stores report

## Human review workflow

For each major release:
- sample 20 successful tasks
- sample 20 failed tasks
- review false confidence cases
- review unnecessary rewrites
- review unsafe suggestions
