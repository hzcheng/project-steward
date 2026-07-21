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
const PROVIDER_EXIT_TIMEOUT_MS = 2_000;
const FINAL_RECORD_LOCK_KEY = 'runtime-binding-final-records';
const configuredTmuxPath = process.env.PROJECT_STEWARD_TMUX_PATH || 'tmux';
const serverName = `project-steward-test-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
const isolatedPrefix = ['-L', serverName, '-f', '/dev/null'];
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
let tmuxTempRoot = null;

class CleanupAggregateError extends Error {
    constructor(errors, message) {
        super(message);
        this.name = 'CleanupAggregateError';
        this.errors = errors.slice();
    }
}

function isolatedEnvironment() {
    if (!tmuxTempRoot) throw new Error('The isolated tmux temporary root is not initialized.');
    return { ...process.env, TMUX_TMPDIR: tmuxTempRoot };
}

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
                env: isolatedEnvironment(),
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

function providerFixture(root, name, payload, fixtureRegistry) {
    const stopPath = path.join(root, `${name}.stop`);
    const pidPath = path.join(root, `${name}.pid`);
    const invocationLogPath = path.join(root, 'provider-invocations.jsonl');
    const invocationId = `${name}-${crypto.randomBytes(8).toString('hex')}`;
    const markerPath = path.join(root, `${name}.done`);
    const program = [
        "const fs = require('fs')",
        'const [pidPath, stopPath, invocationLogPath, invocationId, payload] = process.argv.slice(1)',
        "fs.appendFileSync(invocationLogPath, JSON.stringify({ invocationId, pid: process.pid, cwd: process.cwd(), payload }) + '\\n', 'utf8')",
        "fs.writeFileSync(pidPath, String(process.pid), 'utf8')",
        'const timer = setInterval(() => {',
        '  if (fs.existsSync(stopPath)) { clearInterval(timer); process.exit(0); }',
        '}, 20)',
    ].join('; ');
    const fixture = {
        stopPath,
        pidPath,
        invocationLogPath,
        invocationId,
        markerPath,
        payload,
        launch: {
            executable: process.execPath,
            args: ['-e', program, pidPath, stopPath, invocationLogPath, invocationId, payload],
            markerPath,
        },
    };
    fixtureRegistry.push(fixture);
    return fixture;
}

function readProviderInvocations(invocationLogPath) {
    if (!fs.existsSync(invocationLogPath)) return [];
    return fs.readFileSync(invocationLogPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

function resumeRequest(provider, workspaceScopeIdentity, cwd, sessionId, fixture, terminalName) {
    return {
        identity: {
            provider,
            workspaceScopeIdentity,
            workspaceNavigationIdentity: workspaceScopeIdentity,
            workspaceRootHostPaths: [cwd],
            cwd,
            sessionId,
        },
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

async function runSmoke(root, runner, client, fixtureRegistry) {
    const cwd = path.join(root, "work dir 'quoted' $dollar ; semi");
    fs.mkdirSync(cwd, { recursive: true });
    const payload = "payload with spaces 'quotes' ; $HOME $(not-run) &\nsecond line";
    const fixtures = {
        projectOne: providerFixture(root, 'project-one', payload, fixtureRegistry),
        projectTwo: providerFixture(root, 'project-two', `${payload}:two`, fixtureRegistry),
        sessionOne: providerFixture(root, 'session-one', `${payload}:three`, fixtureRegistry),
        sessionTwo: providerFixture(root, 'session-two', `${payload}:four`, fixtureRegistry),
        pending: providerFixture(root, 'pending', `${payload}:pending`, fixtureRegistry),
    };
    const workspaceScopeIdentity = "workspace:scope with spaces ' ; $";
    const terminals = [];
    const contextA = buildRuntimeContext(client, root, terminals);
    const contextB = buildRuntimeContext(client, root, terminals);

    const projectOneRequest = resumeRequest(
        'codex', workspaceScopeIdentity, cwd, 'session.one-special', fixtures.projectOne,
        'Project Steward: Smoke Project [tmux]'
    );
    const projectTwoRequest = resumeRequest(
        'claude', workspaceScopeIdentity, cwd, 'session-two.special', fixtures.projectTwo,
        'Project Steward: Smoke Project [tmux]'
    );
    const [projectOne, concurrentProjectOne] = await Promise.all([
        contextA.backend.ensureResume(projectOneRequest, 'project'),
        contextB.backend.ensureResume(projectOneRequest, 'project'),
    ]);
    assert.deepStrictEqual(projectOne.tmux, concurrentProjectOne.tmux);
    const projectTwo = await contextA.backend.ensureResume(projectTwoRequest, 'project');

    await waitFor(() => Object.values(fixtures).slice(0, 2)
        .every(fixture => fs.existsSync(fixture.pidPath)), 'project providers to start');
    assertProviderAlive(fixtures.projectOne);
    assertProviderAlive(fixtures.projectTwo);
    const projectInvocationRecords = readProviderInvocations(fixtures.projectOne.invocationLogPath)
        .filter(record => record.invocationId === fixtures.projectOne.invocationId);
    assert.strictEqual(projectInvocationRecords.length, 1,
        'concurrent ensure calls for one identity must dispatch one provider invocation');
    assert.deepStrictEqual(projectInvocationRecords[0], {
        invocationId: fixtures.projectOne.invocationId,
        pid: Number(fs.readFileSync(fixtures.projectOne.pidPath, 'utf8')),
        cwd,
        payload,
    });

    let rows = await client.listWindows();
    const projectManagedSessions = new Set(rows.filter(row =>
        row.sessionMetadata.managed === '1'
        && row.sessionMetadata.layout === 'project'
        && row.sessionMetadata.workspaceScopeIdentity === workspaceScopeIdentity
    ).map(row => row.sessionName));
    assert.strictEqual(projectManagedSessions.size, 1,
        'project layout must have exactly one managed project session');
    const projectRows = rows.filter(row => row.sessionName === projectOne.tmux.sessionName
        && row.windowMetadata.managed === '1'
        && row.windowMetadata.layout === 'project'
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
            .filter(runtime => runtime.identity.workspaceScopeIdentity === workspaceScopeIdentity)
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
        && row.sessionMetadata.managed === '1'
        && row.sessionMetadata.provider
        && row.windowMetadata.managed === '1'
        && row.windowMetadata.layout === 'session');
    assert.strictEqual(sessionRows.length, 2,
        'session layout must contain exactly two managed session rows');
    assert.strictEqual(new Set(sessionRows.map(row => row.sessionName)).size, 2,
        'session layout must create one independent tmux session per AI session');
    assert.ok(sessionRows.every(row => Object.keys(row.windowMetadata).sort().join(',')
        === 'layout,managed,version'), 'session-layout window metadata must remain base-only');
    await contextA.backend.detach(sessionOne);
    await assertPaneAlive(runner, sessionOne.tmux);

    const pendingId = 'pending:create.special';
    const pendingCreatedAt = new Date().toISOString();
    const pending = await contextA.backend.ensurePending({
        identity: {
            provider: 'claude',
            workspaceScopeIdentity,
            workspaceNavigationIdentity: workspaceScopeIdentity,
            workspaceRootHostPaths: [cwd],
            cwd,
            pendingId,
        },
        projectName: 'Smoke Project',
        terminalName: 'Project Steward: Smoke Project [tmux]',
        createdAt: pendingCreatedAt,
        excludedSessionIds: ['existing:one', 'existing:two'],
        title: "Title with 'quotes' ; $HOME",
        launch: { ...fixtures.pending.launch, cwd },
    }, 'project');
    await waitFor(() => fs.existsSync(fixtures.pending.pidPath), 'pending provider to start');
    const invocationRecords = readProviderInvocations(fixtures.projectOne.invocationLogPath);
    assert.strictEqual(invocationRecords.length, Object.keys(fixtures).length,
        'every fixture must append exactly one provider invocation record');
    assert.strictEqual(new Set(invocationRecords.map(record => record.invocationId)).size,
        Object.keys(fixtures).length, 'provider invocation IDs must be unique');
    for (const fixture of Object.values(fixtures)) {
        const records = invocationRecords.filter(record => record.invocationId === fixture.invocationId);
        assert.strictEqual(records.length, 1);
        assert.ok(Number.isSafeInteger(records[0].pid) && records[0].pid > 0);
        assert.strictEqual(records[0].cwd, cwd);
        assert.strictEqual(records[0].payload, fixture.payload);
    }
    const pendingLocator = { ...pending.tmux };
    const finalSessionId = 'promoted:session.special';
    const promoted = await contextA.backend.promotePending(pending.identity, finalSessionId);
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

function killIsolatedServer(run = execFileSync, environment = isolatedEnvironment()) {
    try {
        run(configuredTmuxPath, [...isolatedPrefix, 'kill-server'], {
            env: environment,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: COMMAND_TIMEOUT_MS,
        });
    } catch (error) {
        if (isExplicitNoServerError(error)) return;
        throw redactedCleanupCommandError('kill-server');
    }
}

function isExplicitNoServerError(error) {
    if (!(error && typeof error.status === 'number' && error.status !== 0)) return false;
    const stderr = asText(error.stderr).trim().toLowerCase();
    return stderr === 'server exited unexpectedly'
        || stderr.includes('no server running on')
        || (stderr.includes('error connecting to ')
            && stderr.includes('no such file or directory'));
}

function redactedCleanupCommandError(operation) {
    const error = new Error(`The isolated tmux ${operation} cleanup command failed.`);
    error.code = 'TMUX_SMOKE_CLEANUP_FAILED';
    return error;
}

function captureIsolatedSocketPath() {
    try {
        const socketPath = execFileSync(configuredTmuxPath, [
            ...isolatedPrefix, 'display-message', '-p', '#{socket_path}',
        ], {
            env: isolatedEnvironment(),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: COMMAND_TIMEOUT_MS,
        }).trim();
        return validateOwnedSocketPath(socketPath);
    } catch (error) {
        if (error && typeof error.status === 'number' && error.status !== 0) return null;
        throw error;
    }
}

function assertIsolatedServerStopped(run = execFileSync, environment = isolatedEnvironment()) {
    try {
        run(configuredTmuxPath, [...isolatedPrefix, 'list-sessions'], {
            env: environment,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: COMMAND_TIMEOUT_MS,
        });
    } catch (error) {
        if (isExplicitNoServerError(error)) return;
        throw redactedCleanupCommandError('list-sessions');
    }
    throw new Error(`The isolated tmux server ${serverName} remained alive after cleanup.`);
}

function removeOwnStaleSocket(socketPath) {
    if (!socketPath || !fs.existsSync(socketPath)) return;
    const ownedSocketPath = validateOwnedSocketPath(socketPath);
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) {
        throw new Error('Refusing to remove a non-socket or foreign tmux path.');
    }
    fs.unlinkSync(ownedSocketPath);
    assert.strictEqual(fs.existsSync(ownedSocketPath), false,
        'the isolated tmux socket must be removed after its server stops');
}

function validateOwnedSocketPath(socketPath) {
    if (!tmuxTempRoot || !path.isAbsolute(socketPath) || path.basename(socketPath) !== serverName) {
        throw new Error('tmux returned an unexpected isolated socket path.');
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!Number.isSafeInteger(uid) || uid < 0) {
        throw new Error('Cannot validate the isolated tmux socket owner on this platform.');
    }
    const ownedRoot = fs.realpathSync(tmuxTempRoot);
    const ownedSocketPath = fs.realpathSync(socketPath);
    const expectedParent = path.join(ownedRoot, `tmux-${uid}`);
    if (path.dirname(ownedSocketPath) !== expectedParent
        || path.basename(ownedSocketPath) !== serverName) {
        throw new Error('Refusing to use a tmux socket outside the owned temporary root.');
    }
    return ownedSocketPath;
}

function collectTrackedProviderPids(fixtures, dependencies = {}) {
    const evidence = inspectTrackedProviderPidEvidence(fixtures, dependencies);
    if (evidence.errors.length) {
        throw new CleanupAggregateError(evidence.errors,
            'One or more provider process records could not be verified.');
    }
    return evidence.pids;
}

function inspectTrackedProviderPidEvidence(fixtures, dependencies = {}) {
    const readInvocations = dependencies.readInvocations || readProviderInvocations;
    const readFallbackPid = dependencies.readFallbackPid || (pidPath => {
        if (!fs.existsSync(pidPath)) return null;
        return Number(fs.readFileSync(pidPath, 'utf8'));
    });
    const invocationLogs = new Map();
    const pids = new Set();
    const errors = [];
    for (const fixture of fixtures) {
        let fixtureHasEvidence = false;
        if (fixture.invocationId && fixture.invocationLogPath) {
            let records = invocationLogs.get(fixture.invocationLogPath);
            if (!records) {
                try {
                    records = { values: readInvocations(fixture.invocationLogPath) };
                } catch (error) {
                    records = { values: [] };
                }
                invocationLogs.set(fixture.invocationLogPath, records);
            }
            const ledgerPids = records.values.filter(record =>
                record.invocationId === fixture.invocationId
                && Number.isSafeInteger(record.pid) && record.pid > 0
            ).map(record => record.pid);
            if (ledgerPids.length) {
                ledgerPids.forEach(pid => pids.add(pid));
                fixtureHasEvidence = true;
            }
        }
        if (!fixtureHasEvidence) {
            try {
                const fallbackPid = readFallbackPid(fixture.pidPath);
                if (Number.isSafeInteger(fallbackPid) && fallbackPid > 0) {
                    pids.add(fallbackPid);
                    fixtureHasEvidence = true;
                }
            } catch (error) {
                // A fixed error below retains the fixture root without exposing its path.
            }
        }
        if (!fixtureHasEvidence) {
            errors.push(new Error('Provider process evidence was missing or invalid.'));
        }
    }
    return { pids: [...pids], errors };
}

function waitForTrackedProviderExit(pids, dependencies = {}) {
    const probe = dependencies.probe || (pid => process.kill(pid, 0));
    const wait = dependencies.wait || (delayMs => Atomics.wait(waitBuffer, 0, 0, delayMs));
    const now = dependencies.now || (() => Date.now());
    const timeoutMs = dependencies.timeoutMs ?? PROVIDER_EXIT_TIMEOUT_MS;
    const pollIntervalMs = dependencies.pollIntervalMs ?? POLL_INTERVAL_MS;
    const deadline = now() + timeoutMs;
    const remaining = new Set(pids);
    while (remaining.size) {
        const errors = [];
        for (const pid of [...remaining]) {
            try {
                probe(pid);
            } catch (error) {
                if (error && error.code === 'ESRCH') {
                    remaining.delete(pid);
                } else {
                    errors.push(new Error('A provider process exit could not be verified.'));
                }
            }
        }
        if (errors.length) {
            throw new CleanupAggregateError(errors,
                'One or more provider process exits could not be verified.');
        }
        if (!remaining.size) return;
        if (now() >= deadline) {
            throw new CleanupAggregateError(
                [new Error('Provider processes did not exit before the cleanup deadline.')],
                'One or more provider process exits could not be verified.'
            );
        }
        wait(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
    }
}

function writeProviderStopFiles(fixtures, dependencies = {}) {
    const writeStop = dependencies.writeStop
        || (stopPath => fs.writeFileSync(stopPath, 'stop', 'utf8'));
    const errors = [];
    for (const fixture of fixtures) {
        try {
            writeStop(fixture.stopPath);
        } catch (error) {
            errors.push(new Error('A provider stop request could not be written.'));
        }
    }
    if (errors.length) {
        throw new CleanupAggregateError(errors,
            'One or more provider stop requests could not be written.');
    }
}

function stopAndVerifyProviderFixtures(fixtures, dependencies = {}) {
    const errors = [];
    try {
        writeProviderStopFiles(fixtures, dependencies);
    } catch (error) {
        errors.push(error);
    }
    let pids = [];
    try {
        const evidence = inspectTrackedProviderPidEvidence(fixtures, dependencies);
        pids = evidence.pids;
        errors.push(...evidence.errors);
    } catch (error) {
        errors.push(new Error('Provider process evidence could not be read.'));
    }
    try {
        waitForTrackedProviderExit(pids, dependencies);
    } catch (error) {
        errors.push(error);
    }
    if (errors.length) {
        throw new CleanupAggregateError(errors,
            'One or more provider fixtures could not be stopped and verified.');
    }
}

function removeFixtureRoots(root, isolatedRoot, serverStopped, providersStopped) {
    const errors = [];
    const fixtureRoots = [
        ...(providersStopped ? [root] : []),
        ...(serverStopped ? [isolatedRoot] : []),
    ];
    for (const fixtureRoot of fixtureRoots) {
        try {
            fs.rmSync(fixtureRoot, { recursive: true, force: true });
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length) {
        throw new CleanupAggregateError(errors, 'One or more smoke fixture roots could not be removed.');
    }
}

async function runBestEffortCleanup(stages) {
    const errors = [];
    let socketPath = null;
    const attempt = async operation => {
        try {
            return await operation();
        } catch (error) {
            errors.push(error);
            return undefined;
        }
    };
    const captured = await attempt(() => stages.captureSocket());
    if (typeof captured === 'string') socketPath = captured;
    let killFailed = false;
    try {
        await stages.killServer();
    } catch (error) {
        errors.push(error);
        killFailed = true;
    }
    if (killFailed) {
        await attempt(() => stages.killServer());
    }
    let serverStopped = false;
    try {
        await stages.verifyStopped();
        serverStopped = true;
    } catch (error) {
        errors.push(error);
    }
    await attempt(() => stages.removeSocket(serverStopped ? socketPath : null));
    let providersStopped = false;
    try {
        await stages.terminateProviders();
        providersStopped = true;
    } catch (error) {
        errors.push(error);
    }
    await attempt(() => stages.removeFixtures(serverStopped, providersStopped));
    if (errors.length) {
        throw new CleanupAggregateError(errors, 'The isolated tmux smoke cleanup encountered errors.');
    }
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-tmux-smoke-'));
    tmuxTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-tmux-server-'));
    const ownedTmuxTempRoot = tmuxTempRoot;
    const fixtures = [];
    const runner = new IsolatedSyncTmuxRunner();
    const client = new TmuxClient(configuredTmuxPath, runner);
    let primaryError = null;
    let cleanupError = null;
    try {
        try {
            const availability = await client.checkAvailability();
            assert.ok(availability.available, availability.message);
            await runSmoke(root, runner, client, fixtures);
        } catch (error) {
            primaryError = error;
        }
    } finally {
        try {
            await runBestEffortCleanup({
                captureSocket: captureIsolatedSocketPath,
                killServer: killIsolatedServer,
                verifyStopped: assertIsolatedServerStopped,
                removeSocket: removeOwnStaleSocket,
                terminateProviders: () => stopAndVerifyProviderFixtures(fixtures),
                removeFixtures: (serverStopped, providersStopped) => removeFixtureRoots(
                    root, ownedTmuxTempRoot, serverStopped, providersStopped
                ),
            });
        } catch (error) {
            cleanupError = error;
        }
    }
    if (primaryError && cleanupError) {
        throw new CleanupAggregateError([primaryError, cleanupError],
            'The tmux smoke test and cleanup both failed.');
    }
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
    console.log('AI session tmux smoke checks passed.');
}

module.exports = {
    assertIsolatedServerStopped,
    collectTrackedProviderPids,
    killIsolatedServer,
    runBestEffortCleanup,
    stopAndVerifyProviderFixtures,
    waitForTrackedProviderExit,
    writeProviderStopFiles,
};

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
