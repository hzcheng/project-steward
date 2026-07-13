# Active AI Session Terminal Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Highlight the visible AI session row that belongs to the focused VS Code terminal while its existing completion marker shows that the AI command is still running.

**Architecture:** Extend `AiSessionTerminalService` with reverse terminal resolution, then use a small generic coordinator to own the single completion timer and current highlighted identity. The extension host publishes a lightweight message, while the Webview keeps transient identity state and reapplies a row attribute after both full initialization and incremental DOM replacement.

**Tech Stack:** TypeScript 4, VS Code Extension API `^1.51.0`, browser JavaScript Webview, SCSS/Gulp, Node.js `assert` safety checks, webpack 5

## Global Constraints

- Reuse existing terminal tracking and `.done` markers; do not add a second persisted lifecycle state.
- Highlight at most one session: the session belonging to `vscode.window.activeTerminal`.
- Never auto-expand a project or auto-switch the selected provider.
- Remove the highlight when the terminal changes or closes, or within approximately one second after its marker appears.
- Run at most one one-second completion timer, and only while the Sidebar is visible and a running AI session terminal is active.
- Preserve existing resume, terminal reuse, archive, pin, alias, and batch-management behavior.
- Add no runtime dependency and keep compatibility with VS Code `^1.51.0`.
- Keep source and generated Webview assets identical.
- Preserve the user's `.vscode/settings.json` change.
- Do not commit without explicit user approval.

## File Structure

- Create `src/aiSessions/activeTerminalHighlight.ts`: generic identity and resolution types plus the isolated one-timer coordinator.
- Modify `src/aiSessions/terminalService.ts`: reverse-resolve a terminal using tracked entries and existing environment/name matching.
- Modify `src/aiSessions/types.ts`: define the host-to-Webview active-terminal message.
- Modify `src/dashboard.ts`: instantiate the coordinator, wire VS Code terminal/visibility events, answer the Webview handshake, and resynchronize after terminal tracking changes.
- Modify `src/webview/webviewProjectScripts.js`: own transient active identity, apply the row attribute, request initial state, and reconcile after incremental updates.
- Regenerate `media/webviewProjectScripts.js` from the source script.
- Modify `media/styles.scss` and regenerate `media/styles.css`: add theme-aware active-row styling that coexists with batch selection.
- Modify `scripts/run-ai-session-safety-checks.js`: executable coordinator, terminal resolution, host wiring, Webview lifecycle, asset, and styling coverage.

---

### Task 1: One-Timer Active Terminal Coordinator

**Files:**

- Create: `src/aiSessions/activeTerminalHighlight.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**

- Produces: `ACTIVE_AI_SESSION_TERMINAL_CHECK_INTERVAL_MS`, `ActiveAiSessionTerminalIdentity`, `ActiveAiSessionTerminalResolution<TTerminal, TEntry>`, `ActiveAiSessionTerminalHighlightDependencies<TTerminal, TEntry>`, and default class `ActiveAiSessionTerminalHighlighter<TTerminal, TEntry>`.
- Consumes: only injected callbacks and timer functions; this module must not import `vscode`.

- [ ] **Step 1: Add the failing coordinator checks**

Require the compiled module near the other pure AI-session modules:

```js
const activeTerminalHighlight = require('../out/aiSessions/activeTerminalHighlight');
```

Add `runActiveAiSessionTerminalHighlightChecks()` with fake terminals, resolutions, and timer handles:

```js
function runActiveAiSessionTerminalHighlightChecks() {
    const terminalA = { name: 'A' };
    const terminalB = { name: 'B' };
    let activeTerminal = terminalA;
    let visible = true;
    let complete = new Set();
    let published = [];
    let timers = [];
    const resolutions = new Map([
        [terminalA, { terminal: terminalA, provider: 'codex', sessionId: 'a', entry: { markerPath: 'a.done' } }],
        [terminalB, { terminal: terminalB, provider: 'kimi', sessionId: 'b', entry: { markerPath: 'b.done' } }],
    ]);
    const highlighter = new activeTerminalHighlight.default({
        isVisible: () => visible,
        getActiveTerminal: () => activeTerminal,
        resolveTerminal: terminal => resolutions.get(terminal) || null,
        isComplete: resolution => complete.has(resolution.sessionId),
        publish: identity => published.push(identity),
        setInterval: callback => {
            const handle = { callback, active: true };
            timers.push(handle);
            return handle;
        },
        clearInterval: handle => { handle.active = false; },
    });

    highlighter.sync();
    assert.deepStrictEqual(published.pop(), { provider: 'codex', sessionId: 'a' });
    assert.strictEqual(timers.filter(timer => timer.active).length, 1);

    activeTerminal = terminalB;
    highlighter.sync();
    assert.deepStrictEqual(published.pop(), { provider: 'kimi', sessionId: 'b' });
    assert.strictEqual(timers.filter(timer => timer.active).length, 1);

    complete.add('b');
    timers.find(timer => timer.active).callback();
    assert.strictEqual(published.pop(), null);
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);

    complete.clear();
    activeTerminal = terminalA;
    highlighter.sync();
    highlighter.handleTerminalClosed(terminalA);
    assert.strictEqual(published.pop(), null);
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);

    visible = false;
    highlighter.setVisible(false);
    highlighter.sync();
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);

    visible = true;
    highlighter.setVisible(true);
    highlighter.request();
    assert.deepStrictEqual(published.pop(), { provider: 'codex', sessionId: 'a' });
    assert.strictEqual(timers.filter(timer => timer.active).length, 1);

    highlighter.dispose();
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);
}
```

Call this function from `main()` before the host/Webview checks.

- [ ] **Step 2: Run the safety suite and verify RED**

Run:

```bash
npm run test:safety
```

Expected: TypeScript compilation succeeds for existing files, then Node fails with `Cannot find module '../out/aiSessions/activeTerminalHighlight'`.

- [ ] **Step 3: Implement the generic coordinator**

Create `src/aiSessions/activeTerminalHighlight.ts`:

```ts
'use strict';

