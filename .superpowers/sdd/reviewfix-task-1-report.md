# Review Fix Task 1 Report

## Scope

Implemented Task 1 from `docs/superpowers/plans/2026-07-17-global-todo-review-fixes.md`.
No Task 2-4 ordering, compose-form, destructive-action, search, or keyboard behavior was changed.

## RED

Added Dashboard contract coverage before production changes for:

- primary, legacy, and primary-default `storeProjectsInSettings` resolution;
- migration from globalState to settings and settings to globalState when the selected target is empty;
- no overwrite when both stores contain TODO data;
- rejection of explicit future versions before either storage update method is called;
- local `showCompleted` persistence under `todoViewState` without sync registration;
- user-visible write errors without posting replacement panel HTML;
- serialized concurrent service mutations.

Command:

```text
npm run test:dashboard
```

Observed RED: TypeScript compilation succeeded, then `runTodoStoreChecks` failed with
`AssertionError [ERR_ASSERTION]: Missing expected exception` at the new future-version
contract. Exit code: 1.

## Implementation

- Added `UnsupportedTodoDataVersionError`; normalization accepts version 1 and
  unversioned v1-shaped data, and rejects every other explicit version.
- Reused the shared steward configuration resolver so context-backed TODO storage
  follows primary, legacy, then primary-default precedence.
- Added non-destructive, bidirectional `TodoService.migrateDataIfNeeded()`.
- Persisted `showCompleted` in extension globalState under the existing view-state key.
- Serialized all TODO service writes through one recoverable promise queue.
- Added a TODO host mutation boundary. Storage rejection is logged and shown to the
  user, and panel replacement runs only after a successful mutation.
- Called TODO migration from the existing startup/configuration migration callback.
- Added no task-count or byte limit; backend rejection remains the capacity boundary.

## Review

Self-review found no Critical or Important findings. The final cleanup removed one
unused import left after adopting the shared configuration resolver.

## Verification

Final command results are recorded after the last source and report edits:

- `npm run test:dashboard`
- `npm run test:safety`
- `git diff --check`
