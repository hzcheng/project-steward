'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');
const { loadFreshWithFakeVscode } = require('../../helpers/runtimeContract');

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function makeMemento(initial = {}) {
    const values = clone(initial);
    return {
        values,
        get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(values, key) ? clone(values[key]) : fallback;
        },
        async update(key, value) {
            if (value === undefined) delete values[key];
            else values[key] = clone(value);
        },
    };
}

function makeTwoClientHarness(initialGroups) {
    const configurationValues = {
        storeProjectsInSettings: true,
        projectData: clone(initialGroups),
    };
    const primary = {
        get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(configurationValues, key)
                ? clone(configurationValues[key])
                : fallback;
        },
        inspect(key) {
            return Object.prototype.hasOwnProperty.call(configurationValues, key)
                ? { globalValue: clone(configurationValues[key]) }
                : undefined;
        },
        async update(key, value) {
            configurationValues[key] = clone(value);
        },
    };
    const legacy = {
        get(_key, fallback) {
            return fallback;
        },
        inspect() {
            return undefined;
        },
    };
    const vscode = createFakeVscode({
        workspace: {
            getConfiguration: section => section === 'projectSteward' ? primary : legacy,
        },
    });
    vscode.ConfigurationTarget = { Global: 1 };
    const ProjectService = loadFreshWithFakeVscode(
        '../../../out/services/projectService',
        vscode,
        __dirname
    ).default;
    const colorService = { addRecentColor: async () => undefined };
    const stateA = makeMemento();
    const stateB = makeMemento();

    return {
        configurationValues,
        stateA,
        stateB,
        clientA: new ProjectService(
            { globalState: stateA },
            colorService,
            { createActorId: () => 'actor-a' }
        ),
        clientB: new ProjectService(
            { globalState: stateB },
            colorService,
            { createActorId: () => 'actor-b' }
        ),
    };
}

function projectIds(groups) {
    return groups.flatMap(group => group.projects.map(project => project.id)).sort();
}

function makeCatalogGroups(projects = []) {
    return [{
        id: 'group-main',
        groupName: 'Main',
        collapsed: false,
        projects: [{
            id: 'project-existing',
            name: 'Existing',
            path: '/work/existing',
            color: '#112233',
        }, ...projects],
    }];
}

function loadProjectCatalogSyncModel() {
    return require('../../../out/projects/projectCatalogSync');
}

function loadProjectCatalogSyncService() {
    return require('../../../out/services/projectCatalogSyncService').ProjectCatalogSyncService;
}

function makeSyncPersistenceHarness({
    legacyGroups,
    syncData = null,
    localState = null,
    failLocal = null,
    failSync = null,
    failLegacy = null,
} = {}) {
    const values = {
        legacyGroups: clone(legacyGroups || makeCatalogGroups()),
        syncData: clone(syncData),
        localState: clone(localState),
    };
    const writes = [];
    const conflicts = [];
    const diagnostics = [];
    const failures = {
        local: failLocal,
        sync: failSync,
        legacy: failLegacy,
    };
    const ProjectCatalogSyncService = loadProjectCatalogSyncService();
    const service = new ProjectCatalogSyncService({
        getSyncData: () => clone(values.syncData),
        updateSyncData: async value => {
            writes.push('settings:projectSyncData');
            if (failures.sync) throw failures.sync;
            values.syncData = clone(value);
        },
        getLegacyGroups: () => clone(values.legacyGroups),
        updateLegacyGroups: async groups => {
            writes.push('settings:projectData');
            if (failures.legacy) throw failures.legacy;
            values.legacyGroups = clone(groups);
        },
        getLocalState: () => clone(values.localState),
        updateLocalState: async value => {
            writes.push('globalState:projectCatalogSyncLocal.v1');
            if (failures.local) throw failures.local;
            values.localState = clone(value);
        },
        createActorId: () => 'actor-local',
        onDiagnostic: event => diagnostics.push(clone(event)),
        onConflict: projectIds => conflicts.push([...projectIds]),
    });
    return { conflicts, diagnostics, failures, service, values, writes };
}