import type { AiSessionProviderId } from '../models';

export const ACTIVE_AI_SESSION_TERMINAL_CHECK_INTERVAL_MS = 1000;

export interface ActiveAiSessionTerminalIdentity {
    provider: AiSessionProviderId;
    sessionId: string;
}

export interface ActiveAiSessionTerminalResolution<TTerminal, TEntry>
    extends ActiveAiSessionTerminalIdentity {
    terminal: TTerminal;
    entry: TEntry;
}

export interface ActiveAiSessionTerminalHighlightDependencies<TTerminal, TEntry> {
    isVisible: () => boolean;
    getActiveTerminal: () => TTerminal | null;
    resolveTerminal: (terminal: TTerminal) => ActiveAiSessionTerminalResolution<TTerminal, TEntry> | null;
    isComplete: (resolution: ActiveAiSessionTerminalResolution<TTerminal, TEntry>) => boolean;
    publish: (identity: ActiveAiSessionTerminalIdentity | null) => void;
    setInterval: (callback: () => void, intervalMs: number) => unknown;
    clearInterval: (handle: unknown) => void;
}

export default class ActiveAiSessionTerminalHighlighter<TTerminal, TEntry> {
    private timer: unknown = null;
    private resolution: ActiveAiSessionTerminalResolution<TTerminal, TEntry> = null;
    private currentIdentity: ActiveAiSessionTerminalIdentity = null;

    constructor(private readonly dependencies: ActiveAiSessionTerminalHighlightDependencies<TTerminal, TEntry>) { }

    sync(forcePublish: boolean = false) {
        this.stopTimer();
        this.resolution = null;
        if (!this.dependencies.isVisible()) {
            this.currentIdentity = null;
            return;
        }

        let terminal = this.dependencies.getActiveTerminal();
        let resolution = terminal ? this.dependencies.resolveTerminal(terminal) : null;
        if (!resolution || this.dependencies.isComplete(resolution)) {
            this.setIdentity(null, forcePublish);
            return;
        }

        this.resolution = resolution;
        this.setIdentity({ provider: resolution.provider, sessionId: resolution.sessionId }, forcePublish);
        this.timer = this.dependencies.setInterval(
            () => this.checkCompletion(),
            ACTIVE_AI_SESSION_TERMINAL_CHECK_INTERVAL_MS
        );
    }

    request() {
        this.sync(true);
    }

    setVisible(visible: boolean) {
        if (visible) {
            this.sync(true);
            return;
        }
        this.stopTimer();
        this.resolution = null;
        this.currentIdentity = null;
    }

    handleTerminalClosed(terminal: TTerminal) {
        if (!this.resolution || this.resolution.terminal !== terminal) {
            return;
        }
        this.stopTimer();
        this.resolution = null;
        this.setIdentity(null);
    }

