'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function createTestUri(value) {
    const parsed = new URL(value);
    const uriPath = decodeURIComponent(parsed.pathname);
    return {
        scheme: parsed.protocol.replace(/:$/, ''), authority: parsed.host,
        path: uriPath, fsPath: uriPath, toString: () => value,
    };
}

function createTestFileUri(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return {
        scheme: 'file', authority: '', path: normalized, fsPath: filePath,
        toString: () => `file://${normalized}`,
    };
}

function loadProductionModules() {
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return { Uri: { parse: createTestUri, file: createTestFileUri } };
            return previousLoad.call(this, request, parent, isMain);
        };
        return {
            AiSessionProjectHydrationController:
                require('../../../out/aiSessions/projectHydrationController').AiSessionProjectHydrationController,
            attentionProject: require('../../../out/aiSessions/attentionProject'),
        };
    } finally {
        Module._load = previousLoad;
    }
}

const { AiSessionProjectHydrationController, attentionProject } = loadProductionModules();

test('PERSIST-AI-SESSION-PROJECT-HYDRATION-CONTROLLER-001 preserves scan, projection, cache signature, runtime, and pending boundaries', async () => {
    let refreshReason = 'refresh';
    const codexSession = {
        id: 'session-a', name: 'Original Name', cwd: '/work/a', updatedAt: '2026-07-16T10:00:00Z',
    };
    const providers = [{
        id: 'codex', terminalNamePrefix: 'Codex', projectSessionsKey: 'codexSessions',
        projectSessionsUnavailableKey: 'codexSessionsUnavailable', terminalCwdFields: ['cwd'],
    }, {
        id: 'kimi', terminalNamePrefix: 'Kimi', projectSessionsKey: 'kimiSessions',
        projectSessionsUnavailableKey: 'kimiSessionsUnavailable', terminalCwdFields: ['cwd'],
    }, {
        id: 'claude', terminalNamePrefix: 'Claude', projectSessionsKey: 'claudeSessions',
        projectSessionsUnavailableKey: 'claudeSessionsUnavailable', terminalCwdFields: ['cwd'],
    }];
    const readOptions = [];
    const assignmentInputs = [];
    const terminalService = {
        pending: [], tracked: [], replaced: [],
        getPendingTerminals() { return this.pending; },
        getTrackedSessionKeys() { return new Set(); },
        track(providerId, sessionId, entry) { this.tracked.push([providerId, sessionId, entry]); },
        replacePendingTerminals(pending) { this.replaced.push(pending); this.pending = pending; },
        trackPending(pending) { this.pending.push(pending); },
    };
    const activeRuntimes = [];
    const runtimeCoordinator = {
        getActive: () => activeRuntimes,
        getPending: () => terminalService.pending.map((pending, index) => ({
            identity: {
                provider: pending.provider, pendingId: `hydration:${pending.createdAt}:${index}`,
                projectKey: pending.cwd, cwd: pending.cwd,
            },
            backend: 'vscode', state: 'pending', markerPath: pending.markerPath,
            runStartedAtMs: Date.parse(pending.createdAt), attached: true,
            createdAt: pending.createdAt, excludedSessionIds: [...pending.excludedSessionIds],
            ...(pending.title === undefined ? {} : { title: pending.title }),
        })),
        promotePending: async (pendingId, sessionId) => {
            const pending = runtimeCoordinator.getPending().find(runtime => runtime.identity.pendingId === pendingId);
            const entry = terminalService.pending.find(candidate => candidate.createdAt === pending?.createdAt);
            if (!entry) return [];
            terminalService.track(entry.provider, sessionId, {
                terminal: entry.terminal, markerPath: entry.markerPath,
                runStartedAtMs: Date.parse(entry.createdAt), cwd: entry.cwd,
            });
            terminalService.replacePendingTerminals(terminalService.pending.filter(candidate => candidate !== entry));
            return [{
                identity: { provider: entry.provider, sessionId, projectKey: entry.cwd, cwd: entry.cwd },
                backend: 'vscode', state: 'active', markerPath: entry.markerPath,
                runStartedAtMs: Date.parse(entry.createdAt), attached: true, terminal: entry.terminal,
            }];
        },
    };
    const aliasesSet = [];
    const synced = [];
    const diagnostics = [];
    let nowMs = 1000;
    let workspaceFile = null;
    let workspaceFolders = null;
    const attentionEventId = 'attention-event-a';
    const controller = new AiSessionProjectHydrationController({
        getWorkspaceFile: () => workspaceFile,
        getWorkspaceFolders: () => workspaceFolders,
        getRefreshReason: () => refreshReason,
        incrementalScanMaxFiles: 123,
        getProviders: () => providers,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        readCoordinator: {
            getResults: options => {
                readOptions.push(options);
                return {
                    codex: { available: true, scannedFiles: 1, parsedFiles: 1, sessions: [codexSession] },
                    kimi: { available: false, scannedFiles: 0, parsedFiles: 0, sessions: [] },
                    claude: { available: true, scannedFiles: 0, parsedFiles: 0, sessions: [] },
                };
            },
            getAssignments: (candidates, sessionResults, getSessionPath) => {
                assignmentInputs.push({
                    candidates, sessionPath: getSessionPath('codex', codexSession), sessionResults,
                });
                return {
                    codex: new Map([['project-a', [codexSession]]]),
                    kimi: new Map(), claude: new Map(),
                };
            },
        },
        terminalService,
        runtimeCoordinator,
        setAlias: (providerId, sessionId, alias) => aliasesSet.push([providerId, sessionId, alias]),
        syncActiveTerminal: () => synced.push('sync'),
        getSessionComparableCwd: (_providerId, session) => session.cwd,
        getExpandedProjects: () => new Set(['key:/work/a']),
        getActiveProviders: () => ({ 'key:/work/a': 'codex' }),
        getPinnedSessions: () => new Set(['codex:session-a']),
        getAliases: () => ({ 'codex:session-a': 'Renamed Name' }),
        getAttentionAggregate: () => ({
            protocolVersion: 1, aggregateRevision: '2'.repeat(64), generatedAtMs: 1,
            sessions: [{
                projectId: attentionProject.getAttentionProjectKey('/work/a'),
                sessionKey: 'codex:session-a', reasons: ['completed'],
                eventIds: [attentionEventId], observedAtMs: 2,
            }],
        }),
        getLocalAttentionBySession: () => ({}),
        hasRemoteAttentionAggregate: () => true,
        getProjectKey: project => `key:${project.path}`,
        normalizeProjectPath: value => value ? value.replace(/\/+$/, '') : '',
        nowMs: () => { nowMs += 7; return nowMs; },
        logDiagnostic: event => diagnostics.push(event),
    });

    assert.deepEqual(controller.hydrate([]), []);
    assert.equal(readOptions.length, 0);
    assert.deepEqual(diagnostics[0], {
        event: 'ai-session-hydration', reason: 'refresh', durationMs: 7,
        projectCount: 0, hydratedProjectCount: 0, candidatePathCount: 0,
        providerCount: 3, sessionCount: 0, pendingTerminalCount: 0, cacheHit: false,
    });

    terminalService.pending = [{
        provider: 'codex', terminal: { name: 'pending-terminal' },
        markerPath: '/tmp/session-a.done', cwd: '/work/a',
        createdAt: '2026-07-16T10:00:00.000Z', excludedSessionIds: [], title: ' Pending Alias ',
    }];
    const hydrated = controller.hydrate([{ id: 'project-a', path: '/work/a', name: 'Project A' }]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(readOptions[0], { candidatePaths: ['/work/a'], reason: 'refresh', maxFiles: 123 });
    assert.deepEqual(diagnostics[1], {
        event: 'ai-session-hydration', reason: 'refresh', durationMs: 7,
        projectCount: 1, hydratedProjectCount: 1, candidatePathCount: 1,
        providerCount: 3, sessionCount: 1, pendingTerminalCount: 1, cacheHit: false,
    });
    assert.equal(assignmentInputs[0].candidates[0].path, '/work/a');
    assert.equal(assignmentInputs[0].sessionPath, '/work/a');
    assert.equal(terminalService.tracked[0][0], 'codex');
    assert.equal(terminalService.tracked[0][1], 'session-a');
    assert.equal(terminalService.tracked[0][2].runStartedAtMs, Date.parse('2026-07-16T10:00:00.000Z'));
    assert.deepEqual(aliasesSet, [['codex', 'session-a', ' Pending Alias ']]);
    assert.deepEqual(synced, ['sync']);
    assert.equal(hydrated[0].codexSessionsUnavailable, false);
    assert.equal(hydrated[0].kimiSessionsUnavailable, true);
    assert.equal(hydrated[0].codexSessionsExpanded, true);
    assert.equal(hydrated[0].activeAiSessionProvider, 'codex');
    assert.equal(hydrated[0].codexSessions[0].name, 'Renamed Name');
    assert.equal(hydrated[0].codexSessions[0].pinned, true);
    assert.deepEqual(hydrated[0].codexSessions[0].attention, {
        eventId: attentionEventId, reason: 'completed', unread: true,
    });

    refreshReason = 'terminal-candidates';
    controller.hydrate([{ id: 'project-a', path: '/work/a', name: 'Project A' }]);
    assert.equal(readOptions[1].maxFiles, 0, 'incremental terminal refresh must disable bounded rescan');
    controller.hydrate([{ id: 'project-a', path: '/work/a', name: 'Project A' }]);
    assert.equal(readOptions.length, 2, 'same-turn equal signatures must avoid duplicate reads');
    assert.equal(diagnostics[3].cacheHit, true);
    assert.equal(diagnostics[3].reason, 'terminal-candidates');

    controller.hydrate([{ id: 'project-a', path: '/work/a', name: 'Project A', isGitRepo: true }]);
    assert.equal(readOptions.length, 3, 'raw project fields must invalidate the signature');
    providers[0].projectSessionsUnavailableKey = 'codexSessionsTemporarilyUnavailable';
    controller.hydrate([{ id: 'project-a', path: '/work/a', name: 'Project A', isGitRepo: true }]);
    assert.equal(readOptions.length, 4, 'provider rendering fields must invalidate the signature');
    providers[0].projectSessionsUnavailableKey = 'codexSessionsUnavailable';

    workspaceFile = createTestFileUri('/work/missing.code-workspace');
    workspaceFolders = [{ uri: createTestFileUri('/work/shared') }];
    controller.hydrate([
        { id: 'project-a', path: '/work/a', name: 'Project A' },
        { id: 'project-b', path: '/work/b', name: 'Project B' },
    ]);
    assert.equal(readOptions.length, 5);
    assert.deepEqual(assignmentInputs.at(-1).candidates.map(candidate => ({
        projectId: candidate.project.id, path: candidate.path,
    })), [
        { projectId: 'project-a', path: '/work/a' },
        { projectId: 'project-b', path: '/work/b' },
        { projectId: 'project-a', path: '/work/shared' },
    ]);

    workspaceFile = createTestFileUri('/work/b');
    controller.hydrate([
        { id: 'project-a', path: '/work/a', name: 'Project A' },
        { id: 'project-b', path: '/work/b', name: 'Project B' },
    ]);
    assert.equal(readOptions.length, 6, 'candidate ownership must invalidate the signature');
    assert.deepEqual(assignmentInputs.at(-1).candidates.map(candidate => ({
        projectId: candidate.project.id, path: candidate.path,
    })), [
        { projectId: 'project-a', path: '/work/a' },
        { projectId: 'project-b', path: '/work/b' },
        { projectId: 'project-b', path: '/work/shared' },
    ]);
    await Promise.resolve();
    controller.hydrate([
        { id: 'project-a', path: '/work/a', name: 'Project A' },
        { id: 'project-b', path: '/work/b', name: 'Project B' },
    ]);
    assert.equal(readOptions.length, 7, 'same-turn cache must clear on the next microtask');

    const runtimeSignatureProject = [
        { id: 'project-a', path: '/work/a', name: 'Project A' },
        { id: 'project-b', path: '/work/b', name: 'Project B' },
    ];
    activeRuntimes.push({
        identity: { provider: 'codex', sessionId: 'session-a', projectKey: 'key:/work/a', cwd: '/work/a' },
        backend: 'vscode', state: 'active', markerPath: '/tmp/session-a.done',
        runStartedAtMs: 1, attached: true,
    });
    controller.hydrate(runtimeSignatureProject);
    assert.equal(readOptions.length, 8, 'active identity must invalidate the signature');
    activeRuntimes[0].backend = 'tmux';
    controller.hydrate(runtimeSignatureProject);
    assert.equal(readOptions.length, 9, 'backend must invalidate the signature');
    activeRuntimes[0].tmux = {
        layout: 'project', sessionName: 'project-steward-p-a', windowName: 'ai-codex-a',
    };
    controller.hydrate(runtimeSignatureProject);
    assert.equal(readOptions.length, 10, 'tmux locator must invalidate the signature');
    activeRuntimes[0].tmux.layout = 'session';
    controller.hydrate(runtimeSignatureProject);
    assert.equal(readOptions.length, 11, 'tmux layout must invalidate the signature');
    activeRuntimes[0].attached = false;
    controller.hydrate(runtimeSignatureProject);
    assert.equal(readOptions.length, 12, 'attachment state must invalidate the signature');
    activeRuntimes[0].state = 'conflict';
    controller.hydrate(runtimeSignatureProject);
    assert.equal(readOptions.length, 13, 'conflict state must invalidate the signature');

    controller.trackPendingTerminal(
        'codex', null, '/tmp/skip.done', '/work/a', '2026-07-16T10:00:00.000Z', [], 'skip'
    );
    controller.trackPendingTerminal(
        'codex', { name: 'terminal' }, '', '/work/a', '2026-07-16T10:00:00.000Z', [], 'skip'
    );
    controller.trackPendingTerminal(
        'codex', { name: 'terminal' }, '/tmp/manual.done', '/work/a/',
        '2026-07-16T10:00:00.000Z', ['session-a', '', null, 'session-b'], ' Manual\nTitle '
    );
    const manualPending = terminalService.pending.at(-1);
    assert.equal(manualPending.provider, 'codex');
    assert.equal(manualPending.cwd, '/work/a');
    assert.deepEqual(manualPending.excludedSessionIds, ['session-a', 'session-b']);
    assert.equal(manualPending.title, 'Manual Title');
});