test('PROJECT-CATALOG-SYNC-CONFLICT-001 preserves a project when a stale client submits an older full snapshot', async () => {
    const initialGroups = [{
        id: 'group-main',
        groupName: 'Main',
        collapsed: false,
        projects: [{
            id: 'project-existing',
            name: 'Existing',
            path: '/work/existing',
            color: '#112233',
        }],
    }];
    const { clientA, clientB } = makeTwoClientHarness(initialGroups);
    const staleA = clone(clientA.getGroups(true));
    const added = {
        id: 'project-build-your-own-x',
        name: 'build-your-own-x',
        path: '/work/build-your-own-x',
        color: '#445566',
    };

    await clientB.addProject(added, 'group-main');
    await clientA.saveGroups(staleA);

    assert.deepEqual(
        clientB.getProjectsFlat().map(project => project.id).sort(),
        ['project-build-your-own-x', 'project-existing']
    );
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 keeps an observed deletion after an older canonical snapshot returns', async () => {
    const { clientA, clientB, configurationValues } = makeTwoClientHarness(makeCatalogGroups());
    await clientA.migrateDataIfNeeded();
    await clientB.migrateDataIfNeeded();
    const added = {
        id: 'project-build-your-own-x',
        name: 'build-your-own-x',
        path: '/work/build-your-own-x',
        color: '#445566',
    };
    await clientB.addProject(added, 'group-main');
    await clientA.reconcileProjectCatalog();
    const staleCanonical = clone(configurationValues.projectSyncData);
    const staleProjection = clone(configurationValues.projectData);

    await clientA.removeProject(added.id);
    configurationValues.projectSyncData = staleCanonical;
    configurationValues.projectData = staleProjection;
    await clientA.reconcileProjectCatalog();

    assert.deepEqual(projectIds(clientA.getGroups()), ['project-existing']);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 manual replacement deletes only baseline records and preserves later additions', async () => {
    const removeTarget = {
        id: 'project-remove',
        name: 'Remove',
        path: '/work/remove',
        color: '#991122',
    };
    const { clientA, clientB } = makeTwoClientHarness(makeCatalogGroups([removeTarget]));
    await clientA.migrateDataIfNeeded();
    await clientB.migrateDataIfNeeded();
    const baseline = clone(clientA.getGroups(true));
    const remoteAddition = {
        id: 'project-remote-addition',
        name: 'Remote addition',
        path: '/work/remote-addition',
        color: '#229944',
    };
    await clientB.addProject(remoteAddition, 'group-main');
    const edited = clone(baseline);
    edited[0].projects = edited[0].projects.filter(project => project.id !== removeTarget.id);

    await clientA.saveGroupsFromManualEdit(edited, baseline);

    assert.deepEqual(projectIds(clientA.getGroups()), [
        'project-existing',
        'project-remote-addition',
    ]);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 model preserves unseen additions and observed deletions', () => {
    const {
        applyProjectCatalogSnapshot,
        materializeProjectCatalog,
        mergeProjectCatalogDocuments,
        migrateLegacyProjectCatalog,
    } = loadProjectCatalogSyncModel();
    const baseGroups = makeCatalogGroups();
    const addedProject = {
        id: 'project-build-your-own-x',
        name: 'build-your-own-x',
        path: '/work/build-your-own-x',
        color: '#445566',
    };
    const base = migrateLegacyProjectCatalog(baseGroups, 'actor-a');
    const withAdded = applyProjectCatalogSnapshot(
        base,
        makeCatalogGroups([addedProject]),
        'actor-b'
    );

    const staleMerge = mergeProjectCatalogDocuments(base, withAdded);
    assert.deepEqual(projectIds(materializeProjectCatalog(staleMerge.document)), [
        'project-build-your-own-x',
        'project-existing',
    ]);

    const deleted = applyProjectCatalogSnapshot(
        withAdded,
        makeCatalogGroups(),
        'actor-a',
        { deletedProjectIds: ['project-build-your-own-x'] }
    );
    const deletionMerge = mergeProjectCatalogDocuments(withAdded, deleted);
    assert.deepEqual(
        projectIds(materializeProjectCatalog(deletionMerge.document)),
        ['project-existing']
    );
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 model keeps a concurrent live update and reports recovery', () => {
    const {
        applyProjectCatalogSnapshot,
        materializeProjectCatalog,
        mergeProjectCatalogDocuments,
        migrateLegacyProjectCatalog,
    } = loadProjectCatalogSyncModel();
    const baseGroups = makeCatalogGroups();
    const base = migrateLegacyProjectCatalog(baseGroups, 'actor-seed');
    const removed = applyProjectCatalogSnapshot(
        base,
        [{ ...baseGroups[0], projects: [] }],
        'actor-remove',
        { deletedProjectIds: ['project-existing'] }
    );
    const updatedGroups = makeCatalogGroups();
    updatedGroups[0].projects[0].name = 'Updated elsewhere';
    const updated = applyProjectCatalogSnapshot(base, updatedGroups, 'actor-update');
    const merged = mergeProjectCatalogDocuments(removed, updated);

    assert.equal(materializeProjectCatalog(merged.document)[0].projects[0].name, 'Updated elsewhere');
    assert.deepEqual(merged.conflictProjectIds, ['project-existing']);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 model preserves same-actor concurrent additions with equal causal counters', () => {
    const {
        applyProjectCatalogSnapshot,
        materializeProjectCatalog,
        mergeProjectCatalogDocuments,
        migrateLegacyProjectCatalog,
    } = loadProjectCatalogSyncModel();
    const base = migrateLegacyProjectCatalog(makeCatalogGroups(), 'actor-shared');
    const left = applyProjectCatalogSnapshot(
        base,
        makeCatalogGroups([{
            id: 'project-left-window',
            name: 'Left window',
            path: '/work/left-window',
            color: '#111111',
        }]),
        'actor-shared'
    );
    const right = applyProjectCatalogSnapshot(
        base,
        makeCatalogGroups([{
            id: 'project-right-window',
            name: 'Right window',
            path: '/work/right-window',
            color: '#222222',
        }]),
        'actor-shared'
    );

    const merged = mergeProjectCatalogDocuments(left, right);

    assert.deepEqual(projectIds(materializeProjectCatalog(merged.document)), [
        'project-existing',
        'project-left-window',
        'project-right-window',
    ]);
    assert.deepEqual(merged.conflictProjectIds, [
        'project-left-window',
        'project-right-window',
    ]);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 model does not grow history across repeated fixed-actor mutations', () => {
    const {
        applyProjectCatalogSnapshot,
        materializeProjectCatalog,
        migrateLegacyProjectCatalog,
    } = loadProjectCatalogSyncModel();
    let document = migrateLegacyProjectCatalog(makeCatalogGroups(), 'actor-a');

    for (let index = 0; index < 1000; index += 1) {
        const project = {
            id: `temporary-${index}`,
            name: `Temporary ${index}`,
            path: `/work/temporary-${index}`,
            color: '#778899',
        };
        document = applyProjectCatalogSnapshot(
            document,
            makeCatalogGroups([project]),
            'actor-b'
        );
        document = applyProjectCatalogSnapshot(
            document,
            makeCatalogGroups(),
            'actor-a',
            { deletedProjectIds: [project.id] }
        );
    }

    assert.deepEqual(projectIds(materializeProjectCatalog(document)), ['project-existing']);
    assert.deepEqual(Object.keys(document.versionVector).sort(), ['actor-a', 'actor-b']);
    for (const forbidden of ['operations', 'tombstones', 'projectTombstones', 'groupTombstones']) {
        assert.equal(Object.prototype.hasOwnProperty.call(document, forbidden), false);
    }
    assert.equal(Object.keys(document.projects).length, 1);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 model removes a deleted group project records without orphan metadata', () => {
    const {
        applyProjectCatalogSnapshot,
        materializeProjectCatalog,
        migrateLegacyProjectCatalog,
    } = loadProjectCatalogSyncModel();
    const document = migrateLegacyProjectCatalog(makeCatalogGroups(), 'actor-a');

    const deleted = applyProjectCatalogSnapshot(
        document,
        [],
        'actor-a',
        { deletedGroupIds: ['group-main'] }
    );

    assert.deepEqual(materializeProjectCatalog(deleted), []);
    assert.deepEqual(Object.keys(deleted.groups), []);
    assert.deepEqual(Object.keys(deleted.projects), []);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 persistence writes shadow before sync data and compatibility projection', async () => {
    const harness = makeSyncPersistenceHarness();

    const result = await harness.service.reconcile();

    assert.deepEqual(projectIds(harness.service.getGroups()), ['project-existing']);
    assert.deepEqual(harness.writes, [
        'globalState:projectCatalogSyncLocal.v1',
        'settings:projectSyncData',
        'settings:projectData',
    ]);
    assert.equal(result.repaired, true);
    harness.writes.length = 0;
    await harness.service.reconcile();
    assert.deepEqual(harness.writes, []);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 persistence reads merged shadow state before asynchronous repair', () => {
    const {
        applyProjectCatalogSnapshot,
        migrateLegacyProjectCatalog,
    } = loadProjectCatalogSyncModel();
    const base = migrateLegacyProjectCatalog(makeCatalogGroups(), 'actor-a');
    const addedProject = {
        id: 'project-build-your-own-x',
        name: 'build-your-own-x',
        path: '/work/build-your-own-x',
        color: '#445566',
    };
    const withAdded = applyProjectCatalogSnapshot(
        base,
        makeCatalogGroups([addedProject]),
        'actor-b'
    );
    const harness = makeSyncPersistenceHarness({
        syncData: base,
        localState: {
            schemaVersion: 1,
            actorId: 'actor-b',
            document: withAdded,
        },
    });

    assert.deepEqual(projectIds(harness.service.getGroups()), [
        'project-build-your-own-x',
        'project-existing',
    ]);
    assert.deepEqual(harness.writes, []);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 hardening repairs malformed sync data without logging catalog content', async () => {
    const {
        applyProjectCatalogSnapshot,
        migrateLegacyProjectCatalog,
    } = loadProjectCatalogSyncModel();
    const base = migrateLegacyProjectCatalog(makeCatalogGroups(), 'actor-a');
    const secretProject = {
        id: 'project-secret',
        name: 'Secret',
        description: 'private project description',
        path: '/work/secret',
        color: '#123456',
    };
    const recovered = applyProjectCatalogSnapshot(
        base,
        makeCatalogGroups([secretProject]),
        'actor-b'
    );
    const harness = makeSyncPersistenceHarness({
        syncData: {
            schemaVersion: 1,
            malformed: 'private project description',
        },
        localState: {
            schemaVersion: 1,
            actorId: 'actor-b',
            document: recovered,
        },
    });

    await harness.service.reconcile();

    assert.deepEqual(projectIds(harness.service.getGroups()), [
        'project-existing',
        'project-secret',
    ]);
    assert.equal(
        harness.diagnostics.some(event =>
            event.event === 'project-catalog-sync-invalid-source'
            && event.source === 'projectSyncData'),
        true
    );
    const reconciliation = harness.diagnostics.find(event =>
        event.event === 'project-catalog-sync-reconciled');
    assert.equal(reconciliation.actorId, 'actor-b');
    assert.deepEqual(reconciliation.causalVersionVector, recovered.versionVector);
    assert.equal(reconciliation.repairReasons.includes('invalid-sync-data'), true);
    assert.deepEqual(reconciliation.affectedProjectIds, []);
    assert.equal(JSON.stringify(harness.diagnostics).includes('private project description'), false);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 hardening migrates valid legacy data when sync is malformed and no shadow exists', async () => {
    const legacyProject = {
        id: 'project-legacy-recovery',
        name: 'Legacy recovery',
        path: '/work/legacy-recovery',
        color: '#246810',
    };
    const harness = makeSyncPersistenceHarness({
        legacyGroups: makeCatalogGroups([legacyProject]),
        syncData: { schemaVersion: 1, malformed: true },
        localState: null,
    });

    await harness.service.reconcile();

    assert.deepEqual(projectIds(harness.service.getGroups()), [
        'project-existing',
        'project-legacy-recovery',
    ]);
    assert.deepEqual(projectIds(
        loadProjectCatalogSyncModel().materializeProjectCatalog(harness.values.syncData)
    ), [
        'project-existing',
        'project-legacy-recovery',
    ]);
    assert.equal(
        harness.diagnostics.some(event =>
            event.event === 'project-catalog-sync-invalid-source'
            && event.source === 'projectSyncData'),
        true
    );
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 hardening imports a legacy-client addition without accepting legacy omissions', async () => {
    const {
        materializeProjectCatalog,
        migrateLegacyProjectCatalog,
    } = loadProjectCatalogSyncModel();
    const baseline = makeCatalogGroups();
    const baseDocument = migrateLegacyProjectCatalog(baseline, 'actor-a');
    const legacyAddition = {
        id: 'project-legacy-client',
        name: 'Legacy client',
        path: '/work/legacy-client',
        color: '#654321',
    };
    const harness = makeSyncPersistenceHarness({
        legacyGroups: makeCatalogGroups([legacyAddition]),
        syncData: baseDocument,
        localState: {
            schemaVersion: 1,
            actorId: 'actor-a',
            document: baseDocument,
            legacyProjection: baseline,
        },
    });

    await harness.service.reconcile();

    assert.deepEqual(projectIds(harness.service.getGroups()), [
        'project-existing',
        'project-legacy-client',
    ]);
    assert.deepEqual(projectIds(materializeProjectCatalog(harness.values.syncData)), [
        'project-existing',
        'project-legacy-client',
    ]);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 hardening does not resurrect a canonical deletion from legacy data without a confirmed baseline', async () => {
    const {
        applyProjectCatalogSnapshot,
        migrateLegacyProjectCatalog,
    } = loadProjectCatalogSyncModel();
    const baseline = makeCatalogGroups();
    const baseDocument = migrateLegacyProjectCatalog(baseline, 'actor-a');
    const deletedDocument = applyProjectCatalogSnapshot(
        baseDocument,
        [],
        'actor-a',
        {
            deletedGroupIds: ['group-main'],
            deletedProjectIds: ['project-existing'],
        }
    );
    const harness = makeSyncPersistenceHarness({
        legacyGroups: baseline,
        syncData: deletedDocument,
        localState: null,
    });

    await harness.service.reconcile();

    assert.deepEqual(harness.service.getGroups(), []);
    assert.deepEqual(harness.values.legacyGroups, []);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 hardening aborts before settings when shadow fails and retries later settings failures', async () => {
    const addedProject = {
        id: 'project-retry',
        name: 'Retry',
        path: '/work/retry',
        color: '#abcdef',
    };
    const shadowError = new Error('shadow unavailable');
    const shadowFailure = makeSyncPersistenceHarness({ failLocal: shadowError });
    await assert.rejects(
        shadowFailure.service.saveGroups(makeCatalogGroups([addedProject])),
        shadowError
    );
    assert.deepEqual(shadowFailure.writes, ['globalState:projectCatalogSyncLocal.v1']);

    const syncError = new Error('sync unavailable');
    const retry = makeSyncPersistenceHarness({ failSync: syncError });
    await assert.rejects(
        retry.service.saveGroups(makeCatalogGroups([addedProject])),
        syncError
    );
    assert.deepEqual(retry.writes, [
        'globalState:projectCatalogSyncLocal.v1',
        'settings:projectSyncData',
    ]);
    retry.failures.sync = null;
    retry.writes.length = 0;

    await retry.service.reconcile();

    assert.deepEqual(projectIds(retry.service.getGroups()), [
        'project-existing',
        'project-retry',
    ]);
    assert.deepEqual(retry.writes, [
        'settings:projectSyncData',
        'settings:projectData',
        'globalState:projectCatalogSyncLocal.v1',
    ]);
    retry.writes.length = 0;
    await retry.service.reconcile();
    assert.deepEqual(retry.writes, []);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 hardening confirms the legacy baseline only after its projection succeeds', async () => {
    const addedProject = {
        id: 'project-projection-retry',
        name: 'Projection retry',
        path: '/work/projection-retry',
        color: '#fedcba',
    };
    const projectionError = new Error('legacy projection unavailable');
    const harness = makeSyncPersistenceHarness({ failLegacy: projectionError });

    await assert.rejects(
        harness.service.saveGroups(makeCatalogGroups([addedProject])),
        projectionError
    );
    assert.deepEqual(harness.writes, [
        'globalState:projectCatalogSyncLocal.v1',
        'settings:projectSyncData',
        'settings:projectData',
    ]);
    assert.deepEqual(
        projectIds(harness.values.localState.legacyProjection),
        ['project-existing']
    );

    harness.failures.legacy = null;
    harness.writes.length = 0;
    await harness.service.reconcile();

    assert.deepEqual(harness.writes, [
        'settings:projectData',
        'globalState:projectCatalogSyncLocal.v1',
    ]);
    assert.deepEqual(
        projectIds(harness.values.localState.legacyProjection),
        ['project-existing', 'project-projection-retry']
    );
    harness.writes.length = 0;
    await harness.service.reconcile();
    assert.deepEqual(harness.writes, []);
});

