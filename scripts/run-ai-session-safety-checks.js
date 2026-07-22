'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { validateSafetyScripts } = require('./lib/ciContracts');
const vm = require('vm');
const commands = require('../out/aiSessions/commandBuilders');
const launchSpec = require('../out/aiSessions/launchSpec');
const helpers = require('../out/aiSessions/sessionHelpers');
const archiveBatch = require('../out/aiSessions/archiveBatch');
const activeTerminalHighlight = require('../out/aiSessions/activeTerminalHighlight');
const activeSessionProjection = require('../out/aiSessions/activeSessionProjection');
const lifecycle = require('../out/aiSessions/lifecycle');
const IncrementalJsonlLifecycleReader = require('../out/aiSessions/incrementalJsonlLifecycleReader').default;
const jsonlTail = require('../out/aiSessions/jsonlTail');
const terminalBindingStore = require('../out/aiSessions/terminalBindingStore');
const AiSessionTerminalBindingStore = terminalBindingStore.default;
const AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX = terminalBindingStore.AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX;
const AiSessionAttentionMonitor = require('../out/aiSessions/attentionMonitor').default;
const AiSessionExecutionMonitor = require('../out/aiSessions/executionMonitor').default;
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
const providerAvailability = require('../out/aiSessions/providerAvailability');
const AiSessionTerminalCommandController = require('../out/aiSessions/terminalCommandController').AiSessionTerminalCommandController;
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
const AiSessionExecutionController = require('../out/aiSessions/executionController').AiSessionExecutionController;
const TmuxFocusedRuntimeMonitor = require('../out/aiSessions/tmuxFocusedRuntimeMonitor')
    .TmuxFocusedRuntimeMonitor;
const settleAiSessionRuntimeLifecycles = require('../out/aiSessions/attentionController').settleAiSessionRuntimeLifecycles;
const runAiSessionRuntimeLifecycleTask = require('../out/aiSessions/attentionController').runAiSessionRuntimeLifecycleTask;
const AiSessionArchiveController = require('../out/aiSessions/archiveController').AiSessionArchiveController;
const AiSessionProjectHydrationController = require('../out/aiSessions/projectHydrationController').AiSessionProjectHydrationController;
const SidebarStewardViewProvider = require('../out/dashboard/viewProvider').SidebarStewardViewProvider;
const dashboardErrorContent = require('../out/dashboard/errorContent');
Module._load = originalModuleLoad;

const TODO_SEARCH_ITEMS = [{
    key: 'todo:ai-safety',
    todoId: 'ai-safety',
    groupId: 'release',
    title: 'Preserve AI catalog',
    groupTitle: 'Release',
    priority: 'medium',
    completed: true,
    notesSearchText: 'non-empty AI safety fixture',
    searchText: 'preserve ai catalog release medium non-empty ai safety fixture',
}];

function decodePowerShellPayload(command) {
    const prefix = 'powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ';
    assert.ok(command.startsWith(prefix));
    return Buffer.from(command.slice(prefix.length), 'base64').toString('utf16le');
}

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

function hasClassTokens(classValue, ...tokens) {
    return tokens.every(token => classValue.split(/\s+/).includes(token));
}

// PROJECT-PATH-001
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

// WEBVIEW-DASHBOARD-SEARCH-CATALOG-001
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
        codexSessions: [{ id: 'c1', name: 'Fix dashboard', updatedAt: '2026-07-15T10:00:00Z', active: true }],
        kimiSessions: [{ id: 'k1', name: 'Review layout', updatedAt: '2026-07-15T09:00:00Z' }],
        claudeSessions: [],
    }, {
        id: '__openProjectNavigation-remote', name: 'Remote Dashboard', description: 'Remote',
        path: 'vscode-remote://ssh-remote+host/work/dashboard-api',
        openProjectCardKind: 'projectNavigation', openProjectEnvironmentLabel: 'SSH',
    }];

    const catalog = dashboardViewModel.buildDashboardSearchCatalog(groups, openProjects);
    assert.deepStrictEqual(catalog.sessions.map(item => item.key), ['codex:c1', 'kimi:k1']);
    assert.strictEqual(catalog.sessions.find(item => item.sessionId === 'c1').active, true);
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

// ERROR-DASHBOARD-DIAGNOSTICS-001
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

// ATTENTION-ATTENTION-PROJECTION-001
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

// PROJECT-FAVORITE-PROJECT-ORDER-001
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

// PROJECT-WORKSPACE-HELPER-001
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

// PROJECT-TERMINAL-CANDIDATE-001
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

// PERSIST-PIN-STORE-001
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

// PERSIST-ALIAS-STORE-001
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

// PERSIST-PROJECT-STATE-STORE-001
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

// PROJECT-ACTIVE-AI-SESSION-PROJECTION-001
function runActiveAiSessionProjectionChecks() {
    const projects = [{
        id: 'app',
        path: '/work/app',
        codexSessions: [{ id: 'c1', name: 'Codex live', updatedAt: '2026-07-18T01:00:00Z' }],
        kimiSessions: [{
            id: 'k1',
            name: 'Kimi waiting',
            updatedAt: '2026-07-18T02:00:00Z',
            attention: { eventId: 'e1', reason: 'input-required', unread: true },
        }],
        claudeSessions: [],
    }];
    const projected = activeSessionProjection.applyAiSessionRuntimeProjection({
        projects,
        providers: providers.AI_SESSION_PROVIDER_DEFINITIONS,
        activeRuntimes: [
            {
                identity: { provider: 'codex', sessionId: 'c1', projectKey: '/work/app', cwd: '/work/app' },
                backend: 'vscode', state: 'active', markerPath: '/tmp/c1.done', runStartedAtMs: 10, attached: true,
            },
            {
                identity: { provider: 'kimi', sessionId: 'k1', projectKey: '/work/app', cwd: '/work/app' },
                backend: 'vscode', state: 'active', markerPath: '/tmp/k1.done', runStartedAtMs: 20, attached: true,
            },
        ],
        pendingRuntimes: [{
            identity: { provider: 'claude', pendingId: 'pending-claude', projectKey: '/work/app', cwd: '/work/app' },
            backend: 'vscode', state: 'pending', markerPath: '/tmp/claude.done',
            runStartedAtMs: Date.parse('2026-07-18T03:00:00Z'), attached: true,
            createdAt: '2026-07-18T03:00:00Z',
            excludedSessionIds: [],
            title: 'New Claude',
        }],
        executionSnapshot: {
            'codex:c1': { state: 'running', stateChangedAt: 100 },
            'kimi:k1': { state: 'stopped', stateChangedAt: 200 },
        },
        focusedIdentity: { provider: 'codex', sessionId: 'c1' },
        getProjectCwd: project => project.path,
        normalizePath: value => value && value.replace(/\/$/, ''),
    });

    assert.deepStrictEqual(projected[0].activeAiSessions.map(item => ({
        provider: item.provider,
        executionState: item.executionState,
        status: item.status,
        focused: item.focused,
        needsAttention: item.needsAttention,
    })), [
        { provider: 'kimi', executionState: 'stopped', status: 'needsAttention', focused: false, needsAttention: true },
        { provider: 'codex', executionState: 'running', status: 'focused', focused: true, needsAttention: false },
        { provider: 'claude', executionState: 'starting', status: 'starting', focused: false, needsAttention: false },
    ]);
    assert.deepStrictEqual(projected[0].activeAiSessions.map(item => item.provider), ['kimi', 'codex', 'claude']);
    assert.strictEqual(projected[0].activeAiSessions[0].focused, false);
    assert.strictEqual(projected[0].codexSessions[0].active, true);
    assert.strictEqual(projected[0].codexSessions[0].focused, true);
    assert.strictEqual(projected[0].kimiSessions[0].active, true);
    assert.strictEqual(projected[0].activeAiSessionTab, 'active');
    assert.strictEqual(projects[0].codexSessions[0].active, undefined, 'projection must not mutate hydration input');

    const swappedExecutionStates = activeSessionProjection.applyAiSessionRuntimeProjection({
        projects,
        providers: providers.AI_SESSION_PROVIDER_DEFINITIONS,
        activeTerminals: [
            { provider: 'codex', sessionId: 'c1', cwd: '/work/app', runStartedAtMs: 10 },
            { provider: 'kimi', sessionId: 'k1', cwd: '/work/app', runStartedAtMs: 20 },
        ],
        pendingTerminals: [{
            provider: 'claude',
            cwd: '/work/app',
            createdAt: '2026-07-18T03:00:00Z',
            title: 'New Claude',
        }],
        executionSnapshot: {
            'codex:c1': { state: 'stopped', stateChangedAt: 300 },
            'kimi:k1': { state: 'running', stateChangedAt: 400 },
        },
        focusedIdentity: { provider: 'codex', sessionId: 'c1' },
        getProjectCwd: project => project.path,
        normalizePath: value => value && value.replace(/\/$/, ''),
    });
    assert.deepStrictEqual(
        swappedExecutionStates[0].activeAiSessions.map(item => item.provider),
        ['kimi', 'codex', 'claude']
    );

    const withoutHistory = activeSessionProjection.applyAiSessionRuntimeProjection({
        projects: [{ id: 'historyless', path: '/work/historyless', codexSessions: [], kimiSessions: [], claudeSessions: [] }],
        providers: providers.AI_SESSION_PROVIDER_DEFINITIONS,
        activeRuntimes: [{
            identity: {
                provider: 'claude', sessionId: '1234567890abcdef',
                projectKey: '/work/historyless', cwd: '/work/historyless/',
            },
            backend: 'vscode', state: 'active', markerPath: '/tmp/historyless.done',
            runStartedAtMs: 30,
            attached: true,
        }],
        pendingRuntimes: [],
        executionSnapshot: {},
        focusedIdentity: null,
        getProjectCwd: project => project.path,
        normalizePath: value => value && value.replace(/\/$/, ''),
    });
    assert.strictEqual(withoutHistory[0].activeAiSessions.length, 1);
    assert.strictEqual(withoutHistory[0].activeAiSessions[0].provider, 'claude');
    assert.strictEqual(withoutHistory[0].activeAiSessions[0].executionState, 'stopped');
    assert.ok(withoutHistory[0].activeAiSessions[0].name.includes('12345678'));
    assert.deepStrictEqual(withoutHistory[0].claudeSessions, []);

    const stableStarting = activeSessionProjection.applyAiSessionRuntimeProjection({
        projects: [{ id: 'stable', path: '/work/stable', codexSessions: [], kimiSessions: [], claudeSessions: [] }],
        providers: providers.AI_SESSION_PROVIDER_DEFINITIONS,
        activeRuntimes: [],
        pendingRuntimes: [
            {
                identity: { provider: 'kimi', pendingId: 'first', projectKey: '/work/stable', cwd: '/work/stable' },
                backend: 'vscode', state: 'pending', markerPath: '/tmp/first.done', attached: true,
                runStartedAtMs: Date.parse('2026-07-18T03:00:00Z'),
                createdAt: '2026-07-18T03:00:00Z', excludedSessionIds: [], title: 'First',
            },
            {
                identity: { provider: 'codex', pendingId: 'second', projectKey: '/work/stable', cwd: '/work/stable' },
                backend: 'vscode', state: 'pending', markerPath: '/tmp/second.done', attached: true,
                runStartedAtMs: Date.parse('2026-07-18T03:01:00Z'),
                createdAt: '2026-07-18T03:01:00Z', excludedSessionIds: [], title: 'Second',
            },
        ],
        executionSnapshot: {},
        focusedIdentity: null,
        getProjectCwd: project => project.path,
        normalizePath: value => value,
    });
    assert.deepStrictEqual(stableStarting[0].activeAiSessions.map(item => item.name), ['First', 'Second']);

    const empty = activeSessionProjection.applyAiSessionRuntimeProjection({
        projects: [{ id: 'empty', path: '/work/empty', codexSessions: [], kimiSessions: [], claudeSessions: [] }],
        providers: providers.AI_SESSION_PROVIDER_DEFINITIONS,
        activeRuntimes: [],
        pendingRuntimes: [],
        executionSnapshot: {},
        focusedIdentity: null,
        getProjectCwd: project => project.path,
        normalizePath: value => value,
    });
    assert.strictEqual(empty[0].activeAiSessionTab, 'sessions');
}

