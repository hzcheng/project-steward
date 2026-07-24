'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DashboardStartupController, settleMigration } = require('../../../out/dashboard/startupController');
const {
    deleteTodoWithConfirmation,
    runTodoMutation,
    runTodoRequestMutation,
} = require('../../../out/todos/hostMutation');
const { TodoService } = require('../../../out/todos/service');
const { buildTodoViewModel } = require('../../../out/todos/viewModel');

const NOW = '2026-07-23T00:00:00.000Z';

function makeData(groupTitle, todoTitle = `${groupTitle} item`) {
    if (!groupTitle) {
        return { version: 1, groups: [], todos: [] };
    }
    return {
        version: 1,
        groups: [{ id: `group-${groupTitle}`, title: groupTitle, collapsed: false, order: 0 }],
        todos: [{
            id: `todo-${groupTitle}`,
            groupId: `group-${groupTitle}`,
            title: todoTitle,
            notes: '',
            priority: 'medium',
            completed: false,
            createdAt: NOW,
            updatedAt: NOW,
            order: 0,
        }],
    };
}

function makeStorageHarness({
    global = null,
    settings = null,
    useSettings = false,
    updateGlobal,
    updateSettings,
} = {}) {
    const values = { global, settings, viewState: undefined, provenance: undefined };
    const writes = [];
    let selectedSettings = useSettings;
    let nextId = 0;
    const service = new TodoService({
        globalState: {
            get(key) {
                if (key === 'todos') return values.global;
                if (key === 'todoViewState') return values.viewState;
                if (key === 'todoStorageBackend') return values.provenance;
                return undefined;
            },
            async update(key, value) {
                writes.push(['global', key, value]);
                if (key === 'todos') {
                    if (updateGlobal) await updateGlobal(value, writes);
                    values.global = value;
                } else if (key === 'todoViewState') {
                    values.viewState = value;
                } else if (key === 'todoStorageBackend') {
                    values.provenance = value;
                }
            },
        },
        configuration: {
            get(key, fallback) {
                return key === 'todoData' ? values.settings : fallback;
            },
            async update(key, value, target) {
                writes.push(['settings', key, value, target]);
                if (updateSettings) await updateSettings(value, writes);
                values.settings = value;
            },
        },
        useSettingsStorage: () => selectedSettings,
        now: () => NOW,
        generateId: prefix => `${prefix}-${++nextId}`,
    });
    return {
        service,
        values,
        writes,
        setUseSettings(value) {
            selectedSettings = value;
        },
    };
}

test('TODO-TODO-ORDERING-MUTATION-001 inserts newest TODO first and sorts priority stably', async () => {
    const harness = makeStorageHarness();
    await harness.service.addTodo({ title: 'First', priority: 'low' });
    await harness.service.addTodo({ title: 'Second', priority: 'high' });
    await harness.service.addTodo({ title: 'Third', priority: 'high' });

    assert.deepEqual(
        harness.service.getData().todos.slice().sort((a, b) => a.order - b.order).map(item => item.title),
        ['Third', 'Second', 'First']
    );
    const groupId = harness.service.getData().groups[0].id;
    await harness.service.sortGroupByPriority(groupId);
    assert.deepEqual(
        harness.service.getData().todos.slice().sort((a, b) => a.order - b.order).map(item => item.title),
        ['Third', 'Second', 'First']
    );
});

test('TODO-TODO-ORDERING-MUTATION-001 accepts exact visible reorder and rejects duplicates or cross-group IDs', async () => {
    const harness = makeStorageHarness({ global: {
        version: 1,
        groups: [
            { id: 'a', title: 'A', collapsed: false, order: 0 },
            { id: 'b', title: 'B', collapsed: false, order: 1 },
        ],
        todos: [
            { ...makeData('a').todos[0], id: 'a1', groupId: 'a', completed: false, order: 0 },
            { ...makeData('a').todos[0], id: 'a2', groupId: 'a', completed: false, order: 1 },
            { ...makeData('a').todos[0], id: 'done', groupId: 'a', completed: true, completedAt: NOW, order: 2 },
            { ...makeData('b').todos[0], id: 'b1', groupId: 'b', order: 0 },
        ],
    } });

    await harness.service.reorderTodos('a', ['a2', 'a1']);
    assert.deepEqual(
        harness.service.getData().todos.filter(item => item.groupId === 'a')
            .sort((left, right) => left.order - right.order).map(item => item.id),
        ['a2', 'a1', 'done']
    );
    await assert.rejects(() => harness.service.reorderTodos('a', ['a1', 'a1']), /exactly/);
    await assert.rejects(() => harness.service.reorderTodos('a', ['a1', 'b1']), /same group/);
    await assert.rejects(() => harness.service.reorderGroups(['a', 'a']), /exactly/);
});

