'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const {
    VSCODE_STABLE_VERSION,
    createExtensionHostTestEnvironment,
    createRunTestsOptions,
    removeExtensionHostTestEnvironment,
} = require('./lib/extensionHostLauncher');

async function main() {
    const repositoryRoot = path.resolve(__dirname, '..');
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-extension-host-'));
    try {
        const environment = createExtensionHostTestEnvironment(isolatedRoot);
        console.log(`Running isolated Extension Host smoke with VS Code ${VSCODE_STABLE_VERSION}.`);
        await runTests(createRunTestsOptions(repositoryRoot, environment));
    } finally {
        removeExtensionHostTestEnvironment(isolatedRoot);
    }
}

main().catch(error => {
    console.error(`Extension Host smoke failed: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
});
