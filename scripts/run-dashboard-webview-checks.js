'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dashboardErrorContent = require('../out/dashboard/errorContent');
const dashboardConfiguration = require('../out/dashboard/configuration');
const dashboardStartup = require('../out/dashboard/startup');
const { DashboardStartupController } = require('../out/dashboard/startupController');
const { DashboardLifecycleController } = require('../out/dashboard/lifecycleController');
const { DashboardCommandRegistration } = require('../out/dashboard/commandRegistration');
const dashboardWebviewOptions = require('../out/dashboard/webviewOptions');
const { GroupCollapseController } = require('../out/dashboard/groupCollapseController');
const { DashboardRuntimeController } = require('../out/dashboard/runtimeController');
const { AddProjectsFromFolderController } = require('../out/projects/addProjectsFromFolderController');
const { FavoriteProjectController } = require('../out/projects/favoriteProjectController');
const { GroupCommandController } = require('../out/projects/groupCommandController');
const { queryGroupName } = require('../out/projects/groupPrompts');
const { ProjectOrderController } = require('../out/projects/projectOrderController');
const { ProjectRemovalController } = require('../out/projects/projectRemovalController');

const root = path.join(__dirname, '..');
const dashboardScriptPath = path.join(root, 'src', 'webview', 'webviewDashboardScripts.js');
const projectScriptPath = path.join(root, 'src', 'webview', 'webviewProjectScripts.js');
const extensionHostPath = path.join(root, 'src', 'dashboard.ts');

function extractFunctionBody(source, functionName) {
    const start = source.indexOf(`function ${functionName}(`);
    assert.ok(start >= 0, `Missing function ${functionName}`);
    const braceStart = source.indexOf('{', start);
    let depth = 0;
    for (let index = braceStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(braceStart + 1, index);
    }
    throw new Error(`Unterminated function ${functionName}`);
}

function makeDashboardCatalog() {
    return {
        sessions: [{
            key: 'codex:c1', searchText: 'fix dashboard codex c1', projectId: 'current',
            projectName: 'Dashboard', provider: 'codex', sessionId: 'c1', name: 'Fix dashboard',
        }],
        openProjects: [{
            key: 'open:/work/dashboard', identity: '/work/dashboard', searchText: 'dashboard current',
            projectId: 'current', name: 'Dashboard', description: 'Current',
            action: 'open-current', groupLabels: [],
        }],
        savedProjects: [{
            key: 'saved:/work/dashboard', identity: '/work/dashboard', searchText: 'dashboard tools',
            projectId: 'saved', name: 'Dashboard', description: 'Saved',
            action: 'open-saved', groupLabels: ['FAVORITES', 'TOOLS'],
        }],
    };
}

function makeUpdatedDashboardCatalog() {
    const catalog = makeDashboardCatalog();
    return {
        ...catalog,
        sessions: catalog.sessions.concat({
            key: 'kimi:k1', searchText: 'review dashboard kimi k1', projectId: 'current',
            projectName: 'Dashboard', provider: 'kimi', sessionId: 'k1', name: 'Review dashboard',
        }),
    };
}

