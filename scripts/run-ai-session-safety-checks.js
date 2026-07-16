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
const terminalBindingStore = require('../out/aiSessions/terminalBindingStore');
const AiSessionTerminalBindingStore = terminalBindingStore.default;
const AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX = terminalBindingStore.AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX;
const AiSessionAttentionMonitor = require('../out/aiSessions/attentionMonitor').default;
const attentionPayload = require('../out/aiSessions/attentionPayload');
const attentionAggregate = require('../out/aiSessions/attentionAggregate');
const attentionProject = require('../out/aiSessions/attentionProject');
const AiSessionReadCoordinator = require('../out/aiSessions/readCoordinator').AiSessionReadCoordinator;
const aiSessionViewModels = require('../out/aiSessions/viewModels');
const aiSessionProjectHydration = require('../out/aiSessions/projectHydration');
const AiSessionAliasStore = require('../out/aiSessions/aliasStore').default;
const AiSessionAliasController = require('../out/aiSessions/aliasController').default;
const AiSessionProjectStateStore = require('../out/aiSessions/projectStateStore').default;
const ProductionAttentionStore = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/productionAttentionStore').ProductionAttentionStore;
const AiSessionPinStore = require('../out/aiSessions/pinStore').default;
const AiSessionPinController = require('../out/aiSessions/pinController').default;
const providers = require('../out/aiSessions/providers');
const CodexSessionService = require('../out/services/codexSessionService').default;
const KimiSessionService = require('../out/services/kimiSessionService').default;
const ClaudeSessionService = require('../out/services/claudeSessionService').default;
const GitRepositoryDetector = require('../out/projects/gitRepositoryDetector').default;
const projectPathUtils = require('../out/projects/projectPathUtils');
const favoriteProjectOrder = require('../out/projects/favoriteProjectOrder');
const DashboardDiagnostics = require('../out/dashboard/diagnostics').default;
const originalModuleLoad = Module._load;
const vscodeTestState = { terminals: [], nextTerminalProcessId: 42000 };
let aiSessionProjectCandidates;
let aiSessionSessionPaths;
let aiSessionPendingTerminals;
let aiSessionTerminalCandidates;
let aiSessionPendingTerminalResolver;
let aiSessionScanOptions;
let aiSessionTerminalCwd;
let projectWorkspaceHelpers;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {
            Uri: { parse: createTestUri, file: createTestFileUri },
            window: {
                terminals: vscodeTestState.terminals,
                createTerminal: options => {
                    const terminal = {
                        name: options.name,
                        creationOptions: options,
                        processId: Promise.resolve(vscodeTestState.nextTerminalProcessId++),
                        sendText() {},
                    };
                    vscodeTestState.terminals.push(terminal);
                    return terminal;
                },
                showWarningMessage() {},
            },
        };
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};
aiSessionProjectCandidates = require('../out/aiSessions/projectCandidates');
aiSessionSessionPaths = require('../out/aiSessions/sessionPaths');
aiSessionPendingTerminals = require('../out/aiSessions/pendingTerminals');
aiSessionTerminalCandidates = require('../out/aiSessions/terminalCandidates');
aiSessionPendingTerminalResolver = require('../out/aiSessions/pendingTerminalResolver');
aiSessionScanOptions = require('../out/aiSessions/scanOptions');
aiSessionTerminalCwd = require('../out/aiSessions/terminalCwd');
projectWorkspaceHelpers = require('../out/projects/workspaceHelpers');
const AiSessionTerminalService = require('../out/aiSessions/terminalService').default;
const models = require('../out/models');
const openProjectService = require('../out/projects/openProjectService');
const webviewContentModule = require('../out/webview/webviewContent');
const dashboardViewModel = require('../out/webview/dashboardViewModel');
const AiSessionDashboardController = require('../out/aiSessions/dashboardController').AiSessionDashboardController;
const AiSessionCommandController = require('../out/aiSessions/commandController').AiSessionCommandController;
const AiSessionCreationController = require('../out/aiSessions/creationController').AiSessionCreationController;
const AiSessionResumeController = require('../out/aiSessions/resumeController').AiSessionResumeController;
const AiSessionAttentionController = require('../out/aiSessions/attentionController').AiSessionAttentionController;
const AiSessionProjectHydrationController = require('../out/aiSessions/projectHydrationController').AiSessionProjectHydrationController;
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

function runDashboardSearchCatalogChecks() {
    const groups = [{
        id: 'tools', groupName: 'TOOLS', collapsed: false,
        projects: [
            { id: 'saved', name: 'Dashboard', description: 'Saved', path: '/work/dashboard', favorite: true },
            { id: 'duplicate', name: 'Dashboard copy', description: 'Duplicate', path: '/work/dashboard/' },
            { id: 'other', name: 'Other', description: 'Other', path: '/work/other' },
        ],
    }];
    const openProjects = [{
        id: '__openProjects-0', name: 'Dashboard', description: 'Current', path: '/work/dashboard',
        openProjectCardKind: 'current',
        codexSessions: [{ id: 'c1', name: 'Fix dashboard', updatedAt: '2026-07-15T10:00:00Z' }],
        kimiSessions: [{ id: 'k1', name: 'Review layout', updatedAt: '2026-07-15T09:00:00Z' }],
        claudeSessions: [],
    }, {
        id: '__openProjectNavigation-remote', name: 'Remote Dashboard', description: 'Remote',
        path: 'vscode-remote://ssh-remote+host/work/dashboard-api',
        openProjectCardKind: 'projectNavigation', openProjectEnvironmentLabel: 'SSH',
    }];

    const catalog = dashboardViewModel.buildDashboardSearchCatalog(groups, openProjects);
    assert.deepStrictEqual(catalog.sessions.map(item => item.key), ['codex:c1', 'kimi:k1']);
    assert.deepStrictEqual(catalog.openProjects.map(item => item.action), ['open-current', 'switch-open']);
    assert.strictEqual(catalog.savedProjects.length, 2);
    assert.deepStrictEqual(catalog.savedProjects[0].groupLabels, ['FAVORITES', 'TOOLS']);
    assert.strictEqual(catalog.savedProjects[0].identity, '/work/dashboard');
    assert.strictEqual(catalog.openProjects[1].environmentLabel, 'SSH');

    const serialized = dashboardViewModel.serializeDashboardSearchCatalog({
        ...catalog,
        savedProjects: [{ ...catalog.savedProjects[0], name: '</script><script>bad()</script>' }],
    });
    assert.strictEqual(serialized.includes('</script>'), false);
    assert.deepStrictEqual(JSON.parse(serialized).savedProjects[0].name, '</script><script>bad()</script>');
}

