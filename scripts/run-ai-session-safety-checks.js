'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const vm = require('vm');
const commands = require('../out/aiSessions/commandBuilders');
const launchSpec = require('../out/aiSessions/launchSpec');
const helpers = require('../out/aiSessions/sessionHelpers');
const archiveBatch = require('../out/aiSessions/archiveBatch');
const activeTerminalHighlight = require('../out/aiSessions/activeTerminalHighlight');
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
const workspaceAttentionProjection = require('../out/workspaces/attentionProjection');
const AiSessionReadCoordinator = require('../out/aiSessions/readCoordinator').AiSessionReadCoordinator;
const AiSessionAliasStore = require('../out/aiSessions/aliasStore').default;
const AiSessionAliasController = require('../out/aiSessions/aliasController').default;
const AiSessionWorkspaceStateStore = require('../out/aiSessions/workspaceStateStore').default;
const ProductionAttentionStore = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/productionAttentionStore').ProductionAttentionStore;
const AiSessionPinStore = require('../out/aiSessions/pinStore').default;
const AiSessionPinController = require('../out/aiSessions/pinController').default;
const providers = require('../out/aiSessions/providers');
const providerAvailability = require('../out/aiSessions/providerAvailability');
const workspaceSessionScope = require('../out/workspaces/sessionScope');
const workspaceSessionAssignment = require('../out/workspaces/sessionAssignment');
const workspaceSessionHydration = require('../out/workspaces/sessionHydration');
const WorkspaceSessionHydrationController = require('../out/workspaces/sessionHydrationController')
    .WorkspaceSessionHydrationController;
const WorkspacePendingSessionPromotionController = require('../out/workspaces/pendingSessionPromotionController')
    .WorkspacePendingSessionPromotionController;
const workspacePrimaryRootStore = require('../out/workspaces/primaryRootStore');
const WorkspacePrimaryRootStore = workspacePrimaryRootStore.WorkspacePrimaryRootStore;
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
const DirectTerminalRuntimeBackend = require('../out/aiSessions/directTerminalRuntimeBackend')
    .DirectTerminalRuntimeBackend;
const models = require('../out/models');
const openProjectService = require('../out/projects/openProjectService');
const webviewContentModule = require('../out/webview/webviewContent');
const dashboardViewModel = require('../out/webview/dashboardViewModel');
const AiSessionDashboardController = require('../out/aiSessions/dashboardController').AiSessionDashboardController;
const aiSessionCommandControllerModule = require('../out/aiSessions/commandController');
const AiSessionCommandController = aiSessionCommandControllerModule.AiSessionCommandController;
const AiSessionCreationController = require('../out/aiSessions/creationController').AiSessionCreationController;
const AiSessionResumeController = require('../out/aiSessions/resumeController').AiSessionResumeController;
const AiSessionAttentionController = require('../out/aiSessions/attentionController').AiSessionAttentionController;
const AiSessionExecutionController = require('../out/aiSessions/executionController').AiSessionExecutionController;
const TmuxFocusedRuntimeMonitor = require('../out/aiSessions/tmuxFocusedRuntimeMonitor')
    .TmuxFocusedRuntimeMonitor;
const settleAiSessionRuntimeLifecycles = require('../out/aiSessions/attentionController').settleAiSessionRuntimeLifecycles;
const runAiSessionRuntimeLifecycleTask = require('../out/aiSessions/attentionController').runAiSessionRuntimeLifecycleTask;
const AiSessionArchiveController = require('../out/aiSessions/archiveController').AiSessionArchiveController;
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

function createTestAiSessionDirectoryScope(primaryCwd, additionalDirectories = []) {
    return Object.freeze({
        workspaceNavigationIdentity: `navigation:${primaryCwd}`,
        workspaceScopeIdentity: `scope:${primaryCwd}`,
        workspaceRootHostPaths: Object.freeze([primaryCwd, ...additionalDirectories]),
        primaryRootId: `root:${primaryCwd}`,
        primaryCwd,
        additionalDirectories: Object.freeze([...additionalDirectories]),
    });
}

function createTestAiSessionRuntimeIdentity(provider, cwd, id, overrides = {}) {
    return {
        provider,
        workspaceScopeIdentity: `scope:${cwd}`,
        workspaceNavigationIdentity: `navigation:${cwd}`,
        workspaceRootHostPaths: [cwd],
        cwd,
        ...id,
        ...overrides,
    };
}

function createTestAiSessionTerminalBindingIdentity(providerId, cwd, id, overrides = {}) {
    const { provider: _provider, ...identity } = createTestAiSessionRuntimeIdentity(
        providerId, cwd, id, overrides
    );
    return { providerId, ...identity };
}

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

function runWorkspaceSessionScopeChecks() {
    const workspace = {
        navigationIdentity: 'workspace-navigation',
        scopeIdentity: 'workspace-scope',
        kind: 'savedMultiRoot',
        displayName: 'Platform',
        navigationUri: 'file:///work/platform.code-workspace',
        environment: 'local',
        roots: [
            { id: 'root-api', name: 'API', uri: 'file:///work/api', hostPath: '/work/api', ordinal: 0 },
            { id: 'root-web', name: 'Web', uri: 'file:///work/web', hostPath: '/work/web', ordinal: 1 },
        ],
    };

    assert.strictEqual(workspaceSessionScope.selectPrimaryWorkspaceRoot(workspace, {
        explicitRootId: 'root-web',
        activeEditorUri: { fsPath: '/work/api/src/index.ts' },
        lastUsedRootId: 'root-api',
    }).id, 'root-web');
    assert.strictEqual(workspaceSessionScope.selectPrimaryWorkspaceRoot(workspace, {
        activeEditorUri: { fsPath: '/work/web/src/index.ts' },
        lastUsedRootId: 'root-api',
    }).id, 'root-web');
    assert.strictEqual(workspaceSessionScope.selectPrimaryWorkspaceRoot(workspace, {
        activeEditorUri: { fsPath: '/elsewhere/index.ts' },
        lastUsedRootId: 'root-web',
    }).id, 'root-web');
    assert.strictEqual(workspaceSessionScope.selectPrimaryWorkspaceRoot({
        ...workspace,
        roots: [workspace.roots[1], workspace.roots[0]],
    }, {
        explicitRootId: 'removed-root',
        lastUsedRootId: 'removed-root',
    }).id, 'root-api');

    const scope = workspaceSessionScope.buildAiSessionDirectoryScope(workspace, {
        explicitRootId: 'root-web',
        isDirectory: value => value !== '/work/missing',
    });
    assert.deepStrictEqual(scope, {
        workspaceNavigationIdentity: workspace.navigationIdentity,
        workspaceScopeIdentity: workspace.scopeIdentity,
        workspaceRootHostPaths: ['/work/api', '/work/web'],
        primaryRootId: 'root-web',
        primaryCwd: '/work/web',
        additionalDirectories: ['/work/api'],
    });
    assert.notStrictEqual(scope.workspaceRootHostPaths, workspace.roots);
    assert.strictEqual(Object.isFrozen(scope), true);
    assert.strictEqual(Object.isFrozen(scope.workspaceRootHostPaths), true);
    assert.strictEqual(Object.isFrozen(scope.additionalDirectories), true);

    const whitespaceWorkspace = {
        ...workspace,
        roots: [
            {
                id: 'root-trailing-space', name: 'Trailing space', uri: 'file:///work/repo%20',
                hostPath: '/work/repo ', ordinal: 0,
            },
            {
                id: 'root-inner-space', name: 'Inner space', uri: 'file:///work/%20api',
                hostPath: '/work/ api', ordinal: 1,
            },
        ],
    };
    const directoryProbes = [];
    const whitespaceScope = workspaceSessionScope.buildAiSessionDirectoryScope(whitespaceWorkspace, {
        explicitRootId: 'root-trailing-space',
        isDirectory: value => {
            directoryProbes.push(value);
            return value === '/work/repo ' || value === '/work/ api';
        },
    });
    assert.deepStrictEqual(directoryProbes, ['/work/repo ', '/work/ api']);
    assert.deepStrictEqual(whitespaceScope.workspaceRootHostPaths, ['/work/repo ', '/work/ api']);
    assert.strictEqual(whitespaceScope.primaryCwd, '/work/repo ');
    assert.deepStrictEqual(whitespaceScope.additionalDirectories, ['/work/ api']);
    let blankDirectoryProbeCount = 0;
    assert.throws(
        () => workspaceSessionScope.buildAiSessionDirectoryScope({
            ...workspace,
            roots: [{
                id: 'root-blank', name: 'Blank', uri: 'file:///blank', hostPath: ' \t ', ordinal: 0,
            }],
        }, {
            isDirectory: () => {
                blankDirectoryProbeCount += 1;
                return true;
            },
        }),
        error => error instanceof workspaceSessionScope.WorkspaceDirectoryScopeError,
    );
    assert.strictEqual(blankDirectoryProbeCount, 0, 'blank host paths must fail before filesystem probing');

    const nestedWorkspace = {
        ...workspace,
        roots: [
            { id: 'root-platform', name: 'Platform', uri: 'file:///work', hostPath: '/work', ordinal: 0 },
            { id: 'root-api', name: 'API', uri: 'file:///work/api', hostPath: '/work/api', ordinal: 1 },
            { id: 'root-web', name: 'Web', uri: 'file:///work/web', hostPath: '/work/web', ordinal: 2 },
        ],
    };
    const nestedHistoricalScope = workspaceSessionScope.buildAiSessionDirectoryScope(nestedWorkspace, {
        explicitRootId: 'root-api',
        primaryCwd: '/work/api/packages/service/../service',
        isDirectory: () => true,
    });
    assert.deepStrictEqual(nestedHistoricalScope, {
        workspaceNavigationIdentity: workspace.navigationIdentity,
        workspaceScopeIdentity: workspace.scopeIdentity,
        workspaceRootHostPaths: ['/work', '/work/api', '/work/web'],
        primaryRootId: 'root-api',
        primaryCwd: '/work/api/packages/service',
        additionalDirectories: ['/work', '/work/web'],
    }, 'a nested historical cwd must stay exact while add-dir excludes its owning root');

    const duplicatePathScope = workspaceSessionScope.buildAiSessionDirectoryScope({
        ...workspace,
        roots: workspace.roots.concat({
            id: 'root-api-alias', name: 'API alias', uri: 'file:///work/api/', hostPath: '/work/api/', ordinal: 2,
        }),
    }, {
        explicitRootId: 'root-api-alias',
        isDirectory: () => true,
    });
    assert.deepStrictEqual(duplicatePathScope.workspaceRootHostPaths, ['/work/api', '/work/web']);
    assert.strictEqual(duplicatePathScope.primaryRootId, 'root-api-alias');
    assert.strictEqual(duplicatePathScope.primaryCwd, '/work/api');
    assert.deepStrictEqual(duplicatePathScope.additionalDirectories, ['/work/web']);

    const uncDuplicatePathScope = workspaceSessionScope.buildAiSessionDirectoryScope({
        ...workspace,
        roots: [
            {
                id: 'root-unc-original', name: 'UNC original', uri: 'file://server/Share/App',
                hostPath: '\\\\Server\\Share\\App', ordinal: 0,
            },
            {
                id: 'root-unc-alias', name: 'UNC alias', uri: 'file://server/share/app',
                hostPath: '\\\\server\\share\\app\\', ordinal: 1,
            },
        ],
    }, {
        explicitRootId: 'root-unc-alias',
        isDirectory: () => true,
    });
    assert.deepStrictEqual(uncDuplicatePathScope.workspaceRootHostPaths, ['\\\\Server\\Share\\App']);
    assert.strictEqual(uncDuplicatePathScope.primaryRootId, 'root-unc-alias');
    assert.strictEqual(uncDuplicatePathScope.primaryCwd, '\\\\server\\share\\app');
    assert.deepStrictEqual(uncDuplicatePathScope.additionalDirectories, []);

    const invalidWorkspace = {
        ...workspace,
        roots: workspace.roots.concat({
            id: 'root-missing', name: 'Missing root', uri: 'file:///work/missing', hostPath: '/work/missing', ordinal: 2,
        }),
    };
    assert.throws(
        () => workspaceSessionScope.buildAiSessionDirectoryScope(invalidWorkspace, {
            isDirectory: value => value !== '/work/missing',
        }),
        error => {
            assert.ok(error instanceof workspaceSessionScope.WorkspaceDirectoryScopeError);
            assert.deepStrictEqual(error.invalidRoots, [{ id: 'root-missing', name: 'Missing root' }]);
            assert.ok(error.message.includes('root-missing'));
            assert.ok(error.message.includes('Missing root'));
            assert.strictEqual(error.message.includes('codex'), false);
            assert.strictEqual(error.message.includes('--add-dir'), false);
            return true;
        }
    );

    const unreadableWorkspace = {
        ...workspace,
        roots: workspace.roots.concat({
            id: 'root-unreadable', name: 'Unreadable root', uri: 'file:///work/unreadable',
            hostPath: '/work/unreadable', ordinal: 2,
        }),
    };
    let unreadableScope;
    assert.throws(
        () => {
            unreadableScope = workspaceSessionScope.buildAiSessionDirectoryScope(unreadableWorkspace, {
                isDirectory: value => {
                    if (value === '/work/unreadable') {
                        throw new Error('EACCES while preparing codex --add-dir /work/unreadable');
                    }
                    return true;
                },
            });
        },
        error => {
            assert.ok(error instanceof workspaceSessionScope.WorkspaceDirectoryScopeError);
            assert.deepStrictEqual(error.invalidRoots, [{ id: 'root-unreadable', name: 'Unreadable root' }]);
            assert.ok(error.message.includes('root-unreadable'));
            assert.ok(error.message.includes('Unreadable root'));
            assert.strictEqual(error.message.includes('codex'), false);
            assert.strictEqual(error.message.includes('--add-dir'), false);
            assert.strictEqual(error.message.includes('/work/unreadable'), false);
            return true;
        }
    );
    assert.strictEqual(unreadableScope, undefined, 'unreadable roots must not return a partial scope');

    const values = new Map();
    const updates = [];
    const store = new WorkspacePrimaryRootStore({
        get: key => values.get(key),
        update: async (key, value) => {
            updates.push([key, value]);
            values.set(key, value);
        },
    });
    assert.strictEqual(store.getPrimaryRootId(workspace.scopeIdentity, workspace.roots), null);
    return store.setPrimaryRootId(workspace.scopeIdentity, 'root-web').then(() => {
        assert.strictEqual(store.getPrimaryRootId(workspace.scopeIdentity, workspace.roots), 'root-web');
        assert.strictEqual(store.getPrimaryRootId(workspace.scopeIdentity, [workspace.roots[0]]), null);
        assert.strictEqual(store.getPrimaryRootId('different-scope', workspace.roots), null);
        assert.deepStrictEqual(updates, [[
            workspacePrimaryRootStore.WORKSPACE_PRIMARY_ROOTS_STATE_KEY,
            { [workspace.scopeIdentity]: 'root-web' },
        ]]);
    });
}

function runWorkspaceSessionAssignmentChecks() {
    const roots = [
        { id: 'root-api', name: 'API', uri: 'file:///work/api', hostPath: '/work/api', ordinal: 0 },
        { id: 'root-core', name: 'Core', uri: 'file:///work/api/packages/core', hostPath: '/work/api/packages/core', ordinal: 1 },
    ];

    assert.strictEqual(
        workspaceSessionAssignment.assignPathToWorkspaceRoot('/work/api/packages/core/src/index.ts', roots).id,
        'root-core'
    );
    assert.strictEqual(workspaceSessionAssignment.assignPathToWorkspaceRoot('/work/api-old', roots), null);
    assert.strictEqual(workspaceSessionAssignment.assignPathToWorkspaceRoot('', roots), null);
    assert.strictEqual(workspaceSessionAssignment.assignPathToWorkspaceRoot('/work/api', roots).id, 'root-api');
    assert.strictEqual(workspaceSessionAssignment.normalizeWorkspaceHostPath('/work/repo '), '/work/repo ');
    assert.strictEqual(workspaceSessionAssignment.normalizeWorkspaceHostPath(' /work/repo'), ' /work/repo');
    assert.strictEqual(workspaceSessionAssignment.normalizeWorkspaceHostPath(' \t '), '');

    const whitespaceRoots = [
        {
            id: 'root-trailing-space', name: 'Trailing space', uri: 'file:///work/repo%20',
            hostPath: '/work/repo ', ordinal: 0,
        },
        {
            id: 'root-leading-space', name: 'Leading space', uri: 'file:///leading-space',
            hostPath: ' /work/repo', ordinal: 1,
        },
    ];
    assert.strictEqual(
        workspaceSessionAssignment.assignPathToWorkspaceRoot('/work/repo /src/index.ts', whitespaceRoots).id,
        'root-trailing-space',
    );
    assert.strictEqual(
        workspaceSessionAssignment.assignPathToWorkspaceRoot(' /work/repo/src/index.ts', whitespaceRoots).id,
        'root-leading-space',
    );
    assert.strictEqual(
        workspaceSessionAssignment.assignPathToWorkspaceRoot('/work/repo/src/index.ts', whitespaceRoots),
        null,
    );

    const windowsRoots = [
        { id: 'root-windows', name: 'Windows', uri: 'file:///C:/Work/App', hostPath: 'C:\\Work\\App', ordinal: 0 },
    ];
    assert.strictEqual(
        workspaceSessionAssignment.assignPathToWorkspaceRoot('c:\\work\\APP\\src\\index.ts', windowsRoots).id,
        'root-windows'
    );
    assert.strictEqual(
        workspaceSessionAssignment.assignPathToWorkspaceRoot('C:\\Work\\Application', windowsRoots),
        null
    );

    const duplicateRoots = [
        { id: 'root-later', name: 'Later', uri: 'file:///work/api', hostPath: '/work/api', ordinal: 2 },
        { id: 'root-first', name: 'First', uri: 'file:///work/api/', hostPath: '/work/api/', ordinal: 0 },
    ];
    assert.strictEqual(
        workspaceSessionAssignment.assignPathToWorkspaceRoot('/work/api/src', duplicateRoots).id,
        'root-first'
    );
}

