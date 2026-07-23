'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadHydrationController() {
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return { Uri: { parse: value => new URL(value) } };
            }
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/aiSessions/projectHydrationController').AiSessionProjectHydrationController;
    } finally {
        Module._load = previousLoad;
    }
}

const AiSessionProjectHydrationController = loadHydrationController();
const { AiSessionExecutionController } = require('../../../out/aiSessions/executionController');

const PROVIDERS = [{
    id: 'codex', terminalNamePrefix: 'Codex', projectSessionsKey: 'codexSessions',
    projectSessionsUnavailableKey: 'codexSessionsUnavailable', terminalCwdFields: ['cwd'],
}, {
    id: 'kimi', terminalNamePrefix: 'Kimi', projectSessionsKey: 'kimiSessions',
    projectSessionsUnavailableKey: 'kimiSessionsUnavailable', terminalCwdFields: ['cwd'],
}, {
    id: 'claude', terminalNamePrefix: 'Claude', projectSessionsKey: 'claudeSessions',
    projectSessionsUnavailableKey: 'claudeSessionsUnavailable', terminalCwdFields: ['cwd'],
}];
const SESSION = {
    id: 'session-final', name: 'Original Name', cwd: '/work/app',
    updatedAt: '2026-07-18T10:01:00Z',
};
const PENDING_RUNTIME = {
    identity: { provider: 'codex', pendingId: 'pending-runtime', projectKey: 'pk', cwd: '/work/app' },
    backend: 'tmux', state: 'pending', markerPath: '/tmp/pending.done',
    runStartedAtMs: Date.parse('2026-07-18T10:00:00Z'), attached: false,
    tmux: { layout: 'project', sessionName: 'project-steward-p-a', windowName: 'pending-codex-a' },
    createdAt: '2026-07-18T10:00:00Z', excludedSessionIds: [], title: 'Promoted Alias',
};
const FINAL_RUNTIME = {
    identity: { provider: 'codex', sessionId: SESSION.id, projectKey: 'pk', cwd: '/work/app' },
    backend: 'tmux', state: 'active', markerPath: '/tmp/pending.done',
    runStartedAtMs: PENDING_RUNTIME.runStartedAtMs, attached: false,
    tmux: { layout: 'project', sessionName: 'project-steward-p-a', windowName: 'ai-codex-a' },
};

function createHarness(options = {}) {
    const sessionProvider = options.providerId || 'codex';
    const aliases = {};
    const aliasesSet = [];
    const syncs = [];
    const diagnostics = [];
    const promotions = [];
    const terminalService = {
        pending: options.legacyPending ? [options.legacyPending] : [], tracked: [],
        getPendingTerminals() { return this.pending; },
        getTrackedSessionKeys() { return new Set(); },
        track(providerId, sessionId, entry) { this.tracked.push([providerId, sessionId, entry]); },
        replacePendingTerminals(pending) { this.pending = pending; },
        trackPending(pending) { this.pending.push(pending); },
    };
    const controller = new AiSessionProjectHydrationController({
        getWorkspaceFile: () => null,
        getWorkspaceFolders: () => null,
        getRefreshReason: () => 'refresh',
        incrementalScanMaxFiles: 123,
        getProviders: () => PROVIDERS,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        readCoordinator: {
            getResults: () => Object.fromEntries(PROVIDERS.map(provider => [provider.id, {
                available: true,
                scannedFiles: provider.id === sessionProvider ? 1 : 0,
                parsedFiles: provider.id === sessionProvider ? 1 : 0,
                sessions: provider.id === sessionProvider ? [SESSION] : [],
            }])),
            getAssignments: () => Object.fromEntries(PROVIDERS.map(provider => [
                provider.id,
                provider.id === sessionProvider ? new Map([['project-a', [SESSION]]]) : new Map(),
            ])),
        },
        terminalService,
        ...(options.runtimeCoordinator ? { runtimeCoordinator: options.runtimeCoordinator } : {}),
        setAlias: (providerId, sessionId, alias) => {
            aliases[`${providerId}:${sessionId}`] = alias;
            aliasesSet.push([providerId, sessionId, alias]);
        },
        syncActiveTerminal: () => {
            syncs.push('sync');
            options.onSync?.();
        },
        onDidPromoteRuntime: () => {
            promotions.push('promoted');
            options.onPromoted?.();
        },
        getSessionComparableCwd: (_providerId, session) => session.cwd,
        getExpandedProjects: () => new Set(),
        getActiveProviders: () => ({}),
        getPinnedSessions: () => new Set(),
        getAliases: () => ({ ...aliases }),
        getAttentionAggregate: () => ({
            protocolVersion: 1, aggregateRevision: '3'.repeat(64), generatedAtMs: 1, sessions: [],
        }),
        getLocalAttentionBySession: () => ({}),
        hasRemoteAttentionAggregate: () => false,
        getProjectKey: project => `key:${project.path}`,
        normalizeProjectPath: value => value,
        logDiagnostic: event => diagnostics.push(event),
    });
    return { controller, terminalService, aliases, aliasesSet, syncs, diagnostics, promotions };
}

