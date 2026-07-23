# Workspace Parity Attention and Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Restore completed-Session attention and pending-to-Session promotion for single-folder and multi-root workspaces, with production-wiring and lifecycle regressions that prevent another workspace cutover from silently removing existing behavior.

**Architecture:** Add a root-aware attention index to workspace Session hydration, make the attention aggregate revision invalidate the open-workspace projection, and invoke the existing pending resolver through a focused workspace-native promotion controller. Keep hydration synchronous while queuing promotion as a non-blocking side effect; retain the existing aggregate and acknowledgement protocol without restoring the removed Project hydration layer.

**Tech Stack:** TypeScript, Node.js assert safety scripts, VS Code extension APIs, existing attention/open-workspace bridge protocols, npm/webpack/gulp VSIX packaging.

## Global Constraints

- CURRENT WORKSPACE, OTHER WINDOWS, and PROJECTS card markup and styles must not change.
- UI Bridge remains at package/protocol version 0.1.3; no command or payload field is added.
- One VS Code window remains one workspace card, including multi-root workspaces.
- Only clicking the corresponding AI Session row acknowledges attention; workspace navigation, refresh, tab selection, and collapse never acknowledge.
- Do not restore the removed Project hydration controller or compatibility readers for Project-era transient preferences.
- Install only the main extension into the Dev Container; do not install or overwrite UI Bridge.

---

## File Map

- Create: src/workspaces/sessionAttention.ts — root-aware logical Session attention index.
- Create: src/workspaces/pendingSessionPromotionController.ts — serialized workspace pending promotion.
- Modify: src/aiSessions/attentionController.ts — share logical run-key normalization with rendering.
- Modify: src/workspaces/sessionHydration.ts — decorate history/active view models.
- Modify: src/workspaces/sessionHydrationController.ts — pass attention and notify promotion after provider reads.
- Modify: src/openWorkspaces/dashboardController.ts — attention-aware semantic revision.
- Modify: src/dashboard.ts — production wiring for all three recovered connections.
- Modify: scripts/run-ai-session-safety-checks.js — focused attention and promotion tests.
- Modify: scripts/run-open-project-safety-checks.js — attention-only OTHER WINDOWS test.
- Modify: scripts/run-dashboard-webview-checks.js — refresh production-wiring gate.
- Create: scripts/run-workspace-parity-checks.js — three-shape lifecycle and architecture suite.
- Modify: package.json — register and include the parity suite.
- Create: docs/superpowers/reports/2026-07-22-workspace-parity-verification.md — final evidence.

---

### Task 1: Restore root-aware attention projection

**Files:**
- Create: src/workspaces/sessionAttention.ts
- Modify: src/aiSessions/attentionController.ts:getLogicalSessionKey
- Modify: src/workspaces/sessionHydration.ts:HydrateWorkspaceAiSessionsInput and hydrateWorkspaceAiSessions
- Modify: src/workspaces/sessionHydrationController.ts:WorkspaceSessionHydrationControllerOptions and hydrate
- Modify: src/dashboard.ts:workspaceSessionHydrationController construction
- Test: scripts/run-ai-session-safety-checks.js:runWorkspaceSessionHydrationChecks

**Interfaces:**
- Consumes: AttentionAggregate, getAttentionProjectKey(root.uri), and getAiSessionKey(providerId, sessionId).
- Produces: getLogicalAttentionSessionKey(sessionKey: string): string.
- Produces: buildWorkspaceSessionAttentionIndex(aggregate: AttentionAggregate | null): WorkspaceSessionAttentionIndex.
- Produces: getWorkspaceSessionAttention(index, rootUri, providerId, sessionId): AiSessionViewModel['attention'] | undefined.
- Produces: WorkspaceSessionHydrationControllerOptions.getAttentionAggregate(): AttentionAggregate | null.

- [ ] **Step 1: Add failing hydration assertions**

In runWorkspaceSessionHydrationChecks, add an aggregate containing a logical API
event, two run-scoped Web events, and a same-ID event assigned to the wrong
root:

~~~js
const workspaceAttention = {
    protocolVersion: 1,
    aggregateRevision: 'a'.repeat(64),
    generatedAtMs: 200,
    sessions: [{
        projectId: attentionProject.getAttentionProjectKey('file:///work/app/api'),
        sessionKey: 'codex:api-history',
        eventIds: ['event-api'], reasons: ['completed'], observedAtMs: 100,
    }, {
        projectId: attentionProject.getAttentionProjectKey('file:///work/web'),
        sessionKey: 'codex:web-history:30:tmux',
        eventIds: ['event-web-old'], reasons: ['completed'], observedAtMs: 110,
    }, {
        projectId: attentionProject.getAttentionProjectKey('file:///work/web'),
        sessionKey: 'codex:web-history:40:tmux',
        eventIds: ['event-web-new'], reasons: ['input-required'], observedAtMs: 120,
    }, {
        projectId: attentionProject.getAttentionProjectKey('file:///work/app'),
        sessionKey: 'codex:web-history',
        eventIds: ['event-wrong-root'], reasons: ['failed'], observedAtMs: 130,
    }],
};
~~~

Pass getAttentionAggregate: () => workspaceAttention to the controller fixture,
then assert:

~~~js
assert.deepStrictEqual(result.sessionsByProvider.codex[0].attention, {
    eventId: 'event-api', reason: 'completed', unread: true,
});
assert.deepStrictEqual(result.sessionsByProvider.codex[1].attention, {
    eventId: 'event-web-new', reason: 'input-required', unread: true,
});
const activeWeb = result.activeSessions.find(value => value.sessionId === 'web-history');
assert.strictEqual(activeWeb.needsAttention, true);
assert.strictEqual(activeWeb.status, 'needsAttention');
assert.strictEqual(activeWeb.attentionEventId, 'event-web-new');
assert.strictEqual(result.attentionCount, 2);
assert.strictEqual(result.activeAttentionCount, 1);
~~~

- [ ] **Step 2: Run the focused test to prove the regression**

Run:

~~~bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
~~~

Expected: FAIL because hydration does not accept the aggregate and Session rows
have no attention.

- [ ] **Step 3: Implement one shared root-aware index**

Create src/workspaces/sessionAttention.ts:

~~~ts
'use strict';

import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import { getAttentionProjectKey, getAttentionSessionLookupKey } from '../aiSessions/attentionProject';
import { getAiSessionKey } from '../aiSessions/sessionHelpers';
import type { AiSessionViewModel } from '../aiSessions/types';
import type { AiSessionProviderId } from '../models';

type IndexedAttention = NonNullable<AiSessionViewModel['attention']> & {
    observedAtMs: number;
    sourceKey: string;
};
export type WorkspaceSessionAttentionIndex = ReadonlyMap<string, IndexedAttention>;

export function getLogicalAttentionSessionKey(sessionKey: string): string {
    const match = /^(codex|kimi|claude):(.+):\d+:(?:vscode|tmux)$/.exec(sessionKey || '');
    return match ? match[1] + ':' + match[2] : sessionKey;
}

export function buildWorkspaceSessionAttentionIndex(
    aggregate: AttentionAggregate | null
): WorkspaceSessionAttentionIndex {
    const result = new Map<string, IndexedAttention>();
    for (const session of aggregate?.sessions || []) {
        const lookupKey = getAttentionSessionLookupKey(
            session.projectId, getLogicalAttentionSessionKey(session.sessionKey)
        );
        const eventId = session.eventIds.slice().sort()[0];
        const reason = session.reasons.slice().sort()[0];
        if (!eventId || !reason) { continue; }
        const candidate: IndexedAttention = {
            eventId, reason, unread: true,
            observedAtMs: session.observedAtMs,
            sourceKey: session.sessionKey,
        };
        const current = result.get(lookupKey);
        if (!current || candidate.observedAtMs > current.observedAtMs
            || candidate.observedAtMs === current.observedAtMs
                && candidate.sourceKey.localeCompare(current.sourceKey) > 0) {
            result.set(lookupKey, candidate);
        }
    }
    return result;
}

export function getWorkspaceSessionAttention(
    index: WorkspaceSessionAttentionIndex,
    rootUri: string,
    providerId: AiSessionProviderId,
    sessionId: string
): AiSessionViewModel['attention'] | undefined {
    const indexed = index.get(getAttentionSessionLookupKey(
        getAttentionProjectKey(rootUri), getAiSessionKey(providerId, sessionId)
    ));
    return indexed ? {
        eventId: indexed.eventId, reason: indexed.reason, unread: indexed.unread,
    } : undefined;
}
~~~