function runWorkspaceSessionHydrationChecks() {
    const workspace = {
        navigationIdentity: 'workspace-navigation',
        scopeIdentity: 'workspace-scope',
        kind: 'savedMultiRoot',
        displayName: 'Platform',
        navigationUri: 'file:///work/platform.code-workspace',
        environment: 'local',
        roots: [
            { id: 'root-app', name: 'App', uri: 'file:///work/app', hostPath: '/work/app/', ordinal: 0 },
            { id: 'root-api', name: 'API', uri: 'file:///work/app/api', hostPath: '/work/app/api', ordinal: 1 },
            { id: 'root-web', name: 'Web', uri: 'file:///work/web', hostPath: '/work/./web', ordinal: 2 },
            { id: 'root-web-duplicate', name: 'Web duplicate', uri: 'file:///work/web/', hostPath: '/work/web/', ordinal: 3 },
        ],
    };
    const reads = { codex: [], kimi: [], claude: [] };
    const resultFor = (provider, sessions, available = true) => ({
        id: provider,
        label: provider[0].toUpperCase() + provider.slice(1),
        terminalCwdFields: provider === 'kimi' ? ['workDir'] : ['cwd'],
        service: {
            getSessions: options => {
                reads[provider].push(options);
                return { available, sessions, scannedFiles: sessions.length, parsedFiles: sessions.length };
            },
        },
    });
    const providersForHydration = [
        resultFor('codex', [
            { id: 'api-history', name: 'API history', cwd: '/work/app/api/service', updatedAt: '2026-07-20T12:00:00Z' },
            { id: 'api-history', name: 'Duplicate API history', cwd: '/work/app/api/duplicate', updatedAt: '2026-07-20T13:00:00Z' },
            { id: 'web-history', name: 'Web history', cwd: '/work/web/client', updatedAt: '2026-07-20T11:00:00Z' },
            { id: 'outside-history', name: 'Inactive outside history', cwd: '/work/removed' },
        ]),
        resultFor('kimi', [], false),
        resultFor('claude', [{ id: 'app-history', name: 'App history', cwd: '/work/app/client' }]),
    ];
    const readCoordinator = new AiSessionReadCoordinator(providersForHydration, () => undefined);
    const runtime = (provider, backend, cwd, id, overrides = {}) => ({
        identity: createTestAiSessionRuntimeIdentity(provider, cwd, id, {
            workspaceScopeIdentity: workspace.scopeIdentity,
            workspaceNavigationIdentity: workspace.navigationIdentity,
            workspaceRootHostPaths: workspace.roots.map(root => root.hostPath),
            ...overrides,
        }),
        backend,
        state: id.pendingId ? 'pending' : 'active',
        markerPath: `/markers/${id.sessionId || id.pendingId}`,
        runStartedAtMs: id.pendingId ? 20 : 30,
        attached: backend === 'vscode',
        ...(backend === 'tmux' ? { tmux: { layout: 'project', sessionName: `tmux-${id.sessionId || id.pendingId}` } } : {}),
        ...(id.pendingId ? {
            createdAt: id.pendingId === 'pending-direct'
                ? '2026-07-20T10:00:00Z' : '2026-07-20T10:01:00Z',
            excludedSessionIds: [],
            title: id.pendingId === 'pending-direct' ? 'Direct pending' : 'Tmux pending',
        } : {}),
    });
    const outsideNavigationRuntime = runtime('codex', 'vscode', '/work/removed', { sessionId: 'removed-active' }, {
        workspaceScopeIdentity: 'removed-scope',
        workspaceRootHostPaths: ['/work/removed'],
    });
    const outsideOverlapRuntime = runtime('claude', 'tmux', '/work/previous', { sessionId: 'overlap-active' }, {
        workspaceScopeIdentity: 'previous-scope',
        workspaceNavigationIdentity: 'previous-navigation',
        workspaceRootHostPaths: ['/work/app', '/work/previous'],
    });
    const unmanagedRuntime = runtime('codex', 'tmux', '/unrelated', { sessionId: 'unmanaged-active' }, {
        workspaceScopeIdentity: 'unrelated-scope',
        workspaceNavigationIdentity: 'unrelated-navigation',
        workspaceRootHostPaths: ['/unrelated'],
    });
    const activeRuntimes = [
        outsideNavigationRuntime,
        outsideOverlapRuntime,
        unmanagedRuntime,
        runtime('codex', 'tmux', '/work/web', { sessionId: 'web-history' }),
    ];
    const pendingRuntimes = [
        runtime('codex', 'vscode', '/work/app', { pendingId: 'pending-direct' }),
        runtime('claude', 'tmux', '/work/app/api', { pendingId: 'pending-tmux' }),
        runtime('codex', 'vscode', '/work/removed-pending', { pendingId: 'pending-outside' }),
    ];
    const workspaceAttention = {
        protocolVersion: 1,
        aggregateRevision: 'a'.repeat(64),
        generatedAtMs: 200,
        sessions: [{
            projectId: attentionProject.getAttentionProjectKeys(['file:///work/app/api'])[0],
            sessionKey: 'codex:api-history',
            eventIds: ['event-api'], reasons: ['completed'], observedAtMs: 100,
        }, {
            projectId: attentionProject.getAttentionProjectKeys(['file:///work/web'])[0],
            sessionKey: 'codex:web-history:30:tmux',
            eventIds: ['event-web-old'], reasons: ['completed'], observedAtMs: 110,
        }, {
            projectId: attentionProject.getAttentionProjectKeys(['file:///work/web'])[0],
            sessionKey: 'codex:web-history:40:tmux',
            eventIds: ['event-web-new'], reasons: ['input-required'], observedAtMs: 120,
        }, {
            projectId: attentionProject.getAttentionProjectKeys(['file:///work/app'])[0],
            sessionKey: 'codex:web-history',
            eventIds: ['event-wrong-root'], reasons: ['failed'], observedAtMs: 130,
        }],
    };
    const readNotifications = [];
    const controller = new WorkspaceSessionHydrationController({
        providers: providersForHydration,
        readCoordinator,
        incrementalScanMaxFiles: 100,
        getRefreshReason: () => 'workspace-test',
        getSessionComparableCwd: (providerId, session) => providerId === 'kimi' ? session.workDir : session.cwd,
        getPinnedSessions: () => new Set(),
        getAliases: () => ({}),
        getActiveProvider: () => 'codex',
        getExpanded: () => true,
        getActiveRuntimes: () => activeRuntimes,
        getPendingRuntimes: () => pendingRuntimes,
        getExecutionSnapshot: () => ({}),
        getFocusedIdentity: () => outsideNavigationRuntime.identity,
        getAttentionAggregate: () => workspaceAttention,
        onDidReadSessions: (notifiedWorkspace, sessionResults, reason) => {
            readNotifications.push({ notifiedWorkspace, sessionResults, reason });
        },
    });

    const result = controller.hydrate(workspace);

    assert.strictEqual(readNotifications.length, 1);
    assert.strictEqual(readNotifications[0].notifiedWorkspace, workspace);
    assert.strictEqual(readNotifications[0].reason, 'workspace-test');
    assert.strictEqual(readNotifications[0].sessionResults.codex.sessions[0].id, 'api-history');
    assert.strictEqual(result.workspaceScopeIdentity, workspace.scopeIdentity);
    assert.strictEqual(result.workspaceNavigationIdentity, workspace.navigationIdentity);
    assert.deepStrictEqual(result.sessionsByProvider.codex.map(value => [value.id, value.primaryRootId]), [
        ['api-history', 'root-api'],
        ['web-history', 'root-web'],
    ]);
    assert.strictEqual(result.sessionsByProvider.codex[0].name, 'API history');
    assert.deepStrictEqual(result.sessionsByProvider.codex[0].attention, {
        eventId: 'event-api', reason: 'completed', unread: true,
    });
    assert.deepStrictEqual(result.sessionsByProvider.codex[1].attention, {
        eventId: 'event-web-new', reason: 'input-required', unread: true,
    });
    assert.deepStrictEqual(result.sessionsByProvider.claude.map(value => [value.id, value.primaryRootId]), [
        ['app-history', 'root-app'],
    ]);
    assert.deepStrictEqual(result.unavailableProviders, ['kimi']);
    assert.strictEqual(result.providers.find(provider => provider.id === 'kimi').unavailable, true);
    const removedActive = result.activeSessions.find(session => session.sessionId === 'removed-active');
    assert.strictEqual(removedActive.primaryRootLabel, 'Outside workspace');
    assert.strictEqual(removedActive.outsideWorkspace, true);
    assert.ok(result.activeSessions.some(session => session.sessionId === 'overlap-active'
        && session.outsideWorkspace === true));
    assert.ok(!result.activeSessions.some(session => session.sessionId === 'unmanaged-active'));
    assert.ok(result.activeSessions.some(session => session.sessionId === 'web-history'
        && session.backend === 'tmux' && session.primaryRootId === 'root-web'));
    const activeWeb = result.activeSessions.find(session => session.sessionId === 'web-history');
    assert.strictEqual(activeWeb.needsAttention, true);
    assert.strictEqual(activeWeb.status, 'needsAttention');
    assert.strictEqual(activeWeb.attentionEventId, 'event-web-new');
    assert.strictEqual(result.attentionCount, 2);
    assert.strictEqual(result.activeAttentionCount, 1);
    assert.ok(result.activeSessions.some(session => session.pending && session.backend === 'vscode'
        && session.primaryRootId === 'root-app'));
    assert.ok(result.activeSessions.some(session => session.pending && session.backend === 'tmux'
        && session.primaryRootId === 'root-api'));
    assert.ok(!result.activeSessions.some(session => session.key === 'pending:codex:pending-outside'));
    assert.strictEqual(result.cardCount, undefined, 'hydration must not create per-root cards');
    for (const provider of providersForHydration) {
        assert.strictEqual(reads[provider.id].length, 1, `${provider.id} must be read once`);
        assert.deepStrictEqual(
            reads[provider.id][0].candidatePaths,
            ['/work/app', '/work/app/api', '/work/web'],
            `${provider.id} must receive normalized unique workspace roots in one scan`
        );
    }

    assert.strictEqual(
        workspaceSessionHydration.hasWorkspaceRuntimeContinuity(workspace, outsideNavigationRuntime),
        true
    );
    assert.strictEqual(
        workspaceSessionHydration.hasWorkspaceRuntimeContinuity(workspace, outsideOverlapRuntime),
        true
    );
    assert.strictEqual(
        workspaceSessionHydration.hasWorkspaceRuntimeContinuity(workspace, unmanagedRuntime),
        false
    );
    const whitespaceWorkspace = {
        ...workspace,
        navigationIdentity: 'whitespace-navigation',
        scopeIdentity: 'whitespace-scope',
        roots: [{
            id: 'root-trailing-space', name: 'Trailing space', uri: 'file:///work/repo%20',
            hostPath: '/work/repo ', ordinal: 0,
        }],
    };
    const whitespaceRuntime = rootPath => ({
        identity: createTestAiSessionRuntimeIdentity('codex', `${rootPath}/src`, { sessionId: 'space-owned' }, {
            workspaceScopeIdentity: 'previous-scope',
            workspaceNavigationIdentity: 'previous-navigation',
            workspaceRootHostPaths: [rootPath],
        }),
    });
    assert.strictEqual(
        workspaceSessionHydration.hasWorkspaceRuntimeContinuity(
            whitespaceWorkspace,
            whitespaceRuntime('/work/repo '),
        ),
        true,
    );
    assert.strictEqual(
        workspaceSessionHydration.hasWorkspaceRuntimeContinuity(
            whitespaceWorkspace,
            whitespaceRuntime('/work/repo'),
        ),
        false,
        'a distinct path without the trailing space must not inherit session ownership',
    );
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
    const currentWorkspace = {
        id: 'workspace-current', kind: 'current', navigationIdentity: 'navigation-current',
        scopeIdentity: 'scope-current', name: 'Dashboard Workspace', environment: 'local', environmentLabel: 'Local',
        roots: [
            { id: 'root-app', name: 'App', ordinal: 0 },
            { id: 'root-api', name: 'API', ordinal: 1 },
        ],
        attentionCount: 0,
        aiSessions: {
            workspaceScopeIdentity: 'scope-current',
            workspaceNavigationIdentity: 'navigation-current',
            sessionsByProvider: {
                codex: [{
                    id: 'c1', name: 'Fix dashboard', provider: 'codex',
                    primaryRootId: 'root-api', primaryRootLabel: 'API', active: true,
                }],
            },
        },
    };
    const otherWorkspace = {
        id: 'workspace-other', kind: 'navigation', navigationIdentity: 'navigation-other',
        scopeIdentity: 'scope-other', name: 'Other Workspace', environment: 'ssh', environmentLabel: 'SSH',
        roots: [{ id: 'root-other', name: 'Other', ordinal: 0 }], attentionCount: 0,
    };
    const workspaceCatalog = dashboardViewModel.buildWorkspaceDashboardSearchCatalog(
        groups,
        [
            otherWorkspace,
            currentWorkspace,
            { ...otherWorkspace, id: 'workspace-other-duplicate', name: 'Duplicate publisher' },
            { ...otherWorkspace, id: 'workspace-current-shadow', navigationIdentity: 'navigation-current' },
        ],
    );
    assert.strictEqual(workspaceCatalog.version, 2);
    assert.strictEqual(workspaceCatalog.openWorkspaces.filter(item => item.current).length, 1);
    assert.deepStrictEqual(
        workspaceCatalog.openWorkspaces.map(item => item.navigationIdentity),
        ['navigation-current', 'navigation-other']
    );
    assert.strictEqual(workspaceCatalog.openWorkspaces.some(item => item.rootId), false);
    assert.strictEqual(workspaceCatalog.savedProjects.length, 2);
    assert.deepStrictEqual(workspaceCatalog.savedProjects[0].groupLabels, ['FAVORITES', 'TOOLS']);
    assert.strictEqual(workspaceCatalog.savedProjects[0].identity, '/work/dashboard');
    assert.deepStrictEqual(workspaceCatalog.sessions.map(item => ({
        action: item.action,
        workspaceId: item.workspaceId,
        workspaceNavigationIdentity: item.workspaceNavigationIdentity,
        provider: item.provider,
        sessionId: item.sessionId,
        rootId: item.rootId,
        projectId: item.projectId,
    })), [{
        action: 'reveal-workspace-session',
        workspaceId: 'workspace-current',
        workspaceNavigationIdentity: 'navigation-current',
        provider: 'codex',
        sessionId: 'c1',
        rootId: undefined,
        projectId: undefined,
    }]);

    const serialized = dashboardViewModel.serializeDashboardSearchCatalog({
        ...workspaceCatalog,
        savedProjects: [{
            ...workspaceCatalog.savedProjects[0],
            name: '</script><script>bad()</script>',
        }],
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
            maxOpenWorkspaceDiagnosticBytes: 120,
        });

        diagnostics.logError('Failed action.', new Error('Boom'));
        diagnostics.logAiSessionDiagnostic({ event: 'scan', count: 1 });
        diagnostics.logDashboardDiagnostic({ event: 'refresh' });
        diagnostics.logOpenWorkspaceDiagnostic('Workspace', { event: 'snapshot' });

        assert.strictEqual(lines[0], 'Failed action.');
        assert.ok(lines[1].includes('Boom'));
        assert.strictEqual(lines[2], '[AiSessions] {"event":"scan","count":1}');
        assert.strictEqual(lines[3], '[Dashboard] {"loggedAt":"2026-07-16T12:00:00.000Z","event":"refresh"}');
        assert.strictEqual(lines[4], '[OpenWorkspaces][Workspace] {"event":"snapshot"}');

        const diagnosticPath = path.join(tempRoot, 'open-workspace-diagnostics.jsonl');
        assert.deepStrictEqual(
            fs.readFileSync(diagnosticPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line).component),
            ['Workspace']
        );

        nowMs += 1000;
        diagnostics.logOpenWorkspaceDiagnostic('Bridge', { event: 'large', payload: 'x'.repeat(100) });
        const persisted = fs.readFileSync(diagnosticPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
        assert.deepStrictEqual(persisted.map(item => item.component), ['Bridge']);
        assert.strictEqual(persisted[0].loggedAt, '2026-07-16T12:00:01.000Z');

        const bridgeErrorSentinel = new Error(
            '/private/main-workspace raw-command --session secret-session arbitrary message'
        );
        assert.strictEqual(typeof diagnostics.logOpenWorkspaceBridgeError, 'function',
            'DashboardDiagnostics must expose a privacy-bounded bridge error entry');
        diagnostics.logOpenWorkspaceBridgeError(bridgeErrorSentinel);
        const privacyOutput = lines.join('\n');
        const privacyFile = fs.readFileSync(diagnosticPath, 'utf8');
        assert.strictEqual(privacyOutput.includes(bridgeErrorSentinel.message), false,
            'the main OutputChannel must not contain raw open-workspace bridge errors');
        assert.strictEqual(privacyFile.includes(bridgeErrorSentinel.message), false,
            'the persisted open-workspace diagnostics must not contain raw bridge errors');
        assert.ok(privacyOutput.includes(
            '[OpenWorkspaces][Bridge] {"event":"error","errorCategory":"open-workspace-bridge","errorCode":"unavailable"}'
        ));
        assert.deepStrictEqual(
            JSON.parse(privacyFile.trim().split(/\r?\n/).pop()),
            {
                loggedAt: '2026-07-16T12:00:01.000Z',
                component: 'Bridge',
                event: {
                    event: 'error',
                    errorCategory: 'open-workspace-bridge',
                    errorCode: 'unavailable',
                },
            },
        );

        const circular = {};
        circular.self = circular;
        diagnostics.logOpenWorkspaceDiagnostic('Renderer', circular);
        assert.ok(lines.some(line => line.includes('[OpenWorkspaces][Renderer] Failed to serialize diagnostic:')));
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

    const workspace = {
        navigationIdentity: 'navigation-workspace',
        roots: [
            { uri: 'file:///work/app' },
            { uri: 'file:///work/api' },
        ],
    };
    const workspaceAggregate = {
        protocolVersion: 1,
        aggregateRevision: '1'.repeat(64),
        generatedAtMs: 4,
        sessions: [
            {
                projectId: attentionProject.getAttentionProjectKey('/work/app'),
                sessionKey: 'codex:shared', reasons: ['completed'],
                eventIds: ['event-one', 'event-two'], observedAtMs: 1,
            },
            {
                projectId: attentionProject.getAttentionProjectKey('/work/api'),
                sessionKey: 'codex:shared', reasons: ['completed'],
                eventIds: ['event-one', 'event-two'], observedAtMs: 2,
            },
            {
                projectId: attentionProject.getAttentionProjectKey('/work/api'),
                sessionKey: 'codex:shared', reasons: ['input-required'],
                eventIds: ['event-two', 'event-three'], observedAtMs: 3,
            },
            {
                projectId: attentionProject.getAttentionProjectKey('/work/api'),
                sessionKey: 'kimi:second', reasons: ['failed'],
                eventIds: ['event-four'], observedAtMs: 4,
            },
        ],
    };
    const workspaceSummary = workspaceAttentionProjection.getWorkspaceAttentionSummary(
        workspace,
        workspaceAggregate
    );
    assert.strictEqual(workspaceSummary.attentionCount, 2,
        'one provider session observed through multiple roots must count once');
    assert.deepStrictEqual(workspaceSummary.eventIds, [
        'event-four', 'event-one', 'event-three', 'event-two',
    ]);
    assert.deepStrictEqual(workspaceSummary.sessions, [{
        sessionKey: 'codex:shared',
        eventId: 'event-one',
        eventIds: ['event-one', 'event-three', 'event-two'],
    }, {
        sessionKey: 'kimi:second',
        eventId: 'event-four',
        eventIds: ['event-four'],
    }]);

    const otherWindowAttention = workspaceAttentionProjection.getOtherWorkspaceAttention({
        navigationIdentity: 'navigation-other',
        roots: [
            { uri: 'vscode-remote://ssh-remote+fixture/work/app' },
            { uri: 'vscode-remote://ssh-remote+fixture/work/api' },
        ],
    }, workspaceAggregate);
    assert.deepStrictEqual(otherWindowAttention, {
        navigationIdentity: 'navigation-other',
        attentionCount: 2,
    }, 'other-window attention joins by privacy-bounded root URIs without session details');
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

function runSessionPathChecks() {
    const providerDefinitions = [
        { id: 'codex', terminalNamePrefix: 'Codex', terminalCwdFields: ['cwd'] },
        { id: 'kimi', terminalNamePrefix: 'Kimi', terminalCwdFields: ['workDir', 'cwd'] },
        { id: 'claude', terminalNamePrefix: 'Claude', terminalCwdFields: ['workDir', 'cwd'] },
    ];
    assert.strictEqual(
        aiSessionSessionPaths.getAiSessionComparableCwd(
            'kimi',
            { id: 'k1', cwd: '/work/app/kimi-cwd', workDir: '/work/app/kimi-workdir' },
            providerDefinitions,
        ),
        '/work/app/kimi-workdir'
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
        identity: createTestAiSessionRuntimeIdentity(
            'codex', '/work/app', { pendingId: 'pending-codex' }
        ),
        createdAt: '2026-07-15T10:00:00Z',
        excludedSessionIds: ['excluded'],
    }, result, new Set(['codex:claimed']), (providerId, sessionId) => `${providerId}:${sessionId}`, providerDefinitions);

    assert.strictEqual(match.id, 'newest');
    assert.strictEqual(
        aiSessionPendingTerminals.findPendingAiSessionTerminalMatch({
            identity: createTestAiSessionRuntimeIdentity(
                'kimi', '/work/app', { pendingId: 'pending-kimi' }
            ),
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

async function runPendingTerminalResolverChecks() {
    const providerDefinitions = [
        { id: 'codex', terminalNamePrefix: 'Codex', projectSessionsKey: 'codexSessions', terminalCwdFields: ['cwd'] },
    ];
    function pending(pendingId, cwd, createdAt, title) {
        return {
            identity: createTestAiSessionRuntimeIdentity('codex', cwd, { pendingId }),
            backend: 'vscode', state: 'pending', markerPath: `/tmp/${pendingId}.done`,
            runStartedAtMs: Date.parse(createdAt), attached: true,
            createdAt, excludedSessionIds: [], ...(title === undefined ? {} : { title }),
        };
    }
    function finalRuntime(pendingRuntime, sessionId, overrides = {}) {
        return {
            identity: {
                ...pendingRuntime.identity,
                sessionId,
                pendingId: undefined,
            },
            backend: pendingRuntime.backend,
            state: 'active',
            markerPath: pendingRuntime.markerPath,
            runStartedAtMs: pendingRuntime.runStartedAtMs,
            attached: pendingRuntime.attached,
            ...overrides,
        };
    }
    function resolverOptions(pendingRuntimes, promotePending, aliases, sync) {
        return {
            pendingRuntimes,
            activeRuntimes: [],
            sessionResults: {
                codex: {
                    available: true, scannedFiles: 3, parsedFiles: 3,
                    sessions: pendingRuntimes.map((runtime, index) => ({
                        id: `session-${index}`,
                        name: 'Provider generated title',
                        cwd: runtime.identity.cwd,
                        updatedAt: new Date(Date.parse(runtime.createdAt) + 1000).toISOString(),
                    })),
                },
            },
            providers: providerDefinitions,
            getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
            runtimeCoordinator: { promotePending },
            setAlias: (providerId, sessionId, alias) => aliases.push([providerId, sessionId, alias]),
            syncActiveRuntime: sync,
        };
    }

    const validPending = pending(
        'pending-valid', '/work/valid', '2026-07-15T10:00:00Z', 'Investigate replication'
    );
    const validAliases = [];
    const promotionCalls = [];
    let validSyncs = 0;
    const validResult = await aiSessionPendingTerminalResolver.resolvePendingAiSessionTerminals(
        resolverOptions([validPending], async (identity, sessionId, sessionName) => {
            promotionCalls.push({ identity, sessionId, sessionName });
            return [finalRuntime(validPending, sessionId)];
        }, validAliases, () => { validSyncs++; })
    );
    assert.deepStrictEqual(validResult, {
        attempted: 1,
        promoted: [{ pendingId: 'pending-valid', provider: 'codex', sessionId: 'session-0' }],
        failures: [],
    });
    assert.deepStrictEqual(promotionCalls[0], {
        identity: validPending.identity,
        sessionId: 'session-0',
        sessionName: 'Investigate replication',
    });
    assert.deepStrictEqual(validAliases, [['codex', 'session-0', 'Investigate replication']]);
    assert.strictEqual(validSyncs, 1);

    const fallbackPending = pending(
        'pending-fallback', '/work/fallback', '2026-07-15T10:00:00Z', ''
    );
    const fallbackPromotionCalls = [];
    await aiSessionPendingTerminalResolver.resolvePendingAiSessionTerminals(
        resolverOptions([fallbackPending], async (identity, sessionId, sessionName) => {
            fallbackPromotionCalls.push({ identity, sessionId, sessionName });
            return [finalRuntime(fallbackPending, sessionId)];
        }, [], () => undefined)
    );
    assert.strictEqual(fallbackPromotionCalls[0].sessionName, 'Provider generated title');

    for (const invalidProviderName of ['   ', 'bad\nname', 'x'.repeat(201)]) {
        const invalidNameCalls = [];
        const invalidNameOptions = resolverOptions(
            [fallbackPending], async (identity, sessionId, sessionName) => {
                invalidNameCalls.push({ identity, sessionId, sessionName });
                return [finalRuntime(fallbackPending, sessionId)];
            }, [], () => undefined
        );
        invalidNameOptions.sessionResults.codex.sessions[0].name = invalidProviderName;
        await aiSessionPendingTerminalResolver.resolvePendingAiSessionTerminals(invalidNameOptions);
        assert.strictEqual(invalidNameCalls[0].sessionName, 'session-0',
            'invalid provider display names must fall back to the provider session ID');
    }

    const durableRecoveryPending = {
        ...fallbackPending,
        promotionRecoveryDisplayName: 'Frozen durable name',
        recoverySessionId: 'frozen-session',
    };
    const durableRecoveryCalls = [];
    const durableRecoveryOptions = resolverOptions(
        [durableRecoveryPending], async (identity, sessionId, sessionName) => {
            durableRecoveryCalls.push({ identity, sessionId, sessionName });
            return [finalRuntime(durableRecoveryPending, sessionId)];
        }, [], () => undefined
    );
    durableRecoveryOptions.activeRuntimes = [finalRuntime(
        durableRecoveryPending, 'frozen-session'
    )];
    durableRecoveryOptions.sessionResults.codex.sessions = [{
        id: 'newer-same-cwd', name: 'Newer current name', cwd: '/work/fallback',
        updatedAt: '2026-07-15T10:00:02.000Z',
    }, {
        id: 'frozen-session', name: 'Changed provider name', cwd: '/different',
        updatedAt: '2026-07-15T09:00:00.000Z',
    }];
    await aiSessionPendingTerminalResolver.resolvePendingAiSessionTerminals(durableRecoveryOptions);
    assert.strictEqual(durableRecoveryCalls[0].sessionId, 'frozen-session',
        'durable recovery must select its exact frozen provider session despite claimed/time/cwd heuristics');
    assert.strictEqual(durableRecoveryCalls[0].sessionName, 'Frozen durable name',
        'durable recovery must ignore a changed provider display name');

    const missingRecoveryTargetOptions = resolverOptions(
        [durableRecoveryPending], async () => {
            throw new Error('a missing durable target must not be promoted');
        }, [], () => undefined
    );
    missingRecoveryTargetOptions.sessionResults.codex.sessions = [{
        id: 'newer-same-cwd', name: 'Newer current name', cwd: '/work/fallback',
        updatedAt: '2026-07-15T10:00:02.000Z',
    }];
    assert.deepStrictEqual(
        await aiSessionPendingTerminalResolver.resolvePendingAiSessionTerminals(
            missingRecoveryTargetOptions
        ),
        { attempted: 0, promoted: [], failures: [] },
        'a durable recovery target absent from provider discovery must remain retryable'
    );

    for (const invalidRecoverySessionId of ['', 'bad id', 'bad\nrecovery', 'x'.repeat(513)]) {
        await assert.rejects(
            aiSessionPendingTerminalResolver.resolvePendingAiSessionTerminals(
                resolverOptions([{
                    ...durableRecoveryPending,
                    recoverySessionId: invalidRecoverySessionId,
                }], async () => [], [], () => undefined)
            ),
            /durable promotion session snapshot is invalid/,
            'invalid durable recovery session IDs must fail closed before matching'
        );
    }

    for (const invalidRecoveryName of ['', 'bad\nrecovery', 'x'.repeat(201)]) {
        let invalidRecoveryCalls = 0;
        const invalidRecoveryResult = await aiSessionPendingTerminalResolver
            .resolvePendingAiSessionTerminals(resolverOptions([{
                ...fallbackPending,
                promotionRecoveryDisplayName: invalidRecoveryName,
                recoverySessionId: 'session-0',
            }], async () => {
                invalidRecoveryCalls++;
                return [];
            }, [], () => undefined));
        assert.strictEqual(invalidRecoveryCalls, 0);
        assert.strictEqual(invalidRecoveryResult.failures[0].reason, 'promotion-error',
            'invalid durable recovery display snapshots must fail closed before promotion');
    }

    const duplicatePending = { ...validPending, identity: { ...validPending.identity } };
    const duplicateCases = [{
        reason: null,
        promote: async (_pendingId, sessionId) => [finalRuntime(validPending, sessionId)],
    }, {
        reason: 'conflict',
        promote: async (_pendingId, sessionId) => [
            finalRuntime(validPending, sessionId, { state: 'conflict' }),
        ],
    }, {
        reason: 'missing-runtime',
        promote: async () => [],
    }, {
        reason: 'invalid-runtime',
        promote: async () => [null],
    }, {
        reason: 'promotion-error',
        promote: async () => { throw new Error('duplicate promotion failed'); },
    }];
    for (const duplicateCase of duplicateCases) {
        let promotionCalls = 0;
        const aliases = [];
        let syncs = 0;
        const result = await aiSessionPendingTerminalResolver.resolvePendingAiSessionTerminals(
            resolverOptions([validPending, duplicatePending], async (pendingId, sessionId) => {
                promotionCalls++;
                return duplicateCase.promote(pendingId, sessionId);
            }, aliases, () => { syncs++; })
        );
        assert.strictEqual(promotionCalls, 1, 'one resolver invocation must attempt a full pending identity once');
        assert.strictEqual(result.attempted, 1);
        assert.strictEqual(result.promoted.length, duplicateCase.reason ? 0 : 1);
        assert.deepStrictEqual(result.failures.map(failure => failure.reason),
            duplicateCase.reason ? [duplicateCase.reason] : []);
        assert.strictEqual(aliases.length, duplicateCase.reason ? 0 : 1);
        assert.strictEqual(syncs, duplicateCase.reason ? 0 : 1);
    }

    const invalidCases = [{
        reason: 'missing-runtime',
        promote: async () => [],
    }, {
        reason: 'ambiguous-runtime',
        promote: async (_pendingId, sessionId) => [
            finalRuntime(validPending, sessionId), finalRuntime(validPending, sessionId),
        ],
    }, {
        reason: 'conflict',
        promote: async (_pendingId, sessionId) => [
            finalRuntime(validPending, sessionId, { state: 'conflict' }),
        ],
    }, {
        reason: 'conflict',
        promote: async (_pendingId, sessionId) => [
            finalRuntime(validPending, sessionId),
            finalRuntime(validPending, sessionId, { state: 'conflict' }),
        ],
    }, {
        reason: 'non-active-runtime',
        promote: async (_pendingId, sessionId) => [
            finalRuntime(validPending, sessionId, { state: 'stopped' }),
        ],
    }, {
        reason: 'non-active-runtime',
        promote: async (_pendingId, sessionId) => [
            finalRuntime(validPending, sessionId, { state: 'completed' }),
        ],
    }, {
        reason: 'non-active-runtime',
        promote: async (_pendingId, sessionId) => [
            finalRuntime(validPending, sessionId, { state: 'pending' }),
        ],
    }, {
        reason: 'invalid-runtime',
        promote: async () => [null],
    }, {
        reason: 'identity-mismatch',
        promote: async () => [finalRuntime(validPending, 'other-session')],
    }, {
        reason: 'identity-mismatch',
        promote: async (_identity, sessionId) => [finalRuntime(validPending, sessionId, {
            identity: {
                ...validPending.identity,
                workspaceScopeIdentity: 'scope:/other-workspace',
                pendingId: undefined,
                sessionId,
            },
        })],
    }, {
        reason: 'identity-mismatch',
        promote: async (_identity, sessionId) => [finalRuntime(validPending, sessionId, {
            identity: {
                ...validPending.identity,
                workspaceNavigationIdentity: 'nav:/different',
                workspaceRootHostPaths: ['/different-root'],
                cwd: '/different-root',
                pendingId: undefined,
                sessionId,
            },
        })],
    }, {
        reason: 'promotion-error',
        promote: async () => { throw new Error('promotion failed'); },
    }];
    for (const invalidCase of invalidCases) {
        const aliases = [];
        let syncs = 0;
        const result = await aiSessionPendingTerminalResolver.resolvePendingAiSessionTerminals(
            resolverOptions([validPending], invalidCase.promote, aliases, () => { syncs++; })
        );
        assert.strictEqual(result.attempted, 1);
        assert.deepStrictEqual(result.promoted, []);
        assert.deepStrictEqual(result.failures, [{
            pendingId: 'pending-valid', provider: 'codex', sessionId: 'session-0', reason: invalidCase.reason,
        }]);
        assert.deepStrictEqual(aliases, []);
        assert.strictEqual(syncs, 0);
    }

    const first = pending('pending-first', '/work/first', '2026-07-15T11:00:00Z', 'First Alias');
    const second = pending('pending-second', '/work/second', '2026-07-15T12:00:00Z', 'Second Alias');
    const partialAliases = [];
    let partialSyncs = 0;
    const partial = await aiSessionPendingTerminalResolver.resolvePendingAiSessionTerminals(
        resolverOptions([first, second], async (identity, sessionId) => {
            if (identity.pendingId === 'pending-second') {
                throw new Error('later promotion failed');
            }
            return [finalRuntime(first, sessionId)];
        }, partialAliases, () => { partialSyncs++; })
    );
    assert.deepStrictEqual(partial, {
        attempted: 2,
        promoted: [{ pendingId: 'pending-first', provider: 'codex', sessionId: 'session-0' }],
        failures: [{
            pendingId: 'pending-second', provider: 'codex', sessionId: 'session-1', reason: 'promotion-error',
        }],
    });
    assert.deepStrictEqual(partialAliases, [['codex', 'session-0', 'First Alias']]);
    assert.strictEqual(partialSyncs, 1, 'partial success must synchronize exactly once');
}

async function runWorkspacePendingSessionPromotionChecks() {
    const workspace = {
        navigationIdentity: 'workspace-navigation',
        scopeIdentity: 'workspace-scope',
        kind: 'savedMultiRoot',
        displayName: 'Workspace',
        navigationUri: 'file:///work/workspace.code-workspace',
        environment: 'local',
        roots: [{
            id: 'root-app', name: 'App', uri: 'file:///work/app',
            hostPath: '/work/app', ordinal: 0,
        }],
    };
    const providersForPromotion = [{
        id: 'codex', terminalNamePrefix: 'Codex',
        projectSessionsKey: 'codexSessions', terminalCwdFields: ['cwd'],
    }];
    const sessionResults = {
        codex: {
            available: true, scannedFiles: 1, parsedFiles: 1,
            sessions: [{
                id: 'session-final', cwd: '/work/app',
                updatedAt: '2026-07-22T10:00:01.000Z',
            }],
        },
    };
    const makePending = (scopeIdentity = workspace.scopeIdentity) => ({
        identity: createTestAiSessionRuntimeIdentity(
            'codex', '/work/app', { pendingId: 'pending-workspace' }, {
                workspaceScopeIdentity: scopeIdentity,
                workspaceNavigationIdentity: scopeIdentity === workspace.scopeIdentity
                    ? workspace.navigationIdentity : 'other-navigation',
                workspaceRootHostPaths: ['/work/app'],
            }
        ),
        backend: 'vscode', state: 'pending', markerPath: '/tmp/pending-workspace.done',
        runStartedAtMs: Date.parse('2026-07-22T10:00:00.000Z'), attached: true,
        createdAt: '2026-07-22T10:00:00.000Z', excludedSessionIds: [],
        title: 'New Codex session',
    });
    const makeFinal = pending => ({
        ...pending,
        identity: {
            ...pending.identity,
            pendingId: undefined,
            sessionId: 'session-final',
        },
        state: 'active',
    });

    async function runSuccessCase() {
        const inScope = makePending();
        const outOfScope = makePending('other-scope');
        let pending = [inScope, outOfScope];
        let active = [];
        const promotions = [];
        const aliases = [];
        const refreshReasons = [];
        let syncCount = 0;
        let evaluationCount = 0;
        const controller = new WorkspacePendingSessionPromotionController({
            providers: providersForPromotion,
            getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
            runtimeCoordinator: {
                getPending: () => pending,
                getPendingForPromotion: async () => pending,
                getActive: () => active,
                promotePending: async (identity, sessionId) => {
                    promotions.push([identity.pendingId, sessionId]);
                    const final = makeFinal(inScope);
                    pending = [outOfScope];
                    active = [final];
                    return [final];
                },
            },
            setAlias: (providerId, sessionId, alias) => aliases.push([providerId, sessionId, alias]),
            syncActiveRuntime: () => { syncCount++; },
            evaluateExecution: () => { evaluationCount++; },
            scheduleRefresh: reason => refreshReasons.push(reason),
        });

        await controller.promote(workspace, sessionResults, 'watcher');
        assert.deepStrictEqual(promotions, [['pending-workspace', 'session-final']]);
        assert.deepStrictEqual(aliases, [['codex', 'session-final', 'New Codex session']]);
        assert.strictEqual(syncCount, 1);
        assert.strictEqual(evaluationCount, 1);
        assert.deepStrictEqual(refreshReasons, ['pending-promotion']);
    }

    async function runRetryCase() {
        const pendingRuntime = makePending();
        let pending = [pendingRuntime];
        let active = [];
        let attempts = 0;
        let syncCount = 0;
        let evaluationCount = 0;
        const aliases = [];
        const controller = new WorkspacePendingSessionPromotionController({
            providers: providersForPromotion,
            getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
            runtimeCoordinator: {
                getPending: () => pending,
                getPendingForPromotion: async () => pending,
                getActive: () => active,
                promotePending: async () => {
                    attempts++;
                    if (attempts === 1) return [];
                    const final = makeFinal(pendingRuntime);
                    pending = [];
                    active = [final];
                    return [final];
                },
            },
            setAlias: (providerId, sessionId, alias) => aliases.push([providerId, sessionId, alias]),
            syncActiveRuntime: () => { syncCount++; },
            evaluateExecution: () => { evaluationCount++; },
            scheduleRefresh: () => undefined,
        });

        await controller.promote(workspace, sessionResults, 'first-scan');
        await controller.promote(workspace, sessionResults, 'retry-scan');
        assert.strictEqual(attempts, 2);
        assert.strictEqual(syncCount, 1);
        assert.strictEqual(evaluationCount, 1);
        assert.strictEqual(aliases.length, 1);
    }

    async function runConcurrentCase() {
        const pendingRuntime = makePending();
        let pending = [pendingRuntime];
        let active = [];
        let releaseEnumeration;
        const enumerationGate = new Promise(resolve => { releaseEnumeration = resolve; });
        let enumerationAttempts = 0;
        let attempts = 0;
        const controller = new WorkspacePendingSessionPromotionController({
            providers: providersForPromotion,
            getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
            runtimeCoordinator: {
                getPending: () => pending,
                getPendingForPromotion: async () => {
                    enumerationAttempts++;
                    if (enumerationAttempts === 1) await enumerationGate;
                    return pending;
                },
                getActive: () => active,
                promotePending: async () => {
                    attempts++;
                    const final = makeFinal(pendingRuntime);
                    pending = [];
                    active = [final];
                    return [final];
                },
            },
            setAlias: () => undefined,
            syncActiveRuntime: () => undefined,
            evaluateExecution: () => undefined,
            scheduleRefresh: () => undefined,
        });

        const first = controller.promote(workspace, sessionResults, 'first');
        const second = controller.promote(workspace, sessionResults, 'second');
        releaseEnumeration();
        await Promise.all([first, second]);
        assert.strictEqual(attempts, 1,
            'concurrent hydration must not promote one pending identity twice');
        assert.strictEqual(enumerationAttempts, 2,
            'a queued refresh must re-enumerate after the in-flight promotion settles');
    }

    async function runEnumerationRetryCase() {
        const pendingRuntime = makePending();
        let pending = [pendingRuntime];
        let active = [];
        let enumerationAttempts = 0;
        let promotionAttempts = 0;
        const diagnostics = [];
        const controller = new WorkspacePendingSessionPromotionController({
            providers: providersForPromotion,
            getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
            runtimeCoordinator: {
                getPending: () => pending,
                getPendingForPromotion: async () => {
                    enumerationAttempts++;
                    if (enumerationAttempts === 1) {
                        throw new Error('durable promotion enumeration failed');
                    }
                    return pending;
                },
                getActive: () => active,
                promotePending: async () => {
                    promotionAttempts++;
                    const final = makeFinal(pendingRuntime);
                    pending = [];
                    active = [final];
                    return [final];
                },
            },
            setAlias: () => undefined,
            syncActiveRuntime: () => undefined,
            evaluateExecution: () => undefined,
            scheduleRefresh: () => undefined,
            logDiagnostic: diagnostic => diagnostics.push(diagnostic),
        });

        await controller.promote(workspace, sessionResults, 'failed-enumeration');
        assert.strictEqual(promotionAttempts, 0,
            'a refresh or durable-list error must fail closed before promotion dispatch');
        await controller.promote(workspace, sessionResults, 'retry-enumeration');
        assert.strictEqual(promotionAttempts, 1);
        assert.strictEqual(enumerationAttempts, 2);
        assert.strictEqual(diagnostics[0].event, 'workspace-ai-session-promotion-failed');
    }

    async function runDrainCompletionRaceCase() {
        const pendingRuntime = makePending();
        let pending = [pendingRuntime];
        let active = [];
        let enumerationAttempts = 0;
        let promotionAttempts = 0;
        let injected = false;
        let racedRequest;
        const controller = new WorkspacePendingSessionPromotionController({
            providers: providersForPromotion,
            getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
            runtimeCoordinator: {
                getPending: () => pending,
                getPendingForPromotion: async () => {
                    enumerationAttempts++;
                    return pending;
                },
                getActive: () => active,
                promotePending: async () => {
                    promotionAttempts++;
                    const final = makeFinal(pendingRuntime);
                    pending = [];
                    active = [final];
                    return [final];
                },
            },
            setAlias: () => undefined,
            syncActiveRuntime: () => undefined,
            evaluateExecution: () => undefined,
            scheduleRefresh: () => undefined,
        });
        const queue = controller.queuedByScope;
        const queueHas = queue.has.bind(queue);
        queue.has = scope => {
            const present = queueHas(scope);
            if (!present && enumerationAttempts === 1 && !injected) {
                injected = true;
                racedRequest = controller.promote(workspace, sessionResults, 'empty-finally-window');
            }
            return present;
        };

        await controller.promote(workspace, sessionResults, 'initial');
        await racedRequest;
        assert.strictEqual(enumerationAttempts, 2,
            'a request queued after the empty check must be drained before its promise settles');
        assert.strictEqual(promotionAttempts, 1,
            'the raced refresh must observe settled state without promoting twice');
    }

    await runSuccessCase();
    await runRetryCase();
    await runConcurrentCase();
    await runEnumerationRetryCase();
    await runDrainCompletionRaceCase();
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

async function runWorkspaceStateStoreChecks() {
    const data = {
        'workspaceExpandedAiSessions.v2': ['scope-a', 1, '', 'scope-b'],
        'workspaceActiveAiSessionProvider.v2': {
            'scope-a': 'codex',
            'scope-b': 'unknown',
            'scope-c': 'kimi',
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
    const store = new AiSessionWorkspaceStateStore(state, value => value === 'codex' || value === 'kimi' || value === 'claude');

    assert.deepStrictEqual(Array.from(store.getExpandedWorkspaces()), ['scope-a', 'scope-b']);
    assert.deepStrictEqual(store.getActiveProviders(), {
        'scope-a': 'codex',
        'scope-c': 'kimi',
    });

    await store.setExpanded('scope-c', true);
    await store.setExpanded('scope-a', false);
    await store.setActiveProvider('scope-d', 'claude');
    await store.setActiveProvider('scope-e', 'unknown');

    assert.deepStrictEqual(updates, [
        ['workspaceExpandedAiSessions.v2', ['scope-a', 'scope-b', 'scope-c']],
        ['workspaceExpandedAiSessions.v2', ['scope-b', 'scope-c']],
        ['workspaceActiveAiSessionProvider.v2', {
            'scope-a': 'codex',
            'scope-c': 'kimi',
            'scope-d': 'claude',
        }],
    ]);
}

async function runAiSessionCommandControllerChecks() {
    const workspaceTarget = {
        cardId: 'workspace-a',
        workspace: {
            scopeIdentity: 'scope-a',
            navigationIdentity: 'navigation-a',
            roots: [{ id: 'root-a', name: 'A', uri: 'file:///work/a', ordinal: 0 }],
        },
    };
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
        getWorkspaceTarget: cardId => cardId === workspaceTarget.cardId ? workspaceTarget : null,
        isProviderId: value => value === 'codex' || value === 'kimi' || value === 'claude',
        setExpanded: async (workspaceScopeIdentity, value) => expanded.push([workspaceScopeIdentity, value]),
        setActiveProvider: async (workspaceScopeIdentity, providerId) => {
            activeProviders.push([workspaceScopeIdentity, providerId]);
        },
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

    await controller.toggleSessionsExpanded('workspace-a', true);
    assert.deepStrictEqual(expanded, [['scope-a', true]]);

    await controller.selectProvider('workspace-a', 'kimi');
    assert.deepStrictEqual(activeProviders, [['scope-a', 'kimi']]);
    assert.strictEqual(refreshes.length, 1);

    await controller.selectProvider('missing', 'codex');
    await controller.selectProvider('workspace-a', 'invalid');
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

function runAiSessionProviderAvailabilityChecks() {
    const exists = value => value === '/bin/codex' || value === 'C:\\Tools\\kimi.CMD';
    assert.strictEqual(providerAvailability.isCommandAvailableOnPath(
        'codex', { PATH: '/bin:/usr/bin' }, 'linux', exists
    ), true);
    assert.strictEqual(providerAvailability.isCommandAvailableOnPath(
        'claude', { PATH: '/bin:/usr/bin' }, 'linux', exists
    ), false);
    assert.strictEqual(providerAvailability.isCommandAvailableOnPath(
        'kimi', { Path: 'C:\\Tools', PATHEXT: '.EXE;.CMD' }, 'win32', exists
    ), true);
}

async function runWorkspaceCreationDirectoryFirstChecks() {
    const workspace = {
        displayName: 'Workspace A',
        navigationIdentity: 'navigation-a',
        scopeIdentity: 'scope-a',
        roots: [
            { id: 'root-web', name: 'Web', hostPath: '/work/web', ordinal: 0 },
            { id: 'root-api', name: 'API', hostPath: '/work/api', ordinal: 1 },
        ],
    };
    const target = {
        cardId: 'workspace-a',
        workspace,
        sessions: { sessionsByProvider: {} },
    };
    const events = [];
    const requests = [];
    let pickerResult = 'root-api';
    const creation = new AiSessionCreationController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: cardId => cardId === target.cardId ? target : null,
        pickWorkspaceRoot: async selectedWorkspace => {
            assert.strictEqual(selectedWorkspace, workspace);
            events.push('root');
            return pickerResult;
        },
        pickProvider: async () => {
            events.push('provider');
            return 'codex';
        },
        getProviderLabel: () => 'Codex',
        getProvider: () => ({
            label: 'Codex',
            terminalNamePrefix: 'Codex',
            buildNewSessionLaunchSpec: scope => ({
                executable: 'codex', args: [], cwd: scope.primaryCwd,
            }),
        }),
        resolveWorkspaceDirectoryScope: async (_resolved, _providerId, rootId) => {
            events.push(`scope:${rootId || 'implicit'}`);
            const selectedRoot = workspace.roots.find(root => root.id === rootId) || workspace.roots[0];
            return {
                workspaceNavigationIdentity: workspace.navigationIdentity,
                workspaceScopeIdentity: workspace.scopeIdentity,
                workspaceRootHostPaths: workspace.roots.map(root => root.hostPath),
                primaryRootId: selectedRoot.id,
                primaryCwd: selectedRoot.hostPath,
                additionalDirectories: workspace.roots
                    .filter(root => root.id !== selectedRoot.id)
                    .map(root => root.hostPath),
            };
        },
        runtimeCoordinator: {
            create: async request => {
                requests.push(request);
                return { status: 'started', runtime: {} };
            },
            getActive: () => [],
            getPending: () => [],
        },
        createPendingId: () => `pending-directory-first-${requests.length}`,
        showInputBox: async () => {
            events.push('title');
            return '';
        },
        showActiveTab: async () => undefined,
        announceStatus: async () => undefined,
        showWarningMessage: async () => undefined,
        refresh: () => undefined,
        getExistingSessionIdsForCwd: () => [],
        getPendingMarkerPath: () => '/tmp/directory-first.marker',
        scheduleNewSessionRefresh: () => undefined,
        nowMs: () => 1,
    });

    await creation.createSession(target.cardId);
    assert.deepStrictEqual(events, ['root', 'provider', 'title', 'scope:root-api']);
    assert.strictEqual(requests[0].directoryScope.primaryRootId, 'root-api');

    events.length = 0;
    pickerResult = undefined;
    await creation.createSession(target.cardId);
    assert.deepStrictEqual(events, ['root'],
        'cancelling the workspace root picker must stop before provider and title prompts');
    assert.strictEqual(requests.length, 1);

    events.length = 0;
    workspace.roots = [workspace.roots[0]];
    await creation.createSession(target.cardId);
    assert.deepStrictEqual(events, ['provider', 'title', 'scope:implicit'],
        'single-folder creation must skip the workspace root picker');
    assert.strictEqual(requests[1].directoryScope.primaryRootId, 'root-web');
}

async function runWorkspaceScopeControllerLaunchChecks() {
    const workspaceTarget = {
        cardId: 'workspace-a',
        workspace: {
            displayName: 'Workspace A',
            navigationIdentity: 'navigation-a',
            scopeIdentity: 'scope-a',
            roots: [],
        },
        sessions: { sessionsByProvider: {} },
    };
    const scope = Object.freeze({
        workspaceNavigationIdentity: 'navigation-a',
        workspaceScopeIdentity: 'scope-a',
        workspaceRootHostPaths: Object.freeze(['/work/web', '/work/api', '/work/文档']),
        primaryRootId: 'root-web',
        primaryCwd: '/work/web',
        additionalDirectories: Object.freeze(['/work/api', '/work/文档']),
    });
    for (const providerId of ['codex', 'kimi', 'claude']) {
        const createScopes = [];
        const createRequests = [];
        const createLaunch = Object.freeze({
            executable: providerId,
            args: Object.freeze(['create', providerId]),
            cwd: scope.primaryCwd,
            markerPath: `/tmp/${providerId}-create.marker`,
        });
        const creation = new AiSessionCreationController({
            isProviderId: value => value === providerId,
            getWorkspaceTarget: cardId => cardId === workspaceTarget.cardId ? workspaceTarget : null,
            pickWorkspaceRoot: async () => undefined,
            pickProvider: async () => providerId,
            getProviderLabel: () => providerId,
            getProvider: () => ({
                label: providerId,
                terminalNamePrefix: providerId,
                buildNewSessionLaunchSpec: directoryScope => {
                    createScopes.push(directoryScope);
                    return createLaunch;
                },
            }),
            resolveWorkspaceDirectoryScope: async resolvedTarget => {
                assert.strictEqual(resolvedTarget, workspaceTarget);
                return scope;
            },
            createPendingId: () => `pending-${providerId}`,
            showInputBox: async () => '',
            showActiveTab: async () => undefined,
            announceStatus: async () => undefined,
            showWarningMessage: async () => undefined,
            refresh: () => undefined,
            getExistingSessionIdsForCwd: () => [],
            getPendingMarkerPath: () => `/tmp/${providerId}-create.marker`,
            scheduleNewSessionRefresh: () => undefined,
            nowMs: () => Date.parse('2026-07-20T10:00:00.000Z'),
            runtimeCoordinator: {
                create: async request => {
                    createRequests.push(request);
                    return { status: 'started', runtime: {} };
                },
                getActive: () => [],
                getPending: () => [],
            },
        });
        await creation.createSession(workspaceTarget.cardId);
        assert.strictEqual(createScopes[0], scope,
            `${providerId} creation must pass the injected complete scope unchanged to its builder`);
        assert.deepStrictEqual(createRequests[0].launch, {
            executable: providerId,
            args: ['create', providerId],
            cwd: scope.primaryCwd,
            markerPath: `/tmp/${providerId}-create.marker`,
        });
        assert.strictEqual(createRequests[0].identity.cwd, scope.primaryCwd);

        const session = Object.freeze({
            id: `${providerId}-session`,
            name: `${providerId} Session`,
            cwd: '/historical/session-path',
            updatedAt: '2026-07-20T09:00:00.000Z',
        });
        workspaceTarget.sessions.sessionsByProvider[providerId] = [session];
        const resumeScopes = [];
        const resumeRequests = [];
        const resumeLaunch = Object.freeze({
            executable: providerId,
            args: Object.freeze(['resume', session.id]),
            cwd: scope.primaryCwd,
            markerPath: `/tmp/${providerId}-resume.marker`,
        });
        const resume = new AiSessionResumeController({
            getWorkspaceTarget: cardId => cardId === workspaceTarget.cardId ? workspaceTarget : null,
            getProvider: () => ({
                label: providerId,
                terminalEnvKey: `${providerId}_SESSION_ID`,
                buildResumeLaunchSpec: (sessionId, directoryScope) => {
                    assert.strictEqual(sessionId, session.id);
                    resumeScopes.push(directoryScope);
                    return resumeLaunch;
                },
            }),
            resolveWorkspaceDirectoryScope: async (resolvedTarget, resolvedSession) => {
                assert.strictEqual(resolvedTarget, workspaceTarget);
                assert.strictEqual(resolvedSession, session);
                return scope;
            },
            getTerminalName: () => `${providerId}: Session`,
            getMarkerPath: () => `/tmp/${providerId}-resume.marker`,
            showWarningMessage: () => undefined,
            announceStatus: async () => undefined,
            refresh: () => undefined,
            showActiveTab: async () => undefined,
            runtimeCoordinator: {
                resume: async request => {
                    resumeRequests.push(request);
                    return { status: 'started', runtime: {} };
                },
            },
        });
        await resume.resumeProjectSession(workspaceTarget.cardId, providerId, session.id);
        assert.strictEqual(resumeScopes[0], scope,
            `${providerId} resume must pass the injected complete scope unchanged to its builder`);
        assert.deepStrictEqual(resumeRequests[0].launch, {
            executable: providerId,
            args: ['resume', session.id],
            cwd: scope.primaryCwd,
            markerPath: `/tmp/${providerId}-resume.marker`,
        });
        assert.strictEqual(resumeRequests[0].identity.cwd, scope.primaryCwd);
    }
}

async function runWorkspaceLaunchPreflightControllerChecks() {
    const workspace = {
        navigationIdentity: 'navigation-a',
        scopeIdentity: 'scope-a',
        kind: 'savedMultiRoot',
        displayName: 'Workspace A',
        navigationUri: 'file:///work/workspace.code-workspace',
        environment: 'local',
        roots: [{
            id: 'root-web', name: 'Web', uri: 'file:///work/web', hostPath: '/work/web', ordinal: 0,
        }, {
            id: 'root-api', name: 'API', uri: 'file:///work/api', hostPath: '/work/api', ordinal: 1,
        }],
    };
    const workspaceTarget = {
        cardId: 'workspace-a',
        workspace,
        sessions: { sessionsByProvider: { codex: [] } },
    };
    let trusted = true;
    let providerPresent = true;
    let capabilityStatus = 'supported';
    let activeEditorUri = { fsPath: '/work/api/src/index.ts' };
    let lastUsedRootId = 'root-web';
    let pickerResult;
    const invalidDirectories = new Set();
    const warnings = [];
    const primaryRootWrites = [];
    const capabilityRequests = [];
    const pickedRoots = [];
    const commandController = new AiSessionCommandController({
        getWorkspaceTarget: cardId => cardId === workspaceTarget.cardId ? workspaceTarget : null,
        getOpenWorkspace: () => workspace,
        getActiveEditorUri: () => activeEditorUri,
        isWorkspaceTrusted: () => trusted,
        getProvider: providerId => providerPresent ? {
            id: providerId, label: 'Codex', commandName: 'codex',
        } : null,
        getProviderDirectoryCapability: async provider => {
            capabilityRequests.push(provider.id);
            return { status: capabilityStatus };
        },
        getPrimaryRootId: currentWorkspace => {
            assert.strictEqual(currentWorkspace, workspace);
            return lastUsedRootId;
        },
        setPrimaryRootId: async (scopeIdentity, rootId) => primaryRootWrites.push([scopeIdentity, rootId]),
        pickWorkspaceRoot: async (currentWorkspace, action) => {
            pickedRoots.push([currentWorkspace.scopeIdentity, action]);
            return pickerResult;
        },
        isDirectory: hostPath => !invalidDirectories.has(hostPath),
        showWarningMessage: message => warnings.push(message),
        isProviderId: value => value === 'codex',
        setExpanded: async () => undefined,
        setActiveProvider: async () => undefined,
        togglePin: () => false,
        getAliases: () => ({}),
        saveAliases: () => undefined,
        getOriginalName: () => null,
        getSessionKey: () => '',
        showInputBox: async () => undefined,
        writeClipboard: async () => undefined,
        showInformationMessage: () => undefined,
        refresh: () => undefined,
    });

    const activeEditorScope = await commandController.resolveWorkspaceDirectoryScope(workspace, 'codex');
    assert.strictEqual(activeEditorScope.primaryRootId, 'root-api',
        'the active editor root must win over the last-used root for implicit creation');
    assert.deepStrictEqual(activeEditorScope.additionalDirectories, ['/work/web']);

    const explicitScope = await commandController.resolveWorkspaceDirectoryScope(
        workspace, 'codex', undefined, 'root-web'
    );
    assert.strictEqual(explicitScope.primaryRootId, 'root-web',
        'New Session in… must use the explicit root');
    const workDirScope = await commandController.resolveWorkspaceDirectoryScope(workspace, 'codex', {
        id: 'work-dir-session', name: 'Work-dir session', workDir: '/work/api/packages/from-work-dir',
    });
    assert.strictEqual(workDirScope.primaryRootId, 'root-api');
    assert.strictEqual(workDirScope.primaryCwd, '/work/api/packages/from-work-dir',
        'provider histories that expose workDir must preserve the exact nested cwd too');

    const createRequests = [];
    const createScopes = [];
    const markerRequests = [];
    let createResult = { status: 'started', runtime: {} };
    let createError = null;
    let creationRootId = 'root-api';
    const creation = new AiSessionCreationController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: cardId => cardId === workspaceTarget.cardId ? workspaceTarget : null,
        pickWorkspaceRoot: async () => creationRootId,
        pickProvider: async () => 'codex',
        getProviderLabel: () => 'Codex',
        getProvider: () => ({
            label: 'Codex',
            terminalNamePrefix: 'Codex',
            buildNewSessionLaunchSpec: directoryScope => {
                createScopes.push(directoryScope);
                return {
                    executable: 'codex', args: ['--cd', directoryScope.primaryCwd], cwd: directoryScope.primaryCwd,
                };
            },
        }),
        resolveWorkspaceDirectoryScope: (resolvedTarget, providerId, explicitRootId) =>
            commandController.resolveWorkspaceDirectoryScope(
                resolvedTarget.workspace, providerId, undefined, explicitRootId
            ),
        rememberDirectoryScope: directoryScope => commandController.rememberDirectoryScope(directoryScope),
        runtimeCoordinator: {
            create: async request => {
                createRequests.push(request);
                if (createError) {
                    const error = createError;
                    createError = null;
                    throw error;
                }
                return createResult;
            },
            getActive: () => [],
            getPending: () => [],
        },
        createPendingId: () => `pending-${createRequests.length + 1}`,
        showInputBox: async () => '',
        showActiveTab: async () => undefined,
        announceStatus: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        refresh: () => undefined,
        getExistingSessionIdsForCwd: () => [],
        getPendingMarkerPath: () => {
            markerRequests.push('create');
            return '/tmp/create.marker';
        },
        scheduleNewSessionRefresh: () => undefined,
        nowMs: () => Date.parse('2026-07-20T10:00:00.000Z'),
    });

    await creation.createSession(workspaceTarget.cardId);
    assert.deepStrictEqual(createRequests[0].directoryScope, activeEditorScope);
    assert.strictEqual(createRequests[0].identity.cwd, activeEditorScope.primaryCwd);
    assert.strictEqual(createScopes[0], createRequests[0].directoryScope);
    assert.deepStrictEqual(primaryRootWrites, [[workspace.scopeIdentity, activeEditorScope.primaryRootId]]);

    creationRootId = 'root-web';
    await creation.createSession(workspaceTarget.cardId);
    assert.strictEqual(createRequests[1].directoryScope.primaryRootId, 'root-web');
    assert.deepStrictEqual(primaryRootWrites[1], [workspace.scopeIdentity, 'root-web']);

    createResult = { status: 'focused', runtime: {} };
    creationRootId = 'root-api';
    await creation.createSession(workspaceTarget.cardId);
    assert.strictEqual(primaryRootWrites.length, 2,
        'focusing an existing runtime must not persist a scope that was not launched');
    createResult = { status: 'started', runtime: {} };

    createError = new Error('launch failed');
    await creation.createSession(workspaceTarget.cardId);
    assert.strictEqual(primaryRootWrites.length, 2,
        'a failed launch must not persist the selected root');

    const session = {
        id: 'session-a', name: 'Session A', cwd: '/work/api/packages/service', updatedAt: '2026-07-20T09:00:00Z',
    };
    workspaceTarget.sessions.sessionsByProvider.codex = [session];
    const resumeRequests = [];
    const resumeScopes = [];
    const resumeMarkerRequests = [];
    let resumeResult = { status: 'started', runtime: {} };
    let resumeError = null;
    const resume = new AiSessionResumeController({
        getWorkspaceTarget: cardId => cardId === workspaceTarget.cardId ? workspaceTarget : null,
        getProvider: () => providerPresent ? ({
            label: 'Codex',
            terminalEnvKey: 'CODEX_SESSION_ID',
            buildResumeLaunchSpec: (_sessionId, directoryScope) => {
                resumeScopes.push(directoryScope);
                return {
                    executable: 'codex', args: ['resume', session.id], cwd: directoryScope.primaryCwd,
                };
            },
        }) : null,
        resolveWorkspaceDirectoryScope: (resolvedTarget, resolvedSession, providerId, explicitRootId) =>
            commandController.resolveWorkspaceDirectoryScope(
                resolvedTarget.workspace, providerId, resolvedSession, explicitRootId
            ),
        rememberDirectoryScope: directoryScope => commandController.rememberDirectoryScope(directoryScope),
        runtimeCoordinator: {
            resume: async request => {
                resumeRequests.push(request);
                if (resumeError) {
                    const error = resumeError;
                    resumeError = null;
                    throw error;
                }
                return resumeResult;
            },
        },
        getTerminalName: () => 'Codex: Session A',
        getMarkerPath: () => {
            resumeMarkerRequests.push('resume');
            return '/tmp/resume.marker';
        },
        showWarningMessage: () => undefined,
        showErrorMessage: async () => undefined,
        announceStatus: async () => undefined,
        refresh: () => undefined,
        showActiveTab: async () => undefined,
    });

    workspace.roots.push({
        id: 'root-docs', name: 'Docs', uri: 'file:///work/docs', hostPath: '/work/docs', ordinal: 2,
    });
    await resume.resumeProjectSession(workspaceTarget.cardId, 'codex', session.id, 'root-web');
    assert.strictEqual(resumeRequests[0].directoryScope.primaryRootId, 'root-api',
        'a current historical cwd must win over an explicit resume fallback');
    assert.strictEqual(resumeRequests[0].directoryScope.primaryCwd, '/work/api/packages/service',
        'resume preflight must preserve the normalized historical cwd inside the longest matching root');
    assert.deepStrictEqual(resumeRequests[0].directoryScope.workspaceRootHostPaths,
        ['/work/web', '/work/api', '/work/docs'], 'resume must recalculate all current roots');
    assert.deepStrictEqual(resumeRequests[0].directoryScope.additionalDirectories,
        ['/work/web', '/work/docs'], 'the owning root must not be repeated as an additional directory');
    assert.strictEqual(resumeRequests[0].launch.cwd, '/work/api/packages/service',
        'the provider launch spec must consume the same exact historical cwd');
    assert.strictEqual(resumeRequests[0].identity.cwd, resumeRequests[0].directoryScope.primaryCwd);
    assert.strictEqual(resumeScopes[0], resumeRequests[0].directoryScope);
    assert.deepStrictEqual(primaryRootWrites[2], [workspace.scopeIdentity, 'root-api']);

    session.cwd = '/historical/outside-workspace';
    pickerResult = 'root-web';
    await resume.resumeProjectSession(workspaceTarget.cardId, 'codex', session.id);
    assert.deepStrictEqual(pickedRoots.slice(-1)[0], [workspace.scopeIdentity, 'resume']);
    assert.strictEqual(resumeRequests[1].directoryScope.primaryRootId, 'root-web');
    assert.deepStrictEqual(primaryRootWrites[3], [workspace.scopeIdentity, 'root-web']);

    pickerResult = undefined;
    const resumeRequestCountBeforeCancel = resumeRequests.length;
    const resumeMarkerCountBeforeCancel = resumeMarkerRequests.length;
    await resume.resumeProjectSession(workspaceTarget.cardId, 'codex', session.id);
    assert.strictEqual(resumeRequests.length, resumeRequestCountBeforeCancel);
    assert.strictEqual(resumeMarkerRequests.length, resumeMarkerCountBeforeCancel,
        'picker cancellation must happen before marker creation');

    pickerResult = 'root-api';
    resumeError = new Error('resume launch failed');
    await resume.resumeProjectSession(workspaceTarget.cardId, 'codex', session.id);
    assert.strictEqual(primaryRootWrites.length, 4,
        'a failed resume launch must not persist the selected root');

    const assertCreateBlockedWithoutPartials = async configure => {
        trusted = true;
        providerPresent = true;
        capabilityStatus = 'supported';
        invalidDirectories.clear();
        configure();
        const requestsBefore = createRequests.length;
        const markersBefore = markerRequests.length;
        const writesBefore = primaryRootWrites.length;
        await creation.createSession(workspaceTarget.cardId);
        assert.strictEqual(createRequests.length, requestsBefore);
        assert.strictEqual(markerRequests.length, markersBefore);
        assert.strictEqual(primaryRootWrites.length, writesBefore);
    };
    await assertCreateBlockedWithoutPartials(() => { trusted = false; });
    await assertCreateBlockedWithoutPartials(() => { invalidDirectories.add('/work/docs'); });
    await assertCreateBlockedWithoutPartials(() => { providerPresent = false; });
    await assertCreateBlockedWithoutPartials(() => { capabilityStatus = 'unavailable'; });
    await assertCreateBlockedWithoutPartials(() => { capabilityStatus = 'unsupported'; });

    const assertResumeBlockedWithoutPartials = async (configure, expectedWarning) => {
        trusted = true;
        providerPresent = true;
        capabilityStatus = 'supported';
        invalidDirectories.clear();
        session.cwd = '/work/api/packages/service';
        configure();
        const requestsBefore = resumeRequests.length;
        const scopesBefore = resumeScopes.length;
        const markersBefore = resumeMarkerRequests.length;
        const writesBefore = primaryRootWrites.length;
        const warningsBefore = warnings.length;
        await resume.resumeProjectSession(workspaceTarget.cardId, 'codex', session.id);
        assert.strictEqual(resumeRequests.length, requestsBefore);
        assert.strictEqual(resumeScopes.length, scopesBefore);
        assert.strictEqual(resumeMarkerRequests.length, markersBefore);
        assert.strictEqual(primaryRootWrites.length, writesBefore);
        assert.ok(warnings.slice(warningsBefore).some(message => message.includes(expectedWarning)),
            `blocked resume must surface a warning containing ${expectedWarning}`);
    };
    await assertResumeBlockedWithoutPartials(() => { trusted = false; }, 'Restricted Mode');
    await assertResumeBlockedWithoutPartials(() => { invalidDirectories.add('/work/docs'); }, 'Docs');
    await assertResumeBlockedWithoutPartials(() => { providerPresent = false; }, 'no longer available');
    await assertResumeBlockedWithoutPartials(() => { capabilityStatus = 'unavailable'; }, 'unavailable');
    await assertResumeBlockedWithoutPartials(() => { capabilityStatus = 'unsupported'; }, '--add-dir');

    trusted = true;
    providerPresent = true;
    capabilityStatus = 'unsupported';
    invalidDirectories.clear();
    session.cwd = '/work/web/packages/app';
    const multiRootWorkspaceRoots = workspace.roots;
    workspace.roots = [multiRootWorkspaceRoots[0]];
    const requestsBeforeSingleRootResume = resumeRequests.length;
    const writesBeforeSingleRootResume = primaryRootWrites.length;
    await resume.resumeProjectSession(workspaceTarget.cardId, 'codex', session.id);
    assert.strictEqual(resumeRequests.length, requestsBeforeSingleRootResume + 1,
        'a provider without multi-root support must still resume in a single-root workspace');
    assert.strictEqual(primaryRootWrites.length, writesBeforeSingleRootResume + 1);
    assert.strictEqual(resumeRequests.at(-1).directoryScope.primaryRootId, 'root-web');
    workspace.roots = multiRootWorkspaceRoots;

    assert.ok(warnings.some(message => message.includes('Restricted Mode')));
    assert.ok(warnings.some(message => message.includes('Docs')));
    assert.ok(warnings.some(message => message.includes('Codex')));
    assert.ok(warnings.some(message => message.includes('--add-dir')));
    assert.ok(capabilityRequests.length > 0);
}

async function runAiSessionAttentionControllerChecks() {
    let nowMs = 1000;
    let enabled = true;
    const workspaceTarget = {
        cardId: 'workspace-a',
        workspace: {
            displayName: 'Workspace A',
            navigationIdentity: 'navigation-a',
            scopeIdentity: 'scope-a',
            roots: [{
                id: 'root-a', name: 'A', uri: 'file:///work/a', hostPath: '/work/a', ordinal: 0,
            }],
        },
        sessions: {
            sessionsByProvider: {
                codex: [{
                    id: 'session-a',
                    updatedAt: '2026-07-16T10:00:00Z',
                    primaryRootId: 'root-a',
                }],
                kimi: [],
                claude: [],
            },
        },
    };
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
            identity: createTestAiSessionRuntimeIdentity(
                'codex', '/work/a', { sessionId: 'session-a' }
            ),
            backend: 'tmux', state: 'completed', markerPath: '/tmp/completed.marker',
            runStartedAtMs: 900, attached: false,
            tmux: { layout: 'session', sessionName: 'project-steward-s-codex-a' },
        }],
    ]);
    const published = [];
    const scheduled = [];
    const controller = new AiSessionAttentionController({
        isEnabled: () => enabled,
        getWorkspaceTarget: () => workspaceTarget,
        getProviders: () => providersForTest,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        getRuntimeById: (providerId, sessionId) => runtimeEntries.get(`${providerId}:${sessionId}`) || null,
        isRuntimeComplete: runtime => runtime.state === 'completed',
        publish: async (items, forceHeartbeat) => {
            published.push({ items: items.map(item => ({ ...item })), forceHeartbeat: Boolean(forceHeartbeat) });
            return true;
        },
        scheduleRefresh: reason => scheduled.push(reason),
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
    assert.strictEqual(
        published[0].items[0].projectId,
        attentionProject.getAttentionProjectKeys([workspaceTarget.workspace.roots[0].uri])[0],
    );
    assert.strictEqual(published[0].items[0].sessionKey, 'codex:session-a');
    assert.strictEqual(published[0].items[0].state, 'needsAttention');
    assert.strictEqual(published[0].items[0].reason, 'completed');
    assert.strictEqual(published[0].items[0].observedAtMs, 900);
    assert.ok(published[0].items[0].eventId.endsWith(
        crypto.createHash('sha256').update('terminal-exit:900').digest('hex')
    ), 'a current completion marker must preserve the existing terminal-exit attention signal');
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
        getWorkspaceTarget: () => workspaceTarget,
        getProviders: () => providersForTest,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        getRuntimeById: () => ({
            identity: createTestAiSessionRuntimeIdentity(
                'codex', '/work/a', { sessionId: 'session-a' }
            ),
            backend: 'vscode', state: 'active', markerPath: '/tmp/live.marker',
            runStartedAtMs: 1200, attached: true,
        }),
        isRuntimeComplete: runtime => runtime.state === 'completed',
        publish: async items => { coexistPublished.push(items.map(item => ({ ...item }))); return true; },
        scheduleRefresh: () => undefined,
        nowMs: () => nowMs,
    });
    const oldInactiveRuntime = {
        identity: createTestAiSessionRuntimeIdentity(
            'codex', '/work/a', { sessionId: 'session-a' }
        ),
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
        getWorkspaceTarget: () => workspaceTarget,
        getProviders: () => providersForTest,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        getRuntimeById: () => null,
        isRuntimeComplete: runtime => runtime.state === 'completed',
        publish: async items => {
            retainedPublished.push(items.map(item => ({ ...item })));
            return true;
        },
        scheduleRefresh: () => undefined,
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
        getWorkspaceTarget: () => workspaceTarget,
        getProviders: () => providersForTest,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        getRuntimeById: () => null,
        isRuntimeComplete: runtime => runtime.state === 'completed',
        publish: async () => true,
        scheduleRefresh: () => undefined,
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
        getWorkspaceTarget: () => workspaceTarget,
        getProviders: () => providersForTest,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        getRuntimeById: () => null,
        isRuntimeComplete: runtime => runtime.state === 'completed',
        publish: async items => { boundedPublished.push(items); return true; },
        scheduleRefresh: () => undefined,
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
        getWorkspaceTarget: () => workspaceTarget,
        getProviders: () => providersForTest,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        getRuntimeById: () => null,
        isRuntimeComplete: runtime => runtime.state === 'completed',
        publish: async items => { equalTimestampPublished.push(items); return true; },
        scheduleRefresh: () => undefined,
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
        identity: createTestAiSessionRuntimeIdentity(
            'codex', '/work/a', { sessionId: 'session-a' }
        ),
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

async function runAiSessionExecutionControllerChecks() {
    let activeSessions = [{
        provider: 'codex',
        sessionId: 'session-a',
        runStartedAtMs: 900,
    }];
    let signal = {
        token: 'codex:run:session-a',
        phase: 'running',
        executionState: 'running',
        occurredAtMs: 1100,
    };
    const providerCalls = { codex: [], kimi: [], claude: [] };
    const providersForTest = [{
        id: 'codex',
        service: {
            getLifecycleSignals: requests => {
                providerCalls.codex.push(requests.map(request => ({ ...request })));
                return { 'session-a': signal };
            },
        },
    }, {
        id: 'kimi',
        service: {
            getLifecycleSignals: requests => {
                providerCalls.kimi.push(requests.map(request => ({ ...request })));
                return {};
            },
        },
    }, {
        id: 'claude',
        service: {
            getLifecycleSignals: requests => {
                providerCalls.claude.push(requests.map(request => ({ ...request })));
                return {};
            },
        },
    }];
    const scheduled = [];
    const options = {
        getActiveSessions: () => activeSessions,
        getProviders: () => providersForTest,
        getSessionKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        scheduleRefresh: reason => scheduled.push(reason),
        nowMs: () => 1000,
    };
    assert.strictEqual(Object.prototype.hasOwnProperty.call(options, 'isEnabled'), false);
    const controller = new AiSessionExecutionController(options);

    await controller.evaluate();
    assert.deepStrictEqual(scheduled, ['execution']);
    assert.deepStrictEqual(providerCalls.codex, [[{ sessionId: 'session-a', runStartedAtMs: 900 }]]);
    assert.deepStrictEqual(providerCalls.kimi, []);
    assert.deepStrictEqual(providerCalls.claude, []);
    assert.strictEqual(controller.getSnapshot()['codex:session-a'].state, 'running');

    await controller.evaluate();
    assert.deepStrictEqual(scheduled, ['execution'], 'repeating a signal does not schedule a refresh');

    signal = {
        token: 'codex:stop:session-a',
        phase: 'needsAttention',
        reason: 'completed',
        executionState: 'stopped',
        occurredAtMs: 1200,
    };
    await controller.evaluate();
    assert.deepStrictEqual(scheduled, ['execution', 'execution']);
    assert.strictEqual(controller.getSnapshot()['codex:session-a'].state, 'stopped');

    activeSessions = [];
    await controller.evaluate();
    assert.deepStrictEqual(controller.getSnapshot(), {});
    assert.deepStrictEqual(scheduled, ['execution', 'execution', 'execution'],
        'removing a tracked session must publish the stopped cross-window state');
    assert.strictEqual(providerCalls.codex.length, 3, 'providers without active requests are not queried');
    assert.deepStrictEqual(providerCalls.kimi, []);
    assert.deepStrictEqual(providerCalls.claude, []);

    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'executionController.ts'), 'utf8');
    assert.ok(!source.includes('isEnabled'), 'execution controller has no attention enablement option');
    assert.ok(!source.toLowerCase().includes('attention'), 'execution controller never reads attention configuration');
}

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

