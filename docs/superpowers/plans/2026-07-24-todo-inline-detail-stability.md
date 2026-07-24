# TODO Inline Detail and Rendering Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace page-switching TODO details with stable inline expansion, correct group disclosure visuals, and remove redundant full-surface redraws.

**Architecture:** Keep the host-authoritative snapshot and command protocol unchanged. Refactor the local TODO controller into a cached list-surface renderer, targeted task/group patchers, and independent feedback-region updates so successful acknowledgements do not redraw an already-correct optimistic surface.

**Tech Stack:** TypeScript host rendering, plain JavaScript VS Code Webview controller, SCSS/CSS, Node.js built-in test runner.

## Global Constraints

- Work only on `feat/todo-ux-overhaul` in `.worktree/todo-ux`; do not modify or merge `main`.
- Add no framework, runtime dependency, storage schema, or command protocol version.
- Preserve exact rollback, revision ordering, search reveal, drag-handle-only reorder, and five-second Undo behavior.
- Follow red-green-refactor for each behavior change.

---

### Task 1: Disclosure chevron

**Files:**
- Modify: `src/todos/webviewContent.ts`
- Modify: `src/webview/webviewTodoScripts.js`
- Modify: `media/styles.scss`
- Test: `tests/integration/dashboard/todoContent.test.js`

**Interfaces:**
- Consumes: `group.collapsed` and the existing `todo-collapse-group` command.
- Produces: `.todo-group-chevron` containing an SVG with CSS rotation driven by `.todo-group.collapsed`.

- [ ] **Step 1: Write the failing markup and style assertions**

Assert that both initial and dynamic group markup contain
`todo-group-chevron`, an SVG, and stateful `aria-expanded`; assert that SCSS
centers the SVG and rotates it by `-90deg` only under `.todo-group.collapsed`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test-compile && node --test tests/integration/dashboard/todoContent.test.js
```

Expected: FAIL because the dynamic renderer emits the text glyph `⌄` and has
no TODO-specific centered chevron rule.

- [ ] **Step 3: Implement one SVG disclosure control**

Use the same down-chevron SVG path in the server and dynamic renderers. Give
the wrapper a 20-by-20 grid box, give the SVG an explicit square size and
centered transform origin, and rotate it to point right only for collapsed
groups.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/todos/webviewContent.ts src/webview/webviewTodoScripts.js media/styles.scss tests/integration/dashboard/todoContent.test.js
git commit -m "fix: clarify todo group disclosure"
```

### Task 2: Inline task details

**Files:**
- Modify: `src/webview/webviewTodoScripts.js`
- Modify: `src/todos/webviewContent.ts`
- Modify: `media/styles.scss`
- Test: `tests/integration/dashboard/todoInteraction.test.js`
- Test: `tests/integration/dashboard/todoContent.test.js`

**Interfaces:**
- Consumes: `selectedTodoId`, `draft`, `openDetail(todoId)`, and delegated
  card clicks.
- Produces: `toggleDetail(todoId)`, `.todo-item.expanded`, and
  `.todo-inline-detail`.

- [ ] **Step 1: Write failing inline toggle tests**

Open `todo-a`, assert the list surface remains rendered with the full title,
notes, and ordered metadata inside the task. Dispatch a second card activation
and assert `selectedTodoId` is cleared. Assert `openDetail(todoId)` remains
idempotent for search.

- [ ] **Step 2: Run the focused interaction tests and verify RED**

Run:

```bash
node --test tests/integration/dashboard/todoInteraction.test.js tests/integration/dashboard/todoContent.test.js
```

Expected: FAIL because the controller hides the list and renders a separate
detail surface.

- [ ] **Step 3: Implement inline rendering and targeted task patches**

Render detail rows or the edit form below `.todo-item-main` when its ID equals
`selectedTodoId`. Make ordinary card/title activation toggle that ID; make
search `openDetail` only open it. Patch the previously selected and newly
selected task nodes without replacing the list. Close the task on Escape or
Alt+Left and restore title focus without changing page scroll.

