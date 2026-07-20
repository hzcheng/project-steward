# Tmux Focused Session Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Project Steward update the Focused AI-session row immediately after an explicit focus and within one second after a project-layout tmux window change.

**Architecture:** Keep Direct Terminal and tmux session-layout focus tied to the active VS Code terminal. Add a bounded `TmuxClient.getActiveWindow` query, let `TmuxRuntimeBackend` reconcile a separate in-memory project-layout focused binding, and drive that reconciliation through a visibility-gated single-flight `TmuxFocusedRuntimeMonitor`. Explicit terminal commands refresh immediately after successful focus.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js assertion-based safety checks, tmux fake and real smoke harnesses.

## Global Constraints

- Dashboard-visible project-layout tmux changes must appear within one second.
- Direct Terminal and tmux session layout remain active-terminal driven and are not polled.
- A project-layout unmanaged active window means no focused AI session.
- A transient tmux query failure preserves the prior focused identity.
- Stable focused identity must not trigger a Dashboard refresh.
- Focus polling must be single-flight and stop issuing work while the Dashboard is hidden.
- Do not infer focus from runtime liveness, execution state, attention state, or pane health.
- Diagnostics must not include executable paths, tmux session/window names, commands, prompts, responses, or raw exception messages.

---

### Task 1: Refresh after a successful explicit focus

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js` in `runAiSessionTerminalCommandControllerChecks`
- Modify: `src/aiSessions/terminalCommandController.ts`

**Interfaces:**
- Consumes: `AiSessionTerminalCommandControllerCommonOptions.refresh(): void`.
- Produces: successful active, pending, legacy, and conflict-selected focus paths request an immediate refresh.

- [ ] **Step 1: Write failing success-only refresh tests**

Extend the existing legacy assertions:

```js
await controller.focusPending('app', 'claude', '2026-07-18T03:00:00Z');
assert.deepStrictEqual(refreshes, ['refresh']);
await controller.focusActive('app', 'codex', 'c1');
assert.deepStrictEqual(refreshes, ['refresh', 'refresh']);
await controller.focusActive('app', 'kimi', 'historyless');
assert.deepStrictEqual(refreshes, ['refresh', 'refresh', 'refresh']);
```

Because those three focus calls now refresh, change the later legacy close assertions from `1`, `2`, and `2` to `4`, `5`, and `5` respectively.

Add a runtime controller fixture with one active runtime and one pending runtime. Keep candidates and the selection result mutable so the successful and stale-selection branches can be asserted independently:

```js
const runtimeRefreshes = [];
const runtimeAnnouncements = [];
let runtimeCandidates;
let focusSelectedResult = true;
const runtime = {
    identity: { provider: 'codex', sessionId: 'c1', projectKey: 'key:/work/app', cwd: '/work/app' },
    backend: 'tmux', state: 'active', markerPath: '/tmp/c1.done', runStartedAtMs: 1,
    attached: true,
    tmux: { layout: 'project', sessionName: 'project-steward-p-app', windowName: 'ai-codex-c1' },
};
const runtimePending = {
    identity: { provider: 'claude', pendingId: 'pending-1', projectKey: 'key:/work/app', cwd: '/work/app' },
    backend: 'tmux', state: 'pending', markerPath: '/tmp/pending.done', runStartedAtMs: 2,
    attached: true, createdAt: '2026-07-20T00:00:00.000Z', excludedSessionIds: [],
    tmux: { layout: 'project', sessionName: 'project-steward-p-app', windowName: 'pending-claude-1' },
};
const runtimeController = new AiSessionTerminalCommandController({
    isProviderId: value => value === 'codex' || value === 'kimi' || value === 'claude',
    getOpenProjects: () => [{
        id: 'app', path: '/work/app', codexSessions: [{ id: 'c1' }],
        kimiSessions: [], claudeSessions: [],
    }],
    getProjectSessions: (project, providerId) => project[`${providerId}Sessions`] || [],
    getProjectKey: project => `key:${project.path}`,
    getProjectCwd: project => project.path,
    normalizePath: value => value,
    runtimeCoordinator: {
        getById: (_providerId, sessionId) => sessionId === 'c1' ? runtime : null,
        getActiveCandidates: (_providerId, sessionId) => sessionId === 'c1'
            ? (runtimeCandidates || [runtime]) : [],
        getUnverifiedConflicts: () => [],
        getPending: () => [runtimePending],
        focus: async () => undefined,
        focusSelected: async () => focusSelectedResult,
        detach: async () => undefined,
    },
    confirmRuntimeClose: async () => undefined,
    chooseRuntimeConflict: async runtimes => runtimes[0],
    announceStatus: async (_projectId, message) => runtimeAnnouncements.push(message),
    showErrorMessage: async () => undefined,
    getProviderLabel: providerId => providerId.toUpperCase(),
    refresh: () => runtimeRefreshes.push('refresh'),
});
await runtimeController.focusActive('app', 'codex', 'c1');
await runtimeController.focusPending('app', 'claude', '2026-07-20T00:00:00.000Z');
assert.deepStrictEqual(runtimeRefreshes, ['refresh', 'refresh']);

