# OPEN PROJECT Cross-Window Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every live Project Steward project from the current VS Code Profile in `OPEN PROJECT`, while keeping only current-window cards session-capable and making every other card focus its exact existing window without opening a duplicate.

**Architecture:** Each Workspace Extension publishes a bounded open-window registration through the existing UI-only Local Bridge. Bridge instances coordinate through a separate Profile-local registry and a target-addressed focus-request directory; the target Workspace Extension focuses its own window with `workbench.action.focusWindow`. The dashboard combines its existing current projects with navigation-only projections from the aggregate registry.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js filesystem APIs, Webview HTML/JavaScript, SCSS/Gulp, Webpack, Node `assert` safety scripts.

## Global Constraints

- The hard-gate focus spike must pass before production registry or Webview work begins.
- Scope is one desktop VS Code client and one VS Code Profile.
- Local, Remote SSH, WSL, Dev Container, and other remote windows use one protocol.
- Current-window cards remain first and are the only cards with AI session functionality.
- Other-window cards are navigation-only and sorted by descending window focus time.
- Identical projects in different windows remain separate and targetable.
- No focus failure may invoke `vscode.openFolder`, `vscode.newWindow`, a VS Code CLI, or OS automation.
- Heartbeat interval is 10 seconds; registration lease is 30 seconds.
- Focus request TTL is 10 seconds; focus result TTL is 30 seconds; source wait timeout is 3 seconds.
- The feature has no mixed-version compatibility, protocol downgrade, or old-data migration path.
- `.vscode/settings.json` is user-owned and must never be staged or committed.

---

## File Structure

### Temporary feasibility code

- Modify `spikes/attention-local-bridge/workspace/src/extension.ts` to expose the target Workspace focus handler and a command that selects a live target.
- Create `spikes/attention-local-bridge/shared/focusRelay.ts` for bounded spike request/result parsing and target matching.
- Modify `extensions/attention-ui-bridge/src/extension.ts` to run the temporary focus relay during the spike.
- Modify `scripts/run-attention-local-bridge-spike-checks.js` for deterministic relay tests.
- Create `docs/superpowers/reports/2026-07-15-open-window-focus-feasibility.md` for measured evidence.

### Production main extension

- Create `src/openWindows/protocol.ts` as the canonical wire types, constants, and validators used by both extensions.
- Create `src/openWindows/projection.ts` for pure descriptor building, card projection, ordering, namespaced IDs, and duplicate labels.
- Create `src/openWindows/bridgeClient.ts` for registration lifecycle, aggregate reception, focus requests, and target self-focus.
- Modify `src/models.ts` with explicit current/navigation card metadata.
- Modify `src/projects/currentWorkspaceState.ts` so navigation cards are never marked as the current workspace.
- Modify `src/dashboard.ts` to publish plain current-project descriptors, consume aggregates, render combined cards, and handle focus errors.
- Modify `src/webview/webviewContent.ts` to render current and navigation cards through separate behavior flags.
- Modify `src/webview/webviewProjectScripts.js` to send target focus messages for navigation cards.
- Modify `media/styles.scss` only for a small navigation-card environment/switch affordance; regenerate `media/styles.css` through Gulp.

### Production Local Bridge

- Create `extensions/attention-ui-bridge/src/openWindowStore.ts` for safe registry, request, result, lease, and cleanup file operations.
- Create `extensions/attention-ui-bridge/src/openWindowCoordinator.ts` for aggregation, local-window binding, filesystem watching, and exact target dispatch.
- Modify `extensions/attention-ui-bridge/src/extension.ts` to register production open-window commands and own the coordinator.
- Modify `extensions/attention-ui-bridge/tsconfig.json` to compile `src/openWindows/protocol.ts` into the bridge bundle.

### Tests and packaging

- Create `scripts/run-open-window-safety-checks.js` for protocol, projection, store, coordinator, and bridge-client checks.
- Modify `scripts/run-ai-session-safety-checks.js` for Webview and current-workspace regression checks.
- Modify `package.json` to add the new safety command and include it in `test:safety`.

---

### Task 1: Prove Exact Existing-Window Focus

**Files:**
- Create: `spikes/attention-local-bridge/shared/focusRelay.ts`
- Modify: `spikes/attention-local-bridge/workspace/src/extension.ts`
- Modify: `spikes/attention-local-bridge/workspace/package.json`
- Modify: `extensions/attention-ui-bridge/src/extension.ts`
- Modify: `spikes/attention-local-bridge/tsconfig.json`
- Modify: `scripts/run-attention-local-bridge-spike-checks.js`
- Create: `docs/superpowers/reports/2026-07-15-open-window-focus-feasibility.md`

**Interfaces:**
- Consumes: existing 32-hex-character workspace process IDs, Profile-local bridge storage, and window-local private command routing.
- Produces: `parseFocusSpikeRequest`, `shouldHandleFocusSpikeRequest`, and measured proof that the exact target can run `workbench.action.focusWindow` without increasing the live window count.

- [ ] **Step 1: Add failing pure relay checks**