test('TODO-TODO-EXACT-RESTORE-001 restores identity and relative order between surviving neighbors', async () => {
    const harness = makeStorageHarness({ global: {
        version: 1,
        groups: [
            { id: 'a', title: 'A', collapsed: false, order: 0 },
            { id: 'b', title: 'B', collapsed: false, order: 1 },
        ],
        todos: [
            { ...makeData('a').todos[0], id: 'a1', groupId: 'a', title: 'First', order: 0 },
            { ...makeData('a').todos[0], id: 'a2', groupId: 'a', title: 'Deleted', order: 1 },
            { ...makeData('a').todos[0], id: 'a3', groupId: 'a', title: 'Third', order: 2 },
            { ...makeData('b').todos[0], id: 'b1', groupId: 'b', title: 'Other', order: 0 },
        ],
    } });
    const deleted = harness.service.getData().todos.find(todo => todo.id === 'a2');

    await harness.service.deleteTodo('a2');
    await harness.service.restoreTodo(deleted, { beforeId: 'a1', afterId: 'a3' });

    assert.deepEqual(
        harness.service.getData().todos.filter(todo => todo.groupId === 'a')
            .sort((left, right) => left.order - right.order)
            .map(todo => [todo.id, todo.title]),
        [['a1', 'First'], ['a2', 'Deleted'], ['a3', 'Third']]
    );
});

test('TODO-TODO-EXACT-RESTORE-001 moves a todo to the top and compacts both groups', async () => {
    const harness = makeStorageHarness({ global: {
        version: 1,
        groups: [
            { id: 'a', title: 'A', collapsed: false, order: 0 },
            { id: 'b', title: 'B', collapsed: false, order: 1 },
        ],
        todos: [
            { ...makeData('a').todos[0], id: 'a1', groupId: 'a', order: 0 },
            { ...makeData('a').todos[0], id: 'a2', groupId: 'a', order: 1 },
            { ...makeData('b').todos[0], id: 'b1', groupId: 'b', order: 0 },
        ],
    } });

    await harness.service.moveTodo('a2', 'b');

    assert.deepEqual(
        harness.service.getData().todos.filter(todo => todo.groupId === 'a')
            .sort((left, right) => left.order - right.order)
            .map(todo => [todo.id, todo.order]),
        [['a1', 0]]
    );
    assert.deepEqual(
        harness.service.getData().todos.filter(todo => todo.groupId === 'b')
            .sort((left, right) => left.order - right.order)
            .map(todo => [todo.id, todo.order]),
        [['a2', 0], ['b1', 1]]
    );
});

test('TODO-TODO-STORAGE-RESOLUTION-001 reads only the configured backend and isolates future versions', () => {
    const harness = makeStorageHarness({
        global: makeData('global'),
        settings: makeData('settings'),
        useSettings: false,
    });
    assert.deepEqual(harness.service.getData().groups.map(group => group.title), ['global']);
    harness.setUseSettings(true);
    assert.deepEqual(harness.service.getData().groups.map(group => group.title), ['settings']);

    harness.values.global = { version: 2, groups: [], todos: [] };
    assert.equal(harness.service.getUnsupportedVersionError().version, 2);
    assert.deepEqual(harness.service.getSearchItems(), []);
    harness.values.global = null;
    assert.equal(harness.service.getUnsupportedVersionError(), undefined);
    assert.deepEqual(harness.service.getSearchItems().map(item => item.title), ['settings item']);
});

test('TODO-TODO-MIGRATION-001 copies a sole non-empty source and refuses conflicting stores', async () => {
    const migration = makeStorageHarness({ global: makeData('global'), settings: null, useSettings: true });
    assert.equal(await migration.service.migrateDataIfNeeded(), true);
    assert.deepEqual(migration.values.settings.groups.map(group => group.title), ['global']);
    assert.deepEqual(migration.values.settings.todos.map(item => item.title), ['global item']);
    assert.deepEqual({
        version: migration.values.provenance.version,
        activeBackend: migration.values.provenance.activeBackend,
    }, { version: 1, activeBackend: 'settings' });
    assert.match(migration.values.provenance.inactiveFingerprint, /^[a-f0-9]{64}$/);

    const conflict = makeStorageHarness({
        global: makeData('global'),
        settings: makeData('settings'),
        useSettings: true,
    });
    await assert.rejects(
        () => conflict.service.migrateDataIfNeeded(),
        error => error && error.name === 'TodoStorageConflictError'
    );
    assert.deepEqual(conflict.writes, []);
});

