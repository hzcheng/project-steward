'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const originalModuleLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {};
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};
const attentionProject = require('../out/aiSessions/attentionProject');
const {
    OpenWorkspaceDashboardController,
} = require('../out/openWorkspaces/dashboardController');
const {
    WorkspacePendingSessionPromotionController,
} = require('../out/workspaces/pendingSessionPromotionController');
const {
    WorkspaceSessionHydrationController,
} = require('../out/workspaces/sessionHydrationController');
Module._load = originalModuleLoad;

const SELF_INSTANCE = '1'.repeat(32);
const OTHER_INSTANCE = '2'.repeat(32);

const WORKSPACE_SHAPES = [{
    kind: 'singleFolder',
    navigationUri: 'file:///work/app',
    rootPaths: ['/work/app'],
}, {
    kind: 'savedMultiRoot',
    navigationUri: 'file:///work/all.code-workspace',
    rootPaths: ['/work/app', '/work/api'],
}, {
    kind: 'untitledMultiRoot',
    navigationUri: 'untitled:Untitled-1',
    rootPaths: ['/work/app', '/work/api'],
}];

function identity(seed) {
    return String(seed).padStart(64, '0');
}

function createWorkspace(shape, index) {
    return {
        navigationIdentity: identity(index + 1),
        scopeIdentity: identity(index + 101),
        kind: shape.kind,
        displayName: 'Parity ' + shape.kind,
        navigationUri: shape.navigationUri,
        environment: 'local',
        roots: shape.rootPaths.map((hostPath, ordinal) => ({
            id: identity(index * 10 + ordinal + 201),
            name: ordinal === 0 ? 'App' : 'API',
            uri: 'file://' + hostPath,
            hostPath,
            ordinal,
        })),
    };
}

function createPending(workspace) {
    return {
        identity: {
            provider: 'codex',
            workspaceScopeIdentity: workspace.scopeIdentity,
            workspaceNavigationIdentity: workspace.navigationIdentity,
            workspaceRootHostPaths: workspace.roots.map(root => root.hostPath),
            cwd: workspace.roots[0].hostPath,
            pendingId: 'pending-final',
        },
        backend: 'vscode',
        state: 'pending',
        markerPath: '/tmp/pending-final.done',
        runStartedAtMs: 100,
        attached: true,
        createdAt: '2026-07-22T10:00:00.000Z',
        excludedSessionIds: [],
        title: 'Parity session',
        tmux: {
            layout: 'session',
            sessionName: 'ps-Parity-session-12345678',
            windowName: 'codex-Parity-session-12345678',
        },
    };
}

function promoteRuntime(pending) {
    return {
        ...pending,
        identity: {
            ...pending.identity,
            pendingId: undefined,
            sessionId: 'session-final',
        },
        state: 'active',
    };
}

function providerResults(workspace) {
    return {
        codex: {
            available: true,
            scannedFiles: 1,
            parsedFiles: 1,
            sessions: [{
                id: 'session-final',
                name: 'Parity session',
                cwd: workspace.roots[0].hostPath,
                updatedAt: '2026-07-22T10:00:01.000Z',
            }],
        },
        kimi: { available: true, scannedFiles: 0, parsedFiles: 0, sessions: [] },
        claude: { available: true, scannedFiles: 0, parsedFiles: 0, sessions: [] },
    };
}

function completionAggregate(workspace, revisionCharacter, withEvent) {
    return {
        protocolVersion: 1,
        aggregateRevision: revisionCharacter.repeat(64),
        generatedAtMs: 200,
        sessions: withEvent ? [{
            projectId: attentionProject.getAttentionProjectKeys([
                workspace.roots[0].uri,
            ])[0],
            sessionKey: 'codex:session-final:100:vscode',
            eventIds: ['event-final'],
            reasons: ['completed'],
            observedAtMs: 200,
        }] : [],
    };
}

function openWorkspaceAggregate(workspace, revisionCharacter) {
    const publishedWorkspace = {
        ...workspace,
        runningAiSessionCount: 0,
        roots: workspace.roots.map(({ hostPath: _hostPath, ...root }) => root),
    };
    return {
        protocolVersion: 3,
        semanticRevision: revisionCharacter.repeat(64),
        observedAtMs: 300,
        registrations: [{
            protocolVersion: 3,
            instanceId: OTHER_INSTANCE,
            sequence: 1,
            lastFocusedAtMs: 280,
            leaseUpdatedAtMs: 290,
            workspace: publishedWorkspace,
        }],
    };
}

