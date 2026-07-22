'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DashboardStartupController } = require('../../../out/dashboard/startupController');
const {
    SELF,
    flushAsync,
    loadWithFakeVscode,
    makeAggregate,
    makeRegistration,
} = require('./helpers');
const {
    OpenProjectDashboardController,
} = loadWithFakeVscode('../../../out/openProjects/dashboardController');

function createOptions(overrides = {}) {
    return {
        getOpenProjects: () => [{
            id: '__openProjects-0',
            name: 'Current',
            description: 'Workspace folder',
            path: '/work/current',
        }],
        getGroups: () => [],
        getTodoSearchItems: () => [{
            key: 'todo:open-projects',
            todoId: 'open-projects',
            groupId: 'release',
            title: 'Preserve OPEN catalog',
            groupTitle: 'Release',
            priority: 'high',
            completed: false,
            notesSearchText: '',
            searchText: 'preserve open catalog release high',
        }],
        getStewardInfos: () => ({ openProjectsGroupCollapsed: false, config: {} }),
        getAttentionAggregate: () => ({
            protocolVersion: 1,
            aggregateRevision: 'a'.repeat(64),
            generatedAtMs: 1,
            sessions: [],
        }),
        getBridgeInstanceId: () => SELF,
        postMessage: () => Promise.resolve(true),
        refresh: () => undefined,
        isVisible: () => true,
        logDiagnostic: () => undefined,
        logError: () => undefined,
        nowMs: () => 5000,
        ...overrides,
    };
}

test('OPEN-OPEN-PROJECT-DASHBOARD-CONTROLLER-001 posts each semantic revision once with the complete search catalog', async () => {
    const posted = [];
    const diagnostics = [];
    const options = createOptions({
        postMessage: message => {
            posted.push(message);
            return Promise.resolve(true);
        },
        logDiagnostic: (source, event) => diagnostics.push([source, event]),
    });
    const controller = new OpenProjectDashboardController(options);
    const first = makeAggregate([makeRegistration(SELF, 4000, '/work/current')], {
        semanticRevision: 'revision-1',
    });

    assert.equal(controller.setAggregate(first), true);
    assert.equal(controller.setAggregate({ ...first, observedAtMs: 6000 }), false);
    controller.postUpdated();
    controller.postUpdated();
    await flushAsync();

    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'open-projects-updated');
    assert.equal(posted[0].semanticRevision, 'revision-1');
    assert.equal(posted[0].searchCatalog.todos[0].todoId, 'open-projects');
    assert.ok(diagnostics.some(([, event]) => event.event === 'post-update-skip'));

    controller.setAggregate({ ...first, semanticRevision: 'revision-2' });
    controller.postUpdated();
    await flushAsync();
    assert.deepEqual(posted.map(message => message.semanticRevision), ['revision-1', 'revision-2']);
});

test('OPEN-OPEN-PROJECT-DASHBOARD-CONTROLLER-001 retries undelivered and rejected incremental updates through full refresh', async () => {
    const posted = [];
    const refreshes = [];
    const errors = [];
    let delivery = () => Promise.resolve(false);
    const controller = new OpenProjectDashboardController(createOptions({
        postMessage: message => {
            posted.push(message);
            return delivery();
        },
        refresh: reason => refreshes.push(reason),
        logError: (message, error) => errors.push([message, error.message]),
    }));
    controller.setAggregate(makeAggregate([makeRegistration()], {
        semanticRevision: 'delivery-revision',
    }));

    controller.postUpdated();
    await flushAsync();
    controller.postUpdated();
    delivery = () => Promise.reject(new Error('webview closed'));
    await flushAsync();
    controller.postUpdated();
    await flushAsync();

    assert.equal(posted.length, 3);
    assert.deepEqual(refreshes, [
        'open-project-update-not-delivered',
        'open-project-update-not-delivered',
        'open-project-update-post-error',
    ]);
    assert.deepEqual(errors, [['Failed to post OPEN PROJECT update message.', 'webview closed']]);
});

test('PERSIST-DASHBOARD-MIGRATION-PUBLICATION-001 republishes only after migrated project metadata is visible', async () => {
    const events = [];
    let metadata = 'before-migration';
    let migrated = true;
    const controller = new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded: async () => {
            if (migrated) metadata = 'after-migration';
            return { projects: { migrated }, todos: { migrated: false } };
        },
        refreshDashboard: () => events.push(['refresh', metadata]),
        publishOpenProjects: () => events.push(['publish', metadata]),
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        logError: () => undefined,
        showSteward: () => events.push(['show']),
        applyProjectColorToCurrentWindow: () => undefined,
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'workspace',
        getVisibleEditorLanguageIds: () => [],
    });

    await controller.checkDataMigration();
    migrated = false;
    await controller.checkDataMigration();
    migrated = true;
    metadata = 'before-explicit-migration';
    await controller.checkDataMigration(true);

    assert.deepEqual(events, [
        ['refresh', 'after-migration'],
        ['publish', 'after-migration'],
        ['refresh', 'after-migration'],
        ['publish', 'after-migration'],
        ['show'],
    ]);
});
