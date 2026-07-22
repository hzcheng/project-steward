# Readable Tmux Runtime Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give newly created Project Steward tmux sessions/windows readable project and AI-session names while retaining exact workspace identity, legacy runtime compatibility, stable creation-time names, and collision safety.

**Architecture:** Isolate safe readable-name generation and legacy/new locator matching in `tmuxNaming.ts`. Carry display names beside—not inside—runtime identity, let discovery and persistence retain actual locators (including readable session-layout window names), resolve existing project containers from ownership metadata before creation, and fold pending-to-final readable renames into the existing promotion transaction.

**Tech Stack:** TypeScript, Node.js crypto/Unicode normalization, VS Code Extension API, tmux argument-array client, assertion-based JavaScript safety checks, real tmux smoke tests.

## Global Constraints

- Names are fixed when a tmux object is created; later card/alias edits do not rename running objects.
- Project layout session format is `ps-<project-card-name>-<workspaceHash8>`.
- Project layout final window format is `<provider>-<session-name>-<sessionHash8>`.
- Pending window format is `<provider>-<entered-title-or-new-session>-<pendingHash8>`.
- Session layout uses readable project/session names for both its tmux session and its single window.
- Unicode letters/numbers are preserved after NFKC normalization; unsafe punctuation/control characters collapse to `-`.
- Complete generated names are at most 96 Unicode code points and always retain structural prefix plus the 8-character suffix.
- Duplicate display names remain distinct through identity-derived suffixes.
- Existing legacy hash-only locators remain discoverable/actionable and are not renamed on upgrade.
- Existing project-layout containers are reused by workspace ownership metadata even after the card display name changes.
- More than one project container claiming the same workspace scope fails closed.
- Saved projects/workspaces, Direct Terminal mode, Dashboard markup/styles, attention, execution animation, focus, and Other Windows behavior remain unchanged.

---

### Task 1: Build readable-name and locator-ownership primitives

**Files:**
- Create: `src/aiSessions/tmuxNaming.ts`
- Modify: `src/aiSessions/tmuxLayout.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js` in `runTmuxLayoutChecks`

**Interfaces:**
- Produces: `TmuxReadableNames`, `normalizeTmuxReadableComponent`, `buildReadableTmuxLocator`, `tmuxLocatorMatchesIdentity`, and `legacyTmuxLocator`.
- Consumes: `AiSessionRuntimeIdentity`, `AiSessionTmuxLayout`, `AiSessionTmuxLocator`, provider IDs, and SHA-256.

- [ ] **Step 1: Write failing naming and locator tests**

Import `out/aiSessions/tmuxNaming` and add assertions for Unicode, punctuation, empty fallback, length, deterministic suffixes, duplicates, pending/final names, both layouts, and legacy/new matching:

```js
const tmuxNaming = require('../out/aiSessions/tmuxNaming');
const readableIdentity = {
    provider: 'codex', workspaceScopeIdentity: 'scope-a',
    workspaceNavigationIdentity: 'nav-a', workspaceRootHostPaths: ['/work/a'],
    cwd: '/work/a', sessionId: 'session-123456789',
};
const readable = tmuxNaming.buildReadableTmuxLocator(
    readableIdentity, 'project',
    { projectName: ' RedDB DTS / 双活 ', sessionName: 'Fix: replication.timeout' }
);
assert.match(readable.sessionName, /^ps-RedDB-DTS-双活-[0-9a-f]{8}$/);
assert.match(readable.windowName, /^codex-Fix-replication-timeout-[0-9a-f]{8}$/);
assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity(readable, readableIdentity), true);
assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity(
    { ...readable, windowName: readable.windowName.replace(/[0-9a-f]{8}$/, '00000000') },
    readableIdentity
), false);

const duplicateNameIdentity = { ...readableIdentity, sessionId: 'different-session' };
assert.notStrictEqual(
    tmuxNaming.buildReadableTmuxLocator(duplicateNameIdentity, 'project', {
        projectName: 'RedDB DTS / 双活', sessionName: 'Fix: replication.timeout',
    }).windowName,
    readable.windowName
);

const pendingIdentity = { ...readableIdentity, sessionId: undefined, pendingId: 'pending-1' };
assert.match(tmuxNaming.buildReadableTmuxLocator(pendingIdentity, 'project', {
    projectName: 'RedDB', sessionName: '',
}).windowName, /^codex-new-session-[0-9a-f]{8}$/);

const sessionLayout = tmuxNaming.buildReadableTmuxLocator(readableIdentity, 'session', {
    projectName: 'RedDB', sessionName: 'Repair replication',
});
assert.match(sessionLayout.sessionName, /^ps-RedDB-Repair-replication-[0-9a-f]{8}$/);
assert.match(sessionLayout.windowName, /^codex-Repair-replication-[0-9a-f]{8}$/);

const legacyProject = new tmuxLayout.ProjectTmuxLayout().getLocator(readableIdentity);
const legacySession = new tmuxLayout.SessionTmuxLayout().getLocator(readableIdentity);
assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity(legacyProject, readableIdentity), true);
assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity(legacySession, readableIdentity), true);

const bounded = tmuxNaming.buildReadableTmuxLocator(readableIdentity, 'project', {
    projectName: '项目'.repeat(100), sessionName: '会话'.repeat(100),
});
assert.ok(Array.from(bounded.sessionName).length <= 96);
assert.ok(Array.from(bounded.windowName).length <= 96);
assert.match(bounded.sessionName, /-[0-9a-f]{8}$/);
assert.match(bounded.windowName, /-[0-9a-f]{8}$/);
```

- [ ] **Step 2: Run the tmux suite and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: compilation/module failure because `tmuxNaming.ts` and its exports do not exist.

- [ ] **Step 3: Implement the naming module**

Create the focused module with exact public contracts:

```ts
export interface TmuxReadableNames {
    projectName: string;
    sessionName: string;
}

export function normalizeTmuxReadableComponent(
    value: unknown,
    fallback: 'workspace' | 'session' | 'new-session'
): string;

export function legacyTmuxLocator(
    identity: AiSessionRuntimeIdentity,
    layout: AiSessionTmuxLayout
): AiSessionTmuxLocator;

export function buildReadableTmuxLocator(
    identity: AiSessionRuntimeIdentity,
    layout: AiSessionTmuxLayout,
    names: TmuxReadableNames
): AiSessionTmuxLocator;

export function tmuxLocatorMatchesIdentity(
    locator: AiSessionTmuxLocator,
    identity: AiSessionRuntimeIdentity
): boolean;
```

Use SHA-256 helpers that return the current 16-character legacy suffix and a new 8-character readable suffix. Normalize with `String(value || '').normalize('NFKC')`, preserve `\p{L}` and `\p{N}`, collapse all other runs to `-`, trim hyphens, and bound with `Array.from` so surrogate pairs are never split. Build names as:

```ts
const projectSession = boundedName(['ps', projectComponent], workspaceSuffix(identity));
const runtimeWindow = boundedName([
    identity.provider,
    sessionComponent,
], runtimeSuffix(identity));
const sessionRuntime = boundedName([
    'ps', projectComponent, sessionComponent,
], runtimeSuffix(identity));
```

`tmuxLocatorMatchesIdentity` accepts the exact legacy locator or readable/mixed project locators whose session suffix matches workspace identity and whose window suffix matches final/pending runtime identity. Session layout accepts exact legacy locator or readable session+window names with the runtime suffix. Reject extra/missing window names outside those two families.

Keep `ProjectTmuxLayout` and `SessionTmuxLayout` delegating their existing no-display-name calls to `legacyTmuxLocator`, preserving all existing callers until later tasks opt into readable names.

- [ ] **Step 4: Run the tmux suite and verify GREEN**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: `AI session tmux checks passed.`

- [ ] **Step 5: Commit Task 1**

```bash
git add src/aiSessions/tmuxNaming.ts src/aiSessions/tmuxLayout.ts scripts/run-ai-session-tmux-checks.js
git commit -m "feat: build readable tmux runtime names"
```

---

### Task 2: Carry creation-time display names through runtime requests

