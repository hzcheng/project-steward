'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { createFakeClock } = require('./fakeClock');
const { makeTempDirectory } = require('./tempDirectory');
const { DirectTerminalRuntimeBackend } = require('../../out/aiSessions/directTerminalRuntimeBackend');
const { TmuxRuntimeBackend } = require('../../out/aiSessions/tmuxRuntimeBackend');
const { TmuxRuntimeDiscovery } = require('../../out/aiSessions/tmuxRuntimeDiscovery');
const { ProjectTmuxLayout, SessionTmuxLayout } = require('../../out/aiSessions/tmuxLayout');
const { TmuxClientError } = require('../../out/aiSessions/tmuxClient');

const FIXED_NOW = Date.parse('2026-07-18T10:00:00.000Z');

function createRuntimeFilesystemFixture(testContext, prefix = 'project-steward-runtime-contract-') {
    const root = makeTempDirectory(testContext, prefix);
    return {
        root,
        resolve: (...segments) => path.join(root, ...segments),
    };
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function fakeRuntime(backend, sessionId, overrides = {}) {
    return {
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId },
        backend,
        state: 'active',
        markerPath: '/tmp/runtime-contract.done',
        runStartedAtMs: FIXED_NOW,
        attached: true,
        ...overrides,
    };
}

function fakeResumeRequest(sessionId, overrides = {}) {
    return {
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId },
        projectName: 'Fixture Project',
        terminalName: `Codex: ${sessionId}`,
        launch: {
            executable: 'codex',
            args: ['resume', sessionId],
            markerPath: `/tmp/${sessionId}.done`,
        },
        ...overrides,
    };
}

function fakeCreateRequest(pendingId, overrides = {}) {
    return {
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', pendingId },
        projectName: 'Fixture Project',
        terminalName: `Codex: ${pendingId}`,
        createdAt: '2026-07-18T10:00:00.000Z',
        excludedSessionIds: ['excluded'],
        title: 'Fixture task',
        launch: {
            executable: 'codex',
            args: [],
            markerPath: `/tmp/${pendingId}.done`,
        },
        ...overrides,
    };
}

function createFakeRuntimeBackend(backend, options = {}) {
    const fake = {
        active: [], pending: [], conflicts: [], lifecycleBlockers: [],
        refreshCalls: [], focusCalls: [], detachCalls: [], promoted: [], closed: [],
        ensureResumeCalls: 0, ensurePendingCalls: 0,
    };
    fake.refresh = async force => {
        fake.refreshCalls.push(force);
        if (options.refreshError) throw options.refreshError;
        options.onRefresh?.(fake, force);
    };
    fake.getActive = () => fake.active.map(cloneRuntime);
    fake.getPending = () => fake.pending.map(clonePendingRuntime);
    fake.getConflicts = () => fake.conflicts.map(cloneRuntime);
    fake.getLifecycleBlockers = () => fake.lifecycleBlockers.map(cloneRuntime);
    fake.find = identity => fake.getActive().filter(runtime =>
        runtime.identity.provider === identity.provider
        && runtime.identity.sessionId === identity.sessionId);
    fake.focus = async runtime => { fake.focusCalls.push(cloneRuntime(runtime)); };
    fake.detach = async runtime => { fake.detachCalls.push(cloneRuntime(runtime)); };
    fake.ensureResume = async (request, layout) => {
        fake.ensureResumeCalls += 1;
        if (options.resumeGate) await options.resumeGate.promise;
        if (options.ensureError) throw options.ensureError;
        const runtime = fakeRuntime(backend, request.identity.sessionId, backend === 'tmux' ? {
            attached: false,
            tmux: layout === 'project'
                ? { layout, sessionName: 'managed', windowName: `ai-${request.identity.sessionId}` }
                : { layout, sessionName: `managed-${request.identity.sessionId}` },
        } : {});
        fake.active.push(runtime);
        return cloneRuntime(runtime);
    };
    fake.ensurePending = async (request, layout) => {
        fake.ensurePendingCalls += 1;
        if (options.pendingGate) await options.pendingGate.promise;
        if (options.ensureError) throw options.ensureError;
        const runtime = fakeRuntime(backend, undefined, {
            identity: { ...request.identity }, state: 'pending',
            createdAt: request.createdAt,
            excludedSessionIds: [...request.excludedSessionIds],
            title: request.title,
            ...(backend === 'tmux' ? {
                attached: false,
                tmux: layout === 'project'
                    ? { layout, sessionName: 'managed', windowName: `pending-${request.identity.pendingId}` }
                    : { layout, sessionName: `pending-${request.identity.pendingId}` },
            } : {}),
        });
        fake.pending.push(runtime);
        return clonePendingRuntime(runtime);
    };
    fake.promotePending = async (pendingId, sessionId) => {
        fake.promoted.push({ pendingId, sessionId });
        return [fakeRuntime(backend, sessionId)];
    };
    fake.handleClosedTerminal = terminal => { fake.closed.push(terminal); };
    return fake;
}

