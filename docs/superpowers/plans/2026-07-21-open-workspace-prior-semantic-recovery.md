# Open Workspace Prior-Semantic Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a current-generation acknowledgement after bridge failure even when the desired workspace matches a previously acknowledged semantic.

**Architecture:** Track recovery acknowledgement need independently from `lastSemantic`. Failures set an explicit boolean, healthy duplicate suppression requires it to be clear, and only current-generation success or disposal clears it.

**Tech Stack:** TypeScript, Node.js assertion-based safety scripts, VS Code command bridge.

## Global Constraints

- Preserve `lastSemantic` across failures for healthy semantic suppression.
- Workspace and repeated `null` cases each observe exactly four commands: prior success, failed heartbeat, stale retry success, and latest success.
- Latest promise and `ready` must wait for the latest command acknowledgement.
- Preserve different-generation coalescing, healthy sequencing, retry backoff, heartbeat behavior, and dispose/unregister ordering.

---

### Task 1: Separate recovery health from acknowledged semantic

**Files:**
- Modify: `scripts/run-open-project-safety-checks.js`
- Modify: `src/openWorkspaces/bridgeClient.ts`
- Modify: `.superpowers/sdd/task-11-report.md`

**Interfaces:**
- Consumes: `OpenWorkspaceBridgeClient.publish(workspace, followsFocusEvent?): Promise<boolean>`, the injected heartbeat callback, publication command promises, timers, and status callback.
- Produces: private `recoveryAcknowledgementRequired: boolean` governing semantic duplicate suppression and recovery completion.

- [ ] **Step 1: Write the failing workspace and null regressions**

Add a shared helper that completes the initial command, verifies one healthy
identical `publish()` is suppressed, fails a heartbeat, fires its retry, holds
the first recovery command, and queues the identical latest generation. For a
workspace and for `null`, assert before resolving the latest command:

```js
assert.strictEqual(publications.length, 4);
assert.strictEqual(latestSettled, false);
assert.deepStrictEqual(statuses, ['ready', 'unavailable']);
```

After resolving the latest command, assert:

```js
assert.strictEqual(await latestPublication, true);
assert.deepStrictEqual(statuses, ['ready', 'unavailable', 'ready']);
assert.strictEqual(activeTimers.size, 0);
```

- [ ] **Step 2: Run focused verification for RED**

Run:

```bash
npm run test-compile
npm run attention:bridge:compile
node scripts/run-open-project-safety-checks.js
```

Expected: the first new case fails with three publication commands instead of
four because the latest identical generation is suppressed by the prior
semantic.

- [ ] **Step 3: Implement explicit recovery acknowledgement state**

Add the state near the other bridge flags:

```ts
private recoveryAcknowledgementRequired = true;
```

Require health for the duplicate shortcut:

```ts
if (!this.recoveryAcknowledgementRequired
    && !forceHeartbeat
    && !followsFocusEvent
    && semantic === this.lastSemantic) { return true; }
```

Set the flag before transient failure status/retry handling in both publication
and handshake failure paths:

```ts
this.recoveryAcknowledgementRequired = true;
```

Clear it only beside the current-generation semantic/retry/status commit:

```ts
if (generation === this.latestGeneration) {
    this.lastSemantic = semantic;
    this.retryAttempt = 0;
    this.recoveryAcknowledgementRequired = false;
    if (!this.disposed) { this.setStatus('ready'); }
}
```

Clear it in `dispose()` immediately after setting `disposed`:

```ts
this.disposed = true;
this.recoveryAcknowledgementRequired = false;
```

- [ ] **Step 4: Run focused and full verification for GREEN**

Run:

```bash
npm run test-compile
npm run attention:bridge:compile
node scripts/run-open-project-safety-checks.js
node scripts/run-dashboard-webview-checks.js
node scripts/run-ai-session-safety-checks.js
node scripts/run-ai-session-tmux-checks.js
cmp -s src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
cmp -s src/webview/media/main.js media/main.js
cmp -s src/webview/media/main.css media/main.css
git diff --check
```

Expected: both compilers and every suite/hygiene command exit `0`.

- [ ] **Step 5: Append the Task 11 report and commit**

Record the three-versus-four RED observation, exact workspace/`null` command
sequence, full verification, and self-review in
`.superpowers/sdd/task-11-report.md`, then run:

```bash
git add scripts/run-open-project-safety-checks.js src/openWorkspaces/bridgeClient.ts
git add -f .superpowers/sdd/task-11-report.md
git commit -m "fix: require workspace recovery acknowledgement"
```

- [ ] **Step 6: Run fresh post-commit verification**

Repeat Step 4, replace `git diff --check` with
`git diff HEAD^ HEAD --check`, and require an empty `git status --short`.