function project(name = 'Project') {
    return [{ id: 'project-a', path: '/work/app', name }];
}

async function flushSettlements() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

test('PERSIST-AI-SESSION-PROJECT-HYDRATION-PROMOTION-001 shares single-flight work and cancels stale generations', async () => {
    let resolveDelayed;
    let delayedCalls = 0;
    const delayedPromotion = new Promise(resolve => { resolveDelayed = resolve; });
    const delayed = createHarness({
        runtimeCoordinator: {
            getActive: () => [], getPending: () => [PENDING_RUNTIME],
            promotePending: () => { delayedCalls++; return delayedPromotion; },
        },
    });
    const first = delayed.controller.hydrate(project());
    const second = delayed.controller.hydrate(project());
    assert.equal(delayedCalls, 1, 'same pending identity must start only one production settlement');
    assert.equal(first, second, 'same-generation hydration must share the cached projection');
    assert.equal(first[0].codexSessions[0].name, 'Original Name');
    resolveDelayed([FINAL_RUNTIME]);
    await flushSettlements();
    assert.equal(first[0].codexSessions[0].name, 'Promoted Alias');
    assert.equal(second[0].codexSessions[0].name, 'Promoted Alias');
    assert.deepEqual(delayed.aliasesSet, [['codex', 'session-final', 'Promoted Alias']]);
    assert.deepEqual(delayed.syncs, ['sync']);
    assert.deepEqual(delayed.promotions, ['promoted']);

    let resolveGeneration;
    let generationCalls = 0;
    const generationPromotion = new Promise(resolve => { resolveGeneration = resolve; });
    const generations = createHarness({
        runtimeCoordinator: {
            getActive: () => [], getPending: () => [PENDING_RUNTIME],
            promotePending: () => { generationCalls++; return generationPromotion; },
        },
    });
    const stale = generations.controller.hydrate(project('Stale generation'));
    const current = generations.controller.hydrate(project('Current generation'));
    assert.equal(generationCalls, 1, 'different generations must still share one pending settlement');
    resolveGeneration([FINAL_RUNTIME]);
    await flushSettlements();
    assert.equal(current[0].name, 'Current generation');
    assert.equal(current[0].codexSessions[0].name, 'Promoted Alias');
    assert.equal(stale[0].codexSessions[0].name, 'Original Name');
    assert.deepEqual(generations.aliasesSet, [['codex', 'session-final', 'Promoted Alias']]);
    assert.deepEqual(generations.syncs, ['sync']);
    assert.deepEqual(generations.promotions, ['promoted']);

    let resolveCancelled;
    let cancelledCalls = 0;
    const cancelledPromotion = new Promise(resolve => { resolveCancelled = resolve; });
    const cancelled = createHarness({
        runtimeCoordinator: {
            getActive: () => [], getPending: () => [PENDING_RUNTIME],
            promotePending: () => { cancelledCalls++; return cancelledPromotion; },
        },
    });
    const cancelledProjection = cancelled.controller.hydrate(project('Cancelled generation'));
    cancelled.controller.hydrate([]);
    resolveCancelled([FINAL_RUNTIME]);
    await flushSettlements();
    assert.equal(cancelledCalls, 1);
    assert.equal(cancelledProjection[0].codexSessions[0].name, 'Original Name');
    assert.deepEqual(cancelled.aliasesSet, []);
    assert.deepEqual(cancelled.syncs, []);
    assert.deepEqual(cancelled.promotions, []);
});