function createDirectRuntimeHarness() {
    const operations = [];
    const tracked = [];
    const pending = [];
    const completed = new Set();
    let nextTerminalId = 1;

    const terminalService = {
        getTrackedTerminalEntries: () => tracked.map(entry => ({ ...entry })),
        getPendingTerminals: () => pending.map(entry => ({
            ...entry, excludedSessionIds: [...entry.excludedSessionIds],
        })),
        isComplete: entry => completed.has(entry.terminal),
        createTerminal: options => {
            const terminal = { id: nextTerminalId++, name: options.name };
            operations.push({ type: 'create-terminal', terminal, options });
            return { terminal, cwdAccepted: true };
        },
        getProviderTerminalEnvironment: (provider, sessionId) => ({
            AI_PROVIDER: provider, AI_SESSION: sessionId,
        }),
        sendRuntimeLaunch: async (terminal, launch, options) => {
            operations.push({ type: 'launch', terminal, launch: { ...launch }, options: { ...options } });
        },
        track: (provider, sessionId, entry) => {
            const index = tracked.findIndex(candidate =>
                candidate.provider === provider && candidate.sessionId === sessionId);
            const value = { provider, sessionId, ...entry };
            if (index >= 0) tracked.splice(index, 1, value);
            else tracked.push(value);
            operations.push({ type: 'track', provider, sessionId, terminal: entry.terminal });
        },
        trackPending: entry => {
            pending.push({ ...entry, excludedSessionIds: [...entry.excludedSessionIds] });
            operations.push({ type: 'track-pending', terminal: entry.terminal });
        },
        replacePendingTerminals: entries => {
            pending.splice(0, pending.length, ...entries.map(entry => ({
                ...entry, excludedSessionIds: [...entry.excludedSessionIds],
            })));
        },
        focusTerminal: terminal => { operations.push({ type: 'focus', terminal }); },
        closeTerminal: terminal => { operations.push({ type: 'close', terminal }); },
        handleClosedTerminal: terminal => {
            for (let index = tracked.length - 1; index >= 0; index -= 1) {
                if (tracked[index].terminal === terminal) tracked.splice(index, 1);
            }
            for (let index = pending.length - 1; index >= 0; index -= 1) {
                if (pending[index].terminal === terminal) pending.splice(index, 1);
            }
            operations.push({ type: 'closed', terminal });
        },
    };
    const backend = new DirectTerminalRuntimeBackend(terminalService, () => FIXED_NOW);
    return {
        backend,
        operations,
        tracked,
        pending,
        providerCreateCount: () => operations.filter(item => item.type === 'launch').length,
        viewerCount: () => operations.filter(item => item.type === 'create-terminal').length,
        focusCount: () => operations.filter(item => item.type === 'focus').length,
        detachCount: () => operations.filter(item => item.type === 'close').length,
        notifyClosed: runtime => backend.handleClosedTerminal(runtime.terminal),
        async markCompleted(runtime) {
            completed.add(runtime.terminal);
        },
        async markStopped(runtime) {
            const entry = tracked.find(candidate => candidate.terminal === runtime.terminal);
            if (entry) entry.released = true;
        },
        installCollision(identity) {
            const first = { name: 'duplicate-one' };
            const second = { name: 'duplicate-two' };
            tracked.push({
                provider: identity.provider, sessionId: identity.sessionId, terminal: first,
                markerPath: '/tmp/one.done', runStartedAtMs: 1, cwd: identity.cwd,
            }, {
                provider: identity.provider, sessionId: identity.sessionId, terminal: second,
                markerPath: '/tmp/two.done', runStartedAtMs: 2, cwd: identity.cwd,
            });
        },
    };
}

