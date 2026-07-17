# AI Session Management Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project-card-level `ACTIVE / SESSIONS` tabs that aggregate live Codex, Kimi, and Claude terminals, preserve the complete provider history, and make New Session explicitly provider-independent.

**Architecture:** Derive Active Session state from the existing persisted Terminal bindings and pending-terminal records in a new pure projection module. Keep the user's per-project selected inner tab only in the current VS Code Webview state; render both panels from the project Session projection and keep Webview refreshes incremental. Host-side controllers own provider picking and Terminal close/focus operations, while Webview code only emits validated intent messages.

**Tech Stack:** TypeScript 4.0, VS Code Extension API ^1.51, plain Webview JavaScript, SCSS/CSS, Node `assert` safety scripts, Webpack, Gulp.

## Global Constraints

- `ACTIVE` means a logical Session bound to an existing, unreleased VS Code Terminal in the current extension host.
- `SESSIONS` remains the complete current-provider history and continues to include Active Sessions.
- `ACTIVE` aggregates Codex, Kimi, and Claude; `SESSIONS` keeps the existing provider selector.
- New Session must ask the user to select a provider every time and must not inherit the current history filter.
- Clicking an Active Session focuses its existing Terminal and must not create a duplicate Terminal.
- Active Sessions cannot be archived singly or through batch selection until their Terminal is closed.
- Other VS Code windows remain navigation-only; do not add Session details to the cross-window protocol.
- Preserve Local, SSH, WSL, Dev Container, and other Remote extension-host behavior.
- Do not add a dependency or change provider history storage formats.
- Use VS Code theme tokens; support 260–400px sidebars, high-contrast themes, keyboard navigation, screen readers, and reduced motion.
- Keep `maxVisibleAiSessions` as the list-height control for both inner panels.
- Keep incremental updates local to the affected current-project card; do not rebuild the Dashboard.
- The approved product specification is `docs/superpowers/specs/2026-07-18-ai-session-management-tabs-design.md`.

---

## File Structure

### New files

- `src/aiSessions/activeSessionProjection.ts` — pure projection from hydrated history, active Terminal bindings, pending creation records, focus, and attention into per-project Active models.
- `src/aiSessions/providerAvailability.ts` — pure PATH lookup used to label unavailable provider commands without executing them.
- `src/aiSessions/terminalCommandController.ts` — validates project/session scope and owns pending focus plus confirmed Terminal close behavior.

### Existing files with focused changes

- `src/models.ts` — add runtime-only Project and Session presentation fields.
- `src/aiSessions/types.ts` — add Active model, runtime binding snapshot, inner-tab ID, and provider command metadata.
- `src/aiSessions/terminalBindingStore.ts` — persist an optional comparable cwd on bound records without rejecting existing version-2 records.
- `src/aiSessions/terminalService.ts` — expose immutable active/pending runtime snapshots and persist cwd.
- `src/aiSessions/pendingTerminalResolver.ts` — carry pending cwd into the final bound entry.
- `src/aiSessions/resumeController.ts` — carry cwd into ownership and request an incremental refresh after resume/focus.
- `src/aiSessions/creationController.ts` — ask for provider, enter Active, expose Starting immediately, and prevent duplicate prompts.
- `src/aiSessions/providers.ts` — declare provider executable names.
- `src/aiSessions/viewModels.ts` — include Active counts, adaptive default Tab, and Active models in incremental payloads.
- `src/webview/dashboardViewModel.ts` — mark Active search results.
- `src/webview/webviewContent.ts` — render the shared heading, inner tabs, Active panel, history panel, counts, states, and safe actions.
- `src/webview/webviewProjectScripts.js` — inner-tab behavior, message routing, batch guards, scroll preservation, pending actions, and incremental reconciliation.
- `src/webview/webviewDashboardScripts.js` — render the Active search badge while preserving the existing resume/focus route.
- `src/dashboard.ts` — compose projection/controllers and schedule refreshes on runtime lifecycle events.
- `media/styles.scss` — responsive, themed, accessible visual system.
- `media/styles.css`, `media/webviewProjectScripts.js`, `media/webviewDashboardScripts.js` — generated artifacts from Gulp.
- `scripts/run-ai-session-safety-checks.js`, `scripts/run-dashboard-webview-checks.js` — regression coverage using the repository's current compiled-module and VM harness.
- `README.md` — document the new Active workspace, complete history, and provider picker.

---

### Task 1: Persist Runtime cwd and Build the Pure Active Projection

**Files:**
- Create: `src/aiSessions/activeSessionProjection.ts`
- Modify: `src/models.ts:100-125`
- Modify: `src/aiSessions/types.ts:1-85`
- Modify: `src/aiSessions/terminalBindingStore.ts:14-220`
- Modify: `src/aiSessions/terminalService.ts:10-210`
- Modify: `src/aiSessions/pendingTerminalResolver.ts:45-75`
- Modify: `src/aiSessions/resumeController.ts:32-165`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces: `AiSessionTabId`, `ActiveAiSessionStatus`, `ActiveAiSessionViewModel`, `AiSessionActiveTerminalRuntime`, and `applyAiSessionRuntimeProjection(input): Project[]`.
- Produces: `AiSessionTerminalService.getActiveSessions(): AiSessionActiveTerminalRuntime[]` and the existing `getPendingTerminals()` snapshot.
- Consumes: existing hydrated `Project.codexSessions`, `kimiSessions`, `claudeSessions`, Terminal binding records, and `ActiveAiSessionTerminalIdentity`.

- [ ] **Step 1: Add a failing projection and persistence test**

At the top-level requires in `scripts/run-ai-session-safety-checks.js`, load `out/aiSessions/activeSessionProjection`. Add `runActiveAiSessionProjectionChecks()` and call it immediately after `runProjectStateStoreChecks()`:

```js
function runActiveAiSessionProjectionChecks() {
    const projects = [{
        id: 'app', path: '/work/app',
        codexSessions: [{ id: 'c1', name: 'Codex live', updatedAt: '2026-07-18T01:00:00Z' }],
        kimiSessions: [{ id: 'k1', name: 'Kimi waiting', updatedAt: '2026-07-18T02:00:00Z',
            attention: { eventId: 'e1', reason: 'input-required', unread: true } }],
        claudeSessions: [],
    }];
    const projected = activeSessionProjection.applyAiSessionRuntimeProjection({
        projects,
        providers: providers.AI_SESSION_PROVIDER_DEFINITIONS,
        activeTerminals: [
            { provider: 'codex', sessionId: 'c1', cwd: '/work/app', runStartedAtMs: 10 },
            { provider: 'kimi', sessionId: 'k1', cwd: '/work/app', runStartedAtMs: 20 },
        ],
        pendingTerminals: [{ provider: 'claude', cwd: '/work/app', createdAt: '2026-07-18T03:00:00Z', title: 'New Claude' }],
        focusedIdentity: { provider: 'codex', sessionId: 'c1' },
        getProjectCwd: project => project.path,
        normalizePath: value => value && value.replace(/\/$/, ''),
    });

    assert.deepStrictEqual(projected[0].activeAiSessions.map(item => item.status), [
        'needsAttention', 'focused', 'starting',
    ]);
    assert.deepStrictEqual(projected[0].activeAiSessions.map(item => item.provider), ['kimi', 'codex', 'claude']);
    assert.strictEqual(projected[0].codexSessions[0].active, true);
    assert.strictEqual(projected[0].kimiSessions[0].active, true);
    assert.strictEqual(projected[0].activeAiSessionTab, 'active');
    assert.strictEqual(projects[0].codexSessions[0].active, undefined, 'projection must not mutate hydration input');
}
```

Add a second fixture with no provider history and one bound runtime record whose cwd matches the project. Assert it still produces one Active row with the correct provider, short Session ID fallback name, and no fabricated history entry. Add a stable-sort fixture proving a relative-time refresh does not reorder rows and Starting rows retain creation order.

Extend `runAiSessionTerminalBindingStoreChecks()` with a bound record containing `cwd: '/work/app'`, assert it round-trips, and assert an existing bound record without `cwd` remains valid.

- [ ] **Step 2: Run the safety suite to verify the new test fails**

Run: `npm run test:safety`

Expected: FAIL because `out/aiSessions/activeSessionProjection` and the new runtime types do not exist.

- [ ] **Step 3: Add runtime presentation types**

Add to `src/aiSessions/types.ts`:

```ts
export type AiSessionTabId = 'active' | 'sessions';
export type ActiveAiSessionStatus = 'starting' | 'running' | 'focused' | 'needsAttention';

export interface AiSessionActiveTerminalRuntime {
    provider: AiSessionProviderId;
    sessionId: string;
    cwd?: string;
    runStartedAtMs: number;
}

export interface ActiveAiSessionViewModel {
    key: string;
    provider: AiSessionProviderId;
    sessionId?: string;
    name: string;
    status: ActiveAiSessionStatus;
    focused: boolean;
    needsAttention: boolean;
    pending: boolean;
    updatedAt?: string;
    createdAt?: string;
    pinned?: boolean;
    attentionEventId?: string;
}
```

Extend `AiSessionTerminalEntry` with `cwd?: string`. Extend `CodexSession` and `Project` in `src/models.ts`:

```ts
// CodexSession
active?: boolean;
focused?: boolean;

// Project
activeAiSessions?: ActiveAiSessionViewModel[];
activeAiSessionTab?: AiSessionTabId;
```

Use type-only imports from `./aiSessions/types` in `models.ts` to avoid a runtime cycle.

- [ ] **Step 4: Preserve optional cwd in bound Terminal records**

Add `cwd?: string` to `BoundAiSessionTerminalBinding`. In `validateRecord`, accept but do not require it:

```ts
const cwd = record.cwd === undefined
    ? undefined
    : isBoundedString(record.cwd, MAX_PATH_LENGTH) ? record.cwd : null;
if (cwd === null) {
    return null;
}
return {
    version: 2,
    state: 'bound',
    providerId: record.providerId,
    sessionId: record.sessionId,
    markerPath: record.markerPath,
    runStartedAtMs: record.runStartedAtMs,
    ...(cwd ? { cwd } : {}),
    updatedAtMs: record.updatedAtMs,
};
```

Do not increment the binding version: existing version-2 records remain valid and simply lack the optional fallback cwd.

- [ ] **Step 5: Expose immutable active runtime snapshots**

In `AiSessionTerminalService.track`, persist `normalizedEntry.cwd` when present. Restore `binding.cwd` in `restorePersistedTerminals`. Add:

```ts
getActiveSessions(): AiSessionActiveTerminalRuntime[] {
    const result: AiSessionActiveTerminalRuntime[] = [];
    for (const provider of this.providers) {
        for (const [sessionId, entry] of this.getTerminalMap(provider.id)) {
            if (!entry.released && !this.isComplete(entry)) {
                result.push({
                    provider: provider.id,
                    sessionId,
                    cwd: entry.cwd,
                    runStartedAtMs: entry.runStartedAtMs,
                });
            }
        }
    }
    return result;
}
```

Pass cwd when tracking from `AiSessionResumeController`:

```ts
this.options.track(providerId, session.id, {
    terminal,
    markerPath,
    runStartedAtMs: this.options.nowMs(),
    cwd: this.options.normalizeProjectPath(
        this.options.getComparableCwd(providerId, session)
    ) || undefined,
});
```

Pass `pendingTerminal.cwd` from `pendingTerminalResolver.ts` when upgrading pending ownership.

- [ ] **Step 6: Implement the pure runtime projection**

Create `src/aiSessions/activeSessionProjection.ts` with this public shape:

```ts
export interface ApplyAiSessionRuntimeProjectionInput {
    projects: Project[];
    providers: Record<AiSessionProviderId, Pick<AiSessionProviderDefinition, 'id' | 'projectSessionsKey'>>;
    activeTerminals: AiSessionActiveTerminalRuntime[];
    pendingTerminals: Array<Pick<PendingAiSessionTerminal, 'provider' | 'cwd' | 'createdAt' | 'title'>>;
    focusedIdentity: ActiveAiSessionTerminalIdentity | null;
    getProjectCwd(project: Project): string;
    normalizePath(value: string): string;
}

export function applyAiSessionRuntimeProjection(input: ApplyAiSessionRuntimeProjectionInput): Project[] {
    return input.projects.map(project => projectWithRuntime(project, input));
}
```

