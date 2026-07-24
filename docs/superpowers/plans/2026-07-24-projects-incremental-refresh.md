# Projects Incremental Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop ordinary Projects interactions from rebuilding the complete Dashboard Webview while preserving authoritative recovery for external, stale, malformed, or undeliverable state.

**Architecture:** `ProjectCatalogSyncService` consumes exact local Settings write echoes, `DashboardLifecycleController` routes external catalog changes to a partial Projects refresh, and a versioned `projects-panel-updated` protocol replaces only the Projects panel. Successful drag acknowledgements preserve the existing Projects DOM when its order already matches host state; collapse actions remain fully in place.

**Tech Stack:** TypeScript 4.x, VS Code configuration/Webview APIs, plain ES2019-compatible JavaScript, Node.js `node:test`, existing fake DOM/runtime helpers, Gulp-generated Webview assets.

## Global Constraints

- Work only in `.worktree/todo-ux` on `feat/todo-ux-overhaul`; do not modify or merge `main`.
- Preserve the synchronized project catalog schema and compatibility `projectData` projection.
- Do not suppress external Settings Sync changes or mixed configuration changes.
- Collapse-one and collapse-all must not replace either the Webview document or Projects panel.
- Matching project/favorite drag acknowledgements must not replace the Projects panel.
- Other project mutations may replace only `#dashboard-tab-projects`, never the complete Webview document.
- Preserve the active tab, document/root identity, OPEN/TODO DOM identity and state, and window scroll.
- A malformed, stale, inconsistent, rejected, or failed partial update must retain an authoritative fallback.
- Generated `media/webviewDashboardScripts.js` must match its source.
- Keep compatibility with VS Code `^1.51.0`.

---

### Task 1: Establish the P0 Regression Contract and RED Tests

**Files:**
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `tests/contract/persistence/projectCatalogSync.test.js`
- Modify: `tests/integration/dashboard/errorRecovery.test.js`
- Modify: `tests/integration/dashboard/webviewState.test.js`
- Modify: `tests/contract/openProjects/dashboardController.test.js`

**Behavior:**
- Add: `PROJECT-INCREMENTAL-REFRESH-001` at P0.
- Own: exact Settings echo consumption, lifecycle routing, Projects-only DOM updates, and OPEN/search semantic invalidation.
- Trace: `.github/workflows/verify.yml` `quality-linux` → `npm run test:ci:linux` → `npm run test:deterministic:run` → contract/integration tests.

- [ ] **Step 1: Add the behavior catalog entry**

Register the four owner test files and production evidence in:

```text
src/services/projectCatalogSyncService.ts
src/dashboard/lifecycleController.ts
src/dashboard/projectsPanelController.ts
src/webview/webviewDashboardScripts.js
src/openWorkspaces/dashboardController.ts
```

- [ ] **Step 2: Add RED project catalog echo tests**

Extend the persistence harness to assert:

```js
assert.equal(service.consumeConfigurationWriteEcho({
    syncData: true, legacyGroups: false,
}), true);
assert.equal(service.consumeConfigurationWriteEcho({
    syncData: true, legacyGroups: false,
}), false);
```

Cover:

- one token is consumed once;
- two pending writes with equal values consume independently;
- an `A → B → A` mismatch is external rather than consuming a stale token;
- an event affecting both keys is local only when both current values match;
- invalid/unreadable values clear the affected queue;
- a rejected Settings write removes only its own pending token.

- [ ] **Step 3: Add RED lifecycle routing tests**

Assert:

- pure local project configuration events neither reconcile nor refresh;
- pure external project events reconcile once and call `refreshProjects`;
- pure external project events do not call the full `refresh`;
- project plus unrelated Project Steward configuration uses full refresh;
- local TODO echo plus external project change uses partial Projects refresh.

- [ ] **Step 4: Add RED Webview state tests**

Build a fake mounted Projects panel with saved group and favorite order. Assert:

- a valid `replace` update changes only Projects `innerHTML`;
- the Dashboard root, OPEN panel, TODO panel, active tab, and scroll survive;
- a matching `preserve-order` update leaves Projects `innerHTML` and child identities untouched;
- an order mismatch replaces only Projects;
- stale or duplicate sequence numbers are ignored;
- invalid updates request the existing full-refresh fallback.

- [ ] **Step 5: Add RED OPEN semantic revision test**

Mutate only `getGroups()`/project search data between two `postUpdated()` calls.
Assert a second `open-workspaces-updated` message is posted with a different
semantic revision.

