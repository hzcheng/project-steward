# OPEN PROJECT Cross-Window Project Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every distinct project open in live Project Steward windows in the current VS Code Profile, while keeping only current-window cards session-capable and using the existing project-opening path for navigation.

**Architecture:** Workspace Extension instances publish bounded project descriptors through the existing UI-only Local Bridge. Bridge instances coordinate through one Profile-local registration directory, stamp all lease/focus times in the desktop clock domain, and return semantic aggregates. The dashboard keeps current projects local, deduplicates other projects by canonical URI, and passes navigation clicks through the existing `openProject()` / `vscode.openFolder` flow.

**Tech Stack:** TypeScript 4, VS Code Extension API, Node.js filesystem and crypto APIs, Webview HTML/JavaScript, Webpack, and Node `assert` safety scripts.

## Global Constraints

- Scope is one desktop VS Code client and one VS Code Profile.
- Local, Remote SSH, WSL, Dev Container, and other remote workspaces use one protocol.
- Current-window cards remain first and are the only cards with AI-session functionality.
- Other-window cards are navigation-only and deduplicated by normalized canonical project URI.
- The same project in multiple windows produces one card; the current-window card wins, otherwise the most recently focused publisher wins.
- Navigation reuses `openProject()` and `vscode.openFolder`; there is no target-window instance focus relay.
- The UI Bridge stamps `lastFocusedAtMs` and `leaseUpdatedAtMs` in the desktop clock domain.
- Heartbeat interval is 10 seconds and registration lease is 30 seconds.
- Registrations contain at most 100 projects and use strict runtime validation.
- Heartbeat-only writes do not change the semantic aggregate revision or refresh the Webview.
- The feature has no mixed-version compatibility, protocol downgrade, or old-data migration path.
- The failed exact-focus spike remains documented but all disposable focus-spike code is removed.
- `.vscode/settings.json` is user-owned and must never be staged or committed.

---

## File Structure

### Shared protocol and projection

- Create `src/openProjects/protocol.ts` for strict publication, registration, and aggregate contracts plus semantic revision generation.
- Create `src/openProjects/projection.ts` for canonical identity, record creation, current-card precedence, deduplication, and ordering.
- Modify `src/models.ts` for explicit current/navigation card metadata.
- Create `scripts/run-open-project-safety-checks.js` as the feature's executable test suite.
- Modify `package.json` to compile and run the new checks.

### Profile-local registry

- Create `extensions/attention-ui-bridge/src/openProjectStore.ts` for atomic registration persistence, validation, lease scanning, removal, and malformed-file isolation.
- Create `extensions/attention-ui-bridge/src/openProjectCoordinator.ts` for desktop-clock stamping, owner binding, semantic aggregation, watching, fallback polling, and Workspace delivery.
- Modify `extensions/attention-ui-bridge/src/extension.ts` to register production publish/unregister commands and own the coordinator.
- Modify `extensions/attention-ui-bridge/tsconfig.json` to compile the shared protocol.

### Workspace lifecycle and dashboard

- Create `src/openProjects/bridgeClient.ts` for publication lifecycle and aggregate reception.
- Modify `src/dashboard.ts` to publish current project descriptors, consume aggregates, build navigation cards, and route their clicks through existing project opening.
- Modify `src/projects/currentWorkspaceState.ts` so only current card kinds are marked current.
- Modify `src/webview/webviewContent.ts` to render current and navigation cards with separate behavior markers.
- Modify `src/webview/webviewProjectScripts.js` so navigation cards ignore modifier/middle-click behavior and always send the default project action.

### Spike retirement and delivery

- Delete `spikes/attention-local-bridge/shared/focusRelay.ts`.
- Remove only the open-window focus-spike paths from the workspace probe, UI Bridge, and spike checks.
- Retain `docs/superpowers/reports/2026-07-15-open-window-focus-feasibility.md` as FAIL evidence.

---

### Task 1: Retire the Failed Exact-Focus Spike