runtimeCandidates = [{ ...runtime, state: 'conflict' }];
await runtimeController.focusActive('app', 'codex', 'c1');
assert.deepStrictEqual(runtimeRefreshes, ['refresh', 'refresh', 'refresh']);

focusSelectedResult = false;
await runtimeController.focusActive('app', 'codex', 'c1');
assert.strictEqual(runtimeRefreshes.length, 4,
    'a stale selected runtime keeps its existing invalidation refresh without adding a success refresh');
assert.strictEqual(runtimeAnnouncements.length, 1);

runtimeCandidates = [];
await runtimeController.focusActive('app', 'codex', 'missing');
await runtimeController.focusPending('app', 'claude', 'missing');
assert.strictEqual(runtimeRefreshes.length, 4, 'missing targets must not refresh');
```

- [ ] **Step 2: Run the safety check and verify RED**

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL on the first new focus-refresh assertion because success currently relies on a VS Code terminal-change event.

- [ ] **Step 3: Implement success refreshes**

In runtime active and pending paths:

```ts
await this.options.runtimeCoordinator.focus({ ...runtime.identity });
this.options.refresh();
```

In conflict selection:

```ts
const focused = await options.runtimeCoordinator.focusSelected(cloneRuntime(selected));
if (!focused) {
    options.refresh();
    await options.announceStatus(
        projectId,
        'The selected AI session runtime changed before it could be focused.'
    );
    return;
}
options.refresh();
```

In both legacy paths, keep the scoped lookup and refresh only after `terminal.show()`:

```ts
const terminal = this.getScopedActiveTerminal(projectId, providerId, sessionId, this.options);
if (terminal) {
    terminal.show();
    this.options.refresh();
}
```

Use `getScopedPendingTerminal(...)` in `focusPending`. Keep refresh calls inside successful `if (terminal)` / runtime `try` blocks; invalid or missing targets return without refreshing. Preserve the existing single refresh for a rejected conflict selection or thrown runtime focus because those paths invalidate stale state.

- [ ] **Step 4: Run the safety check and verify GREEN**

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: `AI session safety checks passed.`

- [ ] **Step 5: Commit Task 1**

```bash
git add src/aiSessions/terminalCommandController.ts scripts/run-ai-session-safety-checks.js
git commit -m "fix: refresh focused session after terminal action"
```

---

### Task 2: Query one tmux session's active window

**Files:**
- Modify: `src/aiSessions/tmuxClient.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js` in `runTmuxClientChecks`

**Interfaces:**
- Produces: `TmuxActiveWindowRecord` and `TmuxClient.getActiveWindow(sessionName: string): Promise<TmuxActiveWindowRecord | null>`.
- Consumes: bounded `parseWindowRows`, `isMissingSessionResult`, `TmuxClientError`, and argument-array execution.

- [ ] **Step 1: Write failing active-window client tests**

```js
const activeWindowCalls = [];
let activeWindowResult = {
    exitCode: 0,
    stdout: [
        'project-session\u001fbase\u001f@1\u001f0',
        'project-session\u001fai-codex-a\u001f@2\u001f1',
    ].join('\n') + '\n',
    stderr: '',
};
const activeWindowClient = new tmuxClientModule.TmuxClient('/opt/private/tmux', {
    run: async (_file, args) => {
        activeWindowCalls.push(args);
        if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.2a\n', stderr: '' };
        if (args[0] === 'list-commands') {
            return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
        }
        return activeWindowResult;
    },
});
assert.deepStrictEqual(await activeWindowClient.getActiveWindow('project-session'), {
    sessionName: 'project-session', windowName: 'ai-codex-a', windowId: '@2',
});
assert.deepStrictEqual(activeWindowCalls.slice(-1)[0], [
    'list-windows', '-t', 'project-session', '-F',
    '#{session_name}\u001f#{window_name}\u001f#{window_id}\u001f#{window_active}',
]);

