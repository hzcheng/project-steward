'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const vm = require('vm');
const commands = require('../out/aiSessions/commandBuilders');
const helpers = require('../out/aiSessions/sessionHelpers');
const archiveBatch = require('../out/aiSessions/archiveBatch');
const activeTerminalHighlight = require('../out/aiSessions/activeTerminalHighlight');
const lifecycle = require('../out/aiSessions/lifecycle');
const jsonlTail = require('../out/aiSessions/jsonlTail');
const AiSessionAttentionMonitor = require('../out/aiSessions/attentionMonitor').default;
const attentionPayload = require('../out/aiSessions/attentionPayload');
const attentionAggregate = require('../out/aiSessions/attentionAggregate');
const attentionProject = require('../out/aiSessions/attentionProject');
const ProductionAttentionStore = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/productionAttentionStore').ProductionAttentionStore;
const AiSessionPinStore = require('../out/aiSessions/pinStore').default;
const providers = require('../out/aiSessions/providers');
const CodexSessionService = require('../out/services/codexSessionService').default;
const KimiSessionService = require('../out/services/kimiSessionService').default;
const ClaudeSessionService = require('../out/services/claudeSessionService').default;
const GitRepositoryDetector = require('../out/projects/gitRepositoryDetector').default;
const projectPathUtils = require('../out/projects/projectPathUtils');
const currentWorkspaceState = require('../out/projects/currentWorkspaceState');
const favoriteProjectOrder = require('../out/projects/favoriteProjectOrder');
const originalModuleLoad = Module._load;
const vscodeTestState = { terminals: [] };
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {
            Uri: { parse: createTestUri, file: createTestFileUri },
            window: { terminals: vscodeTestState.terminals },
        };
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};
const AiSessionTerminalService = require('../out/aiSessions/terminalService').default;
const models = require('../out/models');
const openProjectMatcher = require('../out/projects/openProjectMatcher');
const openProjectService = require('../out/projects/openProjectService');
const webviewContentModule = require('../out/webview/webviewContent');
Module._load = originalModuleLoad;

function createTestUri(value) {
    const parsed = new URL(value);
    const uriPath = decodeURIComponent(parsed.pathname);
    return {
        scheme: parsed.protocol.replace(/:$/, ''),
        authority: parsed.host,
        path: uriPath,
        fsPath: uriPath,
        toString: () => value,
    };
}

function createTestFileUri(filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    return {
        scheme: 'file',
        authority: '',
        path: normalizedPath,
        fsPath: filePath,
        toString: () => `file://${normalizedPath}`,
    };
}

function runPathChecks() {
    assert.strictEqual(helpers.normalizeAiSessionComparablePath('/work/app/'), '/work/app');
    assert.strictEqual(helpers.normalizeAiSessionComparablePath('/work/My%20App/'), '/work/My App');
    assert.strictEqual(helpers.normalizeAiSessionComparablePath('C:\\work\\app\\'), 'C:/work/app');
    assert.strictEqual(helpers.aiSessionPathContains('/work/app', '/work/app/src'), true);
    assert.strictEqual(helpers.aiSessionPathContains('/work/My App', '/work/My%20App/src'), true);
    assert.strictEqual(helpers.aiSessionPathContains('/work/app', '/work/application'), false);
    assert.strictEqual(helpers.aiSessionPathContains('', '/work/app'), false);
    assert.strictEqual(projectPathUtils.normalizeRemoteAuthority('ssh-remote%2Bserver'), 'ssh-remote+server');
    assert.strictEqual(projectPathUtils.normalizeRemoteAuthority('dev-container+abc'), 'dev-container+abc');
    assert.strictEqual(projectPathUtils.normalizePosixPath('/work/app/../app/src/'), '/work/app/src');
    assert.strictEqual(projectPathUtils.normalizePosixPath('/'), '/');
    assert.strictEqual(projectPathUtils.isPathInside('/work/app/src', '/work/app'), true);
    assert.strictEqual(projectPathUtils.isPathInside('/work/application', '/work/app'), false);
    assert.strictEqual(projectPathUtils.isPathInside('/work/app', '/work/app'), false);
    assert.strictEqual(projectPathUtils.getPathMatchScore('/work/app', '/work/app', true), 100);
    assert.strictEqual(projectPathUtils.getPathMatchScore('/work/app/src', '/work/app', true), 80);
    assert.strictEqual(projectPathUtils.getPathMatchScore('/work/app', '/work/app/src', true), 70);
    assert.strictEqual(projectPathUtils.getPathMatchScore('/work/app', '/work/app/file.ts', false), 40);
    assert.strictEqual(projectPathUtils.getPathMatchScore('/work/app', '/other/app', false), 10);
    assert.strictEqual(projectPathUtils.ensureLeadingSlash('work/app'), '/work/app');
    assert.strictEqual(projectPathUtils.ensureLeadingSlash('/work/app'), '/work/app');
    assert.strictEqual(projectPathUtils.encodeRemoteAuthority('ssh-remote+user@host'), 'ssh-remote%2Buser@host');
}

function runAssignmentChecks() {
    const candidates = [
        { project: { id: 'root' }, path: '/work' },
        { project: { id: 'app' }, path: '/work/app' },
    ];
    const sessions = [
        { id: 's1', name: 'One', cwd: '/work/app/src' },
        { id: 's2', name: 'Two', cwd: '/elsewhere' },
    ];
    const assignments = helpers.assignAiSessionsToProjects(candidates, sessions, session => session.cwd);

    assert.deepStrictEqual((assignments.get('app') || []).map(session => session.id), ['s1']);
    assert.strictEqual(assignments.has('root'), false);
}

function runCurrentWorkspaceStateChecks() {
    const saved = { id: 'saved', name: 'Saved', path: '/work/saved' };
    const other = { id: 'other', name: 'Other', path: '/work/other' };
    const groups = [{ id: 'group', groupName: 'Work', projects: [saved, other] }];
    const openProjects = [
        { id: '__openProjects-0', name: 'Saved', path: '/work/saved', openProjectCardKind: 'current' },
        { id: '__openProjectNavigation-other', name: 'Other Window', path: '/work/navigation', openProjectCardKind: 'projectNavigation' },
    ];

    const result = currentWorkspaceState.withCurrentWorkspaceState(groups, openProjects, ['saved']);

    assert.strictEqual(result.groups[0].projects[0].isCurrentWorkspace, true);
    assert.strictEqual(result.groups[0].projects[1].isCurrentWorkspace, false);
    assert.strictEqual(result.openProjects[0].isCurrentWorkspace, true);
    assert.strictEqual(result.openProjects[1].isCurrentWorkspace, false);
    assert.strictEqual(saved.isCurrentWorkspace, undefined);
    assert.strictEqual(openProjects[0].isCurrentWorkspace, undefined);
    assert.notStrictEqual(result.groups[0], groups[0]);
}

function runFavoriteProjectOrderChecks() {
    const projects = [
        { id: 'legacy-a', favorite: true },
        { id: 'ordered', favorite: true, favoriteOrder: 0 },
        { id: 'duplicate-a', favorite: true, favoriteOrder: 2 },
        { id: 'duplicate-b', favorite: true, favoriteOrder: 2 },
        { id: 'invalid', favorite: true, favoriteOrder: -1 },
        { id: 'plain', favorite: false, favoriteOrder: 7 },
    ];

    assert.deepStrictEqual(
        favoriteProjectOrder.getFavoriteProjectsInOrder(projects).map(project => project.id),
        ['ordered', 'legacy-a', 'duplicate-a', 'duplicate-b', 'invalid']
    );

    const groups = [
        { id: 'one', projects: [projects[0], projects[1], projects[5]] },
        { id: 'two', projects: [projects[2], projects[3], projects[4]] },
    ];
    const reordered = favoriteProjectOrder.withFavoriteProjectOrder(
        groups,
        ['invalid', 'ordered', 'invalid', 'unknown', 'plain']
    );
    const reorderedProjects = reordered.reduce((all, group) => all.concat(group.projects), []);

    assert.deepStrictEqual(
        favoriteProjectOrder.getFavoriteProjectsInOrder(reorderedProjects).map(project => project.id),
        ['invalid', 'ordered', 'legacy-a', 'duplicate-a', 'duplicate-b']
    );
    assert.deepStrictEqual(reordered.map(group => group.projects.map(project => project.id)), [
        ['legacy-a', 'ordered', 'plain'],
        ['duplicate-a', 'duplicate-b', 'invalid'],
    ]);
    assert.deepStrictEqual(
        favoriteProjectOrder.getFavoriteProjectsInOrder(reorderedProjects).map(project => project.favoriteOrder),
        [0, 1, 2, 3, 4]
    );
    assert.strictEqual(reordered[0].projects[2].favoriteOrder, undefined);
    assert.strictEqual(projects[0].favoriteOrder, undefined);
    assert.notStrictEqual(reordered[0], groups[0]);
    assert.notStrictEqual(reordered[0].projects[0], groups[0].projects[0]);

    const toggleGroups = [{
        id: 'toggle',
        projects: [
            { id: 'a', favorite: true, favoriteOrder: 0 },
            { id: 'b', favorite: true, favoriteOrder: 1 },
            { id: 'c', favorite: false, favoriteOrder: 9 },
        ],
    }];
    const added = favoriteProjectOrder.withToggledProjectFavorite(toggleGroups, 'c');
    const addedProjects = added[0].projects;
    assert.deepStrictEqual(
        favoriteProjectOrder.getFavoriteProjectsInOrder(addedProjects).map(project => project.id),
        ['a', 'b', 'c']
    );
    assert.strictEqual(addedProjects[2].favorite, true);
    assert.strictEqual(addedProjects[2].favoriteOrder, 2);

    const removed = favoriteProjectOrder.withToggledProjectFavorite(added, 'b');
    assert.deepStrictEqual(
        favoriteProjectOrder.getFavoriteProjectsInOrder(removed[0].projects).map(project => project.id),
        ['a', 'c']
    );
    assert.strictEqual(removed[0].projects[1].favorite, false);
    assert.strictEqual(removed[0].projects[1].favoriteOrder, undefined);

    const readded = favoriteProjectOrder.withToggledProjectFavorite(removed, 'b');
    assert.deepStrictEqual(
        favoriteProjectOrder.getFavoriteProjectsInOrder(readded[0].projects).map(project => project.id),
        ['a', 'c', 'b']
    );
    assert.strictEqual(favoriteProjectOrder.withToggledProjectFavorite(toggleGroups, 'missing'), null);
    assert.strictEqual(toggleGroups[0].projects[2].favorite, false);
    assert.strictEqual(toggleGroups[0].projects[2].favoriteOrder, 9);
}

function runCurrentWorkspaceMatchingChecks() {
    const savedProjects = [
        { id: 'local', name: 'Same Name', path: '/work/local' },
        { id: 'other', name: 'Same Name', path: '/work/other' },
        { id: 'workspace', name: 'Workspace', path: '/work/team.code-workspace' },
        { id: 'ssh', name: 'SSH', path: 'vscode-remote://ssh-remote+server/work/ssh' },
        { id: 'container', name: 'Container', path: 'vscode-remote://dev-container+abc/work/container' },
    ];
    const resolveIds = (workspaceUris, remoteName = null) => currentWorkspaceState.getCurrentWorkspaceProjectIds(
        savedProjects,
        workspaceUris,
        remoteName,
        openProjectMatcher.findSavedProjectForOpenProject
    );

    assert.deepStrictEqual(resolveIds([createTestFileUri('/work/local')]), ['local']);
    assert.deepStrictEqual(resolveIds([createTestFileUri('/work/team.code-workspace')]), ['workspace']);
    assert.deepStrictEqual(resolveIds([
        createTestFileUri('/work/local'),
        createTestFileUri('/work/other'),
    ]), ['local', 'other']);
    assert.deepStrictEqual(resolveIds([
        createTestUri('vscode-remote://ssh-remote+server/work/ssh'),
    ], 'ssh-remote'), ['ssh']);
    assert.deepStrictEqual(resolveIds([
        createTestUri('vscode-remote://dev-container+abc/work/container'),
    ], 'dev-container'), ['container']);
    assert.deepStrictEqual(resolveIds([
        createTestFileUri('/work/ssh'),
    ], 'ssh-remote'), ['ssh']);
    assert.deepStrictEqual(resolveIds([createTestFileUri('/missing')]), []);
    assert.deepStrictEqual(resolveIds([]), []);
}

function runOpenProjectAttentionIdentityChecks() {
    const savedRemotePath = 'vscode-remote://dev-container+fixture/work/app';
    const openProjects = openProjectService.getOpenProjectsFromWorkspace(
        null,
        [{ uri: createTestFileUri('/work/app'), name: 'app' }],
        {
            savedProjects: [{
                id: 'saved-remote',
                name: 'App',
                path: savedRemotePath,
                remoteType: models.ProjectRemoteType.DevContainer,
            }],
            currentRemoteName: 'dev-container',
            isFolderGitRepo: () => true,
        }
    );

    assert.strictEqual(openProjects.length, 1);
    assert.strictEqual(openProjects[0].path, '/work/app');
    assert.strictEqual(openProjects[0].attentionProjectPath, savedRemotePath);
}

function runCandidateFilterChecks() {
    const result = {
        available: true,
        sessions: [
            { id: 's1', name: 'One', cwd: '/work/app/src' },
            { id: 's2', name: 'Two', cwd: '/elsewhere' },
        ],
    };
    const filtered = helpers.filterAiSessionsByCandidatePaths(result, ['/work/app'], session => session.cwd);

    assert.deepStrictEqual(filtered.sessions.map(session => session.id), ['s1']);
    assert.strictEqual(helpers.filterAiSessionsByCandidatePaths(result, [], session => session.cwd), result);
    assert.deepStrictEqual(helpers.normalizeAiSessionCandidatePaths(['/work/app/', '/work/app', '']).map(item => item), ['/work/app']);
}

function runDisplayChecks() {
    const prepared = helpers.prepareAiSessionsForDisplay(
        [
            { id: 'old', name: 'Old', updatedAt: '2024-01-01T00:00:00Z' },
            { id: 'pinned', name: 'Pinned', updatedAt: '2020-01-01T00:00:00Z' },
            { id: 'new', name: 'New', updatedAt: '2025-01-01T00:00:00Z' },
        ],
        'codex',
        new Set(['codex:pinned']),
        { 'codex:new': 'Alias New' },
        2
    );

    assert.deepStrictEqual(prepared.map(session => session.id), ['pinned', 'new']);
    assert.strictEqual(prepared[0].provider, 'codex');
    assert.strictEqual(prepared[0].pinned, true);
    assert.strictEqual(prepared[1].name, 'Alias New');
}

function runPinStoreChecks() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-pins-'));
    try {
        const firstStore = new AiSessionPinStore(tempRoot);
        const secondStore = new AiSessionPinStore(tempRoot);

        firstStore.add('codex:first');
        secondStore.add('kimi:second');
        firstStore.remove('codex:first');

        assert.deepStrictEqual(Array.from(secondStore.getAll()), ['kimi:second']);

        firstStore.migrateLegacy(['claude:legacy']);
        assert.strictEqual(secondStore.has('claude:legacy'), true);
        secondStore.remove('claude:legacy');
        secondStore.migrateLegacy(['claude:legacy']);
        assert.strictEqual(firstStore.has('claude:legacy'), false);

        assert.strictEqual(firstStore.toggle('codex:toggle'), true);
        assert.strictEqual(secondStore.toggle('codex:toggle'), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function runKeyChecks() {
    const isProviderId = value => value === 'codex' || value === 'kimi' || value === 'claude';

    assert.strictEqual(helpers.getAiSessionKey('kimi', 'abc'), 'kimi:abc');
    assert.strictEqual(helpers.getAiSessionProviderIdFromKey('claude:xyz', isProviderId), 'claude');
    assert.strictEqual(helpers.getAiSessionProviderIdFromKey('unknown:xyz', isProviderId), null);
    assert.strictEqual(helpers.getAiSessionProviderIdFromKey(':missing', isProviderId), null);
}

function runActiveAiSessionTerminalHighlightChecks() {
    const terminalA = { name: 'A' };
    const terminalB = { name: 'B' };
    let activeTerminal = terminalA;
    let visible = true;
    let complete = new Set();
    let published = [];
    let timers = [];
    const resolutions = new Map([
        [terminalA, { terminal: terminalA, provider: 'codex', sessionId: 'a', entry: { markerPath: 'a.done' } }],
        [terminalB, { terminal: terminalB, provider: 'kimi', sessionId: 'b', entry: { markerPath: 'b.done' } }],
    ]);
    const highlighter = new activeTerminalHighlight.default({
        isVisible: () => visible,
        getActiveTerminal: () => activeTerminal,
        resolveTerminal: terminal => resolutions.get(terminal) || null,
        isComplete: resolution => complete.has(resolution.sessionId),
        publish: identity => published.push(identity),
        setInterval: callback => {
            const handle = { callback, active: true };
            timers.push(handle);
            return handle;
        },
        clearInterval: handle => { handle.active = false; },
    });

    highlighter.sync();
    assert.deepStrictEqual(published.pop(), { provider: 'codex', sessionId: 'a' });
    assert.strictEqual(timers.filter(timer => timer.active).length, 1);

    activeTerminal = terminalB;
    highlighter.sync();
    assert.deepStrictEqual(published.pop(), { provider: 'kimi', sessionId: 'b' });
    assert.strictEqual(timers.filter(timer => timer.active).length, 1);

    complete.add('b');
    timers.find(timer => timer.active).callback();
    assert.strictEqual(published.pop(), null);
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);

    complete.clear();
    activeTerminal = terminalA;
    highlighter.sync();
    highlighter.handleTerminalClosed(terminalA);
    assert.strictEqual(published.pop(), null);
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);

    visible = false;
    highlighter.setVisible(false);
    highlighter.sync();
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);

    visible = true;
    highlighter.setVisible(true);
    highlighter.request();
    assert.deepStrictEqual(published.pop(), { provider: 'codex', sessionId: 'a' });
    assert.strictEqual(timers.filter(timer => timer.active).length, 1);

    resolutions.delete(terminalA);
    highlighter.sync();
    assert.strictEqual(published.pop(), null);
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);

    highlighter.dispose();
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);
}

