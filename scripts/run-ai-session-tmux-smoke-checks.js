'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { TmuxClient } = require('../out/aiSessions/tmuxClient');
const { TmuxRuntimeBackend } = require('../out/aiSessions/tmuxRuntimeBackend');
const {
    TmuxRuntimeDiscovery,
    isCurrentRuntimeMarker,
} = require('../out/aiSessions/tmuxRuntimeDiscovery');
const { TmuxRuntimeBindingStore } = require('../out/aiSessions/tmuxRuntimeBindingStore');
const { TmuxAttachBindingStore } = require('../out/aiSessions/tmuxAttachBindingStore');
const { withTmuxCreationLock } = require('../out/aiSessions/tmuxCreationLock');

const COMMAND_TIMEOUT_MS = 5_000;
const WAIT_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 25;
const FINAL_RECORD_LOCK_KEY = 'runtime-binding-final-records';
const configuredTmuxPath = process.env.PROJECT_STEWARD_TMUX_PATH || 'tmux';
const serverName = `project-steward-test-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
const isolatedPrefix = ['-L', serverName, '-f', '/dev/null'];
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function asText(value) {
    return typeof value === 'string' ? value : value ? value.toString('utf8') : '';
}

function classifyFailure(error) {
    if (error && error.code === 'ENOENT') return 'not-found';
    if (error && (error.code === 'EACCES' || error.code === 'EPERM')) return 'permission-denied';
    if (error && (error.code === 'ETIMEDOUT' || error.killed === true)) return 'timeout';
    if (error && error.code === 'E2BIG') return 'argument-list-too-long';
    return 'unsupported';
}

class IsolatedSyncTmuxRunner {
    constructor() {
        this.calls = [];
    }

    run(file, args) {
        const isolatedArgs = [...isolatedPrefix, ...args];
        this.calls.push({ file, args: isolatedArgs.slice() });
        try {
            const stdout = execFileSync(file, isolatedArgs, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: COMMAND_TIMEOUT_MS,
                maxBuffer: 4 * 1024 * 1024,
            });
            return Promise.resolve({ exitCode: 0, stdout: asText(stdout), stderr: '' });
        } catch (error) {
            if (error && typeof error.status === 'number') {
                return Promise.resolve({
                    exitCode: error.status,
                    stdout: asText(error.stdout),
                    stderr: asText(error.stderr),
                });
            }
            return Promise.resolve({
                exitCode: null,
                stdout: asText(error && error.stdout),
                stderr: asText(error && error.stderr),
                failureCategory: classifyFailure(error),
            });
        }
    }
}

function createAttachStore() {
    const values = new Map();
    return new TmuxAttachBindingStore({
        get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
        update: (key, value) => {
            if (value === undefined) values.delete(key);
            else values.set(key, value);
            return Promise.resolve();
        },
    });
}

function fakeTerminalFactory(terminals) {
    let nextProcessId = 50_000 + terminals.length;
    return options => {
        const terminal = {
            name: options.name,
            creationOptions: options,
            processId: Promise.resolve(nextProcessId++),
            shown: false,
            disposed: false,
            show() { this.shown = true; },
            dispose() { this.disposed = true; },
        };
        terminals.push(terminal);
        return terminal;
    };
}

function buildRuntimeContext(client, root, terminals) {
    const recordsRoot = path.join(root, 'runtime-records');
    const locksRoot = path.join(root, 'runtime-locks');
    const finalRecordLock = operation => withTmuxCreationLock(
        locksRoot, FINAL_RECORD_LOCK_KEY, operation
    );
    const store = new TmuxRuntimeBindingStore(recordsRoot, () => Date.now(), finalRecordLock);
    const discovery = new TmuxRuntimeDiscovery({
        client,
        bindingStore: store,
        markerIsCurrent: isCurrentRuntimeMarker,
        nowMs: () => Date.now(),
        cacheTtlMs: 0,
    });
    const backend = new TmuxRuntimeBackend({
        platform: process.platform,
        client,
        discovery,
        runtimeStore: store,
        attachStore: createAttachStore(),
        withCreationLock: (key, operation) => withTmuxCreationLock(locksRoot, key, operation),
        createTerminal: fakeTerminalFactory(terminals),
        nowMs: () => Date.now(),
    });
    return { backend, discovery, store };
}

function providerFixture(root, name, payload) {
    const stopPath = path.join(root, `${name}.stop`);
    const pidPath = path.join(root, `${name}.pid`);
    const payloadPath = path.join(root, `${name}.payload`);
    const markerPath = path.join(root, `${name}.done`);
    const program = [
        "const fs = require('fs')",
        'const [pidPath, stopPath, payloadPath, payload] = process.argv.slice(1)',
        "fs.writeFileSync(pidPath, String(process.pid), 'utf8')",
        "fs.writeFileSync(payloadPath, payload, 'utf8')",
        'const timer = setInterval(() => {',
        '  if (fs.existsSync(stopPath)) { clearInterval(timer); process.exit(0); }',
        '}, 20)',
    ].join('; ');
    return {
        stopPath,
        pidPath,
        payloadPath,
        markerPath,
        payload,
        launch: {
            executable: process.execPath,
            args: ['-e', program, pidPath, stopPath, payloadPath, payload],
            markerPath,
        },
    };
}

function resumeRequest(provider, projectKey, cwd, sessionId, fixture, terminalName) {
    return {
        identity: { provider, projectKey, cwd, sessionId },
        projectName: 'Smoke Project',
        terminalName,
        launch: { ...fixture.launch, cwd },
    };
}

async function waitFor(predicate, label) {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let lastError;
    while (Date.now() < deadline) {
        try {
            if (await predicate()) return;
        } catch (error) {
            lastError = error;
        }
        Atomics.wait(waitBuffer, 0, 0, POLL_INTERVAL_MS);
    }
    const suffix = lastError ? ` (${lastError.message})` : '';
    throw new Error(`Timed out waiting for ${label}${suffix}.`);
}

function assertProviderAlive(fixture) {
    const pid = Number(fs.readFileSync(fixture.pidPath, 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    process.kill(pid, 0);
}

function locatorMatches(row, locator) {
    return row.sessionName === locator.sessionName
        && (locator.layout === 'session' || row.windowName === locator.windowName);
}

async function assertPaneAlive(runner, locator) {
    const target = locator.windowName
        ? `${locator.sessionName}:${locator.windowName}`
        : locator.sessionName;
    const result = await runner.run(configuredTmuxPath, [
        'list-panes', '-t', target, '-F', '#{pane_dead}',
    ]);
    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.deepStrictEqual(result.stdout.trim().split(/\r?\n/), ['0']);
}

async function runSmoke(root, runner, client) {
    const cwd = path.join(root, "work dir 'quoted' $dollar ; semi");
    fs.mkdirSync(cwd, { recursive: true });
    const payload = "payload with spaces 'quotes' ; $HOME $(not-run) &\nsecond line";
    const fixtures = {
        projectOne: providerFixture(root, 'project-one', payload),
        projectTwo: providerFixture(root, 'project-two', `${payload}:two`),
        sessionOne: providerFixture(root, 'session-one', `${payload}:three`),
        sessionTwo: providerFixture(root, 'session-two', `${payload}:four`),
        pending: providerFixture(root, 'pending', `${payload}:pending`),
    };
    const projectKey = "project:key with spaces ' ; $";
    const terminals = [];
    const contextA = buildRuntimeContext(client, root, terminals);
    const contextB = buildRuntimeContext(client, root, terminals);

    const projectOneRequest = resumeRequest(
        'codex', projectKey, cwd, "session one:';$", fixtures.projectOne,
        'Project Steward: Smoke Project [tmux]'
    );
    const projectTwoRequest = resumeRequest(
        'claude', projectKey, cwd, 'session-two.special:$', fixtures.projectTwo,
        'Project Steward: Smoke Project [tmux]'
    );
    const [projectOne] = await Promise.all([
        contextA.backend.ensureResume(projectOneRequest, 'project'),
        contextB.backend.ensureResume(projectOneRequest, 'project'),
    ]);
    const projectTwo = await contextA.backend.ensureResume(projectTwoRequest, 'project');

    await waitFor(() => Object.values(fixtures).slice(0, 2)
        .every(fixture => fs.existsSync(fixture.pidPath)), 'project providers to start');
    assertProviderAlive(fixtures.projectOne);
    assertProviderAlive(fixtures.projectTwo);
    assert.strictEqual(fs.readFileSync(fixtures.projectOne.payloadPath, 'utf8'), payload);

    let rows = await client.listWindows();
    const projectRows = rows.filter(row => row.sessionName === projectOne.tmux.sessionName
        && row.windowMetadata.provider);
    assert.strictEqual(new Set(projectRows.map(row => row.sessionName)).size, 1);
    assert.strictEqual(projectRows.length, 2,
        'project layout must contain two managed windows in one project session');

    await contextA.backend.detach(projectOne);
    assert.ok(terminals.some(terminal => terminal.disposed),
        'the fake VS Code attach terminal must be disposed during detach');
    await assertPaneAlive(runner, projectOne.tmux);
    await contextA.discovery.refresh(true);
    assert.ok(contextA.backend.getActive()
        .filter(runtime => runtime.tmux && runtime.tmux.layout === 'project')
        .every(runtime => runtime.attached === false));

    const freshProjectContext = buildRuntimeContext(client, root, terminals);
    await freshProjectContext.discovery.refresh(true);
    assert.deepStrictEqual(
        freshProjectContext.discovery.getActive()
            .filter(runtime => runtime.identity.projectKey === projectKey)
            .map(runtime => runtime.identity.sessionId).sort(),
        [projectOneRequest.identity.sessionId, projectTwoRequest.identity.sessionId].sort(),
        'a new production discovery instance must recover metadata-backed runtimes'
    );

    const sessionOneRequest = resumeRequest(
        'kimi', 'session-layout-project', cwd, 'kimi:isolated.one', fixtures.sessionOne,
        'Kimi: isolated one [tmux]'
    );
    const sessionTwoRequest = resumeRequest(
        'codex', 'session-layout-project', cwd, 'codex:isolated.two', fixtures.sessionTwo,
        'Codex: isolated two [tmux]'
    );
    const sessionOne = await contextA.backend.ensureResume(sessionOneRequest, 'session');
    const sessionTwo = await contextA.backend.ensureResume(sessionTwoRequest, 'session');
    await waitFor(() => fs.existsSync(fixtures.sessionOne.pidPath)
        && fs.existsSync(fixtures.sessionTwo.pidPath), 'session-layout providers to start');
    rows = await client.listWindows();
    const sessionRows = rows.filter(row => row.sessionMetadata.layout === 'session'
        && row.sessionMetadata.provider);
    assert.strictEqual(new Set(sessionRows.map(row => row.sessionName)).size, 2,
        'session layout must create one independent tmux session per AI session');
    assert.ok(sessionRows.every(row => Object.keys(row.windowMetadata).sort().join(',')
        === 'layout,managed,version'), 'session-layout window metadata must remain base-only');
    await contextA.backend.detach(sessionOne);
    await assertPaneAlive(runner, sessionOne.tmux);

    const pendingId = "pending:create ' ;$";
    const pendingCreatedAt = new Date().toISOString();
    const pending = await contextA.backend.ensurePending({
        identity: { provider: 'claude', projectKey, cwd, pendingId },
        projectName: 'Smoke Project',
        terminalName: 'Project Steward: Smoke Project [tmux]',
        createdAt: pendingCreatedAt,
        excludedSessionIds: ['existing:one', 'existing:two'],
        title: "Title with 'quotes' ; $HOME",
        launch: { ...fixtures.pending.launch, cwd },
    }, 'project');
    await waitFor(() => fs.existsSync(fixtures.pending.pidPath), 'pending provider to start');
    const pendingLocator = { ...pending.tmux };
    const finalSessionId = "promoted:session ' ;$";
    const promoted = await contextA.backend.promotePending(pendingId, finalSessionId);
    assert.strictEqual(promoted.length, 1);
    assert.strictEqual(promoted[0].identity.sessionId, finalSessionId);
    rows = await client.listWindows();
    assert.strictEqual(rows.some(row => locatorMatches(row, pendingLocator)), false,
        'pending tmux target must be renamed away');
    const promotedRow = rows.find(row => locatorMatches(row, promoted[0].tmux));
    assert.ok(promotedRow, 'promoted tmux target must be discoverable');
    assert.strictEqual(promotedRow.windowMetadata.sessionId, finalSessionId);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(
        promotedRow.windowMetadata, 'pendingId'
    ), false, 'promotion must clear pending metadata');

    fs.writeFileSync(fixtures.projectOne.stopPath, 'stop', 'utf8');
    await waitFor(async () => {
        const currentRows = await client.listWindows();
        return !currentRows.some(row => locatorMatches(row, projectOne.tmux));
    }, 'the exited provider window to disappear');
    assert.ok(fs.existsSync(fixtures.projectOne.markerPath));
    rows = await client.listWindows();
    assert.ok(rows.some(row => locatorMatches(row, projectTwo.tmux)),
        'provider exit must not remove the sibling project window');
    assert.ok(rows.some(row => locatorMatches(row, promoted[0].tmux)),
        'provider exit must not remove the promoted sibling window');
    assert.ok(rows.some(row => locatorMatches(row, sessionTwo.tmux)),
        'provider exit must not remove independent session-layout runtimes');
    assertProviderAlive(fixtures.projectTwo);

    for (const fixture of Object.values(fixtures)) {
        if (!fs.existsSync(fixture.stopPath)) {
            fs.writeFileSync(fixture.stopPath, 'stop', 'utf8');
        }
    }
    assert.ok(runner.calls.length > 0);
    assert.ok(runner.calls.every(call => call.file === configuredTmuxPath
        && call.args[0] === '-L' && call.args[1] === serverName
        && call.args[2] === '-f' && call.args[3] === '/dev/null'));
}

function killIsolatedServer() {
    try {
        execFileSync(configuredTmuxPath, [...isolatedPrefix, 'kill-server'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: COMMAND_TIMEOUT_MS,
        });
    } catch (error) {
        if (!(error && typeof error.status === 'number')) throw error;
    }
}

function captureIsolatedSocketPath() {
    try {
        const socketPath = execFileSync(configuredTmuxPath, [
            ...isolatedPrefix, 'display-message', '-p', '#{socket_path}',
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: COMMAND_TIMEOUT_MS,
        }).trim();
        if (!path.isAbsolute(socketPath) || path.basename(socketPath) !== serverName) {
            throw new Error('tmux returned an unexpected isolated socket path.');
        }
        return socketPath;
    } catch (error) {
        if (error && typeof error.status === 'number' && error.status !== 0) return null;
        throw error;
    }
}

function assertIsolatedServerStopped() {
    try {
        execFileSync(configuredTmuxPath, [...isolatedPrefix, 'list-sessions'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: COMMAND_TIMEOUT_MS,
        });
    } catch (error) {
        if (error && typeof error.status === 'number' && error.status !== 0) return;
        throw error;
    }
    throw new Error(`The isolated tmux server ${serverName} remained alive after cleanup.`);
}

function removeOwnStaleSocket(socketPath) {
    if (!socketPath || !fs.existsSync(socketPath)) return;
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket() || path.basename(socketPath) !== serverName) {
        throw new Error('Refusing to remove a non-socket or foreign tmux path.');
    }
    fs.unlinkSync(socketPath);
    assert.strictEqual(fs.existsSync(socketPath), false,
        'the isolated tmux socket must be removed after its server stops');
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-tmux-smoke-'));
    const runner = new IsolatedSyncTmuxRunner();
    const client = new TmuxClient(configuredTmuxPath, runner);
    let isolatedSocketPath = null;
    try {
        const availability = await client.checkAvailability();
        assert.ok(availability.available, availability.message);
        await runSmoke(root, runner, client);
    } finally {
        try {
            isolatedSocketPath = captureIsolatedSocketPath();
            killIsolatedServer();
            assertIsolatedServerStopped();
            removeOwnStaleSocket(isolatedSocketPath);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
    console.log('AI session tmux smoke checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
