# Batch AI Session Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select and archive multiple AI sessions for one open project and its active provider with one confirmation and a partial-result summary.

**Architecture:** The Webview owns transient management and selection state and sends one scoped batch request. A new pure TypeScript batch module validates selection, coordinates best-effort outcomes, and formats summaries; `dashboard.ts` supplies VS Code, terminal, provider, metadata-cleanup, confirmation, logging, and refresh dependencies while retaining each provider's existing singular `archiveSession()` API.

**Tech Stack:** TypeScript 4, VS Code Extension API, browser JavaScript Webview, SCSS/Gulp, Node.js `assert` safety checks, webpack 5

## Approved UI Adjustment (2026-07-13)

- Replace the text `Manage` control with a checklist/multi-select SVG icon.
- Match the adjacent `New Session` icon button's fixed dimensions and hover/focus treatment.
- Preserve the provider-specific tooltip and accessible label, and expose toggle state with `aria-pressed`.
- Clicking the active Manage button exits management mode and clears selection.
- Remove the batch action bar's separate `Cancel` button and its event hook.
- Extend the existing safety checks before changing implementation, regenerate both compiled Webview assets, and do not commit without the user's explicit approval.

## Global Constraints

- Operate on exactly one open project and its currently active Codex, Kimi, or Claude provider.
- Implement batch archive only; do not add permanent deletion or other bulk actions.
- The `All` button selects all unpinned sessions; pinned sessions remain individually selectable.
- Skip running sessions without closing or focusing their terminals; continue processing the remainder.
- Confirm once and include the eligible count and selected pinned count.
- Reject malformed, cross-project, and cross-provider session IDs.
- Clear pin, alias, marker, and terminal tracking only after a successful provider archive.
- Keep provider `archiveSession(sessionId: string): boolean` interfaces and storage behavior unchanged.
- Send one final incremental refresh; do not add per-item host refreshes or cache invalidations.
- Preserve existing single-session archive behavior.
- Do not modify or stage the user's `.vscode/settings.json`.
- Do not run any `git commit` command without explicit user approval after review of that task's diff.

---

## File Structure

- Create `src/aiSessions/archiveBatch.ts`: pure request normalization, scope resolution, best-effort coordination, result types, issue detection, and user-facing summary formatting.
- Modify `src/dashboard.ts`: Webview message routing, confirmation, VS Code/provider dependency wiring, shared per-session archive attempt, completion response, logging, and final refresh.
- Modify `src/aiSessions/types.ts`: typed `ai-session-batch-archive-completed` host-to-Webview message.
- Modify `src/webview/webviewContent.ts`: Manage button, per-row checkbox, and batch action bar markup.
- Modify `src/webview/webviewProjectScripts.js`: transient management state, selection actions, scoped request submission, completion handling, and incremental-refresh reconciliation.
- Modify `media/styles.scss`: management-mode, selection, pending, and batch action bar styling.
- Regenerate `media/styles.css` and `media/webviewProjectScripts.js` through Gulp.
- Modify `scripts/run-ai-session-safety-checks.js`: executable regression coverage for the pure coordinator and Webview behavior, plus wiring and generated-asset checks.

---

### Task 1: Pure Batch Selection and Outcome Coordinator

**Files:**

- Create: `src/aiSessions/archiveBatch.ts`
- Modify: `scripts/run-ai-session-safety-checks.js:1-30,180-250,900-930`

**Interfaces:**

- Consumes: `CodexSession` from `src/models.ts`.
- Produces: `resolveBatchAiSessionSelection(sessionIds, availableSessions)`, `archiveBatchAiSessions(selection, dependencies)`, `formatBatchAiSessionArchiveSummary(result)`, and `hasBatchAiSessionArchiveIssues(result)`.

- [ ] **Step 1: Write failing safety checks for normalization and mixed outcomes**

Add the compiled-module import near the existing `sessionHelpers` import:

```js
const archiveBatch = require('../out/aiSessions/archiveBatch');
```

Add this test function before `runWebviewContentChecks()`:

```js
function runBatchAiSessionArchiveChecks() {
    const availableSessions = [
        { id: 'pinned', name: 'Pinned', pinned: true },
        { id: 'plain', name: 'Plain' },
        { id: 'running', name: 'Running' },
        { id: 'failed', name: 'Failed' },
    ];
    const selection = archiveBatch.resolveBatchAiSessionSelection(
        ['plain', 'plain', '', 42, 'pinned', 'outside', 'running', 'failed'],
        availableSessions
    );

    assert.deepStrictEqual(selection.eligibleSessions.map(session => session.id), [
        'plain', 'pinned', 'running', 'failed',
    ]);
    assert.deepStrictEqual(selection.rejectedIds, ['outside']);
    assert.strictEqual(selection.malformedCount, 2);
    assert.strictEqual(selection.eligibleSessions.filter(session => session.pinned).length, 1);

    const result = archiveBatch.archiveBatchAiSessions(selection, {
        resolveCurrentSessions: () => availableSessions.filter(session => session.id !== 'pinned'),
        archiveSession: sessionId => sessionId === 'running'
            ? 'running'
            : sessionId === 'failed' ? 'failed' : 'archived',
    });

    assert.deepStrictEqual(result.archivedIds, ['plain']);
    assert.deepStrictEqual(result.runningIds, ['running']);
    assert.deepStrictEqual(result.missingIds, ['pinned']);
    assert.deepStrictEqual(result.failedIds, ['failed']);
    assert.deepStrictEqual(result.rejectedIds, ['outside']);
    assert.strictEqual(result.malformedCount, 2);
    assert.strictEqual(archiveBatch.hasBatchAiSessionArchiveIssues(result), true);
    assert.strictEqual(
        archiveBatch.formatBatchAiSessionArchiveSummary(result),
        'Archived 1 session; skipped 1 running session; 1 session was no longer available; rejected 3 invalid or out-of-scope selections; 1 session failed.'
    );

    const success = archiveBatch.archiveBatchAiSessions(
        archiveBatch.resolveBatchAiSessionSelection(['plain'], availableSessions),
        {
            resolveCurrentSessions: () => availableSessions,
            archiveSession: () => 'archived',
        }
    );
    assert.strictEqual(archiveBatch.hasBatchAiSessionArchiveIssues(success), false);
    assert.strictEqual(
        archiveBatch.formatBatchAiSessionArchiveSummary(success),
        'Archived 1 session.'
    );
}
```

Call `runBatchAiSessionArchiveChecks()` immediately after `runKeyChecks()`.

- [ ] **Step 2: Run the checks and verify RED**

Run:

```bash
npm run test:safety
```

Expected: TypeScript compilation succeeds for existing files, then Node fails with `Cannot find module '../out/aiSessions/archiveBatch'`.

- [ ] **Step 3: Implement the pure batch module**

Create `src/aiSessions/archiveBatch.ts` with these public types and functions:

```ts
'use strict';

import type { CodexSession } from '../models';

export type BatchAiSessionArchiveAttemptStatus = 'archived' | 'running' | 'failed';

export interface BatchAiSessionArchiveSelection {
    eligibleSessions: CodexSession[];
    rejectedIds: string[];
    malformedCount: number;
}

export interface BatchAiSessionArchiveDependencies {
    resolveCurrentSessions: () => readonly CodexSession[];
    archiveSession: (sessionId: string) => BatchAiSessionArchiveAttemptStatus;
}

export interface BatchAiSessionArchiveResult {
    archivedIds: string[];
    runningIds: string[];
    missingIds: string[];
    rejectedIds: string[];
    failedIds: string[];
    malformedCount: number;
}

export function resolveBatchAiSessionSelection(
    sessionIds: unknown,
    availableSessions: readonly CodexSession[]
): BatchAiSessionArchiveSelection {
    let values = Array.isArray(sessionIds) ? sessionIds : [];
    let malformedCount = Array.isArray(sessionIds) ? 0 : 1;
    let requestedIds: string[] = [];
    let seen = new Set<string>();

    for (let value of values) {
        if (typeof value !== 'string' || !value.trim()) {
            malformedCount++;
            continue;
        }

        let sessionId = value.trim();
        if (!seen.has(sessionId)) {
            seen.add(sessionId);
            requestedIds.push(sessionId);
        }
    }

    let sessionsById = new Map((availableSessions || []).map(session => [session.id, session]));
    return {
        eligibleSessions: requestedIds.map(sessionId => sessionsById.get(sessionId)).filter(session => !!session),
        rejectedIds: requestedIds.filter(sessionId => !sessionsById.has(sessionId)),
        malformedCount,
    };
}

export function archiveBatchAiSessions(
    selection: BatchAiSessionArchiveSelection,
    dependencies: BatchAiSessionArchiveDependencies
): BatchAiSessionArchiveResult {
    let currentSessions = new Map(dependencies.resolveCurrentSessions().map(session => [session.id, session]));
    let result: BatchAiSessionArchiveResult = {
        archivedIds: [],
        runningIds: [],
        missingIds: [],
        rejectedIds: [...selection.rejectedIds],
        failedIds: [],
        malformedCount: selection.malformedCount,
    };

    for (let session of selection.eligibleSessions) {
        if (!currentSessions.has(session.id)) {
            result.missingIds.push(session.id);
            continue;
        }

        let status = dependencies.archiveSession(session.id);
        if (status === 'archived') {
            result.archivedIds.push(session.id);
        } else if (status === 'running') {
            result.runningIds.push(session.id);
        } else {
            result.failedIds.push(session.id);
        }
    }

    return result;
}

export function hasBatchAiSessionArchiveIssues(result: BatchAiSessionArchiveResult): boolean {
    return Boolean(
        result.runningIds.length
        || result.missingIds.length
        || result.rejectedIds.length
        || result.failedIds.length
        || result.malformedCount
    );
}

export function formatBatchAiSessionArchiveSummary(result: BatchAiSessionArchiveResult): string {
    let parts = [formatCount('Archived', result.archivedIds.length, 'session')];
    if (result.runningIds.length) {
        parts.push(formatCount('skipped', result.runningIds.length, 'running session'));
    }
    if (result.missingIds.length) {
        parts.push(formatCount('', result.missingIds.length, 'session', 'was', 'were') + ' no longer available');
    }
    let rejectedCount = result.rejectedIds.length + result.malformedCount;
    if (rejectedCount) {
        parts.push(formatCount('rejected', rejectedCount, 'invalid or out-of-scope selection'));
    }
    if (result.failedIds.length) {
        parts.push(formatCount('', result.failedIds.length, 'session') + ' failed');
    }
    return parts.join('; ') + '.';
}

function formatCount(
    prefix: string,
    count: number,
    noun: string,
    singularVerb: string = '',
    pluralVerb: string = ''
): string {
    let words = [prefix, String(count), `${noun}${count === 1 ? '' : 's'}`].filter(value => !!value);
    let verb = count === 1 ? singularVerb : pluralVerb;
    return [...words, verb].filter(value => !!value).join(' ');
}
```

- [ ] **Step 4: Run the focused checks and verify GREEN**

Run `npm run test:safety`.

Expected: exit 0 and output ending with `AI session safety checks passed.`

- [ ] **Step 5: Review checkpoint and optional commit**

Run `git diff --check` and `git diff -- src/aiSessions/archiveBatch.ts scripts/run-ai-session-safety-checks.js`. Present the diff to the user. Only after explicit approval, run:

```bash
git add src/aiSessions/archiveBatch.ts scripts/run-ai-session-safety-checks.js
git commit -m "test: define batch AI session archive outcomes"
```

---

### Task 2: Extension-Host Batch Archive Orchestration

**Files:**

- Modify: `src/aiSessions/types.ts:78-89`
- Modify: `src/dashboard.ts:1-30,54-60,480-620,990-1030`
- Modify: `scripts/run-ai-session-safety-checks.js:280-430`

**Interfaces:**

- Consumes: all exports from `src/aiSessions/archiveBatch.ts`, existing `getProjectAiSessions()`, `getRegisteredAiSessionProvider()`, `AiSessionTerminalService`, `AiSessionPinStore`, and alias helpers.
- Produces: `archive-ai-sessions` request handling, `archiveAiSessions(projectId, providerId, sessionIds)`, shared `archiveAiSessionItem(providerId, sessionId)`, and `AiSessionBatchArchiveCompletedMessage`.

- [ ] **Step 1: Add failing host-wiring regression checks**

In `runWebviewContentChecks()`, add assertions that extract `archiveAiSession`, `archiveAiSessions`, and `archiveAiSessionItem` and verify:

```js
const singleArchiveFunction = extractFunctionBody(dashboard, 'archiveAiSession');
const batchArchiveFunction = extractFunctionBody(dashboard, 'archiveAiSessions');
const archiveItemFunction = extractFunctionBody(dashboard, 'archiveAiSessionItem');

assert.ok(dashboard.includes("case 'archive-ai-sessions':"));
assert.ok(dashboard.includes('AiSessionBatchArchiveCompletedMessage'));
assert.ok(singleArchiveFunction.includes('archiveAiSessionItem(providerId, sessionId)'));
assert.ok(batchArchiveFunction.includes('resolveBatchAiSessionSelection('));
assert.ok(batchArchiveFunction.includes('archiveBatchAiSessions('));
assert.ok(batchArchiveFunction.includes("status: 'cancelled'"));
assert.ok(batchArchiveFunction.includes("status: 'rejected'"));
assert.ok(batchArchiveFunction.includes("status: 'finished'"));
assert.ok(batchArchiveFunction.includes('refreshAiSessionViewsIncrementally()'));
assert.ok(!archiveItemFunction.includes('refreshAiSessionViewsIncrementally()'));
assert.ok(!archiveItemFunction.includes('invalidateAiSessionCache('));
assert.ok(archiveItemFunction.includes('deletePinnedAiSession(providerId, sessionId)'));
assert.ok(archiveItemFunction.includes('deleteAiSessionAlias(providerId, sessionId)'));
```

- [ ] **Step 2: Run `npm run test:safety` and verify RED**

Expected: failure because `archiveAiSessions` and `archiveAiSessionItem` do not exist.

- [ ] **Step 3: Add the typed completion message**

Append to `src/aiSessions/types.ts`:

```ts
import type { BatchAiSessionArchiveResult } from './archiveBatch';

export interface AiSessionBatchArchiveCompletedMessage {
    type: 'ai-session-batch-archive-completed';
    projectId: string;
    provider: AiSessionProviderId;
    status: 'cancelled' | 'rejected' | 'finished';
    result?: BatchAiSessionArchiveResult;
}
```

- [ ] **Step 4: Route and validate the new request in `dashboard.ts`**

Import the archive-batch functions and completion type. Add this switch branch before singular archive message cases:

```ts
case 'archive-ai-sessions':
    await archiveAiSessions(
        e.projectId as string,
        e.provider as AiSessionProviderId,
        e.sessionIds
    );
    break;
```

Implement `postBatchArchiveCompletion(message)` as:

```ts
function postBatchArchiveCompletion(message: AiSessionBatchArchiveCompletedMessage) {
    provider.postMessage(message).then(undefined, error => {
        logError('Failed to post batch AI session archive completion.', error);
    });
}
```

- [ ] **Step 5: Extract one shared mutation attempt**

Implement this helper and use it from the existing singular archive path after its existing modal confirmation:

```ts
function archiveAiSessionItem(
    providerId: AiSessionProviderId,
    sessionId: string
): BatchAiSessionArchiveAttemptStatus {
    let sessionProvider = getRegisteredAiSessionProvider(providerId);
    let existingTerminal = aiSessionTerminalService.getById(providerId, sessionId);
    if (existingTerminal && !aiSessionTerminalService.isComplete(existingTerminal)) {
        return 'running';
    }

    if (!sessionProvider.service.archiveSession(sessionId)) {
        return 'failed';
    }

    if (existingTerminal) {
        aiSessionTerminalService.deleteEntryMarker(existingTerminal);
    }
    aiSessionTerminalService.untrack(providerId, sessionId);
    deletePinnedAiSession(providerId, sessionId);
    deleteAiSessionAlias(providerId, sessionId);
    return 'archived';
}
```

For singular archive, preserve the pre-confirm running-terminal warning/focus. After confirmation, map a race-time `running` result back to the same warning/focus, map `failed` to the existing error, and only refresh after `archived`.

- [ ] **Step 6: Implement the batch coordinator wiring**

Implement `archiveAiSessions()` with this exact control flow:

