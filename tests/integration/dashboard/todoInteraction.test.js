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

function createHarness() {
    const messages = [];
    const catalogs = [];
    const listeners = {};
    let focusedTodoId;
    const root = {
        innerHTML: '',
        addEventListener(type, listener) {
            listeners[type] = listener;
        },
        removeEventListener() {},
        querySelector(selector) {
            const match = selector.match(/data-todo-id="([^"]+)"/);
            if (!match) return null;
            return {
                focus() {
                    focusedTodoId = match[1];
                },
            };
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
    });
    controller.mount(panel, snapshot());
    return { context, controller, root, panel, messages, catalogs, getFocusedTodoId: () => focusedTodoId };
}

test('TODO-FOCUSED-DETAIL-001 reveals complete values and restores list scroll and originating focus', () => {
    const harness = createHarness();
    harness.controller.openDetail('todo-a');
    assert.match(harness.root.innerHTML, /A complete title that must never disappear/);
    assert.match(harness.root.innerHTML, /Every line of the full notes belongs in detail/);

    harness.controller.backToList();
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

test('TODO-INCREMENTAL-ROOT-001 isolates mounted TODO events from the legacy project controller', () => {
    assert.match(projectSource, /isDedicatedTodoTarget/);
    assert.match(projectSource, /window\.__projectStewardTodo/);
    assert.match(dashboardSource, /options\.onTodoMounted\(panels\.todo,\s*message\)/);
});