function runAiSessionTerminalResolutionChecks() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-active-terminal-'));
    try {
        const service = new AiSessionTerminalService(tempRoot, providerId =>
            providers.getAiSessionProviderDefinition(providerId), 0
        );
        const tracked = { name: 'Codex: One [session-]', creationOptions: {} };
        service.track('codex', 'session-one', {
            terminal: tracked,
            markerPath: path.join(tempRoot, 'session-one.done'),
        });
        const candidateCalls = [];
        const candidates = {
            codex: [{ id: 'session-env', name: 'Environment' }],
            kimi: [{ id: 'named-123456', name: 'Named' }],
        };
        const getCandidates = providerId => {
            candidateCalls.push(providerId);
            return candidates[providerId] || [];
        };

        assert.strictEqual(service.resolveTerminalSession(tracked, getCandidates).sessionId, 'session-one');
        assert.deepStrictEqual(candidateCalls, []);

        const byEnv = {
            name: 'Codex restored',
            creationOptions: { env: { PROJECT_STEWARD_CODEX_SESSION_ID: 'session-env' } },
        };
        const archivedByEnv = {
            name: 'Codex archived',
            creationOptions: { env: { PROJECT_STEWARD_CODEX_SESSION_ID: 'session-archived' } },
        };
        const byName = { name: 'Kimi: Named [named-12]', creationOptions: {} };
        const ordinary = { name: 'bash', creationOptions: {} };
        const recoveredMarkerPath = service.getMarkerPath('codex', 'session-env');
        fs.writeFileSync(recoveredMarkerPath, '', 'utf8');
        const oldMarkerAt = new Date(Date.now() - 60_000);
        fs.utimesSync(recoveredMarkerPath, oldMarkerAt, oldMarkerAt);
        vscodeTestState.terminals.splice(
            0,
            vscodeTestState.terminals.length,
            byEnv,
            archivedByEnv,
            byName,
            ordinary
        );

        const recoveredByEnv = service.resolveTerminalSession(byEnv, getCandidates);
        assert.strictEqual(recoveredByEnv.sessionId, 'session-env');
        assert.strictEqual(Number.isFinite(recoveredByEnv.entry.runStartedAtMs), true);
        assert.strictEqual(service.isComplete(recoveredByEnv.entry), false, 'marker older than recovered run is ignored');
        const currentMarkerAt = new Date(recoveredByEnv.entry.runStartedAtMs + 1000);
        fs.utimesSync(recoveredMarkerPath, currentMarkerAt, currentMarkerAt);
        assert.strictEqual(service.isComplete(recoveredByEnv.entry), true, 'marker written during current run completes it');
        assert.deepStrictEqual(candidateCalls, ['codex']);

        candidateCalls.length = 0;
        assert.strictEqual(service.resolveTerminalSession(archivedByEnv, getCandidates), null);
        assert.deepStrictEqual(candidateCalls, ['codex']);

        candidateCalls.length = 0;
        assert.strictEqual(service.resolveTerminalSession(byName, getCandidates).sessionId, 'named-123456');
        assert.deepStrictEqual(candidateCalls, ['kimi']);

        candidateCalls.length = 0;
        assert.strictEqual(service.resolveTerminalSession(ordinary, getCandidates), null);
        assert.deepStrictEqual(candidateCalls, []);
    } finally {
        vscodeTestState.terminals.length = 0;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function runBatchAiSessionArchiveChecks() {
    assert.ok(archiveBatch.MAX_BATCH_AI_SESSION_ARCHIVE_REQUEST_ENTRIES > 20);
    const excessiveIds = Array.from(
        { length: archiveBatch.MAX_BATCH_AI_SESSION_ARCHIVE_REQUEST_ENTRIES + 7 },
        (_, index) => `session-${index}`
    );
    const boundedSelection = archiveBatch.resolveBatchAiSessionSelection(
        excessiveIds,
        excessiveIds.map(id => ({ id, name: id }))
    );
    assert.strictEqual(
        boundedSelection.eligibleSessions.length,
        archiveBatch.MAX_BATCH_AI_SESSION_ARCHIVE_REQUEST_ENTRIES
    );
    assert.strictEqual(boundedSelection.malformedCount, 7);

    const excessiveLengthId = 'x'.repeat(archiveBatch.MAX_BATCH_AI_SESSION_ID_LENGTH + 1);
    const excessiveLengthSelection = archiveBatch.resolveBatchAiSessionSelection(
        [excessiveLengthId],
        [{ id: excessiveLengthId, name: 'Too long' }]
    );
    assert.deepStrictEqual(excessiveLengthSelection.eligibleSessions, []);
    assert.strictEqual(excessiveLengthSelection.malformedCount, 1);

    const rejectedIds = Array.from(
        { length: archiveBatch.MAX_RETAINED_BATCH_AI_SESSION_REJECTED_IDS + 5 },
        (_, index) => `outside-${index}`
    );
    const boundedRejectedSelection = archiveBatch.resolveBatchAiSessionSelection(rejectedIds, []);
    assert.strictEqual(
        boundedRejectedSelection.rejectedIds.length,
        archiveBatch.MAX_RETAINED_BATCH_AI_SESSION_REJECTED_IDS
    );
    assert.strictEqual(boundedRejectedSelection.rejectedIdCount, rejectedIds.length);
    assert.strictEqual(
        archiveBatch.formatBatchAiSessionIdForLog('outside\nnext\t\u0000'),
        'outside\\nnext\\t\\u0000'
    );
    assert.ok(
        archiveBatch.formatBatchAiSessionIdForLog('z'.repeat(1000)).length
        <= archiveBatch.MAX_BATCH_AI_SESSION_LOG_ID_LENGTH + 1
    );

    const availableSessions = [
        { id: 'pinned', name: 'Pinned', pinned: true },
        { id: 'plain', name: 'Plain' },
        { id: 'running', name: 'Running' },
        { id: 'failed', name: 'Failed' },
    ];
    const selection = archiveBatch.resolveBatchAiSessionSelection(
        ['plain', 'plain', '', 42, 'pinned', 'outside', 'running', 'failed'],
        availableSessions
    );

    assert.deepStrictEqual(selection.eligibleSessions.map(session => session.id), [
        'plain', 'pinned', 'running', 'failed',
    ]);
    assert.deepStrictEqual(selection.rejectedIds, ['outside']);
    assert.strictEqual(selection.rejectedIdCount, 1);
    assert.strictEqual(selection.malformedCount, 2);
    assert.strictEqual(selection.eligibleSessions.filter(session => session.pinned).length, 1);

    const result = archiveBatch.archiveBatchAiSessions(selection, {
        resolveCurrentSessions: () => availableSessions.filter(session => session.id !== 'pinned'),
        archiveSession: sessionId => sessionId === 'running'
            ? 'running'
            : sessionId === 'failed' ? 'failed' : 'archived',
    });

    assert.deepStrictEqual(result.archivedIds, ['plain']);
    assert.deepStrictEqual(result.runningIds, ['running']);
    assert.deepStrictEqual(result.missingIds, ['pinned']);
    assert.deepStrictEqual(result.failedIds, ['failed']);
    assert.deepStrictEqual(result.rejectedIds, ['outside']);
    assert.strictEqual(result.malformedCount, 2);
    assert.strictEqual(archiveBatch.hasBatchAiSessionArchiveIssues(result), true);
    assert.strictEqual(
        archiveBatch.formatBatchAiSessionArchiveSummary(result),
        'Archived 1 session; skipped 1 running session; 1 session was no longer available; rejected 3 invalid or out-of-scope selections; 1 session failed.'
    );

    const success = archiveBatch.archiveBatchAiSessions(
        archiveBatch.resolveBatchAiSessionSelection(['plain'], availableSessions),
        {
            resolveCurrentSessions: () => availableSessions,
            archiveSession: () => 'archived',
        }
    );
    assert.strictEqual(archiveBatch.hasBatchAiSessionArchiveIssues(success), false);
    assert.strictEqual(
        archiveBatch.formatBatchAiSessionArchiveSummary(success),
        'Archived 1 session.'
    );
}

async function runBatchAiSessionArchiveHostChecks() {
    const sessions = [
        { id: 'archived', name: 'Archived' },
        { id: 'running', name: 'Running' },
        { id: 'missing', name: 'Missing' },
        { id: 'provider-false', name: 'Provider false', pinned: true },
        { id: 'provider-throw', name: 'Provider throw' },
        { id: 'later', name: 'Later' },
    ];
    const createHarness = overrides => {
        const state = {
            confirmations: [], completions: [], refreshCount: 0, results: [], errors: [],
            scopeRejections: 0, selectionRejections: 0,
        };
        const project = { id: 'project-a', activeAiSessionProvider: 'codex' };
        const dependencies = Object.assign({
            resolveProject: projectId => projectId === project.id ? project : null,
            getProjectSessions: () => sessions,
            resolveCurrentSessions: () => sessions,
            confirm: details => {
                state.confirmations.push(details);
                return Promise.resolve(true);
            },
            archiveSession: () => 'archived',
            reportScopeRejected: () => { state.scopeRejections++; },
            reportSelectionRejected: () => { state.selectionRejections++; },
            reportResult: result => { state.results.push(result); },
            logUnexpectedError: (context, error, sessionId) => {
                state.errors.push({ context, error: String(error), sessionId });
            },
            postCompletion: message => { state.completions.push(message); },
            refresh: () => { state.refreshCount++; },
        }, overrides || {});
        return { state, dependencies };
    };
    const request = {
        projectId: 'project-a', provider: 'codex', sessionIds: sessions.map(session => session.id),
    };

    for (const rejectedRequest of [
        { projectId: 'project-b', provider: 'codex', sessionIds: ['archived'] },
        { projectId: 'project-a', provider: 'kimi', sessionIds: ['archived'] },
    ]) {
        const harness = createHarness();
        await archiveBatch.executeBatchAiSessionArchiveRequest(rejectedRequest, harness.dependencies);
        assert.strictEqual(harness.state.scopeRejections, 1);
        assert.deepStrictEqual(harness.state.completions.map(message => message.status), ['rejected']);
        assert.strictEqual(harness.state.confirmations.length, 0);
        assert.strictEqual(harness.state.refreshCount, 0);
    }

    const cancelled = createHarness({ confirm: () => Promise.resolve(false) });
    await archiveBatch.executeBatchAiSessionArchiveRequest(request, cancelled.dependencies);
    assert.deepStrictEqual(cancelled.state.completions.map(message => message.status), ['cancelled']);
    assert.strictEqual(cancelled.state.refreshCount, 0);

    const confirmation = createHarness();
    await archiveBatch.executeBatchAiSessionArchiveRequest({
        projectId: 'project-a', provider: 'codex',
        sessionIds: ['archived', 'provider-false', 'archived'],
    }, confirmation.dependencies);
    assert.deepStrictEqual(confirmation.state.confirmations, [{
        projectId: 'project-a', provider: 'codex', eligibleCount: 2, pinnedCount: 1,
    }]);
    assert.deepStrictEqual(confirmation.state.completions.map(message => message.status), ['finished']);
    assert.strictEqual(confirmation.state.refreshCount, 1);

    const mixed = createHarness({
        resolveCurrentSessions: () => sessions.filter(session => session.id !== 'missing'),
        archiveSession: sessionId => {
            if (sessionId === 'running') return 'running';
            if (sessionId === 'provider-false') return 'failed';
            if (sessionId === 'provider-throw') throw new Error('provider exploded');
            return 'archived';
        },
    });
    await archiveBatch.executeBatchAiSessionArchiveRequest(request, mixed.dependencies);
    const mixedResult = mixed.state.completions[0].result;
    assert.deepStrictEqual(mixedResult.archivedIds, ['archived', 'later']);
    assert.deepStrictEqual(mixedResult.runningIds, ['running']);
    assert.deepStrictEqual(mixedResult.missingIds, ['missing']);
    assert.deepStrictEqual(mixedResult.failedIds, ['provider-false', 'provider-throw']);
    assert.strictEqual(mixed.state.errors.length, 1);
    assert.strictEqual(mixed.state.errors[0].sessionId, 'provider-throw');
    assert.deepStrictEqual(mixed.state.completions.map(message => message.status), ['finished']);
    assert.strictEqual(mixed.state.refreshCount, 1);

    const cleanupCalls = [];
    const itemDependencies = archiveResult => ({
        isRunning: () => false,
        archiveSession: typeof archiveResult === 'function' ? archiveResult : () => archiveResult,
        deleteEntryMarker: () => cleanupCalls.push('marker'),
        untrackTerminal: () => cleanupCalls.push('terminal'),
        deletePin: () => cleanupCalls.push('pin'),
        deleteAlias: () => cleanupCalls.push('alias'),
    });
    assert.strictEqual(
        archiveBatch.archiveBatchAiSessionItem('success', itemDependencies(true)),
        'archived'
    );
    assert.deepStrictEqual(cleanupCalls, ['marker', 'terminal', 'pin', 'alias']);
    cleanupCalls.length = 0;
    assert.strictEqual(
        archiveBatch.archiveBatchAiSessionItem('failed', itemDependencies(false)),
        'failed'
    );
    assert.deepStrictEqual(cleanupCalls, []);
    assert.throws(
        () => archiveBatch.archiveBatchAiSessionItem('throw', itemDependencies(() => { throw new Error('boom'); })),
        /boom/
    );
    assert.deepStrictEqual(cleanupCalls, []);

    for (const exceptionCase of [
        { override: { resolveProject: () => { throw new Error('resolve'); } }, status: 'rejected', refreshCount: 0 },
        { override: { confirm: () => { throw new Error('confirm'); } }, status: 'rejected', refreshCount: 0 },
        { override: { resolveCurrentSessions: () => { throw new Error('execute'); } }, status: 'finished', refreshCount: 1 },
        { override: { reportResult: () => { throw new Error('report'); } }, status: 'finished', refreshCount: 1 },
    ]) {
        const harness = createHarness(exceptionCase.override);
        await archiveBatch.executeBatchAiSessionArchiveRequest(request, harness.dependencies);
        assert.deepStrictEqual(harness.state.completions.map(message => message.status), [exceptionCase.status]);
        assert.strictEqual(harness.state.refreshCount, exceptionCase.refreshCount);
        assert.strictEqual(harness.state.errors.length, 1);
    }
}

function runWebviewContentChecks() {
    const webviewContent = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'webviewContent.ts'), 'utf8');
    const webviewProjectScripts = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'webviewProjectScripts.js'), 'utf8');
    const webviewIcons = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'webviewIcons.ts'), 'utf8');
    const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.scss'), 'utf8');
    const compiledStyles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    const insideProjectClick = extractFunctionBody(webviewProjectScripts, 'onInsideProjectClick');
    const evaluateAttentionFunction = extractFunctionBody(dashboard, 'evaluateAiSessionAttention');
    const withAiSessionsFunction = extractFunctionBody(dashboard, 'withAiSessions');
    const singleArchiveFunction = extractFunctionBody(dashboard, 'archiveAiSession');
    const batchArchiveFunction = extractFunctionBody(dashboard, 'archiveAiSessions');
    const archiveItemFunction = extractFunctionBody(dashboard, 'archiveAiSessionItem');
    const batchArchiveLogFunction = extractFunctionBody(dashboard, 'logBatchAiSessionArchiveResult');
    const projectWindowColorService = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'projectWindowColorService.ts'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const settingsFunction = extractFunctionBody(dashboard, 'showProjectStewardSettings');
    const sidebarStyles = styles.slice(styles.indexOf('body.steward-sidebar'));
    const projectBorderBlock = extractScssBlock(sidebarStyles, '.project-border');
    const projectBorderHoverBlock = extractScssBlock(sidebarStyles, '&:hover .project-border');
    const expandedProjectHoverBlock = extractScssBlock(sidebarStyles, '&[data-codex-expanded]:hover');
    const expandedProjectBorderBlock = extractScssBlock(expandedProjectHoverBlock, '.project-border');
    const compiledProjectBorderBlock = extractScssBlock(compiledStyles, 'body.steward-sidebar .project .project-border');
    const compiledProjectBorderHoverBlock = extractScssBlock(compiledStyles, 'body.steward-sidebar .project:hover .project-border');
    const compiledExpandedProjectBorderBlock = extractScssBlock(compiledStyles, 'body.steward-sidebar .project[data-open-project][data-codex-expanded]:hover .project-border');
    const currentProjectStyleBlock = extractScssBlock(sidebarStyles, '&[data-current-workspace]');
    const compiledCurrentProjectStyleBlock = extractScssBlock(compiledStyles, 'body.steward-sidebar .project[data-current-workspace]');

    assert.ok(webviewContent.includes('data-action="add" title="Add Project"'));
    assert.ok(webviewContent.includes('class="project no-projects" data-action="add-project" data-nodrag'));
    assert.ok(!webviewContent.includes('getAddProjectDiv(group.id)'));
    assert.ok(!webviewContent.includes('function getAddProjectDiv'));
    assert.ok(webviewContent.includes('class="settings-button" data-action="open-settings"'));
    assert.ok(webviewProjectScripts.includes("type: 'open-settings'"));
    assert.ok(webviewProjectScripts.includes('projectId,'));
    assert.ok(!webviewProjectScripts.includes('projectUri'));
    assert.ok(insideProjectClick.includes('projectDiv.hasAttribute("data-project-navigation")'));
    assert.ok(insideProjectClick.includes('openProject(dataId, ProjectOpenType.Default)'));
    assert.ok(
        insideProjectClick.indexOf('projectDiv.hasAttribute("data-project-navigation")')
            < insideProjectClick.indexOf('var currentWindow = e.ctrlKey || e.metaKey')
    );
    assert.ok(webviewProjectScripts.includes("message.type === 'ai-session-attention-projects-updated'"));
    assert.ok(webviewProjectScripts.includes('syncAiSessionAttentionRows(projectDiv, summary ? summary.sessions : [])'));
    assert.ok(webviewProjectScripts.includes(".project[data-attention-project-key]"));
    assert.ok(webviewProjectScripts.includes("project-ai-attention-badge"));
    assert.ok(styles.includes('.project-ai-attention-badge'));
    assert.ok(webviewContent.includes('getAttentionProjectKey(project.attentionProjectPath || project.path)'));
    assert.ok(webviewContent.includes('class="ai-session-attention-indicator"'));
    assert.ok(styles.includes('.ai-session-attention-indicator'));
    assert.ok(evaluateAttentionFunction.includes('getAttentionProjectKey(project.attentionProjectPath || project.path)'));
    assert.ok(evaluateAttentionFunction.includes('projectId: projectKey'));
    assert.ok(evaluateAttentionFunction.includes('observedAtMs: attention.stateChangedAt'));
    assert.ok(evaluateAttentionFunction.includes('if (!terminal ||'));
    assert.ok(evaluateAttentionFunction.includes('getLifecycleSignals'));
    assert.ok(evaluateAttentionFunction.includes('terminal-exit:'));
    assert.ok(!evaluateAttentionFunction.includes('activityToken'));
    assert.ok(!evaluateAttentionFunction.includes('projectId: project.id'));
    assert.ok(dashboard.includes('runStartedAtMs: Date.parse(pendingTerminal.createdAt)'));
    assert.ok(dashboard.includes('runStartedAtMs: Date.now()'));
    assert.ok(dashboard.includes("type: 'ai-session-attention-projects-updated'"));
    assert.ok(dashboard.includes('sessionEvents: getAiSessionAttentionRecoverySessionEvents()'));
    assert.ok(webviewProjectScripts.includes('message.sessionEvents'));
    assert.ok(dashboard.includes("case 'open-settings':"));
    assert.ok(settingsFunction.includes("executeCommand('workbench.action.openSettings', '@ext:hzcheng.project-steward')"));
    assert.ok(!settingsFunction.includes('showQuickPick'));
    assert.ok(!settingsFunction.includes('ai-session-terminal-mode-planned'));
    assert.ok(dashboard.includes('new AiSessionPinStore(context.globalStoragePath)'));
    assert.ok(dashboard.includes('new ActiveAiSessionTerminalHighlighter'));
    assert.ok(dashboard.includes('vscode.window.onDidChangeActiveTerminal'));
    assert.match(dashboard, /onDidChangeActiveTerminal\(\(\) => \{[\s\S]*?activeAiSessionTerminalHighlighter\.sync\(\);[\s\S]*?void evaluateAiSessionAttention\(\);[\s\S]*?\}\)/);
    assert.match(dashboard, /onDidChangeWindowState\(windowState => \{[\s\S]*?void evaluateAiSessionAttention\(\);[\s\S]*?\}\)/);
    assert.ok(dashboard.includes("case 'request-active-ai-session-terminal':"));
    assert.ok(dashboard.includes("type: 'active-ai-session-terminal-changed'"));
    assert.ok(webviewProjectScripts.includes("type: 'request-active-ai-session-terminal'"));
    assert.ok(webviewProjectScripts.includes("message.type === 'active-ai-session-terminal-changed'"));
    assert.ok(webviewProjectScripts.includes('data-ai-session-active-terminal'));
    assert.ok(dashboard.includes('activeAiSessionTerminalHighlighter.handleTerminalClosed(terminal)'));
    assert.ok(dashboard.includes('activeAiSessionTerminalHighlighter.sync()'));
    assert.ok(dashboard.includes('activeAiSessionTerminalHighlighter.setVisible(webviewView.visible)'));
    const activeTerminalCandidatesFunction = extractFunctionBody(dashboard, 'getAiSessionTerminalCandidates');
    assert.ok(activeTerminalCandidatesFunction.includes('getRegisteredAiSessionProvider(providerId).service.getSessions().sessions'));
    assert.ok(!activeTerminalCandidatesFunction.includes('AI_SESSION_PROVIDER_IDS'));
    assert.ok(!activeTerminalCandidatesFunction.includes('getOpenProjects('));
    assert.ok(!activeTerminalCandidatesFunction.includes('activeAiSessionProvider'));
    assert.ok(!dashboard.includes('prunePinnedAiSessionKeys'));
    assert.ok(extractFunctionBody(dashboard, 'deletePinnedAiSession').includes("logError('Failed to delete the pinned AI session.'"));
    assert.ok(dashboard.includes("case 'archive-ai-sessions':"));
    assert.ok(dashboard.includes('AiSessionBatchArchiveCompletedMessage'));
    assert.ok(singleArchiveFunction.includes('archiveAiSessionItem(providerId, sessionId)'));
    assert.ok(batchArchiveFunction.includes('executeBatchAiSessionArchiveRequest('));
    assert.strictEqual((singleArchiveFunction.match(/activeAiSessionTerminalHighlighter\.sync\(\)/g) || []).length, 1);
    assert.strictEqual((batchArchiveFunction.match(/activeAiSessionTerminalHighlighter\.sync\(\)/g) || []).length, 1);
    assert.ok(!archiveItemFunction.includes('activeAiSessionTerminalHighlighter.sync()'));
    assert.ok(!archiveItemFunction.includes('refreshAiSessionViewsIncrementally()'));
    assert.ok(!archiveItemFunction.includes('invalidateAiSessionCache('));
    assert.ok(archiveItemFunction.includes('executeBatchAiSessionArchiveItem('));
    assert.strictEqual((batchArchiveLogFunction.match(/formatBatchAiSessionIdForLog\(sessionId\)/g) || []).length, 3);
    assert.ok(webviewContent.includes('.settings-button,'));
    assert.ok(styles.includes('max-width: calc(100% - 76px);'));
    assert.ok(styles.includes('margin-left: 4px;'));
    assert.ok(styles.includes('width: 18px;'));
    assert.ok(styles.includes('height: 18px;'));
    assert.ok(styles.includes('width: 17px;'));
    assert.ok(styles.includes('height: 17px;'));
    assert.ok(styles.includes('fill: currentColor;'));
    assert.ok(styles.includes('.codex-session-pin {'));
    assert.ok(styles.includes('stroke: currentColor;'));
    assert.ok(styles.includes('opacity: 1;'));
    assert.ok(!styles.includes('opacity: 0.86;'));
    assert.ok(webviewContent.includes('width: 18px;'));
    assert.ok(webviewContent.includes('height: 18px;'));
    assert.ok(webviewIcons.includes('<svg viewBox="0 0 448 512">'));
    assert.ok(webviewIcons.includes('M19.43 12.98'));
    assert.ok(webviewIcons.includes('stroke-linecap="round"'));
    assert.ok(webviewContent.includes('class="codex-session-actions"'));
    assert.ok(webviewContent.includes('<button type="button" class="codex-session-pin'));
    assert.ok(webviewContent.includes('<button type="button" class="codex-session-archive"'));
    assert.ok(webviewContent.includes('data-action="manage-ai-sessions"'));
    assert.ok(webviewContent.includes('${Icons.manage}'));
    assert.ok(webviewContent.includes('aria-label="${label}"'));
    assert.ok(webviewContent.includes('aria-pressed="false"'));
    assert.ok(webviewIcons.includes('export const manage = `'));
    assert.ok(webviewContent.includes('class="ai-session-batch-checkbox"'));
    assert.ok(!webviewContent.includes('class="ai-session-batch-checkbox" aria-label="Select ${sessionName}" tabindex="-1"'));
    assert.ok(webviewContent.includes('data-action="select-unpinned-ai-sessions"'));
    assert.ok(webviewContent.includes('data-action="select-unpinned-ai-sessions" title="Select all unpinned sessions" aria-label="Select all unpinned sessions">All</button>'));
    assert.ok(!webviewContent.includes('>Select unpinned</button>'));
    assert.ok(webviewContent.includes('data-action="clear-ai-session-selection"'));
    assert.ok(!webviewContent.includes('data-action="cancel-ai-session-management"'));
    assert.ok(!webviewProjectScripts.includes('cancelManagementAction'));
    assert.ok(webviewContent.includes('data-action="archive-selected-ai-sessions"'));
    assert.ok(!webviewContent.includes('codex-session-meta-chip'));
    assert.ok(webviewContent.includes("join(' · ')"));
    assert.ok(styles.includes('.codex-session-actions'));
    assert.ok(styles.includes('[data-ai-session-managing]'));
    assert.ok(styles.includes('grid-template-columns: minmax(0, 1fr) 24px 24px;'));
    assert.ok(styles.includes('.ai-session-manage-button[aria-pressed="true"]'));
    assert.ok(styles.includes('.ai-session-batch-actions'));
    assert.ok(compiledStyles.includes('.ai-session-batch-actions'));
    assert.ok(styles.includes('[data-ai-session-active-terminal]'));
    assert.ok(compiledStyles.includes('[data-ai-session-active-terminal]'));
    assert.ok(styles.includes('[data-session-pinned] .codex-session-actions'));
    assert.ok(styles.includes('&::before'));
    assert.ok(!styles.includes('.codex-session-meta-chip'));
    assert.ok(styles.includes('box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04)'));
    assert.ok(!styles.includes('color-mix('));
    assert.ok(!extractScssBlock(styles, '.codex-session-row').includes('linear-gradient(90deg'));
    assert.ok(!extractScssBlock(styles, '.codex-session-row').includes('translateY(-1px)'));
    assert.ok(webviewContent.includes('visibleRows * 42'));
    assert.ok(styles.includes('calc(3 * 42px + 2 * 2px)'));
    assert.ok(!packageJson.contributes.configuration.properties['projectSteward.aiSessionTerminalMode']);
    assert.ok(withAiSessionsFunction.includes('let aliases = getAiSessionAliases();'));
    assert.ok(!withAiSessionsFunction.includes('pruneAiSessionAliases('));
    assert.ok(!dashboard.includes('function pruneAiSessionAliases('));
    assert.strictEqual(packageJson.contributes.configuration.properties['projectSteward.storeProjectsInSettings'].default, true);
    assert.strictEqual(packageJson.contributes.configuration.properties['projectSteward.applyProjectColorToWindow'].default, false);
    assert.strictEqual(packageJson.contributes.configuration.properties['projectSteward.maxVisibleAiSessions'].default, 3);
    assert.strictEqual(packageJson.contributes.configuration.properties['projectSteward.maxVisibleAiSessions'].minimum, 1);
    assert.ok(dashboard.includes("ProjectWindowColorService"));
    assert.ok(dashboard.includes('resolveCurrentWorkspaceProjectIds('));
    assert.ok(dashboard.includes('findSavedProjectForOpenProject'));
    assert.ok(dashboard.includes('get currentWorkspaceProjectIds() { return getCurrentWorkspaceProjectIds() }'));
    assert.ok(webviewContent.includes('withCurrentWorkspaceState('));
    assert.ok(webviewContent.includes('infos.currentWorkspaceProjectIds || []'));
    assert.ok(webviewContent.includes('getFavoriteProjectsInOrder('));
    assert.ok(dashboard.includes("case 'reordered-favorites':"));
    assert.ok(dashboard.includes('withFavoriteProjectOrder(groups, projectIds)'));
    assert.ok(dashboard.includes('withToggledProjectFavorite(groups, projectId)'));
    assert.ok(dashboard.includes("function applyProjectColorToCurrentWindow(project: Project = null)"));
    assert.ok(dashboard.includes("project?.showSaveAction"));
    assert.ok(dashboard.includes("syncProjectColorToCurrentWindow(project)"));
    assert.ok(projectWindowColorService.includes("PROJECT_COLOR_TO_WINDOW_KEY = 'applyProjectColorToWindow'"));
    assert.ok(projectWindowColorService.includes("PROJECT_WINDOW_COLOR_BACKUP_KEY"));
    assert.ok(projectWindowColorService.includes("WORKBENCH_SECTION = 'workbench'"));
    assert.ok(projectWindowColorService.includes("COLOR_CUSTOMIZATIONS_KEY = 'colorCustomizations'"));
    assert.ok(projectWindowColorService.includes("syncProjectColorToCurrentWindow(project: Project)"));
    assert.ok(projectWindowColorService.includes("restoreProjectWindowColors(project: Project = null)"));
    assert.ok(projectWindowColorService.includes("restoreBackedUpProjectWindowColors"));
    assert.ok(projectWindowColorService.includes("removeGeneratedProjectWindowColors"));
    assert.ok(projectWindowColorService.includes("let originalColorCustomizations = this.removeGeneratedProjectWindowColors(colorCustomizations, project);"));
    assert.ok(projectWindowColorService.includes("await this.backupProjectWindowColors(originalColorCustomizations);"));
    assert.ok(projectWindowColorService.includes("getLegacyWindowColorCustomizations"));
    assert.ok(projectWindowColorService.includes("let auraPalette = this.getAuraPalette(color);"));
    assert.ok(projectWindowColorService.includes("'titleBar.activeBackground': auraPalette.titleBar"));
    assert.ok(projectWindowColorService.includes("'statusBar.background': auraPalette.statusBar"));
    assert.ok(projectWindowColorService.includes("'statusBarItem.remoteBackground': auraPalette.remote"));
    assert.ok(projectWindowColorService.includes("'activityBar.activeBorder': color"));
    assert.ok(projectWindowColorService.includes("'activityBar.activeBackground': auraPalette.activityActive"));
    assert.ok(projectWindowColorService.includes("'commandCenter.activeBorder': auraPalette.commandBorder"));
    assert.ok(!extractMethodBody(projectWindowColorService, 'getWindowColorCustomizations').includes("'activityBar.background'"));
    assert.ok(webviewContent.includes('style="${projectStyle}"'));
    assert.ok(webviewContent.includes("isReadOnlyProject || isProjectNavigation ? ' data-readonly-project' : ''"));
    assert.ok(webviewContent.includes("project.isCurrentWorkspace ? ' data-current-workspace' : ''"));
    assert.ok(styles.includes('--project-color'));
    assert.ok(styles.includes('.project-aura'));
    assert.ok(currentProjectStyleBlock.includes('--vscode-list-inactiveSelectionBackground'));
    assert.ok(currentProjectStyleBlock.includes('var(--vscode-focusBorder)'));
    assert.ok(currentProjectStyleBlock.includes('box-shadow'));
    assert.ok(compiledCurrentProjectStyleBlock.includes('var(--vscode-focusBorder)'));
    assert.ok(!currentProjectStyleBlock.includes('animation'));
    assert.ok(styles.indexOf('&[data-current-workspace]') > styles.indexOf('&[data-codex-expanded]:hover'));
    assert.ok(compiledStyles.indexOf('.project[data-current-workspace]') > compiledStyles.indexOf('.project[data-open-project][data-codex-expanded]:hover'));
    assert.ok(projectBorderBlock.includes('top: 31%'));
    assert.ok(projectBorderBlock.includes('bottom: 31%'));
    assert.ok(projectBorderBlock.includes('height: auto'));
    assert.deepStrictEqual(projectBorderBlock.match(/\bheight\s*:[^;]+/g), ['height: auto']);
    assert.ok(projectBorderHoverBlock.includes('top: 26%'));
    assert.ok(projectBorderHoverBlock.includes('bottom: 26%'));
    assert.ok(!/\bheight\s*:/.test(projectBorderHoverBlock));
    assert.ok(!/\bheight\s*:/.test(expandedProjectBorderBlock));
    assert.ok(compiledProjectBorderBlock.includes('top:31%'));
    assert.ok(compiledProjectBorderBlock.includes('bottom:31%'));
    assert.ok(compiledProjectBorderBlock.includes('height:auto'));
    assert.deepStrictEqual(compiledProjectBorderBlock.match(/\bheight\s*:[^;]+/g), ['height:auto']);
    assert.ok(compiledProjectBorderHoverBlock.includes('top:26%'));
    assert.ok(compiledProjectBorderHoverBlock.includes('bottom:26%'));
    assert.ok(!/\bheight\s*:/.test(compiledProjectBorderHoverBlock));
    assert.ok(!/\bheight\s*:/.test(compiledExpandedProjectBorderBlock));
    assert.ok(webviewContent.includes('--steward-ai-session-list-max-height: ${getAiSessionListMaxHeight(config)}px;'));
    assert.ok(webviewContent.includes('Number.isFinite(visibleRows)'));
    assert.ok(styles.includes('height: var(--steward-ai-session-list-max-height, calc(3 * 42px + 2 * 2px));'));
}

