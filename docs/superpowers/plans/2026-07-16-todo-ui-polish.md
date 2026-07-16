# TODO UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the existing global TODO tab UI without changing its data model or behavior.

**Architecture:** Keep `TodoService`, TODO storage, Dashboard tab loading, and message routing unchanged. Improve `src/todos/webviewContent.ts` markup semantics and `media/styles.scss` visual treatment, then regenerate `media/styles.css` and copied webview assets.

**Tech Stack:** VS Code webview HTML/CSS, TypeScript string renderers, existing Gulp asset pipeline.

## Global Constraints

- Work only in `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/todo-list`.
- Do not change TODO storage schema or synchronized data format.
- Do not add dependencies.
- Keep generated `media/webviewProjectScripts.js` equal to `src/webview/webviewProjectScripts.js`.

---

### Task 1: Polish TODO Markup And Styles

**Files:**
- Modify: `src/todos/webviewContent.ts`
- Modify: `media/styles.scss`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Generated: `media/styles.css`
- Generated: `media/webviewProjectScripts.js`
- Generated: `media/webviewDashboardScripts.js`

**Interfaces:**
- Consumes: `TodoPanelViewModel`, `TodoGroupViewModel`, `TodoItemViewModel`
- Produces: HTML using existing `data-action` values: `todo-add`, `todo-add-group`, `todo-toggle-show-completed`, `todo-focus-add`, `todo-sort-priority`, `todo-toggle`, `todo-edit`, `todo-delete`, `todo-save-edit`, `todo-cancel-edit`

- [ ] **Step 1: Update source-contract checks**

Run after edits: `npm run test:dashboard`

Expected: `Dashboard Webview checks passed.`

- [ ] **Step 2: Improve TODO HTML**

Add command bar, compose panel, group count, item meta row, and compact icon-capable buttons while preserving existing data actions.

- [ ] **Step 3: Improve TODO CSS**

Add polished command bar, compose panel, group section, task row, badge, completed, and inline editor styles using VS Code theme variables.

- [ ] **Step 4: Regenerate media assets**

Run: `npx gulp buildStyles copyWebviewAssets`

Expected: `Finished 'buildStyles'` and `Finished 'copyWebviewAssets'`.

- [ ] **Step 5: Verify**

Run:

```bash
npm run test:dashboard
npm run test:safety
git diff --check
```

Expected:
- Dashboard Webview checks passed.
- AI session safety checks passed.
- Open project safety checks passed.
- `git diff --check` exits 0.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-07-16-todo-ui-polish-design.md docs/superpowers/plans/2026-07-16-todo-ui-polish.md src/todos/webviewContent.ts media/styles.scss media/styles.css media/webviewDashboardScripts.js media/webviewProjectScripts.js scripts/run-dashboard-webview-checks.js
git commit -m "style: polish todo dashboard ui"
```

## Self-Review

- Spec coverage: visual direction maps to markup, CSS, generated assets, and checks.
- Placeholder scan: no TBD or deferred implementation steps.
- Scope check: data model, storage, sync, and message contracts remain unchanged.
