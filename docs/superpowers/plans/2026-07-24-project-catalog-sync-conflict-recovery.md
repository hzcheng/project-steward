# Project Catalog Sync Conflict Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale multi-machine Settings Sync snapshots from silently removing saved projects while preserving explicit observed deletions and bounded sync metadata.

**Architecture:** Add a pure versioned observed-remove catalog model, then place a serialized persistence coordinator between `ProjectService` and settings storage. Keep `projectData` as the legacy live-array projection, store the canonical versioned document in `projectSyncData`, and retain one nonsynced local shadow for rollback repair.

**Tech Stack:** TypeScript targeting ES6, VS Code extension settings and `globalState`, Node.js 22 `node:test`, Project Steward behavior-contract catalog.

## Global Constraints

- Work only in `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/fix-logical-attention-card-count`.
- Keep the user-dirty primary checkout untouched.
- Do not use subagents; execute and review inline.
- Add a CI-reachable failing regression before production changes.
- Do not treat unversioned absence as deletion.
- Do not store an append-only operation log or permanent per-record tombstone collection.
- Keep `projectSteward.storeProjectsInSettings=false` behavior unchanged.
- Preserve every legacy group/project ID, field, and visible order during migration.
- Persist the local shadow before synchronized settings.
- Do not push, open or merge a pull request, package a VSIX, or publish a release.

---

### Task 1: Register and Reproduce the Stale-Snapshot Regression

**Files:**

- Create: `tests/contract/persistence/projectCatalogSync.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**

- Consumes: existing `ProjectService.getGroups()`, `addProject()`, and `saveGroups()`.
- Produces: behavior ID `PROJECT-CATALOG-SYNC-CONFLICT-001` and a behavioral RED against the current implementation.

- [ ] **Step 1: Register the behavior contract**

Add this catalog entry:

```json
{
  "id": "PROJECT-CATALOG-SYNC-CONFLICT-001",
  "domain": "persistence",
  "title": "Project Catalog Sync Conflict Recovery behavior",
  "priority": "P0",
  "status": "automated",
  "owners": [
    "tests/contract/persistence/projectCatalogSync.test.js"
  ],
  "evidence": [
    "src/services/projectService.ts"
  ]
}
```

- [ ] **Step 2: Add a two-client fixture using the current public service**

Create a fake VS Code configuration shared by two `ProjectService` instances,
with separate `globalState` mementos. Use this stable fixture:

```js
const initialGroups = [{
    id: 'group-main',
    groupName: 'Main',
    collapsed: false,
    projects: [{
        id: 'project-existing',
        name: 'Existing',
        path: '/work/existing',
        color: '#112233',
    }],
}];

const staleA = structuredClone(clientA.getGroups(true));
const added = new Project('build-your-own-x', '/work/build-your-own-x');
added.id = 'project-build-your-own-x';
added.color = '#445566';
await clientB.addProject(added, 'group-main');
await clientA.saveGroups(staleA);

assert.deepEqual(
    clientB.getProjectsFlat().map(project => project.id).sort(),
    ['project-build-your-own-x', 'project-existing']
);
```

Name the test:

```text
PROJECT-CATALOG-SYNC-CONFLICT-001 preserves a project when a stale client submits an older full snapshot
```

- [ ] **Step 3: Compile and observe the behavioral RED**

Run:

```bash
npm run test-compile
node --test --test-name-pattern='PROJECT-CATALOG-SYNC-CONFLICT-001 preserves' \
  tests/contract/persistence/projectCatalogSync.test.js
```

Expected: the assertion fails because only `project-existing` remains. Compilation
and fixture setup must succeed.

- [ ] **Step 4: Validate CI ownership**

Run:

```bash
npm run test:behavior-contracts
```

Expected: exit `0`; the owner contains the behavior ID and the evidence path exists.

- [ ] **Step 5: Commit the RED contract**

```bash
git add docs/testing/behavior-contracts.json \
  tests/contract/persistence/projectCatalogSync.test.js