activeWindowResult = { exitCode: 0, stdout: '', stderr: '' };
assert.strictEqual(await activeWindowClient.getActiveWindow('project-session'), null);

activeWindowResult = {
    exitCode: 0,
    stdout: [
        'project-session\u001fa\u001f@1\u001f1',
        'project-session\u001fb\u001f@2\u001f1',
    ].join('\n') + '\n',
    stderr: '',
};
await assert.rejects(activeWindowClient.getActiveWindow('project-session'), error =>
    error.operation === 'get-active-window' && error.category === 'invalid-output');

activeWindowResult = {
    exitCode: 0,
    stdout: 'foreign-session\u001fa\u001f@1\u001f1\n',
    stderr: '',
};
await assert.rejects(activeWindowClient.getActiveWindow('project-session'), error =>
    error.operation === 'get-active-window' && error.category === 'invalid-output');

activeWindowResult = { exitCode: 0, stdout: 'x'.repeat(1024 * 1024 + 1), stderr: '' };
await assert.rejects(activeWindowClient.getActiveWindow('project-session'), error =>
    error.operation === 'get-active-window' && error.category === 'invalid-output');

activeWindowResult = { exitCode: 1, stdout: '', stderr: "can't find session: project-session" };
assert.strictEqual(await activeWindowClient.getActiveWindow('project-session'), null);

activeWindowResult = {
    exitCode: 2,
    stdout: 'secret stdout',
    stderr: 'secret stderr for project-session',
};
await assert.rejects(activeWindowClient.getActiveWindow('project-session'), error => {
    assert.strictEqual(error.operation, 'get-active-window');
    assert.strictEqual(error.category, 'nonzero-exit');
    for (const secret of ['project-session', 'secret stdout', 'secret stderr', '/opt/private/tmux']) {
        assert.ok(!error.message.includes(secret));
    }
    return true;
});
await assert.rejects(activeWindowClient.getActiveWindow('bad\nsession'), TypeError);
```

- [ ] **Step 2: Run tmux checks and verify RED**

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: FAIL with `TypeError: activeWindowClient.getActiveWindow is not a function`.

- [ ] **Step 3: Implement the bounded targeted query**

```ts
export interface TmuxActiveWindowRecord {
    sessionName: string;
    windowName: string;
    windowId: string;
}
```

Add `'get-active-window'` to `TmuxOperation`, then implement:

```ts
async getActiveWindow(sessionName: string): Promise<TmuxActiveWindowRecord | null> {
    if (typeof sessionName !== 'string' || !isTargetField(sessionName)) {
        throw new TypeError('The tmux session name is invalid.');
    }
    await this.requireAvailable();
    const result = await this.invoke('get-active-window', [
        'list-windows', '-t', sessionName, '-F', LIST_WINDOWS_FORMAT,
    ]);
    if (result.exitCode !== 0) {
        if (isMissingSessionResult(result)) {
            return null;
        }
        throw resultError('get-active-window', result);
    }
    const rows = parseWindowRows(result.stdout, 'get-active-window');
    if (rows.some(row => row.sessionName !== sessionName)) {
        throw new TmuxClientError('get-active-window', 'invalid-output');
    }
    const active = rows.filter(row => row.active);
    if (active.length > 1) {
        throw new TmuxClientError('get-active-window', 'invalid-output');
    }
    return active.length ? {
        sessionName: active[0].sessionName,
        windowName: active[0].windowName,
        windowId: active[0].windowId,
    } : null;
}
```

Give `parseWindowRows` an optional `TmuxOperation = 'list-windows'` parameter and use it for every `invalid-output` error.

- [ ] **Step 4: Run tmux checks and verify GREEN**

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: `AI session tmux checks passed.`

- [ ] **Step 5: Commit Task 2**

```bash
git add src/aiSessions/tmuxClient.ts scripts/run-ai-session-tmux-checks.js
git commit -m "feat: query focused tmux window"
```

---

### Task 3: Reconcile the backend's project-layout focused binding

**Files:**
- Modify: `src/aiSessions/tmuxRuntimeBackend.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js` in `createTmuxBackendHarness` and backend checks

**Interfaces:**
- Consumes: `TmuxClient.getActiveWindow(sessionName)` from Task 2.
- Produces: `TmuxFocusedRuntimeSyncResult` and `TmuxRuntimeBackend.syncFocusedRuntime(terminal)`.

- [ ] **Step 1: Extend the fake client and write failing reconciliation tests**

Add `let activeWindowError = null;` beside the other harness failure counters, then add to the fake client:

```js
getActiveWindow: async sessionName => {
    operations.push({ type: 'get-active-window', sessionName });
    if (activeWindowError) {
        const error = activeWindowError;
        activeWindowError = null;
        throw error;
    }
    const activeRows = windows.filter(row => row.sessionName === sessionName && row.active);
    return activeRows.length === 1 ? {
        sessionName: activeRows[0].sessionName,
        windowName: activeRows[0].windowName,
        windowId: activeRows[0].windowId,
    } : null;
},
```

Expose `failNextActiveWindow(error) { activeWindowError = error; }` in the harness return object.

After the two-runtime project-layout focus test, change the fake active row without calling backend `focus`:

```js
projectHarness.windows.forEach(row => {
    row.active = row.sessionName === secondProject.tmux.sessionName
        && row.windowName === firstProject.tmux.windowName;
});
const manualSwitch = await projectBackend.syncFocusedRuntime(projectHarness.terminals[1]);
assert.strictEqual(manualSwitch.monitored, true);
assert.strictEqual(manualSwitch.changed, true);
assert.strictEqual(manualSwitch.identity.sessionId, 's1');
assert.strictEqual(projectBackend.getFocusedRuntime(projectHarness.terminals[1]).identity.sessionId, 's1');
assert.strictEqual((await projectBackend.syncFocusedRuntime(projectHarness.terminals[1])).changed, false);