async function runAiSessionArchiveRuntimeChecks() {
    const archiveCardId = '__currentWorkspace-archive';
    const archiveWorkspaceTarget = {
        cardId: archiveCardId,
        workspace: {
            scopeIdentity: 'scope:/work/a',
            navigationIdentity: 'navigation:/work/a',
        },
        sessions: {
            activeProvider: 'codex',
            workspaceScopeIdentity: 'scope:/work/a',
            workspaceNavigationIdentity: 'navigation:/work/a',
            sessionsByProvider: { codex: [{ id: 'session-a', name: 'Session A' }] },
        },
    };
    const runtime = {
        identity: createTestAiSessionRuntimeIdentity(
            'codex', '/work/a', { sessionId: 'session-a' }
        ),
        backend: 'tmux', state: 'active', markerPath: '/tmp/runtime.marker',
        runStartedAtMs: 900, attached: false,
        tmux: { layout: 'project', sessionName: 'project-steward-p-a', windowName: 'ai-codex-a' },
    };
    const warnings = [];
    const focused = [];
    let confirmCount = 0;
    let archiveCount = 0;
    const controller = new AiSessionArchiveController({
        isProviderId: value => value === 'codex',
        getProvider: () => ({
            label: 'Codex',
            service: { archiveSession: () => { archiveCount++; return true; } },
        }),
        getProviderLabel: () => 'Codex',
        getOpenProjects: () => [],
        getWorkspaceTarget: cardId => cardId === archiveCardId ? archiveWorkspaceTarget : null,
        getProjectSessions: () => [],
        getRuntimeById: (providerId, sessionId) => providerId === 'codex' && sessionId === 'session-a'
            ? runtime : null,
        isRuntimeComplete: candidate => candidate.state === 'completed',
        focusRuntime: candidate => { focused.push({ ...candidate.identity }); },
        deleteRuntimeMarker: () => undefined,
        untrackRuntime: () => undefined,
        deletePin: () => undefined,
        deleteAlias: () => undefined,
        confirmSingleArchive: async () => { confirmCount++; return 'Archive'; },
        confirmBatchArchive: async () => undefined,
        showWarningMessage: message => warnings.push(message),
        showErrorMessage: () => undefined,
        showInformationMessage: () => undefined,
        appendLine: () => undefined,
        postCompletion: () => undefined,
        refresh: () => undefined,
        syncActiveRuntime: () => undefined,
        logUnexpectedError: () => undefined,
    });

    await controller.archiveSession(archiveCardId, 'codex', 'session-a');
    assert.strictEqual(confirmCount, 0, 'an active detached tmux runtime blocks archive before confirmation');
    assert.strictEqual(archiveCount, 0, 'an active detached tmux runtime is never archived');
    assert.strictEqual(warnings.length, 1);
    assert.deepStrictEqual(focused, [createTestAiSessionRuntimeIdentity(
        'codex', '/work/a', { sessionId: 'session-a' }
    )]);

    runtime.state = 'conflict';
    await controller.archiveSession(archiveCardId, 'codex', 'session-a');
    assert.strictEqual(confirmCount, 0, 'a discovery collision blocks archive before confirmation');
    assert.strictEqual(archiveCount, 0, 'a discovery collision performs zero destructive archive actions');

    runtime.state = 'stopped';
    await controller.archiveSession(archiveCardId, 'codex', 'session-a');
    assert.strictEqual(confirmCount, 1, 'a stopped runtime no longer owns the archive guard');
    assert.strictEqual(archiveCount, 1, 'a stopped runtime can be archived');

    const createFreshArchiveController = options => {
        let currentRuntime = null;
        let refreshCount = 0;
        const refreshIdentities = [];
        let freshConfirmCount = 0;
        let freshArchiveCount = 0;
        const freshController = new AiSessionArchiveController({
            isProviderId: value => value === 'codex',
            getProvider: () => ({
                label: 'Codex',
                service: { archiveSession: () => { freshArchiveCount++; return true; } },
            }),
            getProviderLabel: () => 'Codex', getOpenProjects: () => [], getProjectSessions: () => [],
            getWorkspaceTarget: cardId => cardId === archiveCardId ? archiveWorkspaceTarget : null,
            getRuntimeById: () => currentRuntime,
            refreshRuntimeGuard: async (providerId, sessionId) => {
                refreshCount++;
                refreshIdentities.push([providerId, sessionId]);
                currentRuntime = options.runtimeAfterRefresh(refreshCount);
            },
            isRuntimeComplete: candidate => candidate.state === 'completed',
            focusRuntime: () => undefined, deleteRuntimeMarker: () => undefined,
            untrackRuntime: () => undefined, deletePin: () => undefined, deleteAlias: () => undefined,
            confirmSingleArchive: async () => { freshConfirmCount++; return 'Archive'; },
            confirmBatchArchive: async () => undefined,
            showWarningMessage: () => undefined, showErrorMessage: () => undefined,
            showInformationMessage: () => undefined, appendLine: () => undefined,
            postCompletion: () => undefined, refresh: () => undefined,
            syncActiveRuntime: () => undefined, logUnexpectedError: () => undefined,
        });
        return {
            controller: freshController,
            state: () => ({ refreshCount, freshConfirmCount, freshArchiveCount, refreshIdentities }),
        };
    };
    const conflictRuntime = { ...runtime, state: 'conflict' };
    const beforeConfirmation = createFreshArchiveController({
        runtimeAfterRefresh: () => conflictRuntime,
    });
    await beforeConfirmation.controller.archiveSession(archiveCardId, 'codex', 'session-a');
    assert.deepStrictEqual(beforeConfirmation.state(), {
        refreshCount: 1, freshConfirmCount: 0, freshArchiveCount: 0,
        refreshIdentities: [['codex', 'session-a']],
    }, 'archive must force-refresh and block a newly discovered collision before confirmation');

    const afterConfirmation = createFreshArchiveController({
        runtimeAfterRefresh: count => count === 1 ? null : conflictRuntime,
    });
    await afterConfirmation.controller.archiveSession(archiveCardId, 'codex', 'session-a');
    assert.deepStrictEqual(afterConfirmation.state(), {
        refreshCount: 2, freshConfirmCount: 1, freshArchiveCount: 0,
        refreshIdentities: [['codex', 'session-a'], ['codex', 'session-a']],
    }, 'archive must revalidate after confirmation and perform no destructive action on a new collision');
}