function runCurrentWorkspaceRenderingChecks() {
    const config = {
        get: (key, defaultValue) => defaultValue,
        displayProjectPath: false,
        searchIsActiveByDefault: false,
        showAddGroupButtonTile: false,
    };
    const html = webviewContentModule.getStewardContent(
        { extensionPath: '/extension' },
        {
            cspSource: 'test-source',
            asWebviewUri: uri => uri.toString(),
        },
        [{
            id: 'group',
            groupName: 'Work',
            collapsed: false,
            projects: [
                { id: 'saved', name: 'Saved', path: '/work/saved', color: '#00aacc', favorite: true },
                { id: 'other', name: 'Other', path: '/work/other', color: '#ccaa00' },
            ],
        }],
        {
            config,
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            otherStorageHasData: false,
            currentWorkspaceProjectIds: ['saved'],
            openProjects: [
                {
                    id: '__openProjects-0', name: 'Saved', path: '/work/saved', color: '#00aacc',
                    openProjectCardKind: 'current', codexSessions: [{ id: 'session', name: 'Session' }],
                },
                {
                    id: '__openProjectNavigation-other', name: 'Other Window', path: '/work/other-window',
                    description: 'Other workspace', remoteType: models.ProjectRemoteType.SSH,
                    color: 'red;" data-injected="yes', openProjectCardKind: 'projectNavigation', showSaveAction: true,
                    favorite: true, aiSessionAttentionCount: 2,
                    codexSessions: [{ id: 'leaked-session', name: 'Leaked Session' }],
                },
            ],
        },
        true
    );
    const getCardTags = projectId => html.match(new RegExp(`<div class="project"[^>]*data-id="${projectId}"[^>]*>`, 'g')) || [];
    const savedTags = getCardTags('saved');
    const otherTags = getCardTags('other');
    const openTags = getCardTags('__openProjects-0');
    const navigationTags = getCardTags('__openProjectNavigation-other');

    assert.strictEqual(savedTags.length, 2);
    assert.ok(savedTags.every(tag => tag.includes('data-current-workspace')));
    assert.strictEqual(otherTags.length, 1);
    assert.ok(!otherTags[0].includes('data-current-workspace'));
    assert.strictEqual(openTags.length, 1);
    assert.ok(openTags[0].includes('data-current-workspace'));
    assert.strictEqual(navigationTags.length, 1);
    assert.ok(!navigationTags[0].includes('data-current-workspace'));
    assert.ok(!navigationTags[0].includes('data-open-project'));
    assert.ok(navigationTags[0].includes('data-project-navigation'));
    assert.ok(navigationTags[0].includes('data-readonly-project'));
    assert.ok(navigationTags[0].includes('title="Switch to this project"'));
    assert.match(html, /data-open-project/);
    assert.match(html, /data-project-navigation/);
    assert.match(html, /title="Switch to this project"/);
    assert.strictEqual((html.match(/class="codex-sessions"/g) || []).length, 1);
    assert.ok(!navigationTags[0].includes('data-attention-project-key'));
    assert.ok(!navigationTags[0].includes('data-has-favorite-toggle'));
    assert.ok(!navigationTags[0].includes('data-has-save-action'));
    const navigationCardStart = html.indexOf(navigationTags[0]);
    const navigationCardEnd = html.indexOf('</div>\n</div>', navigationCardStart);
    const navigationHtml = html.slice(navigationCardStart, navigationCardEnd);
    assert.ok(!navigationHtml.includes('project-save-badge'));
    assert.ok(!navigationHtml.includes('project-favorite-badge'));
    assert.ok(!navigationHtml.includes('project-actions-wrapper'));
    assert.ok(!navigationHtml.includes('project-ai-attention-badge'));
    assert.ok(!navigationHtml.includes('project-codex-badge'));
    assert.ok(!navigationHtml.includes('class="codex-sessions"'));
    assert.ok(!navigationHtml.includes('Leaked Session'));
    assert.ok(!html.includes('data-injected'));
    assert.ok(!navigationHtml.includes('red;'));
    assert.ok(navigationHtml.includes('<div class="project-border" style=""></div>'));
    assert.ok(openTags[0].includes('style="--project-color: #00aacc;"'));
    assert.ok(html.includes('<div class="project-border" style="background: #00aacc;"></div>'));
    assert.ok(navigationHtml.includes('title="SSH Project"'));
    assert.match(navigationHtml, /class="project-description" title="Other workspace">\s*Other workspace\s*<\/p>/);
}

