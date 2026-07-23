'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');
const { loadFreshWithFakeVscode } = require('../../helpers/runtimeContract');
const { DashboardStartupController, settleMigration } = require('../../../out/dashboard/startupController');
const { TodoService } = require('../../../out/todos/service');

const NOW = '2026-07-23T00:00:00.000Z';

function makeTodoData(name) {
    if (!name) return { version: 1, groups: [], todos: [] };
    return {
        version: 1,
        groups: [{ id: `group-${name}`, title: name, collapsed: false, order: 0 }],
        todos: [{
            id: `todo-${name}`,
            groupId: `group-${name}`,
            title: `${name} item`,
            notes: '',
            priority: 'medium',
            completed: false,
            createdAt: NOW,
            updatedAt: NOW,
            order: 0,
        }],
    };
}

function makeTodoStorageHarness({ global = null, settings = null, useSettings = false } = {}) {
    const values = { global, settings, provenance: undefined };
    const writes = [];
    let selectedSettings = useSettings;
    const service = new TodoService({
        globalState: {
            get(key) {
                if (key === 'todos') return values.global;
                if (key === 'todoStorageBackend') return values.provenance;
                return undefined;
            },
            async update(key, value) {
                writes.push(['global', key, value]);
                if (key === 'todos') values.global = value;
                if (key === 'todoStorageBackend') values.provenance = value;
            },
        },
        configuration: {
            get(key, fallback) {
                return key === 'todoData' ? values.settings : fallback;
            },
            async update(key, value, target) {
                writes.push(['settings', key, value, target]);
                values.settings = value;
            },
        },
        useSettingsStorage: () => selectedSettings,
        now: () => NOW,
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

function makeStartupController(migrateDataIfNeeded, events) {
    return new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded,
        refreshDashboard: async () => events.push('refresh'),
        publishOpenWorkspace: () => events.push('publish'),
        showInformationMessage: message => events.push(['information', message]),
        showErrorMessage: message => events.push(['error', message]),
        logError: (message, error) => events.push(['log', message, error]),
        showSteward: () => events.push('show'),
        applyProjectColorToCurrentWindow: () => undefined,
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'fixture',
        getVisibleEditorLanguageIds: () => [],
    });
}

test('PERSIST-DASHBOARD-MIGRATION-PUBLICATION-001 copies a sole legacy project store without overwriting a populated destination', async () => {
    const values = {
        useSettings: true,
        settings: null,
        global: [{ id: 'legacy', groupName: 'Legacy', projects: [] }],
    };
    const primary = {
        get(key, fallback) {
            if (key === 'storeProjectsInSettings') return values.useSettings;
            if (key === 'projectData') return values.settings;
            return fallback;
        },
        inspect(key) {
            return key === 'storeProjectsInSettings' || key === 'projectData'
                ? { globalValue: this.get(key) }
                : undefined;
        },
        async update(key, value) {
            if (key === 'projectData') values.settings = value;
        },
    };
    const legacy = { get: (_key, fallback) => fallback, inspect: () => undefined };
    const vscode = createFakeVscode({
        workspace: {
            getConfiguration: section => section === 'projectSteward' ? primary : legacy,
        },
    });
    vscode.ConfigurationTarget = { Global: 1 };
    const ProjectService = loadFreshWithFakeVscode(
        '../../../out/services/projectService', vscode, __dirname
    ).default;
    const context = {
        globalState: {
            get: key => key === 'projects' ? values.global : undefined,
            async update(key, value) {
                if (key === 'projects') values.global = value;
            },
        },
    };
    const service = new ProjectService(context, {});

    assert.equal(await service.migrateDataIfNeeded(), true);
    assert.deepEqual(values.settings, values.global);

    values.settings = [{ id: 'settings', groupName: 'Settings', projects: [] }];
    values.global = [{ id: 'global', groupName: 'Global', projects: [] }];
    assert.equal(await service.migrateDataIfNeeded(), false);
    assert.equal(values.settings[0].id, 'settings');
});

test('TODO-TODO-MIGRATION-001 copies one populated backend, records provenance, and rejects conflicting data', async () => {
    const migration = makeTodoStorageHarness({
        global: makeTodoData('legacy'),
        settings: null,
        useSettings: true,
    });
    assert.equal(await migration.service.migrateDataIfNeeded(), true);
    assert.deepEqual(migration.values.settings.groups.map(group => group.title), ['legacy']);
    assert.deepEqual({
        version: migration.values.provenance.version,
        activeBackend: migration.values.provenance.activeBackend,
    }, { version: 1, activeBackend: 'settings' });
    assert.match(migration.values.provenance.inactiveFingerprint, /^[a-f0-9]{64}$/);

    const conflict = makeTodoStorageHarness({
        global: makeTodoData('global'),
        settings: makeTodoData('settings'),
        useSettings: true,
    });
    await assert.rejects(
        conflict.service.migrateDataIfNeeded(),
        error => error && error.name === 'TodoStorageConflictError'
    );
    assert.deepEqual(conflict.writes, []);
});

test('TODO-TODO-MIGRATION-001 overwrites only a known-stale destination and detects later inactive edits', async () => {
    const harness = makeTodoStorageHarness({
        global: makeTodoData('global'),
        settings: null,
        useSettings: false,
    });
    assert.equal(await harness.service.migrateDataIfNeeded(), false);

    harness.setUseSettings(true);
    assert.equal(await harness.service.migrateDataIfNeeded(), true);
    assert.deepEqual(harness.values.settings.groups.map(group => group.title), ['global']);
    assert.deepEqual(harness.values.settings.todos.map(todo => todo.title), ['global item']);

    harness.values.global = makeTodoData('external-edit');
    await assert.rejects(
        harness.service.migrateDataIfNeeded(),
        error => error && error.name === 'TodoStorageConflictError'
    );
    assert.deepEqual(harness.values.settings.groups.map(group => group.title), ['global']);
});

test('TODO-DASHBOARD-TODO-MIGRATION-SEQUENCING-001 settles project and TODO migrations independently', async () => {
    const projectError = new Error('project migration failed');
    let releaseTodo;
    const todoGate = new Promise(resolve => { releaseTodo = resolve; });
    const pending = Promise.all([
        settleMigration(async () => { throw projectError; }),
        settleMigration(async () => {
            await todoGate;
            return true;
        }),
    ]);
    releaseTodo();

    assert.deepEqual(await pending, [
        { migrated: false, error: projectError },
        { migrated: true },
    ]);
});

test('PERSIST-DASHBOARD-MIGRATION-PUBLICATION-001 publishes only after successful migrated state is refreshed', async () => {
    const events = [];
    const projectError = new Error('project destination unavailable');
    const controller = makeStartupController(async () => ({
        projects: { migrated: false, error: projectError },
        todos: { migrated: true },
    }), events);

    await controller.checkDataMigration(true);
    assert.deepEqual(events.map(event => Array.isArray(event) ? event[0] : event), [
        'log', 'error', 'refresh', 'publish', 'information', 'show',
    ]);
    assert.equal(events.indexOf('refresh') < events.indexOf('publish'), true);
    assert.equal(events.filter(event => Array.isArray(event) && event[0] === 'log')[0][2], projectError);
});
