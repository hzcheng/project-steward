# TODO Completion Without Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete a TODO without rebuilding either the Dashboard Webview document or the TODO list surface.

**Architecture:** The host suppresses only configuration events whose current `todoData` fingerprint matches its own last successful Settings write. The Webview applies completion to the existing card, counters, and empty/hidden state while keeping the mounted surface and sibling nodes stable.

**Tech Stack:** TypeScript, VS Code configuration API, framework-free Webview JavaScript, Node.js test runner

## Global Constraints

- Preserve genuine external Settings Sync changes.
- Do not use timers or debounce windows to identify write echoes.
- Preserve the TODO root, list surface, group element, sibling cards, scroll, and drag-and-drop instance on successful completion.
- Keep authoritative rollback and missing-DOM full-render fallbacks.
- Work only in `.worktree/todo-ux`; do not merge `main`.

---

### Task 1: Suppress local Settings write echoes

**Files:**
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `tests/contract/todos/service.test.js`
- Modify: `tests/integration/dashboard/errorRecovery.test.js`
- Modify: `src/todos/service.ts`
- Modify: `src/dashboard/lifecycleController.ts`
- Modify: `src/dashboard.ts`

**Interfaces:**
- Produces: `TodoService.isCurrentSettingsDataLocallyWritten(): boolean`.
- Consumes: the method through `DashboardLifecycleControllerOptions.isTodoDataWriteEcho`.

- [ ] **Step 1: Add the P0 behavior and failing tests**

Register `TODO-COMPLETION-INCREMENTAL-001`. In the service contract, require
`isCurrentSettingsDataLocallyWritten()` to be false initially, true after a
successful Settings-backed completion, false after external data replaces the
setting, and false after a rejected write. In the lifecycle integration test,
pass `isTodoDataWriteEcho: () => true`, send a
`projectSteward.todoData` event, and require no color, refresh, or publication
events.

- [ ] **Step 2: Prove RED through CI-owned tests**

Run:

```bash
npm run test-compile
node --test tests/contract/todos/service.test.js
node --test tests/integration/dashboard/errorRecovery.test.js
```

Expected: the service method is missing and the lifecycle controller still
records `configuration-changed` refresh.

- [ ] **Step 3: Implement fingerprint and lifecycle suppression**

Add a private last-write fingerprint in `TodoService`, set it before the
Settings update, restore its previous value on rejection, and compare it with
the normalized current setting in the public query. Add the optional
`isTodoDataWriteEcho` lifecycle dependency and return early only when
`projectSteward.todoData` is affected and that dependency returns true. Wire it
to the service in `src/dashboard.ts`.

- [ ] **Step 4: Verify GREEN**

Recompile and rerun both focused tests plus
`npm run test:behavior-contracts`.

### Task 2: Patch completion without replacing the list surface

**Files:**
- Modify: `tests/integration/dashboard/todoInteraction.test.js`
- Modify: `src/webview/webviewTodoScripts.js`
- Modify: `src/webview/webviewDnDScripts.js`
- Generate: `media/webviewTodoScripts.js`
- Generate: `media/webviewDnDScripts.js`

**Interfaces:**
- Produces: internal `patchTodoCompletion(todoId)` returning `boolean`.
- Consumes: the existing `dispatch('complete', payload)` path.

- [ ] **Step 1: Write the failing DOM stability test**

Mount with targeted patch nodes, dispatch completion, and require:

```js
assert.equal(harness.getRenderedCount(), mountedRenders);
assert.equal(harness.getTodoNode('todo-a').hidden, true);
assert.equal(harness.getTodoNode('todo-b'), siblingBefore);
assert.equal(harness.summaryMeta.textContent, '1 open · 1 group · completed hidden');
assert.equal(harness.groupCount.textContent, '1 open');
```

Also require the DnD selector to use
`:scope > .todo-item[data-todo-id]:not([hidden])`.

- [ ] **Step 2: Prove RED**

Run:

```bash
node --test tests/integration/dashboard/todoInteraction.test.js
```

Expected: optimistic completion increments the broad render count and does not
hide the target node or patch counters.

- [ ] **Step 3: Implement the targeted completion patch**

Extract summary/group metadata helpers used by both rendering and patching.
`patchTodoCompletion` updates the target card visibility/body, card position
when it remains visible, summary metadata, group metadata, hidden-completed
text, and empty state. It updates the canonical rendered HTML string and
feedback without calling `onRendered`. Dispatch uses it only for `complete`
and falls back to `render()` if required DOM is absent. DnD excludes hidden
cards.

- [ ] **Step 4: Build and verify GREEN**

Run:

```bash
npx gulp --production
node --test tests/integration/dashboard/todoInteraction.test.js
npm run test:dashboard
```

Expected: all checks pass and generated media matches source.

### Task 3: Review, verify, package, and install

**Files:**
- Modify: `docs/superpowers/reports/2026-07-24-todo-continuous-workflow-verification.md`

**Interfaces:**
- Consumes: the completed host and Webview behavior.
- Produces: a verified installed `project-steward-2.1.5.vsix`.

- [ ] **Step 1: Run review and branch gates**

Run read-only review, apply any valid Critical/Important fixes through a fresh
test-first cycle, then run deterministic, behavior, Dashboard, architecture,
lint, and safety gates.

- [ ] **Step 2: Package and install**

Run `npm run test:release-packaging`, install the VSIX with the pinned VS Code
Server CLI, verify archive integrity, and compare installed bundle/media
hashes.

- [ ] **Step 3: Commit and preserve the branch**

Update the verification report with the final commit, test count, and artifact
hashes. Keep `feat/todo-ux-overhaul` and `.worktree/todo-ux`; do not merge or
clean up.
