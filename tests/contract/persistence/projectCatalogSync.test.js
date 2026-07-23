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

function makeSyncPersistenceHarness({ legacyGroups, syncData = null, localState = null } = {}) {
    const values = {
        legacyGroups: clone(legacyGroups || makeCatalogGroups()),
        syncData: clone(syncData),
        localState: clone(localState),
    };
    const writes = [];
    const conflicts = [];
    const diagnostics = [];
    const ProjectCatalogSyncService = loadProjectCatalogSyncService();
    const service = new ProjectCatalogSyncService({
        getSyncData: () => clone(values.syncData),
        updateSyncData: async value => {
            writes.push('settings:projectSyncData');
            values.syncData = clone(value);
        },
        getLegacyGroups: () => clone(values.legacyGroups),
        updateLegacyGroups: async groups => {
            writes.push('settings:projectData');
            values.legacyGroups = clone(groups);
        },
        getLocalState: () => clone(values.localState),
        updateLocalState: async value => {
            writes.push('globalState:projectCatalogSyncLocal.v1');
            values.localState = clone(value);
        },
        createActorId: () => 'actor-local',
        onDiagnostic: event => diagnostics.push(clone(event)),
        onConflict: projectIds => conflicts.push([...projectIds]),
    });
    return { conflicts, diagnostics, service, values, writes };
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