function runDashboardDiagnosticsChecks() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-diagnostics-'));
    try {
        const lines = [];
        let nowMs = Date.parse('2026-07-16T12:00:00.000Z');
        const diagnostics = new DashboardDiagnostics({
            outputChannel: { appendLine: line => lines.push(line) },
            globalStoragePath: tempRoot,
            now: () => new Date(nowMs),
            maxOpenProjectDiagnosticBytes: 120,
        });

        diagnostics.logError('Failed action.', new Error('Boom'));
        diagnostics.logAiSessionDiagnostic({ event: 'scan', count: 1 });
        diagnostics.logDashboardDiagnostic({ event: 'refresh' });
        diagnostics.logOpenProjectDiagnostic('Workspace', { event: 'snapshot' });

        assert.strictEqual(lines[0], 'Failed action.');
        assert.ok(lines[1].includes('Boom'));
        assert.strictEqual(lines[2], '[AiSessions] {"event":"scan","count":1}');
        assert.strictEqual(lines[3], '[Dashboard] {"loggedAt":"2026-07-16T12:00:00.000Z","event":"refresh"}');
        assert.strictEqual(lines[4], '[OpenProjects][Workspace] {"event":"snapshot"}');

        const diagnosticPath = path.join(tempRoot, 'open-project-diagnostics.jsonl');
        assert.deepStrictEqual(
            fs.readFileSync(diagnosticPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line).component),
            ['Workspace']
        );

        nowMs += 1000;
        diagnostics.logOpenProjectDiagnostic('Bridge', { event: 'large', payload: 'x'.repeat(100) });
        const persisted = fs.readFileSync(diagnosticPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
        assert.deepStrictEqual(persisted.map(item => item.component), ['Bridge']);
        assert.strictEqual(persisted[0].loggedAt, '2026-07-16T12:00:01.000Z');

        const circular = {};
        circular.self = circular;
        diagnostics.logOpenProjectDiagnostic('Renderer', circular);
        assert.ok(lines.some(line => line.includes('[OpenProjects][Renderer] Failed to serialize diagnostic:')));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function runAttentionProjectionChecks() {
    const aggregate = {
        protocolVersion: 1,
        aggregateRevision: '0'.repeat(64),
        generatedAtMs: 1,
        sessions: [
            { projectId: attentionProject.getAttentionProjectKey('/work/current'), sessionKey: 'codex:c1', reasons: ['completed'], eventIds: ['e1'], observedAtMs: 1 },
            { projectId: attentionProject.getAttentionProjectKey('/work/current'), sessionKey: 'kimi:k1', reasons: ['input-required'], eventIds: ['e2'], observedAtMs: 2 },
            { projectId: attentionProject.getAttentionProjectKey('/work/other'), sessionKey: 'claude:x1', reasons: ['failed'], eventIds: ['e3'], observedAtMs: 3 },
        ],
    };
    const input = [{ path: '/work/current' }, { path: '/work/other' }];
    const projected = attentionProject.withAttentionProjects(input, aggregate);
    assert.deepStrictEqual(projected.map(item => item.aiSessionAttentionCount), [2, 1]);
    assert.deepStrictEqual(projected[0].aiSessionAttentionEventIds, ['e1', 'e2']);
    assert.strictEqual(input[0].aiSessionAttentionCount, undefined);

    const index = attentionProject.buildAttentionSessionIndex(aggregate);
    assert.strictEqual(index.get(attentionProject.getAttentionSessionLookupKey(
        attentionProject.getAttentionProjectKey('/work/current'), 'kimi:k1'
    )).eventIds[0], 'e2');
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

function runOpenProjectRuntimeIdentityChecks() {
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
    assert.strictEqual(openProjects[0].attentionProjectPath, undefined);
}

function runWorkspaceHelperChecks() {
    const workspaceFile = createTestFileUri('/work/app.code-workspace');
    const workspaceFolders = [
        { uri: createTestFileUri('/work/app') },
        { uri: createTestFileUri('/work/packages/api') },
    ];

    assert.strictEqual(
        projectWorkspaceHelpers.getWorkspacePath(workspaceFile, workspaceFolders),
        '/work/app.code-workspace'
    );
    assert.strictEqual(
        projectWorkspaceHelpers.getWorkspaceUri(workspaceFile, workspaceFolders).fsPath,
        '/work/app.code-workspace'
    );
    assert.deepStrictEqual(
        projectWorkspaceHelpers.getWorkspaceUris(null, workspaceFolders).map(uri => uri.fsPath),
        ['/work/app', '/work/packages/api']
    );
    assert.strictEqual(projectWorkspaceHelpers.getWorkspacePath(null, []), null);
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

function runProjectCandidateChecks() {
    const openProjects = [
        { id: 'app', path: '/work/app/' },
        { id: 'remote', path: 'vscode-remote://ssh-remote+host/work/remote' },
    ];
    const workspaceFile = createTestFileUri('/work/app.code-workspace');
    const workspaceFolders = [
        { uri: createTestFileUri('/work/app') },
        { uri: createTestFileUri('/work/app/packages/api') },
        { uri: createTestFileUri('/work/app/packages/api/') },
    ];
    const candidates = aiSessionProjectCandidates.getAiSessionOpenProjectCandidates(
        openProjects,
        workspaceFile,
        workspaceFolders
    );

    assert.deepStrictEqual(candidates.map(candidate => ({
        id: candidate.project.id,
        path: candidate.path,
    })), [
        { id: 'app', path: '/work/app' },
        { id: 'remote', path: '/work/remote' },
        { id: 'app', path: '/work/app/packages/api' },
    ]);
    assert.deepStrictEqual(
        aiSessionProjectCandidates.getAiSessionCandidatePaths(openProjects, workspaceFile, workspaceFolders),
        ['/work/app', '/work/remote', '/work/app/packages/api']
    );
    assert.strictEqual(aiSessionProjectCandidates.getOpenProjectAiSessionKey(openProjects[0]), '/work/app');
    assert.strictEqual(aiSessionProjectCandidates.getOpenProjectTerminalCwd(openProjects[1]), '/work/remote');
    assert.strictEqual(aiSessionProjectCandidates.normalizeAiSessionProjectPath(''), '');
}

function runSessionPathChecks() {
    const providerDefinitions = [
        { id: 'codex', terminalNamePrefix: 'Codex', projectSessionsKey: 'codexSessions', terminalCwdFields: ['cwd'] },
        { id: 'kimi', terminalNamePrefix: 'Kimi', projectSessionsKey: 'kimiSessions', terminalCwdFields: ['workDir', 'cwd'] },
        { id: 'claude', terminalNamePrefix: 'Claude', projectSessionsKey: 'claudeSessions', terminalCwdFields: ['workDir', 'cwd'] },
    ];
    const project = {
        id: 'project-a',
        path: '/work/app',
        codexSessions: [{ id: 'c1', cwd: '/work/app/codex' }],
        kimiSessions: [{ id: 'k1', cwd: '/work/app/kimi-cwd', workDir: '/work/app/kimi-workdir' }],
    };

    assert.deepStrictEqual(
        aiSessionSessionPaths.getProjectAiSessions(project, 'codex', providerDefinitions).map(session => session.id),
        ['c1']
    );
    assert.deepStrictEqual(
        aiSessionSessionPaths.getProjectAiSessions(project, 'claude', providerDefinitions),
        []
    );
    assert.strictEqual(
        aiSessionSessionPaths.getAiSessionComparableCwd('kimi', project.kimiSessions[0], providerDefinitions),
        '/work/app/kimi-workdir'
    );
    assert.strictEqual(
        aiSessionSessionPaths.getAiSessionTerminalCwd('claude', { id: 'missing', name: 'Missing' }, project, providerDefinitions),
        '/work/app'
    );
    assert.strictEqual(
        aiSessionSessionPaths.getAiSessionTerminalName('codex', { id: 'c1', name: 'Fix bug' }, providerDefinitions),
        'Codex: Fix bug [c1]'
    );
    assert.strictEqual(
        aiSessionSessionPaths.getAiSessionTerminalName('unknown', { id: 'u1', name: '<b>Unsafe</b>' }, providerDefinitions),
        'AI: <b>Unsafe</b> [u1]'
    );
}

function runPendingTerminalMatcherChecks() {
    const providerDefinitions = [
        { id: 'codex', terminalNamePrefix: 'Codex', projectSessionsKey: 'codexSessions', terminalCwdFields: ['cwd'] },
        { id: 'kimi', terminalNamePrefix: 'Kimi', projectSessionsKey: 'kimiSessions', terminalCwdFields: ['workDir', 'cwd'] },
    ];
    const result = {
        available: true,
        scannedFiles: 3,
        parsedFiles: 3,
        sessions: [
            { id: 'old', cwd: '/work/app', updatedAt: '2026-07-15T09:59:00Z' },
            { id: 'excluded', cwd: '/work/app', updatedAt: '2026-07-15T10:01:00Z' },
            { id: 'claimed', cwd: '/work/app', updatedAt: '2026-07-15T10:02:00Z' },
            { id: 'newest', cwd: '/work/app', updatedAt: '2026-07-15T10:03:00Z' },
            { id: 'other-cwd', cwd: '/work/other', updatedAt: '2026-07-15T10:04:00Z' },
        ],
    };

    assert.deepStrictEqual(
        aiSessionPendingTerminals.getAiSessionIdsForCwd('codex', result, '/work/app/', providerDefinitions),
        ['old', 'excluded', 'claimed', 'newest']
    );
    assert.deepStrictEqual(
        aiSessionPendingTerminals.getAiSessionIdsForCwd('codex', { ...result, available: false }, '/work/app', providerDefinitions),
        []
    );

    const match = aiSessionPendingTerminals.findPendingAiSessionTerminalMatch({
        provider: 'codex',
        cwd: '/work/app',
        createdAt: '2026-07-15T10:00:00Z',
        excludedSessionIds: ['excluded'],
    }, result, new Set(['codex:claimed']), (providerId, sessionId) => `${providerId}:${sessionId}`, providerDefinitions);

    assert.strictEqual(match.id, 'newest');
    assert.strictEqual(
        aiSessionPendingTerminals.findPendingAiSessionTerminalMatch({
            provider: 'kimi',
            cwd: '/work/app',
            createdAt: '2026-07-15T10:00:00Z',
            excludedSessionIds: [],
        }, {
            ...result,
            sessions: [{ id: 'workdir', cwd: '/fallback', workDir: '/work/app', updatedAt: '2026-07-15T10:05:00Z' }],
        }, new Set(), (providerId, sessionId) => `${providerId}:${sessionId}`, providerDefinitions).id,
        'workdir'
    );
}

function runTerminalCandidateChecks() {
    const calls = [];
    const coordinator = {
        getProviderResult(providerId, options) {
            calls.push([providerId, options]);
            return {
                available: true,
                scannedFiles: 0,
                parsedFiles: 0,
                sessions: [{ id: `${providerId}-one`, name: 'One' }],
            };
        },
    };

    assert.deepStrictEqual(
        aiSessionTerminalCandidates.getAiSessionTerminalCandidates('codex', coordinator),
        [{ id: 'codex-one', name: 'One' }]
    );
    assert.deepStrictEqual(calls, [['codex', { reason: 'terminal-candidates' }]]);
}

function runPendingTerminalResolverChecks() {
    const providerDefinitions = [
        { id: 'codex', terminalNamePrefix: 'Codex', projectSessionsKey: 'codexSessions', terminalCwdFields: ['cwd'] },
    ];
    const pendingTerminals = [
        {
            provider: 'codex',
            terminal: { name: 'Codex: New' },
            markerPath: '/tmp/new.done',
            cwd: '/work/app',
            createdAt: '2026-07-15T10:00:00Z',
            excludedSessionIds: ['old'],
            title: 'Created Alias',
        },
        {
            provider: 'codex',
            terminal: { name: 'Codex: Still Pending' },
            markerPath: '/tmp/pending.done',
            cwd: '/work/other',
            createdAt: '2026-07-15T10:00:00Z',
            excludedSessionIds: [],
        },
    ];
    const tracked = [];
    const aliases = [];
    const replacements = [];
    let synced = 0;
    const terminalService = {
        getPendingTerminals: () => pendingTerminals.slice(),
        getTrackedSessionKeys: getKey => new Set([getKey('codex', 'claimed')]),
        track: (providerId, sessionId, entry) => tracked.push([providerId, sessionId, entry]),
        replacePendingTerminals: remaining => replacements.push(remaining),
    };

    const matched = aiSessionPendingTerminalResolver.resolvePendingAiSessionTerminals({
        terminalService,
        sessionResults: {
            codex: {
                available: true,
                scannedFiles: 3,
                parsedFiles: 3,
                sessions: [
                    { id: 'old', cwd: '/work/app', updatedAt: '2026-07-15T10:01:00Z' },
                    { id: 'claimed', cwd: '/work/app', updatedAt: '2026-07-15T10:02:00Z' },
                    { id: 'new', cwd: '/work/app', updatedAt: '2026-07-15T10:03:00Z' },
                ],
            },
        },
        providers: providerDefinitions,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        setAlias: (providerId, sessionId, alias) => aliases.push([providerId, sessionId, alias]),
        syncActiveTerminal: () => { synced++; },
    });

    assert.strictEqual(matched, true);
    assert.deepStrictEqual(tracked.map(item => item.slice(0, 2)), [['codex', 'new']]);
    assert.strictEqual(tracked[0][2].terminal, pendingTerminals[0].terminal);
    assert.strictEqual(tracked[0][2].markerPath, '/tmp/new.done');
    assert.strictEqual(tracked[0][2].runStartedAtMs, Date.parse('2026-07-15T10:00:00Z'));
    assert.deepStrictEqual(aliases, [['codex', 'new', 'Created Alias']]);
    assert.deepStrictEqual(replacements, [[pendingTerminals[1]]]);
    assert.strictEqual(synced, 1);
}

function runScanOptionChecks() {
    assert.strictEqual(aiSessionScanOptions.getAiSessionScanMaxFiles('alias-original-name', 2000), 0);
    assert.strictEqual(aiSessionScanOptions.getAiSessionScanMaxFiles('terminal-candidates', 2000), 0);
    assert.strictEqual(aiSessionScanOptions.getAiSessionScanMaxFiles('refresh', 2000), 2000);
}

function runTerminalCwdChecks() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-terminal-cwd-'));
    try {
        const nestedFile = path.join(tempRoot, 'src', 'index.ts');
        fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
        fs.writeFileSync(nestedFile, 'export {};\n', 'utf8');

        assert.strictEqual(aiSessionTerminalCwd.getUsableTerminalCwd(tempRoot), tempRoot);
        assert.strictEqual(aiSessionTerminalCwd.getUsableTerminalCwd(nestedFile), path.dirname(nestedFile));
        assert.strictEqual(aiSessionTerminalCwd.getUsableTerminalCwd('vscode-remote://ssh-remote+host/work/app'), null);
        assert.strictEqual(aiSessionTerminalCwd.getUsableTerminalCwd(path.join(tempRoot, 'missing')), null);
        assert.strictEqual(aiSessionTerminalCwd.getUsableTerminalCwd(''), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
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

async function runPinControllerChecks() {
    const events = [];
    const errors = [];
    const store = {
        getAll: () => new Set(['codex:pinned']),
        toggle: key => {
            events.push(['toggle', key]);
            return true;
        },
        remove: key => events.push(['remove', key]),
        migrateLegacy: pinned => events.push(['migrate', pinned]),
    };
    const controller = new AiSessionPinController({
        store,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        logError: (message, error) => errors.push([message, error.message]),
        showUpdateError: () => events.push(['show-update-error']),
    });

    assert.deepStrictEqual(Array.from(controller.getAll()), ['codex:pinned']);
    assert.strictEqual(controller.toggle('codex', 'p1'), true);
    controller.remove('codex', 'p1');
    await controller.migrateLegacy(['legacy'], () => {
        events.push(['clear']);
        return Promise.resolve();
    });
    assert.deepStrictEqual(events, [
        ['toggle', 'codex:p1'],
        ['remove', 'codex:p1'],
        ['migrate', ['legacy']],
        ['clear'],
    ]);
    assert.deepStrictEqual(errors, []);

    const failingController = new AiSessionPinController({
        store: {
            getAll: () => { throw new Error('read failed'); },
            toggle: () => { throw new Error('toggle failed'); },
            remove: () => { throw new Error('remove failed'); },
            migrateLegacy: () => { throw new Error('migrate failed'); },
        },
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        logError: (message, error) => errors.push([message, error.message]),
        showUpdateError: () => events.push(['show-update-error']),
    });

    assert.deepStrictEqual(Array.from(failingController.getAll()), []);
    assert.strictEqual(failingController.toggle('codex', 'p1'), false);
    failingController.remove('codex', 'p1');
    await failingController.migrateLegacy(['legacy'], () => Promise.resolve());
    assert.deepStrictEqual(errors.map(item => item[0]), [
        'Failed to read pinned AI sessions.',
        'Failed to update the pinned AI session.',
        'Failed to delete the pinned AI session.',
        'Failed to migrate pinned AI sessions.',
    ]);
    assert.deepStrictEqual(events.slice(-1), [['show-update-error']]);
}

function runAliasStoreChecks() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-aliases-'));
    try {
        const store = new AiSessionAliasStore(tempRoot);
        assert.deepStrictEqual(store.getAll(), {});

        store.set('codex:c1', '  Renamed\nChat  ');
        assert.deepStrictEqual(store.getAll(), { 'codex:c1': 'Renamed Chat' });

        store.set('codex:empty', '   ');
        assert.deepStrictEqual(store.getAll(), { 'codex:c1': 'Renamed Chat' });

        store.saveAll({
            'codex:c1': 'Renamed Chat',
            'kimi:k1': ' Kimi Alias ',
            'claude:empty': '',
            'bad:number': 1,
        });
        assert.deepStrictEqual(store.getAll(), {
            'codex:c1': 'Renamed Chat',
            'kimi:k1': ' Kimi Alias ',
        });

        store.remove('codex:c1');
        assert.deepStrictEqual(store.getAll(), { 'kimi:k1': ' Kimi Alias ' });

        fs.writeFileSync(path.join(tempRoot, 'ai-session-aliases.json'), '[]', 'utf8');
        assert.deepStrictEqual(store.getAll(), {});
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function runAliasControllerChecks() {
    const saved = [];
    const removed = [];
    const setAliases = [];
    const errors = [];
    let showSaveErrorCount = 0;
    const store = {
        getAll: () => ({ 'codex:c1': 'Renamed' }),
        saveAll: aliases => saved.push(aliases),
        remove: key => removed.push(key),
        set: (key, alias) => setAliases.push([key, alias]),
    };
    const baseOptions = {
        store,
        isProviderId: value => value === 'codex' || value === 'kimi' || value === 'claude',
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        getProviderResult: (providerId, options) => {
            assert.deepStrictEqual([providerId, options], ['codex', { reason: 'alias-original-name' }]);
            return {
                available: true,
                scannedFiles: 1,
                parsedFiles: 1,
                sessions: [{ id: 'c1', name: 'Original' }],
            };
        },
        logError: (message, error) => errors.push([message, error.message]),
        showSaveError: () => { showSaveErrorCount++; },
    };
    const controller = new AiSessionAliasController(baseOptions);

    assert.deepStrictEqual(controller.getAll(), { 'codex:c1': 'Renamed' });
    controller.saveAll({ 'codex:c2': 'Second' });
    controller.remove('codex', 'c1');
    controller.set('codex', 'c3', '  Alias\nThree ');
    controller.set('unknown', 'bad', 'Alias');
    controller.set('codex', 'empty', '   ');

    assert.deepStrictEqual(saved, [{ 'codex:c2': 'Second' }]);
    assert.deepStrictEqual(removed, ['codex:c1']);
    assert.deepStrictEqual(setAliases, [['codex:c3', 'Alias Three']]);
    assert.strictEqual(controller.getOriginalName('codex', 'c1'), 'Original');
    assert.strictEqual(controller.getOriginalName('codex', 'missing'), 'missing');

    const failingController = new AiSessionAliasController({
        ...baseOptions,
        store: {
            getAll: () => { throw new Error('read failed'); },
            saveAll: () => { throw new Error('save failed'); },
            remove: () => { throw new Error('remove failed'); },
            set: () => { throw new Error('set failed'); },
        },
    });
    assert.deepStrictEqual(failingController.getAll(), {});
    failingController.saveAll({});
    failingController.remove('codex', 'c1');
    failingController.set('codex', 'c1', 'Alias');
    assert.strictEqual(showSaveErrorCount, 2);
    assert.deepStrictEqual(errors.map(item => item[0]), [
        'Failed to read AI session aliases.',
        'Failed to save AI session aliases.',
        'Failed to delete AI session alias.',
        'Failed to save AI session alias.',
    ]);
}

async function runProjectStateStoreChecks() {
    const data = {
        openProjectsExpandedCodexSessions: ['project-a', 1, '', 'project-b'],
        openProjectsActiveAiSessionProvider: {
            'project-a': 'codex',
            'project-b': 'unknown',
            'project-c': 'kimi',
        },
    };
    const updates = [];
    const state = {
        get: key => data[key],
        update: async (key, value) => {
            updates.push([key, value]);
            data[key] = value;
        },
    };
    const store = new AiSessionProjectStateStore(state, value => value === 'codex' || value === 'kimi' || value === 'claude');

    assert.deepStrictEqual(Array.from(store.getExpandedProjects()), ['project-a', 'project-b']);
    assert.deepStrictEqual(store.getActiveProviders(), {
        'project-a': 'codex',
        'project-c': 'kimi',
    });

    await store.setExpanded('project-c', true);
    await store.setExpanded('project-a', false);
    await store.setActiveProvider('project-d', 'claude');
    await store.setActiveProvider('project-e', 'unknown');

    assert.deepStrictEqual(updates, [
        ['openProjectsExpandedCodexSessions', ['project-a', 'project-b', 'project-c']],
        ['openProjectsExpandedCodexSessions', ['project-b', 'project-c']],
        ['openProjectsActiveAiSessionProvider', {
            'project-a': 'codex',
            'project-c': 'kimi',
            'project-d': 'claude',
        }],
    ]);
}

async function runAiSessionCommandControllerChecks() {
    const projects = [
        { id: 'project-a', path: '/work/a' },
        { id: 'project-b', path: '/work/b' },
    ];
    const expanded = [];
    const activeProviders = [];
    const refreshes = [];
    const clipboardWrites = [];
    const infoMessages = [];
    const aliases = {};
    const pinToggles = [];
    const inputPrompts = [];
    let pinToggleResult = true;
    let nextInputValue = '  Renamed Chat  ';
    const controller = new AiSessionCommandController({
        getOpenProjects: () => projects,
        getProjectKey: project => `key:${project.path}`,
        isProviderId: value => value === 'codex' || value === 'kimi' || value === 'claude',
        setExpanded: async (projectKey, value) => expanded.push([projectKey, value]),
        setActiveProvider: async (projectKey, providerId) => activeProviders.push([projectKey, providerId]),
        togglePin: (providerId, sessionId) => {
            pinToggles.push([providerId, sessionId]);
            return pinToggleResult;
        },
        getAliases: () => aliases,
        saveAliases: values => {
            const savedValues = { ...values };
            Object.keys(aliases).forEach(key => delete aliases[key]);
            Object.assign(aliases, savedValues);
        },
        getOriginalName: (providerId, sessionId) => `${providerId}:${sessionId}:original`,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        showInputBox: async options => {
            inputPrompts.push(options);
            return nextInputValue;
        },
        writeClipboard: async value => clipboardWrites.push(value),
        showInformationMessage: message => infoMessages.push(message),
        refresh: () => refreshes.push('refresh'),
    });

    await controller.toggleSessionsExpanded('project-a', true);
    assert.deepStrictEqual(expanded, [['key:/work/a', true]]);

    await controller.selectProvider('project-a', 'kimi');
    assert.deepStrictEqual(activeProviders, [['key:/work/a', 'kimi']]);
    assert.strictEqual(refreshes.length, 1);

    await controller.selectProvider('missing', 'codex');
    await controller.selectProvider('project-a', 'invalid');
    assert.strictEqual(activeProviders.length, 1);

    await controller.togglePin('codex', 'session-1');
    assert.deepStrictEqual(pinToggles, [['codex', 'session-1']]);
    assert.strictEqual(refreshes.length, 2);
    pinToggleResult = false;
    await controller.togglePin('codex', 'session-2');
    assert.deepStrictEqual(pinToggles, [['codex', 'session-1'], ['codex', 'session-2']]);
    assert.strictEqual(refreshes.length, 2);

    await controller.renameSession('codex', 'session-1');
    assert.strictEqual(aliases['codex:session-1'], 'Renamed Chat');
    assert.strictEqual(inputPrompts[0].placeHolder, 'codex:session-1:original');
    assert.strictEqual(refreshes.length, 3);

    nextInputValue = 'codex:session-1:original';
    await controller.renameSession('codex', 'session-1');
    assert.strictEqual(aliases['codex:session-1'], undefined);

    await controller.copySessionId('session-1');
    assert.deepStrictEqual(clipboardWrites, ['session-1']);
    assert.deepStrictEqual(infoMessages, ['Chat ID copied to clipboard.']);
}

async function runAiSessionCreationControllerChecks() {
    const projects = [
        { id: 'project-a', name: 'Project A', path: '/work/a' },
    ];
    const warnings = [];
    const terminals = [];
    const tracked = [];
    const sent = [];
    const scheduled = [];
    const existingSessionInputs = [];
    let nextInputValue = '  Test Title  ';
    let usableCwd = '/work/a';
    const controller = new AiSessionCreationController({
        isProviderId: value => value === 'codex' || value === 'kimi' || value === 'claude',
        getOpenProjects: () => projects,
        getProviderLabel: providerId => providerId.toUpperCase(),
        getProvider: providerId => ({
            id: providerId,
            label: providerId.toUpperCase(),
            terminalNamePrefix: `${providerId}-terminal`,
        }),
        getTerminalCwd: project => project.path,
        getUsableTerminalCwd: () => usableCwd,
        showInputBox: async () => nextInputValue,
        showWarningMessage: message => warnings.push(message),
        createTerminal: options => {
            const terminal = { name: options.name, showCalls: 0, show() { this.showCalls += 1; } };
            terminals.push({ terminal, options });
            return { terminal, cwdAccepted: true };
        },
        getExistingSessionIdsForCwd: (providerId, cwd) => {
            existingSessionInputs.push([providerId, cwd]);
            return [`existing:${providerId}:${cwd}`];
        },
        getPendingMarkerPath: providerId => `/tmp/${providerId}.marker`,
        trackPendingTerminal: pending => tracked.push(pending),
        sendNewSessionCommand: async (providerId, terminal, cwd, title, markerPath) => sent.push([providerId, terminal, cwd, title, markerPath]),
        scheduleNewSessionRefresh: providerId => scheduled.push(providerId),
    });

    await controller.createSession('missing', 'codex');
    assert.deepStrictEqual(warnings, ['Open project not found.']);
    assert.strictEqual(terminals.length, 0);

    await controller.createSession('project-a', 'invalid');
    assert.strictEqual(terminals.length, 0);

    nextInputValue = undefined;
    await controller.createSession('project-a', 'codex');
    assert.strictEqual(terminals.length, 0);

    nextInputValue = '  Test Title  ';
    await controller.createSession('project-a', 'codex');
    assert.strictEqual(terminals[0].options.name, 'codex-terminal: Project A');
    assert.strictEqual(terminals[0].options.cwd, '/work/a');
    assert.strictEqual(tracked[0].provider, 'codex');
    assert.strictEqual(tracked[0].cwd, '/work/a');
    assert.deepStrictEqual(tracked[0].excludedSessionIds, ['existing:codex:/work/a']);
    assert.strictEqual(tracked[0].title, 'Test Title');
    assert.deepStrictEqual(sent[0], ['codex', terminals[0].terminal, '/work/a', 'Test Title', '/tmp/codex.marker']);
    assert.deepStrictEqual(scheduled, ['codex']);
    assert.strictEqual(terminals[0].terminal.showCalls, 1);

    usableCwd = null;
    nextInputValue = '';
    await controller.createSession('project-a', 'kimi');
    assert.strictEqual(terminals[1].options.cwd, null);
    assert.deepStrictEqual(existingSessionInputs[1], ['kimi', '/work/a']);
    assert.strictEqual(tracked[1].cwd, '/work/a');
    assert.deepStrictEqual(sent[1], ['kimi', terminals[1].terminal, null, '', '/tmp/kimi.marker']);
}

async function runAiSessionResumeControllerChecks() {
    const session = { id: 'session-a', name: 'Session A', cwd: '/work/a', updatedAt: '2026-07-16T10:00:00Z' };
    const projects = [
        { id: 'project-a', name: 'Project A', path: '/work/a' },
    ];
    const warnings = [];
    const shown = [];
    const begins = [];
    const finishes = [];
    const created = [];
    const tracked = [];
    const sent = [];
    const synced = [];
    const pendingLookups = [];
    let existingEntry = null;
    let beginResult = true;
    let createCwdAccepted = false;
    let pendingTerminal = null;
    let rejectResumeSend = false;
    const makeTerminal = name => ({ name, show() { shown.push(name); } });
    const controller = new AiSessionResumeController({
        getOpenProjects: () => projects,
        getProvider: providerId => ({ label: providerId.toUpperCase(), terminalEnvKey: `${providerId.toUpperCase()}_SESSION_ID` }),
        getProjectSession: (project, providerId, sessionId) => project.id === 'project-a' && providerId === 'codex' && sessionId === session.id ? session : null,
        getTerminalCwd: () => '/work/a',
        getTerminalName: (providerId, value) => `${providerId}: ${value.name}`,
        getComparableCwd: () => '/work/a',
        getUsableTerminalCwd: cwd => cwd,
        normalizeProjectPath: cwd => cwd,
        getExistingTerminal: () => existingEntry,
        isTerminalComplete: entry => Boolean(entry.complete),
        beginResume: (providerId, sessionId) => {
            begins.push([providerId, sessionId]);
            return beginResult;
        },
        finishResume: (providerId, sessionId) => finishes.push([providerId, sessionId]),
        getMarkerPath: (providerId, sessionId) => `/tmp/${providerId}-${sessionId}.marker`,
        findPendingTerminalForSession: (providerId, sessionId, cwd, updatedAt) => {
            pendingLookups.push([providerId, sessionId, cwd, updatedAt]);
            return pendingTerminal;
        },
        createTerminal: options => {
            const terminal = makeTerminal(`created:${created.length}`);
            created.push(options);
            return { terminal, cwdAccepted: createCwdAccepted };
        },
        track: (providerId, sessionId, entry) => tracked.push([providerId, sessionId, entry]),
        sendResumeCommand: async (providerId, terminal, sessionId, cwd, markerPath) => {
            if (rejectResumeSend) {
                throw new Error('send failed');
            }
            sent.push([providerId, terminal, sessionId, cwd, markerPath]);
        },
        showWarningMessage: message => warnings.push(message),
        syncActiveTerminal: () => synced.push('sync'),
        logError() {},
        nowMs: () => 123456,
    });

    await controller.resumeProjectSession('project-a', null, session.id);
    assert.strictEqual(begins.length, 0);

    await controller.resumeProjectSession('project-a', 'codex', 'missing');
    assert.deepStrictEqual(warnings, ['Selected CODEX session not found.']);
    assert.strictEqual(begins.length, 0);

    existingEntry = { terminal: makeTerminal('existing-running'), markerPath: '/tmp/existing.marker', complete: false };
    await controller.resumeProjectSession('project-a', 'codex', session.id);
    assert.deepStrictEqual(shown, ['existing-running']);
    assert.strictEqual(begins.length, 0);

    existingEntry = null;
    beginResult = false;
    await controller.resumeProjectSession('project-a', 'codex', session.id);
    assert.deepStrictEqual(begins, [['codex', session.id]]);
    assert.strictEqual(created.length, 0);

    beginResult = true;
    await controller.resumeProjectSession('project-a', 'codex', session.id);
    assert.strictEqual(created[0].name, 'codex: Session A');
    assert.deepStrictEqual(created[0].env, { CODEX_SESSION_ID: session.id });
    assert.deepStrictEqual(pendingLookups[0], ['codex', session.id, '/work/a', session.updatedAt]);
    assert.deepStrictEqual(tracked[0][0], 'codex');
    assert.strictEqual(tracked[0][2].markerPath, `/tmp/codex-${session.id}.marker`);
    assert.strictEqual(tracked[0][2].runStartedAtMs, 123456);
    assert.deepStrictEqual(sent[0], ['codex', tracked[0][2].terminal, session.id, null, `/tmp/codex-${session.id}.marker`]);
    assert.deepStrictEqual(finishes.slice(-1)[0], ['codex', session.id]);
    assert.deepStrictEqual(synced, ['sync']);

    createCwdAccepted = true;
    pendingTerminal = { terminal: makeTerminal('pending'), markerPath: '/tmp/pending.marker' };
    await controller.resumeProjectSession('project-a', 'codex', session.id);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(tracked[1][2].terminal, pendingTerminal.terminal);
    assert.deepStrictEqual(sent[1], ['codex', pendingTerminal.terminal, session.id, '/work/a', '/tmp/pending.marker']);

    pendingTerminal = null;
    rejectResumeSend = true;
    const finishCountBeforeReject = finishes.length;
    const syncCountBeforeReject = synced.length;
    let rejected = false;
    try {
        await controller.resumeProjectSession('project-a', 'codex', session.id);
    } catch (error) {
        rejected = true;
        assert.strictEqual(error.message, 'send failed');
    }
    assert.strictEqual(rejected, true);
    assert.strictEqual(finishes.length, finishCountBeforeReject + 1);
    assert.strictEqual(synced.length, syncCountBeforeReject);
}

async function runAiSessionAttentionControllerChecks() {
    let nowMs = 1000;
    let enabled = true;
    const projects = [{
        id: 'project-a',
        path: '/work/a',
        codexSessions: [{ id: 'session-a', updatedAt: '2026-07-16T10:00:00Z' }],
        kimiSessions: [],
        claudeSessions: [],
    }];
    const providersForTest = [{
        id: 'codex',
        projectSessionsKey: 'codexSessions',
        service: {
            getLifecycleSignals: requests => Object.fromEntries(requests.map(request => [
                request.sessionId,
                {
                    token: `codex:complete:${request.sessionId}`,
                    phase: 'needsAttention',
                    reason: 'completed',
                    occurredAtMs: 1100,
                },
            ])),
        },
    }, {
        id: 'kimi',
        projectSessionsKey: 'kimiSessions',
        service: { getLifecycleSignals: () => ({}) },
    }, {
        id: 'claude',
        projectSessionsKey: 'claudeSessions',
        service: { getLifecycleSignals: () => ({}) },
    }];
    const terminalEntries = new Map([
        ['codex:session-a', { runStartedAtMs: 900, complete: false }],
    ]);
    const published = [];
    const scheduled = [];
    const postedSummaries = [];
    const controller = new AiSessionAttentionController({
        isEnabled: () => enabled,
        getOpenProjects: () => projects,
        getProviders: () => providersForTest,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        getProjectKey: project => attentionProject.getAttentionProjectKey(project.path),
        getTerminalById: (providerId, sessionId) => terminalEntries.get(`${providerId}:${sessionId}`) || null,
        isTerminalComplete: entry => Boolean(entry.complete),
        publish: async (items, forceHeartbeat) => {
            published.push({ items: items.map(item => ({ ...item })), forceHeartbeat: Boolean(forceHeartbeat) });
            return true;
        },
        scheduleRefresh: reason => scheduled.push(reason),
        postProjectsUpdated: summaries => postedSummaries.push(summaries.map(summary => ({ ...summary }))),
        nowMs: () => nowMs,
    });

    await controller.evaluate();
    assert.deepStrictEqual(scheduled, ['attention']);
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].forceHeartbeat, false);
    assert.strictEqual(published[0].items.length, 1);
    assert.strictEqual(published[0].items[0].projectId, attentionProject.getAttentionProjectKey('/work/a'));
    assert.strictEqual(published[0].items[0].sessionKey, 'codex:session-a');
    assert.strictEqual(published[0].items[0].state, 'needsAttention');
    assert.strictEqual(published[0].items[0].reason, 'completed');
    assert.strictEqual(published[0].items[0].observedAtMs, 1100);
    assert.strictEqual(postedSummaries.length, 1, 'local fallback posts project summaries when no bridge aggregate is available');
    assert.deepStrictEqual(controller.getRecoverySessionEvents(), [{
        sessionKey: 'codex:session-a',
        eventIds: [published[0].items[0].eventId],
    }]);
    assert.strictEqual(controller.getEffectiveAggregate().sessions[0].sessionKey, 'codex:session-a');
    assert.strictEqual(controller.hasRemoteAggregate(), false);
    await controller.acknowledge([published[0].items[0].eventId]);
    assert.strictEqual(controller.getLocalSnapshot()['codex:session-a'].state, 'acknowledged');
    assert.strictEqual(controller.getEffectiveAggregate().sessions.length, 0, 'local fallback aggregate must reflect acknowledged owner events immediately');

    const remoteAggregate = {
        protocolVersion: 1,
        aggregateRevision: '1'.repeat(64),
        generatedAtMs: 1200,
        sessions: [{
            projectId: attentionProject.getAttentionProjectKey('/work/remote'),
            sessionKey: 'kimi:remote',
            reasons: ['input-required'],
            eventIds: ['remote-event'],
            observedAtMs: 1200,
        }],
    };
    assert.strictEqual(controller.setRemoteAggregate(remoteAggregate), true);
    assert.strictEqual(controller.setRemoteAggregate(remoteAggregate), false);
    assert.strictEqual(controller.hasRemoteAggregate(), true);
    assert.strictEqual(controller.getEffectiveAggregate().sessions[0].sessionKey, 'kimi:remote');
    assert.deepStrictEqual(controller.getRecoverySessionEvents().map(item => item.sessionKey), ['codex:session-a', 'kimi:remote']);

    enabled = false;
    await controller.evaluate();
    assert.strictEqual(controller.hasRemoteAggregate(), false);
    assert.deepStrictEqual(controller.getLocalSnapshot(), {});
    assert.deepStrictEqual(published[published.length - 1], { items: [], forceHeartbeat: true });
    assert.deepStrictEqual(scheduled.slice(-1), ['attention']);
}

async function runAiSessionProjectHydrationControllerChecks() {
    let refreshReason = 'refresh';
    const codexSession = {
        id: 'session-a',
        name: 'Original Name',
        cwd: '/work/a',
        updatedAt: '2026-07-16T10:00:00Z',
    };
    const providersForTest = [{
        id: 'codex',
        terminalNamePrefix: 'Codex',
        projectSessionsKey: 'codexSessions',
        projectSessionsUnavailableKey: 'codexSessionsUnavailable',
        terminalCwdFields: ['cwd'],
    }, {
        id: 'kimi',
        terminalNamePrefix: 'Kimi',
        projectSessionsKey: 'kimiSessions',
        projectSessionsUnavailableKey: 'kimiSessionsUnavailable',
        terminalCwdFields: ['cwd'],
    }, {
        id: 'claude',
        terminalNamePrefix: 'Claude',
        projectSessionsKey: 'claudeSessions',
        projectSessionsUnavailableKey: 'claudeSessionsUnavailable',
        terminalCwdFields: ['cwd'],
    }];
    const readOptions = [];
    const assignmentInputs = [];
    const terminalService = {
        pending: [],
        tracked: [],
        replaced: [],
        getPendingTerminals() {
            return this.pending;
        },
        getTrackedSessionKeys() {
            return new Set();
        },
        track(providerId, sessionId, entry) {
            this.tracked.push([providerId, sessionId, entry]);
        },
        replacePendingTerminals(pending) {
            this.replaced.push(pending);
            this.pending = pending;
        },
        trackPending(pending) {
            this.pending.push(pending);
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
        getProviders: () => providersForTest,
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
                    candidates,
                    sessionPath: getSessionPath('codex', codexSession),
                    sessionResults,
                });
                return {
                    codex: new Map([['project-a', [codexSession]]]),
                    kimi: new Map(),
                    claude: new Map(),
                };
            },
        },
        terminalService,
        setAlias: (providerId, sessionId, alias) => aliasesSet.push([providerId, sessionId, alias]),
        syncActiveTerminal: () => synced.push('sync'),
        getSessionComparableCwd: (providerId, session) => session.cwd,
        getExpandedProjects: () => new Set(['key:/work/a']),
        getActiveProviders: () => ({ 'key:/work/a': 'codex' }),
        getPinnedSessions: () => new Set(['codex:session-a']),
        getAliases: () => ({ 'codex:session-a': 'Renamed Name' }),
        getAttentionAggregate: () => ({
            protocolVersion: 1,
            aggregateRevision: '2'.repeat(64),
            generatedAtMs: 1,
            sessions: [{
                projectId: attentionProject.getAttentionProjectKey('/work/a'),
                sessionKey: 'codex:session-a',
                reasons: ['completed'],
                eventIds: [attentionEventId],
                observedAtMs: 2,
            }],
        }),
        getLocalAttentionBySession: () => ({}),
        hasRemoteAttentionAggregate: () => true,
        getProjectKey: project => `key:${project.path}`,
        normalizeProjectPath: value => value ? value.replace(/\/+$/, '') : '',
        nowMs: () => {
            nowMs += 7;
            return nowMs;
        },
        logDiagnostic: event => diagnostics.push(event),
    });

    assert.deepStrictEqual(controller.hydrate([]), []);
    assert.strictEqual(readOptions.length, 0);
    assert.deepStrictEqual(diagnostics[0], {
        event: 'ai-session-hydration',
        reason: 'refresh',
        durationMs: 7,
        projectCount: 0,
        hydratedProjectCount: 0,
        candidatePathCount: 0,
        providerCount: 3,
        sessionCount: 0,
        pendingTerminalCount: 0,
        cacheHit: false,
    });

    terminalService.pending = [{
        provider: 'codex',
        terminal: { name: 'pending-terminal' },
        markerPath: '/tmp/session-a.done',
        cwd: '/work/a',
        createdAt: '2026-07-16T10:00:00.000Z',
        excludedSessionIds: [],
        title: ' Pending Alias ',
    }];
    const hydrated = controller.hydrate([{ id: 'project-a', path: '/work/a', name: 'Project A' }]);

    assert.deepStrictEqual(readOptions[0], {
        candidatePaths: ['/work/a'],
        reason: 'refresh',
        maxFiles: 123,
    });
    assert.deepStrictEqual(diagnostics[1], {
        event: 'ai-session-hydration',
        reason: 'refresh',
        durationMs: 7,
        projectCount: 1,
        hydratedProjectCount: 1,
        candidatePathCount: 1,
        providerCount: 3,
        sessionCount: 1,
        pendingTerminalCount: 1,
        cacheHit: false,
    });
    assert.strictEqual(assignmentInputs[0].candidates[0].path, '/work/a');
    assert.strictEqual(assignmentInputs[0].sessionPath, '/work/a');
    assert.strictEqual(terminalService.tracked[0][0], 'codex');
    assert.strictEqual(terminalService.tracked[0][1], 'session-a');
    assert.strictEqual(terminalService.tracked[0][2].runStartedAtMs, Date.parse('2026-07-16T10:00:00.000Z'));
    assert.deepStrictEqual(aliasesSet, [['codex', 'session-a', ' Pending Alias ']]);
    assert.deepStrictEqual(synced, ['sync']);
    assert.strictEqual(hydrated[0].codexSessionsUnavailable, false);
    assert.strictEqual(hydrated[0].kimiSessionsUnavailable, true);
    assert.strictEqual(hydrated[0].codexSessionsExpanded, true);
    assert.strictEqual(hydrated[0].activeAiSessionProvider, 'codex');
    assert.strictEqual(hydrated[0].codexSessions[0].name, 'Renamed Name');
    assert.strictEqual(hydrated[0].codexSessions[0].pinned, true);
    assert.deepStrictEqual(hydrated[0].codexSessions[0].attention, {
        eventId: attentionEventId,
        reason: 'completed',
        unread: true,
    });

    refreshReason = 'terminal-candidates';
    controller.hydrate([{ id: 'project-a', path: '/work/a', name: 'Project A' }]);
    assert.strictEqual(readOptions[1].maxFiles, 0);
    controller.hydrate([{ id: 'project-a', path: '/work/a', name: 'Project A' }]);
    assert.strictEqual(readOptions.length, 2, 'same-turn hydration cache should avoid duplicate reads');
    assert.strictEqual(diagnostics[3].cacheHit, true);
    assert.strictEqual(diagnostics[3].reason, 'terminal-candidates');
    controller.hydrate([{ id: 'project-a', path: '/work/a', name: 'Project A', isGitRepo: true }]);
    assert.strictEqual(readOptions.length, 3, 'hydration cache signature must include all raw project fields');
    providersForTest[0].projectSessionsUnavailableKey = 'codexSessionsTemporarilyUnavailable';
    controller.hydrate([{ id: 'project-a', path: '/work/a', name: 'Project A', isGitRepo: true }]);
    assert.strictEqual(readOptions.length, 4, 'hydration cache signature must include provider rendering fields');
    providersForTest[0].projectSessionsUnavailableKey = 'codexSessionsUnavailable';
    workspaceFile = createTestFileUri('/work/missing.code-workspace');
    workspaceFolders = [{ uri: createTestFileUri('/work/shared') }];
    controller.hydrate([
        { id: 'project-a', path: '/work/a', name: 'Project A' },
        { id: 'project-b', path: '/work/b', name: 'Project B' },
    ]);
    assert.strictEqual(readOptions.length, 5);
    assert.deepStrictEqual(
        assignmentInputs[assignmentInputs.length - 1].candidates.map(candidate => ({
            projectId: candidate.project.id,
            path: candidate.path,
        })),
        [
            { projectId: 'project-a', path: '/work/a' },
            { projectId: 'project-b', path: '/work/b' },
            { projectId: 'project-a', path: '/work/shared' },
        ]
    );
    workspaceFile = createTestFileUri('/work/b');
    controller.hydrate([
        { id: 'project-a', path: '/work/a', name: 'Project A' },
        { id: 'project-b', path: '/work/b', name: 'Project B' },
    ]);
    assert.strictEqual(readOptions.length, 6, 'hydration cache signature must include candidate project ownership');
    assert.deepStrictEqual(
        assignmentInputs[assignmentInputs.length - 1].candidates.map(candidate => ({
            projectId: candidate.project.id,
            path: candidate.path,
        })),
        [
            { projectId: 'project-a', path: '/work/a' },
            { projectId: 'project-b', path: '/work/b' },
            { projectId: 'project-b', path: '/work/shared' },
        ]
    );
    await Promise.resolve();
    controller.hydrate([
        { id: 'project-a', path: '/work/a', name: 'Project A' },
        { id: 'project-b', path: '/work/b', name: 'Project B' },
    ]);
    assert.strictEqual(readOptions.length, 7, 'hydration cache must clear after the current turn');

    controller.trackPendingTerminal('codex', null, '/tmp/skip.done', '/work/a', '2026-07-16T10:00:00.000Z', [], 'skip');
    controller.trackPendingTerminal('codex', { name: 'terminal' }, '', '/work/a', '2026-07-16T10:00:00.000Z', [], 'skip');
    controller.trackPendingTerminal('codex', { name: 'terminal' }, '/tmp/manual.done', '/work/a/', '2026-07-16T10:00:00.000Z', ['session-a', '', null, 'session-b'], ' Manual\nTitle ');
    const manualPending = terminalService.pending[terminalService.pending.length - 1];
    assert.strictEqual(manualPending.provider, 'codex');
    assert.strictEqual(manualPending.cwd, '/work/a');
    assert.deepStrictEqual(manualPending.excludedSessionIds, ['session-a', 'session-b']);
    assert.strictEqual(manualPending.title, 'Manual Title');
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
        const service = new AiSessionTerminalService(tempRoot, providers.AI_SESSION_PROVIDER_IDS.map(providerId =>
            providers.getAiSessionProviderDefinition(providerId)), 0
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

async function runAiSessionTerminalBindingStoreChecks() {
    const stateData = {};
    const state = {
        get: (key, fallback) => Object.prototype.hasOwnProperty.call(stateData, key) ? stateData[key] : fallback,
        update: async (key, value) => { stateData[key] = value; },
    };
    const processId = 42001;
    const first = new AiSessionTerminalBindingStore(state);
    first.setPending(Promise.resolve(processId), {
        providerId: 'codex',
        markerPath: '/tmp/pending.done',
        cwd: '/work/app',
        createdAt: '2026-07-15T08:00:00.000Z',
        excludedSessionIds: ['old'],
        title: 'New chat',
    });
    await first.flush();

    const restoredPending = new AiSessionTerminalBindingStore(state).get(processId);
    assert.strictEqual(restoredPending.state, 'pending');
    assert.strictEqual(restoredPending.providerId, 'codex');
    assert.deepStrictEqual(restoredPending.excludedSessionIds, ['old']);
    assert.ok(stateData[AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX + processId]);

    const second = new AiSessionTerminalBindingStore(state);
    second.setBound(processId, {
        providerId: 'codex',
        sessionId: 'session-new',
        markerPath: '/tmp/session-new.done',
        runStartedAtMs: 1784102400000,
    });
    await second.flush();
    assert.strictEqual(new AiSessionTerminalBindingStore(state).get(processId).sessionId, 'session-new');

    const invalidProcessId = 42009;
    stateData[AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX + invalidProcessId] = {
        version: 2,
        state: 'bound',
        providerId: 'invalid',
        sessionId: 'bad',
        markerPath: '/tmp/bad.done',
        runStartedAtMs: 1,
        updatedAtMs: 1,
    };
    const withInvalid = new AiSessionTerminalBindingStore(state);
    assert.strictEqual(withInvalid.get(invalidProcessId), null);
    assert.strictEqual(withInvalid.get(processId).sessionId, 'session-new');

    withInvalid.remove(Promise.resolve(processId));
    await withInvalid.flush();
    assert.strictEqual(new AiSessionTerminalBindingStore(state).get(processId), null);

    const concurrentData = {};
    const pendingUpdates = [];
    const concurrentState = {
        get: (key, fallback) => Object.prototype.hasOwnProperty.call(concurrentData, key) ? concurrentData[key] : fallback,
        update: (key, value) => new Promise(resolve => pendingUpdates.push({ key, value, resolve })),
    };
    const leftProcessId = 42002;
    const rightProcessId = 42003;
    const leftStore = new AiSessionTerminalBindingStore(concurrentState);
    const rightStore = new AiSessionTerminalBindingStore(concurrentState);
    leftStore.setBound(Promise.resolve(leftProcessId), {
        providerId: 'codex', sessionId: 'left', markerPath: '/tmp/left.done', runStartedAtMs: 1,
    });
    rightStore.setBound(Promise.resolve(rightProcessId), {
        providerId: 'codex', sessionId: 'right', markerPath: '/tmp/right.done', runStartedAtMs: 2,
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(pendingUpdates.length, 2, 'both windows must reach workspaceState.update concurrently');
    pendingUpdates.forEach(update => {
        concurrentData[update.key] = update.value;
        update.resolve();
    });
    await Promise.all([leftStore.flush(), rightStore.flush()]);
    const concurrentRestored = new AiSessionTerminalBindingStore(concurrentState);
    assert.strictEqual(concurrentRestored.get(leftProcessId).sessionId, 'left');
    assert.strictEqual(concurrentRestored.get(rightProcessId).sessionId, 'right');

    let persistenceErrors = 0;
    const failingStore = new AiSessionTerminalBindingStore({
        get: (_key, fallback) => fallback,
        update: async () => { throw new Error('workspaceState unavailable'); },
    }, () => { persistenceErrors++; });
    failingStore.setBound(42004, {
        providerId: 'codex', sessionId: 'first', markerPath: '/tmp/first.done', runStartedAtMs: 1,
    });
    failingStore.setBound(42005, {
        providerId: 'codex', sessionId: 'second', markerPath: '/tmp/second.done', runStartedAtMs: 2,
    });
    await failingStore.flush();
    assert.strictEqual(persistenceErrors, 1, 'persistent workspaceState failures are logged once per store');

    const orderedData = {};
    const orderedUpdates = [];
    let resolveDeferredProcessId;
    const deferredProcessId = new Promise(resolve => { resolveDeferredProcessId = resolve; });
    const orderedStore = new AiSessionTerminalBindingStore({
        get: (key, fallback) => Object.prototype.hasOwnProperty.call(orderedData, key) ? orderedData[key] : fallback,
        update: async (key, value) => {
            orderedUpdates.push(value?.state || 'removed');
            orderedData[key] = value;
        },
    });
    orderedStore.setPending(deferredProcessId, {
        providerId: 'codex', markerPath: '/tmp/deferred.done', cwd: '/work/app',
        createdAt: new Date().toISOString(), excludedSessionIds: [],
    });
    orderedStore.setBound(deferredProcessId, {
        providerId: 'codex', sessionId: 'deferred-session', markerPath: '/tmp/deferred.done', runStartedAtMs: 4,
    });
    orderedStore.remove(deferredProcessId);
    resolveDeferredProcessId(42007);
    await orderedStore.flush();
    assert.deepStrictEqual(orderedUpdates, ['pending', 'bound', 'removed']);
    assert.strictEqual(orderedStore.get(42007), null);

    const stalledData = {};
    const stalledStore = new AiSessionTerminalBindingStore({
        get: (key, fallback) => Object.prototype.hasOwnProperty.call(stalledData, key) ? stalledData[key] : fallback,
        update: async (key, value) => { stalledData[key] = value; },
    }, undefined, undefined, 5);
    stalledStore.setPending(new Promise(() => {}), {
        providerId: 'codex', markerPath: '/tmp/stalled.done', cwd: '/work/app',
        createdAt: new Date().toISOString(), excludedSessionIds: [],
    });
    stalledStore.setBound(42006, {
        providerId: 'codex', sessionId: 'after-stall', markerPath: '/tmp/after-stall.done', runStartedAtMs: 3,
    });
    const stalledFlushCompleted = await Promise.race([
        stalledStore.flush().then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 50)),
    ]);
    assert.strictEqual(stalledFlushCompleted, true, 'an unresolved processId must not block later binding writes');
    assert.strictEqual(stalledStore.get(42006).sessionId, 'after-stall');
}

async function runAiSessionTerminalPersistenceChecks() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-terminal-persistence-'));
    const stateData = {};
    const state = {
        get: (key, fallback) => Object.prototype.hasOwnProperty.call(stateData, key) ? stateData[key] : fallback,
        update: async (key, value) => { stateData[key] = value; },
    };
    const terminalProviders = providers.AI_SESSION_PROVIDER_IDS.map(providerId => providers.getAiSessionProviderDefinition(providerId));
    const createdAt = new Date().toISOString();
    try {
        const readyRetryProcessId = 42008;
        let readyRetryProcessIdReads = 0;
        const readyRetryCommands = [];
        const readyRetryEvents = [];
        const readyRetryState = {
            get: (key, fallback) => Object.prototype.hasOwnProperty.call(stateData, key) ? stateData[key] : fallback,
            update: async (key, value) => {
                stateData[key] = value;
                readyRetryEvents.push('persisted');
            },
        };
        const readyRetryTerminal = {
            name: 'Codex: Retry after ready',
            creationOptions: { name: 'Codex: Retry after ready', cwd: '/work/app' },
            get processId() {
                readyRetryProcessIdReads++;
                return readyRetryProcessIdReads === 1
                    ? new Promise(() => {})
                    : Promise.resolve(readyRetryProcessId);
            },
            sendText(command) {
                readyRetryCommands.push(command);
                readyRetryEvents.push('sent');
            },
        };
        const readyRetryStore = new AiSessionTerminalBindingStore(readyRetryState, undefined, undefined, 5);
        const readyRetryService = new AiSessionTerminalService(
            tempRoot,
            terminalProviders,
            0,
            undefined,
            readyRetryStore,
            5
        );
        readyRetryService.trackPending({
            provider: 'codex',
            terminal: readyRetryTerminal,
            markerPath: path.join(tempRoot, 'retry-after-ready.done'),
            cwd: '/work/app',
            createdAt,
            excludedSessionIds: [],
            title: 'Retry after ready',
        });
        await new Promise(resolve => setTimeout(resolve, 10));
        await readyRetryStore.flush();
        assert.strictEqual(
            readyRetryStore.get(readyRetryProcessId),
            null,
            'the fixture must reproduce the initial unresolved PID write'
        );

        await readyRetryService.sendNewSessionCommand(
            'codex',
            readyRetryTerminal,
            '/work/app',
            'Retry after ready',
            path.join(tempRoot, 'retry-after-ready.done')
        );
        await readyRetryStore.flush();
        assert.strictEqual(
            readyRetryStore.get(readyRetryProcessId)?.state,
            'pending',
            'a ready terminal must retry and persist its pending binding before sending the provider command'
        );
        assert.strictEqual(readyRetryCommands.length, 1);
        assert.deepStrictEqual(readyRetryEvents, ['persisted', 'sent']);

        const firstStore = new AiSessionTerminalBindingStore(state);
        const firstService = new AiSessionTerminalService(tempRoot, terminalProviders, 0, undefined, firstStore);
        const created = firstService.createTerminal({
            name: 'Codex: App',
            cwd: '/work/app',
            logError() {},
            cwdFailureMessage: '',
            cwdWarningMessage: '',
        }).terminal;
        const processId = await created.processId;
        assert.strictEqual(Number.isSafeInteger(processId), true);
        firstService.trackPending({
            provider: 'codex',
            terminal: created,
            markerPath: path.join(tempRoot, 'pending.done'),
            cwd: '/work/app',
            createdAt,
            excludedSessionIds: [],
            title: 'App',
        });
        await firstStore.flush();

        const restoredPendingTerminal = {
            ...created,
            creationOptions: { name: created.name, cwd: '/work/app' },
            processId: Promise.resolve(processId),
        };
        const secondStore = new AiSessionTerminalBindingStore(state);
        const secondService = new AiSessionTerminalService(tempRoot, terminalProviders, 0, undefined, secondStore);
        await secondService.restorePersistedTerminals([restoredPendingTerminal]);
        assert.strictEqual(secondService.getPendingTerminals().length, 1);
        assert.strictEqual(secondService.getPendingTerminals()[0].terminal, restoredPendingTerminal);

        secondService.track('codex', 'session-new', {
            terminal: restoredPendingTerminal,
            markerPath: path.join(tempRoot, 'session-new.done'),
            runStartedAtMs: 1784102400000,
        });
        await secondStore.flush();

        const restoredBoundTerminal = {
            ...restoredPendingTerminal,
            creationOptions: { name: restoredPendingTerminal.name, cwd: '/work/app' },
            processId: Promise.resolve(processId),
        };
        const thirdStore = new AiSessionTerminalBindingStore(state);
        const thirdService = new AiSessionTerminalService(tempRoot, terminalProviders, 0, undefined, thirdStore);
        await thirdService.restorePersistedTerminals([restoredBoundTerminal]);
        assert.strictEqual(thirdService.getById('codex', 'session-new').terminal, restoredBoundTerminal);

        thirdService.handleClosedTerminal(restoredBoundTerminal);
        await thirdStore.flush();
        assert.strictEqual(new AiSessionTerminalBindingStore(state).get(processId), null);

        const expiredProcessId = 49999;
        const expiredStore = new AiSessionTerminalBindingStore(state);
        expiredStore.setPending(expiredProcessId, {
            providerId: 'codex',
            markerPath: path.join(tempRoot, 'expired.done'),
            cwd: '/work/app',
            createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
            excludedSessionIds: [],
        });
        await expiredStore.flush();
        const expiredTerminal = {
            ...created,
            creationOptions: { name: created.name, cwd: '/work/app' },
            processId: Promise.resolve(expiredProcessId),
        };
        const expiredService = new AiSessionTerminalService(tempRoot, terminalProviders, 0, undefined, expiredStore);
        await expiredService.restorePersistedTerminals([expiredTerminal]);
        assert.strictEqual(expiredService.getPendingTerminals().length, 0);
        await expiredStore.flush();
        assert.strictEqual(new AiSessionTerminalBindingStore(state).get(expiredProcessId), null);

        const recoverableProcessId = 50001;
        const timeoutStore = new AiSessionTerminalBindingStore(state);
        timeoutStore.setBound(recoverableProcessId, {
            providerId: 'codex',
            sessionId: 'session-after-stalled-terminal',
            markerPath: path.join(tempRoot, 'session-after-stalled-terminal.done'),
            runStartedAtMs: 1784102400000,
        });
        await timeoutStore.flush();
        const stalledTerminal = {
            name: 'Stalled terminal',
            creationOptions: { name: 'Stalled terminal' },
            processId: new Promise(() => {}),
            sendText() {},
        };
        const recoverableTerminal = {
            name: 'Codex: Recoverable',
            creationOptions: { name: 'Codex: Recoverable' },
            processId: Promise.resolve(recoverableProcessId),
            sendText() {},
        };
        const timeoutService = new AiSessionTerminalService(tempRoot, terminalProviders, 0, undefined, timeoutStore, 5);
        const restoreCompleted = await Promise.race([
            timeoutService.restorePersistedTerminals([stalledTerminal, recoverableTerminal]).then(() => true),
            new Promise(resolve => setTimeout(() => resolve(false), 50)),
        ]);
        assert.strictEqual(restoreCompleted, true, 'one unresolved terminal processId must not block extension activation');
        assert.strictEqual(
            timeoutService.getById('codex', 'session-after-stalled-terminal').terminal,
            recoverableTerminal
        );

        const reusedProcessId = 50002;
        const reusedProcessStore = new AiSessionTerminalBindingStore(state);
        reusedProcessStore.setBound(reusedProcessId, {
            providerId: 'codex',
            sessionId: 'stale-session',
            markerPath: path.join(tempRoot, 'stale-session.done'),
            runStartedAtMs: 1784102400000,
        });
        await reusedProcessStore.flush();
        const ordinaryTerminalWithReusedPid = {
            name: 'bash',
            creationOptions: { name: 'bash' },
            processId: Promise.resolve(reusedProcessId),
            sendText() {},
        };
        const reusedProcessService = new AiSessionTerminalService(tempRoot, terminalProviders, 0, undefined, reusedProcessStore);
        await reusedProcessService.restorePersistedTerminals([ordinaryTerminalWithReusedPid]);
        assert.strictEqual(reusedProcessService.getById('codex', 'stale-session'), null);
        await reusedProcessStore.flush();
        assert.strictEqual(reusedProcessStore.get(reusedProcessId), null, 'a reused PID must clear its stale binding');
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
    const projectHydrationControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'projectHydrationController.ts'), 'utf8');
    const hydrateOpenProjectsFunction = extractMethodBody(projectHydrationControllerSource, 'hydrate');
    const attentionControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'attentionController.ts'), 'utf8');
    const dashboardRuntimeControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'runtimeController.ts'), 'utf8');
    const dashboardLifecycleControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'lifecycleController.ts'), 'utf8');
    const evaluateAttentionFunction = extractMethodBody(attentionControllerSource, 'evaluate');
    const archiveControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'archiveController.ts'), 'utf8');
    const singleArchiveFunction = extractMethodBody(archiveControllerSource, 'archiveSession');
    const batchArchiveFunction = extractMethodBody(archiveControllerSource, 'archiveSessions');
    const archiveItemFunction = extractMethodBody(archiveControllerSource, 'archiveSessionItem');
    const batchArchiveLogFunction = extractMethodBody(archiveControllerSource, 'logBatchAiSessionArchiveResult');
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
    assert.ok(webviewContent.includes('getAttentionProjectKey(project.path)'));
    assert.ok(webviewContent.includes('class="ai-session-attention-indicator"'));
    assert.ok(styles.includes('.ai-session-attention-indicator'));
    assert.ok(dashboard.includes('getProjectKey: project => getAttentionProjectKey(project.path)'));
    assert.ok(attentionControllerSource.includes('const projectKey = this.options.getProjectKey(project);'));
    assert.ok(attentionControllerSource.includes('projectId: projectKey'));
    assert.ok(attentionControllerSource.includes('observedAtMs: attention.stateChangedAt'));
    assert.ok(attentionControllerSource.includes('if (!terminal ||'));
    assert.ok(attentionControllerSource.includes('provider.service.getLifecycleSignals(requests)'));
    assert.ok(evaluateAttentionFunction.includes('terminal-exit:'));
    assert.ok(!evaluateAttentionFunction.includes('activityToken'));
    assert.ok(!evaluateAttentionFunction.includes('projectId: project.id'));
    const pendingTerminalResolverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'pendingTerminalResolver.ts'), 'utf8');
    const resumeControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'resumeController.ts'), 'utf8');
    assert.ok(pendingTerminalResolverSource.includes('runStartedAtMs: Date.parse(pendingTerminal.createdAt)'));
    assert.ok(resumeControllerSource.includes('runStartedAtMs: this.options.nowMs()'));
    assert.ok(dashboard.includes('nowMs: () => Date.now()'));
    assert.ok(dashboardRuntimeControllerSource.includes("type: 'ai-session-attention-projects-updated'"));
    assert.ok(dashboard.includes('sessionEvents: aiSessionAttentionController.getRecoverySessionEvents()'));
    assert.ok(webviewProjectScripts.includes('message.sessionEvents'));
    assert.ok(dashboard.includes("import { AiSessionAttentionController } from './aiSessions/attentionController';"));
    assert.ok(dashboard.includes('const aiSessionAttentionController = new AiSessionAttentionController<TerminalEntry>({'));
    assert.ok(!dashboard.includes('function getEffectiveAiSessionAttentionAggregate('));
    assert.ok(!dashboard.includes('function getAiSessionAttentionRecoverySessionEvents('));
    assert.ok(!dashboard.includes('async function evaluateAiSessionAttention('));
    assert.ok(dashboard.includes("'open-settings': async () =>"));
    assert.ok(settingsFunction.includes('dashboardRuntimeController.openSettings()'));
    assert.ok(dashboardRuntimeControllerSource.includes("executeCommand('workbench.action.openSettings', query)"));
    assert.ok(!settingsFunction.includes('showQuickPick'));
    assert.ok(!settingsFunction.includes('ai-session-terminal-mode-planned'));
    assert.ok(dashboard.includes('new AiSessionPinStore(context.globalStoragePath)'));
    assert.ok(dashboard.includes("import { AiSessionCommandController } from './aiSessions/commandController';"));
    assert.ok(dashboard.includes("import { AiSessionCreationController } from './aiSessions/creationController';"));
    assert.ok(dashboard.includes("import { AiSessionResumeController } from './aiSessions/resumeController';"));
    assert.ok(dashboard.includes('const aiSessionCommandController = new AiSessionCommandController({'));
    assert.ok(dashboard.includes('const aiSessionCreationController = new AiSessionCreationController({'));
    assert.ok(dashboard.includes('const aiSessionResumeController = new AiSessionResumeController<vscode.Terminal, TerminalEntry>({'));
    assert.ok(dashboard.includes('new AiSessionPinController({'));
    assert.ok(dashboard.includes('aiSessionPinController.getAll()'));
    assert.ok(dashboard.includes('aiSessionPinController.toggle('));
    assert.ok(dashboard.includes('aiSessionPinController.remove('));
    assert.ok(dashboard.includes('aiSessionPinController.migrateLegacy('));
    assert.ok(!dashboard.includes('function getPinnedAiSessionKeys('));
    assert.ok(!dashboard.includes('function migrateLegacyPinnedAiSessions('));
    assert.ok(!dashboard.includes('function deletePinnedAiSession('));
    assert.ok(dashboard.includes('new AiSessionAliasStore(context.globalStoragePath)'));
    assert.ok(dashboard.includes('new AiSessionProjectStateStore(context.globalState'));
    assert.ok(dashboard.includes('new AiSessionTerminalBindingStore(context.workspaceState'));
    assert.ok(dashboard.includes('new DashboardDiagnostics({'));
    assert.ok(!dashboard.includes('function logAiSessionDiagnostic('));
    assert.ok(!dashboard.includes('function logDashboardDiagnostic('));
    assert.ok(!dashboard.includes('function logOpenProjectDiagnostic('));
    assert.ok(dashboard.includes('export async function activate(context: vscode.ExtensionContext)'));
    const terminalServiceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'terminalService.ts'), 'utf8');
    assert.ok(!terminalServiceSource.includes('AI_SESSION_PROVIDER_IDS'));
    assert.ok(dashboard.includes('const aiSessionProviders = aiSessionProviderRegistry.providers();'));
    assert.ok(dashboard.includes('await aiSessionTerminalService.restorePersistedTerminals(vscode.window.terminals)'));
    assert.ok(dashboard.includes('new ActiveAiSessionTerminalHighlighter'));
    assert.ok(dashboard.includes('vscode.window.onDidChangeActiveTerminal'));
    assert.match(dashboard, /onDidChangeActiveTerminal\(\(\) => \{[\s\S]*?activeAiSessionTerminalHighlighter\.sync\(\);[\s\S]*?void aiSessionAttentionController\.evaluate\(\);[\s\S]*?\}\)/);
    assert.match(dashboard, /onDidChangeWindowState\(windowState => \{[\s\S]*?dashboardLifecycleController\.handleWindowStateChanged\(windowState\);[\s\S]*?\}\)/);
    assert.ok(dashboardLifecycleControllerSource.includes('this.options.evaluateAiSessionAttention();'));
    assert.ok(dashboardLifecycleControllerSource.includes('this.options.publishOpenProjects(true);'));
    assert.ok(dashboard.includes("'request-active-ai-session-terminal': () =>"));
    assert.ok(dashboardRuntimeControllerSource.includes("type: 'active-ai-session-terminal-changed'"));
    assert.ok(webviewProjectScripts.includes("type: 'request-active-ai-session-terminal'"));
    assert.ok(webviewProjectScripts.includes("message.type === 'active-ai-session-terminal-changed'"));
    assert.ok(webviewProjectScripts.includes('data-ai-session-active-terminal'));
    assert.ok(dashboard.includes('activeAiSessionTerminalHighlighter.handleTerminalClosed(terminal)'));
    assert.ok(dashboard.includes('activeAiSessionTerminalHighlighter.sync()'));
    assert.ok(dashboard.includes('onVisibleChanged: visible =>'));
    assert.ok(dashboard.includes('activeAiSessionTerminalHighlighter.setVisible(visible)'));
    const viewProvider = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'viewProvider.ts'), 'utf8');
    assert.ok(viewProvider.includes('this.options.onVisibleChanged(webviewView.visible)'));
    const terminalCandidatesSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'terminalCandidates.ts'), 'utf8');
    assert.ok(terminalCandidatesSource.includes("reason: 'terminal-candidates'"));
    assert.ok(!terminalCandidatesSource.includes('AI_SESSION_PROVIDER_IDS'));
    assert.ok(!terminalCandidatesSource.includes('getOpenProjects('));
    assert.ok(!terminalCandidatesSource.includes('activeAiSessionProvider'));
    assert.ok(!dashboard.includes('prunePinnedAiSessionKeys'));
    assert.ok(dashboard.includes("'archive-ai-sessions': async e =>"));
    assert.ok(dashboard.includes('AiSessionBatchArchiveCompletedMessage'));
    assert.ok(dashboard.includes("import { AiSessionArchiveController } from './aiSessions/archiveController';"));
    assert.ok(dashboard.includes('const aiSessionArchiveController = new AiSessionArchiveController<AiSessionTerminalEntry<vscode.Terminal>>({'));
    assert.ok(dashboard.includes('await aiSessionArchiveController.archiveSessions('));
    assert.ok(dashboard.includes('await aiSessionArchiveController.archiveSession('));
    assert.ok(!dashboard.includes('async function archiveAiSession('));
    assert.ok(!dashboard.includes('function archiveAiSessionItem('));
    assert.ok(!dashboard.includes('async function archiveAiSessions('));
    assert.ok(!dashboard.includes('function logRejectedBatchAiSessionSelections('));
    assert.ok(!dashboard.includes('function logBatchAiSessionArchiveResult('));
    assert.ok(singleArchiveFunction.includes('this.archiveSessionItem(providerId, sessionId)'));
    assert.ok(batchArchiveFunction.includes('executeBatchAiSessionArchiveRequest('));
    assert.strictEqual((singleArchiveFunction.match(/syncActiveTerminal\(\)/g) || []).length, 1);
    assert.strictEqual((batchArchiveFunction.match(/syncActiveTerminal\(\)/g) || []).length, 1);
    assert.ok(!archiveItemFunction.includes('activeAiSessionTerminalHighlighter.sync()'));
    assert.ok(!archiveItemFunction.includes('refreshAiSessionViewsIncrementally()'));
    assert.ok(!archiveItemFunction.includes('invalidateAiSessionCache('));
    assert.ok(archiveItemFunction.includes('archiveBatchAiSessionItem('));
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
    assert.ok(projectHydrationControllerSource.includes('getAliases: () => Record<string, string>;'));
    assert.ok(hydrateOpenProjectsFunction.includes('aliases: this.options.getAliases()'));
    assert.ok(!projectHydrationControllerSource.includes('pruneAiSessionAliases('));
    assert.ok(!dashboard.includes('function pruneAiSessionAliases('));
    assert.ok(!dashboard.includes("const AI_SESSION_ALIASES_FILE_NAME = 'ai-session-aliases.json';"));
    assert.ok(!dashboard.includes('function getAiSessionAliasesPath('));
    assert.ok(dashboard.includes('new AiSessionAliasController({'));
    assert.ok(dashboard.includes('aiSessionAliasController.getAll()'));
    assert.ok(dashboard.includes('aiSessionAliasController.saveAll(aliases)'));
    assert.ok(dashboard.includes('aiSessionAliasController.set('));
    assert.ok(dashboard.includes('aiSessionAliasController.remove('));
    assert.ok(dashboard.includes('aiSessionAliasController.getOriginalName('));
    assert.ok(!dashboard.includes('function getAiSessionAliases('));
    assert.ok(!dashboard.includes('function saveAiSessionAliases('));
    assert.ok(!dashboard.includes('function deleteAiSessionAlias('));
    assert.ok(!dashboard.includes('function setAiSessionAlias('));
    assert.ok(!dashboard.includes('function getAiSessionOriginalName('));
    assert.ok(dashboard.includes('aiSessionProjectStateStore.getExpandedProjects()'));
    assert.ok(dashboard.includes('aiSessionProjectStateStore.setExpanded('));
    assert.ok(dashboard.includes('aiSessionProjectStateStore.getActiveProviders()'));
    assert.ok(dashboard.includes('aiSessionProjectStateStore.setActiveProvider('));
    assert.ok(!dashboard.includes('async function toggleCodexSessions('));
    assert.ok(!dashboard.includes('async function selectAiSessionProvider('));
    assert.ok(!dashboard.includes('async function toggleAiSessionPin('));
    assert.ok(!dashboard.includes('async function renameAiSession('));
    assert.ok(!dashboard.includes('async function copyAiSessionId('));
    assert.ok(!dashboard.includes('async function createAiSession('));
    assert.ok(!dashboard.includes('async function queryNewAiSessionFields('));
    assert.ok(!dashboard.includes('async function createProviderAiSession('));
    assert.ok(dashboard.includes('await aiSessionCommandController.toggleSessionsExpanded('));
    assert.ok(dashboard.includes('await aiSessionCommandController.selectProvider('));
    assert.ok(dashboard.includes('await aiSessionCommandController.togglePin('));
    assert.ok(dashboard.includes('await aiSessionCommandController.renameSession('));
    assert.ok(dashboard.includes('await aiSessionCommandController.copySessionId('));
    assert.ok(dashboard.includes('await aiSessionCreationController.createSession('));
    assert.ok(dashboard.includes('await aiSessionResumeController.resumeProjectSession('));
    assert.ok(!dashboard.includes('async function resumeProjectAiSession('));
    assert.ok(!dashboard.includes('async function resumeAiSession('));
    assert.ok(!dashboard.includes('context.globalState.get(OPEN_PROJECTS_EXPANDED_CODEX_SESSIONS_KEY)'));
    assert.ok(!dashboard.includes('context.globalState.update(OPEN_PROJECTS_EXPANDED_CODEX_SESSIONS_KEY'));
    assert.ok(!dashboard.includes('context.globalState.get(OPEN_PROJECTS_ACTIVE_AI_SESSION_PROVIDER_KEY)'));
    assert.ok(!dashboard.includes('context.globalState.update(OPEN_PROJECTS_ACTIVE_AI_SESSION_PROVIDER_KEY'));
    assert.strictEqual(packageJson.contributes.configuration.properties['projectSteward.storeProjectsInSettings'].default, true);
    assert.strictEqual(packageJson.contributes.configuration.properties['projectSteward.applyProjectColorToWindow'].default, false);
    assert.strictEqual(packageJson.contributes.configuration.properties['projectSteward.maxVisibleAiSessions'].default, 3);
    assert.strictEqual(packageJson.contributes.configuration.properties['projectSteward.maxVisibleAiSessions'].minimum, 1);
    assert.ok(dashboard.includes("ProjectWindowColorService"));
    assert.ok(!dashboard.includes('resolveCurrentWorkspaceProjectIds('));
    assert.ok(!dashboard.includes('get currentWorkspaceProjectIds() { return getCurrentWorkspaceProjectIds() }'));
    assert.ok(!dashboard.includes('function getGroupsWithAiSessionAttention('));
    assert.ok(!dashboard.includes('withAttentionProject(project, aggregate)'));
    assert.ok(!webviewContent.includes('withCurrentWorkspaceState('));
    assert.ok(!webviewContent.includes('infos.currentWorkspaceProjectIds || []'));
    assert.ok(webviewContent.includes('getFavoriteProjectsInOrder('));
    assert.ok(dashboard.includes("'reordered-favorites': async e =>"));
    const favoriteProjectControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'projects', 'favoriteProjectController.ts'), 'utf8');
    assert.ok(!dashboard.includes('withFavoriteProjectOrder(groups, projectIds)'));
    assert.ok(!dashboard.includes('withToggledProjectFavorite(groups, projectId)'));
    assert.ok(favoriteProjectControllerSource.includes('withFavoriteProjectOrder(groups, projectIds)'));
    assert.ok(favoriteProjectControllerSource.includes('withToggledProjectFavorite(groups, projectId)'));
    assert.ok(dashboard.includes("function applyProjectColorToCurrentWindow(project: Project = null)"));
    assert.ok(dashboardRuntimeControllerSource.includes('targetProject?.showSaveAction'));
    assert.ok(dashboard.includes('dashboardRuntimeController.applyProjectColorToCurrentWindow(project)'));
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
    assert.ok(webviewContent.includes("options.readOnlyProjects || isProjectNavigation ? ' data-readonly-project' : ''"));
    assert.ok(webviewContent.includes("showCurrentAttention ? ' data-current-workspace' : ''"));
    assert.ok(webviewContent.includes("options.projectAttentionMode === 'none'"));
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
    const getCardTags = (content, projectId) => content.match(new RegExp(`<div class="project"[^>]*data-id="${projectId}"[^>]*>`, 'g')) || [];
    const savedTags = getCardTags(html, 'saved');
    const otherTags = getCardTags(html, 'other');
    const openTags = getCardTags(html, '__openProjects-0');
    const navigationTags = getCardTags(html, '__openProjectNavigation-other');

    assert.strictEqual(savedTags.length, 0);
    assert.strictEqual(otherTags.length, 0);
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
    assert.ok(navigationTags[0].includes('data-attention-project-key'));
    assert.ok(!navigationTags[0].includes('data-has-favorite-toggle'));
    assert.ok(!navigationTags[0].includes('data-has-save-action'));
    const navigationCardStart = html.indexOf(navigationTags[0]);
    const navigationCardEnd = html.indexOf('</div>\n</div>', navigationCardStart);
    const navigationHtml = html.slice(navigationCardStart, navigationCardEnd);
    assert.ok(!navigationHtml.includes('project-save-badge'));
    assert.ok(!navigationHtml.includes('project-favorite-badge'));
    assert.ok(!navigationHtml.includes('project-actions-wrapper'));
    assert.ok(navigationHtml.includes('project-ai-attention-badge'));
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

    assert.ok(html.includes('role="tablist"'));
    assert.ok(html.includes('data-dashboard-tab="open"'));
    assert.ok(html.includes('data-dashboard-tab="projects"'));
    assert.ok(html.includes('id="dashboard-tab-open"'));
    assert.ok(html.includes('id="dashboard-tab-projects"'));
    assert.ok(html.includes('aria-controls="dashboard-tab-open"'));
    assert.ok(html.includes('aria-controls="dashboard-tab-projects"'));
    assert.ok(html.includes('aria-labelledby="dashboard-tab-open-button"'));
    assert.ok(html.includes('aria-labelledby="dashboard-tab-projects-button"'));
    assert.ok(html.includes('id="dashboard-search-results"'));
    assert.ok(html.includes('id="dashboard-search-catalog"'));
    assert.strictEqual(html.includes('dashboard-projects-template'), false);
    assert.strictEqual(html.includes('class="groups-wrapper"'), false);

    const currentOnly = webviewContentModule.getOpenProjectsGroupContent([
        { id: 'current-only', name: 'Current', path: '/work/current', openProjectCardKind: 'current' },
    ], false, { config });
    const currentAndOther = webviewContentModule.getOpenProjectsGroupContent([
        { id: 'current-both', name: 'Current', path: '/work/current', openProjectCardKind: 'current' },
        { id: 'other-both', name: 'Other', path: '/work/other', openProjectCardKind: 'projectNavigation', aiSessionAttentionCount: 2 },
    ], false, { config });
    const navigationOnly = webviewContentModule.getOpenProjectsGroupContent([
        { id: 'other-only', name: 'Other', path: '/work/other', openProjectCardKind: 'projectNavigation', aiSessionAttentionCount: 2 },
    ], false, { config });
    const noCards = webviewContentModule.getOpenProjectsGroupContent([], false, { config });

    assert.ok(currentOnly.includes('CURRENT WORKSPACE'));
    assert.strictEqual(currentOnly.includes('OTHER WINDOWS'), false);
    assert.ok(currentAndOther.includes('CURRENT WORKSPACE'));
    assert.ok(currentAndOther.includes('OTHER WINDOWS'));
    assert.ok(navigationOnly.includes('No folder is open in this window.'));
    assert.ok(navigationOnly.includes('OTHER WINDOWS'));
    assert.ok(noCards.includes('Open a folder to see running projects.'));
    assert.strictEqual(noCards.includes('OTHER WINDOWS'), false);
    assert.strictEqual((currentOnly.match(/data-action="collapse"/g) || []).length, 0);

    const projectsHtml = webviewContentModule.getProjectsPanelContent([{
        id: 'group', groupName: 'Work', collapsed: false,
        projects: [{
            id: 'static-project', name: 'Static', path: '/work/static',
            aiSessionAttentionCount: 3,
            codexSessions: [{ id: 'must-not-render', name: 'Must Not Render' }],
        }],
    }], { config, otherStorageHasData: false });
    assert.ok(projectsHtml.includes('data-id="static-project"'));
    assert.ok(!projectsHtml.includes('data-current-workspace'));
    assert.ok(!projectsHtml.includes('data-attention-project-key'));
    assert.ok(!projectsHtml.includes('project-ai-attention-badge'));
    assert.ok(!projectsHtml.includes('project-codex-badge'));
    assert.ok(!projectsHtml.includes('class="codex-sessions"'));
    assert.ok(!projectsHtml.includes('Must Not Render'));
}

