# Tmux Initial Execution State Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a newly created tmux-backed AI session reports its first provider turn as `Running` immediately after pending-to-final promotion, then continues to report provider-native `Running` and `Stopped` transitions.

**Architecture:** Keep tmux liveness and provider execution state separate. `AiSessionProjectHydrationController` will preserve an in-flight promotion when the backend consumes its pending runtime, emit one safe successful-promotion notification, and dashboard composition will use that notification to evaluate the existing `AiSessionExecutionController` immediately. Existing one-second polling remains the fallback for later lifecycle events.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js assertion-based safety checks, tmux fake/smoke harnesses.

## Global Constraints

- Cover Codex, Kimi, and Claude.
- Cover `project` and `session` tmux layouts.
- Cover new-session first turns, later turns, resumed sessions, and `Running → Stopped` transitions.
- Do not infer execution state from a live tmux pane, shell, window, or session.
- Preserve Direct Terminal behavior and the existing one-second execution polling interval.
- Keep callback failures non-fatal to an already completed runtime promotion.
- Do not add prompt, response, command, executable-path, or provider-log content to diagnostics.

---

### Task 1: Preserve the in-flight promotion and emit one successful handoff

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js` in `runAiSessionProjectHydrationPromotionChecks`
- Modify: `src/aiSessions/projectHydrationController.ts`

**Interfaces:**
- Consumes: `AiSessionProjectHydrationControllerOptions<TTerminal>` and the existing `PendingPromotionSettlementMemo<TTerminal>`.
- Produces: optional callback `onDidPromoteRuntime?: () => void`, invoked once after a validated pending-to-final promotion succeeds.

- [ ] **Step 1: Write the failing in-flight-consumption regression test**

Extend `createHarness` so it records a successful promotion notification:

```js
const promotions = [];
// In the controller options:
onDidPromoteRuntime: () => {
    promotions.push('promoted');
    options.onPromoted?.();
},
// In the returned harness:
return { controller, terminalService, aliases, aliasesSet, syncs, diagnostics, promotions };
```

Add a controlled-promise case after the existing different-generation case:

```js
let visiblePending = [pendingRuntime];
let resolveConsumedPending;
const consumedPendingPromotion = new Promise(resolve => { resolveConsumedPending = resolve; });
const consumedPending = createHarness({
    runtimeCoordinator: {
        getActive: () => visiblePending.length ? [] : [finalRuntime],
        getPending: () => visiblePending,
        promotePending: () => consumedPendingPromotion,
    },
});
consumedPending.controller.hydrate(project('Promotion started'));
visiblePending = [];
consumedPending.controller.hydrate(project('Backend consumed pending'));
resolveConsumedPending([finalRuntime]);
await flushSettlements();
assert.deepStrictEqual(consumedPending.promotions, ['promoted'],
    'the promotion that consumed its own pending runtime must complete its handoff once');
assert.deepStrictEqual(consumedPending.aliasesSet,
    [['codex', 'session-final', 'Promoted Alias']]);
assert.strictEqual(consumedPending.diagnostics.some(diagnostic =>
    diagnostic.event === 'ai-session-pending-runtime-promotion-result'
    && diagnostic.failureReasons?.includes('stale-pending')), false);
