# Task 13 Report: Save one live workspace as one project

Date: 2026-07-21

Status: complete

## Delivered

- Added a strict global-state pending-intent store which accepts and persists
  only `{ version: 1, scopeIdentity, createdAtMs, expiresAtMs }`. Scope and
  timestamp fields are bounded, the lifetime is capped at ten minutes, and the
  expiry boundary is exclusive.
- Added `SavedWorkspaceProjectAdapter.saveCurrentWorkspace()` and
  activation-time `completePendingWorkspaceSave()`.
- Single-folder snapshots resolve the folder navigation URI through the
  existing remote-project resolver. Saved multi-root snapshots resolve their
  `.code-workspace` navigation URI. Both delegate to the unchanged project
  prompt/mutation/storage path and add exactly one `Project`.
- Untitled multi-root saves persist the intent before invoking
  `workbench.action.saveWorkspaceAs`. A matching saved snapshot completes in
  the same host or after Extension Host restart; all other terminal outcomes
  clear the intent without a project mutation.
- Command and Webview save messages route to the workspace adapter without
  retaining or resolving a transient card ID. The adapter reads a fresh
  `WorkspaceContextResolver` snapshot after Save Workspace As, rather than the
  potentially stale dashboard controller cache.
- Existing `Project`, group, favorite, color, description, ordinary add/open,
  serialization, and ProjectService APIs remain unchanged. Previously saved
  member projects are neither merged, rewritten, nor deleted.

## TDD Evidence

Initial RED command:

```text
npm run test-compile && node scripts/run-open-project-safety-checks.js && node scripts/run-dashboard-webview-checks.js
```

`test-compile` passed, then the safety gate failed as expected with:

```text
Error: Cannot find module '../out/workspaces/pendingWorkspaceSaveStore'
```

The initial failing tests covered single-folder and saved-multi-root paths,
pending-before-command ordering and exact fields, cancellation/non-transition,
matching restart completion, repeated completion, expiry, malformed/extra/future
intent data, changed scope, unrelated/null activation, mutation failure, and
byte-equivalent preservation of existing member entries. The final suite also
exercises concurrent completion against the same intent.

A second focused RED guarded same-host Save Workspace As completion. It failed
because production initially supplied the cached current-workspace getter:

```text
AssertionError: Save Workspace As must read a fresh resolved snapshot instead of a cached transient card/controller state
```

The wiring now supplies `resolveCurrentOpenWorkspace` directly. A third routing
RED proved that legacy `save-project` messages did not yet enter the reserved
snapshot-based handler; the router now maps both `save-current-workspace` and
`save-project` to the same dedicated workspace callback and never falls through
to a generic transient-ID handler.

## Consumption and Idempotency

Activation completion reads the validated intent, awaits durable removal, and
only then checks time, saved-workspace kind, and exact root-set scope identity.
Project detail resolution and mutation happen after removal. Consequently, a
mutation failure leaves no pending retry that could create a duplicate.

Within one Extension Host, simultaneous completion calls share one in-flight
Promise. The safety test invokes two completions concurrently and a third
sequentially, and observes one added workspace project. Across restart, the
four-field global-state record is the only handoff; no card ID or in-memory
group state participates.

## Verification

Fresh final gate:

```text
npm run test-compile
node scripts/run-open-project-safety-checks.js
node scripts/run-dashboard-webview-checks.js
npm run test:dashboard
npm run lint
git diff --check
```

Every command exited zero. Lint reported only the repository's pre-existing
warnings and no warning in either new workspace-save module.

## Residual Risk

The automated suite models the VS Code command returning without transition
and the post-restart saved snapshot, but this environment cannot drive the
interactive Save Workspace As picker and Extension Host restart end to end.
That UI-host scenario remains part of the release manual acceptance matrix.