// ATTENTION-AI-SESSION-ATTENTION-CONTROLLER-001
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
    const runtimeEntries = new Map([
        ['codex:session-a', {
            identity: {
                provider: 'codex', sessionId: 'session-a', projectKey: 'project-a', cwd: '/work/a',
            },
            backend: 'tmux', state: 'completed', markerPath: '/tmp/completed.marker',
            runStartedAtMs: 900, attached: false,
            tmux: { layout: 'session', sessionName: 'project-steward-s-codex-a' },
        }],
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
        getRuntimeById: (providerId, sessionId) => runtimeEntries.get(`${providerId}:${sessionId}`) || null,
        isRuntimeComplete: runtime => runtime.state === 'completed',
        publish: async (items, forceHeartbeat) => {
            published.push({ items: items.map(item => ({ ...item })), forceHeartbeat: Boolean(forceHeartbeat) });
            return true;
        },
        scheduleRefresh: reason => scheduled.push(reason),
        postProjectsUpdated: summaries => postedSummaries.push(summaries.map(summary => ({ ...summary }))),
        nowMs: () => nowMs,
    });

    const evaluation = await controller.evaluate();
    assert.deepStrictEqual(evaluation, {
        enabled: true,
        published: true,
        inScopeSessionKeys: ['codex:session-a'],
        eventIdsBySession: {
            'codex:session-a': [published[0].items[0].eventId],
        },
        overflowedSessionKeys: [],
    }, 'attention evaluation must expose structured scope, publication, and event evidence');
    assert.deepStrictEqual(scheduled, ['attention']);
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].forceHeartbeat, false);
    assert.strictEqual(published[0].items.length, 1);
    assert.strictEqual(published[0].items[0].projectId, attentionProject.getAttentionProjectKey('/work/a'));
    assert.strictEqual(published[0].items[0].sessionKey, 'codex:session-a');
    assert.strictEqual(published[0].items[0].state, 'needsAttention');
    assert.strictEqual(published[0].items[0].reason, 'completed');
    assert.strictEqual(published[0].items[0].observedAtMs, 900);
    assert.ok(published[0].items[0].eventId.endsWith(
        crypto.createHash('sha256').update('terminal-exit:900').digest('hex')
    ), 'a current completion marker must preserve the existing terminal-exit attention signal');
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

    const coexistPublished = [];
    const coexistController = new AiSessionAttentionController({
        isEnabled: () => true,
        getOpenProjects: () => projects,
        getProviders: () => providersForTest,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        getProjectKey: project => attentionProject.getAttentionProjectKey(project.path),
        getRuntimeById: () => ({
            identity: {
                provider: 'codex', sessionId: 'session-a', projectKey: 'project-a', cwd: '/work/a',
            },
            backend: 'vscode', state: 'active', markerPath: '/tmp/live.marker',
            runStartedAtMs: 1200, attached: true,
        }),
        isRuntimeComplete: runtime => runtime.state === 'completed',
        publish: async items => { coexistPublished.push(items.map(item => ({ ...item }))); return true; },
        scheduleRefresh: () => undefined,
        postProjectsUpdated: () => undefined,
        nowMs: () => nowMs,
    });
    const oldInactiveRuntime = {
        identity: {
            provider: 'codex', sessionId: 'session-a', projectKey: 'project-a', cwd: '/work/a',
        },
        backend: 'tmux', state: 'completed', markerPath: '/tmp/old.marker',
        runStartedAtMs: 800, attached: false,
        tmux: { layout: 'session', sessionName: 'old-inactive' },
    };
    await coexistController.evaluate([{
        providerId: 'codex', sessionId: 'session-a', runtime: oldInactiveRuntime,
    }]);
    assert.ok(coexistPublished[0][0].eventId.endsWith(
        crypto.createHash('sha256').update('terminal-exit:800').digest('hex')
    ), 'an old inactive lifecycle must publish its own event even if a live runtime anomalously coexists');
    const multiRunEvaluation = await coexistController.evaluate([
        {
            providerId: 'codex', sessionId: 'session-a', attentionKey: 'codex:session-a:700:tmux',
            runtime: { ...oldInactiveRuntime, runStartedAtMs: 700 },
        },
        {
            providerId: 'codex', sessionId: 'session-a', attentionKey: 'codex:session-a:800:vscode',
            runtime: { ...oldInactiveRuntime, backend: 'vscode', runStartedAtMs: 800 },
        },
    ]);
    assert.deepStrictEqual(multiRunEvaluation.inScopeSessionKeys, [
        'codex:session-a:700:tmux', 'codex:session-a:800:vscode',
    ]);
    assert.strictEqual(coexistPublished[1].length, 3,
        'same-session inactive runs must publish stable distinct lifecycle events alongside retained events');
    assert.strictEqual(new Set(coexistPublished[1].map(item => item.eventId)).size, 3);

    const retainedPublished = [];
    const retainedController = new AiSessionAttentionController({
        isEnabled: () => true,
        getOpenProjects: () => projects,
        getProviders: () => providersForTest,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        getProjectKey: project => attentionProject.getAttentionProjectKey(project.path),
        getRuntimeById: () => null,
        isRuntimeComplete: runtime => runtime.state === 'completed',
        publish: async items => {
            retainedPublished.push(items.map(item => ({ ...item })));
            return true;
        },
        scheduleRefresh: () => undefined,
        postProjectsUpdated: () => undefined,
        nowMs: () => nowMs,
    });
    const retainedKey = 'codex:session-a:800:tmux';
    await retainedController.evaluate([{
        providerId: 'codex',
        sessionId: 'session-a',
        attentionKey: retainedKey,
        runtime: oldInactiveRuntime,
    }]);
    const retainedEventId = retainedPublished[0][0].eventId;
    await retainedController.evaluate();
    assert.deepStrictEqual(retainedPublished[1], [retainedPublished[0][0]],
        'an owner snapshot must keep publishing unread completion after runtime removal');
    assert.deepStrictEqual(retainedController.getRecoverySessionEvents(), [{
        sessionKey: 'codex:session-a',
        eventIds: [retainedEventId],
    }], 'a Session click must address its retained per-run attention event');
    retainedController.acknowledge([retainedEventId]);
    await retainedController.evaluate();
    assert.deepStrictEqual(retainedPublished[2], [],
        'explicit Session acknowledgement removes the retained owner item');

    let disableClearsEnabled = true;
    const disableClearsController = new AiSessionAttentionController({
        isEnabled: () => disableClearsEnabled,
        getOpenProjects: () => projects,
        getProviders: () => providersForTest,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        getProjectKey: project => attentionProject.getAttentionProjectKey(project.path),
        getRuntimeById: () => null,
        isRuntimeComplete: runtime => runtime.state === 'completed',
        publish: async () => true,
        scheduleRefresh: () => undefined,
        postProjectsUpdated: () => undefined,
        nowMs: () => nowMs,
    });
    await disableClearsController.evaluate([{
        providerId: 'codex',
        sessionId: 'session-a',
        attentionKey: retainedKey,
        runtime: oldInactiveRuntime,
    }]);
    assert.ok(disableClearsController.getLocalSnapshot()[retainedKey],
        'the setup must retain an unread attention item before disabling the feature');
    disableClearsEnabled = false;
    await disableClearsController.evaluate();
    assert.deepStrictEqual(disableClearsController.getLocalSnapshot(), {},
        'disabling attention must discard retained local events instead of reviving them on re-enable');

    const boundedPublished = [];
    const boundedController = new AiSessionAttentionController({
        isEnabled: () => true,
        getOpenProjects: () => projects,
        getProviders: () => providersForTest,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        getProjectKey: project => attentionProject.getAttentionProjectKey(project.path),
        getRuntimeById: () => null,
        isRuntimeComplete: runtime => runtime.state === 'completed',
        publish: async items => { boundedPublished.push(items); return true; },
        scheduleRefresh: () => undefined,
        postProjectsUpdated: () => undefined,
        nowMs: () => nowMs,
    });
    const boundedEvaluation = await boundedController.evaluate(Array.from({ length: 1001 }, (_, index) => ({
        providerId: 'codex',
        sessionId: 'session-a',
        attentionKey: `codex:session-a:${index + 1}:tmux`,
        runtime: { ...oldInactiveRuntime, runStartedAtMs: index + 1 },
    })));
    assert.strictEqual(boundedPublished[0].length, 1000,
        'retained attention publication must respect the protocol item bound');
    assert.strictEqual(Math.min(...boundedPublished[0].map(item => item.observedAtMs)), 2,
        'the bounded publication keeps the newest completion observations');
    assert.strictEqual(
        boundedController.getLocalSnapshot()['codex:session-a:1:tmux'],
        undefined,
        'the oldest overflow event is discarded instead of accumulating locally'
    );
    assert.deepStrictEqual(
        boundedEvaluation.overflowedSessionKeys,
        ['codex:session-a:1:tmux'],
        'lifecycle settlement receives explicit evidence for the discarded event'
    );

    const equalTimestampPublished = [];
    const equalTimestampController = new AiSessionAttentionController({
        isEnabled: () => true,
        getOpenProjects: () => projects,
        getProviders: () => providersForTest,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        getProjectKey: project => attentionProject.getAttentionProjectKey(project.path),
        getRuntimeById: () => null,
        isRuntimeComplete: runtime => runtime.state === 'completed',
        publish: async items => { equalTimestampPublished.push(items); return true; },
        scheduleRefresh: () => undefined,
        postProjectsUpdated: () => undefined,
        nowMs: () => nowMs,
    });
    await equalTimestampController.evaluate([
        {
            providerId: 'codex',
            sessionId: 'session-a',
            attentionKey: 'codex:session-a:850:vscode',
            runtime: { ...oldInactiveRuntime, backend: 'vscode', runStartedAtMs: 850 },
        },
        {
            providerId: 'codex',
            sessionId: 'session-a',
            attentionKey: 'codex:session-a:850:tmux',
            runtime: { ...oldInactiveRuntime, runStartedAtMs: 850 },
        },
    ]);
    const equalTimestampEventIds = equalTimestampPublished[0].map(item => item.eventId);
    assert.deepStrictEqual(equalTimestampEventIds, equalTimestampEventIds.slice().sort(),
        'equal-timestamp owner items use event ID as a deterministic tie-break');

    const completionOrder = [];
    let evaluationCount = 0;
    const candidates = [
        { key: 'codex:session-a:700:vscode', state: 'completed', backend: 'vscode' },
        { key: 'codex:session-b:800:tmux', state: 'completed', backend: 'tmux' },
        { key: 'codex:session-c:900:tmux', state: 'completed', backend: 'tmux' },
        { key: 'kimi:missing-event', state: 'completed', backend: 'tmux' },
        { key: 'claude:out-of-scope', state: 'completed', backend: 'vscode' },
        { key: 'codex:stopped', state: 'stopped', backend: 'tmux' },
    ];
    const settled = await settleAiSessionRuntimeLifecycles({
        candidates,
        evaluateAttention: async () => {
            evaluationCount++;
            completionOrder.push('publish');
            return {
                enabled: true,
                published: true,
                inScopeSessionKeys: [
                    'codex:session-a:700:vscode',
                    'codex:session-b:800:tmux',
                    'codex:session-c:900:tmux',
                    'kimi:missing-event',
                ],
                eventIdsBySession: {
                    'codex:session-a:700:vscode': ['direct-completed-event'],
                    'codex:session-b:800:tmux': ['tmux-completed-event'],
                },
                overflowedSessionKeys: ['codex:session-c:900:tmux'],
            };
        },
        release: candidate => {
            completionOrder.push(`release:${candidate.backend}:${candidate.key}`);
        },
        reportFailure: (operation, category, key) => {
            completionOrder.push(`failure:${operation}:${category}:${key || ''}`);
        },
    });
    assert.strictEqual(evaluationCount, 1,
        'one lifecycle settlement round must perform one global attention evaluation');
    assert.deepStrictEqual(settled, {
        releasedKeys: [
            'claude:out-of-scope',
            'codex:session-a:700:vscode',
            'codex:session-b:800:tmux',
            'codex:session-c:900:tmux',
            'codex:stopped',
        ],
        retainedKeys: ['kimi:missing-event'],
    });
    assert.deepStrictEqual(completionOrder, [
        'publish',
        'release:vscode:claude:out-of-scope',
        'release:vscode:codex:session-a:700:vscode',
        'release:tmux:codex:session-b:800:tmux',
        'release:tmux:codex:session-c:900:tmux',
        'release:tmux:codex:stopped',
    ], 'delivery releases both backends without acknowledging user attention');

    let prematureRelease = 0;
    const unpublished = await settleAiSessionRuntimeLifecycles({
        candidates: [{ key: 'codex:unpublished', state: 'completed' }],
        evaluateAttention: async () => ({
            enabled: true,
            published: false,
            inScopeSessionKeys: ['codex:unpublished'],
            eventIdsBySession: { 'codex:unpublished': ['unpublished-event'] },
            overflowedSessionKeys: [],
        }),
        release: () => { prematureRelease++; },
    });
    assert.deepStrictEqual(unpublished, {
        releasedKeys: [], retainedKeys: ['codex:unpublished'],
    });
    assert.strictEqual(prematureRelease, 0,
        'an in-scope completion that was not published must remain owned for retry');

    const disabledReleases = [];
    await settleAiSessionRuntimeLifecycles({
        candidates: [{ key: 'codex:disabled', state: 'completed' }],
        evaluateAttention: async () => ({
            enabled: false, published: true, inScopeSessionKeys: [], eventIdsBySession: {},
            overflowedSessionKeys: [],
        }),
        release: candidate => { disabledReleases.push(candidate.key); },
    });
    assert.deepStrictEqual(disabledReleases, ['codex:disabled'],
        'disabled attention must safely release completed lifecycle ownership');

    const containedFailures = [];
    const rejectedSettlement = await settleAiSessionRuntimeLifecycles({
        candidates: [{ key: 'codex:rejected', state: 'completed' }],
        evaluateAttention: async () => { throw new Error('/secret/raw-evaluate'); },
        release: () => { throw new Error('/secret/raw-release'); },
        reportFailure: (...args) => { containedFailures.push(args); },
    });
    assert.deepStrictEqual(rejectedSettlement, {
        releasedKeys: [], retainedKeys: ['codex:rejected'],
    });
    assert.deepStrictEqual(containedFailures, [['evaluate', 'unexpected', undefined]],
        'settlement catches rejection and reports only fixed redacted fields');

    for (const rejectedOperation of ['release']) {
        const failures = [];
        let releases = 0;
        const result = await settleAiSessionRuntimeLifecycles({
            candidates: [{ key: `codex:${rejectedOperation}`, state: 'completed' }],
            evaluateAttention: async () => ({
                enabled: true,
                published: true,
                inScopeSessionKeys: [`codex:${rejectedOperation}`],
                eventIdsBySession: { [`codex:${rejectedOperation}`]: ['event'] },
                overflowedSessionKeys: [],
            }),
            release: () => {
                releases++;
                throw new Error('/secret/release');
            },
            reportFailure: (...args) => { failures.push(args); },
        });
        assert.deepStrictEqual(result, {
            releasedKeys: [], retainedKeys: [`codex:${rejectedOperation}`],
        }, `${rejectedOperation} rejection must retain lifecycle ownership`);
        assert.strictEqual(releases, 1);
        assert.deepStrictEqual(failures, [[rejectedOperation, 'unexpected',
            `codex:${rejectedOperation}`]]);
    }

    const unhandledLifecycleRejections = [];
    const lifecycleTaskFailures = [];
    const captureUnhandledLifecycleRejection = reason => {
        unhandledLifecycleRejections.push(reason);
    };
    process.on('unhandledRejection', captureUnhandledLifecycleRejection);
    try {
        void runAiSessionRuntimeLifecycleTask(
            'attention-interval',
            async () => { throw new Error('/secret/unhandled-lifecycle'); },
            (operation, category) => lifecycleTaskFailures.push([operation, category])
        );
        await new Promise(resolve => setImmediate(resolve));
    } finally {
        process.removeListener('unhandledRejection', captureUnhandledLifecycleRejection);
    }
    assert.deepStrictEqual(unhandledLifecycleRejections, [],
        'fire-and-forget attention lifecycle tasks must never emit unhandledRejection');
    assert.deepStrictEqual(lifecycleTaskFailures, [['attention-interval', 'unexpected']],
        'fire-and-forget lifecycle failures report only fixed redacted fields');

    const reporterUnhandledRejections = [];
    const captureReporterUnhandledRejection = reason => {
        reporterUnhandledRejections.push(reason);
    };
    process.on('unhandledRejection', captureReporterUnhandledRejection);
    try {
        void runAiSessionRuntimeLifecycleTask(
            'throwing-reporter',
            async () => { throw new Error('/secret/task'); },
            () => { throw new Error('/secret/reporter'); }
        );
        void runAiSessionRuntimeLifecycleTask(
            'rejecting-reporter',
            async () => { throw new Error('/secret/task'); },
            () => Promise.reject(new Error('/secret/reporter-promise'))
        );
        await new Promise(resolve => setImmediate(resolve));
    } finally {
        process.removeListener('unhandledRejection', captureReporterUnhandledRejection);
    }
    assert.deepStrictEqual(reporterUnhandledRejections, [],
        'throwing and rejecting lifecycle failure reporters must remain contained');

    runtimeEntries.set('codex:session-a', {
        identity: {
            provider: 'codex', sessionId: 'session-a', projectKey: 'project-a', cwd: '/work/a',
        },
        backend: 'tmux', state: 'stopped', markerPath: '/tmp/stopped.marker',
        runStartedAtMs: 900, attached: false,
        tmux: { layout: 'session', sessionName: 'project-steward-s-codex-a' },
    });
    await controller.evaluate();
    assert.deepStrictEqual(controller.getLocalSnapshot(), {},
        'a stopped runtime without a current marker must remove attention ownership');
    assert.deepStrictEqual(published[published.length - 1].items, [],
        'a stopped runtime must not publish a completed attention item');

    const remoteAggregate = {
        protocolVersion: 1,
        aggregateRevision: '1'.repeat(64),
        generatedAtMs: 1200,
        sessions: [{
            projectId: attentionProject.getAttentionProjectKey('/work/remote'),
            sessionKey: 'kimi:remote:1200:tmux',
            reasons: ['input-required'],
            eventIds: ['remote-event'],
            observedAtMs: 1200,
        }],
    };
    assert.strictEqual(controller.setRemoteAggregate(remoteAggregate), true);
    assert.strictEqual(controller.setRemoteAggregate(remoteAggregate), false);
    assert.strictEqual(controller.hasRemoteAggregate(), true);
    assert.strictEqual(controller.getEffectiveAggregate().sessions[0].sessionKey, 'kimi:remote:1200:tmux');
    assert.deepStrictEqual(controller.getRecoverySessionEvents().map(item => item.sessionKey), ['kimi:remote']);

    enabled = false;
    const disabledEvaluation = await controller.evaluate();
    assert.strictEqual(controller.hasRemoteAggregate(), false);
    assert.deepStrictEqual(controller.getLocalSnapshot(), {});
    assert.deepStrictEqual(published[published.length - 1], { items: [], forceHeartbeat: true });
    assert.deepStrictEqual(scheduled.slice(-1), ['attention']);
    assert.deepStrictEqual(disabledEvaluation, {
        enabled: false, published: true, inScopeSessionKeys: [], eventIdsBySession: {},
        overflowedSessionKeys: [],
    });
}

