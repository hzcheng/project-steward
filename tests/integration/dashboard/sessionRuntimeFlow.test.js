'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFakeClock } = require('../../helpers/fakeClock');
const { loadFreshWithFakeVscode } = require('../../helpers/runtimeContract');
const { AI_SESSION_PROVIDER_DEFINITIONS } = require('../../../out/aiSessions/providers');
const { hydrateWorkspaceAiSessions } = require('../../../out/workspaces/sessionHydration');
const { getAttentionProjectKeys } = require('../../../out/aiSessions/attentionProject');
const { getAiSessionTerminalCandidates } = require('../../../out/aiSessions/terminalCandidates');
const ActiveAiSessionTerminalHighlighter = require('../../../out/aiSessions/activeTerminalHighlight').default;

test('PROJECT-TERMINAL-CANDIDATE-001 reads provider sessions through the terminal-candidate cache reason', () => {
    const sessions = [{ id: 'candidate', name: 'Candidate' }];
    const calls = [];
    const result = getAiSessionTerminalCandidates('kimi', {
        getProviderResult(providerId, options) {
            calls.push({ providerId, options });
            return { available: true, sessions, scannedFiles: 1, parsedFiles: 1 };
        },
    });

    assert.equal(result, sessions);
    assert.deepEqual(calls, [{ providerId: 'kimi', options: { reason: 'terminal-candidates' } }]);
});

test('PROJECT-ACTIVE-AI-SESSION-PROJECTION-001 OPEN-OPEN-PROJECT-AI-SESSION-VIEW-MODEL-BUILDER-001 RUNTIME-RUNTIME-PROJECTION-001 projects Direct, tmux, pending, attention, conflict, and stale runtime state', () => {
    const workspace = {
        navigationIdentity: 'navigation:app',
        scopeIdentity: 'scope:app',
        kind: 'singleFolder',
        displayName: 'App',
        navigationUri: 'file:///fixtures/app',
        environment: 'local',
        roots: [{
            id: 'root:app',
            name: 'app',
            uri: 'file:///fixtures/app',
            hostPath: '/fixtures/app',
            ordinal: 0,
        }],
    };
    const runtimeIdentity = (provider, id, pending = false) => ({
        provider,
        workspaceScopeIdentity: workspace.scopeIdentity,
        workspaceNavigationIdentity: workspace.navigationIdentity,
        workspaceRootHostPaths: ['/fixtures/app'],
        cwd: '/fixtures/app',
        ...(pending ? { pendingId: id } : { sessionId: id }),
    });
    const projected = hydrateWorkspaceAiSessions({
        workspace,
        providers: Object.values(AI_SESSION_PROVIDER_DEFINITIONS),
        sessionResults: {
            codex: {
                available: true,
                sessions: [{ id: 'direct', name: 'Direct', cwd: '/fixtures/app' }],
            },
            kimi: {
                available: true,
                sessions: [{ id: 'tmux', name: 'Tmux', cwd: '/fixtures/app' }],
            },
            claude: { available: true, sessions: [] },
        },
        getSessionComparableCwd: (_provider, session) => session.cwd,
        pinnedSessions: new Set(),
        aliases: {},
        activeRuntimes: [{
            identity: runtimeIdentity('codex', 'direct'),
            backend: 'vscode', state: 'active', markerPath: '/tmp/direct.done',
            runStartedAtMs: 10, attached: true,
        }, {
            identity: runtimeIdentity('kimi', 'tmux'),
            backend: 'tmux', state: 'conflict', markerPath: '/tmp/tmux.done',
            runStartedAtMs: 20, attached: false, stale: true,
            tmux: { layout: 'project', sessionName: 'managed', windowName: 'ai-kimi-tmux' },
        }],
        pendingRuntimes: [{
            identity: runtimeIdentity('claude', 'pending', true),
            backend: 'tmux', state: 'pending', markerPath: '/tmp/pending.done',
            runStartedAtMs: 30, attached: false, createdAt: '2026-07-18T10:00:00.000Z',
            excludedSessionIds: [], tmux: { layout: 'session', sessionName: 'pending-managed' },
        }],
        executionSnapshot: {
            'codex:direct': { state: 'running', stateChangedAt: 100 },
            'kimi:tmux': { state: 'stopped', stateChangedAt: 200 },
        },
        focusedIdentity: runtimeIdentity('codex', 'direct'),
        attentionAggregate: {
            protocolVersion: 1,
            aggregateRevision: 'a'.repeat(64),
            generatedAtMs: 1,
            sessions: [{
                projectId: getAttentionProjectKeys(['file:///fixtures/app'])[0],
                sessionKey: 'kimi:tmux',
                reasons: ['input-required'],
                eventIds: ['attention'],
                observedAtMs: 1,
            }],
        },
    });

    assert.deepEqual(projected.activeSessions.map(runtime => ({
        provider: runtime.provider,
        backend: runtime.backend,
        status: runtime.status,
        attached: runtime.attached,
        conflict: runtime.conflict || false,
        stale: runtime.stale || false,
    })), [{
        provider: 'kimi', backend: 'tmux', status: 'conflict', attached: false,
        conflict: true, stale: true,
    }, {
        provider: 'codex', backend: 'vscode', status: 'focused', attached: true,
        conflict: false, stale: false,
    }, {
        provider: 'claude', backend: 'tmux', status: 'starting', attached: false,
        conflict: false, stale: false,
    }]);
    assert.equal(projected.sessionsByProvider.codex[0].active, true);
    assert.equal(projected.sessionsByProvider.kimi[0].attention.eventId, 'attention');
});