function createSyntheticTmuxStore(initial = {}) {
    const pending = new Map((initial.pending || []).map(value => [value.pendingId, cloneBinding(value)]));
    const known = new Map((initial.known || []).map(value => [
        `${value.provider}:${value.sessionId}`, cloneBinding(value),
    ]));
    const inactive = new Map((initial.inactive || []).map(value => [
        `${value.provider}:${value.sessionId}`, cloneBinding(value),
    ]));
    const ambiguous = new Map();
    const consumed = new Map();
    const promoting = new Map();
    const identityKey = identity => JSON.stringify([
        identity.provider, identity.projectKey,
        identity.sessionId === undefined ? 'pending' : 'session',
        identity.sessionId === undefined ? identity.pendingId : identity.sessionId,
    ]);
    const store = {
        pending, known, inactive, ambiguous, consumed, promoting,
        listPending: async () => [...pending.values()].map(cloneBinding),
        getPending: async pendingId => cloneBinding(pending.get(pendingId) || null),
        setPending: async record => { pending.set(record.pendingId, cloneBinding(record)); return true; },
        removePending: async pendingId => { pending.delete(pendingId); },
        listKnown: async () => [...known.values()].map(cloneBinding),
        getKnown: async (provider, sessionId) => cloneBinding(known.get(`${provider}:${sessionId}`) || null),
        setKnown: async record => { known.set(`${record.provider}:${record.sessionId}`, cloneBinding(record)); },
        removeKnown: async (provider, sessionId) => { known.delete(`${provider}:${sessionId}`); },
        listInactive: async () => [...inactive.values()].map(cloneBinding),
        setInactive: async record => { inactive.set(`${record.provider}:${record.sessionId}`, cloneBinding(record)); },
        transitionKnownToInactive: async (record, expectedLastSeenAtMs) => {
            const key = `${record.provider}:${record.sessionId}`;
            const current = known.get(key);
            if (!current || current.lastSeenAtMs !== expectedLastSeenAtMs) return false;
            known.delete(key);
            inactive.set(key, cloneBinding(record));
            return true;
        },
        acknowledgeInactive: async expected => {
            const key = `${expected.provider}:${expected.sessionId}`;
            const current = inactive.get(key);
            if (!current) return 'missing';
            if (JSON.stringify(current) !== JSON.stringify(expected)) return 'stale';
            inactive.delete(key);
            return 'acknowledged';
        },
        reconcileKnown: async runtimes => {
            for (const runtime of runtimes) {
                if (!runtime.identity.sessionId || !runtime.tmux) continue;
                const key = `${runtime.identity.provider}:${runtime.identity.sessionId}`;
                known.set(key, makeTmuxKnownBinding(runtime.identity.sessionId, {
                    provider: runtime.identity.provider,
                    projectKey: runtime.identity.projectKey,
                    cwd: runtime.identity.cwd,
                    layout: runtime.tmux.layout,
                    locator: runtime.tmux,
                    markerPath: runtime.markerPath,
                    runStartedAtMs: runtime.runStartedAtMs,
                    lastSeenAtMs: FIXED_NOW,
                }));
                inactive.delete(key);
            }
        },
        getAmbiguous: async identity => cloneBinding(ambiguous.get(identityKey(identity)) || null),
        getAmbiguousByPendingId: async pendingId => uniquePendingValue(ambiguous, pendingId),
        setAmbiguous: async record => { ambiguous.set(identityKey(record), cloneBinding(record)); return true; },
        removeAmbiguous: async identity => { ambiguous.delete(identityKey(identity)); },
        getConsumed: async identity => cloneBinding(consumed.get(identityKey(identity)) || null),
        getConsumedByPendingId: async pendingId => uniquePendingValue(consumed, pendingId),
        setConsumed: async record => { consumed.set(identityKey(record), cloneBinding(record)); return true; },
        getPromoting: async identity => cloneBinding(promoting.get(identityKey(identity)) || null),
        getPromotingByPendingId: async pendingId => uniquePendingValue(promoting, pendingId),
        setPromoting: async record => { promoting.set(identityKey(record), cloneBinding(record)); return true; },
        removePromoting: async identity => { promoting.delete(identityKey(identity)); },
    };
    return store;
}

async function uniquePendingValue(values, pendingId) {
    const matches = [...values.values()].filter(value => value.pendingId === pendingId);
    if (matches.length > 1) throw new Error('Multiple synthetic records use the pending ID.');
    return cloneBinding(matches[0] || null);
}