// SESSION-SIDEBAR-STEWARD-VIEW-PROVIDER-ORDERING-001
async function runSidebarStewardViewProviderOrderingChecks() {
    const order = [];
    const visibilityListeners = [];
    const messageListeners = [];
    const view = {
        visible: true,
        webview: {
            options: {},
            html: '',
            postMessage: async () => true,
            onDidReceiveMessage: listener => { messageListeners.push(listener); return { dispose() {} }; },
        },
        onDidChangeVisibility: listener => { visibilityListeners.push(listener); return { dispose() {} }; },
    };
    const provider = new SidebarStewardViewProvider({
        getWebviewOptions: () => ({}),
        renderContent: () => { order.push('render'); return '<main>fresh</main>'; },
        renderError: () => '<main>error</main>',
        onMessage: async () => undefined,
        onVisibleChanged: async visible => {
            order.push(`visible:${visible}:start`);
            await Promise.resolve();
            order.push(`visible:${visible}:end`);
        },
        logError: () => undefined,
    });
    await provider.resolveWebviewView(view, {}, {});
    assert.deepStrictEqual(order, ['visible:true:start', 'visible:true:end', 'render'],
        'first visible render must await forced runtime refresh');
    view.visible = false;
    await visibilityListeners[0]();
    assert.deepStrictEqual(order.slice(-2), ['visible:false:start', 'visible:false:end'],
        'hidden views must not render or force a runtime refresh');
    view.visible = true;
    await visibilityListeners[0]();
    assert.deepStrictEqual(order.slice(-3), ['visible:true:start', 'visible:true:end', 'render'],
        'later visible renders must also await refresh and render exactly once');

    let staleRenderCount = 0;
    const failedLogs = [];
    const failedView = {
        visible: true,
        webview: {
            options: {}, html: '', postMessage: async () => true,
            onDidReceiveMessage: listener => { messageListeners.push(listener); return { dispose() {} }; },
        },
        onDidChangeVisibility: () => ({ dispose() {} }),
    };
    const failedProvider = new SidebarStewardViewProvider({
        getWebviewOptions: () => ({}),
        renderContent: () => { staleRenderCount++; return '<main>stale</main>'; },
        renderError: () => '<main>runtime unavailable</main>',
        onMessage: async () => { throw new Error('raw message failure'); },
        onVisibleChanged: async () => { throw new Error('raw refresh failure'); },
        logError: message => { failedLogs.push(message); },
    });
    await failedProvider.resolveWebviewView(failedView, {}, {});
    assert.strictEqual(staleRenderCount, 0,
        'a rejected runtime refresh must not render stale state as fresh');
    assert.strictEqual(failedView.webview.html, '<main>runtime unavailable</main>');
    await messageListeners[messageListeners.length - 1]({ type: 'rejected-action' });
    assert.deepStrictEqual(failedLogs, [
        'Failed to prepare Project Steward view.',
        'Failed to handle a Project Steward message.',
    ], 'visibility and message rejections must be contained at the view boundary');

    const secret = '/home/private/tmux-custom-bin --token=do-not-render';
    const visibleFailureLogs = [];
    const secretView = {
        visible: true,
        webview: {
            options: {}, html: '', postMessage: async () => true,
            onDidReceiveMessage: listener => { messageListeners.push(listener); return { dispose() {} }; },
        },
        onDidChangeVisibility: () => ({ dispose() {} }),
    };
    const secretProvider = new SidebarStewardViewProvider({
        getWebviewOptions: () => ({}), renderContent: () => '<main>stale</main>',
        renderError: dashboardErrorContent.getErrorContent,
        onMessage: async () => { throw new Error(secret); },
        onVisibleChanged: async () => { throw new Error(secret); },
        logError: (message, error) => { visibleFailureLogs.push(`${message}|${String(error)}`); },
    });
    await secretProvider.resolveWebviewView(secretView, {}, {});
    await messageListeners[messageListeners.length - 1]({ type: 'secret-failure' });
    assert.strictEqual(secretView.webview.html.includes(secret), false,
        'visible error HTML must never include raw executable paths or exception text');
    assert.strictEqual(visibleFailureLogs.some(line => line.includes(secret)), false,
        'the view provider must not forward raw visible-boundary failures to logs');
    assert.ok(secretView.webview.html.includes('Project Steward could not render this view.'));
}

// WEBVIEW-ACTIVE-AI-SESSION-TERMINAL-HIGHLIGHT-001
function runActiveAiSessionTerminalHighlightChecks() {
    const terminalA = { name: 'A' };
    const terminalB = { name: 'B' };
    let activeTerminal = terminalA;
    let visible = true;
    let complete = new Set();
    let published = [];
    let completionCount = 0;
    let completedResolution = null;
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
        onComplete: resolution => {
            completionCount++;
            completedResolution = resolution;
        },
        setInterval: callback => {
            const handle = { callback, active: true };
            timers.push(handle);
            return handle;
        },
        clearInterval: handle => { handle.active = false; },
    });

    highlighter.sync();
    assert.deepStrictEqual(published.pop(), { provider: 'codex', sessionId: 'a' });
    const firstIdentity = highlighter.getIdentity();
    assert.deepStrictEqual(firstIdentity, { provider: 'codex', sessionId: 'a' });
    firstIdentity.sessionId = 'mutated';
    assert.deepStrictEqual(highlighter.getIdentity(), { provider: 'codex', sessionId: 'a' });
    assert.strictEqual(timers.filter(timer => timer.active).length, 1);

    activeTerminal = terminalB;
    highlighter.sync();
    assert.deepStrictEqual(published.pop(), { provider: 'kimi', sessionId: 'b' });
    assert.strictEqual(timers.filter(timer => timer.active).length, 1);

    complete.add('b');
    timers.find(timer => timer.active).callback();
    assert.strictEqual(published.pop(), null);
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);
    assert.strictEqual(completionCount, 1, 'terminal completion requests an immediate attention reevaluation');
    assert.strictEqual(completedResolution.sessionId, 'b', 'terminal completion identifies the session binding to release');

    complete.clear();
    activeTerminal = terminalA;
    highlighter.sync();
    highlighter.handleTerminalClosed(terminalA);
    assert.strictEqual(published.pop(), null);
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);
    assert.strictEqual(completionCount, 1, 'closing a terminal is not reported as marker completion');

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

// PERSIST-AI-SESSION-TERMINAL-BINDING-STORE-001
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
        cwd: '/work/app',
    });
    await second.flush();
    assert.strictEqual(new AiSessionTerminalBindingStore(state).get(processId).sessionId, 'session-new');
    assert.strictEqual(new AiSessionTerminalBindingStore(state).get(processId).cwd, '/work/app');

    const legacyBoundProcessId = 42010;
    stateData[AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX + legacyBoundProcessId] = {
        version: 2,
        state: 'bound',
        providerId: 'kimi',
        sessionId: 'legacy-session',
        markerPath: '/tmp/legacy.done',
        runStartedAtMs: 10,
        updatedAtMs: 11,
    };
    assert.deepStrictEqual(new AiSessionTerminalBindingStore(state).get(legacyBoundProcessId), {
        version: 2,
        state: 'bound',
        providerId: 'kimi',
        sessionId: 'legacy-session',
        markerPath: '/tmp/legacy.done',
        runStartedAtMs: 10,
        updatedAtMs: 11,
    });

    const released = new AiSessionTerminalBindingStore(state);
    released.setReleased(processId, {
        providerId: 'codex',
        sessionId: 'session-new',
        markerPath: '/tmp/session-new.done',
    });
    await released.flush();
    assert.deepStrictEqual(new AiSessionTerminalBindingStore(state).get(processId), {
        version: 2,
        state: 'released',
        providerId: 'codex',
        sessionId: 'session-new',
        markerPath: '/tmp/session-new.done',
        updatedAtMs: released.get(processId).updatedAtMs,
    });

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