function runErrorContentChecks() {
    const html = dashboardErrorContent.getErrorContent(new Error('<script>alert("x")</script>'));
    assert.ok(html.includes('Project Steward could not render this view.'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
    assert.strictEqual(html.includes('<script>alert("x")</script>'), false);

    assert.strictEqual(
        dashboardErrorContent.escapeHtml(`<&>"'`),
        '&lt;&amp;&gt;&quot;&#39;'
    );
}

function makeWorkspaceConfiguration(values, inspectedKeys = Object.keys(values), fallbackValues = {}) {
    return {
        get: (key, defaultValue) => Object.prototype.hasOwnProperty.call(values, key)
            ? values[key]
            : (Object.prototype.hasOwnProperty.call(fallbackValues, key) ? fallbackValues[key] : defaultValue),
        inspect: key => inspectedKeys.includes(key)
            ? { globalValue: Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined }
            : undefined,
        update: () => 'primary-update',
        passthrough: 'primary-passthrough',
    };
}

function runConfigurationChecks() {
    const primary = makeWorkspaceConfiguration({ customCss: '.primary{}' });
    const legacy = makeWorkspaceConfiguration({ customCss: '.legacy{}', displayProjectPath: false });
    const config = dashboardConfiguration.createStewardConfiguration(primary, legacy);

    assert.strictEqual(config.get('customCss'), '.primary{}');
    assert.strictEqual(config.get('displayProjectPath'), false);
    assert.strictEqual(config.get('missing', 'default'), 'default');
    assert.strictEqual(config.customCss, '.primary{}');
    assert.strictEqual(config.displayProjectPath, false);
    assert.strictEqual(config.passthrough, 'primary-passthrough');
    assert.strictEqual(config.update(), 'primary-update');
    assert.strictEqual(dashboardConfiguration.hasConfiguredValue(primary, 'customCss'), true);
    assert.strictEqual(dashboardConfiguration.hasConfiguredValue(primary, 'missing'), false);
}

function runStartupChecks() {
    assert.strictEqual(dashboardStartup.shouldOpenStewardOnStartup({
        reopenReason: 1,
        openOnStartup: 'never',
        workspaceName: 'project',
        visibleEditorLanguageIds: ['typescript'],
    }), true);
    assert.strictEqual(dashboardStartup.shouldOpenStewardOnStartup({
        openOnStartup: 'always',
        workspaceName: 'project',
        visibleEditorLanguageIds: ['typescript'],
    }), true);
    assert.strictEqual(dashboardStartup.shouldOpenStewardOnStartup({
        openOnStartup: 'never',
        workspaceName: '',
        visibleEditorLanguageIds: [],
    }), false);
    assert.strictEqual(dashboardStartup.shouldOpenStewardOnStartup({
        openOnStartup: 'empty workspace',
        workspaceName: '',
        visibleEditorLanguageIds: [],
    }), true);
    assert.strictEqual(dashboardStartup.shouldOpenStewardOnStartup({
        openOnStartup: 'empty workspace',
        workspaceName: '',
        visibleEditorLanguageIds: ['code-runner-output'],
    }), true);
    assert.strictEqual(dashboardStartup.shouldOpenStewardOnStartup({
        openOnStartup: 'empty workspace',
        workspaceName: 'project',
        visibleEditorLanguageIds: [],
    }), false);
    assert.strictEqual(dashboardStartup.shouldOpenStewardOnStartup({
        openOnStartup: 'empty workspace',
        workspaceName: '',
        visibleEditorLanguageIds: ['typescript'],
    }), false);
}

function runWebviewOptionsChecks() {
    const options = dashboardWebviewOptions.getDashboardWebviewOptions('/extensions/project-steward', value => ({ uri: value }));
    assert.strictEqual(options.enableScripts, true);
    assert.deepStrictEqual(options.localResourceRoots, [{ uri: path.join('/extensions/project-steward', 'media') }]);
}

async function runGroupCollapseControllerChecks() {
    const updates = [];
    const groups = new Map([
        ['group-a', { id: 'group-a', groupName: 'A', collapsed: false }],
        ['group-b', { id: 'group-b', groupName: 'B', collapsed: true }],
    ]);
    const projectServiceUpdates = [];
    const controller = new GroupCollapseController({
        state: {
            get: key => key === 'favoritesGroupCollapsed' ? true : undefined,
            update: async (key, value) => { updates.push([key, value]); },
        },
        projectService: {
            getGroup: groupId => groups.get(groupId) || null,
            updateGroup: async (groupId, group) => { projectServiceUpdates.push([groupId, { ...group }]); },
        },
    });

    assert.strictEqual(controller.getFavoritesCollapsed(), true);
    assert.strictEqual(controller.getOpenProjectsCollapsed(), undefined);

    await controller.collapseGroup('__favorites', true);
    await controller.collapseGroup('__openProjects', false);
    await controller.collapseGroup('group-a');
    await controller.collapseGroup('group-b', false);
    await controller.collapseGroup('missing-group', true);

    assert.deepStrictEqual(updates, [
        ['favoritesGroupCollapsed', true],
        ['openProjectsGroupCollapsed', false],
    ]);
    assert.deepStrictEqual(projectServiceUpdates, [
        ['group-a', { id: 'group-a', groupName: 'A', collapsed: true }],
        ['group-b', { id: 'group-b', groupName: 'B', collapsed: false }],
    ]);
}

async function runGroupPromptChecks() {
    const calls = [];
    const groupName = await queryGroupName(
        {
            showInputBox: async options => {
                calls.push(options);
                return 'Renamed Group';
            },
        },
        'Existing Group'
    );
    assert.strictEqual(groupName, 'Renamed Group');
    assert.strictEqual(calls[0].value, 'Existing Group');
    assert.deepStrictEqual(calls[0].valueSelection, [0, 'Existing Group'.length]);
    assert.strictEqual(calls[0].placeHolder, 'Group Name');
    assert.strictEqual(calls[0].ignoreFocusOut, true);
    assert.strictEqual(calls[0].validateInput(''), 'A Group Name must be provided.');
    assert.strictEqual(calls[0].validateInput('Group'), '');

    await assert.rejects(
        () => queryGroupName({ showInputBox: async () => undefined }),
        /CanceledByUser/
    );
}

async function runGroupCommandControllerChecks() {
    const groups = new Map([['group-a', { id: 'group-a', groupName: 'Old' }]]);
    const actions = [];
    const errors = [];
    let nextPrompt = 'New Group';
    let nextConfirmation = 'Remove';
    const controller = new GroupCommandController({
        projectService: {
            addGroup: async groupName => actions.push(['add', groupName]),
            getGroup: groupId => groups.get(groupId) || null,
            updateGroup: async (groupId, group) => actions.push(['update', groupId, { ...group }]),
            removeGroup: async groupId => actions.push(['remove', groupId]),
        },
        promptGroupName: async defaultText => {
            actions.push(['prompt', defaultText || null]);
            if (nextPrompt instanceof Error) {
                throw nextPrompt;
            }
            return nextPrompt;
        },
        confirmRemoveGroup: async groupName => {
            actions.push(['confirm', groupName]);
            return nextConfirmation;
        },
        showErrorMessage: message => errors.push(message),
        refreshAfterMutation: () => actions.push(['refresh']),
        userCanceledToken: 'CanceledByUser',
    });

    await controller.addGroup();
    await controller.editGroup('group-a');
    await controller.removeGroup('group-a');
    await controller.removeGroup('missing');
    assert.deepStrictEqual(actions, [
        ['prompt', null],
        ['add', 'New Group'],
        ['refresh'],
        ['prompt', 'Old'],
        ['update', 'group-a', { id: 'group-a', groupName: 'New Group' }],
        ['refresh'],
        ['confirm', 'New Group'],
        ['remove', 'group-a'],
        ['refresh'],
    ]);

    nextPrompt = new Error('CanceledByUser');
    await controller.addGroup();
    assert.strictEqual(actions.filter(action => action[0] === 'refresh').length, 3);

    nextPrompt = new Error('boom');
    await assert.rejects(() => controller.editGroup('group-a'), /boom/);
    assert.deepStrictEqual(errors.slice(-1), ['An error occured while editing the group.']);

    nextConfirmation = undefined;
    await controller.removeGroup('group-a');
    assert.strictEqual(actions.filter(action => action[0] === 'remove').length, 1);
}

async function runAddProjectsFromFolderControllerChecks() {
    const actions = [];
    const errors = [];
    let selectedFolders = [{ fsPath: '/work/tools' }];
    let foldersInSelectedPath = ['/work/tools/api', '/work/tools/web'];
    const controller = new AddProjectsFromFolderController({
        getCurrentWorkspacePath: () => '/work/current',
        parsePathAsUri: value => ({ uri: value }),
        showOpenDialog: async options => {
            actions.push(['dialog', options.defaultUri, options.openLabel]);
            return selectedFolders;
        },
        getFolders: async folderPath => {
            actions.push(['get-folders', folderPath]);
            if (foldersInSelectedPath instanceof Error) {
                throw foldersInSelectedPath;
            }
            return foldersInSelectedPath;
        },
        addGroup: async groupName => {
            actions.push(['add-group', groupName]);
            return { id: 'group-tools' };
        },
        addProject: async (project, groupId) => actions.push(['add-project', project.name, project.path, project.color, project.isGitRepo, groupId]),
        getRandomColor: () => '#abcdef',
        isFolderGitRepo: folder => folder.endsWith('/api'),
        showErrorMessage: message => errors.push(message),
        refreshAfterMutation: () => actions.push(['refresh']),
        userCanceledToken: 'CanceledByUser',
    });

    await controller.addProjectsFromFolder();
    assert.deepStrictEqual(actions, [
        ['dialog', { uri: '/work/current' }, 'Select Folder containing Projects'],
        ['get-folders', '/work/tools'],
        ['add-group', 'tools'],
        ['add-project', 'api', '/work/tools/api', '#abcdef', true, 'group-tools'],
        ['add-project', 'web', '/work/tools/web', '#abcdef', false, 'group-tools'],
        ['refresh'],
    ]);

    selectedFolders = [];
    await controller.addProjectsFromFolder();
    assert.strictEqual(actions.filter(action => action[0] === 'refresh').length, 1);

    selectedFolders = [{ fsPath: '/work/broken' }];
    foldersInSelectedPath = new Error('boom');
    await assert.rejects(() => controller.addProjectsFromFolder(), /boom/);
    assert.deepStrictEqual(errors.slice(-1), ['An error occured while adding the projects.']);
}

async function runFavoriteProjectControllerChecks() {
    let groups = [{
        id: 'group-a',
        groupName: 'A',
        projects: [
            { id: 'a', name: 'A', favorite: true, favoriteOrder: 0 },
            { id: 'b', name: 'B' },
        ],
    }];
    const saved = [];
    const actions = [];
    const controller = new FavoriteProjectController({
        getGroups: () => groups,
        saveGroups: async nextGroups => {
            saved.push(nextGroups);
            groups = nextGroups;
        },
        refreshAfterMutation: () => actions.push('refresh'),
    });

    await controller.toggleProjectFavorite('b');
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0][0].projects.find(project => project.id === 'b').favorite, true);
    assert.deepStrictEqual(saved[0][0].projects.filter(project => project.favorite).map(project => project.id), ['a', 'b']);
    assert.deepStrictEqual(actions, ['refresh']);

    await controller.toggleProjectFavorite('missing');
    assert.strictEqual(saved.length, 1);
    assert.deepStrictEqual(actions, ['refresh']);

    await controller.reorderFavoriteProjects(['b', 'a']);
    assert.strictEqual(saved.length, 2);
    assert.deepStrictEqual(
        saved[1][0].projects.filter(project => project.favorite).sort((left, right) => left.favoriteOrder - right.favoriteOrder).map(project => project.id),
        ['b', 'a']
    );
    assert.deepStrictEqual(actions, ['refresh', 'refresh']);
}

