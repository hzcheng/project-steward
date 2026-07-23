'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../../../..');
const dashboardPath = path.join(root, 'out/dashboard.js');

function disposable(dispose = () => undefined) {
    return { dispose };
}

function createVscode(listeners, commands) {
    const configuration = { get: (_key, fallback) => fallback, inspect: () => undefined, update: async () => undefined };
    const uri = value => ({ scheme: 'file', fsPath: value, path: value, toString: () => value });
    return {
        ConfigurationTarget: { Global: 1, Workspace: 2 }, ExtensionMode: { Test: 3 }, ViewColumn: { One: 1 },
        Uri: { file: uri, parse: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
        window: {
            terminals: [], activeTerminal: null, activeTextEditor: undefined, visibleTextEditors: [],
            createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }),
            createTerminal: () => ({ name: 'fixture', show: () => undefined, dispose: () => undefined, sendText: () => undefined }),
            registerWebviewViewProvider: (_id, provider) => {
                listeners.viewProvider = provider;
                return disposable();
            },
            onDidChangeActiveTerminal: () => disposable(), onDidOpenTerminal: () => disposable(),
            onDidCloseTerminal: () => disposable(),
            onDidChangeWindowState: () => disposable(), onDidChangeVisibleTextEditors: () => disposable(),
            onDidChangeActiveTextEditor: () => disposable(),
            showErrorMessage: async () => undefined, showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined, showInputBox: async () => undefined,
            showQuickPick: async () => undefined, showOpenDialog: async () => undefined,
        },
        workspace: {
            workspaceFile: undefined, workspaceFolders: undefined,
            getConfiguration: () => configuration, updateWorkspaceFolders: () => true,
            onDidChangeConfiguration: () => disposable(), onDidChangeWorkspaceFolders: () => disposable(),
            onWillSaveTextDocument: () => disposable(), openTextDocument: async () => ({}),
        },
        commands: {
            registerCommand: (id, callback) => { commands.set(id, callback); return disposable(() => commands.delete(id)); },
            executeCommand: async () => undefined,
        },
        env: { remoteName: undefined, machineId: 'fixture-machine',
            clipboard: { writeText: async () => undefined }, openExternal: async () => true },
        extensions: { getExtension: () => undefined, all: [] },
    };
}

function loadDashboard(transform) {
    const source = transform(fs.readFileSync(dashboardPath, 'utf8'));
    const loaded = new Module(dashboardPath, module);
    loaded.filename = dashboardPath;
    loaded.paths = Module._nodeModulePaths(path.dirname(dashboardPath));
    loaded._compile(source, dashboardPath);
    return loaded.exports;
}

