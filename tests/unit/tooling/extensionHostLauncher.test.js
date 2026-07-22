'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    EXTENSION_HOST_TIMEOUT_MS,
    VSCODE_STABLE_VERSION,
    createExtensionHostTestEnvironment,
    createRunTestsOptions,
    removeExtensionHostTestEnvironment,
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
        assert.equal(options.extensionTestsEnv.VSCODE_IPC_HOOK_CLI, '');
        for (const directory of Object.values(environment)) {
            assert.equal(fs.statSync(directory).isDirectory(), true);
            assert.equal(path.relative(isolatedRoot, directory).startsWith('..'), false);
        }
    } finally {
        removeExtensionHostTestEnvironment(isolatedRoot);
    }
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
