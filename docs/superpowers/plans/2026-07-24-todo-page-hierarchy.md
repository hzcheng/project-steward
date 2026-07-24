# TODO Page Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TODO page command bar visibly and semantically distinct from real TODO group headers.

**Architecture:** Introduce a page-only `todo-page-command-bar` presentation at both TODO render paths while leaving `steward-group-header` exclusively on real groups. Protect the distinction with one P0 integration behavior that checks the host render, client render source, and SCSS contract.

**Tech Stack:** TypeScript, framework-free Webview JavaScript, SCSS, Node.js test runner

## Global Constraints

- Do not change TODO data, mutation, drag-and-drop, or keyboard contracts.
- Real TODO groups retain the shared `steward-group-header` primitive.
- The page command bar has no group border, filled group background, shadow, indentation, or disclosure control.
- Metadata truncates before the fixed-width action cluster at narrow widths.
- Keep `main` untouched; work only in `.worktree/todo-ux`.

---

### Task 1: Page-level TODO command bar

**Files:**
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `tests/integration/dashboard/todoContent.test.js`
- Modify: `src/todos/webviewContent.ts`
- Modify: `src/webview/webviewTodoScripts.js`
- Modify: `media/styles.scss`
- Generate: `media/webviewTodoScripts.js`
- Generate: `media/styles.css`

**Interfaces:**
- Consumes: `getTodoPanelContent(viewModel)` and client `renderListSurface()`.
- Produces: `.todo-page-command-bar`, with `.todo-summary-copy` and `.todo-summary-actions` unchanged as behavior/layout hooks.

- [ ] **Step 1: Register and write the failing P0 behavior**

Add `TODO-PAGE-HIERARCHY-001` to the behavior catalog with
`tests/integration/dashboard/todoContent.test.js` as owner and the two render
sources plus `media/styles.scss` as evidence. Add this exact focused test:

```js
test('TODO-PAGE-HIERARCHY-001 separates the page command bar from real group headers', () => {
    const html = renderPanel();
    const pageHeader = html.match(/<header class="todo-page-header[^"]*"/)[0];

    assert.match(pageHeader, /todo-page-command-bar/);
    assert.doesNotMatch(pageHeader, /(?:group-title|steward-group-header)/);
    assert.match(html, /class="todo-group-header group-title steward-group-header"/);
    assert.match(todoScript, /todo-page-header todo-page-command-bar/);
    assert.doesNotMatch(todoScript, /todo-page-header group-title steward-group-header/);
    assert.match(styles, /\.todo-page-command-bar\s*\{[\s\S]*border:\s*0[\s\S]*background:\s*transparent/);
    assert.match(styles, /\.todo-page-command-bar \.todo-summary-actions\s*\{[\s\S]*opacity:\s*1[\s\S]*pointer-events:\s*all/);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/todoContent.test.js
```

Expected: `TODO-PAGE-HIERARCHY-001` fails because the page header still emits
`group-title steward-group-header`.

- [ ] **Step 3: Implement the distinct render primitive**

Change both page-header render paths, including the unsupported-version host
path, to:

```html
<header class="todo-page-header todo-page-command-bar">
```

Keep real groups unchanged. Add the page-only SCSS:

```scss
.todo-page-command-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    min-width: 0;
    min-height: 32px;
    padding: 2px 4px 6px;
    border: 0;
    color: var(--steward-foreground);
    background: transparent;
    box-shadow: none;
    box-sizing: border-box;
}

.todo-page-command-bar .todo-summary-copy strong {
    font-size: 17px;
    font-weight: 750;
    letter-spacing: .02em;
}

.todo-page-command-bar .todo-summary-actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 2px;
    opacity: 1;
    pointer-events: all;
}
```

- [ ] **Step 4: Build generated assets and confirm GREEN**

Run:

```bash
npm run test-compile
npx gulp --production
node --test tests/integration/dashboard/todoContent.test.js
npm run test:behavior-contracts
```

Expected: focused integration and behavior-contract checks pass.

- [ ] **Step 5: Run repository gates and package**

Run:

```bash
npm run test:deterministic
npm run test:dashboard
npm run test:architecture-guards
npm run lint:ci
npm run test:safety
npm run test:release-packaging
```

Expected: all commands exit 0.

- [ ] **Step 6: Review and commit**

Check `git diff --check`, confirm no unrelated files changed, review against
`docs/superpowers/specs/2026-07-24-todo-page-hierarchy-design.md`, then commit:

```bash
git add docs/testing/behavior-contracts.json tests/integration/dashboard/todoContent.test.js \
  src/todos/webviewContent.ts src/webview/webviewTodoScripts.js \
  media/styles.scss media/styles.css media/webviewTodoScripts.js
git commit -m "fix: distinguish todo page command bar"
```

- [ ] **Step 7: Install the verified VSIX**

Install `artifacts/project-steward-2.1.5.vsix` with the pinned VS Code Server
CLI after clearing the stale inherited IPC hook. Verify archive integrity,
extension version, and installed bundle/media hashes. Do not merge `main`.
