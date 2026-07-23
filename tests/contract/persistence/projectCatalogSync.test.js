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