git commit -m "test: cover stale project catalog overwrite"
```

---

### Task 2: Implement the Bounded Observed-Remove Catalog Model

**Files:**

- Create: `src/projects/projectCatalogSync.ts`
- Modify: `tests/contract/persistence/projectCatalogSync.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**

- Produces:

```ts
export interface ProjectCatalogVersion {
    actorId: string;
    vector: Record<string, number>;
}

export interface ProjectCatalogSyncDocumentV1 {
    schemaVersion: 1;
    versionVector: Record<string, number>;
    groups: Record<string, VersionedProjectCatalogGroup>;
    projects: Record<string, VersionedProjectCatalogProject>;
    layout: VersionedProjectCatalogLayout;
}

export interface ProjectCatalogMutationOptions {
    deletedGroupIds?: string[];
    deletedProjectIds?: string[];
}

export interface ProjectCatalogMergeResult {
    document: ProjectCatalogSyncDocumentV1;
    conflictProjectIds: string[];
    repaired: boolean;
}

export function migrateLegacyProjectCatalog(
    groups: Group[],
    actorId: string
): ProjectCatalogSyncDocumentV1;

export function applyProjectCatalogSnapshot(
    document: ProjectCatalogSyncDocumentV1,
    groups: Group[],
    actorId: string,
    options?: ProjectCatalogMutationOptions
): ProjectCatalogSyncDocumentV1;

export function mergeProjectCatalogDocuments(
    local: ProjectCatalogSyncDocumentV1,
    incoming: ProjectCatalogSyncDocumentV1
): ProjectCatalogMergeResult;

export function materializeProjectCatalog(
    document: ProjectCatalogSyncDocumentV1
): Group[];

export function parseProjectCatalogSyncDocument(
    value: unknown
): ProjectCatalogSyncDocumentV1 | null;
```

- [ ] **Step 1: Add focused model tests**

Add tests whose names contain `PROJECT-CATALOG-SYNC-CONFLICT-001 model` and prove:

```js
const base = migrateLegacyProjectCatalog(initialGroups, 'actor-a');
const withAdded = applyProjectCatalogSnapshot(
    base,
    groupsWithBuildYourOwnX,
    'actor-b'
);
const merged = mergeProjectCatalogDocuments(base, withAdded);
assert.deepEqual(
    materializeProjectCatalog(merged.document)
        .flatMap(group => group.projects.map(project => project.id))
        .sort(),
    ['project-build-your-own-x', 'project-existing']
);
```

Also cover:

- stale omission preserves the unseen added record;
- observed deletion wins after an older snapshot returns;
- concurrent deletion and live update preserve the live value and report its ID;
- repeated merge is byte-stable;
- 1,000 add/delete cycles by two fixed actors leave no `operations`,
  `tombstones`, `projectTombstones`, or `groupTombstones` property and keep only
  the two actor counters.

- [ ] **Step 2: Observe model RED**

Run:

```bash
npm run test-compile
node --test --test-name-pattern='PROJECT-CATALOG-SYNC-CONFLICT-001 model' \
  tests/contract/persistence/projectCatalogSync.test.js
```

Expected: FAIL because the model module and exports do not exist. The original
behavioral RED remains independently reproducible.

- [ ] **Step 3: Implement vector and record comparison**

Implement these rules in `projectCatalogSync.ts`:

```ts
function dominates(left: Record<string, number>, right: Record<string, number>): boolean {
    return Object.keys(right).every(actorId => (left[actorId] || 0) >= right[actorId]);
}

function mergeVectors(
    left: Record<string, number>,
    right: Record<string, number>
): Record<string, number> {
    const result = { ...left };
    for (const actorId of Object.keys(right)) {
        result[actorId] = Math.max(result[actorId] || 0, right[actorId] || 0);
    }
    return result;
}
```

Every live group, project, and layout value stores its full version vector plus
the last writer actor ID. A mutation merges the current document vector,
increments only the current actor counter, and applies one resulting stamp to
the changed records.

- [ ] **Step 4: Implement observed-remove merge**

For a record present on one side only:

