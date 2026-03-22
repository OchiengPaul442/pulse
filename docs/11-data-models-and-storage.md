# Data Models and Storage

## Storage choice

Use SQLite for local durability and simplicity.
Use filesystem caches for large indexes and snapshots.

## Tables

### sessions
```sql
id TEXT PRIMARY KEY
workspace_id TEXT NOT NULL
branch TEXT
title TEXT
status TEXT
planner_model TEXT
editor_model TEXT
created_at TEXT
updated_at TEXT
```

### tasks
```sql
id TEXT PRIMARY KEY
session_id TEXT NOT NULL
objective TEXT
scope_mode TEXT
status TEXT
current_step TEXT
created_at TEXT
updated_at TEXT
```

### traces
```sql
id TEXT PRIMARY KEY
task_id TEXT NOT NULL
event_type TEXT NOT NULL
payload_json TEXT NOT NULL
created_at TEXT
```

### edits
```sql
id TEXT PRIMARY KEY
task_id TEXT NOT NULL
transaction_id TEXT
file_path TEXT NOT NULL
operation TEXT NOT NULL
before_hash TEXT
after_hash TEXT
diff_text TEXT
applied INTEGER
created_at TEXT
```

### memories
```sql
id TEXT PRIMARY KEY
workspace_id TEXT
memory_type TEXT
title TEXT
content TEXT
embedding_ref TEXT
score REAL
source_trace_id TEXT
created_at TEXT
updated_at TEXT
```

### feedback
```sql
id TEXT PRIMARY KEY
task_id TEXT NOT NULL
edit_id TEXT
rating INTEGER
action TEXT
note TEXT
created_at TEXT
```

### mcp_servers
```sql
id TEXT PRIMARY KEY
name TEXT
transport TEXT
config_json TEXT
trust_level TEXT
enabled INTEGER
last_seen_at TEXT
```

### workspace_facts
```sql
id TEXT PRIMARY KEY
workspace_id TEXT
fact_key TEXT
fact_value TEXT
confidence REAL
source_trace_id TEXT
updated_at TEXT
```

## Filesystem cache layout

```text
.storage/
  db.sqlite
  indexes/
  snapshots/
  traces/
  embeddings/
  temp/
```

## Workspace fingerprint

Compute from:
- workspace root path
- git remote url if present
- package manifests
- language fingerprints

Use this to isolate project memory correctly.

## Snapshot strategy

For every apply transaction, store:
- pre-change files
- post-change metadata
- diff
- verification result