async function runProjectOrderControllerChecks() {
    const groups = [
        {
            id: 'group-a',
            groupName: 'A',
            projects: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }],
        },
        {
            id: 'group-b',
            groupName: 'B',
            projects: [{ id: 'b1', name: 'B1' }],
        },
    ];
    const saved = [];
    const informationMessages = [];
    const actions = [];
    const controller = new ProjectOrderController({
        getGroups: () => groups,
        saveGroups: async nextGroups => saved.push(nextGroups),
        showInformationMessage: message => informationMessages.push(message),
        refreshAfterMutation: () => actions.push('refresh'),
    });

    await controller.reorderGroups(null);
    assert.deepStrictEqual(informationMessages, ['Invalid Argument passed to Reordering Projects.']);
    assert.deepStrictEqual(saved, []);
    assert.deepStrictEqual(actions, []);

    await controller.reorderGroups([
        { groupId: 'group-b', projectIds: ['b1', 'a1'] },
        { groupId: 'missing-group', projectIds: ['a2', 'missing-project'] },
    ]);
    assert.strictEqual(saved.length, 1);
    assert.deepStrictEqual(saved[0].map(group => ({
        id: group.id,
        groupName: group.groupName,
        projectIds: group.projects.map(project => project.id),
    })), [
        { id: 'group-b', groupName: 'B', projectIds: ['b1', 'a1'] },
        { id: saved[0][1].id, groupName: 'Group #2', projectIds: ['a2'] },
    ]);
    assert.deepStrictEqual(actions, ['refresh']);
}

async function runProjectRemovalControllerChecks() {
    const projects = new Map([['project-a', { id: 'project-a', name: 'Alpha' }]]);
    const actions = [];
    let nextConfirmation = 'Remove';
    const controller = new ProjectRemovalController({
        getProject: projectId => projects.get(projectId) || null,
        confirmRemoveProject: async projectName => {
            actions.push(['confirm', projectName]);
            return nextConfirmation;
        },
        removeProject: async projectId => actions.push(['remove', projectId]),
        refreshAfterMutation: () => actions.push(['refresh']),
    });

    await controller.removeProject('project-a');
    await controller.removeProject('missing');
    nextConfirmation = undefined;
    await controller.removeProject('project-a');

    assert.deepStrictEqual(actions, [
        ['confirm', 'Alpha'],
        ['remove', 'project-a'],
        ['refresh'],
        ['confirm', 'Alpha'],
    ]);
}

