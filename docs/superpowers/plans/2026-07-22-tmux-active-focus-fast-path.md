# Tmux Active Session Focus Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live-validate and focus a unique cached tmux runtime without blocking on global discovery, with one safe reconciliation retry for changed targets.

**Architecture:** Add a one-command exact-target metadata snapshot to `TmuxClient`, enforce complete runtime identity ownership in `TmuxRuntimeBackend.focus`, and add a unique-tmux fast path with typed stale-target recovery in `AiSessionRuntimeCoordinator`. Keep global discovery's ownership protocol but parallelize the fixed metadata-option reads for each target.

**Tech Stack:** TypeScript, Node.js `execFile`, VS Code Terminal API, tmux format strings, assertion-based JavaScript safety checks, real tmux smoke checks.

## Global Constraints

- Normal unique tmux focus performs no Direct refresh and no full tmux discovery refresh.
- The exact live tmux target must match the complete workspace-aware runtime identity before selection.
- Missing or mismatched targets are never selected.
- Recovery performs at most one forced host refresh and one retry.
- Known conflicts and `focusSelected` retain forced-refresh verification.
- Direct Terminal behavior remains unchanged.
- Metadata option-read concurrency is capped at the fixed option count of 12 per target.
- Do not modify Dashboard markup, CSS, icons, animations, card copy, or click targets.
- Diagnostics must not include executable paths, locators, metadata, stdout, stderr, commands, prompts, or responses.

---

### Task 1: Add a bounded exact-target tmux metadata snapshot

**Files:**
- Modify: `src/aiSessions/tmuxClient.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js` in `runTmuxClientChecks`

**Interfaces:**
- Consumes: `AiSessionTmuxLocator`, `TMUX_METADATA_OPTIONS`, the existing argument-array runner and categorized errors.
- Produces: `TmuxTargetWindowRecord` and `TmuxClient.getTargetWindow(locator: AiSessionTmuxLocator): Promise<TmuxTargetWindowRecord | null>`.

- [ ] **Step 1: Write failing target-snapshot client checks**

Add a runner whose `display-message` result contains three locator fields followed by one field for every `TMUX_METADATA_OPTIONS` entry. Assert the exact target and format arguments, parsed metadata object, missing-target `null`, invalid field count, over-limit value, control-character value, and redacted nonzero error:

```js
const targetMetadata = {
    managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'project-key',
    workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: '["/work"]', cwd: '/work',
    provider: 'codex', sessionId: 'session-1', pendingId: '',
    createdAt: '2026-07-22T00:00:00.000Z', marker: '/tmp/session-1.done',
};
const targetFields = Object.keys(tmuxLayout.TMUX_METADATA_OPTIONS)
    .map(key => targetMetadata[key] || '');
let targetResult = {
    exitCode: 0,
    stdout: ['managed-session', 'ai-codex-1', '@42', ...targetFields].join('\u001f') + '\n',
    stderr: '',
};
const targetCalls = [];
const targetClient = new tmuxClientModule.TmuxClient('/private/tmux', {
    run: async (_file, args) => {
        targetCalls.push(args);
        if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.4\n', stderr: '' };
        if (args[0] === 'list-commands') {
            return { exitCode: 0, stdout: [...requiredCommands, 'display-message'].join('\n'), stderr: '' };
        }
        return targetResult;
    },
});
const targetLocator = {
    layout: 'project', sessionName: 'managed-session', windowName: 'ai-codex-1',
};
assert.deepStrictEqual(await targetClient.getTargetWindow(targetLocator), {
    sessionName: 'managed-session', windowName: 'ai-codex-1', windowId: '@42',
    metadata: Object.fromEntries(Object.entries(targetMetadata).filter(([, value]) => value)),
});
assert.strictEqual(targetCalls.slice(-1)[0][0], 'display-message');
assert.deepStrictEqual(targetCalls.slice(-1)[0].slice(1, 4), [
    '-p', '-t', 'managed-session:ai-codex-1',
]);

targetResult = { exitCode: 1, stdout: '', stderr: "can't find window: ai-codex-1" };
assert.strictEqual(await targetClient.getTargetWindow(targetLocator), null);

targetResult = { exitCode: 0, stdout: 'too\u001ffew\n', stderr: '' };
await assert.rejects(targetClient.getTargetWindow(targetLocator), error =>
    error.operation === 'get-target-window' && error.category === 'invalid-output');

targetResult = { exitCode: 2, stdout: 'private stdout', stderr: 'private locator' };
await assert.rejects(targetClient.getTargetWindow(targetLocator), error => {
    assert.strictEqual(error.operation, 'get-target-window');
    assert.strictEqual(error.category, 'nonzero-exit');
    for (const secret of ['private stdout', 'private locator', '/private/tmux']) {
        assert.ok(!error.message.includes(secret));
    }
    return true;
});
```

