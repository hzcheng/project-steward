'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createFakeVscode } = require('../../helpers/fakeVscode');
const { buildDashboardSearchCatalog } = require('../../../out/webview/dashboardViewModel');
const { getDashboardWebviewOptions } = require('../../../out/dashboard/webviewOptions');

const root = path.join(__dirname, '..', '..', '..');
const dashboardSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDashboardScripts.js'), 'utf8');
const projectSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewProjectScripts.js'), 'utf8');
const dndSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDnDScripts.js'), 'utf8');
const NOW = '2026-07-23T00:00:00.000Z';

function toPlain(value) {
    return JSON.parse(JSON.stringify(value));
}

function createClassList(initial = []) {
    const values = new Set(initial);
    return {
        add: value => values.add(value),
        remove: value => values.delete(value),
        contains: value => values.has(value),
        toggle(value, force) {
            if (force === undefined ? !values.has(value) : force) values.add(value);
            else values.delete(value);
            return values.has(value);
        },
    };
}

function createElement(id = '') {
    const attributes = new Map();
    const listeners = {};
    return {
        id,
        hidden: false,
        innerHTML: '',
        children: [],
        classList: createClassList(),
        addEventListener(type, listener) {
            listeners[type] = listener;
        },
        dispatch(type, event = {}) {
            return listeners[type] && listeners[type](event);
        },
        getAttribute(name) {
            return attributes.has(name) ? attributes.get(name) : null;
        },
        setAttribute(name, value) {
            attributes.set(name, String(value));
        },
        removeAttribute(name) {
            attributes.delete(name);
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        contains: () => false,
        focus() {},
    };
}

function createSearchElement(tagName = 'div') {
    const element = createElement();
    element.tagName = tagName.toUpperCase();
    element.dataset = {};
    element.className = '';
    element.textContent = '';
    element.appendChild = child => {
        element.children.push(child);
        return child;
    };
    element.removeChild = child => {
        element.children.splice(element.children.indexOf(child), 1);
    };
    Object.defineProperty(element, 'firstChild', {
        get: () => element.children[0] || null,
    });
    element.classList = {
        add(value) {
            const classes = new Set(element.className.split(/\s+/).filter(Boolean));
            classes.add(value);
            element.className = Array.from(classes).join(' ');
        },
        remove(value) {
            const classes = new Set(element.className.split(/\s+/).filter(Boolean));
            classes.delete(value);
            element.className = Array.from(classes).join(' ');
        },
        toggle(value, force) {
            if (force) this.add(value);
            else this.remove(value);
        },
        contains: value => element.className.split(/\s+/).includes(value),
    };
    return element;
}

function makeCatalog(suffix = '') {
    return {
        sessions: [{
            key: `codex:c${suffix}`, searchText: `dashboard session ${suffix}`,
            projectId: 'current', projectName: 'Dashboard', provider: 'codex',
            sessionId: `c${suffix}`, name: 'Session',
        }],
        openProjects: [{
            key: `open:${suffix}`, identity: '/work/dashboard', searchText: `dashboard open ${suffix}`,
            projectId: 'current', name: 'Dashboard', description: 'Current', action: 'open-current',
        }],
        savedProjects: [],
        todos: [{
            key: `todo:t${suffix}`, todoId: `t${suffix}`, groupId: 'group-a',
            searchText: `ship todo ${suffix}`, title: 'Ship TODO', groupTitle: 'Planning',
            priority: 'high', completed: false, notesSearchText: 'Release notes',
        }],
    };
}

function createDashboardHarness({ initialTab = 'open', initialSearchQuery = '', synchronousFrames = true } = {}) {
    const openButton = createElement('dashboard-tab-open-button');
    openButton.setAttribute('data-dashboard-tab', 'open');
    const projectsButton = createElement('dashboard-tab-projects-button');
    projectsButton.setAttribute('data-dashboard-tab', 'projects');
    const todoButton = createElement('dashboard-tab-todo-button');
    todoButton.setAttribute('data-dashboard-tab', 'todo');
    const openPanel = createElement('dashboard-tab-open');
    const projectsPanel = createElement('dashboard-tab-projects');
    const todoPanel = createElement('dashboard-tab-todo');
    const searchResults = createSearchElement();
    searchResults.id = 'dashboard-search-results';
    const catalogElement = { textContent: JSON.stringify(makeCatalog()) };
    const elements = {
        'dashboard-tab-open': openPanel,
        'dashboard-tab-projects': projectsPanel,
        'dashboard-tab-todo': todoPanel,
        'dashboard-search-results': searchResults,
        'dashboard-search-catalog': catalogElement,
    };
    const storage = new Map([['projectSteward.activeDashboardTab', initialTab]]);
    const messages = [];
    const frames = [];
    const windowListeners = {};
    const context = {
        document: {
            activeElement: null,
            body: { classList: createClassList() },
            createElement: createSearchElement,
            getElementById: id => elements[id] || null,
            querySelector: () => null,
            querySelectorAll: selector => selector === '[data-dashboard-tab]'
                ? [openButton, projectsButton, todoButton]
                : [],
        },
        sessionStorage: {
            getItem: key => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value),
        },
        window: {
            scrollY: 0,
            scrollTo: (_x, y) => { context.window.scrollY = y; },
            addEventListener: (type, listener) => { windowListeners[type] = listener; },
        },
        requestAnimationFrame(callback) {
            if (synchronousFrames) callback();
            else frames.push(callback);
        },
    };
    vm.runInNewContext(dashboardSource, context);
    const controller = context.initDashboard({
        initialSearchQuery,
        postMessage: message => messages.push(message),
    });
    return {
        context,
        controller,
        messages,
        frames,
        storage,
        windowListeners,
        openButton,
        projectsButton,
        todoButton,
        openPanel,
        projectsPanel,
        todoPanel,
        searchResults,
    };
}

