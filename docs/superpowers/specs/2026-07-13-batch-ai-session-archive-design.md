# Batch AI Session Archive Design

## Problem

Project Steward currently archives AI sessions one at a time. Every archive
requires a separate click, modal confirmation, provider operation, metadata
cleanup, and refresh. Cleaning up several sessions for the current project is
therefore unnecessarily slow.

The first release of batch operations will solve this specific problem without
introducing permanent deletion or unrelated bulk actions.

## Scope

Batch archive operates on exactly one open project and its currently selected
AI provider. It supports Codex, Kimi, and Claude through their existing provider
implementations.

Included:

- entering a temporary management mode for the active provider;
- selecting individual sessions;
- selecting all non-pinned sessions;
- clearing the selection;
- archiving the selection after one confirmation;
- skipping sessions that are currently running in a terminal;
- reporting successful, skipped, missing, and failed sessions.

Excluded:

- permanent deletion;
- cross-provider selection;
- cross-project or cross-window selection;
- bulk pin, unpin, rename, or copy actions;
- automatically closing terminals;
- rollback of sessions already archived when another item fails.

## Interaction Design

The AI provider controls on an expanded Open Project card gain an icon-only
`Manage` toggle. It uses a multi-select/checklist icon, matches the adjacent
`New Session` button's dimensions and interaction styling, and retains its
accessible name and tooltip. Selecting it puts only that project and the active
provider into batch management mode; selecting it again exits management mode
and clears the selection. Other projects and providers remain in their normal
state. The toggle displays an active state while management mode is enabled.

In management mode:

- each session row displays a checkbox;
- each checkbox remains keyboard-focusable and supports native keyboard
  selection;
- clicking a session row toggles selection instead of resuming the session;
- the normal per-row archive and pin actions are hidden or disabled;
- a batch action bar displays `All`, `Clear`, the selected count,
  and `Archive`;
- `Archive` is disabled when no session is selected;
- `All` selects every visible non-pinned session and does not select
  pinned sessions; its tooltip and accessible label retain that full meaning;
- pinned sessions remain individually selectable;
- `Clear` removes all selections without leaving management mode.

Switching providers, collapsing the project, or otherwise leaving the current
project scope exits management mode and clears the selection. During an
incremental session refresh, selected IDs that still exist in the same scope
remain selected, while IDs that disappeared are removed.

The selection and management mode are Webview-only transient state. They are
not persisted to VS Code global state or settings.

## Architecture

The Webview owns presentation and temporary selection state. The extension host
owns validation, confirmation, terminal safety checks, provider mutations,
metadata cleanup, logging, and refresh.

The Webview state is identified by:

```text
projectId + providerId + selectedSessionIds
```

When the user selects `Archive`, the Webview sends one message:

```text
archive-ai-sessions
{
  projectId,
  provider,
  sessionIds
}
```

The extension host answers every submitted request with one
`ai-session-batch-archive-completed` message whose status is `cancelled`,
`rejected`, or `finished`. This response releases the Webview's pending state
even when the user cancels the modal or validation leaves no eligible IDs.
Cancelled and rejected requests keep management mode available for correction;
finished requests exit management mode.

The extension host must treat this message as untrusted input. Before showing
the confirmation, it validates the provider, resolves the current open project,
deduplicates non-empty IDs, and intersects them with the latest sessions
assigned to that project and provider. Malformed and out-of-scope IDs are
recorded as rejected and are not archived. If no eligible IDs remain, the host
reports the rejection without showing a confirmation or mutating provider data.

Single-session and batch archive share an internal per-session archive helper.
The helper performs one archive attempt without showing UI or triggering a
refresh. This keeps the existing single-session behavior aligned with the new
batch behavior while allowing the batch coordinator to confirm, aggregate, and
refresh only once.

Provider services retain the existing singular interface:

```ts
archiveSession(sessionId: string): boolean
```

A new provider-level batch interface is not required because terminal tracking,
pin state, aliases, user feedback, and cross-item coordination belong to the
extension host rather than the provider storage services.

## Archive Flow

After validation, the extension host calculates the number of eligible sessions
and how many of them are pinned, then shows one modal confirmation. The message
includes the provider, eligible count, and pinned count when non-zero, for
example:

```text
Archive 10 selected Codex sessions? 2 selected sessions are pinned.
```

If the user cancels, no mutation occurs.

After confirmation, the host processes each validated selection:

1. Re-resolve the session in the latest current-project/provider scope.
2. If it no longer exists, record it as missing and continue.
3. If its tracked terminal is still running, record it as skipped and continue.
4. Call the provider's existing `archiveSession(sessionId)` method.
5. On failure, record the failure and preserve the session's local metadata.
6. On success, delete any completed terminal marker, untrack the terminal,
   remove the pinned-session entry, and delete the user-defined alias.

After all items have been processed, the host sends the finished response and
requests one incremental refresh. The Webview disables the batch controls while
the request is in flight so the same selection cannot be submitted twice. A
finished response exits management mode; the refresh then renders the remaining
items. Items that failed or were skipped remain visible and can be selected
again. Provider `archiveSession()` implementations retain their current
internal cache invalidation behavior; the batch coordinator adds no per-item
host refresh or extra invalidation.

The operation is intentionally best-effort. Provider storage operations are not
transactional, so successfully archived sessions are not restored if a later
item fails.

## Result Reporting and Logging

When every selected session is archived, Project Steward shows a concise
success notification.

When any session is skipped, missing, rejected as out of scope, or fails,
Project Steward shows a warning summary containing category counts, for example:

```text
Archived 8 sessions; skipped 1 running session; 1 session failed.
```

Detailed provider, sanitized session ID, and reason entries are written to the
existing Project Steward output channel. A running terminal is not focused
during a batch operation because doing so repeatedly would interrupt the batch workflow.
The existing single-session archive action keeps its current behavior, including
focusing a running terminal when archive is blocked.

Only a successful provider archive removes pin state, aliases, terminal marker
files, or terminal tracking. Missing, skipped, rejected, and failed items retain
their local metadata.

## Webview Refresh Semantics

The existing `ai-sessions-updated` message remains the source of current session
rows. While management mode is active, the Webview reconciles its selected ID
set with the refreshed rows for the same project and provider. This preserves
valid selections across watcher updates without allowing a selection to leak
into another provider or project.

The Webview exits management mode when:

- the user selects the active `Manage` toggle;
- the active provider changes;
- the project is collapsed or its scope disappears;
- a submitted batch request receives a `finished` completion response.

Cancelled or rejected requests clear the pending state but do not force an exit
from management mode.

## Testing

Regression coverage must verify:

- management mode is scoped to one project and one provider;
- entering and exiting management mode changes row clicks between selection and
  resume behavior;
- `All` excludes pinned sessions while allowing them to be selected
  individually;
- `Clear`, the `Manage` toggle, provider switching, and project collapse clear selection as
  specified;
- incremental refresh preserves existing selected IDs and removes missing IDs;
- `Archive` is disabled with an empty selection, and both the action bar and
  Manage toggle are disabled while a request is pending;
- cancelled, rejected, and finished completion messages always release the
  pending state, while only finished requests exit management mode;
- the Webview sends one deduplicated batch message for the current project and
  provider;
- the host rejects malformed, cross-project, and cross-provider IDs;
- one confirmation reports the total and selected pinned count;
- mixed results correctly distinguish archived, running, missing, rejected, and
  failed sessions;
- only successful archives clear pins, aliases, terminal markers, and tracking;
- a batch adds no per-item host invalidation or refresh and performs one final
  incremental refresh;
- original single-session archive behavior remains unchanged;
- Codex, Kimi, and Claude use their existing archive implementations.

Repository verification includes:

```bash
npm run test:safety
npm run lint
npx gulp buildStyles copyWebviewAssets
npm run webpack
git diff --check
```

## Acceptance Criteria

- A user can enter management mode from an expanded project's active provider,
  select several sessions, confirm once, and archive them in one operation.
- Selection cannot cross project or provider boundaries.
- Pinned sessions are excluded from bulk selection by default but can be chosen
  explicitly and are called out in confirmation.
- Running sessions do not block other selected sessions from being archived.
- Partial failures do not discard successful work and produce a clear summary.
- No permanent session deletion is introduced.
- Single-session archive behavior and all three providers continue to work.
