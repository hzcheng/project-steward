'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    Project,
    ProjectOpenType,
    ProjectPathType,
    ProjectRemoteType,
} = require('../../../out/models');
const { loadWithFakeVscode } = require('./helpers');
const {
    OpenWorkspaceController,
} = loadWithFakeVscode('../../../out/openWorkspaces/workspaceController');
const {
    CurrentProjectDetailsResolver,
} = loadWithFakeVscode('../../../out/projects/currentProjectDetails');
const {
    ProjectOpenController,
} = loadWithFakeVscode('../../../out/projects/projectOpenController');

function fileUri(value) {
    return {
        scheme: 'file',
        authority: '',
        fsPath: value,
        path: value,
        toString: () => `file://${value}`,
    };
}

function parseUri(value) {
    const match = String(value).match(/^([^:]+):\/\/([^/]*)(\/.*)?$/);
    return {
        scheme: match ? match[1] : 'file',
        authority: match ? match[2] : '',
        fsPath: match && match[1] !== 'file' ? match[3] || '/' : value,
        path: match ? match[3] || '/' : value,
        toString: () => String(value),
    };
}

function createWorkspaceController(overrides = {}) {
    const workspace = {
        navigationIdentity: 'a'.repeat(64),
        scopeIdentity: 'b'.repeat(64),
        kind: 'singleFolder',
        displayName: 'Shared',
        navigationUri: 'file:///work/shared',
        environment: 'local',
        roots: [{
            id: 'c'.repeat(64),
            name: 'shared',
            uri: 'file:///work/shared',
            hostPath: '/work/shared',
            ordinal: 0,
        }],
    };
    return new OpenWorkspaceController({
        getWorkspace: () => workspace,
        getRunningAiSessionCount: () => 0,
        publishWorkspace: () => undefined,
        ...overrides,
    });
}

test('PROJECT-WORKSPACE-CONTROLLER-RECORD-001 includes the live session count in every publication snapshot', () => {
    const controller = createWorkspaceController({
        getRunningAiSessionCount: () => 2,
    });

    assert.equal(controller.getPublication().runningAiSessionCount, 2);
    assert.equal(controller.getPublication().runningAiSessionCount, 2);
});

test('OPEN-OPEN-PROJECT-WORKSPACE-CONTROLLER-001 refreshes workspace metadata and preserves focus intent', () => {
    const publications = [];
    let name = 'Shared';
    const controller = createWorkspaceController({
        getWorkspace: () => ({
            navigationIdentity: 'a'.repeat(64),
            scopeIdentity: 'b'.repeat(64),
            kind: 'singleFolder',
            displayName: name,
            navigationUri: 'file:///work/shared',
            environment: 'local',
            roots: [{
                id: 'c'.repeat(64), name: 'shared', uri: 'file:///work/shared',
                hostPath: '/work/shared', ordinal: 0,
            }],
        }),
        publishWorkspace: (workspace, followsFocusEvent) => publications.push({ workspace, followsFocusEvent }),
    });

    assert.equal(controller.getCurrentWorkspace().displayName, 'Shared');
    name = 'Renamed';
    assert.equal(controller.getCurrentWorkspace().displayName, 'Shared', 'reads are stable until refresh');
    controller.publish(true);

    assert.equal(publications[0].followsFocusEvent, true);
    assert.equal(publications[0].workspace.displayName, 'Renamed');
    assert.equal(controller.getCurrentWorkspace().displayName, 'Renamed');
});

test('OPEN-CURRENT-PROJECT-DETAILS-RESOLVER-001 resolves workspace metadata and returns null without a workspace', async () => {
    const workspaceUri = fileUri('/work/current');
    const calls = [];
    const resolver = new CurrentProjectDetailsResolver({
        getWorkspaceFile: () => null,
        getWorkspaceFolders: () => [{ uri: workspaceUri }],
        getRemoteName: () => 'dev-container',
        getProjectDetailsForSave: async (uri, remoteName) => {
            calls.push([uri, remoteName]);
            return { path: uri.fsPath, remoteType: ProjectRemoteType.DevContainer };
        },
    });

    assert.deepEqual(await resolver.getCurrentProjectDetailsForSave(), {
        path: '/work/current',
        remoteType: ProjectRemoteType.DevContainer,
    });
    assert.deepEqual(calls, [[workspaceUri, 'dev-container']]);

    const empty = new CurrentProjectDetailsResolver({
        getWorkspaceFile: () => null,
        getWorkspaceFolders: () => [],
        getRemoteName: () => undefined,
        getProjectDetailsForSave: async () => { throw new Error('must not resolve'); },
    });
    assert.equal(await empty.getCurrentProjectDetailsForSave(), null);
});

test('OPEN-PROJECT-OPEN-CONTROLLER-001 skips the current workspace and maps local and remote window modes', async () => {
    const commands = [];
    const warnings = [];
    const workspaceUpdates = [];
    const currentUri = fileUri('/work/current');
    const controller = new ProjectOpenController({
        getWorkspaceFile: () => null,
        getWorkspaceFolders: () => [{ uri: currentUri }],
        getPrependVscodeUrlToWslRemotes: () => true,
        getProjectPathType: async () => ProjectPathType.Folder,
        getFoldersFromWorkspaceFile: async () => [],
        showWarningMessage: message => warnings.push(message),
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        executeCommand: async (command, ...args) => commands.push([command, ...args]),
        updateWorkspaceFolders: (start, deleteCount, ...folders) => {
            workspaceUpdates.push([start, deleteCount, folders]);
            return true;
        },
        updateReopenReason: () => undefined,
        fileUri,
        parseUri,
    });

    await controller.openProject({ name: 'Current', path: '/work/current' }, ProjectOpenType.Default);
    await controller.openProject({ name: 'Target', path: '/work/target' }, ProjectOpenType.Default);
    await controller.openProject({ name: 'Folder', path: '/work/folder' }, ProjectOpenType.AddToWorkspace);
    await controller.openProject({
        name: 'SSH',
        path: 'vscode-remote://ssh-remote+host',
        remoteType: ProjectRemoteType.SSH,
    }, ProjectOpenType.NewWindow);

    assert.equal(commands[0][0], 'vscode.openFolder');
    assert.equal(commands[0][1].fsPath, '/work/target');
    assert.deepEqual(commands[0][2], { forceNewWindow: true });
    assert.deepEqual(commands[1], [
        'vscode.newWindow',
        { remoteAuthority: 'ssh-remote+host', reuseWindow: false },
    ]);
    assert.equal(workspaceUpdates[0][2][0].name, 'Folder');
    assert.deepEqual(warnings, []);
});
