# Security, Guardrails, and Trust

## Security posture

This extension can read code, edit files, run commands, and connect to tools.
Treat it as a privileged system.

## Threats to design for

- prompt injection from workspace files
- malicious MCP servers
- destructive shell commands
- exfiltration through tool output
- accidental secrets exposure
- unsafe file writes outside workspace
- model hallucinations causing wrong edits
- poisoned memory from bad feedback loops

## Core security rules

1. Never allow arbitrary writes outside approved roots
2. Never allow shell with side effects without policy checks
3. Never trust instructions embedded in source code comments blindly
4. Never auto-run newly discovered MCP tools without trust evaluation
5. Never store secrets in plain text logs
6. Never treat model text as execution-safe by default

## Approval modes

### Strict
- approve all writes
- approve all shell commands
- approve all MCP tool calls except read-only safe list

### Balanced
- auto-approve read operations
- approve writes and side-effect shell commands
- allow trusted MCP read tools

### Fast
- auto-approve low-risk writes in workspace
- approve destructive actions
- log everything

## Secrets handling

Use VS Code secret storage or OS-secure storage for:

- API keys
- auth tokens
- MCP credentials
- remote model credentials

Do not store secrets in session trace tables.

## Prompt injection defense

Before using file content as instructions:

- classify as code/data/comment/doc
- isolate it as evidence, not authority
- strip or sandbox “ignore previous instructions” type text
- keep system and policy prompts separate and higher priority

## Shell execution policy

Categorize commands:

### Safe read-only
- ls
- cat
- rg
- git status
- npm test -- --runInBand? only if approved policy allows
- language-specific diagnostics commands

### Potentially risky
- package install
- formatter with writes
- git checkout
- migrations
- docker compose
- scripts from repo

### Destructive
- rm -rf
- git reset --hard
- database drop/reset
- force pushes

Destructive actions should be blocked or require explicit typed confirmation.

## MCP trust registry

Track per server:

- origin
- install method
- owner
- capability list
- past failures
- last approval
- risk classification

## Observability and audit

Every privileged action should be auditable:

- who initiated it
- which task
- which files
- which command or tool
- which outputs
- whether it succeeded
