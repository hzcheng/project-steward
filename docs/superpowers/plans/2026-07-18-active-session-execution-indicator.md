# ACTIVE Session Execution Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an independent green `Running` or gray `Stopped` indicator on each bound ACTIVE Session card, while pending cards remain gray `Starting` and attention/focus keep their existing independent behavior.

**Architecture:** Extend the existing normalized provider lifecycle signal with an additive execution field, then feed it to a dedicated in-memory execution monitor/controller that is never gated by the attention setting. Project the controller snapshot into ACTIVE view models and render the execution state as accessible inline metadata; keep attention and focus as separate booleans and preserve their existing sort priority.

**Tech Stack:** TypeScript, VS Code extension API, provider JSONL lifecycle parsers, Sass/CSS, Node.js safety-check harness using `assert`.

## Global Constraints

- Work only on `feat/active-session-execution-indicator` in `.worktrees/feat-active-session-execution-indicator`; do not modify the main checkout.
- Execution means turn-level AI generation/tool execution, not Terminal process liveness.
- Only explicit provider lifecycle events change bound Sessions between `running` and `stopped`; never infer stopped from inactivity.
- No reliable lifecycle signal means `stopped`; a pending NEW Terminal means `starting`.
- Attention confirmation and configuration must not change or disable execution state.
- Focus changes must not change execution state.
- Running/Stopped changes must not affect ACTIVE ordering, counts, filters, or SESSIONS rows.
- Preserve current Terminal completion/removal, attention publication, incremental rendering, and provider cache behavior.
- Add no dependencies and do not publish a version.

---

### Task 1: Normalize execution state in provider lifecycle signals

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js:5506-5595`
- Modify: `src/aiSessions/lifecycle.ts:1-160`
- Modify: `src/aiSessions/attentionController.ts:63-74`

**Interfaces:**
- Produces: `AiSessionLifecycleSignal.executionState: 'running' | 'stopped'`.
- Preserves: `phase`, `reason`, `token`, and `occurredAtMs` for the existing attention monitor.

- [ ] **Step 1: Add failing lifecycle assertions**

In `runLifecycleParserChecks()`, assert the independent field on each provider and add an out-of-order case:

```js
    assert.strictEqual(codexSignal.executionState, 'stopped');
    assert.strictEqual(lifecycle.parseCodexLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:08.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'newer' } }),
        JSON.stringify({ timestamp: '2026-07-15T00:00:07.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'older' } }),
    ], runStartedAtMs).executionState, 'stopped', 'event time wins over physical line order');
    assert.strictEqual(lifecycle.parseCodexLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:09.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } }),
    ], runStartedAtMs).executionState, 'running');
```

Add equivalent direct assertions that Kimi `TurnEnd` and Claude `end_turn` are `stopped`, and that Kimi `TurnBegin` and Claude `user` are `running`. Retain all existing `phase`/`reason` assertions so the attention contract cannot regress.

- [ ] **Step 2: Run the focused compiled harness and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL because `executionState` is currently `undefined`; the existing lifecycle tests must compile first.

- [ ] **Step 3: Extend the lifecycle contract and helpers**

In `src/aiSessions/lifecycle.ts`, add:

```ts
export type AiSessionExecutionState = 'running' | 'stopped';

export interface AiSessionLifecycleSignal {
    token: string;
    phase: AiSessionLifecyclePhase;
    reason?: AiSessionAttentionReason;
    executionState: AiSessionExecutionState;
    occurredAtMs: number;
}
```

Return `executionState: 'running'` from `running(...)` and `executionState: 'stopped'` from `attention(...)`. Do not change `phase` or `reason`.

Add `executionState: 'stopped' as const` to the Terminal-exit signal synthesized by `AiSessionAttentionController.evaluate()`. Attention still ignores this field, but every object satisfying the normalized lifecycle contract must be complete.

In `parseLines(...)`, replace physical-last assignment with event-time selection:

```ts
        let signal = parseEvent(event, occurredAtMs);
        if (signal && (!latest || signal.occurredAtMs >= latest.occurredAtMs)) {
            latest = signal;
        }