projectHarness.windows.forEach(row => { row.active = false; });
projectHarness.windows.push({
    sessionName: firstProject.tmux.sessionName,
    windowName: 'base',
    windowId: '@999',
    active: true,
    sessionMetadata: {}, windowMetadata: {}, metadata: {},
});
const unmanaged = await projectBackend.syncFocusedRuntime(projectHarness.terminals[1]);
assert.deepStrictEqual(unmanaged, { monitored: true, changed: true, identity: null });
assert.strictEqual(projectBackend.getFocusedRuntime(projectHarness.terminals[1]), null);

projectHarness.windows.forEach(row => {
    row.active = row.sessionName === firstProject.tmux.sessionName
        && row.windowName === firstProject.tmux.windowName;
});
await projectBackend.syncFocusedRuntime(projectHarness.terminals[1]);
projectHarness.windows.forEach(row => {
    row.active = row.sessionName === secondProject.tmux.sessionName
        && row.windowName === secondProject.tmux.windowName;
});
projectHarness.failNextActiveWindow(new Error('query failed with private tmux details'));
await assert.rejects(projectBackend.syncFocusedRuntime(projectHarness.terminals[1]), /query failed/);
assert.strictEqual(projectBackend.getFocusedRuntime(projectHarness.terminals[1]).identity.sessionId, 's1',
    'query failure must preserve the last verified focus');
```

Add a dedicated session-layout assertion:

```js
const sessionFocusHarness = createTmuxBackendHarness();
const sessionFocusBackend = new backendModule.TmuxRuntimeBackend(sessionFocusHarness.dependencies);
const sessionFocusRuntime = await sessionFocusBackend.ensureResume({
    identity: { provider: 'codex', projectKey: 'session-focus', cwd: '/work', sessionId: 'sf1' },
    projectName: 'App', terminalName: 'Codex: sf1',
    launch: { executable: 'codex', args: ['resume', 'sf1'], markerPath: '/tmp/sf1' },
}, 'session');
const queryCount = sessionFocusHarness.operations.filter(item => item.type === 'get-active-window').length;
assert.deepStrictEqual(await sessionFocusBackend.syncFocusedRuntime(sessionFocusRuntime.terminal), {
    monitored: false, changed: false, identity: { ...sessionFocusRuntime.identity },
});
assert.strictEqual(sessionFocusHarness.operations.filter(item => item.type === 'get-active-window').length,
    queryCount, 'session layout must remain active-terminal driven');