```ts
if (dominates(missingSide.versionVector, liveRecord.version.vector)) {
    // The missing side observed this value and explicitly removed it.
    return undefined;
}
return liveRecord;
```

For two live values, choose the causally later value. If versions are concurrent,
choose by `actorId.localeCompare()` for deterministic serialization. Preserve a
one-sided live record and report a conflict when the missing side observed an
earlier version but does not dominate the live update.

Sort record keys, group order, project order, and vector keys before returning
or serializing normalized documents.

- [ ] **Step 5: Run model GREEN**

Run:

```bash
npm run test-compile
node --test --test-name-pattern='PROJECT-CATALOG-SYNC-CONFLICT-001 model' \
  tests/contract/persistence/projectCatalogSync.test.js
```

Expected: all model cases pass, including bounded-growth assertions.

- [ ] **Step 6: Point behavior evidence at the model and commit**

Add `src/projects/projectCatalogSync.ts` to the behavior entry evidence, then:

```bash
git add src/projects/projectCatalogSync.ts \
  tests/contract/persistence/projectCatalogSync.test.js \
  docs/testing/behavior-contracts.json
git commit -m "feat: add bounded project catalog merge model"
```

---

### Task 3: Add Serialized Sync Persistence and Local Recovery

**Files:**

- Create: `src/services/projectCatalogSyncService.ts`
- Modify: `src/constants.ts`
- Modify: `package.json`
- Modify: `tests/contract/persistence/projectCatalogSync.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**

- Consumes: all exports from `src/projects/projectCatalogSync.ts`.
- Produces:

```ts
export interface ProjectCatalogLocalStateV1 {
    schemaVersion: 1;
    actorId: string;
    document: ProjectCatalogSyncDocumentV1;
}

export interface ProjectCatalogSyncServiceOptions {
    getSyncData: () => unknown;
    updateSyncData: (value: ProjectCatalogSyncDocumentV1) => Thenable<void>;
    getLegacyGroups: () => Group[] | null;
    updateLegacyGroups: (groups: Group[]) => Thenable<void>;
    getLocalState: () => ProjectCatalogLocalStateV1 | null;
    updateLocalState: (value: ProjectCatalogLocalStateV1) => Thenable<void>;
    createActorId: () => string;
    onDiagnostic?: (event: Record<string, unknown>) => void;
    onConflict?: (projectIds: string[]) => void;
}

export class ProjectCatalogSyncService {
    getGroups(): Group[];
    reconcile(): Promise<ProjectCatalogMergeResult>;
    saveGroups(
        groups: Group[],
        options?: ProjectCatalogMutationOptions
    ): Promise<Group[]>;
}
```

- [ ] **Step 1: Add persistence-order tests**

Create coordinator fixtures that record writes. Prove:

```js
assert.deepEqual(writeOrder, [
    'globalState:projectCatalogSyncLocal.v1',
    'settings:projectSyncData',
    'settings:projectData',
]);
```

Prove `getGroups()` merges synchronized state and local shadow synchronously,
`reconcile()` republishes a stale canonical document once, and a second
`reconcile()` performs no writes.

- [ ] **Step 2: Observe coordinator RED**

Run:

```bash
npm run test-compile
node --test --test-name-pattern='PROJECT-CATALOG-SYNC-CONFLICT-001 persistence' \
  tests/contract/persistence/projectCatalogSync.test.js
```

Expected: FAIL because `ProjectCatalogSyncService` does not exist.

- [ ] **Step 3: Add storage keys and setting schema**

Add:

```ts
export const PROJECT_SYNC_DATA_KEY = 'projectSyncData';
export const PROJECT_SYNC_LOCAL_STATE_KEY = 'projectCatalogSyncLocal.v1';
```

Add `projectSteward.projectSyncData` to `package.json`:

```json
{
  "type": ["object", "null"],
  "default": null,
  "markdownDescription": "Versioned Project Steward sync metadata. Use Project Steward commands to edit projects."
}
```

- [ ] **Step 4: Implement serialized persistence**

Use one promise tail:

```ts
private pending: Promise<unknown> = Promise.resolve();

