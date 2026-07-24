# TODO Continuous Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped TODO card expansion with a focused full-detail workflow and make ordinary TODO mutations locally patchable, reversible, and stable under mouse and keyboard use.

**Architecture:** Keep `TodoService` and `TodoDataV1` authoritative, add a typed command coordinator in the Extension Host, and add a dedicated plain-JavaScript TODO Webview controller. Initial and exceptional recovery renders remain host HTML; ordinary commands return normalized snapshots that the TODO controller renders without replacing the TODO root.

**Tech Stack:** TypeScript 4.x, VS Code Webview APIs, plain ES2019-compatible JavaScript, SCSS, Node.js `node:test`, existing fake DOM/runtime helpers.

## Global Constraints

- Keep the synchronized `TodoDataV1` storage format unchanged.
- Do not add a client-side framework or runtime dependency.
- Preserve storage selection, migration, search, and future-version read-only behavior.
- Ordinary add, edit, complete, delete, reorder, collapse, completed-visibility, and Undo commands must not replace the TODO root.
- Completion and deletion Undo is process-local, lasts five seconds, and restores exact task identity and list position.
- Generated files in `media/` must match their `src/webview/` or `media/styles.scss` sources.
- Support VS Code `^1.51.0`, dark/light/high-contrast themes, and approximately 240–600px sidebar widths.

---

### Task 1: Define Snapshot, Command, and Exact-Restore Model Contracts

**Files:**
- Modify: `src/todos/types.ts`
- Modify: `src/todos/viewModel.ts`
- Modify: `src/todos/service.ts`
- Modify: `tests/unit/todos/types.test.js`
- Modify: `tests/contract/todos/service.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Produces: `TodoPanelSnapshot`, `TodoCommandAction`, `TodoCommandMessage`, `TodoCommandResultMessage`
- Produces: `buildTodoPanelSnapshot(data, viewState, revealedTodoId?)`
- Produces: `TodoService.restoreTodo(item, neighborIds)` and `TodoService.moveTodo(id, groupId)`
- Preserves: `TodoDataV1.version === 1`

- [ ] **Step 1: Add RED snapshot and exact-restore tests**

Add behavior IDs `TODO-TODO-COMMAND-SNAPSHOT-001` and
`TODO-TODO-EXACT-RESTORE-001`. Assert that the snapshot is a defensive,
normalized copy and that restoring a deleted item preserves its ID, group,
fields, and relative position between surviving neighbors.

```js
test('TODO-TODO-COMMAND-SNAPSHOT-001 builds a defensive normalized panel snapshot', () => {
    const source = makeTodoData();
    const snapshot = buildTodoPanelSnapshot(source, { showCompleted: true });
    source.todos[0].title = 'mutated';
    assert.equal(snapshot.data.todos[0].title, 'First');
    assert.equal(snapshot.showCompleted, true);
});