function runFavoriteRenderingChecks() {
    const config = {
        get: (key, defaultValue) => defaultValue,
        displayProjectPath: false,
        searchIsActiveByDefault: false,
        showAddGroupButtonTile: false,
    };
    const html = webviewContentModule.getProjectsPanelContent(
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
            otherStorageHasData: false,
        }
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
    const html = webviewContentModule.getProjectsPanelContent(
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
            otherStorageHasData: false,
        }
    );

    assert.ok(!html.includes(`data-attention-project-key="${projectKey}"`));
    assert.ok(!html.includes('class="project-ai-attention-badge"'));
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
    const dndRoot = {
        querySelector: () => null,
        querySelectorAll: selector => {
            if (selector === '.group-list') return [favorites, ordinary];
            if (selector === '.groups-wrapper') return [{}];
            if (selector.startsWith('.groups-wrapper >')) return [ordinaryGroup];
            return [];
        },
    };
    runtimeContext.initDnD(dndRoot);
    runtimeContext.initDnD(dndRoot);

    assert.strictEqual(drakes.length, 2);
    assert.strictEqual(dndRoot.__projectStewardDnDInitialized, true);
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
        normalizeDashboardSearchCatalog: value => value
            && Array.isArray(value.sessions)
            && Array.isArray(value.openProjects)
            && Array.isArray(value.savedProjects)
            ? value
            : { sessions: [], openProjects: [], savedProjects: [] },
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
            __projectStewardDashboard: { replaceSearchCatalog: () => undefined },
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
        searchCatalog: { sessions: [], openProjects: [], savedProjects: [] },
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

