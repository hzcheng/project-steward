# New Session Pending Lifecycle Design

## Context

Creating an AI session immediately adds a pending `Starting` row to the project's ACTIVE tab. The creation controller currently starts a 15-second binding timer. If the provider's session file is not discoverable before that timer expires, the controller removes the pending record and shows `Could not detect the new session`.

Interactive providers may not write a session file until the user sends the first message. The observed Codex session started at `22:13:07`, while its JSONL file appeared at `22:14:03`, about 56 seconds later. The pending record was therefore removed before the existing resolver could bind it, even though the Terminal remained open and the eventual session had the correct project path.

## Goal

Keep a newly created session visible in the ACTIVE tab for as long as its Terminal remains open. When the provider session becomes discoverable, promote the pending runtime to the established session without losing Terminal ownership.

## Non-goals

- Add a new ACTIVE-tab status or change the existing `Starting` presentation.
- Change provider session discovery, path normalization, or matching rules.
- Change established-session completion behavior.
- Keep pending records after their Terminal closes.

## Lifecycle

The pending Terminal becomes the authoritative runtime record until one of two events occurs:

1. The session resolver finds a provider session created after the pending record, in the same normalized working directory, and not present in the creation-time exclusion set. The resolver replaces the pending record with a bound active-session entry.
2. VS Code reports that the Terminal closed. The terminal service removes the pending record, and the ACTIVE projection removes its row.

There is no elapsed-time transition while the Terminal remains open. Extension reload continues to restore persisted pending bindings. The terminal service's existing 24-hour TTL remains a recovery guard for stale persisted metadata; it is not a live creation timeout.

## Component Changes

### Creation controller

Remove the 15-second binding timeout and all controller-owned pending timer state. Creating a session still tracks the pending Terminal, selects the ACTIVE tab, refreshes the projection, opens the Terminal, sends the provider command, and schedules provider refreshes.

The controller no longer removes pending records or emits `Could not detect the new session`. Its lifecycle ends after launching the provider command.

### Terminal service and resolver

Keep their current responsibilities unchanged:

- the terminal service owns pending records, persistence, close cleanup, and stale restored-record trimming;
- the resolver promotes a pending record when a matching session appears;
- the runtime projection displays every owned pending record as `Starting`.

This avoids introducing a second lifetime policy alongside Terminal ownership.

## Error Handling

Provider picker cancellation, missing projects, unusable working directories, and Terminal creation warnings keep their current behavior. A provider process that stays open without creating a session remains visible as `Starting`, because it is still an active Terminal owned by the dashboard. The user can focus or close that Terminal from the existing ACTIVE controls.

If the Terminal closes before a session is discovered, existing close handling removes the pending record. No detection warning is shown because the close event supplies a definitive lifecycle boundary.

## Testing

Safety checks will cover these behaviors:

- creation tracks one pending record and does not schedule a binding timeout;
- an unresolved pending record remains present beyond the former 15-second boundary without a warning or removal;
- a session that becomes discoverable after a 56-second delay is matched and promoted to a bound active session;
- closing a pending Terminal still removes its record;
- existing creation, persistence, resolver, ACTIVE projection, compilation, and open-project safety checks continue to pass.

## Acceptance Criteria

- A session created from NEW remains in ACTIVE with `Starting` while its Terminal is open, regardless of how long session-file creation takes.
- No `Could not detect the new session` warning appears solely because 15 seconds elapsed.
- Once the session file is discoverable, the same Terminal is bound to the session and the ACTIVE row becomes an established session row.
- Closing the Terminal removes an unresolved pending row.
- Main checkout user changes remain untouched; all work occurs on `fix/new-session-pending-lifecycle` in its isolated worktree.