function loadWebviewModules() {
    const vscode = createFakeVscode({});
    vscode.Uri = {
        file: value => ({ fsPath: value, path: value, toString: () => `file://${value}` }),
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return {
            content: require('../../../out/webview/webviewContent'),
            updateMessages: require('../../../out/dashboard/webviewUpdateMessages'),
        };
    } finally {
        Module._load = previousLoad;
    }
}

const webviewModules = loadWebviewModules();

test('WEBVIEW-DASHBOARD-SEARCH-CATALOG-001 de-duplicates saved path identities while retaining the favorite representative', () => {
    const catalog = buildDashboardSearchCatalog([{
        id: 'tools', groupName: 'TOOLS', projects: [
            { id: 'saved', name: 'Dashboard', path: '/work/dashboard', favorite: true },
            { id: 'duplicate', name: 'Dashboard copy', path: '/work/dashboard/' },
            { id: 'other', name: 'Other', path: '/work/other' },
        ],
    }], [{
        id: 'open', name: 'Dashboard', path: '/work/dashboard', openProjectCardKind: 'current',
        codexSessions: [{ id: 'c1', name: 'Fix dashboard' }],
    }], makeCatalog().todos);

    assert.deepEqual(catalog.sessions.map(item => item.key), ['codex:c1']);
    assert.deepEqual(catalog.savedProjects.map(item => item.projectId), ['saved', 'other']);
    assert.deepEqual(catalog.savedProjects[0].groupLabels, ['FAVORITES', 'TOOLS']);
    assert.deepEqual(catalog.todos, makeCatalog().todos);
});