function runAiSessionIncrementalRefreshSourceChecks() {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    const readCoordinatorPath = path.join(__dirname, '..', 'src', 'aiSessions', 'readCoordinator.ts');
    assert.ok(fs.existsSync(readCoordinatorPath));
    const readCoordinatorSource = fs.readFileSync(readCoordinatorPath, 'utf8');
    const viewModelsPath = path.join(__dirname, '..', 'src', 'aiSessions', 'viewModels.ts');
    assert.ok(fs.existsSync(viewModelsPath));
    const viewModelsSource = fs.readFileSync(viewModelsPath, 'utf8');
    const projectHydrationPath = path.join(__dirname, '..', 'src', 'aiSessions', 'projectHydration.ts');
    assert.ok(fs.existsSync(projectHydrationPath));
    const projectHydrationSource = fs.readFileSync(projectHydrationPath, 'utf8');
    const projectCandidatesPath = path.join(__dirname, '..', 'src', 'aiSessions', 'projectCandidates.ts');
    assert.ok(fs.existsSync(projectCandidatesPath));
    const projectCandidatesSource = fs.readFileSync(projectCandidatesPath, 'utf8');
    const sessionPathsPath = path.join(__dirname, '..', 'src', 'aiSessions', 'sessionPaths.ts');
    assert.ok(fs.existsSync(sessionPathsPath));
    const sessionPathsSource = fs.readFileSync(sessionPathsPath, 'utf8');
    const pendingTerminalsPath = path.join(__dirname, '..', 'src', 'aiSessions', 'pendingTerminals.ts');
    assert.ok(fs.existsSync(pendingTerminalsPath));
    const pendingTerminalsSource = fs.readFileSync(pendingTerminalsPath, 'utf8');
    const pendingTerminalResolverPath = path.join(__dirname, '..', 'src', 'aiSessions', 'pendingTerminalResolver.ts');
    assert.ok(fs.existsSync(pendingTerminalResolverPath));
    const pendingTerminalResolverSource = fs.readFileSync(pendingTerminalResolverPath, 'utf8');
    const terminalCandidatesPath = path.join(__dirname, '..', 'src', 'aiSessions', 'terminalCandidates.ts');
    assert.ok(fs.existsSync(terminalCandidatesPath));
    const terminalCandidatesSource = fs.readFileSync(terminalCandidatesPath, 'utf8');
    const scanOptionsPath = path.join(__dirname, '..', 'src', 'aiSessions', 'scanOptions.ts');
    assert.ok(fs.existsSync(scanOptionsPath));
    const scanOptionsSource = fs.readFileSync(scanOptionsPath, 'utf8');
    const terminalCwdPath = path.join(__dirname, '..', 'src', 'aiSessions', 'terminalCwd.ts');
    assert.ok(fs.existsSync(terminalCwdPath));
    const terminalCwdSource = fs.readFileSync(terminalCwdPath, 'utf8');
    const workspaceHelpersPath = path.join(__dirname, '..', 'src', 'projects', 'workspaceHelpers.ts');
    assert.ok(fs.existsSync(workspaceHelpersPath));
    const workspaceHelpersSource = fs.readFileSync(workspaceHelpersPath, 'utf8');
    const typesSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'types.ts'), 'utf8');
    assert.ok(typesSource.includes('scannedFiles: number;'));
    assert.ok(typesSource.includes('parsedFiles: number;'));
    assert.ok(typesSource.includes('maxFiles?: number;'));
    assert.ok(typesSource.includes('reason?: string;'));
    const providersSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'providers.ts'), 'utf8');
    assert.ok(providersSource.includes('export interface AiSessionProviderRegistry'));
    assert.ok(providersSource.includes('export function createAiSessionProviderRegistry('));
    assert.ok(providersSource.includes('providers(): AiSessionProvider[]'));
    assert.ok(!dashboard.includes('AI_SESSION_PROVIDER_IDS'));
    const controllerPath = path.join(__dirname, '..', 'src', 'aiSessions', 'dashboardController.ts');
    assert.ok(fs.existsSync(controllerPath));
    const controllerSource = fs.readFileSync(controllerPath, 'utf8');
    assert.ok(controllerSource.includes('export class AiSessionDashboardController'));
    assert.ok(controllerSource.includes('scheduleRefresh('));
    assert.ok(controllerSource.includes('setWatchersActive('));
    assert.ok(controllerSource.includes('buildAiSessionsUpdatedMessage'));
    assert.ok(dashboard.includes('AI_SESSION_WATCHER_REFRESH_MIN_INTERVAL_MS'));
    assert.ok(dashboard.includes('watcherRefreshMinIntervalMs: AI_SESSION_WATCHER_REFRESH_MIN_INTERVAL_MS'));
    const refreshFunction = extractFunctionBody(dashboard, 'refreshAiSessionViewsIncrementally');
    assert.ok(refreshFunction.includes('aiSessionDashboardController.refreshNow()'));
    assert.ok(controllerSource.includes("async refreshNow(reason = 'refresh'): Promise<void>"));
    assert.ok(controllerSource.includes('const message = this.getUpdatedMessage(reason);'));
    assert.ok(controllerSource.includes('this.options.postMessage(message).then(delivered =>'));
    assert.ok(controllerSource.includes('if (!delivered)'));
    assert.ok(controllerSource.includes('refresh: (reason: string) => void;'));
    assert.ok(controllerSource.includes("this.options.refresh('ai-session-update-not-delivered');"));
    assert.ok(controllerSource.includes("this.options.refresh('ai-session-update-post-error');"));
    assert.ok(controllerSource.includes("this.options.refresh('ai-session-update-build-error');"));
    const attentionControllerPath = path.join(__dirname, '..', 'src', 'aiSessions', 'attentionController.ts');
    assert.ok(fs.existsSync(attentionControllerPath));
    const attentionControllerSource = fs.readFileSync(attentionControllerPath, 'utf8');
    const evaluateAttentionBody = extractMethodBody(attentionControllerSource, 'evaluate');
    assert.ok(evaluateAttentionBody.includes('const providers = this.options.getProviders();'));
    const projectHydrationControllerPath = path.join(__dirname, '..', 'src', 'aiSessions', 'projectHydrationController.ts');
    assert.ok(fs.existsSync(projectHydrationControllerPath));
    const projectHydrationControllerSource = fs.readFileSync(projectHydrationControllerPath, 'utf8');
    const hydrateOpenProjectsBody = extractMethodBody(projectHydrationControllerSource, 'hydrate');
    assert.ok(hydrateOpenProjectsBody.includes('hydrateOpenProjectsWithAiSessions({'));
    assert.ok(projectHydrationSource.includes('export function hydrateOpenProjectsWithAiSessions('));
    assert.ok(projectHydrationSource.includes('prepareAiSessionsForDisplay('));
    assert.ok(projectHydrationSource.includes('getAttentionSessionLookupKey('));
    assert.ok(projectHydrationSource.includes('function getActiveAiSessionProvider('));
    assert.ok(!dashboard.includes('function getActiveAiSessionProvider('));
    const openProjectViewModelBody = extractFunctionBody(dashboard, 'getOpenProjectAiSessionViewModel');
    assert.ok(openProjectViewModelBody.includes('buildOpenProjectAiSessionViewModel({'));
    assert.ok(viewModelsSource.includes('export function buildOpenProjectAiSessionViewModel('));
    assert.ok(viewModelsSource.includes('sessionsByProvider[providerId]'));
    assert.ok(viewModelsSource.includes('attentionCount: project.aiSessionAttentionCount ?? providers.reduce'));
    const getAiSessionResultsBody = extractMethodBody(projectHydrationControllerSource, 'getAiSessionResults');
    assert.ok(!dashboard.includes('function getAiSessionResults('));
    assert.ok(getAiSessionResultsBody.includes('this.options.readCoordinator.getResults('));
    assert.ok(projectHydrationControllerSource.includes("from './scanOptions'"));
    assert.ok(hydrateOpenProjectsBody.includes('const maxFiles = getAiSessionScanMaxFiles(reason, this.options.incrementalScanMaxFiles);'));
    assert.ok(getAiSessionResultsBody.includes('candidatePaths, reason, maxFiles'));
    assert.ok(projectCandidatesSource.includes('export function getAiSessionOpenProjectCandidates'));
    assert.ok(projectCandidatesSource.includes('export function getAiSessionCandidatePaths'));
    assert.ok(projectCandidatesSource.includes('export function getOpenProjectAiSessionKey('));
    assert.ok(projectCandidatesSource.includes('export function getOpenProjectTerminalCwd('));
    assert.ok(sessionPathsSource.includes('export function getProjectAiSessions('));
    assert.ok(sessionPathsSource.includes('export function getAiSessionTerminalCwd('));
    assert.ok(sessionPathsSource.includes('export function getAiSessionComparableCwd('));
    assert.ok(sessionPathsSource.includes('export function getAiSessionTerminalName('));
    assert.ok(pendingTerminalsSource.includes('export function getAiSessionIdsForCwd('));
    assert.ok(pendingTerminalsSource.includes('export function findPendingAiSessionTerminalMatch('));
    assert.ok(pendingTerminalResolverSource.includes('export function resolvePendingAiSessionTerminals'));
    assert.ok(pendingTerminalResolverSource.includes('replacePendingTerminals'));
    assert.ok(terminalCandidatesSource.includes('export function getAiSessionTerminalCandidates('));
    assert.ok(terminalCandidatesSource.includes("reason: 'terminal-candidates'"));
    assert.ok(scanOptionsSource.includes('export function getAiSessionScanMaxFiles('));
    assert.ok(scanOptionsSource.includes("reason === 'alias-original-name'"));
    assert.ok(scanOptionsSource.includes("reason === 'terminal-candidates'"));
    assert.ok(terminalCwdSource.includes('export function getUsableTerminalCwd('));
    assert.ok(workspaceHelpersSource.includes('export function getWorkspacePath('));
    assert.ok(workspaceHelpersSource.includes('export function getWorkspaceUri('));
    assert.ok(workspaceHelpersSource.includes('export function getWorkspaceUris('));
    assert.ok(!dashboard.includes('function getCodexOpenProjectCandidates('));
    assert.ok(!dashboard.includes('function normalizeCodexComparablePath('));
    assert.ok(!dashboard.includes('function getProjectAiSessions('));
    assert.ok(!dashboard.includes('function getAiSessionTerminalCwd('));
    assert.ok(!dashboard.includes('function getAiSessionComparableCwd('));
    assert.ok(!dashboard.includes('function getAiSessionTerminalName('));
    assert.ok(!dashboard.includes('function getAiSessionIdsForCwd('));
    assert.ok(!dashboard.includes('function findPendingAiSessionTerminalMatch('));
    assert.ok(!dashboard.includes('function resolvePendingAiSessionTerminals('));
    assert.ok(!dashboard.includes('function getTrackedAiSessionTerminalKeys('));
    assert.ok(!dashboard.includes('function getAiSessionTerminalCandidates('));
    assert.ok(!dashboard.includes('function getAiSessionScanMaxFiles('));
    assert.ok(!dashboard.includes('function getUsableTerminalCwd('));
    assert.ok(!dashboard.includes('function getAiSessionTerminalMarkerPath('));
    assert.ok(!dashboard.includes('function getPendingAiSessionTerminalMarkerPath('));
    assert.ok(!dashboard.includes('function getWorkspacePath('));
    assert.ok(!dashboard.includes('function getWorkspaceUri('));
    assert.ok(!dashboard.includes('function getWorkspaceUris('));
    const getAiSessionAssignmentsBody = extractMethodBody(projectHydrationControllerSource, 'getAiSessionAssignments');
    assert.ok(!dashboard.includes('function getAiSessionAssignments('));
    assert.ok(getAiSessionAssignmentsBody.includes('this.options.readCoordinator.getAssignments('));
    assert.ok(!dashboard.includes('function withAiSessions('));
    assert.ok(!dashboard.includes('function trackPendingAiSessionTerminal('));
    assert.strictEqual((dashboard.match(/\.service\.getSessions\(/g) || []).length, 0);
    assert.strictEqual(dashboard.includes('function getProviderAiSessions('), false);
    assert.ok(readCoordinatorSource.includes('export class AiSessionReadCoordinator'));
    assert.ok(readCoordinatorSource.includes("event: 'ai-session-scan'"));
    assert.ok(readCoordinatorSource.includes('durationMs: this.now() - startedAt'));
    assert.ok(readCoordinatorSource.includes('scannedFileCount: result.scannedFiles'));
    assert.ok(readCoordinatorSource.includes('parsedFileCount: result.parsedFiles'));
    assert.ok(readCoordinatorSource.includes('scanBudget: normalizedOptions.maxFiles || null'));
    assert.ok(controllerSource.includes("this.scheduleRefresh('watcher')"));
    assert.ok(controllerSource.includes("this.refreshNow('new-session')"));
    assert.ok(controllerSource.includes('private newSessionRefreshTimeouts: NodeJS.Timeout[] = []'));
    assert.ok(controllerSource.includes('let firedSynchronously = false'));
    assert.ok(controllerSource.includes('this.newSessionRefreshTimeouts.push(timeout)'));
    assert.ok(controllerSource.includes('for (let timeout of this.newSessionRefreshTimeouts)'));
    assert.ok(controllerSource.includes('this.options.clearTimeout(timeout)'));
}

