'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.join(__dirname, '../../../src/webview/webviewTodoScripts.js'),
    'utf8'
);
const projectSource = fs.readFileSync(
    path.join(__dirname, '../../../src/webview/webviewProjectScripts.js'),
    'utf8'
);
const dashboardSource = fs.readFileSync(
    path.join(__dirname, '../../../src/webview/webviewDashboardScripts.js'),
    'utf8'
);
const dndSource = fs.readFileSync(
    path.join(__dirname, '../../../src/webview/webviewDnDScripts.js'),
    'utf8'
);
const NOW = '2026-07-24T00:00:00.000Z';

function snapshot() {
    return {
        version: 1,
        showCompleted: false,
        data: {
            version: 1,
            groups: [{ id: 'group-a', title: 'Planning', collapsed: false, order: 0 }],
            todos: [{
                id: 'todo-a',
                groupId: 'group-a',
                title: 'A complete title that must never disappear',
                notes: 'Every line of the full notes belongs in detail.',
                priority: 'medium',
                completed: false,
                createdAt: NOW,
                updatedAt: NOW,
                order: 0,
            }, {
                id: 'todo-b',
                groupId: 'group-a',
                title: 'Second task',
                notes: '',
                priority: 'low',
                completed: false,
                createdAt: NOW,
                updatedAt: NOW,
                order: 1,
            }],
        },
    };
}

