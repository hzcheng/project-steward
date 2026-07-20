# Completed AI Session Attention Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep completed AI Session attention visible in `OTHER WINDOWS` for both VS Code Terminal and tmux runtimes until the user explicitly clicks the Session or project card.

**Architecture:** Keep unread completion entries in the main extension's attention monitor after runtime ownership disappears, preserve the logical-session-to-run-key mapping needed to acknowledge them, and let successful bridge publication release runtime lifecycle state without marking the event read. The existing UI Bridge protocol and `0.1.3` package remain unchanged; its acknowledged-event set continues to suppress events acknowledged from another window.

**Tech Stack:** TypeScript 4.0, Node `assert` safety tests, VS Code Extension API, existing attention snapshot/aggregate protocol.

## Global Constraints

- Work only in `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/feat-session-tmux-support`.
- Use test-driven development: add each regression assertion and observe the intended failure before changing production code.
- Preserve distinct per-run event IDs of the form `provider:sessionId:runStartedAtMs:backend`.
- Runtime publication confirmation must never call a user-acknowledgement API.
- A failed publication must retain the completed runtime for retry.
- The attention UI Bridge source, protocol, manifest, and version `0.1.3` must not change.
- Do not bump the main extension version or resume merge/tag/release work until manual acceptance passes.

---

## File Structure

- `src/aiSessions/attentionMonitor.ts`: retain only unseen unread entries after their runtime input disappears.
- `src/aiSessions/attentionController.ts`: preserve and bound retained run mappings, fold run events into logical Session acknowledgement data, and settle runtime delivery without automatic acknowledgement.
- `src/dashboard.ts`: wire lifecycle settlement to publication and release only; retain explicit click acknowledgement paths.
- `scripts/run-ai-session-safety-checks.js`: behavioral regressions for monitor retention, controller republication, logical Session acknowledgement, both runtime backends, and bridge filtering.
- `CHANGELOG.md`: record restoration of completed cross-window attention for direct and tmux runtimes.

---

### Task 1: Preserve Unread Monitor Entries Without Preserving Stale States

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js:7954`
- Modify: `src/aiSessions/attentionMonitor.ts:87`

**Interfaces:**
- Consumes: `AiSessionAttentionMonitor.evaluate(inputs)` and `acknowledge(eventIds)`.
- Produces: the invariant that an unseen `needsAttention` entry survives, while an unseen acknowledged entry is pruned.

- [ ] **Step 1: Add the failing monitor regression**

After the existing `complete-1` acknowledgement assertion in
`runAttentionMonitorChecks`, add an isolated monitor so the later generation
checks retain their existing history:

```js
const retentionMonitor = new AiSessionAttentionMonitor({ now: () => now });
const retentionEvents = retentionMonitor.evaluate([{
    key: 'codex:retained',
    signal: signal('retained-complete', 'needsAttention', 'completed'),
}]);
assert.deepStrictEqual(retentionMonitor.evaluate([]), [],
    'runtime removal does not generate a second attention event');
assert.strictEqual(
    retentionMonitor.getSnapshot()['codex:retained'].state,
    'needsAttention',
    'runtime removal must retain unread completion attention'
);
retentionMonitor.acknowledge([retentionEvents[0].eventId]);
assert.strictEqual(retentionMonitor.getSnapshot()['codex:retained'].state, 'acknowledged');
retentionMonitor.evaluate([]);
assert.strictEqual(
    retentionMonitor.getSnapshot()['codex:retained'],
    undefined,
    'an explicitly acknowledged entry may be pruned after runtime removal'
);
```

- [ ] **Step 2: Compile and run the safety test to verify RED**

Run:

```bash
npm run test-compile
node scripts/run-ai-session-safety-checks.js
```

Expected: compilation succeeds, then the safety test fails because
`retentionMonitor.getSnapshot()['codex:retained']` is `undefined` after
`evaluate([])`.

- [ ] **Step 3: Implement minimal state-aware pruning**

In `AiSessionAttentionMonitor.evaluate`, replace unconditional unseen-entry deletion with:

```ts
for (const [key, entry] of this.entries) {
    if (!seen.has(key) && entry.state !== 'needsAttention') {
        this.entries.delete(key);
    }
}
```

This retains no `pending`, `running`, or `acknowledged` state after ownership disappears.

- [ ] **Step 4: Re-run the focused safety test to verify GREEN**

Run:

```bash
npm run test-compile
node scripts/run-ai-session-safety-checks.js
```

Expected: `AI session safety checks passed.`

- [ ] **Step 5: Commit the monitor invariant**

```bash
git add src/aiSessions/attentionMonitor.ts scripts/run-ai-session-safety-checks.js
git commit -m "fix: retain unread attention without runtime ownership"
```

---

### Task 2: Retain Per-Run Items and Acknowledge Them Through the Logical Session

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js:2020`
- Modify: `src/aiSessions/attentionController.ts:1-360`