test('TODO-TODO-BACKEND-SWITCH-BARRIER-001 keeps queued mutations on their captured backend before switching', async () => {
    let releaseFirstWrite;
    const firstWriteGate = new Promise(resolve => { releaseFirstWrite = resolve; });
    let todoWriteCount = 0;
    const harness = makeStorageHarness({
        updateGlobal: async () => {
            todoWriteCount += 1;
            if (todoWriteCount === 1) await firstWriteGate;
        },
    });

    const first = harness.service.addGroup('First global');
    await new Promise(resolve => setImmediate(resolve));
    const second = harness.service.addGroup('Queued global');
    harness.setUseSettings(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(harness.writes.map(write => write[0]), ['global']);
    releaseFirstWrite();
    await Promise.all([first, second]);

    assert.deepEqual(harness.values.global.groups.map(group => group.title), ['First global', 'Queued global']);
    assert.equal(harness.values.settings, null);

    await harness.service.addGroup('First settings');
    assert.deepEqual(
        harness.values.settings.groups.map(group => group.title),
        ['First global', 'Queued global', 'First settings']
    );
    assert.deepEqual(harness.values.global.groups.map(group => group.title), ['First global', 'Queued global']);
});

test('TODO-TODO-VIEW-STATE-001 persists show-completed locally without changing TODO data', async () => {
    const harness = makeStorageHarness({ global: makeData('global') });
    harness.values.viewState = { showCompleted: true, editingTodoId: 'stale' };

    assert.deepEqual(harness.service.getViewState(), { showCompleted: true });
    assert.deepEqual(await harness.service.setShowCompleted(false), { showCompleted: false });
    assert.deepEqual(harness.values.viewState, { showCompleted: false });
    assert.deepEqual(harness.values.global, makeData('global'));
    assert.deepEqual(harness.writes.map(write => write[1]), ['todoViewState']);
});

test('TODO-TODO-MUTATION-SERIALIZATION-001 serializes writes and recovers after rejection', async () => {
    let releaseFirstWrite;
    const firstWriteGate = new Promise(resolve => { releaseFirstWrite = resolve; });
    let writeCount = 0;
    const harness = makeStorageHarness({
        updateGlobal: async () => {
            writeCount += 1;
            if (writeCount === 1) await firstWriteGate;
        },
    });
    const first = harness.service.addGroup('First');
    await new Promise(resolve => setImmediate(resolve));
    const second = harness.service.addGroup('Second');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writeCount, 1);
    releaseFirstWrite();
    await Promise.all([first, second]);
    assert.deepEqual(harness.values.global.groups.map(group => group.title), ['First', 'Second']);

    let attempt = 0;
    const recovering = makeStorageHarness({
        updateGlobal: async () => {
            attempt += 1;
            if (attempt === 1) throw new Error('first write rejected');
        },
    });
    const rejected = recovering.service.addGroup('Rejected');
    const recovered = recovering.service.addGroup('Recovered');
    await assert.rejects(() => rejected, /first write rejected/);
    await recovered;
    assert.deepEqual(recovering.values.global.groups.map(group => group.title), ['Recovered']);
});

test('TODO-TODO-REVEAL-SINGLE-WRITE-001 expands once and projects only the searched completed TODO', async () => {
    const data = {
        version: 1,
        groups: [{ id: 'group', title: 'Group', collapsed: true, order: 0 }],
        todos: [
            { ...makeData('group').todos[0], id: 'open', groupId: 'group' },
            { ...makeData('group').todos[0], id: 'target', groupId: 'group', completed: true, completedAt: NOW, order: 1 },
            { ...makeData('group').todos[0], id: 'other', groupId: 'group', completed: true, completedAt: NOW, order: 2 },
        ],
    };
    const harness = makeStorageHarness({ global: data });
    harness.values.viewState = { showCompleted: false };

    const result = await harness.service.revealTodo('target', 'group');
    assert.equal(result.revealed, true);
    assert.deepEqual(harness.writes.map(write => write[1]), ['todos']);
    assert.equal(harness.values.global.groups[0].collapsed, false);
    assert.deepEqual(harness.values.viewState, { showCompleted: false });
    assert.deepEqual(
        buildTodoViewModel(harness.values.global, harness.values.viewState, 'target')
            .groups[0].visibleTodos.map(item => item.id),
        ['open', 'target']
    );

    harness.writes.length = 0;
    assert.equal((await harness.service.revealTodo('target', 'group')).revealed, true);
    assert.deepEqual(harness.writes, []);
    assert.equal((await harness.service.revealTodo('missing', 'group')).revealed, false);
});

