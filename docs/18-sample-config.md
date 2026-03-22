# Sample Configuration

```json
{
  "agent.ollama.baseUrl": "http://localhost:11434",
  "agent.models.planner": "qwen2.5-coder:14b",
  "agent.models.editor": "deepseek-coder-v2:16b",
  "agent.models.fast": "qwen2.5-coder:7b",
  "agent.models.embedding": "nomic-embed-text",
  "agent.behavior.approvalMode": "balanced",
  "agent.behavior.autoRunVerification": true,
  "agent.behavior.memoryMode": "workspace+episodic",
  "agent.behavior.maxContextTokens": 32000,
  "agent.indexing.enabled": true,
  "agent.indexing.mode": "hybrid",
  "agent.mcp.servers": [
    {
      "id": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"],
      "enabled": true,
      "trust": "workspace"
    }
  ]
}
```

## Notes

- Replace model names based on what you have locally in Ollama.
- Keep planner and editor models separate if possible.
- Start with strict or balanced approval mode.
- Enable indexing once the extension startup path stays fast.
