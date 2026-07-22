'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function runHarnessScenario(name) {
    const environment = { ...process.env };
    environment.NODE_V8_COVERAGE = '';
    const result = spawnSync(process.execPath, [
        path.resolve(__dirname, '../../fixtures/aiSessions/tmuxSmokeHarnessScenarios.js'),
        name,
    ], {
        encoding: 'utf8',
        env: environment,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
}

test('RUNTIME-REAL-TMUX-SMOKE-HARNESS-SOURCE-001 uses the exported isolated harness with injected tmux boundaries', async () => {
    const result = runHarnessScenario('harness');
    assert.deepEqual(result.instrumentation, {
        nodeOptions: process.env.NODE_OPTIONS || null,
        v8Coverage: null,
    });
    assert.deepEqual(result.calls, [
        ['availability', 'runner'], ['smoke', true, 'runner', 'function', 0],
        ['kill'], ['verify'], ['socket', null],
    ]);
    assert.deepEqual(result.rootsExist, { fixture: false, tmux: false });
});

test('RUNTIME-REAL-TMUX-SMOKE-CLEANUP-001 removes only registered roots and retains cleanup failures', async () => {
    const result = runHarnessScenario('cleanup');
    assert.equal(result.rejectedForeignRoot, true);
    assert.deepEqual(result.pathsExist, { owned: false, foreign: true });
    assert.deepEqual(result.cleanupError, { name: 'CleanupAggregateError', count: 2 });
    assert.deepEqual(result.calls, [
        'capture', 'kill', 'kill', 'verify', 'socket:/fixture/socket', 'providers', 'roots:true:true',
    ]);
});