test('WEBVIEW-DASHBOARD-UPDATE-MESSAGE-001 preserves TODO catalog entries in incremental messages', () => {
    const todoSearchItems = makeCatalog().todos;
    const openMessage = webviewModules.updateMessages.buildOpenProjectsUpdatedMessage({
        groups: [], cards: [], collapsed: false,
        stewardInfos: { openProjectsGroupCollapsed: false, config: {} },
        semanticRevision: 'revision', todoSearchItems,
    });
    const sessionsMessage = webviewModules.updateMessages.buildAiSessionsUpdatedMessage({
        groups: [], cards: [], sequence: 7, generatedAt: NOW,
        openProjects: [], todoSearchItems,
    });
    assert.deepEqual(openMessage.searchCatalog.todos, todoSearchItems);
    assert.deepEqual(sessionsMessage.searchCatalog.todos, todoSearchItems);
});

test('WEBVIEW-WEBVIEW-OPTIONS-001 enables scripts and limits local resources to media', () => {
    const options = getDashboardWebviewOptions('/extension', value => ({ path: value }));
    assert.deepEqual(options, {
        enableScripts: true,
        localResourceRoots: [{ path: path.join('/extension', 'media') }],
    });
});

test('WEBVIEW-CURRENT-WORKSPACE-RENDERING-001 distinguishes current and navigation OPEN cards', () => {
    const config = { get: (_key, fallback) => fallback };
    const html = webviewModules.content.getOpenProjectsGroupContent([
        {
            id: 'current', name: 'Current', path: '/work/current', color: '#00aacc',
            openProjectCardKind: 'current', codexSessions: [{ id: 'c1', name: 'Session' }],
        },
        {
            id: 'navigation', name: 'Other', path: '/work/other',
            openProjectCardKind: 'projectNavigation', codexSessions: [{ id: 'leak', name: 'Leaked' }],
        },
    ], false, { config });

    const currentTag = html.match(/<div class="[^"]*project[^"]*"[^>]*data-id="current"[^>]*>/)[0];
    const navigationTag = html.match(/<div class="[^"]*project[^"]*"[^>]*data-id="navigation"[^>]*>/)[0];
    assert.match(currentTag, /data-current-workspace/);
    assert.match(currentTag, /data-open-project/);
    assert.doesNotMatch(navigationTag, /data-current-workspace|data-open-project/);
    assert.match(navigationTag, /data-project-navigation/);
    assert.match(navigationTag, /data-readonly-project/);
    assert.equal((html.match(/class="codex-sessions"/g) || []).length, 1);
    assert.equal(html.includes('Leaked'), false);
});

test('WEBVIEW-FAVORITE-RENDERING-001 renders favorites in explicit order before saved groups', () => {
    const html = webviewModules.content.getProjectsPanelContent([{
        id: 'group', groupName: 'Work', collapsed: false,
        projects: [
            { id: 'favorite-a', name: 'A', path: '/a', favorite: true, favoriteOrder: 1 },
            { id: 'favorite-b', name: 'B', path: '/b', favorite: true, favoriteOrder: 0 },
            { id: 'plain', name: 'Plain', path: '/plain' },
        ],
    }], {
        config: { get: (_key, fallback) => fallback },
        otherStorageHasData: false,
    });
    const ids = Array.from(html.matchAll(/<div class="[^"]*project steward-item-card[^"]*"[^>]*data-id="([^"]+)"/g))
        .map(match => match[1]);
    assert.deepEqual(ids, ['favorite-b', 'favorite-a', 'favorite-a', 'favorite-b', 'plain']);
});

test('WEBVIEW-WEBVIEW-CONTENT-001 renders OPEN PROJECTS and lazy PROJECTS TODO tab shells', () => {
    const config = { get: (_key, fallback) => fallback };
    const html = webviewModules.content.getStewardContent(
        { extensionPath: '/extension' },
        { cspSource: 'test', asWebviewUri: uri => uri.toString() },
        [{ id: 'saved', groupName: 'Saved', projects: [{ id: 'hidden', name: 'Hidden', path: '/hidden' }] }],
        {
            config,
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            otherStorageHasData: false,
            openProjects: [{ id: 'current', name: 'Current', path: '/current', openProjectCardKind: 'current' }],
            todoSearchItems: makeCatalog().todos,
        },
        true
    );
    for (const tab of ['open', 'projects', 'todo']) {
        assert.match(html, new RegExp(`data-dashboard-tab="${tab}"`));
        assert.match(html, new RegExp(`id="dashboard-tab-${tab}"`));
    }
    assert.match(html, /id="dashboard-search-catalog"/);
    assert.equal(html.includes('data-id="hidden"'), false);
    assert.match(html, /data-id="current"/);
});