test('PROJECT-INCREMENTAL-REFRESH-001 consumes each exact local Settings write echo once', async () => {
    const addedProject = {
        id: 'project-echo',
        name: 'Echo',
        path: '/work/echo',
        color: '#123456',
    };
    const harness = makeSyncPersistenceHarness();

    await harness.service.saveGroups(makeCatalogGroups([addedProject]));

    assert.equal(harness.service.consumeConfigurationWriteEcho({
        syncData: true,
        legacyGroups: true,
    }), true);
    assert.equal(harness.service.consumeConfigurationWriteEcho({
        syncData: true,
        legacyGroups: true,
    }), false);
});

test('PROJECT-INCREMENTAL-REFRESH-001 treats a mismatched Settings value as external', async () => {
    const harness = makeSyncPersistenceHarness();
    await harness.service.saveGroups(makeCatalogGroups([{
        id: 'project-local',
        name: 'Local',
        path: '/work/local',
        color: '#654321',
    }]));
    harness.values.legacyGroups = makeCatalogGroups([{
        id: 'project-external',
        name: 'External',
        path: '/work/external',
        color: '#abcdef',
    }]);

    assert.equal(harness.service.consumeConfigurationWriteEcho({
        syncData: false,
        legacyGroups: true,
    }), false);
    assert.equal(harness.service.consumeConfigurationWriteEcho({
        syncData: false,
        legacyGroups: true,
    }), false);
});
