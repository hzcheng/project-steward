'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AiSessionCreationController } = require('../../../out/aiSessions/creationController');
const { AiSessionResumeController } = require('../../../out/aiSessions/resumeController');
const { AiSessionTerminalCommandController } = require('../../../out/aiSessions/terminalCommandController');
const { AiSessionExecutionController } = require('../../../out/aiSessions/executionController');

const workspace = {
    navigationIdentity: 'navigation:fixture',
    scopeIdentity: 'scope:fixture',
    kind: 'singleFolder',
    displayName: 'Project',
    navigationUri: 'file:///work',
    environment: 'local',
    roots: [{ id: 'root:fixture', name: 'work', uri: 'file:///work', hostPath: '/work', ordinal: 0 }],
};
const directoryScope = {
    workspaceNavigationIdentity: workspace.navigationIdentity,
    workspaceScopeIdentity: workspace.scopeIdentity,
    workspaceRootHostPaths: ['/work'],
    primaryRootId: 'root:fixture',
    primaryCwd: '/work',
    additionalDirectories: [],
};
function makeWorkspaceTarget(sessions = []) {
    return {
        cardId: 'p',
        workspace,
        sessions: {
            activeProvider: 'codex',
            expanded: true,
            sessionsByProvider: { codex: sessions },
            unavailableProviders: [],
            activeSessions: [],
        },
    };
}

test('SESSION-AI-SESSION-CREATION-CONTROLLER-001 creates one tracked pending terminal from validated public input', async () => {
    const effects = [];
    const requests = [];
    const controller = new AiSessionCreationController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget() : null,
        pickWorkspaceRoot: async () => undefined,
        pickProvider: async () => 'codex', getProviderLabel: () => 'Codex',
        getProvider: () => ({
            label: 'Codex',
            terminalNamePrefix: 'Codex',
            buildNewSessionLaunchSpec: () => ({ executable: 'codex', args: ['--new'], cwd: '/work' }),
        }),
        resolveWorkspaceDirectoryScope: () => directoryScope,
        showInputBox: async () => '  Fixture title  ', showActiveTab: async id => effects.push(['tab', id]),
        showWarningMessage: async message => effects.push(['warning', message]), refresh: () => effects.push(['refresh']),
        getExistingSessionIdsForCwd: () => ['existing'], getPendingMarkerPath: () => '/tmp/pending',
        scheduleNewSessionRefresh: provider => effects.push(['schedule', provider]), nowMs: () => 1000,
        createPendingId: () => 'pending-fixture',
        announceStatus: async () => undefined,
        runtimeCoordinator: {
            create: async request => { requests.push(request); return { status: 'started', backend: 'vscode' }; },
            getActive: () => [],
            getPending: () => [],
        },
    });
    await controller.createSession('p');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].title, 'Fixture title');
    assert.equal(requests[0].identity.provider, 'codex');
    assert.equal(requests[0].identity.workspaceScopeIdentity, 'scope:fixture');
    assert.deepEqual(requests[0].excludedSessionIds, ['existing']);
    const before = effects.length;
    await controller.createSession('missing');
    assert.equal(effects.length, before + 1);
    assert.match(effects.at(-1)[1], /not found/i);
});

test('SESSION-AI-SESSION-RESUME-CONTROLLER-001 delegates scoped resume and reveals successful runtime results', async () => {
    const effects = [];
    const requests = [];
    const controller = new AiSessionResumeController({
        getWorkspaceTarget: id => id === 'p'
            ? makeWorkspaceTarget([{ id: 's', name: 'Session', cwd: '/work' }])
            : null,
        getProvider: () => ({
            label: 'Codex',
            terminalEnvKey: 'CODEX',
            buildResumeLaunchSpec: () => ({ executable: 'codex', args: ['resume', 's'], cwd: '/work' }),
        }),
        resolveWorkspaceDirectoryScope: () => directoryScope,
        getTerminalName: () => 'Codex: Session', getMarkerPath: () => '/tmp/new', showWarningMessage: message => effects.push(message),
        refresh: () => effects.push('refresh'), showActiveTab: id => effects.push(`tab:${id}`),
        announceStatus: async () => undefined,
        runtimeCoordinator: {
            resume: async request => { requests.push(request); return { status: 'started', backend: 'vscode' }; },
        },
    });
    await controller.resumeProjectSession('p', 'codex', 's');
    assert.deepEqual(effects, ['tab:p', 'refresh']);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].identity.sessionId, 's');
    assert.equal(requests[0].identity.workspaceScopeIdentity, 'scope:fixture');
});

test('SESSION-AI-SESSION-TERMINAL-COMMAND-CONTROLLER-001 focuses and closes only project-owned terminals', async () => {
    const effects = [];
    const terminal = { show: () => effects.push('show'), dispose: () => effects.push('dispose') };
    const identity = {
        provider: 'codex',
        sessionId: 's',
        workspaceScopeIdentity: 'scope:fixture',
        workspaceNavigationIdentity: 'navigation:fixture',
        workspaceRootHostPaths: ['/work'],
        cwd: '/work',
    };
    const runtime = {
        backend: 'vscode', state: 'active', identity, terminal,
        attached: true, stale: false, runStartedAtMs: 1,
    };
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([{ id: 's' }]) : null,
        showErrorMessage: async message => effects.push(message), getProviderLabel: () => 'Codex', refresh: () => effects.push('refresh'),
        runtimeCoordinator: {
            getById: (_provider, session, scope) =>
                session === 's' && scope === 'scope:fixture' ? runtime : null,
            getPending: () => [],
            focus: async () => effects.push('show'),
            detach: async () => effects.push('dispose'),
        },
        confirmRuntimeClose: async () => 'Close Terminal',
        announceStatus: async () => undefined,
    });
    await controller.focusActive('p', 'codex', 's');
    await controller.closeTerminal({ projectId: 'p', providerId: 'codex', sessionId: 's' });
    const before = effects.length;
    await controller.focusActive('other', 'codex', 's');
    assert.deepEqual(effects.slice(0, 4), ['show', 'refresh', 'dispose', 'refresh']);
    assert.equal(effects.length, before);
});

test('SESSION-AI-SESSION-EXECUTION-CONTROLLER-001 schedules one refresh only when lifecycle output changes', () => {
    const refreshes = [];
    let token = 'one';
    const controller = new AiSessionExecutionController({
        getActiveSessions: () => [{ provider: 'codex', sessionId: 's', runStartedAtMs: 1 }],
        getProviders: () => [{ id: 'codex', service: { getLifecycleSignals: () => ({ s: {
            token, occurredAtMs: token === 'one' ? 2 : 3, executionState: token === 'one' ? 'running' : 'stopped',
        } }) } }],
        scheduleRefresh: reason => refreshes.push(reason), nowMs: () => 1,
    });
    controller.evaluate();
    controller.evaluate();
    token = 'two';
    controller.evaluate();
    assert.deepEqual(refreshes, ['execution', 'execution']);
    assert.equal(controller.getSnapshot()['codex:s'].state, 'stopped');
});