    dispose() {
        this.stopTimer();
        this.resolution = null;
        this.currentIdentity = null;
    }

    private checkCompletion() {
        if (!this.resolution
            || !this.dependencies.isVisible()
            || this.dependencies.getActiveTerminal() !== this.resolution.terminal) {
            this.sync();
            return;
        }
        if (this.dependencies.isComplete(this.resolution)) {
            this.stopTimer();
            this.resolution = null;
            this.setIdentity(null);
        }
    }

    private setIdentity(identity: ActiveAiSessionTerminalIdentity | null, forcePublish: boolean = false) {
        let currentKey = this.currentIdentity
            ? `${this.currentIdentity.provider}:${this.currentIdentity.sessionId}`
            : '';
        let nextKey = identity ? `${identity.provider}:${identity.sessionId}` : '';
        this.currentIdentity = identity;
        if (forcePublish || currentKey !== nextKey) {
            this.dependencies.publish(identity);
        }
    }

    private stopTimer() {
        if (this.timer !== null) {
            this.dependencies.clearInterval(this.timer);
            this.timer = null;
        }
    }
}
```

- [ ] **Step 4: Run the safety suite and verify GREEN**

Run `npm run test:safety`.

Expected: `runActiveAiSessionTerminalHighlightChecks()` passes and the existing suite prints `AI session safety checks passed.`

- [ ] **Step 5: Review checkpoint**

Run:

```bash
git diff --check
git diff -- src/aiSessions/activeTerminalHighlight.ts scripts/run-ai-session-safety-checks.js
```

Present the diff for review. Do not commit without explicit user approval.

---

### Task 2: Reverse Terminal-to-Session Resolution

**Files:**

- Modify: `src/aiSessions/terminalService.ts:7-10,35-45,154-188,259-268`
- Modify: `scripts/run-ai-session-safety-checks.js:1-35`

**Interfaces:**

- Consumes: `ActiveAiSessionTerminalResolution<vscode.Terminal, AiSessionTerminalEntry<vscode.Terminal>>` from Task 1.
- Produces: `AiSessionTerminalService.resolveTerminalSession(terminal, getProviderCandidates)`.

- [ ] **Step 1: Extend the VS Code test shim and add failing reverse-resolution checks**

Keep `Module._load` patched until `AiSessionTerminalService` has been required. The shim must expose a mutable terminal array:

```js
const vscodeTestState = { terminals: [] };
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {
            Uri: { parse: createTestUri, file: createTestFileUri },
            window: { terminals: vscodeTestState.terminals },
        };
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};
const AiSessionTerminalService = require('../out/aiSessions/terminalService').default;
```

Add a check that covers tracked lookup, environment recovery, terminal-name recovery, and ordinary terminals:

```js
function runAiSessionTerminalResolutionChecks() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-active-terminal-'));
    try {
        const service = new AiSessionTerminalService(tempRoot, providerId =>
            providers.getAiSessionProviderDefinition(providerId), 0
        );
        const tracked = { name: 'Codex: One [session-]', creationOptions: {} };
        service.track('codex', 'session-one', {
            terminal: tracked,
            markerPath: path.join(tempRoot, 'session-one.done'),
        });
        const candidateCalls = [];
        const candidates = {
            codex: [{ id: 'session-env', name: 'Environment' }],
            kimi: [{ id: 'named-123456', name: 'Named' }],
        };
        const getCandidates = providerId => {
            candidateCalls.push(providerId);
            return candidates[providerId] || [];
        };

        assert.strictEqual(service.resolveTerminalSession(tracked, getCandidates).sessionId, 'session-one');
        assert.deepStrictEqual(candidateCalls, []);

        const byEnv = {
            name: 'Codex restored',
            creationOptions: { env: { PROJECT_STEWARD_CODEX_SESSION_ID: 'session-env' } },
        };
        const byName = { name: 'Kimi: Named [named-12]', creationOptions: {} };
        const ordinary = { name: 'bash', creationOptions: {} };
        vscodeTestState.terminals.splice(0, vscodeTestState.terminals.length, byEnv, byName, ordinary);
        assert.strictEqual(service.resolveTerminalSession(byEnv, getCandidates).sessionId, 'session-env');
        assert.deepStrictEqual(candidateCalls, ['codex']);
        candidateCalls.length = 0;
        assert.strictEqual(service.resolveTerminalSession(byName, getCandidates).sessionId, 'named-123456');
        assert.deepStrictEqual(candidateCalls, ['kimi']);
        candidateCalls.length = 0;
        assert.strictEqual(service.resolveTerminalSession(ordinary, getCandidates), null);
        assert.deepStrictEqual(candidateCalls, []);
    } finally {
        vscodeTestState.terminals.length = 0;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}
