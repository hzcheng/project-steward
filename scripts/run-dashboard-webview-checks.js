'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const vm = require('vm');
const CleanCSS = require('clean-css');
const sass = require('sass');
const dashboardErrorContent = require('../out/dashboard/errorContent');
const dashboardConfiguration = require('../out/dashboard/configuration');
const dashboardStartup = require('../out/dashboard/startup');
const { DashboardStartupController, settleMigration } = require('../out/dashboard/startupController');
const { DashboardLifecycleController } = require('../out/dashboard/lifecycleController');
const { DashboardCommandRegistration } = require('../out/dashboard/commandRegistration');
const activeTerminalFileReference = require('../out/dashboard/activeTerminalFileReference');
const dashboardWebviewOptions = require('../out/dashboard/webviewOptions');
const { GroupCollapseController } = require('../out/dashboard/groupCollapseController');
const { DashboardRuntimeController } = require('../out/dashboard/runtimeController');
const { AddProjectsFromFolderController } = require('../out/projects/addProjectsFromFolderController');
const { FavoriteProjectController } = require('../out/projects/favoriteProjectController');
const { GroupCommandController } = require('../out/projects/groupCommandController');
const { queryGroupName } = require('../out/projects/groupPrompts');
const { ProjectOrderController } = require('../out/projects/projectOrderController');
const { ProjectRemovalController } = require('../out/projects/projectRemovalController');
const todoTypes = require('../out/todos/types');
const { TodoService } = require('../out/todos/service');
const { deleteTodoWithConfirmation, runTodoMutation } = require('../out/todos/hostMutation');
const todoViewModel = require('../out/todos/viewModel');
const todoWebviewContent = require('../out/todos/webviewContent');
const { buildWorkspaceDashboardSearchCatalog } = require('../out/webview/dashboardViewModel');
const AsyncFunction = Object.getPrototypeOf(async function () { return undefined; }).constructor;

const root = path.join(__dirname, '..');
const dashboardScriptPath = path.join(root, 'src', 'webview', 'webviewDashboardScripts.js');
const projectScriptPath = path.join(root, 'src', 'webview', 'webviewProjectScripts.js');
const extensionHostPath = path.join(root, 'src', 'dashboard.ts');

function compileDashboardStyles(source) {
    return sass.compileString(source, {
        loadPaths: [path.join(root, 'media'), path.join(root, 'node_modules')],
        style: 'expanded',
    }).css;
}

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

function extractAsyncArrowPropertyBody(source, propertyName) {
    const signature = `${propertyName}: async () => {`;
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `Missing async property ${propertyName}`);
    const braceStart = source.indexOf('{', start);
    let depth = 0;
    for (let index = braceStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(braceStart + 1, index);
    }
    throw new Error(`Unterminated async property ${propertyName}`);
}

function extractHtmlElementBody(source, openingTag) {
    const start = source.indexOf(openingTag);
    assert.ok(start >= 0, `Missing HTML element ${openingTag}`);
    const tagNameMatch = openingTag.match(/^<([a-z][\w-]*)\b/i);
    assert.ok(tagNameMatch, `Invalid HTML opening tag ${openingTag}`);
    const tagName = tagNameMatch[1];
    const openingTagEnd = source.indexOf('>', start);
    assert.ok(openingTagEnd >= 0, `Unterminated HTML opening tag ${openingTag}`);
    const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
    tagPattern.lastIndex = openingTagEnd + 1;
    let depth = 1;
    let match;
    while ((match = tagPattern.exec(source))) {
        if (match[0].startsWith('</')) {
            depth -= 1;
            if (depth === 0) return source.slice(openingTagEnd + 1, match.index);
        } else if (!match[0].endsWith('/>')) {
            depth += 1;
        }
    }
    throw new Error(`Unterminated HTML element ${openingTag}`);
}

function extractDirectHtmlChildOpeningTags(source) {
    const children = [];
    const tagPattern = /<\/?([a-z][\w-]*)\b[^>]*>/gi;
    let depth = 0;
    let match;
    while ((match = tagPattern.exec(source))) {
        const tag = match[0];
        if (tag.startsWith('</')) {
            depth -= 1;
        } else {
            if (depth === 0) children.push(tag);
            if (!tag.endsWith('/>')) depth += 1;
        }
    }
    assert.strictEqual(depth, 0, 'HTML fragment must contain balanced child elements');
    return children;
}

function extractCssRule(source, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`(^|\\n)\\s*${escapedSelector}\\s*\\{`, 'm'));
    assert.ok(match, `Missing CSS rule ${selector}`);
    const start = match.index + match[0].lastIndexOf(selector);
    const braceStart = source.indexOf('{', start);
    let depth = 0;
    for (let index = braceStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(braceStart + 1, index);
    }
    throw new Error(`Unterminated CSS rule ${selector}`);
}

function extractCssRules(source, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selectorPattern = new RegExp(`(^|\\n)\\s*${escapedSelector}\\s*\\{`, 'gm');
    const rules = [];
    let match;
    while ((match = selectorPattern.exec(source))) {
        const braceStart = source.indexOf('{', match.index);
        let depth = 0;
        for (let index = braceStart; index < source.length; index += 1) {
            if (source[index] === '{') depth += 1;
            if (source[index] === '}') depth -= 1;
            if (depth === 0) {
                rules.push(source.slice(braceStart + 1, index));
                selectorPattern.lastIndex = index + 1;
                break;
            }
        }
    }
    assert.ok(rules.length > 0, `Missing CSS rules ${selector}`);
    return rules;
}

function extractCssRulesContainingSelector(source, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selectorPattern = new RegExp(`(^|\\n)[^{}]*${escapedSelector}(?![\\w-])[^{}]*\\{`, 'gm');
    const rules = [];
    let match;
    while ((match = selectorPattern.exec(source))) {
        const braceStart = source.indexOf('{', match.index);
        let depth = 0;
        for (let index = braceStart; index < source.length; index += 1) {
            if (source[index] === '{') depth += 1;
            if (source[index] === '}') depth -= 1;
            if (depth === 0) {
                rules.push(source.slice(braceStart + 1, index));
                selectorPattern.lastIndex = index + 1;
                break;
            }
        }
    }
    assert.ok(rules.length > 0, `Missing CSS rules containing ${selector}`);
    return rules;
}

function extractCompiledCssRulesContainingSelector(source, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selectorPattern = new RegExp(`${escapedSelector}(?![\\w-])`);
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    const rules = [];
    let match;
    while ((match = rulePattern.exec(source))) {
        const selectors = match[1].split(',').map(value => value.trim()).filter(Boolean);
        if (selectors.some(value => selectorPattern.test(value))) {
            rules.push({ selectors, body: match[2] });
        }
    }
    assert.ok(rules.length > 0, `Missing compiled CSS rules containing ${selector}`);
    return rules;
}

