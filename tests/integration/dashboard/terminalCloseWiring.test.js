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

test('ATTENTION-TERMINAL-CLOSE-WIRING-001 production terminal-close callback preserves unread attention', async () => {
    await execFile(process.execPath, [harnessPath, 'baseline'], { env: harnessEnvironment() });
});

test('ATTENTION-TERMINAL-CLOSE-WIRING-001 controlled acknowledgement mutation is rejected', async () => {
    await assert.rejects(
        execFile(process.execPath, [harnessPath, 'mutation'], { env: harnessEnvironment() }),
        /closing a terminal must not acknowledge unread attention/);
});
