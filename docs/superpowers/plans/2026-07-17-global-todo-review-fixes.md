# Global TODO Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the verified data-safety, CRUD, ordering, search, bulk-action, and accessibility gaps in the Global TODO implementation before merge.

**Architecture:** Keep `TodoService` as the single persistence/mutation boundary and serialize mutations there. Keep rendering in `src/todos`, host prompts/errors in `src/dashboard.ts`, and DOM-only interaction in the existing webview scripts. Reuse the existing Dashboard search catalog, Dragula dependency, modal prompts, and generated asset workflow.

**Tech Stack:** TypeScript 4.x, VS Code Extension API, plain browser JavaScript, SCSS, Dragula, Node contract tests.

## Global Constraints

- Preserve existing TODO data, IDs, timestamps, priority values, and `order` fields.
- Never normalize or write an unknown future TODO data version.
- Storage migration copies only into an empty destination and never overwrites two non-empty stores.
- Do not add arbitrary task-count or byte limits without a product-defined threshold; surface write failures and preserve entered form data instead.
- Keep `projectSteward.storeProjectsInSettings` primary/legacy resolution consistent with project storage.
- Use one persisted mutation for bulk collapse and each reorder operation.
- Regenerate `media/styles.css` and copied webview scripts after source changes.
- Start every task with a focused failing contract test and end with `npm run test:dashboard`, `npm run test:safety`, and `git diff --check`.

---

### Task 1: Protect TODO Persistence And Storage Switching

**Files:**
- Modify: `src/todos/types.ts`
- Modify: `src/todos/service.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Produces: `UnsupportedTodoDataVersionError`, `TodoService.migrateDataIfNeeded()`, persisted `TodoViewState`, serialized service mutations.
- Preserves: `TodoDataV1`, `TODO_DATA_KEY`, `TODO_SETTINGS_KEY`, and existing service method names.

- [ ] Add failing tests for primary/legacy setting resolution, bidirectional empty-target migration, non-overwrite conflict behavior, persisted `showCompleted`, rejected writes, and unknown future versions that must not call either storage update method.
- [ ] Run `npm run test:dashboard`; confirm the new migration/version/error contracts fail.
- [ ] Make parsing explicitly accept version `1` and unversioned legacy v1-shaped data, but throw `UnsupportedTodoDataVersionError` for any other explicit version.
- [ ] Make context-backed storage resolve `storeProjectsInSettings` using the primary setting when explicitly configured, then legacy, then the primary default.
- [ ] Add a non-destructive `migrateDataIfNeeded()` that copies supported data only when the selected destination is empty and the other backend is non-empty; call it during startup/config migration.
- [ ] Persist `showCompleted` in `globalState` under the existing `TODO_VIEW_STATE_KEY` without syncing it.
- [ ] Serialize service mutations through one internal promise queue. Wrap host TODO handlers so rejected writes show a user-visible error and do not post replacement panel HTML.
- [ ] Run focused tests, Dashboard checks, safety checks, and `git diff --check`.
- [ ] Commit as `fix: protect todo persistence`.

### Task 2: Complete Ordering, Empty Groups, And Atomic Bulk Collapse

**Files:**
- Modify: `src/todos/service.ts`
- Modify: `src/todos/viewModel.ts`
- Modify: `src/todos/webviewContent.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `src/webview/webviewDnDScripts.js`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Generate: `media/webviewProjectScripts.js`
- Generate: `media/webviewDnDScripts.js`

**Interfaces:**
- Produces: `renameGroup`, `reorderGroups`, `reorderTodos`, `setGroupsCollapsed`, and messages `todo-rename-group`, `todo-reorder-groups`, `todo-reorder-items`, `todo-collapse-groups`.
- Consumes: Task 1 serialized mutation boundary.

- [ ] Add failing service/render/message tests for new TODO insertion at group order `0`, stable completed-last projection, visible empty groups, group rename, exact reorder arrays, and one-message bulk collapse.
- [ ] Run `npm run test:dashboard`; confirm failures identify the missing behavior.
- [ ] Shift existing group-item orders before adding a TODO so the new item is first. Partition visible items into incomplete then completed while preserving order inside each partition.
- [ ] Treat the panel as globally empty only when there are no groups; render existing empty groups with their header and add action.
- [ ] Add atomic service methods for group rename, group reorder, within-group TODO reorder, and bulk group collapse; normalize affected `order` values in one save.
- [ ] Add host handlers and TODO-specific Dragula containers/acceptance rules. Post one reorder message on drop and one bulk-collapse message for expand/collapse all.
- [ ] Copy webview scripts, run Dashboard/safety checks and `git diff --check`.
- [ ] Commit as `feat: complete todo ordering`.