test('WEBVIEW-DASHBOARD-UPDATE-MESSAGE-001 preserves OPEN PROJECTS and TODO mounted tab state', () => {
    const harness = createDashboardHarness();
    harness.context.window.scrollY = 12;
    harness.controller.activateTab('projects');
    assert.deepEqual(toPlain(harness.messages), [
        { type: 'request-projects-panel', version: 1, requestId: 1 },
    ]);
    assert.equal(harness.controller.applyProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 1, html: '<p>projects</p>',
    }), true);
    harness.controller.activateTab('todo');
    assert.equal(harness.controller.applyTodoPanelMessage({
        type: 'todo-panel-content', version: 1, requestId: 1, html: '<p>todo</p>',
    }), true);
    harness.controller.activateTab('open');
    harness.controller.replaceSearchCatalog(makeCatalog('next'));

    assert.equal(harness.controller.getActiveTab(), 'open');
    assert.equal(harness.projectsPanel.innerHTML, '<p>projects</p>');
    assert.equal(harness.todoPanel.innerHTML, '<p>todo</p>');
    harness.controller.activateTab('projects');
    harness.controller.activateTab('todo');
    assert.equal(harness.messages.filter(message => message.type === 'request-projects-panel').length, 1);
    assert.equal(harness.messages.filter(message => message.type === 'request-todo-panel').length, 1);
    assert.equal(harness.storage.get('projectSteward.activeDashboardTab'), 'todo');
});

test('TODO-TODO-SEARCH-RESULT-RENDERING-001 search reveal requests host data then focuses the mounted TODO', () => {
    const harness = createDashboardHarness({ initialTab: 'todo', synchronousFrames: false });
    assert.equal(harness.controller.applyTodoPanelMessage({
        type: 'todo-panel-content', version: 1, requestId: 1, html: '<p>todo</p>',
    }), true);
    harness.controller.replaceSearchCatalog(makeCatalog('search'));
    harness.controller.setSearchQuery('ship');
    const todoSection = harness.searchResults.children.find(section => section.dataset.sectionType === 'todo');
    const todoResult = todoSection.children[1];
    todoResult.closest = selector => selector === '.dashboard-search-result[data-search-action]'
        ? todoResult
        : null;
    harness.searchResults.dispatch('click', { target: todoResult });
    while (harness.frames.length) harness.frames.shift()();

    assert.deepEqual(toPlain(harness.messages.filter(message => message.type === 'todo-reveal')), [{
        type: 'todo-reveal', todoId: 'tsearch', groupId: 'group-a',
    }]);

    let focused = 0;
    const todoGroup = { classList: createClassList() };
    const todoItem = {
        isConnected: true,
        getAttribute: name => name === 'data-todo-id' ? 'tsearch' : null,
        setAttribute: () => undefined,
        removeAttribute: () => undefined,
        closest: selector => selector === '.todo-group' ? todoGroup : null,
        scrollIntoView: () => undefined,
        focus: () => {
            focused += 1;
            harness.context.document.activeElement = todoItem;
        },
        addEventListener: () => undefined,
    };
    harness.todoPanel.querySelectorAll = selector => selector === '.todo-item[data-todo-id]' ? [todoItem] : [];
    harness.controller.applyTodoPanelUpdatedMessage({
        type: 'todo-panel-updated', version: 1, html: '<p>revealed</p>', searchCatalog: makeCatalog('search'),
    });
    while (harness.frames.length) harness.frames.shift()();
    assert.equal(focused, 1);
    assert.equal(harness.context.document.activeElement, todoItem);
});

