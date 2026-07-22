# Open Workspace Stale Identical Acknowledgement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a stale identical publication acknowledgement from suppressing the newest generation or stranding bridge recovery.

**Architecture:** Keep publication ownership generation-based. Move the `lastSemantic` commit into the existing current-generation acknowledgement guard so a stale success is diagnostic-only and the identical latest generation must issue and receive its own command.

**Tech Stack:** TypeScript, Node.js assertion-based safety scripts, VS Code command bridge.

## Global Constraints

- Only a current-generation acknowledgement may commit `lastSemantic`, reset `retryAttempt`, or emit `ready`.
- Identical workspace and repeated `null` generations each issue exactly two commands when the first command is stale in flight.
- Preserve different-generation recovery coalescing, healthy sequential publication, and disposal/unregister ordering.

---

### Task 1: Gate semantic acknowledgement state by generation

**Files:**
- Modify: `scripts/run-open-project-safety-checks.js`
- Modify: `src/openWorkspaces/bridgeClient.ts`
- Modify: `.superpowers/sdd/task-11-report.md`

**Interfaces:**
- Consumes: `OpenWorkspaceBridgeClient.publish(workspace, followsFocusEvent?): Promise<boolean>` and injected `executeCommand`, timer, and status dependencies.
- Produces: acknowledgement handling in `publishNow()` where `lastSemantic`, `retryAttempt`, and `ready` are committed only for `generation === latestGeneration`.

- [ ] **Step 1: Write the failing deferred regressions**

Add one helper-driven case for an identical workspace and one for repeated
`null`. Hold the first publish command unresolved, queue the identical latest
generation, resolve the stale command, and assert:

```js
assert.strictEqual(publications.length, 2);
assert.strictEqual(await latestPublication, true);
assert.deepStrictEqual(statuses, ['ready']);
assert.strictEqual(activeTimers.size, 0);
```

The second command must have the same workspace value as the first, including
two literal `null` values for the closure case.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
npm run test-compile
npm run attention:bridge:compile
node scripts/run-open-project-safety-checks.js
```

Expected: the new identical-generation assertion fails because only one publish
command is observed and recovery is not completed by the newest generation.

- [ ] **Step 3: Implement the minimal generation-owned semantic commit**

Change the successful command path in `publishNow()` from:

```ts
this.lastSemantic = semantic;
if (generation === this.latestGeneration) {
    this.retryAttempt = 0;
    if (!this.disposed) { this.setStatus('ready'); }
}
```

to:

```ts
if (generation === this.latestGeneration) {
    this.lastSemantic = semantic;
    this.retryAttempt = 0;
    if (!this.disposed) { this.setStatus('ready'); }
}
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

Expected: both compilers and every suite/hygiene command exit `0`, including
`Open project safety checks passed.`

- [ ] **Step 5: Append evidence, self-review, and commit**

Record the RED observation, exact two-command semantics, full verification, and
self-review in `.superpowers/sdd/task-11-report.md`, then run:

```bash
git add scripts/run-open-project-safety-checks.js src/openWorkspaces/bridgeClient.ts
git add -f .superpowers/sdd/task-11-report.md
git commit -m "fix: preserve latest workspace acknowledgement"
```

- [ ] **Step 6: Run fresh post-commit verification**

Repeat Step 4, replace `git diff --check` with
`git diff HEAD^ HEAD --check`, and assert `git status --short` is empty.
