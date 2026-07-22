'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const DashboardDiagnostics = require('../../../out/dashboard/diagnostics').default;
const AiSessionAliasController = require('../../../out/aiSessions/aliasController').default;
const AiSessionAliasStore = require('../../../out/aiSessions/aliasStore').default;
const AiSessionPinController = require('../../../out/aiSessions/pinController').default;
const AiSessionPinStore = require('../../../out/aiSessions/pinStore').default;
const AiSessionTerminalBindingStore = require('../../../out/aiSessions/terminalBindingStore').default;
const { TmuxClient } = require('../../../out/aiSessions/tmuxClient');
const { AddProjectsFromFolderController } = require('../../../out/projects/addProjectsFromFolderController');

const REQUIRED_TMUX_COMMANDS = [
    'new-session', 'new-window', 'list-windows', 'set-option', 'show-options',
    'select-window', 'attach-session', 'has-session', 'rename-session', 'rename-window',
];

function makeAvailableRunner(runCommand) {
    return {
        async run(file, args) {
            if (args[0] === '-V') {
                return { exitCode: 0, stdout: 'tmux 3.4\n', stderr: '' };
            }
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: REQUIRED_TMUX_COMMANDS.join('\n'), stderr: '' };
            }
            return runCommand(file, args);
        },
    };
}

test('SESSION-ALIAS-CONTROLLER-001 and SESSION-PIN-CONTROLLER-001 map unreadable files to empty safe state', t => {
    const root = makeTempDirectory(t, 'project-steward-failure-unreadable-');
    fs.mkdirSync(path.join(root, 'ai-session-aliases.json'));
    const pinRoot = path.join(root, 'pinned-ai-sessions');
    fs.mkdirSync(pinRoot);
    const pinName = `${crypto.createHash('sha256').update('codex:unreadable').digest('hex')}.pin`;
    fs.mkdirSync(path.join(pinRoot, pinName));

    const logs = [];
    const aliasController = new AiSessionAliasController({
        store: new AiSessionAliasStore(root),
        isProviderId: value => value === 'codex',
        getSessionKey: (provider, session) => `${provider}:${session}`,
        getProviderResult: () => ({ sessions: [] }),
        logError: (message, error) => logs.push([message, error]),
    });
    const pinController = new AiSessionPinController({
        store: new AiSessionPinStore(root),
        getSessionKey: (provider, session) => `${provider}:${session}`,
        logError: (message, error) => logs.push([message, error]),
    });

    assert.deepEqual(aliasController.getAll(), {});
    assert.deepEqual(Array.from(pinController.getAll()), []);
    assert.deepEqual(logs.map(([message]) => message), [
        'Failed to read AI session aliases.',
        'Failed to read pinned AI sessions.',
    ]);
    assert.ok(logs.every(([, error]) => error && typeof error.code === 'string'));
});

test('RUNTIME-TMUX-CLIENT-001 maps missing executable, permission, and timeout failures without leaking paths', async () => {
    const executable = '/private/credentials/bin/tmux';
    for (const category of ['not-found', 'permission-denied', 'timeout']) {
        const client = new TmuxClient(executable, {
            run: async () => ({ exitCode: null, stdout: '', stderr: '', failureCategory: category }),
        });
        const availability = await client.checkAvailability();
        assert.equal(availability.available, false);
        assert.equal(availability.category, category);
        assert.equal(availability.message.includes(executable), false);
        assert.equal(availability.message.includes('credentials'), false);
    }
});

test('RUNTIME-TMUX-CLIENT-001 rejects malformed output with redacted diagnostics', async () => {
    const secret = 'private-session-token';
    const executable = '/private/credentials/bin/tmux';
    const client = new TmuxClient(executable, makeAvailableRunner(async () => ({
        exitCode: 0,
        stdout: `${secret}\u001fmissing-fields\n`,
        stderr: `socket at /private/${secret}`,
    })));

    await assert.rejects(client.listWindows(), error => {
        assert.equal(error.operation, 'list-windows');
        assert.equal(error.category, 'invalid-output');
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(executable), false);
        return true;
    });
});