```

The `>=` tie behavior deliberately preserves the later physical event when two provider records share a timestamp, while rejecting genuinely older events.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
git diff --check
git add src/aiSessions/lifecycle.ts src/aiSessions/attentionController.ts scripts/run-ai-session-safety-checks.js
git commit -m "feat: normalize AI session execution state"
```

Expected: lifecycle and safety checks pass; the commit contains only the signal contract, parser ordering, and tests.

---

### Task 2: Track execution independently from attention

**Files:**
- Create: `src/aiSessions/executionMonitor.ts`
- Create: `src/aiSessions/executionController.ts`
- Modify: `scripts/run-ai-session-safety-checks.js:1-95,1434-1570,6450-6510`

**Interfaces:**
- Consumes: current `AiSessionActiveTerminalRuntime[]` and provider `getLifecycleSignals(...)`.
- Produces: `Record<string, AiSessionExecutionSnapshot>` keyed by `provider:sessionId`.

- [ ] **Step 1: Register imports and add failing monitor/controller checks**

Add compiled-module imports near the existing lifecycle/attention imports:

```js
const AiSessionExecutionMonitor = require('../out/aiSessions/executionMonitor').default;
const AiSessionExecutionController = require('../out/aiSessions/executionController').AiSessionExecutionController;
```

Add `runAiSessionExecutionMonitorChecks()` covering:

```js
function runAiSessionExecutionMonitorChecks() {
    let now = 1000;
    const monitor = new AiSessionExecutionMonitor({ now: () => now });
    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1' }]), []);
    assert.strictEqual(monitor.getSnapshot()['codex:s1'].state, 'stopped');

    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1', signal: {
        token: 'run-1', phase: 'running', executionState: 'running', occurredAtMs: 1100,
    } }]), ['codex:s1']);
    assert.strictEqual(monitor.getSnapshot()['codex:s1'].state, 'running');
    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1', signal: {
        token: 'run-1', phase: 'running', executionState: 'running', occurredAtMs: 1100,
    } }]), [], 'same token is idempotent');
    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1', signal: {
        token: 'old-stop', phase: 'needsAttention', reason: 'completed', executionState: 'stopped', occurredAtMs: 1099,
    } }]), [], 'older signal cannot overwrite current execution state');
    assert.strictEqual(monitor.getSnapshot()['codex:s1'].state, 'running');

    now = 1200;
    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1', signal: {
        token: 'stop-2', phase: 'needsAttention', reason: 'input-required', executionState: 'stopped', occurredAtMs: 1200,
    } }]), ['codex:s1']);
    assert.strictEqual(monitor.getSnapshot()['codex:s1'].state, 'stopped');
    monitor.evaluate([]);
    assert.deepStrictEqual(monitor.getSnapshot(), {});
}
```

Add `runAiSessionExecutionControllerChecks()` with one Codex active runtime, empty Kimi/Claude providers, and a mutable returned signal. Assert:

- a running signal schedules exactly one `execution` refresh and appears in the snapshot;
- repeating it schedules nothing;
- a newer stopped signal schedules one more refresh;
- clearing active runtimes removes the snapshot without querying unrelated providers;
- a controller option named `isEnabled` does not exist and attention configuration is never read.

Invoke the monitor check beside `runAttentionMonitorChecks()` and `await` the controller check beside `runAiSessionAttentionControllerChecks()` in `main()`.

- [ ] **Step 2: Run compilation and verify RED**

Run:

```bash
npm run test-compile
```

Expected: FAIL because `executionMonitor.ts` and `executionController.ts` do not exist.

- [ ] **Step 3: Implement the execution monitor**

Create `src/aiSessions/executionMonitor.ts` with these public contracts:

```ts
import type { AiSessionExecutionState, AiSessionLifecycleSignal } from './lifecycle';

export interface AiSessionExecutionInput {
    key: string;
    signal?: AiSessionLifecycleSignal;
}

export interface AiSessionExecutionSnapshot {
    state: AiSessionExecutionState;
    stateChangedAt: number;
}

export default class AiSessionExecutionMonitor {
    constructor(options: { now?: () => number } = {});
    evaluate(inputs: AiSessionExecutionInput[]): string[];
    getSnapshot(): Record<string, AiSessionExecutionSnapshot>;
}
```