Implement `projectWithRuntime` immutably. Match known runtime records by `provider + sessionId`; match history-less runtime and pending records by normalized cwd. A history-less bound Session must still produce an Active row named from the provider label plus its short Session ID; do not drop the row because history is temporarily unavailable. Build statuses with the precedence `needsAttention`, `focused`, `running`, `starting`. Sort attention and focused rows by their actual activity key, sort the remaining established rows by activity descending, and keep Starting rows in creation order until binding; relative-time text changes must never participate in the sort key. Use opaque pending keys in the form `pending:<provider>:<createdAt>`; never serialize cwd or marker paths as DOM keys.

Set `session.active` and `session.focused` on cloned provider arrays. Set `activeAiSessionTab` to the adaptive first-render default: `active` when the Active list is non-empty and `sessions` when empty. User overrides belong to per-Webview state in Task 6, not extension `globalState` or `workspaceState`.

- [ ] **Step 7: Run focused and full safety checks**

Run: `npm run test:safety`

Expected: `AI session safety checks passed.`

- [ ] **Step 8: Commit the runtime projection**

```bash
git add src/models.ts src/aiSessions/types.ts src/aiSessions/terminalBindingStore.ts \
  src/aiSessions/terminalService.ts src/aiSessions/pendingTerminalResolver.ts \
  src/aiSessions/resumeController.ts src/aiSessions/activeSessionProjection.ts \
  scripts/run-ai-session-safety-checks.js
git commit -m "feat: project active AI session runtime state"
```

---

### Task 2: Wire Runtime Projection and Publish the Adaptive Default

**Files:**
- Modify: `src/aiSessions/types.ts:60-105`
- Modify: `src/aiSessions/viewModels.ts:1-70`
- Modify: `src/dashboard.ts:25-55,268-315,1090-1135`
- Modify: `src/aiSessions/activeTerminalHighlight.ts:20-120`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: `applyAiSessionRuntimeProjection`, `AiSessionTerminalService.getActiveSessions()`, and `AiSessionTabId` from Task 1.
- Produces: incremental `OpenProjectAiSessionViewModel.activeSessions`, `activeSessionCount`, `activeAttentionCount`, and `defaultTab`.
- Produces: `ActiveAiSessionTerminalHighlighter.getIdentity()` for the pure projection.
- State boundary: Host payloads publish only the adaptive default; user-selected Tabs are stored with Webview `getState/setState` in Task 6 so one window cannot change another window.

- [ ] **Step 1: Extend projection and view-model tests first**

Extend `runActiveAiSessionProjectionChecks()` with an empty-runtime project and assert its `activeAiSessionTab` is `sessions`; keep the populated project assertion at `active`.

In `runOpenProjectAiSessionViewModelBuilderChecks()`, provide a project with two `activeAiSessions`, one needing attention, and assert:

```js
assert.strictEqual(model.defaultTab, 'active');
assert.strictEqual(model.activeSessionCount, 2);
assert.strictEqual(model.activeAttentionCount, 1);
assert.deepStrictEqual(model.activeSessions.map(item => item.key), ['codex:c1', 'kimi:k1']);
```

Extend `runActiveAiSessionTerminalHighlightChecks()` to assert `getIdentity()` returns the current identity and returns a clone that cannot mutate the highlighter's internal state.

- [ ] **Step 2: Run safety checks to verify failure**

Run: `npm run test:safety`

Expected: FAIL because the runtime payload fields and `getIdentity()` are absent.

- [ ] **Step 3: Expose the focused identity safely**

Add to `ActiveAiSessionTerminalHighlighter`:

```ts
getIdentity(): ActiveAiSessionTerminalIdentity | null {
    return this.currentIdentity ? { ...this.currentIdentity } : null;
}
```

The method must not publish, resync, or mutate timer state.

- [ ] **Step 4: Apply runtime projection after history hydration**

Change `getOpenProjects()` in `dashboard.ts` to compose history and runtime:

```ts
function getOpenProjects(): Project[] {
    const hydrated = aiSessionProjectHydrationController.hydrate(
        openProjectWorkspaceController.getRawOpenProjects()
    );
    return applyAiSessionRuntimeProjection({
        projects: hydrated,
        providers: AI_SESSION_PROVIDER_DEFINITIONS,
        activeTerminals: aiSessionTerminalService.getActiveSessions(),
        pendingTerminals: aiSessionTerminalService.getPendingTerminals(),
        focusedIdentity: activeAiSessionTerminalHighlighter.getIdentity(),
        getProjectCwd: getOpenProjectAiSessionTerminalCwd,
        normalizePath: normalizeAiSessionProjectPath,
    });
}
```

- [ ] **Step 5: Extend the incremental payload**

Add to `OpenProjectAiSessionViewModel`:

```ts
defaultTab: AiSessionTabId;
activeSessions: ActiveAiSessionViewModel[];
activeSessionCount: number;
activeAttentionCount: number;
```

Populate them in `buildOpenProjectAiSessionViewModel` from the projected Project. Include the new Project runtime fields in the builder cache signature through the existing stable serialization.

- [ ] **Step 6: Run safety checks**

Run: `npm run test:safety`

Expected: `AI session safety checks passed.`

- [ ] **Step 7: Commit runtime wiring**

```bash
git add src/aiSessions/activeTerminalHighlight.ts src/aiSessions/types.ts src/aiSessions/viewModels.ts \
  src/dashboard.ts scripts/run-ai-session-safety-checks.js
git commit -m "feat: publish active AI session card state"
```

---

### Task 3: Make New Session Provider-Independent and Surface Starting State

**Files:**
- Create: `src/aiSessions/providerAvailability.ts`
- Modify: `src/aiSessions/types.ts:34-55`
- Modify: `src/aiSessions/providers.ts:10-65`
- Modify: `src/aiSessions/creationController.ts:1-135`
- Modify: `src/aiSessions/terminalService.ts:150-235`
- Modify: `src/dashboard.ts:314-345,665-675`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: pending Terminal tracking, the per-window Webview selection request, and provider registry.
- Produces: `isCommandAvailableOnPath(commandName, environment, platform, exists): boolean`.
- Produces: `AiSessionCreationController.createSession(projectId)`; the caller no longer supplies provider.