**Files:**
- Delete: `spikes/attention-local-bridge/shared/focusRelay.ts`
- Modify: `spikes/attention-local-bridge/workspace/src/extension.ts`
- Modify: `spikes/attention-local-bridge/workspace/package.json`
- Modify: `extensions/attention-ui-bridge/src/extension.ts`
- Modify: `scripts/run-attention-local-bridge-spike-checks.js`

**Interfaces:**
- Consumes: the FAIL decision in `docs/superpowers/reports/2026-07-15-open-window-focus-feasibility.md`.
- Produces: the original attention routing/file-store spike without any `open-window-focus-spike`, `FOCUS_*`, or `workbench.action.focusWindow` path.

- [ ] **Step 1: Add a failing retirement assertion**

In `scripts/run-attention-local-bridge-spike-checks.js`, add a source-contract check that loads the workspace and UI Bridge sources and asserts:

```js
for (const source of [workspaceSource, bridgeSource]) {
    assert.ok(!source.includes('workbench.action.focusWindow'));
    assert.ok(!source.includes('open-window-focus-spike'));
    assert.ok(!source.includes('_projectStewardOpenWindowSpike'));
}
```

- [ ] **Step 2: Verify RED**

Run: `npm run spike:attention:test`

Expected: FAIL because the committed disposable spike still contains all three strings.

- [ ] **Step 3: Remove only disposable focus code**

Delete `focusRelay.ts`; remove its import, focus constants, types, command registrations, handlers, directories, watcher/timer state, cleanup, and disposables. Remove `projectSteward.openWindowFocusSpike` from the probe manifest. Preserve all attention routing, file stress, production attention publish/acknowledgement, and Local Bridge behavior.

- [ ] **Step 4: Verify GREEN and compile production bundles**

Run:

```bash
npm run spike:attention:test
npm run webpack
npm run attention:bridge:bundle
```

Expected: all commands exit 0; the spike check ends with `Attention Local Bridge spike checks passed.`

- [ ] **Step 5: Commit**

```bash
git add spikes/attention-local-bridge extensions/attention-ui-bridge/src/extension.ts scripts/run-attention-local-bridge-spike-checks.js
git commit -m "test: retire failed window focus spike"
```

Do not stage `.vscode/settings.json`.

---

### Task 2: Define the Open-Project Protocol and Pure Projection

**Files:**
- Create: `src/openProjects/protocol.ts`
- Create: `src/openProjects/projection.ts`
- Modify: `src/models.ts`
- Create: `scripts/run-open-project-safety-checks.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `OpenProjectPublication`, `OpenProjectRegistration`, `OpenProjectAggregate`, validators, `createOpenProjectSemanticRevision`, `createOpenProjectRecords`, `normalizeOpenProjectIdentity`, and `projectOpenProjectCards`.

- [ ] **Step 1: Write failing protocol/projection checks**

Create `scripts/run-open-project-safety-checks.js`. Load compiled modules from `out/openProjects/protocol` and `out/openProjects/projection`; assert this representative behavior:

```js
const SELF = '1'.repeat(32);
const OLDER = '2'.repeat(32);
const NEWER = '3'.repeat(32);
const current = [{
    id: '__openProjects-0', name: 'Current', description: 'Workspace folder',
    path: '/work/current', color: '#111', openProjectCardKind: 'current',
}];
const aggregate = {
    protocolVersion: 1,
    semanticRevision: 'revision',
    observedAtMs: 5000,
    registrations: [
        makeRegistration(SELF, 4000, '/work/current'),
        makeRegistration(OLDER, 2000, '/work/shared/'),
        makeRegistration(NEWER, 3000, '/work/shared'),
    ],
};
const cards = projection.projectOpenProjectCards(current, aggregate, SELF);
assert.deepStrictEqual(cards.map(card => card.name), ['Current', 'Shared']);
assert.strictEqual(cards[0].openProjectCardKind, 'current');
assert.strictEqual(cards[1].openProjectCardKind, 'projectNavigation');
assert.strictEqual(cards[1].openProjectSourceInstanceId, NEWER);
assert.strictEqual(cards[1].codexSessions, undefined);
assert.strictEqual(cards[1].path, '/work/shared');
```

Also assert that a current URI suppresses a remote duplicate; remote URI authority and path participate in identity; trailing slashes do not; different remote authorities do not deduplicate; ordering uses descending focus time then ordinal and identity.

Protocol checks must reject unknown keys, invalid 32-hex IDs, more than 100 projects, invalid remote types, unsafe integer sequences, non-finite timestamps, empty/overlong strings, and malformed aggregates. Assert semantic revisions are equal when only sequence/lease fields change and differ when projects or focus time change.

- [ ] **Step 2: Add test commands and verify RED**

Add:

```json
"test:open-projects": "npm run test-compile && npm run attention:bridge:compile && node scripts/run-open-project-safety-checks.js",
"test:safety": "npm run test-compile && node scripts/run-ai-session-safety-checks.js && npm run attention:bridge:compile && node scripts/run-open-project-safety-checks.js"
```

Run: `npm run test:open-projects`

Expected: FAIL because the two compiled modules do not exist.

- [ ] **Step 3: Implement the strict shared protocol**

Create these exact public shapes and constants in `src/openProjects/protocol.ts`:

```ts
export const OPEN_PROJECT_PROTOCOL_VERSION = 1;
export const OPEN_PROJECT_HEARTBEAT_MS = 10_000;
export const OPEN_PROJECT_LEASE_MS = 30_000;
export const MAX_OPEN_PROJECT_RECORDS = 100;
export type OpenProjectRemoteType = 'local' | 'ssh' | 'wsl' | 'devContainer' | 'remote';

