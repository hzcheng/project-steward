'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    getFavoriteProjectsInOrder,
    withFavoriteProjectOrder,
    withToggledProjectFavorite,
} = require('../../../out/projects/favoriteProjectOrder');

test('PROJECT-FAVORITE-PROJECT-ORDER-001 orders unique explicit favorites before stable legacy favorites', () => {
    const projects = [
        { id: 'legacy-a', favorite: true },
        { id: 'ordered', favorite: true, favoriteOrder: 0 },
        { id: 'duplicate-a', favorite: true, favoriteOrder: 2 },
        { id: 'duplicate-b', favorite: true, favoriteOrder: 2 },
        { id: 'invalid', favorite: true, favoriteOrder: -1 },
        { id: 'plain', favorite: false, favoriteOrder: 7 },
    ];

    assert.deepEqual(
        getFavoriteProjectsInOrder(projects).map(project => project.id),
        ['ordered', 'legacy-a', 'duplicate-a', 'duplicate-b', 'invalid']
    );
});

test('PROJECT-FAVORITE-PROJECT-ORDER-001 normalizes drag order without mutating source groups', () => {
    const groups = [{
        id: 'one',
        projects: [
            { id: 'a', favorite: true, favoriteOrder: 0 },
            { id: 'b', favorite: true, favoriteOrder: 1 },
            { id: 'plain', favorite: false, favoriteOrder: 8 },
        ],
    }, {
        id: 'two',
        projects: [
            { id: 'c', favorite: true },
            { id: 'd', favorite: true },
        ],
    }];

    const reordered = withFavoriteProjectOrder(groups, ['d', 'b', 'd', 'unknown', 'plain']);
    const projects = reordered.flatMap(group => group.projects);

    assert.deepEqual(
        getFavoriteProjectsInOrder(projects).map(project => project.id),
        ['d', 'b', 'a', 'c']
    );
    assert.deepEqual(
        getFavoriteProjectsInOrder(projects).map(project => project.favoriteOrder),
        [0, 1, 2, 3]
    );
    assert.equal(projects.find(project => project.id === 'plain').favoriteOrder, undefined);
    assert.equal(groups[0].projects[1].favoriteOrder, 1);
    assert.notEqual(reordered[0], groups[0]);
    assert.notEqual(reordered[0].projects[0], groups[0].projects[0]);
});

test('PROJECT-FAVORITE-PROJECT-ORDER-001 appends newly favorited projects and compacts removal order', () => {
    const groups = [{
        id: 'group',
        projects: [
            { id: 'a', favorite: true, favoriteOrder: 0 },
            { id: 'b', favorite: true, favoriteOrder: 1 },
            { id: 'c', favorite: false, favoriteOrder: 9 },
        ],
    }];

    const added = withToggledProjectFavorite(groups, 'c');
    assert.deepEqual(
        getFavoriteProjectsInOrder(added[0].projects).map(project => project.id),
        ['a', 'b', 'c']
    );
    assert.equal(added[0].projects[2].favoriteOrder, 2);

    const removed = withToggledProjectFavorite(added, 'b');
    assert.deepEqual(
        getFavoriteProjectsInOrder(removed[0].projects).map(project => project.id),
        ['a', 'c']
    );
    assert.equal(removed[0].projects[1].favoriteOrder, undefined);
    assert.equal(withToggledProjectFavorite(groups, 'missing'), null);
    assert.equal(groups[0].projects[2].favorite, false);
    assert.equal(groups[0].projects[2].favoriteOrder, 9);
});