async function runWorkspaceCardActionControllerIntegrationChecks() {
    const workspace = {
        navigationIdentity: 'navigation-workspace-card', scopeIdentity: 'scope-workspace-card',
        kind: 'savedMultiRoot', displayName: 'Workspace Card',
        navigationUri: 'file:///work/workspace.code-workspace', environment: 'local',
        roots: [
            { id: 'root-web', name: 'Web', uri: 'file:///work/web', hostPath: '/work/web', ordinal: 0 },
            { id: 'root-api', name: 'API', uri: 'file:///work/api', hostPath: '/work/api', ordinal: 1 },
        ],
    };
    const session = { id: 'session-id', name: 'Readable Session Alias', cwd: '/work/api' };
    const target = {
        cardId: '__currentWorkspace-card', workspace,
        sessions: {
            workspaceScopeIdentity: workspace.scopeIdentity,
            workspaceNavigationIdentity: workspace.navigationIdentity,
            activeProvider: 'codex', expanded: false,
            providers: [{ id: 'codex', label: 'Codex', count: 1 }],
            sessionsByProvider: { codex: [session] }, unavailableProviders: [],
            aiSessionCount: 1, attentionCount: 0, defaultTab: 'sessions', activeSessions: [{
                key: 'codex:active-card', provider: 'codex', sessionId: 'active-card', name: 'Active Card',
                executionState: 'running', status: 'running', focused: false, needsAttention: false,
                pending: false, backend: 'vscode', attached: true,
            }],
            activeSessionCount: 1, activeAttentionCount: 0,
        },
    };
    let legacyProjectReads = 0;
    const expandedWrites = [];
    const providerWrites = [];
    const commandController = new AiSessionCommandController({
        getOpenProjects: () => { legacyProjectReads++; return []; },
        getWorkspaceTarget: cardId => cardId === target.cardId ? target : null,
        getProjectKey: () => { throw new Error('must not select a root Project'); },
        getOpenWorkspace: () => workspace,
        getActiveEditorUri: () => ({ fsPath: '/work/web/file.ts' }),
        isWorkspaceTrusted: () => true,
        getProvider: () => ({ id: 'codex', label: 'Codex', commandName: 'codex' }),
        getProviderDirectoryCapability: async () => ({ status: 'supported' }),
        getPrimaryRootId: () => null,
        pickWorkspaceRoot: async () => 'root-web',
        isDirectory: () => true,
        isProviderId: value => value === 'codex',
        setExpanded: async (...args) => expandedWrites.push(args),
        setActiveProvider: async (...args) => providerWrites.push(args),
        togglePin: () => false, getAliases: () => ({}), saveAliases: () => undefined,
        getOriginalName: () => null, getSessionKey: () => '', showInputBox: async () => undefined,
        writeClipboard: async () => undefined, showInformationMessage: () => undefined,
        showWarningMessage: () => undefined, refresh: () => undefined,
    });
    await commandController.toggleSessionsExpanded(target.cardId, true);
    await commandController.selectProvider(target.cardId, 'codex');
    assert.deepStrictEqual(expandedWrites, [[workspace.scopeIdentity, true]]);
    assert.deepStrictEqual(providerWrites, [[workspace.scopeIdentity, 'codex']]);

    const createRequests = [];
    const creation = new AiSessionCreationController({
        isProviderId: value => value === 'codex', getOpenProjects: () => { legacyProjectReads++; return []; },
        getWorkspaceTarget: cardId => cardId === target.cardId ? target : null,
        pickWorkspaceRoot: async () => 'root-web',
        pickProvider: async () => 'codex', getProviderLabel: () => 'Codex',
        getProvider: () => ({ label: 'Codex', terminalNamePrefix: 'Codex',
            buildNewSessionLaunchSpec: scope => ({ executable: 'codex', args: [], cwd: scope.primaryCwd }) }),
        resolveDirectoryScope: () => { throw new Error('must not resolve a root Project'); },
        resolveWorkspaceDirectoryScope: (resolved, providerId, rootId) =>
            commandController.resolveWorkspaceDirectoryScope(resolved.workspace, providerId, undefined, rootId),
        runtimeCoordinator: { create: async request => { createRequests.push(request); return { status: 'started', runtime: {} }; },
            getActive: () => [], getPending: () => [] },
        createPendingId: () => 'pending-workspace-card',
        showInputBox: async () => 'Investigate replication',
        showActiveTab: async () => undefined, announceStatus: async () => undefined,
        showWarningMessage: async () => undefined, refresh: () => undefined,
        getExistingSessionIdsForCwd: () => [], getPendingMarkerPath: () => '/tmp/card.marker',
        scheduleNewSessionRefresh: () => undefined, nowMs: () => 1,
    });
    await creation.createSession(target.cardId);
    assert.strictEqual(createRequests[0].identity.workspaceScopeIdentity, workspace.scopeIdentity);
    assert.strictEqual(createRequests[0].projectName, 'Workspace Card');
    assert.strictEqual(createRequests[0].title, 'Investigate replication');

    const resumeRequests = [];
    const resume = new AiSessionResumeController({
        getOpenProjects: () => { legacyProjectReads++; return []; },
        getWorkspaceTarget: cardId => cardId === target.cardId ? target : null,
        getProvider: () => ({ label: 'Codex', terminalEnvKey: 'CODEX_SESSION_ID',
            buildResumeLaunchSpec: (_id, scope) => ({ executable: 'codex', args: [], cwd: scope.primaryCwd }) }),
        getProjectSession: () => { throw new Error('must not select a root Project session'); },
        resolveDirectoryScope: () => { throw new Error('must not resolve a root Project'); },
        resolveWorkspaceDirectoryScope: (resolved, resolvedSession, providerId, rootId) =>
            commandController.resolveWorkspaceDirectoryScope(resolved.workspace, providerId, resolvedSession, rootId),
        runtimeCoordinator: { resume: async request => { resumeRequests.push(request); return { status: 'started', runtime: {} }; } },
        getTerminalName: () => 'Codex: Card Session', getMarkerPath: () => '/tmp/card.marker',
        showWarningMessage: () => undefined, refresh: () => undefined,
        showActiveTab: async () => undefined, announceStatus: async () => undefined,
    });
    await resume.resumeProjectSession(target.cardId, 'codex', session.id);
    assert.strictEqual(resumeRequests[0].identity.workspaceScopeIdentity, workspace.scopeIdentity);
    assert.strictEqual(resumeRequests[0].projectName, 'Workspace Card');
    assert.strictEqual(resumeRequests[0].sessionName, 'Readable Session Alias');
    assert.strictEqual(resumeRequests[0].identity.sessionId, 'session-id');

    const focused = [];
    const runtime = { identity: createTestAiSessionRuntimeIdentity('codex', '/work/api', {
        sessionId: 'active-card', workspaceScopeIdentity: workspace.scopeIdentity,
        workspaceNavigationIdentity: workspace.navigationIdentity,
        workspaceRootHostPaths: ['/work/web', '/work/api'],
    }), backend: 'vscode', state: 'active', markerPath: '/tmp/card.marker', runStartedAtMs: 1, attached: true,
        terminal: { show() {}, dispose() {} } };
    const terminalController = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex', getOpenProjects: () => { legacyProjectReads++; return []; },
        getWorkspaceTarget: cardId => cardId === target.cardId ? target : null,
        getProjectSessions: () => { throw new Error('must not select root sessions'); },
        getProjectCwd: () => { throw new Error('must not select a root cwd'); }, normalizePath: value => value,
        runtimeCoordinator: { getById: () => runtime, getPending: () => [],
            focus: async identity => focused.push(identity), detach: async () => undefined },
        getWorkspaceScopeIdentity: () => workspace.scopeIdentity,
        confirmRuntimeClose: async () => undefined, announceStatus: async () => undefined,
        showErrorMessage: async () => undefined, getProviderLabel: () => 'Codex', refresh: () => undefined,
    });
    await terminalController.focusActive(target.cardId, 'codex', 'active-card');
    assert.strictEqual(focused[0].workspaceScopeIdentity, workspace.scopeIdentity);

    const archived = [];
    let currentArchiveTarget = target;
    let onSingleArchiveConfirmation = () => undefined;
    const archive = new AiSessionArchiveController({
        isProviderId: value => value === 'codex', getProvider: () => ({ label: 'Codex', service: {
            archiveSession: id => { archived.push(id); return true; },
        } }), getProviderLabel: () => 'Codex',
        getOpenProjects: () => { legacyProjectReads++; return []; },
        getWorkspaceTarget: cardId => cardId === currentArchiveTarget?.cardId ? currentArchiveTarget : null,
        getProjectSessions: () => { throw new Error('must not select root sessions'); },
        getRuntimeById: () => null, isRuntimeComplete: () => true, focusRuntime: () => undefined,
        deleteRuntimeMarker: () => undefined, untrackRuntime: () => undefined,
        deletePin: () => undefined, deleteAlias: () => undefined,
        confirmSingleArchive: async () => { onSingleArchiveConfirmation(); return 'Archive'; },
        confirmBatchArchive: async () => 'Archive',
        showWarningMessage: () => undefined, showErrorMessage: () => undefined,
        showInformationMessage: () => undefined, appendLine: () => undefined,
        postCompletion: () => undefined, refresh: () => undefined,
        syncActiveRuntime: () => undefined, logUnexpectedError: error => { throw error; },
    });
    await archive.archiveSessions(target.cardId, 'codex', [session.id]);
    assert.deepStrictEqual(archived, [session.id]);
    archived.length = 0;

    await archive.archiveSession(target.cardId, 'codex', session.id);
    assert.deepStrictEqual(archived, [session.id], 'a valid v2 single archive must reach the provider');
    archived.length = 0;

    await archive.archiveSession(target.cardId, 'codex', 'forged-session');
    await archive.archiveSession('__currentWorkspace-forged', 'codex', session.id);
    assert.deepStrictEqual(archived, [], 'unknown v2 sessions and cards must not reach the provider');

    onSingleArchiveConfirmation = () => {
        currentArchiveTarget = {
            ...target,
            workspace: { ...workspace, scopeIdentity: 'scope-replaced-during-confirmation' },
            sessions: { ...target.sessions, workspaceScopeIdentity: 'scope-replaced-during-confirmation' },
        };
    };
    await archive.archiveSession(target.cardId, 'codex', session.id);
    assert.deepStrictEqual(archived, [], 'a workspace change during confirmation must cancel archive');

    currentArchiveTarget = target;
    onSingleArchiveConfirmation = () => {
        currentArchiveTarget = {
            ...target,
            sessions: { ...target.sessions, sessionsByProvider: { codex: [] } },
        };
    };
    await archive.archiveSession(target.cardId, 'codex', session.id);
    assert.deepStrictEqual(archived, [], 'a session disappearing during confirmation must cancel archive');
    assert.strictEqual(legacyProjectReads, 0, 'v2 current-card actions must never select a member Project');
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
    let completionCount = 0;
    let completedResolution = null;
    let timers = [];
    const resolutions = new Map([
        [terminalA, { terminal: terminalA, provider: 'codex', sessionId: 'a', workspaceScopeIdentity: 'scope-a', entry: { markerPath: 'a.done' } }],
        [terminalB, { terminal: terminalB, provider: 'kimi', sessionId: 'b', workspaceScopeIdentity: 'scope-b', entry: { markerPath: 'b.done' } }],
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
    assert.deepStrictEqual(published.pop(), { provider: 'codex', sessionId: 'a', workspaceScopeIdentity: 'scope-a' });
    const firstIdentity = highlighter.getIdentity();
    assert.deepStrictEqual(firstIdentity, { provider: 'codex', sessionId: 'a', workspaceScopeIdentity: 'scope-a' });
    firstIdentity.sessionId = 'mutated';
    assert.deepStrictEqual(highlighter.getIdentity(), { provider: 'codex', sessionId: 'a', workspaceScopeIdentity: 'scope-a' });
    assert.strictEqual(timers.filter(timer => timer.active).length, 1);

    activeTerminal = terminalB;
    highlighter.sync();
    assert.deepStrictEqual(published.pop(), { provider: 'kimi', sessionId: 'b', workspaceScopeIdentity: 'scope-b' });
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
    assert.deepStrictEqual(published.pop(), { provider: 'codex', sessionId: 'a', workspaceScopeIdentity: 'scope-a' });
    assert.strictEqual(timers.filter(timer => timer.active).length, 1);

    resolutions.delete(terminalA);
    highlighter.sync();
    assert.strictEqual(published.pop(), null);
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);

    highlighter.dispose();
    assert.strictEqual(timers.filter(timer => timer.active).length, 0);
}