```

Retain the existing `hydrate([])` cancellation assertion so closing the project scope still invalidates an in-flight settlement.

- [ ] **Step 2: Run the focused safety test and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL at the new `promotions` assertion because `reconcilePendingPromotionSettlements` retires the entry when the pending runtime disappears.

- [ ] **Step 3: Implement the minimal settlement-state repair**

Add the callback to `AiSessionProjectHydrationControllerOptions<TTerminal>`:

```ts
onDidPromoteRuntime?: () => void;
```

Make reconciliation distinguish a normal refresh from explicit scope invalidation:

```ts
private reconcilePendingPromotionSettlements(
    pendingRuntimes: readonly AiSessionPendingRuntimeSnapshot<TTerminal>[],
    retireInFlight: boolean = false
): void {
    const presentIdentities = new Set(/* existing projection */);
    for (const entry of this.pendingPromotionSettlements.values()) {
        if (!presentIdentities.has(entry.pendingIdentityKey)
            && (retireInFlight || entry.status !== 'pending')) {
            this.retirePendingPromotionSettlement(entry);
        }
    }
}
```

Call `reconcilePendingPromotionSettlements([], true)` from the empty-project branch. Keep the ordinary hydration call at its default `false` value.

After `getPendingAiSessionPromotionFailureReason` validates a successful result and after alias persistence succeeds, notify once from the memoized settlement's `settle` function:

```ts
entry.status = 'success';
this.options.setAlias(pendingRuntime.identity.provider, sessionId, pendingRuntime.title);
this.notifyRuntimePromoted();
return { failureReason: null };
```

Add a non-throwing helper:

```ts
private notifyRuntimePromoted(): void {
    try {
        this.options.onDidPromoteRuntime?.();
    } catch (error) {
        this.logDiagnostic({
            event: 'ai-session-runtime-promotion-notification-failed',
            category: error instanceof Error ? error.name : typeof error,
        });
    }
}
```

The callback is inside the single memoized settlement, so concurrent hydration generations cannot emit it twice.

- [ ] **Step 4: Add callback-failure and duplicate-notification checks**

Add assertions that:

```js
assert.deepStrictEqual(generations.promotions, ['promoted']);
assert.deepStrictEqual(reentrant.promotions, ['promoted']);
```

Add a harness whose `onPromoted` throws and assert that alias settlement still succeeds while diagnostics contain only the error category:

```js
const notificationFailure = createHarness({
    runtimeCoordinator: {
        getActive: () => [finalRuntime],
        getPending: () => [pendingRuntime],
        promotePending: () => [finalRuntime],
    },
    onPromoted: () => { throw new TypeError('do not expose this text'); },
});
notificationFailure.controller.hydrate(project('Notification failure'));
await flushSettlements();
assert.deepStrictEqual(notificationFailure.aliasesSet,
    [['codex', 'session-final', 'Promoted Alias']]);
assert.ok(notificationFailure.diagnostics.some(diagnostic =>
    diagnostic.event === 'ai-session-runtime-promotion-notification-failed'
    && diagnostic.category === 'TypeError'));
assert.strictEqual(JSON.stringify(notificationFailure.diagnostics).includes('do not expose this text'), false);
```

- [ ] **Step 5: Run the focused safety test and verify GREEN**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: `AI session safety checks passed.`

- [ ] **Step 6: Commit Task 1**

```bash
git add src/aiSessions/projectHydrationController.ts scripts/run-ai-session-safety-checks.js
git commit -m "fix: preserve tmux promotion execution handoff"
```

---

### Task 2: Evaluate execution state immediately after promotion

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `src/dashboard.ts`

**Interfaces:**
- Consumes: `AiSessionProjectHydrationControllerOptions.onDidPromoteRuntime` from Task 1 and `AiSessionExecutionController.evaluate(): void`.
- Produces: dashboard wiring that evaluates the final runtime immediately after promotion without changing polling.

- [ ] **Step 1: Write the failing dashboard-wiring test**

In the dashboard composition assertions, require the hydration controller callback to invoke the execution controller:

```js
assert.match(dashboard,
    /new AiSessionProjectHydrationController[\s\S]*?onDidPromoteRuntime: \(\) => \{[\s\S]*?aiSessionExecutionController\.evaluate\(\);[\s\S]*?\}/);
