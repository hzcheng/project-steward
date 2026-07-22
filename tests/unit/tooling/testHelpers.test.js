'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { createFakeClock } = require('../../helpers/fakeClock');
const { createFakeVscode } = require('../../helpers/fakeVscode');
const { makeTempDirectory } = require('../../helpers/tempDirectory');

test('TEST-HELPERS-001 creates a temporary root for its owning test and removes it afterward', async t => {
    let root;

    await t.test('temporary root exists while its test runs', child => {
        root = makeTempDirectory(child, 'project-steward-test-');
        assert.ok(fs.existsSync(root));
    });

    assert.ok(!fs.existsSync(root));
});

test('TEST-HELPERS-002 runs fake-clock callbacks in timestamp and insertion order and skips cleared handles', () => {
    const clock = createFakeClock(100);
    const calls = [];
    const clearedTimeout = clock.setTimeout(() => calls.push('cleared timeout'), 5);
    const clearedInterval = clock.setInterval(() => calls.push('cleared interval'), 3);

    clock.setTimeout(() => calls.push(`first at ${clock.nowMs}`), 5);
    clock.setTimeout(() => calls.push(`second at ${clock.nowMs}`), 5);
    clock.setInterval(() => calls.push(`interval at ${clock.nowMs}`), 4);
    clock.clearTimeout(clearedTimeout);
    clock.clearInterval(clearedInterval);

    clock.advanceBy(12);

    assert.deepEqual(calls, [
        'interval at 104',
        'first at 105',
        'second at 105',
        'interval at 108',
        'interval at 112',
    ]);
    assert.equal(clock.nowMs, 112);
    assert.equal(clock.pendingCount, 1);
});

test('TEST-HELPERS-003 exposes only requested VS Code surfaces and records delegated calls', () => {
    const vscode = createFakeVscode({
        commands: {
            executeCommand: (...args) => `executed:${args.join(':')}`,
        },
    });

    assert.deepEqual(Object.keys(vscode).sort(), ['calls', 'commands']);
    assert.equal(vscode.commands.executeCommand('projectSteward.open', 'project-1'), 'executed:projectSteward.open:project-1');
    assert.deepEqual(vscode.calls, [{
        surface: 'commands',
        method: 'executeCommand',
        args: ['projectSteward.open', 'project-1'],
    }]);
});