```

- [ ] **Step 2: Run `npm run test:safety` and verify RED**

Expected: failure because `resolveTerminalSession` is not defined.

- [ ] **Step 3: Implement reverse resolution by reusing existing matching rules**

Import the resolution type from Task 1 and add:

```ts
resolveTerminalSession(
    terminal: vscode.Terminal,
    getProviderCandidates: (providerId: AiSessionProviderId) => readonly CodexSession[]
): ActiveAiSessionTerminalResolution<vscode.Terminal, AiSessionTerminalEntry<vscode.Terminal>> {
    if (!terminal) {
        return null;
    }

    for (let providerId of AI_SESSION_PROVIDER_IDS) {
        for (let [sessionId, entry] of this.terminals[providerId]) {
            if (entry.terminal === terminal) {
                return { provider: providerId, sessionId, terminal, entry };
            }
        }
    }

    let providerId = this.getTerminalProvider(terminal);
    if (!providerId) {
        return null;
    }

    for (let session of getProviderCandidates(providerId) || []) {
        if (!this.terminalMatchesSession(providerId, terminal, session.id)) {
            continue;
        }
        let entry = { terminal, markerPath: this.getMarkerPath(providerId, session.id) };
        this.track(providerId, session.id, entry);
        return { provider: providerId, sessionId: session.id, terminal, entry };
    }

    return null;
}
```

Use only a cheap provider environment/name-prefix prefilter before loading candidates. Do not add another full short-ID parser; `terminalMatchesSession()` remains the exact environment/name rule. Environment recovery must still find the session in the provider's current candidates before it is tracked again.

- [ ] **Step 4: Run the safety suite and verify GREEN**

Run `npm run test:safety`.

Expected: tracked, environment, name, and ordinary-terminal checks all pass.

- [ ] **Step 5: Review checkpoint**

Run `git diff --check` and present the terminal service and test diff. Do not commit.

---

### Task 3: Extension Host Wiring and Webview Handshake

**Files:**

- Modify: `src/aiSessions/types.ts:49-100`
- Modify: `src/dashboard.ts:15-25,44-132,340-440,560-610,940-1010,2050-2125,2199-2226`
- Modify: `scripts/run-ai-session-safety-checks.js:510-650`

**Interfaces:**

- Consumes: coordinator and terminal resolution from Tasks 1-2.
- Produces: `request-active-ai-session-terminal` handling and `AiSessionActiveTerminalChangedMessage` with nullable provider/session ID.

- [ ] **Step 1: Add failing host-wiring assertions**

Add source checks that require:

```js
assert.ok(dashboard.includes('new ActiveAiSessionTerminalHighlighter'));
assert.ok(dashboard.includes('vscode.window.onDidChangeActiveTerminal'));
assert.ok(dashboard.includes("case 'request-active-ai-session-terminal':"));
assert.ok(dashboard.includes("type: 'active-ai-session-terminal-changed'"));
assert.ok(dashboard.includes('activeAiSessionTerminalHighlighter.handleTerminalClosed(terminal)'));
assert.ok(dashboard.includes('activeAiSessionTerminalHighlighter.sync()'));
assert.ok(dashboard.includes('activeAiSessionTerminalHighlighter.setVisible(webviewView.visible)'));
```

Also assert that the host candidate resolver obtains sessions only for the requested provider without changing project/provider UI state.

- [ ] **Step 2: Run `npm run test:safety` and verify RED**

Expected: the first new dashboard assertion fails.

- [ ] **Step 3: Define the host-to-Webview message**

Add to `src/aiSessions/types.ts`:

```ts
export interface AiSessionActiveTerminalChangedMessage {
    type: 'active-ai-session-terminal-changed';
    provider: AiSessionProviderId | null;
    sessionId: string | null;
}
```

- [ ] **Step 4: Instantiate and register the highlighter**

In `dashboard.ts`, import the Task 1 class/types, provide candidates lazily for the single plausible provider only when an untracked AI terminal must be recovered, and publish through the existing Sidebar provider:

```ts
const activeAiSessionTerminalHighlighter = new ActiveAiSessionTerminalHighlighter<
    vscode.Terminal,
    AiSessionTerminalEntry<vscode.Terminal>