function runFavoriteRenderingChecks() {
    const config = {
        get: (key, defaultValue) => defaultValue,
        displayProjectPath: false,
        searchIsActiveByDefault: false,
        showAddGroupButtonTile: false,
    };
    const html = webviewContentModule.getStewardContent(
        { extensionPath: '/extension' },
        {
            cspSource: 'test-source',
            asWebviewUri: uri => uri.toString(),
        },
        [{
            id: 'group',
            groupName: 'Work',
            collapsed: false,
            projects: [
                { id: 'favorite-a', name: 'Favorite A', path: '/work/a', color: '#00aacc', favorite: true, favoriteOrder: 1 },
                { id: 'favorite-b', name: 'Favorite B', path: '/work/b', color: '#ccaa00', favorite: true, favoriteOrder: 0 },
                { id: 'plain', name: 'Plain', path: '/work/plain', color: '#888888' },
            ],
        }],
        {
            config,
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            otherStorageHasData: false,
            openProjects: [],
        },
        true
    );
    const renderedProjectIds = Array.from(html.matchAll(/<div class="project"[^>]*data-id="([^"]+)"[^>]*>/g))
        .map(match => match[1]);

    assert.deepStrictEqual(renderedProjectIds, [
        'favorite-b',
        'favorite-a',
        'favorite-a',
        'favorite-b',
        'plain',
    ]);
    const favoriteContainer = html.match(/<div class="project-container"([^>]*)>\s*<div class="project"[^>]*data-id="favorite-b"/);
    assert.ok(favoriteContainer);
    assert.ok(!favoriteContainer[1].includes('data-nodrag'));
}

function runAttentionProjectRenderingChecks() {
    const config = {
        get: (key, defaultValue) => defaultValue,
        displayProjectPath: false,
        searchIsActiveByDefault: false,
        showAddGroupButtonTile: false,
    };
    const projectKey = attentionProject.getAttentionProjectKey('/work/remote-repo');
    const html = webviewContentModule.getStewardContent(
        { extensionPath: '/extension' },
        {
            cspSource: 'test-source',
            asWebviewUri: uri => uri.toString(),
        },
        [{
            id: 'group',
            groupName: 'Work',
            collapsed: false,
            projects: [{
                id: 'saved-remote',
                name: 'Remote Repo',
                path: '/work/remote-repo',
                color: '#00aacc',
                aiSessionAttentionCount: 2,
                aiSessionAttentionEventIds: ['event-1', 'event-2'],
            }],
        }],
        {
            config,
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            otherStorageHasData: false,
            openProjects: [],
        },
        true
    );

    assert.ok(html.includes(`data-attention-project-key="${projectKey}"`));
    assert.ok(html.includes('class="project-ai-attention-badge"'));
    assert.ok(html.includes('>2</span>'));
    assert.ok(!html.includes('/work/remote-repo" data-attention-project-key'));

    const openProjectHtml = webviewContentModule.getStewardContent(
        { extensionPath: '/extension' },
        { cspSource: 'test-source', asWebviewUri: uri => uri.toString() },
        [],
        {
            config,
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            otherStorageHasData: false,
            openProjects: [{
                id: 'open-project',
                name: 'Open Repo',
                path: '/work/open-repo',
                color: '#00aacc',
                aiSessionAttentionCount: 2,
                codexSessions: [{
                    id: 'codex-one',
                    name: 'Codex One',
                    attention: { eventId: 'local-event', reason: 'input-required', unread: true },
                }],
            }],
        },
        true
    );
    assert.ok(!openProjectHtml.includes('class="project-ai-attention-badge"'));
    assert.ok(openProjectHtml.includes('class="project-codex-badge has-attention"'));
    assert.ok(openProjectHtml.includes('class="ai-session-attention-count">1</b>'));
}

function runFavoriteDndChecks() {
    const sourcePath = path.join(__dirname, '..', 'src', 'webview', 'webviewDnDScripts.js');
    const generatedPath = path.join(__dirname, '..', 'media', 'webviewDnDScripts.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const context = {};
    vm.runInNewContext(source, context);

    const createContainer = kind => ({
        closest: selector => {
            if (selector === '[data-system-group="__favorites"]') {
                return kind === 'favorites' ? {} : null;
            }
            if (selector === '[data-virtual-group]') {
                return kind === 'favorites' || kind === 'open-projects' ? {} : null;
            }
            return null;
        },
    });
    const draggable = { hasAttribute: () => false };
    const noDrag = { hasAttribute: attribute => attribute === 'data-nodrag' };
    const favorites = createContainer('favorites');
    const otherFavorites = createContainer('favorites');
    const openProjects = createContainer('open-projects');
    const ordinary = createContainer('ordinary');
    const ordinaryTwo = createContainer('ordinary');

    assert.strictEqual(context.canMoveProject(draggable, favorites), true);
    assert.strictEqual(context.canMoveProject(draggable, openProjects), false);
    assert.strictEqual(context.canMoveProject(draggable, ordinary), true);
    assert.strictEqual(context.canMoveProject(noDrag, favorites), false);
    assert.strictEqual(context.canAcceptProject(favorites, favorites), true);
    assert.strictEqual(context.canAcceptProject(otherFavorites, favorites), false);
    assert.strictEqual(context.canAcceptProject(ordinary, favorites), false);
    assert.strictEqual(context.canAcceptProject(favorites, ordinary), false);
    assert.strictEqual(context.canAcceptProject(openProjects, ordinary), false);
    assert.strictEqual(context.canAcceptProject(ordinaryTwo, ordinary), true);
    assert.ok(source.includes("type: 'reordered-favorites'"));
    assert.strictEqual(fs.readFileSync(generatedPath, 'utf8'), source);

    const drakes = [];
    const messages = [];
    const ordinaryGroup = {
        getAttribute: attribute => attribute === 'data-group-id' ? 'group-one' : null,
        querySelectorAll: () => [
            { getAttribute: () => 'ordinary-a' },
            { getAttribute: () => 'ordinary-b' },
        ],
    };
    const runtimeContext = {
        document: {
            body: { classList: { add: () => {}, remove: () => {} } },
            querySelector: () => null,
            querySelectorAll: selector => selector.startsWith('.groups-wrapper >') ? [ordinaryGroup] : [],
        },
        window: {
            addEventListener: () => {},
            vscode: { postMessage: message => messages.push(message) },
        },
        dragula: (containers, options) => {
            const handlers = {};
            const drake = {
                dragging: false,
                cancel: () => {},
                on: (event, handler) => {
                    handlers[event] = handler;
                    return drake;
                },
            };
            drakes.push({ containers, options, handlers, drake });
            return drake;
        },
        autoScroll: () => ({}),
    };
    vm.runInNewContext(source, runtimeContext);
    runtimeContext.initDnD();

    assert.strictEqual(drakes.length, 2);
    const favoriteSource = {
        closest: selector => selector === '[data-system-group="__favorites"]' ? {} : null,
        querySelectorAll: () => [
            { getAttribute: () => 'favorite-b' },
            { getAttribute: () => 'favorite-a' },
        ],
    };
    drakes[0].handlers.drop({}, favoriteSource, favoriteSource);
    drakes[0].handlers.drop({}, ordinary, ordinary);

    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages)), [
        { type: 'reordered-favorites', projectIds: ['favorite-b', 'favorite-a'] },
        {
            type: 'reordered-projects',
            groupOrders: [{ groupId: 'group-one', projectIds: ['ordinary-a', 'ordinary-b'] }],
        },
    ]);
}

function runBatchAiSessionWebviewChecks() {
    const sourcePath = path.join(__dirname, '..', 'src', 'webview', 'webviewProjectScripts.js');
    const generatedPath = path.join(__dirname, '..', 'media', 'webviewProjectScripts.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.strictEqual(fs.readFileSync(generatedPath, 'utf8'), source);
    const messages = [];
    const eventListeners = {};
    const windowEventListeners = {};
    const timeoutCallbacks = [];
    const createSessionRow = (provider, sessionId) => {
        const attributes = new Set();
        const attributeValues = {};
        const classes = new Set();
        let attentionIndicator = null;
        const row = {
            provider,
            sessionId,
            project: null,
            classList: {
                add: className => classes.add(className),
                remove: className => classes.delete(className),
            },
            getAttribute: attribute => {
                if (attribute === 'data-session-provider') return provider;
                if (attribute === 'data-session-id') return sessionId;
                return attributeValues[attribute] || null;
            },
            hasAttribute: attribute => attributes.has(attribute),
            insertBefore: indicator => {
                attentionIndicator = indicator;
                indicator.remove = () => { attentionIndicator = null; };
            },
            querySelector: selector => selector === '.ai-session-attention-indicator' ? attentionIndicator : null,
            removeAttribute: attribute => {
                attributes.delete(attribute);
                delete attributeValues[attribute];
            },
            setAttribute: (attribute, value) => {
                attributes.add(attribute);
                attributeValues[attribute] = value;
            },
            toggleAttribute: (attribute, force) => {
                if (force) {
                    attributes.add(attribute);
                } else {
                    attributes.delete(attribute);
                }
            },
            closest: selector => {
                if (selector === '.codex-session-row[data-session-id]') return row;
                if (selector === '.project' || selector === '.project[data-id]') return row.project;
                return null;
            },
        };
        return row;
    };
    const createProject = (projectId, provider) => {
        const attributes = new Set(['data-open-project']);
        let rows = [];
        let replacementRows = null;
        const sessionSection = {};
        Object.defineProperty(sessionSection, 'outerHTML', {
            set: () => {
                if (replacementRows) {
                    rows = replacementRows;
                    replacementRows = null;
                }
            },
        });
        const manageButton = {
            ariaPressed: 'false',
            disabled: false,
            setAttribute: (attribute, value) => {
                if (attribute === 'aria-pressed') manageButton.ariaPressed = value;
            },
        };
        const batchButtons = [
            'select-unpinned-ai-sessions',
            'clear-ai-session-selection',
            'archive-selected-ai-sessions',
        ].map(action => ({ action, disabled: false }));
        return {
            batchButtons,
            manageButton,
            get rows() { return rows; },
            replaceRowsOnNextUpdate: nextRows => { replacementRows = nextRows; },
            getAttribute: attribute => attribute === 'data-id' ? projectId : null,
            hasAttribute: attribute => attributes.has(attribute),
            removeAttribute: attribute => attributes.delete(attribute),
            setAttribute: attribute => attributes.add(attribute),
            toggleAttribute: (attribute, force) => {
                if (force) {
                    attributes.add(attribute);
                } else {
                    attributes.delete(attribute);
                }
            },
            querySelector: selector => {
                if (selector === 'select[data-action="select-ai-provider"]') {
                    return { value: provider };
                }
                if (selector === '[data-action="archive-selected-ai-sessions"]') {
                    return batchButtons.find(button => button.action === 'archive-selected-ai-sessions');
                }
                if (selector === '[data-action="manage-ai-sessions"]') {
                    return manageButton;
                }
                if (selector === '.codex-sessions') {
                    return sessionSection;
                }
                return null;
            },
            querySelectorAll: selector => {
                if (selector === '.ai-session-batch-actions button') return batchButtons;
                if (selector === '.codex-session-row[data-session-id]') return rows;
                return [];
            },
        };
    };
    const projectA = createProject('project-a', 'codex');
    const projectB = createProject('project-b', 'kimi');
    const activeRow = createSessionRow('codex', 'active-session');
    const otherCodexRow = createSessionRow('codex', 'other-session');
    const sameIdOtherProviderRow = createSessionRow('kimi', 'active-session');
    projectA.replaceRowsOnNextUpdate([activeRow, otherCodexRow]);
    projectA.querySelector('.codex-sessions').outerHTML = '';
    projectB.replaceRowsOnNextUpdate([sameIdOtherProviderRow]);
    projectB.querySelector('.codex-sessions').outerHTML = '';
    const projects = [projectA, projectB];
    let attentionBadge = null;
    const attentionProjectClasses = new Set();
    const attentionRow = createSessionRow('codex', 'attention-session');
    attentionRow.project = projectA;
    let openAttentionBadge = { remove: () => { openAttentionBadge = null; } };
    let openAttentionBadgeInsertions = 0;
    const attentionProjectCard = {
        getAttribute: attribute => attribute === 'data-attention-project-key' ? 'attention-project-a' : null,
        hasAttribute: () => false,
        classList: {
            add: className => attentionProjectClasses.add(className),
            remove: className => attentionProjectClasses.delete(className),
        },
        querySelector: selector => selector === '.project-ai-attention-badge' ? attentionBadge : null,
        querySelectorAll: selector => selector === '.codex-session-row[data-session-id]' ? [attentionRow] : [],
        insertAdjacentHTML: () => {
            const badgeClasses = new Set();
            attentionBadge = {
                textContent: '',
                title: '',
                classList: {
                    add: className => badgeClasses.add(className),
                    remove: className => badgeClasses.delete(className),
                },
                setAttribute: (attribute, value) => {
                    if (attribute === 'title') attentionBadge.title = value;
                },
                remove: () => { attentionBadge = null; },
            };
        },
    };
    const openAttentionProjectCard = {
        getAttribute: attribute => attribute === 'data-attention-project-key' ? 'attention-project-a' : null,
        hasAttribute: attribute => attribute === 'data-open-project',
        classList: { add: () => {}, remove: () => {} },
        querySelector: selector => selector === '.project-ai-attention-badge' ? openAttentionBadge : null,
        querySelectorAll: () => [],
        insertAdjacentHTML: () => { openAttentionBadgeInsertions++; },
    };
    const context = {
        document: {
            body: {
                classList: { toggle: () => {} },
                style: { setProperty: () => {} },
            },
            addEventListener: (event, listener) => { eventListeners[event] = listener; },
            getElementById: () => null,
            createElement: () => ({
                className: '',
                title: '',
                setAttribute: () => {},
                remove: () => {},
            }),
            querySelector: () => null,
            querySelectorAll: selector => {
                if (selector === '.project[data-open-project][data-id]') {
                    return projects;
                }
                if (selector === '.project[data-ai-session-managing], .project[data-ai-session-pending]') {
                    return projects.filter(project => project.hasAttribute('data-ai-session-managing')
                        || project.hasAttribute('data-ai-session-pending'));
                }
                if (selector === '.codex-session-row[data-session-id]') {
                    return projects.flatMap(project => project.rows);
                }
                if (selector === '.project[data-attention-project-key]') {
                    return [attentionProjectCard, openAttentionProjectCard];
                }
                return [];
            },
        },
        window: {
            addEventListener: (event, listener) => { windowEventListeners[event] = listener; },
            requestAnimationFrame: callback => callback(),
            setTimeout: callback => timeoutCallbacks.push(callback),
            vscode: { postMessage: message => messages.push(message) },
        },
    };

    vm.runInNewContext(source, context);
    context.initProjects();

    const messageListenerIndex = source.indexOf("window.addEventListener('message', onWindowMessage)");
    const activeTerminalRequestIndex = source.indexOf("type: 'request-active-ai-session-terminal'");
    assert.notStrictEqual(messageListenerIndex, -1);
    assert.notStrictEqual(activeTerminalRequestIndex, -1);
    assert.ok(messageListenerIndex < activeTerminalRequestIndex);
    assert.ok(windowEventListeners.message);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.shift())), {
        type: 'request-active-ai-session-terminal',
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.shift())), {
        type: 'request-ai-session-attention-state',
    });
    messages.length = 0;

    const navigationProject = {
        getAttribute: attribute => attribute === 'data-id' ? '__openProjectNavigation-other' : null,
        hasAttribute: attribute => attribute === 'data-project-navigation' || attribute === 'data-readonly-project',
    };
    const navigationTarget = {
        closest: selector => selector === '.project' || selector === '.project[data-id]'
            ? navigationProject
            : null,
    };
    eventListeners.click({ button: 0, ctrlKey: true, metaKey: false, target: navigationTarget });
    eventListeners.click({ button: 0, ctrlKey: false, metaKey: true, target: navigationTarget });
    eventListeners.mousedown({ button: 1, ctrlKey: false, metaKey: false, target: navigationTarget });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages)), [
        {
            type: 'selected-project',
            projectId: '__openProjectNavigation-other',
            projectOpenType: 0,
        },
        {
            type: 'selected-project',
            projectId: '__openProjectNavigation-other',
            projectOpenType: 0,
        },
        {
            type: 'selected-project',
            projectId: '__openProjectNavigation-other',
            projectOpenType: 0,
        },
    ]);
    assert.ok(messages.every(message => !Object.prototype.hasOwnProperty.call(message, 'uri')));
    messages.length = 0;

    attentionRow.setAttribute('data-ai-session-attention', '');
    attentionRow.setAttribute('data-session-event-id', 'full-owner-event-a');
    windowEventListeners.message({ data: {
        type: 'ai-session-attention-state',
        eventIds: ['full-owner-event-a', 'full-owner-event-b', 'existing-event'],
        sessionEvents: [{
            sessionKey: 'codex:attention-session',
            eventIds: ['full-owner-event-a', 'full-owner-event-b'],
        }],
    } });
    messages.length = 0;
    eventListeners.click({ button: 0, target: attentionRow });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages[0])), {
        type: 'acknowledge-ai-session-attention',
        eventIds: ['full-owner-event-a', 'full-owner-event-b'],
    }, 'a fresh full render must acknowledge every current owner event before an incremental update');
    messages.length = 0;
    windowEventListeners.message({ data: {
        type: 'ai-session-attention-projects-updated',
        projects: [{
            projectKey: 'attention-project-a',
            attentionCount: 1,
            eventIds: ['existing-event'],
            sessions: [{ sessionKey: 'codex:attention-session', eventId: 'existing-event' }],
        }],
    } });
    assert.strictEqual(attentionBadge.textContent, '1');
    assert.strictEqual(attentionBadge.title, '1 AI session needs attention');
    assert.strictEqual(openAttentionBadge, null);
    assert.strictEqual(openAttentionBadgeInsertions, 0);
    assert.strictEqual(attentionRow.hasAttribute('data-ai-session-attention'), true);
    assert.ok(attentionRow.querySelector('.ai-session-attention-indicator'));
    assert.strictEqual(attentionProjectClasses.has('attention-animate'), false);

    windowEventListeners.message({ data: {
        type: 'ai-session-attention-projects-updated',
        projects: [{
            projectKey: 'attention-project-a',
            attentionCount: 2,
            eventIds: ['existing-event', 'new-event'],
            sessions: [
                { sessionKey: 'codex:attention-session', eventId: 'existing-event' },
                { sessionKey: 'codex:not-rendered', eventId: 'new-event' },
            ],
        }],
    } });
    assert.strictEqual(attentionBadge.textContent, '2');
    assert.strictEqual(attentionProjectClasses.has('attention-animate'), true);
    timeoutCallbacks.splice(0).forEach(callback => callback());
    assert.strictEqual(attentionProjectClasses.has('attention-animate'), false);

    windowEventListeners.message({ data: {
        type: 'ai-session-attention-projects-updated',
        projects: [{
            projectKey: 'attention-project-a',
            attentionCount: 2,
            eventIds: ['existing-event', 'new-event'],
            sessions: [
                { sessionKey: 'codex:attention-session', eventId: 'existing-event' },
                { sessionKey: 'codex:not-rendered', eventId: 'new-event' },
            ],
        }],
    } });
    assert.strictEqual(attentionProjectClasses.has('attention-animate'), false);
    windowEventListeners.message({ data: {
        type: 'ai-session-attention-projects-updated',
        projects: [],
    } });
    assert.strictEqual(attentionBadge, null);
    assert.strictEqual(attentionRow.hasAttribute('data-ai-session-attention'), false);
    assert.strictEqual(attentionRow.querySelector('.ai-session-attention-indicator'), null);

    windowEventListeners.message({ data: {
        type: 'ai-session-attention-projects-updated',
        projects: [{
            projectKey: 'attention-project-a', attentionCount: 1,
            eventIds: ['owner-event-a', 'owner-event-b'],
            sessions: [{
                sessionKey: 'codex:attention-session',
                eventId: 'owner-event-a',
                eventIds: ['owner-event-a', 'owner-event-b'],
            }],
        }],
    } });
    messages.length = 0;
    eventListeners.click({ button: 0, target: attentionRow });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages[0])), {
        type: 'acknowledge-ai-session-attention',
        eventIds: ['owner-event-a', 'owner-event-b'],
    });
    windowEventListeners.message({ data: {
        type: 'ai-session-attention-projects-updated',
        projects: [{
            projectKey: 'attention-project-a', attentionCount: 1,
            eventIds: ['later-generation'],
            sessions: [{ sessionKey: 'codex:attention-session', eventId: 'later-generation', eventIds: ['later-generation'] }],
        }],
    } });
    messages.length = 0;
    eventListeners.click({ button: 0, target: attentionRow });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages[0].eventIds)), ['later-generation']);
    messages.length = 0;

    windowEventListeners.message({ data: {
        type: 'active-ai-session-terminal-changed',
        provider: 'codex',
        sessionId: 'active-session',
    } });
    assert.strictEqual(activeRow.hasAttribute('data-ai-session-active-terminal'), true);
    assert.strictEqual(otherCodexRow.hasAttribute('data-ai-session-active-terminal'), false);
    assert.strictEqual(sameIdOtherProviderRow.hasAttribute('data-ai-session-active-terminal'), false);

    windowEventListeners.message({ data: {
        type: 'active-ai-session-terminal-changed',
        provider: null,
        sessionId: null,
    } });
    assert.strictEqual(activeRow.hasAttribute('data-ai-session-active-terminal'), false);

    windowEventListeners.message({ data: {
        type: 'active-ai-session-terminal-changed',
        provider: 'codex',
        sessionId: 'active-session',
    } });
    const replacementActiveRow = createSessionRow('codex', 'active-session');
    const replacementOtherRow = createSessionRow('codex', 'replacement-other');
    projectA.replaceRowsOnNextUpdate([replacementActiveRow, replacementOtherRow]);
    windowEventListeners.message({ data: {
        type: 'ai-sessions-updated',
        version: 1,
        sequence: 1,
        openProjects: [{
            projectId: 'project-a',
            expanded: true,
            aiSessionCount: 0,
            sessionSectionHtml: '<div class="codex-sessions">replacement</div>',
        }],
    } });
    assert.strictEqual(replacementActiveRow.hasAttribute('data-ai-session-active-terminal'), true);
    assert.strictEqual(replacementOtherRow.hasAttribute('data-ai-session-active-terminal'), false);

    const manager = context.window.__projectStewardBatchAiSessions;
    manager.enter('project-a', 'codex');
    manager.toggle('plain', false);
    manager.selectUnpinned([
        { id: 'plain', pinned: false },
        { id: 'pinned', pinned: true },
        { id: 'second', pinned: false },
    ]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(manager.snapshot())), {
        projectId: 'project-a', provider: 'codex', selectedIds: ['plain', 'second'], pending: false,
    });

    manager.toggle('pinned', true);
    manager.reconcile('project-a', 'codex', ['pinned', 'second']);
    assert.deepStrictEqual(Array.from(manager.snapshot().selectedIds), ['pinned', 'second']);

    manager.submit();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.pop())), {
        type: 'archive-ai-sessions', projectId: 'project-a', provider: 'codex',
        sessionIds: ['pinned', 'second'],
    });
    assert.strictEqual(manager.snapshot().pending, true);
    const archiveProjectA = {
        closest: selector => {
            if (selector === '.project' || selector === '.project[data-id]') return projectA;
            if (selector === '[data-action="archive-selected-ai-sessions"]') return archiveProjectA;
            return null;
        },
    };
    eventListeners.click({ button: 0, target: archiveProjectA });
    assert.ok(projectA.batchButtons.every(button => button.disabled));
    assert.strictEqual(projectA.manageButton.disabled, true);

    const pendingSnapshot = JSON.parse(JSON.stringify(manager.snapshot()));
    manager.enter('project-b', 'kimi');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(manager.snapshot())), pendingSnapshot);
    manager.submit();
    assert.strictEqual(messages.length, 0);

    projectA.toggleAttribute('data-ai-session-managing', true);
    projectA.toggleAttribute('data-ai-session-pending', true);
    const manageProjectB = {
        tagName: 'BUTTON',
        getAttribute: attribute => attribute === 'data-provider' ? 'kimi' : null,
        closest: selector => {
            if (selector === '.project' || selector === '.project[data-id]') {
                return projectB;
            }
            if (selector === '[data-action="manage-ai-sessions"][data-provider]') {
                return manageProjectB;
            }
            return null;
        },
    };
    eventListeners.click({ button: 0, target: manageProjectB });
    assert.strictEqual(projectA.hasAttribute('data-ai-session-managing'), true);
    assert.strictEqual(projectA.hasAttribute('data-ai-session-pending'), true);
    assert.strictEqual(projectB.hasAttribute('data-ai-session-managing'), false);
    assert.strictEqual(projectB.hasAttribute('data-ai-session-pending'), false);
    assert.strictEqual(messages.length, 0);

    windowEventListeners.message({ data: {
        type: 'ai-session-batch-archive-completed',
        projectId: 'project-a',
        provider: 'codex',
        status: 'cancelled',
    } });
    assert.strictEqual(manager.snapshot().pending, false);
    assert.deepStrictEqual(Array.from(manager.snapshot().selectedIds), ['pinned', 'second']);
    assert.ok(projectA.batchButtons.every(button => !button.disabled));
    assert.strictEqual(projectA.manageButton.disabled, false);

    manager.submit();
    manager.toggle('plain');
    manager.clear();
    manager.selectUnpinned([{ id: 'plain', pinned: false }]);
    assert.strictEqual(manager.snapshot().pending, true);
    assert.deepStrictEqual(Array.from(manager.snapshot().selectedIds), ['pinned', 'second']);
    manager.complete('rejected');
    assert.strictEqual(manager.snapshot().pending, false);
    assert.deepStrictEqual(Array.from(manager.snapshot().selectedIds), ['pinned', 'second']);

    manager.complete('finished');
    assert.strictEqual(manager.snapshot().projectId, null);

    const manageProjectA = {
        tagName: 'BUTTON',
        getAttribute: attribute => attribute === 'data-provider' ? 'codex' : null,
        closest: selector => {
            if (selector === '.project' || selector === '.project[data-id]') {
                return projectA;
            }
            if (selector === '[data-action="manage-ai-sessions"][data-provider]') {
                return manageProjectA;
            }
            return null;
        },
    };
    eventListeners.click({ button: 0, target: manageProjectA });
    assert.strictEqual(manager.snapshot().projectId, 'project-a');
    assert.strictEqual(projectA.manageButton.ariaPressed, 'true');
    eventListeners.click({ button: 0, target: manageProjectA });
    assert.strictEqual(manager.snapshot().projectId, null);
    assert.strictEqual(projectA.manageButton.ariaPressed, 'false');

    const providerChange = extractFunctionBody(source, 'selectAiSessionProvider');
    const providerExitIndex = providerChange.indexOf('exitAiSessionBatchManagement()');
    const providerMessageIndex = providerChange.indexOf("type: 'select-ai-session-provider'");
    assert.notStrictEqual(providerExitIndex, -1);
    assert.notStrictEqual(providerMessageIndex, -1);
    assert.ok(providerExitIndex < providerMessageIndex);
    const projectCollapse = extractFunctionBody(source, 'toggleCodexSessions');
    const collapseExitIndex = projectCollapse.indexOf('exitAiSessionBatchManagement()');
    const collapseMessageIndex = projectCollapse.indexOf("type: 'toggle-codex-sessions'");
    assert.notStrictEqual(collapseExitIndex, -1);
    assert.notStrictEqual(collapseMessageIndex, -1);
    assert.ok(collapseExitIndex < collapseMessageIndex);
}