function createTmuxRuntimeHarness(layout, options = {}) {
    const operations = [];
    const windows = [];
    const terminals = [];
    const attachBindings = new Map();
    const store = createSyntheticTmuxStore();
    const lockQueues = new Map();
    let attachQueue = Promise.resolve();
    let nextWindowId = 1;
    let nextProcessId = 100;
    let availability = options.availability || { available: true, version: '3.4' };
    let listError = null;
    let markerCurrent = false;

    const addWindow = (sessionName, windowName) => {
        const row = {
            sessionName, windowName, windowId: `@${nextWindowId++}`, active: false,
            sessionMetadata: {}, windowMetadata: {}, metadata: {},
        };
        windows.push(row);
        return row;
    };
    const syncMetadata = row => {
        row.metadata = { ...row.sessionMetadata, ...row.windowMetadata };
    };
    const client = {
        checkAvailability: async () => { operations.push({ type: 'availability' }); return availability; },
        getExecutablePath: () => '/fixtures/bin/tmux',
        listWindows: async () => {
            operations.push({ type: 'list-windows' });
            if (listError) throw listError;
            return windows.map(cloneWindow);
        },
        getActiveWindow: async sessionName => {
            const active = windows.filter(row => row.sessionName === sessionName && row.active);
            return active.length === 1 ? {
                sessionName: active[0].sessionName,
                windowName: active[0].windowName,
                windowId: active[0].windowId,
            } : null;
        },
        hasSession: async sessionName => windows.some(row => row.sessionName === sessionName),
        createSession: async (sessionName, windowName, cwd, command) => {
            operations.push({ type: 'new-session', sessionName, windowName, cwd, command });
            if (windows.some(row => row.sessionName === sessionName)) {
                throw new TmuxClientError('create-session', 'nonzero-exit');
            }
            addWindow(sessionName, windowName);
        },
        createWindow: async (sessionName, windowName, cwd, command) => {
            operations.push({ type: 'new-window', sessionName, windowName, cwd, command });
            addWindow(sessionName, windowName);
        },
        renameSession: async (sessionName, nextName) => {
            operations.push({ type: 'rename-session', sessionName, nextName });
            windows.filter(row => row.sessionName === sessionName)
                .forEach(row => { row.sessionName = nextName; });
        },
        renameWindow: async (sessionName, windowName, nextName) => {
            operations.push({ type: 'rename-window', sessionName, windowName, nextName });
            const row = windows.find(value => value.sessionName === sessionName
                && value.windowName === windowName);
            if (row) row.windowName = nextName;
        },
        selectWindow: async locator => {
            operations.push({ type: 'select-window', locator: { ...locator } });
            windows.forEach(row => {
                row.active = row.sessionName === locator.sessionName
                    && (!locator.windowName || row.windowName === locator.windowName);
            });
        },
        setSessionOptions: async (sessionName, values) => {
            operations.push({ type: 'session-options', sessionName, values: { ...values } });
            windows.filter(row => row.sessionName === sessionName).forEach(row => {
                row.sessionMetadata = { ...row.sessionMetadata, ...values };
                syncMetadata(row);
            });
        },
        setWindowOptions: async (sessionName, windowName, values) => {
            operations.push({ type: 'window-options', sessionName, windowName, values: { ...values } });
            const row = windows.find(value => value.sessionName === sessionName
                && value.windowName === windowName);
            if (row) {
                row.windowMetadata = { ...row.windowMetadata, ...values };
                syncMetadata(row);
            }
        },
        getSessionOptions: async sessionName => {
            const row = windows.find(value => value.sessionName === sessionName);
            return row ? { ...row.sessionMetadata } : {};
        },
        getWindowOptions: async (sessionName, windowName) => {
            const row = windows.find(value => value.sessionName === sessionName
                && value.windowName === windowName);
            return row ? { ...row.windowMetadata } : {};
        },
        configureManagedWindow: async (sessionName, windowName) => {
            operations.push({ type: 'configure-window', sessionName, windowName });
        },
        clearPendingMetadata: async locator => {
            operations.push({ type: 'clear-pending', locator: { ...locator } });
            windows.filter(row => row.sessionName === locator.sessionName
                && (!locator.windowName || row.windowName === locator.windowName)).forEach(row => {
                delete row.sessionMetadata.pendingId;
                delete row.windowMetadata.pendingId;
                syncMetadata(row);
            });
        },
    };
    const discovery = new TmuxRuntimeDiscovery({
        client,
        bindingStore: store,
        markerIsCurrent: () => markerCurrent,
        nowMs: () => FIXED_NOW,
        cacheTtlMs: 0,
    });
    const attachStore = {
        get: processId => cloneBinding(attachBindings.get(processId) || null),
        set: (processId, binding) => {
            attachQueue = attachQueue.then(() => Promise.resolve(processId)).then(value => {
                if (typeof value === 'number') attachBindings.set(value, cloneBinding(binding));
            });
        },
        remove: processId => {
            attachQueue = attachQueue.then(() => Promise.resolve(processId)).then(value => {
                if (typeof value === 'number') attachBindings.delete(value);
            });
        },
        flush: () => attachQueue,
    };
    const dependencies = {
        platform: 'linux', client, discovery, runtimeStore: store, attachStore,
        withCreationLock: async (key, operation) => {
            const previous = lockQueues.get(key) || Promise.resolve();
            let release;
            const turn = new Promise(resolve => { release = resolve; });
            lockQueues.set(key, previous.then(() => turn));
            await previous;
            operations.push({ type: 'lock', key });
            try {
                return await operation();
            } finally {
                release();
            }
        },
        createTerminal: creationOptions => {
            operations.push({ type: 'create-terminal', creationOptions });
            const processId = nextProcessId++;
            const terminal = {
                name: creationOptions.name,
                processId: Promise.resolve(processId),
                shown: false,
                disposed: false,
                show() { this.shown = true; operations.push({ type: 'show-terminal', terminal: this }); },
                dispose() { this.disposed = true; operations.push({ type: 'dispose-terminal', terminal: this }); },
            };
            terminals.push(terminal);
            return terminal;
        },
        nowMs: () => FIXED_NOW,
    };
    const backend = new TmuxRuntimeBackend(dependencies);
    return {
        backend, dependencies, discovery, store, operations, windows, terminals,
        providerCreateCount: () => operations.filter(item =>
            (item.type === 'new-session' || item.type === 'new-window')
            && item.command.includes('exit_code=$?')).length,
        viewerCount: () => terminals.length,
        focusCount: () => operations.filter(item => item.type === 'select-window').length,
        detachCount: () => operations.filter(item => item.type === 'dispose-terminal').length,
        notifyClosed: runtime => backend.handleClosedTerminal(runtime.terminal),
        async markCompleted(runtime) {
            markerCurrent = true;
            removeLocatorRows(windows, runtime.tmux);
            await backend.refresh(true);
        },
        async markStopped(runtime) {
            markerCurrent = false;
            removeLocatorRows(windows, runtime.tmux);
            await backend.refresh(true);
        },
        installCollision(identity) {
            const locator = getLayout(layout).getLocator(identity);
            const actual = layout === 'project'
                ? { ...locator, windowName: `${locator.windowName}-occupied` }
                : { ...locator, sessionName: `${locator.sessionName}-occupied` };
            const row = makeTmuxDiscoveryRow({
                provider: identity.provider,
                projectKey: identity.projectKey,
                sessionId: identity.sessionId,
                layout,
                locator: actual,
            });
            windows.push(row);
        },
        setUnavailable(category = 'not-found') {
            availability = { available: false, category, message: 'tmux unavailable' };
        },
        setListError(error) { listError = error; },
    };
}