Add this import and test block to `scripts/run-attention-local-bridge-spike-checks.js`:

```js
const focusRelay = require('../spikes/attention-local-bridge/out/spikes/attention-local-bridge/shared/focusRelay');

function runFocusRelayChecks() {
    const request = {
        protocolVersion: 1,
        requestId: '11111111111111111111111111111111',
        sourceInstanceId: '22222222222222222222222222222222',
        targetInstanceId: '33333333333333333333333333333333',
        createdAtMs: 1_000,
    };
    assert.deepStrictEqual(focusRelay.parseFocusSpikeRequest(request, 1_001), request);
    assert.strictEqual(focusRelay.shouldHandleFocusSpikeRequest(request, request.targetInstanceId, 1_001), true);
    assert.strictEqual(focusRelay.shouldHandleFocusSpikeRequest(request, request.sourceInstanceId, 1_001), false);
    assert.throws(() => focusRelay.parseFocusSpikeRequest({ ...request, targetInstanceId: 'bad' }, 1_001), /targetInstanceId/);
    assert.throws(() => focusRelay.parseFocusSpikeRequest(request, 11_001), /expired/);
}
```

Call `runFocusRelayChecks()` from `main()` before the filesystem store checks.

- [ ] **Step 2: Run the spike checks and verify RED**

Run: `npm run spike:attention:test`

Expected: FAIL because `spikes/attention-local-bridge/shared/focusRelay` does not exist.

- [ ] **Step 3: Implement the bounded spike protocol**

Create `spikes/attention-local-bridge/shared/focusRelay.ts`:

```ts
export const FOCUS_SPIKE_TTL_MS = 10_000;
const ID_PATTERN = /^[a-f0-9]{32}$/;

export interface FocusSpikeRequest {
    protocolVersion: 1;
    requestId: string;
    sourceInstanceId: string;
    targetInstanceId: string;
    createdAtMs: number;
}

export function parseFocusSpikeRequest(value: unknown, nowMs: number): FocusSpikeRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('focus request must be an object');
    const record = value as Record<string, unknown>;
    if (record.protocolVersion !== 1) throw new Error('protocolVersion must equal 1');
    for (const field of ['requestId', 'sourceInstanceId', 'targetInstanceId']) {
        if (typeof record[field] !== 'string' || !ID_PATTERN.test(record[field] as string)) throw new Error(`${field} is invalid`);
    }
    if (typeof record.createdAtMs !== 'number' || !Number.isFinite(record.createdAtMs)
        || nowMs < record.createdAtMs || nowMs - record.createdAtMs >= FOCUS_SPIKE_TTL_MS) throw new Error('focus request expired');
    return record as unknown as FocusSpikeRequest;
}

export function shouldHandleFocusSpikeRequest(request: FocusSpikeRequest, localInstanceId: string, nowMs: number): boolean {
    return request.targetInstanceId === localInstanceId && nowMs - request.createdAtMs < FOCUS_SPIKE_TTL_MS;
}
```

Include the file in `spikes/attention-local-bridge/tsconfig.json`.

- [ ] **Step 4: Run pure checks and verify GREEN**

Run: `npm run spike:attention:test`

Expected: PASS with the existing final line `Attention local bridge spike checks passed.`

- [ ] **Step 5: Add the temporary end-to-end spike commands**

In the workspace spike extension, register:

```ts
const FOCUS_WORKSPACE = '_projectStewardOpenWindowSpike.workspace.focus';
const RUN_FOCUS_SPIKE = 'projectSteward.openWindowFocusSpike';

vscode.commands.registerCommand(FOCUS_WORKSPACE, async (request: FocusSpikeRequest) => {
    if (request.targetInstanceId !== workspaceProcessId) throw new Error('focus target mismatch');
    const startedAtMs = Date.now();
    await vscode.commands.executeCommand('workbench.action.focusWindow');
    return {
        requestId: request.requestId,
        targetInstanceId: workspaceProcessId,
        focused: vscode.window.state.focused,
        latencyMs: Date.now() - startedAtMs,
    };
});
```

Add a user-invoked `RUN_FOCUS_SPIKE` command that asks the bridge for live target IDs, uses `vscode.window.showQuickPick` to choose a target, sends one focus request, and writes one JSON line prefixed `OPEN_WINDOW_FOCUS_SPIKE` to the existing output channel.

Contribute the command from `spikes/attention-local-bridge/workspace/package.json`:

```json
{ "command": "projectSteward.openWindowFocusSpike", "title": "Project Steward: Run Open Window Focus Spike" }
```

In the UI Bridge, retain the workspace ID received by the existing spike publish command, store requests under `<bridgeRoot>/open-window-focus-spike/`, and let only the matching bridge call `FOCUS_WORKSPACE`. Use atomic files, a 100 ms watch-driven retry, a 3 second source timeout, and ten-second cleanup. Do not call any open-folder or new-window command.

- [ ] **Step 6: Bundle and package the spike**

Run: `npm run attention:package`