```ts
async function archiveAiSessions(projectId: string, providerId: AiSessionProviderId, sessionIds: unknown) {
    let project = isAiSessionProviderId(providerId)
        ? getOpenProjects().find(candidate => candidate.id === projectId)
        : null;
    if (!project || project.activeAiSessionProvider !== providerId) {
        postBatchArchiveCompletion({
            type: 'ai-session-batch-archive-completed', projectId, provider: providerId,
            status: 'rejected',
        });
        vscode.window.showWarningMessage('The selected AI sessions are no longer in the active project and provider.');
        return;
    }

    let selection = resolveBatchAiSessionSelection(sessionIds, getProjectAiSessions(project, providerId));
    if (!selection.eligibleSessions.length) {
        logRejectedBatchAiSessionSelections(providerId, selection.rejectedIds, selection.malformedCount);
        postBatchArchiveCompletion({
            type: 'ai-session-batch-archive-completed', projectId, provider: providerId,
            status: 'rejected',
        });
        vscode.window.showWarningMessage('No eligible AI sessions were selected.');
        return;
    }

    let providerLabel = getAiSessionProviderLabel(providerId);
    let pinnedCount = selection.eligibleSessions.filter(session => session.pinned).length;
    let pinnedText = pinnedCount ? ` ${pinnedCount} selected ${pinnedCount === 1 ? 'session is' : 'sessions are'} pinned.` : '';
    let accepted = await vscode.window.showWarningMessage(
        `Archive ${selection.eligibleSessions.length} selected ${providerLabel} ${selection.eligibleSessions.length === 1 ? 'session' : 'sessions'}?${pinnedText}`,
        { modal: true },
        'Archive'
    );
    if (!accepted) {
        postBatchArchiveCompletion({
            type: 'ai-session-batch-archive-completed', projectId, provider: providerId,
            status: 'cancelled',
        });
        return;
    }

    let result = archiveBatchAiSessions(selection, {
        resolveCurrentSessions: () => {
            let currentProject = getOpenProjects().find(candidate => candidate.id === projectId);
            return currentProject && currentProject.activeAiSessionProvider === providerId
                ? getProjectAiSessions(currentProject, providerId)
                : [];
        },
        archiveSession: sessionId => archiveAiSessionItem(providerId, sessionId),
    });

    logBatchAiSessionArchiveResult(providerId, result);
    let summary = formatBatchAiSessionArchiveSummary(result);
    if (hasBatchAiSessionArchiveIssues(result)) {
        vscode.window.showWarningMessage(summary);
    } else {
        vscode.window.showInformationMessage(summary);
    }
    postBatchArchiveCompletion({
        type: 'ai-session-batch-archive-completed', projectId, provider: providerId,
        status: 'finished', result,
    });
    refreshAiSessionViewsIncrementally();
}
```

Add these logging helpers so unknown malformed values are counted without being
serialized:

```ts
function logRejectedBatchAiSessionSelections(
    providerId: AiSessionProviderId,
    rejectedIds: string[],
    malformedCount: number
) {
    let label = getAiSessionProviderLabel(providerId);
    for (let sessionId of rejectedIds) {
        outputChannel.appendLine(`[Batch Archive] ${label} rejected out-of-scope session: ${sessionId}`);
    }
    if (malformedCount) {
        outputChannel.appendLine(`[Batch Archive] ${label} rejected ${malformedCount} malformed selection(s).`);
    }
}

function logBatchAiSessionArchiveResult(
    providerId: AiSessionProviderId,
    result: BatchAiSessionArchiveResult
) {
    let label = getAiSessionProviderLabel(providerId);
    logRejectedBatchAiSessionSelections(providerId, result.rejectedIds, result.malformedCount);
    for (let sessionId of result.runningIds) {
        outputChannel.appendLine(`[Batch Archive] ${label} skipped running session: ${sessionId}`);
    }
    for (let sessionId of result.missingIds) {
        outputChannel.appendLine(`[Batch Archive] ${label} session no longer available: ${sessionId}`);
    }
    for (let sessionId of result.failedIds) {
        outputChannel.appendLine(`[Batch Archive] ${label} archive failed: ${sessionId}`);
    }
}
```

- [ ] **Step 7: Run focused verification**

Run `npm run test:safety`.

Expected: exit 0 with `AI session safety checks passed.`

- [ ] **Step 8: Review checkpoint and optional commit**

Run `git diff --check` and present the Task 2 diff. Only after explicit user approval:

```bash
git add src/aiSessions/types.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js
git commit -m "feat: coordinate batch AI session archives"
```

---

### Task 3: Batch Management Markup and Styling

**Files:**

- Modify: `src/webview/webviewContent.ts:400-515`
- Modify: `src/webview/webviewIcons.ts`
- Modify: `media/styles.scss:1100-1410`
- Regenerate: `media/styles.css`
- Modify: `scripts/run-ai-session-safety-checks.js:280-430`

**Interfaces:**

- Consumes: existing `Project`, active provider, session `pinned` state, and Webview icon/button patterns.
- Produces: an icon-only `manage-ai-sessions` toggle plus stable `data-action`
  hooks for Task 4: `select-unpinned-ai-sessions`,
  `clear-ai-session-selection`, and `archive-selected-ai-sessions`.

- [ ] **Step 1: Add failing markup and style assertions**

Add assertions in `runWebviewContentChecks()` for:

```js
assert.ok(webviewContent.includes('data-action="manage-ai-sessions"'));
assert.ok(webviewContent.includes('class="ai-session-batch-checkbox"'));
assert.ok(webviewContent.includes('data-action="select-unpinned-ai-sessions"'));
assert.ok(webviewContent.includes('data-action="clear-ai-session-selection"'));
assert.ok(!webviewContent.includes('data-action="cancel-ai-session-management"'));
assert.ok(webviewContent.includes('data-action="archive-selected-ai-sessions"'));
assert.ok(styles.includes('[data-ai-session-managing]'));
assert.ok(styles.includes('.ai-session-batch-actions'));
assert.ok(compiledStyles.includes('.ai-session-batch-actions'));
```

- [ ] **Step 2: Run `npm run test:safety` and verify RED**

Expected: failure at the first missing batch markup assertion.

- [ ] **Step 3: Render management controls**

In `getAiSessionsDiv(project)`, render a Manage button beside the create button:

```ts
function getManageAiSessionsButton(activeProvider: AiSessionProviderId): string {
    var label = `Manage ${getAiProviderLabel(activeProvider)} Sessions`;
    return `<button type="button" class="ai-session-manage-button" data-action="manage-ai-sessions" data-provider="${activeProvider}" title="${label}" aria-label="${label}" aria-pressed="false">${Icons.manage}</button>`;
}
```

Append a batch action bar after `.codex-sessions-list`:

```html
<div class="ai-session-batch-actions" aria-live="polite">
    <div class="ai-session-batch-selection-actions">
        <button type="button" data-action="select-unpinned-ai-sessions">All</button>
        <button type="button" data-action="clear-ai-session-selection">Clear</button>
    </div>
    <span class="ai-session-batch-count">0 selected</span>
    <div class="ai-session-batch-submit-actions">
        <button type="button" class="ai-session-batch-archive" data-action="archive-selected-ai-sessions" disabled>Archive</button>
    </div>
</div>
```

Add this checkbox as the first element of every session row, preserving the existing icon, text, and action markup:

```ts
var batchCheckbox = `<input type="checkbox" class="ai-session-batch-checkbox" aria-label="Select ${sessionName}" tabindex="-1">`;
```

- [ ] **Step 4: Add scoped SCSS**

Extend provider controls to three columns (`minmax(0, 1fr) 24px 24px`), style
`.ai-session-manage-button` as the same fixed-size icon button as New Session,
including an active state, hide checkboxes and the batch bar by default, and
reveal them only under `.project[data-ai-session-managing]`. In management mode:

```scss
&[data-ai-session-managing] {
    .codex-session-row {
        grid-template-columns: 18px 28px minmax(0, 1fr);
        padding-right: 8px;
    }

    .ai-session-batch-checkbox,
    .ai-session-batch-actions {
        display: flex;
    }

    .codex-session-actions {
        display: none;
    }
}

&[data-ai-session-pending] .ai-session-batch-actions {
    opacity: .65;
    pointer-events: none;
}
```

Use VS Code theme variables for borders, hover states, warning-colored Archive styling, and selected-row background. Do not introduce fixed light-theme text colors.

- [ ] **Step 5: Regenerate CSS and verify GREEN**

Run:

```bash
npx gulp buildStyles
npm run test:safety
```

Expected: Gulp exits 0; safety checks end with `AI session safety checks passed.`

- [ ] **Step 6: Review checkpoint and optional commit**

Present the markup, SCSS, and generated CSS diff. Only after explicit approval:

```bash
git add src/webview/webviewContent.ts media/styles.scss media/styles.css scripts/run-ai-session-safety-checks.js
git commit -m "feat: render AI session batch management"
```

---

### Task 4: Webview Selection State and Request Lifecycle

**Files:**

- Modify: `src/webview/webviewProjectScripts.js:1-220,430-720`
- Regenerate: `media/webviewProjectScripts.js`
- Modify: `scripts/run-ai-session-safety-checks.js:430-640`

**Interfaces:**

- Consumes: Task 3 `data-action` hooks and Task 2 `ai-session-batch-archive-completed` messages.
- Produces: one transient `{ projectId, provider, selectedIds, pending }` state, one `archive-ai-sessions` request, and deterministic selection reconciliation after `ai-sessions-updated` DOM replacement.

- [ ] **Step 1: Add a focused Webview VM test that fails**

Create `runBatchAiSessionWebviewChecks()` beside `runFavoriteDndChecks()`. Load `src/webview/webviewProjectScripts.js` into the existing `vm` pattern with fake project/session elements and a `window.vscode.postMessage` collector. Exercise exported test hooks placed on `window.__projectStewardBatchAiSessions` and assert:

```js
manager.enter('project-a', 'codex');
manager.toggle('plain', false);
manager.selectUnpinned([
    { id: 'plain', pinned: false },
    { id: 'pinned', pinned: true },
    { id: 'second', pinned: false },
]);
assert.deepStrictEqual(manager.snapshot(), {
    projectId: 'project-a', provider: 'codex', selectedIds: ['plain', 'second'], pending: false,
});

manager.toggle('pinned', true);
manager.reconcile('project-a', 'codex', ['pinned', 'second']);
assert.deepStrictEqual(manager.snapshot().selectedIds, ['pinned', 'second']);

manager.submit();
assert.deepStrictEqual(messages.pop(), {
    type: 'archive-ai-sessions', projectId: 'project-a', provider: 'codex',
    sessionIds: ['pinned', 'second'],
});
assert.strictEqual(manager.snapshot().pending, true);

manager.complete('cancelled');
assert.strictEqual(manager.snapshot().pending, false);
assert.deepStrictEqual(manager.snapshot().selectedIds, ['pinned', 'second']);
manager.complete('finished');
assert.strictEqual(manager.snapshot().projectId, null);
```

Also assert through source inspection that provider changes and project collapse call `exitAiSessionBatchManagement()` before posting their existing messages.

- [ ] **Step 2: Run `npm run test:safety` and verify RED**

Expected: failure because `window.__projectStewardBatchAiSessions` is undefined.

- [ ] **Step 3: Implement the pure transient state controller inside `initProjects()`**

Add a controller backed by:

```js
var batchAiSessionState = {
    projectId: null,
    provider: null,
    selectedIds: new Set(),
    pending: false,
};
```

Implement the controller with the following behavior and expose it so the safety
harness tests the same state machine used by DOM handlers:

```js
function enter(projectId, provider) {
    batchAiSessionState.projectId = projectId;
    batchAiSessionState.provider = provider;
    batchAiSessionState.selectedIds = new Set();
    batchAiSessionState.pending = false;
}

function toggle(sessionId) {
    if (!sessionId || batchAiSessionState.pending)
        return;
    if (batchAiSessionState.selectedIds.has(sessionId))
        batchAiSessionState.selectedIds.delete(sessionId);
    else
        batchAiSessionState.selectedIds.add(sessionId);
}

function selectUnpinned(sessions) {
    if (batchAiSessionState.pending)
        return;
    sessions.filter(session => !session.pinned).forEach(session =>
        batchAiSessionState.selectedIds.add(session.id)
    );
}

function clear() {
    if (!batchAiSessionState.pending)
        batchAiSessionState.selectedIds.clear();
}

function reconcile(projectId, provider, remainingIds) {
    if (projectId !== batchAiSessionState.projectId || provider !== batchAiSessionState.provider) {
        exit();
        return;
    }
    let selectedIds = batchAiSessionState.selectedIds;
    batchAiSessionState.selectedIds = new Set(
        remainingIds.filter(sessionId => selectedIds.has(sessionId))
    );
}

function submit() {
    if (batchAiSessionState.pending || !batchAiSessionState.selectedIds.size)
        return;
    batchAiSessionState.pending = true;
    window.vscode.postMessage({
        type: 'archive-ai-sessions',
        projectId: batchAiSessionState.projectId,
        provider: batchAiSessionState.provider,
        sessionIds: Array.from(batchAiSessionState.selectedIds),
    });
}

function complete(status) {
    if (status === 'finished') {
        exit();
        return;
    }
    batchAiSessionState.pending = false;
}

function exit() {
    batchAiSessionState.projectId = null;
    batchAiSessionState.provider = null;
    batchAiSessionState.selectedIds = new Set();
    batchAiSessionState.pending = false;
}

function snapshot() {
    return {
        projectId: batchAiSessionState.projectId,
        provider: batchAiSessionState.provider,
        selectedIds: Array.from(batchAiSessionState.selectedIds),
        pending: batchAiSessionState.pending,
    };
}

var batchAiSessionManager = {
    enter, toggle, selectUnpinned, clear, reconcile, submit, complete, exit, snapshot,
};
window.__projectStewardBatchAiSessions = batchAiSessionManager;
```

- [ ] **Step 4: Wire DOM actions and scoped behavior**

In `onTriggerAiSessionAction()`:

- handle the Manage toggle and all three batch-bar actions before pin/archive
  actions; clicking Manage for the active scope exits management mode;
