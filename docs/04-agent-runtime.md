# Agent Runtime

## Runtime responsibilities

The runtime coordinates model calls, context assembly, tool execution, edit generation, verification, and memory updates.

## Core classes

```text
AgentRuntime
├── TaskManager
├── SessionManager
├── ContextBuilder
├── Planner
├── Executor
├── VerificationRunner
├── MemoryManager
├── TraceRecorder
└── PolicyEngine
```

## Task lifecycle

```text
created
-> scoped
-> context_gathering
-> planning
-> executing
-> awaiting_approval
-> verifying
-> completed
-> failed
-> canceled
```

## Session model

Each session should contain:

- session id
- workspace fingerprint
- active branch
- model profile
- user goals
- current plan
- executed steps
- tool outputs
- proposed edits
- verification results
- memory notes
- timestamps

## Intent routing

Classify each request into one of:

- explain
- search
- implement
- refactor
- debug
- test
- review
- scaffold
- terminal assist
- repo summarize
- memory lookup

## Planner responsibilities

The planner creates structured plans with:

- objective
- constraints
- assumptions
- scope
- candidate files
- execution steps
- verification steps
- rollback notes

### Planner output schema
```json
{
  "objective": "string",
  "scope": {
    "mode": "selection|file|workspace",
    "paths": ["string"]
  },
  "assumptions": ["string"],
  "steps": [
    {
      "id": "step_1",
      "goal": "string",
      "tools": ["read_file", "search_symbols"],
      "expected_output": "string"
    }
  ],
  "verification": [
    {
      "type": "test|lint|build|diagnostics",
      "command": "string"
    }
  ]
}
```

## Executor responsibilities

The executor:

- executes plan steps
- retries transient failures
- preserves step logs
- avoids duplicate reads
- batches similar operations
- stops on policy violations
- requests approval before risky actions

## Policy engine

The policy engine decides:

- whether shell command is allowed
- whether file write is allowed
- whether changes exceed safe threshold
- whether network access is allowed
- whether MCP tool can run
- whether user confirmation is required

## Trace recording

Every task should log:

- prompt version
- model used
- tool sequence
- latency per step
- files read
- files modified
- diff summaries
- verification outputs
- final status

## Recovery

On crash or reload:

- persist current state after every important step
- recover unfinished session
- mark partially applied changes
- offer resume/retry/rollback
