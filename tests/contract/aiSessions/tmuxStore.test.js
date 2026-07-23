'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    createRuntimeFilesystemFixture,
    makeTmuxInactiveBinding,
    makeTmuxKnownBinding,
    makeTmuxPendingBinding,
} = require('../../helpers/runtimeContract');
const { buildReadableTmuxLocator } = require('../../../out/aiSessions/tmuxNaming');
const { TmuxRuntimeBindingStore } = require('../../../out/aiSessions/tmuxRuntimeBindingStore');

const NOW = Date.parse('2026-07-18T10:00:00.000Z');

test('RUNTIME-TMUX-STORE-001 persists pending and final lifecycle records as defensive copies', async t => {
    const filesystem = createRuntimeFilesystemFixture(t, 'project-steward-tmux-store-contract-');
    const store = new TmuxRuntimeBindingStore(filesystem.root, () => NOW);
    const pending = makeTmuxPendingBinding('pending-one', { acceptedAtMs: NOW });
    const known = makeTmuxKnownBinding('session-one', { lastSeenAtMs: NOW });

    assert.equal(await store.setPending(pending), true);
    await store.setKnown(known);
    const pendingIdentity = {
        provider: pending.provider,
        workspaceScopeIdentity: pending.workspaceScopeIdentity,
        workspaceNavigationIdentity: pending.workspaceNavigationIdentity,
        workspaceRootHostPaths: pending.workspaceRootHostPaths,
        cwd: pending.cwd,
        pendingId: pending.pendingId,
    };
    const pendingCopy = await store.getPending(pendingIdentity);
    const knownCopy = await store.getKnown('codex', 'session-one');
    pendingCopy.excludedSessionIds.push('mutated');
    knownCopy.locator.windowName = 'mutated';

    assert.deepEqual(await store.getPending(pendingIdentity), pending);
    assert.deepEqual(await store.getKnown('codex', 'session-one'), known);
    assert.ok((await require('node:fs').promises.readdir(filesystem.root))
        .every(name => !name.endsWith('.tmp')));
});

test('RUNTIME-TMUX-STORE-001 persists readable pending and final locators across restart', async t => {
    const filesystem = createRuntimeFilesystemFixture(t, 'project-steward-readable-tmux-store-');
    const store = new TmuxRuntimeBindingStore(filesystem.root, () => NOW);
    const pending = makeTmuxPendingBinding('pending-readable', {
        acceptedAtMs: NOW,
        title: 'Repair replication',
    });
    pending.locator = buildReadableTmuxLocator({
        provider: pending.provider,
        workspaceScopeIdentity: pending.workspaceScopeIdentity,
        workspaceNavigationIdentity: pending.workspaceNavigationIdentity,
        workspaceRootHostPaths: pending.workspaceRootHostPaths,
        cwd: pending.cwd,
        pendingId: pending.pendingId,
    }, pending.layout, {
        projectName: 'RedDB',
        sessionName: pending.title,
    });
    const known = makeTmuxKnownBinding('session-readable', { lastSeenAtMs: NOW });
    known.locator = buildReadableTmuxLocator({
        provider: known.provider,
        workspaceScopeIdentity: known.workspaceScopeIdentity,
        workspaceNavigationIdentity: known.workspaceNavigationIdentity,
        workspaceRootHostPaths: known.workspaceRootHostPaths,
        cwd: known.cwd,
        sessionId: known.sessionId,
    }, known.layout, {
        projectName: 'RedDB',
        sessionName: 'Repair replication',
    });

    assert.equal(await store.setPending(pending), true);
    await store.setKnown(known);

    const restarted = new TmuxRuntimeBindingStore(filesystem.root, () => NOW);
    assert.deepEqual((await restarted.listPending())[0].locator, pending.locator);
    assert.deepEqual((await restarted.listKnown())[0].locator, known.locator);
});

test('RUNTIME-TMUX-STORE-001 atomically transitions known runtimes to retained completed or stopped records', async t => {
    const filesystem = createRuntimeFilesystemFixture(t, 'project-steward-tmux-lifecycle-contract-');
    const store = new TmuxRuntimeBindingStore(filesystem.root, () => NOW);
    const known = makeTmuxKnownBinding('terminal', { lastSeenAtMs: NOW - 100 });
    const completed = makeTmuxInactiveBinding('terminal', 'completed', { detectedAtMs: NOW });
    await store.setKnown(known);

    assert.equal(await store.transitionKnownToInactive(completed, known.lastSeenAtMs), true);
    assert.equal(await store.getKnown('codex', 'terminal'), null);
    assert.deepEqual(await store.getInactive('codex', 'terminal'), completed);

    const restarted = new TmuxRuntimeBindingStore(filesystem.root, () => NOW);
    assert.deepEqual(await restarted.listInactive(), [completed]);
    assert.equal(await restarted.acknowledgeInactive(completed), 'acknowledged');
    assert.equal(await restarted.acknowledgeInactive(completed), 'missing');
});