Internally retain `lastSignalToken` and `lastOccurredAtMs`. Create unseen entries as `stopped`; ignore a duplicate token or a signal older than `lastOccurredAtMs`; accept equal-time distinct tokens in input order; return a key only when the visible state changed; remove entries not present in the current input set. Return cloned public snapshots without internal ordering fields.

- [ ] **Step 4: Implement the independent controller**

Create `src/aiSessions/executionController.ts` with:

```ts
export interface AiSessionExecutionProvider {
    id: AiSessionProviderId;
    service: {
        getLifecycleSignals(requests: readonly AiSessionLifecycleRequest[]): Record<string, AiSessionLifecycleSignal>;
    };
}

export interface AiSessionExecutionControllerOptions {
    getActiveSessions: () => AiSessionActiveTerminalRuntime[];
    getProviders: () => AiSessionExecutionProvider[];
    getSessionKey?: (providerId: AiSessionProviderId, sessionId: string) => string;
    scheduleRefresh: (reason: string) => void;
    nowMs: () => number;
}
```

`evaluate()` must group active runtimes into one request array per provider, call each provider only when its request array is non-empty, pass `{ key, signal }` to the monitor, and call `scheduleRefresh('execution')` only when `monitor.evaluate(...)` returns changed keys. `getSnapshot()` delegates to the monitor. Do not import the attention controller, monitor, aggregate, payload, configuration, or Project model.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
git diff --check
git add src/aiSessions/executionMonitor.ts src/aiSessions/executionController.ts scripts/run-ai-session-safety-checks.js
git commit -m "feat: track AI session execution activity"
```

Expected: monitor/controller checks pass and repeated signals do not schedule redundant refreshes.

---

### Task 3: Project execution snapshots without changing ordering

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js:889-981`
- Modify: `src/aiSessions/types.ts:1-40`
- Modify: `src/aiSessions/activeSessionProjection.ts:1-190`

**Interfaces:**
- Introduces: optional `ApplyAiSessionRuntimeProjectionInput.executionSnapshot` so the unchanged Dashboard remains compilable until Task 4 supplies the live snapshot and tightens it to required.
- Produces: `ActiveAiSessionViewModel.executionState: 'starting' | 'running' | 'stopped'`.
- Temporarily preserves: overloaded `ActiveAiSessionStatus` and `ActiveAiSessionViewModel.status` only as a renderer compatibility field until Task 5 removes both in the same TDD cycle as the renderer migration.

- [ ] **Step 1: Rewrite projection tests around three orthogonal axes**

Pass this snapshot in the primary projection fixture:

```js
        executionSnapshot: {
            'codex:c1': { state: 'running', stateChangedAt: 100 },
            'kimi:k1': { state: 'stopped', stateChangedAt: 200 },
        },
```

Keep the existing status assertion as a renderer-compatibility regression and add:

```js
    assert.deepStrictEqual(projected[0].activeAiSessions.map(item => ({
        provider: item.provider,
        executionState: item.executionState,
        focused: item.focused,
        needsAttention: item.needsAttention,
    })), [
        { provider: 'kimi', executionState: 'stopped', focused: false, needsAttention: true },
        { provider: 'codex', executionState: 'running', focused: true, needsAttention: false },
        { provider: 'claude', executionState: 'starting', focused: false, needsAttention: false },
    ]);
```

Add a second projection with the Codex/Kimi execution states swapped and assert provider order remains `['kimi', 'codex', 'claude']`. Assert the historyless bound Session defaults to `stopped`. Pass `executionSnapshot: {}` to fixtures that have no signals.

- [ ] **Step 2: Run compilation and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL because the projection ignores `executionSnapshot` and does not return `executionState`.

- [ ] **Step 3: Add the execution field and decouple ordering from overloaded status**

In `src/aiSessions/types.ts`, import `AiSessionExecutionState` as a type and define:

```ts
export type ActiveAiSessionExecutionState = 'starting' | AiSessionExecutionState;

export interface ActiveAiSessionViewModel {
    // existing identity/name fields
    // Keep status through Task 4 so the unchanged renderer still compiles.
    executionState: ActiveAiSessionExecutionState;
    focused: boolean;
    needsAttention: boolean;
    pending: boolean;
    // existing optional fields
}
```

In `activeSessionProjection.ts`, add `executionSnapshot?: Record<string, AiSessionExecutionSnapshot>` to the input. Bound models use `(input.executionSnapshot || {})[key]?.state || 'stopped'`; pending models use `starting`. The field is temporarily optional only because the Dashboard wiring belongs to Task 4. Continue populating the legacy `status` field only for the unchanged renderer; do not use it as the source of execution truth.

Remove `getStatusRank()`. Implement sort rank directly from the orthogonal booleans:

```ts
function getPriorityRank(model: ActiveAiSessionViewModel): number {
    return model.needsAttention ? 0 : model.focused ? 1 : model.pending ? 3 : 2;
}
```

Use that rank in `compareActiveSessions`; keep pending oldest-first and all bound non-pending Sessions newest-first. Never read `executionState` in the comparator.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
git diff --check
git add src/aiSessions/types.ts src/aiSessions/activeSessionProjection.ts scripts/run-ai-session-safety-checks.js
git commit -m "feat: project active session execution state"
```

Expected: projection tests pass, including default-stopped and unchanged-order assertions; the legacy renderer continues compiling until its Task 5 migration.

---

### Task 4: Wire continuous execution evaluation into the Dashboard

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js:2670-2860,4190-4210`
- Modify: `src/aiSessions/activeSessionProjection.ts:12-25`
- Modify: `src/dashboard.ts:45-65,460-505,920-975,1181-1195`

**Interfaces:**
- Produces: a one-second in-memory execution snapshot refresh for currently active bound Sessions.
- Preserves: the separate ten-second attention polling and attention enabled gate.

- [ ] **Step 1: Add failing Dashboard architecture assertions**

In `runWebviewContentChecks()`, read `executionController.ts`, extract its `evaluate` body, and assert:

```js
    assert.ok(dashboard.includes("import { AiSessionExecutionController } from './aiSessions/executionController';"));
    assert.ok(dashboard.includes('const aiSessionExecutionController = new AiSessionExecutionController({'));
    assert.ok(dashboard.includes('getActiveSessions: () => aiSessionTerminalService.getActiveSessions()'));
    assert.ok(dashboard.includes('executionSnapshot: aiSessionExecutionController.getSnapshot()'));
    assert.match(dashboard, /aiSessionExecutionInterval = setInterval\(\(\) => \{ aiSessionExecutionController\.evaluate\(\); \}, 1_000\)/);
    assert.ok(dashboard.includes('clearInterval(aiSessionExecutionInterval)'));
    assert.ok(!evaluateExecutionFunction.includes('isEnabled'));
    assert.ok(!evaluateExecutionFunction.includes('attention'));
```

Also assert the attention controller still contains its existing `isEnabled()` branch and still reads `signal.phase`, proving the feature is additive rather than a replacement.

- [ ] **Step 2: Run the safety harness and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL on the missing Dashboard controller/wiring assertions.

- [ ] **Step 3: Construct and schedule the controller**

Import and instantiate `AiSessionExecutionController` next to the attention controller:

```ts
    const aiSessionExecutionController = new AiSessionExecutionController({
        getActiveSessions: () => aiSessionTerminalService.getActiveSessions(),
        getProviders: getRegisteredAiSessionProviders,
        getSessionKey: getAiSessionKey,
        scheduleRefresh: reason => scheduleAiSessionRefresh(reason),
        nowMs: () => Date.now(),
    });
```

Start an immediate evaluation and a one-second interval independently of `aiSessionAttention.enabled`:

```ts
    const aiSessionExecutionInterval = setInterval(() => { aiSessionExecutionController.evaluate(); }, 1_000);
    setTimeout(() => { aiSessionExecutionController.evaluate(); }, 0);
```