async function runShapeLifecycle(shape, index) {
    const workspace = createWorkspace(shape, index);
    const providers = [{
        id: 'codex', label: 'Codex', terminalNamePrefix: 'Codex',
        projectSessionsKey: 'codexSessions', terminalCwdFields: ['cwd'],
    }, {
        id: 'kimi', label: 'Kimi', terminalNamePrefix: 'Kimi',
        projectSessionsKey: 'kimiSessions', terminalCwdFields: ['workDir', 'cwd'],
    }, {
        id: 'claude', label: 'Claude', terminalNamePrefix: 'Claude',
        projectSessionsKey: 'claudeSessions', terminalCwdFields: ['workDir', 'cwd'],
    }];
    const results = providerResults(workspace);
    let pending = [createPending(workspace)];
    const expectedPromotionName = index % 3 === 0
        ? 'Parity session'
        : index % 3 === 1 ? 'Resolved session name' : 'session-final';
    if (index % 3 !== 0) {
        pending[0].title = '';
        results.codex.sessions[0].name = index % 3 === 1 ? 'Resolved session name' : 'x'.repeat(201);
    }
    let active = [];
    let execution = {};
    let attention = completionAggregate(workspace, '0', false);
    let promotionCount = 0;
    let syncCount = 0;
    let evaluationCount = 0;
    const refreshReasons = [];
    const aliases = [];
    const setAlias = (providerId, sessionId, alias) =>
        aliases.push([providerId, sessionId, alias]);

    const runtimeCoordinator = {
        getPending: () => pending,
        getActive: () => active,
        promotePending: async (_identity, sessionId, sessionName) => {
            promotionCount++;
            assert.strictEqual(sessionId, 'session-final');
            assert.strictEqual(sessionName, expectedPromotionName,
                'promotion must snapshot pending title, resolved name, or provider ID fallback');
            const final = promoteRuntime(pending[0]);
            pending = [];
            active = [final];
            return [final];
        },
    };
    const promotion = new WorkspacePendingSessionPromotionController({
        providers,
        getSessionKey: (providerId, sessionId) => providerId + ':' + sessionId,
        runtimeCoordinator,
        setAlias,
        syncActiveRuntime: () => { syncCount++; },
        evaluateExecution: () => { evaluationCount++; },
        scheduleRefresh: reason => refreshReasons.push(reason),
    });
    const hydration = new WorkspaceSessionHydrationController({
        providers,
        readCoordinator: { getResults: () => results },
        incrementalScanMaxFiles: 100,
        getRefreshReason: () => 'parity',
        getSessionComparableCwd: (_providerId, session) =>
            session.workDir || session.cwd,
        getPinnedSessions: () => new Set(),
        getAliases: () => ({}),
        getActiveProvider: () => 'codex',
        getExpanded: () => true,
        getActiveRuntimes: () => active,
        getPendingRuntimes: () => pending,
        getExecutionSnapshot: () => execution,
        getFocusedIdentity: () => null,
        getAttentionAggregate: () => attention,
    });

    const starting = hydration.hydrate(workspace);
    assert.strictEqual(starting.activeSessions.length, 1);
    assert.strictEqual(starting.activeSessions[0].pending, true);
    assert.strictEqual(starting.activeSessions[0].executionState, 'starting');

    await promotion.promote(workspace, results, 'parity');
    assert.strictEqual(promotionCount, 1);
    assert.strictEqual(syncCount, 1);
    assert.strictEqual(evaluationCount, 1);
    assert.deepStrictEqual(refreshReasons, ['pending-promotion']);
    assert.deepStrictEqual(aliases, [['codex', 'session-final', index % 3 === 0 ? 'Parity session' : '']]);
    const activeLocator = { ...active[0].tmux };
    setAlias('codex', 'session-final', 'Later alias');
    assert.deepStrictEqual(active[0].tmux, activeLocator,
        'later alias updates must not rename an active runtime locator snapshot');

    execution = {
        'codex:session-final': {
            state: 'running',
            stateChangedAt: 150,
        },
    };
    const running = hydration.hydrate(workspace);
    assert.strictEqual(running.activeSessions.length, 1);
    assert.strictEqual(running.activeSessions[0].pending, false);
    assert.strictEqual(running.activeSessions[0].executionState, 'running');

    execution = {
        'codex:session-final': {
            state: 'stopped',
            stateChangedAt: 200,
        },
    };
    attention = completionAggregate(workspace, 'a', true);
    const completed = hydration.hydrate(workspace);
    assert.strictEqual(completed.attentionCount, 1);
    assert.strictEqual(completed.activeAttentionCount, 1);
    assert.strictEqual(completed.activeSessions[0].needsAttention, true);
    assert.strictEqual(completed.activeSessions[0].attentionEventId, 'event-final');

    let collapsed = false;
    const posts = [];
    const remoteDashboard = new OpenWorkspaceDashboardController({
        getCurrentWorkspace: () => null,
        isWorkspaceSavedAsProject: () => false,
        getWorkspaceProjectColor: () => '',
        getCurrentWorkspaceAiSessions: () => null,
        getGroups: () => [],
        getTodoSearchItems: () => [],
        getCollapsed: () => collapsed,
        getRunningCardAnimation: () => 'current',
        getAttentionAggregate: () => attention,
        getBridgeInstanceId: () => SELF_INSTANCE,
        postMessage: async message => { posts.push(message); return true; },
        refresh: () => undefined,
        isVisible: () => true,
        logDiagnostic: () => undefined,
        logError: () => undefined,
    });
    remoteDashboard.setAggregate(openWorkspaceAggregate(workspace, 'c'));

    attention = completionAggregate(workspace, '0', false);
    remoteDashboard.postUpdated();
    await new Promise(resolve => setImmediate(resolve));
    attention = completionAggregate(workspace, 'a', true);
    remoteDashboard.postUpdated();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(posts.length, 2);
    assert.notStrictEqual(posts[0].semanticRevision, posts[1].semanticRevision);
    assert.strictEqual(remoteDashboard.getCards()[0].attentionCount, 1);

    collapsed = true;
    remoteDashboard.postUpdated();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(remoteDashboard.getCards()[0].attentionCount, 1,
        'collapse/refresh must not acknowledge attention');

    attention = completionAggregate(workspace, 'b', false);
    remoteDashboard.postUpdated();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(remoteDashboard.getCards()[0].attentionCount, 0);
    const acknowledged = hydration.hydrate(workspace);
    assert.strictEqual(acknowledged.attentionCount, 0);
    assert.strictEqual(acknowledged.activeAttentionCount, 0);
}