```

In the existing `projectPromotionBackend` test, immediately before promotion assert the pending runtime is focused, then prove the same attach follows the renamed final window:

```js
const projectPromotionTerminal = projectPending.terminal;
assert.strictEqual(projectPromotionBackend.getFocusedRuntime(projectPromotionTerminal)
    .identity.pendingId, 'project-pending');
const projectPromoted = await projectPromotionBackend.promotePending('project-pending', 'project-final');
assert.strictEqual(projectPromotionBackend.getFocusedRuntime(projectPromotionTerminal)
    .identity.sessionId, 'project-final');
assert.strictEqual(projectPromotionHarness.attachBindings.get(await projectPromotionTerminal.processId)
    .windowName, projectPromoted[0].tmux.windowName);
```

- [ ] **Step 2: Run tmux checks and verify RED**

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: FAIL with `TypeError: projectBackend.syncFocusedRuntime is not a function`.

- [ ] **Step 3: Add the separate in-memory focused binding**

```ts
interface AttachEntry<TTerminal> {
    terminal: TTerminal;
    binding: TmuxAttachBinding;
    focusedBinding?: TmuxAttachBinding | null;
}

export interface TmuxFocusedRuntimeSyncResult {
    monitored: boolean;
    changed: boolean;
    identity: AiSessionRuntimeIdentity | null;
}
```

In `attachAndFocus`, construct the selected binding once and assign it to both `binding` and `focusedBinding` for a new entry; for a reused entry update both fields after `selectWindow` succeeds. In restoration, store `{ terminal, binding, focusedBinding: binding }`.

Update `getFocusedRuntime` with an explicit undefined check so `null` means “known unmanaged window” rather than falling back:

```ts
const binding = entry?.focusedBinding !== undefined
    ? entry.focusedBinding
    : entry?.binding;
const runtime = binding ? this.runtimeForBinding(binding) : undefined;
```

- [ ] **Step 4: Implement targeted reconciliation**

```ts
async syncFocusedRuntime(
    terminal: TTerminal | null | undefined
): Promise<TmuxFocusedRuntimeSyncResult> {
    const entry = terminal
        ? [...this.attaches.values()].find(candidate => candidate.terminal === terminal)
        : undefined;
    const previous = this.getFocusedRuntime(terminal);
    if (!entry || entry.binding.layout !== 'project') {
        return {
            monitored: false, changed: false,
            identity: previous ? { ...previous.identity } : null,
        };
    }
    const activeWindow = await this.dependencies.client.getActiveWindow(entry.binding.sessionName);
    const matches = activeWindow ? [
        ...this.dependencies.discovery.getActive(),
        ...this.dependencies.discovery.getPending(),
    ].filter(runtime => runtime.tmux?.layout === 'project'
        && runtime.identity.projectKey === entry.binding.projectKey
        && runtime.tmux.sessionName === activeWindow.sessionName
        && runtime.tmux.windowName === activeWindow.windowName) : [];
    if (matches.length > 1) {
        throw new Error('The active tmux window maps to multiple managed runtimes.');
    }
    const next = matches[0];
    entry.focusedBinding = next
        ? attachBinding(next, entry.binding.terminalNamePrefix)
        : null;
    return {
        monitored: true,
        changed: !runtimeIdentityEquals(previous?.identity || null, next?.identity || null),
        identity: next ? { ...next.identity } : null,
    };
}
```

Use this exact identity comparator; do not compare cwd or terminal objects:

```ts
function runtimeIdentityEquals(
    left: AiSessionRuntimeIdentity | null,
    right: AiSessionRuntimeIdentity | null
): boolean {
    if (!left || !right) {
        return left === right;
    }
    return left.provider === right.provider
        && left.projectKey === right.projectKey
        && left.sessionId === right.sessionId
        && left.pendingId === right.pendingId;
}
```

Filter reconciliation matches by `runtime.identity.projectKey === entry.binding.projectKey` in addition to layout/session/window. This prevents a corrupt duplicate locator from crossing project ownership.

Add this locator-scoped helper:

```ts
function bindingTargetsRuntime(
    binding: TmuxAttachBinding | null | undefined,
    runtime: AiSessionRuntimeSnapshot
): boolean {
    if (!binding || !runtime.tmux
        || binding.layout !== runtime.tmux.layout
        || binding.projectKey !== runtime.identity.projectKey
        || binding.sessionName !== runtime.tmux.sessionName) {
        return false;
    }
    if (binding.layout === 'project') {
        return binding.windowName === runtime.tmux.windowName;
    }
    return (!binding.provider || binding.provider === runtime.identity.provider)
        && (!binding.sessionId || binding.sessionId === runtime.identity.sessionId);
}
```

Rewrite `migrateAttach` without the current `oldKey === newKey` early return:

```ts
const entry = this.attaches.get(oldKey);
if (!entry) {
    return;
}
const nextBinding = attachBinding(promoted, entry.binding.terminalNamePrefix);
const updatePersisted = bindingTargetsRuntime(entry.binding, pending);
const updateFocused = entry.focusedBinding !== undefined
    && bindingTargetsRuntime(entry.focusedBinding, pending);
