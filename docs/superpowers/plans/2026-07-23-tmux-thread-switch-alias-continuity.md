# Tmux Thread Switch Alias Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a user-defined AI Session name on the active card after a successful managed Codex tmux root-thread switch.

**Architecture:** Let `AiSessionAliasController` own an idempotent copy from the old Session key to the new Session key. Let `TmuxRuntimeDiscovery` emit one optional post-commit rebind callback, and wire that callback in production activation without changing alias storage or runtime persistence.

**Tech Stack:** TypeScript, Node.js `node:test`, Project Steward behavior-contract catalog, existing activation harness.

## Global Constraints

- Work only in `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/fix-logical-attention-card-count`.
- Keep the primary checkout and its user changes untouched.
- Do not push, open a pull request, merge, or publish a release.
- Add and run the failing behavior contract before editing production code.
- Copy the old alias; do not remove it from the old History Session.
- Never overwrite an alias already stored for the new Session ID.
- Alias persistence failure must not invalidate a successful durable runtime rebind.
- Backfill aliases for thread switches that were already durably committed
  before the fix was installed.
- Do not migrate pins, attention state, or provider records in this change.

---

### Task 1: Add the Failing Alias-Continuity Contract

**Files:**

- Modify: `docs/testing/behavior-contracts.json`
- Modify: `tests/contract/aiSessions/controllerBoundaries.test.js`
- Modify: `tests/contract/aiSessions/tmuxDiscovery.test.js`
- Modify: `tests/contract/aiSessions/runtimeComposition.test.js`
- Modify: `tests/fixtures/aiSessions/runtimeHostActivationHarness.js`

**Interfaces:**

- Consumes: current alias controller, tmux discovery, and production activation.
- Produces: behavior ID `SESSION-ALIAS-THREAD-SWITCH-001`.

- [ ] **Step 1: Register the behavior**

Add this automated entry after `SESSION-ALIAS-CONTROLLER-001`:

```json
{
  "id": "SESSION-ALIAS-THREAD-SWITCH-001",
  "domain": "session",
  "title": "Tmux Thread Switch Alias Continuity behavior",
  "priority": "P0",
  "status": "automated",
  "owners": [
    "tests/contract/aiSessions/controllerBoundaries.test.js",
    "tests/contract/aiSessions/tmuxDiscovery.test.js",
    "tests/contract/aiSessions/runtimeComposition.test.js"
  ],
  "evidence": [
    "src/aiSessions/aliasController.ts",
    "src/aiSessions/tmuxRuntimeDiscovery.ts",
    "src/dashboard.ts"
  ]
}
```

- [ ] **Step 2: Add controller copy semantics**

Add a `SESSION-ALIAS-THREAD-SWITCH-001` test that constructs an in-memory store,
calls:

```js
controller.copyForRebind('codex', 'old-root', 'new-root');
```

and asserts:

```js
{
  'codex:old-root': 'Readable name',
  'codex:new-root': 'Readable name',
}
```

Repeat with a pre-existing `codex:new-root` alias and assert it is preserved.
Repeat without an old alias and assert `saveAll` was not called.

- [ ] **Step 3: Add discovery post-commit semantics**

Extend the successful `RUNTIME-TMUX-THREAD-SWITCH-001` test name with
`SESSION-ALIAS-THREAD-SWITCH-001`, pass:

```js
onSessionRebound: (previous, next) => reboundEvents.push({ previous, next }),
```

and assert exactly one event carries `old-root` and `new-root`. In the existing
observer/stale/missing loop, pass a counter callback and assert it remains zero.
Construct a restarted discovery with immutable `old-root` tmux metadata and a
durable `new-root` binding, then assert it reports the same old-to-new
transition even though the observer already returns `new-root`.

Add a successful durable rebind whose `onSessionRebound` throws. Assert refresh
still resolves, discovery projects `new-root`, and the durable store contains
only the new binding. Add a controller store whose `saveAll` throws and assert
`copyForRebind` logs the stable preservation error, invokes `showSaveError`,
and does not throw.

- [ ] **Step 4: Prove production composition wires the callback**

In `runtimeHostActivationHarness.js`, patch
`AiSessionAliasController.prototype.copyForRebind`, invoke
`this.options.onSessionRebound(previous, next)` inside the patched
`loadPersistedInactive`, and record the received provider and IDs. Extend the
successful runtime-composition test name with
`SESSION-ALIAS-THREAD-SWITCH-001` and assert the recorded values.

- [ ] **Step 5: Compile and observe RED**

Run:

```bash
npm run test-compile
node --test --test-name-pattern='SESSION-ALIAS-THREAD-SWITCH-001' \
  tests/contract/aiSessions/controllerBoundaries.test.js \
  tests/contract/aiSessions/tmuxDiscovery.test.js \
  tests/contract/aiSessions/runtimeComposition.test.js
```

Expected: FAIL because `copyForRebind` and `onSessionRebound` do not exist and
production activation does not wire alias continuity.

- [ ] **Step 6: Validate catalog ownership**

Run:

```bash
npm run test:behavior-contracts
```

Expected: pass because every owner references the new behavior ID.

- [ ] **Step 7: Commit the red contract**

```bash
git add docs/testing/behavior-contracts.json \
  tests/contract/aiSessions/controllerBoundaries.test.js \
  tests/contract/aiSessions/tmuxDiscovery.test.js \
  tests/contract/aiSessions/runtimeComposition.test.js \
  tests/fixtures/aiSessions/runtimeHostActivationHarness.js
git commit -m "test: cover alias continuity after thread switch"
```

---

### Task 2: Copy Aliases After a Durable Rebind

**Files:**

- Modify: `src/aiSessions/aliasController.ts`
- Modify: `src/aiSessions/tmuxRuntimeDiscovery.ts`
- Modify: `src/dashboard.ts`

**Interfaces:**

- Produces:

```ts
copyForRebind(
    providerId: AiSessionProviderId,
    previousSessionId: string,
    nextSessionId: string
): void;
```

- Produces:

```ts
onSessionRebound?: (
    previous: AiSessionRuntimeIdentity,
    next: AiSessionRuntimeIdentity
) => void;
```

- [ ] **Step 1: Implement idempotent alias copying**

In `AiSessionAliasController`, validate provider, non-empty distinct IDs, derive
both keys, read all aliases, sanitize the source and target, and return unless
the source exists and target does not. Copy the source into a cloned alias map
and call `saveAll`. Catch failures, log:

```text
Failed to preserve AI session alias after runtime rebind.
```

and invoke `showSaveError`.

- [ ] **Step 2: Emit the post-commit callback**

Add `onSessionRebound` to `TmuxRuntimeDiscoveryOptions`. After
`rebindKnown(...)` returns `rebound`, construct cloned previous and next
identities, invoke the callback in a `try/catch`, then project the next
identity. Do not invoke it for any other rebind result.

Before observing a new thread, compare the immutable parsed Session ID with the
exact-locator known binding. For Codex only, when they differ, invoke the same
best-effort callback with parsed identity as `previous` and the durable identity
as `next`. This repairs aliases for transitions committed by older builds and
remains idempotent through the controller target check.

- [ ] **Step 3: Wire production activation**

Move alias store/controller construction before tmux discovery in
`dashboard.ts`, then pass:

```ts
onSessionRebound: (previous, next) => {
    aiSessionAliasController.copyForRebind(
        previous.provider,
        previous.sessionId || '',
        next.sessionId || ''
    );
},
```

Remove the old later construction block so only one controller and store exist.

- [ ] **Step 4: Run focused GREEN**

Run:

```bash
npm run test-compile
node --test --test-name-pattern='SESSION-ALIAS-THREAD-SWITCH-001' \
  tests/contract/aiSessions/controllerBoundaries.test.js \
  tests/contract/aiSessions/tmuxDiscovery.test.js \
  tests/contract/aiSessions/runtimeComposition.test.js
```

Expected: all focused alias-continuity cases pass.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/aiSessions/aliasController.ts \
  src/aiSessions/tmuxRuntimeDiscovery.ts src/dashboard.ts
git commit -m "fix: preserve aliases across thread switches"
```

---

### Task 3: Verify the Regression Gate

**Files:**

- Review only: all files changed in Tasks 1 and 2.

**Interfaces:**

- Consumes: `SESSION-ALIAS-THREAD-SWITCH-001`.
- Produces: fresh local evidence for the PR-required Linux gate.

- [ ] **Step 1: Run targeted gates**

```bash
npm run test:behavior-contracts
npm run test:contract
npm run test:tmux
```

Expected: all commands exit `0`.

- [ ] **Step 2: Run the required PR gate locally**

```bash
npm run test:ci:linux
```

Expected: exit `0`. The path is
`quality-linux -> test:ci:linux -> test:deterministic:run ->
tests/contract/aiSessions/*.test.js`.

- [ ] **Step 3: Review the final diff and repository state**

```bash
git diff --check
git status --short
git log --oneline --decorate -5
```

Expected: no whitespace errors; only intentional committed changes; no primary
checkout files touched.

- [ ] **Step 4: Commit any review corrections**

Stage only intentional correction files and commit:

```bash
git commit -m "test: tighten thread switch alias coverage"
```

Skip this commit when review finds no correction.