function removeLocatorRows(windows, locator) {
    for (let index = windows.length - 1; index >= 0; index -= 1) {
        const row = windows[index];
        const matches = row.sessionName === locator.sessionName
            && (locator.layout === 'session' || row.windowName === locator.windowName);
        if (matches) windows.splice(index, 1);
    }
}

function defineRuntimeContract({ backendId, layout, createHarness }) {
    if (typeof createHarness !== 'function') {
        throw new TypeError('defineRuntimeContract requires createHarness');
    }
    const behaviorId = backendId === 'tmux' ? 'RUNTIME-TMUX-BACKEND-001' : 'SESSION-DIRECT-BACKEND-001';
    const label = backendId === 'tmux' ? `tmux ${layout}` : 'Direct';
    const invoke = (backend, method, request) => layout === 'direct'
        ? backend[method](request)
        : backend[method](request, layout);

    test(`${behaviorId} [${label}] creates, reuses, and promotes a pending runtime`, async () => {
        const harness = createHarness();
        const request = fakeCreateRequest(`pending-${layout}`);
        const first = await invoke(harness.backend, 'ensurePending', request);
        const creationCount = harness.providerCreateCount();
        const second = await invoke(harness.backend, 'ensurePending', request);
        assert.equal(first.backend, backendId);
        assert.equal(first.state, 'pending');
        assert.equal(second.identity.pendingId, request.identity.pendingId);
        assert.equal(harness.providerCreateCount(), creationCount, 'pending reuse must not dispatch twice');

        const promoted = await harness.backend.promotePending(
            request.identity.pendingId, `promoted-${layout}`
        );
        assert.equal(promoted.length, 1);
        assert.equal(promoted[0].identity.sessionId, `promoted-${layout}`);
        assert.equal(harness.backend.getPending().some(runtime =>
            runtime.identity.pendingId === request.identity.pendingId), false);
    });

    test(`${behaviorId} [${label}] resumes once, reuses, attaches/focuses, and detaches`, async () => {
        const harness = createHarness();
        const request = fakeResumeRequest(`resume-${layout}`);
        const first = await invoke(harness.backend, 'ensureResume', request);
        const creationCount = harness.providerCreateCount();
        const viewerCount = harness.viewerCount();
        const second = await invoke(harness.backend, 'ensureResume', request);
        assert.equal(first.backend, backendId);
        assert.equal(second.identity.sessionId, request.identity.sessionId);
        assert.equal(harness.providerCreateCount(), creationCount, 'resume reuse must not replay provider command');
        assert.equal(harness.backend.find(request.identity).length, 1);

        await harness.backend.focus(first);
        await harness.backend.detach(first);
        assert.ok(harness.focusCount() >= 1);
        assert.equal(harness.detachCount(), 1);
        if (backendId === 'tmux') {
            await harness.backend.focus(first);
            assert.equal(harness.viewerCount(), viewerCount + 1, 'detached tmux focus creates one viewer only');
            assert.equal(harness.providerCreateCount(), creationCount);
        } else {
            harness.notifyClosed(first);
            assert.equal(harness.backend.find(request.identity).length, 0);
        }
    });

    test(`${behaviorId} [${label}] distinguishes completed and stopped runtime lifecycle`, async () => {
        const completedHarness = createHarness();
        const completed = await invoke(completedHarness.backend, 'ensureResume',
            fakeResumeRequest(`complete-${layout}`));
        await completedHarness.markCompleted(completed);
        assert.deepEqual(completedHarness.backend.getLifecycleBlockers().map(runtime => runtime.state),
            ['completed']);

        const stoppedHarness = createHarness();
        const stopped = await invoke(stoppedHarness.backend, 'ensureResume',
            fakeResumeRequest(`stop-${layout}`));
        await stoppedHarness.markStopped(stopped);
        assert.equal(stoppedHarness.backend.getActive().length, 0);
        if (backendId === 'tmux') {
            assert.deepEqual(stoppedHarness.backend.getLifecycleBlockers().map(runtime => runtime.state),
                ['stopped']);
        }
    });

    test(`${behaviorId} [${label}] fails closed on identity collision or conflict`, async () => {
        const harness = createHarness();
        const request = fakeResumeRequest(`collision-${layout}`);
        harness.installCollision(request.identity);
        await assert.rejects(
            invoke(harness.backend, 'ensureResume', request),
            error => /conflict|multiple/i.test(`${error?.name || ''} ${error?.message || ''}`)
        );
        assert.equal(harness.providerCreateCount(), 0);
    });

    if (backendId === 'tmux') {
        test(`${behaviorId} [${label}] marks cached runtimes stale and rejects unavailable hosts`, async () => {
            const staleHarness = createHarness();
            await invoke(staleHarness.backend, 'ensureResume', fakeResumeRequest(`stale-${layout}`));
            staleHarness.setListError(new Error('isolated list failure'));
            await assert.rejects(staleHarness.backend.refresh(true), /isolated list failure/);
            assert.ok(staleHarness.backend.getActive().every(runtime => runtime.stale === true));

            const unavailableHarness = createHarness();
            unavailableHarness.setUnavailable();
            await assert.rejects(
                invoke(unavailableHarness.backend, 'ensureResume', fakeResumeRequest(`unavailable-${layout}`)),
                error => error?.name === 'TmuxRuntimeUnavailableError'
            );
            assert.equal(unavailableHarness.providerCreateCount(), 0);
        });

        test(`${behaviorId} [${label}] serializes concurrent resume and pending ensure without duplicate provider resources`, async () => {
            const harness = createHarness();
            const request = fakeResumeRequest(`concurrent-${layout}`);
            const runtimes = await Promise.all([
                invoke(harness.backend, 'ensureResume', request),
                invoke(harness.backend, 'ensureResume', request),
            ]);
            assert.deepEqual(runtimes.map(runtime => runtime.identity.sessionId), [
                request.identity.sessionId, request.identity.sessionId,
            ]);
            assert.equal(harness.backend.find(request.identity).length, 1);
            const managed = harness.windows.filter(row =>
                row.sessionMetadata.provider || row.windowMetadata.provider);
            assert.equal(managed.length, 1);

            const pendingHarness = createHarness();
            const pendingRequest = fakeCreateRequest(`concurrent-pending-${layout}`);
            const pendingRuntimes = await Promise.all([
                invoke(pendingHarness.backend, 'ensurePending', pendingRequest),
                invoke(pendingHarness.backend, 'ensurePending', pendingRequest),
            ]);
            assert.deepEqual(pendingRuntimes.map(runtime => runtime.identity.pendingId), [
                pendingRequest.identity.pendingId, pendingRequest.identity.pendingId,
            ]);
            assert.equal(pendingHarness.backend.getPending().filter(runtime =>
                runtime.identity.pendingId === pendingRequest.identity.pendingId).length, 1);
            assert.equal(pendingHarness.providerCreateCount(), 1);
            const pendingManaged = pendingHarness.windows.filter(row =>
                row.sessionMetadata.pendingId || row.windowMetadata.pendingId);
            assert.equal(pendingManaged.length, 1);
            assert.equal((await pendingHarness.store.listPending()).filter(binding =>
                binding.pendingId === pendingRequest.identity.pendingId).length, 1);
        });
    }
}

