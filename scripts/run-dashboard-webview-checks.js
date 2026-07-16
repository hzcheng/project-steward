'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dashboardErrorContent = require('../out/dashboard/errorContent');
const dashboardConfiguration = require('../out/dashboard/configuration');
const dashboardStartup = require('../out/dashboard/startup');
const dashboardWebviewOptions = require('../out/dashboard/webviewOptions');

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
    const baseServiceSource = fs.readFileSync(path.join(root, 'src', 'services', 'baseService.ts'), 'utf8');
    assert.ok(refreshStewardViewsBody.includes('provider.refresh();'));
    assert.ok(refreshStewardViewsBody.includes('logDashboardDiagnostic({'));
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
    assert.ok(extensionHostSource.includes("from './dashboard/startup'"));
    assert.ok(!extensionHostSource.includes('function showStewardOnOpenIfNeeded('));
    assert.ok(dashboardStartupSource.includes('export function shouldOpenStewardOnStartup('));
    assert.ok(dashboardStartupSource.includes('code-runner-output'));
    const dashboardWebviewOptionsSource = fs.readFileSync(path.join(root, 'src', 'dashboard', 'webviewOptions.ts'), 'utf8');
    assert.ok(extensionHostSource.includes("from './dashboard/webviewOptions'"));
    assert.ok(!extensionHostSource.includes('function getWebviewOptions('));
    assert.ok(dashboardWebviewOptionsSource.includes('export function getDashboardWebviewOptions('));
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
    runControllerChecks(source);
    runSourceContractChecks(source);
    await runDashboardMessageRouterChecks();
    console.log('Dashboard Webview checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