test('WEBVIEW-AI-SESSION-DASHBOARD-WATCHER-COALESCING-001 coalesces watcher refreshes and preserves attention refresh priority', async () => {
    const clock = createFakeClock(1000);
    const messages = [];
    const reasons = [];
    const { AiSessionDashboardController } = loadFreshWithFakeVscode(
        '../../../out/aiSessions/dashboardController', {}, __dirname
    );
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'],
        isVisible: () => true,
        invalidateCache: () => undefined,
        watchSessionChanges: () => ({ dispose() {} }),
        getGroups: () => [], getTodoSearchItems: () => [], getCards: () => [],
        getRunningCardAnimation: () => undefined,
        nextSequence: () => messages.length + 1,
        postMessage: message => { messages.push(message); return Promise.resolve(true); },
        refresh: () => undefined,
        logError: (_message, error) => { throw error; },
        beforeRefresh: reason => reasons.push(reason),
        afterRefresh: () => undefined,
        nowMs: () => clock.nowMs,
        debounceMs: 100,
        watcherRefreshMinIntervalMs: 1000,
        newSessionRefreshDelaysMs: [],
        setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
        clearTimeout: handle => clock.clearTimeout(handle),
    });

    controller.scheduleRefresh('watcher');
    clock.advanceBy(100);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reasons, ['watcher']);
    assert.equal(messages.length, 1);

    clock.advanceBy(100);
    controller.scheduleRefresh('watcher');
    controller.scheduleRefresh('watcher');
    clock.advanceBy(900);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reasons, ['watcher', 'watcher']);
    assert.equal(messages.length, 1, 'unchanged watcher snapshots are built once but not posted twice');

    controller.scheduleRefresh('attention');
    clock.advanceBy(100);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reasons, ['watcher', 'watcher', 'attention']);
});

