'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function uriFrom(value) {
    if (!value.includes('://')) {
        return {
            scheme: 'file', authority: '', path: value, fsPath: value,
            toString: () => `file://${value}`,
        };
    }
    const parsed = new URL(value);
    return {
        scheme: parsed.protocol.slice(0, -1),
        authority: parsed.host,
        path: parsed.pathname,
        fsPath: parsed.pathname,
        toString: () => value,
    };
}

function loadOpenProjectService() {
    const vscode = { Uri: { parse: uriFrom, file: uriFrom } };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        for (const modulePath of [
            '../../../out/models',
            '../../../out/projects/openProjectMatcher',
            '../../../out/projects/openProjectService',
        ]) delete require.cache[require.resolve(modulePath)];
        return require('../../../out/projects/openProjectService');
    } finally {
        Module._load = previousLoad;
    }
}

const service = loadOpenProjectService();
const options = overrides => ({
    savedProjects: [], currentRemoteName: undefined, isFolderGitRepo: () => false, ...overrides,
});

test('OPEN-OPEN-PROJECT-RUNTIME-IDENTITY-001 keeps the real local workspace identity when a saved remote has the same path', () => {
    const projects = service.getOpenProjectsFromWorkspace(null, [{
        name: 'app', uri: uriFrom('/work/app'),
    }], options({
        currentRemoteName: 'dev-container',
        savedProjects: [{
            id: 'saved-remote', name: 'Saved Remote', description: 'Remote metadata',
            path: 'vscode-remote://dev-container%2Bfixture/work/app', color: '#123456', remoteType: 3,
        }],
    }));

    assert.equal(projects.length, 1);
    assert.equal(projects[0].path, '/work/app');
    assert.equal(projects[0].name, 'Saved Remote');
    assert.equal(projects[0].attentionProjectPath, undefined);
    assert.equal(projects[0].showSaveAction, false);
    assert.equal(projects[0].color, '#123456');
});

test('OPEN-OPEN-PROJECT-RUNTIME-IDENTITY-001 preserves workspace-file precedence, untitled fallback, ordinals, and URI lookup', () => {
    const workspaceFile = uriFrom('/work/team.code-workspace');
    const ignoredFolder = { name: 'ignored', uri: uriFrom('/work/ignored') };
    const workspaceProjects = service.getOpenProjectsFromWorkspace(
        workspaceFile, [ignoredFolder], options({ isFolderGitRepo: value => value === '/work/team.code-workspace' })
    );
    assert.equal(workspaceProjects.length, 1);
    assert.equal(workspaceProjects[0].path, '/work/team.code-workspace');
    assert.equal(workspaceProjects[0].name, 'team');
    assert.equal(workspaceProjects[0].description, 'Current workspace');
    assert.equal(workspaceProjects[0].id, '__openProjects-0');
    assert.equal(workspaceProjects[0].isGitRepo, true);
    assert.equal(service.getOpenProjectUri('__openProjects-0', workspaceFile, [ignoredFolder]), workspaceFile);
    assert.equal(service.getOpenProjectUri('__openProjects-1', workspaceFile, [ignoredFolder]), null);

    const untitled = { ...uriFrom('/Untitled-1'), scheme: 'untitled' };
    const folders = [
        { name: 'first', uri: uriFrom('/work/first') },
        { name: 'second', uri: uriFrom('/work/second') },
    ];
    const folderProjects = service.getOpenProjectsFromWorkspace(untitled, folders, options({}));
    assert.deepEqual(folderProjects.map(project => project.path), ['/work/first', '/work/second']);
    assert.deepEqual(folderProjects.map(project => project.id), ['__openProjects-0', '__openProjects-1']);
    assert.equal(service.getOpenProjectUri('__openProjects-1', untitled, folders), folders[1].uri);
    assert.equal(service.getOpenProjectUri('saved-project', untitled, folders), null);
    assert.equal(service.getOpenProjectUri('__openProjects-invalid', untitled, folders), null);
});