**Files:**
- Modify: `src/aiSessions/runtimeTypes.ts`
- Modify: `src/aiSessions/resumeController.ts`
- Modify: `src/aiSessions/creationController.ts`
- Modify: `src/aiSessions/directTerminalRuntimeBackend.ts`
- Modify: `src/aiSessions/pendingTerminalResolver.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-ai-session-tmux-checks.js`

**Interfaces:**
- Produces: `AiSessionResumeRuntimeRequest.sessionName`, `AiSessionPendingRuntimeSnapshot.projectName`, and `promotePending(identity, sessionId, sessionName)`.
- Consumes: prepared `CodexSession.name`, workspace/card display name, entered pending title, and provider-resolved session name.

- [ ] **Step 1: Write failing request and promotion-name tests**

In resume controller checks, capture the request and assert alias-aware display name is independent from identity:

```js
assert.strictEqual(resumeRequests[0].projectName, 'Workspace Card');
assert.strictEqual(resumeRequests[0].sessionName, 'Readable Session Alias');
assert.strictEqual(resumeRequests[0].identity.sessionId, 'session-id');
```

In creation checks assert pending context:

```js
assert.strictEqual(createRequests[0].projectName, 'Workspace Card');
assert.strictEqual(createRequests[0].title, 'Investigate replication');
```

In pending resolver checks capture the promotion call and assert the final display name uses the entered title when non-empty and provider session name otherwise:

```js
assert.deepStrictEqual(promotionCalls[0], {
    identity: expectedPendingIdentity,
    sessionId: 'resolved-session',
    sessionName: 'Investigate replication',
});
assert.strictEqual(fallbackPromotionCalls[0].sessionName, 'Provider generated title');
```

Assert Direct Terminal accepts the extra promotion argument without changing terminal/runtime behavior, and pending snapshots retain `projectName` when supplied.

- [ ] **Step 2: Run safety and tmux checks and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js && node scripts/run-ai-session-tmux-checks.js
```

Expected: request/promotion assertions fail because the new display fields are not propagated.

- [ ] **Step 3: Implement display-context contracts**

Extend the types:

```ts
export interface AiSessionResumeRuntimeRequest {
    identity: AiSessionRuntimeIdentity & { sessionId: string };
    projectName: string;
    sessionName: string;
    terminalName: string;
    launch: AiSessionLaunchSpec;
    directoryScope: AiSessionDirectoryScope;
}

export interface AiSessionPendingRuntimeSnapshot<TTerminal = unknown>
extends AiSessionRuntimeSnapshot<TTerminal> {
    state: 'pending';
    createdAt: string;
    excludedSessionIds: string[];
    projectName?: string;
    title?: string;
}
```

Change executable backend/coordinator promotion signatures consistently:

```ts
promotePending(
    identity: AiSessionRuntimeIdentity & { pendingId: string },
    sessionId: string,
    sessionName: string
): Promise<AiSessionRuntimeSnapshot<TTerminal>[]>;
```

Set `sessionName: session.name || session.id` in `AiSessionResumeController`. Preserve `projectName` in pending snapshots for Direct and tmux paths. In resolver settlement compute:

```ts
const finalDisplayName = pendingRuntime.title?.trim() || session.name || session.id;
runtimeCoordinator.promotePending(pendingIdentity, session.id, finalDisplayName);
```

Keep alias persistence after successful promotion exactly as today.

- [ ] **Step 4: Run safety and tmux checks and verify GREEN**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js && node scripts/run-ai-session-tmux-checks.js
```