function createHarness(options = {}) {
    const messages = [];
    const catalogs = [];
    const listeners = {};
    let focusedTodoId;
    let renderedCount = 0;
    let layoutVisible = options.layoutVisible !== false;
    let expandedTodoHeight = 180;
    let resizeObserverCallback;
    const todoNodes = new Map(['todo-a', 'todo-b'].map(todoId => [todoId, {
        className: '',
        innerHTML: '',
        hidden: false,
        get offsetHeight() {
            if (!layoutVisible) return 0;
            return this.className.includes('expanded') ? expandedTodoHeight : 58;
        },
    }]));
    const summaryMeta = { textContent: '' };
    const groupCount = { textContent: '' };
    const hiddenCompleted = { textContent: '', hidden: true };
    const emptyState = { hidden: true };
    const todoList = {
        hidden: false,
        style: {
            properties: {},
            setProperty(name, value) {
                this.properties[name] = value;
            },
        },
        appendChild() {},
        insertBefore() {},
        insertAdjacentHTML() {},
        querySelector(selector) {
            const match = selector.match(/data-todo-id="([^"]+)"/);
            return match ? todoNodes.get(match[1]) || null : null;
        },
        querySelectorAll(selector) {
            if (selector === '.todo-item.expanded') {
                return Array.from(todoNodes.values()).filter(node =>
                    node.className.includes('expanded')
                );
            }
            return [];
        },
    };
    todoNodes.forEach(node => { node.parentElement = todoList; });
    const groupClasses = new Set(['todo-group']);
    const groupButton = {
        attributes: {},
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
    };
    const groupNode = {
        classList: {
            toggle(name, enabled) {
                if (enabled) groupClasses.add(name);
                else groupClasses.delete(name);
            },
        },
        querySelector(selector) {
            if (selector === '[data-action="todo-collapse-group"]') return groupButton;
            if (selector === '.todo-group-count') return groupCount;
            if (selector === '.todo-list') return todoList;
            if (selector === '.todo-hidden-completed') return hiddenCompleted;
            if (selector === '.todo-group-empty') return emptyState;
            return null;
        },
        insertAdjacentHTML() {
            hiddenCompleted.hidden = false;
        },
    };
    const undoRegion = { hidden: true, style: {}, innerHTML: '' };
    const liveRegion = { textContent: '' };
    const root = {
        innerHTML: '',
        addEventListener(type, listener) {
            listeners[type] = listener;
        },
        removeEventListener() {},
        dispatch(type, event) {
            return listeners[type] && listeners[type](event);
        },
        querySelector(selector) {
            if (options.targetedPatches && selector === '.todo-undo-region') return undoRegion;
            if (options.targetedPatches && selector === '.todo-live-region') return liveRegion;
            if (options.targetedPatches && selector === '.todo-summary-meta') return summaryMeta;
            if (options.targetedPatches && selector.startsWith('.todo-item[')) {
                const todoMatch = selector.match(/data-todo-id="([^"]+)"/);
                return todoMatch ? todoNodes.get(todoMatch[1]) || null : null;
            }
            if (options.targetedPatches && selector.startsWith('.todo-group[')) return groupNode;
            const match = selector.match(/data-todo-id="([^"]+)"/);
            if (!match) return null;
            return {
                focus() {
                    focusedTodoId = match[1];
                },
            };
        },
        querySelectorAll(selector) {
            return options.targetedPatches && selector === '.todo-list' ? [todoList] : [];
        },
    };
    const panel = {
        querySelector(selector) {
            return selector === '.todo-panel' ? root : null;
        },
    };
    const context = {
        console,
        Map,
        JSON,
        Date,
        Number,
        Object,
        Array,
        String,
        Math,
        ResizeObserver: class {
            constructor(callback) {
                resizeObserverCallback = callback;
            }
            observe() {}
            disconnect() {}
        },
        getComputedStyle: () => ({
            getPropertyValue(name) {
                return name === '--todo-collapsed-item-height' ? '58px' : '';
            },
        }),
        setTimeout: callback => {
            context.pendingTimer = callback;
            return 1;
        },
        clearTimeout: () => undefined,
        document: { activeElement: null },
        window: {
            scrollY: 240,
            addEventListener(type, listener) {
                listeners[`window:${type}`] = listener;
            },
            scrollTo(_x, y) {
                this.scrollY = y;
            },
        },
    };
    vm.runInNewContext(source, context, { filename: 'webviewTodoScripts.js' });
    const controller = context.initTodos({
        postMessage: message => messages.push(JSON.parse(JSON.stringify(message))),
        replaceSearchCatalog: catalog => catalogs.push(JSON.parse(JSON.stringify(catalog))),
        onRendered: () => {
            renderedCount += 1;
        },
    });
    controller.mount(panel, options.snapshot || snapshot());
    return {
        context,
        controller,
        root,
        panel,
        messages,
        catalogs,
        getFocusedTodoId: () => focusedTodoId,
        getRenderedCount: () => renderedCount,
        getTodoNode: todoId => todoNodes.get(todoId),
        groupButton,
        groupClasses,
        summaryMeta,
        groupCount,
        hiddenCompleted,
        emptyState,
        todoList,
        setLayoutVisible: visible => {
            layoutVisible = visible;
        },
        setExpandedTodoHeight: height => {
            expandedTodoHeight = height;
        },
        notifyResize: () => {
            if (resizeObserverCallback) resizeObserverCallback();
        },
    };
}

test('TODO-FOCUSED-DETAIL-001 reveals complete values inline and toggles without replacing list context', () => {
    const harness = createHarness();
    harness.controller.openDetail('todo-a');
    assert.match(harness.root.innerHTML, /class="todo-list-surface"/);
    assert.doesNotMatch(harness.root.innerHTML, /class="todo-list-surface" hidden/);
    assert.match(harness.root.innerHTML, /class="todo-inline-detail"/);
    assert.match(harness.root.innerHTML, /A complete title that must never disappear/);
    assert.match(harness.root.innerHTML, /Every line of the full notes belongs in detail/);
    assert.match(
        harness.root.innerHTML,
        />Notes<[\s\S]*>Group<[\s\S]*>Priority<[\s\S]*>Created<[\s\S]*>Updated</
    );
    assert.equal(harness.context.window.scrollY, 240);

    assert.equal(harness.controller.openDetail('todo-a'), true);
    assert.equal(harness.controller.getState().selectedTodoId, 'todo-a');
    assert.equal(harness.controller.toggleDetail('todo-a'), true);
    assert.equal(harness.controller.getState().selectedTodoId, null);
    assert.doesNotMatch(harness.root.innerHTML, /class="todo-inline-detail"/);
    assert.equal(harness.context.window.scrollY, 240);
    assert.equal(harness.getFocusedTodoId(), 'todo-a');
});

