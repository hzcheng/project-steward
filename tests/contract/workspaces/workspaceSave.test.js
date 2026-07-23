'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    DashboardStartupController,
} = require('../../../out/dashboard/startupController');
const {
    PENDING_WORKSPACE_SAVE_TTL_MS,
    PendingWorkspaceSaveStore,
} = require('../../../out/workspaces/pendingWorkspaceSaveStore');
const {
    SavedWorkspaceProjectAdapter,
} = require('../../../out/workspaces/savedWorkspaceProjectAdapter');

const NOW = 40_000;

function memoryMemento(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        get: key => values.get(key),
        async update(key, value) {
            if (value === undefined) {
                values.delete(key);
            } else {
                values.set(key, structuredClone(value));
            }
        },
    };
}

function workspace(kind, overrides = {}) {
    return {
        navigationIdentity: `${kind}-navigation`,
        scopeIdentity: 'a'.repeat(64),
        kind,
        displayName: 'Team',
        navigationUri: kind === 'singleFolder'
            ? 'file:///work/app'
            : kind === 'savedMultiRoot'
                ? 'file:///work/team.code-workspace'
                : 'untitled:Untitled-1',
        environment: 'local',
        roots: [{
            id: 'b'.repeat(64),
            name: 'app',
            uri: 'file:///work/app',
            hostPath: '/work/app',
            ordinal: 0,
        }],
        ...overrides,
    };
}

function detailsFor(navigationUri) {
    return {
        path: navigationUri === 'file:///work/app'
            ? '/work/app'
            : '/work/team.code-workspace',
        remoteType: 0,
    };
}

function startup(migrateDataIfNeeded, afterProjectMigrationSucceeded) {
    return new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded,
        afterProjectMigrationSucceeded,
        refreshDashboard: () => undefined,
        publishOpenWorkspace: () => undefined,
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        logError: () => undefined,
        showSteward: () => undefined,
        applyProjectColorToCurrentWindow: () => undefined,
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'workspace',
        getVisibleEditorLanguageIds: () => [],
    });
}

test('PERSIST-WORKSPACE-SAVE-001 saves each live workspace kind exactly once', async () => {
    for (const kind of ['singleFolder', 'savedMultiRoot']) {
        const current = workspace(kind);
        const saved = [];
        const adapter = new SavedWorkspaceProjectAdapter({
            getCurrentWorkspace: () => current,
            pendingStore: new PendingWorkspaceSaveStore(memoryMemento()),
            getProjectDetailsForSave: async navigationUri => detailsFor(navigationUri),
            saveWorkspaceProject: async details => saved.push(details),
            executeSaveWorkspaceAs: async () => assert.fail(`${kind} must not invoke Save Workspace As`),
            nowMs: () => NOW,
        });
        await adapter.saveCurrentWorkspace();
        assert.deepEqual(saved, [detailsFor(current.navigationUri)]);
    }

    let current = workspace('untitledMultiRoot');
    const saved = [];
    const adapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => current,
        pendingStore: new PendingWorkspaceSaveStore(memoryMemento()),
        getProjectDetailsForSave: async navigationUri => detailsFor(navigationUri),
        saveWorkspaceProject: async details => saved.push(details),
        executeSaveWorkspaceAs: async () => {
            current = workspace('savedMultiRoot', { scopeIdentity: current.scopeIdentity });
        },
        nowMs: () => NOW,
    });
    await adapter.saveCurrentWorkspace();
    assert.deepEqual(saved, [detailsFor('file:///work/team.code-workspace')]);
});

test('PERSIST-WORKSPACE-SAVE-001 serializes duplicate save requests into one mutation', async () => {
    let releaseMutation;
    let mutationStarted;
    const mutationGate = new Promise(resolve => { releaseMutation = resolve; });
    const mutationStart = new Promise(resolve => { mutationStarted = resolve; });
    let mutations = 0;
    const current = workspace('savedMultiRoot');
    const adapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => current,
        pendingStore: new PendingWorkspaceSaveStore(memoryMemento()),
        getProjectDetailsForSave: async navigationUri => detailsFor(navigationUri),
        saveWorkspaceProject: async () => {
            mutations += 1;
            mutationStarted();
            await mutationGate;
        },
        executeSaveWorkspaceAs: async () => assert.fail('saved workspace must not invoke Save Workspace As'),
        nowMs: () => NOW,
    });

    const first = adapter.saveCurrentWorkspace();
    await mutationStart;
    const second = adapter.saveCurrentWorkspace();
    assert.equal(second, first);
    releaseMutation();
    await Promise.all([first, second]);
    assert.equal(mutations, 1);
});