function extractFunctionBody(source, functionName) {
    const signature = `function ${functionName}(`;
    const signatureIndex = source.indexOf(signature);
    assert.notStrictEqual(signatureIndex, -1);

    const openingBraceIndex = source.indexOf('{', signatureIndex);
    assert.notStrictEqual(openingBraceIndex, -1);

    let depth = 0;
    for (let i = openingBraceIndex; i < source.length; i++) {
        if (source[i] === '{') {
            depth++;
        } else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(openingBraceIndex + 1, i);
            }
        }
    }

    assert.fail(`Could not extract ${functionName}`);
}

function extractMethodBody(source, methodName) {
    const signatureIndex = source.indexOf(`${methodName}(`);
    assert.notStrictEqual(signatureIndex, -1);

    const openingBraceIndex = source.indexOf('{', signatureIndex);
    assert.notStrictEqual(openingBraceIndex, -1);

    let depth = 0;
    for (let i = openingBraceIndex; i < source.length; i++) {
        if (source[i] === '{') {
            depth++;
        } else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(openingBraceIndex + 1, i);
            }
        }
    }

    assert.fail(`Could not extract ${methodName}`);
}

function extractScssBlock(source, selector) {
    const selectorIndex = source.indexOf(selector);
    assert.notStrictEqual(selectorIndex, -1);

    const openingBraceIndex = source.indexOf('{', selectorIndex);
    assert.notStrictEqual(openingBraceIndex, -1);

    let depth = 0;
    for (let i = openingBraceIndex; i < source.length; i++) {
        if (source[i] === '{') {
            depth++;
        } else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(openingBraceIndex + 1, i);
            }
        }
    }

    assert.fail(`Could not extract ${selector}`);
}

