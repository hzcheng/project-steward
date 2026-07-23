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
- Command, Webview, and activation entry points share one adapter transaction
  Promise. Single-folder, saved multi-root, untitled, and pending-completion
  races cannot execute two project writes or two Save Workspace As commands.
- Activation consumes pending state only after the existing ProjectService
  storage migration reports project success. Project migration failure leaves
  the intent untouched for a later activation retry while the remaining
  dashboard startup still runs. Extension activation awaits this single ordered
  startup transaction instead of launching it fire-and-forget.
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

Review RED first failed with:

```text
AssertionError: singleFolder concurrent callers must share the same transaction Promise
```

Equivalent saved-multi-root and untitled fixtures now prove one shared Promise,
one mutation, and one Save Workspace As invocation. A cross-entry RED then
showed a command save could win the mutex without consuming the activation
intent:

```text
AssertionError: a command racing activation must consume the matching intent within the shared write
```

The unlocked save path now consumes a matching pending intent itself, while
untitled post-command completion calls a private unlocked method and cannot
deadlock on its own public transaction.

Startup RED required the order `project migration -> refresh/publication ->
pending completion -> remaining startup`, and required project migration errors
to skip pending completion. Integration fixtures use the real ProjectService
migration/add implementation in both global-state-to-settings and
settings-to-global-state directions. Each preserves the old member record and
appends one workspace project. A real ProjectService write failure retains the
intent, performs no project mutation, reports through the existing migration
path, and allows unrelated startup behavior to continue.

Failure fixtures also cover pending-clear rejection with explicit retry,
Save Workspace As rejection with successful clear, details-resolution failure
after consumption, mutation failure, and null explicit workspace details. The
last case warns and returns without invoking the legacy current-project
fallback getter.

## Consumption and Idempotency

Activation completion reads the validated intent, awaits durable removal, and
only then checks time, saved-workspace kind, and exact root-set scope identity.
Project detail resolution and mutation happen after removal. Consequently, a
mutation failure leaves no pending retry that could create a duplicate.

Within one Extension Host, every save and completion entry point shares one
in-flight Promise. Public entry points delegate to private unlocked operations;
the untitled path can therefore complete its own post-command intent without
self-deadlock. The safety tests cover same-entry and command/activation
cross-entry concurrency and observe one added workspace project. Across
restart, the four-field global-state record is the only handoff; no card ID or
in-memory group state participates.

Pending completion awaits durable removal before project detail resolution or
mutation. A clear failure stops the transaction, propagates the error, performs
no mutation, and leaves the intent available for retry. Once clear succeeds,
details or mutation failures propagate without recreating a retryable intent.

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
