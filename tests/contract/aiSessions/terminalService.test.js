'use strict';

const assert = require('node:assert/strict');
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
        return require('../../../out/aiSessions/terminalService').default;
    } finally {
        Module._load = previousLoad;
    }
}

test('SESSION-AI-SESSION-TERMINAL-RESOLUTION-001 resolves tracked, environment, and display-name identities but rejects ordinary terminals', t => {
    const AiSessionTerminalService = loadTerminalService();
    const root = makeTempDirectory(t, 'terminal-resolution-');
    const service = new AiSessionTerminalService(root, providers.AI_SESSION_PROVIDER_IDS.map(id =>
        providers.getAiSessionProviderDefinition(id)), 0);
    const tracked = { name: 'tracked', creationOptions: {}, processId: Promise.resolve(1) };
    service.track('codex', 'tracked-id', { terminal: tracked, markerPath: `${root}/tracked.done` }, false);
    assert.equal(service.resolveTerminalSession(tracked, () => []).sessionId, 'tracked-id');

    const byEnvironment = { name: 'Codex restored', creationOptions: {
        env: { PROJECT_STEWARD_CODEX_SESSION_ID: 'environment-id' },
    }, processId: Promise.resolve(2) };
    assert.equal(service.resolveTerminalSession(byEnvironment, provider => provider === 'codex'
        ? [{ id: 'environment-id', name: 'Environment' }] : []).sessionId, 'environment-id');

    const byName = { name: 'Kimi: Named [named-12]', creationOptions: {}, processId: Promise.resolve(3) };
    assert.equal(service.resolveTerminalSession(byName, provider => provider === 'kimi'
        ? [{ id: 'named-123456', name: 'Named' }] : []).sessionId, 'named-123456');
    assert.equal(service.resolveTerminalSession({ name: 'bash', creationOptions: {} }, () => []), null);
});