test('PERSIST-AI-SESSION-PROJECT-HYDRATION-PROMOTION-001 completes consumed async handoff and memoizes synchronous re-entry', async () => {
    let visiblePending = [PENDING_RUNTIME];
    let resolveConsumed;
    let evaluationCount = 0;
    const consumedPromotion = new Promise(resolve => { resolveConsumed = resolve; });
    const executionController = new AiSessionExecutionController({
        getActiveSessions: () => visiblePending.length ? [] : [{
            provider: FINAL_RUNTIME.identity.provider,
            sessionId: FINAL_RUNTIME.identity.sessionId,
            cwd: FINAL_RUNTIME.identity.cwd,
            runStartedAtMs: FINAL_RUNTIME.runStartedAtMs,
        }],
        getProviders: () => [{
            id: 'codex', service: { getLifecycleSignals: () => {
                evaluationCount++;
                return { [SESSION.id]: {
                    token: `codex:async-run:${SESSION.id}`, phase: 'running', executionState: 'running',
                    occurredAtMs: PENDING_RUNTIME.runStartedAtMs + 1000,
                } };
            } },
        }],
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        scheduleRefresh: () => undefined,
        nowMs: () => PENDING_RUNTIME.runStartedAtMs,
    });
    const consumed = createHarness({
        runtimeCoordinator: {
            getActive: () => visiblePending.length ? [] : [FINAL_RUNTIME],
            getPending: () => visiblePending,
            promotePending: () => consumedPromotion,
        },
        onPromoted: () => executionController.evaluate(),
    });
    consumed.controller.hydrate(project('Promotion started'));
    visiblePending = [];
    consumed.controller.hydrate(project('Backend consumed pending'));
    assert.deepEqual(executionController.getSnapshot(), {});
    resolveConsumed([FINAL_RUNTIME]);
    await flushSettlements();
    assert.deepEqual(consumed.promotions, ['promoted']);
    assert.deepEqual(consumed.aliasesSet, [['codex', 'session-final', 'Promoted Alias']]);
    assert.equal(consumed.diagnostics.some(diagnostic =>
        diagnostic.event === 'ai-session-pending-runtime-promotion-result'
        && diagnostic.failureReasons?.includes('stale-pending')), false);
    assert.equal(executionController.getSnapshot()['codex:session-final'].state, 'running');
    assert.equal(evaluationCount, 1);

    let syncReentered = false;
    let syncController;
    let syncCalls = 0;
    const syncReentry = createHarness({
        runtimeCoordinator: {
            getActive: () => [], getPending: () => [PENDING_RUNTIME],
            promotePending: () => { syncCalls++; return [FINAL_RUNTIME]; },
        },
        onSync: () => {
            if (!syncReentered) {
                syncReentered = true;
                syncController.hydrate(project('Synchronous sync reentry'));
            }
        },
    });
    syncController = syncReentry.controller;
    syncController.hydrate(project('Initial sync'));
    await flushSettlements();
    assert.equal(syncCalls, 1);
    assert.deepEqual(syncReentry.aliasesSet, [['codex', 'session-final', 'Promoted Alias']]);
    assert.deepEqual(syncReentry.syncs, ['sync']);
    assert.deepEqual(syncReentry.promotions, ['promoted']);

    let notificationReentered = false;
    let notificationController;
    let notificationCalls = 0;
    const notificationReentry = createHarness({
        runtimeCoordinator: {
            getActive: () => [], getPending: () => [PENDING_RUNTIME],
            promotePending: () => { notificationCalls++; return [FINAL_RUNTIME]; },
        },
        onPromoted: () => {
            if (!notificationReentered) {
                notificationReentered = true;
                notificationController.hydrate(project('Promotion notification reentry'));
            }
        },
    });
    notificationController = notificationReentry.controller;
    notificationController.hydrate(project('Initial promotion notification'));
    await flushSettlements();
    assert.equal(notificationCalls, 1);
    assert.deepEqual(notificationReentry.promotions, ['promoted']);
    assert.deepEqual(notificationReentry.aliasesSet, [['codex', 'session-final', 'Promoted Alias']]);
    assert.deepEqual(notificationReentry.syncs, ['sync']);

    const notificationFailure = createHarness({
        runtimeCoordinator: {
            getActive: () => [], getPending: () => [PENDING_RUNTIME],
            promotePending: () => [FINAL_RUNTIME],
        },
        onPromoted: () => { throw new TypeError('do not expose this text'); },
    });
    notificationFailure.controller.hydrate(project('Notification failure'));
    await flushSettlements();
    assert.deepEqual(notificationFailure.aliasesSet, [['codex', 'session-final', 'Promoted Alias']]);
    assert.ok(notificationFailure.diagnostics.some(diagnostic =>
        diagnostic.event === 'ai-session-runtime-promotion-notification-failed'
        && diagnostic.category === 'TypeError'));
    assert.equal(JSON.stringify(notificationFailure.diagnostics).includes('do not expose this text'), false);
});

