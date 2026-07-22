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
    OpenProjectWorkspaceController,
} = loadWithFakeVscode('../../../out/openProjects/workspaceController');
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
    const workspaceUri = fileUri('/work/shared');
    return new OpenProjectWorkspaceController({
        getWorkspaceFile: () => null,
        getWorkspaceFolders: () => [{ uri: workspaceUri, name: 'shared' }],
        getSavedProjects: () => [],
        getCurrentRemoteName: () => undefined,
        isFolderGitRepo: () => false,
        publishRecords: () => undefined,
        ...overrides,
    });
}

test('PROJECT-WORKSPACE-CONTROLLER-RECORD-001 includes live session counts except in the initial publication', () => {
    const controller = createWorkspaceController({
        getActiveSessionCounts: () => new Map([['__openProjects-0', 2]]),
    });

    assert.equal(controller.getOpenProjectRecords()[0].activeSessionCount, 2);
    assert.equal(controller.getOpenProjectRecords(false)[0].activeSessionCount, undefined);
});

test('OPEN-OPEN-PROJECT-WORKSPACE-CONTROLLER-001 publishes saved metadata and focus intent for workspace folders', () => {
    const workspaceUri = fileUri('/work/shared');
    const saved = new Project('Saved Shared', '/work/shared', 'Saved description');
    saved.color = '#123456';
    const publications = [];
    const controller = createWorkspaceController({
        getWorkspaceFolders: () => [{ uri: workspaceUri, name: 'shared' }],
        getSavedProjects: () => [saved],
        isFolderGitRepo: projectPath => projectPath === '/work/shared',
        publishRecords: (records, followsFocusEvent) => publications.push({ records, followsFocusEvent }),
    });

    const projects = controller.getRawOpenProjects();
    controller.publish(true);

    assert.deepEqual(projects.map(project => ({
        id: project.id,
        name: project.name,
        description: project.description,
        path: project.path,
        isGitRepo: project.isGitRepo,
    })), [{
        id: '__openProjects-0',
        name: 'Saved Shared',
        description: 'Saved description',
        path: '/work/shared',
        isGitRepo: true,
    }]);
    assert.equal(controller.getOpenProjectUri('__openProjects-0'), workspaceUri);
    assert.equal(controller.getOpenProjectUri('__openProjects-1'), null);
    assert.equal(publications[0].followsFocusEvent, true);
    assert.deepEqual(publications[0].records.map(record => ({
        id: record.localProjectId,
        name: record.name,
        uri: record.uri,
        color: record.color,
    })), [{ id: '__openProjects-0', name: 'Saved Shared', uri: '/work/shared', color: '#123456' }]);
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
