# Memory, Learning, and Sessions

## Principle

The agent should improve through **structured learning**, not uncontrolled self-modification.

That means it should learn from:

- accepted edits
- rejected suggestions
- user follow-up patches
- successful verification patterns
- project conventions
- recurring commands
- common file clusters
- prior task traces

## Memory types

### 1. Session memory
Short-lived task state:
- recent messages
- current plan
- tool outputs
- edited files
- verification status

### 2. Workspace memory
Project-specific facts:
- framework and versions
- folder conventions
- naming patterns
- test commands
- lint commands
- common architecture notes
- known pitfalls

### 3. User preference memory
Personal operating preferences:
- approval mode
- preferred models
- patch verbosity
- code style preferences
- shell permission preferences

### 4. Episodic memory
Past task summaries:
- objective
- files touched
- success/failure
- lessons learned
- follow-up links

### 5. Semantic memory
Embedded chunks:
- architecture docs
- frequent modules
- reusable implementation patterns

## What "learning" should mean in v1

### Allowed
- remember preferences
- learn project conventions
- rank better context sources
- improve prompt templates through versioned configs
- use accepted/rejected history to tune retrieval and edit policies
- capture successful tool sequences for similar tasks

### Not allowed
- live mutation of core safety code without review
- automatic rewriting of system prompts in production
- silent model switching
- hidden policy changes

## Session management

A session should support:

- creation
- save checkpoints
- pause
- resume
- branch into subtask
- archive
- search history

## Checkpoint model

Create checkpoints:

- before any write
- before terminal commands with side effects
- after successful verification
- before risky MCP actions

## Memory extraction pipeline

After task completion:

1. summarize task
2. detect durable facts
3. classify memory type
4. score usefulness
5. deduplicate
6. persist
7. link to trace id

## Feedback capture

Capture user interactions like:

- accepted patch
- partial accept
- edit after accept
- revert
- thumbs up/down
- explicit feedback note

Use this to compute:

- patch precision score
- style alignment score
- tool utility score
- verification reliability

## Continuous improvement loop

```text
task completed
-> trace stored
-> feedback captured
-> memory extracted
-> retrieval ranking adjusted
-> prompt templates reviewed offline
-> eval suite updated
```

## Important rule

Use **offline improvement workflows** for major changes.

The agent can recommend:
- prompt changes
- tool ranking changes
- retrieval tweaks
- model routing tweaks

But those changes should go through versioned review, not uncontrolled self-editing at runtime.
