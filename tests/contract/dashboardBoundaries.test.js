'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const configuration = require('../../out/dashboard/configuration');
const { shouldOpenStewardOnStartup } = require('../../out/dashboard/startup');
const { DashboardRuntimeController } = require('../../out/dashboard/runtimeController');
const { DashboardCommandRegistration } = require('../../out/dashboard/commandRegistration');
const {
    ActiveTerminalFileReferenceController,
    formatFileReference,
    getPrimarySelectionLineRange,
} = require('../../out/dashboard/activeTerminalFileReference');

function configured(values = {}, members = {}) {
    return {
        ...members,
        get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
        },
        inspect(key) {
            return Object.prototype.hasOwnProperty.call(values, key) ? { globalValue: values[key] } : undefined;
        },
    };
}

function flushAsync() {
    return new Promise(resolve => setImmediate(resolve));
}

test('SESSION-CONFIGURATION-001 preserves primary precedence, legacy fallback, defaults, properties, and bound passthrough methods', async () => {
    const calls = [];
    const primary = configured({ customCss: '.primary{}', falseValue: false }, {
        marker: 'primary-marker',
        update(key, value) {
            calls.push([this.marker, key, value]);
            return Promise.resolve('updated');
        },
    });
    const legacy = configured({ customCss: '.legacy{}', displayProjectPath: false, legacyProperty: 'legacy' });
    const steward = configuration.createStewardConfiguration(primary, legacy);

    assert.equal(steward.get('customCss'), '.primary{}');
    assert.equal(steward.get('displayProjectPath'), false);
    assert.equal(steward.get('missing', 'default'), 'default');
    assert.equal(steward.customCss, '.primary{}');
    assert.equal(steward.legacyProperty, 'legacy');
    assert.equal(steward.unknownProperty, undefined);
    assert.equal(steward.marker, 'primary-marker');
    assert.equal(await steward.update('color', '#fff'), 'updated');
    assert.deepEqual(calls, [['primary-marker', 'color', '#fff']]);

    for (const field of [
        'globalValue', 'workspaceValue', 'workspaceFolderValue',
        'globalLanguageValue', 'workspaceLanguageValue', 'workspaceFolderLanguageValue',
    ]) {
        assert.equal(configuration.hasConfiguredValue({ inspect: () => ({ [field]: false }) }, 'value'), true);
    }
    assert.equal(configuration.hasConfiguredValue({ inspect: () => ({}) }, 'value'), false);
    assert.equal(configuration.hasConfiguredValue({ inspect: () => undefined }, 'value'), false);
});

test('SESSION-STARTUP-001 preserves reopen, always, never, and genuinely empty-workspace startup behavior', () => {
    const decide = input => shouldOpenStewardOnStartup({
        reopenReason: 0, reopenNoneValue: 0, openOnStartup: 'empty workspace',
        workspaceName: '', visibleEditorLanguageIds: [], ...input,
    });
    assert.equal(decide({ reopenReason: 1, openOnStartup: 'never', workspaceName: 'project' }), true);
    assert.equal(decide({ openOnStartup: 'always', workspaceName: 'project' }), true);
    assert.equal(decide({ openOnStartup: 'never' }), false);
    assert.equal(decide({}), true);
    assert.equal(decide({ visibleEditorLanguageIds: ['code-runner-output'] }), true);
    assert.equal(decide({ visibleEditorLanguageIds: ['typescript'] }), false);
    assert.equal(decide({ visibleEditorLanguageIds: ['code-runner-output', 'typescript'] }), false);
    assert.equal(decide({ workspaceName: 'project' }), false);
    assert.equal(decide({ openOnStartup: 'unrecognized' }), true);
});

function runtimeHarness(overrides = {}) {
    const events = [];
    let visible = true;
    const options = {
        isVisible: () => visible,
        refreshProvider: () => events.push(['refresh']),
        logDashboardDiagnostic: value => events.push(['diagnostic', value]),
        executeCommand: async (command, ...args) => events.push(['command', command, ...args]),
        viewType: 'fixture.view',
        publishOpenWorkspace: () => events.push(['publish']),
        getCurrentSavedProject: () => ({ id: 'project', path: '/work' }),
        syncProjectColorToCurrentWindow: async project => events.push(['color', project?.id || null]),
        postMessage: async message => events.push(['message', message]),
        logError: (message, error) => events.push(['error', message, error.message]),
        ...overrides,
    };
    return {
        controller: new DashboardRuntimeController(options),
        events,
        setVisible(value) { visible = value; },
    };
}

