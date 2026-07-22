'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
    createOwnedTemporaryRoot,
    removeOwnedTemporaryRoot,
    runBestEffortCleanup,
    runSmokeHarness,
} = require('../../../scripts/run-ai-session-tmux-smoke-checks');

async function runHarnessScenario() {
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
    return {
        calls,
        instrumentation: {
            nodeOptions: process.env.NODE_OPTIONS || null,
            v8Coverage: process.env.NODE_V8_COVERAGE || null,
        },
        rootsExist: {
            fixture: fs.existsSync(roots.fixture.path),
            tmux: fs.existsSync(roots.tmux.path),
        },
    };
}

async function runCleanupScenario() {
    const owned = createOwnedTemporaryRoot('project-steward-tmux-smoke-');
    const foreignPath = `${owned.path}-foreign`;
    fs.mkdirSync(foreignPath);
    let rejectedForeignRoot = false;
    try {
        assert.throws(() => removeOwnedTemporaryRoot({ path: foreignPath }), /validated owned temporary root/);
        rejectedForeignRoot = true;
        removeOwnedTemporaryRoot(owned);

        const calls = [];
        let cleanupError;
        try {
            await runBestEffortCleanup({
                captureSocket: () => { calls.push('capture'); return '/fixture/socket'; },
                killServer: () => { calls.push('kill'); throw new Error('kill failed'); },
                verifyStopped: () => { calls.push('verify'); },
                removeSocket: socket => calls.push(`socket:${socket}`),
                terminateProviders: () => calls.push('providers'),
                removeFixtures: (serverStopped, providersStopped) => {
                    calls.push(`roots:${serverStopped}:${providersStopped}`);
                },
            });
        } catch (error) {
            cleanupError = { name: error.name, count: error.errors.length };
        }
        return {
            calls,
            cleanupError,
            pathsExist: { owned: fs.existsSync(owned.path), foreign: fs.existsSync(foreignPath) },
            rejectedForeignRoot,
        };
    } finally {
        fs.rmSync(foreignPath, { recursive: true, force: true });
    }
}

async function main() {
    const scenario = process.argv[2];
    const result = scenario === 'harness'
        ? await runHarnessScenario()
        : scenario === 'cleanup'
            ? await runCleanupScenario()
            : (() => { throw new Error(`Unknown scenario: ${scenario}`); })();
    process.stdout.write(JSON.stringify(result));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