if (oldKey !== newKey) {
    this.attaches.delete(oldKey);
    this.attaches.set(newKey, entry);
}
if (updatePersisted) {
    entry.binding = nextBinding;
    this.dependencies.attachStore.set(attachTerminal(entry.terminal).processId, nextBinding);
}
if (updateFocused) {
    entry.focusedBinding = nextBinding;
}
if (updatePersisted) {
    await this.dependencies.attachStore.flush();
}
```

This deliberately leaves `focusedBinding === null` and a focused binding for another window untouched. For an older restored entry where `focusedBinding` is `undefined`, updating the persisted binding also updates the fallback used by `getFocusedRuntime`.

- [ ] **Step 5: Run tmux checks and verify GREEN**

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: `AI session tmux checks passed.`

- [ ] **Step 6: Commit Task 3**

```bash
git add src/aiSessions/tmuxRuntimeBackend.ts scripts/run-ai-session-tmux-checks.js
git commit -m "feat: reconcile tmux focused runtime"
```

---

### Task 4: Add the visibility-gated focus monitor and Dashboard wiring

**Files:**
- Create: `src/aiSessions/tmuxFocusedRuntimeMonitor.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: `TmuxRuntimeBackend.syncFocusedRuntime(terminal)` from Task 3.
- Produces: `TmuxFocusedRuntimeMonitor.start()`, `request()`, and `dispose()`.

- [ ] **Step 1: Write failing monitor tests**

Require the compiled monitor and add `runTmuxFocusedRuntimeMonitorChecks`:

```js
const TmuxFocusedRuntimeMonitor = require('../out/aiSessions/tmuxFocusedRuntimeMonitor')
    .TmuxFocusedRuntimeMonitor;

async function runTmuxFocusedRuntimeMonitorChecks() {
    let visible = true;
    const terminal = { name: 'Project tmux attach' };
    let activeTerminal = terminal;
    const timers = [];
    const refreshes = [];
    const errors = [];
    let syncCalls = 0;
    let resolveSync;
    let rejectSync;
    const monitor = new TmuxFocusedRuntimeMonitor({
        isVisible: () => visible,
        getActiveTerminal: () => activeTerminal,
        syncFocusedRuntime: () => {
            syncCalls++;
            return new Promise((resolve, reject) => {
                resolveSync = resolve;
                rejectSync = reject;
            });
        },
        refresh: () => refreshes.push('refresh'),
        onError: error => errors.push(error),
        setInterval: (callback, intervalMs) => {
            const handle = { callback, intervalMs, active: true };
            timers.push(handle);
            return handle;
        },
        clearInterval: handle => { handle.active = false; },
    });
    monitor.start();
    monitor.start();
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].intervalMs, 1_000);
    const first = monitor.request();
    const joined = monitor.request();
    assert.strictEqual(first, joined);
    assert.strictEqual(syncCalls, 1);
    resolveSync({ monitored: true, changed: true, identity: {
        provider: 'codex', sessionId: 's1', projectKey: 'pk', cwd: '/work/app',
    } });
    await first;
    assert.deepStrictEqual(refreshes, ['refresh']);

    const unchanged = monitor.request();
    resolveSync({ monitored: true, changed: false, identity: null });
    await unchanged;
    assert.deepStrictEqual(refreshes, ['refresh']);

    visible = false;
    const callsBeforeHidden = syncCalls;
    await monitor.request();
    timers[0].callback();
    await Promise.resolve();
    assert.strictEqual(syncCalls, callsBeforeHidden);

    visible = true;
    activeTerminal = terminal;
    const staleTerminal = monitor.request();
    activeTerminal = { name: 'Other terminal' };
    resolveSync({ monitored: true, changed: true, identity: null });
    await staleTerminal;
    assert.deepStrictEqual(refreshes, ['refresh'],
        'a result for a no-longer-active terminal must not refresh');

    activeTerminal = terminal;
    const rejected = monitor.request();
    rejectSync(new Error('private tmux query failure'));
    await rejected;
    assert.strictEqual(errors.length, 1);

    const disposedRequest = monitor.request();
    monitor.dispose();
    resolveSync({ monitored: true, changed: true, identity: null });
    await disposedRequest;
    assert.strictEqual(timers[0].active, false);
    assert.deepStrictEqual(refreshes, ['refresh']);
    const callsAfterDispose = syncCalls;
    await monitor.request();
    assert.strictEqual(syncCalls, callsAfterDispose);
}
```

