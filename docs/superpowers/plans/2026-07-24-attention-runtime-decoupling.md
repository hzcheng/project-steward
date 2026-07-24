# AI Session Attention / Runtime Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Direct Terminal and tmux runtime exits from creating red attention indicators while preserving explicit provider attention and reliable runtime cleanup.

**Architecture:** Make provider lifecycle signals the sole source of new attention. Keep completed runtime evaluation as a delivery boundary, but release no-event runtimes independently of attention publication and retain only real unpublished events.

**Tech Stack:** TypeScript, Node.js `node:test`, VS Code extension integration harnesses, repository behavior-contract catalog and architecture guards.

## Global Constraints

- Work only in `.worktree/todo-ux` on `feat/todo-ux-overhaul`; do not modify or merge `main`.
- Follow RED-GREEN-REFACTOR and observe each new test fail for the intended reason.
- Do not change provider lifecycle mappings, attention bridge retention, acknowledgement identity, or UI rendering.
- Natural runtime exit must never synthesize or acknowledge attention.

---

### Task 1: Lock the attention source and runtime-release semantics

**Files:**
- Modify: `tests/contract/aiSessions/attention.test.js`
- Modify: `src/aiSessions/attentionController.ts`

**Interfaces:**
- Consumes: `AiSessionLifecycleSignal` returned by registered provider services.
- Produces: `AiSessionAttentionController.evaluate()` using provider signals only and `settleAiSessionRuntimeLifecycles()` that distinguishes real event delivery from no-event cleanup.

- [ ] **Step 1: Write failing controller tests**

Replace the completion-fallback contract with assertions that a completed
runtime and no provider signal publishes no item. Update settlement expectations
so an in-scope completion with no event is released, while an in-scope
completion carrying an unpublished event remains retained.

- [ ] **Step 2: Run the focused contract test and verify RED**

Run:

```bash
npm run test-compile && node --test tests/contract/aiSessions/attention.test.js
```

Expected: FAIL because the controller still creates `terminal-exit:*`, and
because settlement still retains an in-scope no-event completion.

- [ ] **Step 3: Remove runtime-derived attention**

Delete the `isRuntimeComplete` option, the synthetic `terminal-exit:*` branch,
and runtime-completion suppression state. Feed the provider signal directly to
the monitor.

- [ ] **Step 4: Decouple no-event release**

In `settleAiSessionRuntimeLifecycles`, classify in-scope completions by whether
`eventIdsBySession` or `overflowedSessionKeys` contains attention evidence.
Release no-evidence completions after successful evaluation; require
`published` only for completions with attention evidence.

- [ ] **Step 5: Run the focused contract test and verify GREEN**

Run:

```bash
npm run test-compile && node --test tests/contract/aiSessions/attention.test.js
```

Expected: PASS.

### Task 2: Remove obsolete terminal-close suppression wiring

**Files:**
- Modify: `tests/integration/dashboard/helpers/terminalCloseHarness.js`
- Modify: `tests/integration/dashboard/terminalCloseWiring.test.js`
- Modify: `src/dashboard.ts`

**Interfaces:**
- Consumes: VS Code `onDidCloseTerminal` exit reasons and successful
  `AiSessionTerminalCommandController.closeTerminal()` callbacks.
- Produces: close behavior that never suppresses or creates completion
  attention, while explicit user close continues to acknowledge existing event
  IDs.

- [ ] **Step 1: Rewrite the production-wiring contract**

Assert that both natural process exit and user terminal close avoid completion
suppression. Assert natural exit does not acknowledge, user close does
acknowledge, and successful explicit close/detach acknowledges only after the
runtime action succeeds.

- [ ] **Step 2: Run the wiring test and verify RED**

Run:

```bash
npm run test-compile && node --test tests/integration/dashboard/terminalCloseWiring.test.js
```

Expected: FAIL because current user/explicit Direct close invokes
`suppressRuntimeCompletion`.

- [ ] **Step 3: Simplify close wiring**

Remove `suppressRuntimeCompletion` and `restoreRuntimeCompletion` calls from
`src/dashboard.ts`. Keep successful explicit-close acknowledgement and
user-terminal-close acknowledgement. Keep natural exit non-acknowledging.

- [ ] **Step 4: Run the wiring test and verify GREEN**

Run:

```bash
npm run test-compile && node --test tests/integration/dashboard/terminalCloseWiring.test.js
```

Expected: PASS.

### Task 3: Replace CI contracts that protect the regression

**Files:**
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-architecture-guards.js`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the production semantics established by Tasks 1 and 2.
- Produces: repository gates that fail if runtime-derived attention is
  reintroduced.

- [ ] **Step 1: Invert source and safety assertions**

Assert that the attention evaluator does not contain `terminal-exit:` or
`isRuntimeComplete`, no terminal-close handler invokes runtime-completion
suppression, and no-event completed candidates release after evaluation.

- [ ] **Step 2: Update the behavior catalog**

Rename the P0 terminal-close contract to state that process exit creates no
attention. Update explicit-close titles to describe acknowledgement rather than
completion suppression.

- [ ] **Step 3: Correct release documentation**

Document that process/runtime exit is attention-neutral and that only an
explicit provider completion creates completion attention.

- [ ] **Step 4: Run focused safety and catalog checks**

Run:

```bash
npm run test-compile
npm run test:safety:run
npm run test:architecture-guards
npm run test:behavior-contracts
```

Expected: PASS.

### Task 4: Verify the full regression surface

**Files:**
- Verify only.

**Interfaces:**
- Consumes: all preceding changes.
- Produces: fresh evidence that extension, bridge, webview, packaging, and
  behavior contracts remain valid.

- [ ] **Step 1: Run targeted suites**

Run:

```bash
node --test tests/contract/aiSessions/attention.test.js
node --test tests/integration/dashboard/terminalCloseWiring.test.js
```

Expected: PASS.

- [ ] **Step 2: Run the repository CI command**

Run the project’s canonical full CI command from `package.json`.

Expected: exit code 0 with no failed test or build stage.

- [ ] **Step 3: Review the final diff**

Confirm there is no `terminal-exit:` production path, no completion-suppression
wiring, no unrelated file change, and no change to provider event parsing.
