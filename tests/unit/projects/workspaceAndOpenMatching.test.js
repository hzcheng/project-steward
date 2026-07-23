'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');

class FakeUri {
    constructor(scheme, authority, uriPath, fsPath, raw) {
        this.scheme = scheme;
        this.authority = authority || '';
        this.path = uriPath;
        this.fsPath = fsPath;
        this.raw = raw;
    }

    toString() {
        return this.raw;
    }

    static file(filePath) {
        const normalized = String(filePath).replace(/\\/g, '/');
        return new FakeUri('file', '', normalized, filePath, `file://${normalized}`);
    }

    static parse(value) {
        const text = String(value);
        const match = text.match(/^([^:]+):\/\/([^/]*)(\/[^?#]*)?/);
        if (match) {
            const scheme = match[1];
            const authority = match[2];
            const uriPath = match[3] || '/';
            return new FakeUri(scheme, authority, uriPath, scheme === 'file' ? uriPath : uriPath, text);
        }
        const scheme = text.includes(':') ? text.slice(0, text.indexOf(':')) : '';
        const uriPath = text.slice(text.indexOf(':') + 1) || '';
        return new FakeUri(scheme, '', uriPath, uriPath, text);
    }
}

function loadProjectModules() {
    const fakeVscode = createFakeVscode({});
    fakeVscode.Uri = FakeUri;
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return fakeVscode;
            }
            return previousLoad.call(this, request, parent, isMain);
        };
        return {
            matcher: require('../../../out/projects/openProjectMatcher'),
            service: require('../../../out/projects/openProjectService'),
            workspace: require('../../../out/projects/workspaceHelpers'),
        };
    } finally {
        Module._load = previousLoad;
    }
}

const { matcher, service, workspace } = loadProjectModules();

test('PROJECT-WORKSPACE-HELPER-001 selects a workspace file before folders and returns every folder otherwise', () => {
    const workspaceFile = FakeUri.file('/work/app.code-workspace');
    const workspaceFolders = [
        { uri: FakeUri.file('/work/app') },
        { uri: FakeUri.file('/work/packages/api') },
    ];

    assert.equal(workspace.getWorkspacePath(workspaceFile, workspaceFolders), '/work/app.code-workspace');
    assert.equal(workspace.getWorkspaceUri(workspaceFile, workspaceFolders).fsPath, '/work/app.code-workspace');
    assert.deepEqual(
        workspace.getWorkspaceUris(null, workspaceFolders).map(uri => uri.fsPath),
        ['/work/app', '/work/packages/api']
    );
    assert.equal(workspace.getWorkspacePath(null, []), null);
});

test('PROJECT-WORKSPACE-HELPER-001 matches local folder and workspace-file paths after separator normalization', () => {
    for (const [projectPath, workspaceUri] of [
        ['/work/app/', FakeUri.file('/work/app')],
        ['C:\\work\\app\\', FakeUri.file('C:\\work\\app')],
        ['file:///work/app.code-workspace', FakeUri.file('/work/app.code-workspace')],
    ]) {
        assert.equal(matcher.projectPathMatchesWorkspaceUri(projectPath, workspaceUri), true, projectPath);
    }
    assert.equal(matcher.projectPathMatchesWorkspaceUri('/work/application', FakeUri.file('/work/app')), false);
});

test('PROJECT-WORKSPACE-HELPER-001 matches encoded SSH WSL and Dev Container workspace URIs', () => {
    for (const [projectPath, workspaceUri] of [
        [
            'vscode-remote://ssh-remote%2Buser@host/work/app/',
            FakeUri.parse('vscode-remote://ssh-remote+user@host/work/app'),
        ],
        [
            'vscode-remote://wsl%2BUbuntu/home/dev/app',
            FakeUri.parse('vscode-remote://wsl+Ubuntu/home/dev/app/'),
        ],
        [
            'vscode-remote://dev-container%2Bfixture/workspaces/app',
            FakeUri.parse('vscode-remote://dev-container+fixture/workspaces/app'),
        ],
    ]) {
        assert.equal(matcher.projectPathMatchesWorkspaceUri(projectPath, workspaceUri), true, projectPath);
    }
    assert.equal(
        matcher.projectPathMatchesWorkspaceUri(
            'vscode-remote://ssh-remote+other/work/app',
            FakeUri.parse('vscode-remote://ssh-remote+host/work/app')
        ),
        false
    );
});

test('PROJECT-WORKSPACE-HELPER-001 resolves one unambiguous legacy remote-path match', () => {
    const savedProjects = [
        { id: 'ssh', path: 'vscode-remote://ssh-remote+host/work/app', remoteType: 1 },
        { id: 'wsl', path: 'vscode-remote://wsl+Ubuntu/work/app', remoteType: 2 },
    ];
    assert.equal(
        matcher.findSavedProjectForOpenProject(savedProjects, FakeUri.file('/work/app'), 'ssh-remote').id,
        'ssh'
    );
    assert.equal(
        matcher.findSavedProjectForOpenProject(savedProjects.concat({
            id: 'ssh-duplicate',
            path: 'vscode-remote://ssh-remote+other/work/app',
            remoteType: 1,
        }), FakeUri.file('/work/app'), 'ssh-remote'),
        null
    );
});

test('PROJECT-WORKSPACE-HELPER-001 delegates workspace navigation to the current workspace URI', () => {
    const folders = [{ uri: FakeUri.file('/work/app'), name: 'app' }];
    const workspaceFile = FakeUri.file('/work/app.code-workspace');
    assert.equal(service.getWorkspaceUri(workspaceFile, folders), workspaceFile);
    assert.deepEqual(service.getWorkspaceUris(null, folders), [folders[0].uri]);
});
