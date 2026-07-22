'use strict';
const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const launchSpec = require('../out/aiSessions/launchSpec');
const commandBuilders = require('../out/aiSessions/commandBuilders');
const runtimeConfiguration = require('../out/aiSessions/runtimeConfiguration');
const tmuxLayout = require('../out/aiSessions/tmuxLayout');
const tmuxNaming = require('../out/aiSessions/tmuxNaming');
const tmuxClientModule = require('../out/aiSessions/tmuxClient');
const discoveryModule = require('../out/aiSessions/tmuxRuntimeDiscovery');
const runtimeStoreModule = require('../out/aiSessions/tmuxRuntimeBindingStore');
const attachStoreModule = require('../out/aiSessions/tmuxAttachBindingStore');
const creationLock = require('../out/aiSessions/tmuxCreationLock');
const directBackendModule = require('../out/aiSessions/directTerminalRuntimeBackend');
const coordinatorModule = require('../out/aiSessions/runtimeCoordinator');
const runtimeTypesModule = require('../out/aiSessions/runtimeTypes');
const tmuxBackendModule = require('../out/aiSessions/tmuxRuntimeBackend');
const WorkspacePendingSessionPromotionController = require(
    '../out/workspaces/pendingSessionPromotionController'
).WorkspacePendingSessionPromotionController;
const CreationController = require('../out/aiSessions/creationController').AiSessionCreationController;
const ResumeController = require('../out/aiSessions/resumeController').AiSessionResumeController;
const TerminalCommandController = require('../out/aiSessions/terminalCommandController').AiSessionTerminalCommandController;
const originalModuleLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === 'vscode') {
        return {};
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};
const webviewContentModule = require('../out/webview/webviewContent');
Module._load = originalModuleLoad;

function config(values) {
    return { get: (key, fallback) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback };
}

function decodePowerShellPayload(command) {
    const prefix = 'powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ';
    assert.ok(command.startsWith(prefix));
    return Buffer.from(command.slice(prefix.length), 'base64').toString('utf16le');
}

function quotePowerShellLiteral(value) {
    return `'${String(value).replace(/'/g, `''`)}'`;
}

function createDirectoryScope(primaryCwd, additionalDirectories = []) {
    return Object.freeze({
        workspaceNavigationIdentity: `navigation:${primaryCwd}`,
        workspaceScopeIdentity: `scope:${primaryCwd}`,
        workspaceRootHostPaths: Object.freeze([primaryCwd, ...additionalDirectories]),
        primaryRootId: `root:${primaryCwd}`,
        primaryCwd,
        additionalDirectories: Object.freeze([...additionalDirectories]),
    });
}

function createWorkspaceActionTarget(project, workspaceScopeIdentity) {
    return {
        cardId: project.id,
        workspace: {
            displayName: project.name,
            navigationIdentity: `navigation:${workspaceScopeIdentity}`,
            scopeIdentity: workspaceScopeIdentity,
            roots: [],
        },
        sessions: {
            sessionsByProvider: {
                codex: project.codexSessions || [],
                kimi: project.kimiSessions || [],
                claude: project.claudeSessions || [],
            },
            activeSessions: [],
        },
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function metadataFromOptions(values) {
    return Object.keys(values).reduce((result, key) => {
        result[key] = values[key];
        return result;
    }, {});
}

function createTmuxBackendHarness(options = {}) {
    const operations = [];
    const terminals = [];
    const windows = [];
    const pending = new Map();
    const known = new Map();
    const ambiguous = new Map();
    const consumed = new Map();
    const promoting = new Map();
    const attachBindings = new Map();
    const lockQueues = new Map();
    let attachWriteQueue = Promise.resolve();
    let nextWindowId = 1;
    let nextProcessId = 100;
    let stateReadCount = 0;
    let failAttachCount = options.failAttachCount || 0;
    let failShowCount = options.failShowCount || 0;
    let failDisposeCount = options.failDisposeCount || 0;
    let failSelectCount = options.failSelectCount || 0;
    let ambiguousCreateCount = options.ambiguousCreateCount || 0;
    let failCreateSessionNonzeroCount = options.failCreateSessionNonzeroCount || 0;
    let failCreateWindowNonzeroCount = options.failCreateWindowNonzeroCount || 0;
    let failCreateSessionE2bigCount = options.failCreateSessionE2bigCount || 0;
    let failSetPendingCount = options.failSetPendingCount || 0;
    let failSetConsumedCount = options.failSetConsumedCount || 0;
    let failRenameSessionCount = options.failRenameSessionCount || 0;
    let failRenameWindowCount = options.failRenameWindowCount || 0;
    let ambiguousRenameSessionCount = options.ambiguousRenameSessionCount || 0;
    let ambiguousRenameWindowCount = options.ambiguousRenameWindowCount || 0;
    let failFinalMetadataIdentityWriteCount = options.failFinalMetadataIdentityWriteCount || 0;
    let failPromotionClearPendingCount = options.failPromotionClearPendingCount || 0;
    let failRemovePendingAfterConsumedCount = options.failRemovePendingAfterConsumedCount || 0;
    let failRefreshAfterConsumedCount = options.failRefreshAfterConsumedCount || 0;
    let failAttachMigrationCount = options.failAttachMigrationCount || 0;
    let pendingAttachMigrationError = null;
    let failConfigureWindowTimeoutCount = options.failConfigureWindowTimeoutCount || 0;
    let activeWindowError = null;
    let activeWindowDeferred = null;
    let targetWindowOverride;
    let promotionRenameOccurred = false;

    function syncMetadata(row) {
        row.metadata = { ...row.sessionMetadata, ...row.windowMetadata };
    }

    function addWindow(sessionName, windowName, command) {
        const row = {
            sessionName,
            windowName,
            windowId: `@${nextWindowId++}`,
            active: false,
            sessionMetadata: {},
            windowMetadata: {},
            metadata: {},
        };
        windows.push(row);
        if (command && ambiguousCreateCount > 0) {
            ambiguousCreateCount--;
            if (options.prepareAmbiguousWindow) {
                options.prepareAmbiguousWindow(row);
            }
            const error = new tmuxClientModule.TmuxClientError('create-session', 'timeout');
            throw error;
        }
        return row;
    }

    function ambiguousKey(identity) {
        const kind = identity.sessionId !== undefined ? 'session' : 'pending';
        return JSON.stringify([identity.provider, identity.workspaceScopeIdentity, kind,
            identity.sessionId !== undefined ? identity.sessionId : identity.pendingId]);
    }

    const runtimeStore = {
        listPending: async () => Array.from(pending.values()).filter(record =>
            !options.enforcePendingTtl
            || (dependencies.nowMs() - record.acceptedAtMs < 24 * 60 * 60 * 1000)),
        listRecoverablePending: async () => {
            const records = [];
            const durableKeys = new Set([...promoting.keys(), ...consumed.keys()]);
            for (const key of durableKeys) {
                const intent = promoting.get(key);
                const tombstone = consumed.get(key);
                const livePending = pending.get(key);
                if (intent) {
                    records.push({
                        pendingBinding: intent.pendingBinding,
                        promotionRecoveryDisplayName: intent.finalSessionName,
                        recoverySessionId: intent.finalSessionId,
                    });
                } else if (tombstone?.finalSessionName && livePending) {
                    records.push({
                        pendingBinding: livePending,
                        promotionRecoveryDisplayName: tombstone.finalSessionName,
                        recoverySessionId: tombstone.finalSessionId,
                    });
                }
            }
            return records;
        },
        getPending: async identity => {
            const record = pending.get(ambiguousKey(identity)) || null;
            return record && options.enforcePendingTtl
                && dependencies.nowMs() - record.acceptedAtMs >= 24 * 60 * 60 * 1000 ? null : record;
        },
        listKnown: async () => Array.from(known.values()),
        setPending: async record => {
            operations.push({ type: 'store-pending', pendingId: record.pendingId });
            if (failSetPendingCount > 0) {
                failSetPendingCount--;
                throw new Error('pending persistence failed');
            }
            pending.set(ambiguousKey(record), { ...record });
            return true;
        },
        removePending: async identity => {
            operations.push({ type: 'remove-pending', pendingId: identity.pendingId });
            if (consumed.size && failRemovePendingAfterConsumedCount > 0) {
                failRemovePendingAfterConsumedCount--;
                throw new Error('post-consumed pending removal failed');
            }
            pending.delete(ambiguousKey(identity));
        },
        setKnown: async record => {
            operations.push({ type: 'store-known', sessionId: record.sessionId });
            known.set(`${record.provider}:${record.sessionId}`, { ...record });
        },
        getKnown: async (provider, sessionId) => known.get(`${provider}:${sessionId}`) || null,
        removeKnown: async (provider, sessionId) => known.delete(`${provider}:${sessionId}`),
        getAmbiguous: async identity => ambiguous.get(ambiguousKey(identity)) || null,
        setAmbiguous: async record => {
            operations.push({ type: 'store-ambiguous', record: { ...record } });
            ambiguous.set(ambiguousKey(record), { ...record, locator: { ...record.locator } });
        },
        removeAmbiguous: async identity => {
            operations.push({ type: 'remove-ambiguous', identity: { ...identity } });
            ambiguous.delete(ambiguousKey(identity));
        },
        getConsumed: async identity => {
            stateReadCount++;
            return consumed.get(ambiguousKey(identity)) || null;
        },
        setConsumed: async record => {
            operations.push({ type: 'store-consumed', pendingId: record.pendingId });
            if (failSetConsumedCount > 0) {
                failSetConsumedCount--;
                throw new Error('consumed persistence failed');
            }
            consumed.set(ambiguousKey(record), { ...record, finalLocator: { ...record.finalLocator } });
            return true;
        },
        getPromoting: async identity => {
            stateReadCount++;
            return promoting.get(ambiguousKey(identity)) || null;
        },
        setPromoting: async record => {
            operations.push({ type: 'store-promoting', pendingId: record.pendingId });
            promoting.set(ambiguousKey(record), {
                ...record,
                sourceLocator: { ...record.sourceLocator },
                finalLocator: { ...record.finalLocator },
                ...(record.pendingBinding ? { pendingBinding: {
                    ...record.pendingBinding,
                    excludedSessionIds: [...record.pendingBinding.excludedSessionIds],
                    locator: { ...record.pendingBinding.locator },
                } } : {}),
            });
            return true;
        },
        removePromoting: async identity => {
            operations.push({ type: 'remove-promoting', pendingId: identity.pendingId });
            promoting.delete(ambiguousKey(identity));
        },
        reconcileKnown: async live => {
            operations.push({ type: 'reconcile-known', count: live.length });
            for (const runtime of live) {
                const sessionId = runtime.identity.sessionId;
                if (sessionId && runtime.tmux) {
                    known.set(`${runtime.identity.provider}:${sessionId}`, {
                        version: 2,
                        state: 'known',
                        provider: runtime.identity.provider,
                        sessionId,
                        workspaceScopeIdentity: runtime.identity.workspaceScopeIdentity,
                        workspaceNavigationIdentity: runtime.identity.workspaceNavigationIdentity,
                        workspaceRootHostPaths: [...runtime.identity.workspaceRootHostPaths],
                        cwd: runtime.identity.cwd,
                        layout: runtime.tmux.layout,
                        locator: { ...runtime.tmux },
                        lastSeenAtMs: Date.parse('2026-07-18T10:00:00Z'),
                    });
                }
            }
        },
    };
    const client = {
        checkAvailability: async () => {
            operations.push({ type: 'availability' });
            if (options.availabilityGate) await options.availabilityGate.promise;
            if (options.availabilityError) throw options.availabilityError;
            return options.availability || { available: true, version: '3.2a' };
        },
        getExecutablePath: () => '/opt/tmux',
        setExecutablePath: () => undefined,
        listWindows: async () => {
            operations.push({ type: 'list-windows' });
            if (options.listWindowsError) {
                throw options.listWindowsError;
            }
            return windows.map(row => ({
                ...row,
                sessionMetadata: { ...row.sessionMetadata },
                windowMetadata: { ...row.windowMetadata },
                metadata: { ...row.metadata },
            }));
        },
        getActiveWindow: async sessionName => {
            operations.push({ type: 'get-active-window', sessionName });
            if (activeWindowError) {
                const error = activeWindowError;
                activeWindowError = null;
                throw error;
            }
            const activeRows = windows.filter(row => row.sessionName === sessionName && row.active);
            const result = activeRows.length === 1 ? {
                sessionName: activeRows[0].sessionName,
                windowName: activeRows[0].windowName,
                windowId: activeRows[0].windowId,
            } : null;
            if (activeWindowDeferred) {
                const pendingResult = activeWindowDeferred;
                activeWindowDeferred = null;
                await pendingResult.promise;
            }
            return result;
        },
        getTargetWindow: async locator => {
            operations.push({ type: 'get-target-window', locator: { ...locator } });
            if (targetWindowOverride !== undefined) {
                return targetWindowOverride === null ? null : {
                    ...targetWindowOverride,
                    metadata: { ...targetWindowOverride.metadata },
                };
            }
            const row = windows.find(candidate => candidate.sessionName === locator.sessionName
                && (!locator.windowName || candidate.windowName === locator.windowName));
            return row ? {
                sessionName: row.sessionName,
                windowName: row.windowName,
                windowId: row.windowId,
                metadata: { ...row.metadata },
            } : null;
        },
        hasSession: async name => {
            const exists = windows.some(item => item.sessionName === name);
            if (options.concurrentProjectBootstrap) {
                await new Promise(resolve => setImmediate(resolve));
            }
            return exists;
        },
        createSession: async (sessionName, windowName, cwd, command) => {
            operations.push({ type: 'new-session', sessionName, windowName, cwd, command });
            if (failCreateSessionE2bigCount > 0) {
                failCreateSessionE2bigCount--;
                throw new tmuxClientModule.TmuxClientError('create-session', 'argument-list-too-long');
            }
            if (failCreateSessionNonzeroCount > 0) {
                failCreateSessionNonzeroCount--;
                throw new tmuxClientModule.TmuxClientError('create-session', 'nonzero-exit');
            }
            if (windows.some(item => item.sessionName === sessionName)) {
                throw new tmuxClientModule.TmuxClientError('create-session', 'nonzero-exit');
            }
            addWindow(sessionName, windowName, command);
            if (options.afterProviderCreate) await options.afterProviderCreate();
        },
        createWindow: async (sessionName, windowName, cwd, command) => {
            operations.push({ type: 'new-window', sessionName, windowName, cwd, command });
            if (failCreateWindowNonzeroCount > 0) {
                failCreateWindowNonzeroCount--;
                throw new tmuxClientModule.TmuxClientError('create-window', 'nonzero-exit');
            }
            addWindow(sessionName, windowName, command);
            if (options.afterProviderCreate) await options.afterProviderCreate();
        },
        renameSession: async (sessionName, newName) => {
            operations.push({ type: 'rename-session', sessionName, newName });
            if (failRenameSessionCount > 0) {
                failRenameSessionCount--;
                throw new Error('rename session failed');
            }
            windows.filter(row => row.sessionName === sessionName).forEach(row => { row.sessionName = newName; });
            promotionRenameOccurred = true;
            if (ambiguousRenameSessionCount > 0) {
                ambiguousRenameSessionCount--;
                throw new tmuxClientModule.TmuxClientError('rename-session', 'timeout');
            }
        },
        renameWindow: async (sessionName, windowName, newName) => {
            operations.push({ type: 'rename-window', sessionName, windowName, newName });
            if (failRenameWindowCount > 0) {
                failRenameWindowCount--;
                throw new Error('rename window failed');
            }
            const row = windows.find(candidate => candidate.sessionName === sessionName
                && candidate.windowName === windowName);
            if (row) row.windowName = newName;
            promotionRenameOccurred = true;
            if (ambiguousRenameWindowCount > 0) {
                ambiguousRenameWindowCount--;
                throw new tmuxClientModule.TmuxClientError('rename-window', 'timeout');
            }
        },
        selectWindow: async locator => {
            operations.push({ type: 'select-window', locator: { ...locator } });
            if (failSelectCount > 0) {
                failSelectCount--;
                throw new Error('select failed');
            }
            windows.forEach(row => { row.active = row.sessionName === locator.sessionName
                && (!locator.windowName || row.windowName === locator.windowName); });
        },
        setSessionOptions: async (sessionName, values) => {
            operations.push({ type: 'session-options', sessionName, values: { ...values } });
            windows.filter(item => item.sessionName === sessionName).forEach(item => {
                item.sessionMetadata = { ...item.sessionMetadata, ...metadataFromOptions(values) };
                syncMetadata(item);
            });
            if (promotionRenameOccurred && values.sessionId && failFinalMetadataIdentityWriteCount > 0) {
                failFinalMetadataIdentityWriteCount--;
                throw new Error('final metadata identity write failed');
            }
        },
        setWindowOptions: async (sessionName, windowName, values) => {
            operations.push({ type: 'window-options', sessionName, windowName, values: { ...values } });
            const item = windows.find(candidate => candidate.sessionName === sessionName
                && candidate.windowName === windowName);
            if (item) {
                item.windowMetadata = { ...item.windowMetadata, ...metadataFromOptions(values) };
                syncMetadata(item);
            }
            if (promotionRenameOccurred && values.sessionId && failFinalMetadataIdentityWriteCount > 0) {
                failFinalMetadataIdentityWriteCount--;
                throw new Error('final metadata identity write failed');
            }
        },
        getSessionOptions: async sessionName => {
            operations.push({ type: 'get-session-options', sessionName });
            const item = windows.find(candidate => candidate.sessionName === sessionName);
            const values = item ? { ...item.sessionMetadata } : {};
            return options.corruptPendingMetadata ? { ...values, provider: 'claude' } : values;
        },
        getWindowOptions: async (sessionName, windowName) => {
            operations.push({ type: 'get-window-options', sessionName, windowName });
            const item = windows.find(candidate => candidate.sessionName === sessionName
                && candidate.windowName === windowName);
            const values = item ? { ...item.windowMetadata } : {};
            return options.corruptPendingMetadata ? { ...values, workspaceScopeIdentity: 'wrong-scope' } : values;
        },
        configureManagedWindow: async (sessionName, windowName) => {
            operations.push({ type: 'configure-window', sessionName, windowName });
            if (failConfigureWindowTimeoutCount > 0) {
                failConfigureWindowTimeoutCount--;
                throw new tmuxClientModule.TmuxClientError('configure-managed-window', 'timeout');
            }
        },
        clearPendingMetadata: async locator => {
            operations.push({ type: 'clear-pending', locator: { ...locator } });
            if (promotionRenameOccurred && failPromotionClearPendingCount > 0) {
                failPromotionClearPendingCount--;
                throw new Error('promotion pending clear failed');
            }
            windows.filter(row => row.sessionName === locator.sessionName
                && (!locator.windowName || row.windowName === locator.windowName)).forEach(row => {
                    delete row.sessionMetadata.pendingId;
                    delete row.windowMetadata.pendingId;
                    syncMetadata(row);
                });
        },
    };
    const discovery = new discoveryModule.TmuxRuntimeDiscovery({
        client,
        bindingStore: runtimeStore,
        markerIsCurrent: () => false,
        nowMs: () => typeof options.nowMs === 'function'
            ? options.nowMs() : Date.parse('2026-07-18T10:00:00Z'),
        cacheTtlMs: 0,
    });
    const refreshDiscovery = discovery.refresh.bind(discovery);
    discovery.refresh = async force => {
        if (consumed.size && failRefreshAfterConsumedCount > 0) {
            failRefreshAfterConsumedCount--;
            throw new Error('post-consumed discovery refresh failed');
        }
        return refreshDiscovery(force);
    };
    const attachStore = {
        get: processId => attachBindings.get(processId) || null,
        set: (processId, binding) => {
            if (consumed.size && binding.sessionId && failAttachMigrationCount > 0) {
                failAttachMigrationCount--;
                pendingAttachMigrationError = new Error('attach migration failed');
                return;
            }
            attachWriteQueue = attachWriteQueue.then(() => Promise.resolve(processId)).then(value => {
                if (typeof value === 'number') attachBindings.set(value, { ...binding });
            });
        },
        remove: processId => {
            attachWriteQueue = attachWriteQueue.then(() => Promise.resolve(processId)).then(value => {
                if (typeof value === 'number') attachBindings.delete(value);
            });
        },
        flush: () => {
            if (pendingAttachMigrationError) {
                const error = pendingAttachMigrationError;
                pendingAttachMigrationError = null;
                return Promise.reject(error);
            }
            return attachWriteQueue;
        },
    };
    const dependencies = {
        platform: options.platform || 'linux',
        client,
        discovery,
        runtimeStore,
        attachStore,
        withCreationLock: async (key, operation) => {
            operations.push({ type: 'lock-queued', key });
            const previous = lockQueues.get(key) || Promise.resolve();
            let release;
            const turn = new Promise(resolve => { release = resolve; });
            lockQueues.set(key, previous.then(() => turn));
            await previous;
            operations.push({ type: 'lock', key });
            try {
                if (options.onLockAcquired) await options.onLockAcquired(key);
                return await operation();
            } finally {
                release();
            }
        },
        createTerminal: creationOptions => {
            operations.push({ type: 'create-terminal', creationOptions });
            if (failAttachCount > 0) {
                failAttachCount--;
                throw new Error('attach failed');
            }
            const processId = nextProcessId++;
            const terminal = {
                name: creationOptions.name,
                creationOptions,
                shown: false,
                disposed: false,
                processId: Promise.resolve(processId),
                show() {
                    operations.push({ type: 'show-terminal', terminal: this });
                    if (failShowCount > 0) {
                        failShowCount--;
                        throw new Error('show failed');
                    }
                    this.shown = true;
                },
                dispose() {
                    this.disposed = true;
                    operations.push({ type: 'dispose-terminal', terminal: this });
                    if (failDisposeCount > 0) {
                        failDisposeCount--;
                        throw new Error('dispose failed');
                    }
                },
            };
            terminals.push(terminal);
            return terminal;
        },
        nowMs: () => typeof options.nowMs === 'function'
            ? options.nowMs() : Date.parse('2026-07-18T10:00:00Z'),
        ...(options.getAttachTerminalName
            ? { getAttachTerminalName: options.getAttachTerminalName }
            : {}),
    };
    return {
        dependencies, client, runtimeStore, attachStore, operations, terminals, windows,
        pending, known, ambiguous, consumed, promoting, attachBindings,
        failNextAttach() { failAttachCount++; },
        failNextShow() { failShowCount++; },
        failNextActiveWindow(error) { activeWindowError = error; },
        setTargetWindow(value) { targetWindowOverride = value; },
        deferNextActiveWindow() {
            activeWindowDeferred = deferred();
            return activeWindowDeferred;
        },
        get stateReadCount() { return stateReadCount; },
    };
}

async function promoteWithRestartedCoordinator(harness, identity, sessionId, sessionName) {
    const { coordinator } = createRestartedRuntime(harness);
    return coordinator.promotePending(identity, sessionId, sessionName);
}

function createRestartedRuntime(harness) {
    const direct = createFakeRuntimeBackend('vscode');
    const tmux = new tmuxBackendModule.TmuxRuntimeBackend(harness.dependencies);
    const coordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct,
        tmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'session', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    return { coordinator, tmux };
}

function createPersistedAttachState() {
    const values = new Map();
    return {
        values,
        state: {
            get: (key, fallback) => values.has(key)
                ? JSON.parse(JSON.stringify(values.get(key))) : fallback,
            update: async (key, value) => {
                if (value === undefined) {
                    values.delete(key);
                } else {
                    values.set(key, JSON.parse(JSON.stringify(value)));
                }
            },
        },
    };
}

function clonePersistedAttachState(source) {
    const clone = createPersistedAttachState();
    for (const [key, value] of source.values) {
        clone.values.set(key, JSON.parse(JSON.stringify(value)));
    }
    return clone;
}

function createFreshPersistedRuntime(harness, runtimeRoot, attachState) {
    const runtimeStore = new runtimeStoreModule.TmuxRuntimeBindingStore(
        runtimeRoot, harness.dependencies.nowMs
    );
    const attachStore = new attachStoreModule.TmuxAttachBindingStore(attachState.state);
    const discovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: harness.client,
        bindingStore: runtimeStore,
        markerIsCurrent: () => false,
        nowMs: harness.dependencies.nowMs,
        cacheTtlMs: 0,
    });
    const dependencies = {
        ...harness.dependencies,
        runtimeStore,
        attachStore,
        discovery,
    };
    const tmux = new tmuxBackendModule.TmuxRuntimeBackend(dependencies);
    const direct = createFakeRuntimeBackend('vscode');
    const coordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct,
        tmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'session', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    return { attachStore, coordinator, dependencies, direct, discovery, runtimeStore, tmux };
}

function createPromotionController(runtimeCoordinator) {
    return new WorkspacePendingSessionPromotionController({
        providers: [{
            id: 'codex', terminalNamePrefix: 'Codex', projectSessionsKey: 'codexSessions',
            terminalCwdFields: ['cwd'],
        }],
        getSessionKey: (provider, sessionId) => `${provider}:${sessionId}`,
        runtimeCoordinator,
        setAlias: () => undefined,
        syncActiveRuntime: () => undefined,
        evaluateExecution: () => undefined,
        scheduleRefresh: () => undefined,
    });
}

function runtimeRecordFilename(record) {
    const canonicalState = record.state === 'completed' || record.state === 'stopped'
        ? 'known' : record.state;
    const identity = record.state === 'pending' || record.state === 'consumed' || record.state === 'promoting'
            ? [record.provider, record.workspaceScopeIdentity, record.workspaceNavigationIdentity,
                JSON.stringify(Array.isArray(record.workspaceRootHostPaths)
                    ? record.workspaceRootHostPaths.slice().sort() : []), record.cwd, record.pendingId]
            : [record.provider, record.workspaceScopeIdentity, record.sessionId];
    const digest = crypto.createHash('sha256')
        .update(JSON.stringify([2, canonicalState, ...identity]), 'utf8')
        .digest('hex');
    return `${canonicalState}-${digest}.json`;
}

function runRuntimeConfigurationChecks() {
    assert.deepStrictEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(config({})), {
        mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux',
    });
    assert.deepStrictEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(config({
        aiSessionTerminalMode: 'tmux', aiSessionTmuxLayout: 'session', aiSessionTmuxPath: '/opt/bin/tmux',
    })), { mode: 'tmux', tmuxLayout: 'session', tmuxPath: '/opt/bin/tmux' });
    assert.deepStrictEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(config({
        aiSessionTerminalMode: 'bad', aiSessionTmuxLayout: 'bad', aiSessionTmuxPath: '   ',
    })), { mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' });
    assert.deepStrictEqual(runtimeConfiguration.readAiSessionRuntimeConfiguration(config({
        aiSessionTerminalMode: null, aiSessionTmuxLayout: 1, aiSessionTmuxPath: false,
    })), { mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' });

    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const properties = manifest.contributes.configuration.properties;
    assert.deepStrictEqual(properties['projectSteward.aiSessionTerminalMode'].enum, ['vscode', 'tmux']);
    assert.strictEqual(properties['projectSteward.aiSessionTerminalMode'].scope, 'machine');
    assert.strictEqual(properties['projectSteward.aiSessionTmuxLayout'].default, 'project');
    assert.strictEqual(properties['projectSteward.aiSessionTmuxPath'].scope, 'machine');
}

function runLaunchSpecChecks() {
    const spec = commandBuilders.buildCodexResumeLaunchSpec(
        `session'; touch /tmp/nope; '`,
        createDirectoryScope(`/work/it's app`),
        `/tmp/done marker`
    );
    assert.strictEqual(spec.executable, 'codex');
    assert.deepStrictEqual(spec.args, ['resume', '--cd', `/work/it's app`, `session'; touch /tmp/nope; '`]);
    assert.strictEqual(spec.cwd, undefined);
    assert.strictEqual(spec.markerPath, '/tmp/done marker');

    const tmuxCommand = launchSpec.serializeTmuxLaunchCommand(spec);
    assert.ok(tmuxCommand.startsWith('exec /bin/sh -lc '));
    assert.ok(tmuxCommand.includes("'\\''"));
    assert.ok(tmuxCommand.includes('rm -f'));
    assert.ok(tmuxCommand.includes(': >'));
    assert.ok(tmuxCommand.includes('exit'));

    assert.deepStrictEqual(
        commandBuilders.buildKimiResumeLaunchSpec(
            'kimi; nope', createDirectoryScope('/work/Kimi App'), '/tmp/kimi.done'
        ).args,
        ['--work-dir', '/work/Kimi App', '--resume', 'kimi; nope']
    );
    assert.deepStrictEqual(
        commandBuilders.buildKimiNewSessionLaunchSpec(
            createDirectoryScope('/work/Kimi App'), "owner's task", '/tmp/kimi-new.done'
        ).args,
        ['--work-dir', '/work/Kimi App', '--prompt', "owner's task"]
    );
    assert.strictEqual(
        commandBuilders.buildClaudeResumeLaunchSpec(
            'claude-session', createDirectoryScope('/work/claude'), '/tmp/claude.done'
        ).cwd,
        '/work/claude'
    );
    assert.strictEqual(
        commandBuilders.buildClaudeNewSessionLaunchSpec(
            createDirectoryScope('/work/app'), 'Title', '/tmp/claude-new.done'
        ).cwd,
        '/work/app'
    );
    assert.deepStrictEqual(
        commandBuilders.buildCodexNewSessionLaunchSpec(
            createDirectoryScope('/work/app'), 'Prompt', '/tmp/codex-new.done'
        ).args,
        ['--cd', '/work/app', 'Prompt']
    );

    const windowsCommand = launchSpec.serializeDirectLaunchCommand(spec, 'win32');
    const windowsPayload = decodePowerShellPayload(windowsCommand);
    assert.ok(windowsPayload.includes("Remove-Item -LiteralPath '/tmp/done marker'"));
    assert.ok(windowsPayload.includes("New-Item -ItemType File -Force -Path '/tmp/done marker'"));
    assert.ok(windowsPayload.includes("'session''; touch /tmp/nope; '''"));

    const adversarialValues = {
        prompt: `Prompt "quoted"; Set-Content C:\\tmp\\prompt-pwned 1; #`,
        title: `Title "quoted"; Set-Content C:\\tmp\\title-pwned 1; #`,
        session: `Session "quoted"; Set-Content C:\\tmp\\session-pwned 1; #`,
        cwd: `C:\\work\\O'Brien "quoted"; Set-Content C:\\tmp\\cwd-pwned 1; #`,
        marker: `C:\\tmp\\done "quoted"; Set-Content C:\\tmp\\marker-pwned 1; #`,
    };
    const adversarialScope = createDirectoryScope(adversarialValues.cwd);
    const windowsSpecs = [
        commandBuilders.buildCodexNewSessionLaunchSpec(adversarialScope, adversarialValues.prompt, adversarialValues.marker),
        commandBuilders.buildClaudeNewSessionLaunchSpec(adversarialScope, adversarialValues.title, adversarialValues.marker),
        commandBuilders.buildCodexResumeLaunchSpec(adversarialValues.session, adversarialScope, adversarialValues.marker),
    ];
    for (const windowsSpec of windowsSpecs) {
        const command = launchSpec.serializeDirectLaunchCommand(windowsSpec, 'win32');
        assert.strictEqual(command.includes('Set-Content'), false);
        const payload = decodePowerShellPayload(command);
        assert.ok(payload.includes(quotePowerShellLiteral(adversarialValues.marker)));
        for (const value of Object.values(adversarialValues)) {
            if (windowsSpec.args.includes(value)) {
                assert.ok(payload.includes(quotePowerShellLiteral(value)));
            }
        }
        if (windowsSpec.cwd) {
            assert.ok(payload.includes(`Set-Location -LiteralPath ${quotePowerShellLiteral(windowsSpec.cwd)}`));
        }
    }

    assert.strictEqual(
        commandBuilders.buildCodexResumeCommand(
            'session-1', createDirectoryScope('C:\\Repo App'), null, 'win32'
        ),
        'codex resume --cd "C:\\Repo App" "session-1"'
    );
    assert.strictEqual(
        commandBuilders.buildKimiResumeCommand(
            'session-1', createDirectoryScope('C:\\Repo App'), null, 'win32'
        ),
        'kimi --work-dir "C:\\Repo App" --resume "session-1"'
    );
    assert.strictEqual(
        commandBuilders.buildClaudeResumeCommand(
            'session-1', createDirectoryScope('C:\\Repo App'), null, 'win32'
        ),
        'cd "C:\\Repo App" && claude --resume "session-1"'
    );

    assert.strictEqual(
        decodePowerShellPayload(commandBuilders.buildCodexNewSessionCommand(
            createDirectoryScope('C:\\Repo App'), 'Prompt', null, 'win32'
        )),
        "codex --cd 'C:\\Repo App' 'Prompt'"
    );
    assert.strictEqual(
        decodePowerShellPayload(commandBuilders.buildKimiNewSessionCommand(
            createDirectoryScope('C:\\Repo App'), 'Prompt', null, 'win32'
        )),
        "kimi --work-dir 'C:\\Repo App' --prompt 'Prompt'"
    );
    assert.strictEqual(
        decodePowerShellPayload(commandBuilders.buildClaudeNewSessionCommand(
            createDirectoryScope('C:\\Repo App'), 'Title', null, 'win32'
        )),
        "Set-Location -LiteralPath 'C:\\Repo App'; claude --name 'Title'"
    );

    assert.strictEqual(
        launchSpec.serializeDirectLaunchCommand({ executable: 'tool', args: ['deploy', '--target', 'value'] }, 'linux'),
        "tool deploy --target 'value'"
    );
    assert.strictEqual(
        launchSpec.serializeDirectLaunchCommand({
            executable: 'tool', args: ['resume'], windowsDirectShell: 'current',
        }, 'win32'),
        'tool "resume"'
    );
}

function runTmuxLayoutChecks() {
    assert.strictEqual(runtimeTypesModule.isValidAiSessionRuntimeIdentityId('pending-codex_1.2:3'), true);
    for (const invalidId of ['', '   ', 'pending id', 'pending\ncontrol', '../unsafe', 'x'.repeat(513)]) {
        assert.strictEqual(runtimeTypesModule.isValidAiSessionRuntimeIdentityId(invalidId), false);
    }
    const nestedRuntimeIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'nested-scope', workspaceNavigationIdentity: 'nested-nav',
        workspaceRootHostPaths: ['/work', '/work/api'], cwd: '/work/api/packages/service', sessionId: 'nested-session',
    };
    assert.strictEqual(runtimeTypesModule.isValidAiSessionRuntimeIdentity(nestedRuntimeIdentity), true,
        'runtime identity must accept a normalized cwd contained by a current workspace root');
    assert.strictEqual(runtimeTypesModule.isValidAiSessionRuntimeIdentity({
        ...nestedRuntimeIdentity, cwd: '/work/api/../outside',
    }), false, 'runtime identity must reject a non-normalized cwd');
    assert.strictEqual(runtimeTypesModule.isValidAiSessionRuntimeIdentity({
        ...nestedRuntimeIdentity, cwd: '/workspace-other',
    }), false, 'runtime identity must reject a boundary-adjacent workspace-external cwd');
    assert.strictEqual(runtimeTypesModule.isValidAiSessionRuntimeIdentity({
        ...nestedRuntimeIdentity, workspaceRootHostPaths: ['/work/api', '/work/api/'],
    }), false, 'runtime identity must reject duplicate normalized roots');
    const identity = { provider: 'codex', workspaceScopeIdentity: 'project-key', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work/app'], cwd: '/work/app', sessionId: 'session-1' };
    const project = new tmuxLayout.ProjectTmuxLayout().getLocator(identity);
    const session = new tmuxLayout.SessionTmuxLayout().getLocator(identity);

    assert.strictEqual(
        tmuxNaming.normalizeTmuxReadableComponent(' ＲｅｄＤＢ DTS / 双活 ', 'workspace'),
        'RedDB-DTS-双活'
    );
    assert.strictEqual(tmuxNaming.normalizeTmuxReadableComponent(' : . ', 'session'), 'session');
    assert.strictEqual(tmuxNaming.normalizeTmuxReadableComponent('', 'new-session'), 'new-session');
    assert.strictEqual(
        tmuxNaming.normalizeTmuxReadableComponent('Fix\u0000replication\u001fnow', 'session'),
        'Fix-replication-now'
    );

    const readableIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'scope-a',
        workspaceNavigationIdentity: 'nav-a', workspaceRootHostPaths: ['/work/a'],
        cwd: '/work/a', sessionId: 'session-123456789',
    };
    const readable = tmuxNaming.buildReadableTmuxLocator(
        readableIdentity, 'project',
        { projectName: ' RedDB DTS / 双活 ', sessionName: 'Fix: replication.timeout' }
    );
    assert.match(readable.sessionName, /^ps-RedDB-DTS-双活-[0-9a-f]{8}$/);
    assert.match(readable.windowName, /^codex-Fix-replication-timeout-[0-9a-f]{8}$/);
    assert.deepStrictEqual(
        tmuxNaming.buildReadableTmuxLocator(readableIdentity, 'project', {
            projectName: ' RedDB DTS / 双活 ', sessionName: 'Fix: replication.timeout',
        }),
        readable
    );
    assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity(readable, readableIdentity), true);
    const readableWorkspaceSuffix = readable.sessionName.match(/([0-9a-f]{8})$/)[1];
    assert.strictEqual(tmuxNaming.projectTmuxSessionMatchesWorkspace(
        readable.sessionName, readableIdentity
    ), true);
    assert.strictEqual(tmuxNaming.projectTmuxSessionMatchesWorkspace(
        `ps-Renamed-Card-${readableWorkspaceSuffix}`, readableIdentity
    ), true, 'project session ownership must ignore the creation-time readable prefix');
    assert.strictEqual(tmuxNaming.projectTmuxSessionMatchesWorkspace(
        new tmuxLayout.ProjectTmuxLayout().getLocator(readableIdentity).sessionName,
        readableIdentity
    ), true, 'legacy project sessions must remain workspace-owned');
    for (const invalidProjectSession of [
        `ps-Renamed-Card-00000000`,
        `ps-Bad:Card-${readableWorkspaceSuffix}`,
        `ps-Bad\nCard-${readableWorkspaceSuffix}`,
        `ps-${'x'.repeat(100)}-${readableWorkspaceSuffix}`,
        `ps-Ｃard-${readableWorkspaceSuffix}`,
        `ps--${readableWorkspaceSuffix}`,
    ]) {
        assert.strictEqual(tmuxNaming.projectTmuxSessionMatchesWorkspace(
            invalidProjectSession, readableIdentity
        ), false, `project workspace ownership must reject ${JSON.stringify(invalidProjectSession)}`);
    }
    assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity(
        { ...readable, windowName: readable.windowName.replace(/[0-9a-f]{8}$/, '00000000') },
        readableIdentity
    ), false);
    const readableRuntimeSuffix = readable.windowName.match(/([0-9a-f]{8})$/)[1];
    for (const unsafeWindowName of [
        `codex-bad:name-${readableRuntimeSuffix}`,
        `codex-bad--name-${readableRuntimeSuffix}`,
        `codex-bad\u0000name-${readableRuntimeSuffix}`,
        `codex-Ｆix-${readableRuntimeSuffix}`,
        `codex-${'a'.repeat(100)}-${readableRuntimeSuffix}`,
    ]) {
        assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity({
            ...readable, windowName: unsafeWindowName,
        }, readableIdentity), false);
    }
    for (const unsafeSessionName of [
        `ps-bad:name-${readableWorkspaceSuffix}`,
        `ps-bad\u0000name-${readableWorkspaceSuffix}`,
        `ps-${'a'.repeat(100)}-${readableWorkspaceSuffix}`,
    ]) {
        assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity({
            ...readable, sessionName: unsafeSessionName,
        }, readableIdentity), false);
    }

    const duplicateNameIdentity = { ...readableIdentity, sessionId: 'different-session' };
    assert.notStrictEqual(
        tmuxNaming.buildReadableTmuxLocator(duplicateNameIdentity, 'project', {
            projectName: 'RedDB DTS / 双活', sessionName: 'Fix: replication.timeout',
        }).windowName,
        readable.windowName
    );
    const duplicateProjectIdentity = {
        ...readableIdentity, workspaceScopeIdentity: 'scope-b',
    };
    assert.notStrictEqual(
        tmuxNaming.buildReadableTmuxLocator(duplicateProjectIdentity, 'project', {
            projectName: 'RedDB DTS / 双活', sessionName: 'Fix: replication.timeout',
        }).sessionName,
        readable.sessionName
    );

    const readablePendingIdentity = {
        ...readableIdentity, sessionId: undefined, pendingId: 'pending-1',
    };
    const readablePending = tmuxNaming.buildReadableTmuxLocator(readablePendingIdentity, 'project', {
        projectName: 'RedDB', sessionName: '',
    });
    assert.match(readablePending.windowName, /^codex-new-session-[0-9a-f]{8}$/);
    assert.deepStrictEqual(tmuxNaming.buildReadableTmuxLocator(readablePendingIdentity, 'project', {
        projectName: 'RedDB', sessionName: '',
    }), readablePending);
    assert.strictEqual(
        tmuxNaming.tmuxLocatorMatchesIdentity(readablePending, readablePendingIdentity), true
    );
    assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity(
        new tmuxLayout.ProjectTmuxLayout().getPendingLocator(readablePendingIdentity),
        readablePendingIdentity
    ), true);
    const otherPendingIdentity = { ...readablePendingIdentity, pendingId: 'pending-2' };
    const otherReadablePending = tmuxNaming.buildReadableTmuxLocator(otherPendingIdentity, 'project', {
        projectName: 'RedDB', sessionName: '',
    });
    assert.notStrictEqual(otherReadablePending.windowName, readablePending.windowName);
    assert.strictEqual(
        tmuxNaming.tmuxLocatorMatchesIdentity(readablePending, otherPendingIdentity), false
    );
    const pendingSessionLayout = tmuxNaming.buildReadableTmuxLocator(
        readablePendingIdentity,
        'session',
        { projectName: 'RedDB', sessionName: '' }
    );
    const pendingRuntimeSuffix = readablePending.windowName.match(/([0-9a-f]{8})$/)[1];
    assert.match(
        pendingSessionLayout.sessionName,
        new RegExp(`^ps-RedDB-new-session-${pendingRuntimeSuffix}$`)
    );
    assert.match(
        pendingSessionLayout.windowName,
        new RegExp(`^codex-new-session-${pendingRuntimeSuffix}$`)
    );
    assert.strictEqual(
        tmuxNaming.tmuxLocatorMatchesIdentity(pendingSessionLayout, readablePendingIdentity), true
    );

    const sessionLayout = tmuxNaming.buildReadableTmuxLocator(readableIdentity, 'session', {
        projectName: 'RedDB', sessionName: 'Repair replication',
    });
    assert.match(sessionLayout.sessionName, /^ps-RedDB-Repair-replication-[0-9a-f]{8}$/);
    assert.match(sessionLayout.windowName, /^codex-Repair-replication-[0-9a-f]{8}$/);
    assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity(sessionLayout, readableIdentity), true);
    assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity({
        ...sessionLayout,
        sessionName: `ps-RedDB-${readableRuntimeSuffix}`,
    }, readableIdentity), false);

    const boundary95SessionLayout = tmuxNaming.buildReadableTmuxLocator(
        readableIdentity,
        'session',
        { projectName: 'p'.repeat(41), sessionName: 's'.repeat(41) }
    );
    assert.strictEqual(Array.from(boundary95SessionLayout.sessionName).length, 95);
    assert.strictEqual(
        tmuxNaming.tmuxLocatorMatchesIdentity(boundary95SessionLayout, readableIdentity), true
    );

    const legacyProject = new tmuxLayout.ProjectTmuxLayout().getLocator(readableIdentity);
    const legacySession = new tmuxLayout.SessionTmuxLayout().getLocator(readableIdentity);
    assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity(legacyProject, readableIdentity), true);
    assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity(legacySession, readableIdentity), true);
    assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity({
        ...readable, sessionName: legacyProject.sessionName,
    }, readableIdentity), true);
    assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity({
        ...legacyProject, sessionName: readable.sessionName,
    }, readableIdentity), true);
    assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity({
        ...legacySession, windowName: sessionLayout.windowName,
    }, readableIdentity), false);
    assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity({
        ...sessionLayout, windowName: undefined,
    }, readableIdentity), false);
    assert.strictEqual(tmuxNaming.tmuxLocatorMatchesIdentity({
        ...readable, layout: 'other',
    }, readableIdentity), false);

    const bounded = tmuxNaming.buildReadableTmuxLocator(readableIdentity, 'project', {
        projectName: '项目'.repeat(100), sessionName: '会话'.repeat(100),
    });
    assert.ok(Array.from(bounded.sessionName).length <= 96);
    assert.ok(Array.from(bounded.windowName).length <= 96);
    assert.match(bounded.sessionName, /-[0-9a-f]{8}$/);
    assert.match(bounded.windowName, /-[0-9a-f]{8}$/);
    const astralBounded = tmuxNaming.buildReadableTmuxLocator(readableIdentity, 'session', {
        projectName: '𐐀'.repeat(100), sessionName: '𐐀'.repeat(100),
    });
    assert.strictEqual(Array.from(astralBounded.sessionName).length, 96);
    assert.strictEqual(Array.from(astralBounded.windowName).length, 96);
    assert.match(astralBounded.sessionName, /^ps-𐐀+-𐐀+-[0-9a-f]{8}$/u);
    assert.match(astralBounded.sessionName, /-[0-9a-f]{8}$/);
    assert.match(astralBounded.windowName, /-[0-9a-f]{8}$/);
    assert.strictEqual(
        tmuxNaming.tmuxLocatorMatchesIdentity(astralBounded, readableIdentity), true
    );
    assert.deepStrictEqual(project, {
        layout: 'project',
        sessionName: 'project-steward-p-857b61585ca6ee92',
        windowName: 'ai-codex-33e62d2489174976',
    });
    assert.deepStrictEqual(session, {
        layout: 'session',
        sessionName: 'project-steward-s-codex-33e62d2489174976',
    });
    assert.strictEqual(new tmuxLayout.ProjectTmuxLayout().getLocator(identity).sessionName, project.sessionName);
    const pendingIdentity = { ...identity, sessionId: undefined, pendingId: 'p1' };
    assert.deepStrictEqual(new tmuxLayout.ProjectTmuxLayout().getPendingLocator(pendingIdentity), {
        layout: 'project',
        sessionName: 'project-steward-p-857b61585ca6ee92',
        windowName: 'pending-codex-3f26128a9ac32c34',
    });
    assert.deepStrictEqual(new tmuxLayout.SessionTmuxLayout().getPendingLocator(pendingIdentity), {
        layout: 'session',
        sessionName: 'project-steward-pending-codex-3f26128a9ac32c34',
    });
    assert.deepStrictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'scope-1',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: JSON.stringify(['/work/api', '/work/web']),
        cwd: '/work/web', provider: 'codex', sessionId: 's1'
    }), {
        version: 2, layout: 'project', workspaceScopeIdentity: 'scope-1',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work/api', '/work/web'],
        cwd: '/work/web', provider: 'codex', sessionId: 's1'
    });
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'project', workspaceScopeIdentity: 'scope-1',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: JSON.stringify(['/work/web']),
        cwd: '/work/web', provider: 'codex', sessionId: 's1', projectKey: 'old'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({ managed: '1', version: '99' }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'scope-1',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: JSON.stringify(['/work/web']),
        cwd: '/work/web', provider: 'codex', sessionId: 's1', projectKey: 'legacy-extra',
    }), null, 'v2 managed metadata must reject legacy and unknown extra fields');

    assert.deepStrictEqual(tmuxLayout.TMUX_METADATA_OPTIONS, {
        managed: '@project-steward-managed',
        version: '@project-steward-version',
        layout: '@project-steward-layout',
        workspaceScopeIdentity: '@project-steward-workspace-scope-identity',
        workspaceNavigationIdentity: '@project-steward-workspace-navigation-identity',
        workspaceRootHostPaths: '@project-steward-workspace-root-host-paths',
        cwd: '@project-steward-cwd',
        provider: '@project-steward-provider',
        sessionId: '@project-steward-session-id',
        pendingId: '@project-steward-pending-id',
        createdAt: '@project-steward-created-at',
        marker: '@project-steward-marker',
    });
    assert.strictEqual(tmuxLayout.getTmuxRuntimeKey(identity), '[2,"codex","project-key","nav-1",["/work/app"],"/work/app","session","session-1"]');
    assert.strictEqual(tmuxLayout.getTmuxRuntimeKey({ ...identity, sessionId: undefined, pendingId: 'p1' }), '[2,"codex","project-key","nav-1",["/work/app"],"/work/app","pending","p1"]');
    const reorderedRoots = { ...identity, workspaceRootHostPaths: ['/work/web', '/work/app'] };
    const sortedRoots = { ...identity, workspaceRootHostPaths: ['/work/app', '/work/web'] };
    assert.strictEqual(tmuxLayout.getTmuxRuntimeKey(reorderedRoots), tmuxLayout.getTmuxRuntimeKey(sortedRoots));
    assert.notStrictEqual(tmuxLayout.getTmuxRuntimeKey(identity), tmuxLayout.getTmuxRuntimeKey({
        ...identity, workspaceScopeIdentity: 'other-scope'
    }));
    assert.ok(!project.sessionName.includes('/work/app') && !session.sessionName.includes('/work/app'));
    assert.throws(() => new tmuxLayout.ProjectTmuxLayout().getLocator({ ...identity, sessionId: '' }));
    assert.throws(() => new tmuxLayout.ProjectTmuxLayout().getLocator({ ...identity, provider: 'other' }));
    assert.throws(() => new tmuxLayout.ProjectTmuxLayout().getLocator({ ...identity, workspaceScopeIdentity: 'x'.repeat(513) }));
    assert.throws(() => new tmuxLayout.SessionTmuxLayout().getLocator({ ...identity, sessionId: 'session\u001f1' }));
    assert.throws(() => new tmuxLayout.SessionTmuxLayout().getPendingLocator({ ...identity, sessionId: undefined, pendingId: '' }));
    assert.throws(() => tmuxLayout.getTmuxRuntimeKey({ ...identity, sessionId: undefined, pendingId: undefined }));
    assert.throws(() => tmuxLayout.getTmuxRuntimeKey({ ...identity, pendingId: 'p1' }));
    assert.throws(() => new tmuxLayout.ProjectTmuxLayout().getLocator({ ...identity, pendingId: 'rejected' }));
    assert.throws(() => new tmuxLayout.SessionTmuxLayout().getPendingLocator({ ...pendingIdentity, sessionId: 'rejected' }));
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '2', layout: 'other', workspaceScopeIdentity: 'project-key', provider: 'codex', sessionId: 'session-1'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '2', layout: 'session', workspaceScopeIdentity: 'project-key', provider: 'other', sessionId: 'session-1'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '2', layout: 'session', workspaceScopeIdentity: 'project-key', provider: 'codex', sessionId: 'session\n1'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '2', layout: 'session', workspaceScopeIdentity: 'project-key', provider: 'codex'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '2', layout: 'session', workspaceScopeIdentity: 'project-key', provider: 'codex',
        sessionId: 'session-1', pendingId: 'p1'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '2', layout: 'session', workspaceScopeIdentity: 'project-key', provider: 'codex',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: JSON.stringify(['/work/app']), cwd: '/work/app',
        pendingId: 'p1', createdAt: '2026-07-18T01:02:03.000Z', marker: '/tmp/p1.done'
    }).pendingId, 'p1');
    for (const invalidField of [
        { workspaceScopeIdentity: 'x'.repeat(513) },
        { sessionId: 'x'.repeat(513) },
        { createdAt: 'x'.repeat(201) },
        { createdAt: 'not-a-date' },
        { marker: 'x'.repeat(4097) },
        { marker: '' },
        { marker: '/tmp/control\u007f' },
    ]) {
        assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
            managed: '1', version: '2', layout: 'session', workspaceScopeIdentity: 'project-key', provider: 'codex',
            sessionId: 'session-1', ...invalidField
        }), null);
    }
}

async function runTmuxClientChecks() {
    const requiredCommands = [
        'new-session', 'new-window', 'list-windows', 'set-option', 'show-options',
        'select-window', 'attach-session', 'has-session', 'rename-session', 'rename-window',
        'display-message',
    ];
    const calls = [];
    const runner = {
        run: async (file, args) => {
            calls.push({ file, args });
            if (args[0] === '-V') {
                return { exitCode: 0, stdout: 'tmux 3.2a\n', stderr: '' };
            }
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: `${requiredCommands.join('\n')}\n`, stderr: '' };
            }
            if (args[0] === 'list-windows') {
                return { exitCode: 1, stdout: '', stderr: 'no server running on /tmp/tmux' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };
    const client = new tmuxClientModule.TmuxClient('/opt/bin/tmux', runner);
    assert.deepStrictEqual(await client.checkAvailability(), { available: true, version: '3.2a' });
    assert.deepStrictEqual(await client.checkAvailability(), { available: true, version: '3.2a' });
    assert.strictEqual(calls.filter(call => call.args[0] === '-V').length, 1);
    assert.deepStrictEqual(await client.listWindows(), []);
    await client.selectWindow({
        layout: 'project', sessionName: 'project-steward-p-a', windowName: 'ai-codex-b',
    });
    assert.deepStrictEqual(calls[calls.length - 1], {
        file: '/opt/bin/tmux', args: ['select-window', '-t', 'project-steward-p-a:ai-codex-b'],
    });
    assert.ok(calls.every(call => Array.isArray(call.args)));

    const activeWindowCalls = [];
    let activeWindowResult = {
        exitCode: 0,
        stdout: [
            'project-session\u001fbase\u001f@1\u001f0',
            'project-session\u001fai-codex-a\u001f@2\u001f1',
        ].join('\n') + '\n',
        stderr: '',
    };
    const activeWindowClient = new tmuxClientModule.TmuxClient('/opt/private/tmux', {
        run: async (_file, args) => {
            activeWindowCalls.push(args);
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.2a\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            return activeWindowResult;
        },
    });
    assert.deepStrictEqual(await activeWindowClient.getActiveWindow('project-session'), {
        sessionName: 'project-session', windowName: 'ai-codex-a', windowId: '@2',
    });
    assert.deepStrictEqual(activeWindowCalls.slice(-1)[0], [
        'list-windows', '-t', 'project-session', '-F',
        '#{session_name}\u001f#{window_name}\u001f#{window_id}\u001f#{window_active}',
    ]);

    activeWindowResult = { exitCode: 0, stdout: '', stderr: '' };
    assert.strictEqual(await activeWindowClient.getActiveWindow('project-session'), null);

    activeWindowResult = {
        exitCode: 0,
        stdout: [
            'project-session\u001fa\u001f@1\u001f1',
            'project-session\u001fb\u001f@2\u001f1',
        ].join('\n') + '\n',
        stderr: '',
    };
    await assert.rejects(activeWindowClient.getActiveWindow('project-session'), error =>
        error.operation === 'get-active-window' && error.category === 'invalid-output');

    activeWindowResult = {
        exitCode: 0,
        stdout: 'foreign-session\u001fa\u001f@1\u001f1\n',
        stderr: '',
    };
    await assert.rejects(activeWindowClient.getActiveWindow('project-session'), error =>
        error.operation === 'get-active-window' && error.category === 'invalid-output');

    activeWindowResult = { exitCode: 0, stdout: 'x'.repeat(1024 * 1024 + 1), stderr: '' };
    await assert.rejects(activeWindowClient.getActiveWindow('project-session'), error =>
        error.operation === 'get-active-window' && error.category === 'invalid-output');

    activeWindowResult = { exitCode: 1, stdout: '', stderr: "can't find session: project-session" };
    assert.strictEqual(await activeWindowClient.getActiveWindow('project-session'), null);

    activeWindowResult = {
        exitCode: 2,
        stdout: 'secret stdout',
        stderr: 'secret stderr for project-session',
    };
    await assert.rejects(activeWindowClient.getActiveWindow('project-session'), error => {
        assert.strictEqual(error.operation, 'get-active-window');
        assert.strictEqual(error.category, 'nonzero-exit');
        for (const secret of ['project-session', 'secret stdout', 'secret stderr', '/opt/private/tmux']) {
            assert.ok(!error.message.includes(secret));
        }
        return true;
    });
    await assert.rejects(activeWindowClient.getActiveWindow('bad\nsession'), TypeError);

    const targetMetadata = {
        managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'project-key',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: '["/work"]', cwd: '/work',
        provider: 'codex', sessionId: 'session-1', pendingId: '',
        createdAt: '2026-07-22T00:00:00.000Z', marker: '/tmp/session-1.done',
    };
    const targetFields = Object.keys(tmuxLayout.TMUX_METADATA_OPTIONS)
        .map(key => targetMetadata[key] || '');
    let targetResult = {
        exitCode: 0,
        stdout: ['managed-session', 'ai-codex-1', '@42', ...targetFields].join('\u001f') + '\n',
        stderr: '',
    };
    const targetCalls = [];
    const targetClient = new tmuxClientModule.TmuxClient('/private/tmux', {
        run: async (_file, args) => {
            targetCalls.push(args);
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.4\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return {
                    exitCode: 0,
                    stdout: [...requiredCommands, 'display-message'].join('\n'),
                    stderr: '',
                };
            }
            return targetResult;
        },
    });
    const targetLocator = {
        layout: 'project', sessionName: 'managed-session', windowName: 'ai-codex-1',
    };
    assert.deepStrictEqual(await targetClient.getTargetWindow(targetLocator), {
        sessionName: 'managed-session', windowName: 'ai-codex-1', windowId: '@42',
        metadata: Object.fromEntries(Object.entries(targetMetadata).filter(([, value]) => value)),
    });
    assert.deepStrictEqual(targetCalls.slice(-1)[0].slice(0, 4), [
        'display-message', '-p', '-t', 'managed-session:ai-codex-1',
    ]);
    const targetFormat = targetCalls.slice(-1)[0][4];
    assert.ok(targetFormat.startsWith('#{session_name}\u001f#{window_name}\u001f#{window_id}\u001f'));
    for (const option of Object.values(tmuxLayout.TMUX_METADATA_OPTIONS)) {
        assert.ok(targetFormat.includes(`#{${option}}`));
    }
    const readableSessionTargetLocator = {
        layout: 'session', sessionName: 'managed-session', windowName: 'ai-codex-1',
    };
    assert.deepStrictEqual(await targetClient.getTargetWindow(readableSessionTargetLocator), {
        sessionName: 'managed-session', windowName: 'ai-codex-1', windowId: '@42',
        metadata: Object.fromEntries(Object.entries(targetMetadata).filter(([, value]) => value)),
    });
    assert.deepStrictEqual(targetCalls.slice(-1)[0].slice(0, 4), [
        'display-message', '-p', '-t', 'managed-session:ai-codex-1',
    ], 'real tmux client target verification must address a readable session window exactly');
    await targetClient.getTargetWindow({ layout: 'session', sessionName: 'managed-session' });
    assert.deepStrictEqual(targetCalls.slice(-1)[0].slice(0, 4), [
        'display-message', '-p', '-t', 'managed-session',
    ], 'legacy session target verification must retain its session-only target');
    await assert.rejects(targetClient.getTargetWindow({
        layout: 'session', sessionName: 'managed-session', windowName: 'bad\nwindow',
    }), TypeError);

    targetResult = { exitCode: 1, stdout: '', stderr: "can't find window: ai-codex-1" };
    assert.strictEqual(await targetClient.getTargetWindow(targetLocator), null);

    targetResult = { exitCode: 0, stdout: 'too\u001ffew\n', stderr: '' };
    await assert.rejects(targetClient.getTargetWindow(targetLocator), error =>
        error.operation === 'get-target-window' && error.category === 'invalid-output');

    const oversizedTargetFields = targetFields.slice();
    oversizedTargetFields[Object.keys(tmuxLayout.TMUX_METADATA_OPTIONS).indexOf('marker')] = 'x'.repeat(4097);
    targetResult = {
        exitCode: 0,
        stdout: ['managed-session', 'ai-codex-1', '@42', ...oversizedTargetFields].join('\u001f') + '\n',
        stderr: '',
    };
    await assert.rejects(targetClient.getTargetWindow(targetLocator), error =>
        error.operation === 'get-target-window' && error.category === 'invalid-output');

    targetResult = { exitCode: 2, stdout: 'private stdout', stderr: 'private locator' };
    await assert.rejects(targetClient.getTargetWindow(targetLocator), error => {
        assert.strictEqual(error.operation, 'get-target-window');
        assert.strictEqual(error.category, 'nonzero-exit');
        for (const secret of ['private stdout', 'private locator', '/private/tmux']) {
            assert.ok(!error.message.includes(secret));
        }
        return true;
    });
    await assert.rejects(targetClient.getTargetWindow({
        layout: 'project', sessionName: 'bad\nsession', windowName: 'ai-codex-1',
    }), TypeError);

    const metadataCalls = [];
    const optionValues = {
        'session-a|managed': '1',
        'session-a|version': '2',
        'session-a|layout': 'project',
        'session-a|workspaceScopeIdentity': 'project-key',
        'session-a|workspaceNavigationIdentity': 'nav-1',
        'session-a|workspaceRootHostPaths': '["/work"]',
        'session-a|cwd': '/work',
        '@12|managed': '1',
        '@12|version': '2',
        '@12|layout': 'project',
        '@12|provider': 'codex',
        '@12|sessionId': 'session-id-12',
        '@12|marker': '/tmp/done-12 marker',
        '@13|managed': '1',
        '@13|version': '2',
        '@13|layout': 'project',
        '@13|provider': 'kimi',
        '@13|sessionId': 'session-id-13',
        '@13|marker': '/tmp/done-13 marker',
        'session-a:window-a|provider': 'claude',
        'session-a:window-a|sessionId': 'public-window-lookup',
    };
    const metadataRunner = {
        run: async (file, args) => {
            metadataCalls.push({ file, args });
            if (args[0] === '-V') {
                return { exitCode: 0, stdout: 'tmux 3.4\n', stderr: '' };
            }
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.map(name => `${name} [-flags]`).join('\n'), stderr: '' };
            }
            if (args[0] === 'list-windows') {
                return {
                    exitCode: 0,
                    stdout: [
                        'session-a\u001fwindow-a\u001f@12\u001f1',
                        'session-a\u001fwindow-a\u001f@13\u001f0',
                    ].join('\n') + '\n',
                    stderr: '',
                };
            }
            if (args[0] === 'show-options') {
                const target = args[args.indexOf('-t') + 1];
                const optionName = args[args.length - 1];
                const key = Object.keys(tmuxLayout.TMUX_METADATA_OPTIONS)
                    .find(name => tmuxLayout.TMUX_METADATA_OPTIONS[name] === optionName);
                const value = optionValues[`${target}|${key}`];
                return { exitCode: 0, stdout: value === undefined ? '' : `${value}\n`, stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };
    const metadataClient = new tmuxClientModule.TmuxClient('  /opt/tmux tools/tmux  ', metadataRunner);
    assert.strictEqual(metadataClient.getExecutablePath(), '/opt/tmux tools/tmux');
    assert.deepStrictEqual(await metadataClient.listWindows(), [
        {
            sessionName: 'session-a',
            windowName: 'window-a',
            windowId: '@12',
            active: true,
            sessionMetadata: {
                managed: '1',
                version: '2',
                layout: 'project',
                workspaceScopeIdentity: 'project-key',
                workspaceNavigationIdentity: 'nav-1',
                workspaceRootHostPaths: '["/work"]',
                cwd: '/work',
                workspaceNavigationIdentity: 'nav-1',
                workspaceRootHostPaths: '["/work"]',
                cwd: '/work',
            },
            windowMetadata: {
                managed: '1',
                version: '2',
                layout: 'project',
                provider: 'codex',
                sessionId: 'session-id-12',
                marker: '/tmp/done-12 marker',
            },
            metadata: {
                managed: '1',
                version: '2',
                layout: 'project',
                workspaceScopeIdentity: 'project-key',
                workspaceNavigationIdentity: 'nav-1',
                workspaceRootHostPaths: '["/work"]',
                cwd: '/work',
                provider: 'codex',
                sessionId: 'session-id-12',
                marker: '/tmp/done-12 marker',
            },
        },
        {
            sessionName: 'session-a',
            windowName: 'window-a',
            windowId: '@13',
            active: false,
            sessionMetadata: {
                managed: '1',
                version: '2',
                layout: 'project',
                workspaceScopeIdentity: 'project-key',
                workspaceNavigationIdentity: 'nav-1',
                workspaceRootHostPaths: '["/work"]',
                cwd: '/work',
            },
            windowMetadata: {
                managed: '1',
                version: '2',
                layout: 'project',
                provider: 'kimi',
                sessionId: 'session-id-13',
                marker: '/tmp/done-13 marker',
            },
            metadata: {
                managed: '1',
                version: '2',
                layout: 'project',
                workspaceScopeIdentity: 'project-key',
                workspaceNavigationIdentity: 'nav-1',
                workspaceRootHostPaths: '["/work"]',
                cwd: '/work',
                provider: 'kimi',
                sessionId: 'session-id-13',
                marker: '/tmp/done-13 marker',
            },
        },
    ]);
    const listingMetadataCalls = metadataCalls.slice();
    for (const windowId of ['@12', '@13']) {
        assert.ok(listingMetadataCalls.some(call => JSON.stringify(call.args) === JSON.stringify([
            'show-options', '-qvw', '-t', windowId, '@project-steward-provider',
        ])));
    }
    assert.deepStrictEqual(await metadataClient.getSessionOptions('session-a'), {
        managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'project-key',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: '["/work"]', cwd: '/work',
    });
    assert.deepStrictEqual(await metadataClient.getWindowOptions('session-a', 'window-a'), {
        provider: 'claude', sessionId: 'public-window-lookup',
    });
    await metadataClient.setSessionOptions('session-a', { managed: '1', version: '2' });
    await metadataClient.setWindowOptions('session-a', 'window-a', {
        provider: 'codex', sessionId: 'session-id',
    });
    await metadataClient.configureManagedWindow('session-a', 'window-a');
    await metadataClient.clearPendingMetadata({
        layout: 'project', sessionName: 'session-a', windowName: 'window-a',
    });
    await metadataClient.clearPendingMetadata({ layout: 'session', sessionName: 'session-a' });
    await metadataClient.clearPendingMetadata({
        layout: 'session', sessionName: 'session-a', windowName: 'readable-window',
    });
    assert.ok(metadataCalls.some(call => JSON.stringify(call.args) === JSON.stringify([
        'set-option', '-t', 'session-a', '@project-steward-managed', '1',
    ])));
    assert.ok(metadataCalls.some(call => JSON.stringify(call.args) === JSON.stringify([
        'set-option', '-w', '-t', 'session-a:window-a', '@project-steward-session-id', 'session-id',
    ])));
    assert.deepStrictEqual(metadataCalls.slice(-6).map(call => call.args), [
        ['set-option', '-w', '-t', 'session-a:window-a', 'automatic-rename', 'off'],
        ['set-option', '-w', '-t', 'session-a:window-a', 'allow-rename', 'off'],
        ['set-option', '-w', '-t', 'session-a:window-a', 'remain-on-exit', 'off'],
        ['set-option', '-uw', '-t', 'session-a:window-a', '@project-steward-pending-id'],
        ['set-option', '-u', '-t', 'session-a', '@project-steward-pending-id'],
        ['set-option', '-u', '-t', 'session-a', '@project-steward-pending-id'],
    ]);
    await assert.rejects(metadataClient.clearPendingMetadata({
        layout: 'session', sessionName: 'session-a', windowName: 'bad\nwindow',
    }), TypeError);
    await assert.rejects(
        metadataClient.setSessionOptions('session-a', { status: 'global-option-not-allowed' }),
        /metadata option/
    );

    let inFlightOptions = 0;
    let peakOptions = 0;
    let failedOption = null;
    const parallelClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.4\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            if (args[0] === 'show-options') {
                const option = args[args.length - 1];
                inFlightOptions++;
                peakOptions = Math.max(peakOptions, inFlightOptions);
                await new Promise(resolve => setImmediate(resolve));
                inFlightOptions--;
                if (option === failedOption) {
                    return { exitCode: 2, stdout: 'private stdout', stderr: 'private stderr' };
                }
                return { exitCode: 0, stdout: 'value\n', stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    });
    const parallelMetadata = await parallelClient.getSessionOptions('managed-session');
    assert.strictEqual(Object.keys(parallelMetadata).length,
        Object.keys(tmuxLayout.TMUX_METADATA_OPTIONS).length);
    assert.strictEqual(peakOptions, Object.keys(tmuxLayout.TMUX_METADATA_OPTIONS).length,
        'one target must read its fixed metadata option set concurrently');

    failedOption = tmuxLayout.TMUX_METADATA_OPTIONS.provider;
    await assert.rejects(parallelClient.getWindowOptions('managed-session', 'managed-window'), error =>
        error.operation === 'get-window-options' && error.category === 'nonzero-exit');

    await metadataClient.createSession('s', 'w', '/work/space here', 'exec secret-tool --token credential');
    await metadataClient.createWindow('s', 'w2', '/work/space here', 'exec secret-tool --token credential');
    await metadataClient.renameSession('s', 's2');
    await metadataClient.renameWindow('s2', 'w2', 'w3');
    await metadataClient.selectWindow({ layout: 'session', sessionName: 's2' });
    assert.deepStrictEqual(metadataCalls.slice(-5).map(call => call.args), [
        ['new-session', '-d', '-s', 's', '-n', 'w', '-c', '/work/space here', 'exec secret-tool --token credential'],
        ['new-window', '-d', '-t', 's', '-n', 'w2', '-c', '/work/space here', 'exec secret-tool --token credential'],
        ['rename-session', '-t', 's', 's2'],
        ['rename-window', '-t', 's2:w2', 'w3'],
        ['select-window', '-t', 's2'],
    ]);

    const e2bigClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            const error = new Error('argument list too long');
            error.code = 'E2BIG';
            throw error;
        },
    });
    await assert.rejects(e2bigClient.createSession('s', 'w', '/work', 'command'), error => {
        assert.strictEqual(error.category, 'argument-list-too-long');
        return true;
    });

    const hasSessionRunner = {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            if (args[0] === 'has-session') {
                return { exitCode: 1, stdout: '', stderr: "can't find session: absent" };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };
    assert.strictEqual(await new tmuxClientModule.TmuxClient('tmux', hasSessionRunner).hasSession('absent'), false);

    const pathCalls = [];
    const pathRunner = {
        run: async (file, args) => {
            pathCalls.push({ file, args });
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };
    const pathClient = new tmuxClientModule.TmuxClient('tmux', pathRunner);
    await pathClient.checkAvailability();
    pathClient.setExecutablePath('  /new path/tmux  ');
    assert.strictEqual(pathClient.getExecutablePath(), '/new path/tmux');
    await pathClient.hasSession('s');
    assert.strictEqual(pathCalls.filter(call => call.args[0] === '-V').length, 2);
    assert.ok(pathCalls.slice(-3).every(call => call.file === '/new path/tmux'));
    pathClient.setExecutablePath('/new path/tmux');
    await pathClient.checkAvailability();
    assert.strictEqual(pathCalls.filter(call => call.args[0] === '-V').length, 3);
    assert.throws(() => pathClient.setExecutablePath('   '), /executable/);

    const missingCapabilityClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async (_file, args) => args[0] === '-V'
            ? { exitCode: 0, stdout: 'tmux 3.2\n', stderr: '' }
            : { exitCode: 0, stdout: requiredCommands.filter(name => name !== 'attach-session').join('\n'), stderr: '' },
    });
    assert.deepStrictEqual(await missingCapabilityClient.checkAvailability(), {
        available: false,
        category: 'missing-capability',
        message: 'The configured tmux does not provide all required commands.',
    });
    for (const omittedCommand of ['has-session', 'rename-session', 'rename-window']) {
        const omittedCapabilityClient = new tmuxClientModule.TmuxClient('tmux', {
            run: async (_file, args) => args[0] === '-V'
                ? { exitCode: 0, stdout: 'tmux 3.2\n', stderr: '' }
                : {
                    exitCode: 0,
                    stdout: requiredCommands.filter(name => name !== omittedCommand).join('\n'),
                    stderr: '',
                },
        });
        assert.deepStrictEqual(await omittedCapabilityClient.checkAvailability(), {
            available: false,
            category: 'missing-capability',
            message: 'The configured tmux does not provide all required commands.',
        }, `availability must require ${omittedCommand}`);
    }

    const invalidVersionClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async () => ({ exitCode: 0, stdout: 'tmux   \n', stderr: 'credential=never-report' }),
    });
    assert.deepStrictEqual(await invalidVersionClient.checkAvailability(), {
        available: false,
        category: 'invalid-version',
        message: 'The configured tmux returned an unrecognized version.',
    });
    const unsafeVersionClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async () => ({
            exitCode: 0,
            stdout: 'tmux 3.3 token=credential\n',
            stderr: '',
        }),
    });
    assert.deepStrictEqual(await unsafeVersionClient.checkAvailability(), {
        available: false,
        category: 'invalid-version',
        message: 'The configured tmux returned an unrecognized version.',
    });

    const secret = 'prompt=do-not-report token=credential';
    const failingRunner = {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            return { exitCode: 42, stdout: `stdout ${secret}`, stderr: `stderr ${secret}` };
        },
    };
    const failingClient = new tmuxClientModule.TmuxClient('/secret/path/tmux', failingRunner);
    await assert.rejects(
        failingClient.createSession('secret-session', 'secret-window', '/secret/cwd', secret),
        error => {
            assert.ok(error instanceof tmuxClientModule.TmuxClientError);
            assert.strictEqual(error.operation, 'create-session');
            assert.strictEqual(error.category, 'nonzero-exit');
            const publicError = `${error.message} ${JSON.stringify(error)}`;
            for (const sensitive of [secret, '/secret/path/tmux', 'secret-session', 'secret-window', '/secret/cwd']) {
                assert.strictEqual(publicError.includes(sensitive), false);
            }
            assert.strictEqual(publicError.includes('stdout'), false);
            assert.strictEqual(publicError.includes('stderr'), false);
            return true;
        }
    );

    const notFoundClient = new tmuxClientModule.TmuxClient('/secret/missing-tmux', {
        run: async () => {
            const error = new Error(`spawn /secret/missing-tmux ENOENT ${secret}`);
            error.code = 'ENOENT';
            throw error;
        },
    });
    const notFoundAvailability = await notFoundClient.checkAvailability();
    assert.strictEqual(notFoundAvailability.category, 'not-found');
    assert.strictEqual(JSON.stringify(notFoundAvailability).includes('/secret'), false);
    assert.strictEqual(JSON.stringify(notFoundAvailability).includes(secret), false);

    const malformedClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            return { exitCode: 0, stdout: `session\u001fwindow\u001f@1\u001f1\u001f${secret}\n`, stderr: '' };
        },
    });
    await assert.rejects(malformedClient.listWindows(), error => {
        assert.ok(error instanceof tmuxClientModule.TmuxClientError);
        assert.strictEqual(error.operation, 'list-windows');
        assert.strictEqual(error.category, 'invalid-output');
        assert.strictEqual(error.message.includes(secret), false);
        return true;
    });

    const malformedFailureCategory = 'prompt=do-not-report';
    const malformedResultClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            return {
                exitCode: null, stdout: '', stderr: '', failureCategory: malformedFailureCategory,
            };
        },
    });
    await assert.rejects(malformedResultClient.hasSession('s'), error => {
        assert.strictEqual(error.operation, 'has-session');
        assert.strictEqual(error.category, 'invalid-output');
        assert.strictEqual(error.message.includes(malformedFailureCategory), false);
        return true;
    });

    const forgedSecrets = {
        message: 'message=forged-secret',
        operation: 'operation=forged-secret',
        category: 'category=forged-secret',
        name: 'name=forged-secret',
        stack: 'stack=forged-secret',
        code: 'code=forged-secret',
    };
    const forgedError = new tmuxClientModule.TmuxClientError(
        forgedSecrets.operation, forgedSecrets.category
    );
    Object.assign(forgedError, forgedSecrets);
    const forgedErrorClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            throw forgedError;
        },
    });
    await assert.rejects(forgedErrorClient.hasSession('s'), error => {
        assert.ok(error instanceof tmuxClientModule.TmuxClientError);
        assert.notStrictEqual(error, forgedError);
        assert.strictEqual(error.operation, 'has-session');
        assert.strictEqual(error.category, 'unsupported');
        const publicError = `${error.name} ${error.message} ${error.stack} ${JSON.stringify(error)}`;
        for (const value of Object.values(forgedSecrets)) {
            assert.strictEqual(publicError.includes(value), false);
        }
        return true;
    });

    const rejectedGetterCases = [
        {
            secret: 'rejected-code-getter-secret',
            value: new Proxy({}, {
                get: (_target, property) => {
                    if (property === 'code') {
                        throw new Error('rejected-code-getter-secret');
                    }
                    return undefined;
                },
            }),
        },
        {
            secret: 'rejected-killed-getter-secret',
            value: Object.defineProperties({}, {
                code: { value: 'UNKNOWN', enumerable: true },
                killed: {
                    enumerable: true,
                    get: () => { throw new Error('rejected-killed-getter-secret'); },
                },
            }),
        },
    ];
    for (const rejectedCase of rejectedGetterCases) {
        const rejectedGetterClient = new tmuxClientModule.TmuxClient('tmux', {
            run: async (_file, args) => {
                if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
                if (args[0] === 'list-commands') {
                    return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
                }
                throw rejectedCase.value;
            },
        });
        await assert.rejects(rejectedGetterClient.hasSession('s'), error => {
            assert.ok(error instanceof tmuxClientModule.TmuxClientError);
            assert.notStrictEqual(error, rejectedCase.value);
            assert.strictEqual(error.operation, 'has-session');
            assert.strictEqual(error.category, 'unsupported');
            const publicError = `${error.name} ${error.message} ${error.stack} ${JSON.stringify(error)}`;
            assert.strictEqual(publicError.includes(rejectedCase.secret), false);
            return true;
        });
    }

    const fulfilledGetterSecrets = {
        message: 'fulfilled-getter-message-secret',
        operation: 'fulfilled-getter-operation-secret',
        category: 'fulfilled-getter-category-secret',
    };
    const fulfilledGetterError = new tmuxClientModule.TmuxClientError(
        fulfilledGetterSecrets.operation, fulfilledGetterSecrets.category
    );
    fulfilledGetterError.message = fulfilledGetterSecrets.message;
    const fulfilledResultProxy = new Proxy({}, {
        get: (_target, property) => {
            if (property === 'exitCode') {
                throw fulfilledGetterError;
            }
            return '';
        },
    });
    const fulfilledGetterClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async (_file, args) => {
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.3\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: requiredCommands.join('\n'), stderr: '' };
            }
            return fulfilledResultProxy;
        },
    });
    await assert.rejects(fulfilledGetterClient.hasSession('s'), error => {
        assert.ok(error instanceof tmuxClientModule.TmuxClientError);
        assert.notStrictEqual(error, fulfilledGetterError);
        assert.strictEqual(error.operation, 'has-session');
        assert.strictEqual(error.category, 'invalid-output');
        const publicError = `${error.name} ${error.message} ${error.stack} ${JSON.stringify(error)}`;
        for (const value of Object.values(fulfilledGetterSecrets)) {
            assert.strictEqual(publicError.includes(value), false);
        }
        return true;
    });

    const availabilityGetterSecret = 'availability-getter-secret';
    const availabilityGetterClient = new tmuxClientModule.TmuxClient('tmux', {
        run: async () => new Proxy({}, {
            get: () => { throw new Error(availabilityGetterSecret); },
        }),
    });
    const getterAvailability = await availabilityGetterClient.checkAvailability();
    assert.deepStrictEqual(getterAvailability, {
        available: false,
        category: 'command-failed',
        message: 'The configured tmux could not complete an availability check.',
    });
    assert.strictEqual(JSON.stringify(getterAvailability).includes(availabilityGetterSecret), false);
}

async function runTmuxDiscoveryChecks() {
    const finalIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1',
    };
    const finalLocator = new tmuxLayout.ProjectTmuxLayout().getLocator(finalIdentity);
    const finalSessionMetadata = {
        managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'pk',
    };
    const finalWindowMetadata = {
        managed: '1', version: '2', layout: 'project',
        workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1',
        workspaceRootHostPaths: JSON.stringify(['/work']), cwd: '/work',
        provider: 'codex', sessionId: 's1', marker: '/tmp/s1.done',
        createdAt: '2026-07-18T10:00:00Z',
    };
    const finalRow = {
        ...finalLocator, windowId: '@1', active: false,
        sessionMetadata: finalSessionMetadata,
        windowMetadata: finalWindowMetadata,
        metadata: { ...finalSessionMetadata, ...finalWindowMetadata },
    };
    let now = 1000;
    let lists = 0;
    const reconciled = [];
    const discovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => {
            lists++;
            return [finalRow, { ...finalRow, windowId: '@1-duplicate' }];
        } },
        bindingStore: {
            listPending: async () => [],
            listKnown: async () => [],
            reconcileKnown: async runtimes => { reconciled.push(runtimes); },
        },
        markerIsCurrent: () => false,
        nowMs: () => now,
        cacheTtlMs: 500,
    });
    await discovery.refresh();
    await discovery.refresh();
    assert.strictEqual(lists, 1);
    assert.deepStrictEqual(discovery.getActive(), [{
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        backend: 'tmux',
        state: 'active',
        markerPath: '/tmp/s1.done',
        runStartedAtMs: Date.parse('2026-07-18T10:00:00Z'),
        attached: false,
        tmux: finalLocator,
    }]);
    assert.strictEqual(reconciled.length, 1);
    assert.strictEqual(reconciled[0].length, 1);
    await discovery.refresh(true);
    assert.strictEqual(lists, 2);
    assert.strictEqual(discovery.find(finalIdentity).length, 1);
    const activeCopy = discovery.getActive();
    activeCopy[0].identity.sessionId = 'mutated';
    activeCopy[0].tmux.sessionName = 'mutated';
    assert.strictEqual(discovery.getActive()[0].identity.sessionId, 's1');
    assert.strictEqual(discovery.getActive()[0].tmux.sessionName, finalLocator.sessionName);

    const immutableProjectIdentities = [
        {
            provider: 'codex', workspaceScopeIdentity: 'shared-scope',
            workspaceNavigationIdentity: 'nav:first', workspaceRootHostPaths: ['/work/first'],
            cwd: '/work/first', sessionId: 'immutable-first',
        },
        {
            provider: 'claude', workspaceScopeIdentity: 'shared-scope',
            workspaceNavigationIdentity: 'nav:second', workspaceRootHostPaths: ['/work/second'],
            cwd: '/work/second', sessionId: 'immutable-second',
        },
    ];
    const immutableProjectRows = immutableProjectIdentities.map((identity, index) => ({
        ...new tmuxLayout.ProjectTmuxLayout().getLocator(identity),
        windowId: `@immutable-${index}`,
        active: index === 0,
        sessionMetadata: {
            managed: '1', version: '2', layout: 'project',
            workspaceScopeIdentity: identity.workspaceScopeIdentity,
        },
        windowMetadata: {
            managed: '1', version: '2', layout: 'project',
            workspaceScopeIdentity: identity.workspaceScopeIdentity,
            workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
            workspaceRootHostPaths: JSON.stringify(identity.workspaceRootHostPaths),
            cwd: identity.cwd, provider: identity.provider, sessionId: identity.sessionId,
            createdAt: `2026-07-18T10:00:0${index}.000Z`,
        },
        metadata: {},
    }));
    const immutableProjectDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => immutableProjectRows },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
    });
    await immutableProjectDiscovery.refresh();
    assert.deepStrictEqual(
        immutableProjectDiscovery.getActive().map(runtime => runtime.identity),
        immutableProjectIdentities,
        'each project-layout window must retain its immutable cwd, navigation, and root snapshot'
    );

    discovery.invalidate();
    await discovery.refresh();
    assert.strictEqual(lists, 3);

    const inFlightGate = deferred();
    const forcedInFlightGate = deferred();
    const thirdForcedInFlightGate = deferred();
    let inFlightLists = 0;
    const inFlightDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => {
            inFlightLists++;
            return inFlightLists === 1
                ? inFlightGate.promise
                : inFlightLists === 2 ? forcedInFlightGate.promise : thirdForcedInFlightGate.promise;
        } },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
        nowMs: () => 1000,
        cacheTtlMs: 500,
    });
    const ordinaryRefresh = inFlightDiscovery.refresh();
    const forcedRefresh = inFlightDiscovery.refresh(true);
    const coalescedForcedRefresh = inFlightDiscovery.refresh(true);
    assert.strictEqual(inFlightLists, 1);
    inFlightGate.resolve([finalRow]);
    await ordinaryRefresh;
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(inFlightLists, 2);
    const thirdForcedRefresh = inFlightDiscovery.refresh(true);
    const coalescedThirdForcedRefresh = inFlightDiscovery.refresh(true);
    forcedInFlightGate.resolve([finalRow]);
    await Promise.all([forcedRefresh, coalescedForcedRefresh]);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(inFlightLists, 3);
    thirdForcedInFlightGate.resolve([finalRow]);
    await Promise.all([thirdForcedRefresh, coalescedThirdForcedRefresh]);
    assert.strictEqual(inFlightLists, 3);

    const invalidatedGate = deferred();
    let invalidatedLists = 0;
    const invalidatedDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => {
            invalidatedLists++;
            return invalidatedLists === 1 ? invalidatedGate.promise : [finalRow];
        } },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
        nowMs: () => 1000,
        cacheTtlMs: 500,
    });
    const invalidatedRefresh = invalidatedDiscovery.refresh();
    invalidatedDiscovery.invalidate();
    const invalidatedJoinedRefresh = invalidatedDiscovery.refresh(true);
    assert.strictEqual(invalidatedLists, 1);
    invalidatedGate.resolve([finalRow]);
    await Promise.all([invalidatedRefresh, invalidatedJoinedRefresh]);
    assert.strictEqual(invalidatedLists, 2);
    await invalidatedDiscovery.refresh();
    assert.strictEqual(invalidatedLists, 2);
    await invalidatedDiscovery.refresh();
    assert.strictEqual(invalidatedLists, 2);

    let failedCacheLists = 0;
    const failedCacheDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => {
            failedCacheLists++;
            if (failedCacheLists === 1) throw new Error('uncached list failure');
            return [finalRow];
        } },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
        nowMs: () => 1000,
        cacheTtlMs: 500,
    });
    await assert.rejects(failedCacheDiscovery.refresh(), /uncached list failure/);
    await failedCacheDiscovery.refresh();
    await failedCacheDiscovery.refresh();
    assert.strictEqual(failedCacheLists, 2);

    const pendingIdentity = {
        provider: 'kimi', workspaceScopeIdentity: 'pending-project', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work/pending'], cwd: '/work/pending', pendingId: 'p1',
    };
    const pendingLocator = new tmuxLayout.ProjectTmuxLayout().getPendingLocator(pendingIdentity);
    const pendingBinding = {
        version: 2, state: 'pending', pendingId: 'p1', provider: 'kimi',
        workspaceScopeIdentity: 'pending-project', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work/pending'], cwd: '/work/pending',
        createdAt: '2026-07-18T11:00:00Z', excludedSessionIds: ['old-session'],
        title: 'Pending title', layout: 'project', locator: pendingLocator,
    };
    const pendingWindowMetadata = {
        managed: '1', version: '2', layout: 'project', provider: 'kimi', pendingId: 'p1',
        workspaceScopeIdentity: 'pending-project', workspaceNavigationIdentity: 'nav-1',
        workspaceRootHostPaths: JSON.stringify(['/work/pending']), cwd: '/work/pending',
        createdAt: pendingBinding.createdAt, marker: '/tmp/p1.done',
    };
    const pendingDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [{
            ...pendingLocator, windowId: '@2', active: true,
            sessionMetadata: {
                managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'pending-project',
            },
            windowMetadata: pendingWindowMetadata,
            metadata: { workspaceScopeIdentity: 'pending-project', ...pendingWindowMetadata },
        }] },
        bindingStore: {
            listPending: async () => [pendingBinding], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
    });
    await pendingDiscovery.refresh();
    assert.deepStrictEqual(pendingDiscovery.getPending(), [{
        identity: pendingIdentity,
        backend: 'tmux', state: 'pending', markerPath: '/tmp/p1.done',
        runStartedAtMs: Date.parse(pendingBinding.createdAt), attached: false,
        tmux: pendingLocator, createdAt: pendingBinding.createdAt,
        excludedSessionIds: ['old-session'], title: 'Pending title',
    }]);
    assert.strictEqual(pendingDiscovery.find(pendingIdentity).length, 1);
    assert.strictEqual(pendingDiscovery.find({ ...pendingIdentity, cwd: '/other' }).length, 0);
    const pendingCopy = pendingDiscovery.getPending();
    pendingCopy[0].excludedSessionIds.push('mutated');
    assert.deepStrictEqual(pendingDiscovery.getPending()[0].excludedSessionIds, ['old-session']);

    const collisionIdentity = {
        provider: 'claude', workspaceScopeIdentity: 'collision-project', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'collision-session',
    };
    const collisionExpected = new tmuxLayout.ProjectTmuxLayout().getLocator(collisionIdentity);
    const collisionActual = {
        layout: 'project', sessionName: collisionExpected.sessionName,
        windowName: `${collisionExpected.windowName}-occupied`,
    };
    const collisionMetadata = {
        managed: '1', version: '2', layout: 'project', provider: 'claude',
        workspaceScopeIdentity: 'collision-project', workspaceNavigationIdentity: 'nav-1',
        workspaceRootHostPaths: JSON.stringify(['/work']), cwd: '/work',
        sessionId: 'collision-session', marker: '/tmp/collision.done',
    };
    const collisionKnown = {
        version: 2, state: 'known', provider: 'claude', sessionId: 'collision-session',
        workspaceScopeIdentity: 'collision-project', workspaceNavigationIdentity: 'nav-1',
        workspaceRootHostPaths: ['/work'], cwd: '/work', layout: 'project', locator: collisionExpected,
        lastSeenAtMs: 900,
    };
    const collisionSessionMetadata = {
        managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'collision-project',
    };
    const collisionReconciled = [];
    const collisionRemoved = [];
    let collisionListFailure = false;
    const collisionDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => {
            if (collisionListFailure) {
                throw new Error('collision refresh failed');
            }
            return [
            {
                ...collisionActual, windowId: '@3', active: true,
                sessionMetadata: collisionSessionMetadata,
                windowMetadata: collisionMetadata,
                metadata: { workspaceScopeIdentity: 'collision-project', ...collisionMetadata },
            },
            {
                ...collisionActual, windowId: '@3-duplicate', active: false,
                sessionMetadata: collisionSessionMetadata,
                windowMetadata: collisionMetadata,
                metadata: { workspaceScopeIdentity: 'collision-project', ...collisionMetadata },
            },
            {
                ...collisionExpected, windowId: '@4', active: true,
                sessionMetadata: collisionSessionMetadata,
                windowMetadata: collisionMetadata,
                metadata: {
                    managed: '1', version: '2', layout: 'project',
                    workspaceScopeIdentity: 'collision-project', provider: 'claude', sessionId: 'collision-session',
                },
            },
            {
                ...collisionExpected, windowId: '@5', active: true,
                sessionMetadata: {}, windowMetadata: {}, metadata: {},
            },
            ];
        } },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [collisionKnown],
            reconcileKnown: async runtimes => { collisionReconciled.push(runtimes); },
            removeKnown: async (...identity) => { collisionRemoved.push(identity); },
        },
        markerIsCurrent: () => false,
    });
    await collisionDiscovery.refresh();
    assert.deepStrictEqual(collisionDiscovery.getActive(), []);
    assert.deepStrictEqual(collisionDiscovery.getPending(), []);
    assert.deepStrictEqual(collisionDiscovery.find(collisionIdentity), []);
    assert.deepStrictEqual(collisionDiscovery.getInactive(), []);
    assert.deepStrictEqual(collisionReconciled, [[]]);
    assert.deepStrictEqual(collisionRemoved, []);
    assert.deepStrictEqual(collisionDiscovery.getDiagnostics(), [{
        kind: 'tmux-locator-collision', identity: collisionIdentity,
        actual: collisionActual, expected: collisionExpected,
    }]);
    const diagnosticCopy = collisionDiscovery.getDiagnostics();
    diagnosticCopy[0].identity.sessionId = 'mutated';
    diagnosticCopy[0].actual.sessionName = 'mutated';
    assert.deepStrictEqual(collisionDiscovery.getDiagnostics()[0], {
        kind: 'tmux-locator-collision', identity: collisionIdentity,
        actual: collisionActual, expected: collisionExpected,
    });
    const collisionSnapshot = discoveryModule.findTmuxCollisionRuntime(
        collisionDiscovery.getDiagnostics(), 'claude', 'collision-session',
        collisionIdentity.workspaceScopeIdentity
    );
    assert.strictEqual(collisionSnapshot.state, 'conflict');
    assert.strictEqual(collisionSnapshot.backend, 'tmux');
    assert.deepStrictEqual(collisionSnapshot.identity, collisionIdentity);
    assert.deepStrictEqual(collisionSnapshot.tmux, collisionExpected);
    const stableCollisionSnapshot = discoveryModule.findTmuxCollisionRuntime(
        collisionDiscovery.getDiagnostics(), 'claude', 'collision-session',
        collisionIdentity.workspaceScopeIdentity
    );
    collisionSnapshot.identity.sessionId = 'mutated';
    collisionSnapshot.tmux.sessionName = 'mutated';
    assert.deepStrictEqual(discoveryModule.findTmuxCollisionRuntime(
        collisionDiscovery.getDiagnostics(), 'claude', 'collision-session',
        collisionIdentity.workspaceScopeIdentity
    ), stableCollisionSnapshot, 'synthetic collision snapshots must be stable defensive copies');
    assert.strictEqual(discoveryModule.findTmuxCollisionRuntime(
        [{ ...collisionDiscovery.getDiagnostics()[0], identity: {
            ...collisionIdentity, workspaceScopeIdentity: 'other-scope',
        } }],
        'claude', 'collision-session', collisionIdentity.workspaceScopeIdentity
    ), null, 'collision lookup must not cross workspaceScopeIdentity');
    collisionListFailure = true;
    await assert.rejects(collisionDiscovery.refresh(true), /collision refresh failed/);
    assert.strictEqual(collisionDiscovery.getDiagnostics()[0].stale, true,
        'retained collision diagnostics must be marked stale after a failed refresh');
    assert.strictEqual(discoveryModule.findTmuxCollisionRuntime(
        collisionDiscovery.getDiagnostics(), 'claude', 'collision-session',
        collisionIdentity.workspaceScopeIdentity
    ).stale, true, 'synthetic collision runtimes must preserve diagnostic staleness');

    const pendingCollisionActual = {
        ...pendingLocator, windowName: `${pendingLocator.windowName}-occupied`,
    };
    const pendingCollisionReconciled = [];
    const pendingCollisionRemoved = [];
    const pendingCollisionDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [{
            ...pendingCollisionActual, windowId: '@pending-collision', active: false,
            sessionMetadata: {
                managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'pending-project',
            },
            windowMetadata: pendingWindowMetadata,
            metadata: { workspaceScopeIdentity: 'pending-project', ...pendingWindowMetadata },
        }] },
        bindingStore: {
            listPending: async () => [pendingBinding], listKnown: async () => [],
            reconcileKnown: async runtimes => { pendingCollisionReconciled.push(runtimes); },
            removeKnown: async (...identity) => { pendingCollisionRemoved.push(identity); },
        },
        markerIsCurrent: () => false,
    });
    await pendingCollisionDiscovery.refresh();
    assert.deepStrictEqual(pendingCollisionDiscovery.getPending(), []);
    assert.deepStrictEqual(pendingCollisionDiscovery.getInactive(), []);
    assert.deepStrictEqual(pendingCollisionReconciled, [[]]);
    assert.deepStrictEqual(pendingCollisionRemoved, []);
    assert.deepStrictEqual(pendingCollisionDiscovery.getDiagnostics(), [{
        kind: 'tmux-locator-collision',
        identity: pendingIdentity,
        actual: pendingCollisionActual,
        expected: pendingLocator,
    }]);

    const sessionIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'session-project', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'session-layout-id',
    };
    const sessionLocator = new tmuxLayout.SessionTmuxLayout().getLocator(sessionIdentity);
    const sessionMetadata = {
        managed: '1', version: '2', layout: 'session', workspaceScopeIdentity: 'session-project',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: JSON.stringify(['/work']), cwd: '/work',
        provider: 'codex', sessionId: 'session-layout-id', marker: '/tmp/session.done',
    };
    const sessionWindowMetadata = {
        managed: '1', version: '2', layout: 'session',
    };
    const sessionDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [
            {
                ...sessionLocator, windowName: 'ai-session', windowId: '@6', active: false,
                sessionMetadata, windowMetadata: sessionWindowMetadata,
                metadata: { ...sessionMetadata, ...sessionWindowMetadata },
            },
            {
                ...sessionLocator, windowName: 'ai-session', windowId: '@7', active: true,
                sessionMetadata, windowMetadata: sessionWindowMetadata,
                metadata: { ...sessionMetadata, ...sessionWindowMetadata },
            },
        ] },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
    });
    await sessionDiscovery.refresh();
    assert.strictEqual(sessionDiscovery.getActive().length, 1);
    assert.strictEqual(sessionDiscovery.getActive()[0].attached, false);
    assert.deepStrictEqual(sessionDiscovery.getActive()[0].tmux, sessionLocator,
        'legacy session-layout discovery must retain its locator without windowName');

    const readableProjectIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'readable-project',
        workspaceNavigationIdentity: 'nav-readable-project', workspaceRootHostPaths: ['/work/readable'],
        cwd: '/work/readable', sessionId: 'readable-project-session',
    };
    const readableSessionIdentity = {
        provider: 'claude', workspaceScopeIdentity: 'readable-session',
        workspaceNavigationIdentity: 'nav-readable-session', workspaceRootHostPaths: ['/work/readable-session'],
        cwd: '/work/readable-session', sessionId: 'readable-session-id',
    };
    const readableProjectLocator = tmuxNaming.buildReadableTmuxLocator(
        readableProjectIdentity, 'project', { projectName: 'RedDB', sessionName: 'Repair replication' }
    );
    const readableSessionLocator = tmuxNaming.buildReadableTmuxLocator(
        readableSessionIdentity, 'session', { projectName: 'RedDB', sessionName: 'Repair replication' }
    );
    const wrongReadableIdentity = {
        provider: 'kimi', workspaceScopeIdentity: 'wrong-readable',
        workspaceNavigationIdentity: 'nav-wrong-readable', workspaceRootHostPaths: ['/work/wrong-readable'],
        cwd: '/work/wrong-readable', sessionId: 'wrong-readable-session',
    };
    const wrongReadableExpected = new tmuxLayout.ProjectTmuxLayout().getLocator(wrongReadableIdentity);
    const wrongReadableBuilt = tmuxNaming.buildReadableTmuxLocator(
        wrongReadableIdentity, 'project', { projectName: 'RedDB', sessionName: 'Wrong suffix' }
    );
    const wrongReadableActual = {
        ...wrongReadableBuilt,
        windowName: wrongReadableBuilt.windowName.replace(/[0-9a-f]$/, value => value === '0' ? '1' : '0'),
    };
    const wrongReadableActualTwo = {
        ...wrongReadableBuilt,
        windowName: wrongReadableBuilt.windowName.replace(/[0-9a-f]$/, value =>
            value === 'f' ? 'e' : 'f'),
    };
    const wrongReadableSessionIdentity = {
        provider: 'claude', workspaceScopeIdentity: 'wrong-readable-session',
        workspaceNavigationIdentity: 'nav-wrong-readable-session',
        workspaceRootHostPaths: ['/work/wrong-readable-session'], cwd: '/work/wrong-readable-session',
        sessionId: 'wrong-readable-session-id',
    };
    const wrongReadableSessionExpected = new tmuxLayout.SessionTmuxLayout()
        .getLocator(wrongReadableSessionIdentity);
    const wrongReadableSessionBuilt = tmuxNaming.buildReadableTmuxLocator(
        wrongReadableSessionIdentity, 'session', { projectName: 'RedDB', sessionName: 'Wrong suffix' }
    );
    const wrongReadableSessionActual = {
        ...wrongReadableSessionBuilt,
        sessionName: wrongReadableSessionBuilt.sessionName.replace(
            /[0-9a-f]$/, value => value === '0' ? '1' : '0'
        ),
    };
    const duplicateReadableIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'duplicate-readable',
        workspaceNavigationIdentity: 'nav-duplicate-readable', workspaceRootHostPaths: ['/work/duplicate'],
        cwd: '/work/duplicate', sessionId: 'duplicate-readable-session',
    };
    const duplicateReadableLocators = [
        tmuxNaming.buildReadableTmuxLocator(duplicateReadableIdentity, 'project', {
            projectName: 'RedDB', sessionName: 'Repair replication',
        }),
        tmuxNaming.buildReadableTmuxLocator(duplicateReadableIdentity, 'project', {
            projectName: 'BlueDB', sessionName: 'Repair replication',
        }),
    ];
    const readableRow = (identity, locator, windowId) => {
        const full = {
            managed: '1', version: '2', layout: locator.layout,
            workspaceScopeIdentity: identity.workspaceScopeIdentity,
            workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
            workspaceRootHostPaths: JSON.stringify(identity.workspaceRootHostPaths), cwd: identity.cwd,
            provider: identity.provider, sessionId: identity.sessionId,
            createdAt: '2026-07-18T10:00:00Z',
        };
        const ownership = locator.layout === 'project'
            ? {
                managed: '1', version: '2', layout: 'project',
                workspaceScopeIdentity: identity.workspaceScopeIdentity,
            }
            : { managed: '1', version: '2', layout: 'session' };
        return {
            ...locator, windowId, active: false,
            sessionMetadata: locator.layout === 'project' ? ownership : full,
            windowMetadata: locator.layout === 'project' ? full : ownership,
            metadata: { ...ownership, ...full },
        };
    };
    const readableDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [
            finalRow,
            readableRow(sessionIdentity, { ...sessionLocator, windowName: 'ai-session' }, '@legacy-session'),
            readableRow(readableProjectIdentity, readableProjectLocator, '@readable-project'),
            readableRow(readableSessionIdentity, readableSessionLocator, '@readable-session'),
            readableRow(wrongReadableIdentity, wrongReadableActual, '@wrong-readable'),
            readableRow(wrongReadableIdentity, wrongReadableActualTwo, '@wrong-readable-two'),
            readableRow(wrongReadableSessionIdentity, wrongReadableSessionActual,
                '@wrong-readable-session'),
            ...duplicateReadableLocators.map((locator, index) =>
                readableRow(duplicateReadableIdentity, locator, `@duplicate-readable-${index}`)),
        ] },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
    });
    await readableDiscovery.refresh();
    assert.deepStrictEqual(
        readableDiscovery.getActive().map(runtime => runtime.tmux),
        [finalLocator, sessionLocator, readableProjectLocator, readableSessionLocator],
        'discovery must preserve legacy locators and exact readable project/session actual locators'
    );
    assert.deepStrictEqual(readableDiscovery.find(duplicateReadableIdentity), [],
        'multiple readable actual locators for one identity must fail closed');
    assert.deepStrictEqual(readableDiscovery.getDiagnostics().find(diagnostic =>
        diagnostic.identity.sessionId === wrongReadableIdentity.sessionId), {
        kind: 'tmux-locator-collision', identity: wrongReadableIdentity,
        actual: wrongReadableActual, expected: wrongReadableExpected,
    }, 'a readable locator with the wrong identity suffix must remain a collision diagnostic');
    assert.strictEqual(readableDiscovery.getDiagnostics().filter(diagnostic =>
        diagnostic.identity.sessionId === wrongReadableIdentity.sessionId).length, 1,
    'multiple wrong-suffix actual locators for one identity must produce one raw diagnostic');
    assert.deepStrictEqual(readableDiscovery.getDiagnostics().find(diagnostic =>
        diagnostic.identity.sessionId === wrongReadableSessionIdentity.sessionId), {
        kind: 'tmux-locator-collision', identity: wrongReadableSessionIdentity,
        actual: wrongReadableSessionActual, expected: wrongReadableSessionExpected,
    }, 'a readable session locator with a wrong suffix must remain a collision diagnostic');
    assert.deepStrictEqual(
        discoveryModule.getTmuxCollisionRuntimes(readableDiscovery.getDiagnostics())
            .filter(runtime => runtime.identity.sessionId === duplicateReadableIdentity.sessionId)
            .map(runtime => runtime.identity),
        [duplicateReadableIdentity],
        'multiple valid actual locators must produce one conflict identity'
    );

    const wrongScopeDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [
            {
                ...finalLocator, windowId: '@wrong-project-scope', active: false,
                sessionMetadata: { ...finalSessionMetadata, provider: 'claude' },
                windowMetadata: finalWindowMetadata,
                metadata: { ...finalSessionMetadata, ...finalWindowMetadata, provider: 'claude' },
            },
            {
                ...sessionLocator, windowName: 'shell', windowId: '@wrong-session-scope', active: false,
                sessionMetadata,
                windowMetadata: { ...sessionWindowMetadata, provider: 'codex' },
                metadata: { ...sessionMetadata, ...sessionWindowMetadata },
            },
            {
                ...sessionLocator, windowName: 'legacy', windowId: '@legacy-session-window', active: false,
                sessionMetadata,
                windowMetadata: { ...sessionWindowMetadata, projectKey: 'legacy-project' },
                metadata: { ...sessionMetadata, ...sessionWindowMetadata, projectKey: 'legacy-project' },
            },
        ] },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
    });
    await wrongScopeDiscovery.refresh(true);
    assert.strictEqual(wrongScopeDiscovery.getActive().length, 0);

    const mergedOnlyDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [{
            ...finalLocator, windowId: '@merged-only', active: true,
            metadata: { ...finalSessionMetadata, ...finalWindowMetadata },
        }] },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
    });
    await mergedOnlyDiscovery.refresh();
    assert.deepStrictEqual(mergedOnlyDiscovery.getActive(), []);

    const invalidProjectScopeDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [{
            ...finalLocator, windowId: '@invalid-project-scope', active: true,
            sessionMetadata: { workspaceScopeIdentity: 'pk' },
            windowMetadata: finalWindowMetadata,
            metadata: { ...finalSessionMetadata, ...finalWindowMetadata },
        }] },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
    });
    await invalidProjectScopeDiscovery.refresh();
    assert.deepStrictEqual(invalidProjectScopeDiscovery.getActive(), []);

    const disagreeingWindowMetadata = {
        ...sessionMetadata, sessionId: 'different-session-layout-id',
    };
    const disagreeingSessionDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [{
            ...sessionLocator, windowName: 'shell', windowId: '@disagreeing-session', active: true,
            sessionMetadata,
            windowMetadata: disagreeingWindowMetadata,
            metadata: { ...sessionMetadata, ...disagreeingWindowMetadata },
        }] },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async () => undefined,
        },
        markerIsCurrent: () => false,
    });
    await disagreeingSessionDiscovery.refresh();
    assert.deepStrictEqual(disagreeingSessionDiscovery.getActive(), []);

    const known = {
        version: 2, state: 'known', provider: 'codex', sessionId: 's1', workspaceScopeIdentity: 'pk',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
        layout: 'project', locator: finalLocator, lastSeenAtMs: 900,
    };

    const offlineExitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-offline-exit-'));
    try {
        const offlineRunStartedAtMs = Date.parse('2026-07-18T10:00:00Z');
        const offlineMarkerPath = '/tmp/offline-exit.done';
        const offlineStore = new runtimeStoreModule.TmuxRuntimeBindingStore(
            offlineExitRoot, () => now
        );
        await offlineStore.setKnown({
            ...known,
            cwd: '/work',
            markerPath: offlineMarkerPath,
            runStartedAtMs: offlineRunStartedAtMs,
        });
        const offlineMarkerChecks = [];
        const offlineExitDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
            client: { listWindows: async () => [] },
            bindingStore: offlineStore,
            markerIsCurrent: (markerPath, runStartedAtMs) => {
                offlineMarkerChecks.push([markerPath, runStartedAtMs]);
                return true;
            },
            nowMs: () => now,
        });
        await offlineExitDiscovery.refresh(true);
        assert.strictEqual(offlineExitDiscovery.getInactive()[0].state, 'completed',
            'a provider that exits while the extension host is offline must retain completion proof');
        assert.deepStrictEqual(offlineMarkerChecks, [[offlineMarkerPath, offlineRunStartedAtMs]]);
        assert.strictEqual(offlineExitDiscovery.getInactive()[0].identity.cwd, '/work');
    } finally {
        fs.rmSync(offlineExitRoot, { recursive: true, force: true });
    }

    const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-marker-proof-'));
    try {
        const markerPath = path.join(markerRoot, 'complete.marker');
        fs.writeFileSync(markerPath, '');
        const markerTimeMs = Date.now();
        fs.utimesSync(markerPath, new Date(markerTimeMs), new Date(markerTimeMs));
        assert.strictEqual(discoveryModule.isCurrentRuntimeMarker(markerPath, markerTimeMs - 1), true);
        assert.strictEqual(discoveryModule.isCurrentRuntimeMarker(markerPath, markerTimeMs + 10_000), false);
        assert.strictEqual(discoveryModule.isCurrentRuntimeMarker(markerPath, 0), false);
        assert.strictEqual(discoveryModule.isCurrentRuntimeMarker(markerPath, NaN), false);
        assert.strictEqual(discoveryModule.isCurrentRuntimeMarker('', markerTimeMs), false);
        assert.strictEqual(discoveryModule.isCurrentRuntimeMarker(path.join(markerRoot, 'missing'), markerTimeMs), false);
    } finally {
        fs.rmSync(markerRoot, { recursive: true, force: true });
    }
    const removedKnown = [];
    const markerChecks = [];
    let lifecycleRows = [finalRow];
    const lifecycleDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => lifecycleRows },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [known, known],
            reconcileKnown: async () => undefined,
            removeKnown: async (provider, sessionId) => { removedKnown.push([provider, sessionId]); },
        },
        markerIsCurrent: (markerPath, runStartedAtMs) => {
            markerChecks.push([markerPath, runStartedAtMs]);
            return true;
        },
    });
    await lifecycleDiscovery.refresh();
    lifecycleRows = [];
    await lifecycleDiscovery.refresh(true);
    assert.deepStrictEqual(lifecycleDiscovery.getActive(), []);
    assert.deepStrictEqual(lifecycleDiscovery.find(finalIdentity), []);
    assert.strictEqual(lifecycleDiscovery.getInactive()[0].state, 'completed');
    await lifecycleDiscovery.refresh(true);
    assert.strictEqual(lifecycleDiscovery.getInactive()[0].state, 'completed',
        'a completed inactive runtime must remain owned across consecutive refreshes');
    const inactiveCopy = lifecycleDiscovery.getInactive();
    inactiveCopy[0].identity.sessionId = 'mutated';
    inactiveCopy[0].tmux.sessionName = 'mutated';
    assert.strictEqual(lifecycleDiscovery.getInactive()[0].identity.sessionId, 's1');
    assert.strictEqual(lifecycleDiscovery.getInactive()[0].tmux.sessionName, finalLocator.sessionName);
    assert.deepStrictEqual(markerChecks, [[
        '/tmp/s1.done', Date.parse('2026-07-18T10:00:00Z'),
    ]]);
    assert.deepStrictEqual(removedKnown, [],
        'discovery must not remove persisted ownership before host acknowledgement');
    await lifecycleDiscovery.acknowledgeInactive(lifecycleDiscovery.getInactive()[0]);
    assert.deepStrictEqual(lifecycleDiscovery.getInactive(), []);
    assert.deepStrictEqual(removedKnown, [['codex', 's1']]);

    const acknowledgementEntered = deferred();
    const releaseAcknowledgement = deferred();
    let persistedAcknowledgementExpected;
    const mutationBinding = {
        version: 2, state: 'completed', provider: 'codex', sessionId: 'mutation-ack',
        workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', layout: 'project',
        locator: {
            layout: 'project', sessionName: 'project-pk', windowName: 'mutation-ack',
        },
        markerPath: '/tmp/mutation-ack.done', runStartedAtMs: 900, detectedAtMs: now,
    };
    const mutationAckDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [] },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            listInactive: async () => [mutationBinding],
            reconcileKnown: async () => undefined,
            acknowledgeInactive: async expected => {
                persistedAcknowledgementExpected = expected;
                acknowledgementEntered.resolve();
                await releaseAcknowledgement.promise;
                return 'acknowledged';
            },
        },
        markerIsCurrent: () => false,
    });
    await mutationAckDiscovery.loadPersistedInactive();
    const callerOwnedExpected = mutationAckDiscovery.getInactive()[0];
    const mutationAcknowledgement = mutationAckDiscovery.acknowledgeInactive(callerOwnedExpected);
    await acknowledgementEntered.promise;
    callerOwnedExpected.identity.provider = 'kimi';
    callerOwnedExpected.identity.sessionId = 'mutated-session';
    callerOwnedExpected.identity.workspaceScopeIdentity = 'mutated-project';
    callerOwnedExpected.identity.cwd = '/mutated';
    callerOwnedExpected.tmux.layout = 'session';
    callerOwnedExpected.tmux.sessionName = 'mutated-tmux';
    callerOwnedExpected.tmux.windowName = 'mutated-window';
    callerOwnedExpected.markerPath = '/tmp/mutated.done';
    callerOwnedExpected.runStartedAtMs = 901;
    callerOwnedExpected.detectedAtMs = now + 1;
    callerOwnedExpected.state = 'stopped';
    releaseAcknowledgement.resolve();
    assert.strictEqual(await mutationAcknowledgement, 'acknowledged');
    assert.deepStrictEqual(persistedAcknowledgementExpected, mutationBinding,
        'durable acknowledgement must receive the normalized pre-await run contract');
    assert.deepStrictEqual(mutationAckDiscovery.getInactive(), [],
        'caller mutation after invocation must not retain an acknowledged local blocker');

    const restartRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-inactive-restart-'));
    try {
        const restartStore = new runtimeStoreModule.TmuxRuntimeBindingStore(restartRoot, () => now);
        await restartStore.setKnown(known);
        let restartRows = [finalRow];
        const beforeRestart = new discoveryModule.TmuxRuntimeDiscovery({
            client: { listWindows: async () => restartRows },
            bindingStore: restartStore,
            markerIsCurrent: () => true,
            nowMs: () => now,
        });
        await beforeRestart.refresh(true);
        restartRows = [];
        await beforeRestart.refresh(true);
        assert.strictEqual(beforeRestart.getInactive()[0].state, 'completed');
        assert.strictEqual(await restartStore.getKnown('codex', 's1'), null,
            'persisted inactive records must not appear as known hints');

        const afterRestart = new discoveryModule.TmuxRuntimeDiscovery({
            client: { listWindows: async () => [] },
            bindingStore: new runtimeStoreModule.TmuxRuntimeBindingStore(restartRoot, () => now),
            markerIsCurrent: () => { throw new Error('restart must not reclassify persisted inactive'); },
            nowMs: () => now,
        });
        let unavailableProbeCalls = 0;
        const unavailableRestart = new discoveryModule.TmuxRuntimeDiscovery({
            client: { listWindows: async () => {
                unavailableProbeCalls++;
                throw fakeUnavailableError();
            } },
            bindingStore: new runtimeStoreModule.TmuxRuntimeBindingStore(restartRoot, () => now),
            markerIsCurrent: () => false,
            nowMs: () => now,
        });
        await unavailableRestart.loadPersistedInactive();
        assert.strictEqual(unavailableProbeCalls, 0,
            'inactive restart recovery must not probe tmux availability');
        assert.strictEqual(unavailableRestart.getInactive()[0].state, 'completed');
        await afterRestart.refresh(true);
        assert.strictEqual(afterRestart.getInactive()[0].state, 'completed',
            'a new discovery instance must restore completed inactive state from disk');

        const originalUnlink = fs.promises.unlink;
        fs.promises.unlink = async filePath => {
            if (path.dirname(String(filePath)) === restartRoot) {
                const error = new Error('/secret/discovery-ack-denied');
                error.code = 'EACCES';
                throw error;
            }
            return originalUnlink.call(fs.promises, filePath);
        };
        try {
            await assert.rejects(afterRestart.acknowledgeInactive(afterRestart.getInactive()[0]),
                error => error && error.code === 'EACCES');
        } finally {
            fs.promises.unlink = originalUnlink;
        }
        assert.strictEqual(afterRestart.getInactive()[0].state, 'completed',
            'failed durable acknowledgement must not delete discovery memory first');
        await afterRestart.acknowledgeInactive(afterRestart.getInactive()[0]);
        assert.deepStrictEqual(afterRestart.getInactive(), []);
    } finally {
        fs.rmSync(restartRoot, { recursive: true, force: true });
    }

    const discoveryAckRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-discovery-ack-cas-'));
    try {
        let discoveryAckQueue = Promise.resolve();
        const discoveryAckLock = operation => {
            const result = discoveryAckQueue.then(operation);
            discoveryAckQueue = result.then(() => undefined, () => undefined);
            return result;
        };
        const discoveryAckStoreA = new runtimeStoreModule.TmuxRuntimeBindingStore(
            discoveryAckRoot, () => now, discoveryAckLock
        );
        const discoveryAckStoreB = new runtimeStoreModule.TmuxRuntimeBindingStore(
            discoveryAckRoot, () => now, discoveryAckLock
        );
        const discoveryAckIdentity = {
            provider: 'codex', sessionId: 'discovery-ack-cas', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
        };
        const discoveryAckLocator = new tmuxLayout.ProjectTmuxLayout()
            .getLocator(discoveryAckIdentity);
        const oldDiscoveryAck = {
            version: 2, state: 'completed', ...discoveryAckIdentity, layout: 'project',
            locator: discoveryAckLocator, markerPath: '/tmp/discovery-ack-old.done',
            runStartedAtMs: 900, detectedAtMs: 990,
        };
        await discoveryAckStoreA.setInactive(oldDiscoveryAck);
        const discoveryAckA = new discoveryModule.TmuxRuntimeDiscovery({
            client: { listWindows: async () => [] }, bindingStore: discoveryAckStoreA,
            markerIsCurrent: () => false, nowMs: () => now,
        });
        const discoveryAckB = new discoveryModule.TmuxRuntimeDiscovery({
            client: { listWindows: async () => [] }, bindingStore: discoveryAckStoreB,
            markerIsCurrent: () => false, nowMs: () => now,
        });
        await Promise.all([
            discoveryAckA.loadPersistedInactive(), discoveryAckB.loadPersistedInactive(),
        ]);
        const lateOldExpected = discoveryAckB.getInactive()[0];
        assert.strictEqual(await discoveryAckA.acknowledgeInactive(
            discoveryAckA.getInactive()[0]
        ), 'acknowledged');
        const newDiscoveryAck = {
            ...oldDiscoveryAck, state: 'stopped', markerPath: '/tmp/discovery-ack-new.done',
            runStartedAtMs: 950, detectedAtMs: now,
        };
        await discoveryAckStoreA.setInactive(newDiscoveryAck);
        const otherScopeDiscoveryAck = {
            ...newDiscoveryAck,
            workspaceScopeIdentity: 'other-scope',
            workspaceNavigationIdentity: 'other-nav',
            markerPath: '/tmp/discovery-ack-other-scope.done',
            runStartedAtMs: 975,
            detectedAtMs: now + 1,
        };
        await discoveryAckStoreA.setInactive(otherScopeDiscoveryAck);
        assert.strictEqual(await discoveryAckB.acknowledgeInactive(lateOldExpected), 'stale',
            'a second discovery must not clear a newer run with its retained old snapshot');
        assert.deepStrictEqual(await discoveryAckStoreA.getInactive(
            'codex', 'discovery-ack-cas', discoveryAckIdentity.workspaceScopeIdentity
        ), newDiscoveryAck);
        assert.strictEqual(discoveryAckB.getInactive()[0].runStartedAtMs,
            newDiscoveryAck.runStartedAtMs,
            'a stale acknowledgement must reload and retain the current lifecycle blocker');
        assert.strictEqual(discoveryAckB.getInactive()[0].identity.workspaceScopeIdentity,
            discoveryAckIdentity.workspaceScopeIdentity,
            'stale acknowledgement reload must not cross workspaceScopeIdentity');
    } finally {
        fs.rmSync(discoveryAckRoot, { recursive: true, force: true });
    }

    const staleInactive = {
        identity: { ...finalIdentity }, backend: 'tmux', state: 'completed',
        markerPath: '/tmp/s1.done', runStartedAtMs: 900, attached: false,
        detectedAtMs: now,
        tmux: { ...finalLocator },
    };
    let persistedInactive = [{
        version: 2, state: 'completed', provider: 'codex', sessionId: 's1',
        workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', layout: 'project', locator: { ...finalLocator },
        markerPath: '/tmp/s1.done', runStartedAtMs: 900, detectedAtMs: now,
    }];
    let blockInactiveRead = false;
    const inactiveReadStarted = deferred();
    const releaseInactiveRead = deferred();
    const generationStore = {
        listPending: async () => [],
        listKnown: async () => [],
        listInactive: async () => {
            const captured = persistedInactive.map(record => ({ ...record, locator: { ...record.locator } }));
            if (blockInactiveRead) {
                inactiveReadStarted.resolve();
                await releaseInactiveRead.promise;
            }
            return captured;
        },
        reconcileKnown: async () => undefined,
        setInactive: async () => undefined,
        acknowledgeInactive: async () => { persistedInactive = []; return 'acknowledged'; },
    };
    const generationDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [] }, bindingStore: generationStore,
        markerIsCurrent: () => false, nowMs: () => now,
    });
    await generationDiscovery.refresh(true);
    assert.deepStrictEqual(generationDiscovery.getInactive(), [staleInactive]);
    blockInactiveRead = true;
    const staleRefresh = generationDiscovery.refresh(true);
    await inactiveReadStarted.promise;
    await generationDiscovery.acknowledgeInactive(generationDiscovery.getInactive()[0]);
    releaseInactiveRead.resolve();
    await staleRefresh;
    assert.deepStrictEqual(generationDiscovery.getInactive(), [],
        'a stale concurrent refresh generation must not resurrect acknowledged inactive state');

    const stoppedRemoved = [];
    let stoppedRows = [finalRow];
    const stoppedDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => stoppedRows },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [known],
            reconcileKnown: async () => undefined,
            removeKnown: async (provider, sessionId) => { stoppedRemoved.push([provider, sessionId]); },
        },
        markerIsCurrent: () => false,
    });
    await stoppedDiscovery.refresh();
    stoppedRows = [];
    await stoppedDiscovery.refresh(true);
    assert.deepStrictEqual(stoppedDiscovery.getActive(), []);
    assert.strictEqual(stoppedDiscovery.getInactive()[0].state, 'stopped');
    await stoppedDiscovery.refresh(true);
    assert.strictEqual(stoppedDiscovery.getInactive()[0].state, 'stopped',
        'a stopped inactive runtime must remain owned until lifecycle cleanup acknowledges it');
    assert.deepStrictEqual(stoppedRemoved, []);
    await stoppedDiscovery.acknowledgeInactive(stoppedDiscovery.getInactive()[0]);
    assert.deepStrictEqual(stoppedDiscovery.getInactive(), []);
    assert.deepStrictEqual(stoppedRemoved, [['codex', 's1']]);

    let failList = false;
    let failureReconciles = 0;
    let failureRemovals = 0;
    let failedLists = 0;
    const failureDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => {
            failedLists++;
            if (failList) throw new Error('ambiguous list failure');
            return [finalRow];
        } },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [known],
            reconcileKnown: async () => { failureReconciles++; },
            removeKnown: async () => { failureRemovals++; },
        },
        markerIsCurrent: () => true,
        nowMs: () => now,
        cacheTtlMs: 500,
    });
    await failureDiscovery.refresh();
    const beforeFailure = failureDiscovery.getActive();
    assert.strictEqual(beforeFailure[0].stale, undefined);
    failList = true;
    now += 501;
    await assert.rejects(failureDiscovery.refresh(), /ambiguous list failure/);
    assert.strictEqual(failureDiscovery.getActive()[0].stale, true,
        'a failed refresh must mark the retained last-successful runtime snapshot stale');
    assert.strictEqual(failureReconciles, 1);
    assert.strictEqual(failureRemovals, 0);
    await assert.rejects(failureDiscovery.refresh(), /ambiguous list failure/);
    assert.strictEqual(failedLists, 3);

    const listFailureMutations = [];
    const listFailureDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => { throw new Error('list failure before reads'); } },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [],
            reconcileKnown: async runtimes => { listFailureMutations.push(['reconcile', runtimes]); },
            removeKnown: async (...identity) => { listFailureMutations.push(['remove', identity]); },
        },
        markerIsCurrent: () => false,
    });
    await assert.rejects(listFailureDiscovery.refresh(), /list failure before reads/);
    assert.deepStrictEqual(listFailureMutations, []);

    const readFailureMutations = [];
    const readFailureDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [finalRow] },
        bindingStore: {
            listPending: async () => { throw new Error('binding read failure'); },
            listKnown: async () => [known],
            reconcileKnown: async runtimes => { readFailureMutations.push(['reconcile', runtimes]); },
            removeKnown: async (...identity) => { readFailureMutations.push(['remove', identity]); },
        },
        markerIsCurrent: () => false,
    });
    await assert.rejects(readFailureDiscovery.refresh(), /binding read failure/);
    assert.deepStrictEqual(readFailureMutations, []);

    let markerFailureRows = [finalRow];
    const markerFailureMutations = [];
    const markerFailureDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => markerFailureRows },
        bindingStore: {
            listPending: async () => [], listKnown: async () => [known],
            reconcileKnown: async runtimes => { markerFailureMutations.push(['reconcile', runtimes]); },
            removeKnown: async (...identity) => { markerFailureMutations.push(['remove', identity]); },
        },
        markerIsCurrent: () => { throw new Error('marker read failure'); },
    });
    await markerFailureDiscovery.refresh();
    const markerFailureActive = markerFailureDiscovery.getActive();
    const markerMutationsBeforeFailure = markerFailureMutations.slice();
    markerFailureRows = [];
    await assert.rejects(markerFailureDiscovery.refresh(true), /marker read failure/);
    assert.deepStrictEqual(markerFailureMutations, markerMutationsBeforeFailure);
    assert.deepStrictEqual(markerFailureDiscovery.getActive(), markerFailureActive.map(runtime => ({
        ...runtime, stale: true,
    })));
    assert.deepStrictEqual(markerFailureDiscovery.getInactive(), []);
}

async function runTmuxStoreChecks() {
    const now = Date.parse('2026-07-18T10:00:00Z');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-tmux-store-'));
    try {
        const store = new runtimeStoreModule.TmuxRuntimeBindingStore(root, () => now);
        const pending = (pendingId, createdAt, overrides = {}) => ({
            version: 2,
            state: 'pending',
            pendingId,
            provider: 'codex',
            workspaceScopeIdentity: 'pk',
            workspaceNavigationIdentity: 'nav-1',
            workspaceRootHostPaths: ['/work'],
            cwd: '/work',
            createdAt,
            excludedSessionIds: [],
            acceptedAtMs: Date.parse(createdAt),
            layout: 'project',
            locator: {
                layout: 'project',
                sessionName: 'project-steward-p-a',
                windowName: `pending-codex-${pendingId}`,
            },
            ...overrides,
        });
        const pendingIdentity = record => ({
            provider: record.provider,
            workspaceScopeIdentity: record.workspaceScopeIdentity,
            workspaceNavigationIdentity: record.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...record.workspaceRootHostPaths],
            cwd: record.cwd,
            pendingId: record.pendingId,
        });
        const known = (sessionId, lastSeenAtMs, overrides = {}) => ({
            version: 2,
            state: 'known',
            provider: 'codex',
            sessionId,
            workspaceScopeIdentity: 'pk',
            workspaceNavigationIdentity: 'nav-1',
            workspaceRootHostPaths: ['/work'],
            cwd: '/work',
            layout: 'project',
            locator: {
                layout: 'project',
                sessionName: 'project-steward-p-a',
                windowName: `ai-codex-${sessionId}`,
            },
            lastSeenAtMs,
            ...overrides,
        });
        const legacySessionPending = pending('legacy-session-locator', '2026-07-18T09:59:00Z', {
            layout: 'session',
            locator: { layout: 'session', sessionName: 'project-steward-pending-codex-legacy' },
        });
        const readableSessionPending = pending('readable-session-locator', '2026-07-18T09:59:01Z', {
            layout: 'session',
            locator: {
                layout: 'session', sessionName: 'ps-RedDB-Repair-replication-12345678',
                windowName: 'codex-Repair-replication-12345678',
            },
        });
        assert.deepStrictEqual(runtimeStoreModule.validateTmuxPendingRuntimeBinding(
            legacySessionPending, now
        ), legacySessionPending, 'runtime binding validation must retain legacy session locators');
        assert.deepStrictEqual(runtimeStoreModule.validateTmuxPendingRuntimeBinding(
            readableSessionPending, now
        ), readableSessionPending, 'runtime binding validation must retain session locator windowName');
        const namedPending = pending('named-project', '2026-07-18T09:59:02Z', {
            projectName: 'RedDB DTS Dual Active', title: 'Investigate lag',
        });
        assert.deepStrictEqual(runtimeStoreModule.validateTmuxPendingRuntimeBinding(
            namedPending, now
        ), namedPending, 'pending bindings must retain bounded creation-time project names');
        assert.strictEqual(runtimeStoreModule.validateTmuxPendingRuntimeBinding(
            { ...namedPending, projectName: 'p'.repeat(201) }, now
        ), null, 'pending project names must share the 200-character title bound');
        assert.strictEqual(runtimeStoreModule.validateTmuxPendingRuntimeBinding(
            { ...namedPending, projectName: 'bad\nproject' }, now
        ), null, 'pending project names must reject control characters');
        assert.notStrictEqual(runtimeStoreModule.validateTmuxPendingRuntimeBinding(
            pending('legacy-without-project-name', '2026-07-18T09:59:03Z'), now
        ), null, 'legacy pending records without projectName must remain valid');
        assert.strictEqual(runtimeStoreModule.validateTmuxPendingRuntimeBinding({
            ...legacySessionPending,
            locator: { ...legacySessionPending.locator, windowName: undefined },
        }, now), null, 'session locators must reject an explicit undefined windowName key');
        assert.strictEqual(runtimeStoreModule.validateTmuxPendingRuntimeBinding({
            ...readableSessionPending,
            locator: { ...readableSessionPending.locator, unexpected: true },
        }, now), null, 'session locators must reject keys outside both accepted families');
        await store.setPending(legacySessionPending);
        await store.setPending(readableSessionPending);
        assert.deepStrictEqual(await store.getPending(pendingIdentity(legacySessionPending)),
            legacySessionPending);
        assert.deepStrictEqual(await store.getPending(pendingIdentity(readableSessionPending)),
            readableSessionPending, 'runtime binding persistence must round-trip session windowName');
        await store.removePending(pendingIdentity(legacySessionPending));
        await store.removePending(pendingIdentity(readableSessionPending));
        const missingAcceptedAt = pending('missing-accepted', '2026-07-18T09:59:00Z');
        delete missingAcceptedAt.acceptedAtMs;
        assert.strictEqual(runtimeStoreModule.validateTmuxPendingRuntimeBinding(
            missingAcceptedAt, now
        ), null, 'v2 pending bindings must not synthesize a missing acceptedAtMs');
        await assert.rejects(store.setPending({
            ...pending('extra-pending-key', '2026-07-18T09:59:00Z'),
            projectKey: 'legacy-extra',
        }), /invalid or expired/, 'v2 pending bindings must reject extra legacy keys');
        const inactive = (sessionId, state, detectedAtMs, overrides = {}) => ({
            version: 2,
            state,
            provider: 'codex',
            sessionId,
            workspaceScopeIdentity: 'pk',
            workspaceNavigationIdentity: 'nav-1',
            workspaceRootHostPaths: ['/work'],
            cwd: '/work',
            layout: 'project',
            locator: {
                layout: 'project',
                sessionName: 'project-steward-p-a',
                windowName: `ai-codex-${sessionId}`,
            },
            markerPath: `/tmp/${sessionId}.done`,
            runStartedAtMs: now - 1000,
            detectedAtMs,
            ...overrides,
        });

        for (const [kind, validRecord, invalidRecords] of [
            ['known', known('strict-known', now), record => [
                { ...record, pendingId: 'also-pending' },
                { ...record, projectKey: 'legacy' },
                { ...record, unexpected: true },
                (() => { const value = { ...record }; delete value.lastSeenAtMs; return value; })(),
            ]],
            ['inactive', inactive('strict-inactive', 'completed', now), record => [
                { ...record, pendingId: 'also-pending' },
                { ...record, projectKey: 'legacy' },
                { ...record, unexpected: true },
                (() => { const value = { ...record }; delete value.detectedAtMs; return value; })(),
            ]],
        ]) {
            for (const [index, invalidRecord] of invalidRecords(validRecord).entries()) {
                const strictRoot = path.join(root, `${kind}-strict-${index}`);
                fs.mkdirSync(strictRoot);
                fs.writeFileSync(path.join(strictRoot, runtimeRecordFilename(validRecord)),
                    JSON.stringify(invalidRecord));
                const strictStore = new runtimeStoreModule.TmuxRuntimeBindingStore(strictRoot, () => now);
                const restored = kind === 'known'
                    ? await strictStore.getKnown('codex', validRecord.sessionId, 'pk')
                    : await strictStore.getInactive('codex', validRecord.sessionId, 'pk');
                assert.strictEqual(restored, null,
                    `v2 ${kind} bindings must reject both IDs, missing fields, legacy fields, and extras`);
            }
        }

        const inactiveRoot = path.join(root, 'inactive-lifecycle');
        const inactiveStore = new runtimeStoreModule.TmuxRuntimeBindingStore(inactiveRoot, () => now);
        const transitioningKnown = known('inactive-restart', now - 100);
        const completedInactive = inactive('inactive-restart', 'completed', now);
        await inactiveStore.setKnown(transitioningKnown);
        const lifecycleSlot = path.join(inactiveRoot, runtimeRecordFilename(transitioningKnown));
        assert.strictEqual(fs.existsSync(lifecycleSlot), true);
        assert.strictEqual(await inactiveStore.transitionKnownToInactive(
            completedInactive, transitioningKnown.lastSeenAtMs
        ), true);
        assert.deepStrictEqual(fs.readdirSync(inactiveRoot).filter(name => name.endsWith('.json')),
            [path.basename(lifecycleSlot)],
            'known-to-inactive conversion must atomically reuse one canonical final lifecycle slot');
        assert.strictEqual(await inactiveStore.getKnown('codex', 'inactive-restart'), null,
            'inactive final records must never be returned as duplicate-prevention known hints');
        assert.deepStrictEqual(await inactiveStore.listKnown(), []);
        assert.deepStrictEqual(await inactiveStore.listInactive(), [completedInactive]);
        const restartedInactiveStore = new runtimeStoreModule.TmuxRuntimeBindingStore(inactiveRoot, () => now);
        assert.deepStrictEqual(await restartedInactiveStore.listInactive(), [completedInactive],
            'completed inactive lifecycle state must survive extension-host restart');

        const staleTransitionStore = new runtimeStoreModule.TmuxRuntimeBindingStore(
            path.join(root, 'stale-inactive-transition'), () => now
        );
        const staleKnown = known('stale-transition', now - 200);
        const refreshedKnown = known('stale-transition', now - 50);
        await staleTransitionStore.setKnown(staleKnown);
        await staleTransitionStore.setKnown(refreshedKnown);
        assert.strictEqual(await staleTransitionStore.transitionKnownToInactive(
            inactive('stale-transition', 'stopped', now), staleKnown.lastSeenAtMs
        ), false, 'a stale disappearance must not overwrite a concurrently refreshed known record');
        assert.deepStrictEqual(await staleTransitionStore.getKnown('codex', 'stale-transition'),
            refreshedKnown);

        const guardedInactiveStore = new runtimeStoreModule.TmuxRuntimeBindingStore(
            path.join(root, 'guarded-set-inactive'), () => now
        );
        const guardedKnown = known('guarded-inactive', now);
        await guardedInactiveStore.setKnown(guardedKnown);
        await guardedInactiveStore.setInactive(inactive(
            'guarded-inactive', 'completed', now
        ));
        assert.deepStrictEqual(await guardedInactiveStore.getKnown('codex', 'guarded-inactive'),
            guardedKnown, 'setInactive must never overwrite a canonical known record');

        const idempotentStopped = inactive('idempotent-inactive', 'stopped', now - 10);
        await guardedInactiveStore.setInactive(idempotentStopped);
        const promotedCompleted = inactive('idempotent-inactive', 'completed', now, {
            runStartedAtMs: idempotentStopped.runStartedAtMs,
        });
        await guardedInactiveStore.setInactive(promotedCompleted);
        await guardedInactiveStore.setInactive(inactive('idempotent-inactive', 'stopped', now, {
            runStartedAtMs: idempotentStopped.runStartedAtMs,
        }));
        await guardedInactiveStore.setInactive(inactive('idempotent-inactive', 'completed', now, {
            runStartedAtMs: idempotentStopped.runStartedAtMs + 1,
        }));
        assert.deepStrictEqual(await guardedInactiveStore.getInactive('codex', 'idempotent-inactive'),
            promotedCompleted,
        'inactive updates may promote the same run to completed but never downgrade or replace its run');

        const acknowledgementCasRoot = path.join(root, 'inactive-ack-cas');
        const acknowledgementCasRecords = path.join(acknowledgementCasRoot, 'records');
        let acknowledgementCasQueue = Promise.resolve();
        const acknowledgementCasLock = operation => {
            const result = acknowledgementCasQueue.then(operation);
            acknowledgementCasQueue = result.then(() => undefined, () => undefined);
            return result;
        };
        const acknowledgementCasA = new runtimeStoreModule.TmuxRuntimeBindingStore(
            acknowledgementCasRecords, () => now, acknowledgementCasLock
        );
        const acknowledgementCasB = new runtimeStoreModule.TmuxRuntimeBindingStore(
            acknowledgementCasRecords, () => now, acknowledgementCasLock
        );
        const oldAcknowledgement = inactive('ack-cas', 'completed', now - 10, {
            runStartedAtMs: now - 1000,
        });
        await acknowledgementCasA.setInactive(oldAcknowledgement);
        assert.strictEqual(await acknowledgementCasA.acknowledgeInactive(oldAcknowledgement),
            'acknowledged');
        const newAcknowledgement = inactive('ack-cas', 'stopped', now, {
            runStartedAtMs: now - 500,
            markerPath: '/tmp/ack-cas-new.done',
        });
        await acknowledgementCasB.setInactive(newAcknowledgement);
        assert.strictEqual(await acknowledgementCasA.acknowledgeInactive(oldAcknowledgement),
            'stale', 'a late old-run acknowledgement must not delete a newer inactive run');
        assert.deepStrictEqual(await acknowledgementCasB.getInactive('codex', 'ack-cas'),
            newAcknowledgement);
        const locatorMismatch = {
            ...newAcknowledgement,
            locator: { ...newAcknowledgement.locator, windowName: 'different-window' },
        };
        assert.strictEqual(await acknowledgementCasA.acknowledgeInactive(locatorMismatch), 'stale');
        assert.deepStrictEqual(await acknowledgementCasB.getInactive('codex', 'ack-cas'),
            newAcknowledgement, 'field and locator mismatches must not delete current lifecycle state');
        assert.strictEqual(await acknowledgementCasB.acknowledgeInactive(newAcknowledgement),
            'acknowledged');
        assert.strictEqual(await acknowledgementCasA.acknowledgeInactive(newAcknowledgement),
            'missing', 'same-run duplicate acknowledgement is idempotent');

        const missingStateKnownRoot = path.join(root, 'v2-known-no-discriminator');
        fs.mkdirSync(missingStateKnownRoot);
        const normalizedKnown = known('missing-state-known', now - 100);
        const missingStateKnown = { ...normalizedKnown };
        delete missingStateKnown.state;
        fs.writeFileSync(path.join(missingStateKnownRoot, runtimeRecordFilename(normalizedKnown)),
            JSON.stringify(missingStateKnown));
        const missingStateKnownStore = new runtimeStoreModule.TmuxRuntimeBindingStore(
            missingStateKnownRoot, () => now
        );
        assert.strictEqual(await missingStateKnownStore.getKnown(
            'codex', 'missing-state-known', normalizedKnown.workspaceScopeIdentity
        ), null, 'v2 final records without the exact known-state discriminator are ignored');

        const crossHostRoot = path.join(root, 'cross-host-final-records');
        const crossHostRecords = path.join(crossHostRoot, 'records');
        const sharedFinalLock = operation => creationLock.withTmuxCreationLock(
            crossHostRoot, 'runtime-binding-final-records', operation
        );
        let blockNextTransitionOperation = false;
        const transitionLockEntered = deferred();
        const releaseTransitionLock = deferred();
        const controlledTransitionLock = operation => sharedFinalLock(async () => {
            if (blockNextTransitionOperation) {
                blockNextTransitionOperation = false;
                transitionLockEntered.resolve();
                await releaseTransitionLock.promise;
            }
            return operation();
        });
        let blockNextReconcileOperation = false;
        const reconcileLockEntered = deferred();
        const releaseReconcileLock = deferred();
        const controlledReconcileLock = operation => sharedFinalLock(async () => {
            if (blockNextReconcileOperation) {
                blockNextReconcileOperation = false;
                reconcileLockEntered.resolve();
                await releaseReconcileLock.promise;
            }
            return operation();
        });
        const crossHostA = new runtimeStoreModule.TmuxRuntimeBindingStore(
            crossHostRecords, () => now, controlledTransitionLock
        );
        const crossHostB = new runtimeStoreModule.TmuxRuntimeBindingStore(
            crossHostRecords, () => now, controlledReconcileLock
        );
        const crossOld = known('cross-host', now - 200);
        const crossNew = known('cross-host', now);
        const crossRuntime = {
            identity: {
                provider: 'codex', sessionId: 'cross-host', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
            },
            backend: 'tmux', state: 'active', markerPath: '/tmp/cross-host.done',
            runStartedAtMs: now - 1000, attached: false, tmux: { ...crossNew.locator },
        };
        await crossHostA.setKnown(crossOld);
        blockNextTransitionOperation = true;
        const transitionOperation = crossHostA.transitionKnownToInactive(
            inactive('cross-host', 'stopped', now), crossOld.lastSeenAtMs
        );
        await transitionLockEntered.promise;
        const reconcileAfterTransition = crossHostB.reconcileKnown([crossRuntime]);
        releaseTransitionLock.resolve();
        await Promise.all([transitionOperation, reconcileAfterTransition]);
        assert.strictEqual((await crossHostA.getInactive('codex', 'cross-host')).state, 'stopped',
            'a later cross-host reconcile must not overwrite an inactive transition');

        await crossHostA.acknowledgeInactive(
            await crossHostA.getInactive('codex', 'cross-host')
        );
        await crossHostA.setKnown(crossOld);
        blockNextReconcileOperation = true;
        const reconcileBeforeStaleTransition = crossHostB.reconcileKnown([crossRuntime]);
        await reconcileLockEntered.promise;
        const staleTransitionOperation = crossHostA.transitionKnownToInactive(
            inactive('cross-host', 'stopped', now), crossOld.lastSeenAtMs
        );
        releaseReconcileLock.resolve();
        const [_, staleCrossTransition] = await Promise.all([
            reconcileBeforeStaleTransition,
            staleTransitionOperation,
        ]);
        assert.strictEqual(staleCrossTransition, false);
        assert.deepStrictEqual(await crossHostA.getKnown('codex', 'cross-host'), {
            ...crossNew,
            cwd: crossRuntime.identity.cwd,
            markerPath: crossRuntime.markerPath,
            runStartedAtMs: crossRuntime.runStartedAtMs,
        },
            'a stale cross-host transition must not overwrite a newer reconcile');

        const ackRaceRoot = path.join(crossHostRoot, 'ack-records');
        let blockNextAckOperation = false;
        const ackLockEntered = deferred();
        const releaseAckLock = deferred();
        const controlledAckLock = operation => sharedFinalLock(async () => {
            if (blockNextAckOperation) {
                blockNextAckOperation = false;
                ackLockEntered.resolve();
                await releaseAckLock.promise;
            }
            return operation();
        });
        const ackRaceA = new runtimeStoreModule.TmuxRuntimeBindingStore(
            ackRaceRoot, () => now, controlledAckLock
        );
        const ackRaceB = new runtimeStoreModule.TmuxRuntimeBindingStore(
            ackRaceRoot, () => now, sharedFinalLock
        );
        await ackRaceA.setInactive(inactive('cross-ack', 'completed', now));
        const rewrittenAfterAck = known('cross-ack', now);
        const ackExpected = await ackRaceA.getInactive('codex', 'cross-ack');
        blockNextAckOperation = true;
        const ackOperation = ackRaceA.acknowledgeInactive(ackExpected);
        await ackLockEntered.promise;
        const rewriteOperation = ackRaceB.setKnown(rewrittenAfterAck);
        releaseAckLock.resolve();
        await Promise.all([ackOperation, rewriteOperation]);
        assert.deepStrictEqual(await ackRaceA.getKnown('codex', 'cross-ack'), rewrittenAfterAck,
            'cross-host acknowledgement must not delete a known record rewritten after it');

        const crossPruneRoot = path.join(crossHostRoot, 'prune-records');
        fs.mkdirSync(crossPruneRoot);
        const pruneTarget = known('cross-prune-target', now - 100_000);
        fs.writeFileSync(path.join(crossPruneRoot, runtimeRecordFilename(pruneTarget)),
            JSON.stringify(pruneTarget));
        for (let index = 0; index < 512; index++) {
            const row = known(`cross-prune-${index}`, now - index);
            fs.writeFileSync(path.join(crossPruneRoot, runtimeRecordFilename(row)), JSON.stringify(row));
        }
        const crossPruneA = new runtimeStoreModule.TmuxRuntimeBindingStore(
            crossPruneRoot, () => now, sharedFinalLock
        );
        const crossPruneB = new runtimeStoreModule.TmuxRuntimeBindingStore(
            crossPruneRoot, () => now, sharedFinalLock
        );
        const refreshedPruneTarget = known('cross-prune-target', now);
        await Promise.all([
            crossPruneB.setKnown(refreshedPruneTarget),
            crossPruneA.listKnown(),
        ]);
        assert.deepStrictEqual(await crossPruneA.getKnown('codex', 'cross-prune-target'),
            refreshedPruneTarget, 'cross-host pruning must not delete a concurrently refreshed known record');

        const originalUnlink = fs.promises.unlink;
        fs.promises.unlink = async filePath => {
            if (path.resolve(String(filePath)) === path.resolve(lifecycleSlot)) {
                const error = new Error('/secret/inactive-ack-denied');
                error.code = 'EACCES';
                throw error;
            }
            return originalUnlink.call(fs.promises, filePath);
        };
        try {
            await assert.rejects(
                restartedInactiveStore.acknowledgeInactive(completedInactive),
                error => error && error.code === 'EACCES'
            );
        } finally {
            fs.promises.unlink = originalUnlink;
        }
        assert.deepStrictEqual(await restartedInactiveStore.listInactive(), [completedInactive],
            'failed acknowledgement persistence must retain inactive lifecycle ownership');
        await restartedInactiveStore.acknowledgeInactive(completedInactive);
        await restartedInactiveStore.acknowledgeInactive(completedInactive);
        assert.deepStrictEqual(await restartedInactiveStore.listInactive(), [],
            'inactive acknowledgement must be idempotent');

        const inactiveCapRoot = path.join(root, 'inactive-cap');
        fs.mkdirSync(inactiveCapRoot);
        const completedPriority = inactive('priority-completed', 'completed', now - 10_000);
        fs.writeFileSync(path.join(inactiveCapRoot, runtimeRecordFilename(completedPriority)),
            JSON.stringify(completedPriority));
        for (let index = 0; index < 512; index++) {
            const stopped = inactive(`cap-stopped-${index}`, 'stopped', now - index);
            fs.writeFileSync(path.join(inactiveCapRoot, runtimeRecordFilename(stopped)), JSON.stringify(stopped));
        }
        const inactiveCapStore = new runtimeStoreModule.TmuxRuntimeBindingStore(inactiveCapRoot, () => now);
        const cappedInactive = await inactiveCapStore.listInactive();
        assert.strictEqual(cappedInactive.length, 512);
        assert.strictEqual(cappedInactive.some(record => record.sessionId === 'priority-completed'), true,
            'deterministic cap pruning must retain completed records before newer stopped records');
        assert.strictEqual(cappedInactive.some(record => record.sessionId === 'cap-stopped-511'), false);

        const mixedCapRoot = path.join(root, 'mixed-final-cap');
        fs.mkdirSync(mixedCapRoot);
        for (let index = 0; index < 512; index++) {
            const completed = inactive(`mixed-completed-${index}`, 'completed', now - index);
            fs.writeFileSync(path.join(mixedCapRoot, runtimeRecordFilename(completed)), JSON.stringify(completed));
        }
        const liveKnown = known('mixed-live-known', now);
        fs.writeFileSync(path.join(mixedCapRoot, runtimeRecordFilename(liveKnown)), JSON.stringify(liveKnown));
        const mixedCapStore = new runtimeStoreModule.TmuxRuntimeBindingStore(mixedCapRoot, () => now);
        assert.deepStrictEqual(await mixedCapStore.listKnown(), [liveKnown],
            'inactive lifecycle history must never consume the live-known retention budget');
        assert.strictEqual((await mixedCapStore.listInactive()).length, 512,
            'known and inactive records must use independent bounded retention budgets');
        const expiredInactiveStore = new runtimeStoreModule.TmuxRuntimeBindingStore(
            inactiveCapRoot, () => now + (30 * 24 * 60 * 60 * 1000)
        );
        assert.deepStrictEqual(await expiredInactiveStore.listInactive(), [],
            'inactive lifecycle records expire at the 30-day boundary');
        await assert.rejects(inactiveStore.setInactive(inactive('bad-run', 'completed', now, {
            runStartedAtMs: 0,
        })), /inactive tmux binding is invalid/);

        assert.strictEqual(
            runtimeStoreModule.validateTmuxPendingRuntimeBinding(
                pending('validated', '2026-07-18T09:59:00Z'), now
            ).pendingId,
            'validated'
        );
        assert.strictEqual(runtimeStoreModule.validateTmuxPendingRuntimeBinding(
            pending('expired-validation', '2026-07-17T09:59:59Z'), now
        ), null);
        assert.strictEqual(runtimeStoreModule.validateTmuxPendingRuntimeBinding(
            pending('invalid-validation', '2026-07-18T09:59:00Z', {
                excludedSessionIds: Array.from({ length: 1001 }, (_, index) => `s${index}`),
            }), now
        ), null);
        assert.strictEqual(runtimeStoreModule.validateTmuxPendingRuntimeBinding(
            pending('future-validation', '2026-07-18T10:05:01Z'), now
        ), null);

        const ambiguousIdentity = {
            provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'ambiguous-session',
        };
        const ambiguousRecord = {
            version: 2,
            state: 'ambiguous',
            provider: 'codex',
            workspaceScopeIdentity: 'pk',
            workspaceNavigationIdentity: 'nav-1',
            workspaceRootHostPaths: ['/work'],
            cwd: '/work',
            sessionId: 'ambiguous-session',
            layout: 'session',
            locator: {
                layout: 'session', sessionName: 'project-steward-s-codex-ambiguous',
            },
            acceptedAtMs: now,
        };
        await store.setAmbiguous(ambiguousRecord);
        assert.deepStrictEqual(await store.getAmbiguous(ambiguousIdentity), ambiguousRecord);
        assert.ok(fs.readdirSync(root).every(name => !name.includes('ambiguous-session')));
        const restartedStore = new runtimeStoreModule.TmuxRuntimeBindingStore(root, () => now);
        assert.deepStrictEqual(await restartedStore.getAmbiguous(ambiguousIdentity), ambiguousRecord);
        await restartedStore.removeAmbiguous(ambiguousIdentity);
        assert.strictEqual(await store.getAmbiguous(ambiguousIdentity), null);
        await assert.rejects(store.setAmbiguous({ ...ambiguousRecord, workspaceScopeIdentity: '' }),
            /ambiguous tmux binding is invalid/);
        assert.strictEqual(await store.getAmbiguous(ambiguousIdentity), null);

        const pendingAmbiguousRecord = {
            version: 2,
            state: 'ambiguous',
            provider: 'kimi',
            workspaceScopeIdentity: 'pending-ambiguous-project',
            workspaceNavigationIdentity: 'nav-1',
            workspaceRootHostPaths: ['/pending-ambiguous'],
            pendingId: 'global-ambiguous-pending',
            cwd: '/pending-ambiguous',
            createdAt: '2026-07-18T09:59:00Z',
            excludedSessionIds: ['old'],
            projectName: 'RedDB DTS Dual Active',
            title: 'Pending ambiguous',
            markerPath: '/tmp/pending-ambiguous',
            requestFingerprint: 'b'.repeat(64),
            layout: 'session',
            locator: { layout: 'session', sessionName: 'project-steward-s-kimi-pending-ambiguous' },
            acceptedAtMs: now,
        };
        await store.setAmbiguous(pendingAmbiguousRecord);
        assert.deepStrictEqual(await restartedStore.getAmbiguous(pendingIdentity(pendingAmbiguousRecord)),
            pendingAmbiguousRecord);
        await assert.rejects(store.setAmbiguous({
            ...pendingAmbiguousRecord, pendingId: 'oversized-project-name',
            projectName: 'p'.repeat(201),
        }), /ambiguous tmux binding is invalid/);
        await assert.rejects(store.setAmbiguous({
            ...pendingAmbiguousRecord, pendingId: 'controlled-project-name',
            projectName: 'bad\nproject',
        }), /ambiguous tmux binding is invalid/);
        const legacyPendingAmbiguousRecord = { ...pendingAmbiguousRecord };
        delete legacyPendingAmbiguousRecord.projectName;
        legacyPendingAmbiguousRecord.pendingId = 'legacy-ambiguous-without-project-name';
        await store.setAmbiguous(legacyPendingAmbiguousRecord);
        assert.deepStrictEqual(await restartedStore.getAmbiguous(
            pendingIdentity(legacyPendingAmbiguousRecord)
        ), legacyPendingAmbiguousRecord,
        'legacy pending ambiguity records without projectName must remain valid');
        await store.removeAmbiguous(pendingIdentity(legacyPendingAmbiguousRecord));
        const conflictingPendingAmbiguous = {
            ...pendingAmbiguousRecord,
            provider: 'claude',
            workspaceScopeIdentity: 'other-pending-ambiguous-project',
            workspaceRootHostPaths: ['/other-pending-ambiguous'],
            cwd: '/other-pending-ambiguous',
            locator: { layout: 'session', sessionName: 'project-steward-s-claude-pending-ambiguous' },
        };
        await store.setAmbiguous(conflictingPendingAmbiguous);
        assert.deepStrictEqual(await restartedStore.getAmbiguous(
            pendingIdentity(conflictingPendingAmbiguous)
        ), conflictingPendingAmbiguous);
        await store.removeAmbiguous({
            provider: pendingAmbiguousRecord.provider,
            workspaceScopeIdentity: pendingAmbiguousRecord.workspaceScopeIdentity,
            workspaceNavigationIdentity: pendingAmbiguousRecord.workspaceNavigationIdentity,
            workspaceRootHostPaths: pendingAmbiguousRecord.workspaceRootHostPaths,
            cwd: pendingAmbiguousRecord.cwd,
            pendingId: pendingAmbiguousRecord.pendingId,
        });
        await store.removeAmbiguous({
            provider: conflictingPendingAmbiguous.provider,
            workspaceScopeIdentity: conflictingPendingAmbiguous.workspaceScopeIdentity,
            workspaceNavigationIdentity: conflictingPendingAmbiguous.workspaceNavigationIdentity,
            workspaceRootHostPaths: conflictingPendingAmbiguous.workspaceRootHostPaths,
            cwd: conflictingPendingAmbiguous.cwd,
            pendingId: conflictingPendingAmbiguous.pendingId,
        });

        await store.setPending(pending('p-new', '2026-07-18T09:59:00Z'));
        await store.setPending(pending('p-old', '2026-07-18T09:58:00Z'));
        assert.deepStrictEqual((await store.listPending()).map(record => record.pendingId), ['p-old', 'p-new']);
        assert.strictEqual((await store.getPending(pendingIdentity(
            pending('p-new', '2026-07-18T09:59:00Z')
        ))).pendingId, 'p-new');
        const sameScopeRoot = path.join(root, 'same-scope-pending-snapshots');
        const sameScopeStore = new runtimeStoreModule.TmuxRuntimeBindingStore(sameScopeRoot, () => now);
        const sameScopePendingA = pending('same-scope-pending', '2026-07-18T09:59:00Z', {
            workspaceNavigationIdentity: 'nav:a',
            workspaceRootHostPaths: ['/work/a'],
            cwd: '/work/a',
            locator: { layout: 'session', sessionName: 'pending-a' },
            layout: 'session',
        });
        const sameScopePendingB = pending('same-scope-pending', '2026-07-18T09:59:01Z', {
            workspaceNavigationIdentity: 'nav:b',
            workspaceRootHostPaths: ['/work/b'],
            cwd: '/work/b',
            locator: { layout: 'session', sessionName: 'pending-b' },
            layout: 'session',
        });
        await sameScopeStore.setPending(sameScopePendingA);
        await sameScopeStore.setPending(sameScopePendingB);
        assert.strictEqual((await sameScopeStore.listPending()).length, 2,
            'same provider/scope/pending ID with different immutable snapshots must not overwrite');
        assert.deepStrictEqual(await sameScopeStore.getPending(pendingIdentity(sameScopePendingA)),
            sameScopePendingA);
        assert.deepStrictEqual(await sameScopeStore.getPending(pendingIdentity(sameScopePendingB)),
            sameScopePendingB);
        await sameScopeStore.removePending(pendingIdentity(sameScopePendingA));
        assert.deepStrictEqual(await sameScopeStore.listPending(), [sameScopePendingB],
            'removing one immutable pending identity must retain the other');
        await assert.rejects(store.setPending(pending('future-created-persisted', '2026-07-18T10:05:01Z', {
            acceptedAtMs: now,
        })), /invalid or expired/);
        await assert.rejects(store.setPending(pending('future-accepted-persisted', '2026-07-18T09:59:00Z', {
            acceptedAtMs: now + (5 * 60 * 1000) + 1,
        })), /invalid or expired/);

        const futureDiskRoot = path.join(root, 'future-disk');
        fs.mkdirSync(futureDiskRoot);
        const futureCreatedDisk = pending('future-created-disk', '2026-07-18T10:05:01Z', { acceptedAtMs: now });
        const futureAcceptedDisk = pending('future-accepted-disk', '2026-07-18T09:59:00Z', {
            acceptedAtMs: now + (5 * 60 * 1000) + 1,
        });
        const validDisk = pending('valid-disk', '2026-07-18T09:59:00Z', { acceptedAtMs: now });
        for (const diskRecord of [futureCreatedDisk, futureAcceptedDisk, validDisk]) {
            fs.writeFileSync(path.join(futureDiskRoot, runtimeRecordFilename(diskRecord)),
                JSON.stringify(diskRecord));
        }
        const futureDiskStore = new runtimeStoreModule.TmuxRuntimeBindingStore(futureDiskRoot, () => now);
        assert.deepStrictEqual((await futureDiskStore.listPending()).map(record => record.pendingId), ['valid-disk']);
        assert.strictEqual(await futureDiskStore.getPending(pendingIdentity(futureCreatedDisk)), null);
        assert.strictEqual(await futureDiskStore.getPending(pendingIdentity(futureAcceptedDisk)), null);

        const nonFiniteRoot = path.join(root, 'non-finite-clock');
        const finiteClockStore = new runtimeStoreModule.TmuxRuntimeBindingStore(nonFiniteRoot, () => now);
        await finiteClockStore.setPending(pending('non-finite-clock', '2026-07-18T09:59:00Z', {
            acceptedAtMs: now,
        }));
        const nonFiniteClockStore = new runtimeStoreModule.TmuxRuntimeBindingStore(nonFiniteRoot, () => NaN);
        assert.deepStrictEqual(await nonFiniteClockStore.listPending(), []);
        assert.strictEqual(await nonFiniteClockStore.getPending(pendingIdentity(
            pending('non-finite-clock', '2026-07-18T09:59:00Z')
        )), null);
        const acceptedBeforeExpiry = pending('accepted-before-expiry', '2026-07-17T10:00:01Z', {
            acceptedAtMs: now,
        });
        assert.strictEqual(await store.setPending(acceptedBeforeExpiry), true);
        assert.ok((await store.listPending()).some(record => record.pendingId === 'accepted-before-expiry'));
        await store.removePending(pendingIdentity(acceptedBeforeExpiry));
        assert.ok(fs.readdirSync(root).every(name => !name.includes('p-old') && !name.includes('p-new')));

        fs.writeFileSync(path.join(root, 'bad.json'), '{bad');
        fs.writeFileSync(path.join(root, 'unsupported.json'), JSON.stringify({ version: 99 }));
        fs.writeFileSync(path.join(root, 'oversize.json'), ' '.repeat(1024 * 1024 + 1));
        fs.symlinkSync('/etc/passwd', path.join(root, 'ignored.json'));
        fs.mkdirSync(path.join(root, 'directory.json'));
        assert.deepStrictEqual((await store.listPending()).map(record => record.pendingId), ['p-old', 'p-new']);

        await assert.rejects(store.setPending(pending('expired', '2026-07-17T09:59:59Z')),
            /invalid or expired/);
        await assert.rejects(store.setPending(pending('expired-at-boundary', '2026-07-17T10:00:00Z')),
            /invalid or expired/);
        await assert.rejects(store.setPending(pending('too-many-exclusions', '2026-07-18T09:59:30Z', {
            excludedSessionIds: Array.from({ length: 1001 }, (_, index) => `s${index}`),
        })), /invalid or expired/);
        assert.deepStrictEqual((await store.listPending()).map(record => record.pendingId), ['p-old', 'p-new']);

        const consumedIdentity = { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'p-used' };
        const consumedRecord = {
            version: 2,
            state: 'consumed',
            provider: 'codex',
            workspaceScopeIdentity: 'pk',
            workspaceNavigationIdentity: 'nav-1',
            workspaceRootHostPaths: ['/work'],
            cwd: '/work',
            pendingId: 'p-used',
            finalSessionId: 's-used',
            finalSessionName: 'Used session',
            layout: 'session',
            finalLocator: { layout: 'session', sessionName: 'project-steward-s-codex-used' },
            consumedAtMs: now,
        };
        assert.strictEqual(await store.setConsumed(consumedRecord), true);
        assert.deepStrictEqual(await restartedStore.getConsumed(consumedIdentity), consumedRecord);

        const preDisplayConsumedRecord = { ...consumedRecord };
        delete preDisplayConsumedRecord.finalSessionName;
        preDisplayConsumedRecord.pendingId = 'p-used-before-display-snapshot';
        const preDisplayConsumedPath = path.join(root,
            runtimeRecordFilename(preDisplayConsumedRecord));
        fs.writeFileSync(preDisplayConsumedPath,
            `${JSON.stringify(preDisplayConsumedRecord, null, 2)}\n`);
        assert.deepStrictEqual(await restartedStore.getConsumed({
            ...consumedIdentity, pendingId: preDisplayConsumedRecord.pendingId,
        }), preDisplayConsumedRecord,
        'pre-display-name v2 tombstones must remain readable and fail closed on promotion replay');
        await assert.rejects(store.setConsumed(preDisplayConsumedRecord),
            /consumed tmux binding is invalid/,
        'new consumed records must include the exact raw promotion display name');

        const legacyConsumedRoot = path.join(root, 'legacy-consumed');
        fs.mkdirSync(legacyConsumedRoot);
        const legacyConsumedRecord = {
            version: 1,
            state: 'consumed',
            pendingId: 'legacy-consumed-pending',
            provider: 'codex',
            projectKey: 'legacy-consumed-project',
            finalSessionId: 'legacy-final',
            layout: 'session',
            finalLocator: { layout: 'session', sessionName: 'project-steward-s-codex-legacy-final' },
            consumedAtMs: now - 1,
        };
        const legacyConsumedPath = path.join(legacyConsumedRoot,
            runtimeRecordFilename(legacyConsumedRecord));
        const legacyConsumedBytes = `${JSON.stringify(legacyConsumedRecord, null, 2)}\n`;
        fs.writeFileSync(legacyConsumedPath, legacyConsumedBytes);
        const legacyConsumedStore = new runtimeStoreModule.TmuxRuntimeBindingStore(
            legacyConsumedRoot, () => now
        );
        const legacyConsumedIdentity = {
            provider: 'codex', workspaceScopeIdentity: 'legacy-consumed-project', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/fresh-work'], cwd: '/fresh-work',
            pendingId: 'legacy-consumed-pending',
        };
        assert.strictEqual(await legacyConsumedStore.getConsumed(legacyConsumedIdentity), null);
        await assert.rejects(legacyConsumedStore.setConsumed(legacyConsumedRecord),
            /consumed tmux binding is invalid/);
        assert.strictEqual(fs.readFileSync(legacyConsumedPath, 'utf8'), legacyConsumedBytes);

        const conflictingConsumedRecord = {
            ...consumedRecord,
            provider: 'kimi',
            workspaceScopeIdentity: 'other-consumed-project',
            workspaceRootHostPaths: ['/other-consumed'],
            cwd: '/other-consumed',
            finalSessionId: 'other-used',
            finalLocator: { layout: 'session', sessionName: 'project-steward-s-kimi-other-used' },
        };
        assert.strictEqual(await store.setConsumed(conflictingConsumedRecord), true);
        assert.deepStrictEqual(await restartedStore.getConsumed(pendingIdentity(
            conflictingConsumedRecord
        )), conflictingConsumedRecord);

        const promotingRecord = {
            version: 2,
            state: 'promoting',
            provider: 'codex',
            workspaceScopeIdentity: 'pk',
            workspaceNavigationIdentity: 'nav-1',
            workspaceRootHostPaths: ['/work'],
            pendingId: 'p-promoting',
            cwd: '/work',
            createdAt: '2026-07-18T09:59:00Z',
            markerPath: '/tmp/promoting',
            finalSessionId: 's-promoting',
            finalSessionName: 'Repair replication',
            layout: 'project',
            sourceLocator: {
                layout: 'project', sessionName: 'project-steward-p-a', windowName: 'pending-codex-p-promoting',
            },
            finalLocator: {
                layout: 'project', sessionName: 'project-steward-p-a', windowName: 'ai-codex-s-promoting',
            },
            requestFingerprint: 'a'.repeat(64),
            recordedAtMs: now,
        };
        promotingRecord.pendingBinding = pending('p-promoting', '2026-07-18T09:59:00Z', {
            acceptedAtMs: now,
            locator: { ...promotingRecord.sourceLocator },
        });
        assert.strictEqual(await store.setPromoting(promotingRecord), true);
        const readPromoting = await restartedStore.getPromoting({
            provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'p-promoting',
        });
        assert.deepStrictEqual(readPromoting, promotingRecord);
        readPromoting.sourceLocator.windowName = 'mutated';
        assert.strictEqual((await store.getPromoting({
            provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'p-promoting',
        })).sourceLocator.windowName, 'pending-codex-p-promoting');
        assert.strictEqual(await store.getPromoting({
            provider: 'codex', workspaceScopeIdentity: 'other', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'p-promoting',
        }), null);
        await store.setPending(promotingRecord.pendingBinding);
        assert.deepStrictEqual((await store.listRecoverablePending()).map(record =>
            record.pendingBinding.pendingId),
            ['p-promoting'], 'a strict durable intent must enumerate its exact pending snapshot');
        assert.strictEqual((await store.listRecoverablePending())[0].promotionRecoveryDisplayName,
            promotingRecord.finalSessionName);
        assert.strictEqual((await store.listRecoverablePending())[0].recoverySessionId,
            promotingRecord.finalSessionId);
        const expiredPromotionStore = new runtimeStoreModule.TmuxRuntimeBindingStore(root,
            () => now + (24 * 60 * 60 * 1000) + 1);
        assert.strictEqual(await expiredPromotionStore.getPending(
            pendingIdentity(promotingRecord.pendingBinding)
        ), null);
        assert.deepStrictEqual(await expiredPromotionStore.getPromoting(pendingIdentity(
            promotingRecord
        )), promotingRecord);
        assert.deepStrictEqual((await expiredPromotionStore.listRecoverablePending())
            .map(record => record.pendingBinding.pendingId), ['p-promoting'],
        'the intent snapshot must remain authoritative after the live pending record expires');

        const inconsistentDurableRoot = path.join(root, 'inconsistent-durable');
        const inconsistentDurableStore = new runtimeStoreModule.TmuxRuntimeBindingStore(
            inconsistentDurableRoot, () => now
        );
        await inconsistentDurableStore.setPromoting(promotingRecord);
        await inconsistentDurableStore.setConsumed({
            version: 2, state: 'consumed',
            provider: promotingRecord.provider,
            workspaceScopeIdentity: promotingRecord.workspaceScopeIdentity,
            workspaceNavigationIdentity: promotingRecord.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...promotingRecord.workspaceRootHostPaths],
            cwd: promotingRecord.cwd, pendingId: promotingRecord.pendingId,
            finalSessionId: 'different-final', finalSessionName: 'Different final',
            layout: promotingRecord.layout,
            finalLocator: {
                ...promotingRecord.finalLocator,
                windowName: 'ai-codex-different-final',
            },
            consumedAtMs: now,
        });
        await assert.rejects(inconsistentDurableStore.listRecoverablePending(),
            /disagree on the final runtime/,
        'multiple durable records for one identity must fail closed when they disagree');

        const invalidDurableRoot = path.join(root, 'invalid-durable');
        fs.mkdirSync(invalidDurableRoot);
        fs.writeFileSync(path.join(invalidDurableRoot, `promoting-${'a'.repeat(64)}.json`),
            JSON.stringify({ version: 2, state: 'promoting' }));
        const invalidDurableStore = new runtimeStoreModule.TmuxRuntimeBindingStore(
            invalidDurableRoot, () => now
        );
        await assert.rejects(invalidDurableStore.listRecoverablePending(),
            /durable tmux promoting record is invalid/,
        'invalid strict durable records must fail the entire promotion enumeration');
        await store.removePending(pendingIdentity(promotingRecord.pendingBinding));
        await assert.rejects(store.setPromoting({
            ...promotingRecord,
            cwd: '/different',
            pendingBinding: { ...promotingRecord.pendingBinding, cwd: '/work' },
        }), /promoting tmux binding is invalid/);
        const conflictingPromoting = {
            ...promotingRecord,
            workspaceScopeIdentity: 'other-project',
            workspaceNavigationIdentity: 'nav-other',
            workspaceRootHostPaths: ['/other'],
            cwd: '/other',
            sourceLocator: {
                layout: 'project', sessionName: 'project-steward-p-other', windowName: 'pending-codex-p-promoting',
            },
            finalLocator: {
                layout: 'project', sessionName: 'project-steward-p-other', windowName: 'ai-codex-s-promoting',
            },
        };
        conflictingPromoting.pendingBinding = {
            ...promotingRecord.pendingBinding,
            workspaceScopeIdentity: conflictingPromoting.workspaceScopeIdentity,
            workspaceNavigationIdentity: conflictingPromoting.workspaceNavigationIdentity,
            workspaceRootHostPaths: conflictingPromoting.workspaceRootHostPaths,
            cwd: conflictingPromoting.cwd,
            locator: { ...conflictingPromoting.sourceLocator },
        };
        await store.setPromoting(conflictingPromoting);
        assert.deepStrictEqual(await restartedStore.getPromoting(pendingIdentity(
            conflictingPromoting
        )), conflictingPromoting);
        assert.deepStrictEqual((await store.listRecoverablePending()).map(record =>
            `${record.pendingBinding.workspaceScopeIdentity}:${record.pendingBinding.pendingId}`).sort(), [
            'other-project:p-promoting', 'pk:p-promoting',
        ], 'multiple strict durable identities must enumerate independently');
        await store.removePromoting({
            provider: 'codex', workspaceScopeIdentity: 'other-project', workspaceNavigationIdentity: 'nav-other', workspaceRootHostPaths: ['/other'], cwd: '/other', pendingId: 'p-promoting',
        });
        await restartedStore.removePromoting({
            provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'p-promoting',
        });
        assert.strictEqual(await store.getPromoting({
            provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'p-promoting',
        }), null);

        await store.setKnown(known('s-old', now - 2));
        await store.setKnown(known('s-new', now - 1));
        await store.setKnown(known('expired', now - (30 * 24 * 60 * 60 * 1000) - 1));
        await store.setKnown(known('expired-at-boundary', now - (30 * 24 * 60 * 60 * 1000)));
        assert.deepStrictEqual((await store.listKnown()).map(record => record.sessionId), ['s-new', 's-old']);
        assert.strictEqual((await store.getKnown('codex', 's-old')).locator.windowName, 'ai-codex-s-old');
        assert.strictEqual(await store.getKnown('codex', 'expired'), null);
        assert.strictEqual(await store.getKnown('codex', 'expired-at-boundary'), null);

        const delayedRecordPath = path.join(root, runtimeRecordFilename(known('s-old', now - 2)));
        const originalReadFile = fs.promises.readFile;
        const originalStoreOpen = fs.promises.open;
        const readStarted = deferred();
        const releaseRead = deferred();
        let readDelayed = false;
        const delayTargetRead = async filePath => {
            if (!readDelayed && path.resolve(String(filePath)) === path.resolve(delayedRecordPath)) {
                readDelayed = true;
                readStarted.resolve();
                await releaseRead.promise;
            }
        };
        fs.promises.readFile = async (filePath, ...args) => {
            await delayTargetRead(filePath);
            return originalReadFile.call(fs.promises, filePath, ...args);
        };
        fs.promises.open = async (filePath, flags, ...args) => {
            const handle = await originalStoreOpen.call(fs.promises, filePath, flags, ...args);
            if (path.resolve(String(filePath)) === path.resolve(delayedRecordPath)) {
                const handleReadFile = handle.readFile.bind(handle);
                handle.readFile = async (...readArgs) => {
                    await delayTargetRead(filePath);
                    return handleReadFile(...readArgs);
                };
            }
            return handle;
        };
        const queuedSetRecord = known('queued-set', now);
        const queuedLiveIdentity = {
            identity: { provider: 'kimi', workspaceScopeIdentity: 'pk-queued', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/queued'], cwd: '/queued', sessionId: 'queued-live' },
            backend: 'tmux',
            state: 'active',
            markerPath: '/tmp/queued.done',
            runStartedAtMs: now - 100,
            attached: false,
            tmux: { layout: 'session', sessionName: 'project-steward-s-kimi-queued' },
        };
        let queuedSetSettled = false;
        let queuedReconcileSettled = false;
        try {
            const delayedList = store.listKnown();
            await readStarted.promise;
            const queuedSet = store.setKnown(queuedSetRecord).then(() => { queuedSetSettled = true; });
            const queuedReconcile = store.reconcileKnown([queuedLiveIdentity]).then(() => {
                queuedReconcileSettled = true;
            });
            await new Promise(resolve => setTimeout(resolve, 50));
            const setSettledDuringRead = queuedSetSettled;
            const reconcileSettledDuringRead = queuedReconcileSettled;
            releaseRead.resolve();
            await Promise.all([delayedList, queuedSet, queuedReconcile]);
            assert.strictEqual(setSettledDuringRead, false);
            assert.strictEqual(reconcileSettledDuringRead, false);
        } finally {
            releaseRead.resolve();
            fs.promises.readFile = originalReadFile;
            fs.promises.open = originalStoreOpen;
        }
        assert.ok(await store.getKnown('codex', 'queued-set'));
        assert.ok(await store.getKnown('kimi', 'queued-live'));

        const queueRecoveryRoot = path.join(root, 'queue-recovery');
        fs.writeFileSync(queueRecoveryRoot, 'not a directory');
        const queueRecoveryStore = new runtimeStoreModule.TmuxRuntimeBindingStore(queueRecoveryRoot, () => now);
        await assert.rejects(queueRecoveryStore.listKnown(), error => error && error.code === 'ENOTDIR');
        fs.unlinkSync(queueRecoveryRoot);
        await queueRecoveryStore.setKnown(known('after-read-error', now));
        assert.ok(await queueRecoveryStore.getKnown('codex', 'after-read-error'));

        const noncanonicalPath = path.join(root, 'arbitrary-valid-name.json');
        fs.writeFileSync(noncanonicalPath, JSON.stringify(known('noncanonical', now)));
        assert.strictEqual((await store.listKnown()).some(record => record.sessionId === 'noncanonical'), false);
        assert.strictEqual(fs.existsSync(noncanonicalPath), true);

        const directMismatchRoot = path.join(root, 'direct-identity-mismatch');
        fs.mkdirSync(directMismatchRoot);
        const requestedDirectRecord = known('s1', now);
        const mismatchedDirectRecord = known('s2', now, { provider: 'kimi' });
        const requestedDirectPath = path.join(
            directMismatchRoot, runtimeRecordFilename(requestedDirectRecord)
        );
        fs.writeFileSync(requestedDirectPath, JSON.stringify(mismatchedDirectRecord));
        const directMismatchStore = new runtimeStoreModule.TmuxRuntimeBindingStore(
            directMismatchRoot, () => now
        );
        assert.strictEqual(await directMismatchStore.getKnown('codex', 's1'), null);
        assert.strictEqual(await directMismatchStore.getKnown('kimi', 's2'), null);
        assert.strictEqual(fs.existsSync(requestedDirectPath), true);

        const fifoRoot = path.join(root, 'fifo-records');
        fs.mkdirSync(fifoRoot);
        const fifoPath = path.join(fifoRoot, 'blocked.json');
        const mkfifo = childProcess.spawnSync('mkfifo', [fifoPath]);
        if (mkfifo.status === 0) {
            let fifoWriterError;
            const writerTimer = setTimeout(() => {
                try {
                    const descriptor = fs.openSync(fifoPath, 'w');
                    fs.closeSync(descriptor);
                } catch (error) {
                    fifoWriterError = error;
                }
            }, 200);
            const fifoStore = new runtimeStoreModule.TmuxRuntimeBindingStore(fifoRoot, () => now);
            const startedAt = Date.now();
            assert.deepStrictEqual(await fifoStore.listKnown(), []);
            const elapsedMs = Date.now() - startedAt;
            clearTimeout(writerTimer);
            assert.strictEqual(fifoWriterError, undefined);
            assert.ok(elapsedMs < 150, `FIFO enumeration blocked for ${elapsedMs}ms`);
        }

        if (fs.constants.O_NOFOLLOW) {
            const unsupportedRoot = path.join(root, 'unsupported-no-follow');
            const unsupportedStore = new runtimeStoreModule.TmuxRuntimeBindingStore(unsupportedRoot, () => now);
            const unsupportedRecord = known('unsupported-no-follow', now);
            await unsupportedStore.setKnown(unsupportedRecord);
            const unsupportedPath = path.join(unsupportedRoot, runtimeRecordFilename(unsupportedRecord));
            const unsupportedOriginalOpen = fs.promises.open;
            let noFollowRejected = false;
            let fallbackFlags;
            fs.promises.open = async (filePath, flags, ...args) => {
                if (path.resolve(String(filePath)) === path.resolve(unsupportedPath)) {
                    if (!noFollowRejected) {
                        noFollowRejected = true;
                        const error = new Error('injected unsupported O_NOFOLLOW');
                        error.code = 'EINVAL';
                        throw error;
                    }
                    fallbackFlags = flags;
                }
                return unsupportedOriginalOpen.call(fs.promises, filePath, flags, ...args);
            };
            let unsupportedRecords;
            try {
                unsupportedRecords = await unsupportedStore.listKnown();
            } finally {
                fs.promises.open = unsupportedOriginalOpen;
            }
            assert.strictEqual(noFollowRejected, true);
            assert.strictEqual(unsupportedRecords.length, 1);
            assert.strictEqual(unsupportedRecords[0].sessionId, 'unsupported-no-follow');
            if (fs.constants.O_NONBLOCK) {
                assert.strictEqual((fallbackFlags & fs.constants.O_NONBLOCK) !== 0, true);
            }
            assert.strictEqual((fallbackFlags & fs.constants.O_NOFOLLOW) === 0, true);
        }

        const mismatchRoot = path.join(root, 'fallback-mismatch');
        const mismatchStore = new runtimeStoreModule.TmuxRuntimeBindingStore(mismatchRoot, () => now);
        const mismatchRecord = known('fallback-mismatch', now);
        await mismatchStore.setKnown(mismatchRecord);
        const mismatchPath = path.join(mismatchRoot, runtimeRecordFilename(mismatchRecord));
        const mismatchReplacementPath = path.join(root, 'fallback-mismatch-replacement');
        fs.writeFileSync(mismatchReplacementPath, JSON.stringify(known('fallback-mismatch', now - 456)));
        const mismatchOriginalOpen = fs.promises.open;
        let mismatchNoFollowRejected = false;
        let mismatchHandleClosed = false;
        fs.promises.open = async (filePath, flags, ...args) => {
            if (path.resolve(String(filePath)) === path.resolve(mismatchPath)) {
                if (!mismatchNoFollowRejected && fs.constants.O_NOFOLLOW) {
                    mismatchNoFollowRejected = true;
                    const error = new Error('injected unsupported O_NOFOLLOW before mismatch');
                    error.code = 'EOPNOTSUPP';
                    throw error;
                }
                const handle = await mismatchOriginalOpen.call(
                    fs.promises, mismatchReplacementPath, flags, ...args
                );
                const close = handle.close.bind(handle);
                handle.close = async () => {
                    mismatchHandleClosed = true;
                    return close();
                };
                return handle;
            }
            return mismatchOriginalOpen.call(fs.promises, filePath, flags, ...args);
        };
        let mismatchRecords;
        try {
            mismatchRecords = await mismatchStore.listKnown();
        } finally {
            fs.promises.open = mismatchOriginalOpen;
        }
        assert.strictEqual(mismatchNoFollowRejected, Boolean(fs.constants.O_NOFOLLOW));
        assert.strictEqual(mismatchHandleClosed, true);
        assert.deepStrictEqual(mismatchRecords, []);

        const permissionRoot = path.join(root, 'permission-error');
        const permissionStore = new runtimeStoreModule.TmuxRuntimeBindingStore(permissionRoot, () => now);
        const permissionRecord = known('permission-error', now);
        await permissionStore.setKnown(permissionRecord);
        const permissionPath = path.join(permissionRoot, runtimeRecordFilename(permissionRecord));
        const permissionOriginalOpen = fs.promises.open;
        let permissionOpenAttempts = 0;
        fs.promises.open = async (filePath, flags, ...args) => {
            if (path.resolve(String(filePath)) === path.resolve(permissionPath)) {
                permissionOpenAttempts++;
                const error = new Error('injected permission failure');
                error.code = 'EACCES';
                throw error;
            }
            return permissionOriginalOpen.call(fs.promises, filePath, flags, ...args);
        };
        try {
            await assert.rejects(permissionStore.listKnown(), error => error && error.code === 'EACCES');
        } finally {
            fs.promises.open = permissionOriginalOpen;
        }
        assert.strictEqual(permissionOpenAttempts, 1);

        const raceRoot = path.join(root, 'read-race');
        const raceStore = new runtimeStoreModule.TmuxRuntimeBindingStore(raceRoot, () => now);
        const originalRaceRecord = known('read-race', now);
        await raceStore.setKnown(originalRaceRecord);
        const raceRecordPath = path.join(raceRoot, runtimeRecordFilename(originalRaceRecord));
        const replacementRecordPath = path.join(root, 'read-race-replacement');
        fs.writeFileSync(replacementRecordPath, JSON.stringify(known('read-race', now - 123)));
        const originalLstat = fs.promises.lstat;
        let targetLstatCount = 0;
        fs.promises.lstat = async (filePath, ...args) => {
            const stat = await originalLstat.call(fs.promises, filePath, ...args);
            if (path.resolve(String(filePath)) === path.resolve(raceRecordPath)
                && ++targetLstatCount === 1) {
                fs.unlinkSync(raceRecordPath);
                fs.symlinkSync(replacementRecordPath, raceRecordPath);
            }
            return stat;
        };
        let raceRecords;
        try {
            raceRecords = await raceStore.listKnown();
        } finally {
            fs.promises.lstat = originalLstat;
            fs.rmSync(raceRoot, { recursive: true, force: true });
            fs.rmSync(replacementRecordPath, { force: true });
        }
        assert.deepStrictEqual(raceRecords, []);

        for (let index = 0; index < 513; index++) {
            const capRecord = known(`cap-${index}`, now - 1000 + index);
            fs.writeFileSync(path.join(root, runtimeRecordFilename(capRecord)), JSON.stringify(capRecord));
        }
        const cappedKnown = await store.listKnown();
        assert.strictEqual(cappedKnown.length, 512);
        assert.strictEqual(cappedKnown[0].sessionId, 'queued-set');
        assert.ok(cappedKnown.some(record => record.sessionId === 'cap-512'));
        assert.strictEqual(cappedKnown.some(record => record.sessionId === 'cap-0'), false);

        const legacyReconcileRoot = path.join(root, 'legacy-known-reconcile');
        fs.mkdirSync(legacyReconcileRoot);
        const legacyReconcileStore = new runtimeStoreModule.TmuxRuntimeBindingStore(
            legacyReconcileRoot, () => now
        );
        await legacyReconcileStore.reconcileKnown([{
            identity: {
                provider: 'codex', workspaceScopeIdentity: 'legacy-project', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'legacy-live',
            },
            backend: 'tmux', state: 'active', markerPath: '', runStartedAtMs: 0,
            attached: false,
            tmux: { layout: 'session', sessionName: 'project-steward-s-codex-legacy' },
        }]);
        assert.deepStrictEqual(await legacyReconcileStore.getKnown('codex', 'legacy-live'), {
            version: 2,
            state: 'known',
            provider: 'codex',
            sessionId: 'legacy-live',
            workspaceScopeIdentity: 'legacy-project',
            workspaceNavigationIdentity: 'nav-1',
            workspaceRootHostPaths: ['/work'],
            cwd: '/work',
            layout: 'session',
            locator: { layout: 'session', sessionName: 'project-steward-s-codex-legacy' },
            lastSeenAtMs: now,
        }, 'legacy managed metadata without a run timestamp must retain a duplicate-prevention hint');

        await store.reconcileKnown([{
            identity: { provider: 'kimi', workspaceScopeIdentity: 'pk-live', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/live'], cwd: '/live', sessionId: 'live' },
            backend: 'tmux',
            state: 'active',
            markerPath: '/tmp/live.done',
            runStartedAtMs: now - 100,
            attached: false,
            tmux: { layout: 'session', sessionName: 'project-steward-s-kimi-live' },
        }, {
            identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'ignored-vscode' },
            backend: 'vscode',
            state: 'active',
            markerPath: '/tmp/vscode.done',
            runStartedAtMs: now - 100,
            attached: true,
        }]);
        const live = await store.getKnown('kimi', 'live');
        assert.strictEqual(live.lastSeenAtMs, now);
        assert.strictEqual(live.layout, 'session');
        assert.strictEqual(await store.getKnown('codex', 'ignored-vscode'), null);

        await store.removePending(pendingIdentity(pending('p-old', '2026-07-18T09:58:00Z')));
        await store.removeKnown('kimi', 'live');
        assert.deepStrictEqual((await store.listPending()).map(record => record.pendingId), ['p-new']);
        assert.strictEqual(await store.getKnown('kimi', 'live'), null);
        assert.ok(fs.readdirSync(root).every(name => !name.endsWith('.tmp')));

        const state = new Map();
        const bindingState = {
            get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
            update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value),
        };
        const attach = new attachStoreModule.TmuxAttachBindingStore(bindingState);
        const binding = {
            version: 2,
            layout: 'project',
            workspaceScopeIdentity: 'pk',
            workspaceNavigationIdentity: 'nav-1',
            workspaceRootHostPaths: ['/work'],
            cwd: '/work',
            sessionName: 'project-steward-p-a',
            windowName: 'ai-codex-a',
            provider: 'codex',
            sessionId: 's1',
            terminalNamePrefix: 'Project Steward:',
        };
        attach.set(Promise.resolve(41), binding);
        await attach.flush();
        assert.deepStrictEqual(attach.get(41), binding);
        assert.deepStrictEqual([...state.keys()], ['aiSessionTmuxAttachProcessBinding.v2.41']);
        const legacySessionAttachBinding = { ...binding, layout: 'session' };
        delete legacySessionAttachBinding.windowName;
        legacySessionAttachBinding.sessionName = 'project-steward-s-codex-legacy';
        const readableSessionAttachBinding = {
            ...legacySessionAttachBinding,
            sessionName: 'ps-RedDB-Repair-replication-12345678',
            windowName: 'codex-Repair-replication-12345678',
        };
        attach.set(Promise.resolve(42), legacySessionAttachBinding);
        attach.set(Promise.resolve(43), readableSessionAttachBinding);
        await attach.flush();
        assert.deepStrictEqual(attach.get(42), legacySessionAttachBinding,
            'attach persistence must retain legacy session bindings without windowName');
        assert.deepStrictEqual(attach.get(43), readableSessionAttachBinding,
            'attach persistence must round-trip session binding windowName');
        for (const [processId, invalid] of [
            [46, { ...binding, pendingId: 'also-pending' }],
            [47, { ...binding, projectKey: 'legacy' }],
            [48, { ...binding, unexpected: true }],
            [49, (() => { const value = { ...binding }; delete value.cwd; return value; })()],
            [52, { ...legacySessionAttachBinding, windowName: undefined }],
            [53, { ...readableSessionAttachBinding, unexpected: true }],
        ]) {
            state.set(`aiSessionTmuxAttachProcessBinding.v2.${processId}`, invalid);
            assert.strictEqual(attach.get(processId), null,
                'v2 attach bindings must reject both IDs, missing fields, legacy fields, and extras');
            state.delete(`aiSessionTmuxAttachProcessBinding.v2.${processId}`);
        }
        const minimalBinding = {
            version: 2,
            layout: 'project',
            workspaceScopeIdentity: 'pk',
            sessionName: 'project-steward-p-a',
            terminalNamePrefix: 'Project Steward:',
        };
        attach.set(Promise.resolve(44), minimalBinding);
        await attach.flush();
        assert.strictEqual(attach.get(44), null);
        attach.remove(Promise.resolve(44));
        attach.set(Promise.resolve(0), binding);
        attach.set(Promise.resolve(50), { ...binding, layout: 'session', windowName: '' });
        attach.set(Promise.resolve(51), { ...binding, windowName: undefined, terminalNamePrefix: '' });
        await attach.flush();
        assert.strictEqual(state.size, 3);
        attach.remove(Promise.resolve(41));
        attach.remove(Promise.resolve(42));
        attach.remove(Promise.resolve(43));
        await attach.flush();
        assert.strictEqual(state.size, 0);

        state.set('aiSessionTmuxAttachProcessBinding.v1.45', {
            ...binding,
            version: 1,
            projectKey: binding.workspaceScopeIdentity,
            workspaceScopeIdentity: undefined,
            workspaceNavigationIdentity: undefined,
            workspaceRootHostPaths: undefined,
            cwd: undefined,
        });
        assert.strictEqual(attach.get(45), null, 'v1 attach bindings must be ignored');

        let inside = 0;
        let highestInside = 0;
        await Promise.all([1, 2].map(() => creationLock.withTmuxCreationLock(root, 'same-key', async () => {
            inside++;
            highestInside = Math.max(highestInside, inside);
            await new Promise(resolve => setTimeout(resolve, 10));
            inside--;
        })));
        assert.strictEqual(highestInside, 1);
        const lockDirectory = path.join(root, 'ai-session-tmux-locks');
        const sameDigest = crypto.createHash('sha256').update('same-key', 'utf8').digest('hex');
        const sameLockPath = path.join(lockDirectory, `${sameDigest}.lock`);
        assert.strictEqual(fs.lstatSync(sameLockPath).isDirectory(), true);
        assert.deepStrictEqual(fs.readdirSync(sameLockPath), []);

        const heartbeatKey = 'heartbeat-renewal';
        const heartbeatDigest = crypto.createHash('sha256').update(heartbeatKey, 'utf8').digest('hex');
        const heartbeatHeldPath = path.join(lockDirectory, `${heartbeatDigest}.lock`, 'held');
        const heartbeatEntered = deferred();
        const releaseHeartbeat = deferred();
        const originalSetInterval = global.setInterval;
        const originalClearInterval = global.clearInterval;
        let heartbeatCallback;
        let heartbeatIntervalMs = 0;
        let heartbeatTimerCleared = false;
        const fakeHeartbeatTimer = { unref: () => undefined };
        global.setInterval = (callback, intervalMs) => {
            heartbeatCallback = callback;
            heartbeatIntervalMs = intervalMs;
            return fakeHeartbeatTimer;
        };
        global.clearInterval = timer => {
            if (timer === fakeHeartbeatTimer) {
                heartbeatTimerCleared = true;
            }
        };
        let heartbeatLock;
        try {
            heartbeatLock = creationLock.withTmuxCreationLock(root, heartbeatKey, async () => {
                heartbeatEntered.resolve();
                await releaseHeartbeat.promise;
            });
            await heartbeatEntered.promise;
            assert.strictEqual(typeof heartbeatCallback, 'function',
                'a held tmux creation lock must schedule a renewal heartbeat');
            assert.ok(heartbeatIntervalMs > 0 && heartbeatIntervalMs < 30000,
                'the heartbeat interval must renew the claim before the stale lease expires');
            const claimName = fs.readdirSync(heartbeatHeldPath).find(name => name.endsWith('.claim'));
            assert.ok(claimName, 'the heartbeat test requires an active owner claim');
            const claimPath = path.join(heartbeatHeldPath, claimName);
            const expiredTime = new Date(Date.now() - 31000);
            fs.utimesSync(claimPath, expiredTime, expiredTime);
            await heartbeatCallback();
            assert.ok(fs.lstatSync(claimPath).mtimeMs > expiredTime.getTime(),
                'a heartbeat must renew the active owner claim timestamp');
        } finally {
            releaseHeartbeat.resolve();
            if (heartbeatLock) {
                await heartbeatLock;
            }
            global.setInterval = originalSetInterval;
            global.clearInterval = originalClearInterval;
        }
        assert.strictEqual(heartbeatTimerCleared, true,
            'releasing the lock must stop its heartbeat timer');

        const raceKey = 'owner-cleanup-race';
        const raceDigest = crypto.createHash('sha256').update(raceKey, 'utf8').digest('hex');
        const raceLockPath = path.join(lockDirectory, `${raceDigest}.lock`);
        const raceHeldPath = path.join(raceLockPath, 'held');
        const oldEntered = deferred();
        const releaseOld = deferred();
        const oldLock = creationLock.withTmuxCreationLock(root, raceKey, async () => {
            oldEntered.resolve();
            await releaseOld.promise;
        });
        await oldEntered.promise;
        assert.strictEqual(fs.lstatSync(raceHeldPath).isDirectory(), true);
        const originalRmdir = fs.promises.rmdir;
        const originalRaceOpen = fs.promises.open;
        const cleanupPaused = deferred();
        const allowCleanup = deferred();
        const replacementClaimPaused = deferred();
        const allowReplacementClaim = deferred();
        let cleanupIntercepted = false;
        let pauseNextReplacementClaim = false;
        let replacementClaimIntercepted = false;
        fs.promises.rmdir = async target => {
            if (!cleanupIntercepted && path.resolve(String(target)) === path.resolve(raceHeldPath)) {
                cleanupIntercepted = true;
                cleanupPaused.resolve();
                await allowCleanup.promise;
            }
            return originalRmdir.call(fs.promises, target);
        };
        fs.promises.open = async (filePath, flags, ...args) => {
            if (pauseNextReplacementClaim && !replacementClaimIntercepted && flags === 'wx'
                && path.dirname(String(filePath)) === raceHeldPath) {
                replacementClaimIntercepted = true;
                replacementClaimPaused.resolve();
                await allowReplacementClaim.promise;
            }
            return originalRaceOpen.call(fs.promises, filePath, flags, ...args);
        };
        let replacementLock;
        let replacementEntries = 0;
        try {
            releaseOld.resolve();
            await cleanupPaused.promise;
            await originalRmdir.call(fs.promises, raceHeldPath);
            pauseNextReplacementClaim = true;
            replacementLock = creationLock.withTmuxCreationLock(root, raceKey, async () => {
                replacementEntries++;
            });
            await replacementClaimPaused.promise;
            allowCleanup.resolve();
            await oldLock;
            allowReplacementClaim.resolve();
            await replacementLock;
            assert.strictEqual(replacementEntries, 1);
            assert.strictEqual(fs.lstatSync(raceLockPath).isDirectory(), true);
            assert.strictEqual(fs.existsSync(raceHeldPath), false);
        } finally {
            fs.promises.rmdir = originalRmdir;
            fs.promises.open = originalRaceOpen;
            releaseOld.resolve();
            allowCleanup.resolve();
            allowReplacementClaim.resolve();
        }

        const originalOpen = fs.promises.open;
        let injectedHandleClosed = false;
        let injected = false;
        fs.promises.open = async (filePath, flags, ...args) => {
            const handle = await originalOpen.call(fs.promises, filePath, flags, ...args);
            if (!injected && flags === 'wx' && String(filePath).startsWith(lockDirectory)) {
                injected = true;
                const originalClose = handle.close.bind(handle);
                handle.writeFile = async () => { throw new Error('injected lock initialization failure'); };
                handle.close = async () => {
                    injectedHandleClosed = true;
                    return originalClose();
                };
            }
            return handle;
        };
        try {
            await assert.rejects(
                creationLock.withTmuxCreationLock(root, 'initialization-failure', async () => undefined),
                /injected lock initialization failure/
            );
        } finally {
            fs.promises.open = originalOpen;
        }
        assert.strictEqual(injectedHandleClosed, true);
        const initializationDigest = crypto.createHash('sha256')
            .update('initialization-failure', 'utf8').digest('hex');
        const initializationLockPath = path.join(lockDirectory, `${initializationDigest}.lock`);
        assert.strictEqual(fs.lstatSync(initializationLockPath).isDirectory(), true);
        assert.deepStrictEqual(fs.readdirSync(initializationLockPath), []);

        const symlinkKey = 'symlinked-lock-container';
        const symlinkDigest = crypto.createHash('sha256').update(symlinkKey, 'utf8').digest('hex');
        const symlinkLockPath = path.join(lockDirectory, `${symlinkDigest}.lock`);
        const externalLockDirectory = path.join(root, 'external-lock-target');
        fs.mkdirSync(externalLockDirectory);
        const externalClaimPath = path.join(externalLockDirectory, `${'a'.repeat(64)}.claim`);
        fs.writeFileSync(externalClaimPath, 'external claim must survive');
        const externalClaimBefore = fs.readFileSync(externalClaimPath, 'utf8');
        const oldExternalTime = new Date(Date.now() - 31000);
        fs.utimesSync(externalClaimPath, oldExternalTime, oldExternalTime);
        fs.symlinkSync(externalLockDirectory, symlinkLockPath, 'dir');
        let symlinkOperationRan = false;
        await assert.rejects(creationLock.withTmuxCreationLock(root, symlinkKey, async () => {
            symlinkOperationRan = true;
        }));
        assert.strictEqual(symlinkOperationRan, false);
        assert.strictEqual(fs.readFileSync(externalClaimPath, 'utf8'), externalClaimBefore);
        assert.deepStrictEqual(fs.readdirSync(externalLockDirectory), [path.basename(externalClaimPath)]);
        fs.unlinkSync(symlinkLockPath);
        fs.rmSync(externalLockDirectory, { recursive: true, force: true });

        const staleDigest = crypto.createHash('sha256').update('stale-key', 'utf8').digest('hex');
        const lockName = `${staleDigest}.lock`;
        const staleLockPath = path.join(lockDirectory, lockName);
        fs.mkdirSync(staleLockPath);
        const staleHeldPath = path.join(staleLockPath, 'held');
        fs.mkdirSync(staleHeldPath);
        const staleContainerIdentity = fs.lstatSync(staleLockPath);
        const staleHeldIdentity = fs.lstatSync(staleHeldPath);
        const staleClaimPath = path.join(staleHeldPath, `${'0'.repeat(64)}.claim`);
        fs.writeFileSync(staleClaimPath, JSON.stringify({
            version: 1,
            containerDev: staleContainerIdentity.dev,
            containerIno: staleContainerIdentity.ino,
            containerBirthtimeMs: staleContainerIdentity.birthtimeMs,
            heldDev: staleHeldIdentity.dev,
            heldIno: staleHeldIdentity.ino,
            heldBirthtimeMs: staleHeldIdentity.birthtimeMs,
        }));
        const staleTime = new Date(Date.now() - 31000);
        fs.utimesSync(staleClaimPath, staleTime, staleTime);
        fs.utimesSync(staleHeldPath, staleTime, staleTime);
        let recovered = false;
        await creationLock.withTmuxCreationLock(root, 'stale-key', async () => { recovered = true; });
        assert.strictEqual(recovered, true);
        assert.strictEqual(fs.lstatSync(staleLockPath).isDirectory(), true);
        assert.strictEqual(fs.existsSync(staleHeldPath), false);
        assert.strictEqual(fs.existsSync(staleClaimPath), false);

        const emptyStaleKey = 'empty-stale-key';
        const emptyStaleDigest = crypto.createHash('sha256').update(emptyStaleKey, 'utf8').digest('hex');
        const emptyStaleLockPath = path.join(lockDirectory, `${emptyStaleDigest}.lock`);
        const emptyStaleHeldPath = path.join(emptyStaleLockPath, 'held');
        fs.mkdirSync(emptyStaleLockPath);
        fs.mkdirSync(emptyStaleHeldPath);
        fs.utimesSync(emptyStaleHeldPath, staleTime, staleTime);
        let emptyStaleRecovered = false;
        await creationLock.withTmuxCreationLock(root, emptyStaleKey, async () => {
            emptyStaleRecovered = true;
        });
        assert.strictEqual(emptyStaleRecovered, true);
        assert.strictEqual(fs.existsSync(emptyStaleHeldPath), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function runTmuxBackendChecks() {
    const backendModule = require('../out/aiSessions/tmuxRuntimeBackend');
    const backendCollisionIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'backend-collision-project', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
        sessionId: 'backend-collision-session',
    };
    const backendCollisionExpected = new tmuxLayout.SessionTmuxLayout()
        .getLocator(backendCollisionIdentity);
    let backendCollisionMutationCalls = 0;
    const backendCollision = new backendModule.TmuxRuntimeBackend({
        platform: 'linux',
        client: {
            checkAvailability: async () => ({ available: true, version: '3.4' }),
            hasSession: async () => { backendCollisionMutationCalls++; return false; },
            getExecutablePath: () => 'tmux',
        },
        discovery: {
            refresh: async () => undefined, getActive: () => [], getPending: () => [], find: () => [],
            getDiagnostics: () => [{
                kind: 'tmux-locator-collision', identity: { ...backendCollisionIdentity },
                actual: { ...backendCollisionExpected, sessionName: `${backendCollisionExpected.sessionName}-occupied` },
                expected: { ...backendCollisionExpected },
            }],
        },
        runtimeStore: { getAmbiguous: async () => null, removeAmbiguous: async () => undefined },
        attachStore: { get: () => null, set: () => undefined, remove: () => undefined, flush: async () => undefined },
        withCreationLock: async (_key, operation) => operation(),
        createTerminal: () => { throw new Error('attach must not be reached'); },
        nowMs: () => Date.parse('2026-07-18T10:00:00Z'),
    });
    await assert.rejects(
        backendCollision.ensureResume({
            identity: backendCollisionIdentity, projectName: 'Collision', terminalName: 'Collision',
            launch: { executable: 'codex', args: ['resume'], markerPath: '/tmp/collision.done' },
        }, 'session'),
        error => error && error.name === 'AiSessionRuntimeConflictError'
            && Array.isArray(error.conflicts) && error.conflicts.length === 1
    );
    assert.strictEqual(backendCollisionMutationCalls, 0,
        'backend forced refresh collision guard must run before any tmux mutation/provider dispatch');
    const backendLifecycleIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'backend-lifecycle-project', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
        sessionId: 'backend-lifecycle-session',
    };
    const backendLifecycleBlocker = {
        identity: { ...backendLifecycleIdentity }, backend: 'tmux', state: 'stopped',
        markerPath: '/tmp/backend-lifecycle.done', runStartedAtMs: 100,
        attached: false,
        tmux: new tmuxLayout.SessionTmuxLayout().getLocator(backendLifecycleIdentity),
    };
    let backendLifecycleMutationCalls = 0;
    const backendLifecycle = new backendModule.TmuxRuntimeBackend({
        platform: 'linux',
        client: {
            checkAvailability: async () => ({ available: true, version: '3.4' }),
            hasSession: async () => { backendLifecycleMutationCalls++; return false; },
            getExecutablePath: () => 'tmux',
        },
        discovery: {
            refresh: async () => undefined,
            getActive: () => [], getPending: () => [], find: () => [], getDiagnostics: () => [],
            getInactive: () => [{ ...backendLifecycleBlocker,
                identity: { ...backendLifecycleBlocker.identity },
                tmux: { ...backendLifecycleBlocker.tmux } }],
        },
        runtimeStore: { getAmbiguous: async () => null, removeAmbiguous: async () => undefined },
        attachStore: { get: () => null, set: () => undefined, remove: () => undefined, flush: async () => undefined },
        withCreationLock: async (_key, operation) => operation(),
        createTerminal: () => { throw new Error('attach must not be reached'); },
        nowMs: () => Date.parse('2026-07-18T10:00:00Z'),
    });
    await assert.rejects(backendLifecycle.ensureResume({
        identity: backendLifecycleIdentity, projectName: 'Lifecycle', terminalName: 'Lifecycle',
        launch: { executable: 'codex', args: ['resume'], markerPath: '/tmp/backend-lifecycle.done' },
    }, 'session'), error => error && error.name === 'AiSessionRuntimeLifecycleBlockedError'
        && Array.isArray(error.blockers) && error.blockers.length === 1);
    assert.strictEqual(backendLifecycleMutationCalls, 0,
        'backend lock-boundary lifecycle guard must run before mutation/provider dispatch');
    const projectHarness = createTmuxBackendHarness({
        getAttachTerminalName: runtime => runtime.tmux.layout === 'project'
            ? 'Project Steward: App [tmux]'
            : 'Project Steward: Codex Session [tmux]',
    });
    const projectBackend = new backendModule.TmuxRuntimeBackend(projectHarness.dependencies);
    const firstProject = await projectBackend.ensureResume({
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        projectName: 'RedDB DTS Dual Active',
        sessionName: 'Repair replication',
        terminalName: 'AI Sessions: App',
        launch: { executable: 'codex', args: ['resume', 's1'], markerPath: '/tmp/m1' },
    }, 'project');
    const secondProject = await projectBackend.ensureResume({
        identity: { provider: 'claude', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's2' },
        projectName: 'Renamed Card',
        sessionName: 'Audit failover',
        terminalName: 'AI Sessions: App',
        launch: { executable: 'claude', args: ['--resume', 's2'], markerPath: '/tmp/m2' },
    }, 'project');
    assert.match(firstProject.tmux.sessionName, /^ps-RedDB-DTS-Dual-Active-[0-9a-f]{8}$/);
    assert.match(firstProject.tmux.windowName, /^codex-Repair-replication-[0-9a-f]{8}$/);
    assert.strictEqual(secondProject.tmux.sessionName, firstProject.tmux.sessionName,
        'a renamed project card must reuse the workspace-owned creation-time container');
    assert.match(secondProject.tmux.windowName, /^claude-Audit-failover-[0-9a-f]{8}$/);
    assert.strictEqual(projectHarness.operations.filter(item => item.type === 'new-session').length, 1);
    assert.strictEqual(projectHarness.operations.filter(item => item.type === 'new-window').length, 2);
    assert.strictEqual(projectHarness.operations.filter(item => item.type === 'configure-window').length, 2);
    const firstProjectRequest = {
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        projectName: 'Renamed Card', sessionName: 'Changed display alias', terminalName: 'AI Sessions: App',
        launch: { executable: 'codex', args: ['resume', 's1'], markerPath: '/tmp/m1' },
    };
    const reusedFirstProject = await projectBackend.ensureResume(firstProjectRequest, 'project');
    assert.deepStrictEqual(reusedFirstProject.tmux, firstProject.tmux,
        'an existing identity must reuse its actual creation-time locator after display changes');
    assert.strictEqual(projectHarness.operations.filter(item => item.type === 'new-session').length, 1);
    assert.strictEqual(projectHarness.operations.filter(item => item.type === 'new-window').length, 2);
    assert.strictEqual(projectHarness.terminals.length, 1);
    assert.deepStrictEqual(projectHarness.terminals[0].creationOptions, {
        name: 'Project Steward: App [tmux]',
        shellPath: '/opt/tmux',
        shellArgs: ['attach-session', '-t', firstProject.tmux.sessionName],
        env: { TMUX: null },
    });
    const firstAttachIndex = projectHarness.operations.findIndex(item => item.type === 'create-terminal');
    assert.ok(projectHarness.operations.slice(0, firstAttachIndex).some(item => item.type === 'select-window'));
    assert.strictEqual(firstProject.terminal, projectHarness.terminals[0]);
    assert.strictEqual(secondProject.terminal, projectHarness.terminals[0]);
    assert.strictEqual(projectBackend.getActive().length, 2);

    const ownershipConflictHarness = createTmuxBackendHarness();
    for (const [index, sessionName] of ['ps-first-owned-11111111', 'ps-second-owned-22222222'].entries()) {
        ownershipConflictHarness.windows.push({
            sessionName, windowName: 'project-steward', windowId: `@ownership-${index}`,
            active: false,
            sessionMetadata: {
                managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'owned-conflict',
            },
            windowMetadata: {}, metadata: {},
        });
    }
    const ownershipConflictBackend = new backendModule.TmuxRuntimeBackend(
        ownershipConflictHarness.dependencies
    );
    await assert.rejects(ownershipConflictBackend.ensureResume({
        identity: {
            provider: 'codex', workspaceScopeIdentity: 'owned-conflict',
            workspaceNavigationIdentity: 'nav-owned-conflict', workspaceRootHostPaths: ['/work'],
            cwd: '/work', sessionId: 'owned-conflict-session',
        },
        projectName: 'Current Card', sessionName: 'Do not dispatch', terminalName: 'Conflict',
        launch: { executable: 'codex', args: ['resume', 'owned-conflict-session'] },
    }, 'project'), error => error && error.name === 'AiSessionRuntimeConflictError'
        && error.conflicts.length === 2
        && error.conflicts.map(runtime => runtime.tmux.sessionName).sort().join(',')
            === 'ps-first-owned-11111111,ps-second-owned-22222222');
    assert.strictEqual(ownershipConflictHarness.operations.some(operation =>
        ['new-session', 'new-window', 'store-ambiguous', 'session-options', 'window-options']
            .includes(operation.type)), false,
    'ambiguous workspace ownership must fail before provider dispatch or tmux mutation');

    const renamedContainerIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'renamed-container',
        workspaceNavigationIdentity: 'nav-renamed-container', workspaceRootHostPaths: ['/work'],
        cwd: '/work', sessionId: 'renamed-container-runtime',
    };
    const renamedContainerPreferred = tmuxNaming.buildReadableTmuxLocator(
        renamedContainerIdentity, 'project', {
            projectName: 'Original Card', sessionName: 'Repair ownership',
        }
    );
    const renamedContainerSuffix = renamedContainerPreferred.sessionName.match(/([0-9a-f]{8})$/)[1];
    const renamedContainerMetadata = {
        managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'renamed-container',
    };
    const seedProjectContainer = (harness, sessionName, index = 0) => {
        harness.windows.push({
            sessionName, windowName: 'project-steward', windowId: `@renamed-container-${index}`,
            active: false, sessionMetadata: { ...renamedContainerMetadata },
            windowMetadata: {}, metadata: {},
        });
    };
    const renamedContainerRequest = {
        identity: renamedContainerIdentity,
        projectName: 'Current Card', sessionName: 'Repair ownership', terminalName: 'Ownership',
        launch: { executable: 'codex', args: ['resume', 'renamed-container-runtime'] },
    };
    const mutationTypes = new Set([
        'store-ambiguous', 'new-session', 'new-window', 'session-options', 'window-options',
    ]);
    for (const invalidSessionName of [
        'externally-renamed-without-suffix',
        `ps-Wrong-Suffix-00000000`,
        `ps-Bad:Card-${renamedContainerSuffix}`,
        `ps-Bad\nCard-${renamedContainerSuffix}`,
        `ps-${'x'.repeat(100)}-${renamedContainerSuffix}`,
        `ps-Ｃard-${renamedContainerSuffix}`,
        `ps--${renamedContainerSuffix}`,
    ]) {
        const invalidContainerHarness = createTmuxBackendHarness();
        seedProjectContainer(invalidContainerHarness, invalidSessionName);
        await assert.rejects(new backendModule.TmuxRuntimeBackend(
            invalidContainerHarness.dependencies
        ).ensureResume(renamedContainerRequest, 'project'), error =>
            error && error.name === 'AiSessionRuntimeConflictError'
            && error.conflicts.length === 1
            && error.conflicts[0].tmux.sessionName === invalidSessionName);
        assert.strictEqual(invalidContainerHarness.operations.some(operation =>
            mutationTypes.has(operation.type)), false,
        `invalid owned container ${JSON.stringify(invalidSessionName)} must fail before dispatch/mutation`);
    }

    for (const validSessionName of [
        `ps-Old-Card-${renamedContainerSuffix}`,
        new tmuxLayout.ProjectTmuxLayout().getLocator(renamedContainerIdentity).sessionName,
    ]) {
        const validContainerHarness = createTmuxBackendHarness();
        seedProjectContainer(validContainerHarness, validSessionName);
        const reused = await new backendModule.TmuxRuntimeBackend(
            validContainerHarness.dependencies
        ).ensureResume(renamedContainerRequest, 'project');
        assert.strictEqual(reused.tmux.sessionName, validSessionName,
            'canonical readable and legacy project containers must remain reusable');
        assert.strictEqual(validContainerHarness.operations.filter(operation =>
            operation.type === 'new-session').length, 0);
        assert.strictEqual(validContainerHarness.operations.filter(operation =>
            operation.type === 'new-window').length, 1);
    }

    const mixedOwnershipHarness = createTmuxBackendHarness();
    const validOwnedSession = `ps-Old-Card-${renamedContainerSuffix}`;
    const invalidOwnedSession = 'externally-renamed-without-suffix';
    seedProjectContainer(mixedOwnershipHarness, validOwnedSession, 1);
    seedProjectContainer(mixedOwnershipHarness, invalidOwnedSession, 2);
    await assert.rejects(new backendModule.TmuxRuntimeBackend(
        mixedOwnershipHarness.dependencies
    ).ensureResume(renamedContainerRequest, 'project'), error =>
        error && error.name === 'AiSessionRuntimeConflictError'
        && error.conflicts.length === 2
        && error.conflicts.map(runtime => runtime.tmux.sessionName).sort().join(',')
            === [invalidOwnedSession, validOwnedSession].sort().join(','));
    assert.strictEqual(mixedOwnershipHarness.operations.some(operation =>
        mutationTypes.has(operation.type)), false,
    'one valid plus one invalid owned container must fail before dispatch/mutation');

    const createTargetDefenseHarness = createTmuxBackendHarness();
    seedProjectContainer(createTargetDefenseHarness, invalidOwnedSession);
    let defenseProviderDispatches = 0;
    await assert.rejects(new backendModule.TmuxRuntimeBackend(
        createTargetDefenseHarness.dependencies
    ).createTarget('project', {
        ...renamedContainerPreferred, sessionName: invalidOwnedSession,
    }, '/work', 'codex resume', renamedContainerIdentity, async () => {
        defenseProviderDispatches++;
    }), /unverified target/);
    assert.strictEqual(defenseProviderDispatches, 0,
        'createTarget must independently reject an invalid workspace session before dispatch');
    assert.strictEqual(createTargetDefenseHarness.operations.some(operation =>
        mutationTypes.has(operation.type)), false,
    'createTarget defense must run before project window or metadata mutation');
    const verifiedFocusStart = projectHarness.operations.length;
    await projectBackend.focus(firstProject);
    const verifiedFocusOperations = projectHarness.operations.slice(verifiedFocusStart);
    assert.ok(verifiedFocusOperations.findIndex(item => item.type === 'get-target-window')
        < verifiedFocusOperations.findIndex(item => item.type === 'select-window'),
    'tmux ownership must be live-verified before selecting the target');
    assert.deepStrictEqual(projectHarness.operations.filter(item => item.type === 'select-window').slice(-1)[0].locator,
        firstProject.tmux);

    const validTargetMetadata = {
        managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'pk',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: '["/work"]', cwd: '/work',
        provider: 'codex', sessionId: 's1', createdAt: '2026-07-18T10:00:00.000Z', marker: '/tmp/m1',
    };
    const validTargetWindow = {
        sessionName: firstProject.tmux.sessionName,
        windowName: firstProject.tmux.windowName,
        windowId: '@777',
        metadata: validTargetMetadata,
    };
    for (const target of [
        null,
        { ...validTargetWindow, metadata: { ...validTargetMetadata, workspaceScopeIdentity: 'other' } },
        { ...validTargetWindow, metadata: { ...validTargetMetadata, provider: 'kimi' } },
        { ...validTargetWindow, metadata: { ...validTargetMetadata, sessionId: 'other' } },
        { ...validTargetWindow, windowName: 'other-window' },
        { ...validTargetWindow, metadata: { managed: '1', version: '2', layout: 'project' } },
    ]) {
        projectHarness.setTargetWindow(target);
        const selectCount = projectHarness.operations.filter(item => item.type === 'select-window').length;
        const terminalCount = projectHarness.terminals.length;
        await assert.rejects(projectBackend.focus(firstProject), error =>
            error && error.name === 'AiSessionRuntimeTargetChangedError');
        assert.strictEqual(projectHarness.operations.filter(item => item.type === 'select-window').length,
            selectCount, 'a changed target must not be selected');
        assert.strictEqual(projectHarness.terminals.length, terminalCount,
            'a changed target must not create an attach terminal');
    }

    const readableFocusIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'readable-focus',
        workspaceNavigationIdentity: 'nav-readable-focus', workspaceRootHostPaths: ['/work/readable-focus'],
        cwd: '/work/readable-focus', sessionId: 'readable-focus-session',
    };
    const readableFocusLocator = tmuxNaming.buildReadableTmuxLocator(
        readableFocusIdentity, 'session', { projectName: 'RedDB', sessionName: 'Repair replication' }
    );
    const readableFocusMetadata = {
        managed: '1', version: '2', layout: 'session',
        workspaceScopeIdentity: readableFocusIdentity.workspaceScopeIdentity,
        workspaceNavigationIdentity: readableFocusIdentity.workspaceNavigationIdentity,
        workspaceRootHostPaths: JSON.stringify(readableFocusIdentity.workspaceRootHostPaths),
        cwd: readableFocusIdentity.cwd, provider: readableFocusIdentity.provider,
        sessionId: readableFocusIdentity.sessionId, createdAt: '2026-07-18T10:00:00.000Z',
    };
    const readableFocusRuntime = {
        identity: readableFocusIdentity, backend: 'tmux', state: 'active', markerPath: '',
        runStartedAtMs: Date.parse(readableFocusMetadata.createdAt), attached: false,
        tmux: readableFocusLocator,
    };
    const readableFocusHarness = createTmuxBackendHarness();
    const readableFocusBackend = new backendModule.TmuxRuntimeBackend(readableFocusHarness.dependencies);
    readableFocusHarness.setTargetWindow({
        sessionName: readableFocusLocator.sessionName,
        windowName: readableFocusLocator.windowName,
        windowId: '@readable-focus', metadata: readableFocusMetadata,
    });
    await readableFocusBackend.focus(readableFocusRuntime);
    const readableFocusBinding = readableFocusHarness.attachBindings.get(
        await readableFocusHarness.terminals[0].processId
    );
    assert.strictEqual(readableFocusBinding.windowName, readableFocusLocator.windowName,
        'session attach bindings must preserve the discovered readable windowName');
    readableFocusHarness.setTargetWindow({
        sessionName: readableFocusLocator.sessionName,
        windowName: 'other-window', windowId: '@changed-readable-focus',
        metadata: readableFocusMetadata,
    });
    await assert.rejects(readableFocusBackend.focus(readableFocusRuntime), error =>
        error && error.name === 'AiSessionRuntimeTargetChangedError',
    'readable session target verification must compare the actual windowName');

    const legacyFocusIdentity = {
        ...readableFocusIdentity, workspaceScopeIdentity: 'legacy-focus',
        workspaceNavigationIdentity: 'nav-legacy-focus', sessionId: 'legacy-focus-session',
    };
    const legacyFocusLocator = new tmuxLayout.SessionTmuxLayout().getLocator(legacyFocusIdentity);
    const legacyFocusHarness = createTmuxBackendHarness();
    const legacyFocusBackend = new backendModule.TmuxRuntimeBackend(legacyFocusHarness.dependencies);
    legacyFocusHarness.setTargetWindow({
        sessionName: legacyFocusLocator.sessionName, windowName: 'renamed-legacy-window',
        windowId: '@legacy-focus', metadata: {
            ...readableFocusMetadata,
            workspaceScopeIdentity: legacyFocusIdentity.workspaceScopeIdentity,
            workspaceNavigationIdentity: legacyFocusIdentity.workspaceNavigationIdentity,
            sessionId: legacyFocusIdentity.sessionId,
        },
    });
    await legacyFocusBackend.focus({
        ...readableFocusRuntime, identity: legacyFocusIdentity, tmux: legacyFocusLocator,
    });

    for (const [label, identity, locator, expectedWindowName] of [
        ['readable', readableFocusIdentity, readableFocusLocator, readableFocusLocator.windowName],
        ['legacy', legacyFocusIdentity, legacyFocusLocator, 'ai-session'],
    ]) {
        const metadataHarness = createTmuxBackendHarness();
        metadataHarness.windows.push({
            sessionName: locator.sessionName, windowName: expectedWindowName,
            windowId: `@metadata-${label}`, active: false,
            sessionMetadata: {}, windowMetadata: {}, metadata: {},
        });
        const metadataBackend = new backendModule.TmuxRuntimeBackend(metadataHarness.dependencies);
        await metadataBackend.writePendingMetadata(
            identity, locator, '2026-07-18T10:00:00.000Z', ''
        );
        await metadataBackend.verifyPendingMetadata(
            identity, locator, '2026-07-18T10:00:00.000Z', ''
        );
        assert.ok(metadataHarness.operations.some(operation =>
            operation.type === 'window-options' && operation.windowName === expectedWindowName),
        `${label} session metadata writes must use the locator window fallback`);
        assert.ok(metadataHarness.operations.some(operation =>
            operation.type === 'get-window-options' && operation.windowName === expectedWindowName),
        `${label} session metadata reads must use the locator window fallback`);
    }
    const transitionPendingIdentity = {
        provider: 'kimi', workspaceScopeIdentity: 'readable-transition',
        workspaceNavigationIdentity: 'nav-readable-transition',
        workspaceRootHostPaths: ['/work/readable-transition'], cwd: '/work/readable-transition',
        pendingId: 'readable-transition-pending',
    };
    const transitionFinalIdentity = {
        ...transitionPendingIdentity, pendingId: undefined, sessionId: 'readable-transition-final',
    };
    const transitionFinalLocator = tmuxNaming.buildReadableTmuxLocator(
        transitionFinalIdentity, 'session', { projectName: 'RedDB', sessionName: 'Transition' }
    );
    const transitionHarness = createTmuxBackendHarness();
    transitionHarness.windows.push({
        sessionName: transitionFinalLocator.sessionName,
        windowName: transitionFinalLocator.windowName,
        windowId: '@readable-transition', active: false,
        sessionMetadata: {
            managed: '1', version: '2', layout: 'session',
            workspaceScopeIdentity: transitionFinalIdentity.workspaceScopeIdentity,
            workspaceNavigationIdentity: transitionFinalIdentity.workspaceNavigationIdentity,
            workspaceRootHostPaths: JSON.stringify(transitionFinalIdentity.workspaceRootHostPaths),
            cwd: transitionFinalIdentity.cwd, provider: transitionFinalIdentity.provider,
            sessionId: transitionFinalIdentity.sessionId, createdAt: '2026-07-18T10:00:00.000Z',
        },
        windowMetadata: { managed: '1', version: '2', layout: 'session' },
        metadata: {},
    });
    const transitionBackend = new backendModule.TmuxRuntimeBackend(transitionHarness.dependencies);
    assert.strictEqual(await transitionBackend.promotionTransitionMatches({
        version: 2, state: 'promoting', ...transitionPendingIdentity,
        createdAt: '2026-07-18T10:00:00.000Z', markerPath: '',
        finalSessionId: transitionFinalIdentity.sessionId, layout: 'session',
        finalLocator: transitionFinalLocator,
    }, transitionFinalIdentity), true);
    assert.ok(transitionHarness.operations.some(operation =>
        operation.type === 'get-window-options'
        && operation.windowName === transitionFinalLocator.windowName),
    'session promotion metadata reads must use the actual locator windowName');
    projectHarness.setTargetWindow(undefined);
    await projectBackend.detach(firstProject);
    assert.strictEqual(projectHarness.terminals[0].disposed, true);
    assert.strictEqual(projectBackend.getActive().length, 2);
    assert.ok(projectBackend.getActive().every(runtime => runtime.attached === false));
    const providerCreateCount = projectHarness.operations.filter(item =>
        item.type === 'new-session' || item.type === 'new-window').length;
    await projectBackend.focus(firstProject);
    assert.strictEqual(projectHarness.terminals.length, 2,
        'focusing a detached tmux runtime creates one viewer terminal');
    assert.strictEqual(projectHarness.terminals[1].name, 'Project Steward: App [tmux]');
    assert.strictEqual(projectHarness.operations.filter(item =>
        item.type === 'new-session' || item.type === 'new-window').length, providerCreateCount,
    'reattaching must not create another provider runtime');
    await projectBackend.focus(firstProject);
    assert.strictEqual(projectHarness.terminals.length, 2,
        'repeated focus reuses the existing viewer terminal');
    await projectBackend.focus(secondProject);
    assert.strictEqual(projectBackend.getFocusedRuntime(projectHarness.terminals[1]).identity.sessionId, 's2',
        'project layout focus must follow the selected managed window');
    projectHarness.windows.forEach(row => {
        row.active = row.sessionName === secondProject.tmux.sessionName
            && row.windowName === firstProject.tmux.windowName;
    });
    const manualSwitch = await projectBackend.syncFocusedRuntime(projectHarness.terminals[1]);
    assert.strictEqual(manualSwitch.monitored, true);
    assert.strictEqual(manualSwitch.changed, true);
    assert.strictEqual(manualSwitch.identity.sessionId, 's1');
    assert.strictEqual(projectBackend.getFocusedRuntime(projectHarness.terminals[1]).identity.sessionId, 's1');
    assert.strictEqual((await projectBackend.syncFocusedRuntime(projectHarness.terminals[1])).changed, false);

    const deferredExplicitFocusQuery = projectHarness.deferNextActiveWindow();
    const staleExplicitFocusSync = projectBackend.syncFocusedRuntime(projectHarness.terminals[1]);
    await projectBackend.focus(secondProject);
    deferredExplicitFocusQuery.resolve();
    assert.deepStrictEqual(await staleExplicitFocusSync, {
        monitored: true, changed: false, identity: { ...secondProject.identity },
    }, 'a query superseded by explicit focus must not report a stale change');
    assert.strictEqual(projectBackend.getFocusedRuntime(projectHarness.terminals[1]).identity.sessionId, 's2',
        'a query superseded by explicit focus must not overwrite the selected runtime');

    projectHarness.windows.forEach(row => { row.active = false; });
    projectHarness.windows.push({
        sessionName: firstProject.tmux.sessionName,
        windowName: 'base',
        windowId: '@999',
        active: true,
        sessionMetadata: {}, windowMetadata: {}, metadata: {},
    });
    const unmanaged = await projectBackend.syncFocusedRuntime(projectHarness.terminals[1]);
    assert.deepStrictEqual(unmanaged, { monitored: true, changed: true, identity: null });
    assert.strictEqual(projectBackend.getFocusedRuntime(projectHarness.terminals[1]), null);

    projectHarness.windows.forEach(row => {
        row.active = row.sessionName === firstProject.tmux.sessionName
            && row.windowName === firstProject.tmux.windowName;
    });
    await projectBackend.syncFocusedRuntime(projectHarness.terminals[1]);
    projectHarness.windows.forEach(row => {
        row.active = row.sessionName === secondProject.tmux.sessionName
            && row.windowName === secondProject.tmux.windowName;
    });
    projectHarness.failNextActiveWindow(new Error('query failed with private tmux details'));
    await assert.rejects(projectBackend.syncFocusedRuntime(projectHarness.terminals[1]), /query failed/);
    assert.strictEqual(projectBackend.getFocusedRuntime(projectHarness.terminals[1]).identity.sessionId, 's1',
        'query failure must preserve the last verified focus');
    const focusedBinding = projectHarness.attachBindings.get(await projectHarness.terminals[1].processId);
    assert.strictEqual(focusedBinding.windowName, secondProject.tmux.windowName);
    await projectBackend.detach(firstProject);
    projectHarness.failNextShow();
    await assert.rejects(projectBackend.focus(firstProject), /show failed/);
    assert.strictEqual(projectBackend.getActive().length, 2,
        'an attach show failure does not remove the provider runtime');
    assert.strictEqual(projectHarness.operations.filter(item =>
        item.type === 'new-session' || item.type === 'new-window').length, providerCreateCount,
    'an attach show failure must not resend the provider command');
    await projectBackend.focus(firstProject);
    assert.strictEqual(projectHarness.operations.filter(item =>
        item.type === 'new-session' || item.type === 'new-window').length, providerCreateCount);
    const projectManagedRows = projectHarness.windows.filter(row => row.windowMetadata.provider);
    assert.strictEqual(projectManagedRows.length, 2);
    assert.deepStrictEqual(projectManagedRows[0].sessionMetadata, {
        managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'pk',
    });
    assert.deepStrictEqual(projectManagedRows[0].windowMetadata, {
        managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'pk',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: '["/work"]', cwd: '/work',
        provider: 'codex', sessionId: 's1',
        createdAt: '2026-07-18T10:00:00.000Z', marker: '/tmp/m1',
    });
    assert.ok(projectHarness.operations.findIndex(item => item.type === 'availability')
        < projectHarness.operations.findIndex(item => item.type === 'lock'));

    const concurrentProjectHarness = createTmuxBackendHarness({ concurrentProjectBootstrap: true });
    const concurrentProjectBackendA = new backendModule.TmuxRuntimeBackend(concurrentProjectHarness.dependencies);
    const concurrentProjectBackendB = new backendModule.TmuxRuntimeBackend(concurrentProjectHarness.dependencies);
    await Promise.all([
        concurrentProjectBackendA.ensureResume({
            identity: { provider: 'codex', workspaceScopeIdentity: 'concurrent', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'a' },
            projectName: 'App', terminalName: 'AI Sessions: Concurrent',
            launch: { executable: 'codex', args: ['resume', 'a'] },
        }, 'project'),
        concurrentProjectBackendB.ensureResume({
            identity: { provider: 'claude', workspaceScopeIdentity: 'concurrent', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'b' },
            projectName: 'App', terminalName: 'AI Sessions: Concurrent',
            launch: { executable: 'claude', args: ['--resume', 'b'] },
        }, 'project'),
    ]);
    assert.strictEqual(concurrentProjectHarness.operations.filter(item => item.type === 'new-session').length, 1);
    assert.strictEqual(concurrentProjectHarness.operations.filter(item => item.type === 'new-window').length, 2);

    const projectOwnershipHarness = createTmuxBackendHarness();
    const requestedOwnershipIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'requested-project', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'requested-session',
    };
    const requestedOwnershipLocator = tmuxNaming.buildReadableTmuxLocator(
        requestedOwnershipIdentity, 'project', {
            projectName: 'App', sessionName: 'requested-session',
        }
    );
    const wrongOwnershipRuntime = {
        identity: { provider: 'claude', workspaceScopeIdentity: 'different-project', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'other-session' },
        backend: 'tmux', state: 'active', markerPath: '', runStartedAtMs: 0, attached: false,
        tmux: {
            layout: 'project', sessionName: requestedOwnershipLocator.sessionName, windowName: 'ai-claude-other',
        },
    };
    projectOwnershipHarness.windows.push({
        sessionName: requestedOwnershipLocator.sessionName,
        windowName: 'ai-claude-other', windowId: '@hash-collision', active: true,
        sessionMetadata: {
            managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'different-project',
        },
        windowMetadata: {
            managed: '1', version: '2', layout: 'project', provider: 'claude', sessionId: 'other-session',
        },
        metadata: {},
    });
    const wrongOwnershipDiscovery = {
        refresh: async () => undefined,
        find: () => [],
        getActive: () => [wrongOwnershipRuntime],
        getPending: () => [],
    };
    const projectOwnershipBackend = new backendModule.TmuxRuntimeBackend({
        ...projectOwnershipHarness.dependencies,
        discovery: wrongOwnershipDiscovery,
    });
    await assert.rejects(projectOwnershipBackend.ensureResume({
        identity: requestedOwnershipIdentity,
        projectName: 'App', terminalName: 'AI Sessions: Ownership',
        launch: { executable: 'codex', args: ['resume', 'requested-session'] },
    }, 'project'), /occupied.*unverified/i);
    assert.strictEqual(projectOwnershipHarness.operations.some(item => item.type === 'new-window'), false);
    assert.strictEqual(projectOwnershipHarness.operations.some(item => item.type === 'session-options'), false);

    const lifecycleAckHarness = createTmuxBackendHarness();
    const lifecycleAckIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'lifecycle-ack', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'ack-then-resume',
    };
    let lifecycleAckBlockers = [{
        identity: { ...lifecycleAckIdentity }, backend: 'tmux', state: 'completed',
        markerPath: '/tmp/ack-then-resume.done', runStartedAtMs: 100,
        attached: false,
        tmux: new tmuxLayout.SessionTmuxLayout().getLocator(lifecycleAckIdentity),
    }];
    lifecycleAckHarness.dependencies.discovery.getInactive = () => lifecycleAckBlockers.map(runtime => ({
        ...runtime, identity: { ...runtime.identity }, tmux: { ...runtime.tmux },
    }));
    const lifecycleAckBackend = new backendModule.TmuxRuntimeBackend(
        lifecycleAckHarness.dependencies
    );
    const lifecycleAckRequest = {
        identity: lifecycleAckIdentity, projectName: 'Lifecycle', terminalName: 'Lifecycle',
        launch: { executable: 'codex', args: ['resume'], markerPath: '/tmp/ack-then-resume.done' },
    };
    await assert.rejects(lifecycleAckBackend.ensureResume(lifecycleAckRequest, 'session'),
        error => error && error.name === 'AiSessionRuntimeLifecycleBlockedError');
    assert.strictEqual(lifecycleAckHarness.operations.some(item => item.type === 'new-session'), false);
    lifecycleAckBlockers = [{
        ...lifecycleAckBlockers[0],
        identity: { ...lifecycleAckBlockers[0].identity, workspaceScopeIdentity: 'other-scope' },
    }];
    await lifecycleAckBackend.ensureResume(lifecycleAckRequest, 'session');
    assert.strictEqual(lifecycleAckHarness.operations.filter(item => item.type === 'new-session').length, 1,
        'a lifecycle blocker in another workspace scope must not block this scope');
    lifecycleAckBlockers = [];
    await lifecycleAckBackend.ensureResume(lifecycleAckRequest, 'session');
    assert.strictEqual(lifecycleAckHarness.operations.filter(item => item.type === 'new-session').length, 1);
    assert.ok(lifecycleAckHarness.known.has('codex:ack-then-resume'),
        'acknowledgement removal allows resume and persists the new known runtime');

    const sessionHarness = createTmuxBackendHarness();
    const sessionBackend = new backendModule.TmuxRuntimeBackend(sessionHarness.dependencies);
    await sessionBackend.ensureResume({
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        projectName: 'RedDB DTS Dual Active', sessionName: 'Repair replication', terminalName: 'Codex: s1',
        launch: { executable: 'codex', args: ['resume', 's1'], markerPath: '/tmp/s1' },
    }, 'session');
    await sessionBackend.ensureResume({
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's2' },
        projectName: 'RedDB DTS Dual Active', sessionName: 'Audit failover', terminalName: 'Codex: s2',
        launch: { executable: 'codex', args: ['resume', 's2'], markerPath: '/tmp/s2' },
    }, 'session');
    assert.strictEqual(sessionHarness.operations.filter(item => item.type === 'new-session').length, 2);
    assert.strictEqual(sessionHarness.operations.filter(item => item.type === 'new-window').length, 0);
    const firstSessionCreate = sessionHarness.operations.find(item => item.type === 'new-session');
    assert.match(firstSessionCreate.sessionName,
        /^ps-RedDB-DTS-Dual-Active-Repair-replication-[0-9a-f]{8}$/);
    assert.match(firstSessionCreate.windowName, /^codex-Repair-replication-[0-9a-f]{8}$/);
    assert.deepStrictEqual(sessionHarness.operations.find(item => item.type === 'configure-window'), {
        type: 'configure-window',
        sessionName: firstSessionCreate.sessionName,
        windowName: firstSessionCreate.windowName,
    });
    assert.deepStrictEqual(sessionHarness.operations.find(item => item.type === 'select-window').locator, {
        layout: 'session', sessionName: firstSessionCreate.sessionName,
        windowName: firstSessionCreate.windowName,
    }, 'session creation focus must use the actual readable window target');
    assert.strictEqual(sessionHarness.terminals.length, 2);
    assert.ok(sessionHarness.terminals.every(terminal => terminal.name.endsWith(' [tmux]')),
        'initial session-layout viewers must use the same tmux-specific naming as reattach');
    const sessionManagedRow = sessionHarness.windows[0];
    assert.deepStrictEqual(sessionManagedRow.sessionMetadata, {
        managed: '1', version: '2', layout: 'session', workspaceScopeIdentity: 'pk', provider: 'codex',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: '["/work"]', cwd: '/work',
        sessionId: 's1', createdAt: '2026-07-18T10:00:00.000Z', marker: '/tmp/s1',
    });
    assert.deepStrictEqual(sessionManagedRow.windowMetadata, {
        managed: '1', version: '2', layout: 'session',
    });

    const sessionFocusHarness = createTmuxBackendHarness();
    const sessionFocusBackend = new backendModule.TmuxRuntimeBackend(sessionFocusHarness.dependencies);
    const sessionFocusRuntime = await sessionFocusBackend.ensureResume({
        identity: { provider: 'codex', workspaceScopeIdentity: 'session-focus', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'sf1' },
        projectName: 'App', terminalName: 'Codex: sf1',
        launch: { executable: 'codex', args: ['resume', 'sf1'], markerPath: '/tmp/sf1' },
    }, 'session');
    const queryCount = sessionFocusHarness.operations.filter(item => item.type === 'get-active-window').length;
    assert.deepStrictEqual(await sessionFocusBackend.syncFocusedRuntime(sessionFocusRuntime.terminal), {
        monitored: false, changed: false, identity: { ...sessionFocusRuntime.identity },
    });
    assert.strictEqual(sessionFocusHarness.operations.filter(item => item.type === 'get-active-window').length,
        queryCount, 'session layout must remain active-terminal driven');

    const invalidPendingCases = [
        {
            label: 'invalid date',
            createdAt: 'not-a-date', excludedSessionIds: [],
        },
        {
            label: 'expired date',
            createdAt: '2026-07-17T09:59:59Z', excludedSessionIds: [],
        },
        {
            label: 'oversized exclusions',
            createdAt: '2026-07-18T09:59:00Z',
            excludedSessionIds: Array.from({ length: 1001 }, (_, index) => `s${index}`),
        },
        {
            label: 'invalid title',
            createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [], title: 'bad\ntitle',
        },
    ];
    for (const invalidCase of invalidPendingCases) {
        const invalidHarness = createTmuxBackendHarness();
        const invalidBackend = new backendModule.TmuxRuntimeBackend(invalidHarness.dependencies);
        await assert.rejects(invalidBackend.ensurePending({
            identity: {
                provider: 'codex', workspaceScopeIdentity: 'invalid-pending', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
                pendingId: invalidCase.label.replace(/ /g, '-'),
            },
            projectName: 'App', terminalName: 'Codex: Invalid',
            createdAt: invalidCase.createdAt,
            excludedSessionIds: invalidCase.excludedSessionIds,
            ...(invalidCase.title === undefined ? {} : { title: invalidCase.title }),
            launch: { executable: 'codex', args: ['new'] },
        }, 'session'), /pending runtime request/i);
        assert.strictEqual(invalidHarness.operations.some(item =>
            item.type === 'new-session' || item.type === 'new-window' || item.type === 'session-options'
            || item.type === 'window-options'), false);
    }

    const invalidLayoutHarness = createTmuxBackendHarness();
    const invalidLayoutBackend = new backendModule.TmuxRuntimeBackend(invalidLayoutHarness.dependencies);
    await assert.rejects(invalidLayoutBackend.ensureResume({
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'bad-layout' },
        projectName: 'App', terminalName: 'Codex: Invalid Layout',
        launch: { executable: 'codex', args: ['resume', 'bad-layout'] },
    }, 'invalid'), /layout/i);
    await assert.rejects(invalidLayoutBackend.ensurePending({
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'bad-layout' },
        projectName: 'App', terminalName: 'Codex: Invalid Layout',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
        launch: { executable: 'codex', args: ['new'] },
    }, 'invalid'), /layout/i);
    assert.strictEqual(invalidLayoutHarness.operations.some(item => item.type === 'new-session'), false);

    const invalidDispatchCases = [
        {
            label: 'cwd nul',
            identity: { provider: 'codex', workspaceScopeIdentity: 'invalid-dispatch', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work\0bad'], cwd: '/work\0bad', sessionId: 's1' },
            launch: { executable: 'codex', args: ['resume', 's1'] },
        },
        {
            label: 'executable nul',
            identity: { provider: 'codex', workspaceScopeIdentity: 'invalid-dispatch', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's2' },
            launch: { executable: 'codex\0bad', args: ['resume', 's2'] },
        },
        {
            label: 'argument nul',
            identity: { provider: 'codex', workspaceScopeIdentity: 'invalid-dispatch', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's3' },
            launch: { executable: 'codex', args: ['resume', 's3\0bad'] },
        },
        {
            label: 'launch cwd nul',
            identity: { provider: 'codex', workspaceScopeIdentity: 'invalid-dispatch', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's4' },
            launch: { executable: 'codex', args: ['resume', 's4'], cwd: '/work\0bad' },
        },
        {
            label: 'marker nul',
            identity: { provider: 'codex', workspaceScopeIdentity: 'invalid-dispatch', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's5' },
            launch: { executable: 'codex', args: ['resume', 's5'], markerPath: '/tmp/bad\0marker' },
        },
    ];
    for (const invalidDispatch of invalidDispatchCases) {
        const invalidDispatchHarness = createTmuxBackendHarness();
        await assert.rejects(new backendModule.TmuxRuntimeBackend(invalidDispatchHarness.dependencies).ensureResume({
            identity: invalidDispatch.identity,
            projectName: 'App', terminalName: `Codex: ${invalidDispatch.label}`,
            launch: invalidDispatch.launch,
        }, 'session'), /launch|cwd|marker|argument|executable/i);
        assert.strictEqual(invalidDispatchHarness.ambiguous.size, 0);
        assert.strictEqual(invalidDispatchHarness.operations.some(item => item.type === 'new-session'), false);
    }

    const guardedArgs = [];
    guardedArgs.length = 257;
    const oversizedArgs = new Proxy(guardedArgs, {
        get(target, property, receiver) {
            if (property === Symbol.iterator) throw new Error('args iterator accessed');
            return Reflect.get(target, property, receiver);
        },
    });
    const oversizedArgsHarness = createTmuxBackendHarness();
    await assert.rejects(new backendModule.TmuxRuntimeBackend(oversizedArgsHarness.dependencies).ensureResume({
        identity: { provider: 'codex', workspaceScopeIdentity: 'oversized-args', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'Codex: Oversized Args',
        launch: { executable: 'codex', args: oversizedArgs },
    }, 'session'), /too many provider launch arguments/);
    assert.strictEqual(oversizedArgsHarness.operations.length, 0);
    assert.strictEqual(oversizedArgsHarness.stateReadCount, 0);

    const sparseArgs = new Array(2);
    sparseArgs[1] = 's1';
    const sparseArgsHarness = createTmuxBackendHarness();
    await assert.rejects(new backendModule.TmuxRuntimeBackend(sparseArgsHarness.dependencies).ensureResume({
        identity: { provider: 'codex', workspaceScopeIdentity: 'sparse-args', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'Codex: Sparse Args',
        launch: { executable: 'codex', args: sparseArgs },
    }, 'session'), /dense provider launch arguments/);
    assert.strictEqual(sparseArgsHarness.operations.length, 0);
    assert.strictEqual(sparseArgsHarness.stateReadCount, 0);

    const guardedExclusions = [];
    guardedExclusions.length = 1001;
    const oversizedExclusions = new Proxy(guardedExclusions, {
        get(target, property, receiver) {
            if (property === Symbol.iterator) throw new Error('exclusions iterator accessed');
            return Reflect.get(target, property, receiver);
        },
    });
    const oversizedExclusionsHarness = createTmuxBackendHarness();
    await assert.rejects(new backendModule.TmuxRuntimeBackend(oversizedExclusionsHarness.dependencies).ensurePending({
        identity: {
            provider: 'kimi', workspaceScopeIdentity: 'oversized-exclusions', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'pending',
        },
        projectName: 'App', terminalName: 'Kimi: Oversized Exclusions',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: oversizedExclusions,
        launch: { executable: 'kimi', args: ['new'] },
    }, 'session'), /too many excluded session IDs/);
    assert.strictEqual(oversizedExclusionsHarness.operations.length, 0);
    assert.strictEqual(oversizedExclusionsHarness.stateReadCount, 0);

    const sparseExclusions = new Array(2);
    sparseExclusions[1] = 'old';
    const sparseExclusionsHarness = createTmuxBackendHarness();
    await assert.rejects(new backendModule.TmuxRuntimeBackend(sparseExclusionsHarness.dependencies).ensurePending({
        identity: { provider: 'kimi', workspaceScopeIdentity: 'sparse-exclusions', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'pending' },
        projectName: 'App', terminalName: 'Kimi: Sparse Exclusions',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: sparseExclusions,
        launch: { executable: 'kimi', args: ['new'] },
    }, 'session'), /dense excluded session IDs/);
    assert.strictEqual(sparseExclusionsHarness.operations.length, 0);
    assert.strictEqual(sparseExclusionsHarness.stateReadCount, 0);

    let switchingIdentityReads = 0;
    let switchingLaunchReads = 0;
    const switchingContainerHarness = createTmuxBackendHarness();
    const switchingContainerRequest = {
        get identity() {
            switchingIdentityReads++;
            return switchingIdentityReads === 1
                ? { provider: 'codex', workspaceScopeIdentity: 'single-read-container', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'stable' }
                : { provider: 'codex', workspaceScopeIdentity: 'switched-container', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/changed'], cwd: '/changed', sessionId: 'changed' };
        },
        projectName: 'App', terminalName: 'Codex: Single Read Container',
        get launch() {
            switchingLaunchReads++;
            return switchingLaunchReads === 1
                ? { executable: 'codex', args: ['resume', 'stable'], cwd: '/work' }
                : { executable: 'changed', args: ['resume', 'changed'], cwd: '/changed' };
        },
    };
    const switchingContainerRuntime = await new backendModule.TmuxRuntimeBackend(
        switchingContainerHarness.dependencies
    ).ensureResume(switchingContainerRequest, 'session');
    assert.strictEqual(switchingIdentityReads, 1);
    assert.strictEqual(switchingLaunchReads, 1);
    assert.strictEqual(switchingContainerRuntime.identity.workspaceScopeIdentity, 'single-read-container');
    assert.strictEqual(switchingContainerRuntime.identity.sessionId, 'stable');
    const switchingContainerCreate = switchingContainerHarness.operations.find(item => item.type === 'new-session');
    assert.strictEqual(switchingContainerCreate.cwd, '/work');
    assert.ok(switchingContainerCreate.command.includes('stable'));
    assert.strictEqual(switchingContainerCreate.command.includes('changed'), false);

    const siblingMutationIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'sibling-stable', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'sibling-stable',
    };
    const siblingMutationArgs = ['resume', 'sibling-stable'];
    const siblingMutationHarness = createTmuxBackendHarness();
    const siblingMutationRuntime = await new backendModule.TmuxRuntimeBackend(
        siblingMutationHarness.dependencies
    ).ensureResume({
        identity: siblingMutationIdentity,
        get projectName() {
            siblingMutationIdentity.workspaceScopeIdentity = 'sibling-mutated';
            return 'App';
        },
        terminalName: 'Codex: Sibling Mutation',
        launch: {
            executable: 'codex',
            args: siblingMutationArgs,
            get cwd() {
                siblingMutationArgs[1] = 'sibling-mutated';
                return '/work';
            },
        },
    }, 'session');
    assert.strictEqual(siblingMutationRuntime.identity.workspaceScopeIdentity, 'sibling-stable');
    const siblingMutationCreate = siblingMutationHarness.operations.find(item => item.type === 'new-session');
    assert.ok(siblingMutationCreate.command.includes('sibling-stable'));
    assert.strictEqual(siblingMutationCreate.command.includes('sibling-mutated'), false);

    let switchingLengthReads = 0;
    const switchingLengthArgs = new Proxy(['resume', 'stable-length'], {
        get(target, property, receiver) {
            if (property === 'length') {
                switchingLengthReads++;
                return switchingLengthReads === 1 ? 2 : 1_000_000_000;
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const switchingLengthHarness = createTmuxBackendHarness();
    const switchingLengthRuntime = await new backendModule.TmuxRuntimeBackend(
        switchingLengthHarness.dependencies
    ).ensureResume({
        identity: { provider: 'codex', workspaceScopeIdentity: 'single-read-length', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'stable-length' },
        projectName: 'App', terminalName: 'Codex: Single Read Length',
        launch: { executable: 'codex', args: switchingLengthArgs },
    }, 'session');
    assert.strictEqual(switchingLengthReads, 1);
    assert.strictEqual(switchingLengthRuntime.identity.sessionId, 'stable-length');
    assert.strictEqual(switchingLengthHarness.operations.filter(item => item.type === 'new-session').length, 1);

    const switchingElementReads = [0, 0];
    const switchingElementArgs = new Proxy(['resume', 'stable-element'], {
        get(target, property, receiver) {
            if (property === '0' || property === '1') {
                const index = Number(property);
                switchingElementReads[index]++;
                return switchingElementReads[index] === 1 ? target[index] : 42;
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const switchingElementHarness = createTmuxBackendHarness();
    await new backendModule.TmuxRuntimeBackend(switchingElementHarness.dependencies).ensureResume({
        identity: {
            provider: 'codex', workspaceScopeIdentity: 'single-read-element', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'stable-element',
        },
        projectName: 'App', terminalName: 'Codex: Single Read Element',
        launch: { executable: 'codex', args: switchingElementArgs },
    }, 'session');
    assert.deepStrictEqual(switchingElementReads, [1, 1]);
    const switchingElementCreate = switchingElementHarness.operations.find(item => item.type === 'new-session');
    assert.ok(switchingElementCreate.command.includes('stable-element'));

    let switchingExclusionsReads = 0;
    let switchingTitleReads = 0;
    const switchingPendingHarness = createTmuxBackendHarness();
    const switchingPendingRequest = {
        identity: {
            provider: 'kimi', workspaceScopeIdentity: 'single-read-pending', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'single-read-pending',
        },
        projectName: 'App', terminalName: 'Kimi: Single Read Pending', createdAt: '2026-07-18T09:59:00Z',
        get excludedSessionIds() {
            switchingExclusionsReads++;
            return switchingExclusionsReads === 1 ? ['stable-exclusion'] : ['changed-exclusion'];
        },
        get title() {
            switchingTitleReads++;
            return switchingTitleReads === 1 ? 'Stable title' : 'Changed title';
        },
        launch: { executable: 'kimi', args: ['new'] },
    };
    const switchingPendingRuntime = await new backendModule.TmuxRuntimeBackend(
        switchingPendingHarness.dependencies
    ).ensurePending(switchingPendingRequest, 'session');
    assert.strictEqual(switchingExclusionsReads, 1);
    assert.strictEqual(switchingTitleReads, 1);
    assert.deepStrictEqual(switchingPendingRuntime.excludedSessionIds, ['stable-exclusion']);
    assert.strictEqual(switchingPendingRuntime.title, 'Stable title');

    const launchBudgetCases = [
        { label: 'argument count', args: Array.from({ length: 257 }, () => 'x') },
        { label: 'per argument utf8', args: ['😀'.repeat(5000)] },
        { label: 'aggregate input', args: ['a'.repeat(12000), 'b'.repeat(12000), 'c'.repeat(12000)] },
        { label: 'serialized command', args: ["'".repeat(15000), "'".repeat(15000)] },
    ];
    for (const launchBudgetCase of launchBudgetCases) {
        const launchBudgetHarness = createTmuxBackendHarness();
        await assert.rejects(new backendModule.TmuxRuntimeBackend(launchBudgetHarness.dependencies).ensureResume({
            identity: {
                provider: 'codex', workspaceScopeIdentity: `budget-${launchBudgetCase.label}`, workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1',
            },
            projectName: 'App', terminalName: 'Codex: Budget',
            launch: { executable: 'codex', args: launchBudgetCase.args, markerPath: '/tmp/budget' },
        }, 'session'), /launch.*(budget|large)|argument.*(count|large)/i);
        assert.strictEqual(launchBudgetHarness.operations.length, 0);
        assert.strictEqual(launchBudgetHarness.ambiguous.size, 0);
    }

    const e2bigHarness = createTmuxBackendHarness({ failCreateSessionE2bigCount: 1 });
    const e2bigRequest = {
        identity: { provider: 'codex', workspaceScopeIdentity: 'e2big', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'Codex: E2BIG',
        launch: { executable: 'codex', args: ['resume', 's1'] },
    };
    await assert.rejects(new backendModule.TmuxRuntimeBackend(e2bigHarness.dependencies)
        .ensureResume(e2bigRequest, 'session'), /argument-list-too-long/);
    assert.strictEqual(e2bigHarness.ambiguous.size, 0);
    await new backendModule.TmuxRuntimeBackend(e2bigHarness.dependencies).ensureResume(e2bigRequest, 'session');
    assert.strictEqual(e2bigHarness.operations.filter(item => item.type === 'new-session').length, 2);

    const resumeAvailabilityGate = deferred();
    const resumeSnapshotHarness = createTmuxBackendHarness({ availabilityGate: resumeAvailabilityGate });
    const resumeSnapshotRequest = {
        identity: {
            provider: 'codex', workspaceScopeIdentity: 'snapshot-resume', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/original'], cwd: '/original', sessionId: 'original-session',
        },
        projectName: 'Original Project', sessionName: 'Original Session Name', terminalName: 'Codex: Original',
        launch: {
            executable: 'codex', args: ['resume', 'original-session'], cwd: '/original',
            markerPath: '/tmp/original-marker',
        },
    };
    const resumeSnapshotPromise = new backendModule.TmuxRuntimeBackend(resumeSnapshotHarness.dependencies)
        .ensureResume(resumeSnapshotRequest, 'session');
    resumeSnapshotRequest.identity.workspaceScopeIdentity = 'mutated-project';
    resumeSnapshotRequest.identity.cwd = '/mutated';
    resumeSnapshotRequest.identity.sessionId = 'mutated-session';
    resumeSnapshotRequest.projectName = 'Mutated Project';
    resumeSnapshotRequest.sessionName = 'Mutated Session Name';
    resumeSnapshotRequest.launch.executable = 'mutated-provider';
    resumeSnapshotRequest.launch.args[1] = 'mutated-session';
    resumeSnapshotRequest.launch.cwd = '/mutated';
    resumeSnapshotRequest.launch.markerPath = '/tmp/mutated-marker';
    resumeSnapshotRequest.terminalName = 'Codex: Mutated';
    resumeAvailabilityGate.resolve();
    const resumeSnapshotRuntime = await resumeSnapshotPromise;
    assert.strictEqual(resumeSnapshotRuntime.identity.workspaceScopeIdentity, 'snapshot-resume');
    assert.strictEqual(resumeSnapshotRuntime.identity.sessionId, 'original-session');
    assert.deepStrictEqual(resumeSnapshotRuntime.tmux,
        tmuxNaming.buildReadableTmuxLocator({
            provider: 'codex', workspaceScopeIdentity: 'snapshot-resume',
            workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/original'],
            cwd: '/original', sessionId: 'original-session',
        }, 'session', { projectName: 'Original Project', sessionName: 'Original Session Name' }),
    'resume creation must snapshot display context before awaiting availability');
    assert.match(resumeSnapshotHarness.terminals[0].name, /^Project Steward: codex .+ \[tmux\]$/);
    const resumeSnapshotCreate = resumeSnapshotHarness.operations.find(item => item.type === 'new-session');
    assert.strictEqual(resumeSnapshotCreate.cwd, '/original');
    assert.ok(resumeSnapshotCreate.command.includes('original-session'));
    assert.strictEqual(resumeSnapshotCreate.command.includes('mutated-session'), false);

    const pendingSnapshotLockEntered = deferred();
    const releasePendingSnapshotLock = deferred();
    let holdPendingSnapshotLock = true;
    const pendingSnapshotHarness = createTmuxBackendHarness({
        onLockAcquired: async () => {
            if (holdPendingSnapshotLock) {
                holdPendingSnapshotLock = false;
                pendingSnapshotLockEntered.resolve();
                await releasePendingSnapshotLock.promise;
            }
        },
    });
    const pendingSnapshotRequest = {
        identity: {
            provider: 'kimi', workspaceScopeIdentity: 'snapshot-pending', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/original'], cwd: '/original', pendingId: 'original-pending',
        },
        projectName: 'Original Project', terminalName: 'Kimi: Original',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: ['original-exclusion'], title: 'Original title',
        launch: {
            executable: 'kimi', args: ['--prompt', 'original-title'], cwd: '/original',
            markerPath: '/tmp/original-pending-marker',
        },
    };
    const pendingSnapshotPromise = new backendModule.TmuxRuntimeBackend(pendingSnapshotHarness.dependencies)
        .ensurePending(pendingSnapshotRequest, 'session');
    await pendingSnapshotLockEntered.promise;
    pendingSnapshotRequest.identity.cwd = '/mutated';
    pendingSnapshotRequest.identity.pendingId = 'mutated-pending';
    pendingSnapshotRequest.projectName = 'Mutated Project';
    pendingSnapshotRequest.launch.executable = 'mutated-provider';
    pendingSnapshotRequest.launch.args[1] = 'mutated-title';
    pendingSnapshotRequest.launch.cwd = '/mutated';
    pendingSnapshotRequest.launch.markerPath = '/tmp/mutated-pending-marker';
    pendingSnapshotRequest.excludedSessionIds[0] = 'mutated-exclusion';
    pendingSnapshotRequest.title = 'Mutated title';
    pendingSnapshotRequest.terminalName = 'Kimi: Mutated';
    releasePendingSnapshotLock.resolve();
    const pendingSnapshotRuntime = await pendingSnapshotPromise;
    assert.strictEqual(pendingSnapshotRuntime.identity.pendingId, 'original-pending');
    assert.strictEqual(pendingSnapshotRuntime.projectName, 'Original Project');
    assert.deepStrictEqual(pendingSnapshotRuntime.excludedSessionIds, ['original-exclusion']);
    assert.strictEqual(pendingSnapshotRuntime.title, 'Original title');
    assert.match(pendingSnapshotHarness.terminals[0].name, /^Project Steward: kimi .+ \[tmux\]$/);
    const pendingSnapshotCreate = pendingSnapshotHarness.operations.find(item => item.type === 'new-session');
    assert.strictEqual(pendingSnapshotCreate.cwd, '/original');
    assert.ok(pendingSnapshotCreate.command.includes('original-title'));
    assert.strictEqual(pendingSnapshotCreate.command.includes('mutated-title'), false);

    const basePendingNow = Date.parse('2026-07-18T10:00:00Z');
    const futurePendingHarness = createTmuxBackendHarness({ nowMs: () => basePendingNow });
    await assert.rejects(new backendModule.TmuxRuntimeBackend(futurePendingHarness.dependencies).ensurePending({
        identity: { provider: 'codex', workspaceScopeIdentity: 'future', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'future-pending' },
        projectName: 'App', terminalName: 'Codex: Future',
        createdAt: '2026-07-18T10:05:01Z', excludedSessionIds: [],
        launch: { executable: 'codex', args: ['new'] },
    }, 'session'), /invalid or expired/);
    assert.strictEqual(futurePendingHarness.operations.some(item => item.type === 'new-session'), false);

    let lockExpiryNow = basePendingNow;
    let advancedAtLock = false;
    const lockExpiryHarness = createTmuxBackendHarness({
        nowMs: () => lockExpiryNow,
        onLockAcquired: async () => {
            if (!advancedAtLock) {
                advancedAtLock = true;
                lockExpiryNow += 2000;
            }
        },
    });
    await assert.rejects(new backendModule.TmuxRuntimeBackend(lockExpiryHarness.dependencies).ensurePending({
        identity: { provider: 'codex', workspaceScopeIdentity: 'lock-expiry', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'lock-expiry' },
        projectName: 'App', terminalName: 'Codex: Lock Expiry',
        createdAt: '2026-07-17T10:00:01Z', excludedSessionIds: [],
        launch: { executable: 'codex', args: ['new'] },
    }, 'session'), /expired before provider dispatch/);
    assert.strictEqual(lockExpiryHarness.operations.some(item => item.type === 'new-session'), false);
    assert.strictEqual(lockExpiryHarness.ambiguous.size, 0);

    let acceptedNow = basePendingNow;
    const acceptedHarness = createTmuxBackendHarness({
        nowMs: () => acceptedNow,
        afterProviderCreate: async () => { acceptedNow += 2000; },
    });
    const acceptedRequest = {
        identity: { provider: 'kimi', workspaceScopeIdentity: 'accepted', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'accepted-pending' },
        projectName: 'App', terminalName: 'Kimi: Accepted',
        createdAt: '2026-07-17T10:00:01Z', excludedSessionIds: [],
        launch: { executable: 'kimi', args: ['new'] },
    };
    await new backendModule.TmuxRuntimeBackend(acceptedHarness.dependencies)
        .ensurePending(acceptedRequest, 'session');
    assert.strictEqual(Array.from(acceptedHarness.pending.values())[0].acceptedAtMs, basePendingNow);

    const concurrentGlobalHarness = createTmuxBackendHarness();
    const concurrentPendingId = 'concurrent-global-pending';
    const concurrentGlobalRequests = [
        {
            identity: {
                provider: 'codex', workspaceScopeIdentity: 'concurrent-global-a', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work-a'], cwd: '/work-a',
                pendingId: concurrentPendingId,
            },
            projectName: 'App A', terminalName: 'Codex: Concurrent Global A',
            createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
            launch: { executable: 'codex', args: ['new'], cwd: '/work-a' },
        },
        {
            identity: {
                provider: 'codex', workspaceScopeIdentity: 'concurrent-global-b', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work-b'], cwd: '/work-b',
                pendingId: concurrentPendingId,
            },
            projectName: 'App B', terminalName: 'Codex: Concurrent Global B',
            createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
            launch: { executable: 'codex', args: ['new'], cwd: '/work-b' },
        },
    ];
    const concurrentGlobalResults = await Promise.allSettled(concurrentGlobalRequests.map(request =>
        new backendModule.TmuxRuntimeBackend(concurrentGlobalHarness.dependencies)
            .ensurePending(request, 'session')));
    assert.strictEqual(concurrentGlobalResults.filter(result => result.status === 'fulfilled').length, 2);
    assert.strictEqual(concurrentGlobalHarness.operations.filter(item => item.type === 'new-session').length, 2);
    assert.strictEqual(concurrentGlobalHarness.pending.size, 2);
    for (const request of concurrentGlobalRequests) {
        assert.ok(concurrentGlobalHarness.operations.some(item => item.type === 'lock'
            && item.key === `pending:${tmuxLayout.getTmuxRuntimeKey(request.identity)}`));
        const binding = Array.from(concurrentGlobalHarness.pending.values()).find(record =>
            record.provider === request.identity.provider
            && record.workspaceScopeIdentity === request.identity.workspaceScopeIdentity);
        assert.ok(binding);
        assert.strictEqual(binding.cwd, request.identity.cwd);
    }
    const concurrentBackend = new backendModule.TmuxRuntimeBackend(concurrentGlobalHarness.dependencies);
    const promotedScopedPending = await concurrentBackend.promotePending(
        concurrentGlobalRequests[0].identity, 'concurrent-final-a', 'Concurrent Final A'
    );
    assert.strictEqual(promotedScopedPending.length, 1);
    assert.strictEqual(promotedScopedPending[0].identity.workspaceScopeIdentity, 'concurrent-global-a');
    assert.strictEqual(concurrentGlobalHarness.pending.size, 1);
    assert.strictEqual(Array.from(concurrentGlobalHarness.pending.values())[0].workspaceScopeIdentity,
        'concurrent-global-b');

    const pendingHarness = createTmuxBackendHarness();
    const pendingBackend = new backendModule.TmuxRuntimeBackend(pendingHarness.dependencies);
    const pendingRequest = {
        identity: { provider: 'claude', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'pending-1' },
        projectName: 'RedDB DTS Dual Active', terminalName: 'Claude: New',
        createdAt: '2026-07-18T09:59:00Z',
        excludedSessionIds: ['old'],
        title: 'Investigate lag',
        launch: { executable: 'claude', args: ['--name', 'Investigate lag'], markerPath: '/tmp/pending' },
    };
    const pendingRuntime = await pendingBackend.ensurePending(pendingRequest, 'session');
    assert.strictEqual(pendingRuntime.projectName, 'RedDB DTS Dual Active');
    assert.match(pendingRuntime.tmux.sessionName,
        /^ps-RedDB-DTS-Dual-Active-Investigate-lag-[0-9a-f]{8}$/);
    assert.match(pendingRuntime.tmux.windowName, /^claude-Investigate-lag-[0-9a-f]{8}$/);
    const pendingSessionReadIndex = pendingHarness.operations.findIndex(item => item.type === 'get-session-options');
    const pendingWindowReadIndex = pendingHarness.operations.findIndex(item => item.type === 'get-window-options');
    const pendingStoreIndex = pendingHarness.operations.findIndex(item => item.type === 'store-pending');
    assert.ok(pendingSessionReadIndex >= 0 && pendingSessionReadIndex < pendingStoreIndex);
    assert.ok(pendingWindowReadIndex >= 0 && pendingWindowReadIndex < pendingStoreIndex);
    assert.strictEqual(pendingBackend.getPending().length, 1);
    assert.strictEqual(pendingBackend.getPending()[0].projectName, 'RedDB DTS Dual Active');
    const fallbackPendingHarness = createTmuxBackendHarness();
    const fallbackPending = await new backendModule.TmuxRuntimeBackend(
        fallbackPendingHarness.dependencies
    ).ensurePending({
        identity: {
            provider: 'codex', workspaceScopeIdentity: 'fallback-pending',
            workspaceNavigationIdentity: 'nav-fallback-pending', workspaceRootHostPaths: ['/work'],
            cwd: '/work', pendingId: 'fallback-pending-id',
        },
        projectName: 'RedDB DTS Dual Active', terminalName: 'Codex: New',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [], title: '   ',
        launch: { executable: 'codex', args: ['new'] },
    }, 'project');
    assert.match(fallbackPending.tmux.sessionName,
        /^ps-RedDB-DTS-Dual-Active-[0-9a-f]{8}$/);
    assert.match(fallbackPending.tmux.windowName, /^codex-new-session-[0-9a-f]{8}$/);

    const readableRecoveryHarness = createTmuxBackendHarness({ failSetPendingCount: 1 });
    const readableRecoveryRequest = {
        identity: {
            provider: 'kimi', workspaceScopeIdentity: 'readable-pending-recovery',
            workspaceNavigationIdentity: 'nav-readable-pending-recovery',
            workspaceRootHostPaths: ['/work'], cwd: '/work',
            pendingId: 'readable-pending-recovery-id',
        },
        projectName: 'Original Card', terminalName: 'Kimi: Recover Readable',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: ['old'], title: 'Recover lag',
        launch: { executable: 'kimi', args: ['new'], markerPath: '/tmp/readable-recovery' },
    };
    await assert.rejects(new backendModule.TmuxRuntimeBackend(
        readableRecoveryHarness.dependencies
    ).ensurePending(readableRecoveryRequest, 'session'), /pending persistence failed/);
    const readableRecoveryAmbiguous = Array.from(readableRecoveryHarness.ambiguous.values())[0];
    assert.strictEqual(readableRecoveryAmbiguous.projectName, 'Original Card');
    const recoveredReadablePending = await new backendModule.TmuxRuntimeBackend(
        readableRecoveryHarness.dependencies
    ).ensurePending({ ...readableRecoveryRequest, projectName: 'Renamed Card' }, 'session');
    assert.strictEqual(recoveredReadablePending.projectName, 'Original Card');
    assert.deepStrictEqual(recoveredReadablePending.tmux,
        tmuxNaming.buildReadableTmuxLocator(readableRecoveryRequest.identity, 'session', {
            projectName: 'Original Card', sessionName: 'Recover lag',
        }), 'ambiguous retry must reuse the accepted creation-time readable locator');
    assert.strictEqual(readableRecoveryHarness.operations.filter(item =>
        item.type === 'new-session').length, 1,
    'display-only card changes must not redispatch an ambiguous provider request');

    const renameCountBeforeInvalidPromotion = pendingHarness.operations.filter(item =>
        item.type === 'rename-session' || item.type === 'rename-window').length;
    assert.deepStrictEqual(await pendingBackend.promotePending(
        pendingRequest.identity, 'final-1', ''
    ), []);
    assert.strictEqual(pendingHarness.operations.filter(item =>
        item.type === 'rename-session' || item.type === 'rename-window').length,
    renameCountBeforeInvalidPromotion);
    const promoted = await pendingBackend.promotePending(
        pendingRequest.identity, 'final-1', 'New work'
    );
    assert.strictEqual(promoted.length, 1);
    assert.strictEqual(promoted[0].identity.sessionId, 'final-1');
    assert.match(promoted[0].tmux.sessionName,
        /^ps-RedDB-DTS-Dual-Active-New-work-[0-9a-f]{8}$/);
    assert.match(promoted[0].tmux.windowName, /^claude-New-work-[0-9a-f]{8}$/);
    assert.strictEqual(pendingHarness.pending.size, 0);
    assert.strictEqual(pendingHarness.consumed.size, 1);
    assert.ok(pendingHarness.known.has('claude:final-1'));
    assert.deepStrictEqual(pendingHarness.known.get('claude:final-1').locator, promoted[0].tmux);
    assert.deepStrictEqual(Array.from(pendingHarness.consumed.values())[0].finalLocator,
        promoted[0].tmux);
    const promotedAttachBinding = pendingHarness.attachBindings.get(await pendingRuntime.terminal.processId);
    assert.strictEqual(promotedAttachBinding.sessionName, promoted[0].tmux.sessionName);
    assert.strictEqual(promotedAttachBinding.windowName, promoted[0].tmux.windowName);
    assert.strictEqual(promotedAttachBinding.sessionId, 'final-1');
    assert.strictEqual(pendingHarness.operations.filter(item => item.type === 'clear-pending').length, 1);
    assert.strictEqual(pendingHarness.operations.filter(item => item.type === 'rename-session').length, 1);
    assert.strictEqual(pendingHarness.operations.filter(item => item.type === 'rename-window').length, 1);
    assert.strictEqual(pendingHarness.operations.filter(item => item.type === 'new-session').length, 1);
    assert.ok(pendingHarness.operations.findIndex(item => item.type === 'store-promoting')
        < pendingHarness.operations.findIndex(item => item.type === 'rename-session'));
    assert.ok(pendingHarness.operations.findIndex(item => item.type === 'rename-session')
        < pendingHarness.operations.findIndex(item => item.type === 'clear-pending'));
    assert.notStrictEqual(promoted[0].tmux.sessionName, pendingRuntime.tmux.sessionName);
    assert.ok(pendingHarness.operations.findIndex(item => item.type === 'store-known'
        && item.sessionId === 'final-1') < pendingHarness.operations.findIndex(item => item.type === 'remove-pending'));
    assert.ok(pendingHarness.operations.findIndex(item => item.type === 'store-consumed')
        < pendingHarness.operations.findIndex(item => item.type === 'remove-pending'));
    assert.ok(pendingHarness.operations.some(item => item.type === 'lock' && item.key === tmuxLayout.getTmuxRuntimeKey({
        provider: 'claude', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'final-1',
    })));
    assert.ok(pendingHarness.operations.some(item =>
        item.type === 'lock' && item.key === `pending:${tmuxLayout.getTmuxRuntimeKey(pendingRequest.identity)}`));
    const pendingCreateCount = pendingHarness.operations.filter(item => item.type === 'new-session').length;
    await assert.rejects(
        new backendModule.TmuxRuntimeBackend(pendingHarness.dependencies).ensurePending(pendingRequest, 'session'),
        /already consumed/
    );
    assert.strictEqual(pendingHarness.operations.filter(item => item.type === 'new-session').length,
        pendingCreateCount);

    const corruptPendingHarness = createTmuxBackendHarness({ corruptPendingMetadata: true });
    await assert.rejects(new backendModule.TmuxRuntimeBackend(corruptPendingHarness.dependencies).ensurePending({
        identity: { provider: 'codex', workspaceScopeIdentity: 'corrupt', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'corrupt-pending' },
        projectName: 'App', terminalName: 'Codex: Corrupt',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
        launch: { executable: 'codex', args: ['new'] },
    }, 'session'), /metadata.*verified/i);
    assert.strictEqual(corruptPendingHarness.pending.size, 0);
    assert.strictEqual(corruptPendingHarness.ambiguous.size, 1);
    assert.strictEqual(corruptPendingHarness.operations.filter(item => item.type === 'new-session').length, 1);

    const pendingRecoveryHarness = createTmuxBackendHarness({ failSetPendingCount: 1 });
    const pendingRecoveryRequest = {
        identity: {
            provider: 'kimi', workspaceScopeIdentity: 'pending-recovery', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'recover-pending',
        },
        projectName: 'App', terminalName: 'Kimi: Recover',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: ['old'], title: 'Recover',
        launch: { executable: 'kimi', args: ['new'], markerPath: '/tmp/recover-pending' },
    };
    await assert.rejects(
        new backendModule.TmuxRuntimeBackend(pendingRecoveryHarness.dependencies)
            .ensurePending(pendingRecoveryRequest, 'session'),
        /pending persistence failed/
    );
    assert.strictEqual(pendingRecoveryHarness.pending.size, 0);
    assert.strictEqual(pendingRecoveryHarness.ambiguous.size, 1);
    await assert.rejects(
        new backendModule.TmuxRuntimeBackend(pendingRecoveryHarness.dependencies).ensurePending({
            ...pendingRecoveryRequest, title: 'Different',
        }, 'session'),
        /ambiguous|request/i
    );
    const recoveredPendingRuntime = await new backendModule.TmuxRuntimeBackend(pendingRecoveryHarness.dependencies)
        .ensurePending({
            ...pendingRecoveryRequest,
            projectName: 'Renamed Workspace Card',
        }, 'session');
    assert.strictEqual(recoveredPendingRuntime.identity.pendingId, 'recover-pending');
    assert.strictEqual(recoveredPendingRuntime.projectName, 'App',
        'ambiguous retries must retain the accepted creation-time project display context');
    assert.deepStrictEqual(recoveredPendingRuntime.tmux,
        tmuxNaming.buildReadableTmuxLocator(pendingRecoveryRequest.identity, 'session', {
            projectName: 'App', sessionName: 'Recover',
        }), 'ambiguous retries must recover the creation-time locator after a card rename');
    assert.strictEqual(pendingRecoveryHarness.pending.size, 1);
    assert.strictEqual(pendingRecoveryHarness.ambiguous.size, 0);
    assert.strictEqual(pendingRecoveryHarness.operations.filter(item => item.type === 'new-session').length, 1);

    const projectPromotionHarness = createTmuxBackendHarness();
    const projectPromotionBackend = new backendModule.TmuxRuntimeBackend(projectPromotionHarness.dependencies);
    const projectPending = await projectPromotionBackend.ensurePending({
        identity: {
            provider: 'kimi', workspaceScopeIdentity: 'project-promotion', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'project-pending',
        },
        projectName: 'App', terminalName: 'AI Sessions: Project Promotion',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
        launch: { executable: 'kimi', args: ['new'], markerPath: '/tmp/project-pending' },
    }, 'project');
    const projectPromotionTerminal = projectPending.terminal;
    assert.strictEqual(projectPromotionBackend.getFocusedRuntime(projectPromotionTerminal)
        .identity.pendingId, 'project-pending');
    const deferredPromotionQuery = projectPromotionHarness.deferNextActiveWindow();
    const stalePromotionSync = projectPromotionBackend.syncFocusedRuntime(projectPromotionTerminal);
    const projectPromoted = await projectPromotionBackend.promotePending(
        projectPending.identity, 'project-final', 'Project Final'
    );
    deferredPromotionQuery.resolve();
    assert.deepStrictEqual(await stalePromotionSync, {
        monitored: true, changed: false, identity: { ...projectPromoted[0].identity },
    }, 'a query superseded by promotion must not report a stale change');
    assert.strictEqual(projectPromotionBackend.getFocusedRuntime(projectPromotionTerminal)
        .identity.sessionId, 'project-final',
        'a query superseded by promotion must not overwrite the promoted runtime');
    assert.strictEqual(projectPromotionHarness.attachBindings.get(await projectPromotionTerminal.processId)
        .windowName, projectPromoted[0].tmux.windowName);
    assert.strictEqual(projectPromoted.length, 1);
    assert.strictEqual(projectPromoted[0].identity.sessionId, 'project-final');
    assert.strictEqual(projectPromoted[0].tmux.sessionName, projectPending.tmux.sessionName,
        'project promotion must retain its creation-time project container');
    assert.match(projectPromoted[0].tmux.windowName,
        /^kimi-Project-Final-[0-9a-f]{8}$/);
    assert.strictEqual(projectPromotionHarness.operations.filter(item => item.type === 'rename-window').length, 1);
    assert.strictEqual(projectPromotionHarness.operations.filter(item => item.type === 'rename-session').length, 0);
    assert.strictEqual(projectPromotionHarness.operations.filter(item => item.type === 'clear-pending').length, 1);
    assert.strictEqual(projectPromotionHarness.pending.size, 0);
    assert.strictEqual(projectPromotionHarness.consumed.size, 1);
    assert.deepStrictEqual(projectPromotionHarness.known.get('kimi:project-final').locator,
        projectPromoted[0].tmux);
    assert.deepStrictEqual(Array.from(projectPromotionHarness.consumed.values())[0].finalLocator,
        projectPromoted[0].tmux);

    for (const recoveryLayout of ['session', 'project']) {
        const recoveryHarness = createTmuxBackendHarness({ failSetConsumedCount: 1 });
        const recoveryRequest = {
            identity: {
                provider: 'claude', workspaceScopeIdentity: `promotion-recovery-${recoveryLayout}`, workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
                pendingId: `promotion-recovery-pending-${recoveryLayout}`,
            },
            projectName: 'App', terminalName: `Claude: Promotion Recovery ${recoveryLayout}`,
            createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: ['prior'], title: 'Recover promotion',
            launch: { executable: 'claude', args: ['new'], markerPath: `/tmp/recovery-${recoveryLayout}` },
        };
        const recoveryBackend = new backendModule.TmuxRuntimeBackend(recoveryHarness.dependencies);
        await recoveryBackend.ensurePending(recoveryRequest, recoveryLayout);
        await assert.rejects(recoveryBackend.promotePending(
            recoveryRequest.identity,
            `promotion-recovery-final-${recoveryLayout}`,
            'Recover promotion'
        ), /consumed persistence failed/);
        assert.strictEqual(recoveryHarness.promoting.size, 1);
        assert.strictEqual(recoveryHarness.pending.size, 1);
        assert.strictEqual(recoveryHarness.consumed.size, 0);
        const recoveryIntent = Array.from(recoveryHarness.promoting.values())[0];
        assert.strictEqual(recoveryIntent.finalSessionName, 'Recover promotion');
        assert.deepStrictEqual(recoveryIntent.finalLocator,
            tmuxNaming.buildReadableTmuxLocator({
                ...recoveryRequest.identity,
                pendingId: undefined,
                sessionId: `promotion-recovery-final-${recoveryLayout}`,
            }, recoveryLayout, {
                projectName: 'App', sessionName: 'Recover promotion',
            }));
        const createCountBeforeBlockedEnsure = recoveryHarness.operations.filter(item =>
            item.type === 'new-session' || item.type === 'new-window').length;
        await assert.rejects(
            new backendModule.TmuxRuntimeBackend(recoveryHarness.dependencies)
                .ensurePending(recoveryRequest, recoveryLayout),
            /promotion.*progress/i
        );
        assert.strictEqual(recoveryHarness.operations.filter(item =>
            item.type === 'new-session' || item.type === 'new-window').length, createCountBeforeBlockedEnsure);
        const availabilityBeforeRecoveredPromotion = recoveryHarness.operations.filter(item =>
            item.type === 'availability').length;
        const recoveredPromotion = await new backendModule.TmuxRuntimeBackend(recoveryHarness.dependencies)
            .promotePending(
                recoveryRequest.identity,
                `promotion-recovery-final-${recoveryLayout}`,
                'Recover promotion'
            );
        assert.strictEqual(recoveredPromotion.length, 1);
        assert.strictEqual(recoveryHarness.operations.filter(item =>
            item.type === 'availability').length, availabilityBeforeRecoveredPromotion + 1);
        assert.strictEqual(recoveryHarness.promoting.size, 0);
        assert.strictEqual(recoveryHarness.pending.size, 0);
        assert.strictEqual(recoveryHarness.consumed.size, 1);
        assert.strictEqual(recoveryHarness.operations.filter(item =>
            item.type === 'rename-session' || item.type === 'rename-window').length,
        recoveryLayout === 'session' ? 2 : 1);
        assert.strictEqual(recoveryHarness.operations.filter(item =>
            item.type === 'new-session' || item.type === 'new-window').length,
        createCountBeforeBlockedEnsure);
    }

    for (const ambiguousPromotionLayout of ['session', 'project']) {
        const ambiguousPromotionHarness = createTmuxBackendHarness({
            ...(ambiguousPromotionLayout === 'session'
                ? { ambiguousRenameSessionCount: 1 }
                : { ambiguousRenameWindowCount: 1 }),
        });
        const ambiguousPromotionRequest = {
            identity: {
                provider: 'kimi', workspaceScopeIdentity: `ambiguous-promotion-${ambiguousPromotionLayout}`, workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
                pendingId: `ambiguous-promotion-pending-${ambiguousPromotionLayout}`,
            },
            projectName: 'App', terminalName: `Kimi: Ambiguous Promotion ${ambiguousPromotionLayout}`,
            createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
            launch: { executable: 'kimi', args: ['new'], markerPath: '/tmp/ambiguous-promotion' },
        };
        const ambiguousPromotionBackend = new backendModule.TmuxRuntimeBackend(
            ambiguousPromotionHarness.dependencies
        );
        await ambiguousPromotionBackend.ensurePending(ambiguousPromotionRequest, ambiguousPromotionLayout);
        await assert.rejects(ambiguousPromotionBackend.promotePending(
            ambiguousPromotionRequest.identity,
            `ambiguous-promotion-final-${ambiguousPromotionLayout}`,
            'Ambiguous promotion'
        ), /timeout/);
        assert.strictEqual(ambiguousPromotionHarness.promoting.size, 1);
        assert.strictEqual(ambiguousPromotionHarness.pending.size, 1);
        const recoveredAmbiguousPromotion = await new backendModule.TmuxRuntimeBackend(
            ambiguousPromotionHarness.dependencies
        ).promotePending(
            ambiguousPromotionRequest.identity,
            `ambiguous-promotion-final-${ambiguousPromotionLayout}`,
            'Ambiguous promotion'
        );
        assert.strictEqual(recoveredAmbiguousPromotion.length, 1);
        assert.strictEqual(ambiguousPromotionHarness.promoting.size, 0);
        assert.strictEqual(ambiguousPromotionHarness.pending.size, 0);
        assert.strictEqual(ambiguousPromotionHarness.consumed.size, 1);
        assert.strictEqual(ambiguousPromotionHarness.operations.filter(item =>
            item.type === 'rename-session' || item.type === 'rename-window').length,
        ambiguousPromotionLayout === 'session' ? 2 : 1);
    }

    const fullyRenamedHarness = createTmuxBackendHarness({ ambiguousRenameWindowCount: 1 });
    const fullyRenamedRequest = {
        identity: {
            provider: 'claude', workspaceScopeIdentity: 'fully-renamed-promotion',
            workspaceNavigationIdentity: 'nav-fully-renamed-promotion',
            workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'fully-renamed-pending',
        },
        projectName: 'RedDB', terminalName: 'Claude: Fully renamed promotion',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [], title: 'Investigate replication',
        launch: { executable: 'claude', args: ['new'], markerPath: '/tmp/fully-renamed' },
    };
    const fullyRenamedBackend = new backendModule.TmuxRuntimeBackend(fullyRenamedHarness.dependencies);
    await fullyRenamedBackend.ensurePending(fullyRenamedRequest, 'session');
    const fullyRenamedCreates = fullyRenamedHarness.operations.filter(item =>
        item.type === 'new-session' || item.type === 'new-window').length;
    await assert.rejects(fullyRenamedBackend.promotePending(
        fullyRenamedRequest.identity, 'fully-renamed-final', 'Investigate replication'
    ), /timeout/);
    const fullyRenamedIntent = Array.from(fullyRenamedHarness.promoting.values())[0];
    assert.ok(fullyRenamedHarness.windows.some(row =>
        row.sessionName === fullyRenamedIntent.finalLocator.sessionName
        && row.windowName === fullyRenamedIntent.finalLocator.windowName),
    'an ambiguous second rename must leave an exact fully-renamed state for recovery');
    const fullyRenamedRecovered = await promoteWithRestartedCoordinator(
        fullyRenamedHarness, fullyRenamedRequest.identity,
        'fully-renamed-final', 'Investigate replication'
    );
    assert.deepStrictEqual(fullyRenamedRecovered[0].tmux, fullyRenamedIntent.finalLocator);
    assert.strictEqual(fullyRenamedHarness.operations.filter(item =>
        item.type === 'rename-session' || item.type === 'rename-window').length, 2);
    assert.strictEqual(fullyRenamedHarness.operations.filter(item =>
        item.type === 'new-session' || item.type === 'new-window').length, fullyRenamedCreates);

    const partialRenameHarness = createTmuxBackendHarness({ failRenameWindowCount: 1 });
    const partialRenameRequest = {
        identity: {
            provider: 'codex', workspaceScopeIdentity: 'partial-readable-promotion',
            workspaceNavigationIdentity: 'nav-partial-readable-promotion',
            workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'partial-readable-pending',
        },
        projectName: 'RedDB', terminalName: 'Codex: Partial readable promotion',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [], title: 'Repair replication',
        launch: { executable: 'codex', args: ['new'], markerPath: '/tmp/partial-readable' },
    };
    const partialRenameBackend = new backendModule.TmuxRuntimeBackend(partialRenameHarness.dependencies);
    await partialRenameBackend.ensurePending(partialRenameRequest, 'session');
    const partialRenameCreates = partialRenameHarness.operations.filter(item =>
        item.type === 'new-session' || item.type === 'new-window').length;
    await assert.rejects(partialRenameBackend.promotePending(
        partialRenameRequest.identity, 'partial-readable-final', 'Repair replication'
    ), /rename window failed/);
    const partialIntent = Array.from(partialRenameHarness.promoting.values())[0];
    assert.strictEqual(partialIntent.finalSessionName, 'Repair replication');
    assert.ok(partialRenameHarness.windows.some(row =>
        row.sessionName === partialIntent.finalLocator.sessionName
        && row.windowName === partialIntent.sourceLocator.windowName),
    'a failed second rename must retain the exact final-session/source-window intermediate state');
    const partialMutationsBeforeMismatch = partialRenameHarness.operations.filter(item =>
        item.type === 'rename-session' || item.type === 'rename-window'
        || item.type === 'session-options' || item.type === 'window-options'
        || item.type === 'clear-pending').length;
    await assert.rejects(new backendModule.TmuxRuntimeBackend(partialRenameHarness.dependencies)
        .promotePending(partialRenameRequest.identity, 'partial-readable-final', 'Different display name'),
    /conflicting promotion/i);
    assert.strictEqual(partialRenameHarness.operations.filter(item =>
        item.type === 'rename-session' || item.type === 'rename-window'
        || item.type === 'session-options' || item.type === 'window-options'
        || item.type === 'clear-pending').length, partialMutationsBeforeMismatch,
    'a replay with a different display name must fail closed before any mutation');
    const partialRestarted = createRestartedRuntime(partialRenameHarness);
    const partialTerminal = partialRenameHarness.terminals[0];
    await partialRestarted.tmux.restoreAttachTerminals([partialTerminal]);
    const partialRecovered = await partialRestarted.coordinator.promotePending(
        partialRenameRequest.identity, 'partial-readable-final', 'Repair replication'
    );
    assert.deepStrictEqual(partialRecovered[0].tmux, partialIntent.finalLocator);
    assert.strictEqual(partialRenameHarness.operations.filter(item => item.type === 'rename-session').length, 1,
        'partial recovery must not rename the already-final session again');
    assert.strictEqual(partialRenameHarness.operations.filter(item => item.type === 'rename-window').length, 2);
    const partialAttach = partialRenameHarness.attachBindings.get(await partialTerminal.processId);
    assert.strictEqual(partialAttach.sessionName, partialIntent.finalLocator.sessionName);
    assert.strictEqual(partialAttach.windowName, partialIntent.finalLocator.windowName);
    assert.strictEqual(partialRenameHarness.operations.filter(item =>
        item.type === 'new-session' || item.type === 'new-window').length, partialRenameCreates,
    'partial recovery must never redispatch the provider command');

    for (const transitionLayout of ['session', 'project']) {
        for (const transitionFailure of ['mid-final-write', 'before-pending-clear']) {
            const transitionHarness = createTmuxBackendHarness({
                ...(transitionFailure === 'mid-final-write'
                    ? { failFinalMetadataIdentityWriteCount: 1 }
                    : { failPromotionClearPendingCount: 1 }),
            });
            const transitionRequest = {
                identity: {
                    provider: 'codex', workspaceScopeIdentity: `transition-${transitionLayout}-${transitionFailure}`, workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
                    pendingId: `transition-pending-${transitionLayout}-${transitionFailure}`,
                },
                projectName: 'App', terminalName: `Codex: ${transitionFailure}`,
                createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: ['old'], title: 'Transition',
                launch: {
                    executable: 'codex', args: ['new'], markerPath: `/tmp/${transitionLayout}-${transitionFailure}`,
                },
            };
            const finalSessionId = `transition-final-${transitionLayout}-${transitionFailure}`;
            const transitionBackend = new backendModule.TmuxRuntimeBackend(transitionHarness.dependencies);
            await transitionBackend.ensurePending(transitionRequest, transitionLayout);
            const createsBeforePromotion = transitionHarness.operations.filter(item =>
                item.type === 'new-session' || item.type === 'new-window').length;
            await assert.rejects(transitionBackend.promotePending(
                transitionRequest.identity, finalSessionId, 'Transition'
            ), transitionFailure === 'mid-final-write'
                ? /final metadata identity write failed/
                : /promotion pending clear failed/);
            assert.strictEqual(transitionHarness.promoting.size, 1);
            const transitionRow = transitionHarness.windows.find(row =>
                row.metadata.pendingId === transitionRequest.identity.pendingId
                || row.metadata.sessionId === finalSessionId);
            assert.strictEqual(transitionRow.metadata.pendingId, transitionRequest.identity.pendingId);
            if (transitionFailure === 'before-pending-clear' || transitionLayout === 'session') {
                assert.strictEqual(transitionRow.metadata.sessionId, finalSessionId);
            }
            const recoveredTransition = await promoteWithRestartedCoordinator(
                transitionHarness, transitionRequest.identity, finalSessionId, 'Transition'
            );
            assert.strictEqual(recoveredTransition.length, 1);
            assert.strictEqual(transitionHarness.promoting.size, 0);
            assert.strictEqual(transitionHarness.pending.size, 0);
            assert.strictEqual(transitionHarness.consumed.size, 1);
            assert.strictEqual(transitionHarness.operations.filter(item =>
                item.type === 'rename-session' || item.type === 'rename-window').length,
            transitionLayout === 'session' ? 2 : 1);
            assert.strictEqual(transitionHarness.operations.filter(item =>
                item.type === 'new-session' || item.type === 'new-window').length, createsBeforePromotion);
        }
    }

    for (const productRecoveryCase of [{
        label: 'partial-rename', layout: 'session',
        harnessOptions: { failRenameWindowCount: 1 }, failure: /rename window failed/,
    }, {
        label: 'fully-renamed', layout: 'session',
        harnessOptions: { ambiguousRenameWindowCount: 1 }, failure: /timeout/,
    }, {
        label: 'metadata-transition', layout: 'session',
        harnessOptions: { failFinalMetadataIdentityWriteCount: 1 },
        failure: /final metadata identity write failed/,
    }]) {
        const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(),
            `project-steward-product-promotion-${productRecoveryCase.label}-`));
        try {
            const harness = createTmuxBackendHarness(productRecoveryCase.harnessOptions);
            const attachState = createPersistedAttachState();
            const initial = createFreshPersistedRuntime(harness, runtimeRoot, attachState);
            const request = {
                identity: {
                    provider: 'codex',
                    workspaceScopeIdentity: `product-recovery-${productRecoveryCase.label}`,
                    workspaceNavigationIdentity: `nav-product-recovery-${productRecoveryCase.label}`,
                    workspaceRootHostPaths: ['/work'], cwd: '/work',
                    pendingId: `product-recovery-pending-${productRecoveryCase.label}`,
                },
                projectName: 'Product Recovery', terminalName: 'Codex: Product recovery',
                createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
                launch: { executable: 'codex', args: ['new'], markerPath: '/tmp/product-recovery' },
            };
            const finalSessionId = `product-recovery-final-${productRecoveryCase.label}`;
            const pendingRuntime = await initial.tmux.ensurePending(request, productRecoveryCase.layout);
            const providerDispatches = harness.operations.filter(operation =>
                operation.type === 'new-session' || operation.type === 'new-window').length;
            await assert.rejects(initial.tmux.promotePending(
                request.identity, finalSessionId, 'First frozen name'
            ), productRecoveryCase.failure);
            const frozenIntent = await initial.runtimeStore.getPromoting(request.identity);
            assert.strictEqual(frozenIntent.finalSessionName, 'First frozen name');
            await initial.attachStore.flush();

            const restartedAttachState = clonePersistedAttachState(attachState);
            const restarted = createFreshPersistedRuntime(
                harness, runtimeRoot, restartedAttachState
            );
            await restarted.tmux.restoreAttachTerminals([pendingRuntime.terminal]);
            await assert.rejects(restarted.coordinator.promotePending(
                request.identity, finalSessionId, 'Second current name'
            ), /conflicting promotion|different promotion/i,
            'an explicit replay with a different current display name must remain fail closed');
            const controller = createPromotionController(restarted.coordinator);
            await controller.promote({
                scopeIdentity: request.identity.workspaceScopeIdentity,
                navigationIdentity: request.identity.workspaceNavigationIdentity,
            }, {
                codex: {
                    available: true, scannedFiles: 1, parsedFiles: 1,
                    sessions: [{
                        id: finalSessionId, name: 'Second current name', cwd: '/work',
                        updatedAt: '2026-07-18T10:00:01.000Z',
                    }],
                },
            }, `restart-${productRecoveryCase.label}`);

            const consumed = await restarted.runtimeStore.getConsumed(request.identity);
            assert.ok(consumed,
                'automatic recovery must replay the frozen durable display name');
            assert.strictEqual(consumed.finalSessionName, 'First frozen name');
            assert.deepStrictEqual(consumed.finalLocator, frozenIntent.finalLocator);
            assert.strictEqual(await restarted.runtimeStore.getPromoting(request.identity), null);
            assert.strictEqual(await restarted.runtimeStore.getPending(request.identity), null);
            assert.strictEqual(harness.operations.filter(operation =>
                operation.type === 'new-session' || operation.type === 'new-window').length,
            providerDispatches, 'product-entry recovery must not redispatch the provider command');
            const restoredAttach = restarted.attachStore.get(await pendingRuntime.terminal.processId);
            assert.strictEqual(restoredAttach.sessionId, finalSessionId);
            assert.deepStrictEqual({
                layout: restoredAttach.layout,
                sessionName: restoredAttach.sessionName,
                windowName: restoredAttach.windowName,
            }, consumed.finalLocator);
        } finally {
            fs.rmSync(runtimeRoot, { recursive: true, force: true });
        }
    }

    {
        const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(),
            'project-steward-stale-consumed-attach-'));
        try {
            const harness = createTmuxBackendHarness();
            const attachState = createPersistedAttachState();
            const initial = createFreshPersistedRuntime(harness, runtimeRoot, attachState);
            const request = {
                identity: {
                    provider: 'codex', workspaceScopeIdentity: 'stale-consumed-attach',
                    workspaceNavigationIdentity: 'nav-stale-consumed-attach',
                    workspaceRootHostPaths: ['/work'], cwd: '/work',
                    pendingId: 'stale-consumed-attach-pending',
                },
                projectName: 'Stale Attach', terminalName: 'Codex: Stale attach',
                createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [], title: 'Stale attach',
                launch: { executable: 'codex', args: ['new'], markerPath: '/tmp/stale-attach' },
            };
            const pendingRuntime = await initial.tmux.ensurePending(request, 'session');
            const pendingBinding = await initial.runtimeStore.getPending(request.identity);
            const absentFinalLocator = tmuxNaming.buildReadableTmuxLocator({
                ...request.identity, pendingId: undefined, sessionId: 'stale-attach-final',
            }, 'session', { projectName: request.projectName, sessionName: 'Stale attach' });
            await initial.runtimeStore.setConsumed({
                version: 2, state: 'consumed', ...request.identity,
                finalSessionId: 'stale-attach-final', finalSessionName: 'Stale attach',
                layout: 'session', finalLocator: absentFinalLocator,
                consumedAtMs: harness.dependencies.nowMs(),
            });
            harness.windows.length = 0;
            await initial.attachStore.flush();

            const restartedAttachState = clonePersistedAttachState(attachState);
            const restarted = createFreshPersistedRuntime(
                harness, runtimeRoot, restartedAttachState
            );
            await restarted.tmux.restoreAttachTerminals([pendingRuntime.terminal]);
            assert.strictEqual(restarted.attachStore.get(await pendingRuntime.terminal.processId), null,
                'a consumed pending attach without its exact final runtime must be deleted on reload');
            assert.ok(pendingBinding);
            harness.windows.push({
                sessionName: absentFinalLocator.sessionName,
                windowName: absentFinalLocator.windowName,
                windowId: '@stale-final', active: false,
                sessionMetadata: {
                    managed: '1', version: '2', layout: 'session',
                    workspaceScopeIdentity: request.identity.workspaceScopeIdentity,
                    workspaceNavigationIdentity: request.identity.workspaceNavigationIdentity,
                    workspaceRootHostPaths: JSON.stringify(request.identity.workspaceRootHostPaths),
                    cwd: request.identity.cwd, provider: request.identity.provider,
                    sessionId: 'stale-attach-final', createdAt: request.createdAt,
                    marker: request.launch.markerPath,
                },
                windowMetadata: { managed: '1', version: '2', layout: 'session' },
                metadata: {},
            });
            const secondRestart = createFreshPersistedRuntime(harness, runtimeRoot,
                clonePersistedAttachState(restartedAttachState));
            await secondRestart.tmux.restoreAttachTerminals([pendingRuntime.terminal]);
            assert.strictEqual(secondRestart.tmux.getFocusedRuntime(pendingRuntime.terminal), null,
                'a later runtime with the same identity must not reclaim a deleted stale terminal binding');
        } finally {
            fs.rmSync(runtimeRoot, { recursive: true, force: true });
        }
    }

    for (const crashLayout of ['session', 'project']) {
        for (const crashFailure of [{
            label: 'remove-pending', message: /post-consumed pending removal failed/,
        }, {
            label: 'refresh', message: /post-consumed discovery refresh failed/,
        }, {
            label: 'attach-migrate', message: /attach migration failed/,
        }]) {
            const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(),
                `project-steward-post-consumed-${crashLayout}-${crashFailure.label}-`));
            try {
                const crashHarness = createTmuxBackendHarness();
                const attachState = createPersistedAttachState();
                const initial = createFreshPersistedRuntime(crashHarness, runtimeRoot, attachState);
                const crashRequest = {
                    identity: {
                        provider: 'codex',
                        workspaceScopeIdentity: `promotion-crash-${crashLayout}-${crashFailure.label}`,
                        workspaceNavigationIdentity: `nav-promotion-crash-${crashLayout}`,
                        workspaceRootHostPaths: ['/work'], cwd: '/work',
                        pendingId: `promotion-crash-pending-${crashLayout}-${crashFailure.label}`,
                    },
                    projectName: 'Crash Project', terminalName: `Codex: ${crashFailure.label}`,
                    createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [], title: 'Crash recovery',
                    launch: { executable: 'codex', args: ['new'], markerPath: '/tmp/crash-recovery' },
                };
                const crashFinalId = `promotion-crash-final-${crashLayout}-${crashFailure.label}`;
                const crashPending = await initial.tmux.ensurePending(crashRequest, crashLayout);
                await initial.attachStore.flush();
                const crashCreates = crashHarness.operations.filter(item =>
                    item.type === 'new-session' || item.type === 'new-window').length;

                if (crashFailure.label === 'remove-pending') {
                    const removePending = initial.runtimeStore.removePending.bind(initial.runtimeStore);
                    let failed = false;
                    initial.runtimeStore.removePending = async identity => {
                        if (!failed && await initial.runtimeStore.getConsumed(identity)) {
                            failed = true;
                            throw new Error('post-consumed pending removal failed');
                        }
                        return removePending(identity);
                    };
                } else if (crashFailure.label === 'refresh') {
                    const refresh = initial.discovery.refresh.bind(initial.discovery);
                    let failed = false;
                    initial.discovery.refresh = async force => {
                        if (!failed && await initial.runtimeStore.getConsumed(crashRequest.identity)) {
                            failed = true;
                            throw new Error('post-consumed discovery refresh failed');
                        }
                        return refresh(force);
                    };
                } else {
                    const setAttach = initial.attachStore.set.bind(initial.attachStore);
                    const flushAttach = initial.attachStore.flush.bind(initial.attachStore);
                    let droppedFinalAttach = false;
                    let failed = false;
                    initial.attachStore.set = (processId, binding) => {
                        if (!failed && binding.sessionId === crashFinalId) {
                            droppedFinalAttach = true;
                            return;
                        }
                        setAttach(processId, binding);
                    };
                    initial.attachStore.flush = async () => {
                        if (!failed && droppedFinalAttach) {
                            failed = true;
                            throw new Error('attach migration failed');
                        }
                        return flushAttach();
                    };
                }

                await assert.rejects(initial.tmux.promotePending(
                    crashRequest.identity, crashFinalId, 'Crash recovery'
                ), crashFailure.message);
                const crashConsumed = await initial.runtimeStore.getConsumed(crashRequest.identity);
                assert.ok(crashConsumed, 'post-consumed crash must retain its durable commit record');
                assert.strictEqual(crashConsumed.finalSessionId, crashFinalId);
                assert.strictEqual(crashConsumed.finalSessionName, 'Crash recovery');
                assert.ok(await initial.runtimeStore.getPromoting(crashRequest.identity),
                    'the intent must remain until attach migration and cleanup are durable');
                assert.strictEqual(!!await initial.runtimeStore.getPending(crashRequest.identity),
                    crashFailure.label !== 'refresh',
                    'the pending binding may be absent only after cleanup reached its refresh step');
                await initial.attachStore.flush();

                const restarted = createFreshPersistedRuntime(
                    crashHarness, runtimeRoot, clonePersistedAttachState(attachState)
                );
                await restarted.tmux.restoreAttachTerminals([crashPending.terminal]);
                assert.ok(restarted.coordinator.getActive().some(runtime =>
                    runtime.identity.sessionId === crashFinalId),
                'the final runtime must already be active and therefore claimed by the controller');
                await assert.rejects(restarted.coordinator.promotePending(
                    crashRequest.identity, crashFinalId, 'Crash---recovery'
                ), /conflicting promotion|different promotion|consumed/i,
                'explicit recovery with a different raw display name must remain fail closed');
                const promotionAttempts = [];
                const promotePending = restarted.coordinator.promotePending.bind(
                    restarted.coordinator
                );
                restarted.coordinator.promotePending = async (identity, sessionId, sessionName) => {
                    promotionAttempts.push({ sessionId, sessionName });
                    return promotePending(identity, sessionId, sessionName);
                };
                const controller = createPromotionController(restarted.coordinator);
                const workspace = {
                    scopeIdentity: crashRequest.identity.workspaceScopeIdentity,
                    navigationIdentity: crashRequest.identity.workspaceNavigationIdentity,
                };
                const newerSession = {
                    id: `${crashFinalId}-newer`, name: 'Newer same-cwd session', cwd: '/work',
                    updatedAt: '2026-07-18T10:00:02.000Z',
                };
                const targetSession = {
                    id: crashFinalId, name: 'Changed provider display', cwd: '/work',
                    updatedAt: '2026-07-18T10:00:01.000Z',
                };
                const sessionResult = sessions => ({
                    codex: { available: true, scannedFiles: 2, parsedFiles: 2, sessions },
                });
                if (crashLayout === 'session' && crashFailure.label === 'attach-migrate') {
                    await controller.promote(workspace, sessionResult([newerSession]),
                        'post-consumed-target-missing');
                    assert.deepStrictEqual(promotionAttempts, [],
                        'an absent durable target must not fall back to a newer same-cwd session');
                    assert.ok(await restarted.runtimeStore.getPromoting(crashRequest.identity));
                    assert.ok(await restarted.runtimeStore.getPending(crashRequest.identity));
                }
                await controller.promote(workspace, sessionResult([newerSession, targetSession]),
                    'post-consumed-recovery');
                assert.deepStrictEqual(promotionAttempts, [{
                    sessionId: crashFinalId, sessionName: 'Crash recovery',
                }], 'the real controller must replay the exact frozen durable promotion once');
                assert.strictEqual(await restarted.runtimeStore.getPromoting(crashRequest.identity), null);
                assert.strictEqual(await restarted.runtimeStore.getPending(crashRequest.identity), null);
                const recoveredAttach = restarted.attachStore.get(await crashPending.terminal.processId);
                assert.strictEqual(recoveredAttach.sessionName, crashConsumed.finalLocator.sessionName);
                assert.strictEqual(recoveredAttach.windowName, crashConsumed.finalLocator.windowName);
                assert.strictEqual(recoveredAttach.sessionId, crashFinalId);
                assert.strictEqual(crashHarness.operations.filter(item =>
                    item.type === 'new-session' || item.type === 'new-window').length, crashCreates,
                'real-controller crash recovery must never redispatch the provider command');
            } finally {
                fs.rmSync(runtimeRoot, { recursive: true, force: true });
            }
        }
    }

    for (const expiredIntentLayout of ['session', 'project']) {
        const acceptedNowMs = Date.parse('2026-07-18T10:00:00Z');
        let movingNowMs = acceptedNowMs;
        const expiredIntentHarness = createTmuxBackendHarness({
            failSetConsumedCount: 1,
            enforcePendingTtl: true,
            nowMs: () => movingNowMs,
        });
        const expiredIntentRequest = {
            identity: {
                provider: 'claude', workspaceScopeIdentity: `expired-intent-${expiredIntentLayout}`, workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
                pendingId: `expired-intent-pending-${expiredIntentLayout}`,
            },
            projectName: 'App', terminalName: `Claude: Expired Intent ${expiredIntentLayout}`,
            createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: ['old'], title: 'Expired intent',
            launch: { executable: 'claude', args: ['new'], markerPath: '/tmp/expired-intent' },
        };
        const expiredIntentFinalId = `expired-intent-final-${expiredIntentLayout}`;
        const expiredIntentBackend = new backendModule.TmuxRuntimeBackend(expiredIntentHarness.dependencies);
        await expiredIntentBackend.ensurePending(expiredIntentRequest, expiredIntentLayout);
        await assert.rejects(expiredIntentBackend.promotePending(
            expiredIntentRequest.identity, expiredIntentFinalId, 'Expired intent'
        ), /consumed persistence failed/);
        assert.ok(Array.from(expiredIntentHarness.promoting.values())[0].pendingBinding);
        movingNowMs = acceptedNowMs + (24 * 60 * 60 * 1000) + 1;
        assert.strictEqual(await expiredIntentHarness.runtimeStore.getPending(
            expiredIntentRequest.identity
        ), null);
        const expiredEnsureCreateCount = expiredIntentHarness.operations.filter(item =>
            item.type === 'new-session' || item.type === 'new-window').length;
        await assert.rejects(new backendModule.TmuxRuntimeBackend(expiredIntentHarness.dependencies)
            .ensurePending(expiredIntentRequest, expiredIntentLayout), /promotion.*progress/i);
        assert.strictEqual(expiredIntentHarness.operations.filter(item =>
            item.type === 'new-session' || item.type === 'new-window').length, expiredEnsureCreateCount);
        const expiredIntentRecovered = await new backendModule.TmuxRuntimeBackend(expiredIntentHarness.dependencies)
            .promotePending(expiredIntentRequest.identity, expiredIntentFinalId, 'Expired intent');
        assert.strictEqual(expiredIntentRecovered.length, 1);
        assert.strictEqual(expiredIntentHarness.promoting.size, 0);
        assert.strictEqual(expiredIntentHarness.pending.size, 0);
        assert.strictEqual(expiredIntentHarness.consumed.size, 1);
        assert.strictEqual(expiredIntentHarness.operations.filter(item =>
            item.type === 'rename-session' || item.type === 'rename-window').length,
        expiredIntentLayout === 'session' ? 2 : 1);
    }

    for (const occupiedExpiredLayout of ['session', 'project']) {
        const acceptedNowMs = Date.parse('2026-07-18T10:00:00Z');
        let movingNowMs = acceptedNowMs;
        const occupiedExpiredHarness = createTmuxBackendHarness({
            failSetConsumedCount: 1,
            enforcePendingTtl: true,
            nowMs: () => movingNowMs,
        });
        const occupiedExpiredRequest = {
            identity: {
                provider: 'codex', workspaceScopeIdentity: `occupied-expired-${occupiedExpiredLayout}`, workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
                pendingId: `occupied-expired-pending-${occupiedExpiredLayout}`,
            },
            projectName: 'App', terminalName: `Codex: Occupied Expired ${occupiedExpiredLayout}`,
            createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
            launch: { executable: 'codex', args: ['new'], markerPath: '/tmp/occupied-expired' },
        };
        const occupiedExpiredFinalId = `occupied-expired-final-${occupiedExpiredLayout}`;
        const occupiedExpiredBackend = new backendModule.TmuxRuntimeBackend(occupiedExpiredHarness.dependencies);
        await occupiedExpiredBackend.ensurePending(occupiedExpiredRequest, occupiedExpiredLayout);
        await assert.rejects(occupiedExpiredBackend.promotePending(
            occupiedExpiredRequest.identity, occupiedExpiredFinalId, 'Occupied expired intent'
        ), /consumed persistence failed/);
        const occupiedExpiredIntent = Array.from(occupiedExpiredHarness.promoting.values())[0];
        const renamedRow = occupiedExpiredHarness.windows.find(row =>
            row.sessionName === occupiedExpiredIntent.finalLocator.sessionName
            && (occupiedExpiredLayout === 'session'
                || row.windowName === occupiedExpiredIntent.finalLocator.windowName));
        assert.ok(renamedRow);
        renamedRow.sessionName = occupiedExpiredIntent.sourceLocator.sessionName;
        if (occupiedExpiredLayout === 'project') {
            renamedRow.windowName = occupiedExpiredIntent.sourceLocator.windowName;
            renamedRow.sessionMetadata = {
                managed: '1', version: '2', layout: 'project',
                workspaceScopeIdentity: occupiedExpiredIntent.workspaceScopeIdentity,
            };
            renamedRow.windowMetadata = {
                managed: '1', version: '2', layout: 'project', provider: occupiedExpiredIntent.provider,
                workspaceScopeIdentity: occupiedExpiredIntent.workspaceScopeIdentity,
                workspaceNavigationIdentity: occupiedExpiredIntent.workspaceNavigationIdentity,
                workspaceRootHostPaths: JSON.stringify(occupiedExpiredIntent.workspaceRootHostPaths),
                cwd: occupiedExpiredIntent.cwd,
                createdAt: occupiedExpiredIntent.createdAt, pendingId: occupiedExpiredIntent.pendingId,
                marker: occupiedExpiredIntent.markerPath,
            };
        } else {
            renamedRow.windowName = occupiedExpiredIntent.sourceLocator.windowName || 'ai-session';
            renamedRow.sessionMetadata = {
                managed: '1', version: '2', layout: 'session', provider: occupiedExpiredIntent.provider,
                workspaceScopeIdentity: occupiedExpiredIntent.workspaceScopeIdentity,
                workspaceNavigationIdentity: occupiedExpiredIntent.workspaceNavigationIdentity,
                workspaceRootHostPaths: JSON.stringify(occupiedExpiredIntent.workspaceRootHostPaths),
                cwd: occupiedExpiredIntent.cwd,
                createdAt: occupiedExpiredIntent.createdAt, pendingId: occupiedExpiredIntent.pendingId,
                marker: occupiedExpiredIntent.markerPath,
            };
            renamedRow.windowMetadata = { managed: '1', version: '2', layout: 'session' };
        }
        renamedRow.metadata = { ...renamedRow.sessionMetadata, ...renamedRow.windowMetadata };
        occupiedExpiredHarness.windows.push({
            ...occupiedExpiredIntent.finalLocator,
            windowName: occupiedExpiredIntent.finalLocator.windowName || 'shell',
            windowId: `@occupied-expired-${occupiedExpiredLayout}`,
            active: false, sessionMetadata: {}, windowMetadata: {}, metadata: {},
        });
        movingNowMs = acceptedNowMs + (24 * 60 * 60 * 1000) + 1;
        assert.strictEqual(await occupiedExpiredHarness.runtimeStore.getPending(
            occupiedExpiredRequest.identity
        ), null);
        const promotionMutations = () => occupiedExpiredHarness.operations.filter(item => [
            'rename-session', 'rename-window', 'session-options', 'window-options', 'clear-pending',
            'store-promoting', 'store-consumed', 'store-pending', 'remove-promoting', 'remove-pending',
        ].includes(item.type)).length;
        const mutationsBeforeOccupiedRetry = promotionMutations();
        const occupiedExpiredResult = await new backendModule.TmuxRuntimeBackend(
            occupiedExpiredHarness.dependencies
        ).promotePending(
            occupiedExpiredRequest.identity, occupiedExpiredFinalId, 'Occupied expired intent'
        );
        assert.strictEqual(occupiedExpiredResult.length, 1);
        assert.strictEqual(occupiedExpiredResult[0].state, 'conflict');
        assert.strictEqual(occupiedExpiredResult[0].identity.pendingId,
            occupiedExpiredRequest.identity.pendingId);
        assert.strictEqual(promotionMutations(), mutationsBeforeOccupiedRetry);
    }

    for (const delayedLayout of ['session', 'project']) {
        const pendingLockEntered = deferred();
        const releasePendingLock = deferred();
        let gatePromotion = false;
        let promotionLockHeld = false;
        const delayedIdentity = {
            provider: 'codex', workspaceScopeIdentity: `delayed-${delayedLayout}`, workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
            pendingId: `delayed-pending-${delayedLayout}`,
        };
        const delayedLockKey = `pending:${tmuxLayout.getTmuxRuntimeKey(delayedIdentity)}`;
        const delayedHarness = createTmuxBackendHarness({
            onLockAcquired: async key => {
                if (gatePromotion && !promotionLockHeld && key === delayedLockKey) {
                    promotionLockHeld = true;
                    pendingLockEntered.resolve();
                    await releasePendingLock.promise;
                }
            },
        });
        const delayedRequest = {
            identity: delayedIdentity,
            projectName: 'App', terminalName: `Codex: Delayed ${delayedLayout}`,
            createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
            launch: { executable: 'codex', args: ['new'] },
        };
        const delayedBackend = new backendModule.TmuxRuntimeBackend(delayedHarness.dependencies);
        await delayedBackend.ensurePending(delayedRequest, delayedLayout);
        gatePromotion = true;
        const promotionPromise = delayedBackend.promotePending(
            delayedIdentity, `delayed-final-${delayedLayout}`, 'Delayed final'
        );
        await pendingLockEntered.promise;
        const queuedBeforeEnsure = delayedHarness.operations.filter(item =>
            item.type === 'lock-queued' && item.key === delayedLockKey).length;
        const delayedEnsurePromise = new backendModule.TmuxRuntimeBackend(delayedHarness.dependencies)
            .ensurePending(delayedRequest, delayedLayout);
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(delayedHarness.operations.filter(item =>
            item.type === 'lock-queued' && item.key === delayedLockKey).length, queuedBeforeEnsure + 1);
        releasePendingLock.resolve();
        assert.strictEqual((await promotionPromise).length, 1);
        await assert.rejects(delayedEnsurePromise, /already consumed/);
        assert.strictEqual(delayedHarness.consumed.size, 1);
        assert.strictEqual(delayedHarness.operations.filter(item => item.type === 'new-session').length,
            delayedLayout === 'session' ? 1 : 1);
    }

    const failedPromotionHarness = createTmuxBackendHarness({ failRenameSessionCount: 1 });
    const failedPromotionBackend = new backendModule.TmuxRuntimeBackend(failedPromotionHarness.dependencies);
    const failedPromotionRequest = {
        identity: {
            provider: 'kimi', workspaceScopeIdentity: 'failed-promotion', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'failed-pending',
        },
        projectName: 'App', terminalName: 'Kimi: Failed Promotion',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
        launch: { executable: 'kimi', args: ['new'] },
    };
    await failedPromotionBackend.ensurePending(failedPromotionRequest, 'session');
    const failedPromotionCreates = failedPromotionHarness.operations.filter(item =>
        item.type === 'new-session' || item.type === 'new-window').length;
    await assert.rejects(failedPromotionBackend.promotePending(
        failedPromotionRequest.identity, 'failed-final', 'Failed final'
    ),
        /rename session failed/);
    assert.strictEqual(failedPromotionHarness.consumed.size, 0);
    assert.strictEqual(failedPromotionHarness.pending.size, 1);
    assert.strictEqual(failedPromotionHarness.promoting.size, 0);
    const retriedFailedPromotion = await new backendModule.TmuxRuntimeBackend(
        failedPromotionHarness.dependencies
    ).promotePending(failedPromotionRequest.identity, 'failed-final', 'Failed final');
    assert.match(retriedFailedPromotion[0].tmux.sessionName,
        /^ps-App-Failed-final-[0-9a-f]{8}$/);
    assert.match(retriedFailedPromotion[0].tmux.windowName,
        /^kimi-Failed-final-[0-9a-f]{8}$/);
    assert.strictEqual(failedPromotionHarness.operations.filter(item => item.type === 'rename-session').length, 2);
    assert.strictEqual(failedPromotionHarness.operations.filter(item => item.type === 'rename-window').length, 1);
    assert.strictEqual(failedPromotionHarness.operations.filter(item =>
        item.type === 'new-session' || item.type === 'new-window').length, failedPromotionCreates,
    'pre-rename recovery must never redispatch the provider command');

    const unknownPromotionHarness = createTmuxBackendHarness();
    const unknownPromotionBackend = new backendModule.TmuxRuntimeBackend(unknownPromotionHarness.dependencies);
    const unknownPromotionRequest = {
        identity: {
            provider: 'codex', workspaceScopeIdentity: 'unknown-promotion', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'unknown-pending',
        },
        projectName: 'App', terminalName: 'Codex: Unknown Promotion',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
        launch: { executable: 'codex', args: ['new'] },
    };
    await unknownPromotionBackend.ensurePending(unknownPromotionRequest, 'session');
    const unknownFinalIdentity = {
        provider: 'codex', workspaceScopeIdentity: 'unknown-promotion', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'unknown-final',
    };
    const unknownFinalLocator = tmuxNaming.buildReadableTmuxLocator(
        unknownFinalIdentity, 'session', { projectName: 'App', sessionName: 'Unknown final' }
    );
    unknownPromotionHarness.windows.push({
        ...unknownFinalLocator, windowName: 'shell', windowId: '@unknown-promotion', active: false,
        sessionMetadata: {}, windowMetadata: {}, metadata: {},
    });
    const unknownPromotionResult = await unknownPromotionBackend.promotePending(
        unknownPromotionRequest.identity, 'unknown-final', 'Unknown final'
    );
    assert.strictEqual(unknownPromotionResult.length, 1);
    assert.strictEqual(unknownPromotionResult[0].state, 'conflict');
    assert.strictEqual(unknownPromotionHarness.operations.some(item => item.type === 'rename-session'), false);
    assert.strictEqual(unknownPromotionHarness.pending.size, 1);

    const collisionHarness = createTmuxBackendHarness();
    const collisionBackend = new backendModule.TmuxRuntimeBackend(collisionHarness.dependencies);
    await collisionBackend.ensureResume({
        identity: { provider: 'codex', workspaceScopeIdentity: 'collision', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'final' },
        projectName: 'App', terminalName: 'AI Sessions: Collision',
        launch: { executable: 'codex', args: ['resume', 'final'], markerPath: '/tmp/final' },
    }, 'project');
    const collisionPendingRequest = {
        identity: { provider: 'codex', workspaceScopeIdentity: 'collision', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'pending' },
        projectName: 'App', terminalName: 'AI Sessions: Collision',
        createdAt: '2026-07-18T09:58:00Z', excludedSessionIds: [],
        launch: { executable: 'codex', args: ['new'], markerPath: '/tmp/pending-collision' },
    };
    await collisionBackend.ensurePending(collisionPendingRequest, 'project');
    const collisionResult = await collisionBackend.promotePending(
        collisionPendingRequest.identity, 'final', 'Collision final'
    );
    assert.strictEqual(collisionResult.length, 2);
    assert.ok(collisionResult.every(runtime => runtime.state === 'conflict'));
    assert.strictEqual(collisionHarness.operations.filter(item => item.type === 'rename-window').length, 0);
    assert.strictEqual(collisionHarness.pending.size, 1);

    const attachFailureHarness = createTmuxBackendHarness({ failAttachCount: 1 });
    const attachFailureBackend = new backendModule.TmuxRuntimeBackend(attachFailureHarness.dependencies);
    const attachFailureRequest = {
        identity: { provider: 'kimi', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'Kimi: s1',
        launch: { executable: 'kimi', args: ['--resume', 's1'], markerPath: '/tmp/k1' },
    };
    await assert.rejects(attachFailureBackend.ensureResume(attachFailureRequest, 'session'), /attach failed/);
    await attachFailureBackend.ensureResume(attachFailureRequest, 'session');
    assert.strictEqual(attachFailureHarness.operations.filter(item => item.type === 'new-session').length, 1);

    const showFailureHarness = createTmuxBackendHarness({ failShowCount: 1, failDisposeCount: 1 });
    const showFailureBackend = new backendModule.TmuxRuntimeBackend(showFailureHarness.dependencies);
    await assert.rejects(showFailureBackend.ensureResume(attachFailureRequest, 'session'), /show failed/);
    assert.strictEqual(showFailureHarness.terminals[0].disposed, true);
    assert.ok(showFailureBackend.getActive().every(runtime => !runtime.terminal));
    await showFailureBackend.ensureResume(attachFailureRequest, 'session');
    assert.strictEqual(showFailureHarness.operations.filter(item => item.type === 'new-session').length, 1);

    const selectFailureHarness = createTmuxBackendHarness({ failSelectCount: 1 });
    const selectFailureBackend = new backendModule.TmuxRuntimeBackend(selectFailureHarness.dependencies);
    await assert.rejects(selectFailureBackend.ensureResume(attachFailureRequest, 'session'), /select failed/);
    assert.strictEqual(selectFailureHarness.terminals.length, 0);
    await selectFailureBackend.ensureResume(attachFailureRequest, 'session');
    assert.strictEqual(selectFailureHarness.operations.filter(item => item.type === 'new-session').length, 1);
    assert.strictEqual(selectFailureHarness.terminals.length, 1);

    const ambiguousHarness = createTmuxBackendHarness({ ambiguousCreateCount: 1 });
    const ambiguousBackend = new backendModule.TmuxRuntimeBackend(ambiguousHarness.dependencies);
    const ambiguousRequest = {
        identity: { provider: 'codex', workspaceScopeIdentity: 'ambiguous', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'Codex: s1',
        launch: { executable: 'codex', args: ['resume', 's1'], markerPath: '/tmp/a1' },
    };
    await assert.rejects(ambiguousBackend.ensureResume(ambiguousRequest, 'session'), /timeout/);
    assert.strictEqual(ambiguousHarness.ambiguous.size, 1);
    assert.ok(ambiguousHarness.operations.findIndex(item => item.type === 'store-ambiguous')
        < ambiguousHarness.operations.findIndex(item => item.type === 'new-session'));
    const restartedAmbiguousBackend = new backendModule.TmuxRuntimeBackend(ambiguousHarness.dependencies);
    await assert.rejects(restartedAmbiguousBackend.ensureResume(ambiguousRequest, 'session'), /ambiguous/);
    assert.strictEqual(ambiguousHarness.operations.filter(item => item.type === 'new-session').length, 1);
    assert.strictEqual(ambiguousHarness.pending.size, 0);
    const recoveredAmbiguousRow = ambiguousHarness.windows[0];
    recoveredAmbiguousRow.sessionMetadata = {
        managed: '1', version: '2', layout: 'session', workspaceScopeIdentity: 'ambiguous',
        workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: '["/work"]', cwd: '/work',
        provider: 'codex', sessionId: 's1', marker: '/tmp/a1',
    };
    recoveredAmbiguousRow.windowMetadata = {
        managed: '1', version: '2', layout: 'session',
    };
    recoveredAmbiguousRow.metadata = {
        ...recoveredAmbiguousRow.sessionMetadata, ...recoveredAmbiguousRow.windowMetadata,
    };
    const recoveredAmbiguous = await new backendModule.TmuxRuntimeBackend(ambiguousHarness.dependencies)
        .ensureResume(ambiguousRequest, 'session');
    assert.strictEqual(recoveredAmbiguous.identity.sessionId, 's1');
    assert.deepStrictEqual(ambiguousHarness.known.get('codex:s1'), {
        version: 2, state: 'known', provider: 'codex', sessionId: 's1',
        workspaceScopeIdentity: 'ambiguous', workspaceNavigationIdentity: 'nav-1',
        workspaceRootHostPaths: ['/work'], cwd: '/work', layout: 'session',
        locator: {
            layout: 'session', sessionName: recoveredAmbiguousRow.sessionName,
            windowName: recoveredAmbiguousRow.windowName,
        },
        lastSeenAtMs: Date.parse('2026-07-18T10:00:00Z'),
    }, 'ambiguous recovery without createdAt must retain a v2 known hint');
    assert.strictEqual(ambiguousHarness.ambiguous.size, 0);
    assert.strictEqual(ambiguousHarness.operations.filter(item => item.type === 'new-session').length, 1);

    const ambiguousLifecycleHarness = createTmuxBackendHarness({
        ambiguousCreateCount: 1,
        prepareAmbiguousWindow: row => {
            row.sessionMetadata = {
                managed: '1', version: '2', layout: 'session', workspaceScopeIdentity: 'ambiguous-lifecycle',
                workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: '["/work"]', cwd: '/work',
                provider: 'codex', sessionId: 's2',
                createdAt: '2026-07-18T09:59:00.000Z', marker: '/tmp/a2',
            };
            row.windowMetadata = { managed: '1', version: '2', layout: 'session' };
            row.metadata = { ...row.sessionMetadata, ...row.windowMetadata };
        },
    });
    const ambiguousLifecycleRequest = {
        identity: { provider: 'codex', workspaceScopeIdentity: 'ambiguous-lifecycle', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's2' },
        projectName: 'App', terminalName: 'Codex: s2',
        launch: { executable: 'codex', args: ['resume', 's2'], markerPath: '/tmp/a2' },
    };
    const recoveredLifecycle = await new backendModule.TmuxRuntimeBackend(
        ambiguousLifecycleHarness.dependencies
    ).ensureResume(ambiguousLifecycleRequest, 'session');
    const recoveredLifecycleRow = ambiguousLifecycleHarness.windows[0];
    assert.strictEqual(recoveredLifecycle.identity.sessionId, 's2');
    assert.deepStrictEqual(ambiguousLifecycleHarness.known.get('codex:s2'), {
        version: 2, state: 'known', provider: 'codex', sessionId: 's2',
        workspaceScopeIdentity: 'ambiguous-lifecycle', workspaceNavigationIdentity: 'nav-1',
        workspaceRootHostPaths: ['/work'], layout: 'session',
        locator: {
            layout: 'session', sessionName: recoveredLifecycleRow.sessionName,
            windowName: recoveredLifecycleRow.windowName,
        },
        lastSeenAtMs: Date.parse('2026-07-18T10:00:00Z'),
        cwd: '/work', markerPath: '/tmp/a2',
        runStartedAtMs: Date.parse('2026-07-18T09:59:00.000Z'),
    }, 'ambiguous recovery must preserve complete lifecycle proof when discovery omits cwd');

    const ambiguousPendingHarness = createTmuxBackendHarness({ ambiguousCreateCount: 1 });
    const ambiguousPendingRequest = {
        identity: {
            provider: 'claude', workspaceScopeIdentity: 'ambiguous-pending', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'pending-ambiguous',
        },
        projectName: 'App', terminalName: 'Claude: Ambiguous',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
        launch: { executable: 'claude', args: ['new'] },
    };
    await assert.rejects(
        new backendModule.TmuxRuntimeBackend(ambiguousPendingHarness.dependencies)
            .ensurePending(ambiguousPendingRequest, 'session'),
        /timeout/
    );
    await assert.rejects(
        new backendModule.TmuxRuntimeBackend(ambiguousPendingHarness.dependencies)
            .ensurePending(ambiguousPendingRequest, 'session'),
        /ambiguous|metadata/
    );
    assert.strictEqual(ambiguousPendingHarness.operations.filter(item => item.type === 'new-session').length, 1);
    assert.strictEqual(ambiguousPendingHarness.pending.size, 0);

    const nonzeroSessionHarness = createTmuxBackendHarness({ failCreateSessionNonzeroCount: 1 });
    const nonzeroSessionRequest = {
        identity: { provider: 'codex', workspaceScopeIdentity: 'nonzero-session', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'Codex: Nonzero',
        launch: { executable: 'codex', args: ['resume', 's1'] },
    };
    await assert.rejects(
        new backendModule.TmuxRuntimeBackend(nonzeroSessionHarness.dependencies)
            .ensureResume(nonzeroSessionRequest, 'session'),
        /nonzero-exit/
    );
    assert.strictEqual(nonzeroSessionHarness.ambiguous.size, 0);
    await new backendModule.TmuxRuntimeBackend(nonzeroSessionHarness.dependencies)
        .ensureResume(nonzeroSessionRequest, 'session');
    assert.strictEqual(nonzeroSessionHarness.operations.filter(item => item.type === 'new-session').length, 2);

    const nonzeroProjectHarness = createTmuxBackendHarness({ failCreateWindowNonzeroCount: 1 });
    const nonzeroProjectRequest = {
        identity: { provider: 'claude', workspaceScopeIdentity: 'nonzero-project', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'Claude: Nonzero',
        launch: { executable: 'claude', args: ['--resume', 's1'] },
    };
    await assert.rejects(
        new backendModule.TmuxRuntimeBackend(nonzeroProjectHarness.dependencies)
            .ensureResume(nonzeroProjectRequest, 'project'),
        /nonzero-exit/
    );
    assert.strictEqual(nonzeroProjectHarness.ambiguous.size, 0);
    await new backendModule.TmuxRuntimeBackend(nonzeroProjectHarness.dependencies)
        .ensureResume(nonzeroProjectRequest, 'project');
    assert.strictEqual(nonzeroProjectHarness.operations.filter(item => item.type === 'new-session').length, 1);
    assert.strictEqual(nonzeroProjectHarness.operations.filter(item => item.type === 'new-window').length, 2);

    const occupiedHarness = createTmuxBackendHarness();
    const occupiedIdentity = { provider: 'codex', workspaceScopeIdentity: 'occupied', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' };
    const occupiedLocator = tmuxNaming.buildReadableTmuxLocator(
        occupiedIdentity, 'session', { projectName: 'App', sessionName: 's1' }
    );
    occupiedHarness.windows.push({
        ...occupiedLocator, windowName: 'shell', windowId: '@occupied', active: true,
        sessionMetadata: {}, windowMetadata: {}, metadata: {},
    });
    const occupiedBackend = new backendModule.TmuxRuntimeBackend(occupiedHarness.dependencies);
    await assert.rejects(occupiedBackend.ensureResume({
        identity: occupiedIdentity, projectName: 'App', terminalName: 'Codex: s1',
        launch: { executable: 'codex', args: ['resume', 's1'] },
    }, 'session'), /unverified/);
    assert.strictEqual(occupiedHarness.operations.filter(item => item.type === 'new-session').length, 0);

    const occupiedProjectHarness = createTmuxBackendHarness();
    const occupiedProjectBackend = new backendModule.TmuxRuntimeBackend(occupiedProjectHarness.dependencies);
    await occupiedProjectBackend.ensureResume({
        identity: { provider: 'codex', workspaceScopeIdentity: 'occupied-project', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'existing' },
        projectName: 'App', terminalName: 'AI Sessions: Occupied',
        launch: { executable: 'codex', args: ['resume', 'existing'] },
    }, 'project');
    const unknownProjectIdentity = {
        provider: 'claude', workspaceScopeIdentity: 'occupied-project', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'unknown',
    };
    const unknownProjectLocator = {
        ...tmuxNaming.buildReadableTmuxLocator(
            unknownProjectIdentity, 'project', { projectName: 'App', sessionName: 'unknown' }
        ),
        sessionName: occupiedProjectBackend.getActive()[0].tmux.sessionName,
    };
    occupiedProjectHarness.windows.push({
        ...unknownProjectLocator, windowId: '@occupied-project', active: false,
        sessionMetadata: {
            managed: '1', version: '2', layout: 'project', workspaceScopeIdentity: 'occupied-project',
        },
        windowMetadata: {}, metadata: {},
    });
    await assert.rejects(occupiedProjectBackend.ensureResume({
        identity: unknownProjectIdentity, projectName: 'App', terminalName: 'AI Sessions: Occupied',
        launch: { executable: 'claude', args: ['--resume', 'unknown'] },
    }, 'project'), /occupied/);
    assert.strictEqual(occupiedProjectHarness.operations.filter(item => item.type === 'new-window').length, 1);

    const unavailablePosixHarness = createTmuxBackendHarness({
        availability: { available: false, category: 'not-found', message: 'tmux unavailable' },
    });
    const unavailablePosixBackend = new backendModule.TmuxRuntimeBackend(unavailablePosixHarness.dependencies);
    await assert.rejects(unavailablePosixBackend.ensureResume({
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'Codex: s1',
        launch: { executable: 'codex', args: ['resume', 's1'] },
    }, 'session'), /tmux unavailable/);
    assert.strictEqual(unavailablePosixHarness.operations.some(item => item.type === 'lock'), false);

    const unavailableHarness = createTmuxBackendHarness({ platform: 'win32' });
    const unavailableBackend = new backendModule.TmuxRuntimeBackend(unavailableHarness.dependencies);
    await assert.rejects(unavailableBackend.ensureResume({
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'Codex: s1',
        launch: { executable: 'codex', args: ['resume', 's1'] },
    }, 'session'), /POSIX/);
    assert.strictEqual(unavailableHarness.operations.filter(item => item.type === 'new-session').length, 0);

    const restoreHarness = createTmuxBackendHarness();
    const restoreBackend = new backendModule.TmuxRuntimeBackend(restoreHarness.dependencies);
    const restorable = await restoreBackend.ensureResume({
        identity: { provider: 'codex', workspaceScopeIdentity: 'restore', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'AI Sessions: Restore',
        launch: { executable: 'codex', args: ['resume', 's1'], markerPath: '/tmp/r1' },
    }, 'project');
    const originalTerminal = restorable.terminal;
    const originalProcessId = await originalTerminal.processId;
    await restoreHarness.attachStore.flush();
    const persistedBinding = restoreHarness.attachBindings.get(originalProcessId);
    restoreBackend.handleClosedTerminal(originalTerminal);
    await restoreHarness.attachStore.flush();
    const restoredTerminal = {
        name: originalTerminal.name,
        creationOptions: {},
        processId: Promise.resolve(originalProcessId),
        shown: false,
        disposed: false,
        show() { this.shown = true; },
        dispose() { this.disposed = true; },
    };
    restoreHarness.attachBindings.set(originalProcessId, persistedBinding);
    await restoreBackend.restoreAttachTerminals([restoredTerminal]);
    assert.ok(restoreBackend.getActive().every(runtime => runtime.terminal === restoredTerminal));
    restoreBackend.handleClosedTerminal(restoredTerminal);
    assert.ok(restoreBackend.getActive().every(runtime => !runtime.terminal));

    const reusedPidTerminal = { ...restoredTerminal, name: 'Unrelated shell' };
    restoreHarness.attachBindings.set(originalProcessId, persistedBinding);
    await restoreBackend.restoreAttachTerminals([reusedPidTerminal]);
    await restoreHarness.attachStore.flush();
    assert.strictEqual(restoreHarness.attachBindings.has(originalProcessId), false);
}

function fakeRuntime(backend, sessionId, overrides = {}) {
    return {
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId },
        backend,
        state: 'active',
        markerPath: '/tmp/m',
        runStartedAtMs: 1,
        attached: true,
        ...overrides,
    };
}

function fakeResumeRequest(sessionId) {
    return {
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId },
        projectName: 'App',
        sessionName: `Session ${sessionId}`,
        terminalName: 'Codex: App',
        launch: { executable: 'codex', args: ['resume', sessionId], markerPath: '/tmp/m' },
        directoryScope: createDirectoryScope('/work'),
    };
}

function fakeCreateRequest(pendingId) {
    return {
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId },
        projectName: 'App',
        terminalName: 'Codex: App',
        createdAt: '2026-07-18T10:00:00.000Z',
        excludedSessionIds: ['old'],
        title: 'New work',
        launch: { executable: 'codex', args: [], markerPath: '/tmp/pending' },
        directoryScope: createDirectoryScope('/work'),
    };
}

function fakeUnavailableError() {
    return new runtimeTypesModule.TmuxRuntimeUnavailableError(
        'not-found', 'tmux unavailable'
    );
}

function createFakeRuntimeBackend(backend, options = {}) {
    let remainingEnsureErrors = options.ensureErrorCount || 0;
    const focusErrors = [...(options.focusErrors || [])];
    const fake = {
        backend,
        active: [],
        pending: [],
        conflicts: [],
        lifecycleBlockers: [],
        recoverablePending: [],
        refreshCalls: [],
        ensureResumeCalls: 0,
        ensureResumeRequests: [],
        ensureResumeLayouts: [],
        ensurePendingCalls: 0,
        focusAttempts: [],
        focusCalls: [],
        detachCalls: [],
        closed: [],
        promoted: [],
    };
    fake.refresh = async force => {
        fake.refreshCalls.push(force);
        if (options.refreshError) throw options.refreshError;
        if (options.onRefresh) options.onRefresh(fake, force);
    };
    fake.getActive = () => fake.active.map(runtime => ({
        ...runtime,
        identity: { ...runtime.identity },
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    }));
    fake.getPending = () => fake.pending.map(runtime => ({
        ...runtime,
        identity: { ...runtime.identity },
        excludedSessionIds: runtime.excludedSessionIds.slice(),
    }));
    fake.listRecoverablePending = async () => fake.recoverablePending.map(runtime => ({
        ...runtime,
        identity: { ...runtime.identity },
        excludedSessionIds: runtime.excludedSessionIds.slice(),
    }));
    fake.getConflicts = () => fake.conflicts.map(runtime => ({
        ...runtime,
        identity: { ...runtime.identity },
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    }));
    fake.getLifecycleBlockers = () => fake.lifecycleBlockers.map(runtime => ({
        ...runtime,
        identity: { ...runtime.identity },
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    }));
    fake.find = identity => fake.getActive().filter(item =>
        item.identity.provider === identity.provider
        && item.identity.workspaceScopeIdentity === identity.workspaceScopeIdentity
        && item.identity.sessionId === identity.sessionId);
    fake.focus = async runtime => {
        fake.focusAttempts.push(runtime);
        if (focusErrors.length) throw focusErrors.shift();
        fake.focusCalls.push(runtime);
    };
    fake.detach = async runtime => { fake.detachCalls.push(runtime); };
    fake.ensureResume = async (request, layout) => {
        fake.ensureResumeCalls++;
        fake.ensureResumeRequests.push(request);
        fake.ensureResumeLayouts.push(layout);
        if (options.resumeGate) await options.resumeGate.promise;
        if (remainingEnsureErrors > 0) {
            remainingEnsureErrors--;
            throw options.ensureError || new Error('ensure failed');
        }
        if (options.ensureError && options.ensureErrorCount === undefined) throw options.ensureError;
        const runtime = fakeRuntime(backend, request.identity.sessionId,
            backend === 'tmux' ? { tmux: { layout, sessionName: 'managed' } } : {});
        fake.active.push(runtime);
        return runtime;
    };
    fake.ensurePending = async (request, layout) => {
        fake.ensurePendingCalls++;
        if (options.pendingGate) await options.pendingGate.promise;
        if (remainingEnsureErrors > 0) {
            remainingEnsureErrors--;
            throw options.ensureError || new Error('ensure failed');
        }
        if (options.ensureError && options.ensureErrorCount === undefined) throw options.ensureError;
        const runtime = {
            ...fakeRuntime(backend, undefined),
            identity: { ...request.identity },
            state: 'pending',
            createdAt: request.createdAt,
            excludedSessionIds: request.excludedSessionIds.slice(),
            title: request.title,
            ...(backend === 'tmux' ? { tmux: { layout, sessionName: 'managed-pending' } } : {}),
        };
        fake.pending.push(runtime);
        return runtime;
    };
    fake.promotePending = async (identity, sessionId, sessionName) => {
        fake.promoted.push({ identity: { ...identity }, sessionId, sessionName });
        return [{ ...fakeRuntime(backend, sessionId), identity: { ...identity, pendingId: undefined, sessionId } }];
    };
    fake.handleClosedTerminal = terminal => { fake.closed.push(terminal); };
    return fake;
}

async function runDirectBackendChecks() {
    const terminalA = { name: 'Codex: Existing' };
    const terminalPending = { name: 'Codex: Pending' };
    const terminals = [{
        provider: 'codex', sessionId: 'existing', terminal: terminalA,
        markerPath: '/tmp/existing', runStartedAtMs: 10, cwd: '/work',
        runtimeIdentity: {
            provider: 'codex', workspaceScopeIdentity: '/work', workspaceNavigationIdentity: 'nav-1',
            workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'existing',
        },
    }];
    const pending = [{
        provider: 'codex', terminal: terminalPending, markerPath: '/tmp/pending', cwd: '/work',
        createdAt: '2026-07-18T10:00:00.000Z', excludedSessionIds: ['old'],
        projectName: 'Existing Workspace Card', title: 'New work',
        runtimeIdentity: {
            provider: 'codex', workspaceScopeIdentity: '/work', workspaceNavigationIdentity: 'nav-1',
            workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: '2026-07-18T10:00:00.000Z',
        },
    }];
    const operations = [];
    let nextTerminal = 1;
    let rejectNextCwd = false;
    const terminalService = {
        getTrackedTerminalEntries: () => terminals.map(entry => ({ ...entry })),
        getPendingTerminals: () => pending.map(entry => ({
            ...entry, excludedSessionIds: entry.excludedSessionIds.slice(),
        })),
        isComplete: entry => entry.markerPath === '/tmp/complete',
        createTerminal: options => {
            const terminal = { name: options.name, id: nextTerminal++ };
            operations.push({ type: 'create', options, terminal });
            const cwdAccepted = !rejectNextCwd;
            rejectNextCwd = false;
            return { terminal, cwdAccepted };
        },
        getProviderTerminalEnvironment: (provider, sessionId) => ({ AI_PROVIDER: provider, AI_SESSION: sessionId }),
        sendRuntimeLaunch: async (terminal, launch, options) => {
            operations.push({ type: 'launch', terminal, launch, options });
        },
        track: (provider, sessionId, entry) => {
            const existingIndex = terminals.findIndex(candidate =>
                candidate.provider === provider && candidate.sessionId === sessionId);
            if (existingIndex >= 0) {
                terminals.splice(existingIndex, 1, { provider, sessionId, ...entry });
            } else {
                terminals.push({ provider, sessionId, ...entry });
            }
            operations.push({ type: 'track', provider, sessionId, entry });
        },
        trackPending: entry => {
            pending.push(entry);
            operations.push({ type: 'track-pending', entry });
        },
        replacePendingTerminals: entries => {
            pending.splice(0, pending.length, ...entries);
            operations.push({ type: 'replace-pending', entries });
        },
        focusTerminal: terminal => { operations.push({ type: 'focus', terminal }); },
        closeTerminal: terminal => { operations.push({ type: 'close', terminal }); },
        handleClosedTerminal: terminal => {
            operations.push({ type: 'closed', terminal });
            return [];
        },
    };
    const backend = new directBackendModule.DirectTerminalRuntimeBackend(terminalService, () => 100);
    await backend.refresh(true);
    const projected = backend.getActive();
    assert.strictEqual(projected.length, 1);
    assert.deepStrictEqual(projected[0].identity, {
        provider: 'codex', workspaceScopeIdentity: '/work', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'existing',
    });
    projected[0].identity.sessionId = 'mutated';
    assert.strictEqual(backend.getActive()[0].identity.sessionId, 'existing');
    assert.strictEqual(backend.getPending()[0].identity.pendingId, '2026-07-18T10:00:00.000Z');
    assert.strictEqual(backend.getPending()[0].projectName, 'Existing Workspace Card');

    const resumed = await backend.ensureResume(fakeResumeRequest('fresh'));
    assert.strictEqual(resumed.backend, 'vscode');
    assert.deepStrictEqual(operations.filter(item => item.type === 'create').pop().options.env, {
        AI_PROVIDER: 'codex', AI_SESSION: 'fresh',
    });
    assert.deepStrictEqual(operations.filter(item => item.type === 'launch').pop().options, {
        deleteMarkerBeforeLaunch: true,
    });
    assert.strictEqual(operations.filter(item => item.type === 'track').length, 1);

    const completedTerminal = { name: 'Codex: Completed' };
    terminals.push({
        provider: 'codex', sessionId: 'completed', terminal: completedTerminal,
        markerPath: '/tmp/complete', runStartedAtMs: 20, cwd: '/work',
        runtimeIdentity: {
            provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1',
            workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'completed',
        },
    });
    const createCountBeforeCompleted = operations.filter(item => item.type === 'create').length;
    await assert.rejects(backend.ensureResume(fakeResumeRequest('completed')),
        error => error && error.name === 'AiSessionRuntimeLifecycleBlockedError');
    assert.strictEqual(operations.filter(item => item.type === 'launch').some(item =>
        item.terminal === completedTerminal), false,
    'an unacknowledged Direct completion must block provider replay');
    terminals.find(entry => entry.sessionId === 'completed').released = true;
    const completed = await backend.ensureResume(fakeResumeRequest('completed'));
    assert.strictEqual(completed.terminal, completedTerminal);
    assert.strictEqual(operations.filter(item => item.type === 'create').length, createCountBeforeCompleted);
    assert.strictEqual(operations.filter(item => item.type === 'launch').pop().terminal, completedTerminal);
    assert.strictEqual(operations.filter(item => item.type === 'track').pop().sessionId, 'completed');

    const duplicateCompletedTerminal = { name: 'Codex: Duplicate completed' };
    terminals.push({
        provider: 'codex', sessionId: 'completed', terminal: duplicateCompletedTerminal,
        markerPath: '/tmp/duplicate-active', runStartedAtMs: 21, cwd: '/work',
        runtimeIdentity: {
            provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1',
            workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: 'completed',
        },
    });
    await assert.rejects(backend.ensureResume(fakeResumeRequest('completed')), /Multiple Direct Terminal/);
    assert.strictEqual(operations.filter(item => item.type === 'create').length, createCountBeforeCompleted);
    terminals.splice(terminals.findIndex(entry => entry.terminal === duplicateCompletedTerminal), 1);

    rejectNextCwd = true;
    const cwdRejectedRequest = fakeResumeRequest('cwd-rejected');
    cwdRejectedRequest.launch.cwd = '/work';
    await backend.ensureResume(cwdRejectedRequest);
    const cwdRejectedLaunch = operations.filter(item => item.type === 'launch').pop().launch;
    assert.strictEqual(cwdRejectedLaunch.cwd, '/work');
    assert.strictEqual(cwdRejectedRequest.launch.cwd, '/work');

    rejectNextCwd = true;
    const pendingCwdRejectedRequest = fakeCreateRequest('pending-cwd-rejected');
    pendingCwdRejectedRequest.launch.cwd = '/work';
    await backend.ensurePending(pendingCwdRejectedRequest);
    const pendingCwdRejectedLaunch = operations.filter(item => item.type === 'launch').pop().launch;
    assert.strictEqual(pendingCwdRejectedLaunch.cwd, '/work');
    assert.strictEqual(pendingCwdRejectedRequest.launch.cwd, '/work');

    const created = await backend.ensurePending(fakeCreateRequest('pending-1'));
    assert.strictEqual(created.identity.pendingId, 'pending-1');
    assert.strictEqual(created.projectName, 'App');
    assert.strictEqual(operations.filter(item => item.type === 'track-pending').length, 2);
    assert.deepStrictEqual(operations.filter(item => item.type === 'launch').pop().options, {
        persistPendingBeforeLaunch: true,
    });
    for (const invalidDisplayName of ['', 'x'.repeat(201), 'bad\nname']) {
        assert.deepStrictEqual(await backend.promotePending(
            created.identity, 'new-session', invalidDisplayName
        ), [], 'Direct promotion must reject invalid display names without consuming the pending runtime');
        assert.strictEqual(backend.getPending().some(item => item.identity.pendingId === 'pending-1'), true);
    }
    const promoted = await backend.promotePending(
        created.identity, 'new-session', 'Readable Direct Session'
    );
    assert.strictEqual(promoted[0].identity.sessionId, 'new-session');
    assert.strictEqual(promoted[0].terminal, created.terminal);
    assert.strictEqual(backend.getPending().some(item => item.identity.pendingId === 'pending-1'), false);

    await backend.focus(promoted[0]);
    await backend.detach(promoted[0]);
    backend.handleClosedTerminal(promoted[0].terminal);
    assert.strictEqual(operations.filter(item => item.type === 'focus').length, 6);
    assert.strictEqual(operations.filter(item => item.type === 'close').length, 1);
    assert.strictEqual(operations.filter(item => item.type === 'closed').length, 1);
}

async function runRuntimeCoordinatorChecks() {
    const direct = createFakeRuntimeBackend('vscode');
    const tmux = createFakeRuntimeBackend('tmux');
    let configuration = { mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' };
    let configurationReads = 0;
    const coordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct,
        tmux,
        getConfiguration: () => {
            configurationReads++;
            return { ...configuration };
        },
        chooseTmuxFallback: async () => 'cancel',
    });

    const nestedCwd = '/work/api/packages/service';
    for (const expected of [
        { mode: 'vscode', tmuxLayout: 'project', backend: 'vscode', layout: undefined },
        { mode: 'tmux', tmuxLayout: 'project', backend: 'tmux', layout: 'project' },
        { mode: 'tmux', tmuxLayout: 'session', backend: 'tmux', layout: 'session' },
    ]) {
        const modeDirect = createFakeRuntimeBackend('vscode');
        const modeTmux = createFakeRuntimeBackend('tmux');
        const modeCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
            direct: modeDirect,
            tmux: modeTmux,
            getConfiguration: () => ({ ...expected, tmuxPath: 'tmux' }),
            chooseTmuxFallback: async () => 'cancel',
        });
        const request = fakeResumeRequest(`nested-${expected.mode}-${expected.tmuxLayout}`);
        request.identity.workspaceRootHostPaths = ['/work/api', '/work/web'];
        request.identity.cwd = nestedCwd;
        request.launch.cwd = nestedCwd;
        request.directoryScope = {
            ...createDirectoryScope(nestedCwd, ['/work/web']),
            workspaceRootHostPaths: ['/work/api', '/work/web'],
            primaryRootId: 'root-api',
        };
        await modeCoordinator.resume(request);
        const selectedBackend = expected.backend === 'vscode' ? modeDirect : modeTmux;
        assert.strictEqual(selectedBackend.ensureResumeRequests[0].identity.cwd, nestedCwd);
        assert.strictEqual(selectedBackend.ensureResumeRequests[0].launch.cwd, nestedCwd);
        assert.strictEqual(selectedBackend.ensureResumeRequests[0].directoryScope.primaryCwd, nestedCwd);
        assert.strictEqual(selectedBackend.ensureResumeLayouts[0], expected.layout,
            `${expected.mode}/${expected.tmuxLayout} must consume the exact nested launch scope`);
    }

    for (const operation of ['focus', 'detach']) {
        const isolatedDirect = createFakeRuntimeBackend('vscode');
        isolatedDirect.active.push(fakeRuntime('vscode', `direct-${operation}`));
        const unavailableTmux = createFakeRuntimeBackend('tmux', {
            refreshError: fakeUnavailableError(),
        });
        const isolatedCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
            direct: isolatedDirect,
            tmux: unavailableTmux,
            getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
            chooseTmuxFallback: async () => 'cancel',
            hasLiveTmuxOwnership: async () => false,
        });
        await isolatedCoordinator[operation]({
            provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: `direct-${operation}`,
        });
        assert.deepStrictEqual(isolatedDirect.refreshCalls, [true]);
        assert.deepStrictEqual(unavailableTmux.refreshCalls, [],
            `${operation} of a cached unique Direct runtime must not probe tmux`);
        assert.strictEqual(isolatedDirect[`${operation}Calls`].length, 1);
    }

    const hostDirect = createFakeRuntimeBackend('vscode');
    const hostUnavailableTmux = createFakeRuntimeBackend('tmux', {
        refreshError: fakeUnavailableError(),
    });
    let hostHasLiveOwnership = false;
    const hostRefreshCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: hostDirect,
        tmux: hostUnavailableTmux,
        getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
        hasLiveTmuxOwnership: async () => hostHasLiveOwnership,
    });
    await hostRefreshCoordinator.refreshForHost(true);
    assert.deepStrictEqual(hostDirect.refreshCalls, [true]);
    assert.deepStrictEqual(hostUnavailableTmux.refreshCalls, [true]);
    hostHasLiveOwnership = true;
    await assert.rejects(hostRefreshCoordinator.refreshForHost(true),
        error => error instanceof runtimeTypesModule.TmuxRuntimeUnavailableError);

    const unsafeHostError = new Error('plain host refresh failure');
    const unsafeHostCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: createFakeRuntimeBackend('vscode'),
        tmux: createFakeRuntimeBackend('tmux', { refreshError: unsafeHostError }),
        getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
        hasLiveTmuxOwnership: async () => false,
    });
    await assert.rejects(unsafeHostCoordinator.refreshForHost(true), error => error === unsafeHostError,
        'only structured tmux-unavailable errors may be ignored for an ownership-free Direct host');

    for (const [blockerBackend, blockerState] of [
        ['vscode', 'completed'], ['tmux', 'completed'], ['tmux', 'stopped'],
    ]) {
        const blockedDirect = createFakeRuntimeBackend('vscode');
        const blockedTmux = createFakeRuntimeBackend('tmux');
        const blocker = fakeRuntime(blockerBackend, `blocked-${blockerBackend}-${blockerState}`, {
            state: blockerState,
            attached: blockerBackend === 'vscode',
            ...(blockerBackend === 'tmux'
                ? { tmux: { layout: 'session', sessionName: `blocked-${blockerState}` } }
                : {}),
        });
        (blockerBackend === 'vscode' ? blockedDirect : blockedTmux).lifecycleBlockers.push(blocker);
        let blockedFallbackChoices = 0;
        const blockedCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
            direct: blockedDirect, tmux: blockedTmux,
            getConfiguration: () => ({
                mode: blockerBackend, tmuxLayout: 'session', tmuxPath: 'tmux',
            }),
            chooseTmuxFallback: async () => { blockedFallbackChoices++; return 'direct'; },
            hasLiveTmuxOwnership: async () => false,
        });
        const blockedResult = await blockedCoordinator.resume(
            fakeResumeRequest(blocker.identity.sessionId)
        );
        assert.strictEqual(blockedResult.status, 'blocked');
        assert.strictEqual(blockedResult.blockers.length, 1);
        assert.strictEqual(blockedDirect.ensureResumeCalls + blockedTmux.ensureResumeCalls, 0,
            `${blockerState} ${blockerBackend} lifecycle ownership must block replay before acknowledgement`);
        assert.strictEqual(blockedFallbackChoices, 0,
            'typed lifecycle blockers must never enter unavailable fallback');
        blockedResult.blockers[0].identity.sessionId = 'mutated';
        assert.strictEqual((blockerBackend === 'vscode' ? blockedDirect : blockedTmux)
            .lifecycleBlockers[0].identity.sessionId, blocker.identity.sessionId);
        blockedDirect.lifecycleBlockers = [];
        blockedTmux.lifecycleBlockers = [];
        const resumedAfterAck = await blockedCoordinator.resume(
            fakeResumeRequest(blocker.identity.sessionId)
        );
        assert.strictEqual(resumedAfterAck.status, 'started',
            'resume is allowed only after lifecycle acknowledgement removes the blocker');
    }

    const freshLifecycleDirect = createFakeRuntimeBackend('vscode', {
        onRefresh: backend => {
            backend.lifecycleBlockers = [fakeRuntime('vscode', 'fresh-lifecycle-blocker', {
                state: 'completed', attached: true, runStartedAtMs: 321,
            })];
        },
    });
    const freshLifecycleCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: freshLifecycleDirect, tmux: createFakeRuntimeBackend('tmux'),
        getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'direct', hasLiveTmuxOwnership: async () => false,
    });
    assert.strictEqual((await freshLifecycleCoordinator.resume(
        fakeResumeRequest('fresh-lifecycle-blocker')
    )).status, 'blocked', 'forced refresh lifecycle blockers are atomic resume inputs');
    assert.strictEqual(freshLifecycleDirect.ensureResumeCalls, 0);
    tmux.active.push(fakeRuntime('tmux', 's1'));
    const existing = await coordinator.resume(fakeResumeRequest('s1'));
    assert.strictEqual(existing.status, 'focused');
    assert.strictEqual(existing.runtime.backend, 'tmux');
    assert.strictEqual(direct.ensureResumeCalls, 0);
    assert.deepStrictEqual(direct.refreshCalls, [true]);
    assert.deepStrictEqual(tmux.refreshCalls, [true]);
    assert.strictEqual(configurationReads, 0);

    direct.active.push(fakeRuntime('vscode', 's1'));
    const conflict = await coordinator.resume(fakeResumeRequest('s1'));
    assert.strictEqual(conflict.status, 'conflict');
    assert.strictEqual(conflict.conflicts.length, 2);
    assert.strictEqual(direct.ensureResumeCalls + tmux.ensureResumeCalls, 0);
    assert.strictEqual(configurationReads, 0);
    conflict.conflicts[0].identity.sessionId = 'mutated';
    assert.strictEqual(coordinator.getActive().some(runtime => runtime.identity.sessionId === 'mutated'), false);

    const freshCollisionTmux = createFakeRuntimeBackend('tmux', {
        onRefresh: backend => {
            backend.active = [];
            backend.conflicts = [fakeRuntime('tmux', 'fresh-collision', {
                state: 'conflict', attached: false,
                tmux: { layout: 'session', sessionName: 'fresh-collision-target' },
            })];
        },
    });
    const freshCollisionDirect = createFakeRuntimeBackend('vscode');
    const freshCollisionCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: freshCollisionDirect,
        tmux: freshCollisionTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'session', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    const freshCollisionResult = await freshCollisionCoordinator.resume(
        fakeResumeRequest('fresh-collision')
    );
    assert.strictEqual(freshCollisionResult.status, 'conflict',
        'a collision discovered by the action forced refresh must be an atomic resume input');
    assert.strictEqual(freshCollisionDirect.ensureResumeCalls, 0);
    assert.strictEqual(freshCollisionTmux.ensureResumeCalls, 0,
        'a fresh collision must never dispatch a provider resume command');
    freshCollisionResult.conflicts[0].tmux.sessionName = 'mutated';
    assert.strictEqual(freshCollisionCoordinator.getConflicts()[0].tmux.sessionName,
        'fresh-collision-target', 'coordinator conflict snapshots must be defensive copies');

    const freshPendingCollisionTmux = createFakeRuntimeBackend('tmux', {
        onRefresh: backend => {
            backend.conflicts = [{
                ...fakeRuntime('tmux', undefined, { state: 'conflict', attached: false }),
                identity: {
                    provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
                    pendingId: 'fresh-pending-collision',
                },
                tmux: { layout: 'project', sessionName: 'pending-collision', windowName: 'occupied' },
            }];
        },
    });
    const freshPendingCollisionCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: createFakeRuntimeBackend('vscode'), tmux: freshPendingCollisionTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    const freshPendingCollision = await freshPendingCollisionCoordinator.create(
        fakeCreateRequest('fresh-pending-collision')
    );
    assert.strictEqual(freshPendingCollision.status, 'conflict');
    assert.strictEqual(freshPendingCollisionTmux.ensurePendingCalls, 0,
        'a fresh pending collision must never dispatch a provider create command');

    const backendConflictRuntime = fakeRuntime('tmux', 'backend-typed-conflict', {
        state: 'conflict', attached: false,
        tmux: { layout: 'session', sessionName: 'backend-typed-conflict' },
    });
    const typedConflictTmux = createFakeRuntimeBackend('tmux', {
        ensureError: new runtimeTypesModule.AiSessionRuntimeConflictError([backendConflictRuntime]),
    });
    let typedConflictFallbackChoices = 0;
    const typedConflictCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: createFakeRuntimeBackend('vscode'), tmux: typedConflictTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'session', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => { typedConflictFallbackChoices++; return 'direct'; },
    });
    const typedBackendConflict = await typedConflictCoordinator.resume(
        fakeResumeRequest('backend-typed-conflict')
    );
    assert.strictEqual(typedBackendConflict.status, 'conflict');
    assert.strictEqual(typedConflictFallbackChoices, 0,
        'a typed collision error must never enter unavailable fallback');

    const plainNamedConflict = Object.assign(new Error('plain named collision'), {
        name: 'AiSessionRuntimeConflictError', conflicts: [backendConflictRuntime],
    });
    const plainConflictTmux = createFakeRuntimeBackend('tmux', { ensureError: plainNamedConflict });
    let plainConflictFallbackChoices = 0;
    const plainConflictCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: createFakeRuntimeBackend('vscode'), tmux: plainConflictTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'session', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => { plainConflictFallbackChoices++; return 'direct'; },
    });
    await assert.rejects(plainConflictCoordinator.resume(
        fakeResumeRequest('plain-named-conflict')
    ), error => error === plainNamedConflict);
    assert.strictEqual(plainConflictFallbackChoices, 0,
        'plain conflict-shaped errors must fail closed instead of entering fallback');

    for (const operation of ['focus', 'detach']) {
        let firstRefresh = true;
        const guardedTmux = createFakeRuntimeBackend('tmux', {
            ...(operation === 'focus' ? {
                focusErrors: [new runtimeTypesModule.AiSessionRuntimeTargetChangedError()],
            } : {}),
            onRefresh: backend => {
                if (firstRefresh) {
                    firstRefresh = false;
                    backend.active = [];
                    backend.conflicts = [fakeRuntime('tmux', `guarded-${operation}`, {
                        state: 'conflict', attached: false,
                        tmux: { layout: 'session', sessionName: `guarded-${operation}` },
                    })];
                }
            },
        });
        guardedTmux.active.push(fakeRuntime('tmux', `guarded-${operation}`, {
            attached: false,
            tmux: { layout: 'session', sessionName: `guarded-${operation}` },
        }));
        const guardedActionCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
            direct: createFakeRuntimeBackend('vscode'), tmux: guardedTmux,
            getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'session', tmuxPath: 'tmux' }),
            chooseTmuxFallback: async () => 'cancel',
        });
        await guardedActionCoordinator[operation]({
            provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', sessionId: `guarded-${operation}`,
        });
        assert.deepStrictEqual(guardedTmux[`${operation}Calls`], [],
            `${operation} must not act on a runtime replaced by a fresh collision`);
        assert.deepStrictEqual(guardedTmux.refreshCalls, [true]);
    }

    const duplicate = createFakeRuntimeBackend('vscode');
    duplicate.active.push(fakeRuntime('vscode', 'duplicate'));
    duplicate.active.push(fakeRuntime('vscode', 'duplicate'));
    const duplicateCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: duplicate,
        tmux: createFakeRuntimeBackend('tmux'),
        getConfiguration: () => configuration,
        chooseTmuxFallback: async () => 'cancel',
    });
    assert.strictEqual((await duplicateCoordinator.resume(fakeResumeRequest('duplicate'))).status, 'conflict');
    assert.strictEqual(duplicateCoordinator.getById('codex', 'duplicate', 'pk'), null);

    configuration = { ...configuration, mode: 'tmux', tmuxLayout: 'session' };
    direct.active.push(fakeRuntime('vscode', 'existing-direct'));
    const existingDirect = await coordinator.resume(fakeResumeRequest('existing-direct'));
    assert.strictEqual(existingDirect.status, 'focused');
    assert.strictEqual(existingDirect.runtime.backend, 'vscode');
    assert.strictEqual(configurationReads, 0);
    const settingsWinner = await coordinator.resume(fakeResumeRequest('new-tmux'));
    assert.strictEqual(settingsWinner.status, 'started');
    assert.strictEqual(settingsWinner.runtime.backend, 'tmux');
    assert.strictEqual(configurationReads, 1);

    const gate = deferred();
    const guardedDirect = createFakeRuntimeBackend('vscode', { resumeGate: gate });
    const guardedCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: guardedDirect,
        tmux: createFakeRuntimeBackend('tmux'),
        getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    const first = guardedCoordinator.resume(fakeResumeRequest('single'));
    const second = guardedCoordinator.resume(fakeResumeRequest('single'));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(guardedDirect.ensureResumeCalls, 1);
    gate.resolve();
    const sharedResults = await Promise.all([first, second]);
    assert.deepStrictEqual(sharedResults.map(result => result.status), ['started', 'focused'],
        'only the request that owns the launch may receive a started result');
    assert.strictEqual(sharedResults[0].runtime.identity.sessionId, 'single');
    sharedResults[0].runtime.identity.sessionId = 'changed';
    assert.strictEqual(sharedResults[1].runtime.identity.sessionId, 'single');

    const scopedGate = deferred();
    const scopedDirect = createFakeRuntimeBackend('vscode', { resumeGate: scopedGate });
    const scopedCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: scopedDirect,
        tmux: createFakeRuntimeBackend('tmux'),
        getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    const scopedWorkspaceTarget = {
        cardId: 'scoped-workspace',
        workspace: {
            displayName: 'Scoped Workspace',
            navigationIdentity: 'navigation:scoped-workspace',
            scopeIdentity: 'scope:scoped-workspace',
            roots: [],
        },
        sessions: {
            sessionsByProvider: {
                codex: [{ id: 'scoped-session', cwd: '/work/first' }],
            },
            activeSessions: [],
        },
    };
    const firstScope = Object.freeze({
        ...createDirectoryScope('/work/first', ['/work/second']),
        workspaceScopeIdentity: 'scope:scoped-workspace',
    });
    const secondScope = Object.freeze({
        ...createDirectoryScope('/work/second', ['/work/first']),
        workspaceScopeIdentity: 'scope:scoped-workspace',
    });
    const rememberedScopes = [];
    const createScopedResumeController = directoryScope => new ResumeController({
        getWorkspaceTarget: cardId => cardId === scopedWorkspaceTarget.cardId
            ? scopedWorkspaceTarget
            : null,
        getProvider: () => ({
            label: 'Codex',
            terminalEnvKey: 'CODEX_SESSION_ID',
            buildResumeLaunchSpec: sessionId => ({
                executable: 'codex', args: ['resume', sessionId], cwd: directoryScope.primaryCwd,
            }),
        }),
        resolveWorkspaceDirectoryScope: async () => directoryScope,
        rememberDirectoryScope: scope => { rememberedScopes.push(scope); },
        runtimeCoordinator: scopedCoordinator,
        getTerminalName: () => 'Codex: Scoped Session',
        getMarkerPath: () => '/tmp/scoped.marker',
        showWarningMessage: () => undefined,
        announceStatus: async () => undefined,
        refresh: () => undefined,
        showActiveTab: async () => undefined,
    });
    const firstScopedResume = createScopedResumeController(firstScope)
        .resumeProjectSession(scopedWorkspaceTarget.cardId, 'codex', 'scoped-session');
    const secondScopedResume = createScopedResumeController(secondScope)
        .resumeProjectSession(scopedWorkspaceTarget.cardId, 'codex', 'scoped-session');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(scopedDirect.ensureResumeCalls, 1,
        'concurrent resume requests for one session must launch exactly once');
    assert.deepStrictEqual(scopedDirect.ensureResumeRequests[0].directoryScope, firstScope,
        'the first request scope snapshot must own the single launch');
    assert.notStrictEqual(scopedDirect.ensureResumeRequests[0].directoryScope, firstScope,
        'the launch scope must be a defensive snapshot');
    scopedGate.resolve();
    await Promise.all([firstScopedResume, secondScopedResume]);
    assert.deepStrictEqual(rememberedScopes, [firstScope],
        'only the scope used by the actual launch may be persisted');

    const pendingGate = deferred();
    const guardedPending = createFakeRuntimeBackend('vscode', { pendingGate });
    const pendingCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: guardedPending,
        tmux: createFakeRuntimeBackend('tmux'),
        getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    const pendingFirst = pendingCoordinator.create(fakeCreateRequest('single-pending'));
    const pendingSecond = pendingCoordinator.create(fakeCreateRequest('single-pending'));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(guardedPending.ensurePendingCalls, 1);
    pendingGate.resolve();
    const pendingResults = await Promise.all([pendingFirst, pendingSecond]);
    pendingResults[0].runtime.excludedSessionIds.push('mutated');
    assert.deepStrictEqual(pendingResults[1].runtime.excludedSessionIds, ['old']);
    assert.deepStrictEqual(guardedPending.pending[0].excludedSessionIds, ['old']);

    const retryDirect = createFakeRuntimeBackend('vscode', {
        ensureError: new Error('first direct failure'), ensureErrorCount: 1,
    });
    const retryCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: retryDirect,
        tmux: createFakeRuntimeBackend('tmux'),
        getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    await assert.rejects(retryCoordinator.resume(fakeResumeRequest('retry')), /first direct failure/);
    const retryResult = await retryCoordinator.resume(fakeResumeRequest('retry'));
    assert.strictEqual(retryResult.status, 'started');
    assert.strictEqual(retryDirect.ensureResumeCalls, 2);

    const pendingConflictDirect = createFakeRuntimeBackend('vscode');
    const pendingConflictTmux = createFakeRuntimeBackend('tmux');
    for (const backend of [pendingConflictDirect, pendingConflictTmux]) {
        backend.pending.push({
            ...fakeRuntime(backend.backend, undefined),
            identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'action-conflict' },
            state: 'pending', createdAt: '2026-07-18T10:00:00.000Z', excludedSessionIds: ['old'],
        });
    }
    const pendingConflictCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: pendingConflictDirect,
        tmux: pendingConflictTmux,
        getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    const pendingActionConflict = await pendingConflictCoordinator.create(
        fakeCreateRequest('action-conflict')
    );
    assert.strictEqual(pendingActionConflict.status, 'conflict');
    assert.ok(pendingActionConflict.conflicts.every(runtime => runtime.state === 'conflict'));
    pendingActionConflict.conflicts[0].excludedSessionIds.push('mutated');
    assert.deepStrictEqual(pendingActionConflict.conflicts[1].excludedSessionIds, ['old']);
    assert.deepStrictEqual(pendingConflictDirect.pending[0].excludedSessionIds, ['old']);

    for (const choice of ['direct', 'settings', 'cancel']) {
        const fallbackDirect = createFakeRuntimeBackend('vscode');
        const fallbackTmux = createFakeRuntimeBackend('tmux', { ensureError: fakeUnavailableError() });
        const originalConfiguration = { mode: 'tmux', tmuxLayout: 'project', tmuxPath: '/bad/tmux' };
        const fallbackCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
            direct: fallbackDirect,
            tmux: fallbackTmux,
            getConfiguration: () => ({ ...originalConfiguration }),
            chooseTmuxFallback: async context => {
                assert.strictEqual(context.knownHint, false);
                return choice;
            },
        });
        const result = await fallbackCoordinator.resume(fakeResumeRequest(`fallback-${choice}`));
        assert.strictEqual(result.status, choice === 'direct' ? 'started'
            : choice === 'cancel' ? 'cancelled' : choice);
        assert.strictEqual(fallbackDirect.ensureResumeCalls, choice === 'direct' ? 1 : 0);
        assert.deepStrictEqual(originalConfiguration, {
            mode: 'tmux', tmuxLayout: 'project', tmuxPath: '/bad/tmux',
        });
    }

    for (const acceptedChoice of ['direct', 'direct-anyway']) {
        let cleared = 0;
        const hintedDirect = createFakeRuntimeBackend('vscode');
        const hintedCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
            direct: hintedDirect,
            tmux: createFakeRuntimeBackend('tmux', { ensureError: fakeUnavailableError() }),
            getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: '/bad/tmux' }),
            chooseTmuxFallback: async context => {
                assert.strictEqual(context.knownHint, true);
                return acceptedChoice;
            },
            hasKnownTmuxHint: async () => true,
            clearKnownTmuxHint: async () => { cleared++; },
        });
        const result = await hintedCoordinator.resume(fakeResumeRequest(`hint-${acceptedChoice}`));
        assert.strictEqual(result.status, acceptedChoice === 'direct-anyway' ? 'started' : 'cancelled');
        assert.strictEqual(hintedDirect.ensureResumeCalls, acceptedChoice === 'direct-anyway' ? 1 : 0);
        assert.strictEqual(cleared, acceptedChoice === 'direct-anyway' ? 1 : 0);
    }

    const failedDirect = createFakeRuntimeBackend('vscode', { ensureError: new Error('direct failed') });
    let failedClear = 0;
    const failedHintCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: failedDirect,
        tmux: createFakeRuntimeBackend('tmux', { ensureError: fakeUnavailableError() }),
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: '/bad/tmux' }),
        chooseTmuxFallback: async () => 'direct-anyway',
        hasKnownTmuxHint: async () => true,
        clearKnownTmuxHint: async () => { failedClear++; },
    });
    await assert.rejects(failedHintCoordinator.resume(fakeResumeRequest('hint-failed')), /direct failed/);
    assert.strictEqual(failedClear, 0);

    for (const choice of ['direct', 'settings', 'cancel']) {
        const fallbackDirect = createFakeRuntimeBackend('vscode');
        const fallbackCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
            direct: fallbackDirect,
            tmux: createFakeRuntimeBackend('tmux', { ensureError: fakeUnavailableError() }),
            getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: '/bad/tmux' }),
            chooseTmuxFallback: async context => {
                assert.strictEqual(context.operation, 'create');
                return choice;
            },
        });
        const result = await fallbackCoordinator.create(fakeCreateRequest(`create-fallback-${choice}`));
        assert.strictEqual(result.status, choice === 'direct' ? 'started'
            : choice === 'cancel' ? 'cancelled' : choice);
        assert.strictEqual(fallbackDirect.ensurePendingCalls, choice === 'direct' ? 1 : 0);
    }

    let nonUnavailableChoices = 0;
    const nonUnavailableDirect = createFakeRuntimeBackend('vscode');
    const nonUnavailableCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: nonUnavailableDirect,
        tmux: createFakeRuntimeBackend('tmux', { ensureError: new Error('provider creation timed out') }),
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => { nonUnavailableChoices++; return 'direct'; },
    });
    await assert.rejects(
        nonUnavailableCoordinator.resume(fakeResumeRequest('post-dispatch-timeout')),
        /provider creation timed out/
    );
    assert.strictEqual(nonUnavailableChoices, 0);
    assert.strictEqual(nonUnavailableDirect.ensureResumeCalls, 0);

    const spoofedUnavailable = new Error('tmux unavailable');
    spoofedUnavailable.code = 'TMUX_RUNTIME_UNAVAILABLE';
    let spoofedChoices = 0;
    const spoofedDirect = createFakeRuntimeBackend('vscode');
    const spoofedCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: spoofedDirect,
        tmux: createFakeRuntimeBackend('tmux', { ensureError: spoofedUnavailable }),
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => { spoofedChoices++; return 'direct'; },
    });
    await assert.rejects(spoofedCoordinator.resume(fakeResumeRequest('spoofed-unavailable')), error =>
        error === spoofedUnavailable);
    assert.strictEqual(spoofedChoices, 0);
    assert.strictEqual(spoofedDirect.ensureResumeCalls, 0);

    const boundaryDirect = createFakeRuntimeBackend('vscode');
    const unavailableBoundary = createTmuxBackendHarness({
        availability: { available: false, category: 'not-found', message: 'tmux unavailable' },
    });
    let boundaryChoices = 0;
    const unavailableBoundaryCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: boundaryDirect,
        tmux: new tmuxBackendModule.TmuxRuntimeBackend(unavailableBoundary.dependencies),
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: '/bad/tmux' }),
        chooseTmuxFallback: async context => {
            boundaryChoices++;
            assert.ok(context.error instanceof runtimeTypesModule.TmuxRuntimeUnavailableError);
            return 'direct';
        },
    });
    assert.strictEqual((await unavailableBoundaryCoordinator.resume(
        fakeResumeRequest('boundary-unavailable'))).status, 'started');
    assert.strictEqual(boundaryChoices, 1);
    assert.strictEqual(boundaryDirect.ensureResumeCalls, 1);

    for (const choice of ['direct', 'settings', 'cancel']) {
        const hintedRefreshBoundary = createTmuxBackendHarness({
            availability: { available: false, category: 'not-found', message: 'tmux unavailable' },
        });
        const hintedRefreshDirect = createFakeRuntimeBackend('vscode');
        let hintedRefreshChoices = 0;
        let hintedRefreshClears = 0;
        const hintedRefreshCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
            direct: hintedRefreshDirect,
            tmux: new tmuxBackendModule.TmuxRuntimeBackend(hintedRefreshBoundary.dependencies),
            getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: '/bad/tmux' }),
            chooseTmuxFallback: async context => {
                hintedRefreshChoices++;
                assert.strictEqual(context.knownHint, true);
                assert.ok(context.error instanceof runtimeTypesModule.TmuxRuntimeUnavailableError);
                return choice;
            },
            hasKnownTmuxHint: async () => true,
            clearKnownTmuxHint: async () => { hintedRefreshClears++; },
        });
        const hintedRefreshResult = await hintedRefreshCoordinator.resume(
            fakeResumeRequest(`hinted-refresh-${choice}`)
        );
        assert.strictEqual(hintedRefreshResult.status,
            choice === 'settings' ? 'settings' : 'cancelled');
        assert.strictEqual(hintedRefreshChoices, 1);
        assert.strictEqual(hintedRefreshDirect.ensureResumeCalls, 0);
        assert.strictEqual(hintedRefreshClears, 0);
        assert.strictEqual(hintedRefreshBoundary.operations.some(item => item.type === 'lock'), false);
        assert.strictEqual(hintedRefreshBoundary.operations.some(item => item.type === 'new-session'), false);
    }

    const acceptedRefreshBoundary = createTmuxBackendHarness({
        availability: { available: false, category: 'permission-denied', message: 'tmux denied' },
    });
    const acceptedRefreshDirect = createFakeRuntimeBackend('vscode');
    let acceptedRefreshClears = 0;
    const acceptedRefreshCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: acceptedRefreshDirect,
        tmux: new tmuxBackendModule.TmuxRuntimeBackend(acceptedRefreshBoundary.dependencies),
        getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: '/bad/tmux' }),
        chooseTmuxFallback: async context => {
            assert.strictEqual(context.knownHint, true);
            return 'direct-anyway';
        },
        hasKnownTmuxHint: async () => true,
        clearKnownTmuxHint: async () => { acceptedRefreshClears++; },
    });
    assert.strictEqual((await acceptedRefreshCoordinator.resume(
        fakeResumeRequest('hinted-refresh-accepted'))).status, 'started');
    assert.strictEqual(acceptedRefreshDirect.ensureResumeCalls, 1);
    assert.strictEqual(acceptedRefreshClears, 1);

    const failedRefreshBoundary = createTmuxBackendHarness({
        availability: { available: false, category: 'timeout', message: 'tmux probe timeout' },
    });
    const failedRefreshDirect = createFakeRuntimeBackend('vscode', {
        ensureError: new Error('direct refresh fallback failed'),
    });
    let failedRefreshClears = 0;
    const failedRefreshCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: failedRefreshDirect,
        tmux: new tmuxBackendModule.TmuxRuntimeBackend(failedRefreshBoundary.dependencies),
        getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: '/bad/tmux' }),
        chooseTmuxFallback: async () => 'direct-anyway',
        hasKnownTmuxHint: async () => true,
        clearKnownTmuxHint: async () => { failedRefreshClears++; },
    });
    await assert.rejects(failedRefreshCoordinator.resume(
        fakeResumeRequest('hinted-refresh-direct-failed')), /direct refresh fallback failed/);
    assert.strictEqual(failedRefreshDirect.ensureResumeCalls, 1);
    assert.strictEqual(failedRefreshClears, 0);

    for (const category of ['not-found', 'permission-denied', 'timeout']) {
        const cachedProbeBoundary = createTmuxBackendHarness({
            listWindowsError: new tmuxClientModule.TmuxClientError('list-windows', category),
        });
        const cachedProbeDirect = createFakeRuntimeBackend('vscode');
        let cachedProbeClears = 0;
        const cachedProbeCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
            direct: cachedProbeDirect,
            tmux: new tmuxBackendModule.TmuxRuntimeBackend(cachedProbeBoundary.dependencies),
            getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
            chooseTmuxFallback: async context => {
                assert.strictEqual(context.knownHint, true);
                assert.ok(context.error instanceof runtimeTypesModule.TmuxRuntimeUnavailableError);
                return 'direct-anyway';
            },
            hasKnownTmuxHint: async () => true,
            clearKnownTmuxHint: async () => { cachedProbeClears++; },
        });
        assert.strictEqual((await cachedProbeCoordinator.resume(
            fakeResumeRequest(`cached-probe-${category}`))).status, 'started');
        assert.strictEqual(cachedProbeDirect.ensureResumeCalls, 1);
        assert.strictEqual(cachedProbeClears, 1);
        assert.strictEqual(cachedProbeBoundary.operations.filter(
            item => item.type === 'availability').length, 1);
        assert.strictEqual(cachedProbeBoundary.operations.filter(
            item => item.type === 'list-windows').length, 1);
        assert.strictEqual(cachedProbeBoundary.operations.some(item => item.type === 'lock'), false);
    }

    for (const refreshError of [
        new Error('plain discovery failure'),
        new tmuxClientModule.TmuxClientError('list-windows', 'invalid-output'),
    ]) {
        const failedReadBoundary = createTmuxBackendHarness({ listWindowsError: refreshError });
        const failedReadDirect = createFakeRuntimeBackend('vscode');
        let failedReadChoices = 0;
        const failedReadCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
            direct: failedReadDirect,
            tmux: new tmuxBackendModule.TmuxRuntimeBackend(failedReadBoundary.dependencies),
            getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
            chooseTmuxFallback: async () => { failedReadChoices++; return 'direct-anyway'; },
            hasKnownTmuxHint: async () => true,
            clearKnownTmuxHint: async () => { throw new Error('must not clear'); },
        });
        await assert.rejects(failedReadCoordinator.resume(
            fakeResumeRequest(`failed-read-${failedReadChoices}`)), error => error === refreshError);
        assert.strictEqual(failedReadChoices, 0);
        assert.strictEqual(failedReadDirect.ensureResumeCalls, 0);
    }

    const probeException = new Error('availability programmer failure');
    const probeExceptionBoundary = createTmuxBackendHarness({ availabilityError: probeException });
    const probeExceptionDirect = createFakeRuntimeBackend('vscode');
    let probeExceptionChoices = 0;
    let probeExceptionClears = 0;
    const probeExceptionCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: probeExceptionDirect,
        tmux: new tmuxBackendModule.TmuxRuntimeBackend(probeExceptionBoundary.dependencies),
        getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => { probeExceptionChoices++; return 'direct-anyway'; },
        hasKnownTmuxHint: async () => true,
        clearKnownTmuxHint: async () => { probeExceptionClears++; },
    });
    await assert.rejects(probeExceptionCoordinator.resume(
        fakeResumeRequest('probe-exception')), error => error === probeException);
    assert.strictEqual(probeExceptionChoices, 0);
    assert.strictEqual(probeExceptionDirect.ensureResumeCalls, 0);
    assert.strictEqual(probeExceptionClears, 0);
    assert.strictEqual(probeExceptionBoundary.operations.filter(
        item => item.type === 'availability').length, 1);
    assert.strictEqual(probeExceptionBoundary.operations.some(item => item.type === 'list-windows'), false);
    assert.strictEqual(probeExceptionBoundary.operations.some(item => item.type === 'lock'), false);
    assert.strictEqual(probeExceptionBoundary.operations.some(item => item.type === 'new-session'), false);

    for (const boundaryOptions of [
        { ambiguousCreateCount: 1 },
        { failConfigureWindowTimeoutCount: 1 },
    ]) {
        const timeoutBoundary = createTmuxBackendHarness(boundaryOptions);
        const timeoutDirect = createFakeRuntimeBackend('vscode');
        let timeoutChoices = 0;
        const timeoutCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
            direct: timeoutDirect,
            tmux: new tmuxBackendModule.TmuxRuntimeBackend(timeoutBoundary.dependencies),
            getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'session', tmuxPath: 'tmux' }),
            chooseTmuxFallback: async () => { timeoutChoices++; return 'direct'; },
        });
        await assert.rejects(timeoutCoordinator.resume(fakeResumeRequest(
            boundaryOptions.ambiguousCreateCount ? 'dispatch-timeout' : 'configure-timeout'
        )), /timeout/);
        assert.strictEqual(timeoutChoices, 0);
        assert.strictEqual(timeoutDirect.ensureResumeCalls, 0);
    }

    const lockBoundary = createTmuxBackendHarness();
    lockBoundary.dependencies.withCreationLock = async () => {
        throw new Error('creation lock timed out');
    };
    let lockChoices = 0;
    const lockDirect = createFakeRuntimeBackend('vscode');
    const lockCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: lockDirect,
        tmux: new tmuxBackendModule.TmuxRuntimeBackend(lockBoundary.dependencies),
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'session', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => { lockChoices++; return 'direct'; },
    });
    await assert.rejects(lockCoordinator.resume(fakeResumeRequest('lock-timeout')), /lock timed out/);
    assert.strictEqual(lockChoices, 0);
    assert.strictEqual(lockDirect.ensureResumeCalls, 0);

    for (const promoteRefreshError of [fakeUnavailableError(), new Error('plain promote refresh failure')]) {
        const promoteDirect = createFakeRuntimeBackend('vscode');
        promoteDirect.pending.push({
            ...fakeRuntime('vscode', undefined),
            identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'guarded-promote' },
            state: 'pending', createdAt: '2026-07-18T10:00:00.000Z', excludedSessionIds: [],
        });
        const promoteCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
            direct: promoteDirect,
            tmux: createFakeRuntimeBackend('tmux', { refreshError: promoteRefreshError }),
            getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
            chooseTmuxFallback: async () => 'cancel',
            hasLiveTmuxOwnership: async () => false,
        });
        await assert.rejects(
            promoteCoordinator.promotePending(
                promoteDirect.pending[0].identity, 'must-not-promote', 'Must not promote'
            ),
            error => error === promoteRefreshError
        );
        assert.deepStrictEqual(promoteDirect.promoted, [],
            'promotion must fail closed when either forced refresh outcome is not safe');
    }

    const fastDirect = createFakeRuntimeBackend('vscode');
    const fastTmux = createFakeRuntimeBackend('tmux');
    fastTmux.active.push(fakeRuntime('tmux', 'fast-focus'));
    const fastCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: fastDirect,
        tmux: fastTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    await fastCoordinator.focus(fakeResumeRequest('fast-focus').identity);
    assert.deepStrictEqual(fastDirect.refreshCalls, [],
        'healthy tmux focus must not refresh Direct Terminal discovery');
    assert.deepStrictEqual(fastTmux.refreshCalls, [],
        'healthy tmux focus must not refresh global tmux discovery');
    assert.strictEqual(fastTmux.focusCalls.length, 1);

    const changedTargetError = () => new runtimeTypesModule.AiSessionRuntimeTargetChangedError();
    const fastPathRetryDirect = createFakeRuntimeBackend('vscode');
    const fastPathRetryTmux = createFakeRuntimeBackend('tmux', { focusErrors: [changedTargetError()] });
    fastPathRetryTmux.active.push(fakeRuntime('tmux', 'retry-focus'));
    const fastPathRetryCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: fastPathRetryDirect,
        tmux: fastPathRetryTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    await fastPathRetryCoordinator.focus(fakeResumeRequest('retry-focus').identity);
    assert.deepStrictEqual(fastPathRetryDirect.refreshCalls, [true]);
    assert.deepStrictEqual(fastPathRetryTmux.refreshCalls, [true]);
    assert.strictEqual(fastPathRetryTmux.focusAttempts.length, 2,
        'one changed target must reconcile and retry exactly once');
    assert.strictEqual(fastPathRetryTmux.focusCalls.length, 1);

    const fastPathMissingDirect = createFakeRuntimeBackend('vscode');
    const fastPathMissingTmux = createFakeRuntimeBackend('tmux', {
        focusErrors: [changedTargetError()],
        onRefresh: fake => { fake.active = []; },
    });
    fastPathMissingTmux.active.push(fakeRuntime('tmux', 'missing-after-refresh'));
    const fastPathMissingCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: fastPathMissingDirect,
        tmux: fastPathMissingTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    await fastPathMissingCoordinator.focus(fakeResumeRequest('missing-after-refresh').identity);
    assert.strictEqual(fastPathMissingTmux.focusAttempts.length, 1,
        'a target removed by reconciliation must not be retried');
    assert.strictEqual(fastPathMissingTmux.focusCalls.length, 0);

    const fastPathDuplicateDirect = createFakeRuntimeBackend('vscode', {
        onRefresh: fake => { fake.active.push(fakeRuntime('vscode', 'duplicate-after-refresh')); },
    });
    const fastPathDuplicateTmux = createFakeRuntimeBackend('tmux', {
        focusErrors: [changedTargetError()],
    });
    fastPathDuplicateTmux.active.push(fakeRuntime('tmux', 'duplicate-after-refresh'));
    const fastPathDuplicateCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: fastPathDuplicateDirect,
        tmux: fastPathDuplicateTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    await fastPathDuplicateCoordinator.focus(fakeResumeRequest('duplicate-after-refresh').identity);
    assert.strictEqual(fastPathDuplicateTmux.focusAttempts.length, 1,
        'a cross-backend duplicate discovered during reconciliation must not be focused');
    assert.strictEqual(fastPathDuplicateTmux.focusCalls.length, 0);
    assert.strictEqual(fastPathDuplicateDirect.focusCalls.length, 0);

    const fastPathRepeatedDirect = createFakeRuntimeBackend('vscode');
    const fastPathRepeatedTmux = createFakeRuntimeBackend('tmux', {
        focusErrors: [changedTargetError(), changedTargetError()],
    });
    fastPathRepeatedTmux.active.push(fakeRuntime('tmux', 'repeated-change'));
    const fastPathRepeatedCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: fastPathRepeatedDirect,
        tmux: fastPathRepeatedTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    await fastPathRepeatedCoordinator.focus(fakeResumeRequest('repeated-change').identity);
    assert.strictEqual(fastPathRepeatedTmux.focusAttempts.length, 2,
        'a second target change must stop without an unbounded retry loop');
    assert.strictEqual(fastPathRepeatedTmux.focusCalls.length, 0);
    assert.deepStrictEqual(fastPathRepeatedTmux.refreshCalls, [true]);

    const operationalError = new Error('focus operation failed');
    const fastPathFailedDirect = createFakeRuntimeBackend('vscode');
    const fastPathFailedTmux = createFakeRuntimeBackend('tmux', { focusErrors: [operationalError] });
    fastPathFailedTmux.active.push(fakeRuntime('tmux', 'operational-failure'));
    const fastPathFailedCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: fastPathFailedDirect,
        tmux: fastPathFailedTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    await assert.rejects(fastPathFailedCoordinator.focus(fakeResumeRequest('operational-failure').identity),
        error => error === operationalError);
    assert.deepStrictEqual(fastPathFailedDirect.refreshCalls, []);
    assert.deepStrictEqual(fastPathFailedTmux.refreshCalls, [],
        'operational failures must not be mistaken for stale-target recovery');

    const routedDirect = createFakeRuntimeBackend('vscode');
    const routedTmux = createFakeRuntimeBackend('tmux');
    const routed = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: routedDirect,
        tmux: routedTmux,
        getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    routedDirect.active.push(fakeRuntime('vscode', 'direct-route'));
    routedTmux.active.push(fakeRuntime('tmux', 'tmux-route'));
    routedTmux.pending.push({
        ...fakeRuntime('tmux', undefined),
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'pending-route' },
        state: 'pending', createdAt: '2026-07-18T10:00:00.000Z', excludedSessionIds: [],
    });
    await routed.focus(fakeResumeRequest('tmux-route').identity);
    await routed.focus({ provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'pending-route' });
    await routed.detach(fakeResumeRequest('direct-route').identity);
    assert.strictEqual(routedTmux.focusCalls.length, 2);
    assert.strictEqual(routedDirect.detachCalls.length, 1);
    routedDirect.pending.push({
        ...fakeRuntime('vscode', undefined),
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'pending-conflict' },
        state: 'pending', createdAt: '2026-07-18T10:00:00.000Z', excludedSessionIds: [],
    });
    routedTmux.pending.push({
        ...fakeRuntime('tmux', undefined),
        identity: { provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'pending-conflict' },
        state: 'pending', createdAt: '2026-07-18T10:00:00.000Z', excludedSessionIds: [],
    });
    await routed.focus({ provider: 'codex', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work', pendingId: 'pending-conflict' });
    assert.strictEqual(routedDirect.focusCalls.length, 0);
    assert.strictEqual(routedTmux.focusCalls.length, 2);
    const promotedPending = await routed.promotePending(
        routedTmux.pending[0].identity, 'promoted-route', 'Readable Promoted Session'
    );
    assert.strictEqual(promotedPending[0].identity.sessionId, 'promoted-route');
    assert.deepStrictEqual(routedTmux.promoted, [{
        identity: routedTmux.pending[0].identity,
        sessionId: 'promoted-route',
        sessionName: 'Readable Promoted Session',
    }]);
    const conflictedPromotion = await routed.promotePending(
        routedTmux.pending[1].identity, 'never-promoted', 'Never promoted'
    );
    assert.strictEqual(conflictedPromotion.length, 2);
    assert.ok(conflictedPromotion.every(runtime => runtime.state === 'conflict'));
    assert.strictEqual(routedDirect.promoted.length, 0);

    const durableConflictDirect = createFakeRuntimeBackend('vscode');
    const durableConflictTmux = createFakeRuntimeBackend('tmux');
    const durableConflictPending = {
        ...fakeRuntime('vscode', undefined),
        identity: {
            provider: 'codex', workspaceScopeIdentity: 'durable-conflict',
            workspaceNavigationIdentity: 'nav-durable-conflict', workspaceRootHostPaths: ['/work'],
            cwd: '/work', pendingId: 'durable-conflict-pending',
        },
        state: 'pending', createdAt: '2026-07-18T10:00:00.000Z', excludedSessionIds: [],
    };
    durableConflictDirect.pending.push({
        ...durableConflictPending,
        promotionRecoveryDisplayName: 'Forged ordinary display',
        recoverySessionId: 'forged-ordinary-session',
    });
    durableConflictTmux.recoverablePending.push({
        ...durableConflictPending,
        backend: 'tmux',
        promotionRecoveryDisplayName: 'Durable conflict',
        recoverySessionId: 'durable-conflict-final',
        identity: { ...durableConflictPending.identity },
    });
    durableConflictTmux.getRecoverablePending = async () => ({
        ...durableConflictPending,
        backend: 'tmux',
        identity: { ...durableConflictPending.identity },
    });
    const durableConflictCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: durableConflictDirect,
        tmux: durableConflictTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'session', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    const durablePromotionCandidates = await durableConflictCoordinator.getPendingForPromotion();
    assert.strictEqual(durablePromotionCandidates.length, 2,
        'promotion enumeration must preserve cross-backend identity conflicts');
    const ordinaryPromotionCandidate = durablePromotionCandidates.find(candidate =>
        candidate.backend === 'vscode');
    assert.strictEqual(ordinaryPromotionCandidate.promotionRecoveryDisplayName, undefined);
    assert.strictEqual(ordinaryPromotionCandidate.recoverySessionId, undefined,
        'ordinary pending snapshots must not forge durable recovery inputs');
    await createPromotionController(durableConflictCoordinator).promote({
        scopeIdentity: durableConflictPending.identity.workspaceScopeIdentity,
        navigationIdentity: durableConflictPending.identity.workspaceNavigationIdentity,
    }, {
        codex: {
            available: true, scannedFiles: 1, parsedFiles: 1,
            sessions: [{
                id: 'durable-conflict-final', name: 'Durable conflict', cwd: '/work',
                updatedAt: '2026-07-18T10:00:01.000Z',
            }],
        },
    }, 'durable-conflict');
    assert.strictEqual(durableConflictDirect.promoted.length, 0);
    assert.strictEqual(durableConflictTmux.promoted.length, 0,
        'the product promotion entry point must not choose between backend conflicts');
    const durableConflictResult = await durableConflictCoordinator.promotePending(
        durableConflictPending.identity, 'durable-conflict-final', 'Durable conflict'
    );
    assert.strictEqual(durableConflictResult.length, 2);
    assert.ok(durableConflictResult.every(runtime => runtime.state === 'conflict'));
    assert.strictEqual(durableConflictDirect.promoted.length, 0);
    assert.strictEqual(durableConflictTmux.promoted.length, 0,
        'a durable tmux candidate must not bypass a projected Direct pending conflict');

    const invalidDurableCandidateTmux = createFakeRuntimeBackend('tmux');
    invalidDurableCandidateTmux.recoverablePending.push({
        ...durableConflictPending,
        backend: 'tmux',
        promotionRecoveryDisplayName: 'Durable recovery',
        recoverySessionId: 'bad recovery',
        identity: { ...durableConflictPending.identity },
    });
    const invalidDurableCandidateCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: createFakeRuntimeBackend('vscode'),
        tmux: invalidDurableCandidateTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'session', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    await assert.rejects(invalidDurableCandidateCoordinator.getPendingForPromotion(),
        /durable pending promotion snapshot is invalid/,
    'invalid durable snapshots must fail closed at the coordinator boundary');
    const mismatchedDurableCandidateTmux = createFakeRuntimeBackend('tmux');
    mismatchedDurableCandidateTmux.recoverablePending.push({
        ...durableConflictPending,
        backend: 'tmux',
        promotionRecoveryDisplayName: 'Durable recovery',
        recoverySessionId: 'durable-final-one',
        identity: { ...durableConflictPending.identity },
    }, {
        ...durableConflictPending,
        backend: 'tmux',
        promotionRecoveryDisplayName: 'Durable recovery',
        recoverySessionId: 'durable-final-two',
        identity: { ...durableConflictPending.identity },
    });
    const mismatchedDurableCandidateCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: createFakeRuntimeBackend('vscode'),
        tmux: mismatchedDurableCandidateTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'session', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    await assert.rejects(mismatchedDurableCandidateCoordinator.getPendingForPromotion(),
        /disagree within one backend/,
    'durable candidates with different frozen final IDs must fail closed');
    const closedTerminal = { name: 'closed' };
    routed.handleClosedTerminal(closedTerminal);
    assert.deepStrictEqual(routedDirect.closed, [closedTerminal]);
    assert.deepStrictEqual(routedTmux.closed, [closedTerminal]);

    const choiceDirect = createFakeRuntimeBackend('vscode');
    const choiceTmux = createFakeRuntimeBackend('tmux');
    const directHandle = { name: 'exact-direct-handle' };
    choiceDirect.active.push(fakeRuntime('vscode', 'choice', {
        terminal: directHandle,
        markerPath: '/tmp/direct-choice.done',
        runStartedAtMs: 41,
    }));
    choiceTmux.active.push(fakeRuntime('tmux', 'choice', {
        markerPath: '/tmp/tmux-choice.done',
        runStartedAtMs: 42,
        attached: false,
        tmux: { layout: 'project', sessionName: 'managed-choice', windowName: 'choice-window' },
    }));
    const choiceCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: choiceDirect,
        tmux: choiceTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    const choices = choiceCoordinator.getActiveCandidates('codex', 'choice', 'pk');
    assert.strictEqual(choices.length, 2);
    assert.ok(choices.every(runtime => runtime.state === 'conflict'));
    assert.strictEqual(await choiceCoordinator.focusSelected(choices[0]), true);
    assert.strictEqual(choiceDirect.focusCalls.length, 1,
        'an exact Direct conflict choice must focus its selected terminal handle');
    assert.strictEqual(choiceTmux.focusCalls.length, 0);
    assert.strictEqual(await choiceCoordinator.focusSelected(choices[1]), true);
    assert.strictEqual(choiceTmux.focusCalls.length, 1,
        'an exact tmux conflict choice must focus its selected locator');

    const staleChoice = choiceCoordinator.getActiveCandidates('codex', 'choice', 'pk')[0];
    choiceDirect.refresh = async force => {
        choiceDirect.refreshCalls.push(force);
        choiceDirect.active[0] = {
            ...choiceDirect.active[0],
            terminal: { name: 'replacement-direct-handle' },
        };
    };
    assert.strictEqual(await choiceCoordinator.focusSelected(staleChoice), false,
        'a stale Direct handle must not be focused after forced refresh');
    assert.strictEqual(choiceDirect.focusCalls.length, 1);

    const collisionOnlyDirect = createFakeRuntimeBackend('vscode');
    const collisionOnlyTmux = createFakeRuntimeBackend('tmux');
    const collisionDiagnostic = fakeRuntime('tmux', 'collision-only', {
        state: 'conflict', attached: false,
        tmux: { layout: 'project', sessionName: 'unverified-session', windowName: 'unmanaged-window' },
    });
    collisionOnlyTmux.conflicts.push(collisionDiagnostic);
    const collisionOnlyCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: collisionOnlyDirect,
        tmux: collisionOnlyTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    assert.deepStrictEqual(
        collisionOnlyCoordinator.getActiveCandidates('codex', 'collision-only', 'pk'), [],
        'metadata/name collision diagnostics must not become chooser candidates'
    );
    assert.deepStrictEqual(
        collisionOnlyCoordinator.getUnverifiedConflicts('codex', 'collision-only', 'pk'),
        [collisionDiagnostic]
    );
    assert.strictEqual(await collisionOnlyCoordinator.focusSelected(collisionDiagnostic), false,
        'a forged collision diagnostic must fail exact verified-active revalidation');
    assert.strictEqual(collisionOnlyTmux.focusCalls.length, 0,
        'collision selection must never select or attach an unmanaged tmux target');

    const verifiedWithCollisionDirect = createFakeRuntimeBackend('vscode');
    const verifiedWithCollisionTmux = createFakeRuntimeBackend('tmux');
    const verifiedHandle = { name: 'verified-direct' };
    verifiedWithCollisionDirect.active.push(fakeRuntime('vscode', 'verified-with-collision', {
        terminal: verifiedHandle,
    }));
    verifiedWithCollisionTmux.conflicts.push(fakeRuntime('tmux', 'verified-with-collision', {
        state: 'conflict', attached: false,
        tmux: { layout: 'project', sessionName: 'collision-name', windowName: 'unmanaged-window' },
    }));
    const verifiedWithCollisionCoordinator = new coordinatorModule.AiSessionRuntimeCoordinator({
        direct: verifiedWithCollisionDirect,
        tmux: verifiedWithCollisionTmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
    });
    const verifiedChoices = verifiedWithCollisionCoordinator.getActiveCandidates(
        'codex', 'verified-with-collision', 'pk'
    );
    assert.strictEqual(verifiedChoices.length, 1,
        'a collision diagnostic must not hide a separately verified active runtime');
    assert.strictEqual(verifiedChoices[0].backend, 'vscode');
    assert.strictEqual(await verifiedWithCollisionCoordinator.focusSelected(verifiedChoices[0]), true);
    assert.strictEqual(verifiedWithCollisionDirect.focusCalls.length, 1);
    assert.strictEqual(verifiedWithCollisionTmux.focusCalls.length, 0);
}

async function runRuntimeControllerChecks() {
    const project = {
        id: 'project', name: 'Project', path: '/work',
        codexSessions: [{ id: 'direct-session' }, { id: 'tmux-session' }],
        kimiSessions: [], claudeSessions: [],
    };
    const otherProject = {
        id: 'other-project', name: 'Other Project', path: '/other',
        codexSessions: [{ id: 'direct-session' }, { id: 'tmux-session' }, { id: 'legacy-session' }],
        kimiSessions: [], claudeSessions: [],
    };
    const directTerminalHandle = { name: 'direct-terminal-handle' };
    const direct = {
        identity: { provider: 'codex', sessionId: 'direct-session', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work' },
        backend: 'vscode', state: 'active', markerPath: '/tmp/direct.done',
        runStartedAtMs: 1, attached: true, terminal: directTerminalHandle,
    };
    const tmux = {
        identity: { provider: 'codex', sessionId: 'tmux-session', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work' },
        backend: 'tmux', state: 'active', markerPath: '/tmp/tmux.done',
        runStartedAtMs: 2, attached: false,
        tmux: { layout: 'project', sessionName: 'project-steward-p-a', windowName: 'ai-codex-a' },
    };
    const otherScope = {
        identity: { provider: 'codex', sessionId: 'legacy-session', workspaceScopeIdentity: 'other-scope', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work' },
        backend: 'vscode', state: 'active', markerPath: '/tmp/legacy.done',
        runStartedAtMs: 3, attached: true, terminal: { name: 'legacy-terminal-handle' },
    };
    const runtimes = [direct, tmux, otherScope];
    const coordinator = {
        focused: [], detached: [],
        getById(provider, sessionId) {
            return runtimes.find(runtime => runtime.identity.provider === provider
                && runtime.identity.sessionId === sessionId) || null;
        },
        getPending: () => [],
        focus: async identity => coordinator.focused.push({ ...identity }),
        detach: async identity => coordinator.detached.push({ ...identity }),
    };
    const confirmations = [];
    const controller = new TerminalCommandController({
        isProviderId: value => value === 'codex' || value === 'kimi' || value === 'claude',
        getWorkspaceTarget: cardId => cardId === project.id
            ? createWorkspaceActionTarget(project, 'pk')
            : cardId === otherProject.id ? createWorkspaceActionTarget(otherProject, 'other-pk') : null,
        runtimeCoordinator: coordinator,
        confirmRuntimeClose: async (message, action) => {
            confirmations.push([message, action]);
            return action;
        },
        announceStatus: async () => undefined,
        showErrorMessage: async () => undefined,
        getProviderLabel: provider => provider.toUpperCase(),
        refresh: () => undefined,
    });

    await controller.focusActive('project', 'codex', 'direct-session');
    assert.deepStrictEqual(coordinator.focused, [{
        provider: 'codex', sessionId: 'direct-session', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work',
    }]);
    await controller.focusActive('other-project', 'codex', 'direct-session');
    assert.strictEqual(coordinator.focused.length, 1,
        'duplicate history must not override an authoritative runtime project identity');
    await controller.focusActive('other-project', 'codex', 'legacy-session');
    assert.strictEqual(coordinator.focused.length, 1,
        'runtime lookup must not cross workspaceScopeIdentity even when cwd and history match');
    await controller.closeTerminal({
        projectId: 'other-project', providerId: 'codex', sessionId: 'direct-session',
    });
    assert.strictEqual(coordinator.detached.length, 0,
        'duplicate history must not authorize detach from the wrong project');
    const directRequest = Object.freeze({
        projectId: 'project', providerId: 'codex', sessionId: 'direct-session',
    });
    await controller.closeTerminal(directRequest);
    assert.deepStrictEqual(directRequest, {
        projectId: 'project', providerId: 'codex', sessionId: 'direct-session',
    });
    assert.deepStrictEqual(confirmations[0], [
        'Closing this CODEX terminal may interrupt a running AI task.', 'Close Terminal',
    ]);
    assert.strictEqual(coordinator.detached.length, 1);

    await controller.closeTerminal({
        projectId: 'project', providerId: 'codex', sessionId: 'tmux-session',
    });
    assert.deepStrictEqual(confirmations[1], [
        'Detaching this CODEX terminal will leave the AI task running in tmux.', 'Detach Terminal',
    ]);
    assert.strictEqual(coordinator.detached.length, 2);
    await controller.closeTerminal({
        projectId: 'project', providerId: 'codex', sessionId: 'direct-session',
        expectedBackend: 'tmux',
    });
    await controller.closeTerminal({
        projectId: 'project', providerId: 'codex', sessionId: 'tmux-session',
        expectedBackend: 'vscode',
    });
    assert.strictEqual(confirmations.length, 2,
        'a forged backend-specific route must be rejected before confirmation');
    assert.strictEqual(coordinator.detached.length, 2,
        'a forged backend-specific route must not detach the resolved runtime');
    assert.deepStrictEqual(runtimes, [direct, tmux, otherScope], 'controller calls must not mutate runtime snapshots');

    const conflictDirect = {
        ...direct,
        identity: { ...direct.identity, sessionId: 'conflict-session' },
        state: 'conflict',
    };
    const conflictTmux = {
        ...tmux,
        identity: { ...tmux.identity, sessionId: 'conflict-session' },
        state: 'conflict',
    };
    project.codexSessions.push({ id: 'conflict-session' });
    const conflictCandidates = [conflictDirect, conflictTmux];
    const selectedConflicts = [];
    const chooserSelections = [conflictDirect, conflictTmux, undefined, conflictDirect];
    let selectedFocusResult = true;
    let chooserThrows = false;
    const conflictCoordinator = {
        getById: () => null,
        getActiveCandidates: () => conflictCandidates.map(runtime => ({
            ...runtime,
            identity: { ...runtime.identity },
            ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
        })),
        getPending: () => [],
        focus: async () => { throw new Error('ambiguous identity focus must not be used'); },
        focusSelected: async runtime => {
            selectedConflicts.push(runtime);
            return selectedFocusResult;
        },
        detach: async () => undefined,
    };
    const conflictAnnouncements = [];
    const conflictErrors = [];
    const conflictController = new TerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: cardId => cardId === project.id
            ? createWorkspaceActionTarget(project, 'pk') : null,
        runtimeCoordinator: conflictCoordinator,
        chooseRuntimeConflict: async candidates => {
            assert.strictEqual(candidates.length, 2);
            if (chooserThrows) throw new Error('raw quick pick failure');
            return chooserSelections.shift();
        },
        confirmRuntimeClose: async () => undefined,
        announceStatus: async (projectId, message) => conflictAnnouncements.push([projectId, message]),
        showErrorMessage: async message => conflictErrors.push(message),
        getProviderLabel: () => 'CODEX',
        refresh: () => undefined,
    });
    await conflictController.focusActive('project', 'codex', 'conflict-session');
    await conflictController.focusActive('project', 'codex', 'conflict-session');
    await conflictController.focusActive('project', 'codex', 'conflict-session');
    assert.deepStrictEqual(selectedConflicts.map(runtime => runtime.backend), ['vscode', 'tmux'],
        'the chooser must route exact Direct and tmux conflict selections');
    selectedFocusResult = false;
    await conflictController.focusActive('project', 'codex', 'conflict-session');
    assert.strictEqual(selectedConflicts.length, 3,
        'cancel must perform zero selected-runtime focus actions');
    assert.deepStrictEqual(conflictAnnouncements, [[
        'project', 'The selected AI session runtime changed before it could be focused.',
    ]], 'a stale selection must announce the safe no-action result');
    chooserThrows = true;
    await conflictController.focusActive('project', 'codex', 'conflict-session');
    assert.deepStrictEqual(conflictErrors, ['Could not choose an AI session runtime.']);
    assert.strictEqual(selectedConflicts.length, 3,
        'a rejected QuickPick boundary must perform zero focus actions');

    project.codexSessions.push({ id: 'collision-only' });
    const controllerCollisionDiagnostic = {
        ...conflictTmux,
        identity: { ...conflictTmux.identity, sessionId: 'collision-only' },
        state: 'conflict',
    };
    let collisionChooserCalls = 0;
    let collisionFocusCalls = 0;
    const collisionOnlyAnnouncements = [];
    const collisionOnlyController = new TerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: cardId => cardId === project.id
            ? createWorkspaceActionTarget(project, 'pk') : null,
        runtimeCoordinator: {
            getById: () => null,
            getActiveCandidates: () => [],
            getUnverifiedConflicts: () => [controllerCollisionDiagnostic],
            getPending: () => [],
            focus: async () => { collisionFocusCalls++; },
            focusSelected: async () => { collisionFocusCalls++; return true; },
            detach: async () => undefined,
        },
        chooseRuntimeConflict: async () => { collisionChooserCalls++; return controllerCollisionDiagnostic; },
        confirmRuntimeClose: async () => undefined,
        announceStatus: async (projectId, message) => collisionOnlyAnnouncements.push([projectId, message]),
        showErrorMessage: async () => undefined,
        getProviderLabel: () => 'CODEX',
        refresh: () => undefined,
    });
    await collisionOnlyController.focusActive('project', 'codex', 'collision-only');
    assert.strictEqual(collisionChooserCalls, 0,
        'a lone unverified collision must not open the runtime chooser');
    assert.strictEqual(collisionFocusCalls, 0);
    assert.deepStrictEqual(collisionOnlyAnnouncements, [[
        'project',
        'The conflicting AI session target could not be verified as a managed runtime and was not focused.',
    ]]);

    const otherProjectCollision = {
        ...controllerCollisionDiagnostic,
        identity: {
            ...controllerCollisionDiagnostic.identity,
            workspaceScopeIdentity: 'other-pk',
            cwd: '/other',
        },
    };
    let crossProjectFocusCalls = 0;
    const crossProjectAnnouncements = [];
    const crossProjectCollisionController = new TerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: cardId => cardId === project.id
            ? createWorkspaceActionTarget(project, 'pk')
            : cardId === otherProject.id ? createWorkspaceActionTarget(otherProject, 'other-pk') : null,
        runtimeCoordinator: {
            getById: () => direct,
            getActiveCandidates: () => [direct],
            getUnverifiedConflicts: () => [otherProjectCollision],
            getPending: () => [],
            focus: async () => { crossProjectFocusCalls++; },
            focusSelected: async () => { throw new Error('cross-project collision must not change routing'); },
            detach: async () => undefined,
        },
        chooseRuntimeConflict: async () => { throw new Error('cross-project collision must not open chooser'); },
        confirmRuntimeClose: async () => undefined,
        announceStatus: async (projectId, message) => crossProjectAnnouncements.push([projectId, message]),
        showErrorMessage: async () => undefined,
        getProviderLabel: () => 'CODEX',
        refresh: () => undefined,
    });
    await crossProjectCollisionController.focusActive('project', 'codex', 'direct-session');
    assert.strictEqual(crossProjectFocusCalls, 1,
        'a collision owned by another project must not alter the current project focus route');
    assert.deepStrictEqual(crossProjectAnnouncements, []);

    project.codexSessions.push({ id: 'verified-with-collision' });
    const verifiedControllerRuntime = {
        ...conflictDirect,
        identity: { ...conflictDirect.identity, sessionId: 'verified-with-collision' },
        state: 'active',
    };
    let verifiedCollisionChooserCalls = 0;
    const verifiedCollisionFocuses = [];
    const verifiedCollisionController = new TerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: cardId => cardId === project.id
            ? createWorkspaceActionTarget(project, 'pk') : null,
        runtimeCoordinator: {
            getById: () => null,
            getActiveCandidates: () => [verifiedControllerRuntime],
            getUnverifiedConflicts: () => [controllerCollisionDiagnostic],
            getPending: () => [],
            focus: async () => { throw new Error('identity focus must remain ambiguity-safe'); },
            focusSelected: async runtime => { verifiedCollisionFocuses.push(runtime); return true; },
            detach: async () => undefined,
        },
        chooseRuntimeConflict: async () => { verifiedCollisionChooserCalls++; return undefined; },
        confirmRuntimeClose: async () => undefined,
        announceStatus: async () => undefined,
        showErrorMessage: async () => undefined,
        getProviderLabel: () => 'CODEX',
        refresh: () => undefined,
    });
    await verifiedCollisionController.focusActive('project', 'codex', 'verified-with-collision');
    assert.strictEqual(verifiedCollisionChooserCalls, 0);
    assert.strictEqual(verifiedCollisionFocuses.length, 1,
        'one verified runtime must remain focusable despite a separate unverified collision');

    const normalizeCanonicalPath = value => value
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
    const requestedFallbackProject = {
        id: 'repo-project', name: 'Repo Project', path: '/REPO/',
        codexSessions: [
            { id: 'legacy-inferred-session' },
            { id: 'key-owned-by-other-session' },
            { id: 'cwd-owned-by-other-session' },
        ],
        kimiSessions: [], claudeSessions: [],
    };
    const explicitOtherProject = {
        id: 'other-repo-project', name: 'Other Repo Project', path: '/OTHER-REPO/',
        codexSessions: [], kimiSessions: [], claudeSessions: [],
    };
    const inferredRuntime = {
        identity: {
            provider: 'codex', sessionId: 'legacy-inferred-session',
            workspaceScopeIdentity: 'scope-current', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/repo/subdir'], cwd: '/repo/subdir',
        },
        backend: 'vscode', state: 'active', markerPath: '/tmp/legacy-inferred.done',
        runStartedAtMs: 4, attached: true, terminal: { name: 'legacy-inferred-terminal' },
    };
    const keyOwnedByOtherRuntime = {
        identity: {
            provider: 'codex', sessionId: 'key-owned-by-other-session',
            workspaceScopeIdentity: 'scope-other', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/repo/subdir'], cwd: '/repo/subdir',
        },
        backend: 'vscode', state: 'active', markerPath: '/tmp/key-owned-other.done',
        runStartedAtMs: 5, attached: true, terminal: { name: 'key-owned-other-terminal' },
    };
    const cwdOwnedByOtherRuntime = {
        identity: {
            provider: 'codex', sessionId: 'cwd-owned-by-other-session',
            workspaceScopeIdentity: 'scope-current', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/other-repo'], cwd: '/other-repo',
        },
        backend: 'vscode', state: 'active', markerPath: '/tmp/cwd-owned-other.done',
        runStartedAtMs: 6, attached: true, terminal: { name: 'cwd-owned-other-terminal' },
    };
    const fallbackRuntimes = [inferredRuntime, keyOwnedByOtherRuntime, cwdOwnedByOtherRuntime];
    const fallbackFocused = [];
    const fallbackDetached = [];
    const fallbackConfirmations = [];
    const fallbackCoordinator = {
        getById: (provider, sessionId) => fallbackRuntimes.find(runtime => {
            return runtime.identity.provider === provider && runtime.identity.sessionId === sessionId;
        }) || null,
        getPending: () => [],
        focus: async identity => fallbackFocused.push({ ...identity }),
        detach: async identity => fallbackDetached.push({ ...identity }),
    };
    const fallbackController = new TerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: cardId => cardId === requestedFallbackProject.id
            ? createWorkspaceActionTarget(requestedFallbackProject, 'scope-current')
            : cardId === explicitOtherProject.id
                ? createWorkspaceActionTarget(explicitOtherProject, 'scope-other')
                : null,
        runtimeCoordinator: fallbackCoordinator,
        confirmRuntimeClose: async (_message, action) => {
            fallbackConfirmations.push(action);
            return action;
        },
        announceStatus: async () => undefined,
        showErrorMessage: async () => undefined,
        getProviderLabel: provider => provider.toUpperCase(),
        refresh: () => undefined,
    });

    await fallbackController.focusActive('repo-project', 'codex', 'legacy-inferred-session');
    assert.deepStrictEqual(fallbackFocused, [{ ...inferredRuntime.identity }],
        'v2 runtime lookup accepts an exact workspace scope and session assignment');
    await fallbackController.closeTerminal({
        projectId: 'repo-project', providerId: 'codex', sessionId: 'legacy-inferred-session',
    });
    assert.deepStrictEqual(fallbackDetached, [{ ...inferredRuntime.identity }],
        'v2 runtime detach accepts an exact workspace scope and session assignment');
    assert.deepStrictEqual(fallbackConfirmations, ['Close Terminal']);

    await fallbackController.focusActive('repo-project', 'codex', 'key-owned-by-other-session');
    await fallbackController.closeTerminal({
        projectId: 'repo-project', providerId: 'codex', sessionId: 'key-owned-by-other-session',
    });
    assert.strictEqual(fallbackFocused.length, 1,
        'history must not override a workspaceScopeIdentity owned by another workspace');
    assert.strictEqual(fallbackDetached.length, 1,
        'detach must reject a workspaceScopeIdentity owned by another workspace');
    assert.strictEqual(fallbackConfirmations.length, 1,
        'wrong-project runtime must be rejected before confirmation');

    await fallbackController.focusActive('repo-project', 'codex', 'cwd-owned-by-other-session');
    assert.strictEqual(fallbackFocused.length, 2,
        'immutable workspace scope ownership must not be reclassified from the current cwd');
    await fallbackController.focusActive('other-repo-project', 'codex', 'key-owned-by-other-session');
    await fallbackController.focusActive('other-repo-project', 'codex', 'cwd-owned-by-other-session');
    assert.deepStrictEqual(fallbackFocused.slice(2), [],
        'runtime ownership must never fall back to cwd or another workspace history');

    const directRaceRuntime = terminal => ({
        identity: { provider: 'codex', sessionId: 'race-session', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work' },
        backend: 'vscode', state: 'active', markerPath: '/tmp/race.done',
        runStartedAtMs: 1, attached: true, terminal,
    });
    const tmuxRaceRuntime = (sessionName = 'managed-a', windowName = 'window-a') => ({
        identity: { provider: 'codex', sessionId: 'race-session', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work' },
        backend: 'tmux', state: 'active', markerPath: '/tmp/race.done',
        runStartedAtMs: 1, attached: false,
        tmux: { layout: 'project', sessionName, windowName },
    });
    async function runDetachRaceCase(initialRuntime, mutateDuringConfirm, options = {}) {
        const state = {
            active: initialRuntime.identity.sessionId ? initialRuntime : null,
            pending: initialRuntime.identity.pendingId ? [initialRuntime] : [],
            conflict: false,
        };
        const detached = [];
        const detachObservedRuntimes = [];
        const announced = [];
        const refreshed = [];
        const errors = [];
        let activeLookups = 0;
        const raceCoordinator = {
            getById: (provider, sessionId) => {
                activeLookups++;
                const selected = !state.conflict && state.active
                    && state.active.identity.provider === provider
                    && state.active.identity.sessionId === sessionId ? state.active : null;
                if (selected && options.mutateAfterResolve && activeLookups === 2) {
                    Promise.resolve().then(() => { state.active = options.mutateAfterResolve; });
                }
                return selected;
            },
            getPending: () => state.pending.slice(),
            focus: async () => undefined,
            detach: async identity => {
                detachObservedRuntimes.push(state.active || state.pending[0] || null);
                detached.push({ ...identity });
            },
        };
        const raceController = new TerminalCommandController({
            isProviderId: value => value === 'codex',
            getWorkspaceTarget: cardId => cardId === project.id
                ? createWorkspaceActionTarget({
                    ...project, codexSessions: [{ id: 'race-session' }],
                }, 'pk') : null,
            runtimeCoordinator: raceCoordinator,
            confirmRuntimeClose: async (_message, action) => {
                if (options.confirmError) {
                    throw new Error('confirm failed');
                }
                if (mutateDuringConfirm) {
                    mutateDuringConfirm(state);
                }
                return options.cancel ? undefined : action;
            },
            announceStatus: async (projectId, message) => announced.push([projectId, message]),
            showErrorMessage: async message => errors.push(message),
            getProviderLabel: () => 'CODEX',
            refresh: () => refreshed.push('refresh'),
        });
        const request = initialRuntime.identity.pendingId
            ? { projectId: 'project', providerId: 'codex', pendingCreatedAt: initialRuntime.createdAt }
            : { projectId: 'project', providerId: 'codex', sessionId: initialRuntime.identity.sessionId };
        await raceController.closeTerminal(request);
        return { detached, detachObservedRuntimes, announced, refreshed, errors };
    }

    const staleRaceCases = [
        ['disappeared', tmuxRaceRuntime(), state => { state.active = null; }],
        ['conflict', tmuxRaceRuntime(), state => { state.conflict = true; }],
        ['tmux-to-direct', tmuxRaceRuntime(), state => {
            state.active = directRaceRuntime({ handle: 'replacement-direct' });
        }],
        ['direct-to-tmux', directRaceRuntime({ handle: 'source-direct' }), state => {
            state.active = tmuxRaceRuntime();
        }],
        ['direct-handle', directRaceRuntime({ handle: 'source-direct' }), state => {
            state.active = directRaceRuntime({ handle: 'replacement-direct' });
        }],
        ['tmux-locator', tmuxRaceRuntime(), state => {
            state.active = tmuxRaceRuntime('managed-b', 'window-b');
        }],
    ];
    for (const [label, initialRuntime, mutate] of staleRaceCases) {
        const outcome = await runDetachRaceCase(initialRuntime, mutate);
        assert.strictEqual(outcome.detached.length, 0, `${label} confirmation race must not detach`);
        assert.strictEqual(outcome.refreshed.length, 1, `${label} confirmation race must refresh`);
        assert.deepStrictEqual(outcome.announced, [[
            'project', 'The AI session runtime changed before terminal confirmation.',
        ]], `${label} confirmation race must announce the safe state`);
    }
    const stableRace = await runDetachRaceCase(tmuxRaceRuntime(), null);
    assert.strictEqual(stableRace.detached.length, 1, 'an unchanged tmux selection detaches exactly once');
    const noAwaitSource = directRaceRuntime({ handle: 'no-await-source' });
    const noAwaitRace = await runDetachRaceCase(noAwaitSource, null, {
        mutateAfterResolve: directRaceRuntime({ handle: 'no-await-replacement' }),
    });
    assert.strictEqual(noAwaitRace.detachObservedRuntimes[0], noAwaitSource,
        'the coordinator detach call must happen synchronously after the confirmed runtime is resolved');
    const cancelledRace = await runDetachRaceCase(tmuxRaceRuntime(), null, { cancel: true });
    assert.strictEqual(cancelledRace.detached.length, 0);
    assert.strictEqual(cancelledRace.refreshed.length, 0);
    const confirmErrorRace = await runDetachRaceCase(tmuxRaceRuntime(), null, { confirmError: true });
    assert.strictEqual(confirmErrorRace.detached.length, 0);
    assert.deepStrictEqual(confirmErrorRace.errors, ['Could not confirm the AI session terminal action.']);
    const pendingRaceRuntime = {
        identity: { provider: 'codex', pendingId: 'race-pending', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work' },
        backend: 'tmux', state: 'pending', markerPath: '/tmp/pending.done',
        runStartedAtMs: 1, attached: false, createdAt: '2026-07-19T05:00:00.000Z',
        excludedSessionIds: [], tmux: { layout: 'session', sessionName: 'pending-managed-a' },
    };
    const pendingRace = await runDetachRaceCase(pendingRaceRuntime, null);
    assert.strictEqual(pendingRace.detached.length, 1, 'an unchanged pending selection detaches exactly once');

    const createRequests = [];
    const createdAt = '2026-07-19T04:00:00.000Z';
    const creation = new CreationController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: cardId => cardId === project.id
            ? createWorkspaceActionTarget(project, 'pk') : null,
        pickWorkspaceRoot: async () => undefined,
        pickProvider: async () => 'codex',
        getProviderLabel: () => 'Codex',
        getProvider: () => ({
            label: 'Codex', terminalNamePrefix: 'Codex',
            buildNewSessionLaunchSpec: (scope, title, markerPath) => ({
                executable: 'codex', args: ['new', title], cwd: scope.primaryCwd, markerPath,
            }),
        }),
        createPendingId: () => 'pending-controller',
        resolveWorkspaceDirectoryScope: () => createDirectoryScope('/work'),
        getUsableTerminalCwd: cwd => cwd,
        showInputBox: async () => 'Title',
        showActiveTab: async () => undefined,
        announceStatus: async () => undefined,
        showWarningMessage: async () => undefined,
        refresh: () => undefined,
        getExistingSessionIdsForCwd: () => ['old'],
        getPendingMarkerPath: () => '/tmp/pending.done',
        scheduleNewSessionRefresh: () => undefined,
        normalizeProjectPath: value => value,
        setTimeout: () => ({}),
        clearTimeout: () => undefined,
        bindingTimeoutMs: 15_000,
        nowMs: () => Date.parse(createdAt),
        runtimeCoordinator: {
            create: async request => {
                createRequests.push(request);
                return {
                    status: 'started',
                    runtime: {
                        identity: { ...request.identity }, backend: 'tmux', state: 'pending',
                        markerPath: request.launch.markerPath, runStartedAtMs: Date.parse(request.createdAt),
                        attached: false, createdAt: request.createdAt,
                        excludedSessionIds: [...request.excludedSessionIds], title: request.title,
                    },
                };
            },
            getActive: () => [],
            getPending: () => [],
            focus: async () => undefined,
        },
    });
    await creation.createSession('project');
    assert.strictEqual(createRequests.length, 1);
    assert.strictEqual(createRequests[0].identity.pendingId, 'pending-controller');
    assert.strictEqual(createRequests[0].createdAt, createdAt);

    const resumeRequests = [];
    const resume = new ResumeController({
        getWorkspaceTarget: cardId => cardId === project.id
            ? createWorkspaceActionTarget(project, 'pk') : null,
        getProvider: () => ({
            label: 'Codex', terminalEnvKey: 'CODEX_SESSION_ID',
            buildResumeLaunchSpec: (sessionId, scope, markerPath) => ({
                executable: 'codex', args: ['resume', sessionId], cwd: scope.primaryCwd, markerPath,
            }),
        }),
        resolveWorkspaceDirectoryScope: () => createDirectoryScope('/work'),
        getTerminalName: () => 'Codex: Tmux session',
        getComparableCwd: () => '/work',
        getUsableTerminalCwd: cwd => cwd,
        normalizeProjectPath: value => value,
        getMarkerPath: () => '/tmp/resume.done',
        showWarningMessage: () => undefined,
        announceStatus: async () => undefined,
        refresh: () => undefined,
        showActiveTab: () => undefined,
        runtimeCoordinator: {
            resume: async request => {
                resumeRequests.push(request);
                return { status: 'focused', runtime: tmux };
            },
        },
    });
    await resume.resumeProjectSession('project', 'codex', 'tmux-session');
    assert.deepStrictEqual(resumeRequests[0].identity, {
        provider: 'codex', sessionId: 'tmux-session', workspaceScopeIdentity: 'scope:/work', workspaceNavigationIdentity: 'navigation:/work', workspaceRootHostPaths: ['/work'], cwd: '/work',
    });

    let collisionResumeCalls = 0;
    const collisionLookups = [];
    const collisionAnnouncements = [];
    const collisionRefreshes = [];
    const controllerCollisionSnapshot = {
        identity: { provider: 'codex', sessionId: 'tmux-session', workspaceScopeIdentity: 'pk', workspaceNavigationIdentity: 'nav-1', workspaceRootHostPaths: ['/work'], cwd: '/work' },
        backend: 'tmux', state: 'conflict', markerPath: '', runStartedAtMs: 0,
        attached: false, tmux: { layout: 'session', sessionName: 'collision' },
    };
    const collisionResume = new ResumeController({
        getWorkspaceTarget: cardId => cardId === project.id
            ? createWorkspaceActionTarget(project, 'pk') : null,
        getProvider: () => ({
            label: 'Codex', terminalEnvKey: 'CODEX_SESSION_ID',
            buildResumeLaunchSpec: (sessionId, scope, markerPath) => ({
                executable: 'codex', args: ['resume', sessionId], cwd: scope.primaryCwd, markerPath,
            }),
        }),
        resolveWorkspaceDirectoryScope: () => createDirectoryScope('/work'),
        getTerminalName: () => 'Codex: Collision',
        getMarkerPath: () => '/tmp/collision.done',
        showWarningMessage: () => undefined,
        announceStatus: async (_projectId, message) => { collisionAnnouncements.push(message); },
        refresh: () => { collisionRefreshes.push('refresh'); },
        showActiveTab: () => undefined,
        getRuntimeConflict: (...identity) => {
            collisionLookups.push(identity);
            return controllerCollisionSnapshot;
        },
        runtimeCoordinator: {
            resume: async () => { collisionResumeCalls++; return { status: 'started' }; },
        },
    });
    await collisionResume.resumeProjectSession('project', 'codex', 'tmux-session');
    assert.strictEqual(collisionResumeCalls, 0,
        'a discovery locator collision must block resume dispatch');
    assert.deepStrictEqual(collisionLookups, [[
        'codex', 'tmux-session', 'scope:/work',
    ]], 'resume collision lookup must use the resolved workspaceScopeIdentity');
    assert.deepStrictEqual(collisionRefreshes, ['refresh']);
    assert.deepStrictEqual(collisionAnnouncements, [
        'Multiple live runtimes match this AI session.',
    ]);

    const actionErrors = [];
    const actionRefreshes = [];
    const actionFailures = [];
    const failingActionController = new TerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: cardId => cardId === project.id
            ? createWorkspaceActionTarget(project, 'pk') : null,
        runtimeCoordinator: {
            getById: () => tmux,
            getPending: () => [],
            focus: async () => { throw new Error('raw focus timeout'); },
            detach: async () => { throw new Error('raw detach timeout'); },
        },
        confirmRuntimeClose: async (_message, action) => action,
        announceStatus: async () => undefined,
        showErrorMessage: async message => { actionErrors.push(message); },
        logRuntimeFailure: (operation, error, backend) => {
            actionFailures.push([operation, error.message, backend]);
        },
        getProviderLabel: () => 'Codex',
        refresh: () => { actionRefreshes.push('refresh'); },
    });
    await failingActionController.focusActive('project', 'codex', 'tmux-session');
    await failingActionController.closeTerminal({
        projectId: 'project', providerId: 'codex', sessionId: 'tmux-session',
    });
    assert.deepStrictEqual(actionErrors, [
        'Could not focus the AI session terminal.',
        'Could not detach the AI session terminal.',
    ]);
    assert.deepStrictEqual(actionRefreshes, ['refresh', 'refresh']);
    assert.deepStrictEqual(actionFailures, [
        ['focus-runtime', 'raw focus timeout', 'tmux'],
        ['detach-runtime', 'raw detach timeout', 'tmux'],
    ]);

    const createErrors = [];
    const createFailures = [];
    const createRefreshes = [];
    const rejectedCreation = new CreationController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: cardId => cardId === project.id
            ? createWorkspaceActionTarget(project, 'pk') : null,
        pickWorkspaceRoot: async () => undefined,
        pickProvider: async () => 'codex', getProviderLabel: () => 'Codex',
        getProvider: () => ({
            label: 'Codex', terminalNamePrefix: 'Codex',
            buildNewSessionLaunchSpec: (scope, title, markerPath) => ({
                executable: 'codex', args: ['new', title], cwd: scope.primaryCwd, markerPath,
            }),
        }),
        resolveWorkspaceDirectoryScope: () => createDirectoryScope('/work'),
        createPendingId: () => 'rejected-pending', showInputBox: async () => '',
        showActiveTab: async () => undefined, announceStatus: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async message => { createErrors.push(message); },
        logRuntimeFailure: (operation, error, backend) => {
            createFailures.push([operation, error.message, backend]);
        },
        refresh: () => { createRefreshes.push('refresh'); },
        getExistingSessionIdsForCwd: () => [], getPendingMarkerPath: () => '/tmp/rejected',
        scheduleNewSessionRefresh: () => undefined, normalizeProjectPath: value => value,
        setTimeout: () => ({}), clearTimeout: () => undefined,
        bindingTimeoutMs: 15_000, nowMs: () => Date.parse(createdAt),
        runtimeCoordinator: {
            create: async () => { throw new Error('raw create timeout'); },
            getActive: () => [], getPending: () => [], focus: async () => undefined,
        },
    });
    await rejectedCreation.createSession('project');
    assert.deepStrictEqual(createErrors, ['Could not start the AI session runtime.']);
    assert.deepStrictEqual(createRefreshes, ['refresh']);
    assert.deepStrictEqual(createFailures, [['create-runtime', 'raw create timeout', 'tmux']]);

    const resumeErrors = [];
    const resumeFailures = [];
    const resumeRefreshes = [];
    const rejectedResume = new ResumeController({
        getWorkspaceTarget: cardId => cardId === project.id
            ? createWorkspaceActionTarget({
                ...project,
                codexSessions: project.codexSessions.concat({
                    id: 'rejected', name: 'Rejected', cwd: '/work', updatedAt: createdAt,
                }),
            }, 'pk') : null,
        getProvider: () => ({
            label: 'Codex', terminalEnvKey: 'CODEX_SESSION_ID',
            buildResumeLaunchSpec: (sessionId, scope, markerPath) => ({
                executable: 'codex', args: ['resume', sessionId], cwd: scope.primaryCwd, markerPath,
            }),
        }),
        resolveWorkspaceDirectoryScope: () => createDirectoryScope('/work'),
        getTerminalName: () => 'Codex: Rejected', getMarkerPath: () => '/tmp/rejected',
        showWarningMessage: () => undefined,
        showErrorMessage: async message => { resumeErrors.push(message); },
        logRuntimeFailure: (operation, error, backend) => {
            resumeFailures.push([operation, error.message, backend]);
        },
        announceStatus: async () => undefined,
        refresh: () => { resumeRefreshes.push('refresh'); }, showActiveTab: () => undefined,
        runtimeCoordinator: {
            resume: async () => { throw new Error('raw resume timeout'); },
        },
    });
    await rejectedResume.resumeProjectSession('project', 'codex', 'tmux-session');
    assert.deepStrictEqual(resumeErrors, ['Could not resume the AI session runtime.']);
    assert.deepStrictEqual(resumeRefreshes, ['refresh']);
    assert.deepStrictEqual(resumeFailures, [['resume-runtime', 'raw resume timeout', 'tmux']]);

    const pendingTimeouts = [];
    const pendingErrors = [];
    const pendingFailures = [];
    const pendingRefreshes = [];
    let retainedPending;
    const pendingFocusCreation = new CreationController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: cardId => cardId === project.id
            ? createWorkspaceActionTarget(project, 'pk') : null,
        pickWorkspaceRoot: async () => undefined,
        pickProvider: async () => 'codex', getProviderLabel: () => 'Codex',
        getProvider: () => ({
            label: 'Codex', terminalNamePrefix: 'Codex',
            buildNewSessionLaunchSpec: (scope, title, markerPath) => ({
                executable: 'codex', args: ['new', title], cwd: scope.primaryCwd, markerPath,
            }),
        }),
        resolveWorkspaceDirectoryScope: () => createDirectoryScope('/work'),
        createPendingId: () => 'timeout-pending', showInputBox: async () => '',
        showActiveTab: async () => undefined, announceStatus: async () => undefined,
        showWarningMessage: async (_message, ...items) => items.includes('Focus Terminal')
            ? 'Focus Terminal' : undefined,
        showErrorMessage: async message => { pendingErrors.push(message); },
        logRuntimeFailure: (operation, error, backend) => {
            pendingFailures.push([operation, error.message, backend]);
        },
        refresh: () => { pendingRefreshes.push('refresh'); },
        getExistingSessionIdsForCwd: () => [], getPendingMarkerPath: () => '/tmp/timeout',
        scheduleNewSessionRefresh: () => undefined, normalizeProjectPath: value => value,
        setTimeout: callback => { pendingTimeouts.push(callback); return {}; },
        clearTimeout: () => undefined, bindingTimeoutMs: 15_000,
        nowMs: () => Date.parse(createdAt),
        runtimeCoordinator: {
            create: async request => {
                retainedPending = {
                    identity: { ...request.identity }, backend: 'tmux', state: 'pending',
                    markerPath: request.launch.markerPath, runStartedAtMs: Date.parse(request.createdAt),
                    attached: false, createdAt: request.createdAt, excludedSessionIds: [],
                    tmux: { layout: 'session', sessionName: 'pending-timeout' },
                };
                return { status: 'started', runtime: retainedPending };
            },
            getActive: () => [], getPending: () => retainedPending ? [retainedPending] : [],
            focus: async () => { throw new Error('raw pending focus timeout'); },
        },
    });
    await pendingFocusCreation.createSession('project');
    assert.strictEqual(pendingTimeouts.length, 0,
        'runtime pending sessions must not be removed by an elapsed-time callback');
    assert.strictEqual(retainedPending.identity.pendingId, 'timeout-pending');
    assert.deepStrictEqual(pendingErrors, []);
    assert.deepStrictEqual(pendingFailures, []);
    assert.strictEqual(pendingRefreshes.length, 1,
        'creating a retained pending runtime refreshes the visible runtime state once');
}

function runHostRuntimeCompositionChecks() {
    const dashboardSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    assert.ok(dashboardSource.includes('new TmuxRuntimeBindingStore'));
    assert.ok(dashboardSource.includes('new TmuxAttachBindingStore(context.workspaceState'));
    assert.ok(dashboardSource.includes('new TmuxClient'));
    assert.ok(dashboardSource.includes('new TmuxRuntimeDiscovery'));
    assert.ok(dashboardSource.includes('new DirectTerminalRuntimeBackend'));
    assert.ok(dashboardSource.includes('new TmuxRuntimeBackend'));
    assert.ok(dashboardSource.includes('new AiSessionRuntimeCoordinator'));
    assert.ok(dashboardSource.includes('onDidChangeConfiguration'));
    assert.ok(dashboardSource.includes("affectsConfiguration('projectSteward.aiSession"));
    assert.ok(dashboardSource.includes('runtimeCoordinator: aiSessionRuntimeCoordinator'));
    assert.ok(dashboardSource.includes("path.join(context.globalStoragePath, 'ai-session-tmux-runtimes')"));
    assert.ok(dashboardSource.includes("'runtime-binding-final-records'"));
    assert.ok(dashboardSource.includes('runtimeCoordinator: aiSessionRuntimeCoordinator'));
    assert.ok(dashboardSource.includes('getActiveRuntimes: () => aiSessionRuntimeCoordinator.getActive()'));
    assert.ok(dashboardSource.includes('getPendingRuntimes: () => aiSessionRuntimeCoordinator.getPending()'));
    assert.ok(dashboardSource.includes('findTmuxCollisionRuntime('));
    assert.ok(dashboardSource.includes('getRuntimeConflict: getAiSessionRuntimeCollision'));
    assert.ok(dashboardSource.includes('getFocusedAiSessionRuntimeIdentity()'));
    assert.ok(dashboardSource.includes('tmuxRuntimeBackend.getFocusedRuntime(activeTerminal)'));
    assert.ok(dashboardSource.includes('getAttachTerminalName: getAiSessionTmuxAttachTerminalName'));
    assert.ok(dashboardSource.includes('markerIsCurrent: isCurrentRuntimeMarker'));
    assert.ok(dashboardSource.includes("'Use VS Code Terminal This Time'"));
    assert.ok(dashboardSource.includes("'Resume in VS Code Anyway'"));
    assert.ok(dashboardSource.includes("'Open Settings'"));
    assert.match(dashboardSource, /fallback\.knownHint[\s\S]*?showWarningMessage\([\s\S]*?\{ modal: true \}/);
    assert.ok(dashboardSource.includes('tmuxClient.setExecutablePath(nextConfiguration.tmuxPath)'));
    assert.ok(dashboardSource.includes('tmuxRuntimeDiscovery.invalidate()'));
    assert.ok(dashboardSource.includes('await aiSessionRuntimeCoordinator.refreshForHost(true)'));
    assert.ok(dashboardSource.includes('await tmuxRuntimeDiscovery.loadPersistedInactive()'));
    assert.ok(dashboardSource.includes("category: 'unexpected'"));
    const runtimeFailureBody = dashboardSource.slice(
        dashboardSource.indexOf('function logAiSessionRuntimeFailure('),
        dashboardSource.indexOf('async function chooseAiSessionTmuxFallback(')
    );
    assert.ok(!runtimeFailureBody.includes('error.message'));
    assert.ok(!runtimeFailureBody.includes('String(error)'));
    assert.ok(!runtimeFailureBody.includes('logError('));
    assert.ok(!dashboardSource.includes(
        'getTerminalById: (providerId, sessionId) => aiSessionTerminalService.getActiveById'
    ));
    assert.ok(!dashboardSource.includes(
        'getActiveTerminal: (providerId, sessionId) => aiSessionTerminalService.getActiveById'
    ));
    assert.match(dashboardSource,
        /'close-ai-session-terminal':[\s\S]*?expectedBackend: 'vscode'[\s\S]*?'detach-ai-session-terminal':[\s\S]*?expectedBackend: 'tmux'/,
        'host routes must constrain close/detach to the requested runtime backend');
    assert.ok(dashboardSource.includes('chooseRuntimeConflict:'));
    assert.ok(dashboardSource.includes('vscode.window.showQuickPick'));
    assert.ok(dashboardSource.includes("runtime.backend === 'tmux'"));
    assert.ok(dashboardSource.includes("runtime.attached ? 'attached' : 'detached'"));
    const directRestore = dashboardSource.indexOf(
        'await aiSessionTerminalService.restorePersistedTerminals(vscode.window.terminals)'
    );
    const tmuxRestore = dashboardSource.indexOf(
        'await tmuxRuntimeBackend.restoreAttachTerminals(vscode.window.terminals)'
    );
    const hydrationConstruction = dashboardSource.indexOf(
        'const workspaceSessionHydrationController = new WorkspaceSessionHydrationController'
    );
    assert.ok(directRestore >= 0 && tmuxRestore > directRestore && hydrationConstruction > tmuxRestore,
        'Direct and tmux attachment restoration must finish before first hydration is possible');
}

function runTmuxWebviewExperienceChecks() {
    const projectWithTmuxRuntimeFixture = {
        id: 'p', name: 'App', path: '/work/app', activeAiSessionTab: 'active',
        activeAiSessions: [{
            key: 'codex:s1', provider: 'codex', sessionId: 's1', name: 'One',
            executionState: 'running', status: 'running', focused: false, needsAttention: false, pending: false,
            backend: 'tmux', tmuxLayout: 'project', attached: false, stale: true,
        }],
        codexSessions: [{ id: 's1', name: 'One', active: true }],
        kimiSessions: [], claudeSessions: [],
    };
    const projectWithDirectRuntimeFixture = {
        ...projectWithTmuxRuntimeFixture,
        activeAiSessions: [{
            ...projectWithTmuxRuntimeFixture.activeAiSessions[0],
            backend: 'vscode', tmuxLayout: undefined, attached: true, stale: false,
        }],
    };
    const projectWithConflictFixture = {
        ...projectWithTmuxRuntimeFixture,
        activeAiSessions: [{
            ...projectWithTmuxRuntimeFixture.activeAiSessions[0],
            status: 'conflict', conflict: true, stale: false,
        }],
    };

    const tmuxRow = webviewContentModule.getAiSessionsDiv(projectWithTmuxRuntimeFixture);
    assert.ok(tmuxRow.includes('data-session-backend="tmux"'));
    assert.ok(tmuxRow.includes('data-tmux-layout="project"'));
    assert.ok(tmuxRow.includes('data-session-attached="false"'));
    assert.ok(tmuxRow.includes('role="group"'));
    assert.ok(tmuxRow.includes('class="ai-session-primary-action"'));
    assert.ok(tmuxRow.includes('type="button"'));
    assert.ok(tmuxRow.includes('aria-label="Attach or focus Codex session One using tmux project layout, detached, runtime status is stale"'));
    assert.strictEqual(/class="codex-session-row[^>]*tabindex=/.test(tmuxRow), false,
        'the group row itself must not be a focusable clickable div');
    assert.match(tmuxRow,
        /class="ai-session-primary-action"[\s\S]*?<\/button>[\s\S]*?<span class="codex-session-actions">/,
        'the primary button and row actions must be siblings');
    assert.ok(tmuxRow.includes('ai-session-runtime-badge'));
    assert.ok(tmuxRow.includes('data-session-stale'));
    assert.ok(tmuxRow.includes('ai-session-stale-status'));
    assert.ok(tmuxRow.includes('Runtime status is stale'));
    assert.ok(tmuxRow.includes('tmux'));
    assert.ok(tmuxRow.includes('Detach Terminal…'));
    assert.ok(tmuxRow.includes('data-action="detach-ai-session-terminal"'));
    assert.ok(tmuxRow.includes('aria-label="Detach Terminal"'));
    assert.strictEqual((tmuxRow.match(/data-session-backend="tmux"/g) || []).length, 2,
        'matching active history rows must preserve the tmux backend for context actions');

    const directRow = webviewContentModule.getAiSessionsDiv(projectWithDirectRuntimeFixture);
    assert.ok(directRow.includes('data-session-backend="vscode"'));
    assert.ok(directRow.includes('data-session-attached="true"'));
    assert.ok(directRow.includes('aria-label="Focus Codex session One using Direct VS Code terminal, attached"'));
    assert.ok(directRow.includes('Close Terminal…'));
    assert.ok(directRow.includes('data-action="close-ai-session-terminal"'));
    assert.ok(!directRow.includes('data-action="detach-ai-session-terminal"'));
    assert.strictEqual((directRow.match(/data-session-backend="vscode"/g) || []).length, 2);

    const conflictRow = webviewContentModule.getAiSessionsDiv(projectWithConflictFixture);
    assert.ok(conflictRow.includes('data-session-conflict'));
    assert.ok(conflictRow.includes('Runtime conflict'));
    assert.ok(conflictRow.includes('aria-label="Choose runtime for Codex session One, runtime conflict"'));
    assert.ok(!conflictRow.includes('data-action="close-ai-session-terminal"'));
    assert.ok(!conflictRow.includes('data-action="detach-ai-session-terminal"'));

    const projectScript = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'webview', 'webviewProjectScripts.js'), 'utf8'
    );
    assert.ok(projectScript.includes("'detach-ai-session-terminal'"));
    assert.ok(projectScript.includes("data-session-backend"));
    assert.ok(projectScript.includes("contextMenuAiSessionBackend"));
    assert.ok(projectScript.includes(".ai-session-primary-action"));
    const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.scss'), 'utf8');
    assert.ok(styles.includes('.ai-session-runtime-badge'));
    assert.ok(styles.includes('.ai-session-stale-status'));
    assert.ok(styles.includes('&:focus-visible'));
    assert.ok(styles.includes('&[data-session-conflict]'));
    assert.ok(styles.includes('@media (forced-colors: active)'));
    const compiledStyles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');
    assert.ok(compiledStyles.includes('body.steward-sidebar .project .ai-session-primary-action:focus-visible'),
        'generated styles must give the native primary button a visible keyboard focus outline');
}

async function runRealTmuxSmokeHarnessSourceChecks() {
    const smokePath = path.join(__dirname, 'run-ai-session-tmux-smoke-checks.js');
    assert.ok(fs.existsSync(smokePath), 'the isolated real tmux smoke harness must exist');
    const source = fs.readFileSync(smokePath, 'utf8');
    assert.ok(source.includes('execFileSync'));
    assert.ok(source.includes('project-steward-test-'));
    assert.ok(source.includes("'-L'"));
    assert.ok(source.includes("'-f'"));
    assert.ok(source.includes("'/dev/null'"));
    assert.ok(source.includes('finally'));
    assert.ok(source.includes("'kill-server'"));
    assert.ok(source.includes("'list-sessions'"),
        'cleanup must verify the isolated server no longer answers');
    assert.ok(source.includes('#{socket_path}'),
        'cleanup must capture the exact isolated socket before stopping the server');
    assert.ok(source.includes('unlinkSync'),
        'cleanup must remove only its own stale isolated socket');
    assert.ok(source.includes('TMUX_TMPDIR'));
    assert.ok(source.includes('realpathSync'));
    assert.ok(source.includes('PROJECT_STEWARD_TMUX_PATH'));
    assert.ok(source.includes('appendFileSync'));
    assert.ok(source.includes('invocationId'));
    assert.ok(source.includes('readProviderInvocations'));
    assert.ok(source.includes('collectTrackedProviderPids'));
    assert.strictEqual(source.includes("'SIGTERM'"), false);
    assert.strictEqual(source.includes("'SIGKILL'"), false);
    assert.strictEqual(source.includes('new AggregateError'), false,
        'the smoke harness must remain compatible with Node runtimes before global AggregateError');
    assert.ok(source.includes('assert.deepStrictEqual(projectOne.tmux, concurrentProjectOne.tmux)'));
    assert.ok(source.includes("assert.strictEqual(projectInvocationRecords.length, 1"));
    assert.ok(source.includes("assert.strictEqual(sessionRows.length, 2"));
    assert.strictEqual(/\bexecFile\s*\(/.test(source), false);
    assert.strictEqual(/\bexecSync\s*\(/.test(source), false);
    assert.strictEqual(/\bspawn(?:Sync)?\s*\(/.test(source), false);

    const smokeHarness = require(smokePath);
    const cleanupStages = [
        'captureSocket', 'killServer', 'verifyStopped',
        'removeSocket', 'terminateProviders', 'removeFixtures',
    ];
    for (const failingStage of cleanupStages) {
        const calls = [];
        const stages = Object.fromEntries(cleanupStages.map(stage => [stage, async (...values) => {
            calls.push([stage, ...values]);
            if (stage === failingStage) throw new Error(`${stage} failed`);
            return stage === 'captureSocket' ? '/owned/socket' : undefined;
        }]));
        await assert.rejects(
            smokeHarness.runBestEffortCleanup(stages),
            error => error && error.name === 'CleanupAggregateError'
                && Array.isArray(error.errors)
                && error.errors.some(item => item.message === `${failingStage} failed`)
        );
        const expectedCalls = failingStage === 'killServer'
            ? ['captureSocket', 'killServer', 'killServer', 'verifyStopped',
                'removeSocket', 'terminateProviders', 'removeFixtures']
            : cleanupStages;
        assert.deepStrictEqual(calls.map(call => call[0]), expectedCalls,
            `${failingStage} failure must not skip any later cleanup stage`);
        assert.strictEqual(calls.find(call => call[0] === 'removeSocket')[1],
            failingStage === 'captureSocket' || failingStage === 'verifyStopped'
                ? null : '/owned/socket',
            'socket unlink must require both a captured owned path and proof the server stopped');
        assert.strictEqual(calls.find(call => call[0] === 'removeFixtures')[1],
            failingStage === 'verifyStopped' ? false : true,
            'a live or unverifiable server must retain its owned tmux root while other fixtures clean up');
        assert.strictEqual(calls.find(call => call[0] === 'removeFixtures')[2],
            failingStage === 'terminateProviders' ? false : true,
            'an unverifiable provider set must retain its fixture root');
    }

    const noServerError = Object.assign(new Error('raw no server path'), {
        status: 1,
        stderr: 'no server running on /private/test/socket',
    });
    let noServerKillCalls = 0;
    smokeHarness.killIsolatedServer(() => {
        noServerKillCalls++;
        throw noServerError;
    }, {});
    assert.strictEqual(noServerKillCalls, 1,
        'an explicit no-server result must be treated as already stopped without retry');

    const exitedServerError = Object.assign(new Error('raw exited server path'), {
        status: 1,
        stderr: 'server exited unexpectedly\n',
    });
    smokeHarness.assertIsolatedServerStopped(() => { throw exitedServerError; }, {});

    const ordinaryKillError = () => Object.assign(new Error('raw secret /private/work'), {
        status: 1,
        stderr: 'permission denied: /private/work',
    });
    let ordinaryKillCalls = 0;
    await assert.rejects(smokeHarness.runBestEffortCleanup({
        captureSocket: async () => '/owned/socket',
        killServer: async () => smokeHarness.killIsolatedServer(() => {
            ordinaryKillCalls++;
            if (ordinaryKillCalls === 1) throw ordinaryKillError();
        }, {}),
        verifyStopped: async () => undefined,
        removeSocket: async () => undefined,
        terminateProviders: async () => undefined,
        removeFixtures: async () => undefined,
    }), error => error && error.name === 'CleanupAggregateError'
        && !JSON.stringify(error.errors.map(item => item.message)).includes('/private/work'));
    assert.strictEqual(ordinaryKillCalls, 2,
        'an ordinary numeric kill failure must reach the orchestrator retry');

    let repeatedKillCalls = 0;
    const repeatedCleanupCalls = [];
    await assert.rejects(smokeHarness.runBestEffortCleanup({
        captureSocket: async () => '/owned/socket',
        killServer: async () => {
            repeatedKillCalls++;
            smokeHarness.killIsolatedServer(() => { throw ordinaryKillError(); }, {});
        },
        verifyStopped: async () => {
            repeatedCleanupCalls.push('verifyStopped');
            throw new Error('server status unavailable');
        },
        removeSocket: async socketPath => repeatedCleanupCalls.push(['removeSocket', socketPath]),
        terminateProviders: async () => undefined,
        removeFixtures: async (serverStopped, providersStopped) => {
            repeatedCleanupCalls.push(['removeFixtures', serverStopped, providersStopped]);
        },
    }), error => error && error.name === 'CleanupAggregateError' && error.errors.length >= 3);
    assert.strictEqual(repeatedKillCalls, 2);
    assert.deepStrictEqual(repeatedCleanupCalls, [
        'verifyStopped', ['removeSocket', null], ['removeFixtures', false, true],
    ], 'two ordinary kill failures must still verify and retain the tmux root');

    const evidenceFixtures = [
        {
            invocationId: 'fixture-one', pidPath: '/private/one.pid',
            invocationLogPath: '/private/shared.jsonl', stopPath: '/private/one.stop',
        },
        {
            invocationId: 'fixture-two', pidPath: '/private/two.pid',
            invocationLogPath: '/private/shared.jsonl', stopPath: '/private/two.stop',
        },
    ];
    const assertMissingProviderEvidence = operation => assert.throws(operation, error => {
        const messages = [error.message, ...(error.errors || []).map(item => item.message)];
        return error && error.name === 'CleanupAggregateError'
            && !messages.join(' ').includes('/private/')
            && !messages.join(' ').includes('fixture-one')
            && !messages.join(' ').includes('fixture-two');
    });
    assertMissingProviderEvidence(() => smokeHarness.collectTrackedProviderPids(
        [evidenceFixtures[0]],
        { readInvocations: () => [], readFallbackPid: () => null }
    ));
    assertMissingProviderEvidence(() => smokeHarness.collectTrackedProviderPids(
        evidenceFixtures,
        {
            readInvocations: () => [{ invocationId: 'fixture-one', pid: 201 }],
            readFallbackPid: () => null,
        }
    ));
    assertMissingProviderEvidence(() => smokeHarness.collectTrackedProviderPids(
        evidenceFixtures,
        {
            readInvocations: () => [
                { invocationId: 'fixture-one', pid: 201 },
                { invocationId: 'fixture-one', pid: 202 },
                { invocationId: 'fixture-two', pid: -1 },
            ],
            readFallbackPid: () => null,
        }
    ));
    assert.deepStrictEqual(smokeHarness.collectTrackedProviderPids([], {
        readInvocations: () => { throw new Error('empty fixtures must not read evidence'); },
        readFallbackPid: () => { throw new Error('empty fixtures must not read evidence'); },
    }), [], 'an empty fixture set requires no provider PID evidence');
    smokeHarness.stopAndVerifyProviderFixtures([], {
        writeStop: () => { throw new Error('empty fixtures must not write stop files'); },
        readInvocations: () => { throw new Error('empty fixtures must not read evidence'); },
        readFallbackPid: () => { throw new Error('empty fixtures must not read evidence'); },
        probe: () => { throw new Error('empty fixtures must not probe processes'); },
    });
    assert.deepStrictEqual(smokeHarness.collectTrackedProviderPids([
        { invocationId: 'one', pidPath: '/one.pid', invocationLogPath: '/shared.jsonl' },
        { invocationId: 'two', pidPath: '/two.pid', invocationLogPath: '/shared.jsonl' },
        { invocationId: 'three', pidPath: '/three.pid', invocationLogPath: '/missing.jsonl' },
    ], {
        readInvocations: logPath => logPath === '/shared.jsonl' ? [
            { invocationId: 'one', pid: 101 },
            { invocationId: 'one', pid: 102 },
            { invocationId: 'two', pid: 102 },
            { invocationId: 'foreign', pid: 999 },
            { invocationId: 'two', pid: -1 },
        ] : [],
        readFallbackPid: pidPath => pidPath === '/three.pid' ? 103
            : pidPath === '/one.pid' ? 102 : null,
    }), [101, 102, 103],
    'cleanup must track every ledger PID, deduplicate it, ignore foreign/invalid rows, and retain pidPath fallback');
    const probeCalls = [];
    const probeCounts = new Map();
    let probeNow = 0;
    smokeHarness.waitForTrackedProviderExit([101, 102], {
        probe: pid => {
            probeCalls.push(pid);
            const count = (probeCounts.get(pid) || 0) + 1;
            probeCounts.set(pid, count);
            if (pid === 102 || count > 1) {
                const error = new Error('gone');
                error.code = 'ESRCH';
                throw error;
            }
        },
        now: () => probeNow,
        wait: delayMs => { probeNow += delayMs; },
        timeoutMs: 100,
        pollIntervalMs: 10,
    });
    assert.deepStrictEqual(probeCalls, [101, 102, 101],
        'provider cleanup must verify every ledger PID until all report ESRCH');

    const reusedPidProbes = [];
    let timeoutNow = 0;
    assert.throws(() => smokeHarness.waitForTrackedProviderExit([777], {
        probe: pid => { reusedPidProbes.push(pid); },
        now: () => timeoutNow,
        wait: delayMs => { timeoutNow += delayMs; },
        timeoutMs: 20,
        pollIntervalMs: 10,
    }), error => error && error.name === 'CleanupAggregateError');
    assert.ok(reusedPidProbes.length >= 2,
        'a stale or reused PID must only be observed until the bounded timeout');

    const stopWrites = [];
    assert.throws(() => smokeHarness.writeProviderStopFiles([
        { stopPath: '/stop/one' }, { stopPath: '/stop/two' }, { stopPath: '/stop/three' },
    ], {
        writeStop: stopPath => {
            stopWrites.push(stopPath);
            if (stopPath === '/stop/two') throw new Error('write failed');
        },
    }), error => error && error.name === 'CleanupAggregateError');
    assert.deepStrictEqual(stopWrites, ['/stop/one', '/stop/two', '/stop/three'],
        'provider cleanup must request every controlled stop file even when one write fails');

    const missingEvidenceFixtureProofs = [];
    await assert.rejects(smokeHarness.runBestEffortCleanup({
        captureSocket: async () => null,
        killServer: async () => undefined,
        verifyStopped: async () => undefined,
        removeSocket: async () => undefined,
        terminateProviders: async () => smokeHarness.stopAndVerifyProviderFixtures(
            [evidenceFixtures[0]],
            {
                writeStop: () => undefined,
                readInvocations: () => [],
                readFallbackPid: () => null,
                probe: () => { throw new Error('missing evidence must not probe'); },
            }
        ),
        removeFixtures: async (serverStopped, providersStopped) => {
            missingEvidenceFixtureProofs.push([serverStopped, providersStopped]);
        },
    }), error => error && error.name === 'CleanupAggregateError');
    assert.deepStrictEqual(missingEvidenceFixtureProofs, [[true, false]],
        'zero provider evidence must retain the provider fixture root');

    const partialEvidenceStopWrites = [];
    const partialEvidenceProbes = [];
    const partialEvidenceEvents = [];
    const partialEvidenceFixtureProofs = [];
    await assert.rejects(smokeHarness.runBestEffortCleanup({
        captureSocket: async () => '/owned/socket',
        killServer: async () => undefined,
        verifyStopped: async () => undefined,
        removeSocket: async () => undefined,
        terminateProviders: async () => smokeHarness.stopAndVerifyProviderFixtures(
            evidenceFixtures,
            {
                writeStop: stopPath => {
                    partialEvidenceStopWrites.push(stopPath);
                    partialEvidenceEvents.push(['write', stopPath]);
                },
                readInvocations: () => [{ invocationId: 'fixture-one', pid: 201 }],
                readFallbackPid: () => null,
                probe: pid => {
                    partialEvidenceProbes.push(pid);
                    partialEvidenceEvents.push(['probe', pid]);
                    const error = new Error('gone');
                    error.code = 'ESRCH';
                    throw error;
                },
            }
        ),
        removeFixtures: async (serverStopped, providersStopped) => {
            partialEvidenceFixtureProofs.push([serverStopped, providersStopped]);
        },
    }), error => error && error.name === 'CleanupAggregateError');
    assert.deepStrictEqual(partialEvidenceStopWrites,
        ['/private/one.stop', '/private/two.stop'],
        'all provider stop files must be attempted before evidence validation');
    assert.deepStrictEqual(partialEvidenceProbes, [201],
        'known provider PIDs must still receive signal-0 verification when another fixture lacks evidence');
    assert.deepStrictEqual(partialEvidenceEvents, [
        ['write', '/private/one.stop'], ['write', '/private/two.stop'], ['probe', 201],
    ], 'all controlled stop requests must precede provider process observation');
    assert.deepStrictEqual(partialEvidenceFixtureProofs, [[true, false]],
        'partial provider evidence must retain the provider fixture root');

    const completeEvidenceProbes = [];
    smokeHarness.stopAndVerifyProviderFixtures(evidenceFixtures, {
        writeStop: () => undefined,
        readInvocations: () => [
            { invocationId: 'fixture-one', pid: 201 },
            { invocationId: 'fixture-two', pid: 202 },
        ],
        readFallbackPid: () => null,
        probe: pid => {
            completeEvidenceProbes.push(pid);
            const error = new Error('gone');
            error.code = 'ESRCH';
            throw error;
        },
    });
    assert.deepStrictEqual(completeEvidenceProbes.sort(), [201, 202],
        'complete per-fixture evidence must verify every provider and succeed');
}

async function main() {
    runRuntimeConfigurationChecks();
    runLaunchSpecChecks();
    runTmuxLayoutChecks();
    await runTmuxClientChecks();
    await runTmuxDiscoveryChecks();
    await runTmuxStoreChecks();
    await runTmuxBackendChecks();
    await runDirectBackendChecks();
    await runRuntimeCoordinatorChecks();
    await runRuntimeControllerChecks();
    runHostRuntimeCompositionChecks();
    runTmuxWebviewExperienceChecks();
    await runRealTmuxSmokeHarnessSourceChecks();
    console.log('AI session tmux checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
