'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createDeferred,
    createSyntheticTmuxStore,
    makeTmuxDiscoveryRow,
    makeTmuxKnownBinding,
} = require('../../helpers/runtimeContract');
const {
    TmuxRuntimeDiscovery,
    findTmuxCollisionRuntime,
} = require('../../../out/aiSessions/tmuxRuntimeDiscovery');

test('RUNTIME-TMUX-DISCOVERY-001 caches, force-refreshes, and defensively projects managed rows', async () => {
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
    const conflict = findTmuxCollisionRuntime(discovery.getDiagnostics(), 'claude', 'same');
    assert.equal(conflict.state, 'conflict');
    assert.deepEqual(conflict.tmux, {
        layout: 'project', sessionName: expected.sessionName, windowName: expected.windowName,
    });

    fail = true;
    await assert.rejects(discovery.refresh(true), /collision refresh failed/);
    assert.equal(findTmuxCollisionRuntime(discovery.getDiagnostics(), 'claude', 'same').stale, true);
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