export interface OpenProjectRecord {
    localProjectId: string;
    ordinal: number;
    name: string;
    description: string;
    uri: string;
    remoteType: OpenProjectRemoteType;
    color?: string;
}
export interface OpenProjectPublication {
    protocolVersion: 1;
    instanceId: string;
    sequence: number;
    followsFocusEvent: boolean;
    projects: OpenProjectRecord[];
}
export interface OpenProjectRegistration {
    protocolVersion: 1;
    instanceId: string;
    sequence: number;
    lastFocusedAtMs: number;
    leaseUpdatedAtMs: number;
    projects: OpenProjectRecord[];
}
export interface OpenProjectAggregate {
    protocolVersion: 1;
    semanticRevision: string;
    observedAtMs: number;
    registrations: OpenProjectRegistration[];
}
```

Export strict `validateOpenProjectPublication`, `validateOpenProjectRegistration`, and `validateOpenProjectAggregate`. Use SHA-256 in `createOpenProjectSemanticRevision(registrations)` over sorted instance IDs, focus times, and project descriptors while excluding sequence and lease fields.

- [ ] **Step 4: Add card metadata and pure projection**

Extend `Project` with:

```ts
openProjectCardKind?: 'current' | 'projectNavigation';
openProjectSourceInstanceId?: string;
openProjectEnvironmentLabel?: string;
```

In `src/openProjects/projection.ts`, export:

```ts
export function normalizeOpenProjectIdentity(uri: string): string;
export function createOpenProjectRecords(projects: Project[]): OpenProjectRecord[];
export function projectOpenProjectCards(
    currentProjects: Project[],
    aggregate: OpenProjectAggregate | null,
    ownInstanceId: string
): Project[];
```

Map `ProjectRemoteType` to the protocol string and back. Clone current cards with kind `current`. For navigation IDs use `__openProjectNavigation-${sha256(canonicalIdentity).slice(0, 24)}` so Webview input never becomes a URI. Strip all session, attention, favorite, Save, and expansion fields from navigation cards.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test:open-projects`

Expected: PASS ending with `Open project safety checks passed.`

- [ ] **Step 6: Commit**

```bash
git add src/openProjects src/models.ts scripts/run-open-project-safety-checks.js package.json
git commit -m "feat: define cross-window open project model"
```

---

### Task 3: Implement the Profile-Local Registration Store

**Files:**
- Create: `extensions/attention-ui-bridge/src/openProjectStore.ts`
- Modify: `extensions/attention-ui-bridge/tsconfig.json`
- Modify: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Consumes: `OpenProjectRegistration`, validators, lease constants, and semantic revision generation.
- Produces: `OpenProjectStore.write`, `remove`, `scan`, and `read`.

