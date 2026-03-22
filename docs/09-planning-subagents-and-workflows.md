# Planning, Subagents, and Workflows

## Why subagents

Large coding tasks benefit from decomposition. Even if you start with one runtime, design the system so tasks can be split into focused workers later.

## Subagent types

### Research subagent
Finds relevant files, symbols, APIs, docs, and conventions.

### Planner subagent
Builds execution plan and dependency order.

### Editor subagent
Generates precise patches.

### Test subagent
Adds or updates tests.

### Verification subagent
Runs checks and interprets failures.

### Memory subagent
Extracts durable facts and lessons.

## Coordination model

Use a supervisor pattern:

```text
Supervisor
├── Research Worker
├── Planner Worker
├── Editor Worker
├── Verification Worker
└── Memory Worker
```

In v1 this can be simulated inside a single runtime using role-based structured steps.
Later it can become parallel or queued workers.

## Workflow templates

### Implement feature
1. clarify goal
2. discover relevant files
3. plan change set
4. edit source files
5. add tests
6. run verification
7. summarize

### Fix bug
1. inspect diagnostics or failing test
2. identify root cause candidates
3. inspect impacted symbols
4. patch smallest safe scope
5. run targeted verification
6. summarize confidence and residual risk

### Refactor
1. identify code graph
2. produce migration plan
3. patch in dependency order
4. update imports and tests
5. verify build and tests

## Task envelopes

Every workflow should pass around a consistent object:

```json
{
  "taskId": "string",
  "objective": "string",
  "scope": "selection|file|workspace",
  "constraints": ["string"],
  "relevantFiles": ["string"],
  "plan": [],
  "artifacts": [],
  "verification": [],
  "status": "string"
}
```

## Parallelism

Only parallelize safe read-heavy operations first:

- file scanning
- symbol extraction
- chunk embedding
- diagnostics collection
- MCP resource fetches

Keep writes serialized by transaction.

## Long-running tasks

Support progress events like:

- scanning workspace
- analyzing dependencies
- generating patches
- running tests
- waiting for approval

Persist progress so task resumes after restart.