function makeTmuxPendingBinding(pendingId, overrides = {}) {
    const layout = overrides.layout || 'project';
    const identity = {
        provider: overrides.provider || 'codex',
        projectKey: overrides.projectKey || 'pk',
        cwd: overrides.cwd || '/work',
        pendingId,
    };
    const locator = overrides.locator || getLayout(layout).getPendingLocator(identity);
    return {
        version: 1, state: 'pending', pendingId,
        provider: identity.provider, projectKey: identity.projectKey, cwd: identity.cwd,
        createdAt: overrides.createdAt || '2026-07-18T10:00:00.000Z',
        excludedSessionIds: overrides.excludedSessionIds || [],
        acceptedAtMs: overrides.acceptedAtMs ?? FIXED_NOW,
        layout, locator: { ...locator },
        ...(overrides.title === undefined ? {} : { title: overrides.title }),
    };
}

function makeTmuxKnownBinding(sessionId, overrides = {}) {
    const layout = overrides.layout || 'project';
    const identity = {
        provider: overrides.provider || 'codex',
        projectKey: overrides.projectKey || 'pk',
        cwd: overrides.cwd || '/work',
        sessionId,
    };
    const locator = overrides.locator || getLayout(layout).getLocator(identity);
    return {
        version: 1, state: 'known', provider: identity.provider, sessionId,
        projectKey: identity.projectKey, layout, locator: { ...locator },
        lastSeenAtMs: overrides.lastSeenAtMs ?? FIXED_NOW,
        cwd: identity.cwd,
        markerPath: overrides.markerPath || `/tmp/${sessionId}.done`,
        runStartedAtMs: overrides.runStartedAtMs ?? FIXED_NOW - 1000,
    };
}