test('TODO-INCREMENTAL-ROOT-001 accepts command results without replacing the panel root', () => {
    const harness = createHarness();
    const root = harness.panel.querySelector('.todo-panel');
    harness.controller.applyCommandResult({
        type: 'todo-command-result',
        version: 2,
        requestId: 1,
        revision: 1,
        success: true,
        snapshot: snapshot(),
        searchCatalog: {
            version: 2, sessions: [], openWorkspaces: [], savedProjects: [], todos: [],
        },
    });

    assert.equal(harness.panel.querySelector('.todo-panel'), root);
    assert.equal(harness.catalogs.length, 1);
});

test('TODO-OPTIMISTIC-ROLLBACK-001 posts versioned completion and restores the authoritative failure snapshot', () => {
    const harness = createHarness();
    harness.controller.dispatch('complete', { todoId: 'todo-a', completed: true });
    assert.deepEqual(harness.messages[0], {
        type: 'todo-command',
        version: 2,
        requestId: 1,
        action: 'complete',
        payload: { todoId: 'todo-a', completed: true },
    });
    assert.equal(harness.controller.getState().snapshot.data.todos[0].completed, true);

    harness.controller.applyCommandResult({
        type: 'todo-command-result',
        version: 2,
        requestId: 1,
        revision: 1,
        success: false,
        errorCode: 'storage',
        snapshot: snapshot(),
    });
    assert.equal(harness.controller.getState().snapshot.data.todos[0].completed, false);
    assert.match(harness.root.innerHTML, /Could not save the TODO change/);
});

test('TODO-INCREMENTAL-ROOT-001 does not redraw an optimistic surface again for its matching acknowledgement', () => {
    const harness = createHarness();
    harness.controller.dispatch('complete', { todoId: 'todo-a', completed: true });
    const rendersAfterOptimisticChange = harness.getRenderedCount();
    const saved = snapshot();
    saved.data.todos[0].completed = true;
    saved.data.todos[0].completedAt = NOW;

    harness.controller.applyCommandResult({
        type: 'todo-command-result',
        version: 2,
        requestId: 1,
        revision: 1,
        success: true,
        snapshot: saved,
        undoToken: 'undo-complete',
    });

    assert.equal(harness.getRenderedCount(), rendersAfterOptimisticChange);
    assert.equal(harness.controller.getState().announcement, 'TODO saved');
    assert.equal(harness.controller.getState().undo.token, 'undo-complete');
});

test('TODO-INCREMENTAL-ROOT-001 patches inline details and group disclosure without rebuilding the surface', () => {
    const harness = createHarness({ targetedPatches: true });
    const mountedRenders = harness.getRenderedCount();

    harness.controller.toggleDetail('todo-a');
    assert.equal(harness.getRenderedCount(), mountedRenders);
    assert.match(harness.getTodoNode('todo-a').innerHTML, /class="todo-inline-detail"/);

    harness.controller.toggleDetail('todo-a');
    assert.equal(harness.getRenderedCount(), mountedRenders);
    assert.doesNotMatch(harness.getTodoNode('todo-a').innerHTML, /class="todo-inline-detail"/);

    harness.controller.dispatch('collapse-group', { groupId: 'group-a', collapsed: true });
    assert.equal(harness.getRenderedCount(), mountedRenders);
    assert.equal(harness.groupClasses.has('collapsed'), true);
    assert.equal(harness.groupButton.attributes['aria-expanded'], 'false');
});