async function runDashboardRuntimeControllerChecks() {
    const commands = [];
    const refreshes = [];
    const diagnostics = [];
    const published = [];
    const posted = [];
    const colorSyncs = [];
    const errors = [];
    const projects = [{ id: 'project-a', path: '/work/a' }];
    let visible = true;
    let focusFails = true;
    const baseOptions = {
        isVisible: () => visible,
        refreshProvider: () => refreshes.push('refresh'),
        logDashboardDiagnostic: event => diagnostics.push(event),
        executeCommand: (command, ...args) => {
            commands.push([command, ...args]);
            if (command.endsWith('.focus') && focusFails) {
                focusFails = false;
                return Promise.reject(new Error('focus failed once'));
            }
            return Promise.resolve();
        },
        viewType: 'project-steward.views.sidebar',
        publishOpenProjects: () => published.push('open-projects'),
        getOpenProjects: () => projects,
        syncProjectColorToCurrentWindow: project => {
            colorSyncs.push(project);
            return Promise.resolve();
        },
        postMessage: message => {
            posted.push(message);
            return Promise.resolve(true);
        },
        logError: (message, error) => errors.push([message, error?.message]),
    };
    const controller = new DashboardRuntimeController(baseOptions);

    controller.refresh('manual');
    assert.deepStrictEqual(refreshes, ['refresh']);
    assert.deepStrictEqual(diagnostics, [{ event: 'full-refresh', reason: 'manual' }]);

    visible = false;
    controller.refresh('hidden');
    assert.deepStrictEqual(refreshes, ['refresh']);

    visible = true;
    await controller.showSteward();
    assert.deepStrictEqual(published, ['open-projects']);
    assert.deepStrictEqual(commands, [
        ['workbench.view.extension.project-steward'],
        ['project-steward.views.sidebar.focus'],
        ['project-steward.views.sidebar.focus'],
    ]);
    assert.deepStrictEqual(diagnostics.slice(-1), [{ event: 'full-refresh', reason: 'show-steward' }]);

    await controller.openSettings();
    assert.deepStrictEqual(commands[commands.length - 1], ['workbench.action.openSettings', '@ext:hzcheng.project-steward']);

    controller.postAttentionProjectsUpdated([{ projectKey: 'p', attentionCount: 1, eventIds: ['e'], sessions: [] }]);
    controller.postBatchArchiveCompletion({ type: 'ai-session-batch-archive-completed', projectId: 'p', provider: 'codex', status: 'finished' });
    controller.postActiveAiSessionTerminalChanged({ provider: 'codex', sessionId: 's1' });
    controller.postActiveAiSessionTerminalChanged(null);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(posted.map(message => message.type), [
        'ai-session-attention-projects-updated',
        'ai-session-batch-archive-completed',
        'active-ai-session-terminal-changed',
        'active-ai-session-terminal-changed',
    ]);
    assert.deepStrictEqual(posted[2], { type: 'active-ai-session-terminal-changed', provider: 'codex', sessionId: 's1' });
    assert.deepStrictEqual(posted[3], { type: 'active-ai-session-terminal-changed', provider: null, sessionId: null });

    controller.applyProjectColorToCurrentWindow();
    controller.applyProjectColorToCurrentWindow({ id: 'save', showSaveAction: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(colorSyncs, [projects[0], null]);

    controller.refreshAfterMutation();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(colorSyncs, [projects[0], null, projects[0]]);
    assert.deepStrictEqual(diagnostics.slice(-1), [{ event: 'full-refresh', reason: 'project-mutation' }]);
    assert.deepStrictEqual(published, ['open-projects', 'open-projects']);

    const failingController = new DashboardRuntimeController({
        ...baseOptions,
        syncProjectColorToCurrentWindow: () => Promise.reject(new Error('color failed')),
        postMessage: () => Promise.reject(new Error('post failed')),
    });
    failingController.applyProjectColorToCurrentWindow(projects[0]);
    failingController.postAttentionProjectsUpdated([{ projectKey: 'p', attentionCount: 1, eventIds: ['e'], sessions: [] }]);
    failingController.postBatchArchiveCompletion({ type: 'ai-session-batch-archive-completed', projectId: 'p', provider: 'codex', status: 'finished' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(errors.slice(-3).map(item => item[0]), [
        'Failed to apply project color to current window.',
        'Failed to post AI session attention projects.',
        'Failed to post batch AI session archive completion.',
    ]);

    const syncThrowErrors = [];
    const syncThrowController = new DashboardRuntimeController({
        ...baseOptions,
        executeCommand: () => { throw new Error('command threw'); },
        syncProjectColorToCurrentWindow: () => { throw new Error('color threw'); },
        postMessage: () => { throw new Error('post threw'); },
        logError: (message, error) => syncThrowErrors.push([message, error?.message]),
    });
    await syncThrowController.revealSidebarSteward();
    syncThrowController.applyProjectColorToCurrentWindow(projects[0]);
    syncThrowController.postAttentionProjectsUpdated([{ projectKey: 'p', attentionCount: 1, eventIds: ['e'], sessions: [] }]);
    syncThrowController.postBatchArchiveCompletion({ type: 'ai-session-batch-archive-completed', projectId: 'p', provider: 'codex', status: 'finished' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(syncThrowErrors, [
        ['Failed to apply project color to current window.', 'color threw'],
        ['Failed to post AI session attention projects.', 'post threw'],
        ['Failed to post batch AI session archive completion.', 'post threw'],
    ]);
}

async function runDashboardStartupControllerChecks() {
    const extensionChecks = [];
    const publications = [];
    const informationMessages = [];
    const colorApplications = [];
    const reopenUpdates = [];
    let migrated = true;
    let showStewardCalls = 0;
    let reopenReason = 0;
    let workspaceName = 'workspace';
    let visibleEditorLanguageIds = ['typescript'];
    const stewardInfos = {
        relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
        config: { openOnStartup: 'never' },
    };
    const controller = new DashboardStartupController({
        stewardInfos,
        relevantExtensions: {
            remoteSSH: 'ms-vscode-remote.remote-ssh',
            remoteContainers: 'ms-vscode-remote.remote-containers',
        },
        isExtensionInstalled: extensionId => {
            extensionChecks.push(extensionId);
            return extensionId.endsWith('remote-ssh');
        },
        migrateDataIfNeeded: async () => migrated,
        publishOpenProjects: () => publications.push('published'),
        showInformationMessage: message => informationMessages.push(message),
        showSteward: () => { showStewardCalls += 1; },
        applyProjectColorToCurrentWindow: () => colorApplications.push('applied'),
        getReopenReason: () => reopenReason,
        updateReopenReason: value => reopenUpdates.push(value),
        reopenNoneValue: 0,
        getWorkspaceName: () => workspaceName,
        getVisibleEditorLanguageIds: () => visibleEditorLanguageIds,
    });

    await controller.checkDataMigration();
    assert.deepStrictEqual(publications, ['published']);
    assert.strictEqual(informationMessages.length, 1);
    assert.strictEqual(showStewardCalls, 0);

    migrated = false;
    await controller.checkDataMigration(true);
    assert.deepStrictEqual(publications, ['published']);
    assert.strictEqual(showStewardCalls, 0);

    migrated = true;
    await controller.checkDataMigration(true);
    assert.deepStrictEqual(publications, ['published', 'published']);
    assert.strictEqual(showStewardCalls, 1);

    reopenReason = 1;
    await controller.startUp();
    assert.deepStrictEqual(extensionChecks, [
        'ms-vscode-remote.remote-ssh',
        'ms-vscode-remote.remote-containers',
    ]);
    assert.deepStrictEqual(stewardInfos.relevantExtensionsInstalls, { remoteSSH: true, remoteContainers: false });
    assert.deepStrictEqual(colorApplications, ['applied']);
    assert.deepStrictEqual(reopenUpdates, [0]);
    assert.strictEqual(showStewardCalls, 2);

    reopenReason = 0;
    workspaceName = '';
    visibleEditorLanguageIds = ['code-runner-output'];
    stewardInfos.config = { openOnStartup: 'empty workspace' };
    await controller.startUp();
    assert.strictEqual(showStewardCalls, 3);
}

async function runDashboardLifecycleControllerChecks() {
    const events = [];
    const controller = new DashboardLifecycleController({
        checkDataMigration: async openStewardAfterMigrate => events.push(['migrate', openStewardAfterMigrate]),
        applyProjectColorToCurrentWindow: () => events.push(['color']),
        refresh: reason => events.push(['refresh', reason]),
        publishOpenProjects: followsFocusEvent => events.push(['publish', followsFocusEvent]),
        evaluateAiSessionAttention: () => events.push(['attention']),
    });
    const makeConfigurationEvent = affectedSections => ({
        affectsConfiguration: section => affectedSections.some(affectedSection =>
            affectedSection === section || affectedSection.startsWith(`${section}.`)),
    });

    await controller.handleConfigurationChanged(makeConfigurationEvent(['projectSteward.storeProjectsInSettings']));
    assert.deepStrictEqual(events, [
        ['migrate', false],
        ['color'],
        ['refresh', 'configuration-changed'],
        ['publish', undefined],
    ]);

    events.length = 0;
    await controller.handleConfigurationChanged(makeConfigurationEvent(['dashboard.storeProjectsInSettings']));
    assert.deepStrictEqual(events.map(event => event[0]), ['migrate', 'color', 'refresh', 'publish']);

    events.length = 0;
    await controller.handleConfigurationChanged(makeConfigurationEvent(['projectSteward']));
    assert.deepStrictEqual(events, [
        ['color'],
        ['refresh', 'configuration-changed'],
        ['publish', undefined],
    ]);

    events.length = 0;
    await controller.handleConfigurationChanged(makeConfigurationEvent(['unrelated']));
    assert.deepStrictEqual(events, []);

    controller.handleWorkspaceFoldersChanged();
    assert.deepStrictEqual(events, [
        ['color'],
        ['refresh', 'workspace-folders-changed'],
        ['publish', undefined],
    ]);

    events.length = 0;
    controller.handleWindowStateChanged({ focused: true });
    assert.deepStrictEqual(events, [
        ['publish', true],
        ['attention'],
    ]);

    events.length = 0;
    controller.handleWindowStateChanged({ focused: false });
    assert.deepStrictEqual(events, [
        ['attention'],
    ]);
}

async function runDashboardCommandRegistrationChecks() {
    const registered = [];
    const subscriptions = [];
    const calls = [];
    const registration = new DashboardCommandRegistration({
        registerCommand: (command, callback) => {
            const disposable = { command, dispose: () => undefined };
            registered.push([command, callback]);
            return disposable;
        },
        pushSubscription: disposable => subscriptions.push(disposable),
        handlers: {
            open: () => calls.push('open'),
            addProject: async () => calls.push('addProject'),
            saveProject: async () => calls.push('saveProject'),
            removeProject: async () => calls.push('removeProject'),
            editProjects: async () => calls.push('editProjects'),
            addGroup: async () => calls.push('addGroup'),
            removeGroup: async () => calls.push('removeGroup'),
            addProjectsFromFolder: async () => calls.push('addProjectsFromFolder'),
        },
    });

    registration.register();

    assert.deepStrictEqual(registered.map(([command]) => command), [
        'projectSteward.open',
        'projectSteward.addProject',
        'projectSteward.saveProject',
        'projectSteward.removeProject',
        'projectSteward.editProjects',
        'projectSteward.addGroup',
        'projectSteward.removeGroup',
        'projectSteward.addProjectsFromFolder',
    ]);
    assert.deepStrictEqual(subscriptions.map(disposable => disposable.command), registered.map(([command]) => command));

    for (const [, callback] of registered) {
        await callback();
    }

    assert.deepStrictEqual(calls, [
        'open',
        'addProject',
        'saveProject',
        'removeProject',
        'editProjects',
        'addGroup',
        'removeGroup',
        'addProjectsFromFolder',
    ]);
}

function createClassList() {
    const values = new Set();
    return {
        add: value => values.add(value),
        remove: value => values.delete(value),
        toggle: (value, force) => force === undefined
            ? (values.has(value) ? (values.delete(value), false) : (values.add(value), true))
            : (force ? values.add(value) : values.delete(value), force),
        contains: value => values.has(value),
    };
}

function createElement(id) {
    const attributes = new Map();
    const listeners = {};
    return {
        id,
        hidden: false,
        innerHTML: '',
        classList: createClassList(),
        addEventListener: (type, listener) => { listeners[type] = listener; },
        dispatch: (type, event = {}) => listeners[type] && listeners[type](event),
        focus: () => undefined,
        getAttribute: name => attributes.get(name) || null,
        setAttribute: (name, value) => attributes.set(name, String(value)),
    };
}

function runControllerChecks(source) {
    const openButton = createElement('dashboard-tab-open-button');
    openButton.setAttribute('data-dashboard-tab', 'open');
    const projectsButton = createElement('dashboard-tab-projects-button');
    projectsButton.setAttribute('data-dashboard-tab', 'projects');
    const openPanel = createElement('dashboard-tab-open');
    const projectsPanel = createElement('dashboard-tab-projects');
    const elements = {
        'dashboard-tab-open': openPanel,
        'dashboard-tab-projects': projectsPanel,
    };
    const messages = [];
    const storage = new Map([['projectSteward.activeDashboardTab', 'open']]);
    const windowListeners = {};
    const context = {
        document: {
            body: { classList: createClassList() },
            getElementById: id => elements[id] || null,
            querySelectorAll: selector => selector === '[data-dashboard-tab]'
                ? [openButton, projectsButton]
                : [],
        },
        sessionStorage: {
            getItem: key => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value),
        },
        window: {
            scrollY: 11,
            scrollTo: (_x, y) => { context.window.scrollY = y; },
            addEventListener: (type, listener) => { windowListeners[type] = listener; },
        },
        requestAnimationFrame: callback => callback(),
    };
    vm.runInNewContext(source, context);

    assert.strictEqual(context.normalizeDashboardTab('projects'), 'projects');
    assert.strictEqual(context.normalizeDashboardTab('invalid'), 'open');
    assert.strictEqual(context.getAdjacentDashboardTab('open', 'ArrowRight'), 'projects');
    assert.strictEqual(context.getAdjacentDashboardTab('projects', 'ArrowLeft'), 'open');
    assert.strictEqual(context.validateProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 2, html: '<div></div>',
    }), true);
    assert.strictEqual(context.validateProjectsPanelMessage({
        type: 'projects-panel-content', version: 2, requestId: 2, html: '<div></div>',
    }), false);
    assert.strictEqual(context.globToDashboardRegex('dash*').test('dashboard'), true);
    assert.strictEqual(context.globToDashboardRegex('data?').test('data1'), true);
    const sections = context.filterDashboardCatalog(makeDashboardCatalog(), 'dashboard');
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(sections.map(section => section.id))),
        ['ai-sessions', 'open-projects', 'saved-projects']
    );
    assert.strictEqual(context.filterDashboardCatalog(makeDashboardCatalog(), 'missing').length, 0);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(context.normalizeDashboardSearchCatalog(null))),
        { sessions: [], openProjects: [], savedProjects: [] }
    );
    const state = {
        activeTab: 'projects',
        searchQuery: 'dash',
        scrollPositions: { open: 12, projects: 34 },
        catalog: makeDashboardCatalog(),
    };
    const nextState = context.replaceDashboardSearchCatalogState(state, makeUpdatedDashboardCatalog());
    assert.strictEqual(nextState.activeTab, 'projects');
    assert.strictEqual(nextState.searchQuery, 'dash');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(nextState.scrollPositions)), { open: 12, projects: 34 });
    assert.notStrictEqual(nextState.catalog, state.catalog);

    let mounted = 0;
    const controller = context.initDashboard({
        postMessage: message => messages.push(message),
        onProjectsMounted: panel => {
            assert.strictEqual(panel, projectsPanel);
            mounted += 1;
        },
    });
    assert.strictEqual(controller.getActiveTab(), 'open');
    assert.strictEqual(openPanel.hidden, false);
    assert.strictEqual(projectsPanel.hidden, true);
    assert.strictEqual(openButton.getAttribute('aria-selected'), 'true');
    assert.strictEqual(projectsButton.getAttribute('tabindex'), '-1');

    context.window.scrollY = 37;
    controller.activateTab('projects');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages)), [
        { type: 'request-projects-panel', version: 1, requestId: 1 },
    ]);
    assert.strictEqual(controller.getProjectsState(), 'loading');
    assert.strictEqual(controller.getScrollPosition('open'), 37);
    controller.ensureProjectsPanel();
    assert.strictEqual(messages.length, 1, 'PROJECTS must be requested only once while loading');
    assert.strictEqual(controller.applyProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 0, html: '<div>stale</div>',
    }), false);
    assert.strictEqual(projectsPanel.innerHTML, '');
    controller.activateTab('open');
    const openScrollBeforeResponse = context.window.scrollY;
    assert.strictEqual(controller.applyProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 1, html: '<div>projects</div>',
    }), true);
    assert.strictEqual(context.window.scrollY, openScrollBeforeResponse, 'background PROJECTS mount must not move OPEN scroll');
    assert.strictEqual(projectsPanel.innerHTML, '<div>projects</div>');
    assert.strictEqual(controller.getProjectsState(), 'mounted');
    assert.strictEqual(mounted, 1);
    controller.ensureProjectsPanel();
    assert.strictEqual(messages.length, 1, 'mounted PROJECTS must not be requested again');
    assert.strictEqual(typeof windowListeners.message, 'function');

    storage.set('projectSteward.activeDashboardTab', 'projects');
    const searchMessages = [];
    const searchController = context.initDashboard({
        initialSearchQuery: 'dashboard',
        postMessage: message => searchMessages.push(message),
    });
    assert.strictEqual(searchController.getActiveTab(), 'projects');
    assert.strictEqual(searchController.isSearchActive(), true);
    assert.strictEqual(searchController.getProjectsState(), 'unloaded');
    assert.strictEqual(searchMessages.length, 0, 'restored search must not load PROJECTS');
    searchController.setSearchQuery('');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(searchMessages)), [
        { type: 'request-projects-panel', version: 1, requestId: 1 },
    ]);
    context.window.scrollY = 88;
    searchController.setSearchQuery('dashboard');
    context.window.scrollY = 15;
    assert.strictEqual(searchController.applyProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 1, html: '<div>projects while searching</div>',
    }), true);
    assert.strictEqual(context.window.scrollY, 15, 'background PROJECTS mount must not move search results');
}