Expected: PASS and fresh main/workspace-spike/UI-bridge VSIX files under `artifacts/`.

- [ ] **Step 7: Execute the mandatory matrix**

Install the generated workspace spike and UI bridge into the already available test windows. Run `Project Steward: Open Window Focus Spike` for:

```text
local -> local
local -> SSH
local -> Dev Container
same project window A -> same project window B
20 alternating requests between two targets
request after target close
```

For each case record source ID, target ID, handling ID, `focused`, latency, and live registration count before/after in `docs/superpowers/reports/2026-07-15-open-window-focus-feasibility.md`.

Expected: every live target reports `focused: true`, the handling ID equals the requested target, registration count never increases during switching, and a closed target times out or reports missing without reopening.

- [ ] **Step 8: Apply the hard gate**

If any required topology cannot focus the exact target, mark the report `FAIL`, commit the evidence, and stop. Do not start Task 2.

If every required topology passes, mark the report `PASS` and continue.

- [ ] **Step 9: Commit the spike evidence**

Run:

```bash
git add spikes/attention-local-bridge/shared/focusRelay.ts spikes/attention-local-bridge/workspace/src/extension.ts spikes/attention-local-bridge/workspace/package.json spikes/attention-local-bridge/tsconfig.json extensions/attention-ui-bridge/src/extension.ts scripts/run-attention-local-bridge-spike-checks.js docs/superpowers/reports/2026-07-15-open-window-focus-feasibility.md
git commit -m "test: prove exact VS Code window focus"
```

Expected: one commit containing spike code and its measured report; `.vscode/settings.json` remains unstaged.

---

### Task 2: Define the Production Protocol and Pure Projection

**Files:**
- Create: `src/openWindows/protocol.ts`
- Create: `src/openWindows/projection.ts`
- Modify: `src/models.ts`
- Create: `scripts/run-open-window-safety-checks.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `Project` values produced by `getOpenProjectsFromWorkspace`.
- Produces: `OpenWindowRegistration`, `OpenWindowAggregate`, `WindowFocusRequest`, `WindowFocusResult`, validators, `createOpenWindowSemanticRevision`, `createOpenWindowProjectRecords`, and `projectOpenWindowCards`.

- [ ] **Step 1: Write failing protocol and projection checks**

Create `scripts/run-open-window-safety-checks.js` with assertions for:

```js
function hexId(character) {
    return character.repeat(32);
}

function makeRegistration(instanceId, lastFocusedAtMs, uri) {
    return {
        protocolVersion: 1,
        instanceId,
        sequence: 1,
        lastFocusedAtMs,
        leaseUpdatedAtMs: 5_000,
        projects: [{
            localProjectId: '__openProjects-0',
            ordinal: 0,
            name: 'Shared',
            description: 'Workspace folder',
            uri,
            remoteType: 'local',
        }],
    };
}

const SELF = hexId('1');
const OLDER = hexId('2');
const NEWER = hexId('3');
const current = [{ id: '__openProjects-0', name: 'Current', path: '/work/current', isCurrentWorkspace: true }];
const aggregate = {
    protocolVersion: 1,
    semanticRevision: 'revision',
    observedAtMs: 5_000,
    windows: [
        makeRegistration(SELF, 4_000, '/work/current'),
        makeRegistration(OLDER, 2_000, '/work/shared'),
        makeRegistration(NEWER, 3_000, '/work/shared'),
    ],
};
const cards = projection.projectOpenWindowCards(current, aggregate, SELF);
assert.deepStrictEqual(cards.map(card => card.openWindowInstanceId), [undefined, NEWER, OLDER]);
assert.strictEqual(cards[0].openProjectCardKind, 'current');
assert.strictEqual(cards[1].openProjectCardKind, 'windowNavigation');
assert.strictEqual(cards[1].codexSessions, undefined);
assert.notStrictEqual(cards[1].id, cards[2].id);
assert.match(cards[1].description, /Window [12]/);
```

Also assert exact rejection of unknown keys, more than 100 projects, invalid IDs, invalid remote types, overlong strings, expired focus requests, and non-monotonic timestamps.

- [ ] **Step 2: Add the test command and verify RED**

Add to `package.json`:

```json
"test:open-windows": "npm run test-compile && npm run attention:bridge:compile && node scripts/run-open-window-safety-checks.js",
"test:safety": "npm run test-compile && node scripts/run-ai-session-safety-checks.js && npm run attention:bridge:compile && node scripts/run-open-window-safety-checks.js"
```

Run: `npm run test:open-windows`

Expected: FAIL because `out/openWindows/protocol` and `out/openWindows/projection` do not exist.

- [ ] **Step 3: Implement exact protocol constants and validators**

Create `src/openWindows/protocol.ts` with these exported constants and types:

```ts
export const OPEN_WINDOW_PROTOCOL_VERSION = 1;
export const OPEN_WINDOW_HEARTBEAT_MS = 10_000;
export const OPEN_WINDOW_LEASE_MS = 30_000;
export const WINDOW_FOCUS_REQUEST_TTL_MS = 10_000;
export const WINDOW_FOCUS_RESULT_TTL_MS = 30_000;
export const WINDOW_FOCUS_WAIT_MS = 3_000;
export const MAX_OPEN_WINDOW_PROJECTS = 100;

