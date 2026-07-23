'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createDeferred,
    createSyntheticTmuxStore,
    makeTmuxDiscoveryRow,
    makeTmuxKnownBinding,
} = require('../../helpers/runtimeContract');
const { buildReadableTmuxLocator } = require('../../../out/aiSessions/tmuxNaming');
const {
    TmuxRuntimeDiscovery,
    findTmuxCollisionRuntime,
} = require('../../../out/aiSessions/tmuxRuntimeDiscovery');

test('RUNTIME-TMUX-DISCOVERY-001 RUNTIME-TMUX-FOCUSED-RUNTIME-MONITOR-001 caches, force-refreshes, and defensively projects managed rows', async () => {
    let nowMs = 1000;
    let lists = 0;
    const row = makeTmuxDiscoveryRow({ sessionId: 'session-one' });
    const store = createSyntheticTmuxStore();
    const discovery = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => { lists += 1; return [row, { ...row, windowId: '@duplicate' }]; } },
        bindingStore: store,
        markerIsCurrent: () => false,
        nowMs: () => nowMs,
        cacheTtlMs: 500,
    });

    await discovery.refresh();
    await discovery.refresh();
    assert.equal(lists, 1);
    assert.equal(discovery.getActive().length, 1);
    const copy = discovery.getActive();
    copy[0].identity.sessionId = 'mutated';
    copy[0].tmux.sessionName = 'mutated';
    assert.equal(discovery.getActive()[0].identity.sessionId, 'session-one');

    nowMs += 501;
    await discovery.refresh();
    await discovery.refresh(true);
    assert.equal(lists, 3);
});

test('RUNTIME-TMUX-DISCOVERY-001 coalesces refreshes and marks retained state stale after failure', async () => {
    const first = createDeferred();
    let lists = 0;
    let fail = false;
    const row = makeTmuxDiscoveryRow({ sessionId: 'coalesced' });
    const discovery = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => {
            lists += 1;
            if (fail) throw new Error('isolated discovery failure');
            return lists === 1 ? first.promise : [row];
        } },
        bindingStore: createSyntheticTmuxStore(),
        markerIsCurrent: () => false,
        nowMs: () => 1000,
        cacheTtlMs: 0,
    });

    const ordinary = discovery.refresh();
    const forced = discovery.refresh(true);
    assert.equal(lists, 1);
    first.resolve([row]);
    await Promise.all([ordinary, forced]);
    assert.equal(lists, 2);

    fail = true;
    await assert.rejects(discovery.refresh(true), /isolated discovery failure/);
    assert.equal(discovery.getActive()[0].stale, true);
});

test('RUNTIME-TMUX-DISCOVERY-001 isolates locator collisions as stale-safe conflict diagnostics', async () => {
    let fail = false;
    const expected = makeTmuxDiscoveryRow({ provider: 'claude', projectKey: 'collision', sessionId: 'same' });
    const actual = {
        ...expected,
        windowName: `${expected.windowName}-occupied`,
    };
    const store = createSyntheticTmuxStore({
        known: [makeTmuxKnownBinding('same', {
            provider: 'claude', projectKey: 'collision', locator: {
                layout: 'project', sessionName: expected.sessionName, windowName: expected.windowName,
            },
        })],
    });
    const discovery = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => {
            if (fail) throw new Error('collision refresh failed');
            return [actual];
        } },
        bindingStore: store,
        markerIsCurrent: () => false,
        cacheTtlMs: 0,
    });

    await discovery.refresh();
    assert.deepEqual(discovery.getActive(), []);
    const conflict = findTmuxCollisionRuntime(discovery.getDiagnostics(), 'claude', 'same', 'scope:fixture');
    assert.equal(conflict.state, 'conflict');
    assert.deepEqual(conflict.tmux, {
        layout: 'project', sessionName: expected.sessionName, windowName: expected.windowName,
    });

    fail = true;
    await assert.rejects(discovery.refresh(true), /collision refresh failed/);
    assert.equal(findTmuxCollisionRuntime(discovery.getDiagnostics(), 'claude', 'same', 'scope:fixture').stale, true);
});