function cssRuleIncludesDeclaration(rule, declaration) {
    const escapedDeclaration = declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[;{}\\n])\\s*${escapedDeclaration}`).test(rule);
}

function cssRuleIncludesTopLevelDeclaration(rule, declaration) {
    let depth = 0;
    let topLevelRule = '';
    for (const character of rule) {
        if (character === '{') {
            depth += 1;
        } else if (character === '}') {
            depth -= 1;
        } else if (depth === 0) {
            topLevelRule += character;
        }
    }
    return cssRuleIncludesDeclaration(topLevelRule, declaration);
}

function makeDashboardCatalog() {
    return {
        version: 2,
        sessions: [{
            key: 'codex:c1', searchText: 'fix dashboard codex c1', workspaceId: 'workspace-current',
            workspaceNavigationIdentity: 'navigation-current', workspaceName: 'Dashboard Workspace',
            provider: 'codex', sessionId: 'c1', name: 'Fix dashboard', active: true,
            action: 'reveal-workspace-session',
        }],
        openWorkspaces: [{
            key: 'workspace:navigation-current', navigationIdentity: 'navigation-current',
            searchText: 'dashboard workspace local app api', workspaceId: 'workspace-current',
            name: 'Dashboard Workspace', description: '2 folders', environmentLabel: 'Local',
            action: 'show-current-workspace', current: true,
        }],
        savedProjects: [{
            key: 'saved:/work/dashboard', identity: '/work/dashboard', searchText: 'dashboard tools',
            projectId: 'saved', name: 'Dashboard', description: 'Saved',
            action: 'open-saved', groupLabels: ['FAVORITES', 'TOOLS'],
        }],
        todos: [{
            key: 'todo:t1', todoId: 't1', groupId: 'todo-group-a', searchText: 'ship todo planning',
            title: 'Ship TODO', groupTitle: 'Planning', priority: 'high', completed: false, notesSearchText: 'planning',
        }],
    };
}

function makeUpdatedDashboardCatalog() {
    const catalog = makeDashboardCatalog();
    return {
        ...catalog,
        sessions: catalog.sessions.concat({
            key: 'kimi:k1', searchText: 'review dashboard kimi k1', workspaceId: 'workspace-current',
            workspaceNavigationIdentity: 'navigation-current', workspaceName: 'Dashboard Workspace',
            provider: 'kimi', sessionId: 'k1', name: 'Review dashboard',
            action: 'reveal-workspace-session',
        }),
    };
}

function makeWorkspaceDashboardCatalog() {
    return {
        version: 2,
        sessions: [{
            key: 'codex:c1', searchText: 'fix dashboard codex c1', workspaceId: 'workspace-current',
            workspaceNavigationIdentity: 'navigation-current', workspaceName: 'Dashboard Workspace',
            provider: 'codex', sessionId: 'c1', name: 'Fix dashboard', active: true,
            action: 'reveal-workspace-session',
        }],
        openWorkspaces: [{
            key: 'workspace:navigation-current', navigationIdentity: 'navigation-current',
            searchText: 'dashboard workspace local app api', workspaceId: 'workspace-current',
            name: 'Dashboard Workspace', description: '2 folders', environmentLabel: 'Local',
            action: 'show-current-workspace', current: true,
        }, {
            key: 'workspace:navigation-other', navigationIdentity: 'navigation-other',
            searchText: 'other workspace ssh other', workspaceId: 'workspace-other',
            name: 'Other Workspace', description: '1 folder', environmentLabel: 'SSH',
            action: 'switch-open-workspace', current: false,
        }],
        savedProjects: makeDashboardCatalog().savedProjects,
        todos: makeDashboardCatalog().todos,
    };
}

function runDashboardUpdateMessageChecks() {
    const previousModuleLoad = Module._load;
    let dashboardUpdateMessages;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return {};
            }
            return previousModuleLoad.call(this, request, parent, isMain);
        };
        dashboardUpdateMessages = require('../out/dashboard/webviewUpdateMessages');
    } finally {
        Module._load = previousModuleLoad;
    }
    const todoSearchItems = makeDashboardCatalog().todos;
    const workspaceCard = makeWorkspaceCardFixture(3);
    const aiMessage = dashboardUpdateMessages.buildAiSessionsUpdatedMessage({
        groups: [],
        cards: [workspaceCard],
        sequence: 7,
        generatedAt: '2026-07-17T00:00:00.000Z',
        todoSearchItems,
        runningCardAnimation: 'ripple',
    });
    const workspaceMessage = dashboardUpdateMessages.buildWorkspaceUpdatedMessage({
        card: workspaceCard,
        runningCardAnimation: 'sweep',
    });
    const navigationCard = {
        ...makeWorkspaceCardFixture(2),
        id: 'workspace-other',
        kind: 'navigation',
        navigationIdentity: 'navigation-other',
        scopeIdentity: 'scope-other',
        name: 'Other Workspace',
        environment: 'ssh',
        environmentLabel: 'SSH',
        aiSessions: undefined,
    };
    const openWorkspacesMessage = dashboardUpdateMessages.buildOpenWorkspacesUpdatedMessage({
        groups: [],
        cards: [workspaceCard, navigationCard],
        collapsed: false,
        semanticRevision: 'b'.repeat(64),
        otherWindowsStatus: 'ready',
        todoSearchItems,
        runningCardAnimation: 'halo',
    });
    const workspaceSearchCatalog = buildWorkspaceDashboardSearchCatalog([], [workspaceCard], todoSearchItems);

    assert.deepStrictEqual(aiMessage.searchCatalog.todos, todoSearchItems,
        'AI incremental catalog rebuilds must preserve real TODO search items');
    assert.strictEqual(aiMessage.version, 2);
    assert.strictEqual(aiMessage.currentWorkspaceCount, 1);
    assert.strictEqual(aiMessage.searchCatalog.version, 2);
    assert.deepStrictEqual(aiMessage.searchCatalog.openWorkspaces.map(item => item.current), [true]);
    assert.ok(aiMessage.html.includes('data-current-workspace'));
    assert.ok(aiMessage.html.includes('data-session-fx="ripple"'),
        'AI session incremental updates must use the configured running animation');
    assert.strictEqual(workspaceMessage.type, 'workspace-updated');
    assert.strictEqual(workspaceMessage.version, 2);
    assert.strictEqual(workspaceSearchCatalog.version, 2);
    assert.deepStrictEqual(workspaceSearchCatalog.openWorkspaces.map(item => item.current), [true]);
    assert.deepStrictEqual(workspaceSearchCatalog.sessions.map(item => item.action), ['reveal-workspace-session']);
    assert.deepStrictEqual(workspaceSearchCatalog.todos, todoSearchItems);
    assert.strictEqual(workspaceMessage.currentWorkspaceCount, 1);
    assert.ok(workspaceMessage.html.includes('data-workspace-scope-identity="scope-dashboard"'));
    assert.ok(workspaceMessage.html.includes('data-session-fx="sweep"'),
        'workspace incremental updates must use the configured running animation');
    const emptyWorkspaceMessage = dashboardUpdateMessages.buildWorkspaceUpdatedMessage({ card: null });
    assert.strictEqual(emptyWorkspaceMessage.currentWorkspaceCount, 0);
    assert.strictEqual(emptyWorkspaceMessage.html.includes('class="workspace-card'), false);
    assert.strictEqual(openWorkspacesMessage.type, 'open-workspaces-updated');
    assert.strictEqual(openWorkspacesMessage.version, 2);
    assert.strictEqual(openWorkspacesMessage.currentWorkspaceCount, 1);
    assert.strictEqual(openWorkspacesMessage.navigationWorkspaceCount, 1);
    assert.strictEqual(openWorkspacesMessage.searchCatalog.version, 2);
    assert.strictEqual(openWorkspacesMessage.otherWindowsStatus, 'ready');
    assert.deepStrictEqual(
        openWorkspacesMessage.searchCatalog.openWorkspaces.map(item => item.action),
        ['show-current-workspace', 'switch-open-workspace'],
    );
    assert.ok(openWorkspacesMessage.html.includes('OTHER WINDOWS'));
    assert.ok(openWorkspacesMessage.html.includes('data-session-fx="halo"'),
        'open-workspace incremental updates must use the configured running animation');
}

function makeWorkspaceCardFixture(rootCount) {
    const roots = [
        { id: 'root-app', name: 'App', ordinal: 0 },
        { id: 'root-api', name: 'API', ordinal: 1 },
        { id: 'root-docs', name: 'Docs', ordinal: 2 },
    ].slice(0, rootCount);
    return {
        id: 'workspace-dashboard',
        kind: 'current',
        workspaceKind: 'savedMultiRoot',
        showSaveAction: false,
        runningSessionCount: 0,
        navigationIdentity: 'navigation-dashboard',
        scopeIdentity: 'scope-dashboard',
        name: 'Dashboard',
        environment: 'local',
        environmentLabel: 'Local',
        roots,
        attentionCount: 1,
        aiSessions: {
            workspaceScopeIdentity: 'scope-dashboard',
            workspaceNavigationIdentity: 'navigation-dashboard',
            activeProvider: 'codex',
            expanded: true,
            providers: [
                { id: 'codex', label: 'Codex', count: 1 },
                { id: 'kimi', label: 'Kimi', count: 0 },
                { id: 'claude', label: 'Claude', count: 0 },
            ],
            sessionsByProvider: {
                codex: [{
                    id: 'session-api', name: 'API work', provider: 'codex',
                    primaryRootId: 'root-api', primaryRootLabel: 'API',
                }],
                kimi: [],
                claude: [],
            },
            unavailableProviders: [],
            aiSessionCount: 1,
            attentionCount: 0,
            defaultTab: 'sessions',
            activeSessions: [{
                key: 'codex:session-api', provider: 'codex', sessionId: 'session-api', name: 'API work',
                executionState: 'running', focused: false, needsAttention: false, pending: false,
                backend: 'vscode', attached: true, primaryRootId: 'root-api', primaryRootLabel: 'API',
            }],
            activeSessionCount: 1,
            activeAttentionCount: 0,
        },
    };
}

function runWorkspaceCardRenderingChecks() {
    const previousModuleLoad = Module._load;
    let webviewContent;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return {};
            return previousModuleLoad.call(this, request, parent, isMain);
        };
        webviewContent = require('../out/webview/webviewContent');
    } finally {
        Module._load = previousModuleLoad;
    }
    const icons = require('../out/webview/webviewIcons');

    const emptyHtml = webviewContent.getCurrentWorkspaceGroupContent(null, false);
    assert.strictEqual((emptyHtml.match(/class="workspace-card/g) || []).length, 0);

    const emptyRootsHtml = webviewContent.getCurrentWorkspaceGroupContent(makeWorkspaceCardFixture(0), false);
    assert.strictEqual((emptyRootsHtml.match(/class="workspace-card/g) || []).length, 0,
        'a non-null invalid zero-root snapshot must render the empty current-workspace state');

    const collapsedSingleCard = makeWorkspaceCardFixture(1);
    collapsedSingleCard.aiSessions.expanded = false;
    const singleHtml = webviewContent.getCurrentWorkspaceGroupContent(collapsedSingleCard, false);
    assert.strictEqual((singleHtml.match(/class="workspace-card/g) || []).length, 1);
    assert.strictEqual((singleHtml.match(/class="codex-sessions"/g) || []).length, 1);
    assert.ok(singleHtml.includes(icons.folder));
    assert.ok(singleHtml.includes('title="Local Project"'));
    assert.ok(singleHtml.includes('<h2 class="project-header">App</h2>'));
    assert.ok(singleHtml.includes('<p class="project-description workspace-metadata">1 folder</p>'));
    assert.strictEqual(singleHtml.includes('Local ·'), false,
        'the environment icon already identifies local workspaces');
    assert.strictEqual(singleHtml.includes('class="ai-session-root-chip"'), false,
        'single-root workspaces must not repeat the only root on every session row');
    assert.ok(singleHtml.includes('data-has-ai-session-badge'),
        'current workspace cards must declare when their AI session summary badge is present');
    assert.strictEqual(singleHtml.includes('data-codex-expanded'), false,
        'the collapsed-card fixture must keep its AI session module hidden');
    const collapsedCardStart = singleHtml.indexOf('<div class="workspace-card');
    const collapsedCardOpeningEnd = singleHtml.indexOf('>', collapsedCardStart);
    const collapsedCardOpeningTag = singleHtml.slice(collapsedCardStart, collapsedCardOpeningEnd + 1);
    const collapsedCardBody = extractHtmlElementBody(singleHtml, collapsedCardOpeningTag);
    const collapsedSessionIndex = collapsedCardBody.indexOf('<div class="codex-sessions"');
    assert.ok(collapsedSessionIndex >= 0, 'collapsed current workspace cards must retain the hidden session module');
    const collapsedCardSummary = collapsedCardBody.slice(0, collapsedSessionIndex);
    const collapsedContentChildren = extractDirectHtmlChildOpeningTags(collapsedCardSummary).filter(tag =>
        !/class="[^"]*\b(?:project-aura|steward-item-accent|project-session-fx|project-codex-badge)\b/.test(tag)
    );
    assert.deepStrictEqual(collapsedContentChildren, [
        '<div class="fitty-container project-title-row">',
        '<p class="project-description workspace-metadata">',
    ], 'collapsed current workspace cards must have only title and description rows before the session module');

    const runningCard = makeWorkspaceCardFixture(1);
    runningCard.aiSessions.activeSessions.push(
        {
            key: 'codex:session-starting', provider: 'codex', sessionId: 'session-starting', name: 'Starting',
            executionState: 'starting', focused: false, needsAttention: false, pending: true,
            backend: 'vscode', attached: true,
        },
        {
            key: 'codex:session-stopped', provider: 'codex', sessionId: 'session-stopped', name: 'Stopped',
            executionState: 'stopped', focused: false, needsAttention: false, pending: false,
            backend: 'vscode', attached: true,
        },
    );
    const orbitHtml = webviewContent.getCurrentWorkspaceGroupContent(runningCard, false, 'orbit');
    assert.ok(orbitHtml.includes('class="workspace-card project steward-item-card session-running"'));
    assert.ok(orbitHtml.includes('data-session-fx="orbit"'));
    assert.ok(orbitHtml.includes('<div class="project-session-fx"></div>'));
    assert.ok(orbitHtml.indexOf('project-session-fx') > orbitHtml.indexOf('steward-item-accent'));
    assert.ok(orbitHtml.includes('title="Workspace — 1 active session running"'));

    for (const animation of ['current', 'sweep', 'orbit', 'halo', 'ripple', 'breath']) {
        const animationHtml = webviewContent.getCurrentWorkspaceGroupContent(runningCard, false, animation);
        assert.ok(animationHtml.includes(`data-session-fx="${animation}"`),
            `the current workspace card must accept the ${animation} running animation`);
        assert.ok(animationHtml.includes('<div class="project-session-fx"></div>'));
    }
    const noneHtml = webviewContent.getCurrentWorkspaceGroupContent(runningCard, false, 'none');
    assert.ok(noneHtml.includes('class="workspace-card project steward-item-card session-running"'));
    assert.ok(noneHtml.includes('data-session-fx="none"'));
    assert.strictEqual(noneHtml.includes('project-session-fx'), false,
        'none must retain static running state without an animation layer');
    const invalidHtml = webviewContent.getCurrentWorkspaceGroupContent(runningCard, false, 'invalid');
    assert.ok(invalidHtml.includes('data-session-fx="current"'),
        'an invalid animation value must fail safely to current');

    const idleCard = makeWorkspaceCardFixture(1);
    idleCard.aiSessions.activeSessions = runningCard.aiSessions.activeSessions.filter(
        session => session.executionState !== 'running'
    );
    const idleHtml = webviewContent.getCurrentWorkspaceGroupContent(idleCard, false, 'halo');
    assert.strictEqual(idleHtml.includes('session-running'), false,
        'starting and stopped sessions must not activate the card running state');
    assert.strictEqual(idleHtml.includes('data-session-fx'), false);
    assert.strictEqual(idleHtml.includes('active session running'), false);
    const unhydratedCard = makeWorkspaceCardFixture(1);
    delete unhydratedCard.aiSessions;
    unhydratedCard.attentionCount = 0;
    const unhydratedHtml = webviewContent.getCurrentWorkspaceGroupContent(unhydratedCard, false);
    assert.strictEqual((unhydratedHtml.match(/class="codex-sessions"/g) || []).length, 1,
        'a current card must keep one AI module while hydration is temporarily unavailable');
    assert.strictEqual(unhydratedHtml.includes('data-has-ai-session-badge'), false,
        'badge-free current workspace cards must keep their full title and description width');

    const multiHtml = webviewContent.getCurrentWorkspaceGroupContent(makeWorkspaceCardFixture(3), false);
    assert.strictEqual((multiHtml.match(/class="workspace-card/g) || []).length, 1);
    assert.strictEqual((multiHtml.match(/class="codex-sessions"/g) || []).length, 1);
    assert.ok(multiHtml.includes('<p class="project-description workspace-metadata">3 folders</p>'));
    assert.strictEqual(multiHtml.includes('class="workspace-root-tags"'), false);
    assert.strictEqual(multiHtml.includes('class="workspace-root-tag"'), false);
    assert.ok(multiHtml.includes('data-primary-root-id="root-api"'));
    assert.ok(multiHtml.includes('class="ai-session-root-chip"'));
    assert.ok(multiHtml.includes('data-action="create-ai-session"'));
    assert.strictEqual(multiHtml.includes('data-action="open-new-session-in"'), false);
    assert.strictEqual(multiHtml.includes('data-action="new-session-in"'), false);
    assert.strictEqual(multiHtml.includes('data-action="selected-project"'), false);
    assert.strictEqual(multiHtml.includes('data-project-navigation'), false);
    assert.strictEqual(multiHtml.includes('data-has-save-action'), false);

    const untitledWorkspaceCard = makeWorkspaceCardFixture(3);
    untitledWorkspaceCard.workspaceKind = 'untitledMultiRoot';
    untitledWorkspaceCard.showSaveAction = true;
    const untitledWorkspaceHtml = webviewContent.getCurrentWorkspaceGroupContent(
        untitledWorkspaceCard,
        false,
    );
    assert.ok(untitledWorkspaceHtml.includes('data-has-save-action'));
    assert.strictEqual(
        (untitledWorkspaceHtml.match(/data-action="save-current-workspace"/g) || []).length,
        1,
        'an untitled current multi-root workspace must expose exactly one save action',
    );
    assert.ok(untitledWorkspaceHtml.includes('title="Save Workspace"'));
    const projectActionMessages = [];
    const triggerProjectAction = new Function(
        'target',
        'projectId',
        'window',
        extractFunctionBody(fs.readFileSync(projectScriptPath, 'utf8'), 'onTriggerProjectAction'),
    );
    assert.strictEqual(triggerProjectAction({
        closest: selector => selector === '[data-action]'
            ? { getAttribute: attribute => attribute === 'data-action' ? 'save-current-workspace' : null }
            : null,
    }, untitledWorkspaceCard.id, {
        vscode: { postMessage: message => projectActionMessages.push(message) },
    }), true);
    assert.deepStrictEqual(projectActionMessages, [{
        type: 'save-current-workspace',
        projectId: untitledWorkspaceCard.id,
    }], 'the save badge must use its dedicated workspace-only host route');
    const unregisteredSavedWorkspace = makeWorkspaceCardFixture(3);
    unregisteredSavedWorkspace.showSaveAction = true;
    const unregisteredSavedWorkspaceHtml = webviewContent.getCurrentWorkspaceGroupContent(
        unregisteredSavedWorkspace,
        false,
    );
    assert.ok(unregisteredSavedWorkspaceHtml.includes('data-action="save-current-workspace"'),
        'a saved workspace missing from Saved Projects must retain the save action');

    const devContainerCard = makeWorkspaceCardFixture(1);
    devContainerCard.environment = 'devContainer';
    devContainerCard.environmentLabel = 'Dev Container';
    const devContainerHtml = webviewContent.getCurrentWorkspaceGroupContent(devContainerCard, false);
    assert.ok(devContainerHtml.includes(icons.container));
    assert.ok(devContainerHtml.includes('title="Dev Container Project"'));
    assert.strictEqual(devContainerHtml.includes('class="workspace-root-tags"'), false);
    assert.strictEqual(devContainerHtml.includes('class="workspace-root-tag"'), false);

    const outsideWorkspaceCard = makeWorkspaceCardFixture(3);
    outsideWorkspaceCard.aiSessions.sessionsByProvider.codex[0].primaryRootId = undefined;
    outsideWorkspaceCard.aiSessions.sessionsByProvider.codex[0].primaryRootLabel = 'Outside workspace';
    outsideWorkspaceCard.aiSessions.activeSessions[0].primaryRootId = undefined;
    outsideWorkspaceCard.aiSessions.activeSessions[0].primaryRootLabel = 'Outside workspace';
    const outsideWorkspaceHtml = webviewContent.getCurrentWorkspaceGroupContent(outsideWorkspaceCard, false);
    assert.strictEqual((outsideWorkspaceHtml.match(/>Outside workspace<\/span>/g) || []).length, 2,
        'history and active rows must render the removed-root continuity chip');

    const navigationCard = {
        ...makeWorkspaceCardFixture(1),
        id: 'workspace-other',
        kind: 'navigation',
        navigationIdentity: 'navigation-other',
        scopeIdentity: 'scope-other',
        name: 'App [Dev Container: Existing Dockerfile]',
        environment: 'devContainer',
        environmentLabel: 'Dev Container',
        runningSessionCount: 2,
        aiSessions: runningCard.aiSessions,
    };
    const workspaceHtml = webviewContent.getOpenWorkspacesGroupContent(
        [makeWorkspaceCardFixture(3), navigationCard],
        false,
        'ready',
        'halo',
    );
    const otherWindowsHtml = workspaceHtml.slice(workspaceHtml.indexOf('OTHER WINDOWS'));
    assert.strictEqual((otherWindowsHtml.match(/class="workspace-card/g) || []).length, 1);
    assert.ok(otherWindowsHtml.includes('data-other-workspace'));
    assert.ok(otherWindowsHtml.includes('class="workspace-card project steward-item-card session-running"'));
    assert.ok(otherWindowsHtml.includes('data-session-fx="halo"'));
    assert.ok(otherWindowsHtml.includes('title="Workspace — 2 active sessions running"'));
    assert.ok(otherWindowsHtml.includes('<span class="ai-session-active-count" aria-label="2 active AI sessions">●2</span>'));
    assert.ok(otherWindowsHtml.includes('<h2 class="project-header">App</h2>'));
    assert.ok(otherWindowsHtml.includes('<p class="project-description workspace-metadata">1 folder</p>'));
    assert.strictEqual(otherWindowsHtml.includes('[Dev Container:'), false,
        'navigation cards must not repeat VS Code remote window decorations in their title');
    assert.strictEqual(otherWindowsHtml.includes('Dev Container ·'), false,
        'navigation cards must not repeat their icon environment in metadata');
    assert.ok(otherWindowsHtml.includes(
        '<span class="project-ai-attention-badge" title="1 item needs attention" aria-label="1 item needs attention">1</span>'
    ));
    assert.strictEqual((otherWindowsHtml.match(/class="project-codex-badge"/g) || []).length, 1,
        'a running navigation workspace must expose one compact active-session badge');
    const untitledNavigationHtml = webviewContent.getOpenWorkspacesGroupContent([{
        ...navigationCard,
        workspaceKind: 'untitledMultiRoot',
    }], false);
    assert.strictEqual(untitledNavigationHtml.includes('data-action="save-current-workspace"'), false,
        'OTHER WINDOWS cards must never expose a save action');
    for (const privateDetail of [
        'data-ai-session-total-count',
        'data-ai-session-attention-count',
        'Codex',
        'Kimi',
        'Claude',
    ]) {
        assert.strictEqual(otherWindowsHtml.includes(privateDetail), false,
            `OTHER WINDOWS attention badges must omit ${privateDetail}`);
    }
    assert.strictEqual(otherWindowsHtml.includes('class="codex-sessions"'), false,
        'OTHER WINDOWS must never render session/provider controls');
    assert.strictEqual(otherWindowsHtml.includes('data-workspace-root-id'), false,
        'OTHER WINDOWS roots are aggregate metadata, not expandable rows');
    assert.strictEqual((otherWindowsHtml.match(/active session/g) || []).length, 1,
        'OTHER WINDOWS must render only its protocol count, not injected aiSessions details');

    const updateRequiredHtml = webviewContent.getOpenWorkspacesGroupContent(
        [makeWorkspaceCardFixture(3)],
        true,
        'update-required',
    );
    const updateRequiredGroupIndex = updateRequiredHtml.indexOf('<div class="group steward-section open-other-windows-group');
    const updateRequiredCurrentHtml = updateRequiredHtml.slice(0, updateRequiredGroupIndex);
    const updateRequiredOtherHtml = updateRequiredHtml.slice(updateRequiredGroupIndex);
    assert.ok(updateRequiredOtherHtml.includes('data-other-windows-status="update-required"'));
    assert.strictEqual(updateRequiredOtherHtml.includes('open-other-windows-group collapsed'), false,
        'an actionable bridge upgrade state must not be hidden by the saved collapse state');
    assert.ok(updateRequiredOtherHtml.includes('Update the Project Steward UI Bridge'));
    assert.ok(updateRequiredOtherHtml.includes('data-action="open-bridge-extension"'),
        'the bridge mismatch state must include an actionable upgrade control');
    assert.strictEqual(updateRequiredOtherHtml.includes('class="codex-sessions"'), false,
        'the bridge mismatch state must not create a session expander');
    assert.ok(updateRequiredCurrentHtml.includes('data-current-workspace'));
    assert.ok(updateRequiredCurrentHtml.includes('data-action="create-ai-session"'),
        'the local current workspace NEW action must remain enabled during bridge degradation');
    assert.strictEqual(updateRequiredCurrentHtml.includes('data-action="new-session-in"'), false);

    const projectSource = fs.readFileSync(projectScriptPath, 'utf8');
    const consistencyBody = extractFunctionBody(projectSource, 'isWorkspaceUpdateDomConsistent');
    assert.ok(consistencyBody.includes('currentWorkspaceCount'));
    assert.strictEqual(/rootCount|sessionCount|aiSessionCount/.test(consistencyBody), false,
        'current-card DOM consistency must not equate card count with roots or sessions');
    const stateBody = extractFunctionBody(projectSource, 'getWorkspaceUpdateDomState');
    assert.ok(stateBody.includes('.open-current-workspace-group'));
    assert.ok(stateBody.includes('.workspace-card[data-workspace-scope-identity]'));
    assert.strictEqual(/workspace-root|codex-session-row/.test(stateBody), false);

    let createdReplacementHolder = false;
    const currentCard = {};
    const duplicateCardOutsideCurrentGroup = {};
    const currentGroup = {
        contains: card => card === currentCard,
    };
    const wrapper = {
        querySelector: selector => selector === '.open-current-workspace-group' ? currentGroup : null,
        querySelectorAll: selector => selector === '.workspace-card[data-current-workspace][data-workspace-scope-identity]'
            ? [currentCard, duplicateCardOutsideCurrentGroup]
            : [],
    };
    const context = {
        document: {
            querySelector: selector => selector === '.sticky-groups-wrapper' ? wrapper : null,
            createElement: () => {
                createdReplacementHolder = true;
                throw new Error('a duplicate current card must be rejected before parsing replacement HTML');
            },
        },
        window: {},
    };
    vm.runInNewContext(projectSource, context);
    assert.strictEqual(context.applyWorkspaceUpdate({
        type: 'workspace-updated', version: 2, currentWorkspaceCount: 1, html: '<div></div>',
    }), false);
    assert.strictEqual(createdReplacementHolder, false,
        'the v2 handler must not mount another current card when one exists outside the owned group');

    const preservedOtherNavigationCard = {
        matches: selector => selector === '.workspace-card[data-other-workspace]',
        textContent: 'Other Workspace · SSH · 2 folders',
    };
    const preservedOtherWindowsGroup = {
        matches: selector => selector === '.open-other-windows-group',
        children: [preservedOtherNavigationCard],
        querySelector: selector => selector === '.workspace-card[data-other-workspace]'
            ? preservedOtherNavigationCard
            : null,
    };
    const replacementCard = {};
    const replacementGroup = {
        matches: selector => selector === '.open-current-workspace-group',
        querySelectorAll: selector => selector === '.workspace-card[data-workspace-scope-identity]'
            ? [replacementCard]
            : [],
    };
    let mountedCurrentGroup;
    let successfulWrapper;
    const replaceableCurrentGroup = {
        matches: selector => selector === '.open-current-workspace-group',
        contains: card => card === currentCard,
        replaceWith: replacement => {
            const currentIndex = successfulWrapper.children.indexOf(replaceableCurrentGroup);
            assert.notStrictEqual(currentIndex, -1, 'the fake current group must be mounted before replacement');
            successfulWrapper.children.splice(currentIndex, 1, replacement);
            mountedCurrentGroup = replacement;
        },
    };
    successfulWrapper = {
        children: [replaceableCurrentGroup, preservedOtherWindowsGroup],
        querySelector(selector) {
            if (selector === '.open-current-workspace-group') {
                return this.children.find(node => node.matches?.(selector)) || null;
            }
            if (selector === '.open-other-windows-group') {
                return this.children.find(node => node.matches?.(selector)) || null;
            }
            if (selector === '.workspace-card[data-other-workspace]') {
                return this.querySelector('.open-other-windows-group')?.querySelector(selector) || null;
            }
            return null;
        },
        querySelectorAll: selector => selector === '.workspace-card[data-current-workspace][data-workspace-scope-identity]'
            ? [currentCard]
            : [],
    };
    const successfulContext = {
        document: {
            querySelector: selector => selector === '.sticky-groups-wrapper' ? successfulWrapper : null,
            createElement: () => ({
                children: [replacementGroup],
                firstElementChild: replacementGroup,
                set innerHTML(_value) {},
            }),
        },
        window: {},
    };
    vm.runInNewContext(projectSource, successfulContext);
    assert.strictEqual(successfulContext.applyWorkspaceUpdate({
        type: 'workspace-updated', version: 2, currentWorkspaceCount: 1,
        html: '<div class="open-current-workspace-group"></div>',
    }), true);
    assert.strictEqual(mountedCurrentGroup, replacementGroup,
        'a valid current-group update must replace the current group');
    assert.deepStrictEqual(successfulWrapper.children, [replacementGroup, preservedOtherWindowsGroup],
        'a current-group update must replace one child while preserving the real OTHER WINDOWS sibling');
    assert.strictEqual(successfulWrapper.querySelector('.open-other-windows-group'), preservedOtherWindowsGroup,
        'the same OTHER WINDOWS node must remain mounted');
    assert.strictEqual(
        successfulWrapper.querySelector('.workspace-card[data-other-workspace]'),
        preservedOtherNavigationCard,
        'the same other-window navigation card must survive current-group replacement',
    );
    assert.ok(preservedOtherNavigationCard.textContent.includes('Other Workspace · SSH · 2 folders'),
        'the surviving navigation card must retain its content');

    const stableCardId = '__currentWorkspace-stable-scope';
    let persistedState = {};
    const vscodeApi = {
        getState: () => persistedState,
        setState: state => { persistedState = state; },
    };
    function makeTabSurface(cardId) {
        const attributes = {};
        const sessionSection = { setAttribute: (name, value) => { attributes[name] = value; } };
        const tabs = ['active', 'sessions'].map(tab => {
            const values = { 'data-ai-session-tab': tab };
            return {
                getAttribute: name => values[name] || null,
                setAttribute: (name, value) => { values[name] = value; },
            };
        });
        const panels = ['active', 'sessions'].map(tab => ({
            getAttribute: name => name === 'data-ai-session-panel' ? tab : null,
            toggleAttribute: (name, enabled) => { attributes[`${tab}:${name}`] = enabled; },
        }));
        return {
            attributes,
            getAttribute: name => name === 'data-id' ? cardId : null,
            querySelector: selector => selector === '.codex-sessions' ? sessionSection : null,
            querySelectorAll: selector => selector === '[data-ai-session-tab]'
                ? tabs
                : selector === '[data-ai-session-panel]' ? panels : [],
        };
    }
    const untitledSurface = makeTabSurface(stableCardId);
    const savedSurface = makeTabSurface(stableCardId);
    const stateContext = { document: {}, window: {} };
    vm.runInNewContext(projectSource, stateContext);
    const zeroRootCurrentGroup = {
        matches: selector => selector === '.open-current-workspace-group',
        querySelectorAll: selector => selector === '.workspace-card[data-workspace-scope-identity]' ? [] : [],
    };
    assert.strictEqual(stateContext.isWorkspaceUpdateDomConsistent({ currentWorkspaceCount: 0 }, zeroRootCurrentGroup), true,
        'a zero-root resolver message must be DOM-consistent with an empty current group');
    assert.strictEqual(stateContext.isWorkspaceUpdateDomConsistent({ currentWorkspaceCount: 1 }, zeroRootCurrentGroup), false,
        'the incremental consistency guard must reject a declared 1/rendered 0 split');
    stateContext.writeAiSessionTabState(vscodeApi, stableCardId, 'active');
    stateContext.restoreAiSessionTabsFromState({
        querySelectorAll: () => [savedSurface],
    }, vscodeApi);
    assert.strictEqual(savedSurface.attributes['data-selected-ai-session-tab'], 'active',
        'ACTIVE tab state must survive untitled-to-saved navigation identity changes');
    stateContext.writeAiSessionTabState(vscodeApi, stableCardId, 'sessions');
    stateContext.restoreAiSessionTabsFromState({
        querySelectorAll: () => [untitledSurface],
    }, vscodeApi);
    assert.strictEqual(untitledSurface.attributes['data-selected-ai-session-tab'], 'sessions',
        'SESSIONS tab state must remain keyed by the stable scope-owned card ID');
}

function createSearchResultElement(tagName) {
    const element = {
        tagName: String(tagName || '').toUpperCase(),
        children: [],
        dataset: {},
        attributes: {},
        className: '',
        textContent: '',
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        removeChild(child) {
            this.children.splice(this.children.indexOf(child), 1);
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
    };
    Object.defineProperty(element, 'firstChild', {
        get: () => element.children[0] || null,
    });
    element.classList = {
        add: value => {
            const classes = new Set(element.className.split(/\s+/).filter(Boolean));
            classes.add(value);
            element.className = Array.from(classes).join(' ');
        },
        toggle: (value, force) => {
            const classes = new Set(element.className.split(/\s+/).filter(Boolean));
            if (force) classes.add(value);
            else classes.delete(value);
            element.className = Array.from(classes).join(' ');
        },
        contains: value => element.className.split(/\s+/).includes(value),
    };
    return element;
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
    assert.strictEqual(controller.getOpenWorkspacesCollapsed(), undefined);

    await controller.collapseGroup('__favorites', true);
    await controller.collapseGroup('__openWorkspaces', false);
    await controller.collapseGroup('group-a');
    await controller.collapseGroup('group-b', false);
    await controller.collapseGroup('missing-group', true);

    assert.deepStrictEqual(updates, [
        ['favoritesGroupCollapsed', true],
        ['openWorkspacesGroupCollapsed.v2', false],
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

async function runTodoStoreChecks() {
    assert.deepStrictEqual(todoTypes.normalizeTodoData(null), { version: 1, groups: [], todos: [] });
    assert.throws(
        () => todoTypes.normalizeTodoData({ version: 99, groups: [], todos: [] }),
        error => error && error.name === 'UnsupportedTodoDataVersionError' && error.version === 99
    );
    assert.deepStrictEqual(
        todoTypes.normalizeTodoData({ groups: [], todos: [] }),
        { version: 1, groups: [], todos: [] },
        'unversioned v1-shaped TODO data should remain readable'
    );
    assert.deepStrictEqual(
        todoTypes.normalizeTodoData({
            groups: [{ id: 'legacy-group', title: 'Legacy Group', collapsed: false, order: 0 }],
            todos: [{
                id: 'legacy-todo',
                groupId: 'legacy-group',
                title: 'Keep legacy data',
                notes: 'preserved',
                priority: 'high',
                completed: false,
                createdAt: '2026-07-16T00:00:00.000Z',
                updatedAt: '2026-07-16T00:00:00.000Z',
                order: 0,
            }],
        }),
        {
            version: 1,
            groups: [{ id: 'legacy-group', title: 'Legacy Group', collapsed: false, order: 0 }],
            todos: [{
                id: 'legacy-todo',
                groupId: 'legacy-group',
                title: 'Keep legacy data',
                notes: 'preserved',
                priority: 'high',
                completed: false,
                createdAt: '2026-07-16T00:00:00.000Z',
                updatedAt: '2026-07-16T00:00:00.000Z',
                completedAt: undefined,
                order: 0,
            }],
        },
        'non-empty unversioned v1 TODO data should be preserved'
    );

    const normalized = todoTypes.normalizeTodoData({
        version: 1,
        groups: [
            { id: 'group-a', title: ' Group A ', collapsed: true, order: 2 },
            { id: '', title: '', order: 'bad' },
        ],
        todos: [
            {
                id: 'todo-a',
                groupId: 'group-a',
                title: ' Todo A ',
                notes: 'notes',
                priority: 'high',
                completed: true,
                createdAt: '2026-07-15T00:00:00.000Z',
                updatedAt: '2026-07-16T00:00:00.000Z',
                completedAt: '2026-07-16T00:00:00.000Z',
                order: 3,
            },
            { id: 'todo-b', groupId: 'missing', title: 'Invalid Group' },
            { id: '', groupId: 'group-a', title: 'Invalid Id' },
        ],
    });

    assert.deepStrictEqual(normalized.groups, [
        { id: 'group-a', title: 'Group A', collapsed: true, order: 2 },
    ]);
    assert.strictEqual(normalized.todos.length, 1);
    assert.strictEqual(normalized.todos[0].title, 'Todo A');
    assert.strictEqual(normalized.todos[0].priority, 'high');
    assert.strictEqual(normalized.todos[0].completed, true);

    const searchItems = todoTypes.buildTodoSearchItems({
        version: 1,
        groups: [{ id: 'group-a', title: 'Planning', collapsed: false, order: 0 }],
        todos: [{
            id: 'todo-a',
            groupId: 'group-a',
            title: 'Ship TODO',
            notes: 'x'.repeat(700),
            priority: 'medium',
            completed: false,
            createdAt: '2026-07-16T00:00:00.000Z',
            updatedAt: '2026-07-16T00:00:00.000Z',
            order: 0,
        }],
    });
    assert.strictEqual(searchItems.length, 1);
    assert.strictEqual(searchItems[0].notesSearchText.length, 500);
    assert.ok(searchItems[0].searchText.includes('planning'));
    assert.ok(searchItems[0].searchText.includes('ship todo'));

    const globalValues = new Map();
    const configValues = {};
    const globalUpdates = [];
    const configUpdates = [];
    const makeService = useSettingsStorage => new TodoService({
        globalState: {
            get: key => globalValues.get(key),
            update: async (key, value) => {
                globalUpdates.push([key, value]);
                globalValues.set(key, value);
            },
        },
        configuration: {
            get: (key, fallback) => Object.prototype.hasOwnProperty.call(configValues, key) ? configValues[key] : fallback,
            update: async (key, value, target) => {
                configUpdates.push([key, value, target]);
                configValues[key] = value;
            },
        },
        useSettingsStorage: () => useSettingsStorage,
        now: () => '2026-07-16T00:00:00.000Z',
        generateId: prefix => `${prefix}-id-${globalUpdates.length + configUpdates.length}`,
    });

    const globalService = makeService(false);
    const afterAddTodo = await globalService.addTodo({ title: ' First task ', notes: ' Notes ', priority: 'high' });
    assert.strictEqual(afterAddTodo.groups.length, 1);
    assert.strictEqual(afterAddTodo.groups[0].title, 'Inbox');
    assert.strictEqual(afterAddTodo.todos[0].title, 'First task');
    assert.strictEqual(afterAddTodo.todos[0].notes, 'Notes');
    assert.strictEqual(afterAddTodo.todos[0].priority, 'high');
    assert.deepStrictEqual(globalUpdates[0][0], 'todos');

    const completed = await globalService.completeTodo(afterAddTodo.todos[0].id, true);
    assert.strictEqual(completed.todos[0].completed, true);
    assert.strictEqual(completed.todos[0].completedAt, '2026-07-16T00:00:00.000Z');

    const renamed = await globalService.addGroup('');
    assert.strictEqual(renamed.groups[1].title, 'Untitled Group');
    await globalService.setGroupCollapsed(renamed.groups[1].id, true);
    assert.strictEqual(globalService.getData().groups[1].collapsed, true);
    await globalService.deleteGroup(renamed.groups[1].id);
    assert.strictEqual(globalService.getData().groups.some(group => group.id === renamed.groups[1].id), false);

    const settingsService = makeService(true);
    await settingsService.saveData({ version: 1, groups: [], todos: [] });
    assert.deepStrictEqual(configUpdates[0][1], globalService.getData(),
        'the initial settings barrier must copy the non-empty global source before saving');
    assert.deepStrictEqual(configUpdates[1], ['todoData', { version: 1, groups: [], todos: [] }, 1]);

    const directSettingsUpdates = [];
    const serviceWithReadOnlyMergedConfiguration = new TodoService({
        globalState: {
            get: () => undefined,
            update: async () => undefined,
        },
        configuration: {
            get: (_key, fallback) => fallback,
            update: undefined,
        },
        writableConfiguration: {
            update: async (key, value, target) => directSettingsUpdates.push([key, value, target]),
        },
        useSettingsStorage: () => true,
        now: () => '2026-07-16T00:00:00.000Z',
        generateId: prefix => `${prefix}-direct-settings`,
    });
    await serviceWithReadOnlyMergedConfiguration.addTodo({ title: 'Persist through primary settings' });
    assert.strictEqual(directSettingsUpdates.length, 1,
        'settings-backed TODO writes must bypass the merged read configuration adapter');
    assert.strictEqual(directSettingsUpdates[0][0], 'todoData');
    assert.strictEqual(directSettingsUpdates[0][2], 1);

    for (const useSettingsStorage of [false, true]) {
        globalUpdates.length = 0;
        configUpdates.length = 0;
        await assert.rejects(
            () => makeService(useSettingsStorage).saveData({ version: 2, groups: [], todos: [] }),
            error => error && error.name === 'UnsupportedTodoDataVersionError' && error.version === 2
        );
        assert.deepStrictEqual(globalUpdates, [], 'unknown TODO data must not be written to globalState');
        assert.deepStrictEqual(configUpdates, [], 'unknown TODO data must not be written to settings');
    }
}

async function runTodoOrderingMutationChecks() {
    let storedData = {
        version: 1,
        groups: [
            { id: 'group-a', title: 'Group A', collapsed: false, order: 0 },
            { id: 'group-b', title: 'Group B', collapsed: true, order: 1 },
            { id: 'group-c', title: 'Group C', collapsed: false, order: 2 },
        ],
        todos: [
            { id: 'todo-a1', groupId: 'group-a', title: 'A1', notes: '', priority: 'medium', completed: false, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', order: 0 },
            { id: 'todo-a2', groupId: 'group-a', title: 'A2', notes: '', priority: 'medium', completed: false, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', order: 1 },
            { id: 'todo-a-done', groupId: 'group-a', title: 'A done', notes: '', priority: 'medium', completed: true, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', completedAt: '2026-07-16T01:00:00.000Z', order: 2 },
            { id: 'todo-b1', groupId: 'group-b', title: 'B1', notes: '', priority: 'medium', completed: false, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', order: 0 },
        ],
    };
    const writes = [];
    let nextId = 0;
    const service = new TodoService({
        globalState: {
            get: () => storedData,
            update: async (_key, value) => {
                writes.push(value);
                storedData = value;
            },
        },
        configuration: makeWorkspaceConfiguration({}),
        useSettingsStorage: () => false,
        now: () => '2026-07-17T00:00:00.000Z',
        generateId: prefix => `${prefix}-new-${++nextId}`,
    });

    const afterAdd = await service.addTodo({ title: 'Newest', groupId: 'group-a' });
    assert.deepStrictEqual(
        afterAdd.todos.filter(todo => todo.groupId === 'group-a' && !todo.completed).sort((a, b) => a.order - b.order).map(todo => [todo.title, todo.order]),
        [['Newest', 0], ['A1', 1], ['A2', 2]],
        'new TODOs must be inserted at order 0 and shift existing items down'
    );
    assert.strictEqual(afterAdd.todos.find(todo => todo.id === 'todo-a-done').order, 3,
        'new TODO insertion must also shift completed items without changing their status');

    let previousWrites = writes.length;
    const renamed = await service.renameGroup('group-a', ' Renamed A ');
    assert.strictEqual(renamed.groups.find(group => group.id === 'group-a').title, 'Renamed A');
    assert.strictEqual(writes.length, previousWrites + 1, 'group rename must use one persisted mutation');

    previousWrites = writes.length;
    const reorderedGroups = await service.reorderGroups(['group-c', 'group-a', 'group-b']);
    assert.deepStrictEqual(
        reorderedGroups.groups.map(group => [group.id, group.order]),
        [['group-c', 0], ['group-a', 1], ['group-b', 2]]
    );
    assert.strictEqual(writes.length, previousWrites + 1, 'group reorder must use one persisted mutation');

    previousWrites = writes.length;
    const reorderedTodos = await service.reorderTodos('group-a', ['todo-a2', 'todo-a1', 'todo-new-1']);
    assert.deepStrictEqual(
        reorderedTodos.todos.filter(todo => todo.groupId === 'group-a').sort((a, b) => a.order - b.order).map(todo => [todo.id, todo.order]),
        [['todo-a2', 0], ['todo-a1', 1], ['todo-new-1', 2], ['todo-a-done', 3]],
        'an exact visible TODO reorder must retain hidden completed items at the end'
    );
    assert.strictEqual(writes.length, previousWrites + 1, 'TODO reorder must use one persisted mutation');

    const invalidReorders = [
        () => service.reorderGroups(['group-a', 'group-b']),
        () => service.reorderGroups(['group-a', 'group-b', 'group-b']),
        () => service.reorderTodos('group-a', ['todo-a1', 'todo-a2']),
        () => service.reorderTodos('group-a', ['todo-a1', 'todo-a2', 'todo-b1']),
        () => service.reorderTodos('missing-group', []),
    ];
    previousWrites = writes.length;
    for (const invalidReorder of invalidReorders) {
        await assert.rejects(invalidReorder, /exactly|same group|must exist/i);
    }
    assert.strictEqual(writes.length, previousWrites, 'invalid or cross-group reorder arrays must not persist');

    previousWrites = writes.length;
    const collapsed = await service.setGroupsCollapsed(true);
    assert.deepStrictEqual(collapsed.groups.map(group => group.collapsed), [true, true, true]);
    assert.strictEqual(writes.length, previousWrites + 1, 'bulk TODO collapse must use one persisted mutation');
}

async function runTodoInsertionOrderNormalizationChecks() {
    const scenarios = [
        { name: 'gapped target orders', orders: [0, 2] },
        { name: 'negative target orders', orders: [-2, 0] },
    ];

    for (const scenario of scenarios) {
        let storedData = {
            version: 1,
            groups: [
                { id: 'target-group', title: 'Target', collapsed: false, order: 0 },
                { id: 'other-group', title: 'Other', collapsed: true, order: 1 },
            ],
            todos: [
                { id: 'target-second', groupId: 'target-group', title: 'Second', notes: 'second', priority: 'low', completed: false, createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T01:00:00.000Z', order: scenario.orders[1] },
                { id: 'other-first', groupId: 'other-group', title: 'Other first', notes: 'unchanged', priority: 'high', completed: true, createdAt: '2026-07-14T00:00:00.000Z', updatedAt: '2026-07-14T01:00:00.000Z', completedAt: '2026-07-14T02:00:00.000Z', order: -7 },
                { id: 'target-first', groupId: 'target-group', title: 'First', notes: 'first', priority: 'medium', completed: true, createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T01:00:00.000Z', completedAt: '2026-07-13T02:00:00.000Z', order: scenario.orders[0] },
                { id: 'other-second', groupId: 'other-group', title: 'Other second', notes: 'also unchanged', priority: 'medium', completed: false, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z', order: 9 },
            ],
        };
        const service = new TodoService({
            globalState: {
                get: () => storedData,
                update: async (_key, value) => { storedData = value; },
            },
            configuration: makeWorkspaceConfiguration({}),
            useSettingsStorage: () => false,
            now: () => '2026-07-17T00:00:00.000Z',
            generateId: prefix => `${prefix}-new`,
        });
        const otherGroupBefore = service.getData().todos
            .filter(todo => todo.groupId === 'other-group')
            .map(todo => ({ ...todo }));

        const result = await service.addTodo({ title: 'Newest', groupId: 'target-group' });
        assert.deepStrictEqual(
            result.todos
                .filter(todo => todo.groupId === 'target-group')
                .sort((a, b) => a.order - b.order)
                .map(todo => [todo.id, todo.order]),
            [['todo-new', 0], ['target-first', 1], ['target-second', 2]],
            `${scenario.name} must normalize to a stable contiguous sequence with the new TODO first`
        );
        assert.deepStrictEqual(
            result.todos.filter(todo => todo.groupId === 'other-group'),
            otherGroupBefore,
            `${scenario.name} must not modify TODOs in other groups`
        );
    }

    let tiedData = {
        version: 1,
        groups: [{ id: 'tied-group', title: 'Tied', collapsed: false, order: 0 }],
        todos: [
            { id: 'tie-first', groupId: 'tied-group', title: 'Tie first', notes: '', priority: 'medium', completed: false, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', order: 0 },
            { id: 'tie-second', groupId: 'tied-group', title: 'Tie second', notes: '', priority: 'medium', completed: false, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', order: 0 },
        ],
    };
    const tiedService = new TodoService({
        globalState: {
            get: () => tiedData,
            update: async (_key, value) => { tiedData = value; },
        },
        configuration: makeWorkspaceConfiguration({}),
        useSettingsStorage: () => false,
        now: () => '2026-07-17T00:00:00.000Z',
        generateId: prefix => `${prefix}-new`,
    });
    const tiedResult = await tiedService.addTodo({ title: 'Newest', groupId: 'tied-group' });
    assert.deepStrictEqual(
        tiedResult.todos.sort((a, b) => a.order - b.order).map(todo => [todo.id, todo.order]),
        [['todo-new', 0], ['tie-first', 1], ['tie-second', 2]],
        'equal old orders must retain the current data.todos index as their stable tie-breaker'
    );
}

function makeStoredTodoData(groupId) {
    return {
        version: 1,
        groups: [{ id: groupId, title: groupId, collapsed: false, order: 0 }],
        todos: [],
    };
}

function makeTodoServiceStorageHarness(useSettingsStorage, initialGlobalData, initialSettingsData) {
    const values = {
        global: initialGlobalData,
        settings: initialSettingsData,
    };
    const updates = [];
    let knownDataBackend;
    const service = new TodoService({
        globalState: {
            get: key => key === 'todos' ? values.global : knownDataBackend,
            update: async (key, value) => {
                if (key !== 'todos') {
                    knownDataBackend = value;
                    return;
                }
                updates.push(['global', key, value]);
                values.global = value;
            },
        },
        configuration: {
            get: (key, fallback) => key === 'todoData' ? values.settings : fallback,
            update: async (key, value, target) => {
                updates.push(['settings', key, value, target]);
                values.settings = value;
            },
        },
        useSettingsStorage: () => useSettingsStorage,
        now: () => '2026-07-16T00:00:00.000Z',
    });
    return { service, updates, values };
}

async function runTodoStorageResolutionChecks() {
    const primarySettingsData = makeStoredTodoData('settings-group');
    const globalData = makeStoredTodoData('global-group');
    const cases = [
        {
            name: 'explicit primary setting wins over legacy',
            primary: makeWorkspaceConfiguration({ storeProjectsInSettings: false, todoData: primarySettingsData }),
            legacy: makeWorkspaceConfiguration({ storeProjectsInSettings: true }),
            expectedGroupId: 'global-group',
        },
        {
            name: 'explicit legacy setting is used when primary is not configured',
            primary: makeWorkspaceConfiguration(
                { todoData: primarySettingsData },
                ['todoData'],
                { storeProjectsInSettings: true }
            ),
            legacy: makeWorkspaceConfiguration({ storeProjectsInSettings: false }),
            expectedGroupId: 'global-group',
        },
        {
            name: 'primary default is used when neither setting is configured',
            primary: makeWorkspaceConfiguration(
                { todoData: primarySettingsData },
                ['todoData'],
                { storeProjectsInSettings: true }
            ),
            legacy: makeWorkspaceConfiguration({}, []),
            expectedGroupId: 'settings-group',
        },
    ];

    for (const testCase of cases) {
        const originalLoad = Module._load;
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return {
                    workspace: {
                        getConfiguration: section => section === 'projectSteward'
                            ? testCase.primary
                            : testCase.legacy,
                    },
                };
            }
            return originalLoad.call(this, request, parent, isMain);
        };
        try {
            const service = new TodoService({
                globalState: {
                    get: key => key === 'todos' ? globalData : undefined,
                    update: async () => undefined,
                },
            });
            assert.strictEqual(service.getData().groups[0].id, testCase.expectedGroupId, testCase.name);
        } finally {
            Module._load = originalLoad;
        }
    }

    async function runExtensionContextSettingsWrite(rejectWrite) {
        const primary = makeWorkspaceConfiguration(
            { storeProjectsInSettings: true },
            ['storeProjectsInSettings', 'update']
        );
        const legacy = makeWorkspaceConfiguration({}, []);
        const settingsWrites = [];
        const provenanceWrites = [];
        primary.update = async (key, value, target) => {
            settingsWrites.push([key, value, target]);
            if (rejectWrite) throw new Error('primary settings write rejected');
        };
        const originalLoad = Module._load;
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return {
                    workspace: {
                        getConfiguration: section => section === 'projectSteward' ? primary : legacy,
                    },
                };
            }
            return originalLoad.call(this, request, parent, isMain);
        };
        try {
            const service = new TodoService({
                globalState: {
                    get: key => key === 'todos' ? makeStoredTodoData('context-source') : undefined,
                    update: async (key, value) => provenanceWrites.push([key, value]),
                },
            });
            if (rejectWrite) {
                await assert.rejects(
                    () => service.migrateDataIfNeeded(),
                    /primary settings write rejected/
                );
            } else {
                assert.strictEqual(await service.migrateDataIfNeeded(), true);
            }
        } finally {
            Module._load = originalLoad;
        }
        return { settingsWrites, provenanceWrites };
    }

    const contextWrite = await runExtensionContextSettingsWrite(false);
    assert.strictEqual(contextWrite.settingsWrites.length, 1,
        'ExtensionContext settings writes must call the raw projectSteward configuration writer');
    assert.strictEqual(contextWrite.settingsWrites[0][0], 'todoData');
    assert.strictEqual(contextWrite.settingsWrites[0][2], 1);
    assert.strictEqual(contextWrite.provenanceWrites.length, 1,
        'a successful primary settings write may advance storage provenance');

    const rejectedContextWrite = await runExtensionContextSettingsWrite(true);
    assert.strictEqual(rejectedContextWrite.settingsWrites.length, 1);
    assert.deepStrictEqual(rejectedContextWrite.provenanceWrites, [],
        'a rejected primary settings write must not advance storage provenance');
}

async function runTodoMigrationChecks() {
    const globalSource = makeTodoServiceStorageHarness(true, makeStoredTodoData('global-source'), null);
    assert.strictEqual(await globalSource.service.migrateDataIfNeeded(), true);
    assert.deepStrictEqual(globalSource.updates.map(update => update[0]), ['settings']);
    assert.strictEqual(globalSource.values.settings.groups[0].id, 'global-source');

    const settingsSource = makeTodoServiceStorageHarness(false, { version: 1, groups: [], todos: [] }, makeStoredTodoData('settings-source'));
    assert.strictEqual(await settingsSource.service.migrateDataIfNeeded(), true);
    assert.deepStrictEqual(settingsSource.updates.map(update => update[0]), ['global']);
    assert.strictEqual(settingsSource.values.global.groups[0].id, 'settings-source');

    for (const useSettingsStorage of [false, true]) {
        const conflict = makeTodoServiceStorageHarness(
            useSettingsStorage,
            makeStoredTodoData('global-conflict'),
            makeStoredTodoData('settings-conflict')
        );
        await assert.rejects(
            () => conflict.service.migrateDataIfNeeded(),
            error => error && error.name === 'TodoStorageConflictError'
        );
        assert.deepStrictEqual(conflict.updates, [], 'migration must not overwrite two non-empty stores');
    }

    for (const useSettingsStorage of [false, true]) {
        const futureSource = makeTodoServiceStorageHarness(
            useSettingsStorage,
            useSettingsStorage ? { version: 2, groups: [], todos: [] } : null,
            useSettingsStorage ? null : { version: 2, groups: [], todos: [] }
        );
        await assert.rejects(
            () => futureSource.service.migrateDataIfNeeded(),
            error => error && error.name === 'UnsupportedTodoDataVersionError' && error.version === 2
        );
        assert.deepStrictEqual(futureSource.updates, [], 'unknown migration data must not update either backend');
    }

    for (const useSettingsStorage of [false, true]) {
        const futureTarget = makeTodoServiceStorageHarness(
            useSettingsStorage,
            useSettingsStorage ? makeStoredTodoData('global-source') : { version: 2, groups: [], todos: [] },
            useSettingsStorage ? { version: 2, groups: [], todos: [] } : makeStoredTodoData('settings-source')
        );
        await assert.rejects(
            () => futureTarget.service.migrateDataIfNeeded(),
            error => error && error.name === 'UnsupportedTodoDataVersionError' && error.version === 2
        );
        assert.deepStrictEqual(futureTarget.updates, [], 'an unknown selected migration target must never be overwritten');
    }

    const dataMutations = [
        service => service.saveData({ version: 1, groups: [], todos: [] }),
        service => service.setShowCompleted(true),
        service => service.addGroup('Blocked'),
        service => service.addTodo({ title: 'Blocked' }),
        service => service.updateTodo('todo-a', { title: 'Blocked' }),
        service => service.completeTodo('todo-a', true),
        service => service.deleteTodo('todo-a'),
        service => service.deleteGroup('group-a'),
        service => service.renameGroup('group-a', 'Blocked'),
        service => service.reorderGroups(['group-a']),
        service => service.reorderTodos('group-a', ['todo-a']),
        service => service.setGroupCollapsed('group-a', true),
        service => service.setGroupsCollapsed(true),
        service => service.sortGroupByPriority('group-a'),
        service => service.revealTodo('todo-a', 'group-a'),
    ];
    for (const useSettingsStorage of [false, true]) {
        for (const mutate of dataMutations) {
            const futureTarget = makeTodoServiceStorageHarness(
                useSettingsStorage,
                useSettingsStorage ? null : { version: 2, groups: [], todos: [] },
                useSettingsStorage ? { version: 2, groups: [], todos: [] } : null
            );
            await assert.rejects(
                () => mutate(futureTarget.service),
                error => error && error.name === 'UnsupportedTodoDataVersionError' && error.version === 2
            );
            assert.deepStrictEqual(futureTarget.updates, [], 'CRUD on an unknown selected backend must not write');
            const selectedValue = useSettingsStorage ? futureTarget.values.settings : futureTarget.values.global;
            assert.deepStrictEqual(selectedValue, { version: 2, groups: [], todos: [] },
                'future-version raw data must remain byte-for-byte isolated from TODO writes');
        }
    }

    for (const useSettingsStorage of [false, true]) {
        const futureTarget = makeTodoServiceStorageHarness(
            useSettingsStorage,
            useSettingsStorage ? null : { version: 2, groups: [], todos: [] },
            useSettingsStorage ? { version: 2, groups: [], todos: [] } : null
        );
        assert.deepStrictEqual(futureTarget.service.getSearchItems(), [],
            'future-version TODO data must project an empty safe search catalog');
        assert.deepStrictEqual(
            useSettingsStorage ? futureTarget.values.settings : futureTarget.values.global,
            { version: 2, groups: [], todos: [] },
            'safe catalog projection must preserve future-version raw data'
        );
    }

    const storageReadFailure = new Error('ordinary TODO storage read failed');
    const failingReadService = new TodoService({
        globalState: {
            get: () => { throw storageReadFailure; },
            update: async () => undefined,
        },
        configuration: makeWorkspaceConfiguration({}),
        useSettingsStorage: () => false,
    });
    assert.throws(() => failingReadService.getSearchItems(), error => error === storageReadFailure,
        'safe search catalogs must not swallow ordinary storage errors');

    const mixedReadFailure = new Error('inactive TODO storage read failed');
    const futureAndFailingReadService = new TodoService({
        globalState: {
            get: key => key === 'todos' ? { version: 2, groups: [], todos: [] } : undefined,
            update: async () => undefined,
        },
        configuration: {
            get: () => { throw mixedReadFailure; },
            update: async () => undefined,
        },
        useSettingsStorage: () => false,
    });
    assert.throws(() => futureAndFailingReadService.getSearchItems(), error => error === mixedReadFailure,
        'an unsupported version in one backend must not hide an ordinary read failure in the other');

    const activated = makeTodoServiceStorageHarness(
        false,
        { version: 1, groups: [], todos: [] },
        null
    );
    assert.strictEqual(await activated.service.migrateDataIfNeeded(), false);
    activated.values.global = { version: 2, groups: [], todos: [] };
    await assert.rejects(
        () => activated.service.saveData({ version: 1, groups: [], todos: [] }),
        error => error && error.name === 'UnsupportedTodoDataVersionError' && error.version === 2
    );
    assert.deepStrictEqual(activated.updates, [],
        'an active backend changed to a future version must be revalidated before replacement writes');
    assert.deepStrictEqual(activated.values.global, { version: 2, groups: [], todos: [] });

    const selectedData = makeStoredTodoData('selected-group');
    selectedData.todos.push({
        id: 'selected-todo', groupId: 'selected-group', title: 'Selected TODO', notes: '',
        priority: 'medium', completed: false, createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z', order: 0,
    });
    const futureSource = makeTodoServiceStorageHarness(
        false,
        selectedData,
        { version: 2, groups: [], todos: [] }
    );
    assert.deepStrictEqual(futureSource.service.getSearchItems(), [],
        'a future-version inactive source must isolate TODO search as well as writes');
    assert.strictEqual(futureSource.service.getUnsupportedVersionError().version, 2);
    futureSource.values.settings = null;
    assert.strictEqual(futureSource.service.getUnsupportedVersionError(), undefined,
        'live version probing must recover after future-version raw data is replaced with supported data');
    assert.deepStrictEqual(futureSource.service.getSearchItems().map(item => item.todoId), ['selected-todo']);
}

async function runTodoBackendSwitchBarrierChecks() {
    let useSettingsStorage = false;
    let storageProvenance;
    const values = {
        global: { version: 1, groups: [], todos: [] },
        settings: null,
    };
    const updates = [];
    let releaseFirstWrite;
    const firstWriteGate = new Promise(resolve => { releaseFirstWrite = resolve; });
    const dependencies = {
        globalState: {
            get: key => key === 'todos' ? values.global : storageProvenance,
            update: async (key, value) => {
                if (key !== 'todos') {
                    updates.push(['state', key, value]);
                    storageProvenance = value;
                    return;
                }
                updates.push(['global', key, value]);
                if (updates.length === 1) await firstWriteGate;
                values.global = value;
            },
        },
        configuration: {
            get: (key, fallback) => key === 'todoData' ? values.settings : fallback,
            update: async (key, value, target) => {
                updates.push(['settings', key, value, target]);
                values.settings = value;
            },
        },
        useSettingsStorage: () => useSettingsStorage,
        generateId: prefix => `${prefix}-${updates.length}`,
    };
    const service = new TodoService(dependencies);

    const firstMutation = service.addGroup('First global');
    await new Promise(resolve => setImmediate(resolve));
    const queuedMutation = service.addGroup('Queued global');
    useSettingsStorage = true;
    await new Promise(resolve => setImmediate(resolve));
    try {
        assert.deepStrictEqual(updates.map(update => update[0]), ['global']);
    } finally {
        releaseFirstWrite();
    }
    await Promise.all([firstMutation, queuedMutation]);
    assert.deepStrictEqual(values.global.groups.map(group => group.title), ['First global', 'Queued global'],
        'a queued mutation must keep the backend captured when it was enqueued');
    assert.strictEqual(values.settings, null,
        'a later configuration change must not split an already-queued mutation into the new backend');

    const switchedMutation = await service.addGroup('First settings');
    assert.deepStrictEqual(switchedMutation.groups.map(group => group.title),
        ['First global', 'Queued global', 'First settings']);
    assert.deepStrictEqual(values.settings.groups.map(group => group.title),
        ['First global', 'Queued global', 'First settings'],
        'switching to an empty backend must copy the non-empty source before mutating the captured target');
    assert.deepStrictEqual(values.global.groups.map(group => group.title), ['First global', 'Queued global']);
    assert.strictEqual(storageProvenance.version, 1);
    assert.strictEqual(storageProvenance.activeBackend, 'settings');
    assert.match(storageProvenance.inactiveFingerprint, /^[a-f0-9]{64}$/,
        'a successful backend copy must persist the inactive normalized data fingerprint');

    const secondSettingsMutation = await service.addGroup('Second settings');
    assert.deepStrictEqual(secondSettingsMutation.groups.map(group => group.title),
        ['First global', 'Queued global', 'First settings', 'Second settings'],
        'consecutive active-backend mutations must remain allowed while the inactive snapshot is unchanged');

    const restartedService = new TodoService(dependencies);
    const afterRestart = await restartedService.addGroup('Settings after restart');
    assert.deepStrictEqual(afterRestart.groups.map(group => group.title),
        ['First global', 'Queued global', 'First settings', 'Second settings', 'Settings after restart'],
        'restart must recognize the copied source as stale instead of manufacturing a conflict');

    values.settings = makeStoredTodoData('settings-sync');
    const afterSettingsSync = await service.addGroup('After settings sync');
    assert.deepStrictEqual(afterSettingsSync.groups.map(group => group.title),
        ['settings-sync', 'After settings sync'],
        'Settings Sync may replace active data while the recorded inactive snapshot remains unchanged');

    useSettingsStorage = false;
    const switchedBack = await service.addGroup('Back on global');
    assert.deepStrictEqual(switchedBack.groups.map(group => group.title),
        ['settings-sync', 'After settings sync', 'Back on global'],
        'switching back to the recorded stale target must safely copy current active data before mutation');
    assert.deepStrictEqual(values.settings.groups.map(group => group.title),
        ['settings-sync', 'After settings sync']);
    assert.strictEqual(storageProvenance.activeBackend, 'global');

    values.settings = makeStoredTodoData('externally-modified-inactive');
    const updatesBeforeConflict = updates.length;
    await assert.rejects(
        () => service.addGroup('Blocked after inactive change'),
        error => error && error.name === 'TodoStorageConflictError' && /conflict/i.test(error.message)
    );
    assert.strictEqual(updates.length, updatesBeforeConflict,
        'an externally modified inactive backend must conflict before any data or provenance write');
    assert.strictEqual(values.global.groups.some(group => group.title === 'Blocked after inactive change'), false);

    for (const selectedSettings of [false, true]) {
        const sharedData = makeStoredTodoData('shared-group');
        const matching = makeTodoServiceStorageHarness(
            selectedSettings,
            JSON.parse(JSON.stringify(sharedData)),
            JSON.parse(JSON.stringify(sharedData))
        );
        const result = await matching.service.addGroup('Allowed');
        assert.deepStrictEqual(result.groups.map(group => group.title), ['shared-group', 'Allowed'],
            'matching non-empty stores must allow a mutation on the selected backend');
        assert.deepStrictEqual(matching.updates.map(update => update[0]),
            [selectedSettings ? 'settings' : 'global']);
    }

    for (const selectedSettings of [false, true]) {
        const conflict = makeTodoServiceStorageHarness(
            selectedSettings,
            makeStoredTodoData('global-conflict'),
            makeStoredTodoData('settings-conflict')
        );
        await assert.rejects(
            () => conflict.service.addGroup('Blocked'),
            error => error && error.name === 'TodoStorageConflictError' && /conflict/i.test(error.message)
        );
        assert.deepStrictEqual(conflict.updates, [],
            'an initial mutation must reject different non-empty stores without writing either backend');
    }
}

async function runTodoViewStateChecks() {
    const values = new Map([['todoViewState', { showCompleted: true }]]);
    const updates = [];
    const syncUpdates = [];
    const service = new TodoService({
        globalState: {
            get: key => values.get(key),
            update: async (key, value) => {
                updates.push([key, value]);
                values.set(key, value);
            },
            setKeysForSync: keys => syncUpdates.push(keys),
        },
        configuration: makeWorkspaceConfiguration({}),
        useSettingsStorage: () => true,
    });

    assert.deepStrictEqual(service.getViewState(), { showCompleted: true });
    assert.deepStrictEqual(await service.setShowCompleted(false), { showCompleted: false });
    assert.deepStrictEqual(updates, [['todoViewState', { showCompleted: false }]]);
    assert.deepStrictEqual(syncUpdates, [], 'TODO view state must remain local and must not be registered for sync');
}

async function runTodoMutationSerializationChecks() {
    let storedData = { version: 1, groups: [], todos: [] };
    const writes = [];
    let releaseFirstWrite;
    const firstWriteGate = new Promise(resolve => { releaseFirstWrite = resolve; });
    const service = new TodoService({
        globalState: {
            get: () => storedData,
            update: async (_key, value) => {
                writes.push(value);
                if (writes.length === 1) {
                    await firstWriteGate;
                }
                storedData = value;
            },
        },
        configuration: makeWorkspaceConfiguration({}),
        useSettingsStorage: () => false,
        generateId: prefix => `${prefix}-${writes.length}-${storedData.groups.length}`,
    });

    const firstMutation = service.addGroup('First');
    await new Promise(resolve => setImmediate(resolve));
    const secondMutation = service.addGroup('Second');
    await new Promise(resolve => setImmediate(resolve));
    try {
        assert.strictEqual(writes.length, 1, 'a second mutation must wait for the first write to settle');
    } finally {
        releaseFirstWrite();
    }
    await Promise.all([firstMutation, secondMutation]);
    assert.deepStrictEqual(service.getData().groups.map(group => group.title), ['First', 'Second']);

    let recoveredData = { version: 1, groups: [], todos: [] };
    let writeAttempt = 0;
    const recoveringService = new TodoService({
        globalState: {
            get: () => recoveredData,
            update: async (_key, value) => {
                writeAttempt += 1;
                if (writeAttempt === 1) {
                    throw new Error('first write rejected');
                }
                recoveredData = value;
            },
        },
        configuration: makeWorkspaceConfiguration({}),
        useSettingsStorage: () => false,
        generateId: prefix => `${prefix}-${writeAttempt}`,
    });
    const rejectedMutation = recoveringService.addGroup('Rejected');
    const recoveredMutation = recoveringService.addGroup('Recovered');
    await assert.rejects(() => rejectedMutation, /first write rejected/);
    await recoveredMutation;
    assert.strictEqual(writeAttempt, 2);
    assert.deepStrictEqual(recoveringService.getData().groups.map(group => group.title), ['Recovered']);
}

async function runTodoRevealSingleWriteChecks() {
    const makeRevealData = collapsed => ({
        version: 1,
        groups: [{ id: 'group-a', title: 'Release', collapsed, order: 0 }],
        todos: [
            {
                id: 'todo-open', groupId: 'group-a', title: 'Open task', notes: '', priority: 'medium',
                completed: false, createdAt: '2026-07-17T00:00:00.000Z',
                updatedAt: '2026-07-17T00:00:00.000Z', order: 0,
            },
            {
                id: 'todo-target', groupId: 'group-a', title: 'Target completed', notes: '', priority: 'high',
                completed: true, createdAt: '2026-07-17T00:00:00.000Z',
                updatedAt: '2026-07-17T00:00:00.000Z', completedAt: '2026-07-17T01:00:00.000Z', order: 1,
            },
            {
                id: 'todo-other', groupId: 'group-a', title: 'Other completed', notes: '', priority: 'low',
                completed: true, createdAt: '2026-07-17T00:00:00.000Z',
                updatedAt: '2026-07-17T00:00:00.000Z', completedAt: '2026-07-17T02:00:00.000Z', order: 2,
            },
        ],
    });

    const values = new Map([
        ['todos', makeRevealData(true)],
        ['todoViewState', { showCompleted: false }],
    ]);
    const writes = [];
    const service = new TodoService({
        globalState: {
            get: key => values.get(key),
            update: async (key, value) => {
                writes.push([key, value]);
                values.set(key, value);
            },
        },
        configuration: makeWorkspaceConfiguration({}),
        useSettingsStorage: () => false,
    });
    const revealResult = await service.revealTodo('todo-target', 'group-a');
    assert.strictEqual(revealResult.revealed, true);
    assert.deepStrictEqual(writes.map(write => write[0]), ['todos'],
        'revealing a completed TODO in a collapsed group must persist exactly one data write');
    assert.deepStrictEqual(values.get('todoViewState'), { showCompleted: false },
        'search reveal must never persist showCompleted view state');
    assert.strictEqual(values.get('todos').groups[0].collapsed, false);

    const projected = todoViewModel.buildTodoViewModel(
        values.get('todos'),
        values.get('todoViewState'),
        'todo-target'
    );
    assert.deepStrictEqual(projected.groups[0].visibleTodos.map(todo => todo.id), ['todo-open', 'todo-target'],
        'temporary reveal must show only the searched completed TODO');
    assert.strictEqual(projected.groups[0].hiddenCompletedCount, 1);
    const projectedHtml = todoWebviewContent.getTodoPanelContent(projected);
    assert.ok(projectedHtml.includes('Target completed'));
    assert.strictEqual(projectedHtml.includes('Other completed'), false);

    const failedData = makeRevealData(true);
    const failedDataBefore = JSON.parse(JSON.stringify(failedData));
    const failedViewState = { showCompleted: false };
    const failedWrites = [];
    const failingService = new TodoService({
        globalState: {
            get: key => key === 'todos' ? failedData : failedViewState,
            update: async (key, value) => {
                failedWrites.push([key, value]);
                throw new Error('reveal data write failed');
            },
        },
        configuration: makeWorkspaceConfiguration({}),
        useSettingsStorage: () => false,
    });
    let failedRevealedTodoId;
    let failedRefreshes = 0;
    const failureResult = await runTodoMutation({
        mutate: async () => {
            const result = await failingService.revealTodo('todo-target', 'group-a');
            if (result.revealed) failedRevealedTodoId = 'todo-target';
        },
        onSuccess: async () => { failedRefreshes += 1; },
        showErrorMessage: () => undefined,
        logError: () => undefined,
    });
    assert.strictEqual(failureResult, false);
    assert.deepStrictEqual(failedWrites.map(write => write[0]), ['todos']);
    assert.strictEqual(failedRevealedTodoId, undefined,
        'a rejected group write must not set the temporary reveal target');
    assert.deepStrictEqual(failedViewState, { showCompleted: false });
    assert.deepStrictEqual(failedData, failedDataBefore);
    assert.strictEqual(failedRefreshes, 0,
        'a rejected group write must preserve the current panel');

    const expandedData = makeRevealData(false);
    const expandedWrites = [];
    const expandedService = new TodoService({
        globalState: {
            get: key => key === 'todos' ? expandedData : { showCompleted: false },
            update: async (key, value) => expandedWrites.push([key, value]),
        },
        configuration: makeWorkspaceConfiguration({}),
        useSettingsStorage: () => false,
    });
    let expandedRevealedTodoId;
    let expandedProjection;
    const expandedResult = await runTodoMutation({
        mutate: async () => {
            const result = await expandedService.revealTodo('todo-target', 'group-a');
            if (result.revealed) expandedRevealedTodoId = 'todo-target';
        },
        onSuccess: async () => {
            expandedProjection = todoViewModel.buildTodoViewModel(
                expandedData,
                { showCompleted: false },
                expandedRevealedTodoId
            );
        },
        showErrorMessage: () => undefined,
        logError: () => undefined,
    });
    assert.strictEqual(expandedResult, true);
    assert.deepStrictEqual(expandedWrites, [],
        'an already-expanded target group must require zero persistent writes');
    assert.strictEqual(expandedRevealedTodoId, 'todo-target');
    assert.deepStrictEqual(expandedProjection.groups[0].visibleTodos.map(todo => todo.id),
        ['todo-open', 'todo-target']);

    let queuedData = makeRevealData(true);
    const queueEvents = [];
    let releaseRevealWrite;
    const revealWriteGate = new Promise(resolve => { releaseRevealWrite = resolve; });
    const queuedService = new TodoService({
        globalState: {
            get: () => queuedData,
            update: async (_key, value) => {
                queueEvents.push('write-start');
                if (queueEvents.length === 1) await revealWriteGate;
                queuedData = value;
                queueEvents.push('write-end');
            },
        },
        configuration: makeWorkspaceConfiguration({}),
        useSettingsStorage: () => false,
    });
    const queuedReveal = queuedService.revealTodo('todo-target', 'group-a');
    await new Promise(resolve => setImmediate(resolve));
    const queuedCollapse = queuedService.setGroupCollapsed('group-a', true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(queueEvents, ['write-start'],
        'the next mutation must remain queued behind the reveal data write');
    releaseRevealWrite();
    await Promise.all([queuedReveal, queuedCollapse]);
    assert.deepStrictEqual(queueEvents, ['write-start', 'write-end', 'write-start', 'write-end']);
    assert.strictEqual(queuedData.groups[0].collapsed, true);
}

async function runDashboardTodoMigrationSequencingChecks() {
    const extensionHostSource = fs.readFileSync(extensionHostPath, 'utf8');
    const migrationBody = extractAsyncArrowPropertyBody(extensionHostSource, 'migrateDataIfNeeded');
    const runMigrationBody = new AsyncFunction(
        'projectService',
        'todoService',
        'todoStorageMigration',
        'settleMigration',
        migrationBody
    );
    const runMigration = (projectService, todoService, todoStorageMigration) =>
        runMigrationBody(projectService, todoService, todoStorageMigration, settleMigration);
    const events = [];
    let resolveProjectMigration;
    const projectMigration = new Promise(resolve => { resolveProjectMigration = resolve; });
    let migratedTodoData = [];
    const todoStorageMigration = { ready: Promise.resolve() };
    const migration = runMigration(
        {
            migrateDataIfNeeded: () => {
                events.push('project-started');
                return projectMigration;
            },
        },
        {
            migrateDataIfNeeded: async () => {
                events.push('todo-started');
                migratedTodoData = ['migrated'];
                return true;
            },
        },
        todoStorageMigration
    );
    let migrationSettled = false;
    migration.then(() => { migrationSettled = true; });

    try {
        await Promise.resolve();
        assert.deepStrictEqual(events, ['project-started', 'todo-started'],
            'TODO migration must start before the deferred project migration resolves');
        await todoStorageMigration.ready;
        assert.deepStrictEqual(migratedTodoData, ['migrated'],
            'the first TODO render gate must wait for migrated destination data');
        assert.strictEqual(migrationSettled, false, 'project migration should still be pending');
    } finally {
        resolveProjectMigration(false);
        await migration;
    }

    const todoPanelBody = extractFunctionBody(extensionHostSource, 'postTodoPanelContent');
    assert.ok(todoPanelBody.includes('await todoStorageMigration.ready;'),
        'TODO panel rendering must wait for the active TODO storage migration');

    let rejectTodoMigration;
    const failedTodoMigration = new Promise((_resolve, reject) => { rejectTodoMigration = reject; });
    const retryGate = { ready: Promise.resolve() };
    const firstAttempt = runMigration(
        { migrateDataIfNeeded: async () => false },
        { migrateDataIfNeeded: () => failedTodoMigration },
        retryGate
    );
    let failedGateSettled = false;
    retryGate.ready.then(() => { failedGateSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(failedGateSettled, false,
        'the TODO render gate must remain pending while migration is in progress');

    const migrationFailure = new Error('deferred TODO migration rejected');
    rejectTodoMigration(migrationFailure);
    assert.deepStrictEqual(await firstAttempt, {
        projects: { migrated: false },
        todos: { migrated: false, error: migrationFailure },
    });
    await retryGate.ready;
    assert.strictEqual(failedGateSettled, true,
        'a rejected TODO migration must leave a settled, non-poisoned render gate');

    let retryCalls = 0;
    const retryAttempt = runMigration(
        { migrateDataIfNeeded: async () => false },
        { migrateDataIfNeeded: async () => { retryCalls += 1; return true; } },
        retryGate
    );
    assert.deepStrictEqual(await retryAttempt, {
        projects: { migrated: false },
        todos: { migrated: true },
    });
    await retryGate.ready;
    assert.strictEqual(retryCalls, 1,
        'a later configuration migration must retry after a rejected TODO migration');

    const makeAggregationHarness = (migrateProjects, migrateTodos) => {
        const gate = { ready: Promise.resolve() };
        const refreshes = [];
        const publications = [];
        const errors = [];
        const logs = [];
        const controller = new DashboardStartupController({
            stewardInfos: {
                relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
                config: { openOnStartup: 'never' },
            },
            isExtensionInstalled: () => false,
            migrateDataIfNeeded: () => runMigration(
                { migrateDataIfNeeded: migrateProjects },
                { migrateDataIfNeeded: migrateTodos },
                gate
            ),
            refreshDashboard: async () => { refreshes.push('refreshed'); },
            publishOpenWorkspace: () => publications.push('published'),
            showInformationMessage: () => undefined,
            showErrorMessage: message => errors.push(message),
            logError: (message, error) => logs.push([message, error]),
            showSteward: () => undefined,
            applyProjectColorToCurrentWindow: () => undefined,
            getReopenReason: () => 0,
            updateReopenReason: () => undefined,
            reopenNoneValue: 0,
            getWorkspaceName: () => 'workspace',
            getVisibleEditorLanguageIds: () => [],
        });
        return { controller, gate, refreshes, publications, errors, logs };
    };

    const projectPartialError = new Error('project migration rejected after TODO success');
    let projectPartialCalls = 0;
    let todoPartialCalls = 0;
    const todoSuccessHarness = makeAggregationHarness(
        () => ++projectPartialCalls === 1 ? Promise.reject(projectPartialError) : Promise.resolve(false),
        () => Promise.resolve(++todoPartialCalls === 1)
    );
    await todoSuccessHarness.controller.checkDataMigration();
    await todoSuccessHarness.gate.ready;
    assert.deepStrictEqual(todoSuccessHarness.refreshes, ['refreshed'],
        'TODO true plus project rejection must retain the success and refresh exactly once');
    assert.deepStrictEqual(todoSuccessHarness.publications, ['published']);
    assert.deepStrictEqual(todoSuccessHarness.logs,
        [['Failed to migrate Project Steward project data.', projectPartialError]]);
    assert.strictEqual(todoSuccessHarness.errors.length, 1);
    assert.ok(todoSuccessHarness.errors[0].includes('project migration rejected after TODO success'));
    await todoSuccessHarness.controller.checkDataMigration();
    assert.deepStrictEqual(todoSuccessHarness.refreshes, ['refreshed'],
        'a later false plus false result must not be needed to compensate for a lost partial success');

    const todoPartialError = new Error('TODO migration rejected after project success');
    const projectSuccessHarness = makeAggregationHarness(
        () => Promise.resolve(true),
        () => Promise.reject(todoPartialError)
    );
    await projectSuccessHarness.controller.checkDataMigration();
    await projectSuccessHarness.gate.ready;
    assert.deepStrictEqual(projectSuccessHarness.refreshes, ['refreshed'],
        'project true plus TODO rejection must retain the success and refresh exactly once');
    assert.deepStrictEqual(projectSuccessHarness.logs,
        [['Failed to migrate Project Steward TODO data.', todoPartialError]]);
    assert.strictEqual(projectSuccessHarness.errors.length, 1);
    assert.ok(projectSuccessHarness.errors[0].includes('TODO migration rejected after project success'));

    const bothProjectError = new Error('both-reject project failure');
    const bothTodoError = new Error('both-reject TODO failure');
    let bothAttempts = 0;
    const bothRejectHarness = makeAggregationHarness(
        () => bothAttempts === 0 ? Promise.reject(bothProjectError) : Promise.resolve(false),
        () => {
            const firstAttempt = bothAttempts === 0;
            bothAttempts += 1;
            return firstAttempt ? Promise.reject(bothTodoError) : Promise.resolve(true);
        }
    );
    await bothRejectHarness.controller.checkDataMigration();
    await bothRejectHarness.gate.ready;
    assert.deepStrictEqual(bothRejectHarness.refreshes, [],
        'both rejected migrations must not refresh without any successful migration');
    assert.deepStrictEqual(bothRejectHarness.logs, [
        ['Failed to migrate Project Steward project data.', bothProjectError],
        ['Failed to migrate Project Steward TODO data.', bothTodoError],
    ]);
    assert.strictEqual(bothRejectHarness.errors.length, 2);
    await bothRejectHarness.controller.checkDataMigration();
    await bothRejectHarness.gate.ready;
    assert.deepStrictEqual(bothRejectHarness.refreshes, ['refreshed'],
        'both-reject migration state must remain retryable');

    const syncTodoPartialError = new Error('TODO migration threw synchronously after project success');
    const syncTodoPartialHarness = makeAggregationHarness(
        () => Promise.resolve(true),
        () => { throw syncTodoPartialError; }
    );
    await syncTodoPartialHarness.controller.checkDataMigration();
    await syncTodoPartialHarness.gate.ready;
    assert.deepStrictEqual(syncTodoPartialHarness.refreshes, ['refreshed'],
        'a synchronous TODO throw must not discard a successful project migration');
    assert.deepStrictEqual(syncTodoPartialHarness.logs,
        [['Failed to migrate Project Steward TODO data.', syncTodoPartialError]]);
    assert.strictEqual(syncTodoPartialHarness.errors.length, 1);

    const syncTodoBothError = new Error('TODO migration threw synchronously with project rejection');
    const rejectedProjectError = new Error('project migration rejected beside synchronous TODO throw');
    let syncFailureAttempts = 0;
    const syncFailureHarness = makeAggregationHarness(
        () => syncFailureAttempts === 0 ? Promise.reject(rejectedProjectError) : Promise.resolve(false),
        () => {
            const firstAttempt = syncFailureAttempts === 0;
            syncFailureAttempts += 1;
            if (firstAttempt) {
                throw syncTodoBothError;
            }
            return Promise.resolve(true);
        }
    );
    const unhandledRejections = [];
    const captureUnhandledRejection = reason => { unhandledRejections.push(reason); };
    process.on('unhandledRejection', captureUnhandledRejection);
    try {
        await syncFailureHarness.controller.checkDataMigration();
        await syncFailureHarness.gate.ready;
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(syncFailureHarness.refreshes, [],
            'a synchronous throw plus rejection must not refresh without a migration success');
        assert.deepStrictEqual(syncFailureHarness.logs, [
            ['Failed to migrate Project Steward project data.', rejectedProjectError],
            ['Failed to migrate Project Steward TODO data.', syncTodoBothError],
        ]);
        assert.strictEqual(syncFailureHarness.errors.length, 2);
        assert.deepStrictEqual(unhandledRejections, [],
            'synchronous migration failure must not leave the other migration rejection unhandled');

        await syncFailureHarness.controller.checkDataMigration();
        await syncFailureHarness.gate.ready;
        assert.deepStrictEqual(syncFailureHarness.refreshes, ['refreshed'],
            'the TODO render gate must recover for retry after a synchronous migration throw');
    } finally {
        process.removeListener('unhandledRejection', captureUnhandledRejection);
    }
}

async function runTodoHostMutationChecks() {
    const hostModulePath = path.join(root, 'out', 'todos', 'hostMutation.js');
    assert.ok(fs.existsSync(hostModulePath), 'TODO host mutation error boundary must exist');
    const {
        renameTodoGroupWithPrompt,
        runTodoMutation,
        runTodoPromptMutation,
        runTodoRequestMutation,
    } = require(hostModulePath);
    const events = [];
    const failed = await runTodoMutation({
        mutate: async () => { throw new Error('storage full'); },
        onSuccess: async () => events.push('posted-panel'),
        showErrorMessage: message => events.push(['error', message]),
        logError: (message, error) => events.push(['log', message, error.message]),
    });
    assert.strictEqual(failed, false);
    assert.strictEqual(events.some(event => event === 'posted-panel'), false, 'a rejected write must preserve the current panel');
    assert.ok(events.some(event => Array.isArray(event) && event[0] === 'error' && /save TODO changes/i.test(event[1])));
    assert.ok(events.some(event => Array.isArray(event) && event[0] === 'log' && event[2] === 'storage full'));

    events.length = 0;
    await runTodoMutation({
        mutate: async () => { throw new todoTypes.TodoStorageConflictError(); },
        onSuccess: async () => events.push('posted-panel'),
        showErrorMessage: message => events.push(['error', message]),
        logError: (message, error) => events.push(['log', message, error.message]),
    });
    assert.ok(events.some(event => Array.isArray(event)
        && event[0] === 'error' && /storage conflict/i.test(event[1])),
    'a backend conflict must be visible rather than reduced to a generic write failure');
    assert.strictEqual(events.includes('posted-panel'), false);

    events.length = 0;
    const succeeded = await runTodoMutation({
        mutate: async () => events.push('mutated'),
        onSuccess: async () => events.push('posted-panel'),
        showErrorMessage: message => events.push(['error', message]),
        logError: (message, error) => events.push(['log', message, error.message]),
    });
    assert.strictEqual(succeeded, true);
    assert.deepStrictEqual(events, ['mutated', 'posted-panel']);

    assert.strictEqual(typeof deleteTodoWithConfirmation, 'function',
        'single TODO deletion must use a directly testable host helper');

    const runDeletion = async (options = {}) => {
        const todoId = options.todoId || 'todo-a';
        const confirmation = Object.prototype.hasOwnProperty.call(options, 'confirmation')
            ? options.confirmation
            : 'Delete';
        const rejectDelete = options.rejectDelete === true;
        const calls = [];
        const result = await deleteTodoWithConfirmation({
            todoId,
            getData: () => ({
                todos: [{ id: 'todo-a', title: 'Ship deletion flow' }],
            }),
            confirm: async title => {
                calls.push(['confirm', title]);
                return confirmation;
            },
            deleteTodo: async id => {
                calls.push(['delete', id]);
                if (rejectDelete) {
                    throw new Error('storage rejected');
                }
            },
            refreshPanel: async () => { calls.push(['refresh']); },
            showErrorMessage: message => calls.push(['error', message]),
            logError: (message, error) => calls.push(['log', message, error.message]),
        });
        return { calls, result };
    };

    const confirmedDeletion = await runDeletion();
    assert.strictEqual(confirmedDeletion.result, true);
    assert.deepStrictEqual(confirmedDeletion.calls, [
        ['confirm', 'Ship deletion flow'],
        ['delete', 'todo-a'],
        ['refresh'],
    ], 'confirmed deletion must delete and refresh exactly once');

    for (const confirmation of [undefined, 'Keep']) {
        const canceledDeletion = await runDeletion({ confirmation });
        assert.strictEqual(canceledDeletion.result, false);
        assert.deepStrictEqual(canceledDeletion.calls, [
            ['confirm', 'Ship deletion flow'],
        ], 'canceled deletion must not delete or refresh');
    }

    const missingDeletion = await runDeletion({ todoId: 'missing' });
    assert.strictEqual(missingDeletion.result, false);
    assert.deepStrictEqual(missingDeletion.calls, [],
        'a missing TODO must not prompt, delete, or refresh');

    const rejectedDeletion = await runDeletion({ rejectDelete: true });
    assert.strictEqual(rejectedDeletion.result, false);
    assert.strictEqual(rejectedDeletion.calls.filter(call => call[0] === 'delete').length, 1);
    assert.strictEqual(rejectedDeletion.calls.some(call => call[0] === 'refresh'), false,
        'a rejected deletion must preserve the current panel');
    assert.ok(rejectedDeletion.calls.some(call => call[0] === 'error' && /save TODO changes/i.test(call[1])));
    assert.ok(rejectedDeletion.calls.some(call => call[0] === 'log' && call[2] === 'storage rejected'));

    const retryCalls = [];
    let retryPromptCount = 0;
    let retryWriteCount = 0;
    const retried = await runTodoPromptMutation({
        initialValue: 'Existing group',
        prompt: async value => {
            retryCalls.push(['prompt', value]);
            retryPromptCount += 1;
            return 'Typed group';
        },
        mutate: async value => {
            retryCalls.push(['write', value]);
            retryWriteCount += 1;
            if (retryWriteCount === 1) throw new Error('storage rejected prompt mutation');
        },
        refreshPanel: async () => { retryCalls.push(['refresh']); },
        showErrorMessage: message => retryCalls.push(['error', message]),
        logError: (message, error) => retryCalls.push(['log', message, error.message]),
    });
    assert.strictEqual(retried, true);
    assert.deepStrictEqual(retryCalls.filter(call => call[0] === 'prompt'), [
        ['prompt', 'Existing group'],
        ['prompt', 'Typed group'],
    ], 'a rejected prompt mutation must reprompt with the rejected input');
    assert.strictEqual(retryCalls.filter(call => call[0] === 'error').length, 1,
        'the storage rejection must be shown before retrying');
    assert.ok(retryCalls.findIndex(call => call[0] === 'error')
        < retryCalls.map(call => call[0]).lastIndexOf('prompt'),
    'the storage error must be visible before the retry prompt opens');
    assert.deepStrictEqual(retryCalls.filter(call => call[0] === 'write'), [
        ['write', 'Typed group'],
        ['write', 'Typed group'],
    ]);
    assert.strictEqual(retryCalls.filter(call => call[0] === 'refresh').length, 1,
        'a successful retry must refresh exactly once');

    const cancelCalls = [];
    let cancelPromptCount = 0;
    const canceled = await runTodoPromptMutation({
        prompt: async value => {
            cancelCalls.push(['prompt', value]);
            cancelPromptCount += 1;
            return cancelPromptCount === 1 ? 'Keep this draft' : undefined;
        },
        mutate: async value => {
            cancelCalls.push(['write', value]);
            throw new Error('storage rejected before cancel');
        },
        refreshPanel: async () => { cancelCalls.push(['refresh']); },
        showErrorMessage: message => cancelCalls.push(['error', message]),
        logError: (message, error) => cancelCalls.push(['log', message, error.message]),
    });
    assert.strictEqual(canceled, false);
    assert.deepStrictEqual(cancelCalls.filter(call => call[0] === 'prompt'), [
        ['prompt', undefined],
        ['prompt', 'Keep this draft'],
    ]);
    assert.deepStrictEqual(cancelCalls.filter(call => call[0] === 'write'), [
        ['write', 'Keep this draft'],
    ], 'canceling the retry prompt must not perform an extra write');
    assert.strictEqual(cancelCalls.some(call => call[0] === 'refresh'), false);

    const missingRenameCalls = [];
    const missingRename = await renameTodoGroupWithPrompt({
        groupId: 'missing',
        getData: () => ({ groups: [{ id: 'group-a', title: 'Existing group' }] }),
        prompt: async value => {
            missingRenameCalls.push(['prompt', value]);
            return 'Renamed';
        },
        renameGroup: async (groupId, value) => { missingRenameCalls.push(['write', groupId, value]); },
        refreshPanel: async () => { missingRenameCalls.push(['refresh']); },
        showErrorMessage: message => missingRenameCalls.push(['error', message]),
        logError: (message, error) => missingRenameCalls.push(['log', message, error.message]),
    });
    assert.strictEqual(missingRename, false);
    assert.deepStrictEqual(missingRenameCalls, [], 'a missing TODO group must not prompt, write, or refresh');

    const malformedRequestCalls = [];
    const malformedRequest = await runTodoRequestMutation({
        requestId: 7,
        valid: false,
        mutate: async () => { malformedRequestCalls.push(['write']); },
        onSuccess: async () => { malformedRequestCalls.push(['refresh']); },
        postResult: async message => { malformedRequestCalls.push(['result', message]); },
        showErrorMessage: message => malformedRequestCalls.push(['error', message]),
        logError: (message, error) => malformedRequestCalls.push(['log', message, error.message]),
    });
    assert.strictEqual(malformedRequest, false);
    assert.deepStrictEqual(malformedRequestCalls, [[
        'result',
        { type: 'todo-mutation-result', version: 1, requestId: 7, success: false },
    ]], 'a malformed compose payload with a request ID must receive a failure ack without writing');

    const successfulRequestCalls = [];
    const successfulRequest = await runTodoRequestMutation({
        requestId: 8,
        valid: true,
        mutate: async () => { successfulRequestCalls.push(['write']); },
        onSuccess: async () => { successfulRequestCalls.push(['refresh']); },
        postResult: async message => { successfulRequestCalls.push(['result', message]); },
        showErrorMessage: message => successfulRequestCalls.push(['error', message]),
        logError: (message, error) => successfulRequestCalls.push(['log', message, error.message]),
    });
    assert.strictEqual(successfulRequest, true);
    assert.deepStrictEqual(successfulRequestCalls, [
        ['write'],
        ['refresh'],
        ['result', { type: 'todo-mutation-result', version: 1, requestId: 8, success: true }],
    ], 'a successful compose mutation must refresh the panel before acknowledging success');

    const failedRefreshCalls = [];
    const savedWithoutRefresh = await runTodoRequestMutation({
        requestId: 9,
        valid: true,
        mutate: async () => { failedRefreshCalls.push(['write']); },
        onSuccess: async () => {
            failedRefreshCalls.push(['refresh']);
            throw new Error('panel refresh failed');
        },
        postResult: async message => { failedRefreshCalls.push(['result', message]); },
        showErrorMessage: message => failedRefreshCalls.push(['error', message]),
        logError: (message, error) => failedRefreshCalls.push(['log', message, error.message]),
    });
    assert.strictEqual(savedWithoutRefresh, true,
        'a completed write must remain successful when only the panel refresh fails');
    assert.deepStrictEqual(failedRefreshCalls, [
        ['write'],
        ['refresh'],
        ['log', 'Failed to refresh the TODO panel after saving.', 'panel refresh failed'],
        ['error', 'TODO saved, but the panel could not be refreshed.'],
        ['result', {
            type: 'todo-mutation-result',
            version: 1,
            requestId: 9,
            success: true,
            panelRefreshed: false,
        }],
    ], 'a refresh failure must acknowledge the committed write without inviting a duplicate retry');
}

function makeTodoData() {
    return {
        version: 1,
        groups: [
            { id: 'group-a', title: 'Launch <Group>', collapsed: false, order: 0 },
            { id: 'group-b', title: 'Backlog', collapsed: true, order: 1 },
        ],
        todos: [
            {
                id: 'todo-a',
                groupId: 'group-a',
                title: 'Write <spec>',
                notes: 'Plain notes',
                priority: 'high',
                completed: false,
                createdAt: '2026-07-16T00:00:00.000Z',
                updatedAt: '2026-07-16T00:00:00.000Z',
                order: 0,
            },
            {
                id: 'todo-b',
                groupId: 'group-a',
                title: 'Done task',
                notes: '',
                priority: 'low',
                completed: true,
                createdAt: '2026-07-16T00:00:00.000Z',
                updatedAt: '2026-07-16T00:00:00.000Z',
                completedAt: '2026-07-16T01:00:00.000Z',
                order: 1,
            },
        ],
    };
}

function makeTodoBoundaryData(todoCount) {
    return {
        version: 1,
        groups: [{ id: 'boundary-group', title: 'Boundary', collapsed: false, order: 0 }],
        todos: Array.from({ length: todoCount }, (_, index) => ({
            id: `boundary-todo-${index}`,
            groupId: 'boundary-group',
            title: `Boundary todo ${index + 1}`,
            notes: '',
            priority: 'medium',
            completed: false,
            createdAt: '2026-07-16T00:00:00.000Z',
            updatedAt: '2026-07-16T00:00:00.000Z',
            order: index,
        })),
    };
}

function runTodoViewModelChecks() {
    const hiddenCompleted = todoViewModel.buildTodoViewModel(makeTodoData(), { showCompleted: false });
    assert.strictEqual(hiddenCompleted.groups.length, 2);
    assert.strictEqual(hiddenCompleted.groups[0].visibleTodos.length, 1);
    assert.strictEqual(hiddenCompleted.groups[0].hiddenCompletedCount, 1);
    assert.strictEqual(hiddenCompleted.totalIncomplete, 1);
    assert.strictEqual(hiddenCompleted.totalCompleted, 1);

    const showCompleted = todoViewModel.buildTodoViewModel(makeTodoData(), { showCompleted: true });
    assert.strictEqual(showCompleted.groups[0].visibleTodos.length, 2);

    const stableCompletedLast = todoViewModel.buildTodoViewModel({
        version: 1,
        groups: [{ id: 'stable-group', title: 'Stable', collapsed: false, order: 0 }],
        todos: [
            { id: 'done-first', groupId: 'stable-group', title: 'Done first', notes: '', priority: 'medium', completed: true, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', completedAt: '2026-07-16T01:00:00.000Z', order: 0 },
            { id: 'open-first', groupId: 'stable-group', title: 'Open first', notes: '', priority: 'medium', completed: false, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', order: 1 },
            { id: 'done-second', groupId: 'stable-group', title: 'Done second', notes: '', priority: 'medium', completed: true, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', completedAt: '2026-07-16T02:00:00.000Z', order: 2 },
            { id: 'open-second', groupId: 'stable-group', title: 'Open second', notes: '', priority: 'medium', completed: false, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z', order: 3 },
        ],
    }, { showCompleted: true });
    assert.deepStrictEqual(
        stableCompletedLast.groups[0].visibleTodos.map(todo => todo.id),
        ['open-first', 'open-second', 'done-first', 'done-second'],
        'completed TODOs must be stably projected after incomplete TODOs'
    );

    const html = todoWebviewContent.getTodoPanelContent(hiddenCompleted, { maxVisibleTodosPerGroup: 7 });
    assert.ok(html.includes('todo-panel'));
    assert.ok(html.includes('--todo-visible-items: 7;'));
    assert.ok(html.includes('--todo-list-max-height: 448px;'));
    assert.ok(html.includes('--todo-collapsed-item-height: 58px;'));
    assert.ok(html.includes('Launch &lt;Group&gt;'));
    assert.ok(html.includes('Write &lt;spec&gt;'));
    assert.ok(html.includes('title="Write &lt;spec&gt;"'));
    assert.strictEqual(html.includes('Done task'), false);
    assert.ok(html.includes('1 completed hidden'));
    assert.ok(html.includes('todo-page-header group-title steward-group-header'));
    assert.ok(html.includes('todo-group-header group-title steward-group-header'));
    assert.ok(html.includes('todo-item steward-item-card'));
    assert.ok(html.includes('todo-item-accent steward-item-accent'));
    assert.strictEqual(html.includes('todo-summary-card'), false);
    assert.strictEqual(html.includes('steward-card-compact'), false);
    assert.ok(html.includes('todo-summary-meta'));
    assert.ok(html.includes('todo-summary-actions'));
    assert.ok(html.includes('todo-group group steward-section'));
    assert.ok(html.includes('todo-group-actions group-actions'));
    assert.ok(html.includes('data-action="todo-collapse-group"'));
    assert.ok(html.includes('<button class="todo-group-collapse-button"'));
    assert.ok(html.includes('data-action="todo-collapse-group" data-todo-group-id="group-a" aria-expanded="true"'));
    assert.ok(html.includes('data-action="todo-collapse-group" data-todo-group-id="group-b" aria-expanded="false"'));
    assert.ok(html.includes('<h2 data-drag-todo-group title="Launch &lt;Group&gt;"'),
        'the group collapse button must remain outside the Dragula handle');
    assert.ok(html.includes('data-action="todo-rename-group"'));
    assert.ok(html.includes('data-action="todo-delete-group"'));
    assert.ok(html.includes('data-drag-todo-group'));
    assert.ok(html.includes('todo-priority-badge steward-badge'));
    const todoTitleLineOpeningTag = '<div class="todo-title-line">';
    const todoTitleLineBody = extractHtmlElementBody(html, todoTitleLineOpeningTag);
    const todoTitleIndex = todoTitleLineBody.indexOf(
        '<span class="todo-title-text" title="Write &lt;spec&gt;">Write &lt;spec&gt;</span>'
    );
    const todoPriorityIndex = todoTitleLineBody.indexOf(
        '<span class="todo-priority-badge steward-badge">HIGH</span>'
    );
    assert.ok(todoTitleIndex >= 0, 'todo title should exist in its title line');
    assert.ok(todoPriorityIndex >= 0, 'todo priority should exist in its title line');
    assert.ok(
        todoTitleIndex < todoPriorityIndex,
        'todo titles should appear before their priority badges'
    );
    assert.ok(html.includes('todo-item-footer steward-meta'));
    assert.ok(html.includes('todo-icon-button steward-icon-button'));
    assert.ok(html.includes('type="button" data-action="todo-toggle-expanded"'),
        'the native TODO expand button must provide Enter and Space activation');
    assert.ok(html.includes('aria-expanded="false"'));
    assert.strictEqual(html.includes('<li class="todo-item steward-item-card todo-priority-high" data-todo-id="todo-a" aria-expanded='), false,
        'TODO list items must not impersonate buttons or own the expand control state');
    assert.strictEqual(html.includes('role="button"'), false,
        'TODO cards with nested controls must not use role=button');
    assert.ok(html.includes('todo-item-content'));
    assert.ok(html.includes('todo-item-footer'));
    const addFormCount = (html.match(/<form class="todo-add-form\b/g) || []).length;
    assert.strictEqual(addFormCount, 1, 'TODO panels must render one reachable compose form');
    assert.ok(html.includes('<form class="todo-add-form todo-compose-panel steward-card" data-todo-form="add" hidden>'));
    assert.ok(html.includes('name="title"'));
    assert.ok(html.includes('name="priority"'));
    assert.ok(html.includes('name="notes"'));
    assert.ok(html.includes('name="groupId"'));
    assert.ok(html.includes('data-action="todo-add"'));
    assert.ok(html.includes('data-action="todo-cancel-add"'));
    assert.ok(html.includes('todo-edit-form'));
    assert.ok(html.includes('todo-edit-panel'));
    assert.ok(html.includes('todo-priority-segment'));
    assert.ok(html.includes('data-action="todo-save-edit"'));
    assert.ok(html.includes('data-action="todo-cancel-edit"'));
    assert.ok(html.includes('data-action="todo-toggle-show-completed"'));

    const defaultHtml = todoWebviewContent.getTodoPanelContent(hiddenCompleted);
    assert.ok(defaultHtml.includes('--todo-visible-items: 5;'));
    assert.ok(defaultHtml.includes('--todo-list-max-height: 318px;'));

    const configuredCardCount = 5;
    const collapsedCardHeight = 58;
    const interCardSpacing = 7;
    const configuredMaxHeight = 318;
    const countRenderedTodoCards = content => (content.match(/<li class="todo-item steward-item-card\b/g) || []).length;
    const exactBoundaryHtml = todoWebviewContent.getTodoPanelContent(
        todoViewModel.buildTodoViewModel(makeTodoBoundaryData(configuredCardCount))
    );
    const overflowBoundaryHtml = todoWebviewContent.getTodoPanelContent(
        todoViewModel.buildTodoViewModel(makeTodoBoundaryData(configuredCardCount + 1))
    );
    assert.strictEqual(countRenderedTodoCards(exactBoundaryHtml), configuredCardCount);
    assert.strictEqual(countRenderedTodoCards(overflowBoundaryHtml), configuredCardCount + 1);
    assert.ok(exactBoundaryHtml.includes('--todo-list-max-height: 318px;'));
    assert.ok(overflowBoundaryHtml.includes('--todo-list-max-height: 318px;'));
    assert.strictEqual(
        (configuredCardCount * collapsedCardHeight) + ((configuredCardCount - 1) * interCardSpacing),
        configuredMaxHeight
    );
    assert.ok(
        ((configuredCardCount + 1) * collapsedCardHeight) + (configuredCardCount * interCardSpacing)
            > configuredMaxHeight,
        'N+1 rendered cards should exceed the unchanged N-card viewport height'
    );

    const emptyHtml = todoWebviewContent.getTodoPanelContent(todoViewModel.buildTodoViewModel({ version: 1, groups: [], todos: [] }));
    assert.ok(emptyHtml.includes('todo-empty-state steward-empty-state'));
    assert.ok(emptyHtml.includes('No todos yet'));

    const unsupportedHtml = todoWebviewContent.getUnsupportedTodoVersionPanelContent(7);
    assert.ok(unsupportedHtml.includes('data-todo-error="unsupported-version"'));
    assert.ok(unsupportedHtml.includes('version 7'));
    assert.ok(unsupportedHtml.toLowerCase().includes('read-only'));
    assert.strictEqual(unsupportedHtml.includes('data-action='), false,
        'the unsupported-version TODO panel must expose no mutation controls');
    assert.strictEqual(unsupportedHtml.includes('<form'), false,
        'the unsupported-version TODO panel must be read-only');
    assert.strictEqual((emptyHtml.match(/<form class="todo-add-form\b/g) || []).length, 1,
        'an empty TODO panel must expose the same compose form');
    assert.ok(emptyHtml.includes('<option value="">Inbox</option>'));
    assert.strictEqual(emptyHtml.includes('todo-empty-orb'), false);
    assert.strictEqual(emptyHtml.includes('Create first group'), false);
    assert.strictEqual(emptyHtml.includes('Add todo to Inbox'), false);
    assert.strictEqual(html.includes('todo-edit-panel steward-card'), false);

    const emptyGroupViewModel = todoViewModel.buildTodoViewModel({
        version: 1,
        groups: [{ id: 'empty-group', title: 'Empty Group', collapsed: false, order: 0 }],
        todos: [],
    });
    const emptyGroupHtml = todoWebviewContent.getTodoPanelContent(emptyGroupViewModel);
    assert.strictEqual(emptyGroupViewModel.isEmpty, false, 'a panel with an empty group is not globally empty');
    assert.ok(emptyGroupHtml.includes('data-todo-group-id="empty-group"'));
    assert.ok(emptyGroupHtml.includes('Empty Group'));
    assert.ok(emptyGroupHtml.includes('data-action="todo-add" data-group-id="empty-group"'));
    assert.strictEqual(emptyGroupHtml.includes('No todos yet'), false);

    const dashboardViewModel = require('../out/webview/dashboardViewModel');
    const catalog = dashboardViewModel.buildWorkspaceDashboardSearchCatalog(
        [], [], todoTypes.buildTodoSearchItems(makeTodoData())
    );
    assert.strictEqual(catalog.todos.length, 2);
    assert.ok(dashboardViewModel.serializeDashboardSearchCatalog(catalog).includes('Write TODO') === false);
}

function runTodoOrderingInteractionChecks() {
    const projectSource = fs.readFileSync(projectScriptPath, 'utf8');
    const projectContext = {};
    vm.runInNewContext(projectSource, projectContext);
    const groups = ['Release', 'Backlog'].map((title, index) => {
        const group = createElement(`todo-group-${index}`);
        const button = createElement(`todo-group-${index}-collapse`);
        const heading = { textContent: title };
        group.querySelector = selector => {
            if (selector === '[data-action="todo-collapse-group"]') return button;
            if (selector === 'h2') return heading;
            return null;
        };
        group.collapseButton = button;
        return group;
    });
    const bulkMessages = [];
    projectContext.collapseTodoGroups(groups, true, message => bulkMessages.push(message));
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(bulkMessages)),
        [{ type: 'todo-collapse-groups', collapsed: true }],
        'global TODO collapse must post one bulk message'
    );
    assert.deepStrictEqual(groups.map(group => group.classList.contains('collapsed')), [true, true]);
    assert.deepStrictEqual(groups.map(group => ({
        expanded: group.collapseButton.getAttribute('aria-expanded'),
        title: group.collapseButton.getAttribute('title'),
        label: group.collapseButton.getAttribute('aria-label'),
    })), [
        { expanded: 'false', title: 'Expand todo group', label: 'Expand Release' },
        { expanded: 'false', title: 'Expand todo group', label: 'Expand Backlog' },
    ], 'bulk collapse must keep every group button synchronized with its class');
    projectContext.collapseTodoGroups(groups, false, message => bulkMessages.push(message));
    assert.deepStrictEqual(groups.map(group => ({
        collapsed: group.classList.contains('collapsed'),
        expanded: group.collapseButton.getAttribute('aria-expanded'),
        title: group.collapseButton.getAttribute('title'),
        label: group.collapseButton.getAttribute('aria-label'),
    })), [
        { collapsed: false, expanded: 'true', title: 'Collapse todo group', label: 'Collapse Release' },
        { collapsed: false, expanded: 'true', title: 'Collapse todo group', label: 'Collapse Backlog' },
    ]);
    assert.strictEqual(bulkMessages.length, 2, 'each bulk class transition must post exactly one message');

    const expandButton = createElement('todo-expand');
    const todoItem = {
        classList: createClassList(),
        querySelector: selector => {
            if (selector === '[data-action="todo-toggle-expanded"]') return expandButton;
            if (selector === '.todo-title-text') return { textContent: 'Ship release' };
            return null;
        },
    };
    projectContext.syncTodoExpandControl(todoItem, true);
    assert.deepStrictEqual({
        expanded: expandButton.getAttribute('aria-expanded'),
        title: expandButton.getAttribute('title'),
        label: expandButton.getAttribute('aria-label'),
    }, { expanded: 'true', title: 'Collapse todo', label: 'Collapse Ship release' });
    projectContext.syncTodoExpandControl(todoItem, false);
    assert.deepStrictEqual({
        expanded: expandButton.getAttribute('aria-expanded'),
        title: expandButton.getAttribute('title'),
        label: expandButton.getAttribute('aria-label'),
    }, { expanded: 'false', title: 'Expand todo', label: 'Expand Ship release' });

    const dndSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDnDScripts.js'), 'utf8');
    const dndContext = {};
    vm.runInNewContext(dndSource, dndContext);
    const todoGroupsContainer = { matches: selector => selector === '.todo-groups' };
    const projectGroupsContainer = { matches: selector => selector === '.groups-wrapper' };
    const todoListA = { matches: selector => selector === '.todo-list' };
    const todoListB = { matches: selector => selector === '.todo-list' };
    assert.strictEqual(dndContext.canAcceptTodoGroup(todoGroupsContainer, todoGroupsContainer), true);
    assert.strictEqual(dndContext.canAcceptTodoGroup(projectGroupsContainer, todoGroupsContainer), false,
        'TODO groups must not be accepted by project group containers');
    assert.strictEqual(dndContext.canAcceptTodoItem(todoListA, todoListA), true);
    assert.strictEqual(dndContext.canAcceptTodoItem(todoListB, todoListA), false,
        'TODO items must be rejected when dragged across groups');

    const groupElements = ['group-c', 'group-a', 'group-b'].map(groupId => ({
        getAttribute: name => name === 'data-todo-group-id' ? groupId : null,
    }));
    const todoElements = ['todo-a2', 'todo-a1'].map(todoId => ({
        getAttribute: name => name === 'data-todo-id' ? todoId : null,
    }));
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(dndContext.getTodoGroupIds({ querySelectorAll: () => groupElements }))),
        ['group-c', 'group-a', 'group-b'],
        'TODO group reorder messages must preserve the exact DOM ID array'
    );
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(dndContext.getTodoIds({ querySelectorAll: () => todoElements }))),
        ['todo-a2', 'todo-a1'],
        'TODO item reorder messages must preserve the exact same-group DOM ID array'
    );

    const disposed = [];
    dndContext.window = {
        removeEventListener: (type, listener) => disposed.push(['listener', type, listener]),
    };
    const onKeyDown = () => undefined;
    const dndRoot = {
        __projectStewardDnDInitialized: true,
        __projectStewardDnD: {
            projectDrake: { destroy: () => disposed.push('project') },
            groupsDrake: { destroy: () => disposed.push('groups') },
            todoGroupsDrake: { destroy: () => disposed.push('todo-groups') },
            todoItemsDrake: { destroy: () => disposed.push('todo-items') },
            scroll: { destroy: force => disposed.push(['scroll', force]) },
            onKeyDown,
        },
    };
    dndContext.disposeDnD(dndRoot);
    assert.deepStrictEqual(disposed, [
        'project', 'groups', 'todo-groups', 'todo-items', ['scroll', true], ['listener', 'keydown', onKeyDown],
    ]);
    assert.strictEqual(dndRoot.__projectStewardDnDInitialized, undefined);
    assert.strictEqual(dndRoot.__projectStewardDnD, undefined);
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
        publishOpenWorkspace: () => published.push('open-workspace'),
        getCurrentSavedProject: () => projects[0],
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
    assert.deepStrictEqual(published, ['open-workspace']);
    assert.deepStrictEqual(commands, [
        ['workbench.view.extension.project-steward'],
        ['project-steward.views.sidebar.focus'],
        ['project-steward.views.sidebar.focus'],
    ]);
    assert.deepStrictEqual(diagnostics.slice(-1), [{ event: 'full-refresh', reason: 'show-steward' }]);

    await controller.openSettings();
    assert.deepStrictEqual(commands[commands.length - 1], ['workbench.action.openSettings', '@ext:hzcheng.project-steward']);

    controller.postBatchArchiveCompletion({ type: 'ai-session-batch-archive-completed', projectId: 'p', provider: 'codex', status: 'finished' });
    controller.postActiveAiSessionTerminalChanged({ provider: 'codex', sessionId: 's1' });
    controller.postActiveAiSessionTerminalChanged(null);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(posted.map(message => message.type), [
        'ai-session-batch-archive-completed',
        'active-ai-session-terminal-changed',
        'active-ai-session-terminal-changed',
    ]);
    assert.deepStrictEqual(posted[1], { type: 'active-ai-session-terminal-changed', provider: 'codex', sessionId: 's1' });
    assert.deepStrictEqual(posted[2], { type: 'active-ai-session-terminal-changed', provider: null, sessionId: null });

    controller.applyProjectColorToCurrentWindow();
    controller.applyProjectColorToCurrentWindow({ id: 'save', showSaveAction: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(colorSyncs, [projects[0], { id: 'save', showSaveAction: true }]);

    controller.refreshAfterMutation();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(colorSyncs, [projects[0], { id: 'save', showSaveAction: true }, projects[0]]);
    assert.deepStrictEqual(diagnostics.slice(-1), [{ event: 'full-refresh', reason: 'project-mutation' }]);
    assert.deepStrictEqual(published, ['open-workspace', 'open-workspace']);

    const failingController = new DashboardRuntimeController({
        ...baseOptions,
        syncProjectColorToCurrentWindow: () => Promise.reject(new Error('color failed')),
        postMessage: () => Promise.reject(new Error('post failed')),
    });
    failingController.applyProjectColorToCurrentWindow(projects[0]);
    failingController.postBatchArchiveCompletion({ type: 'ai-session-batch-archive-completed', projectId: 'p', provider: 'codex', status: 'finished' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(errors.slice(-2).map(item => item[0]), [
        'Failed to apply project color to current window.',
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
    syncThrowController.postBatchArchiveCompletion({ type: 'ai-session-batch-archive-completed', projectId: 'p', provider: 'codex', status: 'finished' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(syncThrowErrors, [
        ['Failed to apply project color to current window.', 'color threw'],
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
    const migrationResult = (projectsMigrated, todosMigrated = false) => ({
        projects: { migrated: projectsMigrated },
        todos: { migrated: todosMigrated },
    });
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
        migrateDataIfNeeded: async () => migrationResult(migrated),
        refreshDashboard: () => undefined,
        publishOpenWorkspace: () => publications.push('published'),
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

    const startupOrdering = [];
    const orderedController = new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded: async () => {
            startupOrdering.push('project-migration');
            return migrationResult(true, false);
        },
        afterProjectMigrationSucceeded: async () => {
            startupOrdering.push('pending-workspace-save');
        },
        refreshDashboard: () => startupOrdering.push('refresh'),
        publishOpenWorkspace: () => startupOrdering.push('publish'),
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        logError: () => undefined,
        showSteward: () => undefined,
        applyProjectColorToCurrentWindow: () => startupOrdering.push('color'),
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'workspace',
        getVisibleEditorLanguageIds: () => [],
    });
    await orderedController.startUp();
    assert.deepStrictEqual(startupOrdering, [
        'project-migration', 'refresh', 'publish', 'pending-workspace-save', 'color',
    ], 'pending workspace save completion must run once after successful project migration');

    const failedProjectMigration = new Error('project migration failed');
    const failedProjectOrdering = [];
    const failedProjectController = new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded: async () => ({
            projects: { migrated: false, error: failedProjectMigration },
            todos: { migrated: false },
        }),
        afterProjectMigrationSucceeded: async () => {
            failedProjectOrdering.push('pending-workspace-save');
        },
        refreshDashboard: () => undefined,
        publishOpenWorkspace: () => undefined,
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        logError: () => undefined,
        showSteward: () => undefined,
        applyProjectColorToCurrentWindow: () => failedProjectOrdering.push('color'),
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'workspace',
        getVisibleEditorLanguageIds: () => [],
    });
    await failedProjectController.startUp();
    assert.deepStrictEqual(failedProjectOrdering, ['color'],
        'project migration failure must retain pending intent while allowing the remaining startup behavior');

    let deferredTodoData = { version: 1, groups: [], todos: [] };
    const deferredTodoService = new TodoService({
        globalState: {
            get: key => key === 'todos' ? deferredTodoData : undefined,
            update: async () => undefined,
        },
        configuration: makeWorkspaceConfiguration({}),
        useSettingsStorage: () => false,
    });
    const rebuiltCatalogs = [];
    let releaseRefresh;
    const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
    const provider = {
        refresh: async () => {
            rebuiltCatalogs.push(buildWorkspaceDashboardSearchCatalog([], [], deferredTodoService.getSearchItems()));
            await refreshGate;
        },
    };
    rebuiltCatalogs.push(buildWorkspaceDashboardSearchCatalog([], [], deferredTodoService.getSearchItems()));
    assert.deepStrictEqual(rebuiltCatalogs[0].todos, [],
        'the provider may render its initial search catalog before TODO migration settles');

    let resolveDeferredMigration;
    const deferredMigration = new Promise(resolve => { resolveDeferredMigration = resolve; });
    const deferredController = new DashboardStartupController({
        stewardInfos,
        relevantExtensions: {
            remoteSSH: 'ms-vscode-remote.remote-ssh',
            remoteContainers: 'ms-vscode-remote.remote-containers',
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded: () => deferredMigration,
        refreshDashboard: () => provider.refresh(),
        publishOpenWorkspace: () => undefined,
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        logError: () => undefined,
        showSteward: () => undefined,
        applyProjectColorToCurrentWindow: () => undefined,
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'workspace',
        getVisibleEditorLanguageIds: () => [],
    });
    let deferredCheckSettled = false;
    const deferredCheck = deferredController.checkDataMigration();
    deferredCheck.then(() => { deferredCheckSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(rebuiltCatalogs.length, 1,
        'a full catalog refresh must not overtake the in-flight migration');

    deferredTodoData = {
        version: 1,
        groups: [{ id: 'migrated-group', title: 'Migrated', collapsed: false, order: 0 }],
        todos: [{
            id: 'migrated-todo', groupId: 'migrated-group', title: 'Migrated TODO', notes: '',
            priority: 'medium', completed: false, createdAt: '2026-07-17T00:00:00.000Z',
            updatedAt: '2026-07-17T00:00:00.000Z', order: 0,
        }],
    };
    resolveDeferredMigration(migrationResult(false, true));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(rebuiltCatalogs.length, 2,
        'migration settle must trigger a full provider refresh');
    assert.deepStrictEqual(rebuiltCatalogs[1].todos.map(todo => todo.todoId), ['migrated-todo'],
        'migration settle must rebuild the provider search catalog with migrated TODO data');
    assert.strictEqual(deferredCheckSettled, false,
        'migration checking must await the full dashboard refresh publication');
    releaseRefresh();
    await deferredCheck;

    const migrationErrors = [];
    const migrationLogs = [];
    const retryPublications = [];
    const retryRefreshes = [];
    let rejectMigration;
    let migrationAttempts = 0;
    const rejectedMigration = new Promise((_resolve, reject) => { rejectMigration = reject; });
    const failureController = new DashboardStartupController({
        stewardInfos,
        relevantExtensions: {
            remoteSSH: 'ms-vscode-remote.remote-ssh',
            remoteContainers: 'ms-vscode-remote.remote-containers',
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded: () => {
            migrationAttempts += 1;
            return migrationAttempts === 1
                ? rejectedMigration
                : Promise.resolve(migrationResult(false, true));
        },
        refreshDashboard: () => retryRefreshes.push('refreshed'),
        publishOpenWorkspace: () => retryPublications.push('published'),
        showInformationMessage: () => undefined,
        showErrorMessage: message => migrationErrors.push(message),
        logError: (message, error) => migrationLogs.push([message, error]),
        showSteward: () => undefined,
        applyProjectColorToCurrentWindow: () => undefined,
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'workspace',
        getVisibleEditorLanguageIds: () => [],
    });
    const failedCheck = failureController.checkDataMigration();
    const startupMigrationFailure = new Error('TODO migration write failed');
    rejectMigration(startupMigrationFailure);
    await failedCheck;
    assert.strictEqual(migrationErrors.length, 1,
        'migration failure must be visible to the user');
    assert.ok(migrationErrors[0].includes('TODO migration write failed'));
    assert.deepStrictEqual(migrationLogs,
        [['Failed to migrate Project Steward data.', startupMigrationFailure]],
        'migration failure must be logged without escaping as an unhandled rejection');
    assert.deepStrictEqual(retryPublications, []);
    assert.deepStrictEqual(retryRefreshes, []);

    await failureController.checkDataMigration();
    assert.strictEqual(migrationAttempts, 2);
    assert.deepStrictEqual(retryRefreshes, ['refreshed'],
        'a successful migration retry must resend the full dashboard catalog');
    assert.deepStrictEqual(retryPublications, ['published'],
        'a successful retry must resume post-migration publication');
}

async function runDashboardLifecycleControllerChecks() {
    const events = [];
    const controller = new DashboardLifecycleController({
        checkDataMigration: async openStewardAfterMigrate => events.push(['migrate', openStewardAfterMigrate]),
        applyProjectColorToCurrentWindow: () => events.push(['color']),
        refresh: reason => events.push(['refresh', reason]),
        publishOpenWorkspace: followsFocusEvent => events.push(['publish', followsFocusEvent]),
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
            addFileToActiveTerminal: async () => calls.push('addFileToActiveTerminal'),
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
        'projectSteward.addFileToActiveTerminal',
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
        'addFileToActiveTerminal',
    ]);
}

async function runActiveTerminalFileReferenceChecks() {
    const sent = [];
    const warnings = [];
    let terminalShowCalls = 0;
    const terminal = {
        sendText: (text, addNewLine) => sent.push([text, addNewLine]),
        show: () => { terminalShowCalls += 1; },
    };
    const controller = new activeTerminalFileReference.ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => ({
            document: { uri: { scheme: 'file', fsPath: '/repo/src/dashboard.ts' } },
            selection: {
                isEmpty: false,
                start: { line: 9 },
                end: { line: 14 },
            },
        }),
        getActiveTerminal: () => terminal,
        asRelativePath: uri => uri.fsPath.replace('/repo/', ''),
        showWarningMessage: message => warnings.push(message),
    });

    assert.strictEqual(activeTerminalFileReference.formatFileReference('src/dashboard.ts', null), 'src/dashboard.ts');
    assert.strictEqual(activeTerminalFileReference.formatFileReference('src/dashboard.ts', { startLine: 10, endLine: 10 }), 'src/dashboard.ts:10');
    assert.strictEqual(activeTerminalFileReference.formatFileReference('src/dashboard.ts', { startLine: 10, endLine: 15 }), 'src/dashboard.ts:10-15');
    assert.deepStrictEqual(activeTerminalFileReference.getPrimarySelectionLineRange({
        isEmpty: false,
        start: { line: 14 },
        end: { line: 9 },
    }), { startLine: 10, endLine: 15 });

    await controller.addFileToActiveTerminal();
    assert.deepStrictEqual(sent, [['src/dashboard.ts:10-15', false]]);
    assert.strictEqual(terminalShowCalls, 1);
    assert.deepStrictEqual(warnings, []);

    const emptySelectionController = new activeTerminalFileReference.ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => ({
            document: { uri: { scheme: 'file', fsPath: '/repo/src/models.ts' } },
            selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
        }),
        getActiveTerminal: () => terminal,
        asRelativePath: uri => uri.fsPath.replace('/repo/', ''),
        showWarningMessage: message => warnings.push(message),
    });
    await emptySelectionController.addFileToActiveTerminal();
    assert.deepStrictEqual(sent[1], ['src/models.ts', false]);
    assert.strictEqual(terminalShowCalls, 2);

    const remoteFileController = new activeTerminalFileReference.ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => ({
            document: { uri: { scheme: 'vscode-remote', fsPath: '/repo/src/remote.ts', path: '/repo/src/remote.ts' } },
            selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
        }),
        getActiveTerminal: () => terminal,
        asRelativePath: uri => uri.path.replace('/repo/', ''),
        showWarningMessage: message => warnings.push(message),
    });
    await remoteFileController.addFileToActiveTerminal();
    assert.deepStrictEqual(sent[2], ['src/remote.ts', false]);
    assert.strictEqual(terminalShowCalls, 3);

    const missingTerminalController = new activeTerminalFileReference.ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => ({
            document: { uri: { scheme: 'file', fsPath: '/repo/src/models.ts' } },
            selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
        }),
        getActiveTerminal: () => null,
        asRelativePath: uri => uri.fsPath.replace('/repo/', ''),
        showWarningMessage: message => warnings.push(message),
    });
    await missingTerminalController.addFileToActiveTerminal();
    assert.ok(warnings.includes('No active terminal to receive the file reference.'));
    assert.strictEqual(sent.length, 3);
    assert.strictEqual(terminalShowCalls, 3);

    const untitledController = new activeTerminalFileReference.ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => ({
            document: { uri: { scheme: 'untitled', fsPath: '' } },
            selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
        }),
        getActiveTerminal: () => terminal,
        asRelativePath: uri => uri.fsPath,
        showWarningMessage: message => warnings.push(message),
    });
    await untitledController.addFileToActiveTerminal();
    assert.ok(warnings.includes('Open a saved file before adding it to the active terminal.'));
    assert.strictEqual(sent.length, 3);
    assert.strictEqual(terminalShowCalls, 3);
}

function createClassList(initialValues = []) {
    const values = new Set(initialValues);
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
    const todoButton = createElement('dashboard-tab-todo-button');
    todoButton.setAttribute('data-dashboard-tab', 'todo');
    const openPanel = createElement('dashboard-tab-open');
    const projectsPanel = createElement('dashboard-tab-projects');
    const todoPanel = createElement('dashboard-tab-todo');
    const searchResults = createSearchResultElement('div');
    const searchResultListeners = {};
    searchResults.id = 'dashboard-search-results';
    searchResults.hidden = false;
    searchResults.addEventListener = (type, listener) => { searchResultListeners[type] = listener; };
    searchResults.dispatch = (type, event = {}) => searchResultListeners[type] && searchResultListeners[type](event);
    const elements = {
        'dashboard-tab-open': openPanel,
        'dashboard-tab-projects': projectsPanel,
        'dashboard-tab-todo': todoPanel,
        'dashboard-search-results': searchResults,
    };
    const messages = [];
    const storage = new Map([['projectSteward.activeDashboardTab', 'open']]);
    const windowListeners = {};
    const context = {
        document: {
            body: { classList: createClassList() },
            createElement: createSearchResultElement,
            getElementById: id => elements[id] || null,
            querySelectorAll: selector => selector === '[data-dashboard-tab]'
                ? [openButton, projectsButton, todoButton]
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
    assert.strictEqual(context.normalizeDashboardTab('todo'), 'todo');
    assert.strictEqual(context.normalizeDashboardTab('invalid'), 'open');
    assert.strictEqual(context.getAdjacentDashboardTab('open', 'ArrowRight'), 'projects');
    assert.strictEqual(context.getAdjacentDashboardTab('projects', 'ArrowRight'), 'todo');
    assert.strictEqual(context.getAdjacentDashboardTab('todo', 'ArrowLeft'), 'projects');
    assert.strictEqual(context.getAdjacentDashboardTab('projects', 'ArrowLeft'), 'open');
    assert.strictEqual(context.validateProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 2, html: '<div></div>',
    }), true);
    assert.strictEqual(context.validateProjectsPanelMessage({
        type: 'projects-panel-content', version: 2, requestId: 2, html: '<div></div>',
    }), false);
    assert.strictEqual(context.validateTodoPanelMessage({
        type: 'todo-panel-content', version: 1, requestId: 2, html: '<div></div>',
    }), true);
    assert.strictEqual(context.validateTodoPanelMessage({
        type: 'todo-panel-content', version: 2, requestId: 2, html: '<div></div>',
    }), false);
    assert.strictEqual(context.globToDashboardRegex('dash*').test('dashboard'), true);
    assert.strictEqual(context.globToDashboardRegex('data?').test('data1'), true);
    const workspaceSections = context.filterDashboardCatalog(makeWorkspaceDashboardCatalog(), 'dashboard');
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(workspaceSections.map(section => section.title))),
        ['AI SESSIONS', 'OPEN WORKSPACES', 'SAVED PROJECTS']
    );
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(workspaceSections.map(section => section.id))),
        ['ai-sessions', 'open-workspaces', 'saved-projects']
    );
    const workspaceTodoSections = context.filterDashboardCatalog(makeWorkspaceDashboardCatalog(), 'ship');
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(workspaceTodoSections.map(section => section.title))),
        [],
        'v2 search must expose exactly AI SESSIONS, OPEN WORKSPACES, and SAVED PROJECTS'
    );
    assert.strictEqual(context.filterDashboardCatalog(makeWorkspaceDashboardCatalog(), 'missing').length, 0);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(context.normalizeDashboardSearchCatalog(null))),
        { version: 2, sessions: [], openWorkspaces: [], savedProjects: [], todos: [] }
    );
    assert.strictEqual(
        context.normalizeDashboardSearchCatalog(makeWorkspaceDashboardCatalog()).version,
        2
    );
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(context.normalizeDashboardSearchCatalog({
            ...makeDashboardCatalog(),
            openWorkspaces: null,
        }))),
        { version: 2, sessions: [], openWorkspaces: [], savedProjects: [], todos: [] },
        'a malformed v2 catalog must fail closed'
    );
    const state = {
        activeTab: 'projects',
        searchQuery: 'dash',
        scrollPositions: { open: 12, projects: 34, todo: 56 },
        catalog: makeDashboardCatalog(),
    };
    const nextState = context.replaceDashboardSearchCatalogState(state, makeUpdatedDashboardCatalog());
    assert.strictEqual(nextState.activeTab, 'projects');
    assert.strictEqual(nextState.searchQuery, 'dash');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(nextState.scrollPositions)), { open: 12, projects: 34, todo: 56 });
    assert.notStrictEqual(nextState.catalog, state.catalog);

    let mounted = 0;
    let todoMounted = 0;
    const controller = context.initDashboard({
        postMessage: message => messages.push(message),
        onProjectsMounted: panel => {
            assert.strictEqual(panel, projectsPanel);
            mounted += 1;
        },
        onTodoMounted: panel => {
            assert.strictEqual(panel, todoPanel);
            todoMounted += 1;
        },
    });
    assert.strictEqual(controller.getActiveTab(), 'open');
    assert.strictEqual(openPanel.hidden, false);
    assert.strictEqual(projectsPanel.hidden, true);
    assert.strictEqual(todoPanel.hidden, true);
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
    context.window.scrollY = 41;
    controller.activateTab('todo');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.slice(1))), [
        { type: 'request-todo-panel', version: 1, requestId: 1 },
    ]);
    assert.strictEqual(controller.getTodoState(), 'loading');
    assert.strictEqual(controller.applyTodoPanelMessage({
        type: 'todo-panel-content', version: 1, requestId: 1, html: '<div>todo</div>',
    }), true);
    assert.strictEqual(todoPanel.innerHTML, '<div>todo</div>');
    assert.strictEqual(controller.getTodoState(), 'mounted');
    assert.strictEqual(todoMounted, 1);
    assert.strictEqual(typeof windowListeners.message, 'function');

    let showCompletedFocusCalls = 0;
    const oldShowCompletedToggle = {
        getAttribute: name => name === 'data-action' ? 'todo-toggle-show-completed' : null,
    };
    const newShowCompletedToggle = {
        focus: () => {
            showCompletedFocusCalls += 1;
            context.document.activeElement = newShowCompletedToggle;
        },
    };
    todoPanel.contains = element => element === oldShowCompletedToggle;
    todoPanel.querySelector = selector => selector === '[data-action="todo-toggle-show-completed"]'
        ? newShowCompletedToggle
        : null;
    context.document.activeElement = oldShowCompletedToggle;
    assert.strictEqual(controller.applyTodoPanelUpdatedMessage({
        type: 'todo-panel-updated',
        version: 1,
        html: '<div>show completed updated</div>',
        searchCatalog: makeDashboardCatalog(),
    }), true);
    assert.strictEqual(showCompletedFocusCalls, 1,
        'replacing TODO HTML must restore focus to the Show Completed control');
    assert.strictEqual(context.document.activeElement, newShowCompletedToggle);

    let todoItemMounted = false;
    let todoFocusCalls = 0;
    let todoScrollCalls = 0;
    const pendingTodoFrames = [];
    context.requestAnimationFrame = callback => pendingTodoFrames.push(callback);
    const todoGroup = {
        classList: createClassList(),
        querySelector: selector => selector === '[data-action="todo-collapse-group"]'
            ? { setAttribute: () => undefined }
            : null,
    };
    const todoItem = {
        isConnected: true,
        getAttribute: name => name === 'data-todo-id' ? 't1' : null,
        setAttribute: () => undefined,
        removeAttribute: () => undefined,
        closest: selector => selector === '.todo-group' ? todoGroup : null,
        focus: () => {
            todoFocusCalls += 1;
            context.document.activeElement = todoItem;
        },
        scrollIntoView: () => { todoScrollCalls += 1; },
        addEventListener: () => undefined,
    };
    todoPanel.querySelectorAll = selector => selector === '.todo-item[data-todo-id]' && todoItemMounted
        ? [todoItem]
        : [];
    const todoSearchResult = {
        dataset: {
            searchAction: 'show-todo',
            todoId: 't1',
            groupId: 'todo-group-a',
        },
    };
    todoSearchResult.closest = selector => selector === '.dashboard-search-result[data-search-action]'
        ? todoSearchResult
        : null;
    const messageCountBeforeReveal = messages.length;
    searchResults.dispatch('click', { target: todoSearchResult });
    assert.strictEqual(messages.length, messageCountBeforeReveal,
        'pending TODO targets must wait for requestAnimationFrame before querying the DOM');
    assert.strictEqual(pendingTodoFrames.length, 2,
        'tab scroll restoration and pending TODO resolution should each use their own frame');
    while (pendingTodoFrames.length) pendingTodoFrames.shift()();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.slice(messageCountBeforeReveal))), [{
        type: 'todo-reveal',
        todoId: 't1',
        groupId: 'todo-group-a',
    }], 'a hidden TODO search target must be revealed by the host');
    assert.strictEqual(todoFocusCalls, 0, 'a pending target must wait for mounted TODO HTML');
    todoItemMounted = true;
    assert.strictEqual(controller.applyTodoPanelUpdatedMessage({
        type: 'todo-panel-updated',
        version: 1,
        html: '<div>revealed todo</div>',
        searchCatalog: makeDashboardCatalog(),
    }), true);
    assert.strictEqual(todoMounted, 3, 'updated TODO HTML must invoke onTodoMounted');
    assert.strictEqual(pendingTodoFrames.length, 1);
    todoItemMounted = false;
    pendingTodoFrames.shift()();
    assert.strictEqual(todoFocusCalls, 0,
        'a DOM replacement before the frame must not focus the detached search target');
    todoItemMounted = true;
    assert.strictEqual(controller.applyTodoPanelUpdatedMessage({
        type: 'todo-panel-updated',
        version: 1,
        html: '<div>revealed todo after mutation</div>',
        searchCatalog: makeDashboardCatalog(),
    }), true);
    assert.strictEqual(pendingTodoFrames.length, 1,
        'a later TODO mount must retry a pending target lost to DOM replacement');
    pendingTodoFrames.shift()();
    assert.strictEqual(todoFocusCalls, 1, 'the mounted pending TODO target must receive focus');
    assert.strictEqual(todoScrollCalls, 1, 'the mounted pending TODO target must scroll into view');
    assert.strictEqual(context.document.activeElement, todoItem);
    assert.strictEqual(controller.applyTodoPanelUpdatedMessage({
        type: 'todo-panel-updated',
        version: 1,
        html: '<div>post-focus mutation</div>',
        searchCatalog: makeDashboardCatalog(),
    }), true);
    assert.strictEqual(pendingTodoFrames.length, 0,
        'a successfully focused TODO target must clear pending state exactly once');

    storage.set('projectSteward.activeDashboardTab', 'projects');
    const searchMessages = [];
    const workspaceRevealCalls = [];
    context.window.__projectStewardRevealWorkspaceSession = (...args) => workspaceRevealCalls.push(args);
    const workspaceSearchController = context.initDashboard({
        initialSearchQuery: 'dashboard',
        clearSearch: () => undefined,
        postMessage: message => searchMessages.push(message),
    });
    workspaceSearchController.replaceSearchCatalog(makeWorkspaceDashboardCatalog());
    const workspaceSessionSection = searchResults.children.find(section => section.dataset.sectionType === 'session');
    const workspaceSessionResult = workspaceSessionSection.children[1];
    assert.strictEqual(workspaceSessionResult.dataset.searchAction, 'reveal-workspace-session');
    assert.strictEqual(workspaceSessionResult.dataset.workspaceNavigationIdentity, 'navigation-current');
    workspaceSessionResult.closest = selector => selector === '.dashboard-search-result[data-search-action]'
        ? workspaceSessionResult
        : null;
    searchResults.dispatch('click', { target: workspaceSessionResult });
    assert.deepStrictEqual(workspaceRevealCalls, [[
        'navigation-current', 'codex', 'c1',
    ]], 'workspace session search must reveal its workspace row instead of resuming a root-owned session');
    assert.deepStrictEqual(searchMessages, [], 'workspace session reveal must not post a resume action');

}

function runTodoEditResetInteractionChecks() {
    const projectSource = fs.readFileSync(projectScriptPath, 'utf8');
    const setTodoEditingBody = extractFunctionBody(projectSource, 'setTodoEditing');
    const title = { value: 'Initial title', defaultValue: 'Initial title' };
    const notes = { value: 'Initial notes', defaultValue: 'Initial notes' };
    const priorities = ['high', 'medium', 'low'].map(value => ({
        value,
        checked: value === 'medium',
        defaultChecked: value === 'medium',
    }));
    const choices = priorities.map(input => ({
        classList: createClassList(input.checked ? ['active'] : []),
        querySelector: selector => selector === 'input[name="priority"]' ? input : null,
    }));
    const segment = {
        querySelectorAll: selector => selector === '.todo-priority-choice' ? choices : [],
    };
    const form = {
        hidden: false,
        reset() {
            title.value = title.defaultValue;
            notes.value = notes.defaultValue;
            priorities.forEach(input => { input.checked = input.defaultChecked; });
        },
        querySelector(selector) {
            if (selector === '[name="title"]') return title;
            if (selector === '[name="notes"]') return notes;
            if (selector === '.todo-priority-segment') return segment;
            return null;
        },
    };
    const view = { hidden: false };
    const list = {
        classList: createClassList(['has-editing-item']),
        querySelector: () => null,
    };
    const item = {
        classList: createClassList(['editing', 'expanded']),
        attributes: new Map([['data-expanded-before-edit', 'false']]),
        getAttribute(name) {
            if (name === 'data-todo-id') return 'todo-a';
            return this.attributes.get(name) || null;
        },
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        removeAttribute(name) { this.attributes.delete(name); },
        querySelector(selector) {
            if (selector === '.todo-item-view') return view;
            if (selector === '.todo-edit-form') return form;
            return null;
        },
        closest: selector => selector === '.todo-list' ? list : null,
        scrollIntoView: () => undefined,
    };
    const document = {
        querySelectorAll: selector => selector === '.todo-item[data-todo-id]' ? [item] : [],
    };
    const syncTodoPrioritySegment = currentSegment => {
        currentSegment.querySelectorAll('.todo-priority-choice').forEach(choice => {
            const input = choice.querySelector('input[name="priority"]');
            choice.classList.toggle('active', input.checked === true);
        });
    };
    const toggleTodoItemExpanded = (_item, expanded) => {
        item.classList.toggle('expanded', expanded);
    };
    const resetTodoEditForm = currentForm => {
        currentForm.reset();
        syncTodoPrioritySegment(currentForm.querySelector('.todo-priority-segment'));
    };
    const setTodoEditing = new Function(
        'document',
        'toggleTodoItemExpanded',
        'syncTodoPrioritySegment',
        'resetTodoEditForm',
        'todoId',
        'editing',
        setTodoEditingBody
    );

    title.value = 'Draft title';
    notes.value = 'Draft notes';
    priorities[1].checked = false;
    priorities[2].checked = true;
    syncTodoPrioritySegment(segment);
    setTodoEditing(document, toggleTodoItemExpanded, syncTodoPrioritySegment, resetTodoEditForm, 'todo-a', false);

    assert.strictEqual(title.value, 'Initial title', 'canceling edit must restore the rendered title value');
    assert.strictEqual(notes.value, 'Initial notes', 'canceling edit must restore the rendered notes value');
    assert.deepStrictEqual(priorities.map(input => input.checked), [false, true, false],
        'canceling edit must restore the rendered priority radio state');
    assert.deepStrictEqual(choices.map(choice => choice.classList.contains('active')), [false, true, false],
        'canceling edit must resynchronize the active priority segment');
    assert.strictEqual(item.classList.contains('editing'), false);
    assert.strictEqual(item.classList.contains('expanded'), false,
        'canceling edit must restore the pre-edit collapsed state');
    assert.strictEqual(item.getAttribute('data-expanded-before-edit'), null);
}

function createTodoComposeFormState() {
    const attributes = new Map();
    const controls = {
        title: { value: 'Draft todo' },
        notes: { value: 'Draft notes' },
        priority: { value: 'high', checked: true },
        groupId: { value: 'group-a' },
    };
    const submitAttributes = new Map();
    const submitButton = {
        disabled: false,
        getAttribute: name => submitAttributes.has(name) ? submitAttributes.get(name) : null,
        setAttribute: (name, value) => submitAttributes.set(name, String(value)),
        removeAttribute: name => submitAttributes.delete(name),
    };
    const form = {
        controls,
        submitButton,
        reset() {
            controls.title.value = '';
            controls.notes.value = '';
        },
        getAttribute: name => attributes.has(name) ? attributes.get(name) : null,
        setAttribute: (name, value) => attributes.set(name, String(value)),
        removeAttribute: name => attributes.delete(name),
        querySelector(selector) {
            if (selector === '[type="submit"]') return submitButton;
            const checked = selector.match(/^\[name="([^"]+)"\]:checked$/);
            if (checked) {
                const control = controls[checked[1]];
                return control && control.checked ? control : null;
            }
            const named = selector.match(/^\[name="([^"]+)"\]$/);
            return named ? controls[named[1]] || null : null;
        },
    };
    return form;
}

function runTodoComposePendingInteractionChecks() {
    const projectSource = fs.readFileSync(projectScriptPath, 'utf8');
    const context = {};
    vm.runInNewContext(projectSource, context);
    const onTodoFormSubmit = new Function(
        'submitTodoComposeForm',
        'getTodoFormValue',
        'window',
        'e',
        extractFunctionBody(projectSource, 'onTodoFormSubmit')
    );
    const onWindowMessage = new Function(
        'applyTodoMutationResult',
        'document',
        'e',
        extractFunctionBody(projectSource, 'onWindowMessage')
    );
    const messages = [];
    const form = createTodoComposeFormState();
    const window = { vscode: { postMessage: message => messages.push(message) } };
    const submitEvent = {
        preventDefault: () => undefined,
        target: {
            closest: selector => selector === '.todo-add-form' ? form : null,
        },
    };

    onTodoFormSubmit(context.submitTodoComposeForm, context.getTodoFormValue, window, submitEvent);
    onTodoFormSubmit(context.submitTodoComposeForm, context.getTodoFormValue, window, submitEvent);
    assert.strictEqual(messages.length, 1, 'rapid submits on one compose form must post exactly one mutation');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages[0])), {
        type: 'todo-add',
        requestId: 1,
        title: 'Draft todo',
        notes: 'Draft notes',
        priority: 'high',
        groupId: 'group-a',
    });
    assert.strictEqual(form.submitButton.disabled, true);
    assert.strictEqual(form.submitButton.getAttribute('aria-busy'), 'true');

    const document = {
        querySelector: selector => selector === '.todo-add-form[data-todo-request-id="1"]' ? form : null,
    };
    onWindowMessage(context.applyTodoMutationResult, document, { data: {
        type: 'todo-mutation-result', version: 1, requestId: 1, success: false,
    } });
    assert.strictEqual(form.submitButton.disabled, false, 'a failed mutation ack must unlock compose');
    assert.strictEqual(form.submitButton.getAttribute('aria-busy'), null);
    assert.strictEqual(form.controls.title.value, 'Draft todo');
    assert.strictEqual(form.controls.notes.value, 'Draft notes');

    const refreshFailedForm = createTodoComposeFormState();
    const refreshFailedEvent = {
        preventDefault: () => undefined,
        target: {
            closest: selector => selector === '.todo-add-form' ? refreshFailedForm : null,
        },
    };
    onTodoFormSubmit(context.submitTodoComposeForm, context.getTodoFormValue, window, refreshFailedEvent);
    const refreshFailedRequestId = messages[1].requestId;
    const refreshFailedDocument = {
        querySelector: selector => selector === `.todo-add-form[data-todo-request-id="${refreshFailedRequestId}"]`
            ? refreshFailedForm
            : null,
    };
    onWindowMessage(context.applyTodoMutationResult, refreshFailedDocument, { data: {
        type: 'todo-mutation-result',
        version: 1,
        requestId: refreshFailedRequestId,
        success: true,
        panelRefreshed: false,
    } });
    assert.strictEqual(refreshFailedForm.submitButton.disabled, false,
        'a committed write with a failed refresh must settle the compose form');
    assert.strictEqual(refreshFailedForm.submitButton.getAttribute('aria-busy'), null);
    assert.strictEqual(refreshFailedForm.controls.title.value, '',
        'a committed write must clear its title so retrying cannot create a duplicate');
    assert.strictEqual(refreshFailedForm.controls.notes.value, '');

    const successForm = createTodoComposeFormState();
    const successSubmitEvent = {
        preventDefault: () => undefined,
        target: {
            closest: selector => selector === '.todo-add-form' ? successForm : null,
        },
    };
    onTodoFormSubmit(context.submitTodoComposeForm, context.getTodoFormValue, window, successSubmitEvent);
    const successRequestId = messages[2].requestId;
    const successDocument = {
        querySelector: selector => selector === `.todo-add-form[data-todo-request-id="${successRequestId}"]`
            ? successForm
            : null,
    };
    onWindowMessage(context.applyTodoMutationResult, successDocument, { data: {
        type: 'todo-mutation-result', version: 1, requestId: successRequestId, success: true,
    } });
    assert.strictEqual(successForm.submitButton.disabled, true,
        'a success ack arriving before panel replacement must keep compose locked');
    assert.strictEqual(successForm.submitButton.getAttribute('aria-busy'), 'true');
}

function runSourceContractChecks(source) {
    const projectSource = fs.readFileSync(projectScriptPath, 'utf8');
    const dndSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDnDScripts.js'), 'utf8');
    const filterSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewFilterScripts.js'), 'utf8');
    const extensionHostSource = fs.readFileSync(extensionHostPath, 'utf8');
    assert.strictEqual(extensionHostSource.includes('buildTodoSearchItems(todoService.getData())'), false,
        'initial and incremental Dashboard catalogs must not parse unsupported TODO data directly');
    assert.ok(extensionHostSource.includes('todoService.getSearchItems()'),
        'Dashboard catalog call sites must use the future-version-safe TODO catalog');
    const todoPanelBody = extractFunctionBody(extensionHostSource, 'postTodoPanelContent');
    assert.ok(todoPanelBody.includes('UnsupportedTodoDataVersionError'));
    assert.ok(todoPanelBody.includes('getUnsupportedTodoVersionPanelContent'));
    assert.ok(todoPanelBody.includes('todoService.getUnsupportedVersionError()'),
        'TODO panel rendering must live-probe both backends instead of caching unsupported errors');
    assert.strictEqual(todoPanelBody.includes('todoStorageMigration.error'), false,
        'a corrected future-version value must not leave a stale cached TODO panel error');
    const webviewContentSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewContent.ts'), 'utf8');
    const stylesPath = path.join(root, 'media', 'styles.scss');
    const generatedStylesPath = path.join(root, 'media', 'styles.css');
    const styles = fs.readFileSync(stylesPath, 'utf8');
    assert.strictEqual(styles.includes('.workspace-root-tags'), false);
    assert.strictEqual(styles.includes('.workspace-root-tag'), false);
    assert.ok(styles.includes('@media (max-width: 280px)'));
    assert.ok(styles.includes('min-width: 0'));
    assert.ok(styles.includes('text-overflow: ellipsis'));
    assert.ok(styles.includes('overflow-x: hidden'));
    const compiledStyles = compileDashboardStyles(styles);
    const generatedStyles = fs.readFileSync(generatedStylesPath, 'utf8');
    const minifiedCompiledStyles = new CleanCSS({ rebaseTo: path.dirname(generatedStylesPath) }).minify({
        [generatedStylesPath]: { styles: compiledStyles },
    });
    assert.deepStrictEqual(minifiedCompiledStyles.errors, [], 'compiled dashboard styles must minify without errors');
    assert.deepStrictEqual(minifiedCompiledStyles.warnings, [], 'compiled dashboard styles must minify without warnings');
    assert.strictEqual(
        minifiedCompiledStyles.styles,
        generatedStyles,
        'generated media/styles.css must match compiled and minified media/styles.scss'
    );
    const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const updateMessagePath = path.join(root, 'src', 'dashboard', 'webviewUpdateMessages.ts');
    assert.ok(fs.existsSync(updateMessagePath));
    const updateMessages = fs.readFileSync(updateMessagePath, 'utf8');
    assert.ok(updateMessages.includes('export function buildOpenWorkspacesUpdatedMessage('));
    assert.ok(!updateMessages.includes('export function buildOpenProjectsUpdatedMessage('));
    assert.ok(updateMessages.includes('export function buildAiSessionsUpdatedMessage('));
    assert.ok(updateMessages.includes("type: 'open-workspaces-updated'"));
    assert.ok(!updateMessages.includes("type: 'open-projects-updated'"));
    assert.ok(updateMessages.includes("type: 'ai-sessions-updated'"));
    assert.ok(updateMessages.includes('version: 2'));
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
    assert.ok(routerSource.includes('createAiSession?: DashboardAiSessionCreateMessageHandler'));
    assert.ok(routerSource.includes('resumeAiSession?: DashboardAiSessionLaunchMessageHandler'));
    assert.ok(routerSource.includes('archiveAiSession?: DashboardAiSessionMessageHandler'));
    assert.ok(routerSource.includes('export function createDashboardMessageRouter('));
    assert.strictEqual(routerSource.includes('handleRawMessage'), false);

    assert.ok(source.includes("projectSteward.activeDashboardTab"));
    assert.ok(webviewContentSource.includes('class="group steward-section'));
    assert.ok(webviewContentSource.includes('class="group-title steward-section-header steward-group-header"'));
    assert.ok(webviewContentSource.includes('class="project steward-item-card"'));
    assert.ok(webviewContentSource.includes('class="project-border steward-item-accent"'));
    assert.ok(webviewContentSource.includes('onTodoMounted: () =>'));
    assert.ok(webviewContentSource.includes("window.__projectStewardSyncCollapseButton('todo')"));
    assert.ok(source.includes("setAttribute('aria-selected'"));
    assert.ok(source.includes("setAttribute('tabindex'"));
    assert.ok(source.includes('scrollPositions'));
    assert.ok(source.includes('acceptedProjectsRequestId'));
    assert.ok(source.includes('pendingScrollRestoreTab'));
    assert.ok(extensionHostSource.includes("'request-projects-panel': async e =>"));
    assert.ok(extensionHostSource.includes("'request-todo-panel': async e =>"));
    assert.ok(packageJson.includes('"projectSteward.maxVisibleTodosPerGroup"'));
    assert.ok(packageJson.includes('"projectSteward.maxVisibleProjectsPerGroup"'));
    assert.strictEqual(extensionHostSource.includes('function handleStewardMessage('), false);
    assert.ok(extensionHostSource.includes('getAiSessionProviderIds: () => getRegisteredAiSessionProviders().map(provider => provider.id)'));
    assert.ok(extensionHostSource.includes("type: 'projects-panel-content'"));
    assert.ok(extensionHostSource.includes("type: 'todo-panel-content'"));
    assert.ok(extensionHostSource.includes('getProjectsPanelContent(projectService.getGroups(), stewardInfos)'));
    assert.ok(extensionHostSource.includes('getTodoPanelContent(buildTodoViewModel(todoData'));
    assert.ok(extensionHostSource.includes('getMaxVisibleTodosPerGroup(config)'));
    assert.ok(webviewContentSource.includes("'maxVisibleProjectsPerGroup',"));
    assert.ok(webviewContentSource.includes('DEFAULT_MAX_VISIBLE_PROJECTS_PER_GROUP = 5'));
    assert.ok(webviewContentSource.includes('--steward-max-visible-projects-per-group: ${maxVisibleProjectsPerGroup};'));
    const projectGroupListRule = extractCssRule(
        compiledStyles,
        'body.steward-sidebar #dashboard-tab-projects .group-list'
    );
    assert.ok(projectGroupListRule.includes('max-height: calc(var(--steward-max-visible-projects-per-group, 5) * 65px)'));
    assert.ok(projectGroupListRule.includes('overflow-y: auto'));
    assert.ok(projectSource.includes("e.target.closest('[data-action=\"add-project\"]')"));
    assert.ok(projectSource.includes("e.target.closest('[data-action=\"import-from-other-storage\"]')"));
    assert.ok(projectSource.includes("e.target.closest('[data-action=\"todo-add\"]')"));
    assert.ok(projectSource.includes("type: 'todo-add'"));
    assert.ok(projectSource.includes("type: 'todo-toggle'"));
    assert.ok(projectSource.includes("type: 'todo-delete'"));
    assert.ok(projectSource.includes("type: 'todo-delete-group'"));
    assert.ok(projectSource.includes("type: 'todo-collapse-group'"));
    assert.ok(projectSource.includes("type: 'todo-rename-group'"));
    assert.ok(projectSource.includes("type: 'todo-collapse-groups'"));
    assert.ok(projectSource.includes("type: 'todo-sort-priority'"));
    assert.ok(projectSource.includes("type: 'todo-toggle-show-completed'"));
    assert.ok(projectSource.includes("type: 'todo-update'"));
    assert.ok(projectSource.includes('function syncTodoPrioritySegment('));
    assert.ok(extractFunctionBody(projectSource, 'onChangeEvent').includes('syncTodoPrioritySegment('));
    assert.ok(projectSource.includes('function onTodoFormSubmit('));
    const todoActionBody = extractFunctionBody(projectSource, 'onTodoAction');
    const todoFormSubmitBody = extractFunctionBody(projectSource, 'onTodoFormSubmit');
    const todoComposeSubmitBody = extractFunctionBody(projectSource, 'submitTodoComposeForm');
    assert.ok(todoActionBody.includes('data-action="todo-cancel-add"'));
    assert.ok(todoActionBody.includes('setTodoAddFormVisible('));
    assert.ok(todoActionBody.includes('syncTodoGroupCollapseControl(todoGroup);'),
        'single-group collapse must synchronize class and accessible button state together');
    assert.ok(todoFormSubmitBody.includes('submitTodoComposeForm(addForm'));
    assert.ok(todoComposeSubmitBody.includes("type: 'todo-add'"));
    assert.ok(todoComposeSubmitBody.includes("groupId: getTodoFormValue(form, 'groupId')"));
    assert.ok(todoComposeSubmitBody.includes('requestId'));
    assert.strictEqual(todoComposeSubmitBody.includes('form.reset()'), false,
        'TODO add submissions must retain form values until the host refresh succeeds');
    assert.strictEqual(projectSource.includes(".querySelectorAll('[data-action=\"add-project\"]')"), false);
    assert.strictEqual(projectSource.includes(".querySelectorAll('[data-action=\"import-from-other-storage\"]')"), false);
    assert.ok(extensionHostSource.includes("'todo-add': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-toggle': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-delete': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-delete-group': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-collapse-group': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-rename-group': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-reorder-groups': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-reorder-items': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-collapse-groups': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-sort-priority': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-toggle-show-completed': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-reveal': async e =>"));
    const todoShowCompletedHandler = extensionHostSource.slice(
        extensionHostSource.indexOf("'todo-toggle-show-completed': async e =>"),
        extensionHostSource.indexOf("'todo-reveal': async e =>")
    );
    const todoRevealHandler = extensionHostSource.slice(
        extensionHostSource.indexOf("'todo-reveal': async e =>"),
        extensionHostSource.indexOf("'todo-update': async e =>")
    );
    assert.ok(todoRevealHandler.includes('await todoService.revealTodo('),
        'host reveal must delegate parsing and the optional group write to one TodoService queue operation');
    assert.strictEqual(todoRevealHandler.includes('todoService.getData()'), false,
        'host reveal must not parse stale TODO/group state outside the service queue');
    assert.strictEqual(todoRevealHandler.includes('todoService.setShowCompleted('), false);
    assert.strictEqual(todoRevealHandler.includes('todoService.setGroupCollapsed('), false);
    assert.ok(todoRevealHandler.indexOf('await todoService.revealTodo(')
        < todoRevealHandler.indexOf('revealedTodoId = e.todoId as string;'),
    'host must set the temporary target only after the queued reveal operation succeeds');
    assert.ok(todoShowCompletedHandler.indexOf('await todoService.setShowCompleted(')
        < todoShowCompletedHandler.indexOf('revealedTodoId = undefined;'),
    'an explicit completed toggle must clear the temporary target only after persistence succeeds');
    assert.strictEqual((extensionHostSource.match(/revealedTodoId = undefined;/g) || []).length, 1,
        'the temporary target must persist until an explicit toggle or a later reveal replaces it');
    assert.ok(extensionHostSource.includes('buildTodoViewModel(todoData, todoViewState, revealedTodoId)'),
        'all TODO panel refreshes must project the temporary reveal target');
    assert.ok(extensionHostSource.includes("'todo-update': async e =>"));
    assert.ok(extensionHostSource.includes('async function postTodoPanelContent('));
    assert.ok(extensionHostSource.includes("from './todos/hostMutation'"));
    assert.ok(extensionHostSource.includes('const todoViewState = todoService.getViewState();'));
    assert.ok(extensionHostSource.includes(
        'const projectMigration = settleMigration(() => projectService.migrateDataIfNeeded())'));
    assert.ok(extensionHostSource.includes(
        'const todoMigration = settleMigration(() => todoService.migrateDataIfNeeded())'));
    assert.strictEqual(
        (extensionHostSource.match(/await runTodoPanelMutation\(/g) || []).length,
        10,
        'every non-prompt direct TODO mutation handler must use the write-error boundary'
    );
    assert.ok(extensionHostSource.includes('await runTodoRequestMutation({'),
        'compose mutations must use the request-correlated write-error boundary');
    assert.ok(extensionHostSource.includes('await runTodoPromptMutation({'),
        'add-group mutations must use the retrying prompt error boundary');
    assert.ok(extensionHostSource.includes('await renameTodoGroupWithPrompt({'),
        'rename-group mutations must check group existence before entering the retrying prompt boundary');
    assert.ok(dndSource.includes('function initDnD(root)'));
    assert.ok(dndSource.includes('function disposeDnD(root)'));
    assert.ok(dndSource.includes('root.__projectStewardDnDInitialized'));
    assert.ok(dndSource.includes('const todoGroupsContainerSelector = ".todo-groups"'));
    assert.ok(dndSource.includes('const todoItemsContainerSelector = ".todo-list"'));
    assert.ok(dndSource.includes("type: 'todo-reorder-groups'"));
    assert.ok(dndSource.includes("type: 'todo-reorder-items'"));
    assert.strictEqual((dndSource.match(/type: 'todo-reorder-groups'/g) || []).length, 1,
        'a TODO group drop must have one reorder message send point');
    assert.strictEqual((dndSource.match(/type: 'todo-reorder-items'/g) || []).length, 1,
        'a TODO item drop must have one reorder message send point');
    assert.strictEqual(dndSource.includes('document.querySelectorAll(`${groupsContainerSelector}'), false);
    assert.ok(projectSource.includes("'collapse-group'"));
    const onWindowMessageBody = extractFunctionBody(projectSource, 'onWindowMessage');
    assert.ok(onWindowMessageBody.includes('applyTodoMutationResult(message, document);'));
    assert.ok(onWindowMessageBody.includes('disposeDnD(todoRoot);'));
    assert.ok(onWindowMessageBody.includes('initDnD(todoRoot);'));
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
    assert.strictEqual(projectContext.getCollapseButtonState('todo', [false, true]).title, 'Collapse TODO Groups');
    assert.strictEqual(projectContext.getCollapseButtonState('todo', [true, true]).title, 'Expand TODO Groups');

    const renderSearchBody = extractFunctionBody(source, 'renderDashboardSearchResults');
    assert.ok(renderSearchBody.includes('textContent'));
    assert.ok(renderSearchBody.includes("createElement('button')"));
    assert.strictEqual(renderSearchBody.includes('innerHTML'), false);
    assert.strictEqual(renderSearchBody.includes('project-ai-attention-badge'), false);
    assert.strictEqual(renderSearchBody.includes('data-current-workspace'), false);
    assert.strictEqual(renderSearchBody.includes('dashboard-search-result-notes'), false);
    assert.ok(filterSource.includes('ctrlKey'));
    assert.ok(filterSource.includes('metaKey'));
    assert.ok(filterSource.includes('Escape'));
    assert.ok(source.includes('initialSearchQuery'));
    assert.ok(source.includes('replaceSearchCatalog'));
    assert.ok(source.includes('isSearchActive'));
    assert.strictEqual(source.includes("title: 'TODO RESULTS'"), false);
    assert.ok(source.includes("title: 'OPEN WORKSPACES'"));
    assert.ok(projectSource.includes('__projectStewardAcknowledgeSession'));
    assert.strictEqual(projectSource.includes('__projectStewardShowCurrentProject'), false);
    assert.ok(projectSource.includes('__projectStewardRevealWorkspaceSession'));
    const refreshStewardViewsBody = extractFunctionBody(extensionHostSource, 'refreshStewardViews');
    const aiSessionsMessageBody = extractFunctionBody(extensionHostSource, 'getAiSessionsUpdatedMessage');
    const openWorkspacesMessageBody = extractFunctionBody(extensionHostSource, 'postOpenWorkspacesUpdated');
    const openWorkspaceControllerSource = fs.readFileSync(path.join(root, 'src', 'openWorkspaces', 'dashboardController.ts'), 'utf8');
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
    assert.ok(!extensionHostSource.includes('context.globalState.update(OPEN_WORKSPACES_GROUP_COLLAPSED_KEY'));
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
    assert.ok(openWorkspacesMessageBody.includes('openWorkspaceDashboardController.postUpdated()'));
    assert.ok(openWorkspaceControllerSource.includes('buildOpenWorkspacesUpdatedMessage({'));
    assert.ok(openWorkspaceControllerSource.includes('groups: this.options.getGroups()'));
    assert.ok(openWorkspaceControllerSource.includes('cards: this.getCards()'));
    assert.ok(openWorkspaceControllerSource.includes('semanticRevision,'));
    assert.ok(openWorkspaceControllerSource.includes('otherWindowsStatus: this.bridgeStatus'));
    assert.ok(openWorkspaceControllerSource.includes('getViewSemanticRevision()'));
    assert.ok(aiSessionsMessageBody.includes('aiSessionDashboardController.getUpdatedMessage()'));
    assert.ok(aiSessionControllerSource.includes('buildAiSessionsUpdatedMessage({'));
    assert.ok(aiSessionControllerSource.includes('groups: this.options.getGroups()'));
    assert.ok(aiSessionControllerSource.includes('cards'));
    assert.ok(aiSessionControllerSource.includes('sequence: this.options.nextSequence()'));
    assert.ok(projectSource.includes('replaceSearchCatalog(message.searchCatalog)'));
    assert.ok(projectSource.includes("type: 'open-bridge-extension'"));
    assert.ok(extensionHostSource.includes("'workbench.extensions.action.showExtensionsWithIds'"));
    assert.ok(extensionHostSource.includes("'hzcheng.project-steward-attention-ui-bridge'"));
    assert.strictEqual(projectSource.includes("sessionStorage.setItem('projectSteward.activeDashboardTab', 'open')"), false);
    for (const selector of [
        '.steward-section', '.steward-section-header', '.steward-card',
        '.steward-icon-button', '.steward-badge', '.steward-meta',
        '.steward-item-card', '.steward-item-accent',
        '.dashboard-tab-list', '.dashboard-tab-button', '.dashboard-tab-panel',
        '.dashboard-tab-button::before',
        '.dashboard-search-results', '.dashboard-search-section', '.dashboard-search-result',
        '.dashboard-search-section[data-section-type="todo"]',
        '.open-current-workspace-group', '.open-other-windows-group', '.dashboard-projects-loading',
        '.dashboard-todo-loading', '.todo-panel', '.todo-item', '.todo-priority-high',
        '.todo-empty-state', '.todo-edit-form', '.steward-group-header', '.todo-page-header',
        '.todo-edit-panel', '.todo-priority-segment',
    ]) {
        assert.ok(styles.includes(selector), `missing ${selector}`);
    }
    const sidebarStyles = extractCssRule(styles, 'body.steward-sidebar');
    const projectContainerRule = extractCssRule(sidebarStyles, '.project-container');
    for (const declaration of [
        'box-sizing: border-box',
        'min-width: 0',
        'max-width: 100%',
        'padding: 0 2px',
    ]) {
        assert.ok(cssRuleIncludesTopLevelDeclaration(projectContainerRule, declaration),
            `project container is missing ${declaration}`);
    }
    const sharedItemCardRules = extractCssRules(sidebarStyles, '.steward-item-card');
    const sharedItemCardRule = sharedItemCardRules.join('\n');
    for (const declaration of [
        'min-width: 0',
        'width: 100%',
        'max-width: 100%',
        'height: 58px',
        'margin: 0 0 7px',
        'padding: 8px 10px 8px 15px',
        'border: 1px solid var(--vscode-panel-border)',
        'border-radius: 18px',
        'background: var(',
        'box-shadow:',
    ]) {
        assert.ok(sharedItemCardRules.some(rule => cssRuleIncludesTopLevelDeclaration(rule, declaration)),
            `shared item card is missing ${declaration}`);
    }

    const todoItemRules = extractCssRules(styles, '.todo-item');
    for (const forbidden of ['border:', 'border-radius:', 'background:', 'box-shadow:']) {
        assert.strictEqual(todoItemRules.some(rule => cssRuleIncludesTopLevelDeclaration(rule, forbidden)), false,
            `TODO item must not own ${forbidden}`);
    }

    const sidebarProjectRules = extractCssRules(sidebarStyles, '.project');
    const workspaceProjectRule = sidebarProjectRules.find(rule =>
        rule.includes('&[data-current-workspace][data-has-ai-session-badge]')
    );
    assert.ok(workspaceProjectRule, 'workspace project styles must define the badge-present state');
    const badgePresentWorkspaceRule = extractCssRule(
        workspaceProjectRule,
        '&[data-current-workspace][data-has-ai-session-badge]'
    );
    const sessionSurfaceRules = extractCssRules(workspaceProjectRule, '.codex-sessions');
    const collapsedSessionSurfaceRule = sessionSurfaceRules.find(rule =>
        cssRuleIncludesTopLevelDeclaration(rule, 'max-height: 0')
    );
    assert.ok(collapsedSessionSurfaceRule, 'collapsed workspace sessions must use a measurable zero-height surface');
    for (const declaration of [
        'display: block',
        'overflow: hidden',
        'opacity: 0',
        'visibility: hidden',
        'pointer-events: none',
        'margin-top: 0',
        'padding-top: 0',
        'transition:',
    ]) {
        assert.ok(cssRuleIncludesTopLevelDeclaration(collapsedSessionSurfaceRule, declaration),
            `collapsed workspace sessions are missing ${declaration}`);
    }
    assert.ok(collapsedSessionSurfaceRule.includes('max-height')
        && collapsedSessionSurfaceRule.includes('opacity')
        && collapsedSessionSurfaceRule.includes('margin-top')
        && collapsedSessionSurfaceRule.includes('padding-top'),
    'workspace session motion must transition measurable height, opacity, and spacing');
    const expandedSessionSurfaceRule = sessionSurfaceRules.find(rule =>
        cssRuleIncludesTopLevelDeclaration(rule, 'max-height: 1000px')
    );
    assert.ok(expandedSessionSurfaceRule, 'expanded workspace sessions must open to the bounded surface height');
    for (const declaration of [
        'opacity: 1',
        'visibility: visible',
        'pointer-events: auto',
        'margin-top: 8px',
        'padding-top: 7px',
    ]) {
        assert.ok(cssRuleIncludesTopLevelDeclaration(expandedSessionSurfaceRule, declaration),
            `expanded workspace sessions are missing ${declaration}`);
    }
    assert.ok(badgePresentWorkspaceRule.includes('width: calc(100% - 60px)'),
        'badge-present workspace cards must reserve title and description width');

    const compiledBadgeSelector =
        'body.steward-sidebar .project[data-current-workspace][data-has-ai-session-badge]';
    const compiledBadgeRules = extractCompiledCssRulesContainingSelector(compiledStyles, compiledBadgeSelector);
    for (const suffix of ['.fitty-container', '.project-description']) {
        const exactSelector = `${compiledBadgeSelector} ${suffix}`;
        assert.ok(compiledBadgeRules.some(rule =>
            rule.selectors.includes(exactSelector)
            && rule.body.includes('width: calc(100% - 60px)')
        ), `compiled badge-present workspace styles must reserve width for ${suffix}`);
    }
    const compiledPlainSelector = 'body.steward-sidebar .project[data-current-workspace]';
    const compiledCurrentWorkspaceRules = extractCompiledCssRulesContainingSelector(
        compiledStyles,
        compiledPlainSelector
    );
    assert.strictEqual(compiledCurrentWorkspaceRules.some(rule =>
        ['.fitty-container', '.project-description'].some(suffix =>
            rule.selectors.includes(`${compiledPlainSelector} ${suffix}`)
        ) && rule.body.includes('width: calc(100% - 60px)')
    ), false, 'compiled plain current-workspace styles must not reserve badge width');
    const compiledSessionSurfaceSelector = 'body.steward-sidebar .project .codex-sessions';
    const compiledSessionSurfaceRules = extractCompiledCssRulesContainingSelector(
        compiledStyles,
        compiledSessionSurfaceSelector,
    ).filter(rule => rule.selectors.includes(compiledSessionSurfaceSelector));
    assert.ok(compiledSessionSurfaceRules.some(rule =>
        rule.body.includes('max-height: 0')
        && rule.body.includes('opacity: 0')
        && rule.body.includes('overflow: hidden')
    ), 'compiled collapsed session surface must preserve the motion contract');
    const compiledExpandedSessionSelector =
        'body.steward-sidebar .project[data-current-workspace][data-codex-expanded] .codex-sessions';
    const compiledExpandedSessionRules = extractCompiledCssRulesContainingSelector(
        compiledStyles,
        compiledExpandedSessionSelector,
    );
    assert.ok(compiledExpandedSessionRules.some(rule =>
        rule.selectors.includes(compiledExpandedSessionSelector)
        && rule.body.includes('max-height: 1000px')
        && rule.body.includes('opacity: 1')
    ), 'compiled expanded session surface must preserve the motion contract');

    for (const forbidden of ['height: 58px', 'border-radius: 18px', 'background: var(', 'box-shadow:']) {
        assert.strictEqual(sidebarProjectRules.some(rule => cssRuleIncludesTopLevelDeclaration(rule, forbidden)), false,
            `project domain rule must not duplicate ${forbidden}`);
    }

    const sharedAccentRule = extractCssRule(sidebarStyles, '.steward-item-accent');
    assert.ok(sharedAccentRule.includes('left: 7px'));
    assert.ok(sharedAccentRule.includes('width: 4px'));
    assert.ok(sharedAccentRule.includes('border-radius: 999px'));
    assert.ok(sharedItemCardRule.includes('&.completed'));
    assert.ok(sharedItemCardRule.includes('&.selected'));
    assert.ok(sharedItemCardRule.includes('&[data-current-workspace]'));
    assert.ok(sharedItemCardRule.includes('&[data-codex-expanded]:hover'));
    const currentWorkspaceShellRule = extractCssRule(sharedItemCardRule, '&[data-current-workspace]');
    assert.ok(cssRuleIncludesTopLevelDeclaration(currentWorkspaceShellRule, 'height: auto'),
        'CURRENT WORKSPACE must remain intrinsically sized while its child collapses');
    assert.ok(cssRuleIncludesTopLevelDeclaration(currentWorkspaceShellRule, 'min-height: 58px'));
    assert.strictEqual(
        cssRuleIncludesTopLevelDeclaration(currentWorkspaceShellRule, 'height: 58px'),
        false,
        'CURRENT WORKSPACE must not switch to the fixed collapsed shell height',
    );
    const compiledCurrentWorkspaceShellSelector =
        'body.steward-sidebar .steward-item-card[data-current-workspace]';
    const compiledCurrentWorkspaceShellRules = extractCompiledCssRulesContainingSelector(
        compiledStyles,
        compiledCurrentWorkspaceShellSelector,
    ).filter(rule => rule.selectors.includes(compiledCurrentWorkspaceShellSelector));
    assert.ok(compiledCurrentWorkspaceShellRules.some(rule =>
        rule.body.includes('height: auto') && rule.body.includes('min-height: 58px')
    ), 'compiled CURRENT WORKSPACE shell must remain intrinsic in collapsed and expanded states');
    assert.strictEqual(styles.includes('.steward-card-compact'), false);

    const reducedMotionRule = extractCssRule(styles, '@media (prefers-reduced-motion: reduce)');
    assert.ok(reducedMotionRule.includes('.steward-item-card'));
    assert.ok(reducedMotionRule.includes('.steward-item-accent'));
    assert.ok(reducedMotionRule.includes('.codex-sessions'));
    assert.ok(reducedMotionRule.includes('transition: none'));

    const sharedGroupHeaderRule = extractCssRule(sidebarStyles, '.steward-group-header');
    for (const declaration of [
        'display: flex',
        'width: 100%',
        'padding: 4px 6px',
        'border: 1px solid var(--vscode-panel-border)',
        'border-radius: 7px',
        'background: var(--vscode-list-inactiveSelectionBackground, transparent)',
        'font-size: 15px',
    ]) {
        assert.ok(sharedGroupHeaderRule.includes(declaration), `shared group header is missing ${declaration}`);
    }
    const sharedDangerActionRule = extractCssRule(sharedGroupHeaderRule, '.group-actions > .danger');
    assert.ok(sharedDangerActionRule.includes('&:hover')
        && sharedDangerActionRule.includes('&:focus-visible')
        && sharedDangerActionRule.includes('color: var(--vscode-errorForeground)'),
        'shared group header danger actions must retain their danger color on hover and keyboard focus');

    const todoPageHeaderRules = extractCssRulesContainingSelector(styles, '.todo-page-header').join('\n');
    for (const forbidden of [
        'display:', 'width:', 'padding:', 'border:', 'border-radius:', 'background:', 'box-shadow:',
        'font-family:', 'font-size:', 'font-weight:', 'line-height:', 'box-sizing:',
    ]) {
        assert.strictEqual(cssRuleIncludesDeclaration(todoPageHeaderRules, forbidden), false,
            `TODO page header must not own ${forbidden}`);
    }

    for (const selector of ['.todo-group-action', '.todo-square-button', '.todo-square-toggle']) {
        const todoActionRules = extractCssRulesContainingSelector(styles, selector).join('\n');
        for (const forbidden of ['display:', 'width:', 'height:', 'min-width:', 'min-height:', 'place-items:', 'padding:']) {
            assert.strictEqual(cssRuleIncludesDeclaration(todoActionRules, forbidden), false,
                `${selector} must not own ${forbidden}`);
        }
    }
    const todoCompletedToggleFocusRule = extractCssRule(styles, '.todo-square-toggle:focus-within');
    assert.ok(todoCompletedToggleFocusRule.includes('outline: 1px solid var(--vscode-focusBorder)')
        && todoCompletedToggleFocusRule.includes('outline-offset: 1px'),
    'the hidden Show Completed checkbox must expose a visible focus ring on its label');
    assert.ok(compiledStyles.includes('.todo-square-toggle:focus-within {')
        && compiledStyles.includes('outline: 1px solid var(--vscode-focusBorder);'),
    'compiled dashboard CSS must retain the Show Completed focus-within ring');

    const todoGroupHeaderRule = extractCssRule(styles, '.todo-group-header');
    for (const forbidden of ['border:', 'border-radius:', 'background:', 'box-shadow:']) {
        assert.strictEqual(todoGroupHeaderRule.includes(forbidden), false, `TODO group header must not own ${forbidden}`);
    }
    assert.strictEqual(styles.includes('.todo-group-strip'), false);
    const todoGroupCountRule = extractCssRule(styles, '.todo-group-count');
    assert.ok(todoGroupCountRule.includes('color: currentColor')
        && todoGroupCountRule.includes('background: transparent')
        && todoGroupCountRule.includes('opacity: .55'),
        'todo group counts should not introduce a separate badge color language');
    const todoTitleRule = extractCssRule(styles, '.todo-title-text');
    assert.ok(todoTitleRule.includes('display: block')
        && todoTitleRule.includes('white-space: nowrap')
        && todoTitleRule.includes('text-overflow: ellipsis')
        && !todoTitleRule.includes('-webkit-line-clamp'),
        'todo item titles should stay on one line and ellipsize');
    const todoPriorityChoiceRule = extractCssRule(styles, '.todo-priority-choice');
    assert.ok(todoPriorityChoiceRule.includes('transition:'),
        'todo priority choices should animate visual selected-state changes');
    assert.ok(styles.includes('.todo-priority-choice input:checked + span'),
        'todo priority selected state should be driven by the radio checked state');
    const todoListRules = extractCssRules(styles, '.todo-list');
    const todoListRule = todoListRules.join('\n');
    assert.ok(todoListRule.includes('max-height: calc(var(--todo-list-max-height) + var(--todo-list-expanded-extra-height, 0px))')
        && todoListRule.includes('overflow-y: auto'),
        'todo lists should scroll inside each group when they exceed the configured collapsed-card count');
    assert.ok(todoListRule.includes('var(--todo-list-expanded-extra-height, 0px)'),
        'todo lists should add expanded-card content to the collapsed-card viewport height');
    assert.ok(todoListRules.some(rule => cssRuleIncludesTopLevelDeclaration(rule, 'gap: 0')),
        'shared item card margins should be the only spacing source inside TODO lists');
    const todoLastItemRule = extractCssRule(styles, '.todo-list > .steward-item-card:last-child');
    assert.ok(cssRuleIncludesTopLevelDeclaration(todoLastItemRule, 'margin-bottom: 0'),
        'the final configured TODO card should not add trailing margin beyond the max-height budget');
    const todoListEditingRule = extractCssRule(styles, '.todo-list.has-editing-item');
    assert.ok(todoListEditingRule.includes('max-height: none')
        && todoListEditingRule.includes('overflow-y: visible'),
        'editing a todo should remove the group list viewport limit so the full editor is visible');
    assert.ok(styles.includes('.todo-item:not(.expanded)'),
        'todo items should have a collapsed state that controls the visible-count height');
    assert.ok(sharedItemCardRule.includes('&.expanded')
        && sharedItemCardRule.includes('&.editing'),
        'shared item cards should own expanded and editing states');
    assert.ok(sharedItemCardRule.includes('height: 58px'),
        'collapsed todo items should keep the same normal card height as current workspace cards');
    assert.ok(sharedItemCardRule.includes('height: auto')
        && sharedItemCardRule.includes('min-height: 58px'),
        'expanded todo items should open from the normal collapsed card height');
    assert.ok(styles.includes('.todo-item.editing .todo-edit-form'),
        'editing todo items should force the edit form to render');
    const collapsedNotesRule = extractCssRule(styles, '.todo-item:not(.expanded) .todo-notes');
    assert.ok(collapsedNotesRule.includes('white-space: nowrap'));
    assert.ok(collapsedNotesRule.includes('text-overflow: ellipsis'));
    assert.strictEqual(collapsedNotesRule.includes('display: none'), false);

    const collapsedFooterRule = extractCssRule(styles, '.todo-item:not(.expanded) .todo-item-footer');
    assert.ok(collapsedFooterRule.includes('display: none'));

    const expandedNotesRule = extractCssRule(styles, '.todo-item.expanded .todo-notes,\n.todo-item.editing .todo-notes');
    assert.ok(expandedNotesRule.includes('white-space: pre-wrap'));

    assert.ok(compiledStyles.includes('.group.collapsed .collapse-icon svg'),
        'collapsed groups must keep the existing SVG rotation path');
    assert.strictEqual(
        compiledStyles.includes('.todo-group-collapse-button[aria-expanded=false] .collapse-icon'),
        false,
        'TODO group collapse must not add a parent transform on top of the existing SVG rotation'
    );
    assert.ok(compiledStyles.includes('.todo-expand-control[aria-expanded=false] svg'),
        'the independent TODO expand control must retain its own SVG rotation');

    const completedRules = extractCompiledCssRulesContainingSelector(
        compiledStyles,
        '.todo-item.completed'
    );
    for (const completedRule of completedRules) {
        assert.strictEqual(
            cssRuleIncludesDeclaration(completedRule.body, 'background:'),
            false,
            'completed TODO selectors must not own card backgrounds'
        );
        if (cssRuleIncludesDeclaration(completedRule.body, 'opacity:')) {
            assert.deepStrictEqual(
                completedRule.selectors,
                ['.todo-item.completed .todo-priority-badge'],
                'only the completed priority badge selector may own opacity'
            );
        }
    }
    assert.strictEqual(
        completedRules.some(rule => rule.selectors.some(selector => selector.includes('::before'))),
        false,
        'completed TODO selectors must not own a ::before layer'
    );

    assert.ok(styles.includes('.todo-list.has-editing-item'));
    assert.ok(styles.includes('.todo-item.editing .todo-edit-form'));
    assert.strictEqual(styles.includes('.todo-empty-orb'), false);
    assert.strictEqual(styles.includes('.todo-empty-primary'), false);
    assert.strictEqual(styles.includes('.todo-empty-secondary'), false);
    assert.ok(projectSource.includes('function toggleTodoItemExpanded('),
        'todo cards should have a click-driven expanded/collapsed helper');
    assert.ok(projectSource.includes('function syncTodoListExpandedHeight('),
        'todo card expansion should keep the full expanded card visible inside its scrolling list');
    assert.ok(projectSource.includes('function isTodoInteractiveTarget('),
        'todo card expansion should ignore nested controls');
    assert.ok(extractFunctionBody(projectSource, 'toggleTodoItemExpanded').includes('syncTodoExpandControl(item, nextExpanded);'),
        'todo expansion must synchronize aria-expanded, title, and aria-label');
    const setTodoEditingBody = extractFunctionBody(projectSource, 'setTodoEditing');
    assert.ok(setTodoEditingBody.includes('data-expanded-before-edit'),
        'editing must record whether the TODO was expanded before editing');
    assert.ok(setTodoEditingBody.includes('removeAttribute(\'data-expanded-before-edit\')'),
        'canceling edit must clear the saved pre-edit expansion state');
    assert.ok(setTodoEditingBody.includes('expandedBeforeEdit'),
        'canceling edit must restore the saved pre-edit expansion state');
    assert.ok(setTodoEditingBody.includes("toggleTodoItemExpanded(item, editing ? true : expandedBeforeEdit === 'true')"),
        'editing a todo should force the card into expanded state');
    assert.ok(setTodoEditingBody.includes("item.classList.toggle('editing', editing)"),
        'editing a todo should mark the whole card as editing');
    assert.ok(setTodoEditingBody.includes("list.classList.toggle('has-editing-item'"),
        'editing a todo should make its group list fully expand until editing ends');
    assert.ok(setTodoEditingBody.includes('view.hidden = false'),
        'editing should retain the normal todo card header above the expanded form');
    const onMouseEventBody = extractFunctionBody(projectSource, 'onMouseEvent');
    assert.ok(onMouseEventBody.includes(".todo-item[data-todo-id]"),
        'clicking a todo card should toggle its expanded/collapsed state');
    assert.ok(onMouseEventBody.includes("!todoItem.classList.contains('editing')"),
        'clicking an editing card should not collapse its active edit form');
    assert.ok(projectSource.includes("data-action=\"todo-toggle-expanded\""),
        'TODO cards need an independent focusable expand control');
    assert.ok(projectSource.includes("e.target.closest('[data-action=\"todo-toggle-expanded\"]')"),
        'the expand control must preserve the existing interactive-target guard');
    assert.ok(projectSource.includes("e.target.closest('.todo-edit-form')"),
        'Escape handling must detect the active TODO edit form');
    assert.ok(projectSource.includes("setTodoEditing(editForm.getAttribute('data-todo-id'), false)"),
        'Escape must cancel the active TODO edit form');
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.ok(changelog.includes('Add a global `TODO` Dashboard tab'));
    assert.strictEqual((source.match(/type: 'request-projects-panel'/g) || []).length, 1);
    assert.strictEqual((source.match(/type: 'request-todo-panel'/g) || []).length, 1);
    assert.ok(extractFunctionBody(source, 'ensureProjectsPanel').includes("type: 'request-projects-panel'"));
    assert.ok(extractFunctionBody(source, 'ensureTodoPanel').includes("type: 'request-todo-panel'"));
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
            'request-todo-panel': async message => {
                calls.push(['request-todo-panel', message.requestId]);
            },
            'selected-project': message => {
                calls.push(['selected-project', message.projectId]);
            },
        },
        createAiSession: message => {
            calls.push(['create-ai-session', message.projectId]);
        },
        resumeAiSession: (message, providerId, rootId) => {
            calls.push(['resume-ai-session', providerId, message.sessionId, rootId]);
        },
        archiveAiSession: (message, providerId) => {
            calls.push(['archive-ai-session', providerId, message.sessionId]);
        },
        saveCurrentWorkspace: message => {
            calls.push(['save-current-workspace', message.type, message.requestId]);
        },
    });

    await router(null);
    await router({});
    await router({ type: 'unknown-message' });
    assert.deepStrictEqual(calls, []);

    await router({ type: 'request-projects-panel', requestId: 7 });
    await router({ type: 'request-todo-panel', requestId: 8 });
    await router({ type: 'selected-project', projectId: 'project-a' });
    await router({ type: 'create-ai-session', projectId: 'workspace-a', rootId: 'root-api' });
    await router({ type: 'new-session-in', projectId: 'workspace-a' });
    await router({ type: 'new-session-in', projectId: 'workspace-a', rootId: 'root-api' });
    await router({ type: 'resume-ai-session', provider: 'codex', sessionId: 'c1' });
    await router({ type: 'resume-ai-session', provider: 'codex', sessionId: 'c2', rootId: 'root-web' });
    await router({ type: 'resume-ai-session', provider: 'unknown', sessionId: 'invalid' });
    await router({ type: 'resume-kimi-session', sessionId: 'k1' });
    await router({ type: 'archive-claude-session', sessionId: 'a1' });
    await router({ type: 'resume-unknown-session', sessionId: 'ignored' });
    await router({ type: 'save-current-workspace', requestId: 9 });
    await router({ type: 'save-project', projectId: '__currentWorkspace-transient-card-id' });

    assert.deepStrictEqual(calls, [
        ['request-projects-panel', 7],
        ['request-todo-panel', 8],
        ['selected-project', 'project-a'],
        ['create-ai-session', 'workspace-a'],
        ['resume-ai-session', 'codex', 'c1', null],
        ['resume-ai-session', 'codex', 'c2', 'root-web'],
        ['resume-ai-session', null, 'invalid', null],
        ['resume-ai-session', 'kimi', 'k1', null],
        ['archive-ai-session', 'claude', 'a1'],
        ['save-current-workspace', 'save-current-workspace', 9],
        ['save-current-workspace', 'save-project', undefined],
    ]);

    const genericSaveCalls = [];
    const routerWithoutSaveHandler = routerModule.createDashboardMessageRouter({
        handlers: {
            'save-current-workspace': message => genericSaveCalls.push(message.requestId),
        },
    });
    await routerWithoutSaveHandler({ type: 'save-current-workspace', requestId: 10 });
    await routerWithoutSaveHandler({ type: 'save-project', projectId: '__currentWorkspace-stale' });
    assert.deepStrictEqual(genericSaveCalls, [],
        'workspace save messages must remain reserved routes when their dedicated handler is unavailable');

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
    await runActiveTerminalFileReferenceChecks();
    await runTodoStoreChecks();
    await runTodoInsertionOrderNormalizationChecks();
    await runTodoOrderingMutationChecks();
    await runTodoStorageResolutionChecks();
    await runTodoMigrationChecks();
    await runTodoBackendSwitchBarrierChecks();
    await runTodoViewStateChecks();
    await runTodoMutationSerializationChecks();
    await runTodoRevealSingleWriteChecks();
    await runDashboardTodoMigrationSequencingChecks();
    await runTodoHostMutationChecks();
    runDashboardUpdateMessageChecks();
    runWorkspaceCardRenderingChecks();
    runTodoViewModelChecks();
    runTodoOrderingInteractionChecks();
    runControllerChecks(source);
    runTodoEditResetInteractionChecks();
    runTodoComposePendingInteractionChecks();
    runSourceContractChecks(source);
    await runDashboardMessageRouterChecks();
    console.log('Dashboard Webview checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
