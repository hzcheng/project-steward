# Workspace New Session Directory-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the multi-root `IN…` control and make `NEW` choose a workspace working directory before provider and title prompts.

**Architecture:** Keep one `create-ai-session` webview route. Move multi-root root selection into `AiSessionCreationController` through an injected picker, then pass the selected root to the existing provider-aware directory-scope preflight. Reuse one dashboard picker function for creation and resume preflight.

**Tech Stack:** TypeScript, VS Code extension API, server-rendered webview HTML, plain JavaScript webview controller, Node assertion safety suites.

## Global Constraints

- Multi-root order is root picker → provider picker → optional title → capability preflight → runtime creation.
- Cancelling the root picker performs no later prompts or runtime mutations.
- Single-folder creation and all resume behavior remain unchanged.
- `create-ai-session` is the only new-session webview message.

---

### Task 1: Remove the `IN…` Webview Entry Point

**Files:**
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `media/webviewProjectScripts.js`
- Modify: `src/dashboard/messageRouter.ts`
- Modify: `src/dashboard.ts`
- Test: `scripts/run-dashboard-webview-checks.js`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: the existing `create-ai-session` message containing `projectId`.
- Produces: workspace markup and click handling with no `open-new-session-in`, `new-session-in`, or root-specific creation route.

- [x] **Step 1: Write failing rendering and routing tests**

Change multi-root assertions to require `data-action="create-ai-session"` and reject `open-new-session-in` / `new-session-in`. Remove the expected `new-session-in` click message and assert the router ignores that obsolete message instead of invoking a dedicated handler.

- [x] **Step 2: Run tests and verify RED**

Run: `npm run test-compile && node scripts/run-dashboard-webview-checks.js && node scripts/run-ai-session-safety-checks.js`

Expected: FAIL because current workspace markup and webview clicks still expose `new-session-in`.

- [x] **Step 3: Remove the obsolete UI and route**

Delete `getNewSessionInMenu`, its header interpolation, both webview click branches, `DashboardAiSessionCreateMessageHandler`'s root parameter, `newSessionIn`, and the special router branch. Update the dashboard handler to call `createSession(projectId)`.

- [x] **Step 4: Rebuild mirrored webview assets and verify GREEN**

Run: `npm run test-compile && npx gulp --production && node scripts/run-dashboard-webview-checks.js && node scripts/run-ai-session-safety-checks.js`

Expected: both suites PASS and generated `media/webviewProjectScripts.js` matches the source asset.

### Task 2: Select the Multi-Root Working Directory First

**Files:**
- Modify: `src/aiSessions/creationController.ts`
- Modify: `src/dashboard.ts`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: `pickWorkspaceRoot(workspace): PromiseLike<string | undefined>` injected into `AiSessionCreationControllerOptions`.
- Produces: `createSession(projectId)` that supplies the chosen root ID to `resolveWorkspaceDirectoryScope(target, providerId, explicitRootId)`.

- [x] **Step 1: Write failing creation-order tests**

Instrument picker callbacks with an order array. Assert multi-root creation records `root`, `provider`, `title`; cancellation records only `root`; a one-root workspace records `provider`, `title` and never calls the root picker; and the selected root reaches the runtime request's `directoryScope.primaryRootId`.

- [x] **Step 2: Run the focused safety suite and verify RED**

Run: `npm run test-compile && node scripts/run-ai-session-safety-checks.js`

Expected: FAIL because creation currently starts with the provider picker and has no injected creation root picker.

- [x] **Step 3: Implement directory-first creation**

Add the required picker dependency. In `createSession`, after resolving the workspace target and entering the creation guard, call it only when `workspace.roots.length > 1`; return on cancellation; then request provider and title and pass the root ID into existing scope resolution. Extract the dashboard's current root Quick Pick callback into a shared local function and inject it into both command preflight and creation.

- [x] **Step 4: Verify focused and full suites**

Run: `npm run lint && npm run test:safety && npm run test:dashboard && npm run test:architecture-baseline && npm run test:release-notes && git diff --check`

Expected: all commands exit 0; lint may retain repository baseline warnings.

- [x] **Step 5: Package and install**

Run: `npm run package:release && node scripts/run-release-packaging-checks.js`

Install only `artifacts/project-steward-2.1.3.vsix` into the Dev Container with `code-server --install-extension ... --force`. Do not install or overwrite the UI bridge.

- [x] **Step 6: Commit**

Run: `git add <modified files> && git commit -m "fix: choose workspace directory before session setup"`

Expected: the feature branch is clean and the commit contains the UI removal, controller ordering, tests, and generated asset.
