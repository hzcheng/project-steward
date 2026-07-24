'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DashboardStartupController } = require('../../../out/dashboard/startupController');
const {
    SELF,
    flushAsync,
    loadWithFakeVscode,
    makeAggregate,
    makeRecord,
    makeRegistration,
} = require('./helpers');
const {
    OpenWorkspaceDashboardController,
} = loadWithFakeVscode('../../../out/openWorkspaces/dashboardController');

function createOptions(overrides = {}) {
    const currentWorkspace = makeRecord({ name: 'Current', uri: '/work/current' });
    return {
        getCurrentWorkspace: () => ({
            ...currentWorkspace,
            roots: currentWorkspace.roots.map(root => ({ ...root, hostPath: '/work/current' })),
        }),
        isWorkspaceSavedAsProject: () => true,
        getWorkspaceProjectColor: () => '',
        getCurrentWorkspaceAiSessions: () => null,
        getGroups: () => [],
        getTodoSearchItems: () => [{
            key: 'todo:open-workspaces',
            todoId: 'open-workspaces',
            groupId: 'release',
            title: 'Preserve OPEN catalog',
            groupTitle: 'Release',
            priority: 'high',
            completed: false,
            notesSearchText: '',
            searchText: 'preserve open catalog release high',
        }],
        getCollapsed: () => false,
        getRunningCardAnimation: () => undefined,
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

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
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
    const controller = new OpenWorkspaceDashboardController(options);
    const first = makeAggregate([makeRegistration(SELF, 4000, '/work/current')], {
        semanticRevision: 'revision-1',
    });

    assert.equal(controller.setAggregate(first), true);
    assert.equal(controller.setAggregate({ ...first, observedAtMs: 6000 }), false);
    controller.postUpdated();
    controller.postUpdated();
    await flushAsync();

    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'open-workspaces-updated');
    assert.match(posted[0].semanticRevision, /^[a-f0-9]{64}$/);
    assert.equal(posted[0].searchCatalog.todos[0].todoId, 'open-workspaces');
    assert.ok(diagnostics.some(([, event]) => event.event === 'open-workspace-cards-build'));

    controller.setAggregate({ ...first, semanticRevision: 'revision-2' });
    controller.postUpdated();
    await flushAsync();
    assert.equal(posted.length, 2);
    assert.notEqual(posted[0].semanticRevision, posted[1].semanticRevision);
});

test('PROJECT-INCREMENTAL-REFRESH-001 republishes OPEN search when only the saved project catalog changes', async () => {
    const posted = [];
    let groups = [];
    const controller = new OpenWorkspaceDashboardController(createOptions({
        getGroups: () => groups,
        postMessage: message => {
            posted.push(message);
            return Promise.resolve(true);
        },
    }));

    controller.postUpdated();
    await flushAsync();
    groups = [{
        id: 'work',
        groupName: 'Work',
        collapsed: false,
        projects: [{ id: 'saved', name: 'Saved', path: '/work/saved' }],
    }];
    controller.postUpdated();
    await flushAsync();

    assert.equal(posted.length, 2);
    assert.notEqual(posted[0].semanticRevision, posted[1].semanticRevision);
    assert.deepEqual(posted[1].searchCatalog.savedProjects.map(item => item.projectId), ['saved']);
});

test('PROJECT-INCREMENTAL-REFRESH-001 ignores stale and invalidated OPEN delivery failures', async () => {
    const deliveries = [];
    const refreshes = [];
    let groups = [];
    const controller = new OpenWorkspaceDashboardController(createOptions({
        getGroups: () => groups,
        postMessage: () => {
            const deferred = createDeferred();
            deliveries.push(deferred);
            return deferred.promise;
        },
        refresh: reason => refreshes.push(reason),
    }));

    controller.postUpdated();
    groups = [{
        id: 'work',
        groupName: 'Work',
        projects: [{ id: 'saved', name: 'Saved', path: '/work/saved' }],
    }];
    controller.postUpdated();
    deliveries[1].resolve(true);
    deliveries[0].resolve(false);
    await flushAsync();

    groups = [{
        id: 'work',
        groupName: 'Work renamed',
        projects: [{ id: 'saved', name: 'Saved', path: '/work/saved' }],
    }];
    controller.postUpdated();
    controller.invalidatePendingUpdates();
    deliveries[2].resolve(false);
    await flushAsync();

    assert.deepEqual(refreshes, []);
});

test('OPEN-OPEN-PROJECT-DASHBOARD-CONTROLLER-001 retries undelivered and rejected incremental updates through full refresh', async () => {
    const posted = [];
    const refreshes = [];
    const errors = [];
    let delivery = () => Promise.resolve(false);
    const controller = new OpenWorkspaceDashboardController(createOptions({
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
        'open-workspace-update-not-delivered',
        'open-workspace-update-not-delivered',
        'open-workspace-update-post-error',
    ]);
    assert.deepEqual(errors, [['Failed to post OPEN WORKSPACE update message.', 'webview closed']]);
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
        publishOpenWorkspace: () => events.push(['publish', metadata]),
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