test('WEBVIEW-AI-SESSION-DASHBOARD-CONTROLLER-001 invalidates and refreshes for every new-session delay', async () => {
    const invalidated = [];
    const messages = [];
    const reasons = [];
    const { AiSessionDashboardController } = loadFreshWithFakeVscode(
        '../../../out/aiSessions/dashboardController', {}, __dirname
    );
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'], isVisible: () => true,
        invalidateCache: providerId => invalidated.push(providerId),
        watchSessionChanges: () => ({ dispose() {} }), getGroups: () => [],
        getTodoSearchItems: () => [{ todoId: 'fixture-todo' }], getCards: () => [],
        getRunningCardAnimation: () => undefined,
        nextSequence: () => messages.length + 1,
        postMessage: message => { messages.push(message); return Promise.resolve(true); },
        refresh: () => undefined,
        logError: (_message, error) => { throw error; },
        beforeRefresh: reason => reasons.push(reason),
        debounceMs: 1,
        newSessionRefreshDelaysMs: [1, 2],
        setTimeout: callback => { callback(); return {}; },
        clearTimeout: () => undefined,
    });

    controller.scheduleNewSessionRefresh('codex');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(invalidated, ['codex', 'codex']);
    assert.deepEqual(reasons, ['new-session', 'new-session']);
    assert.deepEqual(messages.map(message => message.type), [
        'ai-sessions-updated', 'ai-sessions-updated',
    ]);
    assert.ok(messages.every(message => message.searchCatalog.todos[0].todoId === 'fixture-todo'));
    controller.dispose();
});

test('WEBVIEW-AI-SESSION-DASHBOARD-UNCHANGED-MESSAGE-SKIP-001 retries an unchanged message after delivery failure', async () => {
    const diagnostics = [];
    const deliveries = [];
    const { AiSessionDashboardController } = loadFreshWithFakeVscode(
        '../../../out/aiSessions/dashboardController', {}, __dirname
    );
    let delivered = false;
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'], isVisible: () => true, invalidateCache: () => undefined,
        watchSessionChanges: () => ({ dispose() {} }), getGroups: () => [],
        getTodoSearchItems: () => [], getCards: () => [],
        getRunningCardAnimation: () => undefined,
        nextSequence: () => deliveries.length + 1,
        postMessage: message => { deliveries.push(message); return Promise.resolve(delivered); },
        refresh: () => undefined,
        logError: (_message, error) => { throw error; },
        logDiagnostic: event => diagnostics.push(event),
        debounceMs: 1, newSessionRefreshDelaysMs: [],
        setTimeout: callback => { callback(); return {}; }, clearTimeout: () => undefined,
    });

    await controller.refreshNow('watcher');
    await new Promise(resolve => setImmediate(resolve));
    delivered = true;
    await controller.refreshNow('watcher');
    await controller.refreshNow('watcher');
    assert.equal(deliveries.length, 2);
    assert.ok(diagnostics.some(event => event.event === 'ai-session-message-skip'));
});

test('WEBVIEW-ACTIVE-AI-SESSION-TERMINAL-HIGHLIGHT-001 ATTENTION-AI-SESSION-ATTENTION-CONTROLLER-001 terminal close clears focus without publishing completion', () => {
    const terminal = { name: 'fixture terminal' };
    let activeTerminal = terminal;
    let complete = false;
    let completionCount = 0;
    const publications = [];
    const timers = [];
    const highlighter = new ActiveAiSessionTerminalHighlighter({
        isVisible: () => true,
        getActiveTerminal: () => activeTerminal,
        resolveTerminal: value => value === terminal
            ? {
                terminal,
                provider: 'codex',
                sessionId: 'session',
                workspaceScopeIdentity: 'scope:fixture',
                entry: { markerPath: '/tmp/marker' },
            }
            : null,
        isComplete: () => complete,
        publish: identity => publications.push(identity),
        onComplete: () => { completionCount += 1; },
        setInterval: callback => { const handle = { callback, active: true }; timers.push(handle); return handle; },
        clearInterval: handle => { handle.active = false; },
    });

    highlighter.sync();
    assert.deepEqual(publications.pop(), {
        provider: 'codex',
        sessionId: 'session',
        workspaceScopeIdentity: 'scope:fixture',
    });
    highlighter.handleTerminalClosed(terminal);
    assert.equal(publications.pop(), null);
    assert.equal(completionCount, 0);

    activeTerminal = terminal;
    highlighter.sync();
    complete = true;
    timers.find(timer => timer.active).callback();
    assert.equal(completionCount, 1);
    assert.equal(publications.pop(), null);
});
