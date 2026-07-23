# Project Catalog Sync Conflict Recovery Design

## Context

Project Steward currently stores the entire saved-project catalog in the single
user setting `projectSteward.projectData`. Every project mutation rewrites the
complete group array. VS Code Settings Sync can transport that setting between
machines, but it does not understand project IDs, additions, edits, moves, or
deletions inside the array.

The `build-your-own-x` incident proves the resulting data-loss path:

1. the remote Dev Container extension host logged a successful project mutation;
2. the saved record was present when the same project was saved again;
3. the original window logged no later Project Steward removal mutation;
4. a later exported catalog contained the older 34-project snapshot instead of
   the 35-project snapshot containing `build-your-own-x`.

The exact client that supplied the older value is not identifiable because the
current format has no writer, revision, or reconciliation diagnostics. The
evidence nevertheless rules out a failed save and is consistent with a stale
full-setting replacement from another synced client.

## Goal

Keep Settings Sync support while preventing an older catalog snapshot from
silently removing a project saved on another client.

The fix must distinguish absence from deletion:

- a record merely missing from an unversioned or unobserving snapshot is not a
  deletion;
- only an explicit removal whose causal context has observed the record is a
  deletion;
- a concurrent deletion conflict keeps the live project and reports recovery;
- a stale snapshot cannot undo either a new project or a valid observed
  deletion.

## Non-Goals

- Building a general conflict-management UI.
- Providing real-time collaboration between simultaneously open windows.
- Changing the existing behavior when
  `projectSteward.storeProjectsInSettings` is `false`.
- Recovering data after every device and every synced or local copy of that data
  has been permanently destroyed.
- Treating deletion performed by an old extension version as authoritative when
  that version cannot advance the versioned causal context.

## Options Considered

### Re-read and union before save

This is the smallest change, but it only narrows the race between a read and a
local write. It cannot repair a Settings Sync rollback that arrives after a
successful save. A plain union would also resurrect intentionally deleted
projects.

### Local backup only

A local backup could restore the incident project, but it could not distinguish
an intentional remote deletion from a stale omission. It would turn every
multi-machine deletion into an ambiguous restore.

### Versioned synchronized catalog with a local shadow

This is the selected design. A versioned observed-remove map gives additions,
updates, and deletions causal metadata without retaining an operation log or
per-deletion tombstone table. A nonsynced local shadow retains the latest state
known by each extension host and can repair a later whole-setting rollback.

## Storage Architecture

### Synchronized document

Add the user setting `projectSteward.projectSyncData`. It stores a versioned
document whose logical shape is:

```text
ProjectSyncDocumentV1
  schemaVersion
  versionVector -> compact causal context, one counter per observed actor
  groups[groupId] -> versioned group fields
  projects[projectId] -> versioned project fields + groupId
  layout -> versioned group and project ordering
```

Every extension host has a stable local actor ID and an increasing actor
counter. A local mutation increments the counter and stamps only the affected
records and layout. An explicit removal deletes the live record after advancing
the document's causal context past the removed record. Version vectors determine
whether a side observed a record before omitting it or whether the omission is
concurrent and therefore unsafe to treat as deletion. Actor IDs provide a
deterministic tie-break for concurrent field or layout edits.

`projectSyncData` becomes the canonical source when settings storage is enabled.
The existing `projectData` array remains a compatibility projection so current
commands, user exports, and older extension versions continue to see the
catalog's materialized group-array shape.

### Local recovery shadow

Store the last merged `ProjectSyncDocumentV1` in extension `globalState` under a
new versioned shadow key. The shadow is deliberately not synced. It protects a
known operation when Settings Sync later replaces the synchronized document
with an older whole value.

The shadow is not a second user-facing catalog. It is an extension-owned replica
used only for reconciliation and retry.

### Reconciliation boundary

Add a focused catalog synchronization component rather than expanding
`ProjectService` with merge internals. It owns:

- migration from legacy `projectData`;
- version stamping and observed-remove causal-context updates;
- deterministic document merge and materialization;
- shadow persistence;
- serialized writes and retry state;
- conflict and repair diagnostics.

`ProjectService` continues to expose the existing group/project API. When
settings storage is enabled, it delegates reads and mutations to the
synchronization component. Global-state-only storage keeps its current path.

## Merge Semantics

1. Merge the incoming synchronized document with the local shadow by stable
   group and project ID, and take the per-actor maximum for the merged version
   vector.
2. If a live record exists on only one side, remove it only when the other
   side's causal context dominates that record's version. Dominance proves the
   other side observed and explicitly removed that value.
3. If the other side did not observe the record, preserve it. A stale or
   concurrent omission is not a deletion.
4. If a removal and a live update are concurrent, keep the live record and emit
   a conflict diagnostic. This implements the approved no-silent-loss policy.
5. If two live values are concurrent, choose deterministically by version and
   actor ID. The project ID remains present, so the conflict cannot erase the
   saved project.
6. Merge layout independently from record existence. A stale order may lose a
   deterministic ordering tie-break, but it cannot drop a record.
7. Group deletion explicitly removes the group and projects intentionally
   removed with it after advancing the causal context. Moving projects or
   deleting an empty group does not remove unrelated projects.
8. Re-adding a removed project through the product creates a new project ID.
   A stale same-ID record whose version is dominated by the causal context
   remains removed.

The normalized merged document must have a stable serialization. Reconciliation
rewrites `projectSyncData` only when the incoming synchronized value is missing
known state, preventing configuration-change write loops.

## Storage Growth and Sync Cost

The synchronized format is a state document, not an append-only operation log:

- edits replace the latest versioned value instead of appending history;
- observed deletions are compressed into the version vector and do not leave a
  permanent per-project or per-group tombstone;
- repeated mutations by the same extension host update one actor counter;
- the version vector grows with the number of distinct extension hosts that
  have participated, not with the number of saves, edits, or deletions.

While compatibility is required, Settings Sync carries both the live
`projectData` projection and the versioned `projectSyncData` document. The
steady-state synchronized payload is therefore approximately two live catalogs
plus small record-version and actor-vector metadata. The local shadow is not
synced. Removing the legacy projection can be considered only in a future
schema-breaking release after old clients no longer need it.

The focused tests must include repeated add/delete cycles from a fixed actor set
and prove that no operation history or tombstone collection grows. Payload size
may grow with legitimate live catalog fields and newly participating actors; it
must not grow merely because existing actors continue to mutate the same
catalog.

## Data Flow

### Local mutation

```text
current sync value + local shadow
  -> reconcile
  -> apply one explicit add/update/move/delete mutation
  -> increment local actor version
  -> persist local shadow
  -> persist projectSyncData
  -> persist compatible projectData projection
  -> refresh the dashboard
```

Persisting the shadow first means a failed synchronized-setting write leaves a
retryable local operation instead of silently discarding it.

### Incoming Settings Sync change

```text
incoming projectSyncData/projectData change
  -> serialize behind any local mutation
  -> merge incoming document with local shadow
  -> preserve unseen additions and causally valid removals
  -> rewrite stale synchronized state when repair is required
  -> refresh only after the merged catalog is available
```

Configuration changes for the canonical and compatibility settings may arrive
separately. Reconciliation therefore reads both current values inside one
serialized task rather than assuming event order.

### Convergence guarantee

A client that has never observed an operation cannot reconstruct it while every
replica carrying that operation is offline. The guarantee is therefore
eventual: as long as the synchronized document or at least one local shadow
still contains the operation, bringing a carrying replica back online causes
the merged document to be republished and all new-version clients converge.
Temporary stale display before that reconciliation is possible; silent
permanent loss while a valid replica survives is not.

### Legacy migration