async function runTmuxFocusedRuntimeMonitorChecks() {
    let visible = true;
    const terminal = { name: 'Project tmux attach' };
    let activeTerminal = terminal;
    const timers = [];
    const refreshes = [];
    const errors = [];
    let syncCalls = 0;
    let resolveSync;
    let rejectSync;
    const monitor = new TmuxFocusedRuntimeMonitor({
        isVisible: () => visible,
        getActiveTerminal: () => activeTerminal,
        syncFocusedRuntime: () => {
            syncCalls++;
            return new Promise((resolve, reject) => {
                resolveSync = resolve;
                rejectSync = reject;
            });
        },
        refresh: () => refreshes.push('refresh'),
        onError: error => errors.push(error),
        setInterval: (callback, intervalMs) => {
            const handle = { callback, intervalMs, active: true };
            timers.push(handle);
            return handle;
        },
        clearInterval: handle => { handle.active = false; },
    });
    monitor.start();
    monitor.start();
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].intervalMs, 1_000);
    const first = monitor.request();
    const joined = monitor.request();
    assert.strictEqual(first, joined);
    assert.strictEqual(syncCalls, 1);
    resolveSync({ monitored: true, changed: true, identity: {
        ...createTestAiSessionRuntimeIdentity('codex', '/work/app', { sessionId: 's1' }),
    } });
    await first;
    assert.deepStrictEqual(refreshes, ['refresh']);

    const unchanged = monitor.request();
    resolveSync({ monitored: true, changed: false, identity: null });
    await unchanged;
    assert.deepStrictEqual(refreshes, ['refresh']);

    visible = false;
    const callsBeforeHidden = syncCalls;
    await monitor.request();
    timers[0].callback();
    await Promise.resolve();
    assert.strictEqual(syncCalls, callsBeforeHidden);

    visible = true;
    activeTerminal = terminal;
    const staleTerminal = monitor.request();
    activeTerminal = { name: 'Other terminal' };
    resolveSync({ monitored: true, changed: true, identity: null });
    await staleTerminal;
    assert.deepStrictEqual(refreshes, ['refresh'],
        'a result for a no-longer-active terminal must not refresh');

    activeTerminal = terminal;
    const rejected = monitor.request();
    rejectSync(new Error('private tmux query failure'));
    await rejected;
    assert.strictEqual(errors.length, 1);

    const disposedRequest = monitor.request();
    monitor.dispose();
    resolveSync({ monitored: true, changed: true, identity: null });
    await disposedRequest;
    assert.strictEqual(timers[0].active, false);
    assert.deepStrictEqual(refreshes, ['refresh']);
    const callsAfterDispose = syncCalls;
    await monitor.request();
    assert.strictEqual(syncCalls, callsAfterDispose);
}