```

Expected behavior: the assertion fails because the callback is not wired yet.

- [ ] **Step 2: Run the focused safety test and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL at the new dashboard-wiring assertion.

- [ ] **Step 3: Wire the successful handoff to execution evaluation**

Add the callback to the `AiSessionProjectHydrationController` construction in `src/dashboard.ts`:

```ts
onDidPromoteRuntime: () => {
    aiSessionExecutionController.evaluate();
},
```

The closure is safe because the hydration controller constructor remains side-effect free and no hydration occurs until activation has initialized `aiSessionExecutionController`.

- [ ] **Step 4: Add the provider/layout execution-handoff matrix**

In `runAiSessionProjectHydrationPromotionChecks`, parameterize final runtime fixtures across:

```js
const handoffFixtures = [
    ['codex', 'project'], ['codex', 'session'],
    ['kimi', 'project'], ['kimi', 'session'],
    ['claude', 'project'], ['claude', 'session'],
];
```

For each fixture, construct an `AiSessionExecutionController` whose provider returns a first `running` signal, update the runtime coordinator from pending to final during `promotePending`, and invoke `executionController.evaluate()` from `onPromoted`. Assert:

```js
assert.strictEqual(
    executionController.getSnapshot()[`${providerId}:${sessionId}`].state,
    'running'
);
assert.strictEqual(evaluationCount, 1);
assert.strictEqual(finalRuntime.runStartedAtMs, pendingRuntime.runStartedAtMs);
```

Then replace the provider signal with the provider's existing stopped semantic and evaluate again:

```js
signal = {
    token: `${providerId}:stop:${sessionId}`,
    phase: 'needsAttention',
    reason: 'completed',
    executionState: 'stopped',
    occurredAtMs: pendingRuntime.runStartedAtMs + 2_000,
};
executionController.evaluate();
assert.strictEqual(
    executionController.getSnapshot()[`${providerId}:${sessionId}`].state,
    'stopped'
);
```

Keep the existing provider parser tests as the source of truth for actual Codex, Kimi, and Claude event shapes. This matrix verifies the backend/layout-neutral handoff rather than duplicating parser behavior.

- [ ] **Step 5: Add Direct Terminal non-regression coverage**

Run the same handoff controller assertion with a Direct Terminal final runtime and verify the callback performs one evaluation and preserves its original `runStartedAtMs`. Do not change Direct Terminal promotion code.

- [ ] **Step 6: Run the focused safety test and verify GREEN**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: `AI session safety checks passed.`

- [ ] **Step 7: Commit Task 2**

```bash
git add src/dashboard.ts scripts/run-ai-session-safety-checks.js
git commit -m "fix: evaluate execution after runtime promotion"
```

---

### Task 3: Verify the full runtime and packaging surface

**Files:**
- Update: `docs/manual-tests/ai-session-tmux-runtime.md` only with fresh command results and the new handoff coverage; do not claim an interactive UI result that was not run.
- If a verification command fails, stop this task and add a new failing regression assertion before changing the source file responsible for that failure.

**Interfaces:**
- Consumes: the completed promotion handoff and dashboard execution wiring.
- Produces: fresh automated evidence and an auditable manual-test record.

- [ ] **Step 1: Run tmux and safety suites**

```bash
npm run test:tmux
npm run test:safety
```

Expected:

```text
AI session tmux checks passed.
AI session safety checks passed.
Open project safety checks passed.
```

- [ ] **Step 2: Run real tmux smoke checks**

```bash
npm run test:tmux:smoke
```

Expected: `AI session tmux smoke checks passed.` and no owned smoke tmux server remains.

- [ ] **Step 3: Run compile and release packaging checks**

```bash
npm run test-compile
npm run vscode:prepublish
npm run test:release-packaging
```

Expected: exit code 0 with no TypeScript or packaging assertion failures.

- [ ] **Step 4: Update the manual acceptance record**

Record the exact commands, date, environment, and automated matrix coverage in `docs/manual-tests/ai-session-tmux-runtime.md`. Mark the interactive green-dot retest as `NOT RUN` unless it is actually performed with the newly installed build.

- [ ] **Step 5: Review the final diff**

```bash
git diff --check
git status -sb
git diff HEAD~2 -- src/aiSessions/projectHydrationController.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js docs/manual-tests/ai-session-tmux-runtime.md
```

Confirm the diff contains only the promotion handoff repair, tests, and evidence update.

- [ ] **Step 6: Commit verification documentation if changed**

```bash
git add docs/manual-tests/ai-session-tmux-runtime.md
git commit -m "docs: record tmux execution handoff verification"
```

- [ ] **Step 7: Re-run the final verification gate**

Run all commands from Steps 1–3 again after the final commit. Do not claim the bug fixed until the new regression test, full safety suite, real tmux smoke suite, compile, and packaging checks all exit successfully.