private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
}
```

`saveGroups()` must reconcile current sync data with the local shadow, apply the
snapshot with explicit deletion IDs, persist local state first, then canonical
sync data, then the compatibility projection. `reconcile()` follows the same
queue and emits one diagnostic/notification batch per merge.

- [ ] **Step 5: Run coordinator GREEN and commit**

```bash
npm run test-compile
node --test --test-name-pattern='PROJECT-CATALOG-SYNC-CONFLICT-001 persistence' \
  tests/contract/persistence/projectCatalogSync.test.js
```

Expected: all persistence-order and idempotence cases pass.

```bash
git add src/services/projectCatalogSyncService.ts src/constants.ts package.json \
  tests/contract/persistence/projectCatalogSync.test.js \
  docs/testing/behavior-contracts.json
git commit -m "feat: persist recoverable project sync state"
```

---

### Task 4: Route ProjectService Mutations Through the Sync Coordinator

**Files:**

- Modify: `src/services/projectService.ts`
- Modify: `tests/contract/persistence/projectCatalogSync.test.js`
- Modify: `tests/contract/persistence/migrations.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**

- Produces:

```ts
reconcileProjectCatalog(): Promise<void>;

saveGroupsFromManualEdit(
    groups: Group[],
    baselineGroups: Group[]
): Thenable<void>;
```

- [ ] **Step 1: Extend service tests before integration**

Add cases proving:

- the Task 1 stale-snapshot test becomes green;
- `removeProject(id)` advances causal removal and stale state cannot resurrect it;
- `removeGroup(id)` removes that group and its contained project IDs only;
- generic `saveGroups(staleGroups)` never interprets missing remote additions as
  deletion;
- `storeProjectsInSettings=false` writes only `PROJECTS_KEY` and never writes
  sync settings or local sync shadow.

Run the full file and confirm the Task 1 test remains RED before production
integration:

```bash
npm run test-compile
node --test tests/contract/persistence/projectCatalogSync.test.js
```

- [ ] **Step 2: Construct the coordinator without breaking existing callers**

Keep the current two-argument constructor valid. Add optional callbacks:

```ts
export interface ProjectServiceSyncOptions {
    createActorId?: () => string;
    onDiagnostic?: (event: Record<string, unknown>) => void;
    onConflict?: (projectIds: string[]) => void;
}
```

Build `ProjectCatalogSyncService` with closures around
`configurationSection.get/update` and `context.globalState.get/update`.

- [ ] **Step 3: Route settings reads and writes**

When `useSettingsStorage()` is true:

```ts
getGroups(noSanitize = false): Group[] {
    const groups = this.catalogSyncService.getGroups();
    return noSanitize ? groups : this.sanitizeGroups(groups);
}
```

Delegate ordinary `saveGroups()` conservatively with no deletion IDs.
`removeProject()` and `removeGroup()` pass exact deleted IDs. Keep the existing
global-state-only branches unchanged.

- [ ] **Step 4: Reconcile migration**

Preserve the existing backend-copy rule, then initialize/reconcile
`projectSyncData` only after the destination legacy array exists. Return
`migrated=true` when either backend copy or initial sync-document creation
occurred. Never replace a populated destination with another backend.

- [ ] **Step 5: Run service GREEN**

```bash
npm run test-compile
node --test tests/contract/persistence/projectCatalogSync.test.js \
  tests/contract/persistence/migrations.test.js
```

Expected: all cases pass, including the original stale overwrite reproduction.

- [ ] **Step 6: Commit service integration**

```bash
git add src/services/projectService.ts \
  tests/contract/persistence/projectCatalogSync.test.js \
  tests/contract/persistence/migrations.test.js \
  docs/testing/behavior-contracts.json
git commit -m "fix: reconcile stale project catalog snapshots"
```

---

### Task 5: Preserve Explicit Manual Deletes and Reconcile Configuration Changes

**Files:**

