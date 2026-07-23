'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
    createOwnedTemporaryRoot,
    removeOwnedTemporaryRoot,
    runBestEffortCleanup,
    runSmokeHarness,
    runTrackedProviderLaunch,
    stopAndVerifyProviderFixtures,
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

async function runFixtureStateScenario() {
    const calls = [];
    const planned = { launchState: { phase: 'planned' } };
    stopAndVerifyProviderFixtures([planned], {
        writeStop: () => { throw new Error('planned fixture must not receive a stop request'); },
        readFallbackPid: () => { throw new Error('planned fixture must not require PID evidence'); },
        probe: () => { throw new Error('planned fixture must not probe a process'); },
    });

    const launched = {
        invocationId: 'launched-fixture',
        invocationLogPath: '/virtual/provider-invocations.jsonl',
        pidPath: '/virtual/launched.pid',
        stopPath: '/virtual/launched.stop',
        launchState: { phase: 'planned' },
    };
    await runTrackedProviderLaunch(launched, async () => 'launched-result');
    const phaseAfterLaunch = launched.launchState.phase;
    stopAndVerifyProviderFixtures([launched], {
        writeStop: stopPath => calls.push(`stop:${stopPath}`),
        readInvocations: () => [{ invocationId: 'launched-fixture', pid: 4242 }],
        readFallbackPid: () => { throw new Error('ledger evidence must win'); },
        probe: pid => {
            calls.push(`probe:${pid}`);
            const error = new Error('not running');
            error.code = 'ESRCH';
            throw error;
        },
    });

    const ambiguous = {
        invocationId: 'ambiguous-fixture',
        invocationLogPath: '/virtual/provider-invocations.jsonl',
        pidPath: '/virtual/ambiguous.pid',
        stopPath: '/virtual/ambiguous.stop',
        launchState: { phase: 'planned' },
    };
    let dispatchError;
    try {
        await runTrackedProviderLaunch(ambiguous, async () => { throw new Error('dispatch failed'); });
    } catch (error) {
        dispatchError = error.message;
    }
    let ambiguousCleanupError;
    try {
        stopAndVerifyProviderFixtures([ambiguous], {
            writeStop: stopPath => calls.push(`stop:${stopPath}`),
            readInvocations: () => [],
            readFallbackPid: () => null,
            probe: () => { throw new Error('missing evidence must not probe a process'); },
        });
    } catch (error) {
        ambiguousCleanupError = { name: error.name, count: error.errors.length };
    }

    let retainedRoot;
    let retainedRootExists;
    try {
        await runSmokeHarness({
            onRootsCreated: roots => { retainedRoot = roots.fixture; },
            createRunner: () => ({ kind: 'runner' }),
            createClient: () => ({ checkAvailability: async () => ({ available: true }) }),
            runSmoke: async (root, runner, client, fixtures) => {
                fixtures.push({
                    pidPath: `${root}/missing.pid`,
                    stopPath: `${root}/ambiguous.stop`,
                    launchState: { phase: 'launching' },
                });
                throw new Error('smoke failed after ambiguous dispatch');
            },
            captureSocket: () => null,
            killServer: () => undefined,
            verifyStopped: () => undefined,
            removeSocket: () => undefined,
        });
    } catch (error) {
        retainedRootExists = fs.existsSync(retainedRoot.path);
    } finally {
        if (retainedRoot && fs.existsSync(retainedRoot.path)) removeOwnedTemporaryRoot(retainedRoot);
    }

    let plannedRoots;
    let plannedHarnessError;
    try {
        await runSmokeHarness({
            onRootsCreated: roots => { plannedRoots = roots; },
            createRunner: () => ({ kind: 'runner' }),
            createClient: () => ({ checkAvailability: async () => ({ available: true }) }),
            runSmoke: async (root, runner, client, fixtures) => {
                fixtures.push({ launchState: { phase: 'planned' } });
                throw new Error('smoke failed before dispatch');
            },
            captureSocket: () => null,
            killServer: () => undefined,
            verifyStopped: () => undefined,
            removeSocket: () => undefined,
        });
    } catch (error) {
        plannedHarnessError = error.message;
    }

    return {
        calls,
        phases: {
            planned: planned.launchState.phase,
            afterLaunch: phaseAfterLaunch,
            launched: launched.launchState.phase,
            ambiguous: ambiguous.launchState.phase,
        },
        dispatchError,
        ambiguousCleanupError,
        retainedRootExists,
        plannedHarnessError,
        plannedRootsExist: {
            fixture: fs.existsSync(plannedRoots.fixture.path),
            tmux: fs.existsSync(plannedRoots.tmux.path),
        },
    };
}

async function main() {
    const scenario = process.argv[2];
    const result = scenario === 'harness'
        ? await runHarnessScenario()
        : scenario === 'cleanup'
            ? await runCleanupScenario()
            : scenario === 'fixture-states'
                ? await runFixtureStateScenario()
            : (() => { throw new Error(`Unknown scenario: ${scenario}`); })();
    process.stdout.write(JSON.stringify(result));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