- [ ] **Step 1: Rewrite the creation-controller test around explicit provider choice**

Update `runAiSessionCreationControllerChecks()` so `pickProvider` returns `undefined`, then `codex`, then `kimi`. Assert cancellation creates no Terminal, a successful pick creates the matching provider Terminal, and a second concurrent `createSession()` returns before opening another picker. Use an injected timeout queue to prove an unresolved pending item is removed after exactly `AI_SESSION_CREATION_BIND_TIMEOUT_MS`, the Terminal is not disposed, both the announcement and warning text are `Could not detect the new session`, and choosing `Focus Terminal` calls `terminal.show()`.

Add `runAiSessionProviderAvailabilityChecks()`:

```js
function runAiSessionProviderAvailabilityChecks() {
    const exists = value => value === '/bin/codex' || value === 'C:\\Tools\\kimi.CMD';
    assert.strictEqual(providerAvailability.isCommandAvailableOnPath(
        'codex', { PATH: '/bin:/usr/bin' }, 'linux', exists
    ), true);
    assert.strictEqual(providerAvailability.isCommandAvailableOnPath(
        'claude', { PATH: '/bin:/usr/bin' }, 'linux', exists
    ), false);
    assert.strictEqual(providerAvailability.isCommandAvailableOnPath(
        'kimi', { Path: 'C:\\Tools', PATHEXT: '.EXE;.CMD' }, 'win32', exists
    ), true);
}
```

- [ ] **Step 2: Run safety checks to verify failure**

Run: `npm run test:safety`

Expected: FAIL because provider availability and the picker-first controller contract are absent.

- [ ] **Step 3: Add executable metadata and pure availability lookup**

Add `commandName: string` to `AiSessionProviderDefinition`. In `providers.ts`, insert these exact properties beside each provider's `label`:

```ts
// AI_SESSION_PROVIDER_DEFINITIONS.codex
commandName: 'codex',
// AI_SESSION_PROVIDER_DEFINITIONS.kimi
commandName: 'kimi',
// AI_SESSION_PROVIDER_DEFINITIONS.claude
commandName: 'claude',
```

Implement `providerAvailability.ts` with `path.win32` and `;` when `platform === 'win32'`, otherwise `path.posix` and `:`. Read `PATH` or `Path`, add `PATHEXT` candidates on Windows, and invoke the injected `exists(candidate)` function. Do not execute provider binaries.

- [ ] **Step 4: Refactor creation to pick before prompting for a title**

Change the controller options:

```ts
pickProvider: () => Thenable<AiSessionProviderId | undefined>;
showActiveTab: (projectId: string) => Thenable<unknown> | Promise<unknown>;
announceStatus: (projectId: string, message: string) => Thenable<unknown> | Promise<unknown>;
showWarningMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
refresh: () => void;
isPending: (providerId: AiSessionProviderId, createdAt: string) => boolean;
removePending: (providerId: AiSessionProviderId, createdAt: string) => void;
setTimeout: (callback: () => void, delayMs: number) => unknown;
clearTimeout: (handle: unknown) => void;
bindingTimeoutMs: number;
```

Replace the public method with:

```ts
private creating = false;

async createSession(projectId: string): Promise<void> {
    if (this.creating) return;
    const project = this.options.getOpenProjects().find(item => item.id === projectId);
    if (!project) {
        this.options.showWarningMessage('Open project not found.');
        return;
    }
    this.creating = true;
    try {
        const providerId = await this.options.pickProvider();
        if (!providerId || !this.options.isProviderId(providerId)) return;
        const fields = await this.queryNewSessionFields(providerId);
        if (!fields) return;
        await this.createProviderSession(providerId, project, fields);
    } finally {
        this.creating = false;
    }
}
```

After `trackPendingTerminal`, call `await showActiveTab(project.id)` and `refresh()` before showing/sending to the Terminal. `showActiveTab` posts `{ type: 'ai-session-tab-selection-requested', projectId, tab: 'active' }`; the Webview persists that explicit user-driven selection in its own window state. The refresh creates the `Starting` projection immediately.

Export `AI_SESSION_CREATION_BIND_TIMEOUT_MS = 15_000`. Add `watchPending(pending)` to schedule the remaining timeout from `pending.createdAt`. At timeout, return immediately if the item already resolved; otherwise remove only that pending record, refresh the projection, call `announceStatus(projectId, 'Could not detect the new session')`, show the same text with `Focus Terminal`, and focus the retained Terminal if selected. Add `dispose()` to clear scheduled handles. Wire `announceStatus` in `dashboard.ts` to post `{ type: 'ai-session-status-announcement', projectId, message }` only to this Dashboard Webview.

In `AiSessionTerminalService`, add scoped `hasPending(providerId, createdAt)` and `removePending(providerId, createdAt)` methods. Removal must also delete only that pending binding record and must not dispose its Terminal. After creating the controller in `dashboard.ts`, call `watchPending` for restored pending records so reload cannot leave a permanent Starting row, and register the controller in `context.subscriptions`.

- [ ] **Step 5: Compose a provider Quick Pick in dashboard.ts**

Build items from all registered providers:

```ts
const picks = getRegisteredAiSessionProviders().map(provider => {
    const available = isCommandAvailableOnPath(
        provider.commandName, process.env, process.platform, existsSync
    );
    return {
        label: available ? provider.label : `$(circle-slash) ${provider.label}`,
        description: available
            ? `Open a new ${provider.label} session`
            : `Unavailable — ${provider.commandName} was not found on PATH`,
        providerId: provider.id,
        available,
    };
});
```

Use `vscode.window.showQuickPick(picks, { title: 'Select an AI provider', placeHolder: 'Select an AI provider', ignoreFocusOut: true })`. If the user selects an unavailable item, show its description and reopen the picker without creating a Terminal or prompting for a title; cancellation returns `undefined`. Keep the existing title sanitization, length limit, provider-specific prompt, and `ignoreFocusOut`. Do not infer a provider from the selected history filter and do not change that filter after a choice.

Change the Webview route to call `createSession(projectId)` and ignore any incoming provider field.

- [ ] **Step 6: Verify creation behavior**

Run: `npm run test:safety`

Expected: `AI session safety checks passed.`

- [ ] **Step 7: Commit provider-independent creation**