function runGitRepositoryDetectorChecks() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-git-'));
    try {
        const repoRoot = path.join(tempRoot, 'repo');
        const nestedDir = path.join(repoRoot, 'src');
        fs.mkdirSync(nestedDir, { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.git'));

        const detector = new GitRepositoryDetector();
        assert.strictEqual(detector.isGitRepositoryPath(nestedDir), true);
        assert.strictEqual(detector.isGitRepositoryPath('vscode-remote://ssh-remote+host/work/repo'), false);
        assert.strictEqual(detector.isGitRepositoryPath(path.join(tempRoot, 'missing')), false);

        const worktreeRoot = path.join(tempRoot, 'worktree');
        fs.mkdirSync(worktreeRoot, { recursive: true });
        fs.writeFileSync(path.join(worktreeRoot, '.git'), 'gitdir: /tmp/git/worktrees/worktree\n');
        assert.strictEqual(detector.isGitRepositoryPath(worktreeRoot), true);

        const initializedLaterBase = createTempRootWithoutGitAncestor();
        if (initializedLaterBase) {
            try {
                const initializedLaterRoot = path.join(initializedLaterBase, 'initialized-later');
                fs.mkdirSync(initializedLaterRoot, { recursive: true });
                assert.strictEqual(detector.isGitRepositoryPath(initializedLaterRoot), false);
                fs.mkdirSync(path.join(initializedLaterRoot, '.git'));
                assert.strictEqual(detector.isGitRepositoryPath(initializedLaterRoot), true);
            } finally {
                fs.rmSync(initializedLaterBase, { recursive: true, force: true });
            }
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function createTempRootWithoutGitAncestor() {
    for (const base of [os.tmpdir(), os.homedir()]) {
        if (!hasGitAncestor(base)) {
            return fs.mkdtempSync(path.join(base, 'project-steward-nongit-'));
        }
    }

    return null;
}

function hasGitAncestor(directory) {
    let currentDir = path.resolve(directory);
    while (currentDir) {
        if (fs.existsSync(path.join(currentDir, '.git'))) {
            return true;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            return false;
        }

        currentDir = parentDir;
    }

    return false;
}

function writeCodexSessionMetaFile(sessionsDir, sessionId, payload) {
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile, JSON.stringify({
        timestamp: payload.timestamp,
        type: 'session_meta',
        payload,
    }) + '\n', 'utf8');
    return sessionFile;
}

function runCodexSubagentSessionFilterChecks() {
    const previousCodexHome = process.env.CODEX_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-codex-subagents-'));
    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '07', '13');
    const indexedNormalId = '11111111-1111-4111-8111-111111111111';
    const indexedSubagentId = '22222222-2222-4222-8222-222222222222';
    const fileNormalId = '33333333-3333-4333-8333-333333333333';
    const fileSubagentId = '44444444-4444-4444-8444-444444444444';
    const parentOnlyId = '55555555-5555-4555-8555-555555555555';
    const malformedIndexedId = '66666666-6666-4666-8666-666666666666';
    try {
        process.env.CODEX_HOME = tempRoot;
        fs.mkdirSync(sessionsDir, { recursive: true });
        const writeMeta = (sessionId, timestamp, extra = {}) => writeCodexSessionMetaFile(
            sessionsDir,
            sessionId,
            { id: sessionId, session_id: sessionId, cwd: '/work/app', timestamp, ...extra }
        );

        writeMeta(indexedNormalId, '2026-07-13T01:00:00.000Z', { source: 'vscode' });
        const indexedSubagentFile = writeMeta(indexedSubagentId, '2026-07-13T02:00:00.000Z', {
            source: { subagent: { thread_spawn: { parent_thread_id: indexedNormalId, depth: 1 } } },
            parent_thread_id: indexedNormalId,
        });
        writeMeta(fileNormalId, '2026-07-13T03:00:00.000Z', { source: 'vscode' });
        const fileSubagentFile = writeMeta(fileSubagentId, '2026-07-13T04:00:00.000Z', {
            source: { subagent: { thread_spawn: { parent_thread_id: indexedNormalId, depth: 1 } } },
            parent_thread_id: indexedNormalId,
        });
        writeMeta(parentOnlyId, '2026-07-13T05:00:00.000Z', {
            source: 'vscode',
            parent_thread_id: indexedNormalId,
        });
        fs.writeFileSync(path.join(sessionsDir, `${malformedIndexedId}.jsonl`), 'not-json\n', 'utf8');
        fs.writeFileSync(path.join(tempRoot, 'session_index.jsonl'), [
            { id: indexedNormalId, thread_name: 'Parent', updated_at: '2026-07-13T01:00:00.000Z' },
            { id: indexedSubagentId, thread_name: 'Worker', updated_at: '2026-07-13T02:00:00.000Z' },
            { id: malformedIndexedId, thread_name: 'Index fallback', updated_at: '2026-07-13T06:00:00.000Z' },
        ].map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

        const result = new CodexSessionService().getSessions();
        assert.strictEqual(result.available, true);
        assert.deepStrictEqual(new Set(result.sessions.map(session => session.id)), new Set([
            indexedNormalId,
            fileNormalId,
            parentOnlyId,
            malformedIndexedId,
        ]));
        assert.strictEqual(fs.existsSync(indexedSubagentFile), true);
        assert.strictEqual(fs.existsSync(fileSubagentFile), true);

        const assignments = helpers.assignAiSessionsToProjects(
            [{ project: { id: 'app' }, path: '/work/app' }],
            result.sessions,
            session => session.cwd
        );
        assert.deepStrictEqual(
            new Set((assignments.get('app') || []).map(session => session.id)),
            new Set([indexedNormalId, fileNormalId, parentOnlyId])
        );

        const terminalService = new AiSessionTerminalService(
            path.join(tempRoot, 'storage'),
            providerId => providers.getAiSessionProviderDefinition(providerId),
            0
        );
        const subagentTerminal = {
            name: 'Codex restored',
            creationOptions: { env: { PROJECT_STEWARD_CODEX_SESSION_ID: indexedSubagentId } },
        };
        assert.strictEqual(
            terminalService.resolveTerminalSession(subagentTerminal, () => result.sessions),
            null
        );
    } finally {
        if (previousCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = previousCodexHome;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function runCodexSessionActivityTimestampChecks() {
    const previousCodexHome = process.env.CODEX_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-codex-activity-'));
    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '07', '14');
    const sessionId = '77777777-7777-4777-8777-777777777777';
    try {
        process.env.CODEX_HOME = tempRoot;
        fs.mkdirSync(sessionsDir, { recursive: true });
        const sessionFile = writeCodexSessionMetaFile(sessionsDir, sessionId, {
            id: sessionId,
            session_id: sessionId,
            cwd: '/work/app',
            timestamp: '2026-07-14T01:00:00.000Z',
            source: 'vscode',
        });
        fs.writeFileSync(path.join(tempRoot, 'session_index.jsonl'), JSON.stringify({
            id: sessionId,
            thread_name: 'Active session',
            updated_at: '2026-07-14T02:00:00.000Z',
        }) + '\n', 'utf8');

        const firstActivityAt = new Date('2026-07-14T03:00:00.000Z');
        fs.utimesSync(sessionFile, firstActivityAt, firstActivityAt);
        const service = new CodexSessionService();
        assert.strictEqual(service.getSessions(true).sessions[0].updatedAt, firstActivityAt.toISOString());

        fs.appendFileSync(sessionFile, '{"type":"event"}\n', 'utf8');
        const secondActivityAt = new Date('2026-07-14T04:00:00.000Z');
        fs.utimesSync(sessionFile, secondActivityAt, secondActivityAt);
        assert.strictEqual(service.getSessions(true).sessions[0].updatedAt, secondActivityAt.toISOString());
    } finally {
        if (previousCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = previousCodexHome;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function runKimiNestedSubagentBoundaryChecks() {
    const previousKimiHome = process.env.KIMI_SHARE_DIR;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-kimi-subagents-'));
    const workDir = '/work/app';
    const sessionId = '77777777-7777-4777-8777-777777777777';
    try {
        process.env.KIMI_SHARE_DIR = tempRoot;
        fs.writeFileSync(path.join(tempRoot, 'kimi.json'), JSON.stringify({
            work_dirs: [{ path: workDir }],
        }), 'utf8');
        const workDirHash = crypto.createHash('md5').update(workDir, 'utf8').digest('hex');
        const sessionDir = path.join(tempRoot, 'sessions', workDirHash, sessionId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'wire.jsonl'), '{}\n', 'utf8');
        fs.writeFileSync(path.join(sessionDir, 'state.json'), '{}', 'utf8');

        const nestedSubagentDir = path.join(sessionDir, 'subagents', 'a12345678');
        fs.mkdirSync(nestedSubagentDir, { recursive: true });
        fs.writeFileSync(path.join(nestedSubagentDir, 'wire.jsonl'), '{}\n', 'utf8');

        const result = new KimiSessionService().getSessions({ candidatePaths: [workDir] });
        assert.strictEqual(result.available, true);
        assert.deepStrictEqual(result.sessions.map(session => session.id), [sessionId]);
    } finally {
        if (previousKimiHome === undefined) {
            delete process.env.KIMI_SHARE_DIR;
        } else {
            process.env.KIMI_SHARE_DIR = previousKimiHome;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function runClaudeSessionChecks() {
    const previousClaudeHome = process.env.CLAUDE_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-claude-'));
    const sessionId = '11111111-1111-4111-8111-111111111111';
    try {
        process.env.CLAUDE_HOME = tempRoot;
        const sessionDir = path.join(tempRoot, 'projects', '-work-app');
        fs.mkdirSync(sessionDir, { recursive: true });
        const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
        const fillerLine = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(4096) } }) + '\n';
        const cwdLine = JSON.stringify({ sessionId, cwd: '/work/app', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n';

        fs.writeFileSync(
            sessionFile,
            fillerLine.repeat(40) + cwdLine + fillerLine.repeat(40),
            'utf8'
        );

        const nestedSubagentDir = path.join(sessionDir, sessionId, 'subagents');
        fs.mkdirSync(nestedSubagentDir, { recursive: true });
        fs.writeFileSync(
            path.join(nestedSubagentDir, 'agent-a1234567890abcdef.jsonl'),
            cwdLine,
            'utf8'
        );

        const result = new ClaudeSessionService().getSessions({ candidatePaths: ['/work/app'] });
        assert.strictEqual(result.available, true);
        assert.deepStrictEqual(result.sessions.map(session => session.id), [sessionId]);
        assert.strictEqual(result.sessions[0].cwd, '/work/app');
    } finally {
        if (previousClaudeHome === undefined) {
            delete process.env.CLAUDE_HOME;
        } else {
            process.env.CLAUDE_HOME = previousClaudeHome;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function runProviderChecks() {
    assert.deepStrictEqual(providers.AI_SESSION_PROVIDER_IDS, ['codex', 'kimi', 'claude']);
    assert.strictEqual(providers.getAiSessionProviderLabel('codex'), 'Codex');
    assert.strictEqual(providers.getAiSessionProviderLabel('kimi'), 'Kimi');
    assert.strictEqual(providers.getAiSessionProviderLabel('claude'), 'Claude');
    assert.strictEqual(providers.getAiSessionProviderDefinition('codex').terminalEnvKey, 'PROJECT_STEWARD_CODEX_SESSION_ID');
    assert.strictEqual(providers.getAiSessionProviderDefinition('kimi').markerDirName, 'kimi-session-terminals');
    assert.strictEqual(providers.getAiSessionProviderDefinition('codex').projectSessionsKey, 'codexSessions');
    assert.strictEqual(providers.getAiSessionProviderDefinition('kimi').projectSessionsUnavailableKey, 'kimiSessionsUnavailable');
    assert.strictEqual(providers.getAiSessionProviderDefinition('claude').terminalEnvKey, 'PROJECT_STEWARD_CLAUDE_SESSION_ID');
    assert.deepStrictEqual(providers.getAiSessionProviderDefinition('codex').terminalCwdFields, ['cwd']);
    assert.deepStrictEqual(providers.getAiSessionProviderDefinition('kimi').terminalCwdFields, ['workDir', 'cwd']);
    assert.deepStrictEqual(providers.getAiSessionProviderDefinition('claude').terminalCwdFields, ['workDir', 'cwd']);
    assert.strictEqual(
        providers.getAiSessionProviderDefinition('codex').buildNewSessionCommand('/work/app', 'Ignored Title', null),
        "codex --cd '/work/app'"
    );
    assert.strictEqual(
        providers.getAiSessionProviderDefinition('claude').buildNewSessionCommand('/work/app', 'Useful Title', null),
        "cd '/work/app' && claude --name 'Useful Title'"
    );
}

function runProviderLifecycleServiceChecks() {
    const runStartedAtMs = Date.parse('2026-07-15T00:00:00.000Z');
    const previousCodexHome = process.env.CODEX_HOME;
    const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-codex-lifecycle-'));
    const codexId = '88888888-8888-4888-8888-888888888888';
    try {
        process.env.CODEX_HOME = codexRoot;
        const sessionDir = path.join(codexRoot, 'sessions', '2026', '07', '15');
        fs.mkdirSync(sessionDir, { recursive: true });
        const sessionFile = writeCodexSessionMetaFile(sessionDir, codexId, {
            id: codexId, session_id: codexId, cwd: '/work/app', timestamp: '2026-07-14T23:00:00.000Z', source: 'vscode',
        });
        fs.appendFileSync(sessionFile, [
            { timestamp: '2026-07-14T23:59:59.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old' } },
            { timestamp: '2026-07-15T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'new' } },
        ].map(JSON.stringify).join('\n') + '\n');
        const service = new CodexSessionService();
        let signals = service.getLifecycleSignals([
            { sessionId: codexId, runStartedAtMs },
            { sessionId: 'missing', runStartedAtMs },
        ]);
        assert.strictEqual(signals[codexId].reason, 'completed');
        assert.strictEqual(signals.missing, undefined);
        fs.appendFileSync(sessionFile, JSON.stringify({ timestamp: '2026-07-15T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } }) + '\n');
        const originalReaddirSync = fs.readdirSync;
        fs.readdirSync = () => { throw new Error('cached lifecycle lookup must not rescan provider roots'); };
        try {
            signals = service.getLifecycleSignals([{ sessionId: codexId, runStartedAtMs }]);
        } finally {
            fs.readdirSync = originalReaddirSync;
        }
        assert.strictEqual(signals[codexId].phase, 'running');
        assert.deepStrictEqual(service.getLifecycleSignals([{ sessionId: codexId, runStartedAtMs: Date.parse('2026-07-16T00:00:00Z') }]), {});
    } finally {
        previousCodexHome === undefined ? delete process.env.CODEX_HOME : process.env.CODEX_HOME = previousCodexHome;
        fs.rmSync(codexRoot, { recursive: true, force: true });
    }

    const previousKimiHome = process.env.KIMI_SHARE_DIR;
    const kimiRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-kimi-lifecycle-'));
    const kimiId = '99999999-9999-4999-8999-999999999999';
    try {
        process.env.KIMI_SHARE_DIR = kimiRoot;
        const workDir = '/work/app';
        fs.writeFileSync(path.join(kimiRoot, 'kimi.json'), JSON.stringify({ work_dirs: [{ path: workDir }] }));
        const workDirHash = crypto.createHash('md5').update(workDir, 'utf8').digest('hex');
        const sessionDir = path.join(kimiRoot, 'sessions', workDirHash, kimiId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), '{}');
        fs.writeFileSync(path.join(sessionDir, 'wire.jsonl'), JSON.stringify({
            timestamp: runStartedAtMs / 1000 + 2, message: { type: 'TurnEnd', payload: {} },
        }) + '\n');
        const signals = new KimiSessionService().getLifecycleSignals([{ sessionId: kimiId, runStartedAtMs }]);
        assert.strictEqual(signals[kimiId].reason, 'completed');
    } finally {
        previousKimiHome === undefined ? delete process.env.KIMI_SHARE_DIR : process.env.KIMI_SHARE_DIR = previousKimiHome;
        fs.rmSync(kimiRoot, { recursive: true, force: true });
    }

    const previousClaudeHome = process.env.CLAUDE_HOME;
    const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-claude-lifecycle-'));
    const claudeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    try {
        process.env.CLAUDE_HOME = claudeRoot;
        const sessionDir = path.join(claudeRoot, 'projects', '-work-app');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, `${claudeId}.jsonl`), JSON.stringify({
            timestamp: '2026-07-15T00:00:02.000Z', type: 'assistant',
            message: { role: 'assistant', stop_reason: 'end_turn', content: [] },
        }) + '\n');
        const signals = new ClaudeSessionService().getLifecycleSignals([{ sessionId: claudeId, runStartedAtMs }]);
        assert.strictEqual(signals[claudeId].reason, 'completed');
    } finally {
        previousClaudeHome === undefined ? delete process.env.CLAUDE_HOME : process.env.CLAUDE_HOME = previousClaudeHome;
        fs.rmSync(claudeRoot, { recursive: true, force: true });
    }
}

function runCommandBuilderChecks() {
    assert.strictEqual(
        commands.buildCodexResumeCommand('abc123', '/work/My App', null, 'linux'),
        "codex resume --cd '/work/My App' 'abc123'"
    );
    assert.strictEqual(
        commands.buildKimiNewSessionCommand('/work/app', "owner's task", null, 'linux'),
        "kimi --work-dir '/work/app' --prompt 'owner'\\''s task'"
    );
    let markedCommand = commands.buildClaudeResumeCommand('session-1', '/work/app', '/tmp/session.done', 'linux');
    assert.ok(markedCommand.startsWith('sh -lc '));
    assert.ok(markedCommand.includes('claude --resume'));
    assert.ok(markedCommand.includes('rm -f'));
    assert.ok(markedCommand.includes(': >'));
    assert.ok(markedCommand.includes('/tmp/session.done'));

    let markedCodexNewCommand = commands.buildCodexNewSessionCommand('/work/app', null, '/tmp/new-codex.done', 'linux');
    assert.ok(markedCodexNewCommand.startsWith('sh -lc '));
    assert.ok(markedCodexNewCommand.includes("codex --cd"));
    assert.ok(markedCodexNewCommand.includes('/tmp/new-codex.done'));

    let windowsCommand = commands.buildClaudeResumeCommand('session-1', 'C:\\Repo', 'C:\\Temp\\session.done', 'win32');
    assert.ok(windowsCommand.startsWith('powershell -NoProfile -ExecutionPolicy Bypass -Command '));
    assert.ok(windowsCommand.includes("Set-Location -LiteralPath 'C:\\Repo'"));
    assert.ok(windowsCommand.includes("Remove-Item -LiteralPath 'C:\\Temp\\session.done'"));
    assert.ok(windowsCommand.includes("New-Item -ItemType File -Force -Path 'C:\\Temp\\session.done'"));
    let windowsNewCommand = commands.buildCodexNewSessionCommand('C:\\Repo', null, 'C:\\Temp\\new-codex.done', 'win32');
    assert.ok(windowsNewCommand.includes("codex --cd 'C:\\Repo'"));
    assert.ok(windowsNewCommand.includes("New-Item -ItemType File -Force -Path 'C:\\Temp\\new-codex.done'"));
    assert.strictEqual(commands.quotePowerShellArg("O'Brien"), "'O''Brien'");
}

function runLifecycleParserChecks() {
    const runStartedAtMs = Date.parse('2026-07-15T00:00:00.000Z');
    const codexSignal = lifecycle.parseCodexLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-14T23:59:59.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old' } }),
        JSON.stringify({ timestamp: '2026-07-15T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
        '{bad json',
        JSON.stringify({ timestamp: '2026-07-15T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
    ], runStartedAtMs);
    assert.strictEqual(codexSignal.phase, 'needsAttention');
    assert.strictEqual(codexSignal.reason, 'completed');
    assert.ok(codexSignal.token.includes('task_complete'));
    assert.strictEqual(lifecycle.parseCodexLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:03.000Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-2' } }),
    ], runStartedAtMs).reason, 'aborted');
    assert.strictEqual(lifecycle.parseCodexLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'request_user_input', call_id: 'call-1' } }),
    ], runStartedAtMs).reason, 'input-required');
    assert.strictEqual(lifecycle.parseCodexLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'request_user_input', call_id: 'call-1' } }),
        JSON.stringify({ timestamp: '2026-07-15T00:00:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'other-call' } }),
    ], runStartedAtMs).reason, 'input-required', 'unrelated Codex output does not answer the pending request');
    assert.strictEqual(lifecycle.parseCodexLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'request_user_input', call_id: 'call-1' } }),
        JSON.stringify({ timestamp: '2026-07-15T00:00:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1' } }),
    ], runStartedAtMs).phase, 'running', 'matching Codex output resumes the turn');

    const kimiSignal = lifecycle.parseKimiLifecycleLines([
        JSON.stringify({ timestamp: 1784073601, message: { type: 'TurnBegin', payload: {} } }),
        JSON.stringify({ timestamp: 1784073602, message: { type: 'QuestionRequest', payload: { id: 'question-1' } } }),
    ], runStartedAtMs);
    assert.strictEqual(kimiSignal.reason, 'input-required');
    assert.strictEqual(lifecycle.parseKimiLifecycleLines([
        JSON.stringify({ timestamp: 1784073603, message: { type: 'StepInterrupted', payload: {} } }),
    ], runStartedAtMs).reason, 'aborted');
    assert.strictEqual(lifecycle.parseKimiLifecycleLines([
        JSON.stringify({ timestamp: 1784073604, message: { type: 'TurnEnd', payload: {} } }),
    ], runStartedAtMs).reason, 'completed');
    assert.strictEqual(lifecycle.parseKimiLifecycleLines([
        JSON.stringify({ timestamp: 1784073605, message: { type: 'ApprovalRequest', payload: { id: 'approval-1' } } }),
    ], runStartedAtMs).reason, 'input-required');
    assert.strictEqual(lifecycle.parseKimiLifecycleLines([
        JSON.stringify({ timestamp: 1784073606, message: { type: 'QuestionRequest', payload: { id: 'question-2' } } }),
        JSON.stringify({ timestamp: 1784073607, message: { type: 'StatusUpdate', payload: { message_id: 'status-2' } } }),
    ], runStartedAtMs).reason, 'input-required', 'Kimi status updates do not answer a pending question');

    const claudeSignal = lifecycle.parseClaudeLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:01.000Z', type: 'user', message: { role: 'user' } }),
        JSON.stringify({ timestamp: '2026-07-15T00:00:02.000Z', type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } }),
    ], runStartedAtMs);
    assert.strictEqual(claudeSignal.reason, 'completed');
    assert.strictEqual(lifecycle.parseClaudeLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:03.000Z', type: 'assistant', message: { role: 'assistant', stop_reason: 'stop_sequence', content: [] } }),
    ], runStartedAtMs).reason, 'completed');
    assert.strictEqual(lifecycle.parseClaudeLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:04.000Z', type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'ask-1' }] } }),
    ], runStartedAtMs).reason, 'input-required');
    assert.strictEqual(lifecycle.parseClaudeLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:05.000Z', type: 'system', subtype: 'api_error' }),
    ], runStartedAtMs).reason, 'failed');
    assert.strictEqual(lifecycle.parseClaudeLifecycleLines(['{}', 'not-json'], runStartedAtMs), null);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-jsonl-tail-'));
    try {
        const filePath = path.join(tempRoot, 'events.jsonl');
        fs.writeFileSync(filePath, `${'x'.repeat(40)}\nsecond\nthird\n`, 'utf8');
        assert.deepStrictEqual(jsonlTail.readJsonlTailLines(filePath, 14), ['second', 'third']);
        assert.deepStrictEqual(jsonlTail.readJsonlTailLines(path.join(tempRoot, 'missing.jsonl'), 14), []);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function runAttentionMonitorChecks() {
    let now = 0;
    const signal = (token, phase, reason, occurredAtMs = now) => ({ token, phase, reason, occurredAtMs });
    let monitor = new AiSessionAttentionMonitor({ now: () => now });
    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1' }]), []);
    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1', signal: signal('run-1', 'running') }]), []);
    now = 60_000;
    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1', signal: signal('run-1', 'running', undefined, 0) }]), [], 'running never becomes attention merely with time');
    let events = monitor.evaluate([{ key: 'codex:s1', signal: signal('complete-1', 'needsAttention', 'completed') }]);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].reason, 'completed');
    assert.strictEqual(monitor.getSnapshot()['codex:s1'].state, 'needsAttention');
    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1', signal: signal('complete-1', 'needsAttention', 'completed') }]), [], 'same token is idempotent');
    monitor.acknowledge([events[0].eventId]);
    assert.strictEqual(monitor.getSnapshot()['codex:s1'].state, 'acknowledged');
    now++;
    monitor.evaluate([{ key: 'codex:s1', signal: signal('run-2', 'running') }]);
    assert.strictEqual(monitor.getSnapshot()['codex:s1'].state, 'running');
    assert.strictEqual(monitor.getSnapshot()['codex:s1'].event, undefined);
    now++;
    events = monitor.evaluate([{ key: 'codex:s1', signal: signal('input-2', 'needsAttention', 'input-required') }]);
    assert.strictEqual(events[0].generation, 2);
    assert.strictEqual(events[0].reason, 'input-required');
    assert.strictEqual(monitor.evaluate([]).length, 0);

    now = 100;
    monitor = new AiSessionAttentionMonitor({ now: () => now });
    events = monitor.evaluate([{ key: 'claude:visible', signal: signal('failed-1', 'needsAttention', 'failed'), ownerVisible: true }]);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(monitor.getSnapshot()['claude:visible'].state, 'acknowledged', 'visible attention is already seen');
    now++;
    assert.deepStrictEqual(monitor.evaluate([{ key: 'claude:visible', signal: signal('failed-1', 'needsAttention', 'failed'), ownerVisible: false }]), [], 'seen event is never replayed');

    now = 200;
    monitor = new AiSessionAttentionMonitor({ now: () => now });
    events = monitor.evaluate([{ key: 'kimi:aborted', signal: signal('aborted-1', 'needsAttention', 'aborted') }]);
    assert.strictEqual(events[0].reason, 'aborted');

    now = 300;
    monitor = new AiSessionAttentionMonitor({ now: () => now });
    events = monitor.evaluate([{ key: 'codex:return-visible', signal: signal('complete-visible', 'needsAttention', 'completed') }]);
    const hiddenEventId = events[0].eventId;
    assert.strictEqual(monitor.getSnapshot()['codex:return-visible'].state, 'needsAttention');
    now++;
    events = monitor.evaluate([{ key: 'codex:return-visible', signal: signal('complete-visible', 'needsAttention', 'completed'), ownerVisible: true }]);
    assert.strictEqual(events.length, 1, 'returning to the owning terminal must republish the changed snapshot');
    assert.strictEqual(events[0].eventId, hiddenEventId, 'visibility acknowledgement retains the exact event');
    assert.strictEqual(monitor.getSnapshot()['codex:return-visible'].state, 'acknowledged');
}