**Interfaces:**
- Consumes: retained monitor snapshots from Task 1 and `MAX_ATTENTION_ITEMS` from `src/aiSessions/attentionPayload.ts`.
- Produces: `getRecoverySessionEvents()` grouped by logical `provider:sessionId`, retained owner snapshot items after runtime removal, and a maximum of 1,000 published items.

- [ ] **Step 1: Add a failing controller retention regression**

In `runAiSessionAttentionControllerChecks`, after the existing multi-run assertions, add a dedicated controller:

```js
const retainedPublished = [];
const retainedController = new AiSessionAttentionController({
    isEnabled: () => true,
    getOpenProjects: () => projects,
    getProviders: () => providersForTest,
    getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
    getProjectKey: project => attentionProject.getAttentionProjectKey(project.path),
    getRuntimeById: () => null,
    isRuntimeComplete: runtime => runtime.state === 'completed',
    publish: async items => {
        retainedPublished.push(items.map(item => ({ ...item })));
        return true;
    },
    scheduleRefresh: () => undefined,
    postProjectsUpdated: () => undefined,
    nowMs: () => nowMs,
});
const retainedKey = 'codex:session-a:900:tmux';
await retainedController.evaluate([{
    providerId: 'codex',
    sessionId: 'session-a',
    attentionKey: retainedKey,
    runtime: oldInactiveRuntime,
}]);
const retainedEventId = retainedPublished[0][0].eventId;
await retainedController.evaluate();
assert.deepStrictEqual(retainedPublished[1], [retainedPublished[0][0]],
    'an owner snapshot must keep publishing unread completion after runtime removal');
assert.deepStrictEqual(retainedController.getRecoverySessionEvents(), [{
    sessionKey: 'codex:session-a',
    eventIds: [retainedEventId],
}], 'a Session click must address its retained per-run attention event');
retainedController.acknowledge([retainedEventId]);
await retainedController.evaluate();
assert.deepStrictEqual(retainedPublished[2], [],
    'explicit Session acknowledgement removes the retained owner item');
```

- [ ] **Step 2: Add a failing 1,000-item bound regression**

Create 1,001 completed overrides for the same logical Session and assert the final publication contains the newest 1,000 observations:

```js
const boundedPublished = [];
const boundedController = new AiSessionAttentionController({
    isEnabled: () => true,
    getOpenProjects: () => projects,
    getProviders: () => providersForTest,
    getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
    getProjectKey: project => attentionProject.getAttentionProjectKey(project.path),
    getRuntimeById: () => null,
    isRuntimeComplete: runtime => runtime.state === 'completed',
    publish: async items => { boundedPublished.push(items); return true; },
    scheduleRefresh: () => undefined,
    postProjectsUpdated: () => undefined,
    nowMs: () => nowMs,
});
await boundedController.evaluate(Array.from({ length: 1001 }, (_, index) => ({
    providerId: 'codex',
    sessionId: 'session-a',
    attentionKey: `codex:session-a:${index}:tmux`,
    runtime: { ...oldInactiveRuntime, runStartedAtMs: index + 1 },
})));
assert.strictEqual(boundedPublished[0].length, 1000,
    'retained attention publication must respect the protocol item bound');
assert.strictEqual(Math.min(...boundedPublished[0].map(item => item.observedAtMs)), 2,
    'the bounded publication keeps the newest completion observations');
```

