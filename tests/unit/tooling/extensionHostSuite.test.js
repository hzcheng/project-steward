'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const suitePath = path.resolve(__dirname, '../../extension-host/suite/index.js');
const bridgeId = 'hzcheng.project-steward-attention-ui-bridge';
const commandRegistrationPath = path.resolve(__dirname, '../../../out/dashboard/commandRegistration.js');

function loadSuite(vscode) {
    const previousLoad = Module._load;
    delete require.cache[suitePath];
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        return previousLoad.call(this, request, parent, isMain);
    };
    try {
        return require(suitePath);
    } finally {
        Module._load = previousLoad;
    }
}

function assertOpenCommandRegistration(transform = source => source) {
    const source = transform(fs.readFileSync(commandRegistrationPath, 'utf8'));
    const loaded = new Module(commandRegistrationPath, module);
    loaded.filename = commandRegistrationPath;
    loaded.paths = Module._nodeModulePaths(path.dirname(commandRegistrationPath));
    loaded._compile(source, commandRegistrationPath);
    const commands = [];
    const noop = () => undefined;
    new loaded.exports.DashboardCommandRegistration({
        registerCommand: command => { commands.push(command); return { dispose: noop }; },
        pushSubscription: noop,
        handlers: {
            open: noop, addProject: noop, saveProject: noop, removeProject: noop,
            editProjects: noop, addGroup: noop, removeGroup: noop,
            addProjectsFromFolder: noop, addFileToActiveTerminal: noop,
        },
    }).register();
    assert.ok(commands.includes('projectSteward.open'),
        'RELEASE-SCHEDULED-EXTENSION-HOST-001 production activation must register projectSteward.open');
}

function createHostFixture() {
    const activationCalls = [];
    const executedCommands = [];
    const bridge = {
        isActive: false,
        packageJSON: { extensionKind: ['ui'] },
        activate: async () => { activationCalls.push('bridge'); bridge.isActive = true; },
    };
    const main = {
        isActive: false,
        packageJSON: { extensionDependencies: [bridgeId] },
        activate: async () => {
            activationCalls.push('main');
            main.isActive = true;
            bridge.isActive = true;
        },
    };
    const vscode = {
        version: 'fixture',
        extensions: {
            getExtension: id => id === 'hzcheng.project-steward' ? main : id === bridgeId ? bridge : undefined,
        },
        commands: {
            executeCommand: async command => { executedCommands.push(command); },
        },
    };
    return { activationCalls, bridge, executedCommands, main, vscode };
}

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 activates only main and exercises live command and view paths', async () => {
    const fixture = createHostFixture();
    const previousTimeout = process.env.PROJECT_STEWARD_EXTENSION_HOST_TIMEOUT_MS;
    process.env.PROJECT_STEWARD_EXTENSION_HOST_TIMEOUT_MS = '1000';
    try {
        await loadSuite(fixture.vscode).run();
    } finally {
        previousTimeout === undefined
            ? delete process.env.PROJECT_STEWARD_EXTENSION_HOST_TIMEOUT_MS
            : process.env.PROJECT_STEWARD_EXTENSION_HOST_TIMEOUT_MS = previousTimeout;
    }

    assert.deepEqual(fixture.activationCalls, ['main']);
    assert.equal(fixture.bridge.isActive, true, 'main activation must auto-activate its bridge dependency');
    assert.deepEqual(fixture.executedCommands, [
        'projectSteward.open',
        'projectSteward.steward.focus',
    ]);
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 rejects a missing bridge dependency before activation', async () => {
    const fixture = createHostFixture();
    fixture.main.packageJSON.extensionDependencies = [];
    const previousTimeout = process.env.PROJECT_STEWARD_EXTENSION_HOST_TIMEOUT_MS;
    process.env.PROJECT_STEWARD_EXTENSION_HOST_TIMEOUT_MS = '1000';
    try {
        await assert.rejects(loadSuite(fixture.vscode).run(), /extensionDependencies/);
    } finally {
        previousTimeout === undefined
            ? delete process.env.PROJECT_STEWARD_EXTENSION_HOST_TIMEOUT_MS
            : process.env.PROJECT_STEWARD_EXTENSION_HOST_TIMEOUT_MS = previousTimeout;
    }
    assert.deepEqual(fixture.activationCalls, []);
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 rejects missing production command registration mutation', () => {
    assertOpenCommandRegistration();
    assert.throws(() => assertOpenCommandRegistration(source => source.replace(
        "this.registerCommand('projectSteward.open', this.options.handlers.open);",
        ''
    )), /RELEASE-SCHEDULED-EXTENSION-HOST-001/);
});