export type OpenWindowRemoteType = 'local' | 'ssh' | 'wsl' | 'devContainer' | 'remote';
export interface OpenWindowProjectRecord { localProjectId: string; ordinal: number; name: string; description: string; uri: string; remoteType: OpenWindowRemoteType; color?: string; }
export interface OpenWindowRegistration { protocolVersion: 1; instanceId: string; sequence: number; lastFocusedAtMs: number; leaseUpdatedAtMs: number; projects: OpenWindowProjectRecord[]; }
export interface OpenWindowAggregate { protocolVersion: 1; semanticRevision: string; observedAtMs: number; windows: OpenWindowRegistration[]; }
export interface WindowFocusRequest { protocolVersion: 1; requestId: string; sourceInstanceId: string; targetInstanceId: string; createdAtMs: number; }
export interface WindowFocusResult { protocolVersion: 1; requestId: string; sourceInstanceId: string; targetInstanceId: string; completedAtMs: number; success: boolean; errorCode?: 'target-missing' | 'focus-failed' | 'expired'; }
```

Export strict `validateOpenWindowRegistration`, `validateOpenWindowAggregate`, `validateWindowFocusRequest`, and `validateWindowFocusResult` functions. Reject unexpected keys. Export `createOpenWindowSemanticRevision` using SHA-256 over instance ID, last focus time, and project descriptors while excluding sequence and lease times.

- [ ] **Step 4: Add explicit project card metadata**

Extend `Project` in `src/models.ts` with:

```ts
openProjectCardKind?: 'current' | 'windowNavigation';
openWindowInstanceId?: string;
openWindowEnvironmentLabel?: string;
openWindowDuplicateLabel?: string;
```

Do not put sessions or attention state on navigation projections.

- [ ] **Step 5: Implement pure projection**

Create `src/openWindows/projection.ts` exporting:

```ts
export function createOpenWindowProjectRecords(projects: Project[]): OpenWindowProjectRecord[];
export function projectOpenWindowCards(currentProjects: Project[], aggregate: OpenWindowAggregate | null, ownInstanceId: string): Project[];
```

`projectOpenWindowCards` must clone current projects with `openProjectCardKind: 'current'`, exclude the current registration, sort other windows by descending `lastFocusedAtMs`, preserve published ordinal order, namespace IDs as `__openWindow-${instanceId}-${localProjectId}`, and add deterministic `Window N` suffixes only when name and URI collide.

- [ ] **Step 6: Run protocol/projection tests and verify GREEN**

Run: `npm run test:open-windows`

Expected: PASS with final output `Open window safety checks passed.`

- [ ] **Step 7: Commit**

```bash
git add src/openWindows src/models.ts scripts/run-open-window-safety-checks.js package.json
git commit -m "feat: define open window registry protocol"
```

---

### Task 3: Implement the Profile-Local Registry and Focus Store

**Files:**
- Create: `extensions/attention-ui-bridge/src/openWindowStore.ts`
- Modify: `extensions/attention-ui-bridge/tsconfig.json`
- Modify: `scripts/run-open-window-safety-checks.js`

**Interfaces:**
- Consumes: validators and TTL constants from `src/openWindows/protocol.ts`.
- Produces: `OpenWindowStore.writeRegistration`, `removeRegistration`, `scanRegistrations`, `writeFocusRequest`, `scanFocusRequests`, `writeFocusResult`, `readFocusResult`, and `cleanup`.

- [ ] **Step 1: Add failing filesystem safety checks**

Use `fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-open-window-'))` and assert:

```js
const registration = makeRegistration(hexId('4'), 900, '/work/store');
const request = {
    protocolVersion: 1,
    requestId: hexId('5'),
    sourceInstanceId: hexId('6'),
    targetInstanceId: registration.instanceId,
    createdAtMs: 1_000,
};
const result = {
    protocolVersion: 1,
    requestId: request.requestId,
    sourceInstanceId: request.sourceInstanceId,
    targetInstanceId: request.targetInstanceId,
    completedAtMs: 1_100,
    success: true,
};
const now = 1_200;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-open-window-'));
const store = new OpenWindowStore(tempRoot, hexId('b'));
await store.writeRegistration(registration);
assert.deepStrictEqual((await store.scanRegistrations(now)).registrations, [registration]);
await assert.rejects(store.writeRegistration({ ...registration, sequence: registration.sequence - 1 }), /sequence/);
await store.writeFocusRequest(request);
assert.deepStrictEqual(await store.scanFocusRequests(now), [request]);
await store.writeFocusResult(result);
assert.deepStrictEqual(await store.readFocusResult(request.requestId, now), result);
await store.removeRegistration(registration.instanceId);
assert.deepStrictEqual((await store.scanRegistrations(now)).registrations, []);
```