test('TODO-MAX-VISIBLE-PER-GROUP-001 expands the current group viewport without replacing its root', () => {
    const harness = createHarness({ targetedPatches: true });
    const root = harness.root;
    const mountedRenders = harness.getRenderedCount();

    harness.controller.toggleDetail('todo-a');

    assert.equal(harness.root, root);
    assert.equal(harness.getRenderedCount(), mountedRenders);
    assert.equal(
        harness.todoList.style.properties['--todo-list-expanded-extra-height'],
        '122px'
    );
});

test('TODO-MAX-VISIBLE-PER-GROUP-001 remeasures an inline detail when its hidden tab becomes visible', () => {
    const harness = createHarness({ targetedPatches: true, layoutVisible: false });

    harness.controller.toggleDetail('todo-a');
    assert.equal(
        harness.todoList.style.properties['--todo-list-expanded-extra-height'],
        '0px'
    );

    harness.setLayoutVisible(true);
    harness.notifyResize();

    assert.equal(
        harness.todoList.style.properties['--todo-list-expanded-extra-height'],
        '122px'
    );
});

test('TODO-MAX-VISIBLE-PER-GROUP-001 remeasures wrapped inline detail after sidebar resize', () => {
    const harness = createHarness({ targetedPatches: true });
    harness.controller.toggleDetail('todo-a');
    assert.equal(
        harness.todoList.style.properties['--todo-list-expanded-extra-height'],
        '122px'
    );

    harness.setExpandedTodoHeight(220);
    harness.notifyResize();

    assert.equal(
        harness.todoList.style.properties['--todo-list-expanded-extra-height'],
        '162px'
    );
});

test('TODO-COMPLETION-INCREMENTAL-001 completes one card without rebuilding the list surface', () => {
    const harness = createHarness({ targetedPatches: true });
    const mountedRenders = harness.getRenderedCount();
    const siblingBefore = harness.getTodoNode('todo-b');

    harness.controller.dispatch('complete', { todoId: 'todo-a', completed: true });

    assert.equal(harness.getRenderedCount(), mountedRenders);
    assert.equal(harness.getTodoNode('todo-a').hidden, true);
    assert.equal(harness.getTodoNode('todo-b'), siblingBefore);
    assert.equal(harness.summaryMeta.textContent, '1 open · 1 group · completed hidden');
    assert.equal(harness.groupCount.textContent, '1 open');
    assert.equal(harness.hiddenCompleted.textContent, '1 completed hidden');
    assert.match(dndSource, /:scope > \.todo-item\[data-todo-id\]:not\(\[hidden\]\)/);

    const saved = snapshot();
    saved.data.todos[0].completed = true;
    saved.data.todos[0].completedAt = NOW;
    harness.controller.applyCommandResult({
        type: 'todo-command-result',
        version: 2,
        requestId: 1,
        revision: 1,
        success: true,
        snapshot: saved,
    });

    assert.equal(harness.getRenderedCount(), mountedRenders);
    assert.equal(harness.getTodoNode('todo-a').hidden, true);
    assert.equal(harness.getTodoNode('todo-b'), siblingBefore);
});

test('TODO-COMPLETION-INCREMENTAL-001 patches the authoritative completion time in an open card', () => {
    const showingCompleted = snapshot();
    showingCompleted.showCompleted = true;
    const harness = createHarness({
        snapshot: showingCompleted,
        targetedPatches: true,
    });
    harness.controller.openDetail('todo-a');
    const mountedRenders = harness.getRenderedCount();

    harness.controller.dispatch('complete', { todoId: 'todo-a', completed: true });
    const saved = snapshot();
    saved.showCompleted = true;
    saved.data.todos[0].completed = true;
    saved.data.todos[0].completedAt = NOW;
    saved.data.todos[0].updatedAt = NOW;
    harness.controller.applyCommandResult({
        type: 'todo-command-result',
        version: 2,
        requestId: 1,
        revision: 1,
        success: true,
        snapshot: saved,
    });

    assert.equal(harness.getRenderedCount(), mountedRenders);
    assert.equal(harness.controller.getState().selectedTodoId, 'todo-a');
    assert.match(harness.getTodoNode('todo-a').innerHTML, /2026-07-24/);
});

