'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    WorkspaceNavigationController,
} = require('../../../out/openWorkspaces/navigationController');

const environments = ['local', 'ssh', 'wsl', 'devContainer', 'remote'];

function record(environment, kind, index) {
    const remote = environment === 'local' ? '' : `${environment}%2Btarget`;
    const navigationUri = environment === 'local'
        ? `file:///work/workspace-${index}${kind === 'savedMultiRoot' ? '.code-workspace' : ''}`
        : `vscode-remote://${remote}/work/workspace-${index}${kind === 'savedMultiRoot' ? '.code-workspace' : ''}`;
    return {
        navigationIdentity: String(index).padStart(64, '0'),
        scopeIdentity: String(index + 100).padStart(64, '0'),
        kind,
        displayName: `${environment}-${kind}`,
        navigationUri: kind === 'untitledMultiRoot' ? `untitled:Untitled-${index}` : navigationUri,
        environment,
        runningAiSessionCount: 0,
        roots: [{
            id: String(index + 200).padStart(64, '0'),
            name: 'member',
            uri: `file:///work/member-${index}`,
            ordinal: 0,
        }],
    };
}

function harness(initialRecord) {
    let current = initialRecord;
    const executions = [];
    const parsedUris = [];
    const information = [];
    const warnings = [];
    const refreshes = [];
    let failExecution = false;
    let failParsing = false;
    const controller = new WorkspaceNavigationController({
        getRecord: cardId => cardId === 'live-card' ? current : null,
        executeCommand: async (...args) => {
            executions.push(args);
            if (failExecution) {
                throw new Error('forced direct navigation failure');
            }
        },
        parseUri: value => {
            if (failParsing) {
                throw new Error('malformed URI');
            }
            const parsed = { parsed: value };
            parsedUris.push(parsed);
            return parsed;
        },
        showInformationMessage: message => information.push(message),
        showWarningMessage: message => warnings.push(message),
        refresh: reason => refreshes.push(reason),
    });
    return {
        controller,
        executions,
        information,
        parsedUris,
        refreshes,
        setFailExecution(value) {
            failExecution = value;
        },
        setFailParsing(value) {
            failParsing = value;
        },
        setRecord(value) {
            current = value;
        },
        warnings,
    };
}

test('OPEN-WORKSPACE-NAVIGATION-001 opens exact workspace URIs in every supported environment', async () => {
    const navigation = harness(null);
    let index = 0;
    for (const environment of environments) {
        for (const kind of ['singleFolder', 'savedMultiRoot']) {
            index += 1;
            const current = record(environment, kind, index);
            navigation.setRecord(current);
            navigation.executions.length = 0;
            navigation.parsedUris.length = 0;
            await navigation.controller.open('live-card');
            assert.equal(navigation.parsedUris[0].parsed, current.navigationUri);
            assert.deepEqual(navigation.executions, [[
                'vscode.openFolder',
                navigation.parsedUris[0],
                { forceNewWindow: true },
            ]]);
            assert.equal(JSON.stringify(navigation.executions).includes(current.roots[0].uri), false);
        }
    }
});

test('OPEN-WORKSPACE-NAVIGATION-001 requires save-first for untitled workspaces', async () => {
    for (const [index, environment] of environments.entries()) {
        const navigation = harness(record(environment, 'untitledMultiRoot', index + 1));
        await navigation.controller.open('live-card');
        assert.deepEqual(navigation.information, ['Save this workspace before switching to it']);
        assert.deepEqual(navigation.parsedUris, []);
        assert.deepEqual(navigation.executions, []);
    }
});

test('OPEN-WORKSPACE-NAVIGATION-001 fails closed to Switch Window without a member-root fallback', async () => {
    const current = record('devContainer', 'savedMultiRoot', 40);
    const navigation = harness(current);
    navigation.setFailExecution(true);
    await navigation.controller.open('live-card');
    assert.equal(navigation.executions.length, 1);
    assert.deepEqual(navigation.warnings, [
        'Unable to switch directly to this workspace. Use VS Code Switch Window instead.',
    ]);
    assert.equal(JSON.stringify(navigation.executions).includes(current.roots[0].uri), false);

    navigation.executions.length = 0;
    navigation.warnings.length = 0;
    navigation.setFailExecution(false);
    navigation.setFailParsing(true);
    await navigation.controller.open('live-card');
    assert.deepEqual(navigation.executions, []);
    assert.deepEqual(navigation.warnings, [
        'Unable to switch directly to this workspace. Use VS Code Switch Window instead.',
    ]);
});

test('OPEN-WORKSPACE-NAVIGATION-001 refreshes instead of acting on a stale card', async () => {
    const navigation = harness(record('local', 'singleFolder', 50));
    await navigation.controller.open('missing-card');
    assert.deepEqual(navigation.refreshes, ['open-workspace-navigation-stale']);
    assert.deepEqual(navigation.parsedUris, []);
    assert.deepEqual(navigation.executions, []);
});
