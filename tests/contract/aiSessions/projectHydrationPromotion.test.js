'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    WorkspacePendingSessionPromotionController,
} = require('../../../out/workspaces/pendingSessionPromotionController');

const PROVIDERS = ['codex', 'kimi', 'claude'].map(id => ({
    id,
    terminalNamePrefix: id[0].toUpperCase() + id.slice(1),
    projectSessionsKey: `${id}Sessions`,
    terminalCwdFields: ['cwd'],
}));
const WORKSPACE = {
    navigationIdentity: 'navigation:fixture',
    scopeIdentity: 'scope:fixture',
    kind: 'singleFolder',
    displayName: 'Fixture',
    navigationUri: 'file:///work/app',
    environment: 'local',
    roots: [{
        id: 'root:fixture', name: 'app', uri: 'file:///work/app',
        hostPath: '/work/app', ordinal: 0,
    }],
};
const SESSION = {
    id: 'session-final',
    name: 'Original Name',
    cwd: '/work/app',
    updatedAt: '2026-07-18T10:01:00Z',
};

function identity(provider, final = false) {
    return {
        provider,
        workspaceScopeIdentity: WORKSPACE.scopeIdentity,
        workspaceNavigationIdentity: WORKSPACE.navigationIdentity,
        workspaceRootHostPaths: ['/work/app'],
        cwd: '/work/app',
        ...(final ? { sessionId: SESSION.id } : { pendingId: `pending-${provider}` }),
    };
}

function pendingRuntime(provider = 'codex', backend = 'tmux', layout = 'project') {
    return {
        identity: identity(provider),
        backend,
        state: 'pending',
        markerPath: `/tmp/${provider}.done`,
        runStartedAtMs: Date.parse('2026-07-18T10:00:00Z'),
        attached: backend === 'vscode',
        ...(backend === 'tmux' ? {
            tmux: {
                layout,
                sessionName: `project-steward-${provider}`,
                ...(layout === 'project' ? { windowName: `ai-${provider}` } : {}),
            },
        } : {}),
        createdAt: '2026-07-18T10:00:00Z',
        excludedSessionIds: [],
        title: 'Promoted Alias',
        recoverySessionId: SESSION.id,
        promotionRecoveryDisplayName: 'Promoted Alias',
    };
}

function finalRuntime(provider = 'codex', backend = 'tmux', layout = 'project') {
    return {
        identity: identity(provider, true),
        backend,
        state: 'active',
        markerPath: `/tmp/${provider}.done`,
        runStartedAtMs: Date.parse('2026-07-18T10:00:00Z'),
        attached: backend === 'vscode',
        ...(backend === 'tmux' ? {
            tmux: {
                layout,
                sessionName: `project-steward-${provider}`,
                ...(layout === 'project' ? { windowName: `ai-${provider}` } : {}),
            },
        } : {}),
    };
}

function sessionResults(provider = 'codex') {
    return Object.fromEntries(PROVIDERS.map(candidate => [candidate.id, {
        available: true,
        scannedFiles: candidate.id === provider ? 1 : 0,
        parsedFiles: candidate.id === provider ? 1 : 0,
        sessions: candidate.id === provider ? [SESSION] : [],
    }]));
}

function createHarness(overrides = {}) {
    const aliases = [];
    const effects = [];
    const diagnostics = [];
    const runtimeCoordinator = {
        getActive: () => [],
        getPending: () => [],
        getPendingForPromotion: async () => [],
        promotePending: async () => [],
        ...overrides.runtimeCoordinator,
    };
    const controller = new WorkspacePendingSessionPromotionController({
        providers: PROVIDERS,
        getSessionKey: (provider, sessionId) => `${provider}:${sessionId}`,
        runtimeCoordinator,
        setAlias: (provider, sessionId, alias) => aliases.push([provider, sessionId, alias]),
        syncActiveRuntime: () => effects.push('sync'),
        evaluateExecution: () => effects.push('evaluate'),
        scheduleRefresh: reason => effects.push(`refresh:${reason}`),
        logDiagnostic: event => diagnostics.push(event),
    });
    return { controller, aliases, effects, diagnostics };
}