- [ ] **Step 3: Compile and run the safety test to verify RED**

Run:

```bash
npm run test-compile
node scripts/run-ai-session-safety-checks.js
```

Expected: the retained publication is empty or the recovery key remains run-specific; the bounded case may also throw `attention payload items must be a bounded array`.

- [ ] **Step 4: Preserve and prune attention-key mappings**

Do not clear `attentionKeysBySession` at the start of every enabled evaluation. Add new run keys only once:

```ts
const keys = this.attentionKeysBySession.get(owned.baseSessionKey) || [];
if (!keys.includes(attentionKey)) {
    keys.push(attentionKey);
    keys.sort();
}
this.attentionKeysBySession.set(owned.baseSessionKey, keys);
```

After `this.monitor.evaluate(inputs)`, prune mappings whose monitor entries no longer exist:

```ts
private pruneAttentionKeysBySession(): void {
    const snapshotKeys = new Set(Object.keys(this.monitor.getSnapshot()));
    for (const [sessionKey, attentionKeys] of this.attentionKeysBySession) {
        const retained = attentionKeys.filter(key => snapshotKeys.has(key));
        if (retained.length) {
            this.attentionKeysBySession.set(sessionKey, retained);
        } else {
            this.attentionKeysBySession.delete(sessionKey);
        }
    }
}
```

Call `pruneAttentionKeysBySession()` after each enabled monitor evaluation. Keep the existing full clear when attention is disabled.

- [ ] **Step 5: Fold run keys into logical Session recovery data**

Add:

```ts
private getLogicalSessionKey(attentionKey: string): string {
    for (const [sessionKey, attentionKeys] of this.attentionKeysBySession) {
        if (attentionKeys.includes(attentionKey)) {
            return sessionKey;
        }
    }
    return attentionKey;
}
```

In `getRecoverySessionEvents`, call `addEvent(this.getLogicalSessionKey(sessionKey), eventId)` for monitor and aggregate events. This keeps lifecycle settlement run-specific while making the Session click acknowledge every retained run event.

- [ ] **Step 6: Bound owner items deterministically**

Import `MAX_ATTENTION_ITEMS` beside `AttentionPayloadItem` and end `buildLocalItems` with:

```ts
return items
    .sort((left, right) => right.observedAtMs - left.observedAtMs
        || (left.eventId || '').localeCompare(right.eventId || ''))
    .slice(0, MAX_ATTENTION_ITEMS);
```

- [ ] **Step 7: Re-run the focused safety test to verify GREEN**

Run:

```bash
npm run test-compile
node scripts/run-ai-session-safety-checks.js
```

Expected: `AI session safety checks passed.`

- [ ] **Step 8: Commit controller retention**

```bash
git add src/aiSessions/attentionController.ts scripts/run-ai-session-safety-checks.js
git commit -m "fix: retain completed attention owner snapshots"
```

---