- [ ] **Step 2: Run the tmux check and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: compilation or runtime failure because `getTargetWindow` does not exist.

- [ ] **Step 3: Implement the bounded target snapshot**

Add `display-message` to the availability command list and `get-target-window` to `TmuxOperation`. Build one fixed format from locator fields plus `Object.values(TMUX_METADATA_OPTIONS)`:

```ts
const TARGET_WINDOW_FORMAT = [
    '#{session_name}', '#{window_name}', '#{window_id}',
    ...Object.values(TMUX_METADATA_OPTIONS).map(option => `#{${option}}`),
].join(FIELD_SEPARATOR);

export interface TmuxTargetWindowRecord {
    sessionName: string;
    windowName: string;
    windowId: string;
    metadata: Record<string, string>;
}
```

Implement `getTargetWindow` with exact target validation and the parser's fixed field count:

```ts
async getTargetWindow(locator: AiSessionTmuxLocator): Promise<TmuxTargetWindowRecord | null> {
    const target = validatedLocatorTarget(locator);
    await this.requireAvailable();
    const result = await this.invoke('get-target-window', [
        'display-message', '-p', '-t', target, TARGET_WINDOW_FORMAT,
    ]);
    if (result.exitCode !== 0) {
        if (isMissingTargetResult(result)) return null;
        throw resultError('get-target-window', result);
    }
    return parseTargetWindow(result.stdout);
}
```

`parseTargetWindow` must accept exactly one newline-terminated or non-terminated record, require `3 + metadataOptionKeys().length` fields, validate locator fields with the same limits as `parseWindowRows`, omit empty metadata fields, and apply `metadataValueLimit` plus the control-character rule to non-empty values. `validatedLocatorTarget` must reject malformed layouts/names and return `session:window` for project layout and the session name for session layout. `isMissingTargetResult` must recognize only the existing no-server/session cases plus `can't find window:`; all other failures remain categorized errors.

- [ ] **Step 4: Run the focused client checks and verify GREEN**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: `AI session tmux checks passed.`

- [ ] **Step 5: Commit Task 1**

```bash
git add src/aiSessions/tmuxClient.ts scripts/run-ai-session-tmux-checks.js
git commit -m "feat: verify exact tmux focus targets"
```

---

### Task 2: Enforce backend ownership before selection

**Files:**
- Modify: `src/aiSessions/runtimeTypes.ts`
- Modify: `src/aiSessions/tmuxRuntimeBackend.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js` in the backend harness and focus checks

**Interfaces:**
- Consumes: `TmuxClient.getTargetWindow`, `parseManagedTmuxMetadata`, `aiSessionRuntimeIdentitiesEqual`, and exact tmux locators.
- Produces: `AiSessionRuntimeTargetChangedError` and a `TmuxRuntimeBackend.focus` that selects only a live target with matching ownership metadata.

- [ ] **Step 1: Write failing backend verification checks**

Extend the tmux backend harness with a `get-target-window` operation and mutable target snapshot. Assert that matching metadata allows `select-window`, while missing, wrong-workspace, wrong-provider/session, wrong actual locator, and malformed metadata throw the typed changed-target error before any select/show/create operation:

```js
const verifiedFocus = createTmuxBackendHarness();
const verifiedRuntime = fakeRuntime('tmux', 'focus-session', {
    identity: {
        provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1',
        workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'focus-session',
    },
    tmux: { layout: 'project', sessionName: 'managed-focus', windowName: 'ai-codex-focus' },
});
verifiedFocus.setTargetWindow(verifiedRuntime, {
    managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'pk',
    workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: '["/work"]', cwd: '/work',
    provider: 'codex', sessionId: 'focus-session',
});
await verifiedFocus.backend.focus(verifiedRuntime);
assert.strictEqual(verifiedFocus.operations.filter(item => item.type === 'select-window').length, 1);

for (const mismatch of [
    null,
    { workspaceScopeIdentity: 'other' },
    { provider: 'kimi' },
    { sessionId: 'other' },
]) {
    const harness = createTmuxBackendHarness();
    harness.setTargetWindow(verifiedRuntime, mismatch === null ? null : {
        managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'pk',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: '["/work"]', cwd: '/work',
        provider: 'codex', sessionId: 'focus-session', ...mismatch,
    });
    await assert.rejects(harness.backend.focus(verifiedRuntime), error =>
        error instanceof runtimeTypesModule.AiSessionRuntimeTargetChangedError);
    assert.strictEqual(harness.operations.some(item => item.type === 'select-window'), false);
    assert.strictEqual(harness.operations.some(item => item.type === 'create-terminal'), false);
}
```

- [ ] **Step 2: Run the tmux check and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: failure because focus does not query or verify the target and the typed error is absent.

- [ ] **Step 3: Implement typed verification before attach/focus**

Add a message-free typed error:

```ts
export class AiSessionRuntimeTargetChangedError extends Error {
    constructor() {
        super('The AI session runtime target changed.');
        this.name = 'AiSessionRuntimeTargetChangedError';
        Object.setPrototypeOf(this, AiSessionRuntimeTargetChangedError.prototype);
    }
}
```

Import `parseManagedTmuxMetadata` and add a backend helper:

```ts
private async verifyFocusTarget(runtime: AiSessionRuntimeSnapshot): Promise<void> {
    if (!runtime.tmux) throw new AiSessionRuntimeTargetChangedError();
    const target = await this.dependencies.client.getTargetWindow(runtime.tmux);
    const metadata = target ? parseManagedTmuxMetadata(target.metadata) : null;
    const locatorMatches = !!target
        && target.sessionName === runtime.tmux.sessionName
        && (runtime.tmux.layout === 'session'
            || target.windowName === runtime.tmux.windowName);
    if (!metadata || metadata.layout !== runtime.tmux.layout || !locatorMatches
        || !aiSessionRuntimeIdentitiesEqual(metadata, runtime.identity)) {
        throw new AiSessionRuntimeTargetChangedError();
    }
}
```

Call `await this.verifyFocusTarget(runtime)` at the start of public `focus`, before `attachAndFocus`. Keep creation/resume flows that call `attachAndFocus` internally unchanged because they already verify or create ownership transactionally.

- [ ] **Step 4: Run backend checks and verify GREEN**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: `AI session tmux checks passed.`

- [ ] **Step 5: Commit Task 2**

```bash
git add src/aiSessions/runtimeTypes.ts src/aiSessions/tmuxRuntimeBackend.ts scripts/run-ai-session-tmux-checks.js
git commit -m "fix: validate tmux ownership before focus"
```

---

### Task 3: Add the coordinator tmux focus fast path and one retry

**Files:**
- Modify: `src/aiSessions/runtimeCoordinator.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js` in coordinator checks

**Interfaces:**
- Consumes: cached runtime candidates and `AiSessionRuntimeTargetChangedError` from Task 2.
- Produces: no-refresh unique tmux focus and one forced-refresh recovery path.

- [ ] **Step 1: Write failing coordinator fast-path and recovery checks**

