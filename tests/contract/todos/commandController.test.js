'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { TodoCommandController } = require('../../../out/todos/commandController');
const { TodoService } = require('../../../out/todos/service');

const NOW = '2026-07-24T00:00:00.000Z';

function makeData() {
    return {
        version: 1,
        groups: [{ id: 'group-a', title: 'A', collapsed: false, order: 0 }],
        todos: [
            {
                id: 'todo-a', groupId: 'group-a', title: 'First', notes: '',
                priority: 'medium', completed: false, createdAt: NOW, updatedAt: NOW, order: 0,
            },
            {
                id: 'todo-b', groupId: 'group-a', title: 'Second', notes: 'Full notes',
                priority: 'high', completed: false, createdAt: NOW, updatedAt: NOW, order: 1,
            },
        ],
    };
}

function createHarness({ writeError, nowMs = () => 1_000 } = {}) {
    let data = makeData();
    let viewState = { showCompleted: false };
    const service = new TodoService({
        globalState: {
            get(key) {
                if (key === 'todos') return data;
                if (key === 'todoViewState') return viewState;
                return undefined;
            },
            async update(key, value) {
                if (writeError && key === 'todos') throw writeError;
                if (key === 'todos') data = value;
                if (key === 'todoViewState') viewState = value;
            },
        },
        configuration: { get: (_key, fallback) => fallback },
        useSettingsStorage: () => false,
        now: () => NOW,
        generateId: prefix => `${prefix}-new`,
    });
    let token = 0;
    let revealedTodoId;
    const controller = new TodoCommandController({
        service,
        getViewState: () => viewState,
        setShowCompleted: value => service.setShowCompleted(value),
        getRevealedTodoId: () => revealedTodoId,
        clearRevealedTodoId: () => { revealedTodoId = undefined; },
        nowMs,
        createUndoToken: () => `undo-${++token}`,
    });
    return { controller, service, getData: () => data, getViewState: () => viewState };
}

function command(requestId, action, payload = {}) {
    return { type: 'todo-command', version: 2, requestId, action, payload };
}

test('TODO-TODO-COMMAND-CONTROLLER-001 rejects malformed envelopes without a result', async () => {
    const { controller } = createHarness();
    assert.equal(await controller.handle(null), undefined);
    assert.equal(await controller.handle({ type: 'todo-command', version: 1 }), undefined);
    assert.equal(await controller.handle(command(0, 'complete')), undefined);
    assert.equal(await controller.handle(command(1, 'unknown')), undefined);
});

test('TODO-TODO-COMMAND-CONTROLLER-001 returns normalized snapshots and monotonic revisions', async () => {
    const { controller } = createHarness();
    const first = await controller.handle(command(1, 'complete', {
        todoId: 'todo-a',
        completed: true,
    }));
    const second = await controller.handle(command(2, 'show-completed', {
        showCompleted: true,
    }));

    assert.equal(first.success, true);
    assert.equal(first.revision, 1);
    assert.equal(first.snapshot.data.todos.find(todo => todo.id === 'todo-a').completed, true);
    assert.match(first.undoToken, /^undo-/);
    assert.equal(second.success, true);
    assert.equal(second.revision, 2);
    assert.equal(second.snapshot.showCompleted, true);
});

test('TODO-TODO-UNDO-001 restores deleted task identity and order before expiry', async () => {
    const { controller } = createHarness();
    const deleted = await controller.handle(command(1, 'delete', { todoId: 'todo-b' }));
    assert.deepEqual(deleted.snapshot.data.todos.map(todo => todo.id), ['todo-a']);

    const restored = await controller.handle(command(2, 'undo', {
        undoToken: deleted.undoToken,
    }));
    assert.equal(restored.success, true);
    assert.deepEqual(
        restored.snapshot.data.todos
            .slice().sort((left, right) => left.order - right.order)
            .map(todo => [todo.id, todo.title, todo.notes]),
        [['todo-a', 'First', ''], ['todo-b', 'Second', 'Full notes']]
    );
});

test('TODO-TODO-UNDO-001 restores the exact completion state before expiry', async () => {
    const { controller } = createHarness();
    const completed = await controller.handle(command(1, 'complete', {
        todoId: 'todo-a',
        completed: true,
    }));
    const restored = await controller.handle(command(2, 'undo', {
        undoToken: completed.undoToken,
    }));
    const todo = restored.snapshot.data.todos.find(item => item.id === 'todo-a');

    assert.equal(todo.completed, false);
    assert.equal(todo.completedAt, undefined);
    assert.equal(todo.updatedAt, NOW);
});

test('TODO-TODO-UNDO-001 rejects expired and already-consumed tokens without mutation', async () => {
    let currentMs = 1_000;
    const { controller } = createHarness({ nowMs: () => currentMs });
    const deleted = await controller.handle(command(1, 'delete', { todoId: 'todo-b' }));
    currentMs = 6_001;
    const expired = await controller.handle(command(2, 'undo', {
        undoToken: deleted.undoToken,
    }));
    const repeated = await controller.handle(command(3, 'undo', {
        undoToken: deleted.undoToken,
    }));

    assert.deepEqual(
        [expired.success, expired.errorCode, repeated.success, repeated.errorCode],
        [false, 'undo-expired', false, 'undo-expired']
    );
    assert.deepEqual(expired.snapshot.data.todos.map(todo => todo.id), ['todo-a']);
});

test('TODO-TODO-COMMAND-CONTROLLER-001 maps storage failures without losing the authoritative snapshot', async () => {
    const { controller } = createHarness({ writeError: new Error('disk full') });
    const result = await controller.handle(command(1, 'delete', { todoId: 'todo-b' }));

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'storage');
    assert.deepEqual(result.snapshot.data.todos.map(todo => todo.id), ['todo-a', 'todo-b']);
    assert.equal(result.undoToken, undefined);
});

test('TODO-TODO-COMMAND-CONTROLLER-001 distinguishes invalid input from missing tasks', async () => {
    const { controller } = createHarness();
    const invalid = await controller.handle(command(1, 'complete', {
        todoId: 'todo-a',
        completed: 'yes',
    }));
    const missing = await controller.handle(command(2, 'delete', {
        todoId: 'missing',
    }));

    assert.deepEqual(
        [invalid.success, invalid.errorCode, missing.success, missing.errorCode],
        [false, 'invalid', false, 'not-found']
    );
});

test('TODO-TODO-COMMAND-CONTROLLER-001 routes versioned commands through the production dashboard', () => {
    const dashboardSource = fs.readFileSync(
        path.join(__dirname, '../../../src/dashboard.ts'),
        'utf8'
    );

    assert.match(dashboardSource, /new TodoCommandController\s*\(/);
    assert.match(dashboardSource, /'todo-command': async e =>/);
    assert.match(dashboardSource, /todoCommandController\.handle\(e\)/);
    assert.match(dashboardSource, /provider\.postMessage\(\{\s*\.\.\.result,\s*searchCatalog:/);
});
