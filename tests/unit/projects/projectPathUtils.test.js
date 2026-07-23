'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    encodeRemoteAuthority,
    getPathMatchScore,
    normalizePosixPath,
    normalizeRemoteAuthority,
} = require('../../../out/projects/projectPathUtils');

test('PROJECT-PATH-001 normalizes POSIX paths for stable comparison', () => {
    for (const [input, expected] of [
        ['/work/app/../app/src/', '/work/app/src'],
        ['/', '/'],
        ['/work/app///', '/work/app'],
    ]) {
        assert.equal(normalizePosixPath(input), expected);
    }
});

test('PROJECT-PATH-002 scores exact, containing, and basename path matches', () => {
    for (const [currentPath, recentPath, isWorkspaceEntry, expected] of [
        ['/work/app', '/work/app', true, 100],
        ['/work/app/src', '/work/app', true, 80],
        ['/work/app', '/work/app/src', true, 70],
        ['/work/app', '/work/app/file.ts', false, 40],
        ['/work/app', '/other/app', false, 10],
        ['/work/app', '/other/project', true, 0],
    ]) {
        assert.equal(getPathMatchScore(currentPath, recentPath, isWorkspaceEntry), expected);
    }
});

test('PROJECT-PATH-003 decodes URI-encoded remote authorities without changing invalid encodings', () => {
    assert.equal(normalizeRemoteAuthority('ssh-remote%2Bserver'), 'ssh-remote+server');
    assert.equal(normalizeRemoteAuthority('dev-container+abc'), 'dev-container+abc');
    assert.equal(normalizeRemoteAuthority('%not-an-encoding'), '%not-an-encoding');
});

test('PROJECT-PATH-004 encodes each remote authority component while preserving the user-host separator', () => {
    assert.equal(encodeRemoteAuthority('ssh-remote+user@host'), 'ssh-remote%2Buser@host');
    assert.equal(encodeRemoteAuthority('dev-container%2Btarget%40ssh-remote%2Bhost'), 'dev-container%2Btarget@ssh-remote%2Bhost');
});
