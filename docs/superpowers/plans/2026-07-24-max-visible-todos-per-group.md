# Max Visible Todos Per Group Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore `projectSteward.maxVisibleTodosPerGroup` without regressing inline details or incremental TODO completion.

**Architecture:** Normalize the setting in the extension host, encode the resulting card-count viewport as CSS variables on the stable `.todo-panel` root, and let list CSS enforce the cap. The client TODO controller measures inline-detail expansion and updates only the affected list-height variable while keeping command-result patches local.

**Tech Stack:** TypeScript, browser JavaScript, SCSS, Node test runner, VS Code extension configuration.

## Global Constraints

- Default and invalid-value fallback is exactly `5`.
- Positive fractional values are floored.
- Collapsed TODO cards remain exactly `58px` high with `7px` spacing.
- Completing a TODO must not replace the TODO panel root.
- Main remains untouched; all changes stay on `feat/todo-ux-overhaul` until final merge approval.

---

### Task 1: Own the restored behavior in required CI

**Files:**
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `tests/integration/dashboard/todoContent.test.js`
- Modify: `tests/integration/dashboard/todoInteraction.test.js`
- Modify: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Consumes: `getTodoPanelContent(viewModel, options)`
- Produces: behavior `TODO-MAX-VISIBLE-PER-GROUP-001`

- [ ] **Step 1: Add the P0 behavior catalog entry**

Add an automated entry owned by the two integration tests, with renderer, dashboard, client controller, stylesheet, and package contribution evidence.

- [ ] **Step 2: Write the failing renderer and wiring assertions**

Render with `{ maxVisibleTodosPerGroup: 2 }`, assert the panel root contains `--todo-visible-items: 2`, `--todo-collapsed-item-height: 58px`, and `--todo-list-max-height: 123px`, then assert invalid input falls back to a `318px` five-card viewport. Assert dashboard source passes the normalized setting and SCSS caps `.todo-list`.

- [ ] **Step 3: Write the failing incremental-preservation assertion**

Mount the TODO controller in the integration harness, complete a card, and assert the original root object and its style attribute remain unchanged while no full render callback occurs.

- [ ] **Step 4: Verify RED**

Run `npm run test-compile && node --test tests/integration/dashboard/todoContent.test.js tests/integration/dashboard/todoInteraction.test.js`.

Expected: FAIL because the renderer ignores the options, dashboard has no setting reader, and SCSS has no list cap.

- [ ] **Step 5: Commit the regression tests**

Commit only catalog and test changes with `test: guard configured todo group viewport`.

### Task 2: Restore the configured viewport

**Files:**
- Modify: `src/todos/webviewContent.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/webview/webviewTodoScripts.js`
- Modify: `media/styles.scss`
- Modify: `package.json`
- Modify: generated `media/styles.css`

**Interfaces:**
- Consumes: `projectSteward.maxVisibleTodosPerGroup`
- Produces: `TodoPanelRenderOptions`, stable panel CSS variables, per-list expanded-height updates

- [ ] **Step 1: Restore renderer options**

Add `TodoPanelRenderOptions`, normalize the requested count, calculate `count * 58 + (count - 1) * 7`, and attach the three CSS properties to `.todo-panel`.

- [ ] **Step 2: Wire extension-host configuration**

Add `getMaxVisibleTodosPerGroup(config: vscode.WorkspaceConfiguration): number` and pass its result to every successful `getTodoPanelContent` call in `postTodoPanelContent`.

- [ ] **Step 3: Restore list viewport CSS**

Set `.todo-list` to `max-height: calc(var(--todo-list-max-height) + var(--todo-list-expanded-extra-height, 0px))` and `overflow-y: auto`.

- [ ] **Step 4: Keep inline details fully visible**

After client-side list render or card patch, measure `.todo-item.expanded` height beyond `--todo-collapsed-item-height` and write the total to `--todo-list-expanded-extra-height` on that list.

- [ ] **Step 5: Restore accurate Settings copy and compile styles**

Describe the setting as the maximum visible TODOs per group before scrolling, then run `npx gulp --production`.

- [ ] **Step 6: Verify GREEN**

Run the focused tests, `npm run test:behavior-contracts`, and `npm run test:dashboard`.

- [ ] **Step 7: Commit the fix**

Commit production and generated files with `fix: restore configured todo group viewport`.

### Task 3: Review, verify, and install

**Files:**
- Create: `docs/superpowers/reports/2026-07-24-max-visible-todos-per-group-verification.md`
- Modify: only files required by actionable review findings

**Interfaces:**
- Consumes: completed restoration
- Produces: reviewed commit, CI evidence, locally installed VSIX

- [ ] **Step 1: Run the repository review-fix-commit loop**

Review the complete branch diff, fix every Critical or Important finding, rerun focused verification, and commit intentional fixes separately.

- [ ] **Step 2: Run branch-level verification**

Run `npm run test:ci:linux` and record exact deterministic test totals and all gate results.

- [ ] **Step 3: Package and install**

Build the VSIX, verify its contents, install it into the active VS Code Server extension host with the repository's pinned command, and confirm `hzcheng.project-steward@2.1.5` is listed.

- [ ] **Step 4: Record verification and confirm isolation**

Write the report, commit it, verify the feature worktree is clean, and prove the primary checkout remains at its original main commit.