Also create malformed JSON, oversized files, symlinks, expired registrations, expired requests, and expired results and assert that scans ignore/remove them without following symlinks.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:open-windows`

Expected: FAIL because `openWindowStore` does not exist.

- [ ] **Step 3: Implement the store**

Create `OpenWindowStore` rooted at `<bridgeRoot>/open-windows/v1`. Use one file per registration/request/result, `lstat`, exact filename regexes, maximum byte limits, `mode: 0o600`, directory `mode: 0o700`, `flag: 'wx'` for temporary files, and atomic rename.

Use these exact signatures:

```ts
export class OpenWindowStore {
    constructor(rootDirectory: string, writerId: string);
    writeRegistration(value: OpenWindowRegistration): Promise<void>;
    removeRegistration(instanceId: string): Promise<void>;
    scanRegistrations(nowMs: number): Promise<{ registrations: OpenWindowRegistration[]; errors: number }>;
    writeFocusRequest(value: WindowFocusRequest): Promise<void>;
    scanFocusRequests(nowMs: number): Promise<WindowFocusRequest[]>;
    removeFocusRequest(requestId: string): Promise<void>;
    writeFocusResult(value: WindowFocusResult): Promise<void>;
    readFocusResult(requestId: string, nowMs: number): Promise<WindowFocusResult | null>;
    removeFocusResult(requestId: string): Promise<void>;
    cleanup(nowMs: number): Promise<void>;
}
```

Enforce monotonic registration sequence by comparing against the last valid on-disk value before replacement.

- [ ] **Step 4: Include shared protocol in bridge compilation**

Add `../../src/openWindows/protocol.ts` to the bridge `tsconfig.json` `include` array.

- [ ] **Step 5: Run and verify GREEN**

Run: `npm run test:open-windows`

Expected: PASS, including all malformed-file checks.

- [ ] **Step 6: Commit**

```bash
git add extensions/attention-ui-bridge/src/openWindowStore.ts extensions/attention-ui-bridge/tsconfig.json scripts/run-open-window-safety-checks.js
git commit -m "feat: add local open window store"
```

---

### Task 4: Add the Local Bridge Coordinator

**Files:**
- Create: `extensions/attention-ui-bridge/src/openWindowCoordinator.ts`
- Modify: `extensions/attention-ui-bridge/src/extension.ts`
- Modify: `scripts/run-open-window-safety-checks.js`

**Interfaces:**
- Consumes: `OpenWindowStore` and production protocol values.
- Produces: `OpenWindowCoordinator.register`, `unregister`, `scanAndNotify`, `requestFocus`, `handleFocusRequests`, and `dispose`.

- [ ] **Step 1: Add failing coordinator checks with fake hosts**

Construct two coordinators over one temporary root with fake callbacks:

```js
const focused = [];
const aggregates = [];
const now = 1_000;
const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-open-window-coordinator-'));
const storeA = new OpenWindowStore(sharedRoot, hexId('c'));
const storeB = new OpenWindowStore(sharedRoot, hexId('d'));
const SOURCE = hexId('7');
const TARGET = hexId('8');
const source = new OpenWindowCoordinator(storeA, {
    publishAggregate: async value => aggregates.push(['source', value]),
    focusWorkspace: async request => { focused.push(['source', request.targetInstanceId]); },
    now: () => now,
});
const target = new OpenWindowCoordinator(storeB, {
    publishAggregate: async value => aggregates.push(['target', value]),
    focusWorkspace: async request => { focused.push(['target', request.targetInstanceId]); },
    now: () => now,
});
await source.register(makeRegistration(SOURCE, 900, '/work/source'));
await target.register(makeRegistration(TARGET, 950, '/work/target'));
const pending = source.requestFocus(SOURCE, TARGET);
await new Promise(resolve => setImmediate(resolve));
await Promise.all([source.handleFocusRequests(), target.handleFocusRequests()]);
assert.strictEqual((await pending).success, true);
assert.deepStrictEqual(focused, [['target', TARGET]]);
```

Assert semantic aggregate callbacks do not repeat on heartbeat-only changes, only one target handles a request, a fresh source scan rejects a missing target, and a focus exception returns `focus-failed` without opening anything.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:open-windows`

Expected: FAIL because `openWindowCoordinator` does not exist.

- [ ] **Step 3: Implement the coordinator with injectable time and timers**

Use this constructor contract:

```ts
export interface OpenWindowCoordinatorHost {
    publishAggregate(value: OpenWindowAggregate): Promise<void>;
    focusWorkspace(request: WindowFocusRequest): Promise<void>;
    now(): number;
}

export class OpenWindowCoordinator {
    constructor(store: OpenWindowStore, host: OpenWindowCoordinatorHost);
    register(value: OpenWindowRegistration): Promise<void>;
    unregister(instanceId: string): Promise<void>;
    scanAndNotify(): Promise<void>;
    requestFocus(sourceInstanceId: string, targetInstanceId: string): Promise<WindowFocusResult>;
    handleFocusRequests(): Promise<void>;
    dispose(): void;
}
```