Expected: both suites print their pass messages.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/aiSessions/runtimeTypes.ts src/aiSessions/resumeController.ts src/aiSessions/creationController.ts src/aiSessions/directTerminalRuntimeBackend.ts src/aiSessions/pendingTerminalResolver.ts scripts/run-ai-session-safety-checks.js scripts/run-ai-session-tmux-checks.js
git commit -m "refactor: carry tmux runtime display names"
```

---

### Task 3: Discover and persist legacy/readable actual locators

**Files:**
- Modify: `src/aiSessions/tmuxRuntimeDiscovery.ts`
- Modify: `src/aiSessions/tmuxRuntimeBindingStore.ts`
- Modify: `src/aiSessions/tmuxAttachBindingStore.ts`
- Modify: `src/aiSessions/tmuxRuntimeBackend.ts` target verification/binding helpers only
- Modify: `scripts/run-ai-session-tmux-checks.js`

**Interfaces:**
- Consumes: `tmuxLocatorMatchesIdentity` from Task 1 and optional session-layout `windowName`.
- Produces: discovery snapshots and all persistence/attach records retain the actual readable locator while accepting legacy session-layout locators without `windowName`.

- [ ] **Step 1: Write failing discovery and persistence compatibility tests**

Add discovery rows for:

```js
const readableProjectLocator = tmuxNaming.buildReadableTmuxLocator(projectIdentity, 'project', {
    projectName: 'RedDB', sessionName: 'Repair replication',
});
const readableSessionLocator = tmuxNaming.buildReadableTmuxLocator(sessionIdentity, 'session', {
    projectName: 'RedDB', sessionName: 'Repair replication',
});
```

Assert both appear active with exact actual locator names; existing legacy rows still appear; readable locators with wrong suffixes become collision diagnostics; two actual locators with one identity produce no live runtime and one conflict identity. Assert runtime-store validators and attach-store round trips accept session-layout `{ layout:'session', sessionName, windowName }` while retaining legacy `{ layout:'session', sessionName }`.

- [ ] **Step 2: Run tmux checks and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: readable locators are rejected against hash-only expected locators, and session-layout persistence drops/rejects `windowName`.

- [ ] **Step 3: Implement actual-locator discovery and compatibility**

After parsing row metadata/identity, construct actual locators as:

```ts
const actual: AiSessionTmuxLocator = parsed.layout === 'project'
    ? { layout: 'project', sessionName: row.sessionName, windowName: row.windowName }
    : row.windowName === 'ai-session'
        ? { layout: 'session', sessionName: row.sessionName }
        : { layout: 'session', sessionName: row.sessionName, windowName: row.windowName };
```

Replace exact `locatorsEqual(actual, expected)` ownership acceptance with `tmuxLocatorMatchesIdentity(actual, identity)`. Keep `expectedLocator` legacy-only for safe collision diagnostics. Preserve the existing multiple-actual-locators-by-identity collision check.

Update `validateLocator` and attach binding validation so session layout accepts either exact key set:

```ts
['layout', 'sessionName']
['layout', 'sessionName', 'windowName']
```

Clone/store `windowName` whenever present. In backend target verification, compare `target.windowName` when the runtime locator includes it; retain legacy session behavior when it does not. Update session-layout metadata reads/writes to use `locator.windowName || 'ai-session'`.

- [ ] **Step 4: Run tmux checks and verify GREEN**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: `AI session tmux checks passed.`

- [ ] **Step 5: Commit Task 3**

```bash
git add src/aiSessions/tmuxRuntimeDiscovery.ts src/aiSessions/tmuxRuntimeBindingStore.ts src/aiSessions/tmuxAttachBindingStore.ts src/aiSessions/tmuxRuntimeBackend.ts scripts/run-ai-session-tmux-checks.js
git commit -m "feat: discover readable tmux locators"
```

---

### Task 4: Create readable runtimes and reuse stable project containers

**Files:**
- Modify: `src/aiSessions/tmuxRuntimeBackend.ts`
- Modify: `src/aiSessions/tmuxRuntimeBindingStore.ts` pending `projectName` validation/persistence
- Modify: `scripts/run-ai-session-tmux-checks.js` backend harness and creation checks

**Interfaces:**
- Consumes: request display context, `buildReadableTmuxLocator`, session-level ownership metadata, actual-locator discovery.
- Produces: readable project/session-layout creation, project-container ownership resolution, and pending bindings carrying creation-time project name.

- [ ] **Step 1: Write failing creation and project-reuse tests**

For project layout, create/resume with `projectName: 'RedDB DTS Dual Active'` and `sessionName: 'Repair replication'`, then assert:

```js
assert.match(runtime.tmux.sessionName, /^ps-RedDB-DTS-Dual-Active-[0-9a-f]{8}$/);
assert.match(runtime.tmux.windowName, /^codex-Repair-replication-[0-9a-f]{8}$/);
```

Create another provider runtime for the same workspace with `projectName: 'Renamed Card'` and assert the first session name is reused while the new window uses its own session display name. Seed two session-metadata-compatible containers for one workspace and assert creation rejects with `AiSessionRuntimeConflictError` before provider dispatch.

For session layout assert both `new-session` and `configure-window` receive readable session/window names, and exact-target focus uses `sessionName:windowName`.

For pending creation assert entered title and empty-title fallback names, plus persisted `projectName`:

```js
assert.strictEqual(pending.projectName, 'RedDB DTS Dual Active');
assert.match(pending.tmux.windowName, /^codex-Investigate-lag-[0-9a-f]{8}$/);
```

- [ ] **Step 2: Run tmux checks and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: created locator names remain legacy hashes/generic window names and renamed-card creation selects a second preferred container.

- [ ] **Step 3: Implement readable creation and project resolver**

Snapshot/validate `request.sessionName` in resume requests. Build preferred locators with:

```ts
buildReadableTmuxLocator(request.identity, layout, {
    projectName: request.projectName,
    sessionName: request.sessionName,
});
```

For pending requests use `request.title?.trim() || 'new-session'`.

Before project-layout mutation, list windows and group exact session ownership bases matching:

```ts
recordsEqual(row.sessionMetadata, projectSessionMetadata(identity))
```

Deduplicate by `row.sessionName`. Return the sole existing name or the preferred readable name. If more than one exists, throw `AiSessionRuntimeConflictError` with one conflict snapshot per distinct container. Replace only the preferred locator's `sessionName`; retain its readable runtime window name.

Before creation, treat an existing runtime as reusable when discovery finds exactly one identity match whose actual locator passes `tmuxLocatorMatchesIdentity`; do not require its readable prefix to match the current request display names.

For session layout, use `locator.windowName || 'ai-session'` in `createSession` and `configureManagedWindow`. Persist optional `projectName` through pending and ambiguous binding records with the same 200-character/control-character bounds as title; legacy records without it remain valid.

- [ ] **Step 4: Run tmux checks and verify GREEN**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js
```