// WEBVIEW-WEBVIEW-CONTENT-001
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
    const attentionMonitorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'attentionMonitor.ts'), 'utf8');
    const executionControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'executionController.ts'), 'utf8');
    const activeSessionProjectionSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'activeSessionProjection.ts'), 'utf8');
    const dashboardRuntimeControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'runtimeController.ts'), 'utf8');
    const dashboardLifecycleControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'lifecycleController.ts'), 'utf8');
    const evaluateAttentionFunction = extractMethodBody(attentionControllerSource, 'evaluate');
    const evaluateAttentionMonitorFunction = extractMethodBody(attentionMonitorSource, 'evaluate');
    const evaluateExecutionFunction = extractMethodBody(executionControllerSource, 'evaluate');
    const archiveControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'archiveController.ts'), 'utf8');
    const singleArchiveFunction = extractMethodBody(archiveControllerSource, 'archiveSession');
    const batchArchiveFunction = extractMethodBody(archiveControllerSource, 'archiveSessions');
    const archiveItemFunction = extractMethodBody(archiveControllerSource, 'archiveSessionItem');
    const batchArchiveLogFunction = extractMethodBody(archiveControllerSource, 'logBatchAiSessionArchiveResult');
    const projectWindowColorService = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'projectWindowColorService.ts'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const settingsFunction = extractFunctionBody(dashboard, 'showProjectStewardSettings');
    const sidebarStyles = extractExactScssBlock(styles, 'body.steward-sidebar');
    const sessionFxKeyframes = {
        current: 'flow',
        sweep: 'sweep',
        orbit: 'orbit',
        ripple: 'ripple',
        halo: 'halo',
        breath: 'breath',
    };
    for (const sessionFx of Object.keys(sessionFxKeyframes)) {
        assert.ok(styles.includes(`&[data-session-fx="${sessionFx}"]`),
            `styles must define the ${sessionFx} session-running animation`);
        const keyframes = `steward-session-running-${sessionFxKeyframes[sessionFx]}`;
        assert.ok(styles.includes(`@keyframes ${keyframes}`),
            `styles must define the ${keyframes} keyframes`);
        assert.ok(compiledStyles.includes(keyframes),
            `compiled styles must include the ${keyframes} keyframes`);
    }
    assert.ok(compiledStyles.includes('.project-session-fx'));
    assert.strictEqual(sidebarStyles.includes('.project[data-current-workspace]'), false,
        'current workspace shell state must be owned by the shared item card');
    assert.strictEqual(sidebarStyles.includes('.project-border'), false,
        'sidebar projects must use the shared accent selector instead of project-specific rail geometry');
    const sharedItemAccentBlock = extractExactScssBlock(sidebarStyles, '.steward-item-accent');
    const sharedItemAccentHoverBlock = extractScssBlock(sidebarStyles, '.steward-item-card:hover .steward-item-accent');
    const projectStyleBlock = extractExactScssBlock(sidebarStyles, '.project');
    const openProjectStyleBlock = extractExactScssBlock(projectStyleBlock, '&[data-open-project]');
    const expandedProjectHoverBlock = extractExactScssBlock(openProjectStyleBlock, '&[data-codex-expanded]:hover');
    const expandedProjectAccentBlock = extractExactScssBlock(expandedProjectHoverBlock, '.steward-item-accent');
    const compiledSharedItemAccentBlock = extractExactCssBlock(compiledStyles, 'body.steward-sidebar .steward-item-accent');
    const compiledSharedItemAccentHoverBlock = extractExactCssBlock(compiledStyles, 'body.steward-sidebar .steward-item-card:hover .steward-item-accent');
    const compiledExpandedProjectAccentBlock = extractExactCssBlock(compiledStyles, 'body.steward-sidebar .project[data-open-project][data-codex-expanded]:hover .steward-item-accent');
    const currentItemCardStyleBlock = extractExactScssBlock(sidebarStyles, '&[data-current-workspace]');
    const compiledCurrentItemCardStyleBlock = extractScssBlock(compiledStyles, 'body.steward-sidebar .steward-item-card[data-current-workspace]');
    const sessionTabsHtml = webviewContentModule.getAiSessionsDiv({
        id: 'project-a',
        activeAiSessionProvider: 'codex',
        activeAiSessionTab: 'active',
        codexSessions: [{ id: 'c1', name: 'Codex live', active: true }],
        kimiSessions: [{ id: 'k1', name: 'Kimi history' }],
        claudeSessions: [],
        activeAiSessions: [
            {
                key: 'codex:c1', provider: 'codex', sessionId: 'c1', name: 'Codex live',
                executionState: 'running', focused: true, needsAttention: false, pending: false,
                backend: 'vscode', attached: true,
            },
            {
                key: 'kimi:k2', provider: 'kimi', sessionId: 'k2', name: 'Kimi waiting',
                executionState: 'stopped', focused: false, needsAttention: true, pending: false,
                attentionEventId: 'attention-1',
                backend: 'tmux', attached: false, tmuxLayout: 'project',
            },
            {
                key: 'claude:c3', provider: 'claude', sessionId: 'c3', name: 'Claude running',
                executionState: 'running', focused: false, needsAttention: false, pending: false,
                backend: 'vscode', attached: true, status: 'conflict', conflict: true, stale: true,
            },
            {
                key: 'pending:claude:2026-07-18T03:00:00Z', provider: 'claude', name: 'New Claude',
                executionState: 'starting', focused: false, needsAttention: false, pending: true,
                createdAt: '2026-07-18T03:00:00Z',
                backend: 'vscode', attached: true,
            },
        ],
    });
    assert.ok(sessionTabsHtml.includes('class="ai-session-module-header"'));
    assert.ok(sessionTabsHtml.includes('data-action="create-ai-session"'));
    assert.ok(!sessionTabsHtml.includes('data-action="create-ai-session" data-provider='));
    assert.ok(sessionTabsHtml.includes('role="tablist" aria-label="AI Session views"'));
    assert.ok(sessionTabsHtml.includes('data-ai-session-tab="active"'));
    assert.ok(sessionTabsHtml.includes('data-ai-session-tab="sessions"'));
    assert.ok(sessionTabsHtml.includes('id="ai-session-active-project-a"'));
    assert.ok(sessionTabsHtml.includes('id="ai-session-history-project-a"'));
    assert.ok(sessionTabsHtml.includes('data-execution-state="running"'));
    assert.ok(sessionTabsHtml.includes('data-execution-state="stopped"'));
    assert.ok(sessionTabsHtml.includes('data-execution-state="starting"'));
    assert.ok(sessionTabsHtml.includes('class="ai-session-execution-status"'));
    assert.ok(sessionTabsHtml.includes('class="ai-session-execution-dot"'));
    assert.ok(sessionTabsHtml.includes('aria-label="AI is currently executing"'));
    assert.ok(sessionTabsHtml.includes('aria-label="AI is not currently executing"'));
    assert.ok(sessionTabsHtml.includes('aria-label="Waiting for AI activity"'));
    assert.ok(sessionTabsHtml.includes('aria-hidden="true"></span>Running</span>'));
    assert.ok(sessionTabsHtml.includes('aria-hidden="true"></span>Stopped</span>'));
    assert.ok(sessionTabsHtml.includes('aria-hidden="true"></span>Starting</span>'));
    assert.ok(sessionTabsHtml.includes('AI session needs attention'));
    assert.ok(sessionTabsHtml.includes('data-session-focused'));
    assert.ok(sessionTabsHtml.includes(
        '<span class="codex-session-title-line"><span class="ai-session-runtime-badge" title="Direct VS Code terminal" aria-label="Direct VS Code terminal">vscode</span><span class="codex-session-name">Codex live</span></span>'
    ), 'a VS Code backend badge must appear before the focused Session name');
    assert.ok(sessionTabsHtml.includes(
        '<span class="codex-session-title-line"><span class="ai-session-runtime-badge" title="Managed tmux runtime" aria-label="Managed tmux runtime">tmux</span><span class="codex-session-name">Kimi waiting</span></span>'
    ), 'a tmux backend badge must appear before the Session name');
    const activeMetadata = Array.from(sessionTabsHtml.matchAll(
        /<div class="codex-session-row active-ai-session-row"[\s\S]*?<span class="codex-session-meta">([\s\S]*?)<\/span>\s*<\/span>/g
    ), match => match[1]);
    assert.ok(activeMetadata.length >= 4, 'every Active Session fixture must expose a metadata line');
    assert.ok(activeMetadata.every(metadata => !/Codex|Kimi|Claude|Focused/.test(metadata)),
        'Active Session metadata must omit redundant Provider and Focused labels');
    assert.ok(activeMetadata.every(metadata => metadata.startsWith(
        '<span class="ai-session-execution-status"'
    )), 'every Active Session metadata line must begin with execution state');
    assert.ok(activeMetadata.every(metadata => !metadata.includes('Needs attention')),
        'the attention dot must not be duplicated by visible metadata text');
    const activeRows = Array.from(sessionTabsHtml.matchAll(
        /<div class="codex-session-row active-ai-session-row"[\s\S]*?<\/div>/g
    ), match => match[0]);
    const attentionRows = activeRows.filter(row => row.includes('data-session-needs-attention'));
    assert.strictEqual(attentionRows.length, 1, 'the fixture must render one attention Active Session row');
    assert.ok(attentionRows[0].includes(
        '<span class="ai-session-attention-indicator" title="AI session needs attention" aria-label="AI session needs attention"></span>'
    ), 'the attention Active Session row must retain the dot, tooltip, and accessible label');
    assert.ok(activeMetadata.some(metadata =>
        metadata.includes('Running</span> · <span class="ai-session-stale-status"')
        && metadata.includes('</span> · Runtime conflict · ')
    ), 'stale and conflict diagnostics must follow execution state');
    assert.ok(attentionRows[0].includes('data-session-needs-attention'));
    assert.ok(!sessionTabsHtml.includes('data-session-status='));
    assert.ok(sessionTabsHtml.includes('data-session-pending'));
    assert.ok(sessionTabsHtml.includes('data-session-active'));
    assert.ok(sessionTabsHtml.includes('Stop the active runtime before archiving.'));
    assert.ok(sessionTabsHtml.includes('aria-live="polite"'));
    assert.ok(webviewContent.includes('data-ai-session-total-count'));
    assert.ok(webviewContent.includes('role="menu" aria-label="AI Session actions"'));
    assert.ok(webviewContent.includes('role="menuitem" tabindex="-1"'));
    assert.ok(webviewProjectScripts.includes("e.key === 'ContextMenu'"));
    assert.ok(webviewProjectScripts.includes("e.key === 'F10' && e.shiftKey"));
    assert.ok(webviewProjectScripts.includes("rowToFocus?.querySelector('.ai-session-primary-action') || selectedTab"));
    assert.ok(sessionTabsHtml.includes('class="ai-session-primary-action"'));
    assert.ok(sessionTabsHtml.includes('role="group"'));
    assert.ok(!/class="codex-session-row[^>]*tabindex=/.test(sessionTabsHtml));
    assert.ok(webviewProjectScripts.includes('updateOpenProjectAiSessionBadge(projectDiv, totalCount, attentionCount, activeCount)'));

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
    assert.ok(webviewContent.includes('resolveAttentionProjectKey(project)'));
    assert.ok(webviewContent.includes('class="ai-session-attention-indicator"'));
    assert.ok(styles.includes('.ai-session-attention-indicator'));
    assert.ok(dashboard.includes('getProjectKey: project => getAttentionProjectKey(project.path)'));
    assert.ok(attentionControllerSource.includes('const projectKey = this.options.getProjectKey(project);'));
    assert.ok(attentionControllerSource.includes('projectId: projectKey'));
    assert.ok(attentionControllerSource.includes('observedAtMs: attention.stateChangedAt'));
    assert.ok(attentionControllerSource.includes("if (!runtime || runtime.state === 'stopped'"));
    assert.ok(attentionControllerSource.includes('provider.service.getLifecycleSignals(requests)'));
    assert.ok(evaluateAttentionFunction.includes('terminal-exit:'));
    assert.ok(!evaluateAttentionFunction.includes('activityToken'));
    assert.ok(!evaluateAttentionFunction.includes('projectId: project.id'));
    const pendingTerminalResolverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'pendingTerminalResolver.ts'), 'utf8');
    const resumeControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'resumeController.ts'), 'utf8');
    assert.ok(pendingTerminalResolverSource.includes('runtimeCoordinator.promotePending('));
    assert.ok(pendingTerminalResolverSource.includes('options.settlePending'));
    assert.ok(!pendingTerminalResolverSource.includes('.terminal'));
    assert.ok(resumeControllerSource.includes('runStartedAtMs: this.options.nowMs()'));
    assert.ok(dashboard.includes('nowMs: () => Date.now()'));
    assert.ok(dashboardRuntimeControllerSource.includes("type: 'ai-session-attention-projects-updated'"));
    assert.ok(dashboard.includes('sessionEvents: aiSessionAttentionController.getRecoverySessionEvents()'));
    assert.ok(webviewProjectScripts.includes('message.sessionEvents'));
    assert.ok(dashboard.includes('settleAiSessionRuntimeLifecycles'));
    assert.ok(dashboard.includes('const aiSessionAttentionController = new AiSessionAttentionController<AiSessionRuntimeSnapshot<vscode.Terminal>>({'));
    assert.ok(dashboard.includes("import { AiSessionExecutionController } from './aiSessions/executionController';"));
    assert.ok(dashboard.includes('const aiSessionExecutionController = new AiSessionExecutionController({'));
    assert.match(dashboard,
        /new AiSessionProjectHydrationController[\s\S]*?onDidPromoteRuntime: \(\) => \{[\s\S]*?aiSessionExecutionController\.evaluate\(\);[\s\S]*?\}/);
    assert.ok(dashboard.includes('getActiveSessions: () => aiSessionRuntimeCoordinator.getActive()'));
    assert.ok(dashboard.includes('executionSnapshot: aiSessionExecutionController.getSnapshot()'));
    assert.match(dashboard, /aiSessionExecutionInterval = setInterval\(\(\) => \{ aiSessionExecutionController\.evaluate\(\); \}, 1_000\)/);
    assert.match(dashboard, /setTimeout\(\(\) => \{ aiSessionExecutionController\.evaluate\(\); \}, 0\)/);
    assert.ok(dashboard.includes('clearInterval(aiSessionExecutionInterval)'));
    assert.ok(!evaluateExecutionFunction.includes('isEnabled'));
    assert.ok(!evaluateExecutionFunction.includes('attention'));
    assert.ok(evaluateAttentionFunction.includes('if (!this.options.isEnabled())'));
    assert.ok(evaluateAttentionMonitorFunction.includes('signal.phase'));
    assert.ok(activeSessionProjectionSource.includes('executionSnapshot: Record<string, AiSessionExecutionSnapshot>;'));
    assert.ok(activeSessionProjectionSource.includes("executionState: input.executionSnapshot[key]?.state || 'stopped'"));
    assert.ok(!dashboard.includes('function getEffectiveAiSessionAttentionAggregate('));
    assert.ok(!dashboard.includes('function getAiSessionAttentionRecoverySessionEvents('));
    assert.ok(dashboard.includes('async function evaluateAiSessionAttention('));
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
    assert.ok(dashboard.includes('const aiSessionResumeController = new AiSessionResumeController<vscode.Terminal>({'));
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
    assert.ok(dashboard.includes('await tmuxRuntimeBackend.restoreAttachTerminals(vscode.window.terminals)'));
    assert.ok(dashboard.includes('new ActiveAiSessionTerminalHighlighter'));
    assert.ok(dashboard.includes('new TmuxFocusedRuntimeMonitor<vscode.Terminal>({'));
    assert.ok(dashboard.includes('tmuxFocusedRuntimeMonitor.start();'));
    assert.ok((dashboard.match(/void tmuxFocusedRuntimeMonitor\.request\(\);/g) || []).length >= 2,
        'view visibility and active-terminal changes must both request reconciliation');
    assert.ok(dashboard.includes("logAiSessionRuntimeFailure('sync-focused-runtime', error)"));
    assert.ok(dashboard.includes('context.subscriptions.push(tmuxFocusedRuntimeMonitor);'));
    assert.match(dashboard, /const acknowledgeAiSessionAttentionEventIds = async[\s\S]*?aiSessionAttentionController\.acknowledge\(uniqueEventIds\);[\s\S]*?await aiSessionAttentionBridgeClient\.acknowledge\(uniqueEventIds\)/);
    assert.match(dashboard, /const acknowledgeAiSessionAttention = async[\s\S]*?await acknowledgeAiSessionAttentionEventIds\(getAiSessionAttentionEventIds\(identity\)\)/);
    const selectedProjectHandler = dashboard.slice(
        dashboard.indexOf("'selected-project': async e =>"),
        dashboard.indexOf("'add-project': async e =>")
    );
    assert.match(
        selectedProjectHandler,
        /withAttentionProject\([\s\S]*?await acknowledgeAiSessionAttentionEventIds\(attentionProject\.aiSessionAttentionEventIds\)/,
        'clicking a project card must acknowledge all attention events represented by that card'
    );
    const settlementCall = dashboard.match(/settleAiSessionRuntimeLifecycles\(\{[\s\S]*?\n\s*\}\);/)?.[0] || '';
    assert.ok(settlementCall.includes('attentionKey: candidate.key'));
    assert.ok(settlementCall.includes('release: async candidate =>'));
    assert.ok(!settlementCall.includes('acknowledgePublished'));
    assert.ok(!settlementCall.includes('acknowledgeLocal'));
    assert.doesNotMatch(
        dashboard,
        /setRemoteAggregate\(aggregate\)[\s\S]*?getReleasedSessions\(\)\.forEach/,
        'a later aggregate must not auto-acknowledge a delivered completion'
    );
    assert.match(dashboard, /onComplete: resolution => \{[\s\S]*?queueAiSessionRuntimeSettlements\(\[\{/);
    assert.ok(!dashboard.includes('void settleAiSessionRuntime('),
        'lifecycle settlement scheduling must not create unhandled fire-and-forget rejections');
    assert.ok(dashboard.includes('getRuntimeById: getAiSessionRuntimeById'));
    assert.ok(!dashboard.includes('getTerminalById: (providerId, sessionId) => aiSessionTerminalService.getActiveById(providerId, sessionId)'));
    assert.match(dashboard, /aiSessionTerminalCompletionInterval = setInterval\(\(\) => \{[\s\S]*?getCompletedSessions\(\)[\s\S]*?tmuxRuntimeDiscovery\.getInactive\(\)[\s\S]*?\}, 1_000\)/);
    assert.match(dashboard, /queueAiSessionRuntimeSettlements\(\[\.\.\.completedRuntimes, \.\.\.inactiveTmuxRuntimes\]\)/,
        'one completion polling round must queue one structured batch');
    assert.ok(dashboard.includes('vscode.window.onDidChangeActiveTerminal'));
    assert.match(dashboard, /onDidChangeActiveTerminal\(\(\) => \{[\s\S]*?activeAiSessionTerminalHighlighter\.sync\(\);[\s\S]*?runSafeAiSessionRuntimeLifecycleTask\([\s\S]*?'evaluate-attention-active-terminal'[\s\S]*?\}\)/);
    assert.ok(!dashboard.includes('void evaluateAiSessionAttention()'));
    assert.ok(!dashboard.includes('void acknowledgeAiSessionAttention('));
    assert.ok(dashboard.includes('runAiSessionRuntimeLifecycleTask('));
    assert.match(dashboard, /onDidChangeWindowState\(windowState => \{[\s\S]*?dashboardLifecycleController\.handleWindowStateChanged\(windowState\);[\s\S]*?\}\)/);
    assert.ok(dashboardLifecycleControllerSource.includes('this.options.evaluateAiSessionAttention();'));
    assert.ok(dashboardLifecycleControllerSource.includes('this.options.publishOpenProjects(true);'));
    assert.ok(dashboard.includes("'request-active-ai-session-terminal': () =>"));
    assert.ok(dashboardRuntimeControllerSource.includes("type: 'active-ai-session-terminal-changed'"));
    assert.ok(webviewProjectScripts.includes("type: 'request-active-ai-session-terminal'"));
    assert.ok(webviewProjectScripts.includes("message.type === 'active-ai-session-terminal-changed'"));
    assert.ok(webviewProjectScripts.includes('data-ai-session-active-terminal'));
    assert.ok(dashboard.includes('activeAiSessionTerminalHighlighter.sync()'));
    assert.ok(dashboard.includes('onVisibleChanged: async visible =>'));
    assert.ok(dashboard.includes('activeAiSessionTerminalHighlighter.setVisible(visible)'));
    assert.ok(dashboard.includes('await dashboardRuntimeController.handleAiSessionViewVisibilityChanged(visible)'));
    const viewProvider = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'viewProvider.ts'), 'utf8');
    assert.ok(viewProvider.includes('await this.options.onVisibleChanged(webviewView.visible)'));
    const terminalCandidatesSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'terminalCandidates.ts'), 'utf8');
    assert.ok(terminalCandidatesSource.includes("reason: 'terminal-candidates'"));
    assert.ok(!terminalCandidatesSource.includes('AI_SESSION_PROVIDER_IDS'));
    assert.ok(!terminalCandidatesSource.includes('getOpenProjects('));
    assert.ok(!terminalCandidatesSource.includes('activeAiSessionProvider'));
    assert.ok(!dashboard.includes('prunePinnedAiSessionKeys'));
    assert.ok(dashboard.includes("'archive-ai-sessions': async e =>"));
    assert.ok(dashboard.includes('AiSessionBatchArchiveCompletedMessage'));
    assert.ok(dashboard.includes("import { AiSessionArchiveController } from './aiSessions/archiveController';"));
    assert.ok(dashboard.includes('const aiSessionArchiveController = new AiSessionArchiveController<AiSessionRuntimeSnapshot<vscode.Terminal>>({'));
    assert.ok(
        dashboard.includes('refreshRuntimeGuard: () => aiSessionRuntimeCoordinator.refreshForHost(true),'),
        'archive confirmation must rescan every runtime backend so a newly external tmux runtime cannot be missed'
    );
    assert.ok(dashboard.includes('await aiSessionArchiveController.archiveSessions('));
    assert.ok(dashboard.includes('await aiSessionArchiveController.archiveSession('));
    assert.ok(!dashboard.includes('async function archiveAiSession('));
    assert.ok(!dashboard.includes('function archiveAiSessionItem('));
    assert.ok(!dashboard.includes('async function archiveAiSessions('));
    assert.ok(!dashboard.includes('function logRejectedBatchAiSessionSelections('));
    assert.ok(!dashboard.includes('function logBatchAiSessionArchiveResult('));
    assert.ok(singleArchiveFunction.includes('this.archiveSessionItem(providerId, sessionId)'));
    assert.ok(batchArchiveFunction.includes('executeBatchAiSessionArchiveRequest('));
    assert.strictEqual((singleArchiveFunction.match(/syncActiveRuntime\(\)/g) || []).length, 1);
    assert.strictEqual((batchArchiveFunction.match(/syncActiveRuntime\(\)/g) || []).length, 1);
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
    assert.ok(styles.includes('.ai-session-tabs'));
    assert.ok(styles.includes('.ai-session-execution-status'));
    assert.ok(styles.includes('.ai-session-execution-dot'));
    assert.ok(!extractScssBlock(styles, '.ai-session-execution-dot').includes('animation'));
    assert.ok(styles.includes('[data-execution-state="running"] .ai-session-execution-status'));
    assert.ok(styles.includes('[data-execution-state="running"] .codex-session-icon'),
        'styles must animate the terminal icon edge while a session executes');
    assert.ok(styles.includes('@keyframes steward-session-icon-spin'));
    assert.ok(compiledStyles.includes('[data-execution-state=running] .codex-session-icon'));
    assert.ok(compiledStyles.includes('steward-session-icon-spin'));
    assert.ok(styles.includes('var(--vscode-terminal-ansiGreen, #89d185)'));
    assert.ok(styles.includes('[data-execution-state="stopped"] .ai-session-execution-status'));
    assert.ok(styles.includes('[data-execution-state="starting"] .ai-session-execution-status'));
    assert.ok(styles.includes('color: var(--vscode-descriptionForeground);'));
    assert.ok(styles.includes('[data-session-focused]'));
    assert.ok(styles.includes('[data-session-needs-attention]'));
    assert.ok(!styles.includes('[data-session-status='));
    assert.ok(compiledStyles.includes('.ai-session-execution-status'));
    assert.ok(compiledStyles.includes('.ai-session-execution-dot'));
    assert.ok(compiledStyles.includes('[data-execution-state=running] .ai-session-execution-status'));
    assert.ok(compiledStyles.includes('var(--vscode-terminal-ansiGreen,#89d185)'));
    assert.ok(compiledStyles.includes('[data-execution-state=stopped] .ai-session-execution-status'));
    assert.ok(compiledStyles.includes('[data-execution-state=starting] .ai-session-execution-status'));
    assert.ok(compiledStyles.includes('var(--vscode-descriptionForeground)'));
    assert.ok(compiledStyles.includes('[data-session-focused]'));
    assert.ok(compiledStyles.includes('[data-session-needs-attention]'));
    assert.ok(!compiledStyles.includes('[data-session-status='));
    assert.ok(styles.includes('[data-session-pending]'));
    assert.ok(styles.includes('@media (max-width: 280px)'));
    assert.ok(styles.includes('@media (prefers-reduced-motion: reduce)'));
    assert.ok(styles.includes('[data-ai-session-managing]'));
    assert.ok(styles.includes('grid-template-columns: minmax(0, 1fr) 24px;'));
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
    assert.deepStrictEqual(
        packageJson.contributes.configuration.properties['projectSteward.aiSessionTerminalMode'].enum,
        ['vscode', 'tmux']
    );
    assert.deepStrictEqual(
        packageJson.contributes.configuration.properties['projectSteward.aiSessionRunningCardAnimation'].enum,
        ['current', 'sweep', 'orbit', 'halo', 'ripple', 'breath', 'none']
    );
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
    assert.ok(currentItemCardStyleBlock.includes('--vscode-list-inactiveSelectionBackground'));
    assert.ok(currentItemCardStyleBlock.includes('var(--vscode-focusBorder)'));
    assert.ok(currentItemCardStyleBlock.includes('box-shadow'));
    assert.ok(compiledCurrentItemCardStyleBlock.includes('var(--vscode-focusBorder)'));
    assert.ok(!currentItemCardStyleBlock.includes('animation'));
    assert.ok(styles.indexOf('&[data-current-workspace]') > styles.indexOf('&[data-codex-expanded]:hover'));
    assert.ok(compiledStyles.indexOf('.steward-item-card[data-current-workspace]') > compiledStyles.indexOf('.steward-item-card[data-codex-expanded]:hover'));
    assert.ok(sharedItemAccentBlock.includes('top: 31%'));
    assert.ok(sharedItemAccentBlock.includes('bottom: 31%'));
    assert.ok(sharedItemAccentBlock.includes('height: auto'));
    assert.deepStrictEqual(sharedItemAccentBlock.match(/\bheight\s*:[^;]+/g), ['height: auto']);
    assert.ok(sharedItemAccentHoverBlock.includes('top: 26%'));
    assert.ok(sharedItemAccentHoverBlock.includes('bottom: 26%'));
    assert.ok(!/\bheight\s*:/.test(sharedItemAccentHoverBlock));
    assert.ok(expandedProjectAccentBlock.includes('opacity: .9'));
    assert.ok(!/\bheight\s*:/.test(expandedProjectAccentBlock));
    assert.ok(compiledSharedItemAccentBlock.includes('top:31%'));
    assert.ok(compiledSharedItemAccentBlock.includes('bottom:31%'));
    assert.ok(compiledSharedItemAccentBlock.includes('height:auto'));
    assert.deepStrictEqual(compiledSharedItemAccentBlock.match(/\bheight\s*:[^;]+/g), ['height:auto']);
    assert.ok(compiledSharedItemAccentHoverBlock.includes('top:26%'));
    assert.ok(compiledSharedItemAccentHoverBlock.includes('bottom:26%'));
    assert.ok(!/\bheight\s*:/.test(compiledSharedItemAccentHoverBlock));
    assert.ok(compiledExpandedProjectAccentBlock.includes('opacity:.9'));
    assert.ok(!/\bheight\s*:/.test(compiledExpandedProjectAccentBlock));
    assert.ok(webviewContent.includes('--steward-ai-session-list-max-height: ${getAiSessionListMaxHeight(config)}px;'));
    assert.ok(webviewContent.includes('Number.isFinite(visibleRows)'));
    assert.ok(styles.includes('height: var(--steward-ai-session-list-max-height, calc(3 * 42px + 2 * 2px));'));
}

// WEBVIEW-CURRENT-WORKSPACE-RENDERING-001
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
    const getCardTags = (content, projectId) => Array.from(content.matchAll(
        new RegExp(`<div class="([^"]*)"[^>]*data-id="${projectId}"[^>]*>`, 'g')
    )).filter(match => hasClassTokens(match[1], 'project', 'steward-item-card')).map(match => match[0]);
    const hasProjectAccent = (content, style) => Array.from(
        content.matchAll(/<div class="([^"]*)" style="([^"]*)"><\/div>/g)
    ).some(match => match[2] === style && hasClassTokens(match[1], 'project-border', 'steward-item-accent'));
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
    assert.ok(hasProjectAccent(navigationHtml, ''));
    assert.ok(openTags[0].includes('style="--project-color: #00aacc;"'));
    assert.ok(hasProjectAccent(html, 'background: #00aacc;'));
    assert.ok(navigationHtml.includes('title="SSH Project"'));
    assert.match(navigationHtml, /class="project-description" title="Other workspace">\s*Other workspace\s*<\/p>/);

    const runningNavigation = webviewContentModule.getOpenProjectsGroupContent([
        {
            id: 'other-running', name: 'Other Running', path: '/work/other-running',
            remoteType: models.ProjectRemoteType.SSH,
            openProjectCardKind: 'projectNavigation', openProjectActiveSessionCount: 2,
        },
    ], false, { config });
    assert.ok(runningNavigation.includes('class="project steward-item-card session-running"'),
        'navigation cards with running sessions must mark the card as session-running');
    assert.ok(runningNavigation.includes('data-session-fx="current"'),
        'navigation cards with running sessions must default to the current animation');
    assert.ok(runningNavigation.includes('<div class="project-session-fx"></div>'),
        'navigation cards with running sessions must render the session fx layer');
    assert.ok(!runningNavigation.includes('project-kind-icon session-running'),
        'the kind icon must not own the session-running animation');
    assert.ok(runningNavigation.includes('title="SSH Project — 2 active sessions running"'));
    const orbitNavigation = webviewContentModule.getOpenProjectsGroupContent([
        {
            id: 'other-orbit', name: 'Other Orbit', path: '/work/other-orbit',
            openProjectCardKind: 'projectNavigation', openProjectActiveSessionCount: 1,
        },
    ], false, { config: { ...config, get: key => key === 'aiSessionRunningCardAnimation' ? 'orbit' : undefined } });
    assert.ok(orbitNavigation.includes('data-session-fx="orbit"'),
        'navigation cards must honor the configured animation');
    const invalidFxNavigation = webviewContentModule.getOpenProjectsGroupContent([
        {
            id: 'other-invalid-fx', name: 'Other Invalid Fx', path: '/work/other-invalid-fx',
            openProjectCardKind: 'projectNavigation', openProjectActiveSessionCount: 1,
        },
    ], false, { config: { ...config, get: key => key === 'aiSessionRunningCardAnimation' ? 'bogus' : undefined } });
    assert.ok(invalidFxNavigation.includes('data-session-fx="current"'),
        'unknown animation values must fall back to the current animation');
    const noFxNavigation = webviewContentModule.getOpenProjectsGroupContent([
        {
            id: 'other-no-fx', name: 'Other No Fx', path: '/work/other-no-fx',
            openProjectCardKind: 'projectNavigation', openProjectActiveSessionCount: 1,
        },
    ], false, { config: { ...config, get: key => key === 'aiSessionRunningCardAnimation' ? 'none' : undefined } });
    assert.ok(noFxNavigation.includes('class="project steward-item-card session-running"'),
        'the none animation must keep the static running border');
    assert.ok(noFxNavigation.includes('data-session-fx="none"'));
    assert.ok(!noFxNavigation.includes('project-session-fx'),
        'the none animation must not render the session fx layer');
    const idleNavigation = webviewContentModule.getOpenProjectsGroupContent([
        {
            id: 'other-idle', name: 'Other Idle', path: '/work/other-idle',
            remoteType: models.ProjectRemoteType.SSH,
            openProjectCardKind: 'projectNavigation', openProjectActiveSessionCount: 0,
        },
    ], false, { config });
    assert.ok(idleNavigation.includes('class="project-kind-icon"'));
    assert.ok(!idleNavigation.includes('session-running'),
        'navigation cards without running sessions must not animate the card edge');
    assert.ok(!idleNavigation.includes('project-session-fx'),
        'navigation cards without running sessions must not render the session fx layer');
    const currentWithSessions = webviewContentModule.getOpenProjectsGroupContent([
        {
            id: 'current-with-sessions', name: 'Current', path: '/work/current',
            remoteType: models.ProjectRemoteType.SSH,
            openProjectCardKind: 'current', openProjectActiveSessionCount: 2,
        },
    ], false, { config });
    assert.ok(!currentWithSessions.includes('session-running'),
        'current-workspace cards must not use the navigation session-running animation');
    assert.ok(!currentWithSessions.includes('project-session-fx'),
        'current-workspace cards must not render the session fx layer');

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

// WEBVIEW-FAVORITE-RENDERING-001
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
    const renderedProjectIds = Array.from(html.matchAll(/<div class="([^"]*)"[^>]*data-id="([^"]+)"[^>]*>/g))
        .filter(match => hasClassTokens(match[1], 'project', 'steward-item-card'))
        .map(match => match[2]);

    assert.deepStrictEqual(renderedProjectIds, [
        'favorite-b',
        'favorite-a',
        'favorite-a',
        'favorite-b',
        'plain',
    ]);
    const favoriteContainer = html.match(/<div class="project-container"([^>]*)>\s*<div class="([^"]*)"[^>]*data-id="favorite-b"/);
    assert.ok(favoriteContainer);
    assert.ok(!favoriteContainer[1].includes('data-nodrag'));
    assert.ok(hasClassTokens(favoriteContainer[2], 'project', 'steward-item-card'));
}

