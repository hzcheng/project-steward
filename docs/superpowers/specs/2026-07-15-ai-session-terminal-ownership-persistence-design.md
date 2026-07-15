# AI Session Terminal Ownership Persistence Design

## Problem

Project Steward can create a new AI session before the provider has assigned its final session ID. The terminal is initially tracked as pending and is later bound to the discovered session only in extension-host memory.

After a VS Code window reload, that in-memory binding is lost. The original terminal has neither the final session ID in its creation environment nor the normal `[session-id-prefix]` resume-terminal name, so Project Steward cannot recognize it. This causes two visible failures:

- session attention is not attributed to the original session;
- clicking the session card opens a duplicate terminal instead of focusing the existing one.

## Scope

Persist ownership only for terminals created by Project Steward. Do not change provider lifecycle parsing, attention payloads, UI rendering, or terminals opened outside Project Steward.

## Design

### Stable terminal instance identity

Every Project Steward-created AI terminal receives a random, privacy-safe instance ID in its terminal creation environment. The instance ID identifies the terminal, not the provider session, and remains available through VS Code terminal persistence and window reloads.

### Workspace-scoped binding registry

The extension stores a bounded registry in `context.workspaceState`, keyed by terminal instance ID. A record is either:

- `pending`: provider, cwd, creation time, marker path, excluded session IDs, and optional title;
- `bound`: provider, final session ID, marker path, and run start time.

The terminal instance ID is random and records remain local to the workspace extension host. The registry does not contain prompts or transcript content.

### Restore flow

On activation, the terminal service reads the registry and enumerates the terminals visible in the current window:

1. Read the terminal instance ID from each terminal's creation environment.
2. Restore matching `bound` records directly into the tracked-terminal map.
3. Restore matching `pending` records into the pending reconciliation queue.
4. Ignore records whose terminal is not visible in this window. They are retained so another window using the same workspace state cannot be accidentally erased.

When pending reconciliation discovers the provider session, the record is atomically promoted from `pending` to `bound` before subsequent refreshes use it.

### Lifecycle and cleanup

- A resumed session terminal is persisted as `bound` immediately.
- A newly created session terminal is persisted as `pending` immediately.
- Closing or explicitly untracking the terminal removes its registry record.
- Writes are serialized and merge with the latest stored registry so rapid state changes do not let an older write overwrite a newer binding.
- Invalid, oversized, or malformed stored records are ignored. The registry has explicit record and string bounds.

## Failure handling

Persistence is best effort. If `workspaceState.update` fails, current-window in-memory tracking continues to work and the error is logged once through the existing Project Steward output channel. No provider command is blocked by persistence failure.

## Testing

Regression tests must prove:

1. A pending new-session terminal can be reconstructed after creating a new terminal-service instance.
2. After pending reconciliation, a second terminal-service instance restores the exact final session ID and `getById` returns the original terminal.
3. Clicking/resuming therefore reuses the restored terminal instead of creating another one.
4. Closing a terminal removes its persistent binding.
5. Malformed persisted records are ignored without affecting valid records.
6. Existing AI session safety, explicit lifecycle attention, and Open Project tests remain green.

## Non-goals

- Recovering terminals created before the instance-ID mechanism exists.
- Guessing ownership from cwd or recent transcript timestamps.
- Sharing terminal ownership across different machines or VS Code remote authorities.
