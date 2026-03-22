# Editing and Refactoring Engine

## Goal

Support precise single-file and multi-file edits with strong previews, rollback, and verification.

## Editing modes

### 1. Inline localized patch
Small fix to selection or nearby lines

### 2. File rewrite section
Replace function/class/module sections

### 3. Multi-file coordinated edit
Changes across interfaces, implementations, tests, docs, config

### 4. Generated file creation
Scaffold new modules, tests, migrations, or configs

## Edit pipeline

```text
identify target files
-> collect anchors and symbols
-> produce edit intents
-> generate patch
-> validate syntax
-> preview diff
-> apply
-> verify
-> rollback on failure if configured
```

## Edit intent schema

```json
{
  "filePath": "src/foo.ts",
  "operation": "replace_range|insert_after_symbol|create_file|delete_file",
  "reason": "Add service dependency injection",
  "anchors": {
    "symbol": "FooService",
    "startLine": 10,
    "endLine": 42
  },
  "content": "..."
}
```

## Patch strategy

Preferred order:

1. symbol-aware patch
2. range patch
3. AST transform where supported
4. full file rewrite only as last resort

## Multi-file change planner

For cross-file changes, require the planner to produce:

- dependency order
- interfaces first or last decision
- test updates needed
- migration/doc updates needed
- rollback notes

## Guardrails

- reject edits against non-existent files unless create_file was intended
- detect stale anchors before apply
- re-read file before apply if changed externally
- refuse huge rewrites without confirmation
- keep a backup snapshot for each apply batch

## Conflict handling

When file content changed between plan and apply:

- attempt anchor relocation
- rerun localized context
- regenerate patch
- ask for confirmation if uncertainty is high

## Verification levels

### Fast
- syntax parse
- type check for touched files if supported
- diagnostics refresh

### Standard
- unit tests related to touched modules
- linter
- formatter

### Full
- complete test suite
- build
- optional integration tests

## Undo support

Store per-apply transaction metadata:

- transaction id
- changed files
- old content hash
- new content hash
- diff summary
- verification status

Provide:
- revert last apply
- revert transaction by id
- restore file snapshot

## Exactly like a coding agent should behave

For large requests:

- first produce a plan
- then gather evidence
- then patch in batches
- verify each batch
- summarize what changed and why

Do not jump straight into giant blind rewrites.