function createProjectVm({ querySelector, querySelectorAll, activeElement, source = projectSource } = {}) {
    const documentListeners = {};
    const windowListeners = {};
    const messages = [];
    const replacedCatalogs = [];
    let webviewState = { unrelated: 'preserved' };
    const context = {
        normalizeDashboardSearchCatalog: value => value
            && Array.isArray(value.sessions)
            && Array.isArray(value.openProjects)
            && Array.isArray(value.savedProjects)
            && Array.isArray(value.todos)
            ? value
            : { sessions: [], openProjects: [], savedProjects: [], todos: [] },
        document: {
            activeElement: activeElement || null,
            body: {
                classList: createClassList(),
                style: { setProperty: () => undefined },
            },
            addEventListener: (type, listener) => { documentListeners[type] = listener; },
            getElementById: () => null,
            createElement: () => ({
                className: '',
                setAttribute: () => undefined,
                remove: () => undefined,
            }),
            querySelector: selector => querySelector ? querySelector(selector) : null,
            querySelectorAll: selector => querySelectorAll ? querySelectorAll(selector) : [],
        },
        window: {
            innerWidth: 1024,
            innerHeight: 768,
            addEventListener: (type, listener) => { windowListeners[type] = listener; },
            requestAnimationFrame: callback => callback(),
            setTimeout: callback => callback(),
            vscode: {
                postMessage: message => messages.push(message),
                getState: () => webviewState,
                setState: state => { webviewState = state; },
            },
            __projectStewardDashboard: {
                replaceSearchCatalog: catalog => replacedCatalogs.push(catalog),
                getActiveTab: () => 'open',
            },
        },
    };
    vm.runInNewContext(source, context);
    context.initProjects();
    messages.length = 0;
    return { context, documentListeners, windowListeners, messages, replacedCatalogs, getWebviewState: () => webviewState };
}

function assertCollapseButtonBehavior(context) {
    assert.deepEqual(toPlain(context.getCollapseButtonState('open', [])), {
        disabled: true, collapsed: false, title: 'No other windows to collapse',
    });
    assert.equal(context.getCollapseButtonState('open', [false]).title, 'Collapse Other Windows');
    assert.equal(context.getCollapseButtonState('open', [true]).title, 'Expand Other Windows');
    assert.equal(context.getCollapseButtonState('projects', [false, true]).title, 'Collapse All Groups');
    assert.equal(context.getCollapseButtonState('todo', [true, true]).title, 'Expand TODO Groups');
}

test('WEBVIEW-COLLAPSE-BUTTON-STATE-001 exposes disabled and exact action labels for each dashboard tab', () => {
    assertCollapseButtonBehavior(createProjectVm().context);
    const mutated = projectSource.replace('No other windows to collapse', 'Nothing to collapse');
    assert.throws(() => assertCollapseButtonBehavior(createProjectVm({ source: mutated }).context));
});

test('WEBVIEW-BATCH-AI-SESSION-WEBVIEW-001 rejects stale AI session update sequences', () => {
    const harness = createProjectVm();
    harness.windowListeners.message({ data: {
        type: 'ai-sessions-updated',
        version: 1,
        sequence: 2,
        openProjects: [],
        searchCatalog: makeCatalog('new'),
    } });
    harness.windowListeners.message({ data: {
        type: 'ai-sessions-updated',
        version: 1,
        sequence: 1,
        openProjects: [],
        searchCatalog: makeCatalog('stale'),
    } });

    assert.equal(harness.replacedCatalogs.length, 1);
    assert.equal(harness.replacedCatalogs[0].todos[0].todoId, 'tnew');
});

