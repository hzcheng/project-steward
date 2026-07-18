'use strict';
const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const launchSpec = require('../out/aiSessions/launchSpec');
const commandBuilders = require('../out/aiSessions/commandBuilders');
const runtimeConfiguration = require('../out/aiSessions/runtimeConfiguration');
const tmuxLayout = require('../out/aiSessions/tmuxLayout');
const tmuxClientModule = require('../out/aiSessions/tmuxClient');
const discoveryModule = require('../out/aiSessions/tmuxRuntimeDiscovery');
const runtimeStoreModule = require('../out/aiSessions/tmuxRuntimeBindingStore');
const attachStoreModule = require('../out/aiSessions/tmuxAttachBindingStore');
const creationLock = require('../out/aiSessions/tmuxCreationLock');

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
            const error = new tmuxClientModule.TmuxClientError('create-session', 'timeout');
            throw error;
        }
        return row;
    }

    function ambiguousKey(identity) {
        const kind = identity.sessionId !== undefined ? 'session' : 'pending';
        return JSON.stringify([identity.provider, identity.projectKey, kind,
            identity.sessionId !== undefined ? identity.sessionId : identity.pendingId]);
    }

    const runtimeStore = {
        listPending: async () => Array.from(pending.values()).filter(record =>
            !options.enforcePendingTtl
            || (dependencies.nowMs() - record.acceptedAtMs < 24 * 60 * 60 * 1000)),
        getPending: async pendingId => {
            const record = pending.get(pendingId) || null;
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
            pending.set(record.pendingId, { ...record });
            return true;
        },
        removePending: async pendingId => {
            operations.push({ type: 'remove-pending', pendingId });
            pending.delete(pendingId);
        },
        setKnown: async record => {
            operations.push({ type: 'store-known', sessionId: record.sessionId });
            known.set(`${record.provider}:${record.sessionId}`, { ...record });
        },
        getKnown: async (provider, sessionId) => known.get(`${provider}:${sessionId}`) || null,
        removeKnown: async (provider, sessionId) => known.delete(`${provider}:${sessionId}`),
        getAmbiguous: async identity => ambiguous.get(ambiguousKey(identity)) || null,
        getAmbiguousByPendingId: async pendingId => {
            stateReadCount++;
            const matches = Array.from(ambiguous.values()).filter(record =>
                record.pendingId === pendingId);
            if (matches.length > 1) throw new Error('Multiple tmux ambiguous records use the same pending ID.');
            return matches[0] || null;
        },
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
        getConsumedByPendingId: async pendingId => {
            stateReadCount++;
            const matches = Array.from(consumed.values()).filter(record => record.pendingId === pendingId);
            if (matches.length > 1) throw new Error('Multiple tmux consumed records use the same pending ID.');
            return matches[0] || null;
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
        getPromotingByPendingId: async pendingId => {
            stateReadCount++;
            const matches = Array.from(promoting.values()).filter(record => record.pendingId === pendingId);
            if (matches.length > 1) throw new Error('Multiple tmux promotion intents use the same pending ID.');
            return matches[0] || null;
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
            for (const runtime of live) {
                const sessionId = runtime.identity.sessionId;
                if (sessionId && runtime.tmux) {
                    known.set(`${runtime.identity.provider}:${sessionId}`, {
                        version: 1,
                        state: 'known',
                        provider: runtime.identity.provider,
                        sessionId,
                        projectKey: runtime.identity.projectKey,
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
            return options.availability || { available: true, version: '3.2a' };
        },
        getExecutablePath: () => '/opt/tmux',
        setExecutablePath: () => undefined,
        listWindows: async () => windows.map(row => ({
            ...row,
            sessionMetadata: { ...row.sessionMetadata },
            windowMetadata: { ...row.windowMetadata },
            metadata: { ...row.metadata },
        })),
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
            return options.corruptPendingMetadata ? { ...values, projectKey: 'wrong-scope' } : values;
        },
        configureManagedWindow: async (sessionName, windowName) => {
            operations.push({ type: 'configure-window', sessionName, windowName });
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
    const attachStore = {
        get: processId => attachBindings.get(processId) || null,
        set: (processId, binding) => {
            attachWriteQueue = attachWriteQueue.then(() => Promise.resolve(processId)).then(value => {
                if (typeof value === 'number') attachBindings.set(value, { ...binding });
            });
        },
        remove: processId => {
            attachWriteQueue = attachWriteQueue.then(() => Promise.resolve(processId)).then(value => {
                if (typeof value === 'number') attachBindings.delete(value);
            });
        },
        flush: () => attachWriteQueue,
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
    };
    return {
        dependencies, client, runtimeStore, attachStore, operations, terminals, windows,
        pending, known, ambiguous, consumed, promoting, attachBindings,
        get stateReadCount() { return stateReadCount; },
    };
}

function runtimeRecordFilename(record) {
    const identity = record.state === 'pending'
        ? [record.pendingId]
        : [record.provider, record.sessionId];
    const digest = crypto.createHash('sha256')
        .update(JSON.stringify([1, record.state, ...identity]), 'utf8')
        .digest('hex');
    return `${record.state}-${digest}.json`;
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
        `/work/it's app`,
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
        commandBuilders.buildKimiResumeLaunchSpec('kimi; nope', '/work/Kimi App', '/tmp/kimi.done').args,
        ['--work-dir', '/work/Kimi App', '--resume', 'kimi; nope']
    );
    assert.deepStrictEqual(
        commandBuilders.buildKimiNewSessionLaunchSpec('/work/Kimi App', "owner's task", '/tmp/kimi-new.done').args,
        ['--work-dir', '/work/Kimi App', '--prompt', "owner's task"]
    );
    assert.strictEqual(
        commandBuilders.buildClaudeResumeLaunchSpec('claude-session', '/work/claude', '/tmp/claude.done').cwd,
        '/work/claude'
    );
    assert.strictEqual(
        commandBuilders.buildClaudeNewSessionLaunchSpec('/work/app', 'Title', '/tmp/claude-new.done').cwd,
        '/work/app'
    );
    assert.deepStrictEqual(
        commandBuilders.buildCodexNewSessionLaunchSpec('/work/app', 'Prompt', '/tmp/codex-new.done').args,
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
    const windowsSpecs = [
        commandBuilders.buildCodexNewSessionLaunchSpec(adversarialValues.cwd, adversarialValues.prompt, adversarialValues.marker),
        commandBuilders.buildClaudeNewSessionLaunchSpec(adversarialValues.cwd, adversarialValues.title, adversarialValues.marker),
        commandBuilders.buildCodexResumeLaunchSpec(adversarialValues.session, adversarialValues.cwd, adversarialValues.marker),
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
        commandBuilders.buildCodexResumeCommand('session-1', 'C:\\Repo App', null, 'win32'),
        'codex resume --cd "C:\\Repo App" "session-1"'
    );
    assert.strictEqual(
        commandBuilders.buildKimiResumeCommand('session-1', 'C:\\Repo App', null, 'win32'),
        'kimi --work-dir "C:\\Repo App" --resume "session-1"'
    );
    assert.strictEqual(
        commandBuilders.buildClaudeResumeCommand('session-1', 'C:\\Repo App', null, 'win32'),
        'cd "C:\\Repo App" && claude --resume "session-1"'
    );

    assert.strictEqual(
        decodePowerShellPayload(commandBuilders.buildCodexNewSessionCommand('C:\\Repo App', 'Prompt', null, 'win32')),
        "codex --cd 'C:\\Repo App' 'Prompt'"
    );
    assert.strictEqual(
        decodePowerShellPayload(commandBuilders.buildKimiNewSessionCommand('C:\\Repo App', 'Prompt', null, 'win32')),
        "kimi --work-dir 'C:\\Repo App' --prompt 'Prompt'"
    );
    assert.strictEqual(
        decodePowerShellPayload(commandBuilders.buildClaudeNewSessionCommand('C:\\Repo App', 'Title', null, 'win32')),
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
    const identity = { provider: 'codex', projectKey: 'project-key', cwd: '/work/app', sessionId: 'session-1' };
    const project = new tmuxLayout.ProjectTmuxLayout().getLocator(identity);
    const session = new tmuxLayout.SessionTmuxLayout().getLocator(identity);
    assert.deepStrictEqual(project, {
        layout: 'project',
        sessionName: 'project-steward-p-857b61585ca6ee92',
        windowName: 'ai-codex-391f442b59834258',
    });
    assert.deepStrictEqual(session, {
        layout: 'session',
        sessionName: 'project-steward-s-codex-391f442b59834258',
    });
    assert.strictEqual(new tmuxLayout.ProjectTmuxLayout().getLocator(identity).sessionName, project.sessionName);
    const pendingIdentity = { ...identity, sessionId: undefined, pendingId: 'p1' };
    assert.deepStrictEqual(new tmuxLayout.ProjectTmuxLayout().getPendingLocator(pendingIdentity), {
        layout: 'project',
        sessionName: 'project-steward-p-857b61585ca6ee92',
        windowName: 'pending-codex-20634e8befb9ebc9',
    });
    assert.deepStrictEqual(new tmuxLayout.SessionTmuxLayout().getPendingLocator(pendingIdentity), {
        layout: 'session',
        sessionName: 'project-steward-pending-codex-20634e8befb9ebc9',
    });
    assert.deepStrictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'project', projectKey: 'project-key', provider: 'codex', sessionId: 'session-1'
    }), {
        version: 1, layout: 'project', projectKey: 'project-key', provider: 'codex', sessionId: 'session-1'
    });
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({ managed: '1', version: '99' }), null);

    assert.deepStrictEqual(tmuxLayout.TMUX_METADATA_OPTIONS, {
        managed: '@project-steward-managed',
        version: '@project-steward-version',
        layout: '@project-steward-layout',
        projectKey: '@project-steward-project-key',
        provider: '@project-steward-provider',
        sessionId: '@project-steward-session-id',
        pendingId: '@project-steward-pending-id',
        createdAt: '@project-steward-created-at',
        marker: '@project-steward-marker',
    });
    assert.strictEqual(tmuxLayout.getTmuxRuntimeKey(identity), '[1,"codex","project-key","session","session-1"]');
    assert.strictEqual(tmuxLayout.getTmuxRuntimeKey({ ...identity, sessionId: undefined, pendingId: 'p1' }), '[1,"codex","project-key","pending","p1"]');
    assert.throws(() => new tmuxLayout.ProjectTmuxLayout().getLocator({ ...identity, sessionId: '' }));
    assert.throws(() => new tmuxLayout.ProjectTmuxLayout().getLocator({ ...identity, provider: 'other' }));
    assert.throws(() => new tmuxLayout.ProjectTmuxLayout().getLocator({ ...identity, projectKey: 'x'.repeat(513) }));
    assert.throws(() => new tmuxLayout.SessionTmuxLayout().getLocator({ ...identity, sessionId: 'session\u001f1' }));
    assert.throws(() => new tmuxLayout.SessionTmuxLayout().getPendingLocator({ ...identity, sessionId: undefined, pendingId: '' }));
    assert.throws(() => tmuxLayout.getTmuxRuntimeKey({ ...identity, sessionId: undefined, pendingId: undefined }));
    assert.throws(() => tmuxLayout.getTmuxRuntimeKey({ ...identity, pendingId: 'p1' }));
    assert.deepStrictEqual(new tmuxLayout.ProjectTmuxLayout().getLocator({ ...identity, pendingId: 'ignored' }), project);
    assert.deepStrictEqual(new tmuxLayout.SessionTmuxLayout().getPendingLocator({ ...pendingIdentity, sessionId: 'ignored' }), {
        layout: 'session', sessionName: 'project-steward-pending-codex-20634e8befb9ebc9'
    });
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'other', projectKey: 'project-key', provider: 'codex', sessionId: 'session-1'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'other', sessionId: 'session-1'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex', sessionId: 'session\n1'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex',
        sessionId: 'session-1', pendingId: 'p1'
    }), null);
    assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
        managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex',
        pendingId: 'p1', createdAt: '2026-07-18T01:02:03.000Z', marker: '/tmp/p1.done'
    }).pendingId, 'p1');
    for (const invalidField of [
        { projectKey: 'x'.repeat(513) },
        { sessionId: 'x'.repeat(513) },
        { createdAt: 'x'.repeat(201) },
        { createdAt: 'not-a-date' },
        { marker: 'x'.repeat(4097) },
        { marker: '' },
        { marker: '/tmp/control\u007f' },
    ]) {
        assert.strictEqual(tmuxLayout.parseManagedTmuxMetadata({
            managed: '1', version: '1', layout: 'session', projectKey: 'project-key', provider: 'codex',
            sessionId: 'session-1', ...invalidField
        }), null);
    }
}