On first activation without `projectSyncData`, convert the current
`projectData` array into a baseline versioned document while preserving all
existing group and project IDs, fields, and order. Persist the shadow before the
new synchronized document and projection.

After migration, additions and updates supplied through the legacy array can be
imported conservatively. A legacy snapshot's missing record cannot be imported
as a deletion because it has no causal context proving observation. This makes
mixed-version operation addition-safe while requiring the new extension version
for reliable cross-machine deletion.

## Failure and Conflict Handling

- Serialize local mutations and reconciliation so two extension events cannot
  interleave partial writes.
- If the synchronized document is absent or malformed, retain the valid shadow
  and legacy projection, log the invalid source, and repair the synchronized
  value. Never replace valid local data with an empty catalog.
- If no valid shadow or synchronized document exists, migrate the valid legacy
  array. Invalid legacy data continues to use the existing validation behavior.
- If shadow persistence fails, abort the synchronized write and surface the
  existing mutation error; an operation is not reported as saved before its
  recovery copy exists.
- If the synchronized or compatibility write fails after the shadow succeeds,
  retain retry state and reconcile on the next activation, relevant
  configuration change, or local mutation.
- Log actor ID, causal versions, repair reason, and affected record IDs without
  logging project descriptions or the complete catalog.
- When concurrent deletion recovery keeps a live project, show one bounded
  informational notification for that reconciliation rather than one message
  per record.

## CI-First Regression Contract

Register behavior `PROJECT-CATALOG-SYNC-CONFLICT-001` and make its owner tests
reachable from the existing Linux PR CI command.

The first test must exercise the current public service behavior before any
production change:

1. create two clients from the same catalog;
2. let client B save a new project;
3. let client A submit its older full snapshot;
4. assert that the new project remains.

On the current implementation, step 3 replaces the array and the assertion must
fail for the diagnosed reason. A compile failure or a fixture failure is not an
acceptable RED.

The complete focused contract must then prove:

1. stale client overwrite cannot remove a project added by another client;
2. a deletion made after observing the project advances causal context and is
   restored as the winning state when a deletion-carrying client reconciles
   after an older snapshot returns;
3. concurrent deletion and live update preserve the project and report one
   recovery conflict;
4. migration preserves legacy IDs, fields, groups, and ordering;
5. stale `projectData` projection cannot override a newer canonical document;
6. malformed synchronized data cannot replace a valid shadow or legacy catalog;
7. shadow failure aborts the user-visible save, while later synchronized-write
   failure remains retryable;
8. repeated reconciliation is idempotent and does not create a configuration
   change loop;
9. repeated add/delete cycles by fixed actors do not accumulate operation
   history or tombstones;
10. global-state-only storage retains its existing behavior.

Owner tests should exercise the merge component deterministically, while a
service/composition contract proves `ProjectService` and configuration-change
handling use it. The behavior catalog and full Linux CI-equivalent gate must run
after the focused tests pass.

## Delivery Constraints

- Work only in the existing clean worktree on
  `fix/logical-attention-card-count`.
- Preserve the user-dirty primary checkout.
- Follow strict RED, minimal GREEN, and refactor-after-GREEN sequencing.
- Keep the sync fix isolated from session attention, aliases, Skill management,
  and unrelated refactoring.
- Do not push, open or merge a pull request, publish a VSIX, or release a
  version during this fix.

## Acceptance Criteria

1. The diagnosed two-client stale-snapshot sequence is covered by CI and passes.
2. A saved project omitted by a later snapshot is restored when any replica
   carrying its versioned record reconciles.
3. Only explicit removals whose causal context observed a record delete it.
4. Concurrent deletion conflicts preserve the live project and are observable.
5. Existing catalogs migrate without changing IDs or visible ordering.
6. Settings Sync remains available and `projectData` remains compatible.
7. Local recovery data makes failed or stale synchronized writes retryable.
8. Existing global-state-only users are unaffected.
9. Sync metadata grows with live records and participating actors, not mutation
   or deletion history.