test('PERSIST-AI-SESSION-PROJECT-HYDRATION-PROMOTION-001 hands Direct and tmux Codex, Kimi, and Claude runtimes to execution immediately', async () => {
    const fixtures = [];
    for (const providerId of ['codex', 'kimi', 'claude']) {
        fixtures.push({ providerId, backend: 'vscode', layout: 'direct' });
        fixtures.push({ providerId, backend: 'tmux', layout: 'project' });
        fixtures.push({ providerId, backend: 'tmux', layout: 'session' });
    }
    for (const fixture of fixtures) {
        const pending = {
            ...PENDING_RUNTIME,
            identity: { ...PENDING_RUNTIME.identity, provider: fixture.providerId },
            backend: fixture.backend,
            attached: fixture.backend === 'vscode',
            tmux: fixture.backend === 'tmux' ? {
                layout: fixture.layout,
                sessionName: fixture.layout === 'project'
                    ? `project-steward-p-${fixture.providerId}`
                    : `project-steward-s-${fixture.providerId}`,
                ...(fixture.layout === 'project' ? { windowName: `ai-${fixture.providerId}-a` } : {}),
            } : undefined,
        };
        const finalRuntime = {
            ...FINAL_RUNTIME,
            identity: { ...FINAL_RUNTIME.identity, provider: fixture.providerId },
            backend: fixture.backend,
            attached: fixture.backend === 'vscode',
            tmux: pending.tmux,
        };
        let active = [];
        let pendingRuntimes = [pending];
        const runtimeCoordinator = {
            getActive: () => active,
            getPending: () => pendingRuntimes,
            promotePending: () => {
                active = [finalRuntime];
                pendingRuntimes = [];
                return [finalRuntime];
            },
        };
        let signal = {
            token: `${fixture.providerId}:first-run:${SESSION.id}`,
            phase: 'running', executionState: 'running',
            occurredAtMs: PENDING_RUNTIME.runStartedAtMs + 1000,
        };
        let evaluationCount = 0;
        const executionController = new AiSessionExecutionController({
            getActiveSessions: () => active.map(runtime => ({
                provider: runtime.identity.provider, sessionId: runtime.identity.sessionId,
                cwd: runtime.identity.cwd, runStartedAtMs: runtime.runStartedAtMs,
            })),
            getProviders: () => [{
                id: fixture.providerId,
                service: { getLifecycleSignals: () => {
                    evaluationCount++;
                    return { [SESSION.id]: signal };
                } },
            }],
            getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
            scheduleRefresh: () => undefined,
            nowMs: () => PENDING_RUNTIME.runStartedAtMs,
        });
        const handoff = createHarness({
            providerId: fixture.providerId,
            runtimeCoordinator,
            onPromoted: () => executionController.evaluate(),
        });
        handoff.controller.hydrate(project(`${fixture.providerId} ${fixture.layout} handoff`));
        await flushSettlements();
        const sessionKey = `${fixture.providerId}:${SESSION.id}`;
        assert.equal(executionController.getSnapshot()[sessionKey].state, 'running');
        assert.equal(evaluationCount, 1, `${fixture.providerId}/${fixture.layout} must evaluate once`);
        assert.equal(finalRuntime.runStartedAtMs, pending.runStartedAtMs);

        signal = {
            token: `${fixture.providerId}:first-stop:${SESSION.id}`,
            phase: 'needsAttention', reason: 'completed', executionState: 'stopped',
            occurredAtMs: PENDING_RUNTIME.runStartedAtMs + 2000,
        };
        executionController.evaluate();
        assert.equal(executionController.getSnapshot()[sessionKey].state, 'stopped');
        signal = {
            token: `${fixture.providerId}:later-run:${SESSION.id}`,
            phase: 'running', executionState: 'running',
            occurredAtMs: PENDING_RUNTIME.runStartedAtMs + 3000,
        };
        executionController.evaluate();
        assert.equal(executionController.getSnapshot()[sessionKey].state, 'running');
        signal = {
            token: `${fixture.providerId}:later-stop:${SESSION.id}`,
            phase: 'needsAttention', reason: 'completed', executionState: 'stopped',
            occurredAtMs: PENDING_RUNTIME.runStartedAtMs + 4000,
        };
        executionController.evaluate();
        assert.equal(executionController.getSnapshot()[sessionKey].state, 'stopped');
    }
});