function makeTmuxInactiveBinding(sessionId, state = 'completed', overrides = {}) {
    const known = makeTmuxKnownBinding(sessionId, overrides);
    return {
        version: 1, state, provider: known.provider, sessionId,
        projectKey: known.projectKey,
        cwd: overrides.cwd || '/work',
        layout: known.layout,
        locator: { ...known.locator },
        markerPath: overrides.markerPath || `/tmp/${sessionId}.done`,
        runStartedAtMs: overrides.runStartedAtMs ?? FIXED_NOW - 1000,
        detectedAtMs: overrides.detectedAtMs ?? FIXED_NOW,
    };
}

function makeTmuxDiscoveryRow(overrides = {}) {
    const layout = overrides.layout || 'project';
    const identity = {
        provider: overrides.provider || 'codex',
        projectKey: overrides.projectKey || 'pk',
        cwd: '',
        sessionId: overrides.sessionId || 'session-one',
    };
    const expected = getLayout(layout).getLocator(identity);
    const locator = overrides.locator || expected;
    const sessionMetadata = layout === 'project' ? {
        managed: '1', version: '1', layout, projectKey: identity.projectKey,
    } : {
        managed: '1', version: '1', layout, projectKey: identity.projectKey,
        provider: identity.provider, sessionId: identity.sessionId,
        createdAt: '2026-07-18T10:00:00.000Z', marker: `/tmp/${identity.sessionId}.done`,
    };
    const windowMetadata = layout === 'project' ? {
        managed: '1', version: '1', layout,
        provider: identity.provider, sessionId: identity.sessionId,
        createdAt: '2026-07-18T10:00:00.000Z', marker: `/tmp/${identity.sessionId}.done`,
    } : { managed: '1', version: '1', layout };
    return {
        sessionName: locator.sessionName,
        windowName: locator.windowName || 'ai-session',
        windowId: overrides.windowId || '@1',
        active: overrides.active || false,
        sessionMetadata,
        windowMetadata,
        metadata: { ...sessionMetadata, ...windowMetadata },
    };
}

