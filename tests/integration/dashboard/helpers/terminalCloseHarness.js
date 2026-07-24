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

function createHarnessVscode(listeners, commands) {
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
            onDidChangeActiveTerminal: callback => { listeners.activeTerminal = callback; return disposable(); },
            onDidOpenTerminal: () => disposable(),
            onDidCloseTerminal: callback => { listeners.closeTerminal = callback; return disposable(); },
            onDidChangeWindowState: callback => { listeners.windowState = callback; return disposable(); },
            onDidChangeVisibleTextEditors: () => disposable(), onDidChangeActiveTextEditor: () => disposable(),
            showErrorMessage: async () => undefined, showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined, showInputBox: async () => undefined,
            showQuickPick: async () => undefined, showOpenDialog: async () => undefined,
        },
        workspace: {
            workspaceFile: undefined, workspaceFolders: undefined,
            getConfiguration: () => configuration, updateWorkspaceFolders: () => true,
            onDidChangeConfiguration: callback => { listeners.configuration = callback; return disposable(); },
            onDidChangeWorkspaceFolders: callback => { listeners.workspaceFolders = callback; return disposable(); },
            onWillSaveTextDocument: () => disposable(), openTextDocument: async () => ({}),
        },
        commands: {
            registerCommand: (id, callback) => { commands.set(id, callback); return disposable(() => commands.delete(id)); },
            executeCommand: async () => undefined,
        },
        env: {
            remoteName: undefined, machineId: 'fixture-machine',
            clipboard: { writeText: async () => undefined }, openExternal: async () => true,
        },
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