test('PERSIST-WORKSPACE-SAVE-001 settles migration before saving and preserves fixture bytes', async () => {
    const fixturePath = path.resolve(
        __dirname,
        '../../../scripts/fixtures/workspace-first-saved-projects.json'
    );
    const fixtureGroups = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const fixtureBytes = JSON.stringify(fixtureGroups);
    const storedGroups = structuredClone(fixtureGroups);
    const state = memoryMemento();
    const pendingStore = new PendingWorkspaceSaveStore(state);
    const current = workspace('savedMultiRoot');
    await pendingStore.write(
        current.scopeIdentity,
        NOW,
        NOW + PENDING_WORKSPACE_SAVE_TTL_MS
    );

    let releaseMigration;
    const migrationGate = new Promise(resolve => { releaseMigration = resolve; });
    let saves = 0;
    const adapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => current,
        pendingStore,
        getProjectDetailsForSave: async navigationUri => detailsFor(navigationUri),
        saveWorkspaceProject: async details => {
            saves += 1;
            storedGroups[0].projects.push({
                id: 'saved-workspace',
                name: 'Team',
                description: '',
                path: details.path,
                remoteType: details.remoteType,
                favorite: false,
                color: '#445566',
                isGitRepo: false,
            });
        },
        executeSaveWorkspaceAs: async () => undefined,
        nowMs: () => NOW + 1,
    });
    const activation = startup(
        async () => {
            await migrationGate;
            return {
                projects: { migrated: true },
                todos: { migrated: false },
            };
        },
        () => adapter.completePendingWorkspaceSave()
    ).startUp();

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(saves, 0);
    releaseMigration();
    await activation;

    const preservedPrefix = storedGroups.map((group, index) => ({
        ...group,
        projects: group.projects.slice(0, fixtureGroups[index].projects.length),
    }));
    assert.equal(JSON.stringify(preservedPrefix), fixtureBytes);
    assert.equal(
        storedGroups.reduce((count, group) => count + group.projects.length, 0),
        fixtureGroups.reduce((count, group) => count + group.projects.length, 0) + 1
    );
    assert.equal(saves, 1);
    assert.equal(pendingStore.read(), null);
});

test('PERSIST-WORKSPACE-SAVE-001 retains pending intent after failed migration for activation retry', async () => {
    const state = memoryMemento();
    const pendingStore = new PendingWorkspaceSaveStore(state);
    const current = workspace('savedMultiRoot');
    await pendingStore.write(
        current.scopeIdentity,
        NOW,
        NOW + PENDING_WORKSPACE_SAVE_TTL_MS
    );
    let saves = 0;
    const adapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => current,
        pendingStore,
        getProjectDetailsForSave: async navigationUri => detailsFor(navigationUri),
        saveWorkspaceProject: async () => { saves += 1; },
        executeSaveWorkspaceAs: async () => undefined,
        nowMs: () => NOW + 1,
    });
    await startup(
        async () => ({
            projects: { migrated: false, error: new Error('forced migration failure') },
            todos: { migrated: false },
        }),
        () => adapter.completePendingWorkspaceSave()
    ).startUp();

    assert.equal(saves, 0);
    assert.ok(pendingStore.read());
});

test('PERSIST-WORKSPACE-SAVE-001 creates no project for a missing or invalid workspace', async () => {
    const writes = [];
    const adapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => null,
        pendingStore: new PendingWorkspaceSaveStore(memoryMemento()),
        getProjectDetailsForSave: async () => assert.fail('missing workspace must not resolve details'),
        saveWorkspaceProject: async details => {
            if (details?.path) {
                writes.push(details);
            }
        },
        executeSaveWorkspaceAs: async () => assert.fail('missing workspace must not invoke Save Workspace As'),
        nowMs: () => NOW,
    });
    await adapter.saveCurrentWorkspace();
    assert.deepEqual(writes, []);
});
