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

    return {
        configurationValues,
        clientA: new ProjectService({ globalState: makeMemento() }, colorService),
        clientB: new ProjectService({ globalState: makeMemento() }, colorService),
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
