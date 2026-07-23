# Workspace Running Animation Rebase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve main's configurable running-session animation after the workspace-first rebase by applying it only to the local CURRENT WORKSPACE card.

**Architecture:** Derive the running count at render time from the current card's already-local `WorkspaceAiSessionViewModel.activeSessions`; do not change bridge protocol v2 or navigation-card data. Normalize the animation in the renderer and pass the configured value through full, open-workspace incremental, and AI-session incremental rendering paths.

**Tech Stack:** TypeScript, VS Code Webview HTML/CSS, Node assertion safety scripts, Gulp-generated CSS/media.

## Global Constraints

- OTHER WINDOWS records and cards must not contain session counts, running booleans, provider details, or animation state.
- Do not restore any file, command, schema, marker, or state key from the deleted live-project v1 compatibility path.
- The supported animation values remain exactly `current`, `sweep`, `orbit`, `halo`, `ripple`, `breath`, and `none`; invalid values normalize to `current`.
- `none` keeps the static running-state card class and data attribute but emits no `.project-session-fx` layer.
- Count only local active sessions whose `executionState === 'running'`; stopped and starting sessions do not activate the card animation.
- All copied/generated media must be produced by Gulp, never edited independently.
- The design source of truth is `docs/superpowers/specs/2026-07-21-workspace-running-animation-rebase-design.md`.

---

### Task 1: Render running state on the current workspace card only

**Files:**
- Modify: `src/webview/webviewContent.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Generated: `media/styles.css`

**Interfaces:**
- Consumes: `WorkspaceCardViewModel.aiSessions.activeSessions[].executionState` and an optional animation string supplied to the workspace render functions.
- Produces: `getCurrentWorkspaceGroupContent(card, hasOtherWindows, runningCardAnimation?)` and `getOpenWorkspacesGroupContent(cards, collapsed, otherWindowsStatus?, runningCardAnimation?)` with current-card-only running markup.

- [ ] **Step 1: Add failing renderer behavior tests**

Add fixtures that call `getCurrentWorkspaceGroupContent`/`getOpenWorkspacesGroupContent` with a current card containing one `running`, one `starting`, and one `stopped` active session. Assert exact behavior:

```js
assert.ok(currentHtml.includes('class="workspace-card project steward-item-card session-running"'));
assert.ok(currentHtml.includes('data-session-fx="orbit"'));
assert.ok(currentHtml.includes('<div class="project-session-fx"></div>'));
assert.ok(currentHtml.includes('title="Workspace — 1 active session running"'));

assert.ok(noneHtml.includes('data-session-fx="none"'));
assert.strictEqual(noneHtml.includes('project-session-fx'), false);
assert.ok(invalidHtml.includes('data-session-fx="current"'));
assert.strictEqual(idleHtml.includes('session-running'), false);
```

Construct a malicious navigation card with an `aiSessions` object and assert it still contains none of `session-running`, `data-session-fx`, `project-session-fx`, or `active session running`.

- [ ] **Step 2: Run the renderer tests and verify RED**

Run:

```bash
npm run test-compile
node scripts/run-ai-session-safety-checks.js
node scripts/run-dashboard-webview-checks.js
```

Expected: compilation or a renderer assertion fails because the workspace render functions do not accept/use the animation value and current cards have no running-state markup.

- [ ] **Step 3: Implement minimal current-card rendering**

In `src/webview/webviewContent.ts`, add a bounded normalization helper and optional arguments:

```ts
const AI_SESSION_RUNNING_CARD_ANIMATIONS = new Set([
    'current', 'sweep', 'orbit', 'halo', 'ripple', 'breath', 'none',
]);

function normalizeRunningCardAnimation(value: string | undefined): string {
    return value && AI_SESSION_RUNNING_CARD_ANIMATIONS.has(value) ? value : 'current';
}
```

Pass the normalized value only to the current card. Inside `getWorkspaceCardDiv`, compute:

```ts
const runningSessionCount = isCurrent
    ? (aiSessions?.activeSessions || []).filter(session => session.executionState === 'running').length
    : 0;
const sessionFx = runningSessionCount > 0
    ? normalizeRunningCardAnimation(runningCardAnimation)
    : '';