- Modify: `src/projects/projectManualEditController.ts`
- Modify: `src/dashboard/lifecycleController.ts`
- Modify: `src/dashboard.ts`
- Modify: `tests/contract/projects/controllers.test.js`
- Modify: `tests/integration/dashboard/errorRecovery.test.js`
- Modify: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**

- Consumes: `ProjectService.saveGroupsFromManualEdit()` and
  `reconcileProjectCatalog()`.
- Produces:

```ts
saveGroups: (groups: Group[], baselineGroups: Group[]) => Thenable<unknown>;
reconcileProjectCatalog?: () => Promise<void>;
```

- [ ] **Step 1: Add manual-edit baseline and lifecycle tests**

In the manual editor contract, open an export containing projects `a` and `b`,
simulate a remote project `c` arriving after the export, save an edited file
that removes only `b`, and assert the callback receives:

```js
{
    groups: editedGroups,
    baselineGroups: exportedGroups,
}
```

In lifecycle tests, handle a `projectSteward.projectSyncData` change and assert:

```js
[
    'reconcile:start',
    'reconcile:end',
    'color',
    ['refresh', 'configuration-changed'],
    'publish',
]
```

- [ ] **Step 2: Observe wiring RED**

```bash
npm run test-compile
node --test --test-name-pattern='PROJECT-CATALOG-SYNC-CONFLICT-001' \
  tests/contract/projects/controllers.test.js \
  tests/integration/dashboard/errorRecovery.test.js
```

Expected: FAIL because the baseline and reconciliation callbacks are not wired.

- [ ] **Step 3: Pass the exported baseline through manual edit**

Keep the original `projects` snapshot captured before writing the temporary
file. On save call:

```ts
await this.options.saveGroups(updatedGroups, projects);
```

`ProjectService.saveGroupsFromManualEdit()` computes explicit deleted IDs only
from records present in `baselineGroups` and absent from `groups`; additions
that arrived after export are preserved.

- [ ] **Step 4: Reconcile before dashboard refresh**

Add optional `reconcileProjectCatalog` to
`DashboardLifecycleControllerOptions`. Await it when either
`projectSteward.projectSyncData` or `projectSteward.projectData` changes, before
color application, refresh, and publication.

Wire production activation:

```ts
reconcileProjectCatalog: () => projectService.reconcileProjectCatalog(),
```

Wire conflict notification once per reconciliation:

```text
Project Steward recovered projects from a sync conflict.
```

- [ ] **Step 5: Run wiring GREEN and commit**

```bash
npm run test-compile
node --test --test-name-pattern='PROJECT-CATALOG-SYNC-CONFLICT-001' \
  tests/contract/projects/controllers.test.js \
  tests/integration/dashboard/errorRecovery.test.js
node scripts/run-dashboard-webview-checks.js
```

Expected: all focused cases and dashboard source/composition checks pass.

```bash
git add src/projects/projectManualEditController.ts \
  src/dashboard/lifecycleController.ts src/dashboard.ts \
  tests/contract/projects/controllers.test.js \
  tests/integration/dashboard/errorRecovery.test.js \
  scripts/run-dashboard-webview-checks.js
git commit -m "fix: reconcile project sync before dashboard refresh"
```

---

### Task 6: Harden Failure Recovery and Legacy Compatibility

**Files:**

- Modify: `tests/contract/persistence/projectCatalogSync.test.js`
- Modify: `tests/contract/persistence/migrations.test.js`
- Modify: `scripts/run-open-project-safety-checks.js`
- Modify: `src/projects/projectCatalogSync.ts`
- Modify: `src/services/projectCatalogSyncService.ts`
- Modify: `src/services/projectService.ts`

**Interfaces:**

- Consumes: sync model, persistence coordinator, and ProjectService integration.
- Produces: deterministic corruption, retry, migration, and compatibility behavior.

- [ ] **Step 1: Add hardening tests**

Prove:

- malformed `projectSyncData` plus a valid shadow repairs from the shadow;
- malformed sync data plus no shadow migrates the valid legacy array;
- local-shadow write rejection causes the user mutation to reject before any
  setting write;