async function runTerminalCloseContract(transform = source => source) {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-close-wiring-'));
    const listeners = {};
    const commands = new Map();
    const vscode = createHarnessVscode(listeners, commands);
    const previousLoad = Module._load;
    const calls = [];
    let activeFixtures = [];
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
        globalStoragePath: storageRoot, globalStorageUri: uri(storageRoot),
        extensionPath: root, extensionUri: uri(root),
        subscriptions: [], globalState: state(), workspaceState: state(),
        extension: { packageJSON: { version: '2.1.3' } }, extensionMode: 3,
    };

    try {
        const { AiSessionRuntimeCoordinator } = require('../../../../out/aiSessions/runtimeCoordinator');
        const ActiveAiSessionTerminalHighlighter = require('../../../../out/aiSessions/activeTerminalHighlight').default;
        const { AiSessionAttentionController } = require('../../../../out/aiSessions/attentionController');
        const { AiSessionTerminalCommandController } = require(
            '../../../../out/aiSessions/terminalCommandController'
        );
        const AttentionBridgeClient = require('../../../../out/aiSessions/attentionBridgeClient').default;
        patchMethod(AiSessionRuntimeCoordinator.prototype, 'getActive', function () { return activeFixtures; });
        patchMethod(AiSessionRuntimeCoordinator.prototype, 'getPending', function () { return []; });
        patchMethod(AiSessionRuntimeCoordinator.prototype, 'handleClosedTerminal', terminal => {
            calls.push(['runtime-close', terminal]);
        });
        patchMethod(AiSessionRuntimeCoordinator.prototype, 'getById', function () {
            return activeFixtures.length === 1 ? activeFixtures[0] : null;
        });
        patchMethod(AiSessionRuntimeCoordinator.prototype, 'detach', async identity => {
            calls.push(['runtime-detach', identity]);
        });
        patchMethod(ActiveAiSessionTerminalHighlighter.prototype, 'handleTerminalClosed', terminal => {
            calls.push(['highlight-close', terminal]);
        });
        patchMethod(AiSessionAttentionController.prototype, 'getRecoverySessionEvents', () => [{
            sessionKey: 'codex:session', eventIds: ['attention-event'],
        }]);
        patchMethod(AiSessionAttentionController.prototype, 'acknowledge', eventIds => {
            calls.push(['local-acknowledge', eventIds]);
        });
        patchMethod(AiSessionAttentionController.prototype, 'suppressRuntimeCompletion', attentionKey => {
            calls.push(['suppress-runtime-completion', attentionKey]);
        });
        patchMethod(AiSessionAttentionController.prototype, 'restoreRuntimeCompletion', attentionKey => {
            calls.push(['restore-runtime-completion', attentionKey]);
        });
        patchMethod(AiSessionAttentionController.prototype, 'evaluate', async () => {
            calls.push(['attention-evaluate']);
            return { enabled: true, published: true, inScopeSessionKeys: [], eventIdsBySession: {}, overflowedSessionKeys: [] };
        });
        patchMethod(AttentionBridgeClient.prototype, 'acknowledge', async eventIds => {
            calls.push(['bridge-acknowledge', eventIds]);
        });
        if (mode === 'explicit-close' || mode === 'explicit-detach') {
            patchMethod(AiSessionTerminalCommandController.prototype, 'closeTerminal', async function () {
                const runtime = activeFixtures[0];
                this.options.onRuntimeCloseStart?.(runtime);
                calls.push(['runtime-detach', runtime.identity]);
                this.options.onRuntimeCloseEnd?.(runtime, true);
            });
        }

        const dashboard = loadDashboard(transform);
        await dashboard.activate(context);
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(typeof listeners.closeTerminal, 'function',
            'ATTENTION-TERMINAL-CLOSE-WIRING-001 production activation must register terminal close');
        const terminal = { name: 'tracked fixture terminal' };
        activeFixtures = [{
            backend: 'vscode', terminal, state: 'active', runStartedAtMs: 1,
            identity: { provider: 'codex', sessionId: 'session', projectKey: '/fixture', cwd: '/fixture' },
        }];
        listeners.closeTerminal(terminal);
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(calls.some(call => call[0] === 'runtime-close'));
        assert.ok(calls.some(call => call[0] === 'highlight-close'));
        assert.equal(calls.some(call => call[0] === 'local-acknowledge' || call[0] === 'bridge-acknowledge'), false,
            'ATTENTION-TERMINAL-CLOSE-WIRING-001 closing a terminal must not acknowledge unread attention');
        if (mode === 'explicit-close' || mode === 'explicit-detach') {
            if (mode === 'explicit-detach') {
                activeFixtures[0] = {
                    ...activeFixtures[0],
                    backend: 'tmux',
                    tmux: { layout: 'project', sessionName: 'project', windowName: 'session' },
                };
            }
            let onMessage;
            const webview = {
                options: {}, html: '', cspSource: 'fixture', asWebviewUri: value => value,
                onDidReceiveMessage: callback => { onMessage = callback; return disposable(); },
                postMessage: async () => true,
            };
            const view = { visible: false, webview, onDidChangeVisibility: () => disposable() };
            await listeners.viewProvider.resolveWebviewView(view, {}, {});
            assert.equal(typeof onMessage, 'function');
            await onMessage({
                type: mode === 'explicit-detach'
                    ? 'detach-ai-session-terminal'
                    : 'close-ai-session-terminal',
                projectId: '__currentWorkspace',
                provider: 'codex',
                sessionId: 'session',
            });
            await new Promise(resolve => setImmediate(resolve));
            const suppressionIndex = calls.findIndex(call => call[0] === 'suppress-runtime-completion');
            const detachIndex = calls.findIndex(call => call[0] === 'runtime-detach');
            const localAcknowledgeIndex = calls.findIndex(call => call[0] === 'local-acknowledge');
            if (mode === 'explicit-close') {
                assert.ok(suppressionIndex >= 0 && suppressionIndex < detachIndex,
                    'ATTENTION-EXPLICIT-SESSION-CLOSE-001 must suppress the exact run before close');
            } else {
                assert.equal(suppressionIndex, -1,
                    'ATTENTION-EXPLICIT-SESSION-CLOSE-001 detach must preserve future completion attention');
            }
            assert.ok(localAcknowledgeIndex > detachIndex,
                'ATTENTION-EXPLICIT-SESSION-CLOSE-001 must acknowledge only after confirmed detach succeeds');
            assert.equal(calls.some(call => call[0] === 'restore-runtime-completion'), false);
        }
        return calls;
    } finally {
        for (const subscription of context.subscriptions.slice().reverse()) subscription.dispose?.();
        await new Promise(resolve => setImmediate(resolve));
        restores.reverse().forEach(restore => restore());
        Module._load = previousLoad;
        fs.rmSync(storageRoot, { recursive: true, force: true });
    }
}

const mode = process.argv[2];
const run = mode === 'mutation'
    ? () => runTerminalCloseContract(source => {
        const needle = 'aiSessionRuntimeCoordinator.handleClosedTerminal(terminal);';
        assert.ok(source.includes(needle), 'controlled mutation must find the production callback');
        return source.replace(needle,
            `${needle}\n            aiSessionAttentionController.acknowledge(['attention-event']);`);
    })
    : () => runTerminalCloseContract();

run().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