test('RUNTIME-TMUX-DISCOVERY-001 recovers readable and renamed project containers by stable identity suffix', async () => {
    const runtimeIdentity = {
        provider: 'codex',
        workspaceScopeIdentity: 'scope:fixture',
        workspaceNavigationIdentity: 'navigation:fixture',
        workspaceRootHostPaths: ['/work'],
        cwd: '/work',
        sessionId: 'readable',
    };
    const locator = buildReadableTmuxLocator(runtimeIdentity, 'project', {
        projectName: 'RedDB',
        sessionName: 'Repair replication',
    });
    const row = makeTmuxDiscoveryRow({
        sessionId: runtimeIdentity.sessionId,
        locator,
    });
    const known = makeTmuxKnownBinding(runtimeIdentity.sessionId, { locator });
    const exact = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => [row] },
        bindingStore: createSyntheticTmuxStore({ known: [known] }),
        markerIsCurrent: () => false,
        nowMs: () => 2000,
        cacheTtlMs: 0,
    });
    await exact.refresh(true);
    assert.deepEqual(exact.getActive().map(runtime => runtime.tmux), [locator]);

    const suffix = locator.sessionName.match(/([0-9a-f]{8})$/)[1];
    const renamedRow = {
        ...row,
        sessionName: `ps-Renamed-${suffix}`,
    };
    const renamed = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => [renamedRow] },
        bindingStore: createSyntheticTmuxStore({ known: [known] }),
        markerIsCurrent: () => false,
        nowMs: () => 2000,
        cacheTtlMs: 0,
    });
    await renamed.refresh(true);
    assert.deepEqual(
        renamed.getActive().map(runtime => runtime.tmux),
        [{ ...locator, sessionName: renamedRow.sessionName }]
    );

    const foreignRow = {
        ...row,
        sessionName: 'ps-Renamed-00000000',
    };
    const foreign = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => [foreignRow] },
        bindingStore: createSyntheticTmuxStore({ known: [known] }),
        markerIsCurrent: () => false,
        nowMs: () => 2000,
        cacheTtlMs: 0,
    });
    await foreign.refresh(true);
    assert.deepEqual(foreign.getActive(), []);
    assert.equal(
        findTmuxCollisionRuntime(
            foreign.getDiagnostics(),
            runtimeIdentity.provider,
            runtimeIdentity.sessionId,
            runtimeIdentity.workspaceScopeIdentity
        ).state,
        'conflict'
    );
});

test('RUNTIME-TMUX-DISCOVERY-001 classifies vanished runtimes as completed or stopped and retains them', async () => {
    let rows = [makeTmuxDiscoveryRow({ sessionId: 'vanished' })];
    let markerCurrent = true;
    const store = createSyntheticTmuxStore();
    const discovery = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => rows },
        bindingStore: store,
        markerIsCurrent: () => markerCurrent,
        nowMs: () => 2000,
        cacheTtlMs: 0,
    });

    await discovery.refresh(true);
    rows = [];
    await discovery.refresh(true);
    assert.deepEqual(discovery.getInactive().map(runtime => runtime.state), ['completed']);

    const stoppedStore = createSyntheticTmuxStore({
        known: [makeTmuxKnownBinding('stopped', { lastSeenAtMs: 1000 })],
    });
    markerCurrent = false;
    const stopped = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => [] },
        bindingStore: stoppedStore,
        markerIsCurrent: () => markerCurrent,
        nowMs: () => 2000,
        cacheTtlMs: 0,
    });
    await stopped.refresh(true);
    assert.deepEqual(stopped.getInactive().map(runtime => runtime.state), ['stopped']);
});

