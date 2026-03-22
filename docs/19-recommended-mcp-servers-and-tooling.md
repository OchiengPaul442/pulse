# Recommended MCP Servers and Tooling

## Start small

Begin with a small trusted set of MCP servers and only expand after the client abstraction is stable.

## Recommended categories

### Filesystem / repo access
Use for:
- controlled file reads
- safe path-based context retrieval
- directory inspection

### Documentation retrieval
Use for:
- official docs lookup
- internal markdown references
- package usage examples

### Browser / web automation
Use for:
- reading docs that are not available locally
- authenticated internal tools if you control the environment

### Database inspection
Use for:
- schema browsing
- read-only query support
- migration validation

### Issue tracker / project tools
Use for:
- linking tasks to implementation work
- pulling ticket details into context

### CI / build status
Use for:
- checking latest build state
- reading artifacts
- surfacing failure summaries

## Tool taxonomy for the agent

Create internal categories so the planner can choose tools cleanly:

- `context.read`
- `context.search`
- `repo.git`
- `code.symbols`
- `code.edit`
- `verify.test`
- `verify.build`
- `runtime.shell`
- `external.docs`
- `external.browser`
- `external.db`

## Trust model

Every server should declare:
- risk level
- side-effect level
- requires approval
- workspace scope
- allowed environments

## v1 recommendation

Support only:
- a trusted filesystem MCP server
- one docs or browser MCP server
- optional custom internal utility server

Do not start with ten servers.