- [ ] **Step 1: Add failing behavioral store checks**

Use a temporary directory and assert:

```js
const store = new OpenProjectStore(tempRoot, 'b'.repeat(32));
await store.write(registration);
assert.deepStrictEqual((await store.scan(1200)).registrations, [registration]);
await assert.rejects(store.write({ ...registration, sequence: registration.sequence - 1 }), /sequence/);
assert.deepStrictEqual(await store.read(registration.instanceId, 1200), registration);
await store.remove(registration.instanceId);
assert.deepStrictEqual((await store.scan(1200)).registrations, []);
```

Create malformed JSON, an oversized file, a symlink, a directory named like a registration, filename/content ID mismatch, rollback sequence, and expired lease. Assert each is isolated, counted, and never replaces a newer cached registration.

- [ ] **Step 2: Verify RED**

Run: `npm run test:open-projects`

Expected: FAIL because `openProjectStore` does not exist.

- [ ] **Step 3: Implement the store**

Accept the existing Local Bridge storage root as the constructor argument and append `open-projects/v1/instances`. Use `lstat`, a `^[a-f0-9]{32}\.json$` filename rule, a 256 KiB file limit, directory mode `0o700`, file mode `0o600`, exclusive random temporary files, and atomic rename. Preserve the highest valid cached sequence per instance and expire registrations when `nowMs - leaseUpdatedAtMs > 30_000`.

Return:

```ts
export interface OpenProjectStoreScan {
    registrations: OpenProjectRegistration[];
    counters: {
        active: number;
        parseErrors: number;
        oversizedFiles: number;
        symlinkFiles: number;
        readErrors: number;
        rollbackCount: number;
        expired: number;
    };
}
```

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:open-projects`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/attention-ui-bridge/src/openProjectStore.ts extensions/attention-ui-bridge/tsconfig.json scripts/run-open-project-safety-checks.js
git commit -m "feat: add profile-local open project store"
```

---

### Task 4: Add the UI Bridge Registry Coordinator

**Files:**
- Create: `extensions/attention-ui-bridge/src/openProjectCoordinator.ts`
- Modify: `extensions/attention-ui-bridge/src/extension.ts`
- Modify: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Consumes: `OpenProjectStore` and validated Workspace publications.
- Produces: `_projectStewardOpenProjects.bridge.publish`, `_projectStewardOpenProjects.bridge.unregister`, and `_projectStewardOpenProjects.workspace.aggregate` behavior.

- [ ] **Step 1: Add failing coordinator tests**

Build the coordinator with injected `now`, `setInterval`, `clearInterval`, `createWatcher`, and `deliverAggregate`. Assert:

```js
await coordinator.publish({ ...publication, followsFocusEvent: true });
const first = (await store.scan(1000)).registrations[0];
assert.strictEqual(first.lastFocusedAtMs, 1000);
assert.strictEqual(first.leaseUpdatedAtMs, 1000);

now = 2000;
await coordinator.publish({ ...publication, sequence: 2, followsFocusEvent: false });
const heartbeat = (await store.scan(2000)).registrations[0];
assert.strictEqual(heartbeat.lastFocusedAtMs, 1000);
assert.strictEqual(heartbeat.leaseUpdatedAtMs, 2000);
```

Also assert a remote-supplied clock field is rejected by strict validation, a second instance ID cannot bind to the same coordinator, identical semantic aggregates deliver once, a project/focus/expiry change delivers again, watcher events coalesce, polling recovers missed watcher events, and unregister removes the bound record.

- [ ] **Step 2: Verify RED**

Run: `npm run test:open-projects`

Expected: FAIL because `openProjectCoordinator` does not exist.

- [ ] **Step 3: Implement and wire the coordinator**

Export `OpenProjectCoordinator` with `publish(raw)`, `unregister(raw)`, `scanAndDeliver()`, and `dispose()`. Stamp registration times using injected desktop `now()`. On first non-focus publication use `lastFocusedAtMs: 0`; preserve it on heartbeats. Use a filesystem watcher plus a five-second fallback scan, single-flight/coalesced scans, and semantic-revision suppression.

