'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const CleanCSS = require('clean-css');
const sass = require('sass');
const dashboardErrorContent = require('../out/dashboard/errorContent');
const dashboardConfiguration = require('../out/dashboard/configuration');
const dashboardStartup = require('../out/dashboard/startup');
const { DashboardStartupController } = require('../out/dashboard/startupController');
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
const todoViewModel = require('../out/todos/viewModel');
const todoWebviewContent = require('../out/todos/webviewContent');

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

async function runTodoStoreChecks() {
    assert.deepStrictEqual(todoTypes.normalizeTodoData(null), { version: 1, groups: [], todos: [] });
    assert.deepStrictEqual(todoTypes.normalizeTodoData({ version: 99, groups: null, todos: null }), { version: 1, groups: [], todos: [] });

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
    assert.deepStrictEqual(configUpdates[0], ['todoData', { version: 1, groups: [], todos: [] }, 1]);
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
    assert.ok(html.includes('data-action="todo-delete-group"'));
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
    assert.ok(html.includes('todo-item-content'));
    assert.ok(html.includes('todo-item-footer'));
    assert.strictEqual(html.includes('todo-add-form'), false, 'default TODO list must not show a persistent add form');
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
    assert.strictEqual(emptyHtml.includes('todo-empty-orb'), false);
    assert.strictEqual(emptyHtml.includes('Create first group'), false);
    assert.strictEqual(emptyHtml.includes('Add todo to Inbox'), false);
    assert.strictEqual(html.includes('todo-edit-panel steward-card'), false);

    const dashboardViewModel = require('../out/webview/dashboardViewModel');
    const catalog = dashboardViewModel.buildDashboardSearchCatalog([], [], todoTypes.buildTodoSearchItems(makeTodoData()));
    assert.strictEqual(catalog.todos.length, 2);
    assert.ok(dashboardViewModel.serializeDashboardSearchCatalog(catalog).includes('Write TODO') === false);
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
    const todoButton = createElement('dashboard-tab-todo-button');
    todoButton.setAttribute('data-dashboard-tab', 'todo');
    const openPanel = createElement('dashboard-tab-open');
    const projectsPanel = createElement('dashboard-tab-projects');
    const todoPanel = createElement('dashboard-tab-todo');
    const elements = {
        'dashboard-tab-open': openPanel,
        'dashboard-tab-projects': projectsPanel,
        'dashboard-tab-todo': todoPanel,
    };
    const messages = [];
    const storage = new Map([['projectSteward.activeDashboardTab', 'open']]);
    const windowListeners = {};
    const context = {
        document: {
            body: { classList: createClassList() },
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
    const sections = context.filterDashboardCatalog(makeDashboardCatalog(), 'dashboard');
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(sections.map(section => section.id))),
        ['ai-sessions', 'open-projects', 'saved-projects']
    );
    const todoSections = context.filterDashboardCatalog(makeDashboardCatalog(), 'ship');
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(todoSections.map(section => section.id))),
        ['todos']
    );
    assert.strictEqual(context.filterDashboardCatalog(makeDashboardCatalog(), 'missing').length, 0);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(context.normalizeDashboardSearchCatalog(null))),
        { sessions: [], openProjects: [], savedProjects: [], todos: [] }
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
    const controller = context.initDashboard({
        postMessage: message => messages.push(message),
        onProjectsMounted: panel => {
            assert.strictEqual(panel, projectsPanel);
            mounted += 1;
        },
        onTodoMounted: panel => {
            assert.strictEqual(panel, todoPanel);
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
    assert.strictEqual(searchController.getTodoState(), 'unloaded');
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
    const webviewContentSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewContent.ts'), 'utf8');
    const stylesPath = path.join(root, 'media', 'styles.scss');
    const generatedStylesPath = path.join(root, 'media', 'styles.css');
    const styles = fs.readFileSync(stylesPath, 'utf8');
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
    assert.ok(webviewContentSource.includes('class="group steward-section'));
    assert.ok(webviewContentSource.includes('class="group-title steward-section-header steward-group-header"'));
    assert.ok(webviewContentSource.includes('class="project steward-item-card"'));
    assert.ok(webviewContentSource.includes('class="project-border steward-item-accent"'));
    assert.ok(source.includes("setAttribute('aria-selected'"));
    assert.ok(source.includes("setAttribute('tabindex'"));
    assert.ok(source.includes('scrollPositions'));
    assert.ok(source.includes('acceptedProjectsRequestId'));
    assert.ok(source.includes('pendingScrollRestoreTab'));
    assert.ok(extensionHostSource.includes("'request-projects-panel': async e =>"));
    assert.ok(extensionHostSource.includes("'request-todo-panel': async e =>"));
    assert.ok(packageJson.includes('"projectSteward.maxVisibleTodosPerGroup"'));
    assert.strictEqual(extensionHostSource.includes('function handleStewardMessage('), false);
    assert.ok(extensionHostSource.includes('getAiSessionProviderIds: () => getRegisteredAiSessionProviders().map(provider => provider.id)'));
    assert.ok(extensionHostSource.includes("type: 'projects-panel-content'"));
    assert.ok(extensionHostSource.includes("type: 'todo-panel-content'"));
    assert.ok(extensionHostSource.includes('getProjectsPanelContent(projectService.getGroups(), stewardInfos)'));
    assert.ok(extensionHostSource.includes('getTodoPanelContent(buildTodoViewModel(todoData'));
    assert.ok(extensionHostSource.includes('getMaxVisibleTodosPerGroup(config)'));
    assert.ok(projectSource.includes("e.target.closest('[data-action=\"add-project\"]')"));
    assert.ok(projectSource.includes("e.target.closest('[data-action=\"import-from-other-storage\"]')"));
    assert.ok(projectSource.includes("e.target.closest('[data-action=\"todo-add\"]')"));
    assert.ok(projectSource.includes("type: 'todo-add'"));
    assert.ok(projectSource.includes("type: 'todo-toggle'"));
    assert.ok(projectSource.includes("type: 'todo-delete'"));
    assert.ok(projectSource.includes("type: 'todo-delete-group'"));
    assert.ok(projectSource.includes("type: 'todo-collapse-group'"));
    assert.ok(projectSource.includes("type: 'todo-sort-priority'"));
    assert.ok(projectSource.includes("type: 'todo-toggle-show-completed'"));
    assert.ok(projectSource.includes("type: 'todo-update'"));
    assert.ok(projectSource.includes('function syncTodoPrioritySegment('));
    assert.ok(extractFunctionBody(projectSource, 'onChangeEvent').includes('syncTodoPrioritySegment('));
    assert.ok(projectSource.includes('function onTodoFormSubmit('));
    assert.strictEqual(projectSource.includes(".querySelectorAll('[data-action=\"add-project\"]')"), false);
    assert.strictEqual(projectSource.includes(".querySelectorAll('[data-action=\"import-from-other-storage\"]')"), false);
    assert.ok(extensionHostSource.includes("'todo-add': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-toggle': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-delete': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-delete-group': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-collapse-group': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-sort-priority': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-toggle-show-completed': async e =>"));
    assert.ok(extensionHostSource.includes("'todo-update': async e =>"));
    assert.ok(extensionHostSource.includes('async function postTodoPanelContent('));
    assert.ok(dndSource.includes('function initDnD(root)'));
    assert.ok(dndSource.includes('root.__projectStewardDnDInitialized'));
    assert.strictEqual(dndSource.includes('document.querySelectorAll(`${groupsContainerSelector}'), false);
    assert.ok(projectSource.includes("'collapse-group'"));
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
    assert.ok(filterSource.includes('ctrlKey'));
    assert.ok(filterSource.includes('metaKey'));
    assert.ok(filterSource.includes('Escape'));
    assert.ok(source.includes('initialSearchQuery'));
    assert.ok(source.includes('replaceSearchCatalog'));
    assert.ok(source.includes('isSearchActive'));
    assert.ok(source.includes("title: 'TODO RESULTS'"));
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
    const sharedItemCardRules = extractCssRules(sidebarStyles, '.steward-item-card');
    const sharedItemCardRule = sharedItemCardRules.join('\n');
    for (const declaration of [
        'height: 58px',
        'margin: 0 2px 7px 2px',
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
    assert.strictEqual(styles.includes('.steward-card-compact'), false);

    const reducedMotionRule = extractCssRule(styles, '@media (prefers-reduced-motion: reduce)');
    assert.ok(reducedMotionRule.includes('.steward-item-card'));
    assert.ok(reducedMotionRule.includes('.steward-item-accent'));
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
    const setTodoEditingBody = extractFunctionBody(projectSource, 'setTodoEditing');
    assert.ok(setTodoEditingBody.includes("toggleTodoItemExpanded(item, editing)"),
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
    await router({ type: 'request-todo-panel', requestId: 8 });
    await router({ type: 'selected-project', projectId: 'project-a' });
    await router({ type: 'resume-ai-session', provider: 'codex', sessionId: 'c1' });
    await router({ type: 'resume-ai-session', provider: 'unknown', sessionId: 'invalid' });
    await router({ type: 'resume-kimi-session', sessionId: 'k1' });
    await router({ type: 'archive-claude-session', sessionId: 'a1' });
    await router({ type: 'resume-unknown-session', sessionId: 'ignored' });

    assert.deepStrictEqual(calls, [
        ['request-projects-panel', 7],
        ['request-todo-panel', 8],
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
    await runActiveTerminalFileReferenceChecks();
    await runTodoStoreChecks();
    runTodoViewModelChecks();
    runControllerChecks(source);
    runSourceContractChecks(source);
    await runDashboardMessageRouterChecks();
    console.log('Dashboard Webview checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