function runAiSessionTerminalResolutionChecks() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-active-terminal-'));
    try {
        const service = new AiSessionTerminalService(tempRoot, providers.AI_SESSION_PROVIDER_IDS.map(providerId =>
            providers.getAiSessionProviderDefinition(providerId)), 0
        );
        const scopedA = { name: 'Codex: Shared A', creationOptions: {}, processId: Promise.resolve(42101) };
        const scopedB = { name: 'Codex: Shared B', creationOptions: {}, processId: Promise.resolve(42102) };
        service.track('codex', 'shared-session', {
            terminal: scopedA, markerPath: path.join(tempRoot, 'shared-a.done'), runStartedAtMs: 1,
            runtimeIdentity: createTestAiSessionRuntimeIdentity('codex', '/work/a', {
                sessionId: 'shared-session',
            }),
        });
        service.track('codex', 'shared-session', {
            terminal: scopedB, markerPath: path.join(tempRoot, 'shared-b.done'), runStartedAtMs: 2,
            runtimeIdentity: createTestAiSessionRuntimeIdentity('codex', '/work/b', {
                sessionId: 'shared-session',
            }),
        });
        assert.strictEqual(service.getTrackedTerminalEntries().filter(entry =>
            entry.provider === 'codex' && entry.sessionId === 'shared-session').length, 2,
        'same provider/session Direct runtimes in separate scopes must coexist');
        assert.strictEqual(service.getById('codex', 'shared-session', 'scope:/work/a').terminal, scopedA);
        assert.strictEqual(service.getById('codex', 'shared-session', 'scope:/work/b').terminal, scopedB);
        service.releaseCompletedSession('codex', 'shared-session', 'scope:/work/a');
        assert.strictEqual(service.getActiveById('codex', 'shared-session', 'scope:/work/a'), null);
        assert.strictEqual(service.getActiveById('codex', 'shared-session', 'scope:/work/b').terminal, scopedB,
            'releasing one scope must leave the identical Direct runtime in the other scope active');
        service.handleClosedTerminal(scopedA);
        const tracked = { name: 'Codex: One [session-]', creationOptions: {} };
        service.track('codex', 'session-one', {
            terminal: tracked,
            markerPath: path.join(tempRoot, 'session-one.done'),
            runtimeIdentity: createTestAiSessionRuntimeIdentity(
                'codex', '/work/app', { sessionId: 'session-one' }
            ),
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
        service.track('codex', 'session-env', {
            terminal: byEnv,
            markerPath: recoveredMarkerPath,
            runStartedAtMs: Date.now(),
            runtimeIdentity: createTestAiSessionRuntimeIdentity(
                'codex', '/work/app', { sessionId: 'session-env' }
            ),
        });

        const recoveredByEnv = service.resolveTerminalSession(byEnv, getCandidates);
        assert.strictEqual(recoveredByEnv.sessionId, 'session-env');
        assert.strictEqual(Number.isFinite(recoveredByEnv.entry.runStartedAtMs), true);
        assert.strictEqual(service.isComplete(recoveredByEnv.entry), false, 'marker older than recovered run is ignored');
        const currentMarkerAt = new Date(recoveredByEnv.entry.runStartedAtMs + 1000);
        fs.utimesSync(recoveredMarkerPath, currentMarkerAt, currentMarkerAt);
        assert.strictEqual(service.isComplete(recoveredByEnv.entry), true, 'marker written during current run completes it');
        assert.deepStrictEqual(
            service.getCompletedSessions().map(item => `${item.provider}:${item.sessionId}`),
            ['codex:session-env'],
            'completed terminals must be discoverable without being active or visible'
        );
        assert.deepStrictEqual(candidateCalls, []);

        service.releaseCompletedSession('codex', 'session-env', 'scope:/work/app');
        assert.strictEqual(fs.existsSync(recoveredMarkerPath), false, 'releasing a completed session removes its marker');
        const releasedByEnv = service.getById('codex', 'session-env', 'scope:/work/app');
        assert.strictEqual(releasedByEnv.terminal, byEnv, 'a completed shell remains available for an explicit resume');
        assert.strictEqual(service.isComplete(releasedByEnv), true, 'a released shell must take the resume path');
        assert.strictEqual(
            service.getActiveById('codex', 'session-env', 'scope:/work/app'),
            null,
            'released shells must not generate a second terminal-exit attention event'
        );
        assert.deepStrictEqual(
            service.getReleasedSessions(),
            [{ provider: 'codex', sessionId: 'session-env', workspaceScopeIdentity: 'scope:/work/app' }],
            'released sessions must remain discoverable for stale bridge-event recovery'
        );
        candidateCalls.length = 0;
        assert.strictEqual(service.resolveTerminalSession(byEnv, getCandidates), null, 'active terminal resolution must ignore a completed shell');
        assert.deepStrictEqual(candidateCalls, []);

        candidateCalls.length = 0;
        assert.strictEqual(service.resolveTerminalSession(archivedByEnv, getCandidates), null);
        assert.deepStrictEqual(candidateCalls, []);

        candidateCalls.length = 0;
        assert.strictEqual(service.resolveTerminalSession(byName, getCandidates), null,
            'unowned terminal name inference must not create a v2 runtime identity');
        assert.deepStrictEqual(candidateCalls, []);

        candidateCalls.length = 0;
        assert.strictEqual(service.resolveTerminalSession(ordinary, getCandidates), null);
        assert.deepStrictEqual(candidateCalls, []);

        const pending = { name: 'Codex: Pending', creationOptions: {}, processId: Promise.resolve(42099) };
        service.trackPending({
            provider: 'codex',
            terminal: pending,
            markerPath: path.join(tempRoot, 'pending.done'),
            cwd: '/work/app',
            createdAt: new Date().toISOString(),
            excludedSessionIds: [],
        }, false);
        assert.strictEqual(service.getPendingTerminals().length, 1);
        assert.deepStrictEqual(service.handleClosedTerminal(pending), []);
        assert.strictEqual(service.getPendingTerminals().length, 0, 'closing a Terminal removes its unresolved pending row');

        assert.deepStrictEqual(
            service.handleClosedTerminal(tracked),
            [{ provider: 'codex', sessionId: 'session-one', workspaceScopeIdentity: 'scope:/work/app' }],
            'closing a tracked terminal must identify the session whose attention should be acknowledged'
        );
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
        ...createTestAiSessionTerminalBindingIdentity(
            'codex', '/work/app', { pendingId: 'pending-store' }
        ),
        markerPath: '/tmp/pending.done',
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
    const validPendingRecord = JSON.parse(JSON.stringify(
        stateData[AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX + processId]
    ));
    for (const [offset, invalid] of [
        [1, { ...validPendingRecord, sessionId: 'also-bound' }],
        [2, { ...validPendingRecord, projectKey: 'legacy' }],
        [3, { ...validPendingRecord, unexpected: true }],
        [4, (() => { const value = { ...validPendingRecord }; delete value.updatedAtMs; return value; })()],
    ]) {
        const invalidId = processId + offset;
        stateData[AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX + invalidId] = invalid;
        assert.strictEqual(new AiSessionTerminalBindingStore(state).get(invalidId), null,
            'v2 terminal bindings must reject both IDs, missing fields, legacy fields, and extras');
    }

    const second = new AiSessionTerminalBindingStore(state);
    second.setBound(processId, {
        ...createTestAiSessionTerminalBindingIdentity(
            'codex', '/work/app', { sessionId: 'session-new' }
        ),
        markerPath: '/tmp/session-new.done',
        runStartedAtMs: 1784102400000,
    });
    await second.flush();
    assert.strictEqual(new AiSessionTerminalBindingStore(state).get(processId).sessionId, 'session-new');
    assert.strictEqual(new AiSessionTerminalBindingStore(state).get(processId).cwd, '/work/app');

    const legacyBoundProcessId = 42010;
    stateData[AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX + legacyBoundProcessId] = {
        version: 1,
        state: 'bound',
        providerId: 'kimi',
        projectKey: '/work/app',
        cwd: '/work/app',
        sessionId: 'legacy-session',
        markerPath: '/tmp/legacy.done',
        runStartedAtMs: 10,
        updatedAtMs: 11,
    };
    assert.strictEqual(new AiSessionTerminalBindingStore(state).get(legacyBoundProcessId), null,
        'v1 terminal bindings are ignored rather than migrated');

    const released = new AiSessionTerminalBindingStore(state);
    released.setReleased(processId, {
        ...createTestAiSessionTerminalBindingIdentity(
            'codex', '/work/app', { sessionId: 'session-new' }
        ),
        markerPath: '/tmp/session-new.done',
    });
    await released.flush();
    assert.deepStrictEqual(new AiSessionTerminalBindingStore(state).get(processId), {
        version: 2,
        state: 'released',
        ...createTestAiSessionTerminalBindingIdentity(
            'codex', '/work/app', { sessionId: 'session-new' }
        ),
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
        ...createTestAiSessionTerminalBindingIdentity(
            'codex', '/work/app', { sessionId: 'left' }
        ),
        markerPath: '/tmp/left.done', runStartedAtMs: 1,
    });
    rightStore.setBound(Promise.resolve(rightProcessId), {
        ...createTestAiSessionTerminalBindingIdentity(
            'codex', '/work/app', { sessionId: 'right' }
        ),
        markerPath: '/tmp/right.done', runStartedAtMs: 2,
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
        ...createTestAiSessionTerminalBindingIdentity(
            'codex', '/work/app', { sessionId: 'first' }
        ),
        markerPath: '/tmp/first.done', runStartedAtMs: 1,
    });
    failingStore.setBound(42005, {
        ...createTestAiSessionTerminalBindingIdentity(
            'codex', '/work/app', { sessionId: 'second' }
        ),
        markerPath: '/tmp/second.done', runStartedAtMs: 2,
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
        ...createTestAiSessionTerminalBindingIdentity(
            'codex', '/work/app', { pendingId: 'pending-deferred' }
        ),
        markerPath: '/tmp/deferred.done',
        createdAt: new Date().toISOString(), excludedSessionIds: [],
    });
    orderedStore.setBound(deferredProcessId, {
        ...createTestAiSessionTerminalBindingIdentity(
            'codex', '/work/app', { sessionId: 'deferred-session' }
        ),
        markerPath: '/tmp/deferred.done', runStartedAtMs: 4,
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
        ...createTestAiSessionTerminalBindingIdentity(
            'codex', '/work/app', { pendingId: 'pending-stalled' }
        ),
        markerPath: '/tmp/stalled.done',
        createdAt: new Date().toISOString(), excludedSessionIds: [],
    });
    stalledStore.setBound(42006, {
        ...createTestAiSessionTerminalBindingIdentity(
            'codex', '/work/app', { sessionId: 'after-stall' }
        ),
        markerPath: '/tmp/after-stall.done', runStartedAtMs: 3,
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
            runtimeIdentity: createTestAiSessionRuntimeIdentity(
                'codex', '/work/app', { pendingId: 'pending-retry' }
            ),
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
            createTestAiSessionDirectoryScope('/work/app'),
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
            runtimeIdentity: createTestAiSessionRuntimeIdentity(
                'codex', '/work/app', { pendingId: 'pending-persisted' }
            ),
            createdAt,
            excludedSessionIds: [],
            projectName: 'Workspace Card',
            title: 'App',
        });
        const pendingIdentityCopy = firstService.getPendingTerminals()[0].runtimeIdentity;
        pendingIdentityCopy.workspaceRootHostPaths[0] = '/mutated-by-caller';
        assert.strictEqual(
            firstService.getPendingTerminals()[0].runtimeIdentity.workspaceRootHostPaths[0],
            '/work/app',
            'pending terminal reads must defensively clone the runtime root snapshot'
        );
        await firstStore.flush();

        const legacyPendingProcessId = 42012;
        const persistedPendingKey = AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX + processId;
        const legacyPendingRecord = JSON.parse(JSON.stringify(stateData[persistedPendingKey]));
        legacyPendingRecord.pendingId = 'pending-legacy-no-project-name';
        delete legacyPendingRecord.projectName;
        stateData[AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX + legacyPendingProcessId]
            = legacyPendingRecord;

        const restoredPendingTerminal = {
            ...created,
            creationOptions: { name: created.name, cwd: '/work/app' },
            processId: Promise.resolve(processId),
        };
        const legacyPendingTerminal = {
            ...created,
            name: 'Codex: Legacy pending',
            creationOptions: { name: 'Codex: Legacy pending', cwd: '/work/app' },
            processId: Promise.resolve(legacyPendingProcessId),
        };
        const secondStore = new AiSessionTerminalBindingStore(state);
        const secondService = new AiSessionTerminalService(tempRoot, terminalProviders, 0, undefined, secondStore);
        await secondService.restorePersistedTerminals([restoredPendingTerminal, legacyPendingTerminal]);
        assert.strictEqual(secondService.getPendingTerminals().length, 2);
        assert.strictEqual(secondService.getPendingTerminals()[0].terminal, restoredPendingTerminal);
        const restoredDirectBackend = new DirectTerminalRuntimeBackend(secondService);
        assert.strictEqual(restoredDirectBackend.getPending().find(runtime =>
            runtime.identity.pendingId === 'pending-persisted').projectName, 'Workspace Card');
        assert.strictEqual(restoredDirectBackend.getPending().find(runtime =>
            runtime.identity.pendingId === 'pending-legacy-no-project-name').projectName, undefined,
            'pre-change Direct pending bindings without projectName must remain restorable');
        secondService.removePendingForTerminal(legacyPendingTerminal);
        await secondStore.flush();

        const timedOutProcessId = 42011;
        const timedOutCreatedAt = new Date(Date.parse(createdAt) + 1).toISOString();
        const timedOutTerminal = {
            name: 'Kimi: Timed out',
            creationOptions: { name: 'Kimi: Timed out', cwd: '/work/app' },
            processId: Promise.resolve(timedOutProcessId),
            disposeCalls: 0,
            dispose() { this.disposeCalls++; },
        };
        secondService.trackPending({
            provider: 'kimi',
            terminal: timedOutTerminal,
            markerPath: path.join(tempRoot, 'timed-out.done'),
            cwd: '/work/app',
            runtimeIdentity: createTestAiSessionRuntimeIdentity(
                'kimi', '/work/app', { pendingId: 'pending-timeout' }
            ),
            createdAt: timedOutCreatedAt,
            excludedSessionIds: [],
        });
        await secondStore.flush();
        assert.strictEqual(secondService.hasPending('kimi', timedOutCreatedAt), true);
        secondService.removePending('kimi', timedOutCreatedAt);
        await secondStore.flush();
        assert.strictEqual(secondService.hasPending('kimi', timedOutCreatedAt), false);
        assert.strictEqual(timedOutTerminal.disposeCalls, 0);
        assert.strictEqual(secondStore.get(timedOutProcessId), null);

        secondService.track('codex', 'session-new', {
            terminal: restoredPendingTerminal,
            markerPath: path.join(tempRoot, 'session-new.done'),
            runStartedAtMs: 1784102400000,
            cwd: '/work/app',
            runtimeIdentity: createTestAiSessionRuntimeIdentity(
                'codex', '/work/app', { sessionId: 'session-new' }
            ),
        });
        await secondStore.flush();

        const restoredBoundTerminal = {
            ...restoredPendingTerminal,
            creationOptions: {
                name: restoredPendingTerminal.name,
                cwd: '/work/app',
                env: { PROJECT_STEWARD_CODEX_SESSION_ID: 'session-new' },
            },
            processId: Promise.resolve(processId),
        };
        const thirdStore = new AiSessionTerminalBindingStore(state);
        const thirdService = new AiSessionTerminalService(tempRoot, terminalProviders, 0, undefined, thirdStore);
        await thirdService.restorePersistedTerminals([restoredBoundTerminal]);
        assert.strictEqual(thirdService.getById(
            'codex', 'session-new', 'scope:/work/app'
        ).terminal, restoredBoundTerminal);
        assert.strictEqual(thirdService.getById(
            'codex', 'session-new', 'scope:/work/app'
        ).cwd, '/work/app');
        const activeSnapshot = thirdService.getActiveSessions();
        assert.deepStrictEqual(activeSnapshot, [{
            provider: 'codex',
            sessionId: 'session-new',
            workspaceScopeIdentity: 'scope:/work/app',
            cwd: '/work/app',
            runStartedAtMs: 1784102400000,
        }]);
        activeSnapshot[0].cwd = '/mutated';
        assert.strictEqual(thirdService.getActiveSessions()[0].cwd, '/work/app');

        thirdService.releaseCompletedSession('codex', 'session-new', 'scope:/work/app');
        await thirdStore.flush();
        assert.strictEqual(new AiSessionTerminalBindingStore(state).get(processId).state, 'released');

        const releasedTerminalAfterReload = {
            ...restoredBoundTerminal,
            processId: Promise.resolve(processId),
        };
        vscodeTestState.terminals.splice(0, vscodeTestState.terminals.length, releasedTerminalAfterReload);
        const fourthStore = new AiSessionTerminalBindingStore(state);
        const fourthService = new AiSessionTerminalService(tempRoot, terminalProviders, 0, undefined, fourthStore);
        await fourthService.restorePersistedTerminals([releasedTerminalAfterReload]);
        const releasedEntryAfterReload = fourthService.getById(
            'codex', 'session-new', 'scope:/work/app'
        );
        assert.strictEqual(
            releasedEntryAfterReload.terminal,
            releasedTerminalAfterReload,
            'a released shell remains reusable after extension reload'
        );
        assert.strictEqual(
            fourthService.isComplete(releasedEntryAfterReload),
            true,
            'a restored released shell must execute resume instead of only receiving focus'
        );
        assert.deepStrictEqual(
            fourthService.getReleasedSessions(),
            [{
                provider: 'codex', sessionId: 'session-new',
                workspaceScopeIdentity: 'scope:/work/app',
            }],
            'released session recovery must survive extension reload'
        );

        fourthService.handleClosedTerminal(releasedTerminalAfterReload);
        assert.deepStrictEqual(fourthService.getReleasedSessions(), []);
        await fourthStore.flush();
        assert.strictEqual(
            new AiSessionTerminalBindingStore(state).get(processId),
            null,
            'closing a released shell removes its persisted tombstone'
        );

        const expiredProcessId = 49999;
        const expiredStore = new AiSessionTerminalBindingStore(state);
        expiredStore.setPending(expiredProcessId, {
            ...createTestAiSessionTerminalBindingIdentity(
                'codex', '/work/app', { pendingId: 'pending-expired' }
            ),
            markerPath: path.join(tempRoot, 'expired.done'),
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
            ...createTestAiSessionTerminalBindingIdentity(
                'codex', '/work/app', { sessionId: 'session-after-stalled-terminal' }
            ),
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
            timeoutService.getById(
                'codex', 'session-after-stalled-terminal', 'scope:/work/app'
            ).terminal,
            recoverableTerminal
        );

        const reusedProcessId = 50002;
        const reusedProcessStore = new AiSessionTerminalBindingStore(state);
        reusedProcessStore.setBound(reusedProcessId, {
            ...createTestAiSessionTerminalBindingIdentity(
                'codex', '/work/app', { sessionId: 'stale-session' }
            ),
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
        assert.strictEqual(reusedProcessService.getById(
            'codex', 'stale-session', 'scope:/work/app'
        ), null);
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
    assert.strictEqual(styles.includes('.workspace-root-tags'), false);
    assert.strictEqual(styles.includes('.workspace-root-tag'), false);
    assert.ok(styles.includes('@media (max-width: 280px)'));
    assert.ok(styles.includes('min-width: 0'));
    assert.ok(styles.includes('text-overflow: ellipsis'));
    assert.ok(styles.includes('overflow-x: hidden'));
    assert.ok(styles.includes('max-height: 1000px'));
    assert.ok(styles.includes('transition:\n                max-height'));
    assert.ok(compiledStyles.includes('.project .codex-sessions{display:block'));
    assert.ok(compiledStyles.includes('max-height:0'));
    assert.ok(compiledStyles.includes('opacity:0'));
    assert.ok(compiledStyles.includes('[data-codex-expanded] .codex-sessions{max-height:1000px'));
    const sessionReducedMotionStyles = extractExactScssBlock(styles, '@media (prefers-reduced-motion: reduce)');
    assert.ok(sessionReducedMotionStyles.includes('.codex-sessions'));
    assert.ok(sessionReducedMotionStyles.includes('transition: none !important'));
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    const insideProjectClick = extractFunctionBody(webviewProjectScripts, 'onInsideProjectClick');
    const attentionControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'attentionController.ts'), 'utf8');
    const attentionMonitorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'attentionMonitor.ts'), 'utf8');
    const executionControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiSessions', 'executionController.ts'), 'utf8');
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
    assert.strictEqual(sidebarStyles.includes('.project[data-current-workspace]'), false,
        'current workspace shell state must be owned by the shared item card');
    assert.strictEqual(sidebarStyles.includes('.project-border'), false,
        'sidebar projects must use the shared accent selector instead of project-specific rail geometry');
    const sidebarGroupStyleBlock = extractExactScssBlock(sidebarStyles, '.group');
    assert.ok(sidebarGroupStyleBlock.includes('grid-template-columns: minmax(0, 1fr)'),
        'sidebar groups must use a shrinkable grid track instead of their content min-width');
    assert.ok(sidebarGroupStyleBlock.includes('min-width: 0'),
        'sidebar groups must be allowed to shrink with the Webview');
    assert.ok(sidebarGroupStyleBlock.includes('max-width: 100%'),
        'sidebar groups must not exceed the visible Webview width');
    const sidebarGroupListStyleBlock = extractExactScssBlock(sidebarGroupStyleBlock, '.group-list');
    assert.ok(sidebarGroupListStyleBlock.includes('min-width: 0'),
        'sidebar group lists must not propagate card content min-width into the grid track');
    assert.ok(sidebarGroupListStyleBlock.includes('max-width: 100%'),
        'sidebar group lists must not exceed the shrinkable grid track');
    const projectContainerStyleBlock = extractExactScssBlock(sidebarStyles, '.project-container');
    assert.ok(projectContainerStyleBlock.includes('box-sizing: border-box'),
        'sidebar project gutters must be included in the project container width');
    assert.ok(projectContainerStyleBlock.includes('min-width: 0'),
        'sidebar project containers must be allowed to shrink with the Webview');
    assert.ok(projectContainerStyleBlock.includes('max-width: 100%'),
        'sidebar project containers must not exceed the visible Webview width');
    assert.ok(projectContainerStyleBlock.includes('padding: 0 2px'),
        'sidebar project containers must reserve the card outline gutter inside their width');
    const sharedItemCardBlock = extractExactScssBlock(sidebarStyles, '.steward-item-card');
    assert.ok(sharedItemCardBlock.includes('width: 100%'),
        'sidebar cards must fill the shrinkable container without percentage-plus-margin rounding');
    assert.ok(sharedItemCardBlock.includes('max-width: 100%'),
        'sidebar cards must not exceed their shrinkable container');
    assert.ok(sharedItemCardBlock.includes('min-width: 0'),
        'sidebar cards must be allowed to shrink below their content width');
    assert.ok(sharedItemCardBlock.includes('margin: 0 0 7px'),
        'sidebar card horizontal spacing must come from the border-box container gutter');
    const sharedItemAccentBlock = extractExactScssBlock(sidebarStyles, '.steward-item-accent');
    const sharedItemAccentHoverBlock = extractScssBlock(sidebarStyles, '.steward-item-card:hover .steward-item-accent');
    const projectStyleBlock = extractExactScssBlock(sidebarStyles, '.project');
    const currentWorkspaceStyleBlock = extractExactScssBlock(projectStyleBlock, '&[data-current-workspace]');
    const expandedProjectHoverBlock = extractExactScssBlock(currentWorkspaceStyleBlock, '&[data-codex-expanded]:hover');
    const expandedProjectAccentBlock = extractExactScssBlock(expandedProjectHoverBlock, '.steward-item-accent');
    const compiledSharedItemAccentBlock = extractExactCssBlock(compiledStyles, 'body.steward-sidebar .steward-item-accent');
    const compiledSharedItemAccentHoverBlock = extractExactCssBlock(compiledStyles, 'body.steward-sidebar .steward-item-card:hover .steward-item-accent');
    const compiledExpandedProjectAccentBlock = extractExactCssBlock(compiledStyles, 'body.steward-sidebar .project[data-current-workspace][data-codex-expanded]:hover .steward-item-accent');
    const currentItemCardShellBlock = extractExactScssBlock(sidebarStyles, '&[data-current-workspace]');
    const currentItemCardVisualBlock = extractExactScssBlock(sharedItemCardBlock, '&.selected');
    const compiledCurrentItemCardShellBlock = extractScssBlock(
        compiledStyles,
        'body.steward-sidebar .steward-item-card[data-current-workspace]',
    );
    const compiledCurrentItemCardVisualBlock = extractExactCssBlock(
        compiledStyles,
        'body.steward-sidebar .steward-item-card.selected',
    );
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
    const workspaceHtml = webviewContentModule.getCurrentWorkspaceGroupContent({
        id: 'workspace-a', kind: 'current', navigationIdentity: 'navigation-a', scopeIdentity: 'scope-a',
        name: 'Workspace A', environment: 'local', environmentLabel: 'Local', attentionCount: 0,
        roots: [
            { id: 'root-app', name: 'App', ordinal: 0 },
            { id: 'root-api', name: 'API', ordinal: 1 },
        ],
        aiSessions: {
            workspaceScopeIdentity: 'scope-a', workspaceNavigationIdentity: 'navigation-a',
            activeProvider: 'codex', expanded: true,
            providers: [{ id: 'codex', label: 'Codex', count: 1 }],
            sessionsByProvider: { codex: [{
                id: 'c1', name: 'Codex live', provider: 'codex', primaryRootId: 'root-api', primaryRootLabel: 'API',
            }] },
            unavailableProviders: [], aiSessionCount: 1, attentionCount: 0, defaultTab: 'sessions',
            activeSessions: [], activeSessionCount: 0, activeAttentionCount: 0,
        },
    }, false);
    assert.strictEqual((workspaceHtml.match(/class="workspace-card/g) || []).length, 1);
    assert.strictEqual((workspaceHtml.match(/class="codex-sessions"/g) || []).length, 1);
    assert.ok(workspaceHtml.includes('data-primary-root-id="root-api"'));
    assert.ok(workspaceHtml.includes('class="ai-session-root-chip"'));
    assert.strictEqual(workspaceHtml.includes('data-action="open-new-session-in"'), false);
    assert.strictEqual(workspaceHtml.includes('data-action="new-session-in"'), false);
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
    assert.ok(!webviewProjectScripts.includes('updateOpenProjectAiSessionBadge('));

    assert.ok(webviewContent.includes('data-action="add" title="Add Project"'));
    assert.ok(webviewContent.includes('class="project no-projects" data-action="add-project" data-nodrag'));
    assert.ok(!webviewContent.includes('getAddProjectDiv(group.id)'));
    assert.ok(!webviewContent.includes('function getAddProjectDiv'));
    assert.ok(webviewContent.includes('class="settings-button" data-action="open-settings"'));
    assert.ok(webviewProjectScripts.includes("type: 'open-settings'"));
    assert.ok(webviewProjectScripts.includes('projectId,'));
    assert.ok(!webviewProjectScripts.includes('projectUri'));
    assert.ok(insideProjectClick.includes('projectDiv.hasAttribute("data-current-workspace")'));
    assert.ok(insideProjectClick.includes('projectDiv.hasAttribute("data-workspace-navigation")'));
    assert.ok(!insideProjectClick.includes('data-project-navigation'));
    assert.ok(insideProjectClick.includes('openProject(dataId, ProjectOpenType.Default)'));
    assert.ok(
        insideProjectClick.indexOf('projectDiv.hasAttribute("data-workspace-navigation")')
            < insideProjectClick.indexOf('var currentWindow = e.ctrlKey || e.metaKey')
    );
    assert.ok(!webviewProjectScripts.includes("message.type === 'ai-session-attention-projects-updated'"));
    assert.ok(webviewContent.includes('class="ai-session-attention-indicator"'));
    assert.ok(styles.includes('.ai-session-attention-indicator'));
    assert.ok(dashboard.includes('getWorkspaceTarget: getCurrentWorkspaceActionTargetWithoutCardId'));
    assert.ok(attentionControllerSource.includes('getWorkspaceTarget: () => WorkspaceAiSessionActionTarget | null;'));
    assert.ok(attentionControllerSource.includes('getAttentionProjectKeys([root.uri])[0]'));
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
    assert.ok(resumeControllerSource.includes('runtimeCoordinator.resume(request)'));
    assert.ok(!dashboardRuntimeControllerSource.includes("type: 'ai-session-attention-projects-updated'"));
    assert.ok(dashboard.includes('sessionEvents: aiSessionAttentionController.getRecoverySessionEvents()'));
    assert.ok(webviewProjectScripts.includes('message.sessionEvents'));
    assert.ok(dashboard.includes('settleAiSessionRuntimeLifecycles'));
    assert.match(dashboard,
        /for \(const runtime of runtimes\) \{\s*if \(!runtimeBelongsToCurrentWorkspace\(runtime\)\) \{\s*continue;\s*\}/,
        'dashboard lifecycle attention collection must reject other scopes before session-key processing');
    assert.ok(dashboard.includes('const aiSessionAttentionController = new AiSessionAttentionController<AiSessionRuntimeSnapshot<vscode.Terminal>>({'));
    assert.ok(dashboard.includes("import { AiSessionExecutionController } from './aiSessions/executionController';"));
    assert.ok(dashboard.includes('const aiSessionExecutionController = new AiSessionExecutionController({'));
    assert.ok(dashboard.includes('new WorkspaceSessionHydrationController<vscode.Terminal>({'));
    assert.ok(dashboard.includes('getExecutionSnapshot: () => aiSessionExecutionController.getSnapshot()'));
    assert.ok(dashboard.includes('getActiveSessions: () => aiSessionRuntimeCoordinator.getActive()'));
    assert.match(dashboard, /aiSessionExecutionInterval = setInterval\(\(\) => \{ aiSessionExecutionController\.evaluate\(\); \}, 1_000\)/);
    assert.match(dashboard, /setTimeout\(\(\) => \{ aiSessionExecutionController\.evaluate\(\); \}, 0\)/);
    assert.ok(dashboard.includes('clearInterval(aiSessionExecutionInterval)'));
    assert.match(dashboard, /onDidCloseTerminal\(terminal => \{[\s\S]*?handleClosedTerminal\(terminal\);[\s\S]*?aiSessionExecutionController\.evaluate\(\);/);
    assert.ok(!evaluateExecutionFunction.includes('isEnabled'));
    assert.ok(!evaluateExecutionFunction.includes('attention'));
    assert.ok(evaluateAttentionFunction.includes('if (!this.options.isEnabled())'));
    assert.ok(evaluateAttentionMonitorFunction.includes('signal.phase'));
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
    assert.ok(!dashboard.includes('aiSessionPinController.migrateLegacy('));
    assert.ok(!dashboard.includes('function getPinnedAiSessionKeys('));
    assert.ok(!dashboard.includes('function migrateLegacyPinnedAiSessions('));
    assert.ok(!dashboard.includes('function deletePinnedAiSession('));
    assert.ok(dashboard.includes('new AiSessionAliasStore(context.globalStoragePath)'));
    assert.ok(dashboard.includes('new AiSessionWorkspaceStateStore(context.globalState'));
    assert.ok(dashboard.includes('new AiSessionTerminalBindingStore(context.workspaceState'));
    assert.ok(dashboard.includes('new DashboardDiagnostics({'));
    assert.ok(!dashboard.includes('function logAiSessionDiagnostic('));
    assert.ok(!dashboard.includes('function logDashboardDiagnostic('));
    assert.ok(!dashboard.includes('function logOpenWorkspaceDiagnostic('));
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
    const runtimeSettlementQueue = dashboard.slice(
        dashboard.indexOf('const queueAiSessionRuntimeSettlements = ('),
        dashboard.indexOf('const drainAiSessionRuntimeSettlements = async')
    );
    assert.ok(
        runtimeSettlementQueue.includes('runtime.identity.workspaceScopeIdentity'),
        'runtime lifecycle settlement keys must separate otherwise-identical runtimes in different workspace scopes'
    );
    assert.ok(!dashboard.includes('void settleAiSessionRuntime('),
        'lifecycle settlement scheduling must not create unhandled fire-and-forget rejections');
    assert.ok(dashboard.includes('getRuntimeById: getAiSessionRuntimeById'));
    assert.ok(!dashboard.includes('getTerminalById: (providerId, sessionId) => aiSessionTerminalService.getActiveById(providerId, sessionId)'));
    assert.match(dashboard, /aiSessionTerminalCompletionInterval = setInterval\(\(\) => \{[\s\S]*?getCompletedSessions\(\)[\s\S]*?tmuxRuntimeDiscovery\.getInactive\(\)[\s\S]*?\}, 1_000\)/);
    assert.match(dashboard, /queueAiSessionRuntimeSettlements\(\[\.\.\.completedRuntimes, \.\.\.inactiveTmuxRuntimes\]\)/,
        'one completion polling round must queue one structured batch');
    const closeTerminalHandlerStart = dashboard.indexOf('vscode.window.onDidCloseTerminal(terminal => {');
    const closeTerminalHandlerEnd = dashboard.indexOf(
        'context.subscriptions.push(activeAiSessionTerminalHighlighter);',
        closeTerminalHandlerStart
    );
    assert.ok(closeTerminalHandlerStart >= 0 && closeTerminalHandlerEnd > closeTerminalHandlerStart);
    const closeTerminalHandler = dashboard.slice(closeTerminalHandlerStart, closeTerminalHandlerEnd);
    assert.match(closeTerminalHandler, /hadRuntimeClient[\s\S]*?aiSessionRuntimeCoordinator\.handleClosedTerminal\(terminal\)[\s\S]*?closedSessions\.length \|\| hadRuntimeClient[\s\S]*?refreshAiSessionViewsIncrementally\(\)/);
    assert.ok(!dashboard.includes('acknowledge-closed-attention'));
    assert.doesNotMatch(
        closeTerminalHandler,
        /acknowledgeAiSessionAttention\(|aiSessionAttentionController\.acknowledge\(|aiSessionAttentionBridgeClient\.acknowledge\(/,
        'terminal closure must not acknowledge user attention'
    );
    assert.ok(dashboard.includes('vscode.window.onDidChangeActiveTerminal'));
    assert.match(dashboard, /onDidChangeActiveTerminal\(\(\) => \{[\s\S]*?activeAiSessionTerminalHighlighter\.sync\(\);[\s\S]*?runSafeAiSessionRuntimeLifecycleTask\([\s\S]*?'evaluate-attention-active-terminal'[\s\S]*?\}\)/);
    assert.ok(!dashboard.includes('void evaluateAiSessionAttention()'));
    assert.ok(!dashboard.includes('void acknowledgeAiSessionAttention('));
    assert.ok(dashboard.includes('runAiSessionRuntimeLifecycleTask('));
    assert.match(dashboard, /onDidChangeWindowState\(windowState => \{[\s\S]*?dashboardLifecycleController\.handleWindowStateChanged\(windowState\);[\s\S]*?\}\)/);
    assert.ok(dashboardLifecycleControllerSource.includes('this.options.evaluateAiSessionAttention();'));
    assert.ok(dashboardLifecycleControllerSource.includes('this.options.publishOpenWorkspace(true);'));
    assert.ok(dashboard.includes("'request-active-ai-session-terminal': () =>"));
    assert.ok(dashboardRuntimeControllerSource.includes("type: 'active-ai-session-terminal-changed'"));
    assert.ok(webviewProjectScripts.includes("type: 'request-active-ai-session-terminal'"));
    assert.ok(webviewProjectScripts.includes("message.type === 'active-ai-session-terminal-changed'"));
    assert.ok(webviewProjectScripts.includes('data-ai-session-active-terminal'));
    assert.ok(dashboard.includes('activeAiSessionTerminalHighlighter.handleTerminalClosed(terminal)'));
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
    assert.match(dashboard, /archiveSession\(\s*e\.projectId as string,\s*providerId as AiSessionProviderId \| null,\s*e\.sessionId as string\s*\)/);
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
    for (const keyframe of [
        'steward-session-running-flow',
        'steward-session-running-sweep',
        'steward-session-running-orbit',
        'steward-session-running-halo',
        'steward-session-running-ripple',
        'steward-session-running-breath',
    ]) {
        assert.ok(styles.includes(`@keyframes ${keyframe}`),
            `workspace card styles must retain ${keyframe}`);
        assert.ok(compiledStyles.includes(`@keyframes ${keyframe}`),
            `generated workspace card styles must retain ${keyframe}`);
    }
    assert.ok(styles.includes('.project-session-fx'));
    assert.ok(compiledStyles.includes('.project-session-fx'));
    const reducedMotionStyles = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.ok(reducedMotionStyles.includes('.project-session-fx'));
    assert.ok(reducedMotionStyles.includes('.project.session-running[data-session-fx="breath"]'));
    assert.ok(reducedMotionStyles.includes('animation: none !important'));
    assert.ok(styles.includes('[data-execution-state="running"] .codex-session-icon'));
    assert.ok(styles.includes('@keyframes steward-session-icon-spin'));
    assert.ok(compiledStyles.includes('[data-execution-state=running] .codex-session-icon::before'));
    assert.ok(compiledStyles.includes('@keyframes steward-session-icon-spin'));
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
        packageJson.contributes.configuration.properties[
            'projectSteward.aiSessionRunningCardAnimation'
        ].enum,
        ['current', 'sweep', 'orbit', 'halo', 'ripple', 'breath', 'none']
    );
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src', 'aiSessions', 'projectHydrationController.ts')));
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src', 'aiSessions', 'projectHydration.ts')));
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src', 'aiSessions', 'activeSessionProjection.ts')));
    assert.ok(!dashboard.includes('function pruneAiSessionAliases('));
    assert.ok(!dashboard.includes("const AI_SESSION_ALIASES_FILE_NAME = 'ai-session-aliases.json';"));
    assert.ok(!dashboard.includes('function getAiSessionAliasesPath('));
    assert.ok(dashboard.includes('new AiSessionAliasController({'));
    assert.ok(dashboard.includes('aiSessionAliasController.getAll()'));
    assert.ok(dashboard.includes('aiSessionAliasController.saveAll(aliases)'));
    assert.strictEqual((dashboard.match(/aiSessionAliasController\.set\(/g) || []).length, 1,
        'workspace pending promotion must persist the resolved Session alias once');
    assert.ok(dashboard.includes('aiSessionAliasController.remove('));
    assert.ok(dashboard.includes('aiSessionAliasController.getOriginalName('));
    assert.ok(!dashboard.includes('function getAiSessionAliases('));
    assert.ok(!dashboard.includes('function saveAiSessionAliases('));
    assert.ok(!dashboard.includes('function deleteAiSessionAlias('));
    assert.ok(!dashboard.includes('function setAiSessionAlias('));
    assert.ok(!dashboard.includes('function getAiSessionOriginalName('));
    assert.ok(dashboard.includes('aiSessionWorkspaceStateStore.getExpandedWorkspaces()'));
    assert.ok(dashboard.includes('aiSessionWorkspaceStateStore.setExpanded('));
    assert.ok(dashboard.includes('aiSessionWorkspaceStateStore.getActiveProviders()'));
    assert.ok(dashboard.includes('aiSessionWorkspaceStateStore.setActiveProvider('));
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
    assert.ok(dashboardRuntimeControllerSource.includes('this.options.getCurrentSavedProject()'));
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
    assert.ok(webviewContent.includes('style="${colorStyles.cardStyle}"'));
    assert.ok(webviewContent.includes("options.readOnlyProjects ? ' data-readonly-project' : ''"));
    assert.ok(styles.includes('--project-color'));
    assert.ok(styles.includes('.project-aura'));
    assert.ok(currentItemCardVisualBlock.includes('--vscode-list-inactiveSelectionBackground'));
    assert.ok(currentItemCardVisualBlock.includes('var(--vscode-focusBorder)'));
    assert.ok(currentItemCardVisualBlock.includes('box-shadow'));
    assert.ok(currentItemCardShellBlock.includes('height: auto'));
    assert.ok(currentItemCardShellBlock.includes('min-height: 58px'));
    assert.strictEqual(/(^|\n)\s*height\s*:\s*58px/.test(currentItemCardShellBlock), false);
    assert.ok(compiledCurrentItemCardVisualBlock.includes('var(--vscode-focusBorder)'));
    assert.ok(compiledCurrentItemCardShellBlock.includes('height:auto'));
    assert.ok(compiledCurrentItemCardShellBlock.includes('min-height:58px'));
    assert.ok(!currentItemCardShellBlock.includes('animation'));
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

function runTmuxSmokeHarnessSafetyChecks() {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const safetyScript = packageJson.scripts['test:safety'];
    assert.ok(safetyScript.includes('node scripts/run-ai-session-tmux-checks.js'),
        'ordinary safety CI must run the pure fake-tmux checks');
    assert.strictEqual(safetyScript.includes('run-ai-session-tmux-smoke-checks.js'), false,
        'ordinary safety CI must never start a real tmux server');
    assert.strictEqual(packageJson.scripts['test:tmux:smoke'],
        'npm run test-compile && node scripts/run-ai-session-tmux-smoke-checks.js');

    const smokeSource = fs.readFileSync(
        path.join(__dirname, 'run-ai-session-tmux-smoke-checks.js'), 'utf8'
    );
    assert.ok(smokeSource.includes('execFileSync'));
    assert.ok(smokeSource.includes('project-steward-test-'));
    assert.ok(smokeSource.includes("['-L', serverName, '-f', '/dev/null']"));
    assert.ok(smokeSource.includes('finally'));
    assert.ok(smokeSource.includes("'kill-server'"));
    assert.strictEqual(/\bexecFile\s*\(/.test(smokeSource), false);
    assert.strictEqual(/\bexecSync\s*\(/.test(smokeSource), false);
    assert.strictEqual(/\bspawn(?:Sync)?\s*\(/.test(smokeSource), false);
}

function runCurrentWorkspaceRenderingChecks() {
    const config = {
        get: (key, defaultValue) => key === 'aiSessionRunningCardAnimation' ? 'breath' : defaultValue,
        displayProjectPath: false,
        searchIsActiveByDefault: false,
        showAddGroupButtonTile: false,
    };
    const current = {
        id: 'workspace-current',
        kind: 'current',
        navigationIdentity: 'navigation-current',
        scopeIdentity: 'scope-current',
        name: 'Workspace A',
        environment: 'local',
        environmentLabel: 'Local',
        attentionCount: 0,
        roots: [
            { id: 'root-app', name: 'App', ordinal: 0 },
            { id: 'root-api', name: 'API', ordinal: 1 },
        ],
        aiSessions: {
            workspaceScopeIdentity: 'scope-current',
            workspaceNavigationIdentity: 'navigation-current',
            activeProvider: 'codex',
            expanded: true,
            providers: [{ id: 'codex', label: 'Codex', count: 1 }],
            sessionsByProvider: {
                codex: [{
                    id: 'session',
                    name: 'Session',
                    provider: 'codex',
                    primaryRootId: 'root-api',
                    primaryRootLabel: 'API',
                }],
            },
            unavailableProviders: [],
            aiSessionCount: 1,
            attentionCount: 0,
            defaultTab: 'sessions',
            activeSessions: [
                {
                    key: 'codex:running', provider: 'codex', sessionId: 'running', name: 'Running',
                    executionState: 'running', focused: false, needsAttention: false, pending: false,
                    backend: 'vscode', attached: true,
                },
                {
                    key: 'codex:starting', provider: 'codex', sessionId: 'starting', name: 'Starting',
                    executionState: 'starting', focused: false, needsAttention: false, pending: true,
                    backend: 'vscode', attached: true,
                },
                {
                    key: 'codex:stopped', provider: 'codex', sessionId: 'stopped', name: 'Stopped',
                    executionState: 'stopped', focused: false, needsAttention: false, pending: false,
                    backend: 'vscode', attached: true,
                },
            ],
            activeSessionCount: 3,
            activeAttentionCount: 0,
        },
    };
    const navigation = {
        id: 'workspace-navigation',
        kind: 'navigation',
        navigationIdentity: 'navigation-other',
        scopeIdentity: 'scope-other',
        name: 'Other Window',
        environment: 'ssh',
        environmentLabel: 'SSH',
        attentionCount: 2,
        roots: [{ id: 'root-other', name: 'Other', ordinal: 0 }],
        aiSessions: {
            activeSessions: [{ executionState: 'running' }],
            activeSessionCount: 99,
            aiSessionCount: 99,
        },
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
        },
        true,
        [current, navigation],
    );
    const getCardTags = (content, cardId) => Array.from(content.matchAll(
        new RegExp(`<div class="([^"]*)"[^>]*data-id="${cardId}"[^>]*>`, 'g')
    )).filter(match => hasClassTokens(match[1], 'workspace-card', 'steward-item-card'))
        .map(match => match[0]);
    const currentTags = getCardTags(html, current.id);
    const navigationTags = getCardTags(html, navigation.id);

    assert.strictEqual(currentTags.length, 1);
    assert.ok(currentTags[0].includes('data-current-workspace'));
    assert.ok(currentTags[0].includes('data-workspace-card-kind="current"'));
    assert.ok(currentTags[0].includes('session-running'));
    assert.ok(currentTags[0].includes('data-session-fx="breath"'),
        'the full Webview render must use the configured running animation');
    assert.ok(html.includes('title="Workspace — 1 active session running"'));
    assert.strictEqual((html.match(/class="project-session-fx"/g) || []).length, 1);
    assert.strictEqual(navigationTags.length, 1);
    assert.ok(navigationTags[0].includes('data-workspace-navigation'));
    assert.ok(navigationTags[0].includes('data-other-workspace'));
    assert.ok(navigationTags[0].includes('data-readonly-project'));
    assert.ok(!navigationTags[0].includes('data-current-workspace'));
    for (const forbidden of ['session-running', 'data-session-fx', 'active session running']) {
        assert.strictEqual(navigationTags[0].includes(forbidden), false,
            `navigation cards must structurally omit ${forbidden}`);
    }
    assert.strictEqual((html.match(/class="workspace-card/g) || []).length, 2);
    assert.strictEqual((html.match(/class="codex-sessions"/g) || []).length, 1);
    assert.strictEqual(html.includes('class="workspace-root-tags"'), false);
    assert.strictEqual(html.includes('class="workspace-root-tag"'), false);
    assert.strictEqual(html.includes('data-workspace-root-id'), false);
    assert.ok(html.includes('data-primary-root-id="root-api"'));
    assert.ok(html.includes('AI 1'));
    const otherWindowsHtml = html.slice(html.indexOf('OTHER WINDOWS'));
    assert.ok(otherWindowsHtml.includes(
        '<span class="project-ai-attention-badge" title="2 items need attention" aria-label="2 items need attention">2</span>'
    ));
    assert.strictEqual((otherWindowsHtml.match(/class="project-ai-attention-badge"/g) || []).length, 1);
    assert.strictEqual(otherWindowsHtml.includes('class="project-codex-badge"'), false);
    for (const privateDetail of [
        'data-ai-session-total-count',
        'data-ai-session-active-count',
        'data-ai-session-attention-count',
        'AI session',
        'active session',
        'running',
        'Codex',
        'Kimi',
        'Claude',
        '>99<',
    ]) {
        assert.strictEqual(otherWindowsHtml.includes(privateDetail), false,
            `anonymous navigation attention must omit ${privateDetail}`);
    }
    assert.ok(!html.includes('data-id="saved"'));
    assert.ok(!html.includes('data-id="other"'));

    assert.ok(html.includes('role="tablist"'));
    assert.ok(html.includes('data-dashboard-tab="open"'));
    assert.ok(html.includes('data-dashboard-tab="projects"'));
    assert.ok(html.includes('id="dashboard-tab-open"'));
    assert.ok(html.includes('id="dashboard-tab-projects"'));
    assert.ok(html.includes('id="dashboard-search-results"'));
    assert.ok(html.includes('id="dashboard-search-catalog"'));
    assert.strictEqual(html.includes('dashboard-projects-template'), false);
    assert.strictEqual(html.includes('class="groups-wrapper"'), false);

    const currentOnly = webviewContentModule.getOpenWorkspacesGroupContent([current], false);
    const currentAndOther = webviewContentModule.getOpenWorkspacesGroupContent(
        [current, navigation], false
    );
    const navigationOnly = webviewContentModule.getOpenWorkspacesGroupContent([navigation], false);
    const noCards = webviewContentModule.getOpenWorkspacesGroupContent([], false);

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
        },
        true,
        [{
            id: 'open-workspace', kind: 'current', navigationIdentity: 'navigation-open',
            scopeIdentity: 'scope-open', name: 'Open Repo', environment: 'local', environmentLabel: 'Local',
            roots: [{ id: 'root-open', name: 'Open Repo', ordinal: 0 }], attentionCount: 1,
            aiSessions: {
                workspaceScopeIdentity: 'scope-open', workspaceNavigationIdentity: 'navigation-open',
                activeProvider: 'codex', expanded: true,
                providers: [{ id: 'codex', label: 'Codex', count: 1 }],
                sessionsByProvider: { codex: [{
                    id: 'codex-one', name: 'Codex One', provider: 'codex',
                    primaryRootId: 'root-open', primaryRootLabel: 'Open Repo',
                }] },
                unavailableProviders: [], aiSessionCount: 1, attentionCount: 1,
                defaultTab: 'active', activeSessionCount: 1, activeAttentionCount: 1,
                activeSessions: [{
                    key: 'codex:codex-one', provider: 'codex', sessionId: 'codex-one', name: 'Codex One',
                    executionState: 'stopped', focused: false, needsAttention: true, pending: false,
                    backend: 'vscode', attached: true,
                }],
            },
        }]
    );
    assert.ok(!openProjectHtml.includes('class="project-ai-attention-badge"'));
    assert.ok(openProjectHtml.includes('class="project-codex-badge"'));
    assert.ok(!openProjectHtml.includes('project-codex-badge has-attention'));
    assert.ok(openProjectHtml.includes('class="ai-session-total-count">AI 1</span>'));
    assert.ok(openProjectHtml.includes('class="ai-session-active-count" aria-label="1 active AI session">'));
    assert.ok(openProjectHtml.includes('class="ai-session-attention-count" aria-label="1 AI session needs attention">1</b>'));

    const quietProjectHtml = webviewContentModule.getStewardContent(
        { extensionPath: '/extension' },
        { cspSource: 'test-source', asWebviewUri: uri => uri.toString() },
        [],
        {
            config,
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            otherStorageHasData: false,
        },
        true,
        [{
            id: 'quiet-workspace', kind: 'current', navigationIdentity: 'navigation-quiet',
            scopeIdentity: 'scope-quiet', name: 'Quiet', environment: 'local', environmentLabel: 'Local',
            roots: [{ id: 'root-quiet', name: 'Quiet', ordinal: 0 }], attentionCount: 0,
            aiSessions: {
                workspaceScopeIdentity: 'scope-quiet', workspaceNavigationIdentity: 'navigation-quiet',
                activeProvider: 'codex', expanded: false,
                providers: [{ id: 'codex', label: 'Codex', count: 1 }],
                sessionsByProvider: { codex: [{
                    id: 'history', name: 'History', provider: 'codex',
                    primaryRootId: 'root-quiet', primaryRootLabel: 'Quiet',
                }] },
                unavailableProviders: [], aiSessionCount: 1, attentionCount: 0,
                defaultTab: 'sessions', activeSessions: [], activeSessionCount: 0, activeAttentionCount: 0,
            },
        }]
    );
    assert.ok(!quietProjectHtml.includes('class="ai-session-active-count"'));
    assert.ok(!quietProjectHtml.includes('class="ai-session-attention-count"'));
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
                return kind === 'favorites' || kind === 'open-workspaces' ? {} : null;
            }
            return null;
        },
    });
    const draggable = { hasAttribute: () => false };
    const noDrag = { hasAttribute: attribute => attribute === 'data-nodrag' };
    const favorites = createContainer('favorites');
    const otherFavorites = createContainer('favorites');
    const openWorkspaces = createContainer('open-workspaces');
    const ordinary = createContainer('ordinary');
    const ordinaryTwo = createContainer('ordinary');

    assert.strictEqual(context.canMoveProject(draggable, favorites), true);
    assert.strictEqual(context.canMoveProject(draggable, openWorkspaces), false);
    assert.strictEqual(context.canMoveProject(draggable, ordinary), true);
    assert.strictEqual(context.canMoveProject(noDrag, favorites), false);
    assert.strictEqual(context.canAcceptProject(favorites, favorites), true);
    assert.strictEqual(context.canAcceptProject(otherFavorites, favorites), false);
    assert.strictEqual(context.canAcceptProject(ordinary, favorites), false);
    assert.strictEqual(context.canAcceptProject(favorites, ordinary), false);
    assert.strictEqual(context.canAcceptProject(openWorkspaces, ordinary), false);
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
        const attributes = new Set(['data-current-workspace']);
        const attributeValues = { 'data-id': projectId };
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
            getAttribute: attribute => attributeValues[attribute] || null,
            hasAttribute: attribute => attributes.has(attribute),
            removeAttribute: attribute => {
                attributes.delete(attribute);
                delete attributeValues[attribute];
            },
            setAttribute: (attribute, value) => {
                attributes.add(attribute);
                attributeValues[attribute] = String(value ?? '');
            },
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
                if (selector === '.codex-session-row[data-session-id][data-session-provider]') return rows;
                return [];
            },
            focus: () => {},
            scrollIntoView: () => {},
            addEventListener: () => {},
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
    const workspaceProject = createProject('workspace-current', 'codex');
    const workspaceSessionRow = createSessionRow('codex', 'workspace-session');
    let workspaceSessionFocuses = 0;
    let workspaceSessionScrolls = 0;
    workspaceSessionRow.focus = () => { workspaceSessionFocuses += 1; };
    workspaceSessionRow.scrollIntoView = () => { workspaceSessionScrolls += 1; };
    workspaceSessionRow.addEventListener = () => {};
    workspaceProject.setAttribute('data-workspace-navigation-identity', 'navigation-current');
    workspaceProject.setAttribute('data-codex-expanded', '');
    workspaceProject.replaceRowsOnNextUpdate([workspaceSessionRow]);
    workspaceProject.querySelector('.codex-sessions').outerHTML = '';
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
        hasAttribute: attribute => attribute === 'data-current-workspace',
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
            && Array.isArray(value.savedProjects)
            && Array.isArray(value.todos)
            && value.version === 2
            && Array.isArray(value.openWorkspaces)
            ? value
            : { version: 2, sessions: [], openWorkspaces: [], savedProjects: [], todos: [] },
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
                if (selector === '.workspace-card[data-current-workspace][data-id]') {
                    return projects;
                }
                if (selector === '.workspace-card[data-workspace-navigation-identity]') {
                    return [workspaceProject];
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

    assert.strictEqual(context.window.__projectStewardRevealWorkspaceSession(
        'navigation-current', 'codex', 'workspace-session'
    ), true);
    assert.strictEqual(workspaceSessionFocuses, 1);
    assert.strictEqual(workspaceSessionScrolls, 1);
    assert.deepStrictEqual(messages, [],
        'revealing a workspace session must not resume it or target a synthetic root project');

    const navigationProject = {
        getAttribute: attribute => attribute === 'data-id' ? '__openWorkspaceNavigation-other' : null,
        hasAttribute: attribute => attribute === 'data-workspace-navigation' || attribute === 'data-readonly-project',
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
            projectId: '__openWorkspaceNavigation-other',
            projectOpenType: 0,
        },
        {
            type: 'selected-project',
            projectId: '__openWorkspaceNavigation-other',
            projectOpenType: 0,
        },
        {
            type: 'selected-project',
            projectId: '__openWorkspaceNavigation-other',
            projectOpenType: 0,
        },
    ]);
    assert.ok(messages.every(message => !Object.prototype.hasOwnProperty.call(message, 'uri')));
    messages.length = 0;

    const clickBoundaryProject = createProject('workspace-click-target', 'codex');
    const aiSessionRegion = {};
    const createWorkspaceClickTarget = insideAiSessionRegion => ({
        closest: selector => {
            if (selector === '.project' || selector === '.project[data-id]') return clickBoundaryProject;
            if (selector === '[data-ai-session-region]' && insideAiSessionRegion) return aiSessionRegion;
            return null;
        },
    });
    const summaryTarget = createWorkspaceClickTarget(false);
    const sessionPanelTarget = createWorkspaceClickTarget(true);
    const sessionDividerTarget = createWorkspaceClickTarget(true);

    eventListeners.click({ button: 0, target: summaryTarget });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages)), [{
        type: 'toggle-codex-sessions',
        projectId: 'workspace-click-target',
        expanded: true,
    }], 'clicking the CURRENT WORKSPACE summary must still toggle AI Sessions');
    messages.length = 0;

    eventListeners.click({ button: 0, target: sessionPanelTarget });
    eventListeners.click({ button: 0, target: sessionDividerTarget });
    assert.deepStrictEqual(messages, [],
        'clicking the AI Sessions panel or its divider must not collapse CURRENT WORKSPACE');

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

    eventListeners.contextmenu({
        target: otherCodexRow.primaryAction,
        preventDefault: () => {},
        clientX: 20,
        clientY: 20,
        keyboardTrigger: false,
    });
    eventListeners.click({ button: 0, target: archiveMenuItem });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.pop())), {
        type: 'archive-codex-session', projectId: 'project-a', provider: 'codex',
        sessionId: 'other-session',
    }, 'context-menu archive must preserve the owning workspace card ID');
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
    context.applyWorkspaceUpdate = message => message.type === 'workspace-updated'
        && message.version === 2
        && message.currentWorkspaceCount === 1
        && typeof message.html === 'string';
    windowEventListeners.message({ data: {
        type: 'ai-sessions-updated',
        version: 2,
        sequence: 1,
        currentWorkspaceCount: 1,
        html: '<div class="open-current-workspace-group"></div>',
        searchCatalog: { version: 2, sessions: [], openWorkspaces: [], savedProjects: [], todos: TODO_SEARCH_ITEMS },
    } });
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(replacedSearchCatalog.todos)),
        TODO_SEARCH_ITEMS,
        'AI incremental rendering must preserve the non-empty TODO catalog replacement'
    );
    assert.strictEqual(activeRow.hasAttribute('data-ai-session-active-terminal'), true);

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
    const collapseToggleIndex = projectCollapse.indexOf('toggleAttribute("data-codex-expanded", expanded)');
    const collapseMessageIndex = projectCollapse.indexOf("type: 'toggle-codex-sessions'");
    assert.notStrictEqual(collapseExitIndex, -1);
    assert.notStrictEqual(collapseToggleIndex, -1);
    assert.notStrictEqual(collapseMessageIndex, -1);
    assert.ok(collapseExitIndex < collapseMessageIndex);
    assert.ok(collapseToggleIndex < collapseMessageIndex,
        'the visible CSS transition must start before expansion state is persisted');
}

function runAiSessionIncrementalRefreshSourceChecks() {
    const root = path.join(__dirname, '..');
    const dashboard = fs.readFileSync(path.join(root, 'src', 'dashboard.ts'), 'utf8');
    const readCoordinatorSource = fs.readFileSync(
        path.join(root, 'src', 'aiSessions', 'readCoordinator.ts'), 'utf8'
    );
    const controllerSource = fs.readFileSync(
        path.join(root, 'src', 'aiSessions', 'dashboardController.ts'), 'utf8'
    );
    const workspaceHydrationSource = fs.readFileSync(
        path.join(root, 'src', 'workspaces', 'sessionHydrationController.ts'), 'utf8'
    );
    const projectCandidatesSource = fs.readFileSync(
        path.join(root, 'src', 'aiSessions', 'projectCandidates.ts'), 'utf8'
    );
    const sessionPathsSource = fs.readFileSync(
        path.join(root, 'src', 'aiSessions', 'sessionPaths.ts'), 'utf8'
    );
    const projectWebviewSource = fs.readFileSync(
        path.join(root, 'src', 'webview', 'webviewProjectScripts.js'), 'utf8'
    );

    for (const removed of [
        'src/aiSessions/viewModels.ts',
        'src/aiSessions/projectHydration.ts',
        'src/aiSessions/projectHydrationController.ts',
        'src/aiSessions/activeSessionProjection.ts',
    ]) {
        assert.strictEqual(fs.existsSync(path.join(root, removed)), false, `${removed} must stay deleted`);
    }

    assert.ok(controllerSource.includes('export class AiSessionDashboardController'));
    assert.ok(controllerSource.includes('buildAiSessionsUpdatedMessage'));
    assert.ok(controllerSource.includes('getCards: () => WorkspaceCardViewModel[];'));
    assert.ok(controllerSource.includes("async refreshNow(reason = 'refresh'): Promise<void>"));
    assert.ok(controllerSource.includes("this.options.refresh('ai-session-update-not-delivered');"));
    assert.ok(controllerSource.includes("this.options.refresh('ai-session-update-post-error');"));
    assert.ok(controllerSource.includes("this.options.refresh('ai-session-update-build-error');"));
    assert.ok(controllerSource.includes("this.scheduleRefresh('watcher')"));
    assert.ok(controllerSource.includes("this.refreshNow('new-session')"));
    assert.ok(!controllerSource.includes('openProjectCardKind'));
    assert.ok(!controllerSource.includes('getOpenProjectAiSessionViewModel'));

    const aiSessionUpdateBody = extractFunctionBody(projectWebviewSource, 'applyAiSessionsUpdate');
    assert.ok(aiSessionUpdateBody.includes('syncAiSessionBatchManagementDom(projectDiv)'));
    assert.ok(projectWebviewSource.includes("message.type !== 'ai-sessions-updated'"));
    assert.ok(aiSessionUpdateBody.includes('message.version !== 2'));

    assert.ok(dashboard.includes('AI_SESSION_WATCHER_REFRESH_MIN_INTERVAL_MS'));
    assert.ok(dashboard.includes('watcherRefreshMinIntervalMs: AI_SESSION_WATCHER_REFRESH_MIN_INTERVAL_MS'));
    const refreshFunction = extractFunctionBody(dashboard, 'refreshAiSessionViewsIncrementally');
    assert.ok(refreshFunction.includes('aiSessionDashboardController.refreshNow()'));
    assert.ok(dashboard.includes('new WorkspaceSessionHydrationController<vscode.Terminal>({'));
    assert.ok(dashboard.includes('getCurrentWorkspaceAiSessions: workspace => workspaceSessionHydrationController.hydrate(workspace)'));
    assert.strictEqual(
        (dashboard.match(/getWorkspaceTarget: getCurrentWorkspaceActionTarget/g) || []).length,
        6,
        'all live AI action and attention controllers must resolve the v2 current workspace',
    );
    assert.strictEqual(dashboard.includes('as unknown as Project[]'), false);
    assert.strictEqual((dashboard.match(/\.service\.getSessions\(/g) || []).length, 0);

    assert.ok(workspaceHydrationSource.includes('export class WorkspaceSessionHydrationController'));
    assert.ok(workspaceHydrationSource.includes('getWorkspaceAiSessionCandidatePaths(workspace)'));
    assert.ok(workspaceHydrationSource.includes('this.options.readCoordinator.getResults({ candidatePaths, reason, maxFiles })'));
    assert.ok(workspaceHydrationSource.includes('hydrateWorkspaceAiSessions({'));
    assert.ok(workspaceHydrationSource.includes('activeProvider: this.options.getActiveProvider(workspace.scopeIdentity)'));
    assert.ok(workspaceHydrationSource.includes('expanded: this.options.getExpanded(workspace.scopeIdentity)'));

    assert.ok(projectCandidatesSource.includes("from '../workspaces/sessionHydration'"));
    assert.ok(!projectCandidatesSource.includes('getOpenProjectAiSessionKey'));
    assert.ok(!projectCandidatesSource.includes('getOpenProjectTerminalCwd'));
    assert.ok(!sessionPathsSource.includes('getProjectAiSessions'));
    assert.ok(!sessionPathsSource.includes('getAiSessionTerminalCwd'));
    assert.ok(sessionPathsSource.includes('export function getAiSessionComparableCwd('));
    assert.ok(sessionPathsSource.includes('export function getAiSessionTerminalName('));

    assert.ok(readCoordinatorSource.includes('export class AiSessionReadCoordinator'));
    assert.ok(readCoordinatorSource.includes("event: 'ai-session-scan'"));
    assert.ok(readCoordinatorSource.includes('durationMs: this.now() - startedAt'));
    assert.ok(readCoordinatorSource.includes('scannedFileCount: result.scannedFiles'));
    assert.ok(readCoordinatorSource.includes('parsedFileCount: result.parsedFiles'));
    assert.ok(readCoordinatorSource.includes('scanBudget: normalizedOptions.maxFiles || null'));
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
        getRunningCardAnimation: () => 'halo',
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
        currentWorkspaceCount: 0,
    }, {
        event: 'ai-session-message-build',
        reason: 'new-session',
        durationMs: 5,
        cardCount: 0,
        currentWorkspaceCount: 0,
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
        getTodoSearchItems: () => TODO_SEARCH_ITEMS,
        getCards: () => [],
        getRunningCardAnimation: () => 'ripple',
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

async function runAiSessionDashboardUnchangedMessageSkipChecks() {
    const messages = [];
    const diagnostics = [];
    let sessionName = 'Codex One';
    let runningCardAnimation = 'halo';
    const workspace = () => ({
        id: 'workspace-a',
        kind: 'current',
        navigationIdentity: 'navigation-a',
        scopeIdentity: 'scope-a',
        name: 'Workspace A',
        environment: 'local',
        environmentLabel: 'Local',
        roots: [{ id: 'root-a', name: 'App', ordinal: 0 }],
        attentionCount: 0,
        aiSessions: {
            workspaceScopeIdentity: 'scope-a',
            workspaceNavigationIdentity: 'navigation-a',
            activeProvider: 'codex',
            expanded: true,
            providers: [{ id: 'codex', label: 'Codex', count: 1 }],
            sessionsByProvider: {
                codex: [{ id: 'session-a', name: sessionName, provider: 'codex' }],
            },
            unavailableProviders: [],
            aiSessionCount: 1,
            attentionCount: 0,
            defaultTab: 'sessions',
            activeSessions: [{
                key: 'codex:session-a', provider: 'codex', sessionId: 'session-a', name: sessionName,
                executionState: 'running', focused: false, needsAttention: false, pending: false,
                backend: 'vscode', attached: true,
            }],
            activeSessionCount: 1,
            activeAttentionCount: 0,
        },
    });
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'],
        isVisible: () => true,
        invalidateCache: () => undefined,
        watchSessionChanges: () => ({ dispose() {} }),
        getGroups: () => [],
        getTodoSearchItems: () => TODO_SEARCH_ITEMS,
        getCards: () => [workspace()],
        getRunningCardAnimation: () => runningCardAnimation,
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
    assert.ok(messages[0].html.includes('data-session-fx="halo"'),
        'AI session controller updates must use the configured running animation');
    assert.strictEqual(diagnostics.some(event => event.event === 'ai-session-message-skip' && event.reason === 'watcher'), true);

    runningCardAnimation = 'orbit';
    await controller.refreshNow('watcher');
    assert.strictEqual(messages.length, 2,
        'changing only the running animation must not be suppressed by incremental message dedupe');
    assert.ok(messages[1].html.includes('data-session-fx="orbit"'));

    sessionName = 'Codex Two';
    await controller.refreshNow('watcher');
    assert.strictEqual(messages.length, 3, 'changed watcher messages must still be posted');
    assert.strictEqual(messages[2].version, 2);
    assert.strictEqual(messages[2].currentWorkspaceCount, 1);
    assert.strictEqual(messages[2].searchCatalog.version, 2);
    assert.deepStrictEqual(messages[2].searchCatalog.openWorkspaces.map(item => item.current), [true]);
    assert.ok(messages[2].html.includes('Codex Two'));

    await controller.refreshNow('refresh');
    assert.strictEqual(messages.length, 4, 'explicit refresh messages must not be suppressed by watcher dedupe');
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
    const indexedExecId = '77777777-7777-4777-8777-777777777777';
    const fileExecId = '88888888-8888-4888-8888-888888888888';
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
        const indexedExecFile = writeMeta(indexedExecId, '2026-07-13T06:00:00.000Z', {
            source: 'exec',
            originator: 'codex_exec',
            thread_source: 'user',
        });
        const fileExecFile = writeMeta(fileExecId, '2026-07-13T07:00:00.000Z', {
            source: 'exec',
            originator: 'codex_exec',
            thread_source: 'user',
        });
        fs.writeFileSync(path.join(sessionsDir, `${malformedIndexedId}.jsonl`), 'not-json\n', 'utf8');
        fs.writeFileSync(path.join(tempRoot, 'session_index.jsonl'), [
            { id: indexedNormalId, thread_name: 'Parent', updated_at: '2026-07-13T01:00:00.000Z' },
            { id: indexedSubagentId, thread_name: 'Worker', updated_at: '2026-07-13T02:00:00.000Z' },
            { id: malformedIndexedId, thread_name: 'Index fallback', updated_at: '2026-07-13T06:00:00.000Z' },
            { id: indexedExecId, thread_name: 'Headless review', updated_at: '2026-07-13T07:00:00.000Z' },
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
        assert.strictEqual(fs.existsSync(indexedExecFile), true);
        assert.strictEqual(fs.existsSync(fileExecFile), true);

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
    const scope = {
        workspaceNavigationIdentity: 'navigation',
        workspaceScopeIdentity: 'scope',
        workspaceRootHostPaths: ['/work/app'],
        primaryRootId: 'root-app',
        primaryCwd: '/work/app',
        additionalDirectories: [],
    };
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
        providers.getAiSessionProviderDefinition('codex').buildNewSessionCommand(scope, 'Ignored Title', null),
        "codex --cd '/work/app'"
    );
    assert.strictEqual(
        providers.getAiSessionProviderDefinition('claude').buildNewSessionCommand(scope, 'Useful Title', null),
        "cd '/work/app' && claude --name 'Useful Title'"
    );
}

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

function runCommandBuilderChecks() {
    const scope = Object.freeze({
        workspaceNavigationIdentity: 'workspace-navigation',
        workspaceScopeIdentity: 'workspace-scope',
        workspaceRootHostPaths: Object.freeze(['/work/web', '/work/api', '/work/文档']),
        primaryRootId: 'root-web',
        primaryCwd: '/work/web',
        additionalDirectories: Object.freeze(['/work/api', '/work/文档']),
    });
    const hostileScope = Object.freeze({
        workspaceNavigationIdentity: 'hostile-navigation',
        workspaceScopeIdentity: 'hostile-scope',
        workspaceRootHostPaths: Object.freeze([
            '/work/space dir',
            '/work/"quoted"',
            "/work/owner's $HOME; & docs 文档",
            'C:\\Repo\\api',
        ]),
        primaryRootId: 'root-space',
        primaryCwd: '/work/space dir',
        additionalDirectories: Object.freeze([
            '/work/"quoted"',
            "/work/owner's $HOME; & docs 文档",
            'C:\\Repo\\api',
        ]),
    });
    const whitespaceScope = Object.freeze({
        workspaceNavigationIdentity: 'whitespace-navigation',
        workspaceScopeIdentity: 'whitespace-scope',
        workspaceRootHostPaths: Object.freeze(['/work/repo ', '/work/ api']),
        primaryRootId: 'root-trailing-space',
        primaryCwd: '/work/repo ',
        additionalDirectories: Object.freeze(['/work/ api']),
    });
    const marker = '/tmp/provider.done';
    assert.deepStrictEqual(commands.buildCodexNewSessionLaunchSpec(scope, 'fix tests', marker), {
        executable: 'codex',
        args: ['--cd', '/work/web', '--add-dir', '/work/api', '--add-dir', '/work/文档', 'fix tests'],
        markerPath: marker,
        windowsDirectShell: 'powershell',
    });
    assert.deepStrictEqual(commands.buildCodexResumeLaunchSpec('c1', scope, marker), {
        executable: 'codex',
        args: ['resume', '--cd', '/work/web', '--add-dir', '/work/api', '--add-dir', '/work/文档', 'c1'],
        markerPath: marker,
        windowsDirectShell: 'current',
    });
    assert.deepStrictEqual(commands.buildKimiNewSessionLaunchSpec(scope, 'fix tests', marker), {
        executable: 'kimi',
        args: ['--work-dir', '/work/web', '--add-dir', '/work/api', '--add-dir', '/work/文档', '--prompt', 'fix tests'],
        markerPath: marker,
        windowsDirectShell: 'powershell',
    });
    assert.deepStrictEqual(commands.buildKimiResumeLaunchSpec('k1', scope, marker).args, [
        '--work-dir', '/work/web', '--add-dir', '/work/api', '--add-dir', '/work/文档', '--resume', 'k1',
    ]);
    assert.deepStrictEqual(commands.buildClaudeNewSessionLaunchSpec(scope, 'fix tests', marker), {
        executable: 'claude',
        args: ['--add-dir', '/work/api', '/work/文档', '--name', 'fix tests'],
        cwd: '/work/web',
        markerPath: marker,
        windowsDirectShell: 'powershell',
    });
    assert.deepStrictEqual(commands.buildClaudeResumeLaunchSpec('c1', scope, marker), {
        executable: 'claude',
        args: ['--add-dir', '/work/api', '/work/文档', '--resume', 'c1'],
        cwd: '/work/web', markerPath: marker, windowsDirectShell: 'current',
    });
    assert.deepStrictEqual(
        commands.buildCodexNewSessionLaunchSpec(hostileScope, null, null).args,
        [
            '--cd', '/work/space dir',
            '--add-dir', '/work/"quoted"',
            '--add-dir', "/work/owner's $HOME; & docs 文档",
            '--add-dir', 'C:\\Repo\\api',
        ],
        'launch specs preserve whitespace, quotes, Unicode, metacharacters, and Windows separators before serialization'
    );
    assert.deepStrictEqual(
        commands.buildCodexNewSessionLaunchSpec(whitespaceScope, null, null).args,
        ['--cd', '/work/repo ', '--add-dir', '/work/ api'],
    );
    assert.deepStrictEqual(
        commands.buildKimiNewSessionLaunchSpec(whitespaceScope, null, null).args,
        ['--work-dir', '/work/repo ', '--add-dir', '/work/ api'],
    );
    assert.deepStrictEqual(
        commands.buildClaudeNewSessionLaunchSpec(whitespaceScope, null, null),
        {
            executable: 'claude',
            args: ['--add-dir', '/work/ api'],
            cwd: '/work/repo ',
            markerPath: null,
            windowsDirectShell: 'powershell',
        },
    );
    assert.deepStrictEqual(
        commands.buildClaudeNewSessionLaunchSpec({ ...scope, primaryCwd: '/work/app', additionalDirectories: [] }, "Useful; 'Title'", '/tmp/claude.done'),
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
            commands.buildKimiNewSessionLaunchSpec({ ...scope, primaryCwd: '/work/app', additionalDirectories: [] }, "owner's task", null),
            'linux'
        ),
        "kimi --work-dir '/work/app' --prompt 'owner'\\''s task'"
    );
    assert.strictEqual(
        commands.buildCodexResumeCommand('abc123', { ...scope, primaryCwd: '/work/My App', additionalDirectories: [] }, null, 'linux'),
        "codex resume --cd '/work/My App' 'abc123'"
    );
    assert.strictEqual(
        commands.buildKimiNewSessionCommand({ ...scope, primaryCwd: '/work/app', additionalDirectories: [] }, "owner's task", null, 'linux'),
        "kimi --work-dir '/work/app' --prompt 'owner'\\''s task'"
    );
    let markedCommand = commands.buildClaudeResumeCommand('session-1', { ...scope, primaryCwd: '/work/app', additionalDirectories: [] }, '/tmp/session.done', 'linux');
    assert.ok(markedCommand.startsWith('sh -lc '));
    assert.ok(markedCommand.includes('claude --resume'));
    assert.ok(markedCommand.includes('rm -f'));
    assert.ok(markedCommand.includes(': >'));
    assert.ok(markedCommand.includes('/tmp/session.done'));

    let markedCodexNewCommand = commands.buildCodexNewSessionCommand({ ...scope, primaryCwd: '/work/app', additionalDirectories: [] }, null, '/tmp/new-codex.done', 'linux');
    assert.ok(markedCodexNewCommand.startsWith('sh -lc '));
    assert.ok(markedCodexNewCommand.includes("codex --cd"));
    assert.ok(markedCodexNewCommand.includes('/tmp/new-codex.done'));

    let windowsCommand = commands.buildClaudeResumeCommand('session-1', { ...scope, primaryCwd: 'C:\\Repo', additionalDirectories: [] }, 'C:\\Temp\\session.done', 'win32');
    let windowsPayload = decodePowerShellPayload(windowsCommand);
    assert.ok(windowsPayload.includes("Set-Location -LiteralPath 'C:\\Repo'"));
    assert.ok(windowsPayload.includes("Remove-Item -LiteralPath 'C:\\Temp\\session.done'"));
    assert.ok(windowsPayload.includes("New-Item -ItemType File -Force -Path 'C:\\Temp\\session.done'"));
    let windowsNewCommand = commands.buildCodexNewSessionCommand({ ...scope, primaryCwd: 'C:\\Repo', additionalDirectories: [] }, null, 'C:\\Temp\\new-codex.done', 'win32');
    let windowsNewPayload = decodePowerShellPayload(windowsNewCommand);
    assert.ok(windowsNewPayload.includes("codex --cd 'C:\\Repo'"));
    assert.ok(windowsNewPayload.includes("New-Item -ItemType File -Force -Path 'C:\\Temp\\new-codex.done'"));
    assert.strictEqual(commands.quotePowerShellArg("O'Brien"), "'O''Brien'");
}

async function runProviderDirectoryCapabilityChecks() {
    const capability = require('../out/aiSessions/providerDirectoryCapability');
    const executions = [];
    const diagnostics = [];
    const results = {
        '/resolved/codex': { exitCode: 0, stdout: 'Usage\n  --add-dir <DIR>  Add writable directory', stderr: '' },
        '/resolved/kimi': { exitCode: 0, stdout: '', stderr: 'Options:\n--add-dir PATH' },
        '/resolved/claude': { exitCode: 0, stdout: '  --add-dir <directories...>', stderr: '' },
        '/resolved/legacy': { exitCode: 0, stdout: 'Usage: legacy --work-dir PATH', stderr: '' },
        '/resolved/nonzero': { exitCode: 2, stdout: '', stderr: 'SECRET stderr from child' },
        '/resolved/timeout': { exitCode: null, stdout: '', stderr: 'SECRET timeout detail', timedOut: true },
        '/resolved/large': { exitCode: 0, stdout: `prefix ${'x'.repeat(90_000)} --add-dir SECRET_AFTER_BOUND`, stderr: '' },
    };
    const adapter = {
        resolveExecutable: commandName => commandName === 'missing' ? null : `/resolved/${commandName}`,
        run: async (executable, args, options) => {
            executions.push({ executable, args: [...args], options: { ...options } });
            return results[executable];
        },
    };
    const probe = new capability.ProviderDirectoryCapabilityProbe(adapter, message => diagnostics.push(message));
    const provider = (id, commandName = id) => ({ id, commandName });
    const supported = await Promise.all([
        probe.probe(provider('codex')),
        probe.probe(provider('codex')),
        probe.probe(provider('kimi')),
        probe.probe(provider('claude')),
    ]);
    assert.deepStrictEqual(supported.map(result => result.status), [
        'supported', 'supported', 'supported', 'supported',
    ]);
    assert.strictEqual(executions.filter(run => run.executable === '/resolved/codex').length, 1,
        'concurrent probes execute --help once per resolved executable/provider ID');
    assert.ok(executions.every(run => (
        run.args.length === 1 && run.args[0] === '--help'
        && run.options.timeoutMs > 0
        && run.options.maxOutputBytes > 0
        && run.options.maxOutputBytes <= 64 * 1024
    )), 'every capability probe is a bounded --help execution');

    assert.strictEqual((await probe.probe(provider('legacy'))).status, 'unsupported');
    assert.strictEqual((await probe.probe(provider('nonzero'))).status, 'unavailable');
    assert.strictEqual((await probe.probe(provider('timeout'))).status, 'unavailable');
    assert.strictEqual((await probe.probe(provider('missing'))).status, 'unavailable');
    assert.strictEqual((await probe.probe(provider('large'))).status, 'unsupported',
        'help parsing must ignore output beyond the configured byte bound');
    assert.ok(diagnostics.length >= 3);
    assert.ok(diagnostics.every(message => !message.includes('SECRET')),
        'capability diagnostics must not expose child output or executable details');
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

function runIncrementalJsonlLifecycleReaderChecks() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-steward-incremental-jsonl-lifecycle-'));
    const runStartedAtMs = Date.parse('2026-07-15T00:00:00.000Z');
    const createAccumulator = () => lifecycle.createCodexLifecycleAccumulator(runStartedAtMs);
    const codexEvent = (timestamp, type, turnId) => JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: { type, turn_id: turnId },
    });

    try {
        const reader = new IncrementalJsonlLifecycleReader(64);
        const filePath = path.join(tempRoot, 'codex.jsonl');
        const started = JSON.stringify({
            timestamp: '2026-07-15T00:00:01.000Z',
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'long-turn' },
        });
        fs.writeFileSync(filePath, `${started}\n${Array.from({ length: 100 }, (_, index) =>
            JSON.stringify({ timestamp: `2026-07-15T00:00:02.${String(index).padStart(3, '0')}Z`, type: 'event_msg', payload: { type: 'token_count' } })
        ).join('\n')}\n`);

        let readCalls = 0;
        const originalReadSync = fs.readSync;
        fs.readSync = function (...args) {
            readCalls++;
            return originalReadSync.apply(this, args);
        };
        let signal;
        try {
            signal = reader.read(
                'codex:long',
                filePath,
                runStartedAtMs,
                createAccumulator
            );
            assert.strictEqual(signal.executionState, 'running', 'cold scan recovers starts beyond one chunk');

            fs.appendFileSync(filePath, JSON.stringify({
                timestamp: '2026-07-15T00:00:03.000Z',
                type: 'event_msg',
                payload: { type: 'task_complete', turn_id: 'long-turn' },
            }) + '\n');
            signal = reader.read('codex:long', filePath, runStartedAtMs, createAccumulator);
            assert.strictEqual(signal.executionState, 'stopped', 'appended completion updates cached state');

            const readsAfterAppend = readCalls;
            signal = reader.read('codex:long', filePath, runStartedAtMs, createAccumulator);
            assert.strictEqual(signal.executionState, 'stopped');
            assert.strictEqual(readCalls, readsAfterAppend, 'unchanged file size performs no additional reads');
        } finally {
            fs.readSync = originalReadSync;
        }

        const inputPath = path.join(tempRoot, 'input.jsonl');
        fs.writeFileSync(inputPath, JSON.stringify({
            timestamp: '2026-07-15T00:00:04.000Z',
            type: 'response_item',
            payload: { type: 'custom_tool_call', name: 'request_user_input', call_id: 'later-answer' },
        }) + '\n');
        signal = reader.read('codex:input', inputPath, runStartedAtMs, createAccumulator);
        assert.strictEqual(signal.reason, 'input-required');
        fs.appendFileSync(inputPath, JSON.stringify({
            timestamp: '2026-07-15T00:00:05.000Z',
            type: 'response_item',
            payload: { type: 'custom_tool_call_output', call_id: 'later-answer' },
        }) + '\n');
        signal = reader.read('codex:input', inputPath, runStartedAtMs, createAccumulator);
        assert.strictEqual(signal.executionState, 'running', 'matching output in a later append resumes input request');

        const splitPath = path.join(tempRoot, 'split.jsonl');
        const splitLine = codexEvent('2026-07-15T00:00:06.000Z', 'task_started', 'split-line');
        const splitAt = Math.floor(splitLine.length / 2);
        fs.writeFileSync(splitPath, splitLine.slice(0, splitAt));
        assert.strictEqual(reader.read('codex:split', splitPath, runStartedAtMs, createAccumulator), null);
        fs.appendFileSync(splitPath, splitLine.slice(splitAt) + '\n');
        signal = reader.read('codex:split', splitPath, runStartedAtMs, createAccumulator);
        assert.strictEqual(signal.executionState, 'running', 'a line split across reads is parsed after its newline arrives');

        const malformedPath = path.join(tempRoot, 'malformed.jsonl');
        fs.writeFileSync(malformedPath, `{bad json\n${codexEvent('2026-07-15T00:00:07.000Z', 'task_started', 'after-bad')}\n`);
        signal = reader.read('codex:malformed', malformedPath, runStartedAtMs, createAccumulator);
        assert.strictEqual(signal.executionState, 'running', 'malformed JSON does not prevent a later valid event');

        const truncatedPath = path.join(tempRoot, 'truncated.jsonl');
        fs.writeFileSync(truncatedPath,
            `${codexEvent('2026-07-15T00:00:08.000Z', 'task_started', 'truncate')}\n`
            + `${codexEvent('2026-07-15T00:00:09.000Z', 'task_complete', 'truncate')}\n`);
        signal = reader.read('codex:truncated', truncatedPath, runStartedAtMs, createAccumulator);
        assert.strictEqual(signal.executionState, 'stopped');
        fs.writeFileSync(truncatedPath, `${codexEvent('2026-07-15T00:00:10.000Z', 'task_started', 'new')}\n`);
        signal = reader.read('codex:truncated', truncatedPath, runStartedAtMs, createAccumulator);
        assert.strictEqual(signal.executionState, 'running', 'truncation resets the old completion state');

        const runResetPath = path.join(tempRoot, 'run-reset.jsonl');
        fs.writeFileSync(runResetPath, `${codexEvent('2026-07-15T00:00:11.000Z', 'task_complete', 'old-run')}\n`);
        signal = reader.read('codex:run-reset', runResetPath, runStartedAtMs, createAccumulator);
        assert.strictEqual(signal.executionState, 'stopped');
        const nextRunStartedAtMs = Date.parse('2026-07-15T00:00:12.000Z');
        const originalOpenSync = fs.openSync;
        fs.openSync = () => { throw new Error('forced open failure after cursor reset'); };
        try {
            signal = reader.read(
                'codex:run-reset',
                runResetPath,
                nextRunStartedAtMs,
                () => lifecycle.createCodexLifecycleAccumulator(nextRunStartedAtMs)
            );
            assert.strictEqual(signal, null, 'an open failure after reset cannot leak the old run signal');
        } finally {
            fs.openSync = originalOpenSync;
        }

        const statFailurePath = path.join(tempRoot, 'stat-failure.jsonl');
        fs.writeFileSync(statFailurePath, `${codexEvent('2026-07-15T00:00:11.000Z', 'task_complete', 'cached-old-run')}\n`);
        signal = reader.read('codex:stat-failure', statFailurePath, runStartedAtMs, createAccumulator);
        assert.strictEqual(signal.executionState, 'stopped');
        const originalStatSync = fs.statSync;
        fs.statSync = () => { throw new Error('forced stat failure'); };
        try {
            signal = reader.read(
                'codex:stat-failure',
                statFailurePath,
                nextRunStartedAtMs,
                () => lifecycle.createCodexLifecycleAccumulator(nextRunStartedAtMs)
            );
            assert.strictEqual(signal, null, 'a stat failure cannot leak a cached signal from another run');

            signal = reader.read('codex:stat-failure', statFailurePath, runStartedAtMs, createAccumulator);
            assert.strictEqual(
                signal.executionState,
                'stopped',
                'a stat failure preserves the cached signal for the matching path and run'
            );
        } finally {
            fs.statSync = originalStatSync;
        }

        const nonFileSourcePath = path.join(tempRoot, 'non-file-source.jsonl');
        const nonFilePath = path.join(tempRoot, 'non-file-target');
        fs.writeFileSync(nonFileSourcePath, `${codexEvent('2026-07-15T00:00:11.000Z', 'task_complete', 'cached-before-non-file')}\n`);
        fs.mkdirSync(nonFilePath);
        signal = reader.read('codex:non-file', nonFileSourcePath, runStartedAtMs, createAccumulator);
        assert.strictEqual(signal.executionState, 'stopped');
        signal = reader.read(
            'codex:non-file',
            nonFilePath,
            nextRunStartedAtMs,
            () => lifecycle.createCodexLifecycleAccumulator(nextRunStartedAtMs)
        );
        assert.strictEqual(signal, null, 'a non-file path cannot leak a cached signal from another path and run');

        const retainedPath = path.join(tempRoot, 'retained.jsonl');
        const retainedStarted = codexEvent('2026-07-15T00:00:13.000Z', 'task_started', 'retain-11');
        const retainedComplete = codexEvent('2026-07-15T00:00:13.000Z', 'task_complete', 'retain-1');
        assert.strictEqual(retainedStarted.length, retainedComplete.length);
        fs.writeFileSync(retainedPath, `${retainedStarted}\n`);
        signal = reader.read('codex:retain-drop', retainedPath, runStartedAtMs, createAccumulator);
        assert.strictEqual(signal.executionState, 'running');
        fs.writeFileSync(retainedPath, `${retainedComplete}\n`);
        reader.retain(new Set(['codex:long']));
        signal = reader.read('codex:retain-drop', retainedPath, runStartedAtMs, createAccumulator);
        assert.strictEqual(signal.executionState, 'stopped', 'retain removes unowned cursors before a same-size rewrite');

        const deletedPath = path.join(tempRoot, 'deleted.jsonl');
        const deletedStarted = codexEvent('2026-07-15T00:00:14.000Z', 'task_started', 'delete-11');
        const deletedComplete = codexEvent('2026-07-15T00:00:14.000Z', 'task_complete', 'delete-1');
        assert.strictEqual(deletedStarted.length, deletedComplete.length);
        fs.writeFileSync(deletedPath, `${deletedStarted}\n`);
        signal = reader.read('codex:delete', deletedPath, runStartedAtMs, createAccumulator);
        assert.strictEqual(signal.executionState, 'running');
        fs.writeFileSync(deletedPath, `${deletedComplete}\n`);
        reader.delete('codex:delete');
        signal = reader.read('codex:delete', deletedPath, runStartedAtMs, createAccumulator);
        assert.strictEqual(signal.executionState, 'stopped', 'delete removes a cursor before a same-size rewrite');
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

function runAiSessionExecutionMonitorChecks() {
    let now = 1000;
    const monitor = new AiSessionExecutionMonitor({ now: () => now });
    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1' }]), []);
    assert.strictEqual(monitor.getSnapshot()['codex:s1'].state, 'stopped');

    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1', signal: {
        token: 'run-1', phase: 'running', executionState: 'running', occurredAtMs: 1100,
    } }]), ['codex:s1']);
    assert.strictEqual(monitor.getSnapshot()['codex:s1'].state, 'running');
    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1', signal: {
        token: 'run-1', phase: 'running', executionState: 'running', occurredAtMs: 1100,
    } }]), [], 'same token is idempotent');
    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1', signal: {
        token: 'old-stop', phase: 'needsAttention', reason: 'completed', executionState: 'stopped', occurredAtMs: 1099,
    } }]), [], 'older signal cannot overwrite current execution state');
    assert.strictEqual(monitor.getSnapshot()['codex:s1'].state, 'running');

    now = 1200;
    assert.deepStrictEqual(monitor.evaluate([{ key: 'codex:s1', signal: {
        token: 'stop-2', phase: 'needsAttention', reason: 'input-required', executionState: 'stopped', occurredAtMs: 1200,
    } }]), ['codex:s1']);
    assert.strictEqual(monitor.getSnapshot()['codex:s1'].state, 'stopped');
    assert.deepStrictEqual(monitor.evaluate([]), ['codex:s1']);
    assert.deepStrictEqual(monitor.getSnapshot(), {});
}

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
    await runWorkspaceSessionScopeChecks();
    runWorkspaceSessionAssignmentChecks();
    runWorkspaceSessionHydrationChecks();
    runDashboardSearchCatalogChecks();
    runDashboardDiagnosticsChecks();
    runAttentionProjectionChecks();
    runFavoriteProjectOrderChecks();
    runWorkspaceHelperChecks();
    runCandidateFilterChecks();
    runSessionPathChecks();
    runPendingTerminalMatcherChecks();
    runTerminalCandidateChecks();
    await runPendingTerminalResolverChecks();
    await runWorkspacePendingSessionPromotionChecks();
    runScanOptionChecks();
    runTerminalCwdChecks();
    runDisplayChecks();
    runPinStoreChecks();
    await runPinControllerChecks();
    runAliasStoreChecks();
    runAliasControllerChecks();
    await runWorkspaceStateStoreChecks();
    runAiSessionProviderAvailabilityChecks();
    await runWorkspaceCreationDirectoryFirstChecks();
    await runAiSessionCommandControllerChecks();
    await runWorkspaceScopeControllerLaunchChecks();
    await runWorkspaceLaunchPreflightControllerChecks();
    await runAiSessionAttentionControllerChecks();
    await runAiSessionExecutionControllerChecks();
    await runSidebarStewardViewProviderOrderingChecks();
    await runAiSessionArchiveRuntimeChecks();
    await runWorkspaceCardActionControllerIntegrationChecks();
    runKeyChecks();
    runBatchAiSessionArchiveChecks();
    runActiveAiSessionTerminalHighlightChecks();
    await runTmuxFocusedRuntimeMonitorChecks();
    runAiSessionTerminalResolutionChecks();
    await runAiSessionTerminalBindingStoreChecks();
    await runAiSessionTerminalPersistenceChecks();
    await runBatchAiSessionArchiveHostChecks();
    runWebviewContentChecks();
    runTmuxSmokeHarnessSafetyChecks();
    runCurrentWorkspaceRenderingChecks();
    runFavoriteRenderingChecks();
    runAttentionProjectRenderingChecks();
    runFavoriteDndChecks();
    runBatchAiSessionWebviewChecks();
    runAiSessionIncrementalRefreshSourceChecks();
    runAiSessionReadCoordinatorChecks();
    runAiSessionDashboardControllerChecks();
    runAiSessionDashboardWatcherCoalescingChecks();
    await runAiSessionDashboardUnchangedMessageSkipChecks();
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
    await runProviderDirectoryCapabilityChecks();
    runLifecycleParserChecks();
    runIncrementalJsonlLifecycleReaderChecks();
    runAttentionMonitorChecks();
    runAiSessionExecutionMonitorChecks();
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