Call `runTmuxFocusedRuntimeMonitorChecks()` from the script's existing async main sequence. Extend the existing Dashboard source contract block with:

```js
assert.ok(dashboard.includes('new TmuxFocusedRuntimeMonitor<vscode.Terminal>({'));
assert.ok(dashboard.includes('tmuxFocusedRuntimeMonitor.start();'));
assert.ok((dashboard.match(/void tmuxFocusedRuntimeMonitor\.request\(\);/g) || []).length >= 2,
    'view visibility and active-terminal changes must both request reconciliation');
assert.ok(dashboard.includes("logAiSessionRuntimeFailure('sync-focused-runtime', error)"));
assert.ok(dashboard.includes('context.subscriptions.push(tmuxFocusedRuntimeMonitor);'));
```

- [ ] **Step 2: Run safety checks and verify RED**

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: compile or module-load failure because the monitor file does not exist.

- [ ] **Step 3: Implement the monitor**

Create `src/aiSessions/tmuxFocusedRuntimeMonitor.ts`:

```ts
'use strict';

import type { TmuxFocusedRuntimeSyncResult } from './tmuxRuntimeBackend';

export const TMUX_FOCUSED_RUNTIME_CHECK_INTERVAL_MS = 1000;

export interface TmuxFocusedRuntimeMonitorOptions<TTerminal> {
    isVisible(): boolean;
    getActiveTerminal(): TTerminal | null;
    syncFocusedRuntime(terminal: TTerminal): Promise<TmuxFocusedRuntimeSyncResult>;
    refresh(): void;
    onError(error: unknown): void;
    setInterval(callback: () => void, intervalMs: number): unknown;
    clearInterval(handle: unknown): void;
}

export class TmuxFocusedRuntimeMonitor<TTerminal> {
    private interval: unknown = null;
    private inFlight: Promise<void> | null = null;
    private disposed = false;

    constructor(private readonly options: TmuxFocusedRuntimeMonitorOptions<TTerminal>) { }

    start(): void {
        if (this.disposed || this.interval !== null) {
            return;
        }
        this.interval = this.options.setInterval(
            () => { void this.request(); },
            TMUX_FOCUSED_RUNTIME_CHECK_INTERVAL_MS
        );
    }

    request(): Promise<void> {
        if (this.disposed || !this.options.isVisible()) {
            return Promise.resolve();
        }
        if (this.inFlight) {
            return this.inFlight;
        }
        const terminal = this.options.getActiveTerminal();
        if (!terminal) {
            return Promise.resolve();
        }
        let tracked: Promise<void>;
        const clear = () => {
            if (this.inFlight === tracked) {
                this.inFlight = null;
            }
        };
        tracked = this.options.syncFocusedRuntime(terminal).then(result => {
            if (!this.disposed && result.changed && this.options.isVisible()
                && this.options.getActiveTerminal() === terminal) {
                this.options.refresh();
            }
        }, error => {
            try {
                this.options.onError(error);
            } catch (_reportError) {
                // Monitoring failures and diagnostic failures remain non-fatal.
            }
        }).then(clear, clear);
        this.inFlight = tracked;
        return tracked;
    }

    dispose(): void {
        this.disposed = true;
        if (this.interval !== null) {
            this.options.clearInterval(this.interval);
            this.interval = null;
        }
    }
}
```

- [ ] **Step 4: Wire Dashboard lifecycle**