test('TODO-COMPLETION-INCREMENTAL-001 renders a concurrent sibling change from the authoritative ACK', () => {
    const harness = createHarness({ targetedPatches: true });
    const mountedRenders = harness.getRenderedCount();

    harness.controller.dispatch('complete', { todoId: 'todo-a', completed: true });
    const saved = snapshot();
    saved.data.todos[0].completed = true;
    saved.data.todos[0].completedAt = NOW;
    saved.data.todos[0].updatedAt = NOW;
    saved.data.todos[1].title = 'Changed in another window';
    harness.controller.applyCommandResult({
        type: 'todo-command-result',
        version: 2,
        requestId: 1,
        revision: 1,
        success: true,
        snapshot: saved,
    });

    assert.equal(harness.getRenderedCount(), mountedRenders + 1);
    assert.match(harness.root.innerHTML, /Changed in another window/);
});

test('TODO-FOCUSED-DETAIL-001 lets search reveal hidden or collapsed todos before opening inline details', () => {
    const hiddenCompleted = snapshot();
    hiddenCompleted.data.todos[0].completed = true;
    hiddenCompleted.data.todos[0].completedAt = NOW;
    const hiddenHarness = createHarness({ snapshot: hiddenCompleted });
    assert.equal(hiddenHarness.controller.openDetail('todo-a'), false);
    assert.equal(hiddenHarness.controller.getState().selectedTodoId, null);

    const collapsed = snapshot();
    collapsed.data.groups[0].collapsed = true;
    const collapsedHarness = createHarness({ snapshot: collapsed });
    assert.equal(collapsedHarness.controller.openDetail('todo-a'), false);
    assert.equal(collapsedHarness.controller.getState().selectedTodoId, null);

    hiddenCompleted.revealedTodoId = 'todo-a';
    const revealedHarness = createHarness({ snapshot: hiddenCompleted });
    assert.equal(revealedHarness.controller.openDetail('todo-a'), true);
    assert.equal(revealedHarness.controller.getState().selectedTodoId, 'todo-a');
});

test('TODO-INCREMENTAL-ROOT-001 rebases later optimistic changes over an earlier acknowledgement', () => {
    const harness = createHarness();
    harness.controller.dispatch('complete', { todoId: 'todo-a', completed: true });
    harness.controller.dispatch('complete', { todoId: 'todo-b', completed: true });
    const rendersAfterBothChanges = harness.getRenderedCount();

    const firstSaved = snapshot();
    firstSaved.data.todos[0].completed = true;
    firstSaved.data.todos[0].completedAt = NOW;
    harness.controller.applyCommandResult({
        type: 'todo-command-result',
        version: 2,
        requestId: 1,
        revision: 1,
        success: true,
        snapshot: firstSaved,
    });

    assert.equal(harness.controller.getState().snapshot.data.todos[0].completed, true);
    assert.equal(harness.controller.getState().snapshot.data.todos[1].completed, true);
    assert.equal(harness.getRenderedCount(), rendersAfterBothChanges);
});

test('TODO-STALE-RESULT-001 rejects stale revisions and posts Undo exactly once', () => {
    const harness = createHarness();
    harness.controller.applyCommandResult({
        type: 'todo-command-result', version: 2, requestId: 2, revision: 2,
        success: true, snapshot: snapshot(), undoToken: 'undo-a',
    });
    const accepted = harness.controller.getState().lastRevision;
    assert.equal(harness.controller.applyCommandResult({
        type: 'todo-command-result', version: 2, requestId: 1, revision: 1,
        success: true, snapshot: snapshot(),
    }), false);
    assert.equal(harness.controller.getState().lastRevision, accepted);

    harness.controller.undo();
    harness.controller.undo();
    assert.equal(harness.messages.filter(message => message.action === 'undo').length, 1);
});