function runAiSessionReadCoordinatorChecks() {
    const calls = [];
    const diagnostics = [];
    let now = 1000;
    const codexResult = {
        available: true,
        scannedFiles: 4,
        parsedFiles: 2,
        sessions: [
            { id: 'session-a', cwd: '/work/app', updatedAt: '2026-07-16T00:00:00.000Z' },
            { id: 'session-b', cwd: '/elsewhere', updatedAt: '2026-07-16T00:00:01.000Z' },
        ],
    };
    const kimiResult = {
        available: false,
        scannedFiles: 0,
        parsedFiles: 0,
        sessions: [],
    };
    const coordinator = new AiSessionReadCoordinator([
        {
            id: 'codex',
            service: {
                getSessions: options => {
                    calls.push(['codex', options]);
                    now += 7;
                    return codexResult;
                },
            },
        },
        {
            id: 'kimi',
            service: {
                getSessions: options => {
                    calls.push(['kimi', options]);
                    now += 3;
                    return kimiResult;
                },
            },
        },
    ], event => diagnostics.push(event), () => now);

    const results = coordinator.getResults({
        candidatePaths: ['/work/app'],
        reason: 'refresh',
        maxFiles: 2000,
    });
    assert.strictEqual(results.codex, codexResult);
    assert.strictEqual(results.kimi, kimiResult);
    assert.deepStrictEqual(calls, [
        ['codex', { candidatePaths: ['/work/app'], reason: 'refresh', maxFiles: 2000 }],
        ['kimi', { candidatePaths: ['/work/app'], reason: 'refresh', maxFiles: 2000 }],
    ]);
    assert.deepStrictEqual(diagnostics.map(event => ({
        event: event.event,
        provider: event.provider,
        durationMs: event.durationMs,
        sessionCount: event.sessionCount,
        scannedFileCount: event.scannedFileCount,
        parsedFileCount: event.parsedFileCount,
        scanBudget: event.scanBudget,
        available: event.available,
    })), [
        {
            event: 'ai-session-scan',
            provider: 'codex',
            durationMs: 7,
            sessionCount: 2,
            scannedFileCount: 4,
            parsedFileCount: 2,
            scanBudget: 2000,
            available: true,
        },
        {
            event: 'ai-session-scan',
            provider: 'kimi',
            durationMs: 3,
            sessionCount: 0,
            scannedFileCount: 0,
            parsedFileCount: 0,
            scanBudget: 2000,
            available: false,
        },
    ]);

    const assignments = coordinator.getAssignments(
        [{ project: { id: 'project-a' }, path: '/work' }],
        results,
        (providerId, session) => providerId === 'codex' ? session.cwd : session.workDir
    );
    assert.deepStrictEqual(Array.from(assignments.codex.keys()), ['project-a']);
    assert.deepStrictEqual(assignments.codex.get('project-a').map(session => session.id), ['session-a']);
    assert.deepStrictEqual(Array.from(assignments.kimi.keys()), []);

    assert.throws(
        () => coordinator.getProviderResult('claude', { reason: 'missing-provider' }),
        /AI session provider claude is not registered/
    );
}

