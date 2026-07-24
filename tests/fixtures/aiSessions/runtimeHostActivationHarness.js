'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const dashboardPath = path.join(root, 'out/dashboard.js');

function disposable() {
    return { dispose() {} };
}

function createVscode() {
    const registeredCommands = [];
    const configuration = { get: (_key, fallback) => fallback, inspect: () => undefined, update: async () => undefined };
    const uri = value => ({ scheme: 'file', fsPath: value, path: value, toString: () => value });
    return {
        registeredCommands,
        ConfigurationTarget: { Global: 1, Workspace: 2 }, ExtensionMode: { Test: 3 }, ViewColumn: { One: 1 },
        Uri: { file: uri, parse: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
        window: {
            terminals: [], activeTerminal: null, activeTextEditor: undefined, visibleTextEditors: [],
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            createTerminal: options => ({ name: options.name || 'fixture', processId: Promise.resolve(1), show() {}, dispose() {}, sendText() {} }),
            registerWebviewViewProvider: () => disposable(),
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
            registerCommand: command => {
                registeredCommands.push(command);
                return disposable();
            },
            executeCommand: async () => undefined,
        },
        env: {
            remoteName: undefined, machineId: 'fixture-machine',
            clipboard: { writeText: async () => undefined }, openExternal: async () => true,
        },
        extensions: { getExtension: () => undefined, all: [] },
    };
}

async function main() {
    const mode = process.argv[2] || 'success';
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-host-activation-'));
    const vscode = createVscode();
    const previousLoad = Module._load;
    const restores = [];
    const events = [];
    const verified = new Set();
    const aliasRebinds = [];
    let simulatedAliasRebind = false;
    let dashboardCommandRegistrationInvocations = 0;
    let attentionShutdownCalls = 0;
    const patch = (prototype, name, replacement) => {
        const original = prototype[name];
        prototype[name] = replacement;
        restores.push(() => { prototype[name] = original; });
    };
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        const loaded = previousLoad.call(this, request, parent, isMain);
        if (parent?.filename === dashboardPath && request === './workspaces/sessionHydrationController') {
            const Original = loaded.WorkspaceSessionHydrationController;
            return {
                ...loaded,
                WorkspaceSessionHydrationController: class extends Original {
                    constructor(...args) {
                        events.push('hydration-constructed');
                        super(...args);
                    }
                },
            };
        }
        return loaded;
    };
    const state = () => ({ get: (_key, fallback) => fallback, update: async () => undefined });
    const uri = value => ({ scheme: 'file', fsPath: value, path: value, toString: () => value });
    const context = {
        globalStoragePath: storageRoot, globalStorageUri: uri(storageRoot), extensionPath: root,
        extensionUri: uri(root), subscriptions: [], globalState: state(), workspaceState: state(),
        extension: { packageJSON: { version: '2.1.3' } }, extensionMode: 3,
    };

    try {
        const TerminalService = require('../../../out/aiSessions/terminalService').default;
        const { DirectTerminalRuntimeBackend } = require('../../../out/aiSessions/directTerminalRuntimeBackend');
        const { AiSessionRuntimeCoordinator } = require('../../../out/aiSessions/runtimeCoordinator');
        const { TmuxAttachBindingStore } = require('../../../out/aiSessions/tmuxAttachBindingStore');
        const { TmuxClient } = require('../../../out/aiSessions/tmuxClient');
        const { TmuxRuntimeBackend } = require('../../../out/aiSessions/tmuxRuntimeBackend');
        const { TmuxRuntimeBindingStore } = require('../../../out/aiSessions/tmuxRuntimeBindingStore');
        const { TmuxRuntimeDiscovery } = require('../../../out/aiSessions/tmuxRuntimeDiscovery');
        const { AiSessionAttentionController } = require('../../../out/aiSessions/attentionController');
        const AttentionBridgeClient = require('../../../out/aiSessions/attentionBridgeClient').default;
        const AiSessionAliasController = require('../../../out/aiSessions/aliasController').default;
        const { DashboardCommandRegistration } = require('../../../out/dashboard/commandRegistration');

        const originalDashboardRegister = DashboardCommandRegistration.prototype.register;
        patch(DashboardCommandRegistration.prototype, 'register', function (...args) {
            dashboardCommandRegistrationInvocations += 1;
            return originalDashboardRegister.apply(this, args);
        });
        patch(AiSessionAliasController.prototype, 'copyForRebind', function (...args) {
            aliasRebinds.push(args);
        });

        patch(TmuxRuntimeDiscovery.prototype, 'loadPersistedInactive', async function () {
            assert.ok(this instanceof TmuxRuntimeDiscovery);
            assert.ok(this.options.client instanceof TmuxClient);
            assert.ok(this.options.bindingStore instanceof TmuxRuntimeBindingStore);
            assert.equal(typeof this.options.onSessionRebound, 'function');
            if (!simulatedAliasRebind) {
                simulatedAliasRebind = true;
                this.options.onSessionRebound(
                    { provider: 'codex', sessionId: 'old-root' },
                    { provider: 'codex', sessionId: 'new-root' }
                );
            }
            verified.add('client-store-discovery');
            verified.add('thread-switch-alias-wiring');
            events.push('inactive-restored');
        });
        patch(TerminalService.prototype, 'restorePersistedTerminals', async function () {
            assert.ok(this instanceof TerminalService);
            events.push(mode === 'direct-failure' ? 'direct-failed' : 'direct-restored');
            if (mode === 'direct-failure') throw new Error('controlled direct restore failure');
        });
        patch(TmuxRuntimeBackend.prototype, 'restoreAttachTerminals', async function () {
            assert.ok(this instanceof TmuxRuntimeBackend);
            assert.ok(this.dependencies.discovery instanceof TmuxRuntimeDiscovery);
            assert.ok(this.dependencies.runtimeStore instanceof TmuxRuntimeBindingStore);
            assert.ok(this.dependencies.attachStore instanceof TmuxAttachBindingStore);
            verified.add('tmux-backend');
            events.push('tmux-restored');
        });
        patch(AiSessionRuntimeCoordinator.prototype, 'getActive', function () {
            assert.ok(this.dependencies.direct instanceof DirectTerminalRuntimeBackend);
            assert.ok(this.dependencies.tmux instanceof TmuxRuntimeBackend);
            verified.add('direct-tmux-coordinator');
            return [];
        });
        patch(AiSessionRuntimeCoordinator.prototype, 'getPending', () => []);
        patch(AiSessionAttentionController.prototype, 'getRecoverySessionEvents', () => []);
        patch(AiSessionAttentionController.prototype, 'evaluate', async () => ({
            enabled: true, published: true, inScopeSessionKeys: [], eventIdsBySession: {}, overflowedSessionKeys: [],
        }));
        const originalAttentionShutdown = AttentionBridgeClient.prototype.shutdown;
        patch(AttentionBridgeClient.prototype, 'shutdown', async function () {
            attentionShutdownCalls += 1;
            if (typeof originalAttentionShutdown === 'function') {
                await originalAttentionShutdown.call(this);
            }
            events.push('attention-shutdown-complete');
        });

        delete require.cache[require.resolve(dashboardPath)];
        const dashboard = require(dashboardPath);
        let failure = null;
        try {
            await dashboard.activate(context);
        } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
        }
        await new Promise(resolve => setImmediate(resolve));
        if (failure === null) {
            await dashboard.deactivate();
            events.push('dashboard-deactivated');
        }
        process.stdout.write(JSON.stringify({
            events,
            failure,
            verified: [...verified].sort(),
            registeredCommands: vscode.registeredCommands,
            dashboardCommandRegistrationInvocations,
            aliasRebinds,
            attentionShutdownCalls,
        }));
    } finally {
        for (const subscription of context.subscriptions.slice().reverse()) subscription.dispose?.();
        restores.reverse().forEach(restore => restore());
        Module._load = previousLoad;
        fs.rmSync(storageRoot, { recursive: true, force: true });
    }
}

main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