Track the one `boundWorkspaceInstanceId` established by `register`. `handleFocusRequests` must skip all nonmatching targets. `requestFocus` must rescan live registrations before writing, then poll/watch for at most 3 seconds. Serialize scans through one in-flight promise.

- [ ] **Step 4: Wire private production commands**

In the UI Bridge extension register:

```ts
const OPEN_WINDOWS_REGISTER = '_projectStewardOpenWindows.bridge.register';
const OPEN_WINDOWS_UNREGISTER = '_projectStewardOpenWindows.bridge.unregister';
const OPEN_WINDOWS_FOCUS = '_projectStewardOpenWindows.bridge.focus';
const OPEN_WINDOWS_AGGREGATE = '_projectStewardOpenWindows.workspace.aggregate';
const OPEN_WINDOWS_WORKSPACE_FOCUS = '_projectStewardOpenWindows.workspace.focus';
```

Instantiate the coordinator with the Profile-local bridge root. Use `fs.watch` on registry and request directories plus a 2-second recovery scan. On dispose, remove the bound registration best-effort and stop watchers/timers.

- [ ] **Step 5: Run and verify GREEN**

Run: `npm run test:open-windows`

Expected: PASS and TypeScript compilation succeeds for both extensions.

- [ ] **Step 6: Commit**

```bash
git add extensions/attention-ui-bridge/src/openWindowCoordinator.ts extensions/attention-ui-bridge/src/extension.ts scripts/run-open-window-safety-checks.js
git commit -m "feat: coordinate open windows through local bridge"
```

---

### Task 5: Add the Workspace Registry Client and Lifecycle

**Files:**
- Create: `src/openWindows/bridgeClient.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-open-window-safety-checks.js`

**Interfaces:**
- Consumes: current plain open projects, production private bridge commands, and registry aggregates.
- Produces: `OpenWindowBridgeClient.instanceId`, `publish`, `focusWindow`, `getAggregate`, and `dispose`.

- [ ] **Step 1: Add failing bridge-client checks with a mocked `vscode` module**

Assert that:

```js
await client.publish(true);
assert.strictEqual(sent[0].command, '_projectStewardOpenWindows.bridge.register');
assert.strictEqual(sent[0].payload.projects[0].name, 'Current');
clock.advance(10_000);
await heartbeat();
assert.ok(sent[1].payload.sequence > sent[0].payload.sequence);
const REQUEST = hexId('9');
const OTHER = hexId('a');
await workspaceFocusHandler({ targetInstanceId: client.instanceId, requestId: REQUEST });
assert.ok(executedCommands.includes('workbench.action.focusWindow'));
await assert.rejects(
    workspaceFocusHandler({ targetInstanceId: OTHER, requestId: REQUEST }),
    /target mismatch/
);
```

Also assert one outstanding source focus request, aggregate validation, focus-state timestamp changes only on `focused: true`, and unregister on dispose.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:open-windows`

Expected: FAIL because `bridgeClient` does not exist.

- [ ] **Step 3: Implement `OpenWindowBridgeClient`**

Use this public contract:

```ts
export default class OpenWindowBridgeClient implements vscode.Disposable {
    readonly instanceId: string;
    constructor(options: {
        getProjects: () => Project[];
        onAggregate: (aggregate: OpenWindowAggregate) => void;
        onError: (error: unknown) => void;
    });
    publish(forceHeartbeat?: boolean): Promise<boolean>;
    focusWindow(targetInstanceId: string): Promise<WindowFocusResult>;
    getAggregate(): OpenWindowAggregate | null;
    dispose(): void;
}
```

Generate a 32-character random hexadecimal instance ID. Register the aggregate and target-focus private commands before the first publish. Keep a ten-second heartbeat, publish immediately, republish on `vscode.window.onDidChangeWindowState` only when focus becomes true, and unregister best-effort during disposal. Rate-limit repeated error logs to one per minute.

Initialize `lastFocusedAtMs` to `Date.now()` only when `vscode.window.state.focused` is true; otherwise initialize it to `0`. Heartbeats update `leaseUpdatedAtMs` and sequence without changing `lastFocusedAtMs`.

- [ ] **Step 4: Separate plain and session-decorated current projects**

In `src/dashboard.ts`, extract:

```ts
function getCurrentWorkspaceOpenProjects(): Project[] {
    return getOpenProjectsFromWorkspace(vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders, {
        savedProjects: projectService.getProjectsFlat(),
        currentRemoteName: vscode.env.remoteName,
        isFolderGitRepo,
    });
}

