# AI Session Alias Persistence Design

## Problem

Project Steward stores user-defined AI session names in
`ai-session-aliases.json`, keyed by provider and session ID. During sidebar
refresh, session discovery is scoped to the projects open in the current VS
Code window. The refresh path currently treats sessions missing from that
scoped result as deleted and removes their aliases from persistent storage.

This makes aliases disappear after project switches, multi-window refreshes,
or transient provider read failures. When the session appears again, its name
falls back to the provider-supplied value, which is often the chat ID.

## Ownership Rule

AI session aliases are user-owned persistent metadata. Session discovery is a
read-only view of provider state and must not delete aliases based on absence
from a discovery result.

An alias may be removed only by an explicit lifecycle action:

- the user clears or resets the name in the Rename action;
- Project Steward successfully archives that session.

External deletion or archival, project switching, window-scoped discovery,
and transient read failures do not remove aliases.

## Implementation

- Stop calling alias-pruning logic from the Open Project rendering and refresh
  path.
- Keep applying aliases in `prepareAiSessionsForDisplay` using the stable
  `provider:sessionId` key.
- Preserve the existing alias JSON format and storage location; no migration is
  required.
- Keep the existing explicit deletion paths for Rename reset and successful
  archive.
- Remove alias-pruning helpers if they have no remaining callers.

No provider service, session discovery behavior, UI contract, or project data
format changes are included.

## Error Handling

Existing read and write error handling remains unchanged. Failure to read an
alias file falls back to provider names and is logged. Failure to save an alias
continues to show the existing error message.

## Testing

Add a regression check proving that the Open Project refresh path does not
prune persisted aliases from scoped session results. The check must fail
against the current implementation before production code changes.

Retain existing coverage that verifies:

- aliases override provider-supplied session names;
- clearing a Rename value removes the alias;
- successful Project Steward archival removes the alias;
- provider and command behavior remains unchanged.

Run TypeScript compilation, the safety checks, lint, and webpack after the
minimal fix.

## Acceptance Criteria

- A renamed session keeps its display name across watcher refreshes.
- Switching projects or opening another VS Code window does not delete aliases.
- A session that temporarily disappears and later returns keeps its alias.
- Resetting the name explicitly restores the provider-supplied name.
- Successfully archiving through Project Steward removes the alias.
- Existing session discovery and rendering behavior does not regress.
