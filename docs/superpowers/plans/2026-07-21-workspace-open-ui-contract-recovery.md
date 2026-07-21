# Workspace OPEN UI Contract Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the established OPEN card appearance, running effects, direct other-window navigation, and narrow-sidebar usability while retaining one-card-per-workspace semantics.

**Architecture:** Keep `WorkspaceCardViewModel` as the live OPEN domain model, add its already-known environment as explicit rendering data, and render it through the existing project-card primitives. Keep navigation in `WorkspaceNavigationController`, but make exact-URI `vscode.openFolder` the normal path for every saved/single-folder workspace and reserve save-first behavior for untitled workspaces.

**Tech Stack:** TypeScript, VS Code Extension API, server-rendered Webview HTML, vanilla Webview JavaScript, SCSS/Gulp, Node assertion scripts.

## Global Constraints

- CURRENT WORKSPACE renders at most one card; roots never become sibling cards.
- Collapsed cards contain two text rows and no permanent workspace-root tag row.
- Running effects are current-window-only and require `executionState === 'running'`.
- OTHER WINDOWS carries no session/provider/running details.
- Navigation uses the exact folder or `.code-workspace` URI and never a member-root fallback.
- Untitled multi-root navigation asks the user to save first.
- Saved PROJECTS data and behavior remain unchanged.
- The installed Webview remains operable at a 200-pixel sidebar width.

---

### Task 1: Restore the workspace card rendering contract

**Files:**
- Modify: `src/models.ts`
- Modify: `src/openWorkspaces/dashboardController.ts`
- Modify: `src/openWorkspaces/projection.ts`
- Modify: `src/webview/webviewContent.ts`
- Test: `scripts/run-dashboard-webview-checks.js`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces: `WorkspaceCardViewModel.environment: OpenWorkspaceEnvironment`
- Consumes: existing `getProjectIcon(ProjectRemoteType)` and `getProjectIconTitle(ProjectRemoteType)` helpers

- [ ] **Step 1: Write failing rendering tests**

Extend workspace-card fixtures with `environment: 'local'`. Add a Dev Container
fixture and assertions equivalent to:

```js
const icons = require('../out/webview/webviewIcons');
const devContainerCard = makeWorkspaceCardFixture(1);
devContainerCard.environment = 'devContainer';
devContainerCard.environmentLabel = 'Dev Container';
const devContainerHtml = webviewContent.getCurrentWorkspaceGroupContent(devContainerCard, false);
assert.ok(devContainerHtml.includes(icons.container));
assert.strictEqual(devContainerHtml.includes('class="workspace-root-tags"'), false);
assert.strictEqual(devContainerHtml.includes('class="workspace-root-tag"'), false);

const multiHtml = webviewContent.getCurrentWorkspaceGroupContent(makeWorkspaceCardFixture(3), false);
assert.ok(multiHtml.includes('Local · 3 folders'));
assert.strictEqual(multiHtml.includes('class="workspace-root-tags"'), false);
assert.ok(multiHtml.includes('class="ai-session-root-chip"'));
```

Also assert that the effect layer appears after the accent layer, matching the
established project-card stacking order:

```js
assert.ok(orbitHtml.indexOf('project-session-fx') > orbitHtml.indexOf('steward-item-accent'));
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npm run test:dashboard
```

Expected: FAIL because `environment` is absent, the folder icon is hard-coded,
root tags still render, or the running layer has the wrong stacking order.

- [ ] **Step 3: Add explicit environment rendering data**

Add the domain field without deriving behavior from a display string:

```ts
import type { OpenWorkspaceEnvironment } from './workspaces/types';

export interface WorkspaceCardViewModel {
    // existing fields
    environment: OpenWorkspaceEnvironment;
    environmentLabel: string;
}
```

Populate it in both current and navigation card projections:

```ts
environment: workspace.environment,
environmentLabel: getEnvironmentLabel(workspace.environment),
```

- [ ] **Step 4: Restore the established icon and markup order**

Add a focused environment adapter in `webviewContent.ts`:

```ts
function getWorkspaceRemoteType(environment: WorkspaceCardViewModel['environment']): ProjectRemoteType {
    switch (environment) {
        case 'ssh': return ProjectRemoteType.SSH;
        case 'wsl': return ProjectRemoteType.WSL;
        case 'devContainer': return ProjectRemoteType.DevContainer;
        case 'remote': return ProjectRemoteType.Remote;
        case 'local':
        default: return ProjectRemoteType.None;
    }
}
```

In `getWorkspaceCardDiv`, use `getProjectIcon(remoteType)`, give its accessible
title the matching environment semantics, remove `rootTags` and
`workspace-root-tags`, and order the shell as:

```html
<div class="project-aura"></div>
<div class="project-border steward-item-accent"></div>
${sessionFxLayer}
<div class="fitty-container project-title-row">...</div>
<p class="project-description workspace-metadata">...</p>
${badge}
${sessionSection}
```

Keep root chips inside multi-root session rows and keep search text aware of
root names.

- [ ] **Step 5: Run focused rendering and session safety tests**

Run:

```bash
npm run test:dashboard
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: PASS, including one-card aggregation, execution-only running effects,
and no session details in navigation cards.

- [ ] **Step 6: Commit the rendering fix**

```bash
git add src/models.ts src/openWorkspaces/dashboardController.ts src/openWorkspaces/projection.ts src/webview/webviewContent.ts scripts/run-dashboard-webview-checks.js scripts/run-ai-session-safety-checks.js
git commit -m "fix: restore workspace OPEN card contract"
```

---

### Task 2: Restore narrow-sidebar and collapsed-card layout

**Files:**
- Modify: `media/styles.scss`
- Test: `scripts/run-ai-session-safety-checks.js`
- Test: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Consumes: workspace markup from Task 1
- Produces: shared responsive rules with no workspace-root tag CSS

- [ ] **Step 1: Write failing stylesheet contract tests**

Add source assertions equivalent to:

```js
assert.strictEqual(sidebarStyles.includes('.workspace-root-tags'), false);
assert.strictEqual(sidebarStyles.includes('.workspace-root-tag'), false);
assert.ok(sidebarStyles.includes('@media (max-width: 280px)'));
assert.ok(sidebarStyles.includes('min-width: 0'));
assert.ok(sidebarStyles.includes('text-overflow: ellipsis'));
assert.ok(sidebarStyles.includes('overflow-x: hidden'));
```

Add a rendering assertion that a collapsed single-root card has only its title
and description before the hidden session module and no third metadata row.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
npm run test:dashboard
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: FAIL because the workspace-root rules still exist.

- [ ] **Step 3: Remove the rejected tag layout and tighten badge spacing**

Delete `.workspace-root-tags` and `.workspace-root-tag`. Keep the shared
58-pixel collapsed shell. Apply reserved title width only when the badge is
actually present by rendering `data-has-ai-session-badge` with a non-empty
badge and scoping the width rule:

```scss
&[data-current-workspace][data-has-ai-session-badge] {
    .fitty-container,
    .project-description {
        width: calc(100% - 60px);
    }
}
```

Without the attribute, title and description use the full content width. In the
existing 280-pixel media query, keep the compact `AI` label and ensure title,
description, session text, and action rows use `min-width: 0` with ellipsis.
Do not add horizontal scrolling.

- [ ] **Step 4: Rebuild CSS and run focused tests**

Run:

```bash
npx gulp
npm run test:dashboard
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: PASS and generated `media/styles.css` reflects the SCSS changes.

- [ ] **Step 5: Commit the responsive fix**

```bash
git add media/styles.scss media/styles.css src/webview/webviewContent.ts scripts/run-dashboard-webview-checks.js scripts/run-ai-session-safety-checks.js
git commit -m "fix: keep workspace cards compact in narrow sidebars"
```

---

### Task 3: Restore direct OTHER WINDOWS navigation

**Files:**
- Modify: `src/openWorkspaces/navigationController.ts`
- Delete: `src/openWorkspaces/navigationCapabilities.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-open-project-safety-checks.js`
- Modify: `scripts/run-workspace-navigation-spike-checks.js`

**Interfaces:**
- Consumes: validated `OpenWorkspaceRecord.navigationUri` and `kind`
- Produces: `WorkspaceNavigationController.open(cardId): Promise<void>` with exact-URI direct navigation