- canonical-setting rejection leaves the newer local shadow retryable;
- compatibility-projection rejection leaves canonical data and shadow intact;
- retry writes only missing state and becomes idempotent;
- diagnostics contain actor/version/reason/record IDs but not descriptions or a
  serialized complete catalog;
- the checked-in workspace fixture remains byte-equivalent after migration and
  gains exactly one saved workspace project.

- [ ] **Step 2: Observe focused RED**

```bash
npm run test-compile
node --test --test-name-pattern='PROJECT-CATALOG-SYNC-CONFLICT-001|PERSIST-DASHBOARD-MIGRATION-PUBLICATION-001' \
  tests/contract/persistence/projectCatalogSync.test.js \
  tests/contract/persistence/migrations.test.js
```

Expected: new failure-order and retry assertions fail before hardening.

- [ ] **Step 3: Implement exact failure behavior**

Reject before synchronized writes when `updateLocalState` fails. After a
successful shadow write, never roll the shadow back when either settings write
fails. On next reconciliation compare normalized documents and write only stale
destinations. Parse invalid versioned data as `null` and log a redacted
diagnostic before selecting shadow or legacy fallback.

- [ ] **Step 4: Update the existing workspace safety fixture**

Teach `run-open-project-safety-checks.js` fake configuration to accept
`projectSyncData` and teach serialized mementos to retain
`projectCatalogSyncLocal.v1`. Preserve all existing assertions for source bytes,
append count, migration failure, and global-state-only behavior.

- [ ] **Step 5: Run hardening GREEN**

```bash
npm run test-compile
node --test tests/contract/persistence/projectCatalogSync.test.js \
  tests/contract/persistence/migrations.test.js
node scripts/run-open-project-safety-checks.js
```

Expected: all commands exit `0`.

- [ ] **Step 6: Commit hardening**

```bash
git add tests/contract/persistence/projectCatalogSync.test.js \
  tests/contract/persistence/migrations.test.js \
  scripts/run-open-project-safety-checks.js \
  src/projects/projectCatalogSync.ts \
  src/services/projectCatalogSyncService.ts \
  src/services/projectService.ts
git commit -m "fix: harden project catalog sync recovery"
```

---

### Task 7: Self-Review and Verify the Complete Fix

**Files:**

- Review: all files changed since `6993963`.

**Interfaces:**

- Consumes: `PROJECT-CATALOG-SYNC-CONFLICT-001`.
- Produces: fresh proof that the user-visible regression and repository gates pass.

- [ ] **Step 1: Run focused and ownership gates**

```bash
npm run test-compile
node --test tests/contract/persistence/projectCatalogSync.test.js \
  tests/contract/persistence/migrations.test.js
npm run test:behavior-contracts
```

Expected: all commands exit `0`.

- [ ] **Step 2: Run affected layered suites**

```bash
npm run test:unit
npm run test:contract
npm run test:integration
npm run test:safety
npm run test:dashboard
```

Expected: all commands exit `0`.

- [ ] **Step 3: Run Linux CI equivalent**

```bash
npm run test:ci:linux
```

Expected: exit `0`, including compile, behavior catalog, lint baseline,
deterministic suites, safety scripts, architecture checks, packaging, bundle,
and coverage ratchet. If coverage decreases, add missing behavioral tests; do
not lower `.ci/coverage-baseline.json`.

- [ ] **Step 4: Perform inline code review**

Inspect:

```bash
git diff 6993963..HEAD --check
git diff --stat 6993963..HEAD
git status -sb
git log --oneline 6993963..HEAD
```

Verify requirement by requirement:

- no permanent operation/tombstone collection;
- exact stale-snapshot RED is now GREEN;
- observed deletion wins and concurrent deletion preserves live data;
- writes occur shadow, canonical, projection;
- migration and global-state-only paths remain intact;
- no complete catalog or project description appears in diagnostics;
- no primary-checkout file changed.

- [ ] **Step 5: Commit review corrections if needed**

Stage only intentional correction files and commit:

```bash
git commit -m "fix: address project sync review findings"
```

Skip this commit when review finds no correction. Do not push or create a PR.