```

Append `session-running`, `data-session-fx`, an effect layer unless the value is `none`, and the accessible running-count suffix to the current workspace icon title. Navigation cards must not consume `aiSessions` or the animation argument.

- [ ] **Step 4: Restore main's style/config regression assertions and verify GREEN**

Keep/add assertions for all six animation keyframe families, `.project-session-fx`, reduced-motion behavior, the running terminal-icon keyframes, and the exact package configuration enum. Regenerate CSS:

```bash
npx gulp buildStyles
npm run test-compile
node scripts/run-ai-session-safety-checks.js
node scripts/run-dashboard-webview-checks.js
git diff --check
```

Expected: all commands exit 0; the navigation privacy assertions remain green.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/webview/webviewContent.ts scripts/run-ai-session-safety-checks.js scripts/run-dashboard-webview-checks.js media/styles.css
git commit -m "feat: animate running sessions on current workspace"
```

---

### Task 2: Propagate configuration through every v2 render path

**Files:**
- Modify: `src/dashboard/webviewUpdateMessages.ts`
- Modify: `src/openWorkspaces/dashboardController.ts`
- Modify: `src/aiSessions/dashboardController.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/webview/webviewContent.ts`
- Modify: `scripts/run-dashboard-webview-checks.js`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: raw `projectSteward.aiSessionRunningCardAnimation` from the current VS Code configuration.
- Produces: `runningCardAnimation?: string` on all three v2 message-builder inputs and `getRunningCardAnimation: () => string | undefined` on both incremental dashboard controllers.

- [ ] **Step 1: Add failing full/incremental propagation tests**

Add behavior tests proving:

```js
const openMessage = dashboardUpdateMessages.buildOpenWorkspacesUpdatedMessage({
    groups: [],
    cards: [workspaceCard],
    collapsed: false,
    semanticRevision: 'b'.repeat(64),
    otherWindowsStatus: 'ready',
    todoSearchItems,
    runningCardAnimation: 'halo',
});
assert.ok(openMessage.html.includes('data-session-fx="halo"'));

const sessionMessage = dashboardUpdateMessages.buildAiSessionsUpdatedMessage({
    groups: [],
    cards: [workspaceCard],
    sequence: 7,
    generatedAt: '2026-07-21T00:00:00.000Z',
    todoSearchItems,
    runningCardAnimation: 'ripple',
});
assert.ok(sessionMessage.html.includes('data-session-fx="ripple"'));
```

Instantiate `OpenWorkspaceDashboardController` and `AiSessionDashboardController` with `getRunningCardAnimation` returning non-default values and assert their posted v2 messages contain those values. Render `getStewardContent` with a config returning `breath` and assert full HTML contains `data-session-fx="breath"`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run test-compile
node scripts/run-open-project-safety-checks.js
node scripts/run-ai-session-safety-checks.js
node scripts/run-dashboard-webview-checks.js
```

Expected: type or behavior assertions fail because configuration is not propagated through the v2 builders/controllers.

- [ ] **Step 3: Implement configuration propagation**

Add `runningCardAnimation?: string` to `BuildWorkspaceUpdatedMessageInput`, `BuildOpenWorkspacesUpdatedMessageInput`, and `BuildAiSessionsUpdatedMessageInput`, and pass it to the renderer. Add this option to both controllers:

```ts
getRunningCardAnimation: () => string | undefined;
```

Use it when building incremental messages. In `src/dashboard.ts`, wire both controller options with:

```ts
getRunningCardAnimation: () => getStewardConfiguration()
    .get<string>('aiSessionRunningCardAnimation', 'current'),
```

For full render, normalize `infos.config.get('aiSessionRunningCardAnimation', 'current')` and pass it from `getStewardContent` into `getOpenWorkspacesGroupContent`.

- [ ] **Step 4: Update user-facing copy**

Change `package.json` and `README.md` so the setting says it animates the CURRENT WORKSPACE card while a local AI session is executing. Explicitly retain the statement that OTHER WINDOWS does not expose provider/session details.

- [ ] **Step 5: Run full verification and verify GREEN**

Run:

```bash
npx gulp buildStyles copyWebviewAssets
npm run lint
npm run test:safety
npm run test:dashboard
npm run test:tmux:smoke
npm run test:architecture-baseline
npm run test:release-notes
npm run test:release-packaging
git diff --check
```

Expected: every command exits 0; lint may report only the established warning baseline; release packaging performs its clean rebuild and real VSIX audit.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/dashboard/webviewUpdateMessages.ts src/openWorkspaces/dashboardController.ts src/aiSessions/dashboardController.ts src/dashboard.ts src/webview/webviewContent.ts scripts/run-dashboard-webview-checks.js scripts/run-ai-session-safety-checks.js README.md package.json media
git commit -m "fix: preserve workspace animation after rebase"
```

After both tasks, request a whole-range review from `main` to `HEAD`. The review must explicitly verify that no session fact enters `OpenWorkspaceRecord` or navigation-card markup.
