'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const vm = require('vm');
const commands = require('../out/aiSessions/commandBuilders');
const helpers = require('../out/aiSessions/sessionHelpers');
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

function runWebviewContentChecks() {
    const webviewContent = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'webviewContent.ts'), 'utf8');
    const webviewProjectScripts = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'webviewProjectScripts.js'), 'utf8');
    const webviewIcons = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'webviewIcons.ts'), 'utf8');
    const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.scss'), 'utf8');
    const compiledStyles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    const withAiSessionsFunction = extractFunctionBody(dashboard, 'withAiSessions');
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
    assert.ok(!webviewContent.includes('codex-session-meta-chip'));
    assert.ok(webviewContent.includes("join(' · ')"));
    assert.ok(styles.includes('.codex-session-actions'));
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

runPathChecks();
runAssignmentChecks();
runCurrentWorkspaceStateChecks();
runFavoriteProjectOrderChecks();
runCurrentWorkspaceMatchingChecks();
runCandidateFilterChecks();
runDisplayChecks();
runPinStoreChecks();
runKeyChecks();
runWebviewContentChecks();
runCurrentWorkspaceRenderingChecks();
runFavoriteRenderingChecks();
runFavoriteDndChecks();
runGitRepositoryDetectorChecks();
runClaudeSessionChecks();
runProviderChecks();
runCommandBuilderChecks();

console.log('AI session safety checks passed.');
