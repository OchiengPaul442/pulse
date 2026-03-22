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

## Practical release workflow

Use this sequence for each release:

1. `npm install`
2. `npm run compile`
3. `npm run test`
4. `npm run package`
5. install generated VSIX locally and smoke test in Extension Development Host
6. bump version in `package.json` (or `npm version patch|minor|major`)
7. publish with `npx vsce publish`

## Publisher setup

Before first publish:

1. Create a publisher in Azure DevOps Marketplace.
2. Generate a PAT with Marketplace publish scope.
3. Authenticate locally:
   - `npx vsce login <publisher-name>`
4. Ensure `publisher` in `package.json` exactly matches the publisher ID.

## Reinstalling the packaged extension

After building a new VSIX:

1. In VS Code Command Palette run `Extensions: Install from VSIX...`
2. Select `pulse-agent-<version>.vsix`
3. Reload VS Code window
4. Verify status badge, model list sync, and MCP diagnostics command output

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
