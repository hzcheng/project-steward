'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    makeTmuxInactiveBinding,
    makeTmuxKnownBinding,
    makeTmuxPendingBinding,
} = require('../../helpers/runtimeContract');
const { TmuxRuntimeBindingStore } = require('../../../out/aiSessions/tmuxRuntimeBindingStore');

const NOW = Date.parse('2026-07-18T10:00:00.000Z');

test('RUNTIME-TMUX-STORE-001 persists pending and final lifecycle records as defensive copies', async t => {
    const root = makeTempDirectory(t, 'project-steward-tmux-store-contract-');
    const store = new TmuxRuntimeBindingStore(root, () => NOW);
    const pending = makeTmuxPendingBinding('pending-one', { acceptedAtMs: NOW });
    const known = makeTmuxKnownBinding('session-one', { lastSeenAtMs: NOW });

    assert.equal(await store.setPending(pending), true);
    await store.setKnown(known);
    const pendingCopy = await store.getPending('pending-one');
    const knownCopy = await store.getKnown('codex', 'session-one');
    pendingCopy.excludedSessionIds.push('mutated');
    knownCopy.locator.windowName = 'mutated';

    assert.deepEqual(await store.getPending('pending-one'), pending);
    assert.deepEqual(await store.getKnown('codex', 'session-one'), known);
    assert.ok((await require('node:fs').promises.readdir(root)).every(name => !name.endsWith('.tmp')));
});

test('RUNTIME-TMUX-STORE-001 atomically transitions known runtimes to retained completed or stopped records', async t => {
    const root = makeTempDirectory(t, 'project-steward-tmux-lifecycle-contract-');
    const store = new TmuxRuntimeBindingStore(root, () => NOW);
    const known = makeTmuxKnownBinding('terminal', { lastSeenAtMs: NOW - 100 });
    const completed = makeTmuxInactiveBinding('terminal', 'completed', { detectedAtMs: NOW });
    await store.setKnown(known);

    assert.equal(await store.transitionKnownToInactive(completed, known.lastSeenAtMs), true);
    assert.equal(await store.getKnown('codex', 'terminal'), null);
    assert.deepEqual(await store.getInactive('codex', 'terminal'), completed);

    const restarted = new TmuxRuntimeBindingStore(root, () => NOW);
    assert.deepEqual(await restarted.listInactive(), [completed]);
    assert.equal(await restarted.acknowledgeInactive(completed), 'acknowledged');
    assert.equal(await restarted.acknowledgeInactive(completed), 'missing');
});

test('RUNTIME-TMUX-STORE-001 rejects stale transition and acknowledgement races', async t => {
    const root = makeTempDirectory(t, 'project-steward-tmux-cas-contract-');
    const records = path.join(root, 'records');
    let lockQueue = Promise.resolve();
    const withLock = operation => {
        const result = lockQueue.then(operation);
        lockQueue = result.then(() => undefined, () => undefined);
        return result;
    };
    const first = new TmuxRuntimeBindingStore(records, () => NOW, withLock);
    const second = new TmuxRuntimeBindingStore(records, () => NOW, withLock);
    const staleKnown = makeTmuxKnownBinding('raced', { lastSeenAtMs: NOW - 200 });
    const freshKnown = makeTmuxKnownBinding('raced', { lastSeenAtMs: NOW - 50 });
    await first.setKnown(staleKnown);
    await second.setKnown(freshKnown);

    assert.equal(await first.transitionKnownToInactive(
        makeTmuxInactiveBinding('raced', 'stopped'), staleKnown.lastSeenAtMs
    ), false);
    assert.deepEqual(await second.getKnown('codex', 'raced'), freshKnown);

    const oldRun = makeTmuxInactiveBinding('ack-race', 'completed', {
        runStartedAtMs: NOW - 1000, detectedAtMs: NOW - 10,
    });
    const newRun = makeTmuxInactiveBinding('ack-race', 'stopped', {
        runStartedAtMs: NOW - 500, markerPath: '/tmp/ack-race-new.done', detectedAtMs: NOW,
    });
    await first.setInactive(oldRun);
    assert.equal(await first.acknowledgeInactive(oldRun), 'acknowledged');
    await second.setInactive(newRun);
    assert.equal(await first.acknowledgeInactive(oldRun), 'stale');
    assert.deepEqual(await second.getInactive('codex', 'ack-race'), newRun);
});
