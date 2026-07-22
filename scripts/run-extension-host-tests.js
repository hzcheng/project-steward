'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const {
    EXTENSION_HOST_WORKER_TIMEOUT_MS,
    createExtensionHostTestEnvironment,
    removeExtensionHostTestEnvironment,
    runWorkerWithWatchdog,
    withSanitizedExtensionHostEnvironment,
} = require('./lib/extensionHostLauncher');

async function main() {
    const repositoryRoot = path.resolve(__dirname, '..');
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-extension-host-'));
    try {
        const environment = createExtensionHostTestEnvironment(isolatedRoot);
        const workerPath = path.join(__dirname, 'run-extension-host-worker.js');
        await withSanitizedExtensionHostEnvironment(() => runWorkerWithWatchdog(
            () => childProcess.spawn(process.execPath, [
                workerPath,
                repositoryRoot,
                JSON.stringify(environment),
            ], {
                detached: process.platform !== 'win32',
                env: { ...process.env },
                stdio: 'inherit',
            }),
            { timeoutMs: EXTENSION_HOST_WORKER_TIMEOUT_MS }
        ));
    } finally {
        removeExtensionHostTestEnvironment(isolatedRoot);
    }
}

main().catch(error => {
    console.error(`Extension Host smoke failed: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
});