function getOpenProjects(): Project[] {
    return withAiSessions(getCurrentWorkspaceOpenProjects());
}
```

The bridge publisher must call `getCurrentWorkspaceOpenProjects`, never `getOpenProjects`, so other-window discovery does not scan session history.

- [ ] **Step 5: Wire aggregate state and mutation refreshes**

Store the last aggregate in `dashboard.ts`. On semantic revision change, call `refreshStewardViews()`. On workspace-folder changes and after project metadata mutations, call `openWindowBridgeClient.publish()` in addition to the existing view refresh. Add the client to `context.subscriptions`.

- [ ] **Step 6: Run and verify GREEN**

Run: `npm run test:open-windows`

Expected: PASS, including heartbeat, target validation, and no-session-scan assertions.

- [ ] **Step 7: Commit**

```bash
git add src/openWindows/bridgeClient.ts src/dashboard.ts scripts/run-open-window-safety-checks.js
git commit -m "feat: publish live Project Steward windows"
```

---

### Task 6: Project Current and Navigation Cards into OPEN PROJECT

**Files:**
- Modify: `src/dashboard.ts`
- Modify: `src/projects/currentWorkspaceState.ts`
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `media/styles.scss`
- Modify: `media/styles.css` through Gulp
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: `projectOpenWindowCards`, the current aggregate, and `OpenWindowBridgeClient.focusWindow`.
- Produces: combined `StewardInfos.openProjects`, navigation-only DOM cards, and `focus-open-window` Webview messages.

- [ ] **Step 1: Add failing projection/rendering checks**

In `scripts/run-ai-session-safety-checks.js`, render one current project and one navigation project and assert:

```js
assert.match(html, /data-open-project/);
assert.match(html, /data-window-navigation-project/);
assert.match(html, /data-target-window-instance="[a-f0-9]{32}"/);
const navigationHtml = html.slice(html.indexOf('data-window-navigation-project'));
assert.doesNotMatch(navigationHtml, /codex-sessions/);
assert.doesNotMatch(navigationHtml, /project-codex-badge/);
assert.doesNotMatch(navigationHtml, /project-save-badge/);
assert.doesNotMatch(navigationHtml, /project-favorite-badge/);
```

Load `src/webview/webviewProjectScripts.js` in the existing VM harness, click a navigation card with Ctrl/Cmd and middle-button variants, and assert every case posts only:

```js
{ type: 'focus-open-window', targetInstanceId: '...' }
```

Assert current cards still call `toggleCodexSessions`.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:safety`

Expected: FAIL because navigation card rendering and click handling do not exist.

- [ ] **Step 3: Build the combined card list only for the view**

Change the `StewardInfos.openProjects` getter to:

```ts
get openProjects() {
    return projectOpenWindowCards(
        getOpenProjects(),
        openWindowBridgeClient.getAggregate(),
        openWindowBridgeClient.instanceId
    );
}
```

Keep every session assignment, terminal resolution, archive operation, and incremental AI-session update scoped to `getOpenProjects()` so navigation cards never become session targets.

- [ ] **Step 4: Preserve current-workspace state only for current cards**

Update `withCurrentWorkspaceState` so:

```ts
isCurrentWorkspace: project.openProjectCardKind !== 'windowNavigation'
```

Navigation cards must remain false even when their URI matches a saved project in the current window.

- [ ] **Step 5: Render explicit card kinds**

In `getProjectDiv`, derive:

```ts
const isWindowNavigation = project.openProjectCardKind === 'windowNavigation';
const isCurrentOpenProject = isReadOnlyProject && !isWindowNavigation;
```

Only current cards receive `data-open-project`, AI badges, and `getAiSessionsDiv`. Navigation cards receive `data-window-navigation-project`, `data-target-window-instance`, `title="Switch to this window"`, and no actions or session markup. Render their secondary line as:

```ts
const navigationDescription = [project.openWindowEnvironmentLabel, project.openWindowDuplicateLabel]
    .filter(value => !!value)
    .join(' · ');
```

Both card kinds remain non-draggable and context-menu-free.

- [ ] **Step 6: Send only a focus message from navigation clicks**

Before the current `data-open-project` branch in `onInsideProjectClick`, add:

```js
if (projectDiv.hasAttribute('data-window-navigation-project')) {
    var targetInstanceId = projectDiv.getAttribute('data-target-window-instance');
    if (targetInstanceId) {
        window.vscode.postMessage({ type: 'focus-open-window', targetInstanceId });
    }
    return;
}
```

This branch must ignore mouse button and modifier state and must run before all generic project opening logic.

- [ ] **Step 7: Handle focus results without any open fallback**

Add a `focus-open-window` case to `handleStewardMessage`:

```ts
const result = await openWindowBridgeClient.focusWindow(String(e.targetInstanceId || ''));
if (!result.success) {
    if (result.errorCode === 'target-missing') refreshStewardViews();
    vscode.window.showWarningMessage(
        result.errorCode === 'target-missing'
            ? 'Target window is no longer available.'
            : 'Project Steward could not focus the target window.'
    );
}
```

Do not call `openProject` in this case.

- [ ] **Step 8: Add the minimal navigation affordance**

In `media/styles.scss`, add a navigation-card selector that uses existing VS Code theme variables for a subtle environment label and focus-border hover. Do not add session or attention badges. Regenerate CSS with:

Run: `npx gulp`

Expected: `media/styles.css` changes only through compiled SCSS output.

