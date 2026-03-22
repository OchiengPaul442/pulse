# MCP Integration

## Why MCP matters

MCP turns the agent into a platform instead of a closed tool. It lets the agent connect to external tools, prompts, resources, and workflows without custom hardcoding each time.

## MCP roles in this system

Your extension acts as an **MCP client**.
It can connect to one or more MCP servers that provide:

- tools
- resources
- prompts
- roots
- optional sampling-related capabilities depending on server and SDK support

## Example MCP servers to support

- filesystem helpers
- git or repo intelligence
- browser automation
- docs retrieval
- package registry lookups
- database inspection
- issue tracker access
- CI/CD status
- custom internal automation scripts

## MCP manager module

Create:

```text
src/agent/mcp/
  McpManager.ts
  McpServerConnection.ts
  McpToolAdapter.ts
  McpResourceAdapter.ts
  McpPromptAdapter.ts
  McpRegistry.ts
```

## Responsibilities

### McpManager
- load server configs
- connect/disconnect/retry
- keep capability registry
- expose tools/resources/prompts to the runtime

### McpToolAdapter
- normalize tool schemas
- validate inputs
- execute tool calls
- capture logs and errors

### McpResourceAdapter
- fetch resource content
- cache content where safe
- convert resources into retrieval context

### McpPromptAdapter
- expose reusable prompt workflows to the agent

## Server configuration example

```json
{
  "agent.mcp.servers": [
    {
      "id": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "enabled": true,
      "trust": "workspace"
    },
    {
      "id": "docs",
      "transport": "stdio",
      "command": "node",
      "args": ["./scripts/docs-mcp-server.js"],
      "enabled": true,
      "trust": "user"
    }
  ]
}
```

## Tool exposure policy

Do not expose every MCP tool automatically to every task.

Instead:

1. classify request
2. determine needed tool families
3. expose only relevant tools to the model
4. gate dangerous tools with confirmation

## MCP safety model

For each MCP server define:

- trust level
- allowed workspaces
- allowed tool names
- network permission
- file write permission
- shell permission
- prompt injection risk score
- manual approval requirement

## Connection lifecycle

```text
load config
-> spawn/connect
-> initialize
-> read capabilities
-> register tools/resources/prompts
-> health monitor
-> reconnect if needed
-> disconnect on shutdown
```

## Context use from resources

Treat MCP resources as retrieval inputs, not absolute truth.

Store:
- server id
- resource uri
- last fetched time
- content hash
- classification label
- cache policy

## Tool result normalization

Wrap all MCP outputs in a standard envelope:

```json
{
  "toolName": "string",
  "serverId": "string",
  "status": "ok|error",
  "data": {},
  "stderr": "string",
  "durationMs": 1234
}
```

## Best practice

Prefer a small number of trustworthy MCP servers first.
Get the client abstraction right before adding many servers.
