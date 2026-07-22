'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');

const MAIN_EXTENSION_ID = 'hzcheng.project-steward';
const BRIDGE_EXTENSION_ID = 'hzcheng.project-steward-attention-ui-bridge';

async function verifyExtensionHostLifecycle() {
    const mainExtension = vscode.extensions.getExtension(MAIN_EXTENSION_ID);
    const bridgeExtension = vscode.extensions.getExtension(BRIDGE_EXTENSION_ID);
    assert.ok(mainExtension, `${MAIN_EXTENSION_ID} must be discoverable in the Extension Host`);
    assert.ok(bridgeExtension, `${BRIDGE_EXTENSION_ID} must be discoverable in the Extension Host`);

    await bridgeExtension.activate();
    await mainExtension.activate();
    assert.equal(bridgeExtension.isActive, true, `${BRIDGE_EXTENSION_ID} must activate`);
    assert.equal(mainExtension.isActive, true, `${MAIN_EXTENSION_ID} must activate`);

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('projectSteward.open'),
        'activated main extension must register projectSteward.open');
    const views = mainExtension.packageJSON.contributes && mainExtension.packageJSON.contributes.views;
    assert.ok(Array.isArray(views && views['project-steward'])
        && views['project-steward'].some(view => view.id === 'projectSteward.steward'),
    'main extension must contribute the projectSteward.steward view');
}

// RELEASE-SCHEDULED-EXTENSION-HOST-001
async function run() {
    const timeoutMs = Number(process.env.PROJECT_STEWARD_EXTENSION_HOST_TIMEOUT_MS);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
        'Extension Host timeout must be a positive integer');
    let timeout;
    try {
        await Promise.race([
            verifyExtensionHostLifecycle(),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error(
                    `Extension Host lifecycle exceeded ${timeoutMs} ms`
                )), timeoutMs);
            }),
        ]);
        console.log(`RELEASE-SCHEDULED-EXTENSION-HOST-001 passed on VS Code ${vscode.version}.`);
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { run };
