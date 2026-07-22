'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    validateSafetyScripts,
    validateVerifyWorkflow,
} = require('../../../scripts/lib/ciContracts');

const verifyWorkflow = fs.readFileSync(
    path.resolve(__dirname, '../../../.github/workflows/verify.yml'),
    'utf8'
);

test('RELEASE-VSIX-PACKAGING-001 accepts the unquoted GitHub Actions on key', () => {
    assert.doesNotThrow(() => validateVerifyWorkflow(verifyWorkflow));
});

test('RELEASE-VSIX-PACKAGING-001 rejects workflow requirements that appear only in comments', () => {
    const commentOnlyWorkflow = verifyWorkflow
        .split('\n')
        .map(line => `# ${line}`)
        .join('\n');

    assert.throws(
        () => validateVerifyWorkflow(commentOnlyWorkflow),
        /verification workflow must be a YAML mapping/
    );
});

test('RELEASE-VSIX-PACKAGING-001 rejects a Linux gate assigned to the Windows runner', () => {
    const wrongRunnerWorkflow = verifyWorkflow.replace(
        'runs-on: ubuntu-latest',
        'runs-on: windows-latest'
    );

    assert.throws(
        () => validateVerifyWorkflow(wrongRunnerWorkflow),
        /quality-linux must use ubuntu-latest/
    );
});

test('RELEASE-VSIX-PACKAGING-001 requires npm caching in the Windows job itself', () => {
    const cacheMatches = [...verifyWorkflow.matchAll(/          cache: npm/g)];
    assert.equal(cacheMatches.length, 2);
    const windowsCache = cacheMatches[1];
    const missingWindowsCacheWorkflow =
        verifyWorkflow.slice(0, windowsCache.index)
        + verifyWorkflow.slice(windowsCache.index + windowsCache[0].length);

    assert.throws(
        () => validateVerifyWorkflow(missingWindowsCacheWorkflow),
        /platform-windows setup-node step must cache npm/
    );
});

test('RUNTIME-TMUX-SMOKE-HARNESS-SAFETY-001 requires the developer wrapper to invoke its no-compile runner', () => {
    assert.throws(() => validateSafetyScripts({
        'test:safety': 'npm run test-compile',
        'test:safety:run': 'node scripts/run-ai-session-tmux-checks.js',
    }), /test:safety must invoke npm run test:safety:run/);
});