async function runTmuxClientChecks() {
    const requiredCommands = [
        'new-session', 'new-window', 'list-windows', 'set-option', 'show-options',
        'select-window', 'attach-session',
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

    const metadataCalls = [];
    const optionValues = {
        'session-a|managed': '1',
        'session-a|version': '1',
        'session-a|layout': 'project',
        'session-a|projectKey': 'project-key',
        '@12|managed': '1',
        '@12|version': '1',
        '@12|layout': 'project',
        '@12|provider': 'codex',
        '@12|sessionId': 'session-id-12',
        '@12|marker': '/tmp/done-12 marker',
        '@13|managed': '1',
        '@13|version': '1',
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
                version: '1',
                layout: 'project',
                projectKey: 'project-key',
            },
            windowMetadata: {
                managed: '1',
                version: '1',
                layout: 'project',
                provider: 'codex',
                sessionId: 'session-id-12',
                marker: '/tmp/done-12 marker',
            },
            metadata: {
                managed: '1',
                version: '1',
                layout: 'project',
                projectKey: 'project-key',
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
                version: '1',
                layout: 'project',
                projectKey: 'project-key',
            },
            windowMetadata: {
                managed: '1',
                version: '1',
                layout: 'project',
                provider: 'kimi',
                sessionId: 'session-id-13',
                marker: '/tmp/done-13 marker',
            },
            metadata: {
                managed: '1',
                version: '1',
                layout: 'project',
                projectKey: 'project-key',
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
        managed: '1', version: '1', layout: 'project', projectKey: 'project-key',
    });
    assert.deepStrictEqual(await metadataClient.getWindowOptions('session-a', 'window-a'), {
        provider: 'claude', sessionId: 'public-window-lookup',
    });
    await metadataClient.setSessionOptions('session-a', { managed: '1', version: '1' });
    await metadataClient.setWindowOptions('session-a', 'window-a', {
        provider: 'codex', sessionId: 'session-id',
    });
    await metadataClient.configureManagedWindow('session-a', 'window-a');
    await metadataClient.clearPendingMetadata({
        layout: 'project', sessionName: 'session-a', windowName: 'window-a',
    });
    await metadataClient.clearPendingMetadata({ layout: 'session', sessionName: 'session-a' });
    assert.ok(metadataCalls.some(call => JSON.stringify(call.args) === JSON.stringify([
        'set-option', '-t', 'session-a', '@project-steward-managed', '1',
    ])));
    assert.ok(metadataCalls.some(call => JSON.stringify(call.args) === JSON.stringify([
        'set-option', '-w', '-t', 'session-a:window-a', '@project-steward-session-id', 'session-id',
    ])));
    assert.deepStrictEqual(metadataCalls.slice(-5).map(call => call.args), [
        ['set-option', '-w', '-t', 'session-a:window-a', 'automatic-rename', 'off'],
        ['set-option', '-w', '-t', 'session-a:window-a', 'allow-rename', 'off'],
        ['set-option', '-w', '-t', 'session-a:window-a', 'remain-on-exit', 'off'],
        ['set-option', '-uw', '-t', 'session-a:window-a', '@project-steward-pending-id'],
        ['set-option', '-u', '-t', 'session-a', '@project-steward-pending-id'],
    ]);
    await assert.rejects(
        metadataClient.setSessionOptions('session-a', { status: 'global-option-not-allowed' }),
        /metadata option/
    );

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
        provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 's1',
    };
    const finalLocator = new tmuxLayout.ProjectTmuxLayout().getLocator(finalIdentity);
    const finalSessionMetadata = {
        managed: '1', version: '1', layout: 'project', projectKey: 'pk',
    };
    const finalWindowMetadata = {
        managed: '1', version: '1', layout: 'project',
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
        identity: { provider: 'codex', projectKey: 'pk', cwd: '', sessionId: 's1' },
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
        provider: 'kimi', projectKey: 'pending-project', cwd: '/work/pending', pendingId: 'p1',
    };
    const pendingLocator = new tmuxLayout.ProjectTmuxLayout().getPendingLocator(pendingIdentity);
    const pendingBinding = {
        version: 1, state: 'pending', pendingId: 'p1', provider: 'kimi',
        projectKey: 'pending-project', cwd: '/work/pending',
        createdAt: '2026-07-18T11:00:00Z', excludedSessionIds: ['old-session'],
        title: 'Pending title', layout: 'project', locator: pendingLocator,
    };
    const pendingWindowMetadata = {
        managed: '1', version: '1', layout: 'project', provider: 'kimi', pendingId: 'p1',
        createdAt: pendingBinding.createdAt, marker: '/tmp/p1.done',
    };
    const pendingDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [{
            ...pendingLocator, windowId: '@2', active: true,
            sessionMetadata: {
                managed: '1', version: '1', layout: 'project', projectKey: 'pending-project',
            },
            windowMetadata: pendingWindowMetadata,
            metadata: { projectKey: 'pending-project', ...pendingWindowMetadata },
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
        provider: 'claude', projectKey: 'collision-project', cwd: '', sessionId: 'collision-session',
    };
    const collisionExpected = new tmuxLayout.ProjectTmuxLayout().getLocator(collisionIdentity);
    const collisionActual = {
        layout: 'project', sessionName: collisionExpected.sessionName,
        windowName: `${collisionExpected.windowName}-occupied`,
    };
    const collisionMetadata = {
        managed: '1', version: '1', layout: 'project', provider: 'claude',
        sessionId: 'collision-session', marker: '/tmp/collision.done',
    };
    const collisionKnown = {
        version: 1, state: 'known', provider: 'claude', sessionId: 'collision-session',
        projectKey: 'collision-project', layout: 'project', locator: collisionExpected,
        lastSeenAtMs: 900,
    };
    const collisionReconciled = [];
    const collisionRemoved = [];
    const collisionDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [
            {
                ...collisionActual, windowId: '@3', active: true,
                sessionMetadata: {
                    managed: '1', version: '1', layout: 'project', projectKey: 'collision-project',
                },
                windowMetadata: collisionMetadata,
                metadata: { projectKey: 'collision-project', ...collisionMetadata },
            },
            {
                ...collisionActual, windowId: '@3-duplicate', active: false,
                sessionMetadata: {
                    managed: '1', version: '1', layout: 'project', projectKey: 'collision-project',
                },
                windowMetadata: collisionMetadata,
                metadata: { projectKey: 'collision-project', ...collisionMetadata },
            },
            {
                ...collisionExpected, windowId: '@4', active: true,
                sessionMetadata: {
                    managed: '1', version: '1', layout: 'project',
                    projectKey: 'collision-project',
                },
                windowMetadata: collisionMetadata,
                metadata: {
                    managed: '1', version: '1', layout: 'project',
                    projectKey: 'collision-project', provider: 'claude', sessionId: 'collision-session',
                },
            },
            {
                ...collisionExpected, windowId: '@5', active: true,
                sessionMetadata: {}, windowMetadata: {}, metadata: {},
            },
        ] },
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

    const pendingCollisionActual = {
        ...pendingLocator, windowName: `${pendingLocator.windowName}-occupied`,
    };
    const pendingCollisionReconciled = [];
    const pendingCollisionRemoved = [];
    const pendingCollisionDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [{
            ...pendingCollisionActual, windowId: '@pending-collision', active: false,
            sessionMetadata: {
                managed: '1', version: '1', layout: 'project', projectKey: 'pending-project',
            },
            windowMetadata: pendingWindowMetadata,
            metadata: { projectKey: 'pending-project', ...pendingWindowMetadata },
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
        identity: { ...pendingIdentity, cwd: '' },
        actual: pendingCollisionActual,
        expected: pendingLocator,
    }]);

    const sessionIdentity = {
        provider: 'codex', projectKey: 'session-project', cwd: '', sessionId: 'session-layout-id',
    };
    const sessionLocator = new tmuxLayout.SessionTmuxLayout().getLocator(sessionIdentity);
    const sessionMetadata = {
        managed: '1', version: '1', layout: 'session', projectKey: 'session-project',
        provider: 'codex', sessionId: 'session-layout-id', marker: '/tmp/session.done',
    };
    const sessionWindowMetadata = {
        managed: '1', version: '1', layout: 'session',
    };
    const sessionDiscovery = new discoveryModule.TmuxRuntimeDiscovery({
        client: { listWindows: async () => [
            {
                ...sessionLocator, windowName: 'shell', windowId: '@6', active: false,
                sessionMetadata, windowMetadata: sessionWindowMetadata,
                metadata: { ...sessionMetadata, ...sessionWindowMetadata },
            },
            {
                ...sessionLocator, windowName: 'logs', windowId: '@7', active: true,
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
            sessionMetadata: { projectKey: 'pk' },
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
        version: 1, state: 'known', provider: 'codex', sessionId: 's1', projectKey: 'pk',
        layout: 'project', locator: finalLocator, lastSeenAtMs: 900,
    };
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
    const inactiveCopy = lifecycleDiscovery.getInactive();
    inactiveCopy[0].identity.sessionId = 'mutated';
    inactiveCopy[0].tmux.sessionName = 'mutated';
    assert.strictEqual(lifecycleDiscovery.getInactive()[0].identity.sessionId, 's1');
    assert.strictEqual(lifecycleDiscovery.getInactive()[0].tmux.sessionName, finalLocator.sessionName);
    assert.deepStrictEqual(markerChecks, [[
        '/tmp/s1.done', Date.parse('2026-07-18T10:00:00Z'),
    ]]);
    assert.deepStrictEqual(removedKnown, [['codex', 's1']]);

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
    failList = true;
    now += 501;
    await assert.rejects(failureDiscovery.refresh(), /ambiguous list failure/);
    assert.deepStrictEqual(failureDiscovery.getActive(), beforeFailure);
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
    assert.deepStrictEqual(markerFailureDiscovery.getActive(), markerFailureActive);
    assert.deepStrictEqual(markerFailureDiscovery.getInactive(), []);
}

async function runTmuxStoreChecks() {
    const now = Date.parse('2026-07-18T10:00:00Z');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-tmux-store-'));
    try {
        const store = new runtimeStoreModule.TmuxRuntimeBindingStore(root, () => now);
        const pending = (pendingId, createdAt, overrides = {}) => ({
            version: 1,
            state: 'pending',
            pendingId,
            provider: 'codex',
            projectKey: 'pk',
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
        const known = (sessionId, lastSeenAtMs, overrides = {}) => ({
            version: 1,
            state: 'known',
            provider: 'codex',
            sessionId,
            projectKey: 'pk',
            layout: 'project',
            locator: {
                layout: 'project',
                sessionName: 'project-steward-p-a',
                windowName: `ai-codex-${sessionId}`,
            },
            lastSeenAtMs,
            ...overrides,
        });

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
            provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 'ambiguous-session',
        };
        const ambiguousRecord = {
            version: 1,
            state: 'ambiguous',
            provider: 'codex',
            projectKey: 'pk',
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
        await assert.rejects(store.setAmbiguous({ ...ambiguousRecord, projectKey: '' }),
            /ambiguous tmux binding is invalid/);
        assert.strictEqual(await store.getAmbiguous(ambiguousIdentity), null);

        const pendingAmbiguousRecord = {
            version: 1,
            state: 'ambiguous',
            provider: 'kimi',
            projectKey: 'pending-ambiguous-project',
            pendingId: 'global-ambiguous-pending',
            cwd: '/pending-ambiguous',
            createdAt: '2026-07-18T09:59:00Z',
            excludedSessionIds: ['old'],
            title: 'Pending ambiguous',
            markerPath: '/tmp/pending-ambiguous',
            requestFingerprint: 'b'.repeat(64),
            layout: 'session',
            locator: { layout: 'session', sessionName: 'project-steward-s-kimi-pending-ambiguous' },
            acceptedAtMs: now,
        };
        await store.setAmbiguous(pendingAmbiguousRecord);
        assert.deepStrictEqual(await restartedStore.getAmbiguousByPendingId('global-ambiguous-pending'),
            pendingAmbiguousRecord);
        const conflictingPendingAmbiguous = {
            ...pendingAmbiguousRecord,
            provider: 'claude',
            projectKey: 'other-pending-ambiguous-project',
            cwd: '/other-pending-ambiguous',
            locator: { layout: 'session', sessionName: 'project-steward-s-claude-pending-ambiguous' },
        };
        await store.setAmbiguous(conflictingPendingAmbiguous);
        await assert.rejects(restartedStore.getAmbiguousByPendingId('global-ambiguous-pending'),
            /Multiple.*pending ID/);
        await store.removeAmbiguous({
            provider: pendingAmbiguousRecord.provider,
            projectKey: pendingAmbiguousRecord.projectKey,
            pendingId: pendingAmbiguousRecord.pendingId,
        });
        await store.removeAmbiguous({
            provider: conflictingPendingAmbiguous.provider,
            projectKey: conflictingPendingAmbiguous.projectKey,
            pendingId: conflictingPendingAmbiguous.pendingId,
        });

        await store.setPending(pending('p-new', '2026-07-18T09:59:00Z'));
        await store.setPending(pending('p-old', '2026-07-18T09:58:00Z'));
        assert.deepStrictEqual((await store.listPending()).map(record => record.pendingId), ['p-old', 'p-new']);
        assert.strictEqual((await store.getPending('p-new')).pendingId, 'p-new');
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
        assert.strictEqual(await futureDiskStore.getPending('future-created-disk'), null);
        assert.strictEqual(await futureDiskStore.getPending('future-accepted-disk'), null);

        const nonFiniteRoot = path.join(root, 'non-finite-clock');
        const finiteClockStore = new runtimeStoreModule.TmuxRuntimeBindingStore(nonFiniteRoot, () => now);
        await finiteClockStore.setPending(pending('non-finite-clock', '2026-07-18T09:59:00Z', {
            acceptedAtMs: now,
        }));
        const nonFiniteClockStore = new runtimeStoreModule.TmuxRuntimeBindingStore(nonFiniteRoot, () => NaN);
        assert.deepStrictEqual(await nonFiniteClockStore.listPending(), []);
        assert.strictEqual(await nonFiniteClockStore.getPending('non-finite-clock'), null);
        const acceptedBeforeExpiry = pending('accepted-before-expiry', '2026-07-17T10:00:01Z', {
            acceptedAtMs: now,
        });
        assert.strictEqual(await store.setPending(acceptedBeforeExpiry), true);
        assert.ok((await store.listPending()).some(record => record.pendingId === 'accepted-before-expiry'));
        await store.removePending('accepted-before-expiry');
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

        const consumedIdentity = { provider: 'codex', projectKey: 'pk', cwd: '/work', pendingId: 'p-used' };
        const consumedRecord = {
            version: 1,
            state: 'consumed',
            provider: 'codex',
            projectKey: 'pk',
            cwd: '/work',
            pendingId: 'p-used',
            finalSessionId: 's-used',
            layout: 'session',
            finalLocator: { layout: 'session', sessionName: 'project-steward-s-codex-used' },
            consumedAtMs: now,
        };
        assert.strictEqual(await store.setConsumed(consumedRecord), true);
        assert.deepStrictEqual(await restartedStore.getConsumed(consumedIdentity), consumedRecord);
        assert.deepStrictEqual(await restartedStore.getConsumedByPendingId('p-used'), consumedRecord);
        const conflictingConsumedRecord = {
            ...consumedRecord,
            provider: 'kimi',
            projectKey: 'other-consumed-project',
            cwd: '/other-consumed',
            finalSessionId: 'other-used',
            finalLocator: { layout: 'session', sessionName: 'project-steward-s-kimi-other-used' },
        };
        assert.strictEqual(await store.setConsumed(conflictingConsumedRecord), true);
        await assert.rejects(restartedStore.getConsumedByPendingId('p-used'), /Multiple.*pending ID/);

        const boundedConsumedRoot = path.join(root, 'bounded-consumed');
        fs.mkdirSync(boundedConsumedRoot);
        for (let index = 0; index < 513; index++) {
            fs.writeFileSync(path.join(boundedConsumedRoot, `consumed-${index}.json`), '{}');
        }
        await assert.rejects(
            new runtimeStoreModule.TmuxRuntimeBindingStore(boundedConsumedRoot, () => now)
                .getConsumedByPendingId('bounded-pending'),
            /Too many.*lifecycle|bounded/i
        );
        const boundedDirectoryRoot = path.join(root, 'bounded-directory');
        fs.mkdirSync(boundedDirectoryRoot);
        for (let index = 0; index < 4097; index++) {
            fs.writeFileSync(path.join(boundedDirectoryRoot, `noise-${index}.json`), '{}');
        }
        await assert.rejects(
            new runtimeStoreModule.TmuxRuntimeBindingStore(boundedDirectoryRoot, () => now)
                .getConsumedByPendingId('bounded-directory-pending'),
            /Too many.*lifecycle files|bounded/i
        );

        const promotingRecord = {
            version: 1,
            state: 'promoting',
            provider: 'codex',
            projectKey: 'pk',
            pendingId: 'p-promoting',
            cwd: '/work',
            createdAt: '2026-07-18T09:59:00Z',
            markerPath: '/tmp/promoting',
            finalSessionId: 's-promoting',
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
            provider: 'codex', projectKey: 'pk', cwd: '/work', pendingId: 'p-promoting',
        });
        assert.deepStrictEqual(readPromoting, promotingRecord);
        readPromoting.sourceLocator.windowName = 'mutated';
        assert.strictEqual((await store.getPromoting({
            provider: 'codex', projectKey: 'pk', cwd: '/work', pendingId: 'p-promoting',
        })).sourceLocator.windowName, 'pending-codex-p-promoting');
        assert.strictEqual(await store.getPromoting({
            provider: 'codex', projectKey: 'other', cwd: '/work', pendingId: 'p-promoting',
        }), null);
        assert.deepStrictEqual(await restartedStore.getPromotingByPendingId('p-promoting'), promotingRecord);
        await store.setPending(promotingRecord.pendingBinding);
        const expiredPromotionStore = new runtimeStoreModule.TmuxRuntimeBindingStore(root,
            () => now + (24 * 60 * 60 * 1000) + 1);
        assert.strictEqual(await expiredPromotionStore.getPending('p-promoting'), null);
        assert.deepStrictEqual(await expiredPromotionStore.getPromotingByPendingId('p-promoting'), promotingRecord);
        await store.removePending('p-promoting');
        await assert.rejects(store.setPromoting({
            ...promotingRecord,
            cwd: '/different',
            pendingBinding: { ...promotingRecord.pendingBinding, cwd: '/work' },
        }), /promoting tmux binding is invalid/);
        const conflictingPromoting = {
            ...promotingRecord,
            projectKey: 'other-project',
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
            projectKey: conflictingPromoting.projectKey,
            cwd: conflictingPromoting.cwd,
            locator: { ...conflictingPromoting.sourceLocator },
        };
        await store.setPromoting(conflictingPromoting);
        await assert.rejects(restartedStore.getPromotingByPendingId('p-promoting'), /Multiple.*pending ID/);
        await store.removePromoting({
            provider: 'codex', projectKey: 'other-project', cwd: '/other', pendingId: 'p-promoting',
        });
        await restartedStore.removePromoting({
            provider: 'codex', projectKey: 'pk', cwd: '/work', pendingId: 'p-promoting',
        });
        assert.strictEqual(await store.getPromoting({
            provider: 'codex', projectKey: 'pk', cwd: '/work', pendingId: 'p-promoting',
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
            identity: { provider: 'kimi', projectKey: 'pk-queued', cwd: '/queued', sessionId: 'queued-live' },
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

        await store.reconcileKnown([{
            identity: { provider: 'kimi', projectKey: 'pk-live', cwd: '/live', sessionId: 'live' },
            backend: 'tmux',
            state: 'active',
            markerPath: '/tmp/live.done',
            runStartedAtMs: now - 100,
            attached: false,
            tmux: { layout: 'session', sessionName: 'project-steward-s-kimi-live' },
        }, {
            identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 'ignored-vscode' },
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

        await store.removePending('p-old');
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
            version: 1,
            layout: 'project',
            projectKey: 'pk',
            sessionName: 'project-steward-p-a',
            windowName: 'ai-codex-a',
            provider: 'codex',
            sessionId: 's1',
            terminalNamePrefix: 'Project Steward:',
        };
        attach.set(Promise.resolve(41), binding);
        await attach.flush();
        assert.deepStrictEqual(attach.get(41), binding);
        assert.deepStrictEqual([...state.keys()], ['aiSessionTmuxAttachProcessBinding.v1.41']);
        const minimalBinding = {
            version: 1,
            layout: 'project',
            projectKey: 'pk',
            sessionName: 'project-steward-p-a',
            terminalNamePrefix: 'Project Steward:',
        };
        attach.set(Promise.resolve(44), minimalBinding);
        await attach.flush();
        assert.deepStrictEqual(attach.get(44), minimalBinding);
        attach.remove(Promise.resolve(44));
        attach.set(Promise.resolve(0), binding);
        attach.set(Promise.resolve(42), { ...binding, layout: 'session' });
        attach.set(Promise.resolve(43), { ...binding, windowName: undefined, terminalNamePrefix: '' });
        await attach.flush();
        assert.strictEqual(state.size, 1);
        attach.remove(Promise.resolve(41));
        await attach.flush();
        assert.strictEqual(state.size, 0);

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
    const projectHarness = createTmuxBackendHarness();
    const projectBackend = new backendModule.TmuxRuntimeBackend(projectHarness.dependencies);
    const firstProject = await projectBackend.ensureResume({
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 's1' },
        projectName: 'App',
        terminalName: 'AI Sessions: App',
        launch: { executable: 'codex', args: ['resume', 's1'], markerPath: '/tmp/m1' },
    }, 'project');
    const secondProject = await projectBackend.ensureResume({
        identity: { provider: 'claude', projectKey: 'pk', cwd: '/work', sessionId: 's2' },
        projectName: 'App',
        terminalName: 'AI Sessions: App',
        launch: { executable: 'claude', args: ['--resume', 's2'], markerPath: '/tmp/m2' },
    }, 'project');
    assert.strictEqual(projectHarness.operations.filter(item => item.type === 'new-session').length, 1);
    assert.strictEqual(projectHarness.operations.filter(item => item.type === 'new-window').length, 2);
    assert.strictEqual(projectHarness.operations.filter(item => item.type === 'configure-window').length, 2);
    const firstProjectRequest = {
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'AI Sessions: App',
        launch: { executable: 'codex', args: ['resume', 's1'], markerPath: '/tmp/m1' },
    };
    await projectBackend.ensureResume(firstProjectRequest, 'project');
    assert.strictEqual(projectHarness.operations.filter(item => item.type === 'new-session').length, 1);
    assert.strictEqual(projectHarness.operations.filter(item => item.type === 'new-window').length, 2);
    assert.strictEqual(projectHarness.terminals.length, 1);
    assert.deepStrictEqual(projectHarness.terminals[0].creationOptions, {
        name: 'AI Sessions: App',
        shellPath: '/opt/tmux',
        shellArgs: ['attach-session', '-t', firstProject.tmux.sessionName],
        env: { TMUX: null },
    });
    const firstAttachIndex = projectHarness.operations.findIndex(item => item.type === 'create-terminal');
    assert.ok(projectHarness.operations.slice(0, firstAttachIndex).some(item => item.type === 'select-window'));
    assert.strictEqual(firstProject.terminal, projectHarness.terminals[0]);
    assert.strictEqual(secondProject.terminal, projectHarness.terminals[0]);
    assert.strictEqual(projectBackend.getActive().length, 2);
    await projectBackend.focus(firstProject);
    assert.deepStrictEqual(projectHarness.operations.filter(item => item.type === 'select-window').slice(-1)[0].locator,
        firstProject.tmux);
    await projectBackend.detach(firstProject);
    assert.strictEqual(projectHarness.terminals[0].disposed, true);
    assert.strictEqual(projectBackend.getActive().length, 2);
    assert.ok(projectBackend.getActive().every(runtime => runtime.attached === false));
    const projectManagedRows = projectHarness.windows.filter(row => row.windowMetadata.provider);
    assert.strictEqual(projectManagedRows.length, 2);
    assert.deepStrictEqual(projectManagedRows[0].sessionMetadata, {
        managed: '1', version: '1', layout: 'project', projectKey: 'pk',
    });
    assert.deepStrictEqual(projectManagedRows[0].windowMetadata, {
        managed: '1', version: '1', layout: 'project', provider: 'codex', sessionId: 's1',
        createdAt: '2026-07-18T10:00:00.000Z', marker: '/tmp/m1',
    });
    assert.ok(projectHarness.operations.findIndex(item => item.type === 'availability')
        < projectHarness.operations.findIndex(item => item.type === 'lock'));

    const concurrentProjectHarness = createTmuxBackendHarness({ concurrentProjectBootstrap: true });
    const concurrentProjectBackendA = new backendModule.TmuxRuntimeBackend(concurrentProjectHarness.dependencies);
    const concurrentProjectBackendB = new backendModule.TmuxRuntimeBackend(concurrentProjectHarness.dependencies);
    await Promise.all([
        concurrentProjectBackendA.ensureResume({
            identity: { provider: 'codex', projectKey: 'concurrent', cwd: '/work', sessionId: 'a' },
            projectName: 'App', terminalName: 'AI Sessions: Concurrent',
            launch: { executable: 'codex', args: ['resume', 'a'] },
        }, 'project'),
        concurrentProjectBackendB.ensureResume({
            identity: { provider: 'claude', projectKey: 'concurrent', cwd: '/work', sessionId: 'b' },
            projectName: 'App', terminalName: 'AI Sessions: Concurrent',
            launch: { executable: 'claude', args: ['--resume', 'b'] },
        }, 'project'),
    ]);
    assert.strictEqual(concurrentProjectHarness.operations.filter(item => item.type === 'new-session').length, 1);
    assert.strictEqual(concurrentProjectHarness.operations.filter(item => item.type === 'new-window').length, 2);

    const projectOwnershipHarness = createTmuxBackendHarness();
    const requestedOwnershipIdentity = {
        provider: 'codex', projectKey: 'requested-project', cwd: '/work', sessionId: 'requested-session',
    };
    const requestedOwnershipLocator = new tmuxLayout.ProjectTmuxLayout().getLocator(requestedOwnershipIdentity);
    const wrongOwnershipRuntime = {
        identity: { provider: 'claude', projectKey: 'different-project', cwd: '', sessionId: 'other-session' },
        backend: 'tmux', state: 'active', markerPath: '', runStartedAtMs: 0, attached: false,
        tmux: {
            layout: 'project', sessionName: requestedOwnershipLocator.sessionName, windowName: 'ai-claude-other',
        },
    };
    projectOwnershipHarness.windows.push({
        sessionName: requestedOwnershipLocator.sessionName,
        windowName: 'ai-claude-other', windowId: '@hash-collision', active: true,
        sessionMetadata: {
            managed: '1', version: '1', layout: 'project', projectKey: 'different-project',
        },
        windowMetadata: {
            managed: '1', version: '1', layout: 'project', provider: 'claude', sessionId: 'other-session',
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

    const sessionHarness = createTmuxBackendHarness();
    const sessionBackend = new backendModule.TmuxRuntimeBackend(sessionHarness.dependencies);
    await sessionBackend.ensureResume({
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'Codex: s1',
        launch: { executable: 'codex', args: ['resume', 's1'], markerPath: '/tmp/s1' },
    }, 'session');
    await sessionBackend.ensureResume({
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 's2' },
        projectName: 'App', terminalName: 'Codex: s2',
        launch: { executable: 'codex', args: ['resume', 's2'], markerPath: '/tmp/s2' },
    }, 'session');
    assert.strictEqual(sessionHarness.operations.filter(item => item.type === 'new-session').length, 2);
    assert.strictEqual(sessionHarness.operations.filter(item => item.type === 'new-window').length, 0);
    assert.strictEqual(sessionHarness.terminals.length, 2);
    const sessionManagedRow = sessionHarness.windows[0];
    assert.deepStrictEqual(sessionManagedRow.sessionMetadata, {
        managed: '1', version: '1', layout: 'session', projectKey: 'pk', provider: 'codex',
        sessionId: 's1', createdAt: '2026-07-18T10:00:00.000Z', marker: '/tmp/s1',
    });
    assert.deepStrictEqual(sessionManagedRow.windowMetadata, {
        managed: '1', version: '1', layout: 'session',
    });

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
                provider: 'codex', projectKey: 'invalid-pending', cwd: '/work',
                pendingId: invalidCase.label,
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
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 'bad-layout' },
        projectName: 'App', terminalName: 'Codex: Invalid Layout',
        launch: { executable: 'codex', args: ['resume', 'bad-layout'] },
    }, 'invalid'), /layout/i);
    await assert.rejects(invalidLayoutBackend.ensurePending({
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', pendingId: 'bad-layout' },
        projectName: 'App', terminalName: 'Codex: Invalid Layout',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
        launch: { executable: 'codex', args: ['new'] },
    }, 'invalid'), /layout/i);
    assert.strictEqual(invalidLayoutHarness.operations.some(item => item.type === 'new-session'), false);

    const invalidDispatchCases = [
        {
            label: 'cwd nul',
            identity: { provider: 'codex', projectKey: 'invalid-dispatch', cwd: '/work\0bad', sessionId: 's1' },
            launch: { executable: 'codex', args: ['resume', 's1'] },
        },
        {
            label: 'executable nul',
            identity: { provider: 'codex', projectKey: 'invalid-dispatch', cwd: '/work', sessionId: 's2' },
            launch: { executable: 'codex\0bad', args: ['resume', 's2'] },
        },
        {
            label: 'argument nul',
            identity: { provider: 'codex', projectKey: 'invalid-dispatch', cwd: '/work', sessionId: 's3' },
            launch: { executable: 'codex', args: ['resume', 's3\0bad'] },
        },
        {
            label: 'launch cwd nul',
            identity: { provider: 'codex', projectKey: 'invalid-dispatch', cwd: '/work', sessionId: 's4' },
            launch: { executable: 'codex', args: ['resume', 's4'], cwd: '/work\0bad' },
        },
        {
            label: 'marker nul',
            identity: { provider: 'codex', projectKey: 'invalid-dispatch', cwd: '/work', sessionId: 's5' },
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
        identity: { provider: 'codex', projectKey: 'oversized-args', cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'Codex: Oversized Args',
        launch: { executable: 'codex', args: oversizedArgs },
    }, 'session'), /too many provider launch arguments/);
    assert.strictEqual(oversizedArgsHarness.operations.length, 0);
    assert.strictEqual(oversizedArgsHarness.stateReadCount, 0);

    const sparseArgs = new Array(2);
    sparseArgs[1] = 's1';
    const sparseArgsHarness = createTmuxBackendHarness();
    await assert.rejects(new backendModule.TmuxRuntimeBackend(sparseArgsHarness.dependencies).ensureResume({
        identity: { provider: 'codex', projectKey: 'sparse-args', cwd: '/work', sessionId: 's1' },
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
            provider: 'kimi', projectKey: 'oversized-exclusions', cwd: '/work', pendingId: 'pending',
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
        identity: { provider: 'kimi', projectKey: 'sparse-exclusions', cwd: '/work', pendingId: 'pending' },
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
                ? { provider: 'codex', projectKey: 'single-read-container', cwd: '/work', sessionId: 'stable' }
                : { provider: 'codex', projectKey: 'switched-container', cwd: '/changed', sessionId: 'changed' };
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
    assert.strictEqual(switchingContainerRuntime.identity.projectKey, 'single-read-container');
    assert.strictEqual(switchingContainerRuntime.identity.sessionId, 'stable');
    const switchingContainerCreate = switchingContainerHarness.operations.find(item => item.type === 'new-session');
    assert.strictEqual(switchingContainerCreate.cwd, '/work');
    assert.ok(switchingContainerCreate.command.includes('stable'));
    assert.strictEqual(switchingContainerCreate.command.includes('changed'), false);

    const siblingMutationIdentity = {
        provider: 'codex', projectKey: 'sibling-stable', cwd: '/work', sessionId: 'sibling-stable',
    };
    const siblingMutationArgs = ['resume', 'sibling-stable'];
    const siblingMutationHarness = createTmuxBackendHarness();
    const siblingMutationRuntime = await new backendModule.TmuxRuntimeBackend(
        siblingMutationHarness.dependencies
    ).ensureResume({
        identity: siblingMutationIdentity,
        get projectName() {
            siblingMutationIdentity.projectKey = 'sibling-mutated';
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
    assert.strictEqual(siblingMutationRuntime.identity.projectKey, 'sibling-stable');
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
        identity: { provider: 'codex', projectKey: 'single-read-length', cwd: '/work', sessionId: 'stable-length' },
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
            provider: 'codex', projectKey: 'single-read-element', cwd: '/work', sessionId: 'stable-element',
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
            provider: 'kimi', projectKey: 'single-read-pending', cwd: '/work', pendingId: 'single-read-pending',
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
                provider: 'codex', projectKey: `budget-${launchBudgetCase.label}`, cwd: '/work', sessionId: 's1',
            },
            projectName: 'App', terminalName: 'Codex: Budget',
            launch: { executable: 'codex', args: launchBudgetCase.args, markerPath: '/tmp/budget' },
        }, 'session'), /launch.*(budget|large)|argument.*(count|large)/i);
        assert.strictEqual(launchBudgetHarness.operations.length, 0);
        assert.strictEqual(launchBudgetHarness.ambiguous.size, 0);
    }

    const e2bigHarness = createTmuxBackendHarness({ failCreateSessionE2bigCount: 1 });
    const e2bigRequest = {
        identity: { provider: 'codex', projectKey: 'e2big', cwd: '/work', sessionId: 's1' },
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
            provider: 'codex', projectKey: 'snapshot-resume', cwd: '/original', sessionId: 'original-session',
        },
        projectName: 'Original Project', terminalName: 'Codex: Original',
        launch: {
            executable: 'codex', args: ['resume', 'original-session'], cwd: '/original',
            markerPath: '/tmp/original-marker',
        },
    };
    const resumeSnapshotPromise = new backendModule.TmuxRuntimeBackend(resumeSnapshotHarness.dependencies)
        .ensureResume(resumeSnapshotRequest, 'session');
    resumeSnapshotRequest.identity.projectKey = 'mutated-project';
    resumeSnapshotRequest.identity.cwd = '/mutated';
    resumeSnapshotRequest.identity.sessionId = 'mutated-session';
    resumeSnapshotRequest.launch.executable = 'mutated-provider';
    resumeSnapshotRequest.launch.args[1] = 'mutated-session';
    resumeSnapshotRequest.launch.cwd = '/mutated';
    resumeSnapshotRequest.launch.markerPath = '/tmp/mutated-marker';
    resumeSnapshotRequest.terminalName = 'Codex: Mutated';
    resumeAvailabilityGate.resolve();
    const resumeSnapshotRuntime = await resumeSnapshotPromise;
    assert.strictEqual(resumeSnapshotRuntime.identity.projectKey, 'snapshot-resume');
    assert.strictEqual(resumeSnapshotRuntime.identity.sessionId, 'original-session');
    assert.strictEqual(resumeSnapshotHarness.terminals[0].name, 'Codex: Original');
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
            provider: 'kimi', projectKey: 'snapshot-pending', cwd: '/original', pendingId: 'original-pending',
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
    assert.deepStrictEqual(pendingSnapshotRuntime.excludedSessionIds, ['original-exclusion']);
    assert.strictEqual(pendingSnapshotRuntime.title, 'Original title');
    assert.strictEqual(pendingSnapshotHarness.terminals[0].name, 'Kimi: Original');
    const pendingSnapshotCreate = pendingSnapshotHarness.operations.find(item => item.type === 'new-session');
    assert.strictEqual(pendingSnapshotCreate.cwd, '/original');
    assert.ok(pendingSnapshotCreate.command.includes('original-title'));
    assert.strictEqual(pendingSnapshotCreate.command.includes('mutated-title'), false);

    const basePendingNow = Date.parse('2026-07-18T10:00:00Z');
    const futurePendingHarness = createTmuxBackendHarness({ nowMs: () => basePendingNow });
    await assert.rejects(new backendModule.TmuxRuntimeBackend(futurePendingHarness.dependencies).ensurePending({
        identity: { provider: 'codex', projectKey: 'future', cwd: '/work', pendingId: 'future-pending' },
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
        identity: { provider: 'codex', projectKey: 'lock-expiry', cwd: '/work', pendingId: 'lock-expiry' },
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
    await new backendModule.TmuxRuntimeBackend(acceptedHarness.dependencies).ensurePending({
        identity: { provider: 'kimi', projectKey: 'accepted', cwd: '/work', pendingId: 'accepted-pending' },
        projectName: 'App', terminalName: 'Kimi: Accepted',
        createdAt: '2026-07-17T10:00:01Z', excludedSessionIds: [],
        launch: { executable: 'kimi', args: ['new'] },
    }, 'session');
    assert.strictEqual(acceptedHarness.pending.get('accepted-pending').acceptedAtMs, basePendingNow);

    const globalMismatchRequest = pendingId => ({
        identity: { provider: 'codex', projectKey: 'global-request', cwd: '/work', pendingId },
        projectName: 'App', terminalName: 'Codex: Global Pending',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
        launch: { executable: 'codex', args: ['new'] },
    });
    const globalMismatchCases = [
        {
            label: 'promoting',
            seed(harness, pendingId) {
                const record = {
                    pendingId, provider: 'kimi', projectKey: 'other-promoting', cwd: '/other-promoting',
                };
                harness.promoting.set('global-mismatch-promoting', record);
            },
        },
        {
            label: 'consumed',
            seed(harness, pendingId) {
                const record = {
                    pendingId, provider: 'kimi', projectKey: 'other-consumed', cwd: '/other-consumed',
                };
                harness.consumed.set('global-mismatch-consumed', record);
            },
        },
        {
            label: 'ambiguous',
            seed(harness, pendingId) {
                const record = {
                    pendingId, provider: 'kimi', projectKey: 'other-ambiguous', cwd: '/other-ambiguous',
                };
                harness.ambiguous.set('global-mismatch-ambiguous', record);
            },
        },
        {
            label: 'live pending',
            seed(harness, pendingId) {
                harness.pending.set(pendingId, {
                    pendingId, provider: 'kimi', projectKey: 'other-live', cwd: '/other-live',
                    acceptedAtMs: basePendingNow,
                });
            },
        },
    ];
    for (const mismatchCase of globalMismatchCases) {
        const mismatchHarness = createTmuxBackendHarness();
        const pendingId = `global-mismatch-${mismatchCase.label.replace(' ', '-')}`;
        mismatchCase.seed(mismatchHarness, pendingId);
        await assert.rejects(
            new backendModule.TmuxRuntimeBackend(mismatchHarness.dependencies)
                .ensurePending(globalMismatchRequest(pendingId), 'session'),
            /pending ID.*identity|different.*identity|conflict/i
        );
        assert.strictEqual(mismatchHarness.operations.filter(item => item.type === 'new-session').length, 0);
    }

    for (const promotionMismatchState of ['consumed', 'ambiguous']) {
        const promotionMismatchHarness = createTmuxBackendHarness();
        const pendingId = `promotion-global-mismatch-${promotionMismatchState}`;
        const sourceIdentity = {
            provider: 'codex', projectKey: 'promotion-global-source', cwd: '/source', pendingId,
        };
        const sourceLocator = new tmuxLayout.SessionTmuxLayout().getPendingLocator(sourceIdentity);
        promotionMismatchHarness.pending.set(pendingId, {
            version: 1, state: 'pending', ...sourceIdentity,
            createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
            acceptedAtMs: basePendingNow, layout: 'session', locator: sourceLocator,
        });
        const mismatchedRecord = {
            pendingId, provider: 'kimi', projectKey: 'promotion-global-other', cwd: '/other',
        };
        promotionMismatchHarness[promotionMismatchState].set(
            `promotion-global-${promotionMismatchState}`, mismatchedRecord
        );
        await assert.rejects(
            new backendModule.TmuxRuntimeBackend(promotionMismatchHarness.dependencies)
                .promotePending(pendingId, `promotion-global-final-${promotionMismatchState}`),
            /pending ID.*identity|different.*identity/i
        );
        assert.strictEqual(promotionMismatchHarness.operations.some(item =>
            item.type === 'rename-session' || item.type === 'rename-window'
            || item.type === 'store-promoting' || item.type === 'store-consumed'), false);
    }

    const concurrentGlobalHarness = createTmuxBackendHarness();
    const concurrentPendingId = 'concurrent-global-pending';
    const concurrentGlobalRequests = [
        {
            identity: {
                provider: 'codex', projectKey: 'concurrent-global-a', cwd: '/work-a',
                pendingId: concurrentPendingId,
            },
            projectName: 'App A', terminalName: 'Codex: Concurrent Global A',
            createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
            launch: { executable: 'codex', args: ['new'], cwd: '/work-a' },
        },
        {
            identity: {
                provider: 'kimi', projectKey: 'concurrent-global-b', cwd: '/work-b',
                pendingId: concurrentPendingId,
            },
            projectName: 'App B', terminalName: 'Kimi: Concurrent Global B',
            createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
            launch: { executable: 'kimi', args: ['new'], cwd: '/work-b' },
        },
    ];
    const concurrentGlobalResults = await Promise.allSettled(concurrentGlobalRequests.map(request =>
        new backendModule.TmuxRuntimeBackend(concurrentGlobalHarness.dependencies)
            .ensurePending(request, 'session')));
    assert.strictEqual(concurrentGlobalResults.filter(result => result.status === 'fulfilled').length, 1);
    assert.strictEqual(concurrentGlobalResults.filter(result => result.status === 'rejected').length, 1);
    assert.match(concurrentGlobalResults.find(result => result.status === 'rejected').reason.message,
        /pending ID.*identity|different.*identity|conflict/i);
    assert.strictEqual(concurrentGlobalHarness.operations.filter(item => item.type === 'new-session').length, 1);
    assert.strictEqual(concurrentGlobalHarness.operations.filter(item =>
        item.type === 'lock' && item.key === `pending:${concurrentPendingId}`).length, 2);
    const concurrentGlobalBinding = concurrentGlobalHarness.pending.get(concurrentPendingId);
    assert.ok(concurrentGlobalBinding);
    const winningRequest = concurrentGlobalResults[0].status === 'fulfilled'
        ? concurrentGlobalRequests[0] : concurrentGlobalRequests[1];
    assert.strictEqual(concurrentGlobalBinding.provider, winningRequest.identity.provider);
    assert.strictEqual(concurrentGlobalBinding.projectKey, winningRequest.identity.projectKey);
    assert.strictEqual(concurrentGlobalBinding.cwd, winningRequest.identity.cwd);

    const pendingHarness = createTmuxBackendHarness();
    const pendingBackend = new backendModule.TmuxRuntimeBackend(pendingHarness.dependencies);
    const pendingRequest = {
        identity: { provider: 'claude', projectKey: 'pk', cwd: '/work', pendingId: 'pending-1' },
        projectName: 'App', terminalName: 'Claude: New',
        createdAt: '2026-07-18T09:59:00Z',
        excludedSessionIds: ['old'],
        title: 'New work',
        launch: { executable: 'claude', args: ['--name', 'New work'], markerPath: '/tmp/pending' },
    };
    const pendingRuntime = await pendingBackend.ensurePending(pendingRequest, 'session');
    const pendingSessionReadIndex = pendingHarness.operations.findIndex(item => item.type === 'get-session-options');
    const pendingWindowReadIndex = pendingHarness.operations.findIndex(item => item.type === 'get-window-options');
    const pendingStoreIndex = pendingHarness.operations.findIndex(item => item.type === 'store-pending');
    assert.ok(pendingSessionReadIndex >= 0 && pendingSessionReadIndex < pendingStoreIndex);
    assert.ok(pendingWindowReadIndex >= 0 && pendingWindowReadIndex < pendingStoreIndex);
    assert.strictEqual(pendingBackend.getPending().length, 1);
    const promoted = await pendingBackend.promotePending('pending-1', 'final-1');
    assert.strictEqual(promoted.length, 1);
    assert.strictEqual(promoted[0].identity.sessionId, 'final-1');
    assert.strictEqual(pendingHarness.pending.size, 0);
    assert.strictEqual(pendingHarness.consumed.size, 1);
    assert.ok(pendingHarness.known.has('claude:final-1'));
    assert.strictEqual(pendingHarness.operations.filter(item => item.type === 'clear-pending').length, 1);
    assert.strictEqual(pendingHarness.operations.filter(item => item.type === 'rename-session').length, 1);
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
        provider: 'claude', projectKey: 'pk', cwd: '/work', sessionId: 'final-1',
    })));
    assert.ok(pendingHarness.operations.some(item =>
        item.type === 'lock' && item.key === 'pending:pending-1'));
    const pendingCreateCount = pendingHarness.operations.filter(item => item.type === 'new-session').length;
    await assert.rejects(
        new backendModule.TmuxRuntimeBackend(pendingHarness.dependencies).ensurePending(pendingRequest, 'session'),
        /already consumed/
    );
    assert.strictEqual(pendingHarness.operations.filter(item => item.type === 'new-session').length,
        pendingCreateCount);

    const corruptPendingHarness = createTmuxBackendHarness({ corruptPendingMetadata: true });
    await assert.rejects(new backendModule.TmuxRuntimeBackend(corruptPendingHarness.dependencies).ensurePending({
        identity: { provider: 'codex', projectKey: 'corrupt', cwd: '/work', pendingId: 'corrupt-pending' },
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
            provider: 'kimi', projectKey: 'pending-recovery', cwd: '/work', pendingId: 'recover-pending',
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
        .ensurePending(pendingRecoveryRequest, 'session');
    assert.strictEqual(recoveredPendingRuntime.identity.pendingId, 'recover-pending');
    assert.strictEqual(pendingRecoveryHarness.pending.size, 1);
    assert.strictEqual(pendingRecoveryHarness.ambiguous.size, 0);
    assert.strictEqual(pendingRecoveryHarness.operations.filter(item => item.type === 'new-session').length, 1);

    const projectPromotionHarness = createTmuxBackendHarness();
    const projectPromotionBackend = new backendModule.TmuxRuntimeBackend(projectPromotionHarness.dependencies);
    const projectPending = await projectPromotionBackend.ensurePending({
        identity: {
            provider: 'kimi', projectKey: 'project-promotion', cwd: '/work', pendingId: 'project-pending',
        },
        projectName: 'App', terminalName: 'AI Sessions: Project Promotion',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
        launch: { executable: 'kimi', args: ['new'], markerPath: '/tmp/project-pending' },
    }, 'project');
    const projectPromoted = await projectPromotionBackend.promotePending('project-pending', 'project-final');
    assert.strictEqual(projectPromoted.length, 1);
    assert.strictEqual(projectPromoted[0].identity.sessionId, 'project-final');
    assert.strictEqual(projectPromotionHarness.operations.filter(item => item.type === 'rename-window').length, 1);
    assert.strictEqual(projectPromotionHarness.operations.filter(item => item.type === 'clear-pending').length, 1);
    assert.strictEqual(projectPromotionHarness.pending.size, 0);
    assert.strictEqual(projectPromotionHarness.consumed.size, 1);
    assert.notStrictEqual(projectPromoted[0].tmux.windowName, projectPending.tmux.windowName);

    for (const recoveryLayout of ['session', 'project']) {
        const recoveryHarness = createTmuxBackendHarness({ failSetConsumedCount: 1 });
        const recoveryRequest = {
            identity: {
                provider: 'claude', projectKey: `promotion-recovery-${recoveryLayout}`, cwd: '/work',
                pendingId: `promotion-recovery-pending-${recoveryLayout}`,
            },
            projectName: 'App', terminalName: `Claude: Promotion Recovery ${recoveryLayout}`,
            createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: ['prior'], title: 'Recover promotion',
            launch: { executable: 'claude', args: ['new'], markerPath: `/tmp/recovery-${recoveryLayout}` },
        };
        const recoveryBackend = new backendModule.TmuxRuntimeBackend(recoveryHarness.dependencies);
        await recoveryBackend.ensurePending(recoveryRequest, recoveryLayout);
        await assert.rejects(recoveryBackend.promotePending(
            recoveryRequest.identity.pendingId, `promotion-recovery-final-${recoveryLayout}`
        ), /consumed persistence failed/);
        assert.strictEqual(recoveryHarness.promoting.size, 1);
        assert.strictEqual(recoveryHarness.pending.size, 1);
        assert.strictEqual(recoveryHarness.consumed.size, 0);
        const createCountBeforeBlockedEnsure = recoveryHarness.operations.filter(item =>
            item.type === 'new-session' || item.type === 'new-window').length;
        await assert.rejects(
            new backendModule.TmuxRuntimeBackend(recoveryHarness.dependencies)
                .ensurePending(recoveryRequest, recoveryLayout),
            /promotion.*progress/i
        );
        assert.strictEqual(recoveryHarness.operations.filter(item =>
            item.type === 'new-session' || item.type === 'new-window').length, createCountBeforeBlockedEnsure);
        const recoveredPromotion = await new backendModule.TmuxRuntimeBackend(recoveryHarness.dependencies)
            .promotePending(recoveryRequest.identity.pendingId, `promotion-recovery-final-${recoveryLayout}`);
        assert.strictEqual(recoveredPromotion.length, 1);
        assert.strictEqual(recoveryHarness.promoting.size, 0);
        assert.strictEqual(recoveryHarness.pending.size, 0);
        assert.strictEqual(recoveryHarness.consumed.size, 1);
        assert.strictEqual(recoveryHarness.operations.filter(item =>
            item.type === 'rename-session' || item.type === 'rename-window').length, 1);
    }

    for (const ambiguousPromotionLayout of ['session', 'project']) {
        const ambiguousPromotionHarness = createTmuxBackendHarness({
            ...(ambiguousPromotionLayout === 'session'
                ? { ambiguousRenameSessionCount: 1 }
                : { ambiguousRenameWindowCount: 1 }),
        });
        const ambiguousPromotionRequest = {
            identity: {
                provider: 'kimi', projectKey: `ambiguous-promotion-${ambiguousPromotionLayout}`, cwd: '/work',
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
            ambiguousPromotionRequest.identity.pendingId,
            `ambiguous-promotion-final-${ambiguousPromotionLayout}`
        ), /timeout/);
        assert.strictEqual(ambiguousPromotionHarness.promoting.size, 1);
        assert.strictEqual(ambiguousPromotionHarness.pending.size, 1);
        const recoveredAmbiguousPromotion = await new backendModule.TmuxRuntimeBackend(
            ambiguousPromotionHarness.dependencies
        ).promotePending(
            ambiguousPromotionRequest.identity.pendingId,
            `ambiguous-promotion-final-${ambiguousPromotionLayout}`
        );
        assert.strictEqual(recoveredAmbiguousPromotion.length, 1);
        assert.strictEqual(ambiguousPromotionHarness.promoting.size, 0);
        assert.strictEqual(ambiguousPromotionHarness.pending.size, 0);
        assert.strictEqual(ambiguousPromotionHarness.consumed.size, 1);
        assert.strictEqual(ambiguousPromotionHarness.operations.filter(item =>
            item.type === 'rename-session' || item.type === 'rename-window').length, 1);
    }

    for (const transitionLayout of ['session', 'project']) {
        for (const transitionFailure of ['mid-final-write', 'before-pending-clear']) {
            const transitionHarness = createTmuxBackendHarness({
                ...(transitionFailure === 'mid-final-write'
                    ? { failFinalMetadataIdentityWriteCount: 1 }
                    : { failPromotionClearPendingCount: 1 }),
            });
            const transitionRequest = {
                identity: {
                    provider: 'codex', projectKey: `transition-${transitionLayout}-${transitionFailure}`, cwd: '/work',
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
                transitionRequest.identity.pendingId, finalSessionId
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
            const recoveredTransition = await new backendModule.TmuxRuntimeBackend(transitionHarness.dependencies)
                .promotePending(transitionRequest.identity.pendingId, finalSessionId);
            assert.strictEqual(recoveredTransition.length, 1);
            assert.strictEqual(transitionHarness.promoting.size, 0);
            assert.strictEqual(transitionHarness.pending.size, 0);
            assert.strictEqual(transitionHarness.consumed.size, 1);
            assert.strictEqual(transitionHarness.operations.filter(item =>
                item.type === 'rename-session' || item.type === 'rename-window').length, 1);
            assert.strictEqual(transitionHarness.operations.filter(item =>
                item.type === 'new-session' || item.type === 'new-window').length, createsBeforePromotion);
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
                provider: 'claude', projectKey: `expired-intent-${expiredIntentLayout}`, cwd: '/work',
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
            expiredIntentRequest.identity.pendingId, expiredIntentFinalId
        ), /consumed persistence failed/);
        assert.ok(Array.from(expiredIntentHarness.promoting.values())[0].pendingBinding);
        movingNowMs = acceptedNowMs + (24 * 60 * 60 * 1000) + 1;
        assert.strictEqual(await expiredIntentHarness.runtimeStore.getPending(
            expiredIntentRequest.identity.pendingId
        ), null);
        const expiredEnsureCreateCount = expiredIntentHarness.operations.filter(item =>
            item.type === 'new-session' || item.type === 'new-window').length;
        await assert.rejects(new backendModule.TmuxRuntimeBackend(expiredIntentHarness.dependencies)
            .ensurePending(expiredIntentRequest, expiredIntentLayout), /promotion.*progress/i);
        assert.strictEqual(expiredIntentHarness.operations.filter(item =>
            item.type === 'new-session' || item.type === 'new-window').length, expiredEnsureCreateCount);
        const expiredIntentRecovered = await new backendModule.TmuxRuntimeBackend(expiredIntentHarness.dependencies)
            .promotePending(expiredIntentRequest.identity.pendingId, expiredIntentFinalId);
        assert.strictEqual(expiredIntentRecovered.length, 1);
        assert.strictEqual(expiredIntentHarness.promoting.size, 0);
        assert.strictEqual(expiredIntentHarness.pending.size, 0);
        assert.strictEqual(expiredIntentHarness.consumed.size, 1);
        assert.strictEqual(expiredIntentHarness.operations.filter(item =>
            item.type === 'rename-session' || item.type === 'rename-window').length, 1);
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
                provider: 'codex', projectKey: `occupied-expired-${occupiedExpiredLayout}`, cwd: '/work',
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
            occupiedExpiredRequest.identity.pendingId, occupiedExpiredFinalId
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
                managed: '1', version: '1', layout: 'project',
                projectKey: occupiedExpiredIntent.projectKey,
            };
            renamedRow.windowMetadata = {
                managed: '1', version: '1', layout: 'project', provider: occupiedExpiredIntent.provider,
                createdAt: occupiedExpiredIntent.createdAt, pendingId: occupiedExpiredIntent.pendingId,
                marker: occupiedExpiredIntent.markerPath,
            };
        } else {
            renamedRow.sessionMetadata = {
                managed: '1', version: '1', layout: 'session', provider: occupiedExpiredIntent.provider,
                projectKey: occupiedExpiredIntent.projectKey,
                createdAt: occupiedExpiredIntent.createdAt, pendingId: occupiedExpiredIntent.pendingId,
                marker: occupiedExpiredIntent.markerPath,
            };
            renamedRow.windowMetadata = { managed: '1', version: '1', layout: 'session' };
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
            occupiedExpiredRequest.identity.pendingId
        ), null);
        const promotionMutations = () => occupiedExpiredHarness.operations.filter(item => [
            'rename-session', 'rename-window', 'session-options', 'window-options', 'clear-pending',
            'store-promoting', 'store-consumed', 'store-pending', 'remove-promoting', 'remove-pending',
        ].includes(item.type)).length;
        const mutationsBeforeOccupiedRetry = promotionMutations();
        const occupiedExpiredResult = await new backendModule.TmuxRuntimeBackend(
            occupiedExpiredHarness.dependencies
        ).promotePending(occupiedExpiredRequest.identity.pendingId, occupiedExpiredFinalId);
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
            provider: 'codex', projectKey: `delayed-${delayedLayout}`, cwd: '/work',
            pendingId: `delayed-pending-${delayedLayout}`,
        };
        const delayedLockKey = `pending:${delayedIdentity.pendingId}`;
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
            delayedIdentity.pendingId, `delayed-final-${delayedLayout}`
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
    await failedPromotionBackend.ensurePending({
        identity: {
            provider: 'kimi', projectKey: 'failed-promotion', cwd: '/work', pendingId: 'failed-pending',
        },
        projectName: 'App', terminalName: 'Kimi: Failed Promotion',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
        launch: { executable: 'kimi', args: ['new'] },
    }, 'session');
    await assert.rejects(failedPromotionBackend.promotePending('failed-pending', 'failed-final'),
        /rename session failed/);
    assert.strictEqual(failedPromotionHarness.consumed.size, 0);
    assert.strictEqual(failedPromotionHarness.pending.has('failed-pending'), true);
    assert.strictEqual(failedPromotionHarness.promoting.size, 0);

    const unknownPromotionHarness = createTmuxBackendHarness();
    const unknownPromotionBackend = new backendModule.TmuxRuntimeBackend(unknownPromotionHarness.dependencies);
    await unknownPromotionBackend.ensurePending({
        identity: {
            provider: 'codex', projectKey: 'unknown-promotion', cwd: '/work', pendingId: 'unknown-pending',
        },
        projectName: 'App', terminalName: 'Codex: Unknown Promotion',
        createdAt: '2026-07-18T09:59:00Z', excludedSessionIds: [],
        launch: { executable: 'codex', args: ['new'] },
    }, 'session');
    const unknownFinalIdentity = {
        provider: 'codex', projectKey: 'unknown-promotion', cwd: '/work', sessionId: 'unknown-final',
    };
    const unknownFinalLocator = new tmuxLayout.SessionTmuxLayout().getLocator(unknownFinalIdentity);
    unknownPromotionHarness.windows.push({
        ...unknownFinalLocator, windowName: 'shell', windowId: '@unknown-promotion', active: false,
        sessionMetadata: {}, windowMetadata: {}, metadata: {},
    });
    const unknownPromotionResult = await unknownPromotionBackend.promotePending(
        'unknown-pending', 'unknown-final'
    );
    assert.strictEqual(unknownPromotionResult.length, 1);
    assert.strictEqual(unknownPromotionResult[0].state, 'conflict');
    assert.strictEqual(unknownPromotionHarness.operations.some(item => item.type === 'rename-session'), false);
    assert.strictEqual(unknownPromotionHarness.pending.has('unknown-pending'), true);

    const collisionHarness = createTmuxBackendHarness();
    const collisionBackend = new backendModule.TmuxRuntimeBackend(collisionHarness.dependencies);
    await collisionBackend.ensureResume({
        identity: { provider: 'codex', projectKey: 'collision', cwd: '/work', sessionId: 'final' },
        projectName: 'App', terminalName: 'AI Sessions: Collision',
        launch: { executable: 'codex', args: ['resume', 'final'], markerPath: '/tmp/final' },
    }, 'project');
    await collisionBackend.ensurePending({
        identity: { provider: 'codex', projectKey: 'collision', cwd: '/work', pendingId: 'pending' },
        projectName: 'App', terminalName: 'AI Sessions: Collision',
        createdAt: '2026-07-18T09:58:00Z', excludedSessionIds: [],
        launch: { executable: 'codex', args: ['new'], markerPath: '/tmp/pending-collision' },
    }, 'project');
    const collisionResult = await collisionBackend.promotePending('pending', 'final');
    assert.strictEqual(collisionResult.length, 2);
    assert.ok(collisionResult.every(runtime => runtime.state === 'conflict'));
    assert.strictEqual(collisionHarness.operations.filter(item => item.type === 'rename-window').length, 0);
    assert.strictEqual(collisionHarness.pending.has('pending'), true);

    const attachFailureHarness = createTmuxBackendHarness({ failAttachCount: 1 });
    const attachFailureBackend = new backendModule.TmuxRuntimeBackend(attachFailureHarness.dependencies);
    const attachFailureRequest = {
        identity: { provider: 'kimi', projectKey: 'pk', cwd: '/work', sessionId: 's1' },
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
        identity: { provider: 'codex', projectKey: 'ambiguous', cwd: '/work', sessionId: 's1' },
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
        managed: '1', version: '1', layout: 'session', projectKey: 'ambiguous',
        provider: 'codex', sessionId: 's1', createdAt: '2026-07-18T10:00:00.000Z', marker: '/tmp/a1',
    };
    recoveredAmbiguousRow.windowMetadata = {
        managed: '1', version: '1', layout: 'session',
    };
    recoveredAmbiguousRow.metadata = {
        ...recoveredAmbiguousRow.sessionMetadata, ...recoveredAmbiguousRow.windowMetadata,
    };
    const recoveredAmbiguous = await new backendModule.TmuxRuntimeBackend(ambiguousHarness.dependencies)
        .ensureResume(ambiguousRequest, 'session');
    assert.strictEqual(recoveredAmbiguous.identity.sessionId, 's1');
    assert.strictEqual(ambiguousHarness.ambiguous.size, 0);
    assert.strictEqual(ambiguousHarness.operations.filter(item => item.type === 'new-session').length, 1);

    const ambiguousPendingHarness = createTmuxBackendHarness({ ambiguousCreateCount: 1 });
    const ambiguousPendingRequest = {
        identity: {
            provider: 'claude', projectKey: 'ambiguous-pending', cwd: '/work', pendingId: 'pending-ambiguous',
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
        identity: { provider: 'codex', projectKey: 'nonzero-session', cwd: '/work', sessionId: 's1' },
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
        identity: { provider: 'claude', projectKey: 'nonzero-project', cwd: '/work', sessionId: 's1' },
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
    const occupiedIdentity = { provider: 'codex', projectKey: 'occupied', cwd: '/work', sessionId: 's1' };
    const occupiedLocator = new tmuxLayout.SessionTmuxLayout().getLocator(occupiedIdentity);
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
        identity: { provider: 'codex', projectKey: 'occupied-project', cwd: '/work', sessionId: 'existing' },
        projectName: 'App', terminalName: 'AI Sessions: Occupied',
        launch: { executable: 'codex', args: ['resume', 'existing'] },
    }, 'project');
    const unknownProjectIdentity = {
        provider: 'claude', projectKey: 'occupied-project', cwd: '/work', sessionId: 'unknown',
    };
    const unknownProjectLocator = new tmuxLayout.ProjectTmuxLayout().getLocator(unknownProjectIdentity);
    occupiedProjectHarness.windows.push({
        ...unknownProjectLocator, windowId: '@occupied-project', active: false,
        sessionMetadata: {
            managed: '1', version: '1', layout: 'project', projectKey: 'occupied-project',
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
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'Codex: s1',
        launch: { executable: 'codex', args: ['resume', 's1'] },
    }, 'session'), /tmux unavailable/);
    assert.strictEqual(unavailablePosixHarness.operations.some(item => item.type === 'lock'), false);

    const unavailableHarness = createTmuxBackendHarness({ platform: 'win32' });
    const unavailableBackend = new backendModule.TmuxRuntimeBackend(unavailableHarness.dependencies);
    await assert.rejects(unavailableBackend.ensureResume({
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', sessionId: 's1' },
        projectName: 'App', terminalName: 'Codex: s1',
        launch: { executable: 'codex', args: ['resume', 's1'] },
    }, 'session'), /POSIX/);
    assert.strictEqual(unavailableHarness.operations.filter(item => item.type === 'new-session').length, 0);

    const restoreHarness = createTmuxBackendHarness();
    const restoreBackend = new backendModule.TmuxRuntimeBackend(restoreHarness.dependencies);
    const restorable = await restoreBackend.ensureResume({
        identity: { provider: 'codex', projectKey: 'restore', cwd: '/work', sessionId: 's1' },
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
        name: 'AI Sessions: Restore',
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

async function main() {
    runRuntimeConfigurationChecks();
    runLaunchSpecChecks();
    runTmuxLayoutChecks();
    await runTmuxClientChecks();
    await runTmuxDiscoveryChecks();
    await runTmuxStoreChecks();
    await runTmuxBackendChecks();
    console.log('AI session tmux checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
