'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AiSessionCreationController } = require('../../../out/aiSessions/creationController');
const { AiSessionResumeController } = require('../../../out/aiSessions/resumeController');
const { AiSessionTerminalCommandController } = require('../../../out/aiSessions/terminalCommandController');
const { AiSessionExecutionController } = require('../../../out/aiSessions/executionController');

test('SESSION-AI-SESSION-CREATION-CONTROLLER-001 creates one tracked pending terminal from validated public input', async () => {
    const effects = [];
    const terminal = { show() {}, dispose() {} };
    const controller = new AiSessionCreationController({
        isProviderId: value => value === 'codex', getOpenProjects: () => [{ id: 'p', name: 'Project', path: '/work' }],
        pickProvider: async () => 'codex', getProviderLabel: () => 'Codex',
        getProvider: () => ({ label: 'Codex', terminalNamePrefix: 'Codex' }), getTerminalCwd: project => project.path,
        showInputBox: async () => '  Fixture title  ', showActiveTab: async id => effects.push(['tab', id]),
        showWarningMessage: async message => effects.push(['warning', message]), refresh: () => effects.push(['refresh']),
        getExistingSessionIdsForCwd: () => ['existing'], getPendingMarkerPath: () => '/tmp/pending',
        scheduleNewSessionRefresh: provider => effects.push(['schedule', provider]), nowMs: () => 1000,
        getUsableTerminalCwd: value => value, createTerminal: options => { effects.push(['terminal', options]); return { terminal }; },
        trackPendingTerminal: value => effects.push(['pending', value]),
        sendNewSessionCommand: async (...args) => effects.push(['send', ...args]),
    });
    await controller.createSession('p');
    assert.equal(effects.filter(item => item[0] === 'terminal').length, 1);
    assert.equal(effects.find(item => item[0] === 'pending')[1].title, 'Fixture title');
    assert.equal(effects.find(item => item[0] === 'send')[1], 'codex');
    const before = effects.length;
    await controller.createSession('missing');
    assert.equal(effects.length, before + 1);
    assert.match(effects.at(-1)[1], /not found/);
});

test('SESSION-AI-SESSION-RESUME-CONTROLLER-001 focuses a live terminal and creates only after completion', async () => {
    const effects = [];
    const live = { terminal: { show: () => effects.push('show') }, markerPath: '/tmp/live' };
    let complete = false;
    const controller = new AiSessionResumeController({
        getOpenProjects: () => [{ id: 'p', path: '/work' }], getProvider: () => ({ label: 'Codex', terminalEnvKey: 'CODEX' }),
        getProjectSession: () => ({ id: 's', name: 'Session', cwd: '/work' }), getTerminalCwd: () => '/work',
        getTerminalName: () => 'Codex: Session', getMarkerPath: () => '/tmp/new', showWarningMessage: message => effects.push(message),
        refresh: () => effects.push('refresh'), showActiveTab: id => effects.push(`tab:${id}`), getComparableCwd: () => '/work',
        getUsableTerminalCwd: value => value, normalizeProjectPath: value => value, getExistingTerminal: () => live,
        isTerminalComplete: () => complete, beginResume: () => true, finishResume: () => effects.push('finish'),
        findPendingTerminalForSession: () => null,
        createTerminal: () => ({ terminal: { show() {} }, cwdAccepted: true }), track: () => effects.push('track'),
        claimPendingTerminal: () => effects.push('claim'), sendResumeCommand: async () => effects.push('send'),
        syncActiveTerminal: () => effects.push('sync'), logError() {}, nowMs: () => 1000,
    });
    await controller.resumeProjectSession('p', 'codex', 's');
    assert.deepEqual(effects, ['show', 'tab:p', 'refresh']);
    complete = true;
    await controller.resumeProjectSession('p', 'codex', 's');
    assert.ok(effects.includes('send'));
    assert.ok(effects.includes('track'));
    assert.ok(effects.includes('finish'));
});

test('SESSION-AI-SESSION-TERMINAL-COMMAND-CONTROLLER-001 focuses and closes only project-owned terminals', async () => {
    const effects = [];
    const terminal = { show: () => effects.push('show'), dispose: () => effects.push('dispose') };
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex', getOpenProjects: () => [{ id: 'p', path: '/work', codexSessions: [{ id: 's' }] }],
        getProjectSessions: project => project.codexSessions, getProjectCwd: project => project.path, normalizePath: value => value,
        showErrorMessage: async message => effects.push(message), getProviderLabel: () => 'Codex', refresh: () => effects.push('refresh'),
        getActiveTerminal: (_provider, session) => session === 's' ? { terminal, cwd: '/work' } : null,
        getPendingTerminals: () => [], confirmClose: async () => 'Close Terminal',
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