>({
    isVisible: () => provider.visible,
    getActiveTerminal: () => vscode.window.activeTerminal || null,
    resolveTerminal: terminal => aiSessionTerminalService.resolveTerminalSession(
        terminal,
        providerId => getAiSessionTerminalCandidates(providerId)
    ),
    isComplete: resolution => aiSessionTerminalService.isComplete(resolution.entry),
    publish: identity => postActiveAiSessionTerminalChanged(identity),
    setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
});
```

Register `onDidChangeActiveTerminal` to call `sync()`. Extend the existing close listener to call `handleTerminalClosed(terminal)` after terminal-service cleanup. Dispose the highlighter with the extension.

Add:

```ts
function getAiSessionTerminalCandidates(providerId: AiSessionProviderId): readonly CodexSession[] {
    return getRegisteredAiSessionProvider(providerId).service.getSessions().sessions;
}

function postActiveAiSessionTerminalChanged(identity: ActiveAiSessionTerminalIdentity | null) {
    let message: AiSessionActiveTerminalChangedMessage = {
        type: 'active-ai-session-terminal-changed',
        provider: identity?.provider || null,
        sessionId: identity?.sessionId || null,
    };
    provider.postMessage(message).then(undefined, error => {
        logError('Failed to post the active AI session terminal.', error);
    });
}
```

- [ ] **Step 5: Wire visibility, requests, and tracking transitions**

After Sidebar visibility changes, call `activeAiSessionTerminalHighlighter.setVisible(webviewView.visible)`. Add the message case:

```ts
case 'request-active-ai-session-terminal':
    activeAiSessionTerminalHighlighter.request();
    break;
```

Call `sync()` after a resume command has deleted its old marker and been sent. In `resolvePendingAiSessionTerminals()`, remember whether any pending terminal was matched; after replacing the pending list, call `sync()` once when a match occurred.

- [ ] **Step 6: Run the safety suite and verify GREEN**

Run `npm run test:safety`.

Expected: all host wiring assertions pass and existing archive/resume checks remain green.

- [ ] **Step 7: Review checkpoint**

Run `git diff --check` and present the type, dashboard, and test diff. Do not commit.

---

### Task 4: Webview State, Highlight Styling, and Generated Assets

**Files:**

- Modify: `src/webview/webviewProjectScripts.js:1-110,350-420,760-870,940-965`
- Regenerate: `media/webviewProjectScripts.js`
- Modify: `media/styles.scss:1273-1340,1515-1540`
- Regenerate: `media/styles.css`
- Modify: `scripts/run-ai-session-safety-checks.js:510-620,868-1070`

**Interfaces:**

- Consumes: `active-ai-session-terminal-changed` and the initial request handler from Task 3.
- Produces: transient `{ provider, sessionId }`, `data-ai-session-active-terminal`, initial handshake, and theme-aware styling.

- [ ] **Step 1: Add failing Webview and style checks**

Add static assertions for the request, response, DOM attribute, SCSS selector, compiled selector, and generated-source equality:

```js
assert.ok(webviewProjectScripts.includes("type: 'request-active-ai-session-terminal'"));
assert.ok(webviewProjectScripts.includes("message.type === 'active-ai-session-terminal-changed'"));
assert.ok(webviewProjectScripts.includes('data-ai-session-active-terminal'));
assert.ok(styles.includes('[data-ai-session-active-terminal]'));
assert.ok(compiledStyles.includes('[data-ai-session-active-terminal]'));
```

Extend `runBatchAiSessionWebviewChecks()` or add a focused VM check that sends an active-terminal message, verifies only the matching row receives the attribute, clears it with a null message, and verifies `updateOpenProjectAiSessions()` reapplies it after replacement.

- [ ] **Step 2: Run `npm run test:safety` and verify RED**

Expected: failure on the first missing Webview request assertion.

- [ ] **Step 3: Implement transient Webview state and DOM synchronization**

Near the existing batch state, add:

```js
var activeAiSessionTerminalState = { provider: null, sessionId: null };