test('PERSIST-AI-SESSION-PROJECT-HYDRATION-PROMOTION-001 shares single-flight work and drains the latest queued generation', async () => {
    let release;
    let reads = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = pendingRuntime();
    const harness = createHarness({
        runtimeCoordinator: {
            getPendingForPromotion: async () => {
                reads += 1;
                if (reads === 1) await gate;
                return reads === 1 ? [pending] : [];
            },
            promotePending: async () => [finalRuntime()],
        },
    });

    const first = harness.controller.promote(WORKSPACE, sessionResults(), 'first');
    const second = harness.controller.promote(WORKSPACE, sessionResults(), 'latest');
    assert.equal(first, second);
    release();
    await first;

    assert.equal(reads, 2);
    assert.deepEqual(harness.aliases, [['codex', SESSION.id, 'Promoted Alias']]);
    assert.deepEqual(harness.effects, ['sync', 'evaluate', 'refresh:pending-promotion']);
});

test('PERSIST-AI-SESSION-PROJECT-HYDRATION-PROMOTION-001 completes an asynchronous runtime handoff before publishing effects', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const harness = createHarness({
        runtimeCoordinator: {
            getPendingForPromotion: async () => [pendingRuntime()],
            promotePending: async () => {
                await gate;
                return [finalRuntime()];
            },
        },
    });

    const promotion = harness.controller.promote(WORKSPACE, sessionResults(), 'async');
    await Promise.resolve();
    assert.deepEqual(harness.effects, []);
    release();
    await promotion;
    assert.deepEqual(harness.aliases, [['codex', SESSION.id, 'Promoted Alias']]);
    assert.deepEqual(harness.effects, ['sync', 'evaluate', 'refresh:pending-promotion']);
});

test('PERSIST-AI-SESSION-PROJECT-HYDRATION-PROMOTION-001 hands Direct and tmux Codex, Kimi, and Claude runtimes to execution immediately', async () => {
    for (const provider of ['codex', 'kimi', 'claude']) {
        for (const fixture of [
            { backend: 'vscode', layout: 'project' },
            { backend: 'tmux', layout: 'project' },
            { backend: 'tmux', layout: 'session' },
        ]) {
            const pending = pendingRuntime(provider, fixture.backend, fixture.layout);
            const final = finalRuntime(provider, fixture.backend, fixture.layout);
            const harness = createHarness({
                runtimeCoordinator: {
                    getPendingForPromotion: async () => [pending],
                    promotePending: async (pendingIdentity, sessionId, displayName) => {
                        assert.deepEqual(pendingIdentity, pending.identity);
                        assert.equal(sessionId, SESSION.id);
                        assert.equal(displayName, 'Promoted Alias');
                        return [final];
                    },
                },
            });
            await harness.controller.promote(WORKSPACE, sessionResults(provider), `${provider}-${fixture.backend}`);
            assert.deepEqual(harness.effects, ['sync', 'evaluate', 'refresh:pending-promotion']);
            assert.deepEqual(harness.aliases, [[provider, SESSION.id, 'Promoted Alias']]);
        }
    }
});

test('PERSIST-AI-SESSION-PROJECT-HYDRATION-PROMOTION-001 reports failures without secrets and permits a later retry', async () => {
    let attempt = 0;
    const pending = pendingRuntime();
    const harness = createHarness({
        runtimeCoordinator: {
            getPendingForPromotion: async () => [pending],
            promotePending: async () => {
                attempt += 1;
                if (attempt === 1) {
                    return [];
                }
                return [finalRuntime()];
            },
        },
    });

    await harness.controller.promote(WORKSPACE, sessionResults(), 'first-failure');
    assert.deepEqual(harness.effects, []);
    assert.ok(harness.diagnostics.some(event =>
        event.event === 'workspace-ai-session-promotion'
        && event.failureReasons.includes('missing-runtime')));

    await harness.controller.promote(WORKSPACE, sessionResults(), 'retry');
    assert.equal(attempt, 2);
    assert.deepEqual(harness.aliases, [['codex', SESSION.id, 'Promoted Alias']]);
    assert.deepEqual(harness.effects, ['sync', 'evaluate', 'refresh:pending-promotion']);
    assert.equal(JSON.stringify(harness.diagnostics).includes('/tmp/codex.done'), false);
});
