'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VSCODE_STABLE_VERSION = '1.130.0';
const EXTENSION_HOST_TIMEOUT_MS = 120000;
const EXTENSION_HOST_WORKER_TIMEOUT_MS = 480000;
const HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS = Object.freeze([
    'ELECTRON_RUN_AS_NODE',
    'VSCODE_ESM_ENTRYPOINT',
    'VSCODE_CWD',
    'VSCODE_NLS_CONFIG',
    'VSCODE_IPC_HOOK_CLI',
]);
const OWNERSHIP_MARKER = '.project-steward-extension-host-test';
const OWNERSHIP_VALUE = 'owned temporary extension host test directory\n';

function createExtensionHostTestEnvironment(isolatedRoot) {
    if (!path.isAbsolute(isolatedRoot)) {
        throw new Error('Extension Host isolation root must be absolute.');
    }
    fs.mkdirSync(isolatedRoot, { recursive: true });
    fs.writeFileSync(path.join(isolatedRoot, OWNERSHIP_MARKER), OWNERSHIP_VALUE, { flag: 'wx' });
    const environment = {
        workspace: path.join(isolatedRoot, 'workspace'),
        userData: path.join(isolatedRoot, 'user-data'),
        extensions: path.join(isolatedRoot, 'extensions'),
        home: path.join(isolatedRoot, 'home'),
        xdgConfigHome: path.join(isolatedRoot, 'xdg', 'config'),
        xdgDataHome: path.join(isolatedRoot, 'xdg', 'data'),
        xdgCacheHome: path.join(isolatedRoot, 'xdg', 'cache'),
        codexHome: path.join(isolatedRoot, 'providers', 'codex'),
        kimiHome: path.join(isolatedRoot, 'providers', 'kimi'),
        claudeHome: path.join(isolatedRoot, 'providers', 'claude'),
    };
    for (const directory of Object.values(environment)) {
        fs.mkdirSync(directory, { recursive: true });
    }
    return environment;
}

function createRunTestsOptions(repositoryRoot, environment) {
    return {
        version: VSCODE_STABLE_VERSION,
        extensionDevelopmentPath: [
            repositoryRoot,
            path.join(repositoryRoot, 'extensions', 'attention-ui-bridge'),
        ],
        extensionTestsPath: path.join(repositoryRoot, 'tests', 'extension-host', 'suite', 'index.js'),
        launchArgs: [
            environment.workspace,
            `--user-data-dir=${environment.userData}`,
            `--extensions-dir=${environment.extensions}`,
        ],
        extensionTestsEnv: {
            HOME: environment.home,
            XDG_CONFIG_HOME: environment.xdgConfigHome,
            XDG_DATA_HOME: environment.xdgDataHome,
            XDG_CACHE_HOME: environment.xdgCacheHome,
            CODEX_HOME: environment.codexHome,
            KIMI_SHARE_DIR: environment.kimiHome,
            CLAUDE_HOME: environment.claudeHome,
            PROJECT_STEWARD_EXTENSION_HOST_TIMEOUT_MS: String(EXTENSION_HOST_TIMEOUT_MS),
        },
    };
}

async function withSanitizedExtensionHostEnvironment(callback) {
    const previous = new Map(HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS.map(key => [key, {
        existed: Object.prototype.hasOwnProperty.call(process.env, key),
        value: process.env[key],
    }]));
    for (const key of HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS) delete process.env[key];
    try {
        return await callback();
    } finally {
        for (const [key, state] of previous) {
            if (state.existed) process.env[key] = state.value;
            else delete process.env[key];
        }
    }
}

function runWorkerWithWatchdog(spawnWorker, options = {}) {
    const timeoutMs = options.timeoutMs || EXTENSION_HOST_WORKER_TIMEOUT_MS;
    const platform = options.platform || process.platform;
    const killProcess = options.killProcess || process.kill.bind(process);
    const setTimeoutFn = options.setTimeout || setTimeout;
    const clearTimeoutFn = options.clearTimeout || clearTimeout;
    return new Promise((resolve, reject) => {
        let child;
        let timedOut = false;
        let forceTimer;
        let timeoutTimer;
        let settled = false;
        const clearTimers = () => {
            if (timeoutTimer !== undefined) clearTimeoutFn(timeoutTimer);
            if (forceTimer !== undefined) clearTimeoutFn(forceTimer);
        };
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimers();
            error ? reject(error) : resolve();
        };
        const terminate = signal => {
            if (!child || !child.pid) return;
            if (platform === 'darwin' || platform === 'linux') killProcess(-child.pid, signal);
            else child.kill(signal);
        };
        try {
            child = spawnWorker();
        } catch (error) {
            finish(error);
            return;
        }
        child.once('error', finish);
        child.once('close', (code, signal) => {
            if (timedOut) {
                finish(new Error(`Extension Host worker exceeded ${timeoutMs} ms and was terminated`));
            } else if (code === 0) {
                finish();
            } else {
                finish(new Error(`Extension Host worker failed with code ${code === null ? signal : code}`));
            }
        });
        timeoutTimer = setTimeoutFn(() => {
            timedOut = true;
            try {
                terminate('SIGTERM');
                forceTimer = setTimeoutFn(() => {
                    try {
                        terminate('SIGKILL');
                    } catch (error) {
                        finish(error);
                    }
                }, 5000);
            } catch (error) {
                finish(error);
            }
        }, timeoutMs);
    });
}

function removeExtensionHostTestEnvironment(isolatedRoot) {
    const markerPath = path.join(isolatedRoot, OWNERSHIP_MARKER);
    if (!path.isAbsolute(isolatedRoot) || !fs.existsSync(markerPath)
        || fs.readFileSync(markerPath, 'utf8') !== OWNERSHIP_VALUE) {
        throw new Error('Refusing to remove an unowned Extension Host test directory.');
    }
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
}

module.exports = {
    EXTENSION_HOST_TIMEOUT_MS,
    EXTENSION_HOST_WORKER_TIMEOUT_MS,
    HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS,
    VSCODE_STABLE_VERSION,
    createExtensionHostTestEnvironment,
    createRunTestsOptions,
    removeExtensionHostTestEnvironment,
    runWorkerWithWatchdog,
    withSanitizedExtensionHostEnvironment,
};