- [ ] **Step 9: Run and verify GREEN**

Run: `npm run test:safety`

Expected: PASS with `AI session safety checks passed.` and `Open window safety checks passed.`

- [ ] **Step 10: Commit**

```bash
git add src/dashboard.ts src/projects/currentWorkspaceState.ts src/webview/webviewContent.ts src/webview/webviewProjectScripts.js media/styles.scss media/styles.css scripts/run-ai-session-safety-checks.js package.json
git commit -m "feat: show live windows in open project"
```

---

### Task 7: Remove Spike Scaffolding and Verify Production Behavior

**Files:**
- Modify: `spikes/attention-local-bridge/workspace/src/extension.ts`
- Delete: `spikes/attention-local-bridge/shared/focusRelay.ts`
- Modify: `extensions/attention-ui-bridge/src/extension.ts`
- Modify: `spikes/attention-local-bridge/tsconfig.json`
- Modify: `scripts/run-attention-local-bridge-spike-checks.js`
- Modify: `docs/superpowers/reports/2026-07-15-open-window-focus-feasibility.md`

**Interfaces:**
- Consumes: the completed production registry and focus relay.
- Produces: production-only packages with retained feasibility evidence and no temporary commands or directories.

- [ ] **Step 1: Replace temporary spike execution with production checks**

Remove `_projectStewardOpenWindowSpike.*`, `projectSteward.openWindowFocusSpike`, and `<bridgeRoot>/open-window-focus-spike`. Keep the feasibility report unchanged except for a final line naming the production commits that replaced the spike.

- [ ] **Step 2: Update safety scripts after spike removal**

Remove `runFocusRelayChecks` and its temporary import from `scripts/run-attention-local-bridge-spike-checks.js`. The equivalent protocol, target-matching, TTL, timeout, and no-fallback checks must remain in `scripts/run-open-window-safety-checks.js`.

- [ ] **Step 3: Run the full automated suite**

Run:

```bash
npm run test:safety
npm run spike:attention:test
npm run webpack
npm run attention:bridge:bundle
npm run lint
```

Expected:

```text
AI session safety checks passed.
Open window safety checks passed.
Attention local bridge spike checks passed.
webpack exits 0 for the main extension.
bridge Webpack exits 0.
TSLint exits 0, or reports only the repository's documented pre-existing warnings with zero errors.
```

- [ ] **Step 4: Package both extensions**

Run: `npm run attention:package`

Expected: both main and UI Bridge VSIX artifacts are created and contain the production open-window modules, with no temporary spike module.

- [ ] **Step 5: Run the production acceptance matrix**

Install the production packages and verify:

```text
current cards are first and expand sessions
other local/SSH/Dev Container cards appear without session UI
other cards follow recent focus order
same project in two windows produces two cards
each navigation card focuses its exact target
20 alternating switches create no extra registration/window
closed target disappears immediately or within 30 seconds
failed switch never opens a project
hidden sidebar does not stop registration heartbeat
navigation-only windows do not increase provider session scans
```

Record any environment-specific latency or failure in the feasibility report. A production failure reopens the responsible task; it is not accepted as a compatibility limitation.

- [ ] **Step 6: Review the complete diff**

Run:

```bash
git diff --check
git status --short
git diff --stat ai-session-attention-first-usable..HEAD
```

Expected: no whitespace errors; only intended source, tests, generated CSS, report, spec, and plan files are changed; `.vscode/settings.json` remains unstaged.

- [ ] **Step 7: Commit cleanup and verification evidence**

```bash
git add spikes/attention-local-bridge/workspace/src/extension.ts spikes/attention-local-bridge/workspace/package.json spikes/attention-local-bridge/tsconfig.json spikes/attention-local-bridge/shared/focusRelay.ts extensions/attention-ui-bridge/src/extension.ts scripts/run-attention-local-bridge-spike-checks.js scripts/run-open-window-safety-checks.js docs/superpowers/reports/2026-07-15-open-window-focus-feasibility.md
git commit -m "test: verify cross-window project switching"
```

Do not stage a path that has no actual change, and do not stage `.vscode/settings.json`.

---

## Final Review Checklist

- [ ] The feasibility report is `PASS` for local, SSH, Dev Container, duplicate-project, repeated-switch, and closed-target cases.
- [ ] Current cards alone contain `data-open-project` and session markup.
- [ ] Navigation cards alone contain `data-window-navigation-project` and exact target IDs.
- [ ] No navigation-card code path reaches `openProject`, `vscode.openFolder`, or `vscode.newWindow`.
- [ ] Other-window aggregation excludes the current instance and never deduplicates distinct windows.
- [ ] Heartbeats do not change semantic revision or rebuild the Webview.
- [ ] Registration, request, and result files are bounded, validated, atomically replaced, and symlink-safe.
- [ ] Normal close unregisters; abnormal close expires within 30 seconds.
- [ ] Main and bridge packages build and install together without compatibility branches.
- [ ] All automated commands have fresh passing output.
- [ ] `.vscode/settings.json` is neither staged nor committed.