- [ ] **Step 6: Compile and run focused tests to verify RED**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/persistence/projectCatalogSync.test.js
node --test --test-concurrency=1 tests/integration/dashboard/errorRecovery.test.js
node --test --test-concurrency=1 tests/integration/dashboard/webviewState.test.js
node --test --test-concurrency=1 tests/contract/openProjects/dashboardController.test.js
```

Expected: failures because write-echo consumption, `refreshProjects`, the
Projects update protocol/controller, client handling, and project-aware OPEN
semantic revision do not exist.

- [ ] **Step 7: Commit the RED contract**

```bash
git add docs/testing/behavior-contracts.json \
  tests/contract/persistence/projectCatalogSync.test.js \
  tests/integration/dashboard/errorRecovery.test.js \
  tests/integration/dashboard/webviewState.test.js \
  tests/contract/openProjects/dashboardController.test.js
git commit -m "test: guard incremental projects refresh"
```

---

### Task 2: Consume Exact Local Project-Catalog Write Echoes

**Files:**
- Modify: `src/services/projectCatalogSyncService.ts`
- Modify: `src/services/projectService.ts`

**Interfaces:**
- Add: `ProjectCatalogConfigurationChange`
- Add: `ProjectCatalogSyncService.consumeConfigurationWriteEcho(change): boolean`
- Add: a delegating `ProjectService.consumeProjectCatalogWriteEcho(change): boolean`

- [ ] **Step 1: Add per-key pending write tokens**

Track separate FIFO tokens for `projectSyncData` and legacy `projectData`.
Each token contains an internal ID and a stable serialized fingerprint. Register
the token immediately before the associated Settings update.

- [ ] **Step 2: Make write failure cleanup token-specific**

If a Settings update rejects, remove only the token registered by that write.
Do not clear newer writes.

- [ ] **Step 3: Implement exact event consumption**

For every affected key:

1. read the current configured value through the existing injected getter;
2. parse/normalize it through the same catalog validation path;
3. compare it with the oldest pending token;
4. consume exactly one on equality;
5. clear that key's pending queue and return external on mismatch or unreadable
   input.

An event affecting both keys returns `true` only when both keys consume a token.

- [ ] **Step 4: Expose the classification through `ProjectService`**

Return `false` when project storage is not Settings-backed. Keep filesystem
storage behavior unchanged.

- [ ] **Step 5: Run the persistence owner test**

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/persistence/projectCatalogSync.test.js
```

Expected: all persistence contract tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/projectCatalogSyncService.ts src/services/projectService.ts
git commit -m "fix: classify project settings write echoes"
```

---

### Task 3: Route Configuration Changes Without Full Refresh Storms

**Files:**
- Modify: `src/dashboard/lifecycleController.ts`
- Modify: `src/dashboard.ts`
- Modify: `tests/integration/dashboard/errorRecovery.test.js`

**Interfaces:**
- Add option: `consumeProjectCatalogWriteEcho(change)`
- Add option: `refreshProjects(reason)`

- [ ] **Step 1: Separate catalog keys from full-refresh settings**

Remove `projectSteward.projectData` and `projectSteward.projectSyncData` from the
unconditional non-TODO full-refresh list. Compute explicit booleans for those
two keys and for unrelated Dashboard settings.

- [ ] **Step 2: Implement the routing matrix**

Use this order:

1. perform storage migration when its setting changes;
2. classify affected project catalog keys as local/external;
3. reconcile external project changes;
4. return immediately for pure local project/TODO echoes;
5. call `refreshProjects('configuration-changed')`, color application, and
   open-workspace publication for pure external project changes;
6. retain the current full-refresh path for mixed project plus unrelated
   configuration and for existing external TODO/full settings changes.

- [ ] **Step 3: Wire service classification and partial refresh callbacks**

Pass the exact affected-key shape to `ProjectService`. Do not catch and relabel a
reconciliation error as local.

- [ ] **Step 4: Run lifecycle tests**

```bash
npm run test-compile
node --test --test-concurrency=1 tests/integration/dashboard/errorRecovery.test.js
```

Expected: lifecycle routing tests pass and existing full-refresh recovery tests
remain green.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/lifecycleController.ts src/dashboard.ts \
  tests/integration/dashboard/errorRecovery.test.js
git commit -m "fix: route project configuration incrementally"
```

---

### Task 4: Add the Versioned Projects Panel Update Protocol