function runOpenProjectAiSessionViewModelBuilderChecks() {
    const project = {
        id: 'project-a',
        name: 'Project A',
        path: '/work/project-a',
        activeAiSessionProvider: 'kimi',
        codexSessionsExpanded: true,
        codexSessions: [
            { id: 'c1', name: 'Codex One', updatedAt: '2026-07-16T00:00:00.000Z', attention: { unread: true } },
        ],
        kimiSessions: [
            { id: 'k1', name: 'Kimi One', updatedAt: '2026-07-16T00:01:00.000Z' },
        ],
        claudeSessions: [],
        kimiSessionsUnavailable: true,
    };
    const model = aiSessionViewModels.buildOpenProjectAiSessionViewModel({
        project,
        providers: [
            { id: 'codex', label: 'Codex', projectSessionsKey: 'codexSessions', projectSessionsUnavailableKey: 'codexSessionsUnavailable' },
            { id: 'kimi', label: 'Kimi', projectSessionsKey: 'kimiSessions', projectSessionsUnavailableKey: 'kimiSessionsUnavailable' },
            { id: 'claude', label: 'Claude', projectSessionsKey: 'claudeSessions', projectSessionsUnavailableKey: 'claudeSessionsUnavailable' },
        ],
        getProjectKey: item => `key:${item.id}`,
        getSearchText: item => `search:${item.name}`,
        renderSessionSection: item => `html:${item.id}`,
    });

    assert.strictEqual(model.projectId, 'project-a');
    assert.strictEqual(model.projectKey, 'key:project-a');
    assert.strictEqual(model.activeProvider, 'kimi');
    assert.strictEqual(model.expanded, true);
    assert.deepStrictEqual(model.providers.map(provider => ({
        id: provider.id,
        label: provider.label,
        count: provider.count,
        unavailable: provider.unavailable,
    })), [
        { id: 'codex', label: 'Codex', count: 1, unavailable: false },
        { id: 'kimi', label: 'Kimi', count: 1, unavailable: true },
        { id: 'claude', label: 'Claude', count: 0, unavailable: false },
    ]);
    assert.deepStrictEqual(model.unavailableProviders, ['kimi']);
    assert.deepStrictEqual(model.sessionsByProvider.codex, [{
        id: 'c1',
        name: 'Codex One',
        updatedAt: '2026-07-16T00:00:00.000Z',
        attention: { unread: true },
        provider: 'codex',
    }]);
    assert.deepStrictEqual(model.sessionsByProvider.kimi, [{
        id: 'k1',
        name: 'Kimi One',
        updatedAt: '2026-07-16T00:01:00.000Z',
        provider: 'kimi',
    }]);
    assert.strictEqual(model.searchText, 'search:Project A');
    assert.strictEqual(model.aiSessionCount, 2);
    assert.strictEqual(model.attentionCount, 1);
    assert.strictEqual(model.sessionSectionHtml, 'html:project-a');

    const explicitAttentionModel = aiSessionViewModels.buildOpenProjectAiSessionViewModel({
        project: { ...project, aiSessionAttentionCount: 7 },
        providers: [
            { id: 'codex', label: 'Codex', projectSessionsKey: 'codexSessions', projectSessionsUnavailableKey: 'codexSessionsUnavailable' },
        ],
        getProjectKey: item => item.id,
        getSearchText: () => '',
        renderSessionSection: () => '',
    });
    assert.strictEqual(explicitAttentionModel.attentionCount, 7);
}

