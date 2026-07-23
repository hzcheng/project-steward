'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    validateQualityGateScripts,
    validateSafetyScripts,
    validateScheduledWorkflow,
    validateVerifyWorkflow,
} = require('../../../scripts/lib/ciContracts');

const verifyWorkflow = fs.readFileSync(
    path.resolve(__dirname, '../../../.github/workflows/verify.yml'),
    'utf8'
);
const scheduledWorkflow = fs.readFileSync(
    path.resolve(__dirname, '../../../.github/workflows/scheduled-verification.yml'),
    'utf8'
);
const packageScripts = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../../package.json'),
    'utf8'
)).scripts;

test('RELEASE-VSIX-PACKAGING-001 accepts the unquoted GitHub Actions on key', () => {
    assert.doesNotThrow(() => validateVerifyWorkflow(verifyWorkflow));
});

test('RUNTIME-REAL-TMUX-CI-GATE-001 requires a stable real-tmux smoke job', () => {
    const missingTmuxJobWorkflow = verifyWorkflow.replace(/\n  tmux-smoke-linux:[\s\S]*$/, '');
    assert.throws(
        () => validateVerifyWorkflow(missingTmuxJobWorkflow),
        /must define tmux-smoke-linux/
    );
});

test('RUNTIME-REAL-TMUX-CI-GATE-001 requires tmux installation in the smoke job', () => {
    const missingTmuxInstallWorkflow = verifyWorkflow.replace(
        '        run: sudo apt-get install -y tmux',
        '        run: tmux -V'
    );
    assert.throws(
        () => validateVerifyWorkflow(missingTmuxInstallWorkflow),
        /tmux-smoke-linux must run sudo apt-get install -y tmux/
    );
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
    assert.ok(cacheMatches.length >= 2);
    const windowsCache = cacheMatches[1];
    const missingWindowsCacheWorkflow =
        verifyWorkflow.slice(0, windowsCache.index)
        + verifyWorkflow.slice(windowsCache.index + windowsCache[0].length);

    assert.throws(
        () => validateVerifyWorkflow(missingWindowsCacheWorkflow),
        /platform-windows setup-node step must cache npm/
    );
});

test('RUNTIME-TMUX-SMOKE-HARNESS-SAFETY-001 RELEASE-VSIX-PACKAGING-001 requires developer and release gates to keep their public runners', () => {
    assert.throws(() => validateSafetyScripts({
        'test:safety': 'npm run test-compile',
        'test:safety:run': 'node scripts/run-ai-session-tmux-checks.js',
    }), /test:safety must invoke npm run test:safety:run/);
});

test('ARCH-CI-QUALITY-GATE-001 requires architecture guards in the compile-once Linux chain', () => {
    assert.throws(() => validateQualityGateScripts({
        'test:ci:linux': 'npm run test-compile && npm run test:safety:run',
        'test:architecture-guards': 'node scripts/run-architecture-guards.js',
    }), /test:ci:linux must invoke npm run test:architecture-guards/);
});

test('ARCH-CI-QUALITY-GATE-001 keeps the repository Linux quality chain wired exactly', () => {
    assert.doesNotThrow(() => validateQualityGateScripts(packageScripts));
});

test('ARCH-CI-QUALITY-GATE-001 scheduled verification reuses the complete Verify workflow', () => {
    assert.doesNotThrow(() => validateScheduledWorkflow(scheduledWorkflow));

    assert.throws(
        () => validateScheduledWorkflow(
            scheduledWorkflow.replace(/\n  verify:\n[\s\S]*?(?=\n  scheduled-macos:)/, '')
        ),
        /must define verify/
    );
    assert.throws(
        () => validateScheduledWorkflow(
            scheduledWorkflow.replace(
                'uses: ./.github/workflows/verify.yml',
                'uses: ./.github/workflows/release-vsix.yml'
            )
        ),
        /verify must reuse \.\/\.github\/workflows\/verify\.yml/
    );
});

test('ARCH-CI-QUALITY-GATE-001 scheduled Extension Host gate is pinned and blocking', () => {
    for (const [source, message] of [
        [
            scheduledWorkflow.replace('        run: npm run test:extension-host', '        run: npm test'),
            /scheduled-macos must run npm run test:extension-host/,
        ],
        [
            scheduledWorkflow.replace('node-version: 22.12.0', 'node-version: 22'),
            /scheduled-macos setup-node step must use Node 22\.12\.0/,
        ],
        [
            scheduledWorkflow.replace('          cache: npm', '          cache: false'),
            /scheduled-macos setup-node step must cache npm/,
        ],
        [
            scheduledWorkflow.replace('        run: npm ci', '        run: npm install'),
            /scheduled-macos must run npm ci/,
        ],
        [
            `${scheduledWorkflow}\n    continue-on-error: true\n`,
            /must not define continue-on-error/,
        ],
    ]) {
        assert.throws(() => validateScheduledWorkflow(source), message);
    }
});