Teach `createFakeRuntimeBackend` to throw queued `focusErrors` after recording the call. Assert a healthy unique tmux runtime focuses without either backend refresh:

```js
const fastDirect = createFakeRuntimeBackend('vscode');
const fastTmux = createFakeRuntimeBackend('tmux');
fastTmux.active.push(fakeRuntime('tmux', 'fast-focus'));
const fastCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
    direct: fastDirect, tmux: fastTmux,
    getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
    chooseTmuxFallback: async () => 'cancel',
});
await fastCoordinator.focus(fakeResumeRequest('fast-focus').identity);
assert.deepStrictEqual(fastDirect.refreshCalls, []);
assert.deepStrictEqual(fastTmux.refreshCalls, []);
assert.strictEqual(fastTmux.focusCalls.length, 1);
```

Add changed-target recovery fixtures that prove: one error refreshes both backends and retries once; refresh removing the target does not retry; refresh producing duplicate/conflict state does not retry; two typed errors stop after two focus calls and one refresh; non-target errors propagate without refresh. Keep existing `focusSelected` assertions proving it still refreshes.

- [ ] **Step 2: Run the tmux check and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: the healthy fast-path assertion fails because both backends are currently forcibly refreshed.

- [ ] **Step 3: Implement unique tmux focus and typed recovery**

Refactor `focus` into backend-specific cached paths:

```ts
async focus(identity: AiSessionRuntimeIdentity): Promise<void> {
    const cached = this.matchesForIdentity(identity);
    if (cached.length === 1 && cached[0].state !== 'conflict') {
        if (cached[0].backend === 'vscode') {
            await this.dependencies.direct.refresh(true);
            const directMatches = this.matchesInBackend(this.dependencies.direct, identity);
            if (directMatches.length === 1 && directMatches[0].state !== 'conflict') {
                await this.dependencies.direct.focus(cloneRuntime(directMatches[0]));
            }
            return;
        }
        try {
            await this.dependencies.tmux.focus(cloneRuntime(cached[0]));
            return;
        } catch (error) {
            if (!(error instanceof AiSessionRuntimeTargetChangedError)) throw error;
        }
        await this.refreshForHost(true);
        const refreshed = this.matchesForIdentity(identity);
        if (refreshed.length !== 1 || refreshed[0].state === 'conflict') return;
        try {
            await this.backendFor(refreshed[0]).focus(cloneRuntime(refreshed[0]));
        } catch (error) {
            if (!(error instanceof AiSessionRuntimeTargetChangedError)) throw error;
        }
        return;
    }
    await this.refreshForHost(true);
    const matches = this.matchesForIdentity(identity);
    if (matches.length !== 1 || matches[0].state === 'conflict') return;
    try {
        await this.backendFor(matches[0]).focus(cloneRuntime(matches[0]));
    } catch (error) {
        if (!(error instanceof AiSessionRuntimeTargetChangedError)) throw error;
    }
}
```

Do not change `focusSelected`, `detach`, resume/create, promotion, or conflict candidate projection.

- [ ] **Step 4: Run coordinator checks and verify GREEN**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: `AI session tmux checks passed.`

- [ ] **Step 5: Commit Task 3**

```bash
git add src/aiSessions/runtimeCoordinator.ts scripts/run-ai-session-tmux-checks.js
git commit -m "perf: bypass discovery for verified tmux focus"
```

---

### Task 4: Bound and parallelize metadata reads per discovery target

**Files:**
- Modify: `src/aiSessions/tmuxClient.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js` in `runTmuxClientChecks`

**Interfaces:**
- Consumes: the fixed 12-key `metadataOptionKeys` list and existing per-option parser.
- Produces: all-or-nothing concurrent reads with concurrency never exceeding 12 for one target.

- [ ] **Step 1: Write a failing overlap and failure-atomicity check**

Use deferred option reads to record peak in-flight calls. Resolve them only after all 12 have started, then assert complete metadata and `peak === 12`. Add one rejected/nonzero option result and assert the public read rejects without returning a partial record:

```js
let inFlightOptions = 0;
let peakOptions = 0;
const releaseOptions = deferred();
const parallelClient = new tmuxClientModule.TmuxClient('tmux', {
    run: async (_file, args) => {
        if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.4\n', stderr: '' };
        if (args[0] === 'list-commands') {
            return { exitCode: 0, stdout: [...requiredCommands, 'display-message'].join('\n'), stderr: '' };
        }
        if (args[0] === 'show-options') {
            inFlightOptions++;
            peakOptions = Math.max(peakOptions, inFlightOptions);
            if (peakOptions === Object.keys(tmuxLayout.TMUX_METADATA_OPTIONS).length) {
                releaseOptions.resolve();
            }
            await releaseOptions.promise;
            inFlightOptions--;
            return { exitCode: 0, stdout: 'value\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
    },
});
await parallelClient.getSessionOptions('managed-session');
assert.strictEqual(peakOptions, Object.keys(tmuxLayout.TMUX_METADATA_OPTIONS).length);
```

- [ ] **Step 2: Run the tmux check and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: the deferred check cannot reach 12 concurrent reads under the existing sequential loop.

- [ ] **Step 3: Implement fixed-count concurrent option reads**

Replace the sequential loop with one `Promise.all` over the fixed metadata keys, parse each completed result with its associated key, then construct the result only after every operation succeeds:

```ts
const entries = await Promise.all(metadataOptionKeys().map(async key => {
    const result = await this.invoke(operation, [...baseArgs, TMUX_METADATA_OPTIONS[key]]);
    if (result.exitCode !== 0) throw resultError(operation, result);
    return [key, parseMetadataOptionValue(result.stdout, operation)] as const;
}));
const values: Record<string, string> = {};
for (const [key, value] of entries) {
    if (value !== null) values[key] = value;
}
return values;
```

Do not parallelize across tmux targets or windows; the maximum added process concurrency remains 12.

- [ ] **Step 4: Run tmux and real-smoke checks and verify GREEN**

Run:

```bash
npm run test-compile
node scripts/run-ai-session-tmux-checks.js
npm run test:tmux:smoke
```

Expected: the assertion suite prints `AI session tmux checks passed.` and real tmux smoke passes.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/aiSessions/tmuxClient.ts scripts/run-ai-session-tmux-checks.js
git commit -m "perf: parallelize bounded tmux metadata reads"
```

---

### Task 5: Verify workspace parity and install the test build

**Files:**
- Modify only if a packaging regression requires an in-scope correction.
- Package: `artifacts/project-steward-2.1.3.vsix`

**Interfaces:**
- Consumes: Tasks 1-4 and the existing extension packaging/install workflow.
- Produces: a verified VSIX installed into the pinned Dev Container extension host; the UI bridge remains untouched.

- [ ] **Step 1: Run focused and full regression suites**

Run:

```bash
npm run test:workspace-parity
npm run test:safety
npm run test:dashboard
npm run test:tmux:smoke
npm run test:release-packaging
```

Expected: every command exits 0 with its suite-specific pass message.

- [ ] **Step 2: Inspect the final diff for UI and scope drift**

Run:

```bash
git diff HEAD~4 -- src/webview src/styles src/dashboard.ts
git status --short
```

Expected: no Webview/style/card changes; only intended source, tests, and docs are present.

- [ ] **Step 3: Package and verify the main extension**

Follow `.codex/skills/installing-vscode-extensions-locally/SKILL.md` and build the main VSIX at the repository artifact path. Record its SHA-256 and inspect package contents. Do not package or install the UI bridge.

- [ ] **Step 4: Install with the pinned code-server binary**

Run the skill-prescribed install command using:

```text
/home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server
```

Expected: `hzcheng.project-steward@2.1.3` is installed and `hzcheng.project-steward-attention-ui-bridge@0.1.3` remains unchanged.

- [ ] **Step 5: Commit verification evidence if a report is added**

```bash
git add docs/superpowers/reports
git commit -m "docs: verify tmux focus fast path"
```