Import getLogicalAttentionSessionKey into attentionController.ts and use it as
the regex fallback in getLogicalSessionKey. The controller's explicit
attentionKeysBySession mapping remains the first choice.

- [ ] **Step 4: Feed the aggregate through hydration**

Add attentionAggregate?: AttentionAggregate | null to
HydrateWorkspaceAiSessionsInput. Build one index per hydration:

~~~ts
const attentionByRootAndSession = buildWorkspaceSessionAttentionIndex(
    input.attentionAggregate || null
);
~~~

While mapping each assigned history Session:

~~~ts
const attention = root && getWorkspaceSessionAttention(
    attentionByRootAndSession, root.uri, provider.id, session.id
);
return {
    ...session,
    provider: provider.id,
    active: activeSessionKeys.has(key),
    focused: focusedSessionKey === key,
    ...(attention ? { attention } : {}),
    primaryRootId: root.id,
    primaryRootLabel: root.name,
};
~~~

Add getAttentionAggregate to WorkspaceSessionHydrationControllerOptions and
forward this.options.getAttentionAggregate() into hydrateWorkspaceAiSessions.
Wire src/dashboard.ts with:

~~~ts
getAttentionAggregate: () => aiSessionAttentionController.getEffectiveAggregate(),
~~~

- [ ] **Step 5: Verify Task 1**

Run:

~~~bash
npm run test-compile
node scripts/run-ai-session-safety-checks.js
~~~

Expected: PASS, including root isolation, newest-run selection, current summary
count, and active row needsAttention.

- [ ] **Step 6: Commit Task 1**

~~~bash
git add src/workspaces/sessionAttention.ts src/aiSessions/attentionController.ts src/workspaces/sessionHydration.ts src/workspaces/sessionHydrationController.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js
git commit -m "fix: restore workspace session attention projection"
~~~

---

### Task 2: Refresh OTHER WINDOWS on attention-only changes

**Files:**
- Modify: src/openWorkspaces/dashboardController.ts:getViewSemanticRevision
- Modify: src/dashboard.ts:attention bridge callback and openWorkspaceDashboardController declaration
- Test: scripts/run-open-project-safety-checks.js:runOpenWorkspaceClientAndControllerChecks
- Test: scripts/run-dashboard-webview-checks.js:controller source wiring

**Interfaces:**
- Consumes: OpenWorkspaceDashboardControllerOptions.getAttentionAggregate().
- Produces: a semantic revision that changes with aggregateRevision.
- Produces: scheduleAttentionViewsRefresh(): void, refreshing CURRENT and OTHER projections.

- [ ] **Step 1: Add a failing attention-only projection test**

Create a dashboard fixture with mutable attention and captured posts:

~~~js
let attention = null;
const posts = [];
const attentionDashboard = new OpenWorkspaceDashboardController({
    getCurrentWorkspace: () => current,
    isWorkspaceSavedAsProject: () => true,
    getWorkspaceProjectColor: () => '',
    getCurrentWorkspaceAiSessions: () => null,
    getGroups: () => [], getTodoSearchItems: () => [],
    getCollapsed: () => false,
    getRunningCardAnimation: () => 'current',
    getAttentionAggregate: () => attention,
    getBridgeInstanceId: () => SELF,
    postMessage: async message => { posts.push(message); return true; },
    refresh: () => undefined, isVisible: () => true,
    logDiagnostic: () => undefined, logError: () => undefined,
});
attentionDashboard.setAggregate(aggregate);
attentionDashboard.postUpdated();
await new Promise(resolve => setImmediate(resolve));
attention = {
    protocolVersion: 1, aggregateRevision: 'b'.repeat(64), generatedAtMs: 6000,
    sessions: [{
        projectId: attentionProject.getAttentionProjectKey(current.roots[0].uri),
        sessionKey: 'codex:done', eventIds: ['event-done'],
        reasons: ['completed'], observedAtMs: 5900,
    }],
};
attentionDashboard.postUpdated();
await new Promise(resolve => setImmediate(resolve));
assert.strictEqual(posts.length, 2);
assert.notStrictEqual(posts[0].semanticRevision, posts[1].semanticRevision);
assert.strictEqual(posts[1].cards[0].attentionCount, 1);
~~~