Expected: `AI session tmux checks passed.`

- [ ] **Step 5: Commit Task 4**

```bash
git add src/aiSessions/tmuxRuntimeBackend.ts src/aiSessions/tmuxRuntimeBindingStore.ts scripts/run-ai-session-tmux-checks.js
git commit -m "feat: create readable tmux runtimes"
```

---

### Task 5: Promote pending runtimes to final readable names atomically

**Files:**
- Modify: `src/aiSessions/runtimeCoordinator.ts`
- Modify: `src/aiSessions/tmuxRuntimeBackend.ts`
- Modify: `src/aiSessions/tmuxRuntimeBindingStore.ts`
- Modify: `src/aiSessions/pendingTerminalResolver.ts`
- Modify: `scripts/run-ai-session-tmux-checks.js`
- Modify: `scripts/run-workspace-parity-checks.js`

**Interfaces:**
- Consumes: `promotePending(identity, sessionId, sessionName)`, stored pending project name/source locator, and `buildReadableTmuxLocator`.
- Produces: one ambiguity-safe pending-to-final rename that keeps the project container stable and produces final readable window/session names.

- [ ] **Step 1: Write failing readable-promotion tests**

Project layout assertion:

```js
assert.strictEqual(promoted.tmux.sessionName, pending.tmux.sessionName,
    'project promotion must retain its creation-time project container');
assert.match(promoted.tmux.windowName, /^codex-Investigate-replication-[0-9a-f]{8}$/);
```

Session layout assertion:

```js
assert.match(promoted.tmux.sessionName,
    /^ps-RedDB-Investigate-replication-[0-9a-f]{8}$/);
assert.match(promoted.tmux.windowName,
    /^codex-Investigate-replication-[0-9a-f]{8}$/);
```

Assert project promotion renames one window; session promotion renames both the tmux session and its managed window; attach, known, consumed, and promoting bindings store the exact final locator. Re-run the existing ambiguous rename/metadata write/clear-pending failure matrices with readable locators and assert recovery never dispatches the provider command again.

Add workspace parity coverage proving the resolver passes `pending.title || resolvedSession.name || session.id` and later alias updates do not rename active locator snapshots.