Clear the interval in the existing subscription disposal block. On Terminal close, call `aiSessionExecutionController.evaluate()` after `handleClosedTerminal(...)` so stale snapshots are pruned immediately. The one-second poll handles binding, next-turn, tool, completion, failure, abort, and input-request transitions; do not duplicate attention calls or modify its ten-second interval.

- [ ] **Step 4: Feed the snapshot into runtime projection**

In `getOpenProjects()`, add:

```ts
            executionSnapshot: aiSessionExecutionController.getSnapshot(),
```

Once the Dashboard supplies that value, make `ApplyAiSessionRuntimeProjectionInput.executionSnapshot` required by removing the temporary `?` and simplify bound lookup to `input.executionSnapshot[key]?.state || 'stopped'`. Keep the hydration, active/pending Terminal ownership, focused identity, CWD matching, and path normalization inputs unchanged.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run test:safety
npm run test:dashboard
git diff --check
git add src/aiSessions/activeSessionProjection.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js
git commit -m "feat: wire active session execution monitoring"
```

Expected: both suites pass; source assertions prove execution evaluation remains active regardless of attention configuration.

---

### Task 5: Render the accessible green/gray indicator

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js:2670-2790,2890-2940`
- Modify: `src/aiSessions/types.ts:1-40`
- Modify: `src/aiSessions/activeSessionProjection.ts:1-190`
- Modify: `src/webview/webviewContent.ts:740-778`
- Modify: `media/styles.scss` in the sidebar `.codex-session-row` section
- Regenerate: `media/styles.css`

**Interfaces:**
- Consumes: `ActiveAiSessionViewModel.executionState`.
- Produces: `data-execution-state`, visible status text, static dot, and state-specific accessible text.

- [ ] **Step 1: Rewrite rendering fixtures and add failing HTML/style assertions**

Replace every ACTIVE fixture `status` with `executionState`: focused Codex `running`, attention Kimi `stopped`, normal Claude `running`, pending Claude `starting`. This is the point where the compatibility `status` field is removed from the model and projection.

Assert all three attributes and labels exist:

```js
    assert.ok(sessionTabsHtml.includes('data-execution-state="running"'));
    assert.ok(sessionTabsHtml.includes('data-execution-state="stopped"'));
    assert.ok(sessionTabsHtml.includes('data-execution-state="starting"'));
    assert.ok(sessionTabsHtml.includes('class="ai-session-execution-status"'));
    assert.ok(sessionTabsHtml.includes('class="ai-session-execution-dot"'));
    assert.ok(sessionTabsHtml.includes('aria-label="AI is currently executing"'));
    assert.ok(sessionTabsHtml.includes('aria-label="AI is not currently executing"'));
    assert.ok(sessionTabsHtml.includes('aria-label="Waiting for AI activity"'));
    assert.ok(sessionTabsHtml.includes('AI session needs attention'));
    assert.ok(!sessionTabsHtml.includes('data-session-status='));
```

Assert Sass and compiled CSS contain execution selectors, Terminal green with fallback, description foreground for stopped/starting, and use `[data-session-focused]` plus `[data-session-needs-attention]` instead of old `[data-session-status]` selectors.

- [ ] **Step 2: Run the safety harness and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL because the renderer still expects `status` and no indicator markup/styles exist.

- [ ] **Step 3: Render execution metadata independently**

In `getActiveAiSessionRow(...)`, map the three states:

```ts
    var executionLabel = model.executionState === 'running' ? 'Running'
        : model.executionState === 'starting' ? 'Starting'
            : 'Stopped';
    var executionAriaLabel = model.executionState === 'running' ? 'AI is currently executing'
        : model.executionState === 'starting' ? 'Waiting for AI activity'
            : 'AI is not currently executing';
    var executionStatus = `<span class="ai-session-execution-status" aria-label="${executionAriaLabel}"><span class="ai-session-execution-dot" aria-hidden="true"></span>${executionLabel}</span>`;
    var metadata = [providerLabel, executionStatus, createdAt, shortSessionId].filter(Boolean).join(' · ');
```