async function runTodoPanelContract(transform) {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-todo-panel-'));
    const listeners = {};
    const commands = new Map();
    const vscode = createVscode(listeners, commands);
    const previousLoad = Module._load;
    const restores = [];
    const patchMethod = (prototype, name, replacement) => {
        const original = prototype[name];
        prototype[name] = replacement;
        restores.push(() => { prototype[name] = original; });
    };
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        return previousLoad.call(this, request, parent, isMain);
    };
    const state = () => ({ get: (_key, fallback) => fallback, update: async () => undefined });
    const uri = value => ({ scheme: 'file', fsPath: value, path: value, toString: () => value });
    const context = {
        globalStoragePath: storageRoot, globalStorageUri: uri(storageRoot), extensionPath: root, extensionUri: uri(root),
        subscriptions: [], globalState: state(), workspaceState: state(),
        extension: { packageJSON: { version: '2.1.3' } }, extensionMode: 3,
    };
    let armed = false;
    let unsupported;
    let probeCount = 0;

    try {
        const { TodoService } = require('../../../../out/todos/service');
        const { UnsupportedTodoDataVersionError } = require('../../../../out/todos/types');
        const { AiSessionRuntimeCoordinator } = require('../../../../out/aiSessions/runtimeCoordinator');
        const { AiSessionAttentionController } = require('../../../../out/aiSessions/attentionController');
        patchMethod(TodoService.prototype, 'migrateDataIfNeeded', async () => false);
        patchMethod(TodoService.prototype, 'getUnsupportedVersionError', () => {
            if (!armed) return undefined;
            probeCount += 1;
            return unsupported;
        });
        patchMethod(TodoService.prototype, 'getData', () => ({ version: 1, groups: [], todos: [] }));
        patchMethod(TodoService.prototype, 'getSearchItems', () => []);
        patchMethod(AiSessionRuntimeCoordinator.prototype, 'getActive', () => []);
        patchMethod(AiSessionRuntimeCoordinator.prototype, 'getPending', () => []);
        patchMethod(AiSessionAttentionController.prototype, 'getRecoverySessionEvents', () => []);
        patchMethod(AiSessionAttentionController.prototype, 'evaluate', async () => ({
            enabled: true, published: true, inScopeSessionKeys: [], eventIdsBySession: {}, overflowedSessionKeys: [],
        }));

        const dashboard = loadDashboard(transform);
        await dashboard.activate(context);
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(listeners.viewProvider,
            'TODO-FUTURE-VERSION-DASHBOARD-001 / RELEASE-SCHEDULED-EXTENSION-HOST-001 activation must register the production view provider');

        const posted = [];
        let onMessage;
        const webview = {
            options: {}, html: '', cspSource: 'fixture', asWebviewUri: value => value,
            onDidReceiveMessage: callback => { onMessage = callback; return disposable(); },
            postMessage: async message => { posted.push(message); return true; },
        };
        const view = { visible: false, webview, onDidChangeVisibility: () => disposable() };
        await listeners.viewProvider.resolveWebviewView(view, {}, {});
        assert.equal(typeof onMessage, 'function',
            'TODO-FUTURE-VERSION-DASHBOARD-001 must reach the production Webview message callback');

        armed = true;
        unsupported = new UnsupportedTodoDataVersionError(9);
        await onMessage({ type: 'request-todo-panel', version: 1, requestId: 1 });
        assert.equal(posted.length, 1, 'TODO-FUTURE-VERSION-DASHBOARD-001 unsupported request must post one panel');
        assert.equal(posted[0].type, 'todo-panel-content');
        assert.match(posted[0].html, /data-todo-error="unsupported-version"/,
            'TODO-FUTURE-VERSION-DASHBOARD-001 must map the live unsupported-version error');
        assert.match(posted[0].html, /unsupported version 9/);

        unsupported = undefined;
        await onMessage({ type: 'request-todo-panel', version: 1, requestId: 2 });
        assert.equal(posted.length, 2, 'TODO-FUTURE-VERSION-DASHBOARD-001 recovery request must post a fresh panel');
        assert.doesNotMatch(posted[1].html, /data-todo-error="unsupported-version"/,
            'TODO-FUTURE-VERSION-DASHBOARD-001 must not reuse a stale migration/version error');
        assert.match(posted[1].html, /class="todo-panel\b/);
        assert.equal(probeCount, 2,
            'TODO-FUTURE-VERSION-DASHBOARD-001 each panel request must live-probe the active backend');
    } finally {
        for (const subscription of context.subscriptions.slice().reverse()) subscription.dispose?.();
        await new Promise(resolve => setImmediate(resolve));
        restores.reverse().forEach(restore => restore());
        Module._load = previousLoad;
        fs.rmSync(storageRoot, { recursive: true, force: true });
    }
}

const mode = process.argv[2];
let transform = source => source;
if (mode === 'missing-live-probe') {
    transform = source => source.replace(
        'const unsupportedVersionError = todoService.getUnsupportedVersionError();',
        'const unsupportedVersionError = undefined;');
} else if (mode === 'missing-catch-mapping') {
    transform = source => source.replace(
        'if (!(error instanceof types_1.UnsupportedTodoDataVersionError))',
        'if (error instanceof types_1.UnsupportedTodoDataVersionError)');
} else if (mode === 'missing-view-registration') {
    transform = source => source.replace(
        'context.subscriptions.push(vscode.window.registerWebviewViewProvider(viewProvider_1.SidebarStewardViewProvider.viewType, provider));',
        'context.subscriptions.push({ dispose: () => undefined });');
}

runTodoPanelContract(transform).catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