test('RUNTIME-DASHBOARD-RUNTIME-CONTROLLER-001 refreshes and reveals only through the stable production command boundary', async () => {
    const harness = runtimeHarness();
    harness.controller.refresh('manual');
    harness.setVisible(false);
    harness.controller.refresh('hidden');
    harness.setVisible(true);
    await harness.controller.showSteward();
    await harness.controller.openSettings();

    assert.deepEqual(harness.events, [
        ['diagnostic', { event: 'full-refresh', reason: 'manual' }],
        ['refresh'],
        ['publish'],
        ['command', 'workbench.view.extension.project-steward'],
        ['command', 'fixture.view.focus'],
        ['diagnostic', { event: 'full-refresh', reason: 'show-steward' }],
        ['refresh'],
        ['command', 'workbench.action.openSettings', '@ext:hzcheng.project-steward'],
    ]);

    const attempts = [];
    const retry = runtimeHarness({
        executeCommand(command) {
            attempts.push(command);
            if (command === 'fixture.view.focus' && attempts.filter(value => value === command).length === 1) {
                return Promise.reject(new Error('focus race'));
            }
            return Promise.resolve();
        },
    });
    await retry.controller.revealSidebarSteward();
    assert.deepEqual(attempts, [
        'workbench.view.extension.project-steward', 'fixture.view.focus', 'fixture.view.focus',
    ]);

    const revealThrows = runtimeHarness({ executeCommand: () => { throw new Error('reveal failed'); } });
    await assert.doesNotReject(revealThrows.controller.revealSidebarSteward());
});

test('RUNTIME-DASHBOARD-RUNTIME-CONTROLLER-001 publishes exact batch, terminal, mutation, color, and visibility effects', async () => {
    const harness = runtimeHarness();
    const batch = { type: 'ai-session-batch-archive-completed', archived: 2 };
    harness.controller.postBatchArchiveCompletion(batch);
    harness.controller.postActiveAiSessionTerminalChanged({ provider: 'codex', sessionId: 's1' });
    harness.controller.postActiveAiSessionTerminalChanged(null);
    harness.controller.applyProjectColorToCurrentWindow();
    harness.controller.applyProjectColorToCurrentWindow({ id: 'save', showSaveAction: true });
    harness.controller.refreshAfterMutation('saved');
    await flushAsync();

    assert.deepEqual(harness.events, [
        ['message', batch],
        ['message', { type: 'active-ai-session-terminal-changed', provider: 'codex', sessionId: 's1' }],
        ['message', { type: 'active-ai-session-terminal-changed', provider: null, sessionId: null }],
        ['color', 'project'],
        ['color', 'save'],
        ['color', 'project'],
        ['diagnostic', { event: 'full-refresh', reason: 'saved' }],
        ['refresh'],
        ['publish'],
    ]);

    const visibleEffects = [];
    const visibility = runtimeHarness({
        refreshAiSessionRuntimes: async (reason, force) => visibleEffects.push([reason, force]),
    });
    await visibility.controller.handleAiSessionViewVisibilityChanged(false);
    await visibility.controller.handleAiSessionViewVisibilityChanged(true);
    assert.deepEqual(visibleEffects, [['dashboard-visible', true]]);
});

test('RUNTIME-DASHBOARD-RUNTIME-CONTROLLER-001 maps rejected promises and synchronous throws to stable diagnostics', async () => {
    for (const mode of ['reject', 'throw']) {
        const errors = [];
        const fail = () => {
            const error = new Error(`${mode} failure`);
            if (mode === 'throw') throw error;
            return Promise.reject(error);
        };
        const controller = new DashboardRuntimeController({
            isVisible: () => true, refreshProvider() {}, logDashboardDiagnostic() {},
            executeCommand: async () => undefined, viewType: 'fixture.view', publishOpenWorkspace() {},
            getCurrentSavedProject: () => ({ id: 'project' }), syncProjectColorToCurrentWindow: fail,
            postMessage: fail,
            logError: (message, error) => errors.push([message, error.message]),
        });
        controller.postBatchArchiveCompletion({ type: 'batch' });
        controller.postActiveAiSessionTerminalChanged(null);
        controller.applyProjectColorToCurrentWindow();
        await flushAsync();
        assert.deepEqual(errors, [
            ['Failed to post batch AI session archive completion.', `${mode} failure`],
            ['Failed to post the active AI session terminal.', `${mode} failure`],
            ['Failed to apply project color to current window.', `${mode} failure`],
        ]);
    }
});

const DASHBOARD_COMMANDS = [
    'projectSteward.open', 'projectSteward.addProject', 'projectSteward.saveProject',
    'projectSteward.removeProject', 'projectSteward.editProjects', 'projectSteward.addGroup',
    'projectSteward.removeGroup', 'projectSteward.addProjectsFromFolder',
    'projectSteward.addFileToActiveTerminal',
];