function runSourceContractChecks(source) {
    const projectSource = fs.readFileSync(projectScriptPath, 'utf8');
    const dndSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDnDScripts.js'), 'utf8');
    const filterSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewFilterScripts.js'), 'utf8');
    const extensionHostSource = fs.readFileSync(extensionHostPath, 'utf8');
    const styles = fs.readFileSync(path.join(root, 'media', 'styles.scss'), 'utf8');
    const updateMessagePath = path.join(root, 'src', 'dashboard', 'webviewUpdateMessages.ts');
    assert.ok(fs.existsSync(updateMessagePath));
    const updateMessages = fs.readFileSync(updateMessagePath, 'utf8');
    assert.ok(updateMessages.includes('export function buildOpenProjectsUpdatedMessage('));
    assert.ok(updateMessages.includes('export function buildAiSessionsUpdatedMessage('));
    assert.ok(updateMessages.includes("type: 'open-projects-updated'"));
    assert.ok(updateMessages.includes("type: 'ai-sessions-updated'"));
    assert.ok(updateMessages.includes('version: 1'));
    const viewProviderPath = path.join(root, 'src', 'dashboard', 'viewProvider.ts');
    assert.ok(fs.existsSync(viewProviderPath));
    const viewProviderSource = fs.readFileSync(viewProviderPath, 'utf8');
    assert.ok(viewProviderSource.includes('export class SidebarStewardViewProvider implements vscode.WebviewViewProvider'));
    assert.ok(viewProviderSource.includes('refresh()'));
    assert.ok(viewProviderSource.includes('postMessage(message: unknown)'));
    const routerPath = path.join(root, 'src', 'dashboard', 'messageRouter.ts');
    assert.ok(fs.existsSync(routerPath));
    const routerSource = fs.readFileSync(routerPath, 'utf8');
    assert.ok(routerSource.includes('export interface DashboardMessageHandlers'));
    assert.ok(routerSource.includes('handlers: Record<string, DashboardMessageHandler>'));
    assert.ok(routerSource.includes('resumeAiSession?: DashboardAiSessionMessageHandler'));
    assert.ok(routerSource.includes('archiveAiSession?: DashboardAiSessionMessageHandler'));
    assert.ok(routerSource.includes('export function createDashboardMessageRouter('));
    assert.strictEqual(routerSource.includes('handleRawMessage'), false);

    assert.ok(source.includes("projectSteward.activeDashboardTab"));
    assert.ok(source.includes("setAttribute('aria-selected'"));
    assert.ok(source.includes("setAttribute('tabindex'"));
    assert.ok(source.includes('scrollPositions'));
    assert.ok(source.includes('acceptedProjectsRequestId'));
    assert.ok(source.includes('pendingScrollRestoreTab'));
    assert.ok(extensionHostSource.includes("'request-projects-panel': async e =>"));
    assert.strictEqual(extensionHostSource.includes('function handleStewardMessage('), false);
    assert.ok(extensionHostSource.includes('getAiSessionProviderIds: () => getRegisteredAiSessionProviders().map(provider => provider.id)'));
    assert.ok(extensionHostSource.includes("type: 'projects-panel-content'"));
    assert.ok(extensionHostSource.includes('getProjectsPanelContent(projectService.getGroups(), stewardInfos)'));
    assert.ok(projectSource.includes("e.target.closest('[data-action=\"add-project\"]')"));
    assert.ok(projectSource.includes("e.target.closest('[data-action=\"import-from-other-storage\"]')"));
    assert.strictEqual(projectSource.includes(".querySelectorAll('[data-action=\"add-project\"]')"), false);
    assert.strictEqual(projectSource.includes(".querySelectorAll('[data-action=\"import-from-other-storage\"]')"), false);
    assert.ok(dndSource.includes('function initDnD(root)'));
    assert.ok(dndSource.includes('root.__projectStewardDnDInitialized'));
    assert.strictEqual(dndSource.includes('document.querySelectorAll(`${groupsContainerSelector}'), false);
    assert.ok(projectSource.includes("type: 'collapse-group'"));
    assert.ok(projectSource.includes('Collapse Other Windows'));
    assert.ok(projectSource.includes('Expand Other Windows'));
    assert.ok(projectSource.includes('aria-disabled'));

    const projectContext = {};
    vm.runInNewContext(projectSource, projectContext);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(projectContext.getCollapseButtonState('open', []))),
        { disabled: true, collapsed: false, title: 'No other windows to collapse' }
    );
    assert.strictEqual(projectContext.getCollapseButtonState('open', [false]).title, 'Collapse Other Windows');
    assert.strictEqual(projectContext.getCollapseButtonState('open', [true]).title, 'Expand Other Windows');
    assert.strictEqual(projectContext.getCollapseButtonState('projects', [false, true]).title, 'Collapse All Groups');
    assert.strictEqual(projectContext.getCollapseButtonState('projects', [true, true]).title, 'Expand All Groups');

    const renderSearchBody = extractFunctionBody(source, 'renderDashboardSearchResults');
    assert.ok(renderSearchBody.includes('textContent'));
    assert.ok(renderSearchBody.includes("createElement('button')"));
    assert.strictEqual(renderSearchBody.includes('innerHTML'), false);
    assert.strictEqual(renderSearchBody.includes('project-ai-attention-badge'), false);
    assert.strictEqual(renderSearchBody.includes('data-current-workspace'), false);
    assert.ok(filterSource.includes('ctrlKey'));
    assert.ok(filterSource.includes('metaKey'));
    assert.ok(filterSource.includes('Escape'));
    assert.ok(source.includes('initialSearchQuery'));
    assert.ok(source.includes('replaceSearchCatalog'));
    assert.ok(source.includes('isSearchActive'));
    assert.ok(projectSource.includes('__projectStewardAcknowledgeSession'));
    assert.ok(projectSource.includes('__projectStewardShowCurrentProject'));
    const refreshStewardViewsBody = extractFunctionBody(extensionHostSource, 'refreshStewardViews');
    const aiSessionsMessageBody = extractFunctionBody(extensionHostSource, 'getAiSessionsUpdatedMessage');
    const openProjectsMessageBody = extractFunctionBody(extensionHostSource, 'postOpenProjectsUpdated');
    const openProjectControllerSource = fs.readFileSync(path.join(root, 'src', 'openProjects', 'dashboardController.ts'), 'utf8');
    const aiSessionControllerSource = fs.readFileSync(path.join(root, 'src', 'aiSessions', 'dashboardController.ts'), 'utf8');
    const dashboardDiagnosticsSource = fs.readFileSync(path.join(root, 'src', 'dashboard', 'diagnostics.ts'), 'utf8');
    const dashboardErrorContentSource = fs.readFileSync(path.join(root, 'src', 'dashboard', 'errorContent.ts'), 'utf8');
    const dashboardRuntimeControllerSource = fs.readFileSync(path.join(root, 'src', 'dashboard', 'runtimeController.ts'), 'utf8');
    const baseServiceSource = fs.readFileSync(path.join(root, 'src', 'services', 'baseService.ts'), 'utf8');
    assert.ok(refreshStewardViewsBody.includes('dashboardRuntimeController.refresh(reason);'));
    assert.ok(dashboardRuntimeControllerSource.includes('this.options.refreshProvider();'));
    assert.ok(dashboardRuntimeControllerSource.includes('this.options.logDashboardDiagnostic({'));
    assert.ok(extensionHostSource.includes('new DashboardDiagnostics({'));
    assert.ok(!extensionHostSource.includes('function logDashboardDiagnostic('));
    assert.ok(dashboardDiagnosticsSource.includes('logDashboardDiagnostic('));
    assert.ok(extensionHostSource.includes("from './dashboard/errorContent'"));
    assert.ok(!extensionHostSource.includes('function getErrorContent('));
    assert.ok(!extensionHostSource.includes('function escapeHtml('));
    assert.ok(dashboardErrorContentSource.includes('export function getErrorContent('));
    assert.ok(dashboardErrorContentSource.includes('Project Steward could not render this view.'));
    const dashboardConfigurationSource = fs.readFileSync(path.join(root, 'src', 'dashboard', 'configuration.ts'), 'utf8');
    assert.ok(extensionHostSource.includes("from './dashboard/configuration'"));
    assert.ok(!extensionHostSource.includes('function getStewardConfiguration('));
    assert.ok(!extensionHostSource.includes('function hasConfiguredValue('));
    assert.ok(dashboardConfigurationSource.includes('export function createStewardConfiguration('));
    assert.ok(dashboardConfigurationSource.includes('export function hasConfiguredValue('));
    assert.ok(baseServiceSource.includes("from '../dashboard/configuration'"));
    assert.strictEqual(baseServiceSource.includes('private hasConfiguredValue('), false);
    const dashboardStartupSource = fs.readFileSync(path.join(root, 'src', 'dashboard', 'startup.ts'), 'utf8');
    const dashboardStartupControllerSource = fs.readFileSync(path.join(root, 'src', 'dashboard', 'startupController.ts'), 'utf8');
    assert.ok(extensionHostSource.includes("from './dashboard/startupController'"));
    assert.ok(!extensionHostSource.includes('function showStewardOnOpenIfNeeded('));
    assert.ok(dashboardStartupSource.includes('export function shouldOpenStewardOnStartup('));
    assert.ok(dashboardStartupSource.includes('code-runner-output'));
    assert.ok(dashboardStartupControllerSource.includes('export class DashboardStartupController'));
    assert.ok(dashboardStartupControllerSource.includes('shouldOpenStewardOnStartup({'));
    const dashboardWebviewOptionsSource = fs.readFileSync(path.join(root, 'src', 'dashboard', 'webviewOptions.ts'), 'utf8');
    assert.ok(extensionHostSource.includes("from './dashboard/webviewOptions'"));
    assert.ok(!extensionHostSource.includes('function getWebviewOptions('));
    assert.ok(dashboardWebviewOptionsSource.includes('export function getDashboardWebviewOptions('));
    const groupCollapseControllerSource = fs.readFileSync(path.join(root, 'src', 'dashboard', 'groupCollapseController.ts'), 'utf8');
    assert.ok(extensionHostSource.includes("from './dashboard/groupCollapseController'"));
    assert.ok(!extensionHostSource.includes('async function collapseGroup('));
    assert.ok(!extensionHostSource.includes('context.globalState.update(FAVORITES_GROUP_COLLAPSED_KEY'));
    assert.ok(!extensionHostSource.includes('context.globalState.update(OPEN_PROJECTS_GROUP_COLLAPSED_KEY'));
    assert.ok(groupCollapseControllerSource.includes('export class GroupCollapseController'));
    assert.ok(groupCollapseControllerSource.includes('collapseGroup('));
    const groupPromptsSource = fs.readFileSync(path.join(root, 'src', 'projects', 'groupPrompts.ts'), 'utf8');
    assert.ok(extensionHostSource.includes("from './projects/groupPrompts'"));
    assert.ok(!extensionHostSource.includes('async function queryGroupFields('));
    assert.ok(groupPromptsSource.includes('export async function queryGroupName('));
    const groupCommandControllerSource = fs.readFileSync(path.join(root, 'src', 'projects', 'groupCommandController.ts'), 'utf8');
    assert.ok(extensionHostSource.includes("from './projects/groupCommandController'"));
    assert.ok(!extensionHostSource.includes('async function addGroup('));
    assert.ok(!extensionHostSource.includes('async function editGroup('));
    assert.ok(!extensionHostSource.includes('async function removeGroup('));
    assert.ok(groupCommandControllerSource.includes('export class GroupCommandController'));
    const addProjectsFromFolderControllerSource = fs.readFileSync(path.join(root, 'src', 'projects', 'addProjectsFromFolderController.ts'), 'utf8');
    assert.ok(extensionHostSource.includes("from './projects/addProjectsFromFolderController'"));
    assert.ok(!extensionHostSource.includes('async function addProjectsFromFolder('));
    assert.ok(addProjectsFromFolderControllerSource.includes('export class AddProjectsFromFolderController'));
    const favoriteProjectControllerSource = fs.readFileSync(path.join(root, 'src', 'projects', 'favoriteProjectController.ts'), 'utf8');
    assert.ok(extensionHostSource.includes("from './projects/favoriteProjectController'"));
    assert.ok(!extensionHostSource.includes('async function toggleProjectFavorite('));
    assert.ok(!extensionHostSource.includes('async function reorderFavoriteProjects('));
    assert.ok(!extensionHostSource.includes('withFavoriteProjectOrder(groups, projectIds)'));
    assert.ok(!extensionHostSource.includes('withToggledProjectFavorite(groups, projectId)'));
    assert.ok(favoriteProjectControllerSource.includes('export class FavoriteProjectController'));
    const projectOrderControllerSource = fs.readFileSync(path.join(root, 'src', 'projects', 'projectOrderController.ts'), 'utf8');
    assert.ok(extensionHostSource.includes("from './projects/projectOrderController'"));
    assert.ok(!extensionHostSource.includes('async function reorderGroups('));
    assert.ok(projectOrderControllerSource.includes('export class ProjectOrderController'));
    const projectRemovalControllerSource = fs.readFileSync(path.join(root, 'src', 'projects', 'projectRemovalController.ts'), 'utf8');
    assert.ok(extensionHostSource.includes("from './projects/projectRemovalController'"));
    assert.ok(!extensionHostSource.includes('async function removeProject('));
    assert.ok(projectRemovalControllerSource.includes('export class ProjectRemovalController'));
    assert.ok(openProjectsMessageBody.includes('openProjectDashboardController.postUpdated()'));
    assert.ok(openProjectControllerSource.includes('buildOpenProjectsUpdatedMessage({'));
    assert.ok(openProjectControllerSource.includes('groups: this.options.getGroups()'));
    assert.ok(openProjectControllerSource.includes('cards'));
    assert.ok(openProjectControllerSource.includes('semanticRevision: this.aggregate.semanticRevision'));
    assert.ok(aiSessionsMessageBody.includes('aiSessionDashboardController.getUpdatedMessage()'));
    assert.ok(aiSessionControllerSource.includes('buildAiSessionsUpdatedMessage({'));
    assert.ok(aiSessionControllerSource.includes('groups: this.options.getGroups()'));
    assert.ok(aiSessionControllerSource.includes('cards'));
    assert.ok(aiSessionControllerSource.includes('sequence: this.options.nextSequence()'));
    assert.ok(projectSource.includes('replaceSearchCatalog(message.searchCatalog)'));
    assert.strictEqual(projectSource.includes("sessionStorage.setItem('projectSteward.activeDashboardTab', 'open')"), false);
    for (const selector of [
        '.dashboard-tab-list', '.dashboard-tab-button', '.dashboard-tab-panel',
        '.dashboard-search-results', '.dashboard-search-section', '.dashboard-search-result',
        '.open-current-workspace-group', '.open-other-windows-group', '.dashboard-projects-loading',
    ]) {
        assert.ok(styles.includes(selector), `missing ${selector}`);
    }
    assert.strictEqual((source.match(/type: 'request-projects-panel'/g) || []).length, 1);
    assert.ok(extractFunctionBody(source, 'ensureProjectsPanel').includes("type: 'request-projects-panel'"));
    assert.strictEqual(extractFunctionBody(source, 'renderSearchMode').includes('ensureProjectsPanel()'), false);
    assert.ok(source.includes("document.body.classList.toggle('dashboard-search-active'"));
}