function getLayout(layout) {
    return layout === 'session' ? new SessionTmuxLayout() : new ProjectTmuxLayout();
}

function createFakeScheduler(startMs = 0) {
    const clock = createFakeClock(startMs);
    return {
        clock,
        nowMs: () => clock.nowMs,
        setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
        clearTimeout: handle => clock.clearTimeout(handle),
        setInterval: (callback, delay) => clock.setInterval(callback, delay),
        clearInterval: handle => clock.clearInterval(handle),
    };
}

function createFakeProcessLookup(initial = {}) {
    const processes = new Map(Object.entries(initial).map(([key, value]) => [Number(key), value]));
    return {
        get: processId => processes.get(processId),
        set: (processId, value) => processes.set(processId, value),
        remove: processId => processes.delete(processId),
    };
}

function createFakeTmuxRunner(handler = async () => ({ exitCode: 0, stdout: '', stderr: '' })) {
    const calls = [];
    return {
        calls,
        async run(file, args) {
            calls.push({ file, args: [...args] });
            return handler(file, [...args], calls.length - 1);
        },
    };
}

function createFakeTerminalFactory() {
    const terminals = [];
    return {
        terminals,
        create(options) {
            const terminal = {
                name: options.name,
                options: { ...options },
                shown: false,
                disposed: false,
                show() { this.shown = true; },
                dispose() { this.disposed = true; },
            };
            terminals.push(terminal);
            return terminal;
        },
    };
}

function loadFreshWithFakeVscode(request, vscode, fromDirectory = process.cwd()) {
    const requireFromCaller = Module.createRequire(path.join(fromDirectory, '__runtime-contract-loader.js'));
    const resolved = requireFromCaller.resolve(request);
    const previousLoad = Module._load;
    delete require.cache[resolved];
    try {
        Module._load = function (moduleRequest, parent, isMain) {
            if (moduleRequest === 'vscode') return vscode;
            return previousLoad.call(this, moduleRequest, parent, isMain);
        };
        return requireFromCaller(request);
    } finally {
        Module._load = previousLoad;
    }
}

async function flushAsync(turns = 8) {
    for (let turn = 0; turn < turns; turn += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

function cloneWindow(row) {
    return {
        ...row,
        sessionMetadata: { ...row.sessionMetadata },
        windowMetadata: { ...row.windowMetadata },
        metadata: { ...row.metadata },
    };
}

function cloneRuntime(runtime) {
    return {
        ...runtime,
        identity: { ...runtime.identity },
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}

function clonePendingRuntime(runtime) {
    return {
        ...cloneRuntime(runtime),
        excludedSessionIds: [...runtime.excludedSessionIds],
    };
}

function cloneBinding(value) {
    if (!value) return value;
    return JSON.parse(JSON.stringify(value));
}

module.exports = {
    FIXED_NOW,
    createDeferred,
    createDirectRuntimeHarness,
    createFakeProcessLookup,
    createFakeRuntimeBackend,
    createFakeScheduler,
    createFakeTerminalFactory,
    createFakeTmuxRunner,
    createRuntimeFilesystemFixture,
    createSyntheticTmuxStore,
    createTmuxRuntimeHarness,
    defineRuntimeContract,
    fakeCreateRequest,
    fakeResumeRequest,
    fakeRuntime,
    flushAsync,
    loadFreshWithFakeVscode,
    makeTmuxDiscoveryRow,
    makeTmuxInactiveBinding,
    makeTmuxKnownBinding,
    makeTmuxPendingBinding,
};
