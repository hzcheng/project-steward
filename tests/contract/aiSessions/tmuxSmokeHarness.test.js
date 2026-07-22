'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
    createOwnedTemporaryRoot,
    removeOwnedTemporaryRoot,
    runBestEffortCleanup,
    runSmokeHarness,
} = require('../../../scripts/run-ai-session-tmux-smoke-checks');

test('RUNTIME-REAL-TMUX-SMOKE-HARNESS-SOURCE-001 uses the exported isolated harness with injected tmux boundaries', async () => {
    const calls = [];
    let roots;
    await runSmokeHarness({
        onRootsCreated: value => { roots = value; },
        createRunner: () => ({ kind: 'runner' }),
        createClient: runner => ({
            checkAvailability: async () => {
                calls.push(['availability', runner.kind]);
                return { available: true };
            },
        }),
        runSmoke: async (root, runner, client, fixtures) => {
            calls.push(['smoke', fs.existsSync(root), runner.kind, typeof client.checkAvailability, fixtures.length]);
        },
        captureSocket: () => null,
        killServer: () => calls.push(['kill']),
        verifyStopped: () => calls.push(['verify']),
        removeSocket: value => calls.push(['socket', value]),
    });
    assert.deepEqual(calls, [
        ['availability', 'runner'], ['smoke', true, 'runner', 'function', 0],
        ['kill'], ['verify'], ['socket', null],
    ]);
    assert.equal(fs.existsSync(roots.fixture.path), false);
    assert.equal(fs.existsSync(roots.tmux.path), false);
});

test('RUNTIME-REAL-TMUX-SMOKE-CLEANUP-001 removes only registered roots and retains cleanup failures', async () => {
    const owned = createOwnedTemporaryRoot('project-steward-tmux-smoke-');
    const foreignPath = `${owned.path}-foreign`;
    fs.mkdirSync(foreignPath);
    assert.throws(() => removeOwnedTemporaryRoot({ path: foreignPath }), /validated owned temporary root/);
    removeOwnedTemporaryRoot(owned);
    assert.equal(fs.existsSync(owned.path), false);
    assert.equal(fs.existsSync(foreignPath), true);
    fs.rmSync(foreignPath, { recursive: true });

    const calls = [];
    await assert.rejects(runBestEffortCleanup({
        captureSocket: () => { calls.push('capture'); return '/fixture/socket'; },
        killServer: () => { calls.push('kill'); throw new Error('kill failed'); },
        verifyStopped: () => { calls.push('verify'); },
        removeSocket: socket => calls.push(`socket:${socket}`),
        terminateProviders: () => calls.push('providers'),
        removeFixtures: (serverStopped, providersStopped) => calls.push(`roots:${serverStopped}:${providersStopped}`),
    }), error => error.name === 'CleanupAggregateError' && error.errors.length === 2);
    assert.deepEqual(calls, [
        'capture', 'kill', 'kill', 'verify', 'socket:/fixture/socket', 'providers', 'roots:true:true',
    ]);
});
