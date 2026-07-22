'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VSCODE_STABLE_VERSION = '1.130.0';
const EXTENSION_HOST_TIMEOUT_MS = 120000;
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
            VSCODE_IPC_HOOK_CLI: '',
        },
    };
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
    VSCODE_STABLE_VERSION,
    createExtensionHostTestEnvironment,
    createRunTestsOptions,
    removeExtensionHostTestEnvironment,
};
