# Current Workspace Summary Click Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make only the CURRENT WORKSPACE summary toggle AI Sessions while clicks on the divider or session area never collapse the card.

**Architecture:** Mark the existing AI Sessions root as a non-toggle event boundary without adding a layout element or style. Keep delegated card clicks and existing action dispatch, but return before `toggleCodexSessions` when a current-workspace click originated inside that boundary.

**Tech Stack:** Server-rendered TypeScript HTML, browser JavaScript event delegation, Node `assert` safety suites, VS Code VSIX packaging.

## Global Constraints

- Do not change `media/styles.scss` or `media/styles.css`.
- Do not change card dimensions, spacing, separator placement, colors, hover/focus treatment, or animation.
- The existing divider and everything below it must not toggle expansion.
- OTHER WINDOWS navigation, PROJECTS cards, save actions, and AI Session actions retain their behavior.
- Install only the main extension into the Dev Container; do not install or overwrite the UI bridge.

---

### Task 1: Protect the AI Sessions Region From Card Toggle Clicks

**Files:**
- Modify: `scripts/run-dashboard-webview-checks.js`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Generated: `media/webviewProjectScripts.js`

**Interfaces:**
- Consumes: delegated `onInsideProjectClick(e, projectDiv)` and the existing `.codex-sessions` root.
- Produces: `data-ai-session-region` on the existing root and a current-workspace boundary check using `e.target.closest('[data-ai-session-region]')`.

- [x] **Step 1: Write failing markup and click-behavior tests**

Add a rendering assertion that the existing AI Sessions root contains the boundary without adding a summary wrapper:

```js
assert.ok(singleHtml.includes('class="codex-sessions" data-ai-session-region'));
assert.strictEqual(singleHtml.includes('workspace-card-summary'), false);
```

Extend the webview runtime harness with three current-workspace targets. The summary target returns the current project for `.project` selectors and `null` for `[data-ai-session-region]`; the session and divider targets additionally return a shared region object for `[data-ai-session-region]`. Assert the summary emits one `toggle-codex-sessions` message while the session and divider clicks emit none.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-dashboard-webview-checks.js && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL because the markup lacks `data-ai-session-region` and current-workspace clicks inside the session area still reach `toggleCodexSessions`.

- [x] **Step 3: Add the non-visual DOM boundary and click guard**

Change the existing AI Sessions root in `getAiSessionsDiv` without adding a wrapper:

```ts
<div class="codex-sessions" data-ai-session-region data-selected-ai-session-tab="${selectedTab}">
```

Guard only current-workspace toggling after existing action handlers:

```js
if (projectDiv.hasAttribute("data-current-workspace")) {
    if (e.target.closest('[data-ai-session-region]'))
        return;

    toggleCodexSessions(projectDiv, dataId);
    return;
}
```

- [x] **Step 4: Copy webview assets and verify GREEN**

Run:

```bash
npx gulp --production
npm run test-compile
node scripts/run-dashboard-webview-checks.js
node scripts/run-ai-session-safety-checks.js
node scripts/run-open-project-safety-checks.js
git diff --exit-code -- media/styles.scss media/styles.css
```

Expected: all checks PASS, generated project script matches its source, and both style files have no diff.

### Task 2: Full Verification, Packaging, Installation, and Commit

**Files:**
- Modify: `docs/superpowers/plans/2026-07-21-current-workspace-summary-click-target.md`

**Interfaces:**
- Consumes: the verified non-toggle boundary from Task 1.
- Produces: a packaged and installed `hzcheng.project-steward@2.1.3` main extension with the UI bridge untouched.

- [x] **Step 1: Run complete repository verification**

Run:

```bash
npm run lint
npm run test:safety
npm run test:dashboard
npm run test:architecture-baseline
npm run test:release-notes
git diff --check
git diff --exit-code -- media/styles.scss media/styles.css
```

Expected: every command exits 0; lint may print repository baseline warnings, and style files remain unchanged.

- [x] **Step 2: Package and validate release archives**

Run:

```bash
npm run package:release
node scripts/run-release-packaging-checks.js
```

Expected: `artifacts/project-steward-2.1.3.vsix` and bridge `0.1.4` package successfully and archive checks pass.

- [x] **Step 3: Install only the main extension and verify bytes**

Run the pinned Dev Container `code-server --install-extension artifacts/project-steward-2.1.3.vsix --force`, verify `hzcheng.project-steward@2.1.3` is listed, and compare SHA-256 for packaged and installed `dist/dashboard.js`. Do not install the bridge VSIX.

- [x] **Step 4: Commit the tested change**

```bash
git add docs/superpowers/specs/2026-07-21-current-workspace-summary-click-target-design.md \
  docs/superpowers/plans/2026-07-21-current-workspace-summary-click-target.md \
  scripts/run-dashboard-webview-checks.js scripts/run-ai-session-safety-checks.js \
  src/webview/webviewContent.ts src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
git commit -m "fix: limit workspace collapse click target"
```

Expected: the commit succeeds and the feature worktree is clean.