### Task 3: Separate Runtime Delivery From Explicit Acknowledgement

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js:2174-2290`
- Modify: `scripts/run-ai-session-safety-checks.js:4688`
- Modify: `scripts/run-ai-session-safety-checks.js:8045`
- Modify: `src/aiSessions/attentionController.ts:360-470`
- Modify: `src/dashboard.ts:670-740`
- Modify: `CHANGELOG.md:5-25`

**Interfaces:**
- Consumes: `AiSessionAttentionEvaluation.published`, `inScopeSessionKeys`, and `eventIdsBySession`.
- Produces: `settleAiSessionRuntimeLifecycles(options)` with only `evaluateAttention`, `release`, and optional redacted failure reporting; explicit UI handlers remain the only acknowledgement callers.

- [ ] **Step 1: Rewrite the settlement test to require both backends and zero acknowledgement**

Replace the current `completionOrder` fixture with candidates carrying both backend labels:

```js
const completionOrder = [];
const candidates = [
    { key: 'codex:session-a:700:vscode', state: 'completed', backend: 'vscode' },
    { key: 'codex:session-b:800:tmux', state: 'completed', backend: 'tmux' },
    { key: 'kimi:missing-event', state: 'completed', backend: 'tmux' },
    { key: 'claude:out-of-scope', state: 'completed', backend: 'vscode' },
    { key: 'codex:stopped', state: 'stopped', backend: 'tmux' },
];
const settled = await settleAiSessionRuntimeLifecycles({
    candidates,
    evaluateAttention: async () => {
        completionOrder.push('publish');
        return {
            enabled: true,
            published: true,
            inScopeSessionKeys: [
                'codex:session-a:700:vscode',
                'codex:session-b:800:tmux',
                'kimi:missing-event',
            ],
            eventIdsBySession: {
                'codex:session-a:700:vscode': ['direct-completed-event'],
                'codex:session-b:800:tmux': ['tmux-completed-event'],
            },
        };
    },
    release: candidate => completionOrder.push(`release:${candidate.backend}:${candidate.key}`),
});
assert.deepStrictEqual(settled, {
    releasedKeys: [
        'claude:out-of-scope',
        'codex:session-a:700:vscode',
        'codex:session-b:800:tmux',
        'codex:stopped',
    ],
    retainedKeys: ['kimi:missing-event'],
});
assert.deepStrictEqual(completionOrder, [
    'publish',
    'release:vscode:claude:out-of-scope',
    'release:vscode:codex:session-a:700:vscode',
    'release:tmux:codex:session-b:800:tmux',
    'release:tmux:codex:stopped',
], 'delivery releases both backends without acknowledging user attention');
```

Remove `acknowledgePublished` and `acknowledgeLocal` from every settlement fixture. Keep the publication-failure, disabled-attention, evaluation-failure, and release-failure cases; reduce the rejected-operation loop to `release` because acknowledgement is no longer a settlement operation.

- [ ] **Step 2: Add the bridge-filtering regression**

In `runAttentionPayloadChecks`, prove that explicit acknowledgement remains effective when an owner republishes its retained item:

```js
const republishedOwner = attentionPayload.validateAttentionOwnerSnapshot({
    ...owner,
    sequence: 2,
    heartbeat: 2,
});
const acknowledgedRepublish = attentionAggregate.aggregateAttentionSnapshots(
    [republishedOwner],
    new Set(['e']),
    22
);
assert.deepStrictEqual(acknowledgedRepublish.sessions, [],
    'a project-card acknowledgement must suppress retained owner republication');
```

- [ ] **Step 3: Tighten the source-wiring regression**

Replace the static assertion that requires acknowledgement callbacks in the settlement call with:

```js
const settlementCall = dashboard.match(/settleAiSessionRuntimeLifecycles\(\{[\s\S]*?\n\s*\}\);/)?.[0] || '';
assert.ok(settlementCall.includes('attentionKey: candidate.key'));
assert.ok(settlementCall.includes('release: async candidate =>'));
assert.ok(!settlementCall.includes('acknowledgePublished'));
assert.ok(!settlementCall.includes('acknowledgeLocal'));
assert.doesNotMatch(
    dashboard,
    /setRemoteAggregate\(aggregate\)[\s\S]*?getReleasedSessions\(\)\.forEach/,
    'a later aggregate must not auto-acknowledge a delivered completion'
);
```

- [ ] **Step 4: Run the focused suite to verify RED**

Run:

```bash
npm run test-compile
node scripts/run-ai-session-safety-checks.js
```

Expected: the settlement order includes `ack:` and `local:` entries, or the new TypeScript call shape fails because acknowledgement callbacks are still required.

- [ ] **Step 5: Simplify the settlement contract and implementation**

Change the failure operation union to:

```ts
export type AiSessionRuntimeLifecycleFailureOperation = 'evaluate' | 'release';
```

Remove both acknowledgement callbacks from `SettleAiSessionRuntimeLifecyclesOptions`. Replace the event-ID reduction and acknowledgement block with direct delivery eligibility:

```ts
const deliveredCompletions = candidates.filter(candidate => candidate.state === 'completed'
    && evaluation.enabled && inScope.has(candidateSessionKey(candidate))
    && evaluation.published
    && (evaluation.eventIdsBySession[candidateSessionKey(candidate)] || []).length > 0);

