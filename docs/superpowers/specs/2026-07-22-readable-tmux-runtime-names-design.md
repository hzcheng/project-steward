# Readable Tmux Runtime Names Design

Date: 2026-07-22

Status: Approved in conversation; awaiting written-spec review

## Goal

Make Project Steward-managed tmux sessions and windows recognizable in native tmux lists while preserving exact workspace/session ownership, deterministic collision resistance, runtime restoration, and the existing Project Steward UI.

## Confirmed Product Decision

Tmux names are determined when the managed object is created and remain stable for that object's lifetime.

- Renaming a project card does not rename an existing tmux session.
- Renaming an AI session alias does not rename an existing tmux window/session.
- A later runtime created after the prior tmux object no longer exists uses the current project/session display name.
- Existing legacy hash-named tmux runtimes remain discoverable and keep their existing names.

## Naming Rules

### Project layout

One tmux session represents the workspace/project card and each AI runtime is a window:

```text
session: ps-<project-card-name>-<workspaceHash8>
window:  <provider>-<session-name>-<sessionHash8>
pending: <provider>-<entered-title-or-new-session>-<pendingHash8>
```

Example:

```text
session: ps-reddb-dts-dual-active-a31f9c20
window:  codex-fix-replication-timeout-42d815ce
```

The first runtime created for a workspace fixes the project tmux session name. If the card is renamed while that session still exists, later windows continue using the same existing tmux session instead of creating a second session for the same workspace.

### Session layout

Each AI runtime is its own tmux session:

```text
session: ps-<project-card-name>-<session-name>-<sessionHash8>
pending: ps-<project-card-name>-<entered-title-or-new-session>-<pendingHash8>
window:  <provider>-<session-name>-<sessionHash8>
```

The session-layout window remains a single managed window, but its native tmux window name is readable instead of the generic `ai-session` name.

### Pending promotion

A pending runtime initially uses the entered title, or `new-session` when the title is empty. Once Project Steward resolves the pending runtime to a provider session, promotion renames the pending tmux window/session to a final readable name derived from the resolved session's current display name and final session identity.

This promotion rename is part of the existing pending-to-final identity transaction, not a response to later alias edits.

## Safe Name Normalization

Readable components are normalized independently from identity:

- normalize Unicode with NFKC;
- trim surrounding whitespace;
- preserve Unicode letters and numbers;
- collapse whitespace and unsafe punctuation to one hyphen;
- remove control characters and tmux target separators such as `:` and `.`;
- remove leading/trailing hyphens;
- use `workspace`, `session`, or `new-session` when the readable component becomes empty;
- bound the complete session/window name while always retaining the structural prefix and 8-character identity suffix required by the format;
- pass names to tmux as argument-array values without shell interpolation.

The readable prefix is presentation only. Workspace/session identity continues to come exclusively from validated Project Steward metadata.

## Uniqueness and Locator Semantics

The 8-character suffix is derived from the same canonical identity inputs already used by Project Steward:

- project session suffix: workspace scope identity;
- final runtime suffix: workspace scope, provider, and final session ID;
- pending runtime suffix: workspace scope, provider, and pending ID.

The suffix prevents ordinary duplicate display names from colliding. Existing metadata collision diagnostics remain the authoritative fail-closed guard for malformed, duplicated, or externally renamed runtimes.

Locator validation will accept two managed naming families:

1. the existing legacy hash-only names;
2. the new readable names with a valid identity-derived suffix.

Discovery validates the actual locator against the identity-derived suffix and metadata rather than recomputing the entire human-readable prefix. This allows creation-time names to remain stable after later card/alias edits without weakening identity ownership.

If more than one actual locator claims the same complete runtime identity, the existing conflict path wins and neither runtime is silently focused or resumed.

## Data Flow

### Resume an existing provider session

1. The workspace action target supplies the project card display name.
2. The prepared provider session supplies the current session display name, including any alias already applied before runtime creation.
3. The resume request carries both display names separately from the runtime identity.
4. Discovery first looks for an existing managed runtime with the exact identity.
5. If one exists, its creation-time locator is reused unchanged.
6. Otherwise the selected layout creates a readable locator with the identity suffix.

### Create a new provider session

1. The creation request carries the project card display name and entered title.
2. The pending locator uses the project name plus title/new-session fallback.
3. Project Steward writes the same ownership metadata and persistence records as today.
4. When the provider session appears, the resolver supplies its current display name to promotion.
5. Promotion calculates the final readable locator, performs the existing ambiguity-safe rename/metadata transaction, and updates attach/runtime bindings.

### Project layout reuse after a card rename

1. A project-session resolver scans session-level ownership metadata, including the base-only bootstrap window, and finds the existing session for the workspace scope.
2. Creation uses that actual session name and creates only the new readable window.
3. No duplicate project session is created from the newer card label.

If the resolver finds more than one project session claiming the same workspace scope, creation fails closed through the collision path.

## Compatibility

- Existing legacy Project Steward tmux sessions/windows remain visible and actionable.
- Existing legacy runtimes are never renamed merely because the extension is upgraded.
- New runtimes use readable names.
- Saved projects and saved workspaces are unchanged because display-name locator inputs are runtime-only data.
- Direct Terminal mode is unchanged.
- Project Steward card appearance, session labels, attention, running animation, focused state, completion, detach, and Other Windows behavior are unchanged.

## Error Handling

- Invalid or empty display names use bounded fallbacks and never prevent runtime creation.
- A generated readable locator already occupied by unrelated metadata is treated as a collision; Project Steward does not overwrite or attach to it.
- External renames that remove the valid identity suffix fail locator verification and enter the existing conflict diagnostics.
- Ambiguous create/rename results continue using the existing tombstone and recovery transactions.
- No raw project/session display name is added to error messages or diagnostics.

## Test Strategy

Automated checks will cover:

1. Unicode-preserving normalization, punctuation cleanup, fallbacks, bounds, and fixed suffix retention;
2. deterministic project, final, and pending readable names;
3. duplicate project/session display names producing distinct locators;
4. legacy locator acceptance and readable locator acceptance;
5. incorrect suffix, external rename, and multiple-locator collision rejection;
6. project layout creation using project name and session name;
7. project layout reuse after the project card name changes;
8. session layout readable session and window names;
9. pending title/new-session names and promotion to the resolved provider session name;
10. alias changes after creation leaving active locator names unchanged;
11. persisted known/pending/consumed/promoting/attach bindings retaining actual locators;
12. exact-target focus validation continuing to use the actual verified locator;
13. workspace parity, attention, running animation, pending promotion, Dashboard, safety, real tmux smoke, build, and packaging regressions.

## Acceptance Criteria

- `tmux list-sessions` identifies newly created project-layout runtimes primarily by project card name.
- `tmux list-windows` identifies newly created AI runtimes primarily by the session name visible in Project Steward.
- Names remain unique when project cards or sessions share the same display name.
- Running tmux names do not change after project/alias edits.
- Pending promotion produces the final readable session name exactly once as part of promotion.
- Existing legacy runtimes remain usable without migration.
- No saved-project/workspace or Project Steward visual behavior regresses.