test('WEBVIEW-BATCH-AI-SESSION-WEBVIEW-001 requests full refresh when an incremental target is missing', () => {
    const harness = createProjectVm();
    harness.windowListeners.message({ data: {
        type: 'ai-sessions-updated',
        version: 1,
        sequence: 1,
        openProjects: [{
            projectId: 'missing',
            expanded: true,
            sessionSectionHtml: '<div class="codex-sessions"></div>',
        }],
        searchCatalog: makeCatalog(),
    } });
    assert.deepEqual(toPlain(harness.messages), [{
        type: 'request-full-refresh', reason: 'missing-open-project',
    }]);
    assert.deepEqual(harness.replacedCatalogs, []);
});

test('WEBVIEW-BATCH-AI-SESSION-WEBVIEW-001 maps ctrl meta and middle-click project modifiers', () => {
    const project = {
        getAttribute: name => name === 'data-id' ? 'saved-project' : null,
        hasAttribute: () => false,
    };
    const target = {
        closest(selector) {
            return selector === '.project' || selector === '.project[data-id]' ? project : null;
        },
    };
    const harness = createProjectVm();
    harness.documentListeners.click({ button: 0, ctrlKey: true, metaKey: false, target });
    harness.documentListeners.click({ button: 0, ctrlKey: false, metaKey: true, target });
    harness.documentListeners.mousedown({ button: 1, ctrlKey: false, metaKey: false, target });

    assert.deepEqual(toPlain(harness.messages), [
        { type: 'selected-project', projectId: 'saved-project', projectOpenType: 3 },
        { type: 'selected-project', projectId: 'saved-project', projectOpenType: 3 },
        { type: 'selected-project', projectId: 'saved-project', projectOpenType: 1 },
    ]);
});

function createTodoEditHarness() {
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
    const segment = { querySelectorAll: selector => selector === '.todo-priority-choice' ? choices : [] };
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
    const list = {
        classList: createClassList(['has-editing-item']),
        style: { setProperty: () => undefined },
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
    };
    const expandButton = createElement();
    const item = {
        classList: createClassList(['editing', 'expanded']),
        attributes: new Map([['data-expanded-before-edit', 'false']]),
        offsetHeight: 58,
        getAttribute(name) {
            if (name === 'data-todo-id') return 'todo-a';
            return this.attributes.has(name) ? this.attributes.get(name) : null;
        },
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        removeAttribute(name) { this.attributes.delete(name); },
        querySelector(selector) {
            if (selector === '.todo-item-view') return { hidden: false };
            if (selector === '.todo-edit-form') return form;
            if (selector === '[data-action="todo-toggle-expanded"]') return expandButton;
            if (selector === '.todo-title-text') return { textContent: 'Initial title' };
            return null;
        },
        closest: selector => selector === '.todo-list' ? list : null,
        scrollIntoView: () => undefined,
    };
    return { title, notes, priorities, choices, form, list, item };
}

test('TODO-TODO-EDIT-RESET-INTERACTION-001 cancel restores rendered edit values and expansion state', () => {
    const edit = createTodoEditHarness();
    const harness = createProjectVm({
        querySelectorAll: selector => selector === '.todo-item[data-todo-id]' ? [edit.item] : [],
    });
    edit.title.value = 'Draft';
    edit.notes.value = 'Draft notes';
    edit.priorities[1].checked = false;
    edit.priorities[2].checked = true;
    const cancelAction = {
        getAttribute: name => name === 'data-todo-id' ? 'todo-a' : null,
    };
    const target = {
        closest: selector => selector === '[data-action="todo-cancel-edit"]' ? cancelAction : null,
    };

    harness.documentListeners.click({ button: 0, target });
    assert.equal(edit.title.value, 'Initial title');
    assert.equal(edit.notes.value, 'Initial notes');
    assert.deepEqual(edit.priorities.map(input => input.checked), [false, true, false]);
    assert.deepEqual(edit.choices.map(choice => choice.classList.contains('active')), [false, true, false]);
    assert.equal(edit.item.classList.contains('editing'), false);
    assert.equal(edit.item.classList.contains('expanded'), false);
    assert.equal(edit.item.getAttribute('data-expanded-before-edit'), null);
});