test('RUNTIME-TMUX-THREAD-SWITCH-001 SESSION-ALIAS-THREAD-SWITCH-001 rebinds one managed locator and reports the committed root transition', async () => {
    const row = makeTmuxDiscoveryRow({
        sessionId: 'old-root',
        panePid: 4321,
    });
    const locator = {
        layout: 'project',
        sessionName: row.sessionName,
        windowName: row.windowName,
    };
    const known = makeTmuxKnownBinding('old-root', { locator });
    const store = createSyntheticTmuxStore({ known: [known] });
    const observed = [];
    const reboundEvents = [];
    const observer = {
        observe: async request => {
            observed.push(request);
            return 'new-root';
        },
    };
    const discovery = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => [row] },
        bindingStore: store,
        codexRootThreadObserver: observer,
        markerIsCurrent: () => false,
        nowMs: () => 2000,
        cacheTtlMs: 0,
        onSessionRebound: (previous, next) => reboundEvents.push({ previous, next }),
    });

    await discovery.refresh(true);
    assert.deepEqual(observed, [{
        panePid: 4321,
        currentSessionId: 'old-root',
        runStartedAtMs: known.runStartedAtMs,
    }]);
    assert.deepEqual(discovery.getActive().map(runtime => runtime.identity.sessionId), ['new-root']);
    assert.equal(store.known.has('codex:old-root'), false);
    assert.equal(store.known.get('codex:new-root').locator.windowName, row.windowName);
    assert.deepEqual(reboundEvents.map(event => [
        event.previous.provider,
        event.previous.sessionId,
        event.next.provider,
        event.next.sessionId,
    ]), [['codex', 'old-root', 'codex', 'new-root']]);

    const restarted = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => [row] },
        bindingStore: store,
        codexRootThreadObserver: observer,
        markerIsCurrent: () => false,
        nowMs: () => 2001,
        cacheTtlMs: 0,
    });
    await restarted.refresh(true);
    assert.deepEqual(restarted.getActive().map(runtime => runtime.identity.sessionId), ['new-root']);
});

test('RUNTIME-TMUX-THREAD-SWITCH-001 preserves the durable projection when observation cannot commit', async () => {
    const row = makeTmuxDiscoveryRow({ sessionId: 'old-root', panePid: 4321 });
    const locator = {
        layout: 'project',
        sessionName: row.sessionName,
        windowName: row.windowName,
    };
    let reboundEvents = 0;
    for (const failure of ['observer', 'stale', 'missing']) {
        const store = createSyntheticTmuxStore({
            known: [makeTmuxKnownBinding('old-root', { locator })],
        });
        if (failure !== 'observer') {
            store.rebindKnown = async () => failure;
        }
        const discovery = new TmuxRuntimeDiscovery({
            client: { listWindows: async () => [row] },
            bindingStore: store,
            codexRootThreadObserver: {
                observe: async () => {
                    if (failure === 'observer') throw new Error('controlled observer race');
                    return 'new-root';
                },
            },
            markerIsCurrent: () => false,
            nowMs: () => 2000,
            cacheTtlMs: 0,
            onSessionRebound: () => { reboundEvents += 1; },
        });
        await discovery.refresh(true);
        assert.deepEqual(
            discovery.getActive().map(runtime => runtime.identity.sessionId),
            ['old-root'],
            failure
        );
    }
    assert.equal(reboundEvents, 0);
});

test('RUNTIME-TMUX-THREAD-SWITCH-001 rejects ambiguous locator authority and non-Codex observation', async () => {
    const row = makeTmuxDiscoveryRow({ sessionId: 'old-root', panePid: 4321 });
    const locator = {
        layout: 'project',
        sessionName: row.sessionName,
        windowName: row.windowName,
    };
    const duplicate = makeTmuxKnownBinding('other-root', { locator });
    const ambiguousStore = createSyntheticTmuxStore({
        known: [makeTmuxKnownBinding('old-root', { locator }), duplicate],
    });
    let observations = 0;
    const ambiguous = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => [row] },
        bindingStore: ambiguousStore,
        codexRootThreadObserver: {
            observe: async () => { observations += 1; return 'new-root'; },
        },
        markerIsCurrent: () => false,
        cacheTtlMs: 0,
    });
    await ambiguous.refresh(true);
    assert.equal(observations, 0);
    assert.deepEqual(ambiguous.getActive().map(runtime => runtime.identity.sessionId), ['old-root']);

    const kimiRow = makeTmuxDiscoveryRow({
        provider: 'kimi', sessionId: 'kimi-root', panePid: 4322,
    });
    const kimi = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => [kimiRow] },
        bindingStore: createSyntheticTmuxStore(),
        codexRootThreadObserver: {
            observe: async () => { observations += 1; return 'wrong'; },
        },
        markerIsCurrent: () => false,
        cacheTtlMs: 0,
    });
    await kimi.refresh(true);
    assert.equal(observations, 0);
    assert.deepEqual(kimi.getActive().map(runtime => runtime.identity.sessionId), ['kimi-root']);
});