test('TODO-TODO-HOST-MUTATION-001 preserves the panel on failures and acknowledges committed writes', async () => {
    const events = [];
    const failed = await runTodoMutation({
        mutate: async () => { throw new Error('storage full'); },
        onSuccess: async () => events.push('refresh'),
        showErrorMessage: message => events.push(['error', message]),
        logError: (message, error) => events.push(['log', message, error.message]),
    });
    assert.equal(failed, false);
    assert.equal(events.includes('refresh'), false);
    assert.match(events.find(event => event[0] === 'error')[1], /preserved/);

    const requestEvents = [];
    const saved = await runTodoRequestMutation({
        requestId: 7,
        valid: true,
        mutate: async () => requestEvents.push('write'),
        onSuccess: async () => {
            requestEvents.push('refresh');
            throw new Error('refresh failed');
        },
        postResult: async message => requestEvents.push(['result', message]),
        showErrorMessage: message => requestEvents.push(['error', message]),
        logError: (message, error) => requestEvents.push(['log', message, error.message]),
    });
    assert.equal(saved, true);
    assert.deepEqual(requestEvents.find(event => event[0] === 'result')[1], {
        type: 'todo-mutation-result',
        version: 1,
        requestId: 7,
        success: true,
        panelRefreshed: false,
    });
});

test('TODO-TODO-HOST-MUTATION-001 deletes only after exact confirmation', async () => {
    const events = [];
    let confirmation = 'Cancel';
    const options = {
        todoId: 'todo-a',
        getData: () => ({ todos: [{ id: 'todo-a', title: 'Ship' }] }),
        confirm: async title => {
            events.push(['confirm', title]);
            return confirmation;
        },
        deleteTodo: async id => events.push(['delete', id]),
        refreshPanel: async () => events.push(['refresh']),
        showErrorMessage: () => undefined,
        logError: () => undefined,
    };
    assert.equal(await deleteTodoWithConfirmation(options), false);
    confirmation = 'Delete';
    assert.equal(await deleteTodoWithConfirmation(options), true);
    assert.deepEqual(events, [
        ['confirm', 'Ship'],
        ['confirm', 'Ship'],
        ['delete', 'todo-a'],
        ['refresh'],
    ]);
});

test('TODO-DASHBOARD-TODO-MIGRATION-SEQUENCING-001 and WEBVIEW-DASHBOARD-STARTUP-CONTROLLER-001 settle migrations independently', async () => {
    const projectError = new Error('project failed');
    let releaseTodo;
    const todoGate = new Promise(resolve => { releaseTodo = resolve; });
    const migrations = Promise.all([
        settleMigration(async () => { throw projectError; }),
        settleMigration(async () => {
            await todoGate;
            return true;
        }),
    ]);
    releaseTodo();
    const [projects, todos] = await migrations;
    assert.deepEqual(projects, { migrated: false, error: projectError });
    assert.deepEqual(todos, { migrated: true });

    const events = [];
    const controller = new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded: async () => ({ projects, todos }),
        refreshDashboard: async () => events.push('refresh'),
        publishOpenWorkspace: () => events.push('publish'),
        showInformationMessage: () => undefined,
        showErrorMessage: message => events.push(['error', message]),
        logError: (message, error) => events.push(['log', message, error]),
        showSteward: () => undefined,
        applyProjectColorToCurrentWindow: () => undefined,
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        getWorkspaceName: () => 'workspace',
        getVisibleEditorLanguageIds: () => [],
    });
    await controller.checkDataMigration();
    assert.equal(events.filter(event => event === 'refresh').length, 1);
    assert.equal(events.filter(event => event === 'publish').length, 1);
    assert.equal(events.filter(event => Array.isArray(event) && event[0] === 'log').length, 1);
});
