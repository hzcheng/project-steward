'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const commandBuilders = require('../../../out/aiSessions/commandBuilders');
const {
    preflightAiSessionDirectoryScope,
} = require('../../../out/aiSessions/commandController');
const {
    WorkspaceDirectoryScopeError,
    buildAiSessionDirectoryScope,
    selectPrimaryWorkspaceRoot,
} = require('../../../out/workspaces/sessionScope');

function workspace(overrides = {}) {
    return {
        navigationIdentity: '1'.repeat(64),
        scopeIdentity: '2'.repeat(64),
        kind: 'savedMultiRoot',
        displayName: 'Platform',
        navigationUri: 'file:///work/platform.code-workspace',
        environment: 'local',
        roots: [
            { id: 'root-parent', name: 'Parent', uri: 'file:///work', hostPath: '/work', ordinal: 0 },
            { id: 'root-api', name: 'API', uri: 'file:///work/api', hostPath: '/work/api', ordinal: 1 },
            { id: 'root-web', name: 'Web', uri: 'file:///work/web', hostPath: '/work/web', ordinal: 2 },
        ],
        ...overrides,
    };
}

test('SESSION-WORKSPACE-SCOPE-001 preserves explicit, editor, stored, and ordinal root precedence', () => {
    const current = workspace();
    assert.equal(selectPrimaryWorkspaceRoot(current, {
        explicitRootId: 'root-web',
        activeEditorUri: '/work/api/src/index.ts',
        lastUsedRootId: 'root-api',
    }).id, 'root-web');
    assert.equal(selectPrimaryWorkspaceRoot(current, {
        activeEditorUri: '/work/api/src/index.ts',
        lastUsedRootId: 'root-web',
    }).id, 'root-api');
    assert.equal(selectPrimaryWorkspaceRoot(current, {
        activeEditorUri: '/outside/index.ts',
        lastUsedRootId: 'root-web',
    }).id, 'root-web');
    assert.equal(selectPrimaryWorkspaceRoot(workspace({
        roots: [current.roots[2], current.roots[1], current.roots[0]],
    }), {
        explicitRootId: 'removed-root',
        lastUsedRootId: 'removed-root',
    }).id, 'root-parent');
});

test('SESSION-WORKSPACE-SCOPE-001 preserves whitespace and rejects blank or unavailable roots', () => {
    const spaced = workspace({
        roots: [
            {
                id: 'root-trailing',
                name: 'Trailing',
                uri: 'file:///work/repo%20',
                hostPath: '/work/repo ',
                ordinal: 0,
            },
            {
                id: 'root-leading',
                name: 'Leading',
                uri: 'file:///work/%20api',
                hostPath: '/work/ api',
                ordinal: 1,
            },
        ],
    });
    const probes = [];
    const scope = buildAiSessionDirectoryScope(spaced, {
        explicitRootId: 'root-trailing',
        isDirectory: hostPath => {
            probes.push(hostPath);
            return true;
        },
    });
    assert.deepEqual(probes, ['/work/repo ', '/work/ api']);
    assert.equal(scope.primaryCwd, '/work/repo ');
    assert.deepEqual(scope.additionalDirectories, ['/work/ api']);

    let blankProbes = 0;
    assert.throws(
        () => buildAiSessionDirectoryScope(workspace({
            roots: [{
                id: 'root-blank',
                name: 'Blank',
                uri: 'file:///blank',
                hostPath: ' \t ',
                ordinal: 0,
            }],
        }), {
            isDirectory: () => {
                blankProbes += 1;
                return true;
            },
        }),
        error => error instanceof WorkspaceDirectoryScopeError
    );
    assert.equal(blankProbes, 0);

    assert.throws(
        () => buildAiSessionDirectoryScope(workspace(), {
            isDirectory: hostPath => hostPath !== '/work/web',
        }),
        error => {
            assert.ok(error instanceof WorkspaceDirectoryScopeError);
            assert.deepEqual(error.invalidRoots, [{ id: 'root-web', name: 'Web' }]);
            return true;
        }
    );
});

test('SESSION-WORKSPACE-SCOPE-001 builds provider-specific add-directory arguments', async () => {
    const current = workspace();
    const ready = await preflightAiSessionDirectoryScope({
        workspace: current,
        provider: { id: 'codex', label: 'Codex', commandName: 'codex' },
        action: 'create',
        isWorkspaceTrusted: true,
        getProviderDirectoryCapability: async () => ({ status: 'supported' }),
        isDirectory: () => true,
        pickWorkspaceRoot: async () => undefined,
        explicitRootId: 'root-api',
    });
    assert.equal(ready.status, 'ready');
    const scope = ready.directoryScope;
    assert.equal(scope.primaryCwd, '/work/api');
    assert.deepEqual(scope.additionalDirectories, ['/work', '/work/web']);

    assert.deepEqual(commandBuilders.buildCodexNewSessionLaunchSpec(scope).args, [
        '--cd', '/work/api', '--add-dir', '/work', '--add-dir', '/work/web',
    ]);
    assert.deepEqual(commandBuilders.buildKimiNewSessionLaunchSpec(scope).args, [
        '--work-dir', '/work/api', '--add-dir', '/work', '--add-dir', '/work/web',
    ]);
    assert.deepEqual(commandBuilders.buildClaudeNewSessionLaunchSpec(scope), {
        executable: 'claude',
        args: ['--add-dir', '/work', '/work/web'],
        cwd: '/work/api',
        markerPath: null,
        windowsDirectShell: 'powershell',
    });
});

test('SESSION-WORKSPACE-SCOPE-001 blocks unsupported multi-root providers before directory or terminal preparation', async () => {
    let directoryProbes = 0;
    let rootPicks = 0;
    const result = await preflightAiSessionDirectoryScope({
        workspace: workspace(),
        provider: { id: 'codex', label: 'Codex', commandName: 'codex' },
        action: 'create',
        isWorkspaceTrusted: true,
        getProviderDirectoryCapability: async () => ({ status: 'unsupported' }),
        isDirectory: () => {
            directoryProbes += 1;
            return true;
        },
        pickWorkspaceRoot: async () => {
            rootPicks += 1;
            return 'root-api';
        },
    });
    assert.deepEqual(result, {
        status: 'blocked',
        reason: 'capability-unsupported',
        message: 'Codex cannot launch in this multi-root workspace. Upgrade it to a version with --add-dir support.',
    });
    assert.equal(directoryProbes, 0);
    assert.equal(rootPicks, 0);
});