Set `data-execution-state="${model.executionState}"` on the ACTIVE row and remove `data-session-status`. Add `data-session-needs-attention` whenever `model.needsAttention` is true; preserve the existing event-id-dependent `data-ai-session-attention` attribute for attention synchronization and preserve `data-session-focused` for focus styling.

In the same step, remove `ActiveAiSessionStatus` and `ActiveAiSessionViewModel.status` from `src/aiSessions/types.ts`; remove `getEstablishedStatus()` and all `status` assignments from `activeSessionProjection.ts`. The renderer and model therefore migrate atomically and the task remains independently compilable.

- [ ] **Step 4: Add static, theme-aware styles**

In the sidebar session-row Sass block add:

```scss
.ai-session-execution-status {
    display: inline-flex;
    align-items: center;
    gap: 3px;
}

.ai-session-execution-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: currentColor;
}

.codex-session-row[data-execution-state="running"] .ai-session-execution-status {
    color: var(--vscode-terminal-ansiGreen, #89d185);
}

.codex-session-row[data-execution-state="stopped"] .ai-session-execution-status,
.codex-session-row[data-execution-state="starting"] .ai-session-execution-status {
    color: var(--vscode-descriptionForeground);
}
```

Move existing focus styling from `[data-session-status="focused"]` to `[data-session-focused]`, and attention styling from `[data-session-status="needsAttention"]` to `[data-session-needs-attention]`. Add no animation.

- [ ] **Step 5: Regenerate minified CSS and verify GREEN**

Run the repository's existing Sass parity path:

```bash
npx gulp buildStyles --production
npm run test:safety
npm run test:dashboard
git diff --check
```

Expected: HTML, Sass, compiled CSS, accessibility, orthogonal combination, and CSS parity checks pass.

- [ ] **Step 6: Commit the UI**

Run:

```bash
git add src/aiSessions/types.ts src/aiSessions/activeSessionProjection.ts src/webview/webviewContent.ts media/styles.scss media/styles.css scripts/run-ai-session-safety-checks.js
git commit -m "feat: show active session execution indicator"
```

---

### Task 6: Regression review and final verification

**Files:**
- Review: all files changed from `origin/main`
- Modify only if a regression test exposes a defect.

- [ ] **Step 1: Prove complete spec coverage**

Run:

```bash
rg -n "ActiveAiSessionStatus|data-session-status|\.status" src/aiSessions src/webview/webviewContent.ts media/styles.scss scripts/run-ai-session-safety-checks.js
rg -n "executionState|executionSnapshot|data-execution-state|ai-session-execution" src media/styles.scss scripts/run-ai-session-safety-checks.js
```

Expected: the first command finds no obsolete ACTIVE status model/selectors (unrelated `.status` uses may be manually classified); the second command shows lifecycle, monitor/controller, projection, Dashboard, renderer, styles, and tests.

- [ ] **Step 2: Run the full relevant verification matrix from fresh output**

Run:

```bash
npm run lint
npm run test:safety
npm run test:dashboard
npm run test:architecture-baseline
npm run vscode:prepublish
git diff --check
git status -sb
git log --oneline origin/main..HEAD
```

Expected: every command exits `0`; no generated file is stale; the branch contains the design, plan, lifecycle, monitor/controller, projection, Dashboard wiring, UI, and test commits only.

- [ ] **Step 3: Self-review the exact branch diff**

Run:

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- src/aiSessions/lifecycle.ts src/aiSessions/executionMonitor.ts src/aiSessions/executionController.ts src/aiSessions/activeSessionProjection.ts src/aiSessions/types.ts src/dashboard.ts src/webview/webviewContent.ts media/styles.scss scripts/run-ai-session-safety-checks.js
```

Review specifically for: attention-gating leakage, inactivity heuristics, execution-based sorting, missing default-stopped behavior, stale snapshots after Terminal close, unsafe raw HTML, animation, obsolete status selectors, and accidental release/version changes.

- [ ] **Step 4: Record any review fix as an intentional commit**

If review finds an issue, first add a failing regression assertion, implement the smallest fix, rerun the full verification matrix, and commit with a scoped message. If no issue is found, do not create an empty review commit.