test('TODO-QUICK-CREATE-001 refuses empty titles and dispatches trimmed group-local tasks', () => {
    const harness = createHarness();
    assert.equal(harness.controller.submitQuickAdd('group-a', '   '), false);
    assert.equal(harness.messages.length, 0);
    assert.equal(harness.controller.submitQuickAdd('group-a', '  Ship it  '), true);
    assert.deepEqual(harness.messages[0].payload, {
        title: 'Ship it',
        notes: '',
        priority: 'medium',
        groupId: 'group-a',
    });
});

test('TODO-TODO-ORDERING-INTERACTION-001 keeps the dropped task order while the host persists it', () => {
    const harness = createHarness();
    harness.controller.dispatch('reorder-items', {
        groupId: 'group-a',
        todoIds: ['todo-b', 'todo-a'],
    });
    assert.deepEqual(
        JSON.parse(JSON.stringify(harness.controller.getState().snapshot.data.todos))
            .sort((left, right) => left.order - right.order)
            .map(todo => todo.id),
        ['todo-b', 'todo-a']
    );
});

test('TODO-FOCUSED-DETAIL-001 preserves an unsaved detail draft across unrelated results', () => {
    const harness = createHarness();
    harness.controller.openDetail('todo-a');
    const editAction = {
        getAttribute(name) {
            return name === 'data-action' ? 'todo-edit-detail' : null;
        },
    };
    harness.root.dispatch('click', {
        target: {
            closest(selector) {
                return selector === '[data-action]' ? editAction : null;
            },
        },
    });
    const titleField = {
        value: 'A locally edited draft',
        getAttribute(name) {
            return name === 'name' ? 'title' : null;
        },
        closest(selector) {
            return selector === '.todo-detail-edit-form' ? {} : null;
        },
    };
    harness.root.dispatch('input', { target: titleField });
    const rendersAfterTyping = harness.getRenderedCount();
    harness.controller.applyCommandResult({
        type: 'todo-command-result',
        version: 2,
        requestId: 99,
        revision: 1,
        success: true,
        snapshot: snapshot(),
    });

    assert.equal(harness.controller.getState().draft.title, 'A locally edited draft');
    assert.equal(harness.getRenderedCount(), rendersAfterTyping);
});

test('TODO-FOCUSED-DETAIL-001 keeps inline editing open when form whitespace is clicked', () => {
    const harness = createHarness();
    harness.controller.openDetail('todo-a');
    const editAction = {
        getAttribute(name) {
            return name === 'data-action' ? 'todo-edit-detail' : null;
        },
    };
    harness.root.dispatch('click', {
        target: {
            closest(selector) {
                return selector === '[data-action]' ? editAction : null;
            },
        },
    });
    const item = {
        getAttribute(name) {
            return name === 'data-todo-id' ? 'todo-a' : null;
        },
    };
    const form = {};
    harness.root.dispatch('click', {
        target: {
            closest(selector) {
                if (selector === '[data-action]') return null;
                if (selector === '.todo-item[data-todo-id]') return item;
                if (selector === '.todo-inline-detail') return form;
                return null;
            },
        },
    });

    assert.equal(harness.controller.getState().selectedTodoId, 'todo-a');
    assert.ok(harness.controller.getState().draft);
});

test('TODO-INCREMENTAL-ROOT-001 isolates mounted TODO events from the legacy project controller', () => {
    assert.match(projectSource, /isDedicatedTodoTarget/);
    assert.match(projectSource, /window\.__projectStewardTodo/);
    assert.match(dashboardSource, /options\.onTodoMounted\(panels\.todo,\s*message\)/);
});
