'use strict';

const assert = require('node:assert/strict');
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

function config(values) {
    return {
        get: (key, fallback) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback,
        inspect: key => Object.prototype.hasOwnProperty.call(values, key) ? { globalValue: values[key] } : undefined,
        update: () => 'updated',
    };
}

test('SESSION-CONFIGURATION-001 gives explicit primary values precedence and preserves legacy fallback', () => {
    const steward = configuration.createStewardConfiguration(config({ customCss: '.primary{}' }), config({
        customCss: '.legacy{}', displayProjectPath: false,
    }));
    assert.equal(steward.get('customCss'), '.primary{}');
    assert.equal(steward.get('displayProjectPath'), false);
    assert.equal(steward.get('missing', 'default'), 'default');
    assert.equal(steward.update(), 'updated');
    assert.equal(configuration.hasConfiguredValue(config({ value: false }), 'value'), true);
});

test('SESSION-STARTUP-001 opens for reopen and configured empty-workspace cases only', () => {
    assert.equal(shouldOpenStewardOnStartup({ reopenReason: 1, openOnStartup: 'never', workspaceName: 'project' }), true);
    assert.equal(shouldOpenStewardOnStartup({ openOnStartup: 'always', workspaceName: 'project' }), true);
    assert.equal(shouldOpenStewardOnStartup({ openOnStartup: 'never', workspaceName: '', visibleEditorLanguageIds: [] }), false);
    assert.equal(shouldOpenStewardOnStartup({ openOnStartup: 'empty workspace', workspaceName: '', visibleEditorLanguageIds: [] }), true);
    assert.equal(shouldOpenStewardOnStartup({ openOnStartup: 'empty workspace', workspaceName: 'project', visibleEditorLanguageIds: [] }), false);
});

test('RUNTIME-DASHBOARD-RUNTIME-CONTROLLER-001 routes observable refresh, reveal, message, and color effects', async () => {
    const events = [];
    let visible = true;
    const controller = new DashboardRuntimeController({
        isVisible: () => visible,
        refreshProvider: () => events.push('refresh'),
        logDashboardDiagnostic: value => events.push(['diagnostic', value]),
        executeCommand: async (command, ...args) => events.push(['command', command, ...args]),
        viewType: 'fixture.view', publishOpenProjects: () => events.push('publish'),
        getOpenProjects: () => [{ id: 'project', path: '/work' }],
        syncProjectColorToCurrentWindow: async project => events.push(['color', project?.id || null]),
        postMessage: async message => events.push(['message', message]),
        logError: (message, error) => events.push(['error', message, error.message]),
    });
    controller.refresh('manual');
    visible = false;
    controller.refresh('hidden');
    visible = true;
    await controller.showSteward();
    controller.postActiveAiSessionTerminalChanged({ provider: 'codex', sessionId: 's1' });
    controller.applyProjectColorToCurrentWindow();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.filter(item => item === 'refresh').length, 2);
    assert.ok(events.some(item => Array.isArray(item) && item[0] === 'message' && item[1].sessionId === 's1'));
    assert.ok(events.some(item => Array.isArray(item) && item[0] === 'color' && item[1] === 'project'));
});

test('WEBVIEW-DASHBOARD-COMMAND-REGISTRATION-001 registers every public command and preserves its callback', async () => {
    const registered = new Map();
    const subscriptions = [];
    const calls = [];
    const handlers = Object.fromEntries([
        'open', 'addProject', 'saveProject', 'removeProject', 'editProjects', 'addGroup', 'removeGroup',
        'addProjectsFromFolder', 'addFileToActiveTerminal',
    ].map(name => [name, () => calls.push(name)]));
    new DashboardCommandRegistration({
        registerCommand: (command, callback) => { registered.set(command, callback); return { command, dispose() {} }; },
        pushSubscription: disposable => subscriptions.push(disposable), handlers,
    }).register();
    assert.deepEqual([...registered.keys()], [
        'projectSteward.open', 'projectSteward.addProject', 'projectSteward.saveProject',
        'projectSteward.removeProject', 'projectSteward.editProjects', 'projectSteward.addGroup',
        'projectSteward.removeGroup', 'projectSteward.addProjectsFromFolder',
        'projectSteward.addFileToActiveTerminal',
    ]);
    for (const callback of registered.values()) await callback();
    assert.equal(subscriptions.length, 9);
    assert.deepEqual(calls, Object.keys(handlers));
});

test('SESSION-ACTIVE-TERMINAL-FILE-REFERENCE-001 sends one selection-aware reference and rejects absent terminals', async () => {
    const sent = [];
    const warnings = [];
    const editor = { document: { uri: { scheme: 'file', fsPath: '/repo/src/file.ts' } }, selection: {
        isEmpty: false, start: { line: 4 }, end: { line: 2 },
    } };
    const controller = new ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => editor,
        getActiveTerminal: () => ({ sendText: (value, addNewLine) => sent.push([value, addNewLine]), show() {} }),
        asRelativePath: uri => uri.fsPath.replace('/repo/', ''),
        showWarningMessage: message => warnings.push(message),
    });
    assert.deepEqual(getPrimarySelectionLineRange(editor.selection), { startLine: 3, endLine: 5 });
    assert.equal(formatFileReference('src/file.ts', { startLine: 3, endLine: 5 }), 'src/file.ts:3-5');
    await controller.addFileToActiveTerminal();
    assert.deepEqual(sent, [['src/file.ts:3-5', false]]);
    const missing = new ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => editor, getActiveTerminal: () => null,
        asRelativePath: () => 'src/file.ts', showWarningMessage: message => warnings.push(message),
    });
    await missing.addFileToActiveTerminal();
    assert.deepEqual(warnings, ['No active terminal to receive the file reference.']);
});