- [ ] **Step 1: Replace fail-closed tests with failing direct-navigation tests**

For each environment (`local`, `ssh`, `wsl`, `devContainer`, `remote`) and each
non-untitled kind, assert:

```js
await controller.open('live-card');
assert.deepStrictEqual(parsedUris, [{ parsed: record.navigationUri }]);
assert.deepStrictEqual(executions, [[
    'vscode.openFolder',
    parsedUris[0],
    { forceNewWindow: true },
]]);
assert.strictEqual(JSON.stringify(executions).includes(record.roots[0].uri), false);
```

For `untitledMultiRoot`, retain the exact save-first information message and no
command. For a rejected `vscode.openFolder`, assert one warning and explicitly
assert that `workbench.action.switchWindow` is never executed.

- [ ] **Step 2: Run the navigation checks and verify failure**

Run:

```bash
npm run test:open-projects
```

Expected: FAIL because the all-false matrix routes normal records to the native
window picker.

- [ ] **Step 3: Simplify the controller to exact-URI navigation**

Remove the capability import, `canNavigateDirectly`, and command-enumeration
dependency. Preserve stale and untitled guards, then execute:

```ts
try {
    await this.options.executeCommand(
        'vscode.openFolder',
        this.options.parseUri(record.navigationUri),
        { forceNewWindow: true },
    );
} catch (_error) {
    this.options.showWarningMessage(
        'Unable to switch directly to this workspace. Use VS Code Switch Window instead.',
    );
}
```

Delete `navigationCapabilities.ts`, remove `getAvailableCommands` from the
controller options and `dashboard.ts`, and update the spike safety check so it
rejects production references to `workbench.action.switchWindow` rather than
requiring the old matrix.

- [ ] **Step 4: Run navigation and compile checks**

Run:

```bash
npm run test:open-projects
npm run lint
```

Expected: PASS; no production source imports the deleted matrix or invokes the
Switch Window command.

- [ ] **Step 5: Commit the navigation fix**

```bash
git add src/openWorkspaces/navigationController.ts src/openWorkspaces/navigationCapabilities.ts src/dashboard.ts scripts/run-open-project-safety-checks.js scripts/run-workspace-navigation-spike-checks.js
git commit -m "fix: navigate directly to open workspaces"
```

---

### Task 4: Full verification, review, package, and Dev Container installation

**Files:**
- Modify only if verification or review finds a scoped defect
- Verify: `artifacts/project-steward-2.1.3.vsix`

**Interfaces:**
- Consumes: Tasks 1-3
- Produces: reviewed and installed candidate build

- [ ] **Step 1: Run the complete repository verification**

Run:

```bash
npm run lint
npm run test:safety
npm run test:dashboard
npm run test:architecture-baseline
npm run test:release-notes
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Review the complete diff against the approved spec**

Use the repository review/fix loop. Verify specifically that saved PROJECTS
rendering did not change, navigation receives only validated record IDs, and
OTHER WINDOWS contains no session data. Apply scoped fixes and rerun Step 1 if
review finds an issue.

- [ ] **Step 3: Build the release package**

Run:

```bash
npm run package:release
```

Expected: exit 0 and recreate the main and UI Bridge release artifacts.

- [ ] **Step 4: Install the main VSIX into the existing Dev Container**

Follow `.codex/skills/installing-vscode-extensions-locally/SKILL.md` to resolve
the active Dev Container extension host and install the packaged main VSIX
without replacing the user's manually installed UI Bridge.

Expected: the Dev Container reports the new `hzcheng.project-steward` build and
the desktop UI host retains `hzcheng.project-steward-attention-ui-bridge`.

- [ ] **Step 5: Perform installed-build smoke checks**

Check the six reported regressions at 400, 280, 240, and 200 pixel sidebar
widths. Confirm the Dev Container icon, true collapsed height, visible running
effect only during `running`, direct OTHER WINDOWS focus without a picker or
duplicate window, and session actions at 200 pixels.

- [ ] **Step 6: Record the final repository state**

Run `git status --short` and `git log -5 --oneline`. If review required scoped
corrections, commit the exact files changed by that correction with message
`fix: close workspace OPEN acceptance gaps`; otherwise create no empty commit.
