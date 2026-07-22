'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
    EXTENSION_HOST_TIMEOUT_MS,
    EXTENSION_HOST_WORKER_TIMEOUT_MS,
    HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS,
    VSCODE_STABLE_VERSION,
    createExtensionHostTestEnvironment,
    createRunTestsOptions,
    removeExtensionHostTestEnvironment,
    runWorkerWithWatchdog,
    withSanitizedExtensionHostEnvironment,
} = require('../../../scripts/lib/extensionHostLauncher');

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 launches both extensions with pinned stable VS Code', () => {
    const repositoryRoot = path.resolve(__dirname, '../../..');
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-launcher-test-'));
    try {
        const environment = createExtensionHostTestEnvironment(isolatedRoot);
        const options = createRunTestsOptions(repositoryRoot, environment);

        assert.equal(VSCODE_STABLE_VERSION, '1.130.0');
        assert.equal(EXTENSION_HOST_TIMEOUT_MS, 120000);
        assert.deepEqual(options.extensionDevelopmentPath, [
            repositoryRoot,
            path.join(repositoryRoot, 'extensions', 'attention-ui-bridge'),
        ]);
        assert.equal(options.version, VSCODE_STABLE_VERSION);
        assert.equal(options.extensionTestsPath,
            path.join(repositoryRoot, 'tests', 'extension-host', 'suite', 'index.js'));
        assert.deepEqual(options.launchArgs, [
            environment.workspace,
            `--user-data-dir=${environment.userData}`,
            `--extensions-dir=${environment.extensions}`,
        ]);
        assert.equal(options.extensionTestsEnv.HOME, environment.home);
        assert.equal(options.extensionTestsEnv.XDG_CONFIG_HOME, path.join(isolatedRoot, 'xdg', 'config'));
        assert.equal(options.extensionTestsEnv.XDG_DATA_HOME, path.join(isolatedRoot, 'xdg', 'data'));
        assert.equal(options.extensionTestsEnv.XDG_CACHE_HOME, path.join(isolatedRoot, 'xdg', 'cache'));
        assert.equal(options.extensionTestsEnv.CODEX_HOME, environment.codexHome);
        assert.equal(options.extensionTestsEnv.KIMI_SHARE_DIR, environment.kimiHome);
        assert.equal(options.extensionTestsEnv.CLAUDE_HOME, environment.claudeHome);
        assert.equal(options.extensionTestsEnv.PROJECT_STEWARD_EXTENSION_HOST_TIMEOUT_MS, '120000');
        assert.equal(Object.prototype.hasOwnProperty.call(
            options.extensionTestsEnv, 'VSCODE_IPC_HOOK_CLI'), false);
        for (const directory of Object.values(environment)) {
            assert.equal(fs.statSync(directory).isDirectory(), true);
            assert.equal(path.relative(isolatedRoot, directory).startsWith('..'), false);
        }
    } finally {
        removeExtensionHostTestEnvironment(isolatedRoot);
    }
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 removes hostile parent variables and restores exact state after failure', async () => {
    const original = new Map(HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS.map(key => [key, process.env[key]]));
    for (const [index, key] of HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS.entries()) {
        if (index === HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS.length - 1) delete process.env[key];
        else process.env[key] = `hostile-${index}`;
    }
    try {
        await assert.rejects(
            withSanitizedExtensionHostEnvironment(async () => {
                for (const key of HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS) {
                    assert.equal(Object.prototype.hasOwnProperty.call(process.env, key), false, key);
                }
                throw new Error('fixture failure');
            }),
            /fixture failure/);
        for (const [index, key] of HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS.entries()) {
            if (index === HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS.length - 1) {
                assert.equal(Object.prototype.hasOwnProperty.call(process.env, key), false, key);
            } else {
                assert.equal(process.env[key], `hostile-${index}`, key);
            }
        }
    } finally {
        for (const [key, value] of original) {
            value === undefined ? delete process.env[key] : process.env[key] = value;
        }
    }
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 watchdog terminates the POSIX worker process group', async () => {
    const child = new EventEmitter();
    child.pid = 4321;
    const kills = [];
    const timers = [];
    let settlements = 0;
    const promise = runWorkerWithWatchdog(() => child, {
        timeoutMs: 25,
        platform: 'linux',
        killProcess: (pid, signal) => { kills.push([pid, signal]); },
        setTimeout: (callback, delay) => {
            const timer = { callback, cleared: false, delay };
            timers.push(timer);
            return timer;
        },
        clearTimeout: timer => { timer.cleared = true; },
    });
    promise.then(() => { settlements += 1; }, () => { settlements += 1; });

    timers[0].callback();
    child.emit('close', null, 'SIGTERM');
    await Promise.resolve();
    assert.equal(settlements, 0, 'worker close must not settle before process-group escalation');
    assert.equal(timers[1].cleared, false, 'worker close must not clear the force-kill timer');
    timers[1].callback();

    await assert.rejects(promise, /exceeded 25 ms/);
    assert.equal(EXTENSION_HOST_WORKER_TIMEOUT_MS, 480000);
    assert.deepEqual(kills, [[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
    assert.equal(settlements, 1);
    assert.equal(timers.every(timer => timer.cleared), true);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('close'), 0);
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 watchdog treats ESRCH as a cleanly absent process group', async () => {
    const child = new EventEmitter();
    child.pid = 9876;
    const timers = [];
    const promise = runWorkerWithWatchdog(() => child, {
        timeoutMs: 25,
        platform: 'darwin',
        killProcess: () => {
            const error = new Error('no such process group');
            error.code = 'ESRCH';
            throw error;
        },
        setTimeout: (callback, delay) => {
            const timer = { callback, cleared: false, delay };
            timers.push(timer);
            return timer;
        },
        clearTimeout: timer => { timer.cleared = true; },
    });

    timers[0].callback();

    await assert.rejects(promise, /exceeded 25 ms/);
    assert.equal(timers.length, 1, 'ESRCH must not schedule a redundant force kill');
    assert.equal(timers[0].cleared, true);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('close'), 0);
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 cleanup removes only the owned isolation root', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-launcher-parent-'));
    const isolatedRoot = path.join(parent, 'owned');
    createExtensionHostTestEnvironment(isolatedRoot);
    fs.writeFileSync(path.join(parent, 'keep.txt'), 'keep');

    removeExtensionHostTestEnvironment(isolatedRoot);

    assert.equal(fs.existsSync(isolatedRoot), false);
    assert.equal(fs.readFileSync(path.join(parent, 'keep.txt'), 'utf8'), 'keep');
    fs.rmSync(parent, { recursive: true, force: true });
});
