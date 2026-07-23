'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    UnsupportedTodoDataVersionError,
    buildTodoSearchItems,
    normalizeTodoData,
    normalizeTodoPriority,
} = require('../../../out/todos/types');
const { buildTodoViewModel } = require('../../../out/todos/viewModel');

const NOW = '2026-07-23T00:00:00.000Z';

function todo(id, groupId, overrides = {}) {
    return {
        id,
        groupId,
        title: id,
        notes: '',
        priority: 'medium',
        completed: false,
        createdAt: NOW,
        updatedAt: NOW,
        order: 0,
        ...overrides,
    };
}

test('TODO-TODO-STORE-001 normalizes empty and unversioned V1 data while rejecting future versions', () => {
    assert.deepEqual(normalizeTodoData(null), { version: 1, groups: [], todos: [] });
    assert.deepEqual(normalizeTodoData({ groups: [], todos: [] }), { version: 1, groups: [], todos: [] });
    assert.throws(
        () => normalizeTodoData({ version: 2, groups: [], todos: [] }),
        error => error instanceof UnsupportedTodoDataVersionError && error.version === 2
    );
});

test('TODO-TODO-STORE-001 sanitizes V1 fields and drops duplicate or orphaned records', () => {
    const normalized = normalizeTodoData({
        version: 1,
        groups: [
            { id: 'group-b', title: ' Backlog ', collapsed: true, order: 2 },
            { id: 'group-a', title: '', collapsed: false, order: 1 },
            { id: 'group-a', title: 'Duplicate', order: 3 },
            { id: '', title: 'Missing id' },
        ],
        todos: [
            todo('todo-b', 'group-b', {
                title: ' Ship ', notes: ' Notes ', priority: 'invalid', completed: true,
                completedAt: '', order: 3,
            }),
            todo('todo-a', 'group-a', { order: 1 }),
            todo('todo-a', 'group-b', { order: 2 }),
            todo('orphan', 'missing', { order: 4 }),
        ],
    }, NOW);

    assert.deepEqual(normalized.groups, [
        { id: 'group-a', title: 'Untitled Group', collapsed: false, order: 1 },
        { id: 'group-b', title: 'Backlog', collapsed: true, order: 2 },
    ]);
    assert.deepEqual(normalized.todos.map(item => ({
        id: item.id,
        title: item.title,
        notes: item.notes,
        priority: item.priority,
        completedAt: item.completedAt,
    })), [
        { id: 'todo-a', title: 'todo-a', notes: '', priority: 'medium', completedAt: undefined },
        { id: 'todo-b', title: 'Ship', notes: 'Notes', priority: 'medium', completedAt: NOW },
    ]);
    assert.equal(normalizeTodoPriority('high'), 'high');
    assert.equal(normalizeTodoPriority('urgent'), 'medium');
});

test('TODO-TODO-INSERTION-ORDER-NORMALIZATION-001 preserves insertion order for equal numeric order values', () => {
    const normalized = normalizeTodoData({
        version: 1,
        groups: [
            { id: 'first', title: 'First', collapsed: false, order: 0 },
            { id: 'second', title: 'Second', collapsed: false, order: 0 },
        ],
        todos: [
            todo('first-a', 'first', { order: 0 }),
            todo('first-b', 'first', { order: 0 }),
            todo('second-a', 'second', { order: 0 }),
        ],
    });

    assert.deepEqual(normalized.groups.map(group => group.id), ['first', 'second']);
    assert.deepEqual(normalized.todos.map(item => item.id), ['first-a', 'first-b', 'second-a']);
});

test('TODO-TODO-SEARCH-RESULT-RENDERING-001 builds bounded searchable TODO catalog items', () => {
    const [item] = buildTodoSearchItems({
        version: 1,
        groups: [{ id: 'planning', title: 'Planning', collapsed: false, order: 0 }],
        todos: [todo('ship', 'planning', {
            title: 'Ship TODO', notes: 'x'.repeat(700), priority: 'high', completed: true,
        })],
    });

    assert.deepEqual({
        key: item.key,
        todoId: item.todoId,
        groupId: item.groupId,
        groupTitle: item.groupTitle,
        priority: item.priority,
        completed: item.completed,
        notesLength: item.notesSearchText.length,
    }, {
        key: 'todo:ship',
        todoId: 'ship',
        groupId: 'planning',
        groupTitle: 'Planning',
        priority: 'high',
        completed: true,
        notesLength: 500,
    });
    assert.match(item.searchText, /ship todo planning high/);
});

test('TODO-TODO-VIEW-MODEL-001 keeps incomplete items first and reveals only the requested completed item', () => {
    const data = {
        version: 1,
        groups: [{ id: 'group', title: 'Group', collapsed: false, order: 0 }],
        todos: [
            todo('done-first', 'group', { completed: true, completedAt: NOW, order: 0 }),
            todo('open-first', 'group', { order: 1, priority: 'high' }),
            todo('done-second', 'group', { completed: true, completedAt: NOW, order: 2 }),
            todo('open-second', 'group', { order: 3, priority: 'low' }),
        ],
    };

    const hidden = buildTodoViewModel(data, { showCompleted: false }, 'done-second');
    assert.deepEqual(
        hidden.groups[0].visibleTodos.map(item => [item.id, item.priorityLabel]),
        [['open-first', 'HIGH'], ['open-second', 'LOW'], ['done-second', 'MED']]
    );
    assert.equal(hidden.groups[0].hiddenCompletedCount, 1);
    assert.equal(hidden.totalIncomplete, 2);
    assert.equal(hidden.totalCompleted, 2);

    const visible = buildTodoViewModel(data, { showCompleted: true });
    assert.deepEqual(
        visible.groups[0].visibleTodos.map(item => item.id),
        ['open-first', 'open-second', 'done-first', 'done-second']
    );
});