- [ ] **Step 4: Add compact vertical detail styles**

Remove dedicated-page spacing and add a border-top-separated inline region,
full unclamped expanded title, two-column label/value rows that collapse to
one column in narrow panels, and wrapping metadata/action values.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/webview/webviewTodoScripts.js src/todos/webviewContent.ts media/styles.scss tests/integration/dashboard/todoInteraction.test.js tests/integration/dashboard/todoContent.test.js
git commit -m "feat: expand todo details inline"
```

### Task 3: Stable incremental rendering

**Files:**
- Modify: `src/webview/webviewTodoScripts.js`
- Modify: `src/webview/webviewContent.ts`
- Test: `tests/integration/dashboard/todoInteraction.test.js`
- Test: `tests/integration/dashboard/webviewState.test.js`

**Interfaces:**
- Consumes: optimistic `dispatch`, authoritative `applyCommandResult`, and
  `options.onRendered`.
- Produces: cached `renderedSurfaceHtml`, `renderSurface(force)`,
  `renderFeedback()`, `patchTodo(todoId)`, and `patchGroup(groupId)`.

- [ ] **Step 1: Write the failing acknowledgement redraw test**

Count `onRendered` calls. Dispatch an optimistic completion, capture the
count, then apply a successful authoritative result with the same completed
state. Assert the count does not increase and the Undo/live feedback updates.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test tests/integration/dashboard/todoInteraction.test.js
```

Expected: FAIL because both dispatch and acknowledgement call the full
`render()` and `onRendered`.

- [ ] **Step 3: Separate surface and feedback rendering**

Cache `renderListSurface()` output. Replace `.todo-list-surface` only when the
new output differs, update `.todo-undo-region` and `.todo-live-region`
directly, and call `onRendered` only after an actual structural surface
replacement. Synchronize the cache after direct task/group patches.

- [ ] **Step 4: Preserve rollback and search behavior**

On failure, restore the pending selection/draft and authoritative snapshot,
then compare/redraw the surface. Keep the public `openDetail` method used by
Dashboard search and update search-catalog state without replacing the list.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/todoInteraction.test.js tests/integration/dashboard/webviewState.test.js
npm run test:dashboard:run
```

Expected: all selected tests and Dashboard Webview checks pass.

- [ ] **Step 6: Commit**

```bash
git add src/webview/webviewTodoScripts.js src/webview/webviewContent.ts tests/integration/dashboard/todoInteraction.test.js tests/integration/dashboard/webviewState.test.js
git commit -m "perf: avoid redundant todo surface redraws"
```

### Task 4: Release verification and installation

**Files:**
- Modify: `docs/superpowers/reports/2026-07-24-todo-continuous-workflow-verification.md`

**Interfaces:**
- Consumes: final production assets and VSIX.
- Produces: fresh verification evidence and an installed `hzcheng.project-steward@2.1.5`.

- [ ] **Step 1: Run final repository gates**

```bash
npm run test:deterministic
npm run test:behavior-contracts
npm run test:dashboard
npm run test:architecture-guards
npm run lint:ci
npm run test:safety
npm run test:release-packaging
npm run vscode:prepublish
```

Expected: every command exits 0.

- [ ] **Step 2: Install the verified workspace VSIX**

Use the pinned VS Code Server CLI:

```bash
/home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server \
  --install-extension \
  artifacts/project-steward-2.1.5.vsix \
  --force
```

Expected: successful installation.

- [ ] **Step 3: Verify the installed asset**

Compare SHA-256 for the worktree and installed
`media/webviewTodoScripts.js`; expected hashes are identical.

- [ ] **Step 4: Update and commit the verification report**

Record final command results, artifact hash, installed asset hash, and reload
requirement.

```bash
git add docs/superpowers/reports/2026-07-24-todo-continuous-workflow-verification.md
git commit -m "docs: verify inline todo interactions"
```