```bash
git add src/aiSessions/providerAvailability.ts src/aiSessions/types.ts src/aiSessions/providers.ts \
  src/aiSessions/creationController.ts src/aiSessions/terminalService.ts src/dashboard.ts \
  scripts/run-ai-session-safety-checks.js
git commit -m "feat: choose provider for new AI sessions"
```

---

### Task 4: Add Safe Pending Focus and Confirmed Terminal Close

**Files:**
- Create: `src/aiSessions/terminalCommandController.ts`
- Modify: `src/dashboard.ts:340-390,670-720,843-870`
- Modify: `src/aiSessions/resumeController.ts:65-175`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: `AiSessionTerminalService.getActiveById()`, `getPendingTerminals()`, Project provider histories, and Terminal `show()` / `dispose()`.
- Produces: `focusActive(projectId, providerId, sessionId)`, `focusPending(projectId, providerId, createdAt)`, and `closeTerminal({ projectId, providerId, sessionId?, pendingCreatedAt? })`.

- [ ] **Step 1: Add controller tests for scope, focus, cancel, and close**

Load `out/aiSessions/terminalCommandController` and add `runAiSessionTerminalCommandControllerChecks()`. Cover:

```js
await controller.focusPending('app', 'claude', '2026-07-18T03:00:00Z');
assert.strictEqual(pendingTerminal.showCalls, 1);

await controller.focusActive('app', 'codex', 'c1');
assert.strictEqual(activeTerminal.showCalls, 1);

confirmation = undefined;
await controller.closeTerminal({ projectId: 'app', providerId: 'codex', sessionId: 'c1' });
assert.strictEqual(activeTerminal.disposeCalls, 0);

confirmation = 'Close Terminal';
await controller.closeTerminal({ projectId: 'app', providerId: 'codex', sessionId: 'c1' });
assert.strictEqual(activeTerminal.disposeCalls, 1);
assert.strictEqual(refreshes.length, 1);
```

Also assert a mismatched project, provider, Session, or pending createdAt cannot focus or dispose a Terminal.

- [ ] **Step 2: Run safety checks to verify failure**

Run: `npm run test:safety`

Expected: FAIL because `terminalCommandController` does not exist.

- [ ] **Step 3: Implement the scoped Terminal command controller**

Create an interface that injects all external effects:

```ts
export interface AiSessionTerminalCommandControllerOptions<TTerminal extends { show(): void; dispose(): void }> {
    isProviderId(value: string): value is AiSessionProviderId;
    getOpenProjects(): Project[];
    getProjectSessions(project: Project, providerId: AiSessionProviderId): CodexSession[];
    getActiveTerminal(providerId: AiSessionProviderId, sessionId: string): { terminal: TTerminal; cwd?: string } | null;
    getPendingTerminals(): Array<{
        provider: AiSessionProviderId;
        terminal: TTerminal;
        cwd: string;
        createdAt: string;
    }>;
    getProjectCwd(project: Project): string;
    normalizePath(value: string): string;
    confirmClose(providerLabel: string): Thenable<string | undefined>;
    showErrorMessage(message: string): Thenable<unknown> | Promise<unknown>;
    getProviderLabel(providerId: AiSessionProviderId): string;
    refresh(): void;
}
```

Validate established Sessions against the target Project's provider history, or—when history is temporarily unavailable—against the active binding's normalized cwd. Validate pending Sessions by provider, createdAt, and normalized project cwd. Use `terminal.show()` for focus. For close, require exactly `Close Terminal` from a modal warning whose body states that closing can interrupt a running AI task. Catch a synchronous `dispose()` failure, call `showErrorMessage('Could not close the AI session terminal.')`, retain the Active row, and refresh only after successful disposal. Do not optimistically remove, archive, unpin, or delete aliases.

- [ ] **Step 4: Refresh after resume and all runtime lifecycle exits**

Add `refresh: () => void` to `AiSessionResumeControllerOptions`. Call it both when an existing live Terminal is focused and after a newly resumed Session is tracked.

In `dashboard.ts`:

- route `focus-ai-session-terminal`, `focus-pending-ai-session`, and `close-ai-session-terminal` to the new controller;
- after `handleClosedTerminal` returns one or more Sessions, call `refreshAiSessionViewsIncrementally()`;
- after the one-second completion sweep releases Sessions, call `refreshAiSessionViewsIncrementally()` once per batch, not once per Session;
- keep the existing attention evaluation and active-terminal highlighter sync.

- [ ] **Step 5: Run safety checks**

Run: `npm run test:safety`

Expected: `AI session safety checks passed.`

- [ ] **Step 6: Commit safe Terminal commands**

```bash
git add src/aiSessions/terminalCommandController.ts src/aiSessions/resumeController.ts \
  src/dashboard.ts scripts/run-ai-session-safety-checks.js
git commit -m "feat: manage active AI session terminals"
```

---

### Task 5: Render the Shared Heading, Inner Tabs, and Both Session Panels

**Files:**
- Modify: `src/webview/webviewContent.ts:450-680,775-800`
- Modify: `src/aiSessions/viewModels.ts:15-65`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: projected `Project.activeAiSessions`, `activeAiSessionTab`, and `session.active` from Tasks 1–2.
- Produces: stable DOM hooks `data-ai-session-tab`, `data-ai-session-panel`, `data-session-active`, `data-session-pending`, and shared `data-action="create-ai-session"`.

- [ ] **Step 1: Add exact HTML assertions before changing the renderer**

Extend `runWebviewContentChecks()` with a project containing focused, attention, running, and pending Active models. Assert the HTML contains:

```js
assert.ok(html.includes('class="ai-session-module-header"'));
assert.ok(html.includes('data-action="create-ai-session"'));
assert.ok(!html.includes('data-action="create-ai-session" data-provider='));
assert.ok(html.includes('role="tablist" aria-label="AI Session views"'));
assert.ok(html.includes('data-ai-session-tab="active"'));
assert.ok(html.includes('data-ai-session-tab="sessions"'));
assert.ok(html.includes('id="ai-session-active-project-a"'));
assert.ok(html.includes('id="ai-session-history-project-a"'));
assert.ok(html.includes('data-session-status="needsAttention"'));
assert.ok(html.includes('data-session-pending'));
assert.ok(html.includes('data-session-active'));
assert.ok(html.includes('Close the active terminal before archiving.'));
```