Import and construct after `activeAiSessionTerminalHighlighter`:

```ts
const tmuxFocusedRuntimeMonitor = new TmuxFocusedRuntimeMonitor<vscode.Terminal>({
    isVisible: () => provider.visible,
    getActiveTerminal: () => vscode.window.activeTerminal || null,
    syncFocusedRuntime: terminal => tmuxRuntimeBackend.syncFocusedRuntime(terminal),
    refresh: refreshAiSessionViewsIncrementally,
    onError: error => logAiSessionRuntimeFailure('sync-focused-runtime', error),
    setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
});
tmuxFocusedRuntimeMonitor.start();
```

In `onVisibleChanged`, request only on the transition to visible:

```ts
if (visible) {
    void tmuxFocusedRuntimeMonitor.request();
}
```

Also call `void tmuxFocusedRuntimeMonitor.request()` from `onDidChangeActiveTerminal`, push the monitor into `context.subscriptions`, and do not couple it to execution or attention controllers.

- [ ] **Step 5: Run full safety checks and verify GREEN**

```bash
npm run test:safety
```

Expected:

```text
AI session tmux checks passed.
AI session safety checks passed.
Open project safety checks passed.
```

- [ ] **Step 6: Commit Task 4**

```bash
git add src/aiSessions/tmuxFocusedRuntimeMonitor.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js
git commit -m "feat: follow focused tmux project window"
```

---

### Task 5: Verify, document, package, and install

**Files:**
- Update: `docs/manual-tests/ai-session-tmux-runtime.md`

**Interfaces:**
- Consumes: all completed focused-session changes.
- Produces: fresh evidence, VSIX artifacts, and an installed Dev Container extension for manual testing.

- [ ] **Step 1: Run full suites**

```bash
npm run test:tmux
npm run test:safety
npm run test:tmux:smoke
```

Expected: tmux, AI safety, Open Project, and real tmux smoke checks all print their passed messages.

- [ ] **Step 2: Run compile and release gates**

```bash
npm run test-compile
npm run vscode:prepublish
npm run test:release-packaging
git diff --check
```

Expected: all commands exit 0; webpack may print existing deprecation warnings; packaging prints `Release packaging checks passed.`

- [ ] **Step 3: Update and commit the manual record**

Add these rows without claiming an unperformed UI result:

```markdown
| PASS (automated) | Explicit focused-session refresh | Successful active, pending, legacy Direct, runtime-backed, and conflict-selected focus paths request an immediate refresh; missing and failed targets do not claim focus. |
| PASS (automated) | Project tmux active-window synchronization | Managed A→B, managed→unmanaged, unchanged, query failure, pending promotion, visibility gating, single-flight, and disposal checks passed. |
| NOT RUN | Installed UI focused-session retest | Awaiting manual Project Steward click and tmux-internal window-switch verification after installing the new VSIX. |
```

```bash
git add docs/manual-tests/ai-session-tmux-runtime.md
git commit -m "docs: record tmux focused session verification"
```

- [ ] **Step 4: Re-run Steps 1 and 2 after the final commit**

Confirm every command passes again and `git status -sb` is clean.

- [ ] **Step 5: Build and install through the repository workflow**

```bash
env | rg '^(REMOTE_CONTAINERS|CODESPACES|SSH_CONNECTION|VSCODE_IPC_HOOK_CLI)=' || true
which -a code
code --version
SKIP_NPM_CI=1 npm run install-local
```

Expected: `artifacts/project-steward-2.1.2.vsix` is built and `hzcheng.project-steward@2.1.2` installs in the Dev Container. Report the UI-only attention bridge as packaged but not remotely installable if VS Code rejects it.

- [ ] **Step 6: Verify the installed artifact**

```bash
code --list-extensions --show-versions | rg '^hzcheng\.project-steward@2\.1\.2$'
sha256sum dist/dashboard.js \
  /home/hzcheng/.vscode-server/extensions/hzcheng.project-steward-2.1.2/dist/dashboard.js
git status -sb
```

Expected: the extension is listed, both hashes match, and the worktree is clean.

- [ ] **Step 7: Hand off manual verification**

Ask the user to reload VS Code and verify:

1. clicking between two active project-layout sessions changes Focused immediately;
2. tmux window navigation changes Focused within one second;
3. selecting the base/unmanaged window clears Focused.