### Task 3: Make TODO Creation And Destructive Actions Complete

**Files:**
- Modify: `src/todos/webviewContent.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `media/styles.scss`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Generate: `media/styles.css`
- Generate: `media/webviewProjectScripts.js`

**Interfaces:**
- Produces: reachable `.todo-add-form`, `todo-cancel-add`, group-targeted compose behavior, and confirmed single-TODO deletion.
- Consumes: existing `todo-add` mutation and Task 1 error-preserving host behavior.

- [ ] Replace the old “add form absent” assertion with failing contracts for one hidden compose form containing title, priority, notes, group select, save, and cancel controls.
- [ ] Add failing handler tests proving single-TODO delete requires modal confirmation and cancellation performs no mutation.
- [ ] Render the compose form for empty and non-empty panels. Top-level add targets Inbox; group add preselects that group; cancel hides without clearing other panel state.
- [ ] Keep form values until successful host refresh. Remove the host title-only `showInputBox` fallback for webview messages.
- [ ] Confirm deletion with the TODO title before calling `deleteTodo`.
- [ ] Regenerate CSS/scripts, run Dashboard/safety checks and `git diff --check`.
- [ ] Commit as `feat: complete todo creation flow`.

### Task 4: Complete Search, Catalog Preservation, And Keyboard Interaction

**Files:**
- Modify: `src/dashboard/webviewUpdateMessages.ts`
- Modify: call sites in `src/dashboard.ts`, `src/openProjects/dashboardController.ts`, and `src/aiSessions/dashboardController.ts` as required
- Modify: `src/webview/webviewDashboardScripts.js`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/todos/webviewContent.ts`
- Modify: `media/styles.scss`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-open-project-safety-checks.js`
- Generate: copied webview scripts and `media/styles.css`

**Interfaces:**
- Produces: preserved TODO search projections in incremental messages, pending TODO search target reveal/focus, `onTodoMounted`, keyboard-operable collapse/expand, Escape cancel, and restored pre-edit expansion state.

- [ ] Add failing tests proving incremental Open/AI messages preserve non-empty TODO catalog items, search results render notes/completed metadata, and a clicked result carries `todoId/groupId` through mount and focus.
- [ ] Add failing contracts for `onTodoMounted`, group `aria-expanded`, focusable expand controls, Enter/Space activation, Escape cancellation, and pre-edit expansion restoration.
- [ ] Pass `todoSearchItems` through all catalog rebuild inputs and update safety fixtures to require `todos` rather than silently defaulting it away.
- [ ] Store a pending TODO search target, switch tabs, request reveal when the completed item is hidden, expand its group, then scroll/focus it after TODO content mounts.
- [ ] Synchronize the global collapse button from `onTodoMounted`.
- [ ] Use a real button for group collapse and a focusable item expand control. Handle Enter/Space and Escape without toggling nested controls; restore the pre-edit expanded state on cancel.
- [ ] Render TODO search note snippets, group/priority metadata, and completed-state styling.
- [ ] Regenerate assets, run Dashboard/safety checks and `git diff --check`.
- [ ] Commit as `fix: complete todo dashboard interactions`.

### Task 5: Final Verification, Cleanup, Package, And Install

**Files:**
- Modify only if verification finds a regression.
- Fix: `docs/superpowers/plans/2026-07-16-global-todo-list.md` trailing whitespace.

- [ ] Remove the known trailing blank-line violation and run `git diff --check $(git merge-base HEAD main)..HEAD`.
- [ ] Run `npx gulp buildStyles copyWebviewAssets`.
- [ ] Run `npm run test:dashboard`, `npm run test:safety`, `npm run test:architecture-baseline`, `npm run test:release-notes`, `npm run test:release-packaging`, and `npm run lint`.
- [ ] Confirm both source/media webview script pairs are byte-identical and the worktree is clean.
- [ ] Request an independent whole-branch review and fix all Critical/Important findings.
- [ ] Run `SKIP_NPM_CI=1 npm run install-local`, verify `hzcheng.project-steward@2.0.1`, and report the UI-only bridge host limitation separately.
- [ ] Commit any final focused correction; do not create an empty commit.

## Plan Self-Review

- All verified Important findings are covered. Arbitrary sync byte limits are intentionally excluded; rejected writes remain visible and preserve user input.
- Unknown future versions cannot be normalized or overwritten.
- Ordering uses the existing numeric `order` model rather than introducing a second `todoIds` representation.
- Every multi-group or reorder action is one service mutation and one persisted write.
- Search and incremental update tests preserve TODO catalog data while retaining Open/AI safety contracts.
- Manual visual inspection remains required after VS Code Reload Window because the repository has no VS Code UI screenshot harness.
