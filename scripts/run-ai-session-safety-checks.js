'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const vm = require('vm');
const commands = require('../out/aiSessions/commandBuilders');
const helpers = require('../out/aiSessions/sessionHelpers');
const archiveBatch = require('../out/aiSessions/archiveBatch');
const AiSessionPinStore = require('../out/aiSessions/pinStore').default;
const providers = require('../out/aiSessions/providers');
const ClaudeSessionService = require('../out/services/claudeSessionService').default;
const GitRepositoryDetector = require('../out/projects/gitRepositoryDetector').default;
const projectPathUtils = require('../out/projects/projectPathUtils');
const currentWorkspaceState = require('../out/projects/currentWorkspaceState');
const favoriteProjectOrder = require('../out/projects/favoriteProjectOrder');
const originalModuleLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return { Uri: { parse: createTestUri, file: createTestFileUri } };
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};
const openProjectMatcher = require('../out/projects/openProjectMatcher');
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
    const openProjects = [{ id: '__openProjects-0', name: 'Saved', path: '/work/saved' }];

    const result = currentWorkspaceState.withCurrentWorkspaceState(groups, openProjects, ['saved']);

    assert.strictEqual(result.groups[0].projects[0].isCurrentWorkspace, true);
    assert.strictEqual(result.groups[0].projects[1].isCurrentWorkspace, false);
    assert.strictEqual(result.openProjects[0].isCurrentWorkspace, true);
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
    assert.ok(dashboard.includes("case 'open-settings':"));
    assert.ok(settingsFunction.includes("executeCommand('workbench.action.openSettings', '@ext:hzcheng.project-steward')"));
    assert.ok(!settingsFunction.includes('showQuickPick'));
    assert.ok(!settingsFunction.includes('ai-session-terminal-mode-planned'));
    assert.ok(dashboard.includes('new AiSessionPinStore(context.globalStoragePath)'));
    assert.ok(!dashboard.includes('prunePinnedAiSessionKeys'));
    assert.ok(extractFunctionBody(dashboard, 'deletePinnedAiSession').includes("logError('Failed to delete the pinned AI session.'"));
    assert.ok(dashboard.includes("case 'archive-ai-sessions':"));
    assert.ok(dashboard.includes('AiSessionBatchArchiveCompletedMessage'));
    assert.ok(singleArchiveFunction.includes('archiveAiSessionItem(providerId, sessionId)'));
    assert.ok(batchArchiveFunction.includes('executeBatchAiSessionArchiveRequest('));
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
                { id: '__openProjects-0', name: 'Saved', path: '/work/saved', color: '#00aacc' },
            ],
        },
        true
    );
    const getCardTags = projectId => html.match(new RegExp(`<div class="project"[^>]*data-id="${projectId}"[^>]*>`, 'g')) || [];
    const savedTags = getCardTags('saved');
    const otherTags = getCardTags('other');
    const openTags = getCardTags('__openProjects-0');

    assert.strictEqual(savedTags.length, 2);
    assert.ok(savedTags.every(tag => tag.includes('data-current-workspace')));
    assert.strictEqual(otherTags.length, 1);
    assert.ok(!otherTags[0].includes('data-current-workspace'));
    assert.strictEqual(openTags.length, 1);
    assert.ok(openTags[0].includes('data-current-workspace'));
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
    const createProject = (projectId, provider) => {
        const attributes = new Set(['data-open-project']);
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
            getAttribute: attribute => attribute === 'data-id' ? projectId : null,
            hasAttribute: attribute => attributes.has(attribute),
            removeAttribute: attribute => attributes.delete(attribute),
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
                return null;
            },
            querySelectorAll: selector => selector === '.ai-session-batch-actions button'
                ? batchButtons
                : [],
        };
    };
    const projectA = createProject('project-a', 'codex');
    const projectB = createProject('project-b', 'kimi');
    const projects = [projectA, projectB];
    const context = {
        document: {
            body: {
                classList: { toggle: () => {} },
                style: { setProperty: () => {} },
            },
            addEventListener: (event, listener) => { eventListeners[event] = listener; },
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: selector => {
                if (selector === '.project[data-open-project][data-id]') {
                    return projects;
                }
                if (selector === '.project[data-ai-session-managing], .project[data-ai-session-pending]') {
                    return projects.filter(project => project.hasAttribute('data-ai-session-managing')
                        || project.hasAttribute('data-ai-session-pending'));
                }
                return [];
            },
        },
        window: {
            addEventListener: (event, listener) => { windowEventListeners[event] = listener; },
            requestAnimationFrame: callback => callback(),
            vscode: { postMessage: message => messages.push(message) },
        },
    };

    vm.runInNewContext(source, context);
    context.initProjects();

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

async function main() {
    runPathChecks();
    runAssignmentChecks();
    runCurrentWorkspaceStateChecks();
    runFavoriteProjectOrderChecks();
    runCurrentWorkspaceMatchingChecks();
    runCandidateFilterChecks();
    runDisplayChecks();
    runPinStoreChecks();
    runKeyChecks();
    runBatchAiSessionArchiveChecks();
    await runBatchAiSessionArchiveHostChecks();
    runWebviewContentChecks();
    runCurrentWorkspaceRenderingChecks();
    runFavoriteRenderingChecks();
    runFavoriteDndChecks();
    runBatchAiSessionWebviewChecks();
    runGitRepositoryDetectorChecks();
    runClaudeSessionChecks();
    runProviderChecks();
    runCommandBuilderChecks();

    console.log('AI session safety checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