function runProductionWiringChecks() {
    const root = path.join(__dirname, '..');
    const dashboardSource = fs.readFileSync(
        path.join(root, 'src', 'dashboard.ts'), 'utf8'
    );
    const hydrationSource = fs.readFileSync(
        path.join(root, 'src', 'workspaces', 'sessionHydrationController.ts'), 'utf8'
    );
    const openWorkspaceDashboardSource = fs.readFileSync(
        path.join(root, 'src', 'openWorkspaces', 'dashboardController.ts'), 'utf8'
    );
    const projectScriptsSource = fs.readFileSync(
        path.join(root, 'src', 'webview', 'webviewProjectScripts.js'), 'utf8'
    );

    assert.ok(dashboardSource.includes(
        "from './workspaces/pendingSessionPromotionController'"
    ));
    assert.ok(dashboardSource.includes(
        'workspacePendingSessionPromotionController.promote('
    ));
    assert.ok(hydrationSource.includes('this.options.onDidReadSessions?.('));
    assert.ok(hydrationSource.includes(
        'getAttentionAggregate: () => AttentionAggregate | null'
    ));
    assert.ok(openWorkspaceDashboardSource.includes(
        'this.options.getAttentionAggregate()?.aggregateRevision || null'
    ));
    assert.ok(dashboardSource.includes('scheduleAttentionViewsRefresh()'));

    const navigationBranch = projectScriptsSource.slice(
        projectScriptsSource.indexOf(
            'if (projectDiv.hasAttribute("data-workspace-navigation"))'
        ),
        projectScriptsSource.indexOf('var currentWindow')
    );
    assert.ok(navigationBranch.includes(
        'openProject(dataId, ProjectOpenType.Default)'
    ));
    assert.strictEqual(navigationBranch.includes('acknowledge'), false);

    for (const removed of [
        'src/aiSessions/projectHydrationController.ts',
        'src/aiSessions/projectHydration.ts',
        'src/aiSessions/activeSessionProjection.ts',
    ]) {
        assert.strictEqual(fs.existsSync(path.join(root, removed)), false);
    }
}

async function main() {
    for (let index = 0; index < WORKSPACE_SHAPES.length; index++) {
        await runShapeLifecycle(WORKSPACE_SHAPES[index], index + 1);
    }
    runProductionWiringChecks();
    console.log('Workspace parity checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