test('RUNTIME-TMUX-STORE-001 rejects stale transition and acknowledgement races', async t => {
    const filesystem = createRuntimeFilesystemFixture(t, 'project-steward-tmux-cas-contract-');
    const records = filesystem.resolve('records');
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

test('RUNTIME-TMUX-THREAD-SWITCH-001 atomically rebinds a known runtime to one replacement session', async t => {
    const filesystem = createRuntimeFilesystemFixture(t, 'project-steward-tmux-rebind-');
    const store = new TmuxRuntimeBindingStore(filesystem.root, () => NOW);
    const oldBinding = makeTmuxKnownBinding('old-root', { lastSeenAtMs: NOW - 10 });
    await store.setKnown(oldBinding);

    assert.equal(await store.rebindKnown(oldBinding, 'new-root'), 'rebound');
    assert.equal(await store.getKnown('codex', 'old-root'), null);
    assert.deepEqual(await store.getKnown('codex', 'new-root'), {
        ...oldBinding,
        sessionId: 'new-root',
    });

    const restarted = new TmuxRuntimeBindingStore(filesystem.root, () => NOW);
    assert.deepEqual(await restarted.listKnown(), [{
        ...oldBinding,
        sessionId: 'new-root',
    }]);
    assert.ok((await require('node:fs').promises.readdir(filesystem.root))
        .every(name => !name.endsWith('.tmp') && !name.startsWith('rebind-')));
});

test('RUNTIME-TMUX-THREAD-SWITCH-001 rejects stale, missing, invalid, and occupied rebind targets', async t => {
    const filesystem = createRuntimeFilesystemFixture(t, 'project-steward-tmux-rebind-reject-');
    const store = new TmuxRuntimeBindingStore(filesystem.root, () => NOW);
    const expected = makeTmuxKnownBinding('old-root', { lastSeenAtMs: NOW - 20 });
    const current = makeTmuxKnownBinding('old-root', { lastSeenAtMs: NOW - 10 });
    await store.setKnown(current);

    assert.equal(await store.rebindKnown(expected, 'new-root'), 'stale');
    assert.equal(await store.rebindKnown(
        makeTmuxKnownBinding('missing-root', { lastSeenAtMs: NOW - 10 }),
        'new-root'
    ), 'missing');
    assert.equal(await store.rebindKnown(current, 'bad\nroot'), 'stale');

    const occupied = makeTmuxKnownBinding('occupied', { lastSeenAtMs: NOW - 5 });
    await store.setKnown(occupied);
    assert.equal(await store.rebindKnown(current, occupied.sessionId), 'stale');
    assert.deepEqual(await store.getKnown('codex', current.sessionId), current);
    assert.deepEqual(await store.getKnown('codex', occupied.sessionId), occupied);
});

test('RUNTIME-TMUX-THREAD-SWITCH-001 serializes competing known-runtime rebinds', async t => {
    const filesystem = createRuntimeFilesystemFixture(t, 'project-steward-tmux-rebind-race-');
    const records = filesystem.resolve('records');
    let lockQueue = Promise.resolve();
    const withLock = operation => {
        const result = lockQueue.then(operation);
        lockQueue = result.then(() => undefined, () => undefined);
        return result;
    };
    const first = new TmuxRuntimeBindingStore(records, () => NOW, withLock);
    const second = new TmuxRuntimeBindingStore(records, () => NOW, withLock);
    const expected = makeTmuxKnownBinding('old-root', { lastSeenAtMs: NOW - 10 });
    await first.setKnown(expected);

    const results = await Promise.all([
        first.rebindKnown(expected, 'new-root-a'),
        second.rebindKnown(expected, 'new-root-b'),
    ]);
    assert.equal(results.filter(result => result === 'rebound').length, 1);
    assert.equal((await first.listKnown()).length, 1);
    assert.notEqual((await first.listKnown())[0].sessionId, 'old-root');
});

test('RUNTIME-TMUX-THREAD-SWITCH-001 recovers every durable rebind interruption stage', async t => {
    for (const stage of ['intent-only', 'replacement-written', 'old-removed']) {
        const filesystem = createRuntimeFilesystemFixture(
            t, `project-steward-tmux-rebind-recovery-${stage}-`
        );
        const expected = makeTmuxKnownBinding('old-root', { lastSeenAtMs: NOW - 10 });
        const replacement = { ...expected, sessionId: 'new-root' };
        const intent = {
            version: 1,
            state: 'rebind-known',
            expected,
            replacement,
            recordedAtMs: NOW,
        };
        fs.mkdirSync(filesystem.root, { recursive: true });
        if (stage !== 'old-removed') {
            fs.writeFileSync(
                path.join(filesystem.root, recordFilename(
                    'known', expected.provider, expected.workspaceScopeIdentity, expected.sessionId
                )),
                JSON.stringify(expected)
            );
        }
        if (stage !== 'intent-only') {
            fs.writeFileSync(
                path.join(filesystem.root, recordFilename(
                    'known', replacement.provider,
                    replacement.workspaceScopeIdentity, replacement.sessionId
                )),
                JSON.stringify(replacement)
            );
        }
        fs.writeFileSync(
            path.join(filesystem.root, recordFilename(
                'rebind', expected.provider,
                expected.workspaceScopeIdentity, JSON.stringify(expected.locator)
            )),
            JSON.stringify(intent)
        );

        const restarted = new TmuxRuntimeBindingStore(filesystem.root, () => NOW);
        assert.deepEqual(await restarted.listKnown(), [replacement], stage);
        assert.deepEqual(
            (await fs.promises.readdir(filesystem.root)).filter(name =>
                name.startsWith('rebind-') || name.endsWith('.tmp')),
            [],
            stage
        );
    }
});

function recordFilename(kind, ...identity) {
    const digest = createHash('sha256')
        .update(JSON.stringify([2, kind, ...identity]), 'utf8')
        .digest('hex');
    return `${kind}-${digest}.json`;
}
