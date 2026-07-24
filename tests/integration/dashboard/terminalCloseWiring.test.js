'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const util = require('node:util');

const execFile = util.promisify(childProcess.execFile);
const harnessPath = path.join(__dirname, 'helpers', 'terminalCloseHarness.js');

function harnessEnvironment() {
    return { ...process.env, NODE_V8_COVERAGE: '' };
}

test('ATTENTION-RUNTIME-EXIT-NEUTRAL-001 production process exit creates no attention side effect', async () => {
    await execFile(process.execPath, [harnessPath, 'baseline'], { env: harnessEnvironment() });
});

test('ATTENTION-USER-TERMINAL-CLOSE-001 production user close acknowledges existing attention without completion suppression', async () => {
    await execFile(process.execPath, [harnessPath, 'user-close'], { env: harnessEnvironment() });
});

test('ATTENTION-EXPLICIT-SESSION-CLOSE-001 production close action acknowledges attention without completion suppression', async () => {
    await execFile(process.execPath, [harnessPath, 'explicit-close'], { env: harnessEnvironment() });
});

test('ATTENTION-EXPLICIT-SESSION-CLOSE-001 tmux detach acknowledges current attention without suppressing future completion', async () => {
    await execFile(process.execPath, [harnessPath, 'explicit-detach'], { env: harnessEnvironment() });
});

test('ATTENTION-RUNTIME-EXIT-NEUTRAL-001 controlled completion-suppression mutation is rejected', async () => {
    await assert.rejects(
        execFile(process.execPath, [harnessPath, 'mutation'], { env: harnessEnvironment() }),
        /runtime exit must never suppress completion attention/);
});
