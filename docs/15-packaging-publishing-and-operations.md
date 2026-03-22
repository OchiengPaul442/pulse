# Packaging, Publishing, and Operations

## Local install first

Your first success criterion is a locally installable VSIX.
Do not optimize for marketplace publication before the extension is stable.

## Packaging checklist

- bundle extension code
- keep production dependencies minimal
- include icons and metadata
- verify activation events
- verify commands and views
- verify settings schema
- smoke test on Windows, macOS, and Linux if possible

## Versioning

Use semantic versioning:

- major for architecture changes
- minor for new capabilities
- patch for bug fixes

## Release artifacts

- `.vsix` package
- changelog
- release notes
- migration notes for config/schema changes
- known issues list

## Operational diagnostics

Provide a command:

- Agent: Open Diagnostics Report

It should show:
- extension version
- VS Code version
- Ollama status
- loaded models
- MCP server status
- index status
- db status
- last task failures

## Logging policy

Support:
- info
- warn
- error
- debug

Keep a rolling local log file with retention limits.
Allow users to export logs for debugging.

## Performance strategy

- lazy initialize heavy components
- batch file system scans
- cache symbol maps
- debounce diagnostics refresh
- avoid serial model calls where not needed
- reduce context for small tasks

## Backup and recovery

The agent should survive:
- VS Code restart
- extension reload
- model outage
- MCP disconnect
- half-finished edit session

## Support commands

- reset local index
- clear session cache
- export trace bundle
- verify model config
- reconnect MCP servers