// WEBVIEW-FAVORITE-DND-001
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

// WEBVIEW-BATCH-AI-SESSION-WEBVIEW-001
function runBatchAiSessionWebviewChecks() {
    const sourcePath = path.join(__dirname, '..', 'src', 'webview', 'webviewProjectScripts.js');
    const generatedPath = path.join(__dirname, '..', 'media', 'webviewProjectScripts.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.strictEqual(fs.readFileSync(generatedPath, 'utf8'), source);
    const messages = [];
    const eventListeners = {};
    const windowEventListeners = {};
    const timeoutCallbacks = [];
    const createSessionRow = (provider, sessionId, backend = 'vscode') => {
        const attributes = new Set(['data-session-backend', 'data-session-attached']);
        const attributeValues = {
            'data-session-backend': backend,
            'data-session-attached': backend === 'vscode' ? 'true' : 'false',
        };
        const classes = new Set();
        let attentionIndicator = null;
        const row = {
            provider,
            sessionId,
            project: null,
            classList: {
                add: className => classes.add(className),
                remove: className => classes.delete(className),
                contains: className => classes.has(className),
                toggle: (className, force) => {
                    if (force) classes.add(className);
                    else classes.delete(className);
                },
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
            querySelector: selector => selector === '.ai-session-attention-indicator' ? attentionIndicator
                : selector === '.ai-session-primary-action' ? row.primaryAction : null,
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
                if (selector === '.codex-session-row' || selector === '.codex-session-row[data-session-provider]'
                    || selector === '.codex-session-row[data-session-provider][data-session-backend]') return row;
                if (selector === '.codex-session-row[data-session-id]' && sessionId) return row;
                if (selector === '.codex-session-row[data-session-id][data-session-provider]' && sessionId) return row;
                if (selector === '.codex-session-row[data-session-pending]' && attributes.has('data-session-pending')) return row;
                if (selector === '.project' || selector === '.project[data-id]') return row.project;
                return null;
            },
            focus: () => {},
            getBoundingClientRect: () => ({ left: 10, top: 10 }),
        };
        row.primaryAction = {
            focus: () => { row.primaryAction.focused = true; },
            closest: selector => {
                if (selector === '[data-action="activate-ai-session"]'
                    || selector === '.ai-session-primary-action'
                    || selector === 'button, input, select, textarea, a[href]') return row.primaryAction;
                return row.closest(selector);
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
        const project = {
            batchButtons,
            manageButton,
            get rows() { return rows; },
            replaceRowsOnNextUpdate: nextRows => {
                nextRows.forEach(row => { row.project = project; });
                replacementRows = nextRows;
            },
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
        return project;
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
    const openSessionBadgeAttributes = {
        'data-ai-session-total-count': '2',
        'data-ai-session-active-count': '1',
        'data-ai-session-attention-count': '0',
    };
    const openSessionBadgeChildren = {};
    const createOpenSessionBadgeChild = selector => {
        const child = {
            textContent: '',
            classList: { add: () => {}, remove: () => {} },
            setAttribute: () => {},
            remove: () => { delete openSessionBadgeChildren[selector]; },
        };
        openSessionBadgeChildren[selector] = child;
        return child;
    };
    const openSessionBadge = {
        getAttribute: attribute => openSessionBadgeAttributes[attribute] || null,
        setAttribute: (attribute, value) => { openSessionBadgeAttributes[attribute] = String(value); },
        querySelector: selector => openSessionBadgeChildren[selector] || null,
        insertAdjacentHTML: (_position, html) => {
            if (html.includes('ai-session-total-count')) createOpenSessionBadgeChild('.ai-session-total-count');
            if (html.includes('ai-session-active-count')) createOpenSessionBadgeChild('.ai-session-active-count');
            if (html.includes('ai-session-attention-count')) createOpenSessionBadgeChild('.ai-session-attention-count');
        },
    };
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
        querySelector: selector => {
            if (selector === '.project-ai-attention-badge') return openAttentionBadge;
            if (selector === '.project-codex-badge') return openSessionBadge;
            if (selector === '.project-codex-badge .ai-session-attention-count') {
                return openSessionBadgeChildren['.ai-session-attention-count'] || null;
            }
            return null;
        },
        querySelectorAll: () => [],
        insertAdjacentHTML: () => { openAttentionBadgeInsertions++; },
    };
    let replacedSearchCatalog = null;
    let webviewState = { unrelated: 'preserved' };
    const createMenuItem = action => {
        const classes = new Set(['custom-context-menu-item']);
        const attributes = { 'data-action': action };
        const item = {
            textContent: '',
            classList: {
                add: name => classes.add(name),
                remove: name => classes.delete(name),
                contains: name => classes.has(name),
                toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
            },
            getAttribute: name => attributes[name] || null,
            setAttribute: (name, value) => { attributes[name] = String(value); },
            toggleAttribute: (name, force) => {
                if (force) attributes[name] = '';
                else delete attributes[name];
            },
            hasAttribute: name => Object.prototype.hasOwnProperty.call(attributes, name),
            focus: () => { item.focused = true; },
            closest: selector => {
                if (selector === '#aiSessionContextMenu [data-action]'
                    || selector === '#aiSessionContextMenu [role="menuitem"]') return item;
                if (selector === '.disabled' && classes.has('disabled')) return item;
                if (selector === '#aiSessionContextMenu') return aiSessionMenu;
                return null;
            },
        };
        return item;
    };
    const resumeMenuItem = createMenuItem('resume');
    const archiveMenuItem = createMenuItem('archive');
    const closeMenuItem = createMenuItem('close-terminal');
    const aiSessionMenuItems = [resumeMenuItem, closeMenuItem, archiveMenuItem];
    const menuClasses = new Set();
    const aiSessionMenu = {
        style: {},
        classList: {
            add: name => menuClasses.add(name),
            remove: name => menuClasses.delete(name),
        },
        getBoundingClientRect: () => ({ width: 180, height: 120 }),
        querySelectorAll: selector => selector === ':scope > *' || selector === '[role="menuitem"]'
            ? aiSessionMenuItems : [],
        querySelector: selector => selector === '[data-action="archive"]' ? archiveMenuItem
            : selector === '[data-action="close-terminal"]' ? closeMenuItem
                : selector === '.custom-context-menu-item[data-action]:not(.disabled)'
                    ? aiSessionMenuItems.find(item => !item.classList.contains('disabled')) : null,
    };
    const context = {
        normalizeDashboardSearchCatalog: value => value
            && Array.isArray(value.sessions)
            && Array.isArray(value.openProjects)
            && Array.isArray(value.savedProjects)
            && Array.isArray(value.todos)
            ? value
            : { sessions: [], openProjects: [], savedProjects: [], todos: [] },
        document: {
            body: {
                classList: { toggle: () => {} },
                style: { setProperty: () => {} },
            },
            addEventListener: (event, listener) => { eventListeners[event] = listener; },
            getElementById: id => id === 'aiSessionContextMenu' ? aiSessionMenu : null,
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
                if (selector === '.custom-context-menu') return [aiSessionMenu];
                return [];
            },
        },
        window: {
            innerWidth: 800,
            innerHeight: 600,
            addEventListener: (event, listener) => { windowEventListeners[event] = listener; },
            requestAnimationFrame: callback => callback(),
            setTimeout: callback => timeoutCallbacks.push(callback),
            vscode: {
                postMessage: message => messages.push(message),
                getState: () => webviewState,
                setState: state => { webviewState = state; },
            },
            __projectStewardDashboard: { replaceSearchCatalog: catalog => { replacedSearchCatalog = catalog; } },
        },
    };

    vm.runInNewContext(source, context);
    assert.strictEqual(context.normalizeAiSessionTab('active'), 'active');
    assert.strictEqual(context.normalizeAiSessionTab('unknown'), 'sessions');
    assert.strictEqual(context.getAdjacentAiSessionTab('active', 'ArrowRight'), 'sessions');
    assert.strictEqual(context.getAdjacentAiSessionTab('sessions', 'ArrowLeft'), 'active');
    assert.strictEqual(context.getAdjacentAiSessionTab('sessions', 'Home'), 'active');
    assert.strictEqual(context.getAdjacentAiSessionTab('active', 'End'), 'sessions');
    context.writeAiSessionTabState(context.window.vscode, 'project-a', 'active');
    context.writeAiSessionTabState(context.window.vscode, 'project-b', 'sessions');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(context.readAiSessionTabState(context.window.vscode))), {
        'project-a': 'active',
        'project-b': 'sessions',
    });
    assert.strictEqual(webviewState.unrelated, 'preserved');

    const createTabElement = tabId => {
        const attributes = { 'data-ai-session-tab': tabId };
        return {
            getAttribute: attribute => attributes[attribute] || null,
            setAttribute: (attribute, value) => { attributes[attribute] = String(value); },
            focus: () => {},
        };
    };
    const activeListState = { scrollTop: 0, scrollHeight: 100, clientHeight: 40 };
    const historyListState = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
    const createTabPanel = (tabId, list) => {
        const attributes = { 'data-ai-session-panel': tabId };
        return {
            getAttribute: attribute => attributes[attribute] || null,
            toggleAttribute: (attribute, force) => {
                if (force) attributes[attribute] = '';
                else delete attributes[attribute];
                if (attribute === 'hidden') {
                    list.scrollHeight = force ? 0 : 100;
                    list.clientHeight = force ? 0 : 40;
                }
            },
            querySelector: () => null,
        };
    };
    const activeTabElement = createTabElement('active');
    const sessionsTabElement = createTabElement('sessions');
    const activePanelElement = createTabPanel('active', activeListState);
    const historyPanelElement = createTabPanel('sessions', historyListState);
    const tabStateProject = {
        querySelector: selector => {
            if (selector === '.codex-sessions') return { setAttribute: () => {} };
            if (selector === '.ai-session-active-panel .codex-sessions-list') return activeListState;
            if (selector === '.ai-session-history-panel .codex-sessions-list') return historyListState;
            if (selector === '[data-ai-session-panel="active"]') return activePanelElement;
            return null;
        },
        querySelectorAll: selector => {
            if (selector === '[data-ai-session-tab]') return [activeTabElement, sessionsTabElement];
            if (selector === '[data-ai-session-panel]') return [activePanelElement, historyPanelElement];
            if (selector === '.codex-session-row') return [];
            return [];
        },
    };
    context.restoreAiSessionViewState(tabStateProject, {
        activeScrollTop: 17,
        historyScrollTop: 29,
        restoreFocus: false,
    }, 'active');
    assert.strictEqual(activeListState.scrollTop, 17);
    assert.strictEqual(historyListState.scrollTop, 29, 'a hidden Session Tab must retain its own scroll position');
    assert.strictEqual(activeTabElement.getAttribute('aria-selected'), 'true');
    assert.strictEqual(sessionsTabElement.getAttribute('aria-selected'), 'false');
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

    activeRow.setAttribute('data-session-active', '');
    const pendingRow = createSessionRow('claude', '');
    pendingRow.project = projectA;
    pendingRow.setAttribute('data-session-pending', '');
    pendingRow.setAttribute('data-pending-created-at', '2026-07-18T08:00:00Z');
    let primarySpacePrevented = false;
    eventListeners.keydown({
        target: activeRow.primaryAction,
        key: ' ',
        preventDefault: () => { primarySpacePrevented = true; },
    });
    assert.strictEqual(primarySpacePrevented, false,
        'native Space activation on the primary button must not be intercepted');
    eventListeners.click({ button: 0, target: activeRow.primaryAction });
    eventListeners.click({ button: 0, target: otherCodexRow.primaryAction });
    eventListeners.click({ button: 0, target: pendingRow.primaryAction });

    const newSessionTarget = {
        closest: selector => {
            if (selector === '.project' || selector === '.project[data-id]') return projectA;
            if (selector === '[data-action="create-ai-session"]') return newSessionTarget;
            return null;
        },
    };
    eventListeners.click({ button: 0, target: newSessionTarget });

    const closeActiveTarget = {
        getAttribute: attribute => attribute === 'data-action' ? 'close-ai-session-terminal' : null,
        closest: selector => {
            if (selector === '.project' || selector === '.project[data-id]') return projectA;
            if (selector === '[data-action="close-ai-session-terminal"], [data-action="detach-ai-session-terminal"]') return closeActiveTarget;
            if (selector === '.codex-session-row[data-session-provider][data-session-backend]') return activeRow;
            return null;
        },
    };
    const closePendingTarget = {
        getAttribute: attribute => attribute === 'data-action' ? 'close-ai-session-terminal' : null,
        closest: selector => {
            if (selector === '.project' || selector === '.project[data-id]') return projectA;
            if (selector === '[data-action="close-ai-session-terminal"], [data-action="detach-ai-session-terminal"]') return closePendingTarget;
            if (selector === '.codex-session-row[data-session-provider][data-session-backend]') return pendingRow;
            return null;
        },
    };
    const tmuxRow = createSessionRow('kimi', 'tmux-session', 'tmux');
    tmuxRow.project = projectA;
    tmuxRow.setAttribute('data-session-active', '');
    const detachTmuxTarget = {
        getAttribute: attribute => attribute === 'data-action' ? 'detach-ai-session-terminal' : null,
        closest: selector => {
            if (selector === '.project' || selector === '.project[data-id]') return projectA;
            if (selector === '[data-action="close-ai-session-terminal"], [data-action="detach-ai-session-terminal"]') return detachTmuxTarget;
            if (selector === '.codex-session-row[data-session-provider][data-session-backend]') return tmuxRow;
            return null;
        },
    };
    eventListeners.click({ button: 0, target: closeActiveTarget });
    eventListeners.click({ button: 0, target: closePendingTarget });
    eventListeners.click({ button: 0, target: detachTmuxTarget });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages)), [{
        type: 'focus-ai-session-terminal', projectId: 'project-a', provider: 'codex', sessionId: 'active-session',
    }, {
        type: 'resume-codex-session', projectId: 'project-a', sessionId: 'other-session',
    }, {
        type: 'focus-pending-ai-session', projectId: 'project-a', provider: 'claude',
        createdAt: '2026-07-18T08:00:00Z',
    }, {
        type: 'create-ai-session', projectId: 'project-a',
    }, {
        type: 'close-ai-session-terminal', projectId: 'project-a', provider: 'codex', sessionId: 'active-session',
    }, {
        type: 'close-ai-session-terminal', projectId: 'project-a', provider: 'claude',
        pendingCreatedAt: '2026-07-18T08:00:00Z',
    }, {
        type: 'detach-ai-session-terminal', projectId: 'project-a', provider: 'kimi',
        sessionId: 'tmux-session',
    }]);
    messages.length = 0;

    let keyboardContextPrevented = false;
    eventListeners.keydown({
        target: tmuxRow.primaryAction,
        key: 'F10',
        shiftKey: true,
        preventDefault: () => { keyboardContextPrevented = true; },
    });
    assert.strictEqual(keyboardContextPrevented, true);
    assert.strictEqual(resumeMenuItem.focused, true,
        'Shift+F10 on the native primary button must preserve keyboard context-menu access');

    tmuxRow.setAttribute('data-session-conflict', '');
    eventListeners.contextmenu({
        target: tmuxRow.primaryAction,
        preventDefault: () => {},
        clientX: 20,
        clientY: 20,
        keyboardTrigger: true,
    });
    assert.strictEqual(closeMenuItem.hasAttribute('hidden'), true,
        'a conflict row must hide Close/Detach from its context menu');
    tmuxRow.removeAttribute('data-session-conflict');

    eventListeners.contextmenu({
        target: tmuxRow.primaryAction,
        preventDefault: () => {},
        clientX: 20,
        clientY: 20,
        keyboardTrigger: true,
    });
    assert.strictEqual(closeMenuItem.hasAttribute('hidden'), false);
    assert.strictEqual(closeMenuItem.textContent, 'Detach Terminal…');
    assert.strictEqual(closeMenuItem.getAttribute('aria-label'), 'Detach Terminal…');
    eventListeners.keydown({
        target: closeMenuItem,
        key: 'Enter',
        preventDefault: () => {},
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.pop())), {
        type: 'detach-ai-session-terminal', projectId: 'project-a', provider: 'kimi',
        sessionId: 'tmux-session',
    }, 'keyboard context-menu activation must preserve the tmux detach route');

    eventListeners.contextmenu({
        target: activeRow.primaryAction,
        preventDefault: () => {},
        clientX: 20,
        clientY: 20,
        keyboardTrigger: false,
    });
    assert.strictEqual(closeMenuItem.textContent, 'Close Terminal…');
    assert.strictEqual(closeMenuItem.getAttribute('aria-label'), 'Close Terminal…');
    eventListeners.click({ button: 0, target: closeMenuItem });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.pop())), {
        type: 'close-ai-session-terminal', projectId: 'project-a', provider: 'codex',
        sessionId: 'active-session',
    }, 'pointer context-menu activation must preserve the Direct close route');
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
    eventListeners.click({ button: 0, target: attentionRow.primaryAction });
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
    assert.strictEqual(openSessionBadgeChildren['.ai-session-attention-count'].textContent, '1');
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
    eventListeners.click({ button: 0, target: attentionRow.primaryAction });
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
    eventListeners.click({ button: 0, target: attentionRow.primaryAction });
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
        searchCatalog: { sessions: [], openProjects: [], savedProjects: [], todos: TODO_SEARCH_ITEMS },
        openProjects: [{
            projectId: 'project-a',
            expanded: true,
            aiSessionCount: 0,
            sessionSectionHtml: '<div class="codex-sessions">replacement</div>',
        }],
    } });
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(replacedSearchCatalog.todos)),
        TODO_SEARCH_ITEMS,
        'AI incremental rendering must preserve the non-empty TODO catalog replacement'
    );
    assert.strictEqual(replacementActiveRow.hasAttribute('data-ai-session-active-terminal'), true);
    assert.strictEqual(replacementOtherRow.hasAttribute('data-ai-session-active-terminal'), false);

    const manager = context.window.__projectStewardBatchAiSessions;
    manager.enter('project-a', 'codex');
    manager.toggle('plain', false);
    manager.selectUnpinned([
        { id: 'plain', pinned: false },
        { id: 'pinned', pinned: true },
        { id: 'second', pinned: false },
        { id: 'active', pinned: false, active: true },
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

// WEBVIEW-AI-SESSION-DASHBOARD-CONTROLLER-001
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
        getTodoSearchItems: () => TODO_SEARCH_ITEMS,
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
    assert.ok(messages.every(message => message.searchCatalog.todos.length === 1
        && message.searchCatalog.todos[0].todoId === 'ai-safety'),
        'AI incremental updates must preserve the non-empty TODO catalog');
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

// WEBVIEW-AI-SESSION-DASHBOARD-WATCHER-COALESCING-001
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
        getTodoSearchItems: () => TODO_SEARCH_ITEMS,
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
    assert.strictEqual(messages.length, 1, 'unchanged coalesced watcher refreshes may be skipped after build');

    nowMs = 1350;
    controller.scheduleRefresh('attention');
    assert.strictEqual(scheduled[3].delayMs, 100, 'non-watcher refreshes should not be throttled by watcher coalescing');
}

// WEBVIEW-AI-SESSION-DASHBOARD-UNCHANGED-MESSAGE-SKIP-001
async function runAiSessionDashboardUnchangedMessageSkipChecks() {
    const messages = [];
    const diagnostics = [];
    let sessionName = 'Codex One';
    const project = {
        id: 'project-a',
        path: '/work/app',
        codexSessions: [{ id: 'session-a', name: sessionName }],
        kimiSessions: [],
        claudeSessions: [],
    };
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'],
        isVisible: () => true,
        invalidateCache: () => undefined,
        watchSessionChanges: () => ({ dispose() {} }),
        getGroups: () => [],
        getTodoSearchItems: () => TODO_SEARCH_ITEMS,
        getCards: () => [project],
        getOpenProjectAiSessionViewModel: item => ({
            projectId: item.id,
            projectKey: item.path,
            activeProvider: 'codex',
            expanded: true,
            providers: [{ id: 'codex', label: 'Codex', count: 1 }],
            sessionsByProvider: {
                codex: [{ id: 'session-a', name: sessionName, provider: 'codex' }],
            },
        }),
        nextSequence: () => messages.length + 1,
        postMessage: message => {
            messages.push(message);
            return Promise.resolve(true);
        },
        refresh: () => undefined,
        logError: error => { throw new Error(`Unexpected logError: ${error}`); },
        logDiagnostic: event => diagnostics.push(event),
        debounceMs: 1,
        newSessionRefreshDelaysMs: [],
        setTimeout: callback => {
            callback();
            return { disposed: false };
        },
        clearTimeout: () => undefined,
    });

    await controller.refreshNow('watcher');
    await controller.refreshNow('watcher');
    assert.strictEqual(messages.length, 1, 'unchanged watcher messages should not be posted twice');
    assert.strictEqual(diagnostics.some(event => event.event === 'ai-session-message-skip' && event.reason === 'watcher'), true);

    sessionName = 'Codex Two';
    await controller.refreshNow('watcher');
    assert.strictEqual(messages.length, 2, 'changed watcher messages must still be posted');

    await controller.refreshNow('refresh');
    assert.strictEqual(messages.length, 3, 'explicit refresh messages must not be suppressed by watcher dedupe');
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

