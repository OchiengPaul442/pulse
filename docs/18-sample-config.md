# Sample Configuration

```json
{
  "pulse.ollama.baseUrl": "http://localhost:11434",
  "pulse.models.planner": "qwen2.5-coder:7b",
  "pulse.models.editor": "qwen2.5-coder:7b",
  "pulse.models.fast": "nemotron-mini:latest",
  "pulse.models.embedding": "nomic-embed-text:latest",
  "pulse.models.fallbacks": ["deepseek-r1:7b", "nemotron-mini:latest"],
  "pulse.behavior.approvalMode": "balanced",
  "pulse.behavior.allowTerminalExecution": false,
  "pulse.behavior.autoRunVerification": true,
  "pulse.behavior.memoryMode": "workspace+episodic",
  "pulse.behavior.maxContextTokens": 32000,
  "pulse.indexing.enabled": true,
  "pulse.indexing.mode": "hybrid",
  "pulse.mcp.servers": [
    {
      "id": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "${workspaceFolder}"
      ],
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