Register the two bridge commands in `extensions/attention-ui-bridge/src/extension.ts`, create the coordinator under the existing `bridgeRoot`, and deliver aggregates with:

```ts
vscode.commands.executeCommand(
    '_projectStewardOpenProjects.workspace.aggregate',
    aggregate
)
```

Dispose the coordinator with the extension. Do not add any focus or open-folder command to the UI Bridge.

- [ ] **Step 4: Verify GREEN and bundle**

Run:

```bash
npm run test:open-projects
npm run attention:bridge:bundle
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add extensions/attention-ui-bridge/src/openProjectCoordinator.ts extensions/attention-ui-bridge/src/extension.ts scripts/run-open-project-safety-checks.js
git commit -m "feat: coordinate live open projects"
```

---

### Task 5: Publish Workspace Projects and Receive Aggregates

**Files:**
- Create: `src/openProjects/bridgeClient.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Produces: `OpenProjectBridgeClient.instanceId`, `publish`, `receiveAggregate`, and `dispose`.
- Dashboard provides current raw projects and receives aggregate changes.

- [ ] **Step 1: Add failing client lifecycle checks**

Use injected command execution, timers, and instance ID. Assert activation publication, ten-second heartbeat, focus-event publication, semantic suppression between heartbeats, strict aggregate rejection, aggregate callback only for a changed semantic revision, throttled errors, and best-effort unregister on dispose.

The expected publication shape is:

```js
{
    protocolVersion: 1,
    instanceId: 'a'.repeat(32),
    sequence: 1,
    followsFocusEvent: true,
    projects: records,
}
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:open-projects`

Expected: FAIL because `bridgeClient` does not exist.

- [ ] **Step 3: Implement the client**

Register `_projectStewardOpenProjects.workspace.aggregate`. Publish through `_projectStewardOpenProjects.bridge.publish`; unregister through `_projectStewardOpenProjects.bridge.unregister`. Generate a 32-hex activation ID, increment safe integer sequence values, publish immediately, heartbeat every 10 seconds, and keep all timestamps out of the Workspace publication.

- [ ] **Step 4: Integrate lifecycle without changing session scope**

In `dashboard.ts`:

- keep existing `getOpenProjects()` current-window-only and session-capable;
- add `getRawOpenProjects()` using `getOpenProjectsFromWorkspace` without `withAiSessions`;
- create the client with `createOpenProjectRecords(getRawOpenProjects())`;
- republish on workspace-folder/config metadata changes;
- republish with `followsFocusEvent: true` when `onDidChangeWindowState` reports focused;
- store the latest validated aggregate and refresh only when its semantic revision changes;
- dispose the client through `context.subscriptions`.

- [ ] **Step 5: Verify GREEN and main bundle**

Run:

```bash
npm run test:open-projects
npm run webpack
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/openProjects/bridgeClient.ts src/dashboard.ts scripts/run-open-project-safety-checks.js
git commit -m "feat: publish live workspace projects"
```

---

### Task 6: Render and Navigate Cross-Window Project Cards

**Files:**
- Modify: `src/dashboard.ts`
- Modify: `src/projects/currentWorkspaceState.ts`
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Consumes: `projectOpenProjectCards(current, aggregate, ownInstanceId)`.
- Produces: combined `stewardInfos.openProjects`, safe navigation lookup, and distinct DOM behavior.

- [ ] **Step 1: Add failing dashboard/Webview regression checks**

Assert generated HTML for one current and one navigation card:

```js
assert.match(html, /data-open-project/);
assert.match(html, /data-project-navigation/);
assert.match(html, /title="Switch to this project"/);
assert.strictEqual((html.match(/class="codex-sessions"/g) || []).length, 1);
```

Source-contract checks must assert navigation IDs resolve from the latest projection map, the Webview does not send a URI, modifiers/middle click are ignored for `data-project-navigation`, and `openProject()` remains the final navigation handler.

Add a pure `withCurrentWorkspaceState` regression showing a navigation card remains `isCurrentWorkspace: false` while a current card is true.

- [ ] **Step 2: Verify RED**

Run: `npm run test:safety`

Expected: FAIL because navigation cards are not yet rendered or routed.

- [ ] **Step 3: Build the combined card projection**

Change only `stewardInfos.openProjects` to return `projectOpenProjectCards(getOpenProjects(), latestAggregate, client.instanceId)`. Keep every session/terminal/attention operation on `getOpenProjects()`.

Maintain a fresh navigation-card lookup by ID. In `selected-project`, resolve saved projects, then current projects, then navigation cards. Reject unknown IDs with the existing warning. Pass a resolved navigation `Project` to the existing `openProject(project, ProjectOpenType.Default)` path.

- [ ] **Step 4: Render explicit current/navigation behavior**

In `withCurrentWorkspaceState`, mark an open card current only when `openProjectCardKind !== 'projectNavigation'`.

In `getProjectDiv`:

- set `data-open-project` only for current cards;
- set `data-project-navigation`, `data-readonly-project`, and `title="Switch to this project"` for navigation cards;
- render AI badge and session section only for current cards;
- suppress Save, Favorite, actions, attention, and context menus for navigation cards;
- keep the existing remote icon and description.

In `onInsideProjectClick`, handle `data-project-navigation` before modifier logic and call `openProject(dataId, ProjectOpenType.Default)`.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm run test:safety
npm run webpack
```