function createComposeForm() {
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
    return {
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
            if (checked) return controls[checked[1]] && controls[checked[1]].checked ? controls[checked[1]] : null;
            const named = selector.match(/^\[name="([^"]+)"\]$/);
            return named ? controls[named[1]] || null : null;
        },
    };
}

test('TODO-TODO-COMPOSE-PENDING-INTERACTION-001 locks rapid submits and settles failure acknowledgements', () => {
    const form = createComposeForm();
    const harness = createProjectVm({
        querySelector: selector => selector === '.todo-add-form[data-todo-request-id="1"]' ? form : null,
    });
    const event = {
        preventDefault: () => undefined,
        target: { closest: selector => selector === '.todo-add-form' ? form : null },
    };
    harness.documentListeners.submit(event);
    harness.documentListeners.submit(event);

    assert.deepEqual(toPlain(harness.messages), [{
        type: 'todo-add', requestId: 1, title: 'Draft todo', notes: 'Draft notes',
        priority: 'high', groupId: 'group-a',
    }]);
    assert.equal(form.submitButton.disabled, true);
    assert.equal(form.submitButton.getAttribute('aria-busy'), 'true');

    harness.windowListeners.message({ data: {
        type: 'todo-mutation-result', version: 1, requestId: 1, success: false,
    } });
    assert.equal(form.submitButton.disabled, false);
    assert.equal(form.submitButton.getAttribute('aria-busy'), null);
    assert.equal(form.controls.title.value, 'Draft todo');
});

test('TODO-TODO-COMPOSE-PENDING-INTERACTION-001 clears committed input when only panel refresh fails', () => {
    const form = createComposeForm();
    const harness = createProjectVm({
        querySelector: selector => selector === '.todo-add-form[data-todo-request-id="1"]' ? form : null,
    });
    harness.documentListeners.submit({
        preventDefault: () => undefined,
        target: { closest: selector => selector === '.todo-add-form' ? form : null },
    });
    harness.windowListeners.message({ data: {
        type: 'todo-mutation-result', version: 1, requestId: 1, success: true, panelRefreshed: false,
    } });
    assert.equal(form.submitButton.disabled, false);
    assert.equal(form.controls.title.value, '');
    assert.equal(form.controls.notes.value, '');
});

function createDndHarness({ projectContainers = [], todoGroups = [], todoLists = [], groupElements = [] } = {}) {
    const drakes = [];
    const messages = [];
    const windowListeners = {};
    const context = {
        document: {
            body: { classList: createClassList() },
            querySelector: () => null,
            querySelectorAll: () => [],
        },
        window: {
            addEventListener: (type, listener) => { windowListeners[type] = listener; },
            removeEventListener: () => undefined,
            vscode: { postMessage: message => messages.push(message) },
        },
        dragula(containers, options) {
            const handlers = {};
            const drake = {
                dragging: false,
                cancel: () => undefined,
                destroy: () => undefined,
                on(type, listener) {
                    handlers[type] = listener;
                    return drake;
                },
            };
            drakes.push({ containers, options, handlers, drake });
            return drake;
        },
        autoScroll: () => ({ destroy: () => undefined }),
    };
    vm.runInNewContext(dndSource, context);
    const rootElement = {
        querySelector: () => null,
        querySelectorAll(selector) {
            if (selector === '.group-list') return projectContainers;
            if (selector === '.groups-wrapper') return [{}];
            if (selector === '.todo-groups') return todoGroups;
            if (selector === '.todo-list') return todoLists;
            if (selector === '.todo-groups > .todo-group[data-todo-group-id]') return groupElements;
            if (selector === '.groups-wrapper > [data-group-id]:not([data-virtual-group])') return groupElements;
            return [];
        },
    };
    return { context, rootElement, drakes, messages, windowListeners };
}