function runAiSessionProjectHydrationChecks() {
    const project = { id: 'project-a', path: '/work/app' };
    const codexSessions = [
        { id: 'c1', name: 'Codex One', cwd: '/work/app', updatedAt: '2026-07-16T00:00:00.000Z' },
        { id: 'c2', name: 'Codex Two', cwd: '/work/app', updatedAt: '2026-07-16T00:01:00.000Z' },
    ];
    const aggregateByProjectAndSession = new Map();
    aggregateByProjectAndSession.set(
        attentionProject.getAttentionSessionLookupKey(
            attentionProject.getAttentionProjectKey('/work/app'),
            'codex:c2'
        ),
        {
            sessionKey: 'codex:c2',
            eventIds: ['remote-event'],
            reasons: ['completed'],
            observedAtMs: 17,
        }
    );

    const hydrated = aiSessionProjectHydration.hydrateOpenProjectsWithAiSessions({
        projects: [project],
        providers: [
            { id: 'codex', projectSessionsKey: 'codexSessions', projectSessionsUnavailableKey: 'codexSessionsUnavailable' },
            { id: 'kimi', projectSessionsKey: 'kimiSessions', projectSessionsUnavailableKey: 'kimiSessionsUnavailable' },
        ],
        sessionResults: {
            codex: { available: true, sessions: codexSessions, scannedFiles: 2, parsedFiles: 2 },
            kimi: { available: false, sessions: [], scannedFiles: 0, parsedFiles: 0 },
        },
        assignments: {
            codex: new Map([['project-a', codexSessions]]),
            kimi: new Map(),
        },
        expandedProjects: new Set(['project-key']),
        activeProviders: { 'project-key': 'kimi' },
        pinnedSessions: new Set(['codex:c2']),
        aliases: { 'codex:c1': 'Aliased Codex One' },
        aggregateByProjectAndSession,
        localAttentionBySession: {
            'codex:c1': {
                state: 'needsAttention',
                stateChangedAt: 3,
                event: { eventId: 'local-event', reason: 'input-required' },
            },
        },
        includeLocalAttention: false,
        getProjectKey: item => item.id === 'project-a' ? 'project-key' : item.id,
    });

    assert.strictEqual(hydrated[0], project, 'hydration preserves project object identity');
    assert.strictEqual(project.codexSessionsExpanded, true);
    assert.strictEqual(project.activeAiSessionProvider, 'kimi');
    assert.strictEqual(project.codexSessionsUnavailable, false);
    assert.strictEqual(project.kimiSessionsUnavailable, true);
    assert.deepStrictEqual(project.codexSessions.map(session => ({
        id: session.id,
        name: session.name,
        pinned: session.pinned,
        attention: session.attention,
    })), [
        {
            id: 'c2',
            name: 'Codex Two',
            pinned: true,
            attention: { eventId: 'remote-event', reason: 'completed', unread: true },
        },
        {
            id: 'c1',
            name: 'Aliased Codex One',
            pinned: false,
            attention: undefined,
        },
    ]);

    aiSessionProjectHydration.hydrateOpenProjectsWithAiSessions({
        projects: [project],
        providers: [
            { id: 'codex', projectSessionsKey: 'codexSessions', projectSessionsUnavailableKey: 'codexSessionsUnavailable' },
        ],
        sessionResults: {
            codex: { available: true, sessions: codexSessions, scannedFiles: 2, parsedFiles: 2 },
        },
        assignments: {
            codex: new Map([['project-a', [codexSessions[0]]]]),
        },
        expandedProjects: new Set(),
        activeProviders: {},
        pinnedSessions: new Set(),
        aliases: {},
        aggregateByProjectAndSession: new Map(),
        localAttentionBySession: {
            'codex:c1': {
                state: 'needsAttention',
                stateChangedAt: 3,
                event: { eventId: 'local-event', reason: 'input-required' },
            },
        },
        includeLocalAttention: true,
        getProjectKey: () => 'project-key',
    });
    assert.deepStrictEqual(project.codexSessions[0].attention, {
        eventId: 'local-event',
        reason: 'input-required',
        unread: true,
    });

    const fallbackProject = { id: 'fallback', path: '/fallback', codexSessions: [], kimiSessions: [{ id: 'k2' }] };
    aiSessionProjectHydration.hydrateOpenProjectsWithAiSessions({
        projects: [fallbackProject],
        providers: [
            { id: 'codex', projectSessionsKey: 'codexSessions', projectSessionsUnavailableKey: 'codexSessionsUnavailable' },
            { id: 'kimi', projectSessionsKey: 'kimiSessions', projectSessionsUnavailableKey: 'kimiSessionsUnavailable' },
        ],
        sessionResults: {
            codex: { available: true, sessions: [], scannedFiles: 0, parsedFiles: 0 },
            kimi: { available: true, sessions: [{ id: 'k2' }], scannedFiles: 1, parsedFiles: 1 },
        },
        assignments: {
            codex: new Map(),
            kimi: new Map([['fallback', [{ id: 'k2' }]]]),
        },
        expandedProjects: new Set(),
        activeProviders: { fallback: 'claude' },
        pinnedSessions: new Set(),
        aliases: {},
        aggregateByProjectAndSession: new Map(),
        localAttentionBySession: {},
        includeLocalAttention: false,
        getProjectKey: item => item.id,
    });
    assert.strictEqual(fallbackProject.activeAiSessionProvider, 'kimi');
}