**Files:**
- Create: `src/dashboard/projectsPanelController.ts`
- Create: `tests/contract/projects/panelController.test.js`
- Modify: `src/dashboard/webviewUpdateMessages.ts`
- Modify: `src/webview/webviewDashboardScripts.js`
- Modify: `tests/integration/dashboard/webviewState.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**

```ts
export type ProjectsPanelUpdateMode = 'replace' | 'preserve-order';

export interface ProjectsPanelUpdatedMessage {
    type: 'projects-panel-updated';
    version: 1;
    sequence: number;
    mode: ProjectsPanelUpdateMode;
    html: string;
    searchCatalog: DashboardWorkspaceSearchCatalog;
    groupOrders: Array<{ groupId: string; projectIds: string[] }>;
    favoriteProjectIds: string[];
}
```

- [ ] **Step 1: Build authoritative messages**

Use current groups, OPEN cards, TODO search items, and the existing Projects HTML
renderer. Derive saved group orders and favorite order from current host state.
Increment `sequence` monotonically per controller instance.

- [ ] **Step 2: Add delivery recovery**

If `postMessage()` returns false or rejects while visible, call full refresh with
`projects-panel-update-not-delivered` or `projects-panel-update-post-error`.
Reset no host data.

- [ ] **Step 3: Validate client messages strictly**

Require exact type/version, a safe positive sequence, known mode, normalized
search catalog, unique group IDs, unique project IDs within/between orders, and
unique favorite IDs. Reject stale sequences.

- [ ] **Step 4: Apply panel updates**

- Always replace the accepted search catalog.
- If Projects has not been mounted, retain the accepted sequence/catalog and let
  the next lazy request render current host state.
- For `replace`, assign only Projects panel `innerHTML`, then run
  `onProjectsMounted`.
- For `preserve-order`, compare authoritative group/favorite order with current
  DOM; preserve all Projects nodes on exact equality, otherwise use the
  Projects-only replacement fallback.
- Capture the focused project/action before replacement and restore it when a
  matching focus target remains.
- Never assign the Dashboard document/root or sibling panel HTML.

- [ ] **Step 5: Run controller and Webview owner tests**

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/projects/panelController.test.js
node --test --test-concurrency=1 tests/integration/dashboard/webviewState.test.js
```

Expected: all new protocol, delivery fallback, sequence, DOM preservation, and
order fallback tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/projectsPanelController.ts \
  src/dashboard/webviewUpdateMessages.ts \
  src/webview/webviewDashboardScripts.js \
  tests/contract/projects/panelController.test.js \
  tests/integration/dashboard/webviewState.test.js \
  docs/testing/behavior-contracts.json
git commit -m "feat: update projects panel incrementally"
```

---

### Task 5: Route Project Mutations to the Partial Surface

**Files:**
- Modify: `src/dashboard.ts`
- Modify: `src/dashboard/runtimeController.ts`
- Modify: `src/projects/projectMutationController.ts`
- Modify: `src/projects/projectOrderController.ts`
- Modify: `src/projects/favoriteProjectController.ts`
- Modify: `src/projects/projectRemovalController.ts`
- Modify: `src/projects/groupCommandController.ts`
- Modify: relevant controller contract tests

**Mutation policy:**
- `preserve-order`: saved-project reorder, saved-group reorder, favorite reorder.
- `replace`: add, edit, color, favorite toggle, remove, group add/edit/remove.
- no post: group collapse and collapse-all; their optimistic DOM is retained.

- [ ] **Step 1: Add explicit refresh modes to mutation callbacks**

Change callback types to accept `ProjectsPanelUpdateMode`, defaulting to
`replace`. Pass `preserve-order` only from successful reorder paths.

- [ ] **Step 2: Create a project-surface refresh function**

After a successful project mutation:

1. post the Projects update in the requested mode;
2. post an OPEN/search update whose semantic revision reflects the new catalog;
3. apply project color to the current window;
4. publish open-workspace metadata.

Do not call provider/Webview full refresh.

- [ ] **Step 3: Wire external catalog refresh to the same surface**

Use `replace` after external catalog reconciliation.

- [ ] **Step 4: Keep collapse fully optimistic**

Do not add a panel update to `collapse-group` or collapse-all. Exact Settings
echo consumption is their acknowledgement path.

- [ ] **Step 5: Run affected controller and Dashboard tests**

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/projects/*.test.js
node --test --test-concurrency=1 tests/contract/openProjects/*.test.js
node --test --test-concurrency=1 tests/integration/dashboard/*.test.js
```

