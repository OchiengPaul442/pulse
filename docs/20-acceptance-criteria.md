# Acceptance Criteria

## Extension install and startup
- installs as VSIX without manual patching
- appears in VS Code extensions list normally
- activates from command or configured startup event
- opens sidebar or panel successfully

## Ollama integration
- detects unavailable Ollama clearly
- streams model responses
- supports configurable planner/editor models
- validates structured JSON outputs before acting

## Agentic behavior
- creates a plan for medium and large tasks
- gathers relevant context before editing
- keeps a visible execution trace
- asks for approval for risky actions

## Editing
- previews diffs before applying
- supports multi-file transactions
- can revert prior agent changes
- avoids unrelated file churn

## Sessions and memory
- persists tasks across reload
- resumes from last checkpoint
- stores workspace facts and user preferences
- captures feedback after task completion

## MCP
- connects to configured servers
- lists tools/resources/prompts
- can execute trusted MCP tools
- degrades gracefully if a server fails

## Verification
- can run diagnostics, tests, or build commands
- records verification outcomes honestly
- never claims success without evidence

## Reliability
- handles timeout and malformed output
- survives extension reload
- survives model outage gracefully
- logs enough detail for debugging

## Quality
- has unit tests for core modules
- has integration tests for provider, MCP, and edits
- has extension tests for activation and commands
- produces a package ready for local use