Expected: both exit 0; safety output includes `AI session safety checks passed.` and `Open project safety checks passed.`

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.ts src/projects/currentWorkspaceState.ts src/webview/webviewContent.ts src/webview/webviewProjectScripts.js scripts/run-ai-session-safety-checks.js scripts/run-open-project-safety-checks.js
git commit -m "feat: show live projects across VS Code windows"
```

---

### Task 7: Final Verification and Test Packages

**Files:**
- Modify only if verification finds a scoped defect.
- Update: `.superpowers/sdd/progress.md` (ignored ledger only).

**Interfaces:**
- Produces: reviewed source, fresh main/UI-Bridge VSIX artifacts, and a concise manual acceptance checklist.

- [ ] **Step 1: Run full automated verification**

```bash
npm run test:safety
npm run spike:attention:test
npm run webpack
npm run attention:bridge:bundle
npm run lint
```

Expected: every command exits 0; lint may retain only its documented pre-existing warnings.

- [ ] **Step 2: Verify the failed mechanism is absent**

```bash
! rg -n "workbench\.action\.focusWindow|open-window-focus-spike|_projectStewardOpenWindowSpike" src shared extensions spikes scripts
```

Expected: exit 0 with no matches.

- [ ] **Step 3: Package fresh artifacts**

Run:

```bash
npm run attention:package
npx @vscode/vsce package --out artifacts/project-steward-1.1.8.vsix
sha256sum artifacts/project-steward-1.1.8.vsix artifacts/project-steward-attention-ui-bridge-0.1.1.vsix
```

Expected: both VSIX files exist; record their byte sizes and SHA-256 values. Do not publish or install automatically.

- [ ] **Step 4: Perform final whole-branch review**

Review from the branch merge base through `HEAD`, including all Minor findings recorded in `.superpowers/sdd/progress.md`. Fix Critical and Important findings with covering tests and rerun affected verification.

- [ ] **Step 5: Commit any verification fixes**

If and only if scoped fixes were required:

```bash
git add src/openProjects src/models.ts src/dashboard.ts src/projects/currentWorkspaceState.ts src/webview/webviewContent.ts src/webview/webviewProjectScripts.js extensions/attention-ui-bridge/src extensions/attention-ui-bridge/tsconfig.json scripts/run-open-project-safety-checks.js scripts/run-ai-session-safety-checks.js scripts/run-attention-local-bridge-spike-checks.js spikes/attention-local-bridge package.json
git commit -m "fix: harden cross-window open projects"
```

Leave `.vscode/settings.json` unstaged. Do not push without a user request.