function extractExactScssBlock(source, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`(^|\\n)\\s*${escapedSelector}\\s*\\{`, 'm'));
    assert.ok(match, `Could not find exact SCSS selector ${selector}`);
    const selectorIndex = match.index + match[0].lastIndexOf(selector);
    return extractScssBlock(source.slice(selectorIndex), selector);
}

function extractExactCssBlock(source, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`(^|[,}])${escapedSelector}\\{`));
    assert.ok(match, `Could not find exact CSS selector ${selector}`);
    const selectorIndex = match.index + match[0].lastIndexOf(selector);
    return extractScssBlock(source.slice(selectorIndex), selector);
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

// SESSION-AI-SESSION-PROVIDER-MAX-FILES-001
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

// SESSION-PROVIDER-001
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

// PERSIST-PROVIDER-LIFECYCLE-SERVICE-001
function runProviderLifecycleServiceChecks() {
    const writeLargeLifecycleLog = (filePath, firstEvent, fillerEvent) => {
        const fillerLine = JSON.stringify(fillerEvent);
        const fillerCount = Math.ceil((600 * 1024) / Buffer.byteLength(fillerLine + '\n'));
        fs.writeFileSync(filePath, [
            JSON.stringify(firstEvent),
            ...Array.from({ length: fillerCount }, () => fillerLine),
            '',
        ].join('\n'));
    };
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
        writeLargeLifecycleLog(sessionFile, {
            timestamp: '2026-07-15T00:00:01.000Z',
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'long-codex' },
        }, {
            timestamp: '2026-07-15T00:00:02.000Z',
            type: 'event_msg',
            payload: { type: 'token_count' },
        });
        const codexService = new CodexSessionService();
        let signals = codexService.getLifecycleSignals([
            { sessionId: codexId, runStartedAtMs },
            { sessionId: 'missing', runStartedAtMs },
        ]);
        assert.strictEqual(signals[codexId].executionState, 'running');
        assert.strictEqual(signals.missing, undefined);
        fs.appendFileSync(sessionFile, JSON.stringify({
            timestamp: '2026-07-15T00:00:03.000Z',
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'long-codex' },
        }) + '\n');
        const originalReaddirSync = fs.readdirSync;
        fs.readdirSync = () => { throw new Error('cached lifecycle lookup must not rescan provider roots'); };
        try {
            signals = codexService.getLifecycleSignals([{ sessionId: codexId, runStartedAtMs }]);
        } finally {
            fs.readdirSync = originalReaddirSync;
        }
        assert.strictEqual(signals[codexId].executionState, 'stopped');
        assert.deepStrictEqual(codexService.getLifecycleSignals([{ sessionId: codexId, runStartedAtMs: Date.parse('2026-07-16T00:00:00Z') }]), {});
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
        writeLargeLifecycleLog(path.join(sessionDir, 'wire.jsonl'), {
            timestamp: runStartedAtMs / 1000 + 1,
            message: { type: 'TurnBegin', payload: {} },
        }, {
            timestamp: runStartedAtMs / 1000 + 2,
            message: { type: 'StatusUpdate', payload: {} },
        });
        const kimiService = new KimiSessionService();
        assert.strictEqual(
            kimiService.getLifecycleSignals([{ sessionId: kimiId, runStartedAtMs }])[kimiId].executionState,
            'running'
        );
        fs.appendFileSync(path.join(sessionDir, 'wire.jsonl'), JSON.stringify({
            timestamp: runStartedAtMs / 1000 + 3,
            message: { type: 'TurnEnd', payload: {} },
        }) + '\n');
        assert.strictEqual(
            kimiService.getLifecycleSignals([{ sessionId: kimiId, runStartedAtMs }])[kimiId].executionState,
            'stopped'
        );
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
        const claudeFile = path.join(sessionDir, `${claudeId}.jsonl`);
        writeLargeLifecycleLog(claudeFile, {
            timestamp: '2026-07-15T00:00:01.000Z',
            type: 'user',
            message: { role: 'user' },
        }, {
            timestamp: '2026-07-15T00:00:02.000Z',
            type: 'progress',
        });
        const claudeService = new ClaudeSessionService();
        assert.strictEqual(
            claudeService.getLifecycleSignals([{ sessionId: claudeId, runStartedAtMs }])[claudeId].executionState,
            'running'
        );
        fs.appendFileSync(claudeFile, JSON.stringify({
            timestamp: '2026-07-15T00:00:03.000Z',
            type: 'assistant',
            message: { role: 'assistant', stop_reason: 'end_turn', content: [] },
        }) + '\n');
        assert.strictEqual(
            claudeService.getLifecycleSignals([{ sessionId: claudeId, runStartedAtMs }])[claudeId].executionState,
            'stopped'
        );
    } finally {
        previousClaudeHome === undefined ? delete process.env.CLAUDE_HOME : process.env.CLAUDE_HOME = previousClaudeHome;
        fs.rmSync(claudeRoot, { recursive: true, force: true });
    }
}