- when the clicked row belongs to the active management scope, toggle its ID and return without sending a resume message;
- call `syncAiSessionBatchManagementDom(projectDiv)` after every state mutation;
- build `selectUnpinned` input from current `.codex-session-row` elements and their `data-session-pinned` attribute;
- set `data-ai-session-managing` and `data-ai-session-pending` only on the scoped project;
- update checkboxes, selected-row attributes, count copy, and Archive disabled state from the controller snapshot.

Call `exitAiSessionBatchManagement()` before changing Provider and before collapsing the managed project. Pressing Escape exits management mode only when no request is pending; otherwise it leaves the disabled in-flight state intact.

- [ ] **Step 5: Handle host completion and incremental refresh**

Update `onWindowMessage()` so completion messages are processed before the existing `ai-sessions-updated` guard:

```js
if (message && message.type === 'ai-session-batch-archive-completed') {
    if (message.projectId === batchAiSessionState.projectId
        && message.provider === batchAiSessionState.provider) {
        batchAiSessionManager.complete(message.status);
        syncAiSessionBatchManagementDom(findOpenProjectDiv(message.projectId));
    }
    return;
}
```

After replacing `sessionSection.outerHTML` in `updateOpenProjectAiSessions()`, collect the active provider and remaining row IDs, call `reconcile()` for a matching scope, and sync the DOM. If the project disappears or the provider changes, exit management mode.

- [ ] **Step 6: Copy the Webview asset and verify GREEN**

Run:

```bash
npx gulp copyWebviewAssets
npm run test:safety
```

Expected: the generated `media/webviewProjectScripts.js` exactly matches the source, and all safety checks pass.

- [ ] **Step 7: Review checkpoint and optional commit**

Present source, generated asset, and test diffs. Only after explicit approval:

```bash
git add src/webview/webviewProjectScripts.js media/webviewProjectScripts.js scripts/run-ai-session-safety-checks.js
git commit -m "feat: add AI session batch selection behavior"
```

---

### Task 5: Full Verification and Manual VS Code Smoke Test

**Files:**

- Modify only if verification exposes a defect: files already listed in Tasks 1-4.
- Review: `docs/superpowers/specs/2026-07-13-batch-ai-session-archive-design.md`
- Review: `docs/superpowers/plans/2026-07-13-batch-ai-session-archive.md`

**Interfaces:**

- Consumes: completed host coordinator, rendered controls, Webview state lifecycle, and generated assets.
- Produces: verification evidence and a user-reviewed final diff; no commit without separate approval.

- [ ] **Step 1: Run repository verification independently**

```bash
npm run test:safety
npm run lint
npx gulp buildStyles copyWebviewAssets
npm run webpack
git diff --check
```

Expected:

- `test:safety` exits 0 and prints `AI session safety checks passed.`;
- lint exits 0, allowing only the repository's existing legacy warnings;
- Gulp exits 0 and generated assets match their sources;
- webpack compiles successfully;
- `git diff --check` produces no output.

- [ ] **Step 2: Confirm the complete diff scope**

Run:

```bash
git status --short
git diff --stat
git diff -- . ':(exclude).vscode/settings.json' ':(exclude).superpowers/**'
```

Expected: only the design, plan, Task 1-4 source/test/generated-asset changes are in feature scope. `.vscode/settings.json` remains unstaged and unchanged by this work. `.superpowers/` remains excluded from feature review or is removed separately only with user approval.

- [ ] **Step 3: Run the VS Code Extension Development Host smoke test**

Use the existing extension launch configuration and verify this sequence for Codex, Kimi, and Claude where local history exists:

1. Expand an Open Project and click Manage for the active provider.
2. Confirm normal row clicks select rather than resume.
3. Confirm `All` skips pinned rows and manual pinned selection works.
4. Cancel the modal and confirm selection remains usable.
5. Select a mix containing a running session and archive once.
6. Confirm the running session remains, successful sessions disappear, and one summary is shown.
7. Switch provider and collapse the project; confirm selection does not leak.
8. Confirm ordinary single-session archive still warns and focuses a running terminal.

- [ ] **Step 4: Present final evidence and request commit authorization**

Report command exit codes, safety-check result, any lint warnings, smoke-test observations, and the exact files intended for commit. Do not commit until the user explicitly approves the final diff and commit scope.

- [ ] **Step 5: Commit only after explicit approval**

After approval, stage only the reviewed feature files and re-run `git diff --cached --check` plus `git diff --cached --name-status`. Then commit with the user-approved message, for example:

```bash
git commit -m "feat: add batch AI session archive"
```