- [ ] **Step 2: Run tmux and workspace parity checks and verify RED**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js && node scripts/run-workspace-parity-checks.js
```

Expected: promotion signatures/locators remain hash-only and session-layout window rename assertions fail.

- [ ] **Step 3: Implement readable promotion inside the existing transaction**

Compute the preferred final locator using stored pending context:

```ts
const preferredFinal = buildReadableTmuxLocator(finalIdentityValue, storedPending.layout, {
    projectName: storedPending.projectName || 'workspace',
    sessionName,
});
const finalLocator = storedPending.layout === 'project'
    ? { ...preferredFinal, sessionName: storedPending.locator.sessionName }
    : preferredFinal;
```

Include `sessionName` and final locator in the promotion request fingerprint/intent equality so replay with a different final display name fails closed. For project layout retain `rename-window`. For session layout rename the session first, then rename the source managed window to `finalLocator.windowName`, recording ambiguity before either mutation exactly as the existing transaction does. Recovery must accept the defined pre-rename, partially renamed, and fully renamed metadata/locator states and converge to one final binding.

Pass the third promotion argument through `AiSessionRuntimeCoordinator`; Direct backend ignores it after validating it as a bounded non-empty display string. Preserve alias storage after successful settlement.

- [ ] **Step 4: Run tmux and workspace parity checks and verify GREEN**

Run:

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js && node scripts/run-workspace-parity-checks.js
```

Expected: both suites print their pass messages.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/aiSessions/runtimeCoordinator.ts src/aiSessions/tmuxRuntimeBackend.ts src/aiSessions/tmuxRuntimeBindingStore.ts src/aiSessions/pendingTerminalResolver.ts scripts/run-ai-session-tmux-checks.js scripts/run-workspace-parity-checks.js
git commit -m "feat: promote tmux runtimes to readable names"
```

---

### Task 6: Verify, package, and install the readable-name build

**Files:**
- Create: `docs/superpowers/reports/2026-07-22-readable-tmux-runtime-names-verification.md`
- Package: `artifacts/project-steward-2.1.3.vsix`

**Interfaces:**
- Consumes: Tasks 1-5 and the repository's extension-install skill.
- Produces: verified code/test evidence and a main-extension-only Dev Container install.

- [ ] **Step 1: Run focused and full regression suites**

Run:

```bash
npm run test:workspace-parity
npm run test:safety
npm run test:dashboard
npm run test:tmux:smoke
npm run test:architecture-baseline
npm run test:release-packaging
```

Expected: every command exits 0 with its suite-specific pass message.

- [ ] **Step 2: Inspect visual/saved-project scope**

Run:

```bash
git diff 3e21b7f^..HEAD -- src/webview src/styles src/dashboard.ts src/projects src/workspaces
git diff --check
git status --short
```

Expected: no Dashboard markup/style/card changes and no saved-project/workspace persistence changes; only intentional AI-session runtime/controller integration appears.

- [ ] **Step 3: Verify real tmux naming**

Run the real tmux smoke harness with one project-layout and one session-layout runtime. Assert the native `list-sessions`/`list-windows` rows contain the readable project/session components and correct 8-character suffixes, then let the harness remove only its own temporary sessions.

- [ ] **Step 4: Package and inspect the main VSIX**

Follow `/home/hzcheng/projects/repos/vscode-dashboard/.codex/skills/installing-vscode-extensions-locally/SKILL.md`. Record the absolute main VSIX path, SHA-256, extension ID/version, and package contents. Do not install the UI bridge artifact produced by release packaging.

- [ ] **Step 5: Install only the main extension into the pinned Dev Container host**

Use:

```text
/home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server
```

Verify the post-install listing contains `hzcheng.project-steward@2.1.3` and the user-managed UI bridge version remains unchanged.

- [ ] **Step 6: Record and commit verification evidence**

Write the commands, pass messages, real tmux names, VSIX hash, and installed versions to the report, then run:

```bash
git add docs/superpowers/reports/2026-07-22-readable-tmux-runtime-names-verification.md
git commit -m "docs: verify readable tmux runtime names"
```