const eligibleByKey = new Map<string, TCandidate>();
for (const candidate of [...safeToRelease, ...deliveredCompletions]) {
    eligibleByKey.set(candidate.key, candidate);
}
```

Keep evaluation and release exception containment unchanged.

- [ ] **Step 6: Remove automatic acknowledgement wiring from the Dashboard**

In the `settleAiSessionRuntimeLifecycles` call, delete:

```ts
acknowledgePublished: eventIds => aiSessionAttentionBridgeClient.acknowledge(eventIds),
acknowledgeLocal: eventIds => aiSessionAttentionController.acknowledge(eventIds),
```

In the attention bridge aggregate callback, remove the `getReleasedSessions().forEach(...)` recovery loop. Preserve `acknowledgeAiSessionAttention` itself and the `acknowledge-ai-session-attention` message handler because they implement explicit user interaction.

- [ ] **Step 7: Record the regression fix**

Under `CHANGELOG.md` → `[Unreleased]` → `Fixed`, add:

```markdown
-   Preserve completed AI Session attention in `OTHER WINDOWS` after VS Code Terminal or tmux runtime cleanup, until the user clicks the Session or project card.
```

- [ ] **Step 8: Run focused and cross-window safety suites to verify GREEN**

Run:

```bash
npm run test-compile
node scripts/run-ai-session-safety-checks.js
node scripts/run-open-project-safety-checks.js
```

Expected: both scripts report their `passed` messages.

- [ ] **Step 9: Commit lifecycle separation**

```bash
git add src/aiSessions/attentionController.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js CHANGELOG.md
git commit -m "fix: preserve completed session attention until interaction"
```

---

### Task 4: Full Verification and Manual Acceptance Handoff

**Files:**
- Verify only; do not modify production files unless a failing check identifies a scoped defect.

**Interfaces:**
- Consumes: all three implementation commits.
- Produces: release-quality evidence that the main extension and unchanged attention bridge package remain compatible.

- [ ] **Step 1: Run the complete safety suite**

```bash
npm run test:safety
```

Expected: TypeScript compilation, attention bridge compilation, tmux checks, AI Session safety checks, and Open Projects safety checks all pass.

- [ ] **Step 2: Run live tmux smoke verification**

```bash
npm run test:tmux:smoke
```

Expected: `AI session tmux smoke checks passed.` and no owned smoke tmux server remains.

- [ ] **Step 3: Build production assets and verify release packaging**

```bash
npm run vscode:prepublish
npm run test:release-packaging
```

Expected: webpack/gulp completes, release packaging assertions pass, and the bridge manifest remains version `0.1.3`.

- [ ] **Step 4: Check repository integrity**

```bash
git diff --check
git status --short
git diff -- extensions/attention-ui-bridge
```

Expected: no whitespace errors, only intentional generated production assets if the build tracks them, and no attention UI Bridge source or manifest diff.

- [ ] **Step 5: Package and install the main extension for manual testing**

Follow `.codex/skills/installing-vscode-extensions-locally/SKILL.md` exactly to build, package, install, and verify the correct extension host. Do not publish or tag.

- [ ] **Step 6: Perform two-window manual acceptance**

Verify this sequence first with `projectSteward.aiSessionTerminalMode = vscode`, then with `tmux`:

```text
Window A: start an AI Session and leave the project window unfocused
Window B: keep the project visible under OTHER WINDOWS
Window A: allow the AI run to complete
Window B: confirm the project red badge remains visible after runtime cleanup
Window B: click the project card
Both windows: confirm the badge disappears and does not replay
```

Also click a completed Session row in the owning window and confirm all retained events for that logical Session clear without clearing a newer unacknowledged run.

- [ ] **Step 7: Stop for user acceptance before release work**

Report the installed main-extension artifact identity, automated command results, and manual scenarios awaiting user confirmation. Do not bump `2.1.3`, merge, tag, or publish until the user confirms both runtime modes.