test('PERSIST-AI-SESSION-TERMINAL-BINDING-STORE-001 skips timed-out process IDs and preserves later writes', async () => {
    const values = {};
    const errors = [];
    const state = {
        get: (key, fallback) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback,
        async update(key, value) {
            if (value === undefined) delete values[key];
            else values[key] = value;
        },
    };
    const store = new AiSessionTerminalBindingStore(state, error => errors.push(error), () => 1000, 5);
    store.setPending(new Promise(() => {}), {
        providerId: 'codex',
        markerPath: '/tmp/timed-out.done',
        cwd: '/work',
        createdAt: '2026-07-23T00:00:00.000Z',
        excludedSessionIds: [],
    });
    store.setBound(Promise.reject(new Error('process disappeared')), {
        providerId: 'codex',
        sessionId: 'rejected',
        markerPath: '/tmp/rejected.done',
        runStartedAtMs: 1,
    });
    store.setBound(42001, {
        providerId: 'codex',
        sessionId: 'survives',
        markerPath: '/tmp/survives.done',
        runStartedAtMs: 1,
    });
    await store.flush();

    assert.equal(store.get(42001).sessionId, 'survives');
    assert.equal(Object.keys(values).length, 1);
    assert.equal(errors.length, 1, 'process lookup errors are reported once per store');
});

test('ERROR-DASHBOARD-DIAGNOSTICS-001 keeps the output channel usable after diagnostic persistence permission failures', t => {
    const root = makeTempDirectory(t, 'project-steward-failure-diagnostic-');
    const blockedPath = path.join(root, 'not-a-directory');
    fs.writeFileSync(blockedPath, 'occupied', 'utf8');
    const lines = [];
    const diagnostics = new DashboardDiagnostics({
        outputChannel: { appendLine: line => lines.push(line) },
        globalStoragePath: blockedPath,
        now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    assert.doesNotThrow(() => diagnostics.logOpenProjectDiagnostic('Bridge', { event: 'retry' }));
    diagnostics.logDashboardDiagnostic({ event: 'still-running' });
    assert.ok(lines.some(line => line.includes('Failed to persist diagnostic:')));
    assert.ok(lines.some(line => line.includes('"event":"still-running"')));
});

test('ERROR-DASHBOARD-DIAGNOSTICS-001 writes bounded diagnostics and contains serialization failures', t => {
    const root = makeTempDirectory(t, 'project-steward-failure-diagnostic-bounds-');
    const lines = [];
    let nowMs = Date.parse('2026-07-23T00:00:00.000Z');
    const diagnostics = new DashboardDiagnostics({
        outputChannel: { appendLine: line => lines.push(line) },
        globalStoragePath: root,
        now: () => new Date(nowMs),
        maxOpenProjectDiagnosticBytes: 120,
    });

    diagnostics.logError('Failed action.', new Error('synthetic failure'));
    diagnostics.logAiSessionDiagnostic({ event: 'scan', count: 1 });
    diagnostics.logDashboardDiagnostic({ event: 'refresh' });
    diagnostics.logOpenProjectDiagnostic('Workspace', { event: 'snapshot' });
    const diagnosticPath = path.join(root, 'open-project-diagnostics.jsonl');
    assert.deepEqual(
        fs.readFileSync(diagnosticPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line).component),
        ['Workspace']
    );

    nowMs += 1000;
    diagnostics.logOpenProjectDiagnostic('Bridge', { event: 'large', payload: 'x'.repeat(100) });
    const persisted = fs.readFileSync(diagnosticPath, 'utf8').trim().split(/\r?\n/)
        .map(line => JSON.parse(line));
    assert.deepEqual(persisted.map(item => item.component), ['Bridge']);
    assert.equal(persisted[0].loggedAt, '2026-07-23T00:00:01.000Z');

    const circular = {};
    circular.self = circular;
    assert.doesNotThrow(() => diagnostics.logOpenProjectDiagnostic('Renderer', circular));
    assert.ok(lines.some(line => line.includes('[OpenProjects][Renderer] Failed to serialize diagnostic:')));
});

test('PROJECT-ADD-PROJECTS-FROM-FOLDER-CONTROLLER-001 treats user cancellation as a no-op', async () => {
    const events = [];
    let result;
    const controller = new AddProjectsFromFolderController({
        getCurrentWorkspacePath: () => '/work/current',
        parsePathAsUri: value => ({ fsPath: value }),
        showOpenDialog: async () => result,
        getFolders: async () => { throw new Error('CanceledByUser'); },
        addGroup: async () => { events.push('add-group'); return { id: 'group' }; },
        addProject: async () => events.push('add-project'),
        getRandomColor: () => '#000000',
        isFolderGitRepo: () => false,
        showErrorMessage: message => events.push(['error', message]),
        refreshAfterMutation: () => events.push('refresh'),
        userCanceledToken: 'CanceledByUser',
    });

    await controller.addProjectsFromFolder();
    result = [{ fsPath: '/work/canceled' }];
    await controller.addProjectsFromFolder();
    assert.deepEqual(events, []);
});