function syncActiveAiSessionTerminalDom() {
    document.querySelectorAll('.codex-session-row[data-session-id]').forEach(row => {
        var provider = row.getAttribute('data-session-provider') || 'codex';
        var sessionId = row.getAttribute('data-session-id');
        row.toggleAttribute(
            'data-ai-session-active-terminal',
            provider === activeAiSessionTerminalState.provider
                && sessionId === activeAiSessionTerminalState.sessionId
        );
    });
}
```

Handle the host message before `ai-sessions-updated`:

```js
if (message && message.type === 'active-ai-session-terminal-changed') {
    activeAiSessionTerminalState.provider = isAiSessionProvider(message.provider) ? message.provider : null;
    activeAiSessionTerminalState.sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
    syncActiveAiSessionTerminalDom();
    return;
}
```

Call the synchronizer after incremental session DOM replacement. After registering the `window` message listener, request initial state:

```js
window.vscode.postMessage({ type: 'request-active-ai-session-terminal' });
```

- [ ] **Step 4: Add active-row SCSS**

Place the active selector after provider/pinned row variants so it wins their background and pseudo-element values:

```scss
.codex-session-row[data-ai-session-active-terminal] {
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-list-hoverBackground);

    &::before {
        top: 5px;
        bottom: 5px;
        width: 3px;
        background: var(--vscode-focusBorder);
        opacity: 1;
    }
}
```

Do not override `[data-ai-session-managing] ... [data-ai-session-selected]` background. Because the active rule changes the existing `::before`, its left accent remains visible when batch selection supplies the full-row background.

- [ ] **Step 5: Regenerate assets**

Run:

```bash
npx gulp buildStyles copyWebviewAssets
```

Expected: `media/styles.css` contains the active selector and `media/webviewProjectScripts.js` exactly matches its source.

- [ ] **Step 6: Run the safety suite and verify GREEN**

Run `npm run test:safety`.

Expected: message lifecycle, matching/clearing, incremental reconciliation, SCSS, compiled CSS, and generated asset checks pass.

- [ ] **Step 7: Review checkpoint**

Run:

```bash
cmp -s src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
git diff --check
```

Present the Webview, SCSS, generated asset, and test diff. Do not commit.

---

### Task 5: Full Verification and Manual Smoke Test

**Files:**

- Verify all files from Tasks 1-4.
- Preserve: `.vscode/settings.json`

**Interfaces:**

- Consumes: completed terminal resolution, coordinator, host message lifecycle, and Webview presentation.
- Produces: evidence that the feature meets the approved design without regressing existing AI session behavior.

- [ ] **Step 1: Regenerate assets from source**

Run `npx gulp buildStyles copyWebviewAssets`.

Expected: both tasks finish successfully.

- [ ] **Step 2: Run automated verification**

Run:

```bash
npm run test:safety
npm run lint
npm run webpack
cmp -s src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
git diff --check
```

Expected:

- safety checks print `AI session safety checks passed.`;
- lint exits 0, allowing only the repository's existing legacy warnings;
- webpack compiles successfully, allowing only existing webpack deprecation warnings;
- source/generated comparison and diff check exit 0.

- [ ] **Step 3: Audit scope**

Run `git status --short` and `git diff --stat`.

Expected: only the design, plan, Task 1-4 source/test/generated files are in feature scope, while `.vscode/settings.json` remains the user's separate local modification.

- [ ] **Step 4: Run manual smoke tests**

Using the extension launch configuration, verify:

1. Focus a running Codex, Kimi, and Claude terminal where locally available; only its visible session row is highlighted.
2. Switch to an ordinary terminal; the previous highlight clears immediately.
3. Switch between two running AI terminals; exactly one row remains highlighted.
4. Exit an AI command without closing the terminal; its highlight clears within approximately one second.
5. Resume that completed session in the same terminal; its highlight returns after the marker is removed.
6. Close the active terminal; tracking and highlight clear.
7. Start a new AI session; once pending-terminal reconciliation discovers its ID, the visible row highlights if the terminal still has focus.
8. Select another provider or collapse the project; the UI does not auto-switch or auto-expand.
9. Enter batch management and select the active row; the batch background and active left accent coexist.
10. Hide and reopen the Sidebar; the initial handshake restores only a currently running active session.

- [ ] **Step 5: Present results for review**

Report command exit codes, existing warnings, manual observations, and exact intended commit scope. Do not stage or commit until the user explicitly approves.