Expected: all affected contract and integration tests pass; no ordinary project
mutation test observes a full provider refresh.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.ts src/dashboard/runtimeController.ts src/projects \
  tests/contract/projects tests/contract/openProjects tests/integration/dashboard
git commit -m "fix: keep project mutations in place"
```

---

### Task 6: Make OPEN/Search Publication Project-Aware

**Files:**
- Modify: `src/openWorkspaces/dashboardController.ts`
- Modify: `tests/contract/openProjects/dashboardController.test.js`

- [ ] **Step 1: Include project-facing data in view semantics**

Hash normalized group/project content and TODO search items into
`getViewSemanticRevision()` alongside bridge, aggregate, attention, and
animation state. The revision must change when saved-state/color/search changes
even if the cross-window aggregate does not.

- [ ] **Step 2: Preserve de-duplication**

Two consecutive `postUpdated()` calls with identical complete view input must
still publish once.

- [ ] **Step 3: Run the OPEN controller contract**

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/openProjects/dashboardController.test.js
```

Expected: project-only state changes produce a new update; identical state is
deduplicated.

- [ ] **Step 4: Commit**

```bash
git add src/openWorkspaces/dashboardController.ts \
  tests/contract/openProjects/dashboardController.test.js
git commit -m "fix: invalidate open search on project changes"
```

---

### Task 7: Regenerate Assets and Verify the Regression Layers

**Files:**
- Modify: `media/webviewDashboardScripts.js`
- Modify: `docs/testing/behavior-contracts.json` if owner paths changed

- [ ] **Step 1: Regenerate production Webview assets**

```bash
npx gulp --production
```

Verify the generated dashboard script contains
`projects-panel-updated` handling and matches the source behavior.

- [ ] **Step 2: Run focused owner tests**

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/persistence/projectCatalogSync.test.js
node --test --test-concurrency=1 tests/contract/projects/panelController.test.js
node --test --test-concurrency=1 tests/contract/openProjects/dashboardController.test.js
node --test --test-concurrency=1 tests/integration/dashboard/errorRecovery.test.js
node --test --test-concurrency=1 tests/integration/dashboard/webviewState.test.js
```

- [ ] **Step 3: Run regression governance and Dashboard suites**

```bash
npm run test:behavior-catalog
npm run test:dashboard
npm run test:architecture
npm run lint
npm run test:safety
```

- [ ] **Step 4: Run the required deterministic CI path**

```bash
npm run test:ci:linux
```

Expected: unit, contract, and integration suites pass through the same command
reached by required check `quality-linux`.

- [ ] **Step 5: Commit generated assets**

```bash
git add media/webviewDashboardScripts.js docs/testing/behavior-contracts.json
git commit -m "build: regenerate incremental projects assets"
```

---

### Task 8: Review, Package, Install, and Record Evidence

**Files:**
- Create: `docs/superpowers/reports/2026-07-24-projects-incremental-refresh-verification.md`

- [ ] **Step 1: Run the review-fix-commit loop**

Request a focused review for behavior gaps, async races, stale echo suppression,
DOM consistency, privacy, and regression-test ownership. Apply actionable fixes,
rerun their narrowest tests, and commit fixes intentionally.

- [ ] **Step 2: Run fresh completion verification**

```bash
git status --short
npm run test:ci:linux
npm run test:behavior-catalog
npm run test:dashboard
npm run test:architecture
npm run lint
npm run test:safety
npm run package:release
```

Record exact counts, artifact path/hash, commit, and branch. Do not claim success
from earlier cached output.

- [ ] **Step 3: Package and install in the target VS Code Server**

Use the repository's local extension installation workflow and pinned
`code-server` binary. Install the new VSIX with `--force`, then verify:

```bash
<pinned-code-server> --list-extensions --show-versions | rg '^hzcheng\.project-steward@'
```

- [ ] **Step 4: Record live verification guidance**

In the report, include:

- collapse one/all causes zero `full-refresh`;
- reorder causes zero Projects panel replacement on a matching acknowledgement;
- CRUD causes one Projects panel update and zero full document reload;
- local configuration echoes do not create a refresh storm;
- external/mixed and delivery failures retain full recovery.

- [ ] **Step 5: Commit the verification report**

```bash
git add docs/superpowers/reports/2026-07-24-projects-incremental-refresh-verification.md
git commit -m "docs: verify incremental projects refresh"
```

- [ ] **Step 6: Preserve the branch for user approval**

Confirm `main` remains unchanged. Do not push, open a PR, merge, or remove the
worktree. Report the installed VSIX and ask only for the user's final visual
approval before any integration decision.