function runAttentionPayloadChecks() {
    const payload = attentionPayload.createAttentionPayload([{ projectId: 'a'.repeat(64), sessionKey: 'k', state: 'needsAttention', eventId: 'e', reason: 'input-required', observedAtMs: 10 }], 20);
    assert.deepStrictEqual(attentionPayload.parseAttentionPayload(attentionPayload.serializeAttentionPayload(payload)), payload);
    assert.throws(() => attentionPayload.parseAttentionPayload('{"version":1,"generatedAtMs":1,"items":[{"projectId":"p","sessionKey":"k","state":"bad","observedAtMs":1}]}'));
    const owner = attentionPayload.validateAttentionOwnerSnapshot({ ...payload, instanceId: 'a'.repeat(32), sequence: 1, heartbeat: 1 });
    const aggregate = attentionAggregate.aggregateAttentionSnapshots([owner], new Set(['e']), 21);
    assert.deepStrictEqual(aggregate.sessions, []);
    assert.strictEqual(aggregate.aggregateRevision.length, 64);

    const secondOwner = attentionPayload.validateAttentionOwnerSnapshot({
        ...owner,
        instanceId: 'b'.repeat(32),
        items: owner.items.map(item => ({ ...item, eventId: 'e-2', reason: 'completed', observedAtMs: 10 })),
    });
    const partial = attentionAggregate.aggregateAttentionSnapshots([owner, secondOwner], new Set(['e']), 21);
    assert.strictEqual(partial.sessions.length, 1, 'duplicate owners count as one logical session');
    assert.deepStrictEqual(partial.sessions[0].eventIds, ['e-2'], 'only the exact acknowledged event is removed');
    assert.deepStrictEqual(partial.sessions[0].reasons, ['completed']);

    const newerAcknowledgedOwner = attentionPayload.validateAttentionOwnerSnapshot({
        ...secondOwner,
        items: secondOwner.items.map(item => ({ ...item, state: 'acknowledged', observedAtMs: 20 })),
    });
    const differentTimes = attentionAggregate.aggregateAttentionSnapshots([owner, newerAcknowledgedOwner], new Set(), 21);
    assert.strictEqual(differentTimes.sessions.length, 1, 'a newer acknowledged duplicate must not hide an older unread event');
    assert.deepStrictEqual(differentTimes.sessions[0].eventIds, ['e']);

    assert.throws(() => attentionPayload.validateAttentionPayload({ ...payload, unexpected: true }), /unexpected fields/);
    assert.throws(() => attentionPayload.validateAttentionPayload({
        ...payload,
        items: [{ projectId: 'a'.repeat(64), sessionKey: 'k', state: 'needsAttention', eventId: undefined, reason: undefined, observedAtMs: 1 }],
    }), /eventId.*reason|combination/);
    assert.throws(() => attentionPayload.validateAttentionPayload({
        ...payload,
        items: [{ ...payload.items[0], eventId: 'x'.repeat(1025) }],
    }), /eventId/);
    assert.throws(() => attentionPayload.validateAttentionPayload({
        ...payload,
        items: [{ ...payload.items[0], projectId: '/home/alice/private-repo' }],
    }), /projectId|privacy-safe/);
    assert.throws(() => attentionPayload.validateAttentionPayload({
        ...payload,
        items: [{ ...payload.items[0], reason: 'quiet' }],
    }), /reason|combination/);
    assert.throws(() => attentionPayload.validateAttentionOwnerSnapshot({ ...owner, unexpected: true }), /unexpected fields/);
    assert.throws(() => attentionAggregate.validateAttentionAggregate({
        protocolVersion: 1,
        aggregateRevision: 'x'.repeat(64),
        generatedAtMs: 1,
        sessions: [],
        unexpected: true,
    }), /unexpected fields/);
    assert.throws(() => attentionAggregate.validateAttentionAggregate({
        protocolVersion: 2,
        aggregateRevision: 'x'.repeat(64),
        generatedAtMs: 1,
        sessions: [],
    }), /protocol/);

    const manyOwners = Array.from({ length: 1001 }, (_, index) => attentionPayload.validateAttentionOwnerSnapshot({
        ...payload,
        instanceId: index.toString(16).padStart(32, '0'),
        sequence: 1,
        heartbeat: 1,
        items: [{
            ...payload.items[0],
            sessionKey: `codex:bounded-${String(index).padStart(4, '0')}`,
            eventId: `bounded-event-${index}`,
        }],
    }));
    const boundedAggregate = attentionAggregate.aggregateAttentionSnapshots(manyOwners, new Set(), 30);
    assert.strictEqual(boundedAggregate.sessions.length, 1000);
    assert.doesNotThrow(() => attentionAggregate.validateAttentionAggregate(boundedAggregate));
}

async function runProductionAttentionStoreClockChecks() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-production-store-clock-'));
    const store = new ProductionAttentionStore(root, 'f'.repeat(32));
    const snapshot = attentionPayload.validateAttentionOwnerSnapshot({
        ...attentionPayload.createAttentionPayload([], 1),
        instanceId: 'a'.repeat(32),
        sequence: 1,
        heartbeat: 1,
    });
    try {
        await store.write(snapshot, 1_000_000);
        let scan = await store.scan(1_000_000 + 89_999);
        assert.strictEqual(scan.snapshots.length, 1, 'far-past Workspace clock must not expire a fresh UI-host receipt');
        const persisted = fs.readFileSync(path.join(root, 'instances', `${snapshot.instanceId}.json`), 'utf8');
        assert.ok(persisted.includes('"receivedAtMs":1000000'));

        await store.write({ ...snapshot, generatedAtMs: 9_999_999_999_999, sequence: 2, heartbeat: 2 }, 2_000_000);
        scan = await store.scan(2_000_000 + 90_001);
        assert.strictEqual(scan.snapshots.length, 0, 'far-future Workspace clock must not extend a UI-host lease');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function runProductionAttentionStoreLifecycleChecks() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-production-store-lifecycle-'));
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    let firstEntered = false;
    const store = new ProductionAttentionStore(root, 'f'.repeat(32), {
        beforeCommit: async snapshot => {
            if (snapshot.sequence === 1) {
                firstEntered = true;
                await firstGate;
            }
        },
    });
    const base = attentionPayload.validateAttentionOwnerSnapshot({
        ...attentionPayload.createAttentionPayload([], 1),
        instanceId: 'b'.repeat(32), sequence: 1, heartbeat: 1,
    });
    try {
        const firstWrite = store.write(base, 1000);
        for (let attempt = 0; attempt < 50 && !firstEntered; attempt += 1) {
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.strictEqual(firstEntered, true, 'test hook must hold the first write inside the serialized commit');
        const secondWrite = store.write({ ...base, sequence: 2, heartbeat: 2 }, 1001);
        releaseFirst();
        await Promise.all([firstWrite, secondWrite]);
        const filePath = path.join(root, 'instances', `${base.instanceId}.json`);
        assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).snapshot.sequence, 2);
        await assert.rejects(store.write({ ...base, sequence: 1 }, 1002), /sequence decreased/);
        await store.write({ ...base, sequence: 3, heartbeat: 3 }, 1003);
        assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).snapshot.sequence, 3, 'mutation queue recovers after rejection');

        fs.writeFileSync(filePath, '{malformed', 'utf8');
        assert.strictEqual((await store.scan(1010)).snapshots[0].sequence, 3, 'malformed replacement retains last valid cache');
        fs.unlinkSync(filePath);
        assert.strictEqual((await store.scan(1011)).snapshots[0].sequence, 3, 'missing file retains last valid cache');
        assert.strictEqual((await store.scan(1003 + 90_001)).snapshots.length, 0, 'cache expires only after desktop receipt lease');

        await store.write({ ...base, sequence: 4, heartbeat: 4 }, 2000);
        const delayedWrite = store.write({ ...base, sequence: 5, heartbeat: 5 }, 2001);
        const removal = store.remove(base.instanceId);
        await Promise.all([delayedWrite, removal]);
        assert.strictEqual((await store.scan(2002)).snapshots.length, 0, 'serialized unregister wins after preceding write');

        const instancesDirectory = path.join(root, 'instances');
        for (let index = 0; index < 2001; index += 1) {
            fs.writeFileSync(path.join(instancesDirectory, `stale-junk-${String(index).padStart(4, '0')}`), 'x');
        }
        const live = { ...base, instanceId: 'c'.repeat(32), sequence: 1, heartbeat: 1 };
        await store.write(live, 3000);
        const freshReader = new ProductionAttentionStore(root, 'e'.repeat(32));
        assert.strictEqual((await freshReader.scan(3001)).snapshots.some(snapshot => snapshot.instanceId === live.instanceId), true,
            'filtering valid filenames before the cap must retain a live owner after >2000 junk entries');
        const invalidOldPath = path.join(instancesDirectory, `${'d'.repeat(32)}.json`);
        fs.writeFileSync(invalidOldPath, '{invalid');
        fs.utimesSync(invalidOldPath, new Date(0), new Date(0));
        await freshReader.scan(24 * 60 * 60 * 1000 + 1);
        assert.strictEqual(fs.existsSync(invalidOldPath), false, 'invalid files are cleaned after retention');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function runProductionAttentionStoreUnregisterPropagationChecks() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-production-store-unregister-'));
    const instanceId = '9'.repeat(32);
    const ownerPath = path.join(root, 'instances', `${instanceId}.json`);
    const removalPath = path.join(root, 'removals', `${instanceId}.json`);
    const storeA = new ProductionAttentionStore(root, 'a'.repeat(32));
    const storeB = new ProductionAttentionStore(root, 'b'.repeat(32));
    const snapshot = sequence => attentionPayload.validateAttentionOwnerSnapshot({
        ...attentionPayload.createAttentionPayload([], sequence),
        instanceId,
        sequence,
        heartbeat: sequence,
    });
    try {
        await storeA.write(snapshot(5), 1000);
        assert.deepStrictEqual((await storeA.scan(1001)).snapshots.map(value => value.sequence), [5]);
        assert.deepStrictEqual((await storeB.scan(1001)).snapshots.map(value => value.sequence), [5]);

        fs.unlinkSync(ownerPath);
        assert.deepStrictEqual((await storeB.scan(1002)).snapshots.map(value => value.sequence), [5],
            'transient owner-file absence must retain the peer last-valid cache');
        await storeA.write(snapshot(6), 1003);
        assert.deepStrictEqual((await storeB.scan(1004)).snapshots.map(value => value.sequence), [6]);

        await storeA.remove(instanceId, 1005);
        assert.deepStrictEqual({
            removingStore: (await storeA.scan(1006)).snapshots,
            peerStore: (await storeB.scan(1006)).snapshots,
        }, {
            removingStore: [],
            peerStore: [],
        }, 'a shared unregister marker must invalidate every bridge cache immediately');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(removalPath, 'utf8')), {
            storageVersion: 1,
            instanceId,
            removedAtMs: 1005,
        });

        await storeA.write(snapshot(1), 1010);
        assert.deepStrictEqual((await storeA.scan(1011)).snapshots.map(value => value.sequence), [1]);
        assert.deepStrictEqual((await storeB.scan(1011)).snapshots.map(value => value.sequence), [1],
            'a later activation reusing an instance ID must supersede the tombstone');

        fs.mkdirSync(path.dirname(removalPath), { recursive: true });
        fs.writeFileSync(removalPath, JSON.stringify({
            storageVersion: 1,
            instanceId,
            removedAtMs: 2000,
            unexpected: true,
        }));
        assert.deepStrictEqual((await storeB.scan(1012)).snapshots.map(value => value.sequence), [1],
            'strict validation must ignore a malformed removal marker');

        let releaseRead;
        let readEntered = false;
        const readGate = new Promise(resolve => { releaseRead = resolve; });
        const originalReadFile = fs.promises.readFile;
        fs.promises.readFile = async (...args) => {
            const value = await originalReadFile.apply(fs.promises, args);
            if (String(args[0]) === ownerPath && !readEntered) {
                readEntered = true;
                await readGate;
            }
            return value;
        };
        try {
            const racingScan = storeA.scan(2000);
            for (let attempt = 0; attempt < 50 && !readEntered; attempt += 1) {
                await new Promise(resolve => setImmediate(resolve));
            }
            assert.strictEqual(readEntered, true);
            const racingRemove = storeA.remove(instanceId, 2001);
            await new Promise(resolve => setImmediate(resolve));
            releaseRead();
            await Promise.all([racingScan, racingRemove]);
        } finally {
            fs.promises.readFile = originalReadFile;
        }
        assert.deepStrictEqual((await storeA.scan(2002)).snapshots, [],
            'a scan racing remove must not repopulate the local last-valid cache');
        assert.deepStrictEqual((await storeB.scan(2002)).snapshots, [],
            'the racing removal must still invalidate a peer cache');

        assert.strictEqual(fs.existsSync(removalPath), true);
        await storeB.scan(2001 + 24 * 60 * 60 * 1000 + 1);
        assert.strictEqual(fs.existsSync(removalPath), false, 'removal markers are cleaned after bounded retention');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function runProductionAttentionStoreTombstoneReactivationRaceChecks() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-production-store-reactivation-race-'));
    const instanceId = '8'.repeat(32);
    const removalPath = path.join(root, 'removals', `${instanceId}.json`);
    const storeA = new ProductionAttentionStore(root, 'a'.repeat(32));
    const storeB = new ProductionAttentionStore(root, 'b'.repeat(32));
    const snapshot = sequence => attentionPayload.validateAttentionOwnerSnapshot({
        ...attentionPayload.createAttentionPayload([], sequence),
        instanceId,
        sequence,
        heartbeat: sequence,
    });
    try {
        await storeA.write(snapshot(6), 1000);
        await storeA.scan(1001);
        assert.deepStrictEqual((await storeB.scan(1001)).snapshots.map(value => value.sequence), [6]);

        await storeA.remove(instanceId, 1002);
        await storeA.write(snapshot(1), 1003);
        assert.deepStrictEqual((await storeB.scan(1003)).snapshots.map(value => value.sequence), [1],
            'a peer that missed unregister must use the retained tombstone to accept reactivation sequence 1');
        assert.strictEqual(fs.existsSync(removalPath), true,
            'reactivation must retain the shared tombstone for peers that have not scanned yet');

        await storeA.write(snapshot(2), 1004);
        assert.deepStrictEqual((await storeB.scan(1004)).snapshots.map(value => value.sequence), [2],
            'a retained tombstone must not block later heartbeats from the reactivated owner');
        assert.strictEqual(fs.existsSync(removalPath), true);

        await assert.rejects(storeA.write(snapshot(1), 1005), /sequence decreased/,
            'a retained tombstone must not repeatedly reset sequence monotonicity after reactivation');
        assert.deepStrictEqual({
            writer: (await storeA.scan(1005)).snapshots.map(value => value.sequence),
            peer: (await storeB.scan(1005)).snapshots.map(value => value.sequence),
        }, { writer: [2], peer: [2] }, 'a rejected late heartbeat must leave both stores at sequence 2');

        await storeA.remove(instanceId, 1006);
        await storeA.write(snapshot(1), 1007);
        assert.deepStrictEqual({
            writer: (await storeA.scan(1007)).snapshots.map(value => value.sequence),
            peer: (await storeB.scan(1007)).snapshots.map(value => value.sequence),
        }, { writer: [1], peer: [1] }, 'a newer tombstone generation must permit one new sequence reset');

        const afterRetentionMs = 1006 + 24 * 60 * 60 * 1000 + 1;
        assert.deepStrictEqual((await storeA.scan(afterRetentionMs)).snapshots, [],
            'the writer must not retain a stale snapshot after tombstone retention');
        assert.deepStrictEqual((await storeB.scan(afterRetentionMs)).snapshots, [],
            'the peer must not retain a stale snapshot after tombstone retention');
        assert.strictEqual(fs.existsSync(removalPath), false, 'retained tombstones still expire after bounded retention');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function runAttentionBridgeClientPrivacyChecks() {
    const executed = [];
    const registered = new Map();
    let handshakeMode = 'accepted';
    const vscode = {
        commands: {
            registerCommand: (command, callback) => {
                registered.set(command, callback);
                return { dispose() { registered.delete(command); } };
            },
            executeCommand: async (command, argument) => {
                executed.push({ command, argument });
                if (command === '_projectStewardAttention.bridge.handshake') {
                    if (handshakeMode === 'missing') throw new Error('command not found');
                    return {
                        accepted: true,
                        protocolVersion: handshakeMode === 'mismatch' ? 2 : 1,
                        bridgeExtensionVersion: '0.1.1',
                        capabilities: { snapshots: true, acknowledgements: true, atomicReplace: true },
                    };
                }
                return undefined;
            },
        },
    };
    const currentModuleLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        return currentModuleLoad.call(this, request, parent, isMain);
    };
    const modulePath = require.resolve('../out/aiSessions/attentionBridgeClient');
    delete require.cache[modulePath];
    try {
        const AttentionBridgeClient = require(modulePath).default;
        const secretIdentity = 'vscode-remote://ssh-remote+secret.example.com/home/alice/private-repo';
        const errors = [];
        const receivedAggregates = [];
        const client = new AttentionBridgeClient(aggregate => receivedAggregates.push(aggregate), error => errors.push(error));
        assert.strictEqual(await client.publish([]), true);
        assert.strictEqual(executed[0].command, '_projectStewardAttention.bridge.handshake');
        const productionPublish = executed.find(entry => entry.command === '_projectStewardAttention.bridge.publish');
        assert.ok(productionPublish);
        const serialized = JSON.stringify(productionPublish.argument);
        assert.ok(!serialized.includes('/home/alice/private-repo'));
        assert.ok(!serialized.includes('secret.example.com'));
        assert.ok(!serialized.includes('ssh-remote'));
        assert.ok(!Object.prototype.hasOwnProperty.call(productionPublish.argument, 'workspaceIdentity'));

        const aggregateReceiver = registered.get('_projectStewardAttention.workspace.aggregate');
        aggregateReceiver({
            protocolVersion: 1,
            aggregateRevision: 'b'.repeat(64),
            generatedAtMs: 1,
            sessions: [{
                projectId: 'a'.repeat(64),
                sessionKey: 'codex:peer',
                reasons: ['input-required'],
                eventIds: ['peer-event'],
                observedAtMs: 1,
            }],
        });
        assert.strictEqual(receivedAggregates.length, 1);
        const errorCountBeforeMalformedAggregate = errors.length;
        aggregateReceiver({ protocolVersion: 1, sessions: new Array(1001).fill({}) });
        assert.strictEqual(errors.length, errorCountBeforeMalformedAggregate + 1, 'malformed aggregate must fail closed');
        await client.acknowledge(['peer-event']);
        assert.strictEqual(
            executed.some(entry => entry.command === '_projectStewardAttention.bridge.acknowledge'
                && entry.argument.eventIds[0] === 'peer-event'),
            true,
            'a window must acknowledge an exact event even when it does not own that event'
        );
        client.dispose();

        const publishCount = executed.filter(entry => entry.command === '_projectStewardAttention.bridge.publish').length;
        handshakeMode = 'mismatch';
        const mismatch = new AttentionBridgeClient(() => undefined, error => errors.push(error));
        assert.strictEqual(await mismatch.publish([]), false, 'incompatible bridge must keep window-local fallback');
        mismatch.dispose();
        assert.strictEqual(executed.filter(entry => entry.command === '_projectStewardAttention.bridge.publish').length, publishCount);

        handshakeMode = 'missing';
        const missing = new AttentionBridgeClient(() => undefined, error => errors.push(error));
        assert.strictEqual(await missing.publish([]), false, 'missing bridge must keep window-local fallback');
        missing.dispose();
        assert.ok(errors.length >= 2);
    } finally {
        Module._load = currentModuleLoad;
        delete require.cache[modulePath];
    }
}