Add a source assertion that the AttentionBridgeClient callback calls
scheduleAttentionViewsRefresh().

- [ ] **Step 2: Run the failing test**

~~~bash
npm run test-compile
npm run attention:bridge:compile
node scripts/run-open-project-safety-checks.js
~~~

Expected: FAIL with posts.length equal to 1.

- [ ] **Step 3: Include attention revision in the view revision**

Change getViewSemanticRevision() to hash:

~~~ts
return crypto.createHash('sha256').update(JSON.stringify([
    this.bridgeStatus,
    this.aggregate?.semanticRevision || null,
    this.options.getAttentionAggregate()?.aggregateRevision || null,
    this.options.getRunningCardAnimation(),
])).digest('hex');
~~~

- [ ] **Step 4: Wire an initialization-safe dual refresh**

Declare:

~~~ts
let openWorkspaceDashboardController: OpenWorkspaceDashboardController | undefined;
~~~

Assign it later rather than declaring a new const. Add:

~~~ts
function scheduleAttentionViewsRefresh() {
    scheduleAiSessionRefresh('attention');
    openWorkspaceDashboardController?.postUpdated();
}
~~~

Use that function when setRemoteAggregate returns true. Keep optional access so
an early bridge callback cannot encounter a temporal-dead-zone error.

- [ ] **Step 5: Verify Task 2**

~~~bash
npm run test-compile
node scripts/run-open-project-safety-checks.js
node scripts/run-dashboard-webview-checks.js
node scripts/run-ai-session-safety-checks.js
~~~

Expected: PASS; the second post is generated without an open-workspace
inventory change.

- [ ] **Step 6: Commit Task 2**

~~~bash
git add src/openWorkspaces/dashboardController.ts src/dashboard.ts scripts/run-open-project-safety-checks.js scripts/run-dashboard-webview-checks.js
git commit -m "fix: refresh other windows for attention updates"
~~~

---

### Task 3: Restore workspace-native pending Session promotion

**Files:**
- Create: src/workspaces/pendingSessionPromotionController.ts
- Modify: src/workspaces/sessionHydrationController.ts:WorkspaceSessionHydrationControllerOptions and hydrate
- Modify: src/dashboard.ts:controller construction
- Test: scripts/run-ai-session-safety-checks.js:runWorkspacePendingSessionPromotionChecks

**Interfaces:**
- Consumes: resolvePendingAiSessionTerminals, current workspace, provider read results, runtime coordinator, alias store, active sync, execution evaluation, refresh, and diagnostics.
- Produces: WorkspacePendingSessionPromotionController.promote(workspace, sessionResults, reason): Promise<void>.
- Produces: WorkspaceSessionHydrationControllerOptions.onDidReadSessions?(workspace, sessionResults, reason): void.

- [ ] **Step 1: Write failing success, retry, scope, and concurrency tests**

Import WorkspacePendingSessionPromotionController from the compiled output. Build
one pending runtime whose provider Session appears one second later. Assert:

~~~js
await controller.promote(workspace, sessionResults, 'watcher');
assert.deepStrictEqual(promotions, [['pending-workspace', 'session-final']]);
assert.deepStrictEqual(aliases, [['codex', 'session-final', 'New Codex session']]);
assert.strictEqual(syncCount, 1);
assert.strictEqual(evaluationCount, 1);
assert.deepStrictEqual(refreshReasons, ['pending-promotion']);
~~~

For retry, return [] on the first promotion, retain the pending runtime, and
return one valid active runtime on the second call. Assert two attempts but one
alias/sync/evaluation/refresh. For concurrency, issue two promote calls before
resolving a deferred first promotion and assert no duplicate. Add another scope
and assert its pending runtime is never attempted.

- [ ] **Step 2: Run compile and prove the production component is missing**

~~~bash
npm run test-compile
~~~

Expected: the new compiled module cannot be imported because no production
controller exists.

- [ ] **Step 3: Implement the serialized controller**

Create src/workspaces/pendingSessionPromotionController.ts with:

~~~ts
export interface WorkspacePendingSessionPromotionControllerOptions<TTerminal = unknown> {
    providers: readonly Pick<AiSessionProviderDefinition,
        'id' | 'terminalNamePrefix' | 'projectSessionsKey' | 'terminalCwdFields'>[];
    getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string;
    runtimeCoordinator: PendingAiSessionRuntimeCoordinator<TTerminal> & {
        getActive(): AiSessionRuntimeSnapshot<TTerminal>[];
        getPending(): AiSessionPendingRuntimeSnapshot<TTerminal>[];
    };
    setAlias: (providerId: AiSessionProviderId, sessionId: string, alias: string) => void;
    syncActiveRuntime: () => void;
    evaluateExecution: () => void;
    scheduleRefresh: (reason: string) => void;
    logDiagnostic?: (event: Record<string, unknown>) => void;
}

export class WorkspacePendingSessionPromotionController<TTerminal = unknown> {
    private readonly queuedByScope = new Map<string, PromotionRequest>();
    private readonly inFlightByScope = new Map<string, Promise<void>>();

    constructor(private readonly options:
        WorkspacePendingSessionPromotionControllerOptions<TTerminal>) {}

    promote(workspace: OpenWorkspace,
        sessionResults: Record<AiSessionProviderId, AiSessionReadResult>,
        reason: string): Promise<void> {
        const scope = workspace.scopeIdentity;
        this.queuedByScope.set(scope, { workspace, sessionResults, reason });
        const existing = this.inFlightByScope.get(scope);
        if (existing) { return existing; }
        const running = this.drain(scope).finally(() => {
            if (this.inFlightByScope.get(scope) === running) {
                this.inFlightByScope.delete(scope);
            }
        });
        this.inFlightByScope.set(scope, running);
        return running;
    }

    private async drain(scope: string): Promise<void> {
        while (this.queuedByScope.has(scope)) {
            const request = this.queuedByScope.get(scope) as PromotionRequest;
            this.queuedByScope.delete(scope);
            try {
                await this.promoteOnce(request);
            } catch (error) {
                this.options.logDiagnostic?.({
                    event: 'workspace-ai-session-promotion-failed',
                    reason: request.reason,
                    category: error instanceof Error ? error.name : typeof error,
                });
            }
        }
    }

    private async promoteOnce(request: PromotionRequest): Promise<void> {
        const pendingRuntimes = this.options.runtimeCoordinator.getPending()
            .filter(runtime => runtime.identity.workspaceScopeIdentity
                === request.workspace.scopeIdentity);
        if (!pendingRuntimes.length) { return; }
        const activeRuntimes = this.options.runtimeCoordinator.getActive()
            .filter(runtime => runtime.identity.workspaceScopeIdentity
                === request.workspace.scopeIdentity
                || runtime.identity.workspaceNavigationIdentity
                    === request.workspace.navigationIdentity);
        const result = await resolvePendingAiSessionTerminals({
            pendingRuntimes,
            activeRuntimes,
            sessionResults: request.sessionResults,
            providers: this.options.providers,
            getSessionKey: this.options.getSessionKey,
            runtimeCoordinator: this.options.runtimeCoordinator,
            setAlias: this.options.setAlias,
            syncActiveRuntime: this.options.syncActiveRuntime,
        });
        if (result.promoted.length) {
            this.options.evaluateExecution();
            this.options.scheduleRefresh('pending-promotion');
        }
        if (result.failures.length) {
            this.options.logDiagnostic?.({
                event: 'workspace-ai-session-promotion',
                reason: request.reason,
                attempted: result.attempted,
                promotedCount: result.promoted.length,
                failureReasons: result.failures.map(failure => failure.reason),
            });
        }
    }
}
~~~

Define the request next to the options and import the types/functions named in
the File Map:

~~~ts
interface PromotionRequest {
    workspace: OpenWorkspace;
    sessionResults: Record<AiSessionProviderId, AiSessionReadResult>;
    reason: string;
}
~~~

The controller always reads fresh runtime snapshots and does not memoize
failures, so a later provider scan can retry safely.

- [ ] **Step 4: Trigger promotion after the shared provider scan**

Add this exact option:

~~~ts
onDidReadSessions?: (
    workspace: OpenWorkspace,
    sessionResults: Record<AiSessionProviderId, AiSessionReadResult>,
    reason: string
) => void;
~~~

Immediately after readCoordinator.getResults:

~~~ts
this.options.onDidReadSessions?.(workspace, sessionResults, reason);
~~~

Construct the new controller in dashboard.ts with aiSessionProviders,
getAiSessionKey, aiSessionRuntimeCoordinator, aiSessionAliasController.set,
activeAiSessionTerminalHighlighter.sync, aiSessionExecutionController.evaluate,
refreshAiSessionViewsIncrementally, and logAiSessionDiagnostic. Wire hydration:

~~~ts
onDidReadSessions: (workspace, sessionResults, reason) => {
    void workspacePendingSessionPromotionController.promote(
        workspace, sessionResults, reason
    );
},
~~~

All callbacks run only after activation construction completes.

- [ ] **Step 5: Verify Task 3**

~~~bash
npm run test-compile
node scripts/run-ai-session-safety-checks.js
node scripts/run-ai-session-tmux-checks.js
~~~

Expected: PASS for Direct Terminal and tmux, including retry, concurrency, and
scope isolation.

- [ ] **Step 6: Commit Task 3**

~~~bash
git add src/workspaces/pendingSessionPromotionController.ts src/workspaces/sessionHydrationController.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js
git commit -m "fix: restore workspace pending session promotion"
~~~

---

### Task 4: Add the Workspace parity lifecycle and wiring gate

**Files:**
- Create: scripts/run-workspace-parity-checks.js
- Modify: package.json:scripts
- Modify: scripts/run-ai-session-safety-checks.js:runAiSessionIncrementalRefreshSourceChecks

**Interfaces:**
- Consumes: compiled workspace hydration, promotion, open-workspace dashboard, aggregate helpers, and production source.
- Produces: npm script test:workspace-parity and a safety-suite production-wiring gate.

- [ ] **Step 1: Create a three-shape lifecycle runner**

Create scripts/run-workspace-parity-checks.js and loop over:

~~~js
const WORKSPACE_KINDS = [
    { kind: 'singleFolder', navigationUri: 'file:///work/app', roots: ['/work/app'] },
    { kind: 'savedMultiRoot', navigationUri: 'file:///work/all.code-workspace',
        roots: ['/work/app', '/work/api'] },
    { kind: 'untitledMultiRoot', navigationUri: 'untitled:Untitled-1',
        roots: ['/work/app', '/work/api'] },
];
~~~

For each shape, construct one pending runtime, a mutable runtime coordinator,
provider results, execution snapshot, mutable aggregate, hydration controller,
promotion controller, and open-workspace dashboard controller. Exercise:

~~~js
await promotion.promote(workspace, providerResults, 'parity');
const running = hydration.hydrate(workspace);
assert.strictEqual(running.activeSessions[0].executionState, 'running');

attention = completionAggregate(
    workspace.roots[0].uri,
    'codex:session-final:100:vscode',
    'event-final'
);
const completed = hydration.hydrate(workspace);
assert.strictEqual(completed.activeSessions[0].needsAttention, true);
assert.strictEqual(completed.activeSessions[0].attentionEventId, 'event-final');
~~~

Post the remote workspace once after running becomes zero and once after only
attention.aggregateRevision changes. Assert the second post has attentionCount
1. Simulate refresh, tab switch, collapse, and workspace navigation without
calling acknowledgement, and assert attention remains. Then replace attention
with an empty newer aggregate to represent an explicit Session click and assert
CURRENT and OTHER clear together.

- [ ] **Step 2: Add production-wiring architecture assertions**

Read production sources and assert:

~~~js
assert.ok(dashboardSource.includes(
    \"from './workspaces/pendingSessionPromotionController'\"
));
assert.ok(dashboardSource.includes(
    'workspacePendingSessionPromotionController.promote('
));
assert.ok(hydrationControllerSource.includes('onDidReadSessions?.('));
assert.ok(hydrationControllerSource.includes(
    'getAttentionAggregate: () => AttentionAggregate | null'
));
assert.ok(openWorkspaceDashboardSource.includes(
    'this.options.getAttentionAggregate()?.aggregateRevision || null'
));
assert.ok(dashboardSource.includes('scheduleAttentionViewsRefresh()'));
~~~

Also retain the existing gate that removed Project hydration files do not
reappear.

- [ ] **Step 3: Register and run the dedicated suite**

Add:

~~~json
\"test:workspace-parity\": \"npm run test-compile && node scripts/run-workspace-parity-checks.js\"
~~~

Run:

~~~bash
npm run test:workspace-parity
~~~

Expected before final fixture/wiring completion: FAIL on the missing lifecycle
or production-wiring assertion. Expected after completing the runner: PASS and
print Workspace parity checks passed.

- [ ] **Step 4: Include parity in normal safety verification**

Set test:safety to:

~~~json
\"test:safety\": \"npm run test-compile && npm run attention:bridge:compile && node scripts/run-workspace-parity-checks.js && node scripts/run-ai-session-tmux-checks.js && node scripts/run-ai-session-safety-checks.js && node scripts/run-open-project-safety-checks.js\"
~~~

- [ ] **Step 5: Verify Task 4**

~~~bash
npm run test:workspace-parity
npm run test:safety
npm run test:dashboard
~~~

Expected: PASS for single-folder, saved multi-root, and untitled multi-root
fixtures, followed by all existing action and rendering regressions.

- [ ] **Step 6: Commit Task 4**

~~~bash
git add scripts/run-workspace-parity-checks.js scripts/run-ai-session-safety-checks.js package.json
git commit -m "test: lock workspace session lifecycle parity"
~~~

---

### Task 5: Review, verify, package, install, and record evidence

**Files:**
- Create: docs/superpowers/reports/2026-07-22-workspace-parity-verification.md
- Verify unchanged: media/styles.scss, media/styles.css, extensions/attention-ui-bridge/**
- Package output: artifacts/project-steward-2.1.3.vsix

**Interfaces:**
- Consumes: Tasks 1-4 and release scripts.
- Produces: a verified main-extension VSIX installed into the pinned Dev Container host.

- [ ] **Step 1: Review the complete diff for forbidden scope**

~~~bash
git diff --check HEAD~4..HEAD
git diff --name-only HEAD~4..HEAD
git diff HEAD~4..HEAD -- media/styles.scss media/styles.css extensions/attention-ui-bridge
rg -n \"acknowledge\\(|acknowledge-ai-session-attention\" src/workspaces src/openWorkspaces
~~~

Expected: no whitespace errors, no style/UI Bridge diff, and no workspace-card
acknowledgement path.

- [ ] **Step 2: Run fresh full verification**

~~~bash
npm run test:workspace-parity
npm run test:safety
npm run test:dashboard
npm run test:tmux:smoke
npm run test:release-packaging
~~~

Expected: every command exits 0.

- [ ] **Step 3: Produce and inspect the main VSIX**

~~~bash
npm run package:release
ls -lh artifacts/project-steward-2.1.3.vsix
~~~

Expected: artifacts/project-steward-2.1.3.vsix exists. Do not package or install
a replacement UI Bridge.

- [ ] **Step 4: Install only the main VSIX into the Dev Container**

~~~bash
/home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server --install-extension artifacts/project-steward-2.1.3.vsix --force
~~~

Expected: successful Project Steward installation. Do not run an install command
for hzcheng.project-steward-attention-ui-bridge.

- [ ] **Step 5: Record automated evidence and the user-run matrix**

Create the verification report with exact command results, commit IDs, artifact
path/size, and install output. Include:

~~~markdown
| Backend | Workspace shape | Running animation | Completion red dot | Persists until Session click | CURRENT/OTHER clear together |
| --- | --- | --- | --- | --- | --- |
| VS Code Terminal | single folder | [ ] | [ ] | [ ] | [ ] |
| VS Code Terminal | saved multi-root | [ ] | [ ] | [ ] | [ ] |
| VS Code Terminal | untitled multi-root | [ ] | [ ] | [ ] | [ ] |
| tmux | single folder | [ ] | [ ] | [ ] | [ ] |
| tmux | saved multi-root | [ ] | [ ] | [ ] | [ ] |
| tmux | untitled multi-root | [ ] | [ ] | [ ] | [ ] |
~~~

Record separately that OTHER WINDOWS navigation still jumps directly and does
not acknowledge attention.

- [ ] **Step 6: Commit the verification report**

~~~bash
git add docs/superpowers/reports/2026-07-22-workspace-parity-verification.md
git commit -m "docs: verify workspace lifecycle parity"
~~~
