'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const util = require('node:util');

const execFile = util.promisify(childProcess.execFile);
const harnessPath = path.join(__dirname, 'helpers', 'todoPanelHarness.js');
const harnessOptions = { env: { ...process.env, NODE_V8_COVERAGE: '' } };

test('TODO-FUTURE-VERSION-DASHBOARD-001 live-probes and recovers through the production message callback', async () => {
    await execFile(process.execPath, [harnessPath, 'baseline'], harnessOptions);
});

for (const mutation of ['missing-live-probe', 'missing-catch-mapping']) {
    test(`TODO-FUTURE-VERSION-DASHBOARD-001 rejects ${mutation} mutation`, async () => {
        await assert.rejects(
            execFile(process.execPath, [harnessPath, mutation], harnessOptions),
            /TODO-FUTURE-VERSION-DASHBOARD-001/);
    });
}