Assert project summary markup contains separate total, Active, and attention elements and accessible labels. Add zero-count fixtures proving Active and attention summary elements are omitted when their count is zero.

- [ ] **Step 2: Run safety checks to verify failure**

Run: `npm run test:safety`

Expected: FAIL on the new renderer assertions.

- [ ] **Step 3: Replace the provider toolbar wrapper with a module shell**

Make `getAiSessionsDiv(project)` emit:

```html
<div class="codex-sessions" data-selected-ai-session-tab="active">
  <div class="ai-session-module-header">
    <span class="ai-session-module-title">AI SESSIONS</span>
    <button type="button" class="ai-session-create-button" data-action="create-ai-session"
      aria-label="New AI Session"><span aria-hidden="true">+</span><span>NEW</span></button>
  </div>
  <div class="ai-session-tabs" role="tablist" aria-label="AI Session views">
    ${getAiSessionTabButton(project, 'active', activeSessions.length)}
    ${getAiSessionTabButton(project, 'sessions', totalSessionCount)}
  </div>
  ${getActiveAiSessionPanel(project, activeSessions)}
  ${getAiSessionHistoryPanel(project, activeProvider, historySessionsForProvider)}
</div>
```

Add the exact helper signatures `getAiSessionTabButton(project: Project, tab: AiSessionTabId, count: number): string`, `getActiveAiSessionPanel(project: Project, sessions: ActiveAiSessionViewModel[]): string`, and `getAiSessionHistoryPanel(project: Project, provider: AiSessionProviderId, sessions: CodexSession[]): string`. Generate project-scoped IDs through `escapeAttribute(project.id)`. Render `aria-selected`, `tabindex`, `aria-controls`, `aria-labelledby`, and `hidden` from `project.activeAiSessionTab`.

Derive `activeAttentionCount` from `activeSessions.filter(item => item.needsAttention).length`. When it is greater than zero, render one accessible attention dot inside the `ACTIVE` Tab button. The dot must expose an `aria-label` with the attention count but must not add a second visible number beside the Tab count.

- [ ] **Step 4: Render Active rows and empty state**

Add a dedicated `getActiveAiSessionRow(model)` instead of overloading the history renderer. Established rows carry provider/session ID and reuse resume/focus behavior. Pending rows carry provider/createdAt and use `focus-pending-ai-session`. Render exact status text:

```ts
const statusLabel = model.status === 'needsAttention' ? 'Needs attention'
    : model.status === 'focused' ? 'Focused'
    : model.status === 'starting' ? 'Starting'
    : 'Running';
```

The empty panel must include buttons for `create-ai-session` and `select-ai-session-tab` with `data-tab="sessions"`.

Add one project-scoped `aria-live="polite"` status region for the Starting-to-running transition and Starting timeout failure. Do not mark relative-time labels as live regions, so their periodic updates remain silent to assistive technology.

- [ ] **Step 5: Mark active history safely**

In `getCodexSessionRow`, add `data-session-active` and an `Active` status element when `session.active` is true. Disable the archive button and batch checkbox for Active rows:

```ts
const archiveAction = session.active
    ? `<button type="button" class="codex-session-archive" disabled
         title="Close the active terminal before archiving.">${Icons.archive}</button>`
    : `<button type="button" class="codex-session-archive"
         data-action="archive-${provider}-session" title="Archive Session">${Icons.archive}</button>`;
```

Keep Pin, Rename, and Copy ID available through the existing row/context-menu behavior.

- [ ] **Step 6: Split project summary counts**

Render one wrapper with three semantic children:

```html
<span class="project-codex-badge" aria-label="18 AI sessions">
  <span class="ai-session-total-count">AI 18</span>
  <span class="ai-session-active-count" aria-label="3 active AI sessions">●3</span>
  <b class="ai-session-attention-count" aria-label="2 AI sessions need attention">2</b>
</span>
```

Render the Active and attention children only when their corresponding count is greater than zero. Do not apply the attention error color to the whole total badge.

- [ ] **Step 7: Update the context menu labels and disabled state hook**

Rename `Resume Chat` to `Focus / Resume Chat`, add `Close Terminal…`, and let the Webview disable Archive or Close based on the row's `data-session-active` / `data-session-pending` state before displaying the menu.

- [ ] **Step 8: Run safety checks**

Run: `npm run test:safety`

Expected: `AI session safety checks passed.`

- [ ] **Step 9: Commit semantic rendering**

```bash
git add src/webview/webviewContent.ts src/aiSessions/viewModels.ts scripts/run-ai-session-safety-checks.js
git commit -m "feat: render active and history session tabs"
```

---

### Task 6: Implement Webview Tab Behavior, Safe Actions, and Incremental Reconciliation

**Files:**
- Modify: `src/webview/webviewProjectScripts.js:340-650,1000-1200,1350-1720`
- Test: `scripts/run-ai-session-safety-checks.js`
- Test: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Consumes: stable renderer hooks from Task 5 and host routes from Tasks 2–4.
- Produces: window-scoped per-project Tab persistence, keyboard-complete Tab selection, per-panel scroll capture/restore, pending focus, close messages, and batch exclusion of Active rows.

- [ ] **Step 1: Add pure Webview helper tests first**

Define top-level helpers outside `initProjects()` so the VM test harness can call them:

```js
function normalizeAiSessionTab(value) {
    return value === 'active' ? 'active' : 'sessions';
}

function getAdjacentAiSessionTab(tab, key) {
    tab = normalizeAiSessionTab(tab);
    if (key === 'ArrowLeft' || key === 'ArrowRight') return tab === 'active' ? 'sessions' : 'active';
    if (key === 'Home') return 'active';
    if (key === 'End') return 'sessions';
    return tab;
}

function readAiSessionTabState(vscodeApi) {
    var state = vscodeApi.getState() || {};
    return state.aiSessionTabs && typeof state.aiSessionTabs === 'object'
        ? Object.assign({}, state.aiSessionTabs)
        : {};
}

function writeAiSessionTabState(vscodeApi, projectId, tab) {
    var state = vscodeApi.getState() || {};
    var tabs = readAiSessionTabState(vscodeApi);
    tabs[projectId] = normalizeAiSessionTab(tab);
    vscodeApi.setState(Object.assign({}, state, { aiSessionTabs: tabs }));
}
```