async function runProductionAttentionBridgeIntegrationChecks() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-production-integration-'));
    const registered = new Map();
    const executed = [];
    const vscode = {
        window: {
            createOutputChannel: () => ({
                appendLine: () => undefined,
                dispose: () => undefined,
            }),
        },
        workspace: { workspaceFolders: [] },
        commands: {
            registerCommand: (command, callback) => {
                registered.set(command, callback);
                return { dispose() { registered.delete(command); } };
            },
            executeCommand: async (command, argument) => {
                executed.push({ command, argument });
                const callback = registered.get(command);
                return callback ? callback(argument) : undefined;
            },
        },
    };
    const currentModuleLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        return currentModuleLoad.call(this, request, parent, isMain);
    };
    const extensionPath = require.resolve('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/extension');
    const clientPath = require.resolve('../out/aiSessions/attentionBridgeClient');
    delete require.cache[extensionPath];
    delete require.cache[clientPath];
    const bridgePackageRoot = path.join(__dirname, '..', 'extensions', 'attention-ui-bridge');
    const bridgePackage = JSON.parse(fs.readFileSync(path.join(bridgePackageRoot, 'package.json'), 'utf8'));
    const extensionSource = fs.readFileSync(path.join(bridgePackageRoot, 'src', 'extension.ts'), 'utf8');
    const productionStoreSource = fs.readFileSync(path.join(bridgePackageRoot, 'src', 'productionAttentionStore.ts'), 'utf8');
    assert.ok(!extensionSource.includes("bridgeExtensionVersion: '0.1.1'"));
    assert.ok(!extensionSource.includes("Date.now(), '0.1.1'"));
    assert.ok(!productionStoreSource.includes("bridgeVersion = '0.1.1'"));
    const context = {
        extensionPath: bridgePackageRoot,
        globalStoragePath: root,
        globalStorageUri: { scheme: 'file' },
        subscriptions: [],
    };
    try {
        const extension = require(extensionPath);
        await extension.activate(context);
        assert.strictEqual(typeof registered.get('_projectStewardAttention.bridge.handshake'), 'function');
        const aggregates = [];
        const errors = [];
        const AttentionBridgeClient = require(clientPath).default;
        const client = new AttentionBridgeClient(aggregate => aggregates.push(aggregate), error => errors.push(error));
        assert.strictEqual(await client.publish([{
            projectId: 'a'.repeat(64),
            sessionKey: 'codex:integration',
            state: 'needsAttention',
            eventId: 'integration-event',
            reason: 'completed',
            observedAtMs: 1,
        }]), true);
        assert.strictEqual(errors.length, 0);
        assert.strictEqual(aggregates.length > 0, true);
        assert.deepStrictEqual(aggregates[aggregates.length - 1].sessions[0].eventIds, ['integration-event']);

        const publish = registered.get('_projectStewardAttention.bridge.publish');
        const handshake = registered.get('_projectStewardAttention.bridge.handshake');
        const unregister = registered.get('_projectStewardAttention.bridge.unregister');
        const validPublishedSnapshot = executed.find(entry => entry.command === '_projectStewardAttention.bridge.publish').argument;
        assert.strictEqual(typeof unregister, 'function');
        const handshakeResponse = await handshake({
            protocolVersion: 1,
            mainExtensionVersion: '1.1.8',
            instanceId: 'a'.repeat(32),
        });
        assert.strictEqual(handshakeResponse.bridgeExtensionVersion, bridgePackage.version);
        await assert.rejects(unregister({ protocolVersion: 1, instanceId: validPublishedSnapshot.instanceId, unexpected: true }), /unexpected fields/);
        await assert.rejects(handshake({ protocolVersion: 2, mainExtensionVersion: '1.1.8', instanceId: 'a'.repeat(32) }), /protocol/);
        await assert.rejects(publish({ ...validPublishedSnapshot, unexpected: true }), /unexpected fields/);
        await assert.rejects(publish({ ...validPublishedSnapshot, version: 2 }), /header|version|protocol/);
        await assert.rejects(publish({
            ...validPublishedSnapshot,
            items: [{ ...validPublishedSnapshot.items[0], eventId: 'x'.repeat(1025) }],
        }), /eventId/);

        const productionRoot = path.join(root, 'attention-local-bridge-spike', 'v1', 'production-attention', 'v1', 'instances');
        const storedText = fs.readdirSync(productionRoot)
            .filter(name => name.endsWith('.json'))
            .map(name => fs.readFileSync(path.join(productionRoot, name), 'utf8'))
            .join('\n');
        assert.ok(!storedText.includes('/home/'));
        assert.ok(!storedText.includes('ssh-remote'));
        assert.ok(!storedText.includes('workspaceIdentity'));
        await unregister({ protocolVersion: 1, instanceId: validPublishedSnapshot.instanceId });
        assert.strictEqual(fs.existsSync(path.join(productionRoot, `${validPublishedSnapshot.instanceId}.json`)), false);
        client.dispose();
    } finally {
        Module._load = currentModuleLoad;
        delete require.cache[extensionPath];
        delete require.cache[clientPath];
        for (const disposable of context.subscriptions.slice().reverse()) disposable.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function runAttentionBridgeClientLifecycleChecks() {
    const registered = new Map();
    const commands = [];
    const timers = [];
    let now = 1_000;
    let bridgeMode = 'missing';
    let holdHandshake = false;
    let handshakeEntered = false;
    let releaseHandshake;
    let handshakeGate = Promise.resolve();
    let holdFirstPublish = false;
    let firstPublishEntered = false;
    let releaseFirstPublish;
    let firstPublishGate = new Promise(resolve => { releaseFirstPublish = resolve; });
    const vscode = { commands: {
        registerCommand: (command, callback) => {
            registered.set(command, callback);
            return { dispose: () => registered.delete(command) };
        },
        executeCommand: async (command, argument) => {
            commands.push({ command, argument });
            if (command === '_projectStewardAttention.bridge.handshake') {
                if (holdHandshake) {
                    handshakeEntered = true;
                    await handshakeGate;
                }
                if (bridgeMode === 'missing') throw new Error('command not found');
                return {
                    accepted: true, protocolVersion: bridgeMode === 'incompatible' ? 2 : 1,
                    bridgeExtensionVersion: '0.1.1',
                    capabilities: { snapshots: true, acknowledgements: true, atomicReplace: true },
                };
            }
            if (command === '_projectStewardAttention.bridge.publish' && holdFirstPublish && !firstPublishEntered) {
                firstPublishEntered = true;
                await firstPublishGate;
            }
            if (command === '_projectStewardAttention.bridge.publish' && bridgeMode === 'missing') {
                throw new Error('command not found');
            }
            return undefined;
        },
    } };
    const currentModuleLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        return currentModuleLoad.call(this, request, parent, isMain);
    };
    const modulePath = require.resolve('../out/aiSessions/attentionBridgeClient');
    delete require.cache[modulePath];
    const options = {
        now: () => now,
        setTimeout: (callback, delayMs) => { timers.push({ callback, delayMs }); return timers.length; },
        clearTimeout: () => undefined,
    };
    const item = eventId => ({
        projectId: 'a'.repeat(64), sessionKey: 'codex:lifecycle', state: 'needsAttention',
        eventId, reason: 'input-required', observedAtMs: now,
    });
    try {
        const Client = require(modulePath).default;
        const client = new Client(() => undefined, () => undefined, options);
        assert.strictEqual(await client.publish([item('latest-while-missing')]), false);
        assert.strictEqual(timers.length, 1, 'missing bridge schedules bounded retry');
        bridgeMode = 'available';
        timers.shift().callback();
        for (let attempt = 0; attempt < 50 && !commands.some(entry => entry.command === '_projectStewardAttention.bridge.publish'); attempt += 1) {
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.strictEqual(commands.find(entry => entry.command === '_projectStewardAttention.bridge.publish').argument.items[0].eventId, 'latest-while-missing');

        bridgeMode = 'missing';
        assert.strictEqual(await client.publish([], true), false);
        const publishCountBeforeEmptyRecovery = commands.filter(
            entry => entry.command === '_projectStewardAttention.bridge.publish'
        ).length;
        assert.strictEqual(timers.length, 1);
        bridgeMode = 'available';
        timers.shift().callback();
        for (let attempt = 0; attempt < 50 && commands.filter(
            entry => entry.command === '_projectStewardAttention.bridge.publish'
        ).length === publishCountBeforeEmptyRecovery; attempt += 1) {
            await new Promise(resolve => setImmediate(resolve));
        }
        const publicationsAfterEmptyRecovery = commands.filter(
            entry => entry.command === '_projectStewardAttention.bridge.publish'
        );
        assert.strictEqual(publicationsAfterEmptyRecovery.length, publishCountBeforeEmptyRecovery + 1,
            'bridge recovery must flush an explicitly requested empty snapshot');
        assert.deepStrictEqual(publicationsAfterEmptyRecovery[publicationsAfterEmptyRecovery.length - 1].argument.items, []);

        holdFirstPublish = true;
        firstPublishEntered = false;
        firstPublishGate = new Promise(resolve => { releaseFirstPublish = resolve; });
        const first = client.publish([item('older')], true);
        for (let attempt = 0; attempt < 50 && !firstPublishEntered; attempt += 1) await new Promise(resolve => setImmediate(resolve));
        const second = client.publish([item('newer')], true);
        releaseFirstPublish();
        await Promise.all([first, second]);
        holdFirstPublish = false;
        const beforeDedup = commands.filter(entry => entry.command === '_projectStewardAttention.bridge.publish').length;
        await client.publish([item('newer')]);
        assert.strictEqual(commands.filter(entry => entry.command === '_projectStewardAttention.bridge.publish').length, beforeDedup, 'client cache remains at newest publication');
        client.dispose();
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(commands.some(entry => entry.command === '_projectStewardAttention.bridge.unregister'), true);

        holdHandshake = true;
        handshakeEntered = false;
        handshakeGate = new Promise(resolve => { releaseHandshake = resolve; });
        const handshakeDisposeClient = new Client(() => undefined, () => undefined, options);
        const handshakeDisposePublish = handshakeDisposeClient.publish([item('dispose-during-handshake')], true);
        for (let attempt = 0; attempt < 50 && !handshakeEntered; attempt += 1) {
            await new Promise(resolve => setImmediate(resolve));
        }
        const handshakeDisposeInstanceId = handshakeDisposeClient.instanceId;
        handshakeDisposeClient.dispose();
        releaseHandshake();
        await handshakeDisposePublish;
        await new Promise(resolve => setImmediate(resolve));
        holdHandshake = false;

        holdFirstPublish = false;
        const queuedDisposeClient = new Client(() => undefined, () => undefined, options);
        assert.strictEqual(await queuedDisposeClient.publish([item('queued-dispose-warmup')], true), true);
        const queuedDisposeInstanceId = queuedDisposeClient.instanceId;
        holdFirstPublish = true;
        firstPublishEntered = false;
        firstPublishGate = new Promise(resolve => { releaseFirstPublish = resolve; });
        const inFlightAtDispose = queuedDisposeClient.publish([item('in-flight-at-dispose')], true);
        for (let attempt = 0; attempt < 50 && !firstPublishEntered; attempt += 1) {
            await new Promise(resolve => setImmediate(resolve));
        }
        const queuedAtDispose = queuedDisposeClient.publish([item('queued-at-dispose')], true);
        queuedDisposeClient.dispose();
        releaseFirstPublish();
        await Promise.all([inFlightAtDispose, queuedAtDispose]);
        await new Promise(resolve => setImmediate(resolve));
        holdFirstPublish = false;

        const lifecycleMutations = instanceId => commands
            .filter(entry => entry.argument?.instanceId === instanceId
                && (entry.command === '_projectStewardAttention.bridge.publish'
                    || entry.command === '_projectStewardAttention.bridge.unregister'))
            .map(entry => ({
                command: entry.command,
                eventIds: entry.argument.items?.map(value => value.eventId) || [],
            }));
        assert.deepStrictEqual({
            disposedDuringHandshake: lifecycleMutations(handshakeDisposeInstanceId),
            disposedWithQueuedAndInFlight: lifecycleMutations(queuedDisposeInstanceId).slice(1),
        }, {
            disposedDuringHandshake: [{
                command: '_projectStewardAttention.bridge.unregister',
                eventIds: [],
            }],
            disposedWithQueuedAndInFlight: [
                {
                    command: '_projectStewardAttention.bridge.publish',
                    eventIds: ['in-flight-at-dispose'],
                },
                {
                    command: '_projectStewardAttention.bridge.unregister',
                    eventIds: [],
                },
            ],
        });

        bridgeMode = 'incompatible';
        const incompatibleTimersBefore = timers.length;
        const incompatible = new Client(() => undefined, () => undefined, options);
        assert.strictEqual(await incompatible.publish([item('never')]), false);
        assert.strictEqual(timers.length, incompatibleTimersBefore, 'incompatible protocol is not retried blindly');
        incompatible.dispose();
    } finally {
        Module._load = currentModuleLoad;
        delete require.cache[modulePath];
    }
}

function runAttentionProjectChecks() {
    const localKey = attentionProject.getAttentionProjectKey('/work/My%20Repo/');
    assert.strictEqual(localKey, attentionProject.getAttentionProjectKey('/work/My Repo'));
    assert.strictEqual(localKey.length, 64);
    assert.ok(!localKey.includes('/work/My Repo'));
    assert.notStrictEqual(
        attentionProject.getAttentionProjectKey('vscode-remote://ssh-remote+host-a/work/repo'),
        attentionProject.getAttentionProjectKey('vscode-remote://ssh-remote+host-b/work/repo')
    );
    assert.strictEqual(attentionProject.getAttentionProjectKey(''), '');

    const summaries = attentionProject.getAttentionProjectSummaries({
        protocolVersion: 1,
        aggregateRevision: 'revision',
        generatedAtMs: 10,
        sessions: [
            { projectId: localKey, sessionKey: 'codex:one', eventIds: ['event-1'], reasons: ['input-required'], observedAtMs: 1 },
            { projectId: localKey, sessionKey: 'claude:two', eventIds: ['event-2'], reasons: ['completed'], observedAtMs: 2 },
        ],
    });
    assert.deepStrictEqual(summaries, [{
        projectKey: localKey,
        attentionCount: 2,
        eventIds: ['event-1', 'event-2'],
        sessions: [
            { sessionKey: 'claude:two', eventId: 'event-2', eventIds: ['event-2'] },
            { sessionKey: 'codex:one', eventId: 'event-1', eventIds: ['event-1'] },
        ],
    }]);
    const multiEventSummary = attentionProject.getAttentionProjectSummaries({
        protocolVersion: 1,
        aggregateRevision: 'c'.repeat(64),
        generatedAtMs: 10,
        sessions: [{
            projectId: localKey,
            sessionKey: 'codex:one',
            eventIds: ['event-old', 'event-new'],
            reasons: ['completed', 'input-required'],
            observedAtMs: 2,
        }],
    });
    assert.deepStrictEqual(multiEventSummary[0].sessions[0].eventIds, ['event-new', 'event-old']);
    const project = { id: 'saved', path: '/work/My Repo', name: 'Repo' };
    const annotated = attentionProject.withAttentionProject(project, {
        protocolVersion: 1,
        aggregateRevision: 'revision',
        generatedAtMs: 10,
        sessions: [
            { projectId: localKey, sessionKey: 'codex:one', eventIds: ['event-1'], reasons: ['input-required'], observedAtMs: 1 },
        ],
    });
    assert.notStrictEqual(annotated, project);
    assert.strictEqual(annotated.aiSessionAttentionCount, 1);
    assert.deepStrictEqual(annotated.aiSessionAttentionEventIds, ['event-1']);
    assert.strictEqual(project.aiSessionAttentionCount, undefined);

    const remotePath = 'vscode-remote://dev-container+fixture/work/app';
    const remoteKey = attentionProject.getAttentionProjectKey(remotePath);
    const remoteOpenProject = attentionProject.withAttentionProject({
        id: 'open-project',
        path: '/work/app',
        attentionProjectPath: remotePath,
    }, {
        protocolVersion: 1,
        aggregateRevision: 'remote-revision',
        generatedAtMs: 10,
        sessions: [{
            projectId: remoteKey,
            sessionKey: 'codex:remote',
            eventIds: ['event-remote'],
            reasons: ['input-required'],
            observedAtMs: 2,
        }],
    });
    assert.strictEqual(remoteOpenProject.aiSessionAttentionCount, 1);
}

function runVsixPackagingChecks() {
    const vscodeIgnore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8');
    assert.ok(
        vscodeIgnore.split(/\r?\n/).includes('.superpowers/**'),
        'VSIX packaging must exclude local .superpowers artifacts'
    );
}

async function main() {
    runPathChecks();
    runAssignmentChecks();
    runCurrentWorkspaceStateChecks();
    runFavoriteProjectOrderChecks();
    runCurrentWorkspaceMatchingChecks();
    runOpenProjectAttentionIdentityChecks();
    runCandidateFilterChecks();
    runDisplayChecks();
    runPinStoreChecks();
    runKeyChecks();
    runBatchAiSessionArchiveChecks();
    runActiveAiSessionTerminalHighlightChecks();
    runAiSessionTerminalResolutionChecks();
    await runBatchAiSessionArchiveHostChecks();
    runWebviewContentChecks();
    runCurrentWorkspaceRenderingChecks();
    runFavoriteRenderingChecks();
    runAttentionProjectRenderingChecks();
    runFavoriteDndChecks();
    runBatchAiSessionWebviewChecks();
    runGitRepositoryDetectorChecks();
    runCodexSubagentSessionFilterChecks();
    runCodexSessionActivityTimestampChecks();
    runKimiNestedSubagentBoundaryChecks();
    runClaudeSessionChecks();
    runProviderChecks();
    runProviderLifecycleServiceChecks();
    runCommandBuilderChecks();
    runLifecycleParserChecks();
    runAttentionMonitorChecks();
    runAttentionPayloadChecks();
    await runProductionAttentionStoreClockChecks();
    await runProductionAttentionStoreLifecycleChecks();
    await runProductionAttentionStoreUnregisterPropagationChecks();
    await runProductionAttentionStoreTombstoneReactivationRaceChecks();
    await runAttentionBridgeClientPrivacyChecks();
    await runProductionAttentionBridgeIntegrationChecks();
    await runAttentionBridgeClientLifecycleChecks();
    runAttentionProjectChecks();
    runVsixPackagingChecks();

    console.log('AI session safety checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