test('PERSIST-AI-SESSION-PROJECT-HYDRATION-PROMOTION-001 retires memos, retries failures, deduplicates conflicts, and synchronously promotes legacy Direct terminals', async () => {
    let visiblePending = [PENDING_RUNTIME];
    let lifecycleCalls = 0;
    const lifecycle = createHarness({
        runtimeCoordinator: {
            getActive: () => [], getPending: () => visiblePending,
            promotePending: () => { lifecycleCalls++; return [FINAL_RUNTIME]; },
        },
    });
    lifecycle.controller.hydrate(project('First lifecycle'));
    await flushSettlements();
    visiblePending = [];
    lifecycle.controller.hydrate(project('Pending absent'));
    visiblePending = [PENDING_RUNTIME];
    lifecycle.controller.hydrate(project('Second lifecycle'));
    await flushSettlements();
    assert.equal(lifecycleCalls, 2, 'successful memo must retire after the pending identity disappears');
    assert.equal(lifecycle.aliasesSet.length, 2);
    assert.equal(lifecycle.syncs.length, 2);

    let retryCalls = 0;
    const retry = createHarness({
        runtimeCoordinator: {
            getActive: () => [], getPending: () => [PENDING_RUNTIME],
            promotePending: async () => {
                retryCalls++;
                if (retryCalls === 1) throw new Error('first promotion failed');
                return [FINAL_RUNTIME];
            },
        },
    });
    retry.controller.hydrate(project('Failed generation'));
    await flushSettlements();
    const retried = retry.controller.hydrate(project('Retry generation'));
    await flushSettlements();
    assert.equal(retryCalls, 2);
    assert.equal(retried[0].codexSessions[0].name, 'Promoted Alias');
    assert.deepEqual(retry.syncs, ['sync']);

    for (const fixture of [
        { backend: 'vscode', reason: 'conflict' },
        { backend: 'vscode', reason: 'promotion-error' },
        { backend: 'tmux', reason: 'conflict' },
        { backend: 'tmux', reason: 'promotion-error' },
    ]) {
        const pending = {
            ...PENDING_RUNTIME, backend: fixture.backend, attached: fixture.backend === 'vscode',
            ...(fixture.backend === 'vscode' ? { tmux: undefined } : {}),
        };
        const finalRuntime = {
            ...FINAL_RUNTIME, backend: fixture.backend, attached: fixture.backend === 'vscode',
            ...(fixture.backend === 'vscode' ? { tmux: undefined } : {}),
        };
        let allowSuccess = false;
        let calls = 0;
        const duplicate = createHarness({
            runtimeCoordinator: {
                getActive: () => [],
                getPending: () => [pending, {
                    ...pending, identity: { ...pending.identity },
                    title: 'Duplicate title must not produce another attempt',
                }],
                promotePending: async () => {
                    calls++;
                    if (allowSuccess) return [finalRuntime];
                    if (fixture.reason === 'promotion-error') throw new Error('fixture rejection');
                    return [{ ...finalRuntime, state: 'conflict' }];
                },
            },
        });
        duplicate.controller.hydrate(project(`${fixture.backend} duplicate failure`));
        await flushSettlements();
        assert.equal(calls, 1, 'duplicate pending identities must produce one attempt');
        const failures = duplicate.diagnostics.filter(diagnostic =>
            diagnostic.event === 'ai-session-pending-runtime-promotion-result');
        assert.equal(failures.length, 1);
        assert.deepEqual(failures[0].failureReasons, [fixture.reason]);
        assert.deepEqual(duplicate.aliasesSet, []);
        assert.deepEqual(duplicate.syncs, []);

        allowSuccess = true;
        const recovered = duplicate.controller.hydrate(project(`${fixture.backend} retry`));
        await flushSettlements();
        assert.equal(calls, 2);
        assert.equal(recovered[0].codexSessions[0].name, 'Promoted Alias');
        assert.equal(duplicate.aliasesSet.length, 1);
        assert.deepEqual(duplicate.syncs, ['sync']);
    }

    const legacyPending = {
        provider: 'codex', terminal: { name: 'Legacy pending' }, markerPath: '/tmp/legacy.done',
        cwd: '/work/app', createdAt: '2026-07-18T10:00:00Z', excludedSessionIds: [],
        title: 'Legacy Alias',
    };
    const legacy = createHarness({ legacyPending });
    const legacyHydrated = legacy.controller.hydrate(project('Legacy'));
    assert.equal(legacyHydrated[0].codexSessions[0].name, 'Legacy Alias');
    assert.deepEqual(legacy.aliasesSet, [['codex', 'session-final', 'Legacy Alias']]);
});
