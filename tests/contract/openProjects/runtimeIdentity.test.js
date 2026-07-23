'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { WorkspaceContextResolver } = require('../../../out/workspaces/contextResolver');

function uriFrom(value, fsPath) {
    const parsed = new URL(value.includes('://') ? value : `file://${value}`);
    return {
        scheme: parsed.protocol.slice(0, -1),
        authority: parsed.host,
        path: parsed.pathname,
        fsPath: fsPath || parsed.pathname,
        toString: () => parsed.toString(),
    };
}

test('OPEN-OPEN-PROJECT-RUNTIME-IDENTITY-001 keeps local and remote workspaces with the same path distinct', () => {
    const resolver = new WorkspaceContextResolver();
    const local = resolver.resolve({
        workspaceFolders: [{ name: 'app', uri: uriFrom('/work/app') }],
    });
    const remote = resolver.resolve({
        workspaceFolders: [{
            name: 'app',
            uri: uriFrom('vscode-remote://dev-container%2Bfixture/work/app', '/work/app'),
        }],
        remoteName: 'dev-container',
    });

    assert.equal(local.navigationUri, 'file:///work/app');
    assert.equal(local.environment, 'local');
    assert.equal(remote.navigationUri, 'vscode-remote://dev-container%2Bfixture/work/app');
    assert.equal(remote.environment, 'devContainer');
    assert.notEqual(local.navigationIdentity, remote.navigationIdentity);
    assert.notEqual(local.scopeIdentity, remote.scopeIdentity);
});

test('OPEN-OPEN-PROJECT-RUNTIME-IDENTITY-001 preserves workspace-file precedence, untitled identity, and root ordinals', () => {
    const resolver = new WorkspaceContextResolver();
    const workspaceFile = uriFrom('/work/team.code-workspace');
    const folders = [
        { name: 'first', uri: uriFrom('/work/first') },
        { name: 'second', uri: uriFrom('/work/second') },
    ];
    const saved = resolver.resolve({
        workspaceFile,
        workspaceFolders: folders,
        workspaceName: 'Team (Workspace)',
    });

    assert.equal(saved.kind, 'savedMultiRoot');
    assert.equal(saved.navigationUri, 'file:///work/team.code-workspace');
    assert.equal(saved.displayName, 'Team');
    assert.deepEqual(saved.roots.map(root => [root.name, root.ordinal]), [['first', 0], ['second', 1]]);
    assert.deepEqual(saved.roots.map(root => root.hostPath), ['/work/first', '/work/second']);

    const untitled = resolver.resolve({
        workspaceFile: { ...uriFrom('/Untitled-1'), scheme: 'untitled' },
        workspaceFolders: folders,
        workspaceName: 'Untitled-1',
    });
    assert.equal(untitled.kind, 'untitledMultiRoot');
    assert.equal(untitled.displayName, 'Untitled');
    assert.equal(untitled.navigationUri, 'file:///Untitled-1');
    assert.deepEqual(untitled.roots.map(root => root.ordinal), [0, 1]);
    assert.notEqual(saved.navigationIdentity, untitled.navigationIdentity);
    assert.equal(saved.scopeIdentity, untitled.scopeIdentity);
});