test('WEBVIEW-DASHBOARD-COMMAND-REGISTRATION-001 registers exact callbacks and subscriptions', async () => {
    const registered = new Map();
    const subscriptions = [];
    const calls = [];
    const handlerNames = [
        'open', 'addProject', 'saveProject', 'removeProject', 'editProjects', 'addGroup', 'removeGroup',
        'addProjectsFromFolder', 'addFileToActiveTerminal',
    ];
    const handlers = Object.fromEntries(handlerNames.map(name => [name, (...args) => calls.push([name, ...args])]));
    new DashboardCommandRegistration({
        registerCommand: (command, callback) => {
            registered.set(command, callback);
            return { command, dispose() {} };
        },
        pushSubscription: disposable => subscriptions.push(disposable),
        handlers,
    }).register();

    assert.deepEqual([...registered.keys()], DASHBOARD_COMMANDS);
    for (const callback of registered.values()) await callback('ignored');
    assert.deepEqual(calls, handlerNames.map(name => [name, 'ignored']));
    assert.deepEqual(subscriptions.map(value => value.command), DASHBOARD_COMMANDS);
});

test('WEBVIEW-DASHBOARD-COMMAND-REGISTRATION-001 production activation installs the exact Dashboard public command surface', () => {
    const environment = { ...process.env, NODE_V8_COVERAGE: '' };
    const result = spawnSync(process.execPath, [
        path.resolve(__dirname, '../fixtures/aiSessions/runtimeHostActivationHarness.js'), 'success',
    ], { encoding: 'utf8', env: environment });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const activation = JSON.parse(result.stdout);
    assert.equal(activation.failure, null);
    assert.equal(activation.dashboardCommandRegistrationInvocations, 1);
    assert.deepEqual(
        activation.registeredCommands.filter(command => command.startsWith('projectSteward.')),
        DASHBOARD_COMMANDS
    );
});

function fileReferenceHarness({ editor, terminal, relativePath = 'src/file.ts' }) {
    const sent = [];
    const warnings = [];
    let shown = 0;
    const activeTerminal = terminal === undefined ? {
        sendText: (value, addNewLine) => sent.push([value, addNewLine]),
        show: () => { shown += 1; },
    } : terminal;
    const controller = new ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => editor,
        getActiveTerminal: () => activeTerminal,
        asRelativePath: () => relativePath,
        showWarningMessage: message => warnings.push(message),
    });
    return { controller, sent, warnings, get shown() { return shown; } };
}

test('SESSION-ACTIVE-TERMINAL-FILE-REFERENCE-001 formats local, empty, reversed, and remote saved-file references', async () => {
    assert.equal(formatFileReference('src/file.ts', null), 'src/file.ts');
    assert.equal(formatFileReference('src/file.ts', { startLine: 3, endLine: 3 }), 'src/file.ts:3');
    assert.equal(formatFileReference('src/file.ts', { startLine: 3, endLine: 5 }), 'src/file.ts:3-5');
    assert.equal(getPrimarySelectionLineRange(null), null);
    assert.equal(getPrimarySelectionLineRange({ isEmpty: true, start: { line: 9 }, end: { line: 9 } }), null);
    const reversed = { isEmpty: false, start: { line: 4 }, end: { line: 2 } };
    assert.deepEqual(getPrimarySelectionLineRange(reversed), { startLine: 3, endLine: 5 });

    const local = fileReferenceHarness({
        editor: { document: { uri: { scheme: 'file', fsPath: '/repo/src/file.ts' } }, selection: reversed },
    });
    await local.controller.addFileToActiveTerminal();
    assert.deepEqual(local.sent, [['src/file.ts:3-5', false]]);
    assert.equal(local.shown, 1);

    const remote = fileReferenceHarness({
        editor: {
            document: { uri: { scheme: 'vscode-remote', path: '/work/app.ts' } },
            selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
        },
        relativePath: 'app.ts',
    });
    await remote.controller.addFileToActiveTerminal();
    assert.deepEqual(remote.sent, [['app.ts', false]]);
});

test('SESSION-ACTIVE-TERMINAL-FILE-REFERENCE-001 warns without effects for missing terminals and unsaved editors', async () => {
    const editor = {
        document: { uri: { scheme: 'file', fsPath: '/repo/src/file.ts' } },
        selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
    };
    const missingTerminal = fileReferenceHarness({ editor, terminal: null });
    await missingTerminal.controller.addFileToActiveTerminal();
    assert.deepEqual(missingTerminal.warnings, ['No active terminal to receive the file reference.']);
    assert.deepEqual(missingTerminal.sent, []);

    const untitled = fileReferenceHarness({
        editor: { ...editor, document: { uri: { scheme: 'untitled', path: 'Untitled-1' } } },
    });
    await untitled.controller.addFileToActiveTerminal();
    assert.deepEqual(untitled.warnings, ['Open a saved file before adding it to the active terminal.']);
    assert.deepEqual(untitled.sent, []);
});