async function runDashboardMessageRouterChecks() {
    const routerModule = require(path.join(root, 'out', 'dashboard', 'messageRouter.js'));
    const calls = [];
    const router = routerModule.createDashboardMessageRouter({
        getAiSessionProviderIds: () => ['codex', 'kimi', 'claude'],
        handlers: {
            'request-projects-panel': async message => {
                calls.push(['request-projects-panel', message.requestId]);
            },
            'selected-project': message => {
                calls.push(['selected-project', message.projectId]);
            },
        },
        resumeAiSession: (message, providerId) => {
            calls.push(['resume-ai-session', providerId, message.sessionId]);
        },
        archiveAiSession: (message, providerId) => {
            calls.push(['archive-ai-session', providerId, message.sessionId]);
        },
    });

    await router(null);
    await router({});
    await router({ type: 'unknown-message' });
    assert.deepStrictEqual(calls, []);

    await router({ type: 'request-projects-panel', requestId: 7 });
    await router({ type: 'selected-project', projectId: 'project-a' });
    await router({ type: 'resume-ai-session', provider: 'codex', sessionId: 'c1' });
    await router({ type: 'resume-ai-session', provider: 'unknown', sessionId: 'invalid' });
    await router({ type: 'resume-kimi-session', sessionId: 'k1' });
    await router({ type: 'archive-claude-session', sessionId: 'a1' });
    await router({ type: 'resume-unknown-session', sessionId: 'ignored' });

    assert.deepStrictEqual(calls, [
        ['request-projects-panel', 7],
        ['selected-project', 'project-a'],
        ['resume-ai-session', 'codex', 'c1'],
        ['resume-ai-session', null, 'invalid'],
        ['resume-ai-session', 'kimi', 'k1'],
        ['archive-ai-session', 'claude', 'a1'],
    ]);
}

async function main() {
    const source = fs.readFileSync(dashboardScriptPath, 'utf8');
    runErrorContentChecks();
    runConfigurationChecks();
    runStartupChecks();
    runWebviewOptionsChecks();
    await runGroupCollapseControllerChecks();
    await runGroupPromptChecks();
    await runGroupCommandControllerChecks();
    await runAddProjectsFromFolderControllerChecks();
    await runFavoriteProjectControllerChecks();
    await runProjectOrderControllerChecks();
    await runProjectRemovalControllerChecks();
    await runDashboardRuntimeControllerChecks();
    await runDashboardStartupControllerChecks();
    await runDashboardLifecycleControllerChecks();
    await runDashboardCommandRegistrationChecks();
    runControllerChecks(source);
    runSourceContractChecks(source);
    await runDashboardMessageRouterChecks();
    console.log('Dashboard Webview checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
