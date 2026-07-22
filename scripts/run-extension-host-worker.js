'use strict';

const { runTests } = require('@vscode/test-electron');
const { VSCODE_STABLE_VERSION, createRunTestsOptions } = require('./lib/extensionHostLauncher');

async function main() {
    const repositoryRoot = process.argv[2];
    const environment = JSON.parse(process.argv[3]);
    if (!repositoryRoot || !environment || typeof environment.workspace !== 'string') {
        throw new Error('Extension Host worker requires repository and isolation paths.');
    }
    console.log(`Running isolated Extension Host smoke with VS Code ${VSCODE_STABLE_VERSION}.`);
    await runTests(createRunTestsOptions(repositoryRoot, environment));
}

main().catch(error => {
    console.error(`Extension Host worker failed: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
});