test('WEBVIEW-FAVORITE-DND-001 limits favorite drag to the same virtual container and posts exact order', () => {
    const favorites = {
        closest(selector) {
            if (selector === '[data-system-group="__favorites"]') return {};
            if (selector === '[data-virtual-group]') return {};
            return null;
        },
        querySelectorAll: () => [
            { getAttribute: () => 'favorite-b' },
            { getAttribute: () => 'favorite-a' },
        ],
    };
    const otherFavorites = { ...favorites };
    const ordinary = { closest: () => null };
    const draggable = { hasAttribute: () => false };
    const noDrag = { hasAttribute: name => name === 'data-nodrag' };
    const harness = createDndHarness({ projectContainers: [favorites, ordinary] });

    assert.equal(harness.context.canMoveProject(draggable, favorites), true);
    assert.equal(harness.context.canMoveProject(noDrag, favorites), false);
    assert.equal(harness.context.canAcceptProject(favorites, favorites), true);
    assert.equal(harness.context.canAcceptProject(otherFavorites, favorites), false);
    assert.equal(harness.context.canAcceptProject(ordinary, favorites), false);

    harness.context.initDnD(harness.rootElement);
    harness.context.initDnD(harness.rootElement);
    assert.equal(harness.rootElement.__projectStewardDnDInitialized, true);
    assert.equal(harness.drakes.length, 2);
    harness.drakes[0].handlers.drop({}, favorites, favorites);
    assert.deepEqual(toPlain(harness.messages), [{
        type: 'reordered-favorites', projectIds: ['favorite-b', 'favorite-a'],
    }]);
});

test('TODO-TODO-ORDERING-INTERACTION-001 constrains TODO drag state and posts exact DOM order', () => {
    const todoGroupsContainer = { matches: selector => selector === '.todo-groups' };
    const todoList = {
        matches: selector => selector === '.todo-list',
        closest: selector => selector === '.todo-group[data-todo-group-id]'
            ? { getAttribute: () => 'group-a' }
            : null,
        querySelectorAll: () => [
            { getAttribute: () => 'todo-b' },
            { getAttribute: () => 'todo-a' },
        ],
    };
    const groupElements = ['group-b', 'group-a'].map(id => ({
        getAttribute: () => id,
    }));
    const harness = createDndHarness({
        todoGroups: [todoGroupsContainer],
        todoLists: [todoList],
        groupElements,
    });

    const todoGroupElement = { matches: selector => selector === '.todo-group' };
    const todoItemElement = { matches: selector => selector === '.todo-item' };
    const groupHandle = { closest: selector => selector === '[data-drag-todo-group]' ? {} : null };
    const itemHandle = { closest: () => null };
    assert.equal(harness.context.canMoveTodoGroup(todoGroupElement, todoGroupsContainer, groupHandle), true);
    assert.equal(harness.context.canAcceptTodoGroup(todoGroupsContainer, todoGroupsContainer), true);
    assert.equal(harness.context.canMoveTodoItem(todoItemElement, todoList, itemHandle), true);
    assert.equal(harness.context.canAcceptTodoItem(todoList, todoList), true);
    assert.equal(harness.context.canAcceptTodoItem({ matches: () => true }, todoList), false);
    assert.deepEqual(
        toPlain(harness.context.getTodoGroupIds({ querySelectorAll: () => groupElements })),
        ['group-b', 'group-a']
    );

    harness.context.initDnD(harness.rootElement);
    assert.equal(harness.drakes.length, 4);
    harness.drakes[2].handlers.drop();
    harness.drakes[3].handlers.drop({}, todoList, todoList);
    assert.deepEqual(toPlain(harness.messages), [
        { type: 'todo-reorder-groups', groupIds: ['group-b', 'group-a'] },
        { type: 'todo-reorder-items', groupId: 'group-a', todoIds: ['todo-b', 'todo-a'] },
    ]);

    harness.context.disposeDnD(harness.rootElement);
    assert.equal(harness.rootElement.__projectStewardDnDInitialized, undefined);
    assert.equal(harness.rootElement.__projectStewardDnD, undefined);
});
