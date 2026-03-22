# Prompts, Policies, and Operating Rules

## Design principle

Prompts are part of the software.
Version them, test them, and keep them modular.

## Prompt stack

### System policy prompt
Defines hard rules:
- safe tool usage
- allowed scope
- honesty about uncertainty
- no fake verification
- no hidden edits

### Runtime behavior prompt
Defines style of operation:
- plan before large edits
- cite file evidence
- prefer minimal diffs
- verify after changes

### Workspace convention prompt
Defines repo-specific norms:
- frameworks
- style rules
- test commands
- architecture notes

### Task prompt
Contains current user request, scope, constraints, selected context, and expected schema.

## Planner prompt requirements

The planner must:
- define assumptions
- identify likely files
- propose verification
- avoid immediate editing
- respect budget limits

## Editor prompt requirements

The editor must:
- preserve surrounding code style
- edit smallest correct scope
- avoid inventing APIs
- produce structured patch metadata
- mention uncertainties

## Tool-use prompt requirements

The tool-use policy must instruct the model to:
- read before write
- re-read before applying if content may be stale
- use diagnostics before guessing
- use search before broad rewrite
- stop if tool output contradicts assumption

## Verification prompt requirements

The verification model or step must:
- inspect command output
- distinguish passed, failed, flaky, not-run
- identify next likely fix when failed
- avoid claiming success without evidence

## Memory extraction prompt

Extract only:
- durable preferences
- durable repo facts
- reusable lessons
- useful follow-up items

Reject:
- transient details
- sensitive secrets
- low-confidence assumptions

## Prompt versioning

Store:
- prompt id
- semantic version
- last updated
- target model profile
- known limitations
- eval notes

## Example operating rules

1. For any workspace-wide change, plan first.
2. For any file write, read the target file first.
3. For any multi-file edit, update tests or explain why not.
4. For any success claim, provide verification evidence.
5. For any uncertainty, say exactly what is missing.