Add VM assertions for normalization and all four keys. Use a fake VS Code API to prove state is isolated by project ID and unrelated Webview state keys survive writes. Dispatch `ai-session-tab-selection-requested` and `ai-session-status-announcement` fixtures, then assert only the named project's selected Tab and live-region text change. Extend batch manager tests so `selectUnpinned([{ id:'active', active:true }, { id:'history', active:false }])` selects only `history`.

- [ ] **Step 2: Run focused Webview checks to verify failure**

Run: `npm run test:dashboard && npm run test:safety`

Expected: FAIL because the helpers, window-scoped state, and Active exclusion do not exist.

- [ ] **Step 3: Handle tab click and keyboard selection**

In `onTriggerAiSessionAction`, handle `[data-action="select-ai-session-tab"][data-tab]`. Update the current DOM immediately and call `writeAiSessionTabState(window.vscode, projectId, tab)`.

```js
selectAiSessionTabDom(projectDiv, tab);
writeAiSessionTabState(window.vscode, projectId, tab);
```

Do not exit batch-management mode on a Tab switch. The history panel is only hidden, so its selection and pending-operation state must remain intact when the user returns to `SESSIONS`.

Do not post normal Tab selection to the Host: `vscode.getState/setState` is scoped to this Webview/window, while extension `globalState` and `workspaceState` can leak the selection across windows. On initialization, apply a stored project Tab when one exists; otherwise keep the Host-rendered adaptive default.

Add a `keydown` listener for inner tabs. Move focus with ArrowLeft/ArrowRight/Home/End and activate with Enter/Space. Keep the outer Dashboard Tab handler independent.

- [ ] **Step 4: Make New Session provider-free**

Change the create handler to match `[data-action="create-ai-session"]` without `data-provider` and post only:

```js
window.vscode.postMessage({ type: 'create-ai-session', projectId });
```

Do not read the history provider selector.

- [ ] **Step 5: Route Active and pending row actions**

For established Active rows post a dedicated intent so the host validates ownership and focuses the bound Terminal even when provider history is temporarily unavailable:

```js
window.vscode.postMessage({
    type: 'focus-ai-session-terminal',
    projectId,
    provider,
    sessionId,
});
```

For pending rows post:

```js
window.vscode.postMessage({
    type: 'focus-pending-ai-session',
    projectId,
    provider,
    createdAt,
});
```

Apply the same established focus route to rows marked `data-session-active` in `SESSIONS`; unmarked history rows continue to post the existing resume intent. This preserves the non-mutual model while preventing duplicate Terminals.

For `Close Terminal…`, post established `sessionId` or pending `createdAt` through `close-ai-session-terminal`. Do not optimistically remove the row.

- [ ] **Step 6: Preserve scroll and tab focus across section replacement**

Immediately before assigning `projectUpdate.sessionSectionHtml` to `sessionSection.outerHTML`, capture:

```js
const viewState = {
    activeScrollTop: projectDiv.querySelector('[data-ai-session-panel="active"] .codex-sessions-list')?.scrollTop || 0,
    sessionsScrollTop: projectDiv.querySelector('[data-ai-session-panel="sessions"] .codex-sessions-list')?.scrollTop || 0,
    focusedTab: document.activeElement?.getAttribute('data-ai-session-tab'),
    pendingCount: projectDiv.querySelectorAll('[data-session-pending]').length,
    establishedActiveCount: projectDiv.querySelectorAll('[data-session-active]:not([data-session-pending])').length,
};
```

After replacement, reapply the stored project Tab before restoring each scroll position with bounds clamping. If pending count decreased while established Active count increased, set the project live region to `AI session is ready`; never announce time-only updates. Restore focus only when it was inside this project, falling back to the same Tab, the same Session row, or the nearest surviving row after a confirmed close. Then run batch reconciliation, focus highlighting, and attention animation.

Handle `{ type: 'ai-session-tab-selection-requested', projectId, tab: 'active' }` from the Host by selecting Active in the named project and persisting it through `writeAiSessionTabState`. This message is reserved for explicit New Session creation and must not be emitted by background Active-count changes.

Handle `{ type: 'ai-session-status-announcement', projectId, message }` by assigning validated plain text to that project's live region. Reject missing projects and non-string or overlong messages; do not inject message HTML.

- [ ] **Step 7: Exclude Active rows from batch management**

Change `selectUnpinned` and row-toggle handling to ignore `data-session-active` and disabled checkboxes. In `syncAiSessionBatchManagementDom`, always keep Active checkboxes disabled, including when the batch request is not pending. Reconcile only history panel rows for the selected provider.

- [ ] **Step 8: Update incremental project summary with three counts**

Change `updateOpenProjectAiSessionBadge(projectDiv, aiSessionCount, attentionCount)` to accept `activeSessionCount`. Update total, Active, and attention child nodes independently; do not overwrite `badge.textContent`, which would destroy child elements.

- [ ] **Step 9: Regenerate and test source/media equality**

Run:

```bash
npx gulp copyWebviewAssets
npm run test:dashboard
npm run test:safety
```

Expected: `Dashboard webview checks passed.` and `AI session safety checks passed.`

- [ ] **Step 10: Commit Webview behavior**

```bash
git add src/webview/webviewProjectScripts.js media/webviewProjectScripts.js \
  scripts/run-ai-session-safety-checks.js scripts/run-dashboard-webview-checks.js
git commit -m "feat: control AI session tabs in the webview"
```

---

### Task 7: Add Active Search Status and the Responsive Visual System

**Files:**
- Modify: `src/webview/dashboardViewModel.ts:5-100`
- Modify: `src/webview/webviewDashboardScripts.js:95-155`
- Modify: `media/styles.scss:2187-2739`
- Generate: `media/styles.css`
- Generate: `media/webviewDashboardScripts.js`
- Test: `scripts/run-ai-session-safety-checks.js`
- Test: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Consumes: `CodexSession.active`, renderer hooks, and inner-tab behavior.
- Produces: `DashboardSearchSessionItem.active` and themed styles for Active/Focused/Attention/Starting states.

- [ ] **Step 1: Add failing search and style assertions**

Extend `runDashboardSearchCatalogChecks()`:

```js
assert.strictEqual(catalog.sessions.find(item => item.sessionId === 'active-session').active, true);
```

Extend `runDashboardWebviewChecks()` so a Session search result with `active: true` contains a child whose text is `Active` and still posts the existing resume message on click.

Extend `runWebviewContentChecks()` source assertions for:

- `.ai-session-tabs`;
- `[data-session-status="focused"]`;
- `[data-session-status="needsAttention"]`;
- `[data-session-pending]`;
- `@media (max-width: 280px)`;
- `@media (prefers-reduced-motion: reduce)`.

- [ ] **Step 2: Run dashboard and safety checks to verify failure**

Run: `npm run test:dashboard && npm run test:safety`

Expected: FAIL on Active search metadata and missing SCSS selectors.

- [ ] **Step 3: Add Active metadata to the search catalog**

Extend `DashboardSearchSessionItem` with `active?: boolean`, and set it from `session.active`. In `renderDashboardSearchResults`, append:

```js
if (section.type === 'session' && item.active === true) {
    var activeBadge = document.createElement('span');
    activeBadge.className = 'dashboard-search-result-status active';
    activeBadge.textContent = 'Active';
    metadata.appendChild(activeBadge);
}
```

Do not add attention state to global search.

- [ ] **Step 4: Implement the themed segmented control and rows**

In `media/styles.scss`:

- make `.ai-session-module-header` a two-column flex row;
- make `.ai-session-tabs` a two-column grid with `role=tab` focus rings;
- keep `.ai-session-tab-panel[hidden] { display: none; }`;
- retain `--steward-ai-session-list-max-height` for both lists;
- use provider accent variables for the left stripe;
- use `--vscode-focusBorder` for Focused;
- use `--vscode-errorForeground` and input validation error border for Needs attention;
- use description foreground and a dashed border for Starting;
- style history `Active` as a neutral badge;
- keep disabled Archive and batch controls visually legible;
- separate total, Active, and attention project summary colors.

Use no fixed product colors except existing provider fallbacks where a VS Code token is unavailable.

- [ ] **Step 5: Add responsive and motion rules**

At `max-width: 280px`, hide short IDs and long time fragments before hiding provider/status, compact project summary labels to the dot/count form, and keep `NEW` text visible. Add:

```scss
@media (prefers-reduced-motion: reduce) {
    .codex-session-row,
    .project-codex-badge,
    .ai-session-attention-indicator {
        animation: none !important;
        transition: none !important;
    }
}
```

- [ ] **Step 6: Generate media and run visual-contract checks**

Run:

```bash
npx gulp buildStyles
npx gulp copyWebviewAssets
npm run test:dashboard
npm run test:safety
```

Expected: both check scripts pass, and source/media Webview scripts are byte-identical.

- [ ] **Step 7: Run lint and TypeScript compile**

Run: `npm run lint && npm run test-compile`

Expected: both commands exit 0 with no TypeScript or TSLint errors.

- [ ] **Step 8: Commit search and visuals**

```bash
git add src/webview/dashboardViewModel.ts src/webview/webviewDashboardScripts.js \
  media/webviewDashboardScripts.js media/styles.scss media/styles.css \
  scripts/run-ai-session-safety-checks.js scripts/run-dashboard-webview-checks.js
git commit -m "feat: style active AI session management"
```

---

### Task 8: Document, Run Full Regression Verification, and Review the Branch

**Files:**
- Modify: `README.md:60-68`
- Verify: all files changed by Tasks 1–7

**Interfaces:**
- Consumes: the complete implementation.
- Produces: user-facing documentation and final evidence that the feature meets the approved PRD.

- [ ] **Step 1: Update the AI Sessions documentation**

Replace the current provider-selector-only description with exact behavior:

```markdown
Open a current-workspace project card to switch between `ACTIVE` and `SESSIONS`.
`ACTIVE` collects every Codex, Kimi, and Claude session that is open in a live
VS Code terminal. `SESSIONS` keeps the complete history for the selected provider,
including sessions that are already active. Clicking an active session focuses its
terminal; clicking an inactive history entry resumes it.

Use `NEW` to choose Codex, Kimi, or Claude explicitly before Project Steward opens
the terminal. Active sessions must be closed before they can be archived.
```

- [ ] **Step 2: Run the full relevant verification suite**

Run:

```bash
npm run test:safety
npm run test:dashboard
npm run test:open-projects
npm run test:architecture-baseline
npm run lint
npm run vscode:prepublish
```

Expected:

- AI session safety checks pass;
- Dashboard Webview checks pass;
- Open-project safety checks pass;
- architecture baseline checks pass;
- TSLint exits 0;
- production Webpack and Gulp builds exit 0.

- [ ] **Step 3: Verify generated artifacts and worktree scope**

Run:

```bash
git diff --check
cmp src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
cmp src/webview/webviewDashboardScripts.js media/webviewDashboardScripts.js
git status --short
```

Expected: no whitespace errors; both `cmp` commands exit 0; only intended feature and generated files are modified.

- [ ] **Step 4: Perform the manual interaction matrix in an Extension Development Host**

Verify each case and record pass/fail in the implementation session notes:

1. no Active Session defaults to `SESSIONS`;
2. one or more Active Sessions default to `ACTIVE` only before a manual Tab choice exists;
3. Codex, Kimi, and Claude Active rows appear together;
4. Active history rows stay in their provider list and focus instead of duplicating a Terminal;
5. New always opens provider selection and then the optional title prompt;
6. Starting upgrades to a real row without duplication;
7. close confirmation cancels safely and closes only after confirmation;
8. Active Archive and batch selection remain unavailable;
9. reload restores Terminal ownership before default Tab selection;
10. 260px and 400px widths, keyboard-only navigation, high-contrast theme, and reduced motion remain usable;
11. another VS Code window reveals no Session detail in `OTHER WINDOWS`.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain AI session management tabs"
```

- [ ] **Step 6: Run the repository review/fix loop before publication**

Invoke the repository `review-fix-commit-loop` skill. Review the complete branch against `docs/superpowers/specs/2026-07-18-ai-session-management-tabs-design.md`, apply only evidence-backed corrections, re-run the affected verification commands, and create intentional follow-up commits rather than squashing fixes silently.