test('TODO-TODO-EXACT-RESTORE-001 restores identity and relative order', async () => {
    const service = createServiceWithTodos(['a', 'b', 'c']);
    const deleted = service.getData().todos.find(todo => todo.id === 'b');
    await service.deleteTodo('b');
    await service.restoreTodo(deleted, { beforeId: 'a', afterId: 'c' });
    assert.deepEqual(service.getData().todos.map(todo => todo.id), ['a', 'b', 'c']);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run test-compile
node --test tests/unit/todos/types.test.js
node --test --test-concurrency=1 tests/contract/todos/service.test.js
```

Expected: fail because the snapshot types/builders and restore operation do not
exist.

- [ ] **Step 3: Add the typed contracts and snapshot builder**

Add these exact public shapes:

```ts
export type TodoCommandAction =
    | 'add' | 'update' | 'complete' | 'delete' | 'undo'
    | 'reorder-items' | 'reorder-groups'
    | 'collapse-group' | 'collapse-groups'
    | 'sort-priority' | 'show-completed';

export interface TodoPanelSnapshot {
    version: 1;
    data: TodoDataV1;
    showCompleted: boolean;
    revealedTodoId?: string;
}

export interface TodoCommandMessage {
    type: 'todo-command';
    version: 2;
    requestId: number;
    action: TodoCommandAction;
    payload: unknown;
}

export interface TodoCommandResultMessage {
    type: 'todo-command-result';
    version: 2;
    requestId: number;
    revision: number;
    success: boolean;
    snapshot?: TodoPanelSnapshot;
    undoToken?: string;
    errorCode?: 'invalid' | 'not-found' | 'conflict' | 'storage' | 'undo-expired';
}
```

Implement `buildTodoPanelSnapshot()` by normalizing and cloning its input.

- [ ] **Step 4: Implement exact restore and group movement**

`restoreTodo()` must reject an unavailable target group, retain the supplied
item ID and timestamps, place the item between the first surviving requested
neighbor pair, and renumber only the target group. `moveTodo()` must move an
existing item to the top of a valid destination group and compact both groups.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 commands.

Expected: all TODO type and service tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/todos/types.ts src/todos/viewModel.ts src/todos/service.ts \
  tests/unit/todos/types.test.js tests/contract/todos/service.test.js \
  docs/testing/behavior-contracts.json
git commit -m "feat: add todo interaction snapshot model"
```

---

### Task 2: Add the Host Command Coordinator and Expiring Undo

**Files:**
- Create: `src/todos/commandController.ts`
- Create: `tests/contract/todos/commandController.test.js`
- Modify: `src/dashboard.ts`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Consumes: `TodoService`, `TodoCommandMessage`, `buildTodoPanelSnapshot`
- Produces: `TodoCommandController.handle(message): Promise<TodoCommandResultMessage | undefined>`
- Produces: result revisions that increase monotonically for accepted commands
- Produces: five-second process-local Undo tokens for complete and delete

- [ ] **Step 1: Add RED controller tests**

Cover invalid envelopes, add/update/complete/delete success, exact Undo,
expiration, storage failure mapping, revision order, and unrelated concurrent
task commands.

```js
test('TODO-TODO-COMMAND-CONTROLLER-001 returns normalized snapshots and monotonic revisions', async () => {
    const controller = createController();
    const first = await controller.handle(command(1, 'complete', {
        todoId: 'todo-a', completed: true,
    }));
    const second = await controller.handle(command(2, 'show-completed', {
        showCompleted: true,
    }));
    assert.equal(first.success, true);
    assert.equal(second.revision, first.revision + 1);
    assert.equal(first.snapshot.data.todos[0].completed, true);
});

test('TODO-TODO-UNDO-001 restores deleted task identity before expiry', async () => {
    const controller = createController();
    const deleted = await controller.handle(command(1, 'delete', { todoId: 'todo-b' }));
    const restored = await controller.handle(command(2, 'undo', {
        undoToken: deleted.undoToken,
    }));
    assert.deepEqual(restored.snapshot.data.todos.map(todo => todo.id), ['todo-a', 'todo-b']);
});
```

- [ ] **Step 2: Run the controller test and verify RED**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/todos/commandController.test.js
```

Expected: fail because `TodoCommandController` is missing.

- [ ] **Step 3: Implement the coordinator**

Create a controller with injected clock/token dependencies:

```ts
export interface TodoCommandControllerOptions {
    service: TodoService;
    getViewState: () => TodoViewState;
    setShowCompleted: (value: boolean) => Promise<TodoViewState>;
    getRevealedTodoId: () => string | undefined;
    clearRevealedTodoId: () => void;
    nowMs?: () => number;
    createUndoToken?: () => string;
}
```

Validate the version, request ID, action, strings, booleans, priorities, and
string arrays before mutation. Return `undefined` for a malformed envelope.
Map `TodoStorageConflictError` to `conflict`, validation/not-found conditions
to their matching code, expired Undo to `undo-expired`, and other write
failures to `storage`.

- [ ] **Step 4: Wire `todo-command` into the Dashboard router**

Instantiate one controller beside `TodoService`. Add only this new generic
handler:

```ts
'todo-command': async message => {
    const result = await todoCommandController.handle(message as TodoCommandMessage);
    if (result) {
        await provider.postMessage(result);
    }
},
```

Retain legacy handlers until the new Webview path and compatibility tests are
green.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/todos/commandController.test.js \
  tests/contract/todos/service.test.js tests/contract/dashboardBoundaries.test.js
```

Expected: all selected contract tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/todos/commandController.ts src/dashboard.ts \
  tests/contract/todos/commandController.test.js docs/testing/behavior-contracts.json
git commit -m "feat: coordinate incremental todo commands"
```

---

### Task 3: Redesign TODO Markup for List and Focused Detail

**Files:**
- Modify: `src/todos/webviewContent.ts`
- Modify: `media/styles.scss`
- Modify: `tests/integration/dashboard/styles.test.js`
- Create: `tests/integration/dashboard/todoContent.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Consumes: `TodoPanelSnapshot`, `TodoPanelViewModel`
- Produces: one stable `.todo-panel` root with `.todo-list-surface`,
  `.todo-detail-surface`, `.todo-live-region`, and `.todo-undo-region`
- Produces: `renderTodoListSnapshot(snapshot)` and
  `renderTodoDetailSnapshot(snapshot, todoId)`

- [ ] **Step 1: Add RED content and style tests**

Assert:

```js
assert.match(html, /class="todo-list-surface"/);
assert.match(html, /class="todo-detail-surface"[^>]*hidden/);
assert.match(html, /data-action="todo-open-detail"/);
assert.match(html, /data-drag-todo-item/);
assert.doesNotMatch(mediumItemHtml, /todo-priority-badge/);
assert.match(styles, /-webkit-line-clamp:\s*2/);
assert.doesNotMatch(todoListRule, /overflow-y:\s*auto/);
```

Also assert that detail rendering includes the full escaped title, full notes,
group selector, priority controls, back action, edit action, and accessible
status region.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/todoContent.test.js \
  tests/integration/dashboard/styles.test.js
```

Expected: fail because the list/detail surface and two-line title styles are
missing.

- [ ] **Step 3: Restructure server markup**

Keep `.todo-panel` stable. Render a compact command bar, quick-create template,
single-scroll group list, hidden focused detail surface, live region, and undo
region. Make task rows focusable and separate:

```html
<button class="todo-check" data-action="todo-toggle">…</button>
<button class="todo-item-open" data-action="todo-open-detail">…</button>
<button class="todo-drag-handle" data-drag-todo-item aria-label="Reorder …">…</button>
```

Use the existing HTML escaping helper for all persisted strings.

- [ ] **Step 4: Replace nested scrolling and card expansion styles**

Remove fixed TODO item height/max-height calculations and group-local
`overflow-y`. Add two-line clamping in list state and unrestricted wrapping in
detail state. Add narrow-width stacking, visible focus, live status, Undo, and
high-contrast-safe borders using VS Code theme variables.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run Step 2 commands and `npm run test:dashboard`.

Expected: focused tests and existing Dashboard checks pass.

- [ ] **Step 6: Commit**

```bash
git add src/todos/webviewContent.ts media/styles.scss \
  tests/integration/dashboard/styles.test.js \
  tests/integration/dashboard/todoContent.test.js docs/testing/behavior-contracts.json
git commit -m "feat: add focused todo detail surface"
```

---

### Task 4: Add the Dedicated Webview TODO Controller

**Files:**
- Create: `src/webview/webviewTodoScripts.js`
- Create: `tests/integration/dashboard/todoInteraction.test.js`
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewDashboardScripts.js`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `src/webview/webviewDnDScripts.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Produces: `initTodos(options)` and `window.__projectStewardTodo`
- Consumes: `todo-command-result` version 2 messages
- Produces: `todo-command` version 2 messages
- Preserves: mounted `.todo-panel` identity across ordinary mutations

- [ ] **Step 1: Add RED state and DOM interaction tests**

Use the existing VM/fake-DOM style to cover:

```js
test('TODO-FOCUSED-DETAIL-001 restores list scroll and originating focus', () => {
    controller.openDetail('todo-a');
    controller.backToList();
    assert.equal(window.scrollY, 240);
    assert.equal(document.activeElement.dataset.todoId, 'todo-a');
});

test('TODO-INCREMENTAL-ROOT-001 accepts command results without replacing the panel root', () => {
    const root = harness.todoPanel.querySelector('.todo-panel');
    controller.applyCommandResult(successResult());
    assert.equal(harness.todoPanel.querySelector('.todo-panel'), root);
});
```

Also cover quick-create Enter/Escape, empty-title validation, detail draft
preservation, completion/delete optimistic rollback, Undo posting, stale
revision rejection, `Escape`, `Alt+Left`, and live-region announcements.

- [ ] **Step 2: Run the interaction test and verify RED**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/todoInteraction.test.js
```

Expected: fail because `webviewTodoScripts.js` does not exist.

- [ ] **Step 3: Implement local state and command dispatch**

Keep this explicit controller state:

```js
var state = {
    mode: 'list',
    snapshot: null,
    selectedTodoId: null,
    listScrollTop: 0,
    restoreFocusTodoId: null,
    draft: null,
    nextRequestId: 0,
    lastRevision: 0,
    pending: new Map(),
    undo: null,
};
```

Every command captures the minimal rollback state, posts one `todo-command`,
and disables duplicate task-local submission. Apply successful snapshots by
patching summary, groups, task rows, and detail content inside the stable root.
Apply failure by restoring the request snapshot and announcing the mapped
error.

- [ ] **Step 4: Implement focused detail and quick create**

Open detail from row click/Enter, render complete values, and restore page
scroll/focus on back. Put add inputs directly in the requested group; global
add uses the Inbox sentinel. `Enter` submits and `Escape` cancels without
persisting an empty task.

- [ ] **Step 5: Isolate TODO from the general project script and DnD**

Load `webviewTodoScripts.js` after the Dashboard script and initialize it from
`onTodoMounted`. Remove TODO event routing from `webviewProjectScripts.js`.
Change item dragging so only `[data-drag-todo-item]` starts it. Keep group
dragging on its dedicated heading handle.

- [ ] **Step 6: Run focused and compatibility tests**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/todoInteraction.test.js \
  tests/integration/dashboard/webviewState.test.js
npm run test:dashboard
```

Expected: all tests pass and legacy non-TODO project interactions remain green.

- [ ] **Step 7: Commit**

```bash
git add src/webview/webviewTodoScripts.js src/webview/webviewContent.ts \
  src/webview/webviewDashboardScripts.js src/webview/webviewProjectScripts.js \
  src/webview/webviewDnDScripts.js tests/integration/dashboard/todoInteraction.test.js \
  docs/testing/behavior-contracts.json
git commit -m "feat: make todo interactions continuous"
```

---

### Task 5: Synchronize Search, Exceptional Refresh, and Generated Assets

**Files:**
- Modify: `src/dashboard.ts`
- Modify: `src/webview/webviewDashboardScripts.js`
- Modify: `src/webview/webviewTodoScripts.js`
- Modify: `tests/integration/dashboard/webviewState.test.js`
- Modify: `tests/integration/dashboard/todoPanelFutureVersion.test.js`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Modify: `scripts/run-release-packaging-checks.js`
- Modify: `.vscodeignore`
- Generate: `media/webviewTodoScripts.js`
- Generate: `media/webviewDashboardScripts.js`
- Generate: `media/webviewProjectScripts.js`
- Generate: `media/webviewDnDScripts.js`
- Generate: `media/styles.css`

**Interfaces:**
- Consumes: command result snapshots
- Produces: refreshed TODO search catalog after each accepted mutation
- Preserves: lazy initial mount, search reveal, future-version read-only
  recovery, and source/generated asset parity

- [ ] **Step 1: Add RED compatibility and packaging assertions**

Assert that command results include the current search catalog, external
configuration/sync changes request an exceptional snapshot replacement, search
reveal opens focused detail after mounting, and the release package contains
`media/webviewTodoScripts.js`.

- [ ] **Step 2: Run targeted compatibility checks and verify RED**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/webviewState.test.js \
  tests/integration/dashboard/todoPanelFutureVersion.test.js
npm run test:dashboard:run
```

Expected: fail on missing TODO asset/search-result integration.

- [ ] **Step 3: Complete host and Dashboard integration**

Include the normalized snapshot and search catalog in initial TODO panel
messages and successful command results. Use full HTML replacement only when
the initial lazy panel is empty, data changes externally, or unsupported
version recovery changes read-only state.

- [ ] **Step 4: Generate Webview and style assets**

Run:

```bash
npx gulp --production
```

This copies every `src/webview/*.js` file to `media/` and compiles/minifies
`media/styles.scss` to `media/styles.css`.

- [ ] **Step 5: Run focused checks and verify GREEN**

Run:

```bash
npm run test:dashboard
npm run test:behavior-contracts
npm run test:release-packaging
```

Expected: all checks pass and generated artifacts match their sources.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.ts src/webview media \
  tests/integration/dashboard/webviewState.test.js \
  tests/integration/dashboard/todoPanelFutureVersion.test.js \
  scripts/run-dashboard-webview-checks.js scripts/run-release-packaging-checks.js \
  .vscodeignore
git commit -m "build: package continuous todo experience"
```

---

### Task 6: Full Review, Regression Verification, and Local Effect Handoff

**Files:**
- Modify only files required by review findings
- Create: `docs/superpowers/reports/2026-07-24-todo-continuous-workflow-verification.md`

**Interfaces:**
- Produces: reviewed commits with no unresolved findings
- Produces: a locally installable VSIX and verification report

- [ ] **Step 1: Run deterministic and TODO-specific gates**

Run:

```bash
npm run test:deterministic
npm run test:behavior-contracts
npm run test:dashboard
npm run test:architecture-guards
npm run lint:ci
```

Expected: every command exits 0.

- [ ] **Step 2: Run repository safety and packaging gates**

Run:

```bash
npm run test:safety
npm run test:release-packaging
npm run vscode:prepublish
```

Expected: every command exits 0 and both release extensions package cleanly.

- [ ] **Step 3: Review the complete branch diff**

Review `origin/main...HEAD` for requirements coverage, TODO root replacement,
unsafe HTML, stale result handling, Undo overwrites, focus loss, generated
asset drift, and unrelated changes. Fix each actionable issue with a focused
test first, rerun its narrow test, and commit the correction.

- [ ] **Step 4: Build and install the local extension**

Follow `installing-vscode-extensions-locally` and run:

```bash
npm run install-local
```

Expected: the script builds a clean VSIX, installs both required extensions
into the applicable local/remote Extension Host, and prints the installed
version/path without errors.

- [ ] **Step 5: Record verification evidence**

Write the exact command results, test totals, packaged artifact paths, tested
VS Code/Node environment, and manual checklist for:

- long title list/detail rendering;
- list-to-detail return focus;
- quick create;
- completion/delete Undo;
- storage failure rollback;
- single-scroll 20–100 item fixture;
- dark/light/high-contrast and narrow-width presentation.

- [ ] **Step 6: Commit the report**

```bash
git add docs/superpowers/reports/2026-07-24-todo-continuous-workflow-verification.md
git commit -m "docs: verify continuous todo workflow"
```
