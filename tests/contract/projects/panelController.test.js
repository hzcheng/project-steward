'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');
const { loadFreshWithFakeVscode } = require('../../helpers/runtimeContract');
const {
    ProjectsPanelController,
} = loadFreshWithFakeVscode(
    '../../../out/dashboard/projectsPanelController',
    createFakeVscode({}),
    __dirname
);

function makeCatalog() {
    return {
        version: 2,
        sessions: [],
        openWorkspaces: [],
        savedProjects: [],
        todos: [],
    };
}

function flushAsync() {
    return new Promise(resolve => setImmediate(resolve));
}

test('PROJECT-INCREMENTAL-REFRESH-001 posts authoritative order with a monotonic sequence', async () => {
    const posted = [];
    const groups = [{
        id: 'work',
        groupName: 'Work',
        collapsed: false,
        projects: [
            { id: 'plain', name: 'Plain', path: '/plain' },
            { id: 'favorite-b', name: 'B', path: '/b', favorite: true, favoriteOrder: 1 },
            { id: 'favorite-a', name: 'A', path: '/a', favorite: true, favoriteOrder: 0 },
        ],
    }];
    const controller = new ProjectsPanelController({
        getGroups: () => groups,
        getSearchCatalog: makeCatalog,
        renderHtml: value => `<main>${value[0].groupName}</main>`,
        postMessage: message => {
            posted.push(message);
            return Promise.resolve(true);
        },
        refresh: () => undefined,
        isVisible: () => true,
        logError: () => undefined,
    });

    controller.postUpdated('preserve-order');
    controller.postUpdated('replace');
    await flushAsync();

    assert.deepEqual(posted.map(message => ({
        type: message.type,
        version: message.version,
        sequence: message.sequence,
        mode: message.mode,
        groupOrders: message.groupOrders,
        favoriteProjectIds: message.favoriteProjectIds,
    })), [{
        type: 'projects-panel-updated',
        version: 1,
        sequence: 1,
        mode: 'preserve-order',
        groupOrders: [{
            groupId: 'work',
            projectIds: ['plain', 'favorite-b', 'favorite-a'],
        }],
        favoriteProjectIds: ['favorite-a', 'favorite-b'],
    }, {
        type: 'projects-panel-updated',
        version: 1,
        sequence: 2,
        mode: 'replace',
        groupOrders: [{
            groupId: 'work',
            projectIds: ['plain', 'favorite-b', 'favorite-a'],
        }],
        favoriteProjectIds: ['favorite-a', 'favorite-b'],
    }]);
});

test('PROJECT-INCREMENTAL-REFRESH-001 falls back to a full refresh on delivery failure', async () => {
    const refreshes = [];
    const errors = [];
    let reject = false;
    const controller = new ProjectsPanelController({
        getGroups: () => [],
        getSearchCatalog: makeCatalog,
        renderHtml: () => '<main></main>',
        postMessage: () => reject
            ? Promise.reject(new Error('closed'))
            : Promise.resolve(false),
        refresh: reason => refreshes.push(reason),
        isVisible: () => true,
        logError: (message, error) => errors.push([message, error.message]),
    });

    controller.postUpdated();
    await flushAsync();
    reject = true;
    controller.postUpdated();
    await flushAsync();

    assert.deepEqual(refreshes, [
        'projects-panel-update-not-delivered',
        'projects-panel-update-post-error',
    ]);
    assert.deepEqual(errors, [[
        'Failed to post Projects panel update message.',
        'closed',
    ]]);
});
