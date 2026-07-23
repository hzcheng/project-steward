'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const providers = require('../../../out/aiSessions/providers');

function loadTerminalService() {
    const terminals = [];
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return { window: { terminals, createTerminal() {}, showWarningMessage() {} } };
            return previousLoad.call(this, request, parent, isMain);
        };
        delete require.cache[require.resolve('../../../out/aiSessions/terminalService')];
        return {
            AiSessionTerminalService: require('../../../out/aiSessions/terminalService').default,
            terminals,
        };
    } finally {
        Module._load = previousLoad;
    }
}

test('SESSION-AI-SESSION-TERMINAL-RESOLUTION-001 resolves tracked, environment, and display-name identities but rejects ordinary terminals', t => {
    const { AiSessionTerminalService, terminals } = loadTerminalService();
    const root = makeTempDirectory(t, 'terminal-resolution-');
    const service = new AiSessionTerminalService(root, providers.AI_SESSION_PROVIDER_IDS.map(id =>
        providers.getAiSessionProviderDefinition(id)), 0);
    const tracked = { name: 'tracked', creationOptions: {}, processId: Promise.resolve(1) };
    const trackedIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'scope:fixture',
        workspaceNavigationIdentity: 'navigation:fixture', workspaceRootHostPaths: ['/work'],
        cwd: '/work', sessionId: 'tracked-id',
    };
    service.track('codex', 'tracked-id', {
        terminal: tracked, markerPath: `${root}/tracked.done`, runtimeIdentity: trackedIdentity,
        runStartedAtMs: Date.now(), cwd: '/work',
    }, false);
    const candidateCalls = [];
    const candidates = {
        codex: [{ id: 'environment-id', name: 'Environment' }],
        kimi: [{ id: 'named-123456', name: 'Named' }],
    };
    const getCandidates = provider => {
        candidateCalls.push(provider);
        return candidates[provider] || [];
    };
    assert.equal(service.resolveTerminalSession(tracked, getCandidates).sessionId, 'tracked-id');
    assert.deepEqual(candidateCalls, []);

    const byEnvironment = { name: 'Codex restored', creationOptions: {
        env: { PROJECT_STEWARD_CODEX_SESSION_ID: 'environment-id' },
    }, processId: Promise.resolve(2) };
    const archivedByEnvironment = { name: 'Codex archived', creationOptions: {
        env: { PROJECT_STEWARD_CODEX_SESSION_ID: 'archived-id' },
    }, processId: Promise.resolve(3) };

    const markerPath = service.getMarkerPath('codex', 'environment-id');
    fs.writeFileSync(markerPath, '', 'utf8');
    const oldMarkerAt = new Date(Date.now() - 60_000);
    fs.utimesSync(markerPath, oldMarkerAt, oldMarkerAt);
    const byName = { name: 'Kimi: Named [named-12]', creationOptions: {}, processId: Promise.resolve(4) };
    const ordinary = { name: 'bash', creationOptions: {} };
    terminals.push(byEnvironment, archivedByEnvironment, byName, ordinary);

    assert.equal(service.resolveTerminalSession(byEnvironment, getCandidates), null);
    assert.deepEqual(candidateCalls, []);
    assert.equal(service.resolveTerminalSession(byEnvironment, getCandidates), null);
    assert.deepEqual(candidateCalls, []);

    candidateCalls.length = 0;
    assert.equal(service.resolveTerminalSession(archivedByEnvironment, getCandidates), null);
    assert.deepEqual(candidateCalls, []);
    candidateCalls.length = 0;
    assert.equal(service.resolveTerminalSession(byName, getCandidates), null);
    assert.deepEqual(candidateCalls, []);
    candidateCalls.length = 0;
    assert.equal(service.resolveTerminalSession(ordinary, getCandidates), null);
    assert.deepEqual(candidateCalls, []);

    const pending = { name: 'Codex: Pending', creationOptions: {}, processId: Promise.resolve(5) };
    service.trackPending({
        provider: 'codex', terminal: pending, markerPath: `${root}/pending.done`, cwd: '/work/app',
        createdAt: new Date().toISOString(), excludedSessionIds: [],
        runtimeIdentity: {
            provider: 'codex', workspaceScopeIdentity: 'scope:fixture',
            workspaceNavigationIdentity: 'navigation:fixture', workspaceRootHostPaths: ['/work/app'],
            cwd: '/work/app', pendingId: 'pending-fixture',
        },
    }, false);
    assert.equal(service.getPendingTerminals().length, 1);
    assert.deepEqual(service.handleClosedTerminal(pending), []);
    assert.equal(service.getPendingTerminals().length, 0);
    assert.deepEqual(service.handleClosedTerminal(tracked), [{
        provider: 'codex',
        sessionId: 'tracked-id',
        workspaceScopeIdentity: 'scope:fixture',
    }]);
});