// SESSION-COMMAND-BUILDER-001
function runCommandBuilderChecks() {
    assert.deepStrictEqual(
        commands.buildClaudeNewSessionLaunchSpec('/work/app', "Useful; 'Title'", '/tmp/claude.done'),
        {
            executable: 'claude',
            args: ['--name', "Useful; 'Title'"],
            cwd: '/work/app',
            markerPath: '/tmp/claude.done',
            windowsDirectShell: 'powershell',
        }
    );
    assert.strictEqual(
        launchSpec.serializeDirectLaunchCommand(
            commands.buildKimiNewSessionLaunchSpec('/work/app', "owner's task", null),
            'linux'
        ),
        "kimi --work-dir '/work/app' --prompt 'owner'\\''s task'"
    );
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
    let windowsPayload = decodePowerShellPayload(windowsCommand);
    assert.ok(windowsPayload.includes("Set-Location -LiteralPath 'C:\\Repo'"));
    assert.ok(windowsPayload.includes("Remove-Item -LiteralPath 'C:\\Temp\\session.done'"));
    assert.ok(windowsPayload.includes("New-Item -ItemType File -Force -Path 'C:\\Temp\\session.done'"));
    let windowsNewCommand = commands.buildCodexNewSessionCommand('C:\\Repo', null, 'C:\\Temp\\new-codex.done', 'win32');
    let windowsNewPayload = decodePowerShellPayload(windowsNewCommand);
    assert.ok(windowsNewPayload.includes("codex --cd 'C:\\Repo'"));
    assert.ok(windowsNewPayload.includes("New-Item -ItemType File -Force -Path 'C:\\Temp\\new-codex.done'"));
    assert.strictEqual(commands.quotePowerShellArg("O'Brien"), "'O''Brien'");
}