function runAiSessionDashboardControllerChecks() {
    const invalidated = [];
    const messages = [];
    const clearedTimeouts = [];
    const refreshReasons = [];
    const diagnostics = [];
    let nowMs = 2000;
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'],
        isVisible: () => true,
        invalidateCache: providerId => invalidated.push(providerId),
        watchSessionChanges: () => ({ dispose() {} }),
        getGroups: () => [],
        getCards: () => [],
        getOpenProjectAiSessionViewModel: project => project,
        nextSequence: () => 1,
        postMessage: message => {
            messages.push(message);
            return Promise.resolve(true);
        },
        refresh: () => undefined,
        logError: error => { throw new Error(`Unexpected logError: ${error}`); },
        beforeRefresh: reason => refreshReasons.push(reason),
        afterRefresh: () => undefined,
        nowMs: () => {
            nowMs += 5;
            return nowMs;
        },
        logDiagnostic: event => diagnostics.push(event),
        debounceMs: 1,
        newSessionRefreshDelaysMs: [1, 2],
        setTimeout: callback => {
            callback();
            return { disposed: false };
        },
        clearTimeout: handle => clearedTimeouts.push(handle),
    });

    controller.scheduleNewSessionRefresh('codex');
    controller.dispose();
    assert.deepStrictEqual(invalidated, ['codex', 'codex']);
    assert.deepStrictEqual(refreshReasons, ['new-session', 'new-session']);
    assert.strictEqual(messages.length, 2);
    assert.deepStrictEqual(messages.map(message => message.type), ['ai-sessions-updated', 'ai-sessions-updated']);
    assert.deepStrictEqual(diagnostics, [{
        event: 'ai-session-message-build',
        reason: 'new-session',
        durationMs: 5,
        cardCount: 0,
        openProjectCount: 0,
    }, {
        event: 'ai-session-message-build',
        reason: 'new-session',
        durationMs: 5,
        cardCount: 0,
        openProjectCount: 0,
    }]);
    assert.strictEqual(clearedTimeouts.length, 0);
}

function runAiSessionDashboardWatcherCoalescingChecks() {
    const messages = [];
    const refreshReasons = [];
    const scheduled = [];
    const cleared = [];
    let nowMs = 1000;
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'],
        isVisible: () => true,
        invalidateCache: () => undefined,
        watchSessionChanges: () => ({ dispose() {} }),
        getGroups: () => [],
        getCards: () => [],
        getOpenProjectAiSessionViewModel: project => project,
        nextSequence: () => messages.length + 1,
        postMessage: message => {
            messages.push(message);
            return Promise.resolve(true);
        },
        refresh: () => undefined,
        logError: error => { throw new Error(`Unexpected logError: ${error}`); },
        beforeRefresh: reason => refreshReasons.push(reason),
        afterRefresh: () => undefined,
        nowMs: () => nowMs,
        debounceMs: 100,
        watcherRefreshMinIntervalMs: 1000,
        newSessionRefreshDelaysMs: [],
        setTimeout: (callback, delayMs) => {
            const handle = { callback, delayMs };
            scheduled.push(handle);
            return handle;
        },
        clearTimeout: handle => cleared.push(handle),
    });

    controller.scheduleRefresh('watcher');
    assert.strictEqual(scheduled[0].delayMs, 100);
    scheduled[0].callback();
    assert.deepStrictEqual(refreshReasons, ['watcher']);
    assert.strictEqual(messages.length, 1);

    nowMs = 1200;
    controller.scheduleRefresh('watcher');
    assert.strictEqual(scheduled[1].delayMs, 800);
    nowMs = 1300;
    controller.scheduleRefresh('watcher');
    assert.deepStrictEqual(cleared, [scheduled[1]]);
    assert.strictEqual(scheduled[2].delayMs, 700);
    scheduled[2].callback();
    assert.deepStrictEqual(refreshReasons, ['watcher', 'watcher']);
    assert.strictEqual(messages.length, 2);

    nowMs = 1350;
    controller.scheduleRefresh('attention');
    assert.strictEqual(scheduled[3].delayMs, 100, 'non-watcher refreshes should not be throttled by watcher coalescing');
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
    const pattern = new RegExp(`\\b${methodName}\\s*\\(`, 'g');
    let match;
    let signatureIndex = -1;
    let openingBraceIndex = -1;
    while ((match = pattern.exec(source)) !== null) {
        const candidateIndex = match.index;
        const candidateBraceIndex = source.indexOf('{', candidateIndex);
        const candidateSemicolonIndex = source.indexOf(';', candidateIndex);
        if (candidateBraceIndex !== -1 && (candidateSemicolonIndex === -1 || candidateBraceIndex < candidateSemicolonIndex)) {
            signatureIndex = candidateIndex;
            openingBraceIndex = candidateBraceIndex;
            break;
        }
    }
    assert.notStrictEqual(signatureIndex, -1);

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
            providers.AI_SESSION_PROVIDER_IDS.map(providerId => providers.getAiSessionProviderDefinition(providerId)),
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

function runCodexSessionMetaCacheChecks() {
    const previousCodexHome = process.env.CODEX_HOME;
    const originalOpenSync = fs.openSync;
    const originalReadFileSync = fs.readFileSync;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-codex-meta-cache-'));
    const sessionsDir = path.join(tempRoot, 'sessions', '2026', '07', '16');
    const sessionId = '88888888-8888-4888-8888-888888888888';
    try {
        process.env.CODEX_HOME = tempRoot;
        fs.mkdirSync(sessionsDir, { recursive: true });
        const sessionFile = writeCodexSessionMetaFile(sessionsDir, sessionId, {
            id: sessionId,
            session_id: sessionId,
            cwd: '/work/app',
            timestamp: '2026-07-16T01:00:00.000Z',
            source: 'vscode',
        });
        const indexPath = path.join(tempRoot, 'session_index.jsonl');
        fs.writeFileSync(indexPath, JSON.stringify({
            id: sessionId,
            thread_name: 'Cached Index',
            updated_at: '2026-07-16T02:00:00.000Z',
        }) + '\n', 'utf8');

        let sessionMetaOpenCount = 0;
        let sessionIndexReadCount = 0;
        fs.openSync = function patchedOpenSync(filePath, flags, mode) {
            if (filePath === sessionFile) {
                sessionMetaOpenCount++;
            }
            return originalOpenSync.apply(this, arguments);
        };
        fs.readFileSync = function patchedReadFileSync(filePath, options) {
            if (filePath === indexPath) {
                sessionIndexReadCount++;
            }
            return originalReadFileSync.apply(this, arguments);
        };

        const service = new CodexSessionService();
        assert.strictEqual(service.getSessions({ forceRefresh: true }).sessions[0].id, sessionId);
        const firstReadCount = sessionMetaOpenCount;
        const firstIndexReadCount = sessionIndexReadCount;
        assert.ok(firstReadCount > 0, 'first Codex scan should read session metadata from disk');
        assert.ok(firstIndexReadCount > 0, 'first Codex scan should read session index from disk');

        assert.strictEqual(service.getSessions({ forceRefresh: true }).sessions[0].id, sessionId);
        assert.strictEqual(
            sessionMetaOpenCount,
            firstReadCount,
            'unchanged Codex session metadata should be reused across forced scans'
        );
        assert.strictEqual(
            sessionIndexReadCount,
            firstIndexReadCount,
            'unchanged Codex session index should be reused across forced scans'
        );
    } finally {
        fs.openSync = originalOpenSync;
        fs.readFileSync = originalReadFileSync;
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

function runAiSessionProviderMaxFilesChecks() {
    const previousCodexHome = process.env.CODEX_HOME;
    const previousKimiHome = process.env.KIMI_SHARE_DIR;
    const previousClaudeHome = process.env.CLAUDE_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-provider-budget-'));
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const thirdId = '33333333-3333-4333-8333-333333333333';
    try {
        const codexHome = path.join(tempRoot, 'codex');
        const codexSessionsDir = path.join(codexHome, 'sessions');
        fs.mkdirSync(codexSessionsDir, { recursive: true });
        writeCodexSessionMetaFile(codexSessionsDir, firstId, {
            id: firstId, session_id: firstId, cwd: '/work/app', timestamp: '2026-07-14T01:00:00.000Z',
        });
        writeCodexSessionMetaFile(codexSessionsDir, secondId, {
            id: secondId, session_id: secondId, cwd: '/work/app', timestamp: '2026-07-14T02:00:00.000Z',
        });
        fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), [
            { id: firstId, thread_name: 'One', updated_at: '2026-07-14T01:00:00.000Z' },
            { id: secondId, thread_name: 'Two', updated_at: '2026-07-14T02:00:00.000Z' },
        ].map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
        process.env.CODEX_HOME = codexHome;
        const codexResult = new CodexSessionService().getSessions({ maxFiles: 1, forceRefresh: true });
        assert.strictEqual(codexResult.sessions.length, 1);
        assert.strictEqual(codexResult.scannedFiles, 2);
        assert.strictEqual(codexResult.parsedFiles, 1);

        const kimiHome = path.join(tempRoot, 'kimi');
        const workDir = '/work/app';
        const secondWorkDir = '/work/other';
        const workDirHash = crypto.createHash('md5').update(workDir, 'utf8').digest('hex');
        const secondWorkDirHash = crypto.createHash('md5').update(secondWorkDir, 'utf8').digest('hex');
        const kimiSessionsRoot = path.join(kimiHome, 'sessions', workDirHash);
        const secondKimiSessionsRoot = path.join(kimiHome, 'sessions', secondWorkDirHash);
        fs.mkdirSync(kimiSessionsRoot, { recursive: true });
        fs.mkdirSync(secondKimiSessionsRoot, { recursive: true });
        fs.writeFileSync(path.join(kimiHome, 'kimi.json'), JSON.stringify({ work_dirs: [{ path: workDir }, { path: secondWorkDir }] }), 'utf8');
        for (const sessionId of [firstId, secondId]) {
            const sessionDir = path.join(kimiSessionsRoot, sessionId);
            fs.mkdirSync(sessionDir, { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'wire.jsonl'), '{}\n', 'utf8');
            fs.writeFileSync(path.join(sessionDir, 'state.json'), '{}', 'utf8');
        }
        const thirdSessionDir = path.join(secondKimiSessionsRoot, thirdId);
        fs.mkdirSync(thirdSessionDir, { recursive: true });
        fs.writeFileSync(path.join(thirdSessionDir, 'wire.jsonl'), '{}\n', 'utf8');
        fs.writeFileSync(path.join(thirdSessionDir, 'state.json'), '{}', 'utf8');
        process.env.KIMI_SHARE_DIR = kimiHome;
        fs.utimesSync(path.join(kimiSessionsRoot, firstId, 'wire.jsonl'), new Date('2026-07-14T01:00:00.000Z'), new Date('2026-07-14T01:00:00.000Z'));
        fs.utimesSync(path.join(kimiSessionsRoot, secondId, 'wire.jsonl'), new Date('2026-07-14T02:00:00.000Z'), new Date('2026-07-14T02:00:00.000Z'));
        fs.utimesSync(path.join(secondKimiSessionsRoot, thirdId, 'wire.jsonl'), new Date('2026-07-14T03:00:00.000Z'), new Date('2026-07-14T03:00:00.000Z'));
        const kimiResult = new KimiSessionService().getSessions({ maxFiles: 2, forceRefresh: true });
        assert.strictEqual(kimiResult.sessions.length, 2);
        assert.deepStrictEqual(kimiResult.sessions.map(session => session.id), [thirdId, secondId]);
        assert.strictEqual(kimiResult.scannedFiles, 3);
        assert.strictEqual(kimiResult.parsedFiles, 2);
        fs.writeFileSync(path.join(secondKimiSessionsRoot, thirdId, 'state.json'), JSON.stringify({ archived: true }), 'utf8');
        const kimiArchivedResult = new KimiSessionService().getSessions({ maxFiles: 1, forceRefresh: true });
        assert.strictEqual(kimiArchivedResult.sessions.length, 0, 'Kimi maxFiles should cap scanned session directories, including archived sessions');
        assert.strictEqual(kimiArchivedResult.scannedFiles, 3);
        assert.strictEqual(kimiArchivedResult.parsedFiles, 1);

        const claudeHome = path.join(tempRoot, 'claude');
        const claudeProjectDir = path.join(claudeHome, 'projects', '-work-app');
        fs.mkdirSync(claudeProjectDir, { recursive: true });
        for (const sessionId of [firstId, secondId, thirdId]) {
            fs.writeFileSync(path.join(claudeProjectDir, `${sessionId}.jsonl`), JSON.stringify({
                sessionId, cwd: '/work/app', timestamp: '2026-07-14T01:00:00.000Z',
            }) + '\n', 'utf8');
        }
        process.env.CLAUDE_HOME = claudeHome;
        const claudeResult = new ClaudeSessionService().getSessions({ maxFiles: 2, forceRefresh: true });
        assert.strictEqual(claudeResult.sessions.length, 2);
        assert.strictEqual(claudeResult.scannedFiles, 3);
        assert.strictEqual(claudeResult.parsedFiles, 2);
    } finally {
        if (previousCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = previousCodexHome;
        }
        if (previousKimiHome === undefined) {
            delete process.env.KIMI_SHARE_DIR;
        } else {
            process.env.KIMI_SHARE_DIR = previousKimiHome;
        }
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

    const beforeReload = new AiSessionAttentionMonitor({ now: () => now });
    const acknowledgedBeforeReload = beforeReload.evaluate([{
        key: 'codex:reloaded',
        signal: signal('turn-before-reload', 'needsAttention', 'completed'),
    }])[0];
    const afterReload = new AiSessionAttentionMonitor({ now: () => now + 1 });
    const newTurnAfterReload = afterReload.evaluate([{
        key: 'codex:reloaded',
        signal: signal('turn-after-reload', 'needsAttention', 'completed', now + 1),
    }])[0];
    assert.notStrictEqual(
        newTurnAfterReload.eventId,
        acknowledgedBeforeReload.eventId,
        'a new lifecycle event must not collide with an acknowledgement after Extension Host reload'
    );

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
    assert.strictEqual(monitor.getSnapshot()['claude:visible'].state, 'needsAttention', 'active terminal attention remains unread until explicit handling');
    now++;
    assert.deepStrictEqual(monitor.evaluate([{ key: 'claude:visible', signal: signal('failed-1', 'needsAttention', 'failed'), ownerVisible: true }]), [], 'the same active-terminal event is never duplicated');
    assert.strictEqual(monitor.getSnapshot()['claude:visible'].state, 'needsAttention', 'remaining on the active terminal does not auto-acknowledge attention');

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
    assert.strictEqual(events.length, 0, 'returning to the owning terminal does not acknowledge or replay the event');
    assert.strictEqual(monitor.getSnapshot()['codex:return-visible'].event.eventId, hiddenEventId);
    assert.strictEqual(monitor.getSnapshot()['codex:return-visible'].state, 'needsAttention');
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
    const openPath = '/work/app';
    const openKey = attentionProject.getAttentionProjectKey(openPath);
    const remoteOpenProject = attentionProject.withAttentionProject({
        id: 'open-project',
        path: openPath,
        attentionProjectPath: remotePath,
    }, {
        protocolVersion: 1,
        aggregateRevision: 'remote-revision',
        generatedAtMs: 10,
        sessions: [{
            projectId: openKey,
            sessionKey: 'codex:remote',
            eventIds: ['event-remote'],
            reasons: ['input-required'],
            observedAtMs: 2,
        }],
    });
    assert.strictEqual(
        remoteOpenProject.aiSessionAttentionCount,
        1,
        'OPEN attention identity must use the actual open path shared by OTHER WINDOWS cards'
    );
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
    runDashboardSearchCatalogChecks();
    runDashboardDiagnosticsChecks();
    runAttentionProjectionChecks();
    runFavoriteProjectOrderChecks();
    runOpenProjectRuntimeIdentityChecks();
    runWorkspaceHelperChecks();
    runCandidateFilterChecks();
    runProjectCandidateChecks();
    runSessionPathChecks();
    runPendingTerminalMatcherChecks();
    runTerminalCandidateChecks();
    runPendingTerminalResolverChecks();
    runScanOptionChecks();
    runTerminalCwdChecks();
    runDisplayChecks();
    runPinStoreChecks();
    await runPinControllerChecks();
    runAliasStoreChecks();
    runAliasControllerChecks();
    await runProjectStateStoreChecks();
    await runAiSessionCommandControllerChecks();
    await runAiSessionCreationControllerChecks();
    await runAiSessionResumeControllerChecks();
    await runAiSessionAttentionControllerChecks();
    await runAiSessionProjectHydrationControllerChecks();
    runKeyChecks();
    runBatchAiSessionArchiveChecks();
    runActiveAiSessionTerminalHighlightChecks();
    runAiSessionTerminalResolutionChecks();
    await runAiSessionTerminalBindingStoreChecks();
    await runAiSessionTerminalPersistenceChecks();
    await runBatchAiSessionArchiveHostChecks();
    runWebviewContentChecks();
    runCurrentWorkspaceRenderingChecks();
    runFavoriteRenderingChecks();
    runAttentionProjectRenderingChecks();
    runFavoriteDndChecks();
    runBatchAiSessionWebviewChecks();
    runAiSessionIncrementalRefreshSourceChecks();
    runAiSessionReadCoordinatorChecks();
    runOpenProjectAiSessionViewModelBuilderChecks();
    runAiSessionProjectHydrationChecks();
    runAiSessionDashboardControllerChecks();
    runAiSessionDashboardWatcherCoalescingChecks();
    runGitRepositoryDetectorChecks();
    runCodexSubagentSessionFilterChecks();
    runCodexSessionActivityTimestampChecks();
    runCodexSessionMetaCacheChecks();
    runKimiNestedSubagentBoundaryChecks();
    runClaudeSessionChecks();
    runAiSessionProviderMaxFilesChecks();
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