// PERSIST-LIFECYCLE-PARSER-001
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
    assert.strictEqual(codexSignal.executionState, 'stopped');
    assert.ok(codexSignal.token.includes('task_complete'));
    assert.strictEqual(lifecycle.parseCodexLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:08.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'newer' } }),
        JSON.stringify({ timestamp: '2026-07-15T00:00:07.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'older' } }),
    ], runStartedAtMs).executionState, 'stopped', 'event time wins over physical line order');
    assert.strictEqual(lifecycle.parseCodexLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:09.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } }),
    ], runStartedAtMs).executionState, 'running');
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

    const codexAccumulator = lifecycle.createCodexLifecycleAccumulator(runStartedAtMs);
    codexAccumulator.addLines([
        JSON.stringify({
            timestamp: '2026-07-15T00:00:10.000Z',
            type: 'response_item',
            payload: { type: 'custom_tool_call', name: 'request_user_input', call_id: 'cross-batch' },
        }),
    ]);
    assert.strictEqual(codexAccumulator.getSignal().reason, 'input-required');
    codexAccumulator.addLines([
        JSON.stringify({
            timestamp: '2026-07-15T00:00:11.000Z',
            type: 'response_item',
            payload: { type: 'custom_tool_call_output', call_id: 'cross-batch' },
        }),
    ]);
    assert.strictEqual(codexAccumulator.getSignal().executionState, 'running');

    const staleCodexAccumulator = lifecycle.createCodexLifecycleAccumulator(runStartedAtMs);
    staleCodexAccumulator.addLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:20.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'completed' } }),
        JSON.stringify({ timestamp: '2026-07-15T00:00:19.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'request_user_input', call_id: 'stale-input' } }),
        JSON.stringify({ timestamp: '2026-07-15T00:00:21.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'stale-input' } }),
    ]);
    assert.strictEqual(staleCodexAccumulator.getSignal().executionState, 'stopped', 'stale events cannot mutate provider state');

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
        JSON.stringify({ timestamp: 1784073604, message: { type: 'TurnEnd', payload: {} } }),
    ], runStartedAtMs).executionState, 'stopped');
    assert.strictEqual(lifecycle.parseKimiLifecycleLines([
        JSON.stringify({ timestamp: 1784073605, message: { type: 'TurnBegin', payload: {} } }),
    ], runStartedAtMs).executionState, 'running');
    assert.strictEqual(lifecycle.parseKimiLifecycleLines([
        JSON.stringify({ timestamp: 1784073605, message: { type: 'ApprovalRequest', payload: { id: 'approval-1' } } }),
    ], runStartedAtMs).reason, 'input-required');
    assert.strictEqual(lifecycle.parseKimiLifecycleLines([
        JSON.stringify({ timestamp: 1784073606, message: { type: 'QuestionRequest', payload: { id: 'question-2' } } }),
        JSON.stringify({ timestamp: 1784073607, message: { type: 'StatusUpdate', payload: { message_id: 'status-2' } } }),
    ], runStartedAtMs).reason, 'input-required', 'Kimi status updates do not answer a pending question');

    const kimiAccumulator = lifecycle.createKimiLifecycleAccumulator(runStartedAtMs);
    kimiAccumulator.addLines([
        JSON.stringify({ timestamp: 1784073612, message: { type: 'TurnEnd', payload: {} } }),
    ]);
    kimiAccumulator.addLines([
        JSON.stringify({ timestamp: 1784073611, message: { type: 'TurnBegin', payload: {} } }),
    ]);
    assert.strictEqual(kimiAccumulator.getSignal().executionState, 'stopped');

    const claudeSignal = lifecycle.parseClaudeLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:01.000Z', type: 'user', message: { role: 'user' } }),
        JSON.stringify({ timestamp: '2026-07-15T00:00:02.000Z', type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [] } }),
    ], runStartedAtMs);
    assert.strictEqual(claudeSignal.reason, 'completed');
    assert.strictEqual(claudeSignal.executionState, 'stopped');
    assert.strictEqual(lifecycle.parseClaudeLifecycleLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:02.000Z', type: 'user', message: { role: 'user' } }),
    ], runStartedAtMs).executionState, 'running');
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

    const claudeAccumulator = lifecycle.createClaudeLifecycleAccumulator(runStartedAtMs);
    claudeAccumulator.addLines([
        JSON.stringify({ timestamp: '2026-07-15T00:00:12.000Z', type: 'user', message: { role: 'user' } }),
    ]);
    assert.strictEqual(claudeAccumulator.getSignal().executionState, 'running');

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

// ATTENTION-ATTENTION-MONITOR-001
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

    const retentionMonitor = new AiSessionAttentionMonitor({ now: () => now });
    const retentionEvents = retentionMonitor.evaluate([{
        key: 'codex:retained',
        signal: signal('retained-complete', 'needsAttention', 'completed'),
    }]);
    assert.deepStrictEqual(retentionMonitor.evaluate([]), [],
        'runtime removal does not generate a second attention event');
    assert.strictEqual(
        retentionMonitor.getSnapshot()['codex:retained'].state,
        'needsAttention',
        'runtime removal must retain unread completion attention'
    );
    retentionMonitor.acknowledge([retentionEvents[0].eventId]);
    assert.strictEqual(retentionMonitor.getSnapshot()['codex:retained'].state, 'acknowledged');
    retentionMonitor.evaluate([]);
    assert.strictEqual(
        retentionMonitor.getSnapshot()['codex:retained'],
        undefined,
        'an explicitly acknowledged entry may be pruned after runtime removal'
    );

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

// ATTENTION-ATTENTION-PAYLOAD-001
function runAttentionPayloadChecks() {
    const payload = attentionPayload.createAttentionPayload([{ projectId: 'a'.repeat(64), sessionKey: 'k', state: 'needsAttention', eventId: 'e', reason: 'input-required', observedAtMs: 10 }], 20);
    assert.deepStrictEqual(attentionPayload.parseAttentionPayload(attentionPayload.serializeAttentionPayload(payload)), payload);
    assert.throws(() => attentionPayload.parseAttentionPayload('{"version":1,"generatedAtMs":1,"items":[{"projectId":"p","sessionKey":"k","state":"bad","observedAtMs":1}]}'));
    const owner = attentionPayload.validateAttentionOwnerSnapshot({ ...payload, instanceId: 'a'.repeat(32), sequence: 1, heartbeat: 1 });
    const aggregate = attentionAggregate.aggregateAttentionSnapshots([owner], new Set(['e']), 21);
    assert.deepStrictEqual(aggregate.sessions, []);
    assert.strictEqual(aggregate.aggregateRevision.length, 64);

    const republishedOwner = attentionPayload.validateAttentionOwnerSnapshot({
        ...owner,
        sequence: 2,
        heartbeat: 2,
    });
    const acknowledgedRepublish = attentionAggregate.aggregateAttentionSnapshots(
        [republishedOwner],
        new Set(['e']),
        22
    );
    assert.deepStrictEqual(acknowledgedRepublish.sessions, [],
        'a project-card acknowledgement must suppress retained owner republication');

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

// ATTENTION-PRODUCTION-ATTENTION-STORE-CLOCK-001
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

// ATTENTION-PRODUCTION-ATTENTION-STORE-LIFECYCLE-001
async function runProductionAttentionStoreLifecycleChecks() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-production-store-lifecycle-'));
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    let resolveFirstEntered;
    const firstEnteredPromise = new Promise(resolve => { resolveFirstEntered = resolve; });
    let firstEntered = false;
    const store = new ProductionAttentionStore(root, 'f'.repeat(32), {
        beforeCommit: async snapshot => {
            if (snapshot.sequence === 1) {
                firstEntered = true;
                resolveFirstEntered();
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
        let firstEnteredTimeout;
        try {
            await Promise.race([
                firstEnteredPromise,
                new Promise(resolve => { firstEnteredTimeout = setTimeout(resolve, 1000); }),
            ]);
        } finally {
            clearTimeout(firstEnteredTimeout);
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

// ATTENTION-PRODUCTION-ATTENTION-STORE-UNREGISTER-PROPAGATION-001
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

// ATTENTION-PRODUCTION-ATTENTION-STORE-TOMBSTONE-REACTIVATION-RACE-001
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

// ATTENTION-ATTENTION-BRIDGE-CLIENT-PRIVACY-001
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

// ATTENTION-ATTENTION-BRIDGE-CLIENT-LIFECYCLE-001
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

// ATTENTION-ATTENTION-PROJECT-001
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

async function main() {
    runPathChecks();
    runDashboardSearchCatalogChecks();
    runDashboardDiagnosticsChecks();
    runAttentionProjectionChecks();
    runFavoriteProjectOrderChecks();
    runWorkspaceHelperChecks();
    runTerminalCandidateChecks();
    runPinStoreChecks();
    runAliasStoreChecks();
    await runProjectStateStoreChecks();
    runActiveAiSessionProjectionChecks();
    await runAiSessionAttentionControllerChecks();
    await runSidebarStewardViewProviderOrderingChecks();
    runActiveAiSessionTerminalHighlightChecks();
    await runAiSessionTerminalBindingStoreChecks();
    runWebviewContentChecks();
    runCurrentWorkspaceRenderingChecks();
    runFavoriteRenderingChecks();
    runFavoriteDndChecks();
    runBatchAiSessionWebviewChecks();
    runAiSessionDashboardControllerChecks();
    runAiSessionDashboardWatcherCoalescingChecks();
    await runAiSessionDashboardUnchangedMessageSkipChecks();
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
    await runAttentionBridgeClientLifecycleChecks();
    runAttentionProjectChecks();

    console.log('AI session safety checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
