'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const originalModuleLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {};
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};
const workspaceProtocol = require('../out/openWorkspaces/protocol');
const workspaceProjection = require('../out/openWorkspaces/projection');
const { default: OpenWorkspaceBridgeClient } = require('../out/openWorkspaces/bridgeClient');
const { OpenWorkspaceDashboardController } = require('../out/openWorkspaces/dashboardController');
const { OpenWorkspaceController } = require('../out/openWorkspaces/workspaceController');
const { WorkspaceNavigationController } = require('../out/openWorkspaces/navigationController');
const attentionProject = require('../out/aiSessions/attentionProject');
const { CurrentProjectDetailsResolver } = require('../out/projects/currentProjectDetails');
const { ProjectManualEditController } = require('../out/projects/projectManualEditController');
const { ProjectOpenController } = require('../out/projects/projectOpenController');
const { ProjectMutationController } = require('../out/projects/projectMutationController');
const { ProjectPromptController } = require('../out/projects/projectPromptController');
const { DashboardStartupController, settleMigration } = require('../out/dashboard/startupController');
const { WorkspaceContextResolver } = require('../out/workspaces/contextResolver');
const {
    PendingWorkspaceSaveStore,
    PENDING_WORKSPACE_SAVE_TTL_MS,
} = require('../out/workspaces/pendingWorkspaceSaveStore');
const { SavedWorkspaceProjectAdapter } = require('../out/workspaces/savedWorkspaceProjectAdapter');
const models = require('../out/models');
const { OpenWorkspaceStore } = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceStore');
const { OpenWorkspaceCoordinator } = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceCoordinator');
const { replaceOpenWorkspacePublicationUris } = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspacePublication');
Module._load = originalModuleLoad;

const SELF = '1'.repeat(32);
const OLDER = '2'.repeat(32);
const NEWER = '3'.repeat(32);
const OTHER = '4'.repeat(32);

function workspaceIdentity(index) {
    return Number(index).toString(16).padStart(64, '0');
}

function makeWorkspaceRoot(index = 0, overrides = {}) {
    return {
        id: workspaceIdentity(index + 100),
        name: `Root ${index}`,
        uri: `file:///work/root-${index}`,
        ordinal: index,
        ...overrides,
    };
}

function makeWorkspaceRecord(index = 0, overrides = {}) {
    return {
        navigationIdentity: workspaceIdentity(index + 1),
        scopeIdentity: workspaceIdentity(index + 10),
        kind: 'singleFolder',
        displayName: `Workspace ${index}`,
        navigationUri: `file:///work/root-${index}`,
        environment: 'local',
        runningAiSessionCount: 0,
        roots: [makeWorkspaceRoot(index, { ordinal: 0 })],
        ...overrides,
    };
}

function makeWorkspacePublication(overrides = {}) {
    return {
        protocolVersion: 2,
        instanceId: SELF,
        sequence: 1,
        followsFocusEvent: false,
        workspace: makeWorkspaceRecord(),
        ...overrides,
    };
}

function makeWorkspaceRegistration(instanceId = SELF, lastFocusedAtMs = 4000, workspace = makeWorkspaceRecord(), overrides = {}) {
    return {
        protocolVersion: 2,
        instanceId,
        sequence: 1,
        lastFocusedAtMs,
        leaseUpdatedAtMs: 4500,
        workspace,
        ...overrides,
    };
}

function makeWorkspaceAggregate(registrations, overrides = {}) {
    return {
        protocolVersion: 2,
        semanticRevision: 'a'.repeat(64),
        observedAtMs: 5000,
        registrations,
        ...overrides,
    };
}

function assertRejectsValidation(callback, pattern) {
    assert.throws(callback, pattern);
}

function extractFunctionBody(source, functionName) {
    const signatureIndex = source.indexOf(`function ${functionName}(`);
    assert.notStrictEqual(signatureIndex, -1, `missing function ${functionName}`);
    const openingBraceIndex = source.indexOf('{', signatureIndex);
    let depth = 0;
    for (let index = openingBraceIndex; index < source.length; index += 1) {
        if (source[index] === '{') {
            depth += 1;
        } else if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) {
                return source.slice(openingBraceIndex + 1, index);
            }
        }
    }
    assert.fail(`could not extract function ${functionName}`);
}

function hasClassTokens(classValue, ...tokens) {
    return tokens.every(token => classValue.split(/\s+/).includes(token));
}

function runWorkspaceProtocolV2Checks() {
    const publication = makeWorkspacePublication();
    const registration = makeWorkspaceRegistration();
    const aggregate = makeWorkspaceAggregate([registration]);

    assert.deepStrictEqual(workspaceProtocol.validateOpenWorkspacePublication(publication), publication);
    assert.deepStrictEqual(workspaceProtocol.validateOpenWorkspaceRegistration(registration), registration);
    assert.deepStrictEqual(workspaceProtocol.validateOpenWorkspaceAggregate(aggregate), aggregate);
    assert.deepStrictEqual(
        workspaceProtocol.validateOpenWorkspacePublication({ ...publication, workspace: null }),
        { ...publication, workspace: null }
    );
    assert.deepStrictEqual(
        workspaceProtocol.validateOpenWorkspaceRegistration({ ...registration, workspace: null }),
        { ...registration, workspace: null }
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({
            ...publication,
            workspace: { ...publication.workspace, roots: [] },
        }),
        /roots/
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({
            ...publication,
            workspace: {
                ...publication.workspace,
                roots: [makeWorkspaceRoot(0), makeWorkspaceRoot(1)],
            },
        }),
        /singleFolder/
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({
            ...publication,
            workspace: {
                ...publication.workspace,
                navigationUri: 'file:///work/unrelated',
            },
        }),
        /navigationUri/
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({
            ...publication,
            workspace: {
                ...publication.workspace,
                kind: 'savedMultiRoot',
                roots: [makeWorkspaceRoot(0), makeWorkspaceRoot(1, { ordinal: 2 })],
            },
        }),
        /ordinal/
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({
            ...publication,
            workspace: {
                ...publication.workspace,
                kind: 'savedMultiRoot',
                roots: [makeWorkspaceRoot(1, { ordinal: 1 }), makeWorkspaceRoot(0, { ordinal: 0 })],
            },
        }),
        /ordinal/
    );

    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({
            protocolVersion: 1,
            instanceId: SELF,
            sequence: 1,
            followsFocusEvent: false,
            projects: [],
        }),
        /protocolVersion|unexpected fields/
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspaceRegistration({ ...registration, protocolVersion: 1 }),
        /protocolVersion/
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspaceAggregate({ ...aggregate, protocolVersion: 1 }),
        /protocolVersion/
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({ ...publication, followsFocusEvent: 1 }),
        /followsFocusEvent/
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({ ...publication, workspace: undefined }),
        /open workspace record/
    );
    for (const [validate, value] of [
        [workspaceProtocol.validateOpenWorkspacePublication, publication],
        [workspaceProtocol.validateOpenWorkspaceRegistration, registration],
        [workspaceProtocol.validateOpenWorkspaceAggregate, aggregate],
    ]) {
        assertRejectsValidation(() => validate({ ...value, unexpected: true }), /unexpected fields/);
    }
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({
            ...publication,
            workspace: { ...publication.workspace, unexpected: true },
        }),
        /unexpected fields/
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({
            ...publication,
            workspace: { ...publication.workspace, runningAiSessionCount: -1 },
        }),
        /runningAiSessionCount/
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({
            ...publication,
            workspace: {
                ...publication.workspace,
                roots: [{ ...publication.workspace.roots[0], hostPath: '/private/root' }],
            },
        }),
        /unexpected fields/
    );

    for (const instanceId of ['short', 'A'.repeat(32), 'g'.repeat(32), `${SELF}0`]) {
        assertRejectsValidation(
            () => workspaceProtocol.validateOpenWorkspacePublication({ ...publication, instanceId }),
            /instanceId/
        );
    }
    for (const sequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assertRejectsValidation(
            () => workspaceProtocol.validateOpenWorkspacePublication({ ...publication, sequence }),
            /sequence/
        );
    }
    for (const timestamp of [NaN, Infinity, -Infinity, -1]) {
        assertRejectsValidation(
            () => workspaceProtocol.validateOpenWorkspaceRegistration({ ...registration, lastFocusedAtMs: timestamp }),
            /lastFocusedAtMs/
        );
        assertRejectsValidation(
            () => workspaceProtocol.validateOpenWorkspaceAggregate({ ...aggregate, observedAtMs: timestamp }),
            /observedAtMs/
        );
        assertRejectsValidation(
            () => workspaceProtocol.validateOpenWorkspaceRegistration({ ...registration, leaseUpdatedAtMs: timestamp }),
            /leaseUpdatedAtMs/
        );
    }

    const maximumString = 'x'.repeat(8192);
    const maximumRoots = Array.from({ length: 100 }, (_, index) => makeWorkspaceRoot(index));
    const maximumWorkspace = makeWorkspaceRecord(0, {
        kind: 'savedMultiRoot',
        displayName: maximumString,
        navigationUri: `file:///${'x'.repeat(8184)}`,
        roots: maximumRoots,
    });
    assert.strictEqual(
        workspaceProtocol.validateOpenWorkspacePublication({ ...publication, workspace: maximumWorkspace })
            .workspace.roots.length,
        100
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({
            ...publication,
            workspace: { ...publication.workspace, displayName: 'x'.repeat(8193) },
        }),
        /displayName/
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({
            ...publication,
            workspace: { ...publication.workspace, roots: Array.from({ length: 101 }, (_, index) => makeWorkspaceRoot(index)) },
        }),
        /roots/
    );
    assert.strictEqual(
        workspaceProtocol.validateOpenWorkspaceAggregate(makeWorkspaceAggregate(
            Array.from({ length: 100 }, (_, index) => makeWorkspaceRegistration(
                index.toString(16).padStart(32, '0'),
                index,
                makeWorkspaceRecord(index)
            ))
        )).registrations.length,
        100
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspaceAggregate(makeWorkspaceAggregate(
            Array.from({ length: 101 }, (_, index) => makeWorkspaceRegistration(
                index.toString(16).padStart(32, '0'),
                index,
                makeWorkspaceRecord(index)
            ))
        )),
        /registrations/
    );

    for (const [field, value, pattern] of [
        ['navigationIdentity', 'not-a-hash', /navigationIdentity/],
        ['navigationIdentity', 'A'.repeat(64), /navigationIdentity/],
        ['scopeIdentity', 'not-a-hash', /scopeIdentity/],
        ['kind', 'folder', /kind/],
        ['displayName', '', /displayName/],
        ['displayName', 'unsafe\nname', /displayName/],
        ['displayName', 'unsafe\u0085name', /displayName/],
        ['navigationUri', '/not/a/uri', /navigationUri/],
        ['navigationUri', 'file:///bad%escape', /navigationUri/],
        ['navigationUri', 'file:///bad path', /navigationUri/],
        ['navigationUri', 'vscode-remote://[bad/workspace', /navigationUri/],
        ['environment', 'codespaces', /environment/],
    ]) {
        assertRejectsValidation(
            () => workspaceProtocol.validateOpenWorkspacePublication({
                ...publication,
                workspace: { ...publication.workspace, [field]: value },
            }),
            pattern
        );
    }
    for (const [field, value, pattern] of [
        ['id', 'not-a-hash', /root id/],
        ['name', '', /root name/],
        ['name', 'unsafe\u0000name', /root name/],
        ['uri', 'relative/root', /root uri/],
        ['uri', 'file:///bad%escape', /root uri/],
        ['ordinal', -1, /ordinal/],
        ['ordinal', 0.5, /ordinal/],
        ['ordinal', Number.MAX_SAFE_INTEGER + 1, /ordinal/],
    ]) {
        assertRejectsValidation(
            () => workspaceProtocol.validateOpenWorkspacePublication({
                ...publication,
                workspace: {
                    ...publication.workspace,
                    roots: [{ ...publication.workspace.roots[0], [field]: value }],
                },
            }),
            pattern
        );
    }
    const firstRoot = makeWorkspaceRoot(0);
    for (const duplicate of [
        makeWorkspaceRoot(1, { id: firstRoot.id }),
        makeWorkspaceRoot(1, { uri: firstRoot.uri }),
        makeWorkspaceRoot(1, { ordinal: firstRoot.ordinal }),
    ]) {
        assertRejectsValidation(
            () => workspaceProtocol.validateOpenWorkspacePublication({
                ...publication,
                workspace: { ...publication.workspace, roots: [firstRoot, duplicate] },
            }),
            /duplicate/
        );
    }
    const sparseRoots = [firstRoot];
    sparseRoots.length = 2;
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication({
            ...publication,
            workspace: { ...publication.workspace, roots: sparseRoots },
        }),
        /open workspace root/
    );
    const sparseRegistrations = [registration];
    sparseRegistrations.length = 2;
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspaceAggregate(makeWorkspaceAggregate(sparseRegistrations)),
        /open workspace registration/
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspaceAggregate(makeWorkspaceAggregate([
            registration,
            { ...registration, sequence: 2 },
        ])),
        /duplicate instanceId/
    );
    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspaceAggregate({ ...aggregate, semanticRevision: 'revision' }),
        /semanticRevision/
    );

    const baseRevision = workspaceProtocol.createOpenWorkspaceSemanticRevision([registration]);
    assert.match(baseRevision, /^[a-f0-9]{64}$/);
    assert.strictEqual(
        workspaceProtocol.createOpenWorkspaceSemanticRevision([{
            ...registration,
            sequence: 99,
            leaseUpdatedAtMs: 9999,
        }]),
        baseRevision,
        'sequence and lease heartbeat time are not semantic workspace state'
    );
    assert.notStrictEqual(
        workspaceProtocol.createOpenWorkspaceSemanticRevision([{
            ...registration,
            lastFocusedAtMs: registration.lastFocusedAtMs + 1,
        }]),
        baseRevision
    );
    assert.notStrictEqual(
        workspaceProtocol.createOpenWorkspaceSemanticRevision([{
            ...registration,
            workspace: { ...registration.workspace, displayName: 'Changed' },
        }]),
        baseRevision
    );
    assert.notStrictEqual(
        workspaceProtocol.createOpenWorkspaceSemanticRevision([{
            ...registration,
            workspace: { ...registration.workspace, runningAiSessionCount: 1 },
        }]),
        baseRevision,
        'running session changes must propagate through the cross-window semantic revision'
    );
    assert.strictEqual(
        workspaceProtocol.createOpenWorkspaceSemanticRevision([
            makeWorkspaceRegistration(OLDER, 2000, makeWorkspaceRecord(1)),
            makeWorkspaceRegistration(NEWER, 3000, makeWorkspaceRecord(2)),
        ]),
        workspaceProtocol.createOpenWorkspaceSemanticRevision([
            makeWorkspaceRegistration(NEWER, 3000, makeWorkspaceRecord(2)),
            makeWorkspaceRegistration(OLDER, 2000, makeWorkspaceRecord(1)),
        ])
    );
    const multiRoot = makeWorkspaceRecord(0, {
        kind: 'savedMultiRoot',
        roots: [makeWorkspaceRoot(0), makeWorkspaceRoot(1)],
    });
    assert.throws(
        () => workspaceProtocol.createOpenWorkspaceSemanticRevision([
            makeWorkspaceRegistration(SELF, 4000, { ...multiRoot, roots: multiRoot.roots.slice().reverse() }),
        ]),
        /ordinal/,
    );
}

function runWorkspaceProjectionV2Checks() {
    const sourceWorkspace = {
        ...makeWorkspaceRecord(0, {
            kind: 'savedMultiRoot',
            roots: [
                { ...makeWorkspaceRoot(0), hostPath: '/private/root-0' },
                { ...makeWorkspaceRoot(1), hostPath: '/private/root-1' },
                { ...makeWorkspaceRoot(2), hostPath: '/private/root-2' },
            ],
        }),
    };
    const publicationRecord = workspaceProjection.createOpenWorkspacePublication(sourceWorkspace, 2);
    assert.strictEqual(Array.isArray(publicationRecord), false, 'a workspace publication is one record, not one record per root');
    assert.deepStrictEqual(Object.keys(publicationRecord).sort(), [
        'displayName',
        'environment',
        'kind',
        'navigationIdentity',
        'navigationUri',
        'roots',
        'runningAiSessionCount',
        'scopeIdentity',
    ]);
    assert.strictEqual(publicationRecord.runningAiSessionCount, 2);
    assert.strictEqual(publicationRecord.roots.length, 3);
    assert.strictEqual(publicationRecord.roots.some(root => Object.hasOwnProperty.call(root, 'hostPath')), false);
    assert.strictEqual(workspaceProjection.createOpenWorkspacePublication(null), null);

    const currentWorkspace = {
        ...makeWorkspaceRecord(50),
        roots: [{ ...makeWorkspaceRoot(50), hostPath: '/private/current' }],
    };
    const duplicateIdentity = workspaceIdentity(70);
    const duplicateOlder = makeWorkspaceRecord(70, {
        navigationIdentity: duplicateIdentity,
        displayName: 'Older duplicate',
        environment: 'local',
    });
    const duplicateNewer = makeWorkspaceRecord(71, {
        navigationIdentity: duplicateIdentity,
        displayName: 'Newest duplicate',
        environment: 'ssh',
        runningAiSessionCount: 2,
        roots: [makeWorkspaceRoot(71), makeWorkspaceRoot(72)],
    });
    const tiedIdentity = workspaceIdentity(80);
    const tiedWinner = makeWorkspaceRecord(80, {
        navigationIdentity: tiedIdentity,
        displayName: 'Lower instance wins exact focus tie',
        environment: 'wsl',
    });
    const tiedLoser = makeWorkspaceRecord(81, {
        navigationIdentity: tiedIdentity,
        displayName: 'Higher instance loses exact focus tie',
        environment: 'remote',
    });
    const stableIdentity = workspaceIdentity(60);
    const stableWorkspace = makeWorkspaceRecord(60, {
        navigationIdentity: stableIdentity,
        displayName: 'Stable identity sort',
        environment: 'devContainer',
    });
    const ignoredOwnWorkspace = makeWorkspaceRecord(90, { displayName: 'Own instance ignored' });
    const reservedCurrentWorkspace = makeWorkspaceRecord(91, {
        navigationIdentity: currentWorkspace.navigationIdentity,
        displayName: 'Current identity reserved',
    });
    const registrations = [
        makeWorkspaceRegistration(SELF, 9999, ignoredOwnWorkspace),
        makeWorkspaceRegistration('9'.repeat(32), 9998, reservedCurrentWorkspace),
        makeWorkspaceRegistration('8'.repeat(32), 1000, duplicateOlder),
        makeWorkspaceRegistration('7'.repeat(32), 7000, duplicateNewer),
        makeWorkspaceRegistration('1'.repeat(31) + '0', 6000, tiedWinner),
        makeWorkspaceRegistration('2'.repeat(31) + '0', 6000, tiedLoser),
        makeWorkspaceRegistration('6'.repeat(32), 6000, stableWorkspace),
        makeWorkspaceRegistration('5'.repeat(32), 5000, null),
    ];
    const attentionRootUri = duplicateNewer.roots[0].uri;
    const attention = {
        protocolVersion: 1,
        aggregateRevision: 'b'.repeat(64),
        generatedAtMs: 10,
        sessions: [{
            projectId: attentionProject.getAttentionProjectKey(attentionProject.getAttentionProjectPath(attentionRootUri)),
            sessionKey: 'codex:workspace-attention',
            reasons: ['completed'],
            eventIds: ['event-workspace-attention'],
            observedAtMs: 9,
        }],
    };
    const aggregate = makeWorkspaceAggregate(registrations);
    const cards = workspaceProjection.projectOpenWorkspaceCards(currentWorkspace, aggregate, SELF, attention);
    assert.strictEqual(cards.length, 3);
    assert.deepStrictEqual(
        cards.map(card => card.navigationIdentity),
        [duplicateIdentity, stableIdentity, tiedIdentity],
        'cards sort by descending focus time, then stable navigation identity'
    );
    const duplicateCard = cards.find(card => card.navigationIdentity === duplicateIdentity);
    assert.strictEqual(duplicateCard.name, 'Newest duplicate');
    assert.strictEqual(duplicateCard.environment, 'ssh');
    assert.strictEqual(duplicateCard.environmentLabel, 'SSH');
    assert.strictEqual(duplicateCard.roots.length, 2);
    assert.strictEqual(duplicateCard.attentionCount, 1);
    assert.strictEqual(duplicateCard.runningSessionCount, 2);
    assert.deepStrictEqual(Object.keys(duplicateCard).sort(), [
        'attentionCount',
        'environment',
        'environmentLabel',
        'id',
        'kind',
        'name',
        'navigationIdentity',
        'roots',
        'runningSessionCount',
        'scopeIdentity',
        'showSaveAction',
        'workspaceKind',
    ]);
    assert.strictEqual(duplicateCard.kind, 'navigation');
    assert.strictEqual(duplicateCard.workspaceKind, duplicateNewer.kind);
    assert.deepStrictEqual(Object.keys(duplicateCard.roots[0]).sort(), ['id', 'name', 'ordinal']);
    assert.strictEqual(duplicateCard.id.includes(duplicateCard.navigationIdentity), false);
    assert.strictEqual(duplicateCard.id.includes(duplicateNewer.navigationUri), false);
    assert.match(duplicateCard.id, /^__openWorkspaceNavigation-[a-f0-9]{24}$/);
    assert.strictEqual(cards.some(card => card.navigationIdentity === ignoredOwnWorkspace.navigationIdentity), false);
    assert.strictEqual(cards.some(card => card.navigationIdentity === currentWorkspace.navigationIdentity), false);

    const tiedCard = cards.find(card => card.navigationIdentity === tiedIdentity);
    assert.strictEqual(tiedCard.name, 'Lower instance wins exact focus tie');
    assert.strictEqual(tiedCard.environmentLabel, 'WSL');
    assert.deepStrictEqual(
        workspaceProjection.projectOpenWorkspaceCards(
            currentWorkspace,
            makeWorkspaceAggregate(registrations.slice().reverse()),
            SELF,
            attention
        ),
        cards,
        'equal-focus duplicate publishers use lower instanceId, never aggregate input order'
    );
    assert.deepStrictEqual(workspaceProjection.projectOpenWorkspaceCards(currentWorkspace, null, SELF, attention), []);
}

function runOpenWorkspacePublicationChecks() {
    const original = makeWorkspacePublication({
        workspace: makeWorkspaceRecord(4, {
            kind: 'savedMultiRoot',
            navigationUri: 'vscode-remote://dev-container%2Bold/work/team.code-workspace',
            roots: [
                makeWorkspaceRoot(4, { ordinal: 0, uri: 'vscode-remote://dev-container%2Bold/work/app' }),
                makeWorkspaceRoot(5, { ordinal: 1, uri: 'vscode-remote://dev-container%2Bold/work/api' }),
            ],
        }),
    });
    const replacement = replaceOpenWorkspacePublicationUris(
        original,
        'vscode-remote://dev-container%2Bcurrent/work/team.code-workspace',
        [
            'vscode-remote://dev-container%2Bcurrent/work/app',
            'vscode-remote://dev-container%2Bcurrent/work/api',
        ],
    );
    assert.strictEqual(replacement.workspace.navigationUri,
        'vscode-remote://dev-container%2Bcurrent/work/team.code-workspace');
    assert.deepStrictEqual(replacement.workspace.roots.map(root => root.uri), [
        'vscode-remote://dev-container%2Bcurrent/work/app',
        'vscode-remote://dev-container%2Bcurrent/work/api',
    ]);
    assert.strictEqual(replacement.workspace.navigationIdentity, original.workspace.navigationIdentity);
    assert.strictEqual(replacement.workspace.scopeIdentity, original.workspace.scopeIdentity);
    assert.deepStrictEqual(
        replacement.workspace.roots.map(root => root.id),
        original.workspace.roots.map(root => root.id),
    );
    assert.strictEqual(original.workspace.navigationUri,
        'vscode-remote://dev-container%2Bold/work/team.code-workspace');

    const singleFolderOriginal = makeWorkspacePublication({
        workspace: makeWorkspaceRecord(6, {
            navigationUri: 'vscode-remote://dev-container%2Bold/work/app',
            roots: [makeWorkspaceRoot(6, {
                uri: 'vscode-remote://dev-container%2Bold/work/app',
                ordinal: 0,
            })],
        }),
    });
    const singleFolderReplacement = replaceOpenWorkspacePublicationUris(
        singleFolderOriginal,
        null,
        ['vscode-remote://dev-container%2Bcurrent/work/app'],
    );
    assert.strictEqual(
        singleFolderReplacement.workspace.navigationUri,
        'vscode-remote://dev-container%2Bcurrent/work/app',
    );
    assert.strictEqual(
        singleFolderReplacement.workspace.navigationUri,
        singleFolderReplacement.workspace.roots[0].uri,
    );
    const crossSchemeSingleFolder = makeWorkspacePublication({
        workspace: makeWorkspaceRecord(7, {
            navigationUri: 'file:///work/cross-scheme-app',
            roots: [makeWorkspaceRoot(7, {
                uri: 'file:///work/cross-scheme-app',
                ordinal: 0,
            })],
        }),
    });
    assert.strictEqual(
        replaceOpenWorkspacePublicationUris(
            crossSchemeSingleFolder,
            null,
            ['vscode-remote://ssh-remote%2Bhost/work/cross-scheme-app'],
        ).workspace.navigationUri,
        'vscode-remote://ssh-remote%2Bhost/work/cross-scheme-app',
        'authority and scheme changes with the same resource path must remain valid',
    );

    assert.throws(
        () => replaceOpenWorkspacePublicationUris(
            singleFolderOriginal,
            null,
            ['vscode-remote://dev-container%2Bcurrent/work/different-app'],
        ),
        /root resource path/,
    );
    assert.throws(
        () => replaceOpenWorkspacePublicationUris(
            original,
            'vscode-remote://dev-container%2Bcurrent/work/team.code-workspace',
            [
                'vscode-remote://dev-container%2Bcurrent/work/app',
                'vscode-remote://dev-container%2Bcurrent/work/different-api',
            ],
        ),
        /root resource path/,
    );
    assert.throws(
        () => replaceOpenWorkspacePublicationUris(
            original,
            'vscode-remote://dev-container%2Bcurrent/work/different-team.code-workspace',
            [
                'vscode-remote://dev-container%2Bcurrent/work/app',
                'vscode-remote://dev-container%2Bcurrent/work/api',
            ],
        ),
        /workspace resource path/,
    );

    for (const [rootUris, pattern] of [
        [[], /root count/],
        [[
            'vscode-remote://dev-container%2Bcurrent/work/app',
            'vscode-remote://dev-container%2Bcurrent/work/api',
            'vscode-remote://dev-container%2Bcurrent/work/extra',
        ], /root count/],
    ]) {
        assert.throws(
            () => replaceOpenWorkspacePublicationUris(singleFolderOriginal, null, rootUris),
            pattern,
        );
    }
    assert.throws(
        () => replaceOpenWorkspacePublicationUris(
            {
                ...original,
                workspace: {
                    ...original.workspace,
                    roots: original.workspace.roots.slice().reverse(),
                },
            },
            'vscode-remote://dev-container%2Bcurrent/work/team.code-workspace',
            [
                'vscode-remote://dev-container%2Bcurrent/work/app',
                'vscode-remote://dev-container%2Bcurrent/work/api',
            ],
        ),
        /ordinal|order/,
    );

    const empty = makeWorkspacePublication({ workspace: null });
    assert.deepStrictEqual(
        replaceOpenWorkspacePublicationUris(
            empty,
            'file:///must-not-be-synthesized.code-workspace',
            ['file:///must-not-be-synthesized'],
        ),
        empty,
        'Bridge URI normalization must never synthesize a workspace from a null publication',
    );
}

async function runOpenWorkspaceStoreChecks() {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-steward-open-workspace-store-'));
    try {
        const instancesDirectory = path.join(tempRoot, 'open-workspaces', 'v2', 'instances');
        const v1Directory = path.join(tempRoot, 'open-projects', 'v1', 'instances');
        const ownRegistration = makeWorkspaceRegistration(SELF, 1000, makeWorkspaceRecord(1), {
            leaseUpdatedAtMs: 1000,
        });
        const legacyRegistration = {
            protocolVersion: 1,
            instanceId: OTHER,
            sequence: 1,
            lastFocusedAtMs: 1000,
            leaseUpdatedAtMs: 1000,
            projects: [],
        };
        await fs.promises.mkdir(v1Directory, { recursive: true });
        await fs.promises.writeFile(
            path.join(v1Directory, `${OTHER}.json`),
            `${JSON.stringify(legacyRegistration)}\n`,
        );
        const store = new OpenWorkspaceStore(tempRoot, SELF);
        await store.write(ownRegistration);
        assert.deepStrictEqual((await store.scan(1000)).registrations, [ownRegistration]);
        assert.strictEqual((await fs.promises.stat(instancesDirectory)).mode & 0o777, 0o700);
        assert.strictEqual(
            (await fs.promises.stat(path.join(instancesDirectory, `${SELF}.json`))).mode & 0o777,
            0o600,
        );
        assert.strictEqual(
            (await store.scan(1000)).registrations.some(registration => registration.instanceId === OTHER),
            false,
            'the v2 registry must never scan v1 owner files',
        );
        await fs.promises.writeFile(path.join(instancesDirectory, `${OTHER}.json`), '{malformed');
        const malformed = await store.scan(1000);
        assert.deepStrictEqual(malformed.registrations, [ownRegistration]);
        assert.strictEqual(malformed.counters.parseErrors, 1);
        const oversizedId = '5'.repeat(32);
        const symlinkId = '6'.repeat(32);
        const expiredId = '7'.repeat(32);
        const mismatchId = '8'.repeat(32);
        await fs.promises.writeFile(
            path.join(instancesDirectory, `${oversizedId}.json`),
            Buffer.alloc(256 * 1024 + 1),
        );
        const symlinkTarget = path.join(tempRoot, 'workspace-symlink-target.json');
        await fs.promises.writeFile(symlinkTarget, `${JSON.stringify(makeWorkspaceRegistration(
            symlinkId, 900, makeWorkspaceRecord(6), { leaseUpdatedAtMs: 1000 },
        ))}\n`);
        await fs.promises.symlink(symlinkTarget, path.join(instancesDirectory, `${symlinkId}.json`));
        await fs.promises.writeFile(
            path.join(instancesDirectory, `${expiredId}.json`),
            `${JSON.stringify(makeWorkspaceRegistration(
                expiredId, 900, makeWorkspaceRecord(7), { leaseUpdatedAtMs: 0 },
            ))}\n`,
        );
        await fs.promises.writeFile(
            path.join(instancesDirectory, `${mismatchId}.json`),
            `${JSON.stringify(makeWorkspaceRegistration(
                '9'.repeat(32), 900, makeWorkspaceRecord(8), { leaseUpdatedAtMs: 1000 },
            ))}\n`,
        );
        const defensive = await store.scan(31_000);
        assert.deepStrictEqual(defensive.registrations, [ownRegistration]);
        assert.strictEqual(defensive.counters.parseErrors, 2);
        assert.strictEqual(defensive.counters.oversizedFiles, 1);
        assert.strictEqual(defensive.counters.symlinkFiles, 1);
        assert.strictEqual(defensive.counters.expired, 1);
        await assert.rejects(
            store.write({ ...ownRegistration, sequence: 0 }),
            /sequence/,
        );
        await assert.rejects(
            store.write({ ...ownRegistration, instanceId: OTHER, sequence: 2 }),
            /does not belong/,
        );
        await store.remove(SELF);
        assert.deepStrictEqual((await store.scan(31_000)).registrations, []);
    } finally {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
}

async function runOpenWorkspaceCoordinatorChecks() {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-steward-open-workspace-coordinator-'));
    let now = 1000;
    let intervalCallback;
    const delivered = [];
    const coordinator = new OpenWorkspaceCoordinator(tempRoot, {
        now: () => now,
        setInterval: callback => {
            intervalCallback = callback;
            return 'workspace-interval';
        },
        clearInterval: () => undefined,
        createWatcher: directory => {
            assert.strictEqual(directory, path.join(tempRoot, 'open-workspaces', 'v2', 'instances'));
            return { close: () => undefined };
        },
        deliverAggregate: aggregate => delivered.push(aggregate),
    });
    const observer = new OpenWorkspaceStore(tempRoot, OTHER);
    try {
        await coordinator.publish(makeWorkspacePublication());
        assert.strictEqual((await observer.scan(now)).registrations.length, 1,
            'one workspace publication must write one owner record');
        assert.strictEqual(delivered.length, 1);
        const semanticRevision = delivered[0].semanticRevision;

        now = 2000;
        await coordinator.publish(makeWorkspacePublication({ sequence: 2, followsFocusEvent: true }));
        assert.strictEqual((await observer.scan(now)).registrations[0].lastFocusedAtMs, 2000);
        const deliveredAfterFocus = delivered.length;

        now = 12_000;
        intervalCallback();
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const current = (await observer.scan(now)).registrations[0];
            if (current?.leaseUpdatedAtMs === now) break;
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.strictEqual(
            delivered[delivered.length - 1].semanticRevision,
            workspaceProtocol.createOpenWorkspaceSemanticRevision((await observer.scan(now)).registrations),
        );
        assert.strictEqual(delivered.length, deliveredAfterFocus,
            'lease heartbeats must not change the semantic revision or redeliver the aggregate');

        now = 13_000;
        await coordinator.publish(makeWorkspacePublication({ sequence: 3, workspace: null }));
        const emptyOwner = (await observer.scan(now)).registrations.find(value => value.instanceId === SELF);
        assert.ok(emptyOwner, 'workspace:null keeps lease ownership until explicit unregister');
        assert.strictEqual(emptyOwner.workspace, null);
        assert.notStrictEqual(delivered[delivered.length - 1].semanticRevision, semanticRevision);

        await coordinator.unregister({ protocolVersion: 2, instanceId: SELF });
        assert.deepStrictEqual((await observer.scan(now)).registrations, []);
    } finally {
        coordinator.dispose();
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
}

async function runOpenWorkspaceCoordinatorBoundaryChecks() {
    const registrations = Array.from({ length: 101 }, (_, index) => makeWorkspaceRegistration(
        index.toString(16).padStart(32, '0'),
        index,
        makeWorkspaceRecord(index),
        { sequence: index + 1, leaseUpdatedAtMs: 5000 },
    ));
    const deliver = async input => {
        const deliveries = [];
        const coordinator = new OpenWorkspaceCoordinator('/unused-open-workspace-boundary', {
            now: () => 5000,
            setInterval: () => 'boundary-interval',
            clearInterval: () => undefined,
            createWatcher: () => ({ close: () => undefined }),
            deliverAggregate: aggregate => deliveries.push(aggregate),
            createStore: () => ({
                write: async () => undefined,
                remove: async () => undefined,
                scan: async () => ({ registrations: input, counters: {} }),
            }),
        });
        try {
            await coordinator.publish(makeWorkspacePublication());
            return deliveries[0];
        } finally {
            coordinator.dispose();
        }
    };
    const forward = await deliver(registrations);
    const reverse = await deliver(registrations.slice().reverse());
    assert.strictEqual(forward.registrations.length, 100);
    assert.deepStrictEqual(workspaceProtocol.validateOpenWorkspaceAggregate(forward), forward);
    assert.deepStrictEqual(reverse, forward, 'bounded aggregate order must not depend on scan order');
    assert.strictEqual(forward.registrations[0].lastFocusedAtMs, 100);
    assert.strictEqual(forward.registrations[99].lastFocusedAtMs, 1);
}

async function runOpenWorkspaceCoordinatorDiagnosticPrivacyChecks() {
    const sentinel = '/private/workspace raw-command --session secret-session';
    const diagnostics = [];
    const coordinator = new OpenWorkspaceCoordinator('/unused-open-workspace-diagnostic', {
        now: () => 5000,
        setInterval: () => 'diagnostic-interval',
        clearInterval: () => undefined,
        createWatcher: () => ({ close: () => undefined }),
        deliverAggregate: () => undefined,
        reportDiagnostic: event => diagnostics.push(event),
        createStore: () => ({
            write: async () => { throw new Error(sentinel); },
            remove: async () => undefined,
            scan: async () => ({ registrations: [], counters: {} }),
        }),
    });
    try {
        await assert.rejects(coordinator.publish(makeWorkspacePublication()), error => {
            assert.ok(String(error).includes(sentinel),
                'the direct caller may receive its own operation error');
            return true;
        });
        const diagnostic = diagnostics.find(event => event.event === 'error');
        assert.deepStrictEqual(diagnostic, {
            event: 'error',
            operation: 'publish',
            errorCategory: 'open-workspace-operation',
            errorCode: 'failed',
            atMs: 5000,
        });
        assert.strictEqual(JSON.stringify(diagnostics).includes(sentinel), false,
            'cross-extension diagnostics must not contain arbitrary exception text');
    } finally {
        coordinator.dispose();
    }
}

async function runOpenWorkspaceClientAndControllerChecks() {
    const commands = new Map();
    const executions = [];
    let intervalCallback;
    const record = makeWorkspaceRecord(12);
    const client = new OpenWorkspaceBridgeClient(record, () => undefined, () => undefined, {
        instanceId: SELF,
        mainExtensionVersion: '2.0.0',
        registerCommand: (command, callback) => {
            commands.set(command, callback);
            return { dispose: () => commands.delete(command) };
        },
        executeCommand: async (command, argument) => {
            executions.push({ command, argument });
            if (command === '_projectStewardOpenWorkspaces.bridge.handshake') {
                return {
                    accepted: true,
                    protocolVersion: 2,
                    bridgeExtensionVersion: '2.0.0',
                    capabilities: { workspaces: true, atomicReplace: true, focusLeases: true },
                };
            }
            return { accepted: true };
        },
        setInterval: callback => {
            intervalCallback = callback;
            return 'heartbeat';
        },
        clearInterval: () => undefined,
    });
    for (let attempt = 0; attempt < 50
        && !executions.some(value => value.command === '_projectStewardOpenWorkspaces.bridge.publish'); attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.strictEqual(executions[0].command, '_projectStewardOpenWorkspaces.bridge.handshake');
    assert.strictEqual(executions[1].command, '_projectStewardOpenWorkspaces.bridge.publish');
    assert.strictEqual(executions[1].argument.workspace.navigationIdentity, record.navigationIdentity);
    assert.deepStrictEqual(Object.keys(executions[1].argument.workspace.roots[0]).sort(),
        ['id', 'name', 'ordinal', 'uri']);
    assert.strictEqual(executions[1].argument.workspace.aiSessions, undefined);
    assert.strictEqual(executions[1].argument.workspace.provider, undefined);

    await client.publish(record, true);
    const focusPublication = executions.filter(value => value.command.endsWith('.bridge.publish')).pop().argument;
    assert.strictEqual(focusPublication.followsFocusEvent, true);
    intervalCallback();
    for (let attempt = 0; attempt < 50
        && executions.filter(value => value.command.endsWith('.bridge.publish')).length < 3; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
    client.dispose();
    for (let attempt = 0; attempt < 50
        && !executions.some(value => value.command === '_projectStewardOpenWorkspaces.bridge.unregister'); attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(executions.some(value =>
        value.command === '_projectStewardOpenWorkspaces.bridge.unregister'
        && value.argument.protocolVersion === 2
    ));
    assert.strictEqual(commands.size, 0);

    const publications = [];
    let currentWorkspace = record;
    let workspaceResolutionCount = 0;
    const workspaceController = new OpenWorkspaceController({
        getWorkspace: () => {
            workspaceResolutionCount += 1;
            return currentWorkspace;
        },
        getRunningAiSessionCount: () => 2,
        publishWorkspace: (workspace, followsFocusEvent) => publications.push({ workspace, followsFocusEvent }),
    });
    workspaceController.publish();
    workspaceController.getCurrentWorkspace();
    workspaceController.getPublication();
    assert.strictEqual(workspaceResolutionCount, 1,
        'one publication cycle must resolve the current workspace only once');
    currentWorkspace = null;
    workspaceController.publish(true);
    assert.strictEqual(workspaceResolutionCount, 2);
    assert.deepStrictEqual(publications, [
        { workspace: { ...record, runningAiSessionCount: 2 }, followsFocusEvent: false },
        { workspace: null, followsFocusEvent: true },
    ]);

    const duplicateIdentity = workspaceIdentity(900);
    const current = { ...makeWorkspaceRecord(30), roots: [{ ...makeWorkspaceRoot(30), hostPath: '/private/current' }] };
    const duplicate = makeWorkspaceRecord(31, { navigationIdentity: duplicateIdentity });
    const duplicateNewer = makeWorkspaceRecord(32, {
        navigationIdentity: duplicateIdentity,
        displayName: 'Newest registration wins',
    });
    const aggregate = makeWorkspaceAggregate([
        makeWorkspaceRegistration(OTHER, 1000, duplicate),
        makeWorkspaceRegistration(NEWER, 2000, duplicateNewer),
    ]);
    const posted = [];
    const dashboard = new OpenWorkspaceDashboardController({
        getCurrentWorkspace: () => current,
        isWorkspaceSavedAsProject: () => false,
        getCurrentWorkspaceAiSessions: () => null,
        getGroups: () => [],
        getTodoSearchItems: () => [],
        getCollapsed: () => false,
        getRunningCardAnimation: () => 'orbit',
        getAttentionAggregate: () => null,
        getBridgeInstanceId: () => SELF,
        postMessage: async message => { posted.push(message); return true; },
        refresh: () => undefined,
        isVisible: () => true,
        logDiagnostic: () => undefined,
        logError: () => undefined,
    });
    dashboard.setAggregate(aggregate);
    const cards = dashboard.getCards();
    assert.strictEqual(cards.filter(card => card.kind === 'current').length, 1);
    assert.strictEqual(cards.find(card => card.kind === 'current').showSaveAction, true);
    assert.strictEqual(cards.find(card => card.kind === 'navigation').showSaveAction, false);
    assert.strictEqual(cards.filter(card => card.kind === 'navigation').length, 1,
        'two owner registrations for one navigation identity must project to one card');
    assert.strictEqual(cards.find(card => card.kind === 'navigation').name, 'Newest registration wins');
    assert.strictEqual(cards.some(card => card.roots.some(root => Object.hasOwnProperty.call(root, 'hostPath'))), false);
    assert.strictEqual(cards.find(card => card.kind === 'navigation').aiSessions, undefined,
        'OTHER WINDOWS cards must stay lightweight');
    let identityWorkspace = {
        ...current,
        kind: 'untitledMultiRoot',
        navigationIdentity: workspaceIdentity(930),
        navigationUri: 'untitled:Untitled-9',
    };
    let identitySavedAsProject = false;
    const identityDashboard = new OpenWorkspaceDashboardController({
        getCurrentWorkspace: () => identityWorkspace,
        isWorkspaceSavedAsProject: () => identitySavedAsProject,
        getCurrentWorkspaceAiSessions: () => null,
        getGroups: () => [],
        getTodoSearchItems: () => [],
        getCollapsed: () => false,
        getRunningCardAnimation: () => 'current',
        getAttentionAggregate: () => null,
        getBridgeInstanceId: () => SELF,
        postMessage: async () => true,
        refresh: () => undefined,
        isVisible: () => true,
        logDiagnostic: () => undefined,
        logError: () => undefined,
    });
    const untitledCardId = identityDashboard.getCards()[0].id;
    assert.strictEqual(identityDashboard.getCards()[0].showSaveAction, true);
    identityDashboard.setAggregate(aggregate);
    const navigationCardIdsBeforeSave = identityDashboard.getCards()
        .filter(card => card.kind === 'navigation').map(card => card.id).sort();
    identityWorkspace = {
        ...identityWorkspace,
        kind: 'savedMultiRoot',
        navigationIdentity: workspaceIdentity(931),
        navigationUri: 'file:///work/saved.code-workspace',
    };
    const savedCardId = identityDashboard.getCards()[0].id;
    assert.strictEqual(identityDashboard.getCards()[0].showSaveAction, true,
        'saving the workspace file must keep the action until it is registered in Saved Projects');
    identitySavedAsProject = true;
    assert.strictEqual(identityDashboard.getCards()[0].showSaveAction, false,
        'the save action must disappear after the workspace is registered in Saved Projects');
    assert.strictEqual(savedCardId, untitledCardId,
        'saving an untitled workspace must preserve the scope-owned current card ID');
    assert.deepStrictEqual(identityDashboard.getCards()
        .filter(card => card.kind === 'navigation').map(card => card.id).sort(), navigationCardIdsBeforeSave,
        'OTHER WINDOWS card IDs must remain navigation-owned across the current workspace save transition');
    identityWorkspace = {
        ...identityWorkspace,
        scopeIdentity: workspaceIdentity(932),
        roots: identityWorkspace.roots.concat(makeWorkspaceRoot(932)),
    };
    assert.notStrictEqual(identityDashboard.getCards()[0].id, savedCardId,
        'changing the root set must change the scope-owned current card ID');
    dashboard.postUpdated();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].type, 'open-workspaces-updated');
    assert.strictEqual(posted[0].version, 2);
    assert.strictEqual(posted[0].currentWorkspaceCount, 1);
    assert.strictEqual(posted[0].navigationWorkspaceCount, 1);
    assert.strictEqual(posted[0].searchCatalog.version, 2);
}

async function runWorkspaceNavigationControllerChecks() {
    const environments = ['local', 'ssh', 'wsl', 'devContainer', 'remote'];
    const navigableKinds = ['singleFolder', 'savedMultiRoot'];
    let record = makeWorkspaceRecord(60, {
        kind: 'savedMultiRoot',
        environment: 'devContainer',
        navigationUri: 'vscode-remote://dev-container%2Btarget/work/team.code-workspace',
        roots: [makeWorkspaceRoot(60, {
            uri: 'vscode-remote://dev-container%2Btarget/work/member-root',
        })],
    });
    let directExecutionFails = false;
    const executions = [];
    const parsedUris = [];
    const informationMessages = [];
    const warningMessages = [];
    const refreshes = [];
    const controller = new WorkspaceNavigationController({
        getRecord: cardId => cardId === 'live-card' ? record : null,
        executeCommand: async (...args) => {
            executions.push(args);
            if (directExecutionFails) { throw new Error('forced direct navigation failure'); }
        },
        parseUri: value => {
            const parsed = { parsed: value };
            parsedUris.push(parsed);
            return parsed;
        },
        showInformationMessage: message => { informationMessages.push(message); },
        showWarningMessage: message => { warningMessages.push(message); },
        refresh: reason => refreshes.push(reason),
    });

    await controller.open('missing-card');
    assert.deepStrictEqual(refreshes, ['open-workspace-navigation-stale']);
    assert.deepStrictEqual(executions, []);
    assert.deepStrictEqual(parsedUris, []);

    let caseIndex = 0;
    for (const environment of environments) {
        for (const kind of navigableKinds) {
            caseIndex += 1;
            executions.length = 0;
            parsedUris.length = 0;
            informationMessages.length = 0;
            warningMessages.length = 0;
            const rootUri = `file:///work/member-root-${caseIndex}`;
            record = makeWorkspaceRecord(60 + caseIndex, {
                kind,
                environment,
                navigationUri: environment === 'local'
                    ? `file:///work/navigation-${caseIndex}${kind === 'savedMultiRoot' ? '.code-workspace' : ''}`
                    : `vscode-remote://${environment}%2Btarget/work/navigation-${caseIndex}${kind === 'savedMultiRoot' ? '.code-workspace' : ''}`,
                roots: [makeWorkspaceRoot(60 + caseIndex, { uri: rootUri })],
            });
            await controller.open('live-card');
            assert.deepStrictEqual(parsedUris, [{ parsed: record.navigationUri }]);
            assert.deepStrictEqual(executions, [[
                'vscode.openFolder',
                parsedUris[0],
                { forceNewWindow: true },
            ]], `${environment}/${kind} must open the exact navigation URI in a new window`);
            assert.deepStrictEqual(informationMessages, []);
            assert.deepStrictEqual(warningMessages, []);
            assert.strictEqual(JSON.stringify(executions).includes(rootUri), false,
                `${environment}/${kind} must never open a member root URI`);
        }
    }

    executions.length = 0;
    parsedUris.length = 0;
    informationMessages.length = 0;
    warningMessages.length = 0;
    record = makeWorkspaceRecord(80, {
        kind: 'untitledMultiRoot',
        environment: 'local',
        navigationUri: 'untitled:Untitled-1',
        roots: [makeWorkspaceRoot(80, { uri: 'file:///work/untitled-member-root' })],
    });
    await controller.open('live-card');
    assert.deepStrictEqual(informationMessages, ['Save this workspace before switching to it']);
    assert.deepStrictEqual(executions, []);
    assert.deepStrictEqual(parsedUris, []);
    assert.deepStrictEqual(warningMessages, []);

    record = makeWorkspaceRecord(90, {
        kind: 'savedMultiRoot',
        environment: 'devContainer',
        navigationUri: 'vscode-remote://dev-container%2Btarget/work/direct.code-workspace',
        roots: [makeWorkspaceRoot(90, {
            uri: 'vscode-remote://dev-container%2Btarget/work/member-root',
        })],
    });
    directExecutionFails = true;
    parsedUris.length = 0;
    executions.length = 0;
    warningMessages.length = 0;
    await controller.open('live-card');
    assert.deepStrictEqual(executions, [[
        'vscode.openFolder',
        parsedUris[0],
        { forceNewWindow: true },
    ]]);
    assert.deepStrictEqual(warningMessages, [
        'Unable to switch directly to this workspace. Use VS Code Switch Window instead.',
    ]);
    assert.strictEqual(executions.some(args => args[0] === 'workbench.action.switchWindow'), false);
    assert.strictEqual(JSON.stringify(executions).includes(record.roots[0].uri), false);
}

async function runOpenWorkspaceHardeningChecks() {
    const flush = () => new Promise(resolve => setImmediate(resolve));
    const acceptedHandshake = {
        accepted: true,
        protocolVersion: 2,
        bridgeExtensionVersion: '2.0.0',
        capabilities: { workspaces: true, atomicReplace: true, focusLeases: true },
    };

    const terminalHandshakeCases = [
        ['rejected response', { ...acceptedHandshake, accepted: false, errorCode: 'update-required' }],
        ['protocol version mismatch', { ...acceptedHandshake, protocolVersion: 1 }],
        ['malformed response', { accepted: true, protocolVersion: 2 }],
        ['capability mismatch', {
            ...acceptedHandshake,
            capabilities: { ...acceptedHandshake.capabilities, focusLeases: false },
        }],
    ];
    for (let caseIndex = 0; caseIndex < terminalHandshakeCases.length; caseIndex += 1) {
        const [label, response] = terminalHandshakeCases[caseIndex];
        const mismatchExecutions = [];
        const mismatchTimers = [];
        const mismatchStatuses = [];
        let mismatchHeartbeat;
        const mismatchClient = new OpenWorkspaceBridgeClient(
            makeWorkspaceRecord(40 + caseIndex),
            () => undefined,
            () => undefined,
            {
                instanceId: (caseIndex + 7).toString(16).repeat(32),
                mainExtensionVersion: '2.0.0',
                registerCommand: () => ({ dispose: () => undefined }),
                executeCommand: async (command, argument) => {
                    mismatchExecutions.push({ command, argument });
                    return command.endsWith('.bridge.handshake') ? response : undefined;
                },
                setInterval: callback => { mismatchHeartbeat = callback; return 'heartbeat'; },
                clearInterval: () => undefined,
                setTimeout: (callback, delayMs) => {
                    mismatchTimers.push({ callback, delayMs });
                    return mismatchTimers.length;
                },
                clearTimeout: () => undefined,
                onStatusChange: status => mismatchStatuses.push(status),
            }
        );
        await flush();
        await mismatchClient.publish(makeWorkspaceRecord(60 + caseIndex));
        mismatchHeartbeat();
        await flush();
        assert.strictEqual(
            mismatchExecutions.filter(value => value.command.endsWith('.bridge.handshake')).length,
            1,
            `${label} must be terminal instead of creating a retry storm`
        );
        assert.strictEqual(mismatchTimers.length, 0, `${label} must not schedule a retry`);
        assert.deepStrictEqual(mismatchStatuses, ['update-required'], label);
        mismatchClient.dispose();
    }

    let transientHandshakeCount = 0;
    const retryTimers = [];
    const retryStatuses = [];
    const retryClient = new OpenWorkspaceBridgeClient(
        makeWorkspaceRecord(42),
        () => undefined,
        () => undefined,
        {
            instanceId: OTHER,
            registerCommand: () => ({ dispose: () => undefined }),
            executeCommand: async command => {
                if (command.endsWith('.bridge.handshake')) {
                    transientHandshakeCount += 1;
                    throw new Error('protocol transport temporarily unavailable');
                }
                return undefined;
            },
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
            setTimeout: (callback, delayMs) => {
                retryTimers.push({ callback, delayMs });
                return retryTimers.length;
            },
            clearTimeout: () => undefined,
            onStatusChange: status => retryStatuses.push(status),
        }
    );
    const queuedRetryA = retryClient.publish(makeWorkspaceRecord(43));
    const queuedRetryB = retryClient.publish(makeWorkspaceRecord(44));
    await Promise.all([queuedRetryA, queuedRetryB]);
    assert.strictEqual(transientHandshakeCount, 1,
        'queued publications must wait for the one scheduled retry instead of retrying immediately');
    assert.strictEqual(retryTimers.length, 1, 'transient failure must keep at most one retry timer');
    assert.deepStrictEqual(retryStatuses, ['unavailable'],
        'transport rejection text must never be classified as a protocol incompatibility');
    retryClient.dispose();

    const backoffTimers = [];
    const activeBackoffTimers = new Set();
    const backoffStatuses = [];
    let maximumActiveBackoffTimers = 0;
    let backoffPublishAttempts = 0;
    const backoffClient = new OpenWorkspaceBridgeClient(
        makeWorkspaceRecord(70),
        () => undefined,
        () => undefined,
        {
            instanceId: 'b'.repeat(32),
            registerCommand: () => ({ dispose: () => undefined }),
            executeCommand: async command => {
                if (command.endsWith('.bridge.handshake')) return acceptedHandshake;
                if (command.endsWith('.bridge.publish')) {
                    backoffPublishAttempts += 1;
                    if (backoffPublishAttempts <= 6) throw new Error('publish transport failure');
                }
                return undefined;
            },
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
            setTimeout: (callback, delayMs) => {
                const timer = {
                    delayMs,
                    callback: () => {
                        activeBackoffTimers.delete(timer);
                        callback();
                    },
                };
                backoffTimers.push(timer);
                activeBackoffTimers.add(timer);
                maximumActiveBackoffTimers = Math.max(maximumActiveBackoffTimers, activeBackoffTimers.size);
                return timer;
            },
            clearTimeout: timer => activeBackoffTimers.delete(timer),
            onStatusChange: status => backoffStatuses.push(status),
        }
    );
    for (let timerIndex = 0; timerIndex < 6; timerIndex += 1) {
        for (let attempt = 0; attempt < 50 && backoffTimers.length <= timerIndex; attempt += 1) {
            await flush();
        }
        assert.strictEqual(backoffTimers.length, timerIndex + 1,
            'each failed retry cycle must schedule exactly one next timer');
        backoffTimers[timerIndex].callback();
    }
    for (let attempt = 0; attempt < 50 && backoffStatuses.at(-1) !== 'ready'; attempt += 1) {
        await flush();
    }
    assert.deepStrictEqual(backoffTimers.map(timer => timer.delayMs),
        [100, 500, 2_000, 10_000, 30_000, 30_000],
        'publish retry delays must increase and cap across successful handshakes');
    assert.strictEqual(maximumActiveBackoffTimers, 1, 'a retry cycle must keep at most one active timer');
    assert.strictEqual(backoffPublishAttempts, 7);
    assert.deepStrictEqual(backoffStatuses, ['unavailable', 'ready'],
        'ready must not churn between retry handshakes and failed required publications');
    backoffClient.dispose();

    const staleW1 = makeWorkspaceRecord(80);
    const staleW2 = makeWorkspaceRecord(81);
    const latestW3 = makeWorkspaceRecord(82);
    const recoveryTimers = [];
    const activeRecoveryTimers = new Set();
    const recoveryStatuses = [];
    const recoveryPublications = [];
    let recoveryHandshakeAttempts = 0;
    let latestW3Attempts = 0;
    let resolveRecoveryHandshake;
    const pendingRecoveryHandshake = new Promise(resolve => { resolveRecoveryHandshake = resolve; });
    const recoveryClient = new OpenWorkspaceBridgeClient(
        staleW1,
        () => undefined,
        () => undefined,
        {
            instanceId: 'c'.repeat(32),
            registerCommand: () => ({ dispose: () => undefined }),
            executeCommand: async (command, argument) => {
                if (command.endsWith('.bridge.handshake')) {
                    recoveryHandshakeAttempts += 1;
                    if (recoveryHandshakeAttempts === 1) throw new Error('initial handshake failure');
                    if (recoveryHandshakeAttempts === 2) return pendingRecoveryHandshake;
                    return acceptedHandshake;
                }
                if (command.endsWith('.bridge.publish')) {
                    recoveryPublications.push(argument.workspace);
                    if (argument.workspace?.navigationIdentity === latestW3.navigationIdentity) {
                        latestW3Attempts += 1;
                        if (latestW3Attempts === 1) throw new Error('latest workspace publish failed');
                    }
                }
                return undefined;
            },
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
            setTimeout: (callback, delayMs) => {
                const timer = {
                    delayMs,
                    callback: () => {
                        activeRecoveryTimers.delete(timer);
                        callback();
                    },
                };
                recoveryTimers.push(timer);
                activeRecoveryTimers.add(timer);
                return timer;
            },
            clearTimeout: timer => activeRecoveryTimers.delete(timer),
            onStatusChange: status => recoveryStatuses.push(status),
        }
    );
    for (let attempt = 0; attempt < 50 && recoveryTimers.length === 0; attempt += 1) await flush();
    assert.deepStrictEqual(recoveryTimers.map(timer => timer.delayMs), [100]);
    recoveryTimers[0].callback();
    for (let attempt = 0; attempt < 50 && recoveryHandshakeAttempts < 2; attempt += 1) await flush();
    const staleW2Publication = recoveryClient.publish(staleW2);
    const latestW3Publication = recoveryClient.publish(latestW3);
    resolveRecoveryHandshake(acceptedHandshake);
    await Promise.all([staleW2Publication, latestW3Publication]);
    for (let attempt = 0; attempt < 50 && recoveryTimers.length < 2; attempt += 1) await flush();
    assert.deepStrictEqual(
        recoveryPublications.map(workspace => workspace?.navigationIdentity || null),
        [latestW3.navigationIdentity],
        'recovery handshake completion must publish only the latest desired generation'
    );
    assert.deepStrictEqual(recoveryTimers.map(timer => timer.delayMs), [100, 500],
        'failure of the latest recovery publication must continue the prior backoff');
    assert.deepStrictEqual(recoveryStatuses, ['unavailable'],
        'stale acknowledgement and retry handshake success must not emit ready');
    assert.strictEqual(activeRecoveryTimers.size, 1);
    recoveryTimers[1].callback();
    for (let attempt = 0; attempt < 50 && recoveryStatuses.at(-1) !== 'ready'; attempt += 1) await flush();
    assert.deepStrictEqual(
        recoveryPublications.map(workspace => workspace?.navigationIdentity || null),
        [latestW3.navigationIdentity, latestW3.navigationIdentity]
    );
    assert.deepStrictEqual(recoveryStatuses, ['unavailable', 'ready']);
    assert.strictEqual(activeRecoveryTimers.size, 0);
    recoveryClient.dispose();

    const runIdenticalGenerationRecoveryCase = async (workspace, instanceId, label) => {
        const timers = [];
        const activeTimers = new Set();
        const statuses = [];
        const publications = [];
        let handshakeAttempts = 0;
        let failNextPublication = false;
        let resolveStalePublication;
        const stalePublication = new Promise(resolve => { resolveStalePublication = resolve; });
        const client = new OpenWorkspaceBridgeClient(
            workspace,
            () => undefined,
            () => undefined,
            {
                instanceId,
                registerCommand: () => ({ dispose: () => undefined }),
                executeCommand: async (command, argument) => {
                    if (command.endsWith('.bridge.handshake')) {
                        handshakeAttempts += 1;
                        if (handshakeAttempts === 1) throw new Error(`${label} initial handshake failure`);
                        return acceptedHandshake;
                    }
                    if (command.endsWith('.bridge.publish')) {
                        publications.push(argument.workspace);
                        if (publications.length === 1) return stalePublication;
                        if (failNextPublication) {
                            failNextPublication = false;
                            throw new Error(`${label} reset probe failure`);
                        }
                    }
                    return undefined;
                },
                setInterval: () => 'heartbeat',
                clearInterval: () => undefined,
                setTimeout: (callback, delayMs) => {
                    const timer = {
                        delayMs,
                        callback: () => {
                            activeTimers.delete(timer);
                            callback();
                        },
                    };
                    timers.push(timer);
                    activeTimers.add(timer);
                    return timer;
                },
                clearTimeout: timer => activeTimers.delete(timer),
                onStatusChange: status => statuses.push(status),
            }
        );
        for (let attempt = 0; attempt < 50 && timers.length === 0; attempt += 1) await flush();
        timers[0].callback();
        for (let attempt = 0; attempt < 50 && publications.length === 0; attempt += 1) await flush();
        const latestPublication = client.publish(workspace);
        resolveStalePublication(undefined);
        assert.strictEqual(await latestPublication, true,
            `${label} latest identical generation must be acknowledged`);
        assert.deepStrictEqual(publications, [workspace, workspace],
            `${label} stale acknowledgement must not suppress the latest identical command`);
        assert.deepStrictEqual(statuses, ['unavailable', 'ready'],
            `${label} recovery must become ready only after the latest identical acknowledgement`);
        assert.strictEqual(activeTimers.size, 0, `${label} recovery must not leave a retry timer active`);

        failNextPublication = true;
        assert.strictEqual(await client.publish(workspace, true), false);
        assert.deepStrictEqual(timers.map(timer => timer.delayMs), [100, 100],
            `${label} latest acknowledgement must reset the next retry delay`);
        assert.strictEqual(activeTimers.size, 1, `${label} reset probe must retain exactly one timer`);
        timers[1].callback();
        for (let attempt = 0; attempt < 50 && statuses.at(-1) !== 'ready'; attempt += 1) await flush();
        assert.deepStrictEqual(publications, [workspace, workspace, workspace, workspace],
            `${label} must issue exactly two recovery commands and one failed/successful reset probe pair`);
        assert.deepStrictEqual(statuses, ['unavailable', 'ready', 'unavailable', 'ready']);
        assert.strictEqual(activeTimers.size, 0, `${label} final retry success must clear the timer`);
        client.dispose();
    };

    await runIdenticalGenerationRecoveryCase(
        makeWorkspaceRecord(88),
        'f'.repeat(32),
        'identical workspace generation'
    );
    await runIdenticalGenerationRecoveryCase(
        null,
        '1'.repeat(32),
        'repeated null generation'
    );

    const runPriorSemanticRecoveryCase = async (workspace, instanceId, label) => {
        const timers = [];
        const activeTimers = new Set();
        const statuses = [];
        const publications = [];
        let heartbeatCallback;
        let latestSettled = false;
        let resolveStaleRetry;
        let resolveLatestPublication;
        const staleRetry = new Promise(resolve => { resolveStaleRetry = resolve; });
        const latestPublicationCommand = new Promise(resolve => { resolveLatestPublication = resolve; });
        const client = new OpenWorkspaceBridgeClient(
            workspace,
            () => undefined,
            () => undefined,
            {
                instanceId,
                registerCommand: () => ({ dispose: () => undefined }),
                executeCommand: async (command, argument) => {
                    if (command.endsWith('.bridge.handshake')) return acceptedHandshake;
                    if (command.endsWith('.bridge.publish')) {
                        publications.push(argument.workspace);
                        if (publications.length === 2) throw new Error(`${label} heartbeat failure`);
                        if (publications.length === 3) return staleRetry;
                        if (publications.length === 4) return latestPublicationCommand;
                    }
                    return undefined;
                },
                setInterval: callback => {
                    heartbeatCallback = callback;
                    return 'heartbeat';
                },
                clearInterval: () => undefined,
                setTimeout: (callback, delayMs) => {
                    const timer = {
                        delayMs,
                        callback: () => {
                            activeTimers.delete(timer);
                            callback();
                        },
                    };
                    timers.push(timer);
                    activeTimers.add(timer);
                    return timer;
                },
                clearTimeout: timer => activeTimers.delete(timer),
                onStatusChange: status => statuses.push(status),
            }
        );
        for (let attempt = 0; attempt < 50 && publications.length < 1; attempt += 1) await flush();
        assert.strictEqual(await client.publish(workspace), true,
            `${label} healthy identical publication must remain accepted`);
        assert.deepStrictEqual(publications, [workspace],
            `${label} healthy identical semantic must remain suppressed`);

        heartbeatCallback();
        for (let attempt = 0; attempt < 50 && timers.length < 1; attempt += 1) await flush();
        assert.deepStrictEqual(publications, [workspace, workspace]);
        assert.deepStrictEqual(statuses, ['ready', 'unavailable']);
        assert.deepStrictEqual(timers.map(timer => timer.delayMs), [100]);
        assert.strictEqual(activeTimers.size, 1);

        timers[0].callback();
        for (let attempt = 0; attempt < 50 && publications.length < 3; attempt += 1) await flush();
        const latestPublication = client.publish(workspace).then(result => {
            latestSettled = true;
            return result;
        });
        resolveStaleRetry(undefined);
        for (let attempt = 0;
            attempt < 50 && publications.length < 4 && !latestSettled;
            attempt += 1) await flush();
        assert.deepStrictEqual(publications, [workspace, workspace, workspace, workspace],
            `${label} prior semantic must not suppress the latest recovery command`);
        assert.strictEqual(latestSettled, false,
            `${label} latest promise must wait for its own acknowledgement`);
        assert.deepStrictEqual(statuses, ['ready', 'unavailable'],
            `${label} stale retry success must not restore ready`);
        assert.strictEqual(activeTimers.size, 0);

        resolveLatestPublication(undefined);
        assert.strictEqual(await latestPublication, true);
        assert.deepStrictEqual(statuses, ['ready', 'unavailable', 'ready']);
        assert.strictEqual(activeTimers.size, 0, `${label} latest success must leave no retry timer`);
        client.dispose();
    };

    await runPriorSemanticRecoveryCase(
        makeWorkspaceRecord(89),
        '2'.repeat(32),
        'prior workspace semantic recovery'
    );
    await runPriorSemanticRecoveryCase(
        null,
        '3'.repeat(32),
        'prior null semantic recovery'
    );

    const closureW1 = makeWorkspaceRecord(83);
    const closureW2 = makeWorkspaceRecord(84);
    const closureTimers = [];
    const closurePublications = [];
    let closureHandshakeAttempts = 0;
    let resolveClosureHandshake;
    const pendingClosureHandshake = new Promise(resolve => { resolveClosureHandshake = resolve; });
    const closureClient = new OpenWorkspaceBridgeClient(
        closureW1,
        () => undefined,
        () => undefined,
        {
            instanceId: 'd'.repeat(32),
            registerCommand: () => ({ dispose: () => undefined }),
            executeCommand: async (command, argument) => {
                if (command.endsWith('.bridge.handshake')) {
                    closureHandshakeAttempts += 1;
                    if (closureHandshakeAttempts === 1) throw new Error('initial closure handshake failure');
                    if (closureHandshakeAttempts === 2) return pendingClosureHandshake;
                    return acceptedHandshake;
                }
                if (command.endsWith('.bridge.publish')) closurePublications.push(argument.workspace);
                return undefined;
            },
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
            setTimeout: (callback, delayMs) => {
                const timer = { callback, delayMs };
                closureTimers.push(timer);
                return timer;
            },
            clearTimeout: () => undefined,
        }
    );
    for (let attempt = 0; attempt < 50 && closureTimers.length === 0; attempt += 1) await flush();
    closureTimers[0].callback();
    for (let attempt = 0; attempt < 50 && closureHandshakeAttempts < 2; attempt += 1) await flush();
    const staleClosurePublication = closureClient.publish(closureW2);
    const latestClosurePublication = closureClient.publish(null);
    resolveClosureHandshake(acceptedHandshake);
    await Promise.all([staleClosurePublication, latestClosurePublication]);
    for (let attempt = 0; attempt < 50 && closurePublications.length === 0; attempt += 1) await flush();
    assert.deepStrictEqual(closurePublications, [null],
        'a null closure generation must supersede every captured stale workspace during recovery');
    closureClient.dispose();

    const connectedW1 = makeWorkspaceRecord(85);
    const connectedW2 = makeWorkspaceRecord(86);
    const connectedW3 = makeWorkspaceRecord(87);
    const connectedPublications = [];
    const connectedClient = new OpenWorkspaceBridgeClient(
        connectedW1,
        () => undefined,
        () => undefined,
        {
            instanceId: 'e'.repeat(32),
            registerCommand: () => ({ dispose: () => undefined }),
            executeCommand: async (command, argument) => {
                if (command.endsWith('.bridge.handshake')) return acceptedHandshake;
                if (command.endsWith('.bridge.publish')) connectedPublications.push(argument.workspace);
                return undefined;
            },
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
        }
    );
    for (let attempt = 0; attempt < 50 && connectedPublications.length === 0; attempt += 1) await flush();
    await Promise.all([
        connectedClient.publish(connectedW2),
        connectedClient.publish(connectedW3),
    ]);
    assert.deepStrictEqual(
        connectedPublications.map(workspace => workspace.navigationIdentity),
        [connectedW1.navigationIdentity, connectedW2.navigationIdentity, connectedW3.navigationIdentity],
        'healthy connected publications must preserve their sequential order'
    );
    connectedClient.dispose();

    let resolveHandshake;
    const pendingHandshake = new Promise(resolve => { resolveHandshake = resolve; });
    const handshakeDisposeExecutions = [];
    const handshakeDisposeClient = new OpenWorkspaceBridgeClient(
        makeWorkspaceRecord(45),
        () => undefined,
        () => undefined,
        {
            instanceId: NEWER,
            registerCommand: () => ({ dispose: () => undefined }),
            executeCommand: (command, argument) => {
                handshakeDisposeExecutions.push({ command, argument });
                return command.endsWith('.bridge.handshake') ? pendingHandshake : Promise.resolve(undefined);
            },
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
        }
    );
    await flush();
    handshakeDisposeClient.dispose();
    await flush();
    assert.strictEqual(
        handshakeDisposeExecutions.filter(value => value.command.endsWith('.bridge.unregister')).length,
        1,
        'dispose must not wait forever for an in-flight handshake before unregistering'
    );
    resolveHandshake(acceptedHandshake);
    await flush();
    assert.strictEqual(
        handshakeDisposeExecutions.some(value => value.command.endsWith('.bridge.publish')),
        false,
        'a handshake completed after disposal must never publish'
    );

    let resolveInFlightPublish;
    const inFlightPublish = new Promise(resolve => { resolveInFlightPublish = resolve; });
    const publishDisposeExecutions = [];
    const publishDisposeClient = new OpenWorkspaceBridgeClient(
        makeWorkspaceRecord(47),
        () => undefined,
        () => undefined,
        {
            instanceId: '6'.repeat(32),
            registerCommand: () => ({ dispose: () => undefined }),
            executeCommand: (command, argument) => {
                publishDisposeExecutions.push({ command, argument });
                if (command.endsWith('.bridge.handshake')) return Promise.resolve(acceptedHandshake);
                if (command.endsWith('.bridge.publish')) return inFlightPublish;
                return Promise.resolve(undefined);
            },
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
        }
    );
    for (let attempt = 0; attempt < 50
        && !publishDisposeExecutions.some(value => value.command.endsWith('.bridge.publish')); attempt += 1) {
        await flush();
    }
    publishDisposeClient.dispose();
    await flush();
    assert.strictEqual(
        publishDisposeExecutions.some(value => value.command.endsWith('.bridge.unregister')),
        false,
        'dispose must not unregister before an already-issued publication settles'
    );
    resolveInFlightPublish(undefined);
    for (let attempt = 0; attempt < 50
        && !publishDisposeExecutions.some(value => value.command.endsWith('.bridge.unregister')); attempt += 1) {
        await flush();
    }
    assert.strictEqual(
        publishDisposeExecutions.filter(value => value.command.endsWith('.bridge.unregister')).length,
        1,
        'dispose must unregister once after an in-flight publication settles'
    );

    const aggregateCommands = new Map();
    let aggregateDeliveryAttempts = 0;
    const aggregateDeliveryErrors = [];
    const aggregateClient = new OpenWorkspaceBridgeClient(
        null,
        () => {
            aggregateDeliveryAttempts += 1;
            if (aggregateDeliveryAttempts === 1) {
                const rejected = Promise.reject(new Error('consumer path contains /private/workspace'));
                void rejected.catch(() => undefined);
                return rejected;
            }
            return Promise.resolve();
        },
        error => aggregateDeliveryErrors.push(error),
        {
            instanceId: '5'.repeat(32),
            registerCommand: (command, callback) => {
                aggregateCommands.set(command, callback);
                return { dispose: () => aggregateCommands.delete(command) };
            },
            executeCommand: async command => command.endsWith('.bridge.handshake')
                ? acceptedHandshake
                : undefined,
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
        }
    );
    await flush();
    let acknowledgedRegistration;
    const acknowledgementCoordinator = new OpenWorkspaceCoordinator('/unused-acknowledgement-root', {
        now: () => 5000,
        setInterval: () => 'acknowledgement-interval',
        clearInterval: () => undefined,
        createWatcher: () => ({ close: () => undefined }),
        deliverAggregate: aggregate => aggregateCommands.get(
            '_projectStewardOpenWorkspaces.workspace.aggregate'
        )(aggregate),
        createStore: () => ({
            write: async registration => { acknowledgedRegistration = registration; },
            remove: async () => undefined,
            scan: async () => ({
                registrations: acknowledgedRegistration ? [acknowledgedRegistration] : [],
                counters: {},
            }),
        }),
    });
    await assert.rejects(
        acknowledgementCoordinator.publish(makeWorkspacePublication()),
        error => {
            assert.strictEqual(error.message, 'open workspace aggregate delivery failed');
            assert.strictEqual(String(error).includes('/private/workspace'), false,
                'consumer details must be sanitized at the bridge acknowledgement boundary');
            return true;
        },
        'consumer rejection must reach the coordinator acknowledgement boundary'
    );
    await acknowledgementCoordinator.scanAndDeliver();
    assert.strictEqual(aggregateDeliveryAttempts, 2,
        'coordinator must retry the same semantic revision after consumer rejection');
    await acknowledgementCoordinator.scanAndDeliver();
    assert.strictEqual(aggregateDeliveryAttempts, 2,
        'coordinator may commit the semantic revision only after consumer acknowledgement');
    assert.strictEqual(aggregateDeliveryErrors.length, 1);
    assert.strictEqual(String(aggregateDeliveryErrors[0]).includes('/private/workspace'), true,
        'the local error sink receives the original diagnostic');
    acknowledgementCoordinator.dispose();
    aggregateClient.dispose();

    const current = {
        ...makeWorkspaceRecord(50),
        roots: [{ ...makeWorkspaceRoot(50), hostPath: '/private/current' }],
    };
    const firstOther = makeWorkspaceRecord(51);
    const secondOther = makeWorkspaceRecord(52);
    const posted = [];
    const refreshes = [];
    let deliveryResult = true;
    let runningCardAnimation = 'halo';
    const dashboard = new OpenWorkspaceDashboardController({
        getCurrentWorkspace: () => current,
        isWorkspaceSavedAsProject: () => true,
        getCurrentWorkspaceAiSessions: () => ({
            workspaceScopeIdentity: current.scopeIdentity,
            workspaceNavigationIdentity: current.navigationIdentity,
            activeProvider: 'codex',
            expanded: true,
            providers: [],
            sessionsByProvider: { codex: [], kimi: [], claude: [] },
            unavailableProviders: [],
            aiSessionCount: 0,
            attentionCount: 0,
            defaultTab: 'sessions',
            activeSessionCount: 1,
            activeSessions: [{
                key: 'codex:running', provider: 'codex', sessionId: 'running', name: 'Running',
                executionState: 'running', focused: false, needsAttention: false, pending: false,
                backend: 'vscode', attached: true,
            }],
            activeAttentionCount: 0,
        }),
        getGroups: () => [],
        getTodoSearchItems: () => [],
        getCollapsed: () => false,
        getRunningCardAnimation: () => runningCardAnimation,
        getAttentionAggregate: () => null,
        getBridgeInstanceId: () => SELF,
        postMessage: async message => { posted.push(message); return deliveryResult; },
        refresh: reason => refreshes.push(reason),
        isVisible: () => true,
        logDiagnostic: () => undefined,
        logError: () => undefined,
    });
    dashboard.setAggregate(makeWorkspaceAggregate([
        makeWorkspaceRegistration(OTHER, 1000, firstOther),
        makeWorkspaceRegistration(NEWER, 2000, secondOther),
    ], { semanticRevision: 'c'.repeat(64) }));
    const cards = dashboard.getCards();
    assert.strictEqual(cards.filter(card => card.kind === 'current').length, 1);
    assert.strictEqual(cards.filter(card => card.kind === 'navigation').length, 2);
    assert.strictEqual(cards.some(card => card.roots.some(root => root.hostPath)), false);
    assert.strictEqual(cards.find(card => card.kind === 'navigation').aiSessions, undefined);
    const staleCardId = cards.find(card => card.navigationIdentity === firstOther.navigationIdentity).id;
    assert.strictEqual(dashboard.getNavigationWorkspace(staleCardId).navigationUri, firstOther.navigationUri);
    dashboard.setAggregate(makeWorkspaceAggregate([], { semanticRevision: 'd'.repeat(64) }));
    assert.strictEqual(dashboard.getNavigationWorkspace(staleCardId), null,
        'an opaque navigation card ID must be invalidated as soon as its aggregate changes');

    dashboard.setBridgeStatus('update-required');
    const state = dashboard.getState();
    assert.strictEqual(state.otherWindows.status, 'update-required');
    assert.strictEqual(dashboard.getCards().filter(card => card.kind === 'current').length, 1,
        'bridge degradation must not remove the locally resolved current card');
    assert.ok(dashboard.getCards().find(card => card.kind === 'current').aiSessions,
        'bridge degradation must not disable current-card actions');

    dashboard.postUpdated();
    dashboard.postUpdated();
    await flush();
    assert.strictEqual(posted.length, 1, 'identical semantic workspace updates must be suppressed');
    assert.strictEqual(posted[0].otherWindowsStatus, 'update-required');
    assert.ok(posted[0].html.includes('data-session-fx="halo"'),
        'open-workspace controller updates must use the configured running animation');
    runningCardAnimation = 'orbit';
    dashboard.postUpdated();
    await flush();
    assert.strictEqual(posted.length, 2,
        'changing only the running animation must not be suppressed as an unchanged workspace update');
    assert.ok(posted[1].html.includes('data-session-fx="orbit"'));
    deliveryResult = false;
    dashboard.setBridgeStatus('unavailable');
    dashboard.postUpdated();
    await flush();
    deliveryResult = true;
    dashboard.postUpdated();
    await flush();
    assert.strictEqual(posted.filter(message => message.otherWindowsStatus === 'unavailable').length, 2,
        'an undelivered aggregate state must remain retryable');
    assert.ok(refreshes.includes('open-workspace-update-not-delivered'));
}

async function runWorkspaceContextResolverChecks() {
    function uri(value, overrides = {}) {
        const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/]*))?(.*)$/.exec(value);
        assert.ok(match, `invalid URI fixture: ${value}`);
        let decodedAuthority;
        let decodedPath;
        try {
            decodedAuthority = decodeURIComponent(match[2] || '');
            decodedPath = decodeURIComponent(match[3] || '');
        } catch (error) {
            decodedAuthority = match[2] || '';
            decodedPath = match[3] || '';
        }
        return {
            scheme: match[1].toLowerCase(),
            authority: decodedAuthority,
            path: decodedPath,
            fsPath: decodedPath,
            toString: () => value,
            ...overrides,
        };
    }

    function remoteUri(uriPath, authority = 'ssh-remote+fixture') {
        return uri(`vscode-remote://${authority}${uriPath}`, { fsPath: uriPath });
    }

    function folder(name, folderUri) {
        return { name, uri: folderUri };
    }

    const resolver = new WorkspaceContextResolver();
    assert.strictEqual(resolver.resolve({
        workspaceFile: null,
        workspaceName: undefined,
        remoteName: undefined,
        workspaceFolders: [],
    }), null);

    const local = resolver.resolve({
        workspaceFile: null,
        workspaceName: 'app [Dev Container: Existing Dockerfile]',
        remoteName: undefined,
        workspaceFolders: [folder('app', uri('file:///work/app'))],
    });
    assert.strictEqual(local.kind, 'singleFolder');
    assert.strictEqual(local.displayName, 'app');
    assert.strictEqual(local.navigationUri, 'file:///work/app');
    assert.strictEqual(local.environment, 'local');
    assert.strictEqual(local.roots.length, 1);
    assert.strictEqual(local.roots[0].name, 'app');
    assert.strictEqual(local.roots[0].uri, 'file:///work/app');
    assert.strictEqual(local.roots[0].hostPath, '/work/app');
    assert.strictEqual(local.roots[0].ordinal, 0);
    assert.strictEqual(local.roots[0].id, local.navigationIdentity);

    const saved = resolver.resolve({
        workspaceFile: uri('file:///work/team.code-workspace'),
        workspaceName: 'Team [Dev Container: Existing Dockerfile]',
        remoteName: undefined,
        workspaceFolders: [
            folder('app', uri('file:///work/app')),
            folder('lib', uri('file:///work/lib')),
        ],
    });
    assert.strictEqual(saved.kind, 'savedMultiRoot');
    assert.strictEqual(saved.displayName, 'Team');
    assert.strictEqual(saved.navigationUri, 'file:///work/team.code-workspace');
    assert.strictEqual(saved.environment, 'local');
    assert.deepStrictEqual(saved.roots.map(root => root.ordinal), [0, 1]);

    const savedWithoutWorkspaceName = resolver.resolve({
        workspaceFile: uri('file:///work/fallback.code-workspace'),
        remoteName: undefined,
        workspaceFolders: [folder('saved root name', uri('file:///work/saved-root'))],
    });
    assert.strictEqual(savedWithoutWorkspaceName.displayName, 'fallback');
    const untitledWithoutWorkspaceName = resolver.resolve({
        workspaceFile: uri('untitled:Untitled-3'),
        remoteName: undefined,
        workspaceFolders: [folder('untitled root name', uri('file:///work/untitled-root'))],
    });
    assert.strictEqual(untitledWithoutWorkspaceName.displayName, 'Untitled');
    const decoratedUntitledWorkspace = resolver.resolve({
        workspaceFile: uri('untitled:Untitled-9'),
        workspaceName: 'Untitled (Workspace)',
        remoteName: 'dev-container',
        workspaceFolders: [
            folder('app', uri('file:///work/app')),
            folder('lib', uri('file:///work/lib')),
        ],
    });
    assert.strictEqual(decoratedUntitledWorkspace.displayName, 'Untitled');
    const singleFolderWithoutWorkspaceName = resolver.resolve({
        workspaceFile: null,
        remoteName: undefined,
        workspaceFolders: [folder('single root name', uri('file:///work/single-root'))],
    });
    assert.strictEqual(singleFolderWithoutWorkspaceName.displayName, 'single root name');
    const noRootSavedWorkspace = resolver.resolve({
        workspaceFile: uri('file:///work/no-roots.code-workspace'),
        remoteName: undefined,
        workspaceFolders: [],
    });
    assert.strictEqual(noRootSavedWorkspace, null,
        'a saved workspace file without folders is not a current workspace snapshot');
    const noRootUntitledWorkspace = resolver.resolve({
        workspaceFile: uri('untitled:'),
        remoteName: undefined,
        workspaceFolders: [],
    });
    assert.strictEqual(noRootUntitledWorkspace, null,
        'an untitled workspace file without folders is not a current workspace snapshot');

    const zeroRootMessages = [];
    const zeroRootDashboard = new OpenWorkspaceDashboardController({
        getCurrentWorkspace: () => resolver.resolve({
            workspaceFile: uri('file:///work/no-roots.code-workspace'),
            workspaceFolders: [],
        }),
        isWorkspaceSavedAsProject: () => true,
        getCurrentWorkspaceAiSessions: () => { throw new Error('zero-root must not hydrate sessions'); },
        getGroups: () => [],
        getTodoSearchItems: () => [],
        getCollapsed: () => false,
        getRunningCardAnimation: () => 'current',
        getAttentionAggregate: () => null,
        getBridgeInstanceId: () => SELF,
        postMessage: async message => { zeroRootMessages.push(message); return true; },
        refresh: () => undefined,
        isVisible: () => true,
        logDiagnostic: () => undefined,
        logError: () => undefined,
    });
    assert.deepStrictEqual(zeroRootDashboard.getCards(), []);
    zeroRootDashboard.postUpdated();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(zeroRootMessages.length, 1);
    assert.strictEqual(zeroRootMessages[0].currentWorkspaceCount, 0);
    assert.strictEqual(zeroRootMessages[0].navigationWorkspaceCount, 0);
    assert.strictEqual(zeroRootMessages[0].searchCatalog.openWorkspaces.length, 0);
    assert.strictEqual((zeroRootMessages[0].html.match(/class="workspace-card/g) || []).length, 0,
        'declared and rendered current workspace counts must both be zero');

    const first = resolver.resolve({
        workspaceFile: uri('untitled:Untitled-1'),
        workspaceName: 'Frontend + API',
        remoteName: 'ssh-remote',
        workspaceFolders: [folder('api', remoteUri('/work/api')), folder('web', remoteUri('/work/web'))],
    });
    const reordered = resolver.resolve({
        workspaceFile: uri('untitled:Untitled-1'),
        workspaceName: 'Renamed',
        remoteName: 'ssh-remote',
        workspaceFolders: [folder('web', remoteUri('/work/web')), folder('api', remoteUri('/work/api'))],
    });
    assert.strictEqual(first.kind, 'untitledMultiRoot');
    assert.strictEqual(first.roots.length, 2);
    assert.strictEqual(first.scopeIdentity, reordered.scopeIdentity);
    assert.strictEqual(first.navigationIdentity, reordered.navigationIdentity);
    assert.deepStrictEqual(reordered.roots.map(root => root.ordinal), [0, 1]);
    assert.deepStrictEqual(reordered.roots.map(root => root.hostPath), ['/work/web', '/work/api']);
    assert.strictEqual(first.environment, 'ssh');
    assert.strictEqual(reordered.displayName, 'Renamed');
    assert.deepStrictEqual(
        first.roots.map(root => root.id).sort(),
        reordered.roots.map(root => root.id).sort()
    );

    const savedTransition = resolver.resolve({
        workspaceFile: uri('file:///work/team.code-workspace'),
        workspaceName: 'Frontend + API',
        remoteName: 'ssh-remote',
        workspaceFolders: [folder('api', remoteUri('/work/api')), folder('web', remoteUri('/work/web'))],
    });
    assert.strictEqual(savedTransition.kind, 'savedMultiRoot');
    assert.strictEqual(savedTransition.navigationUri, 'file:///work/team.code-workspace');
    assert.notStrictEqual(savedTransition.navigationIdentity, first.navigationIdentity);
    assert.strictEqual(savedTransition.scopeIdentity, first.scopeIdentity);
    assert.deepStrictEqual(savedTransition.roots, first.roots);

    const withDocs = resolver.resolve({
        workspaceFile: uri('file:///work/team.code-workspace'),
        workspaceName: 'Frontend + API',
        remoteName: 'ssh-remote',
        workspaceFolders: [
            folder('api', remoteUri('/work/api')),
            folder('web', remoteUri('/work/web')),
            folder('docs', remoteUri('/work/docs')),
        ],
    });
    assert.strictEqual(withDocs.navigationIdentity, savedTransition.navigationIdentity);
    assert.notStrictEqual(withDocs.scopeIdentity, savedTransition.scopeIdentity);
    assert.deepStrictEqual(withDocs.roots.slice(0, 2), savedTransition.roots);
    assert.strictEqual(withDocs.roots[2].hostPath, '/work/docs');
    assert.strictEqual(withDocs.roots[2].ordinal, 2);
    const removedDocs = resolver.resolve({
        workspaceFile: uri('file:///work/team.code-workspace'),
        workspaceName: 'Frontend + API',
        remoteName: 'ssh-remote',
        workspaceFolders: [folder('api', remoteUri('/work/api')), folder('web', remoteUri('/work/web'))],
    });
    assert.strictEqual(removedDocs.scopeIdentity, savedTransition.scopeIdentity);
    assert.deepStrictEqual(removedDocs.roots, savedTransition.roots);

    const nested = resolver.resolve({
        workspaceFile: uri('untitled:Untitled-2'),
        workspaceName: 'Nested',
        remoteName: undefined,
        workspaceFolders: [
            folder('repo', uri('file:///work/repo')),
            folder('packages', uri('file:///work/repo/packages')),
        ],
    });
    assert.strictEqual(nested.roots.length, 2);
    assert.notStrictEqual(nested.roots[0].id, nested.roots[1].id);
    assert.deepStrictEqual(nested.roots.map(root => root.hostPath), ['/work/repo', '/work/repo/packages']);

    const encoded = resolver.resolve({
        workspaceFile: null,
        workspaceName: 'Encoded',
        remoteName: 'ssh-remote',
        workspaceFolders: [folder('encoded', uri(
            'vscode-remote://ssh-remote%2Bfixture/work/team%20space',
            { fsPath: '/extension-host/team space' }
        ))],
    });
    const decoded = resolver.resolve({
        workspaceFile: null,
        workspaceName: 'Decoded',
        remoteName: 'ssh-remote',
        workspaceFolders: [folder('decoded', uri(
            'vscode-remote://ssh-remote+fixture/work/team space',
            { fsPath: '/different-host-path' }
        ))],
    });
    assert.strictEqual(encoded.navigationIdentity, decoded.navigationIdentity);
    assert.strictEqual(encoded.scopeIdentity, decoded.scopeIdentity);
    assert.strictEqual(encoded.roots[0].id, decoded.roots[0].id);
    assert.strictEqual(encoded.roots[0].hostPath, '/extension-host/team space');
    assert.strictEqual(decoded.roots[0].hostPath, '/different-host-path');

    const literalPercentEscape = resolver.resolve({
        workspaceFile: null,
        workspaceName: 'Literal percent escape',
        remoteName: undefined,
        workspaceFolders: [folder('literal', uri(
            'file:///work/a%252Fb',
            { path: '/work/a%2Fb', fsPath: '/work/a%2Fb' }
        ))],
    });
    const pathSeparator = resolver.resolve({
        workspaceFile: null,
        workspaceName: 'Path separator',
        remoteName: undefined,
        workspaceFolders: [folder('separator', uri('file:///work/a/b'))],
    });
    assert.notStrictEqual(literalPercentEscape.navigationIdentity, pathSeparator.navigationIdentity);
    assert.notStrictEqual(literalPercentEscape.scopeIdentity, pathSeparator.scopeIdentity);
    assert.notStrictEqual(literalPercentEscape.roots[0].id, pathSeparator.roots[0].id);

    for (const [remoteName, environment] of [
        [undefined, 'local'],
        ['ssh-remote', 'ssh'],
        ['wsl', 'wsl'],
        ['dev-container', 'devContainer'],
        ['codespaces', 'remote'],
    ]) {
        const context = resolver.resolve({
            workspaceFile: null,
            workspaceName: environment,
            remoteName,
            workspaceFolders: [folder(environment, uri('file:///work/environment'))],
        });
        assert.strictEqual(context.environment, environment);
    }
}

function createMemoryMemento(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        get: key => values.get(key),
        update: async (key, value) => {
            if (value === undefined) {
                values.delete(key);
            } else {
                values.set(key, value);
            }
        },
        entries: () => Array.from(values.entries()),
    };
}

function makeSaveWorkspace(kind, overrides = {}) {
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

async function runSavedWorkspaceProjectAdapterChecks() {
    const now = 10_000;
    const pathByUri = {
        'file:///work/app': '/work/app',
        'file:///work/team.code-workspace': '/work/team.code-workspace',
    };

    async function saveImmediate(workspace) {
        const state = createMemoryMemento();
        const saved = [];
        const adapter = new SavedWorkspaceProjectAdapter({
            getCurrentWorkspace: () => workspace,
            pendingStore: new PendingWorkspaceSaveStore(state),
            getProjectDetailsForSave: async navigationUri => ({
                path: pathByUri[navigationUri],
                remoteType: models.ProjectRemoteType.None,
            }),
            saveWorkspaceProject: async details => saved.push({ ...details }),
            executeSaveWorkspaceAs: async () => assert.fail('saved workspaces must not invoke Save Workspace As'),
            nowMs: () => now,
        });
        await adapter.saveCurrentWorkspace();
        return saved;
    }

    assert.deepStrictEqual(await saveImmediate(makeSaveWorkspace('singleFolder')), [{
        path: '/work/app',
        remoteType: models.ProjectRemoteType.None,
    }], 'a single-folder live workspace must add exactly one folder project');
    assert.deepStrictEqual(await saveImmediate(makeSaveWorkspace('savedMultiRoot')), [{
        path: '/work/team.code-workspace',
        remoteType: models.ProjectRemoteType.None,
    }], 'a saved multi-root live workspace must add exactly one workspace-file project');

    for (const kind of ['singleFolder', 'savedMultiRoot']) {
        let releaseMutation;
        let mutationStarted;
        const mutationGate = new Promise(resolve => { releaseMutation = resolve; });
        const mutationStart = new Promise(resolve => { mutationStarted = resolve; });
        let mutations = 0;
        const workspace = makeSaveWorkspace(kind);
        const adapter = new SavedWorkspaceProjectAdapter({
            getCurrentWorkspace: () => workspace,
            pendingStore: new PendingWorkspaceSaveStore(createMemoryMemento()),
            getProjectDetailsForSave: async navigationUri => ({
                path: pathByUri[navigationUri],
                remoteType: models.ProjectRemoteType.None,
            }),
            saveWorkspaceProject: async () => {
                mutations += 1;
                mutationStarted();
                await mutationGate;
            },
            executeSaveWorkspaceAs: async () => assert.fail(`${kind} must not invoke Save Workspace As`),
            nowMs: () => now,
        });
        const first = adapter.saveCurrentWorkspace();
        await mutationStart;
        const second = adapter.saveCurrentWorkspace();
        assert.strictEqual(second, first, `${kind} concurrent callers must share the same transaction Promise`);
        releaseMutation();
        await Promise.all([first, second]);
        assert.strictEqual(mutations, 1, `${kind} concurrent save must mutate once`);
    }

    const untitled = makeSaveWorkspace('untitledMultiRoot');
    const pendingState = createMemoryMemento();
    const pendingStore = new PendingWorkspaceSaveStore(pendingState);
    const ordering = [];
    const pendingAdapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => untitled,
        pendingStore,
        getProjectDetailsForSave: async () => assert.fail('untitled cancellation must not resolve project details'),
        saveWorkspaceProject: async () => assert.fail('untitled cancellation must not add a project'),
        executeSaveWorkspaceAs: async () => {
            const intent = pendingStore.read();
            ordering.push('command');
            assert.deepStrictEqual(Object.keys(intent).sort(), [
                'createdAtMs', 'expiresAtMs', 'scopeIdentity', 'version',
            ]);
            assert.strictEqual(intent.version, 1);
            assert.strictEqual(intent.scopeIdentity, untitled.scopeIdentity);
            assert.strictEqual(intent.createdAtMs, now);
            assert.strictEqual(intent.expiresAtMs, now + PENDING_WORKSPACE_SAVE_TTL_MS);
            assert.deepStrictEqual(pendingState.entries(), [[
                PendingWorkspaceSaveStore.storageKey,
                intent,
            ]], 'only the bounded four-field intent may be persisted before the command');
        },
        nowMs: () => now,
    });
    ordering.push('before');
    await pendingAdapter.saveCurrentWorkspace();
    ordering.push('after');
    assert.deepStrictEqual(ordering, ['before', 'command', 'after']);
    assert.strictEqual(pendingStore.read(), null, 'Save Workspace As cancellation/non-transition must clear intent');

    const concurrentUntitledState = createMemoryMemento();
    let releaseSaveAs;
    let saveAsStarted;
    const saveAsGate = new Promise(resolve => { releaseSaveAs = resolve; });
    const saveAsStart = new Promise(resolve => { saveAsStarted = resolve; });
    let saveAsCalls = 0;
    const concurrentUntitledAdapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => untitled,
        pendingStore: new PendingWorkspaceSaveStore(concurrentUntitledState),
        getProjectDetailsForSave: async () => assert.fail('untitled non-transition must not resolve details'),
        saveWorkspaceProject: async () => assert.fail('untitled non-transition must not mutate'),
        executeSaveWorkspaceAs: async () => {
            saveAsCalls += 1;
            saveAsStarted();
            await saveAsGate;
        },
        nowMs: () => now,
    });
    const firstUntitledSave = concurrentUntitledAdapter.saveCurrentWorkspace();
    await saveAsStart;
    const secondUntitledSave = concurrentUntitledAdapter.saveCurrentWorkspace();
    assert.strictEqual(secondUntitledSave, firstUntitledSave,
        'untitled concurrent callers must share the same transaction Promise');
    releaseSaveAs();
    await Promise.all([firstUntitledSave, secondUntitledSave]);
    assert.strictEqual(saveAsCalls, 1, 'untitled concurrent save must invoke Save Workspace As once');
    assert.deepStrictEqual(concurrentUntitledState.entries(), []);

    const savedWorkspace = makeSaveWorkspace('savedMultiRoot', {
        scopeIdentity: untitled.scopeIdentity,
    });
    const restartState = createMemoryMemento();
    const restartStore = new PendingWorkspaceSaveStore(restartState);
    await restartStore.write(untitled.scopeIdentity, now, now + PENDING_WORKSPACE_SAVE_TTL_MS);
    const existingProjects = [
        { id: 'member-app', name: 'App', path: '/work/app', favorite: true },
        { id: 'member-lib', name: 'Lib', path: '/work/lib', description: 'Keep me' },
    ];
    const before = JSON.parse(JSON.stringify(existingProjects));
    const restartAdapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => savedWorkspace,
        pendingStore: restartStore,
        getProjectDetailsForSave: async navigationUri => ({
            path: pathByUri[navigationUri],
            remoteType: models.ProjectRemoteType.None,
        }),
        saveWorkspaceProject: async details => existingProjects.push({
            id: 'workspace-team',
            name: 'Team',
            path: details.path,
        }),
        executeSaveWorkspaceAs: async () => assert.fail('activation completion must not reopen Save Workspace As'),
        nowMs: () => now + 1,
    });
    await Promise.all([
        restartAdapter.completePendingWorkspaceSave(),
        restartAdapter.completePendingWorkspaceSave(),
    ]);
    await restartAdapter.completePendingWorkspaceSave();
    assert.deepStrictEqual(existingProjects.slice(0, before.length), before,
        'saving an encompassing workspace must not merge, rewrite, or delete member projects');
    assert.strictEqual(JSON.stringify(existingProjects.slice(0, before.length)), JSON.stringify(before),
        'pre-existing saved-project serialization must remain byte-for-byte equivalent');
    assert.deepStrictEqual(existingProjects.slice(before.length).map(project => project.path), [
        '/work/team.code-workspace',
    ], 'matching restart completion must add exactly one project and remain idempotent');
    assert.strictEqual(restartStore.read(), null);

    const crossEntryState = createMemoryMemento();
    const crossEntryStore = new PendingWorkspaceSaveStore(crossEntryState);
    await crossEntryStore.write(untitled.scopeIdentity, now, now + PENDING_WORKSPACE_SAVE_TTL_MS);
    let releaseCrossMutation;
    let crossMutationStarted;
    const crossMutationGate = new Promise(resolve => { releaseCrossMutation = resolve; });
    const crossMutationStart = new Promise(resolve => { crossMutationStarted = resolve; });
    let crossMutations = 0;
    const crossEntryAdapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => savedWorkspace,
        pendingStore: crossEntryStore,
        getProjectDetailsForSave: async () => ({
            path: '/work/team.code-workspace',
            remoteType: models.ProjectRemoteType.None,
        }),
        saveWorkspaceProject: async () => {
            crossMutations += 1;
            crossMutationStarted();
            await crossMutationGate;
        },
        executeSaveWorkspaceAs: async () => undefined,
        nowMs: () => now + 1,
    });
    const commandSave = crossEntryAdapter.saveCurrentWorkspace();
    await crossMutationStart;
    const activationCompletion = crossEntryAdapter.completePendingWorkspaceSave();
    assert.strictEqual(activationCompletion, commandSave,
        'command/Webview and activation completion must share one transaction');
    releaseCrossMutation();
    await Promise.all([commandSave, activationCompletion]);
    assert.strictEqual(crossMutations, 1);
    assert.strictEqual(crossEntryStore.read(), null,
        'a command racing activation must consume the matching intent within the shared write');

    async function assertRejectedPending(currentWorkspace, rawIntent, currentTime, label) {
        const state = createMemoryMemento({ [PendingWorkspaceSaveStore.storageKey]: rawIntent });
        const store = new PendingWorkspaceSaveStore(state);
        let mutations = 0;
        const adapter = new SavedWorkspaceProjectAdapter({
            getCurrentWorkspace: () => currentWorkspace,
            pendingStore: store,
            getProjectDetailsForSave: async () => {
                mutations += 1;
                return { path: '/unexpected', remoteType: models.ProjectRemoteType.None };
            },
            saveWorkspaceProject: async () => { mutations += 1; },
            executeSaveWorkspaceAs: async () => undefined,
            nowMs: () => currentTime,
        });
        await adapter.completePendingWorkspaceSave();
        assert.strictEqual(mutations, 0, `${label} must not create a project`);
        assert.strictEqual(store.read(), null, `${label} must clear pending state`);
        assert.deepStrictEqual(state.entries(), [], `${label} must remove malformed/stale storage`);
    }

    const validIntent = {
        version: 1,
        scopeIdentity: untitled.scopeIdentity,
        createdAtMs: now,
        expiresAtMs: now + PENDING_WORKSPACE_SAVE_TTL_MS,
    };
    await assertRejectedPending(savedWorkspace, validIntent, validIntent.expiresAtMs, 'intent at expiry boundary');
    await assertRejectedPending(savedWorkspace, { ...validIntent, version: 2 }, now + 1, 'malformed intent');
    await assertRejectedPending(savedWorkspace, { ...validIntent, unexpected: true }, now + 1, 'intent with extra data');
    await assertRejectedPending(savedWorkspace, { ...validIntent, createdAtMs: now + 2 }, now + 1, 'future intent');
    await assertRejectedPending(makeSaveWorkspace('savedMultiRoot', {
        scopeIdentity: 'c'.repeat(64),
    }), validIntent, now + 1, 'changed root scope');
    await assertRejectedPending(makeSaveWorkspace('singleFolder', {
        scopeIdentity: untitled.scopeIdentity,
    }), validIntent, now + 1, 'unrelated activation');
    await assertRejectedPending(null, validIntent, now + 1, 'activation without a workspace');

    const failureState = createMemoryMemento();
    const failureStore = new PendingWorkspaceSaveStore(failureState);
    await failureStore.write(untitled.scopeIdentity, now, now + PENDING_WORKSPACE_SAVE_TTL_MS);
    const mutationFailure = new Error('forced workspace project mutation failure');
    const failureAdapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => savedWorkspace,
        pendingStore: failureStore,
        getProjectDetailsForSave: async () => ({
            path: '/work/team.code-workspace',
            remoteType: models.ProjectRemoteType.None,
        }),
        saveWorkspaceProject: async () => { throw mutationFailure; },
        executeSaveWorkspaceAs: async () => undefined,
        nowMs: () => now + 1,
    });
    await assert.rejects(() => failureAdapter.completePendingWorkspaceSave(), error => error === mutationFailure);
    assert.strictEqual(failureStore.read(), null, 'mutation failure must leave no retryable duplicate intent');
    assert.deepStrictEqual(failureState.entries(), []);

    const clearFailure = new Error('forced pending clear failure');
    let allowClear = false;
    const retryStateValues = new Map();
    const retryState = {
        get: key => retryStateValues.get(key),
        update: async (key, value) => {
            if (value === undefined && !allowClear) {
                throw clearFailure;
            }
            if (value === undefined) {
                retryStateValues.delete(key);
            } else {
                retryStateValues.set(key, value);
            }
        },
    };
    const retryStore = new PendingWorkspaceSaveStore(retryState);
    await retryStore.write(untitled.scopeIdentity, now, now + PENDING_WORKSPACE_SAVE_TTL_MS);
    let retryMutations = 0;
    const retryAdapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => savedWorkspace,
        pendingStore: retryStore,
        getProjectDetailsForSave: async () => ({
            path: '/work/team.code-workspace',
            remoteType: models.ProjectRemoteType.None,
        }),
        saveWorkspaceProject: async () => { retryMutations += 1; },
        executeSaveWorkspaceAs: async () => undefined,
        nowMs: () => now + 1,
    });
    await assert.rejects(() => retryAdapter.completePendingWorkspaceSave(), error => error === clearFailure);
    assert.strictEqual(retryMutations, 0, 'clear failure must stop before project mutation');
    assert.deepStrictEqual(retryStore.read(), validIntent, 'clear failure must retain intent for retry');
    allowClear = true;
    await retryAdapter.completePendingWorkspaceSave();
    assert.strictEqual(retryMutations, 1, 'a later successful clear may retry exactly once');
    assert.strictEqual(retryStore.read(), null);

    const commandFailureState = createMemoryMemento();
    const commandFailureStore = new PendingWorkspaceSaveStore(commandFailureState);
    const commandFailure = new Error('forced Save Workspace As failure');
    const commandFailureAdapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => untitled,
        pendingStore: commandFailureStore,
        getProjectDetailsForSave: async () => assert.fail('command failure must not resolve details'),
        saveWorkspaceProject: async () => assert.fail('command failure must not mutate'),
        executeSaveWorkspaceAs: async () => { throw commandFailure; },
        nowMs: () => now,
    });
    await assert.rejects(() => commandFailureAdapter.saveCurrentWorkspace(), error => error === commandFailure);
    assert.strictEqual(commandFailureStore.read(), null, 'command failure must clear a successfully written intent');
    assert.deepStrictEqual(commandFailureState.entries(), []);

    const detailsFailureState = createMemoryMemento();
    const detailsFailureStore = new PendingWorkspaceSaveStore(detailsFailureState);
    await detailsFailureStore.write(untitled.scopeIdentity, now, now + PENDING_WORKSPACE_SAVE_TTL_MS);
    const detailsFailure = new Error('forced workspace details failure');
    let detailsFailureMutations = 0;
    const detailsFailureAdapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => savedWorkspace,
        pendingStore: detailsFailureStore,
        getProjectDetailsForSave: async () => { throw detailsFailure; },
        saveWorkspaceProject: async () => { detailsFailureMutations += 1; },
        executeSaveWorkspaceAs: async () => undefined,
        nowMs: () => now + 1,
    });
    await assert.rejects(() => detailsFailureAdapter.completePendingWorkspaceSave(), error => error === detailsFailure);
    assert.strictEqual(detailsFailureMutations, 0);
    assert.strictEqual(detailsFailureStore.read(), null,
        'details failure occurs after successful consumption and must not retry');

    let fallbackReads = 0;
    const nullWarnings = [];
    const nullWorkspaceMutationController = new ProjectMutationController({
        getCurrentWorkspacePath: () => null,
        getOpenProjectUri: () => null,
        getCurrentProjectDetailsForSave: async () => {
            fallbackReads += 1;
            return { path: '/wrong/fallback', remoteType: models.ProjectRemoteType.None };
        },
        getProjectDetailsForSave: async () => null,
        getProjectsFlat: () => [],
        getProjectAndGroup: () => [null, null],
        addProjectToGroup: async () => assert.fail('null workspace details must not create a project'),
        updateProject: async () => undefined,
        removeGroup: async () => undefined,
        getRandomColor: () => '#000000',
        isFolderGitRepo: () => false,
        prompt: {
            queryProjectFields: async () => assert.fail('null workspace details must not prompt project fields'),
            queryGroup: async () => assert.fail('null workspace details must not prompt for a group'),
            queryProjectDescription: async () => '',
            queryProjectColor: async () => '#000000',
        },
        showInputBox: async () => undefined,
        showWarningMessage: message => nullWarnings.push(message),
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        refreshAfterMutation: () => undefined,
    });
    await nullWorkspaceMutationController.saveWorkspaceProject(null);
    assert.strictEqual(fallbackReads, 0,
        'explicit workspace save with null details must not fallback to current project resolution');
    assert.deepStrictEqual(nullWarnings, ['No project is currently open.']);
}

async function runProjectServiceWorkspaceSaveMigrationIntegrationChecks() {
    function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function createSerializedMemento(initial = {}) {
        const values = new Map(Object.entries(clone(initial)));
        return {
            get: key => clone(values.get(key)),
            update: async (key, value) => {
                if (value === undefined) {
                    values.delete(key);
                } else {
                    values.set(key, clone(value));
                }
            },
        };
    }

    let primaryConfiguration;
    const legacyConfiguration = {
        get: (_key, defaultValue) => defaultValue,
        inspect: () => undefined,
        update: async () => undefined,
    };
    const vscodeStub = {
        ConfigurationTarget: { Global: 'global' },
        workspace: {
            getConfiguration: section => section === 'projectSteward'
                ? primaryConfiguration
                : legacyConfiguration,
        },
    };
    const projectServiceModulePath = require.resolve('../out/services/projectService');
    delete require.cache[projectServiceModulePath];
    const previousModuleLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') {
            return vscodeStub;
        }
        return previousModuleLoad.call(this, request, parent, isMain);
    };
    let ProjectService;
    try {
        ProjectService = require(projectServiceModulePath).default;
    } finally {
        Module._load = previousModuleLoad;
    }

    function createConfiguration(values, failProjectWrite = null) {
        return {
            values,
            get: (key, defaultValue) => Object.prototype.hasOwnProperty.call(values, key)
                ? values[key]
                : defaultValue,
            inspect: key => Object.prototype.hasOwnProperty.call(values, key)
                ? { globalValue: values[key] }
                : undefined,
            update: async (key, value) => {
                if (key === 'projectData' && failProjectWrite) {
                    throw failProjectWrite;
                }
                values[key] = clone(value);
            },
        };
    }

    function createStartup(service, adapter) {
        return new DashboardStartupController({
            stewardInfos: {
                relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
                config: { openOnStartup: 'never' },
            },
            isExtensionInstalled: () => false,
            migrateDataIfNeeded: async () => ({
                projects: await settleMigration(() => service.migrateDataIfNeeded()),
                todos: { migrated: false },
            }),
            afterProjectMigrationSucceeded: () => adapter.completePendingWorkspaceSave(),
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

    const fixturePath = path.join(__dirname, 'fixtures', 'workspace-first-saved-projects.json');
    const fixtureGroups = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.ok(fixtureGroups.every(group => Array.isArray(group.projects)),
        'the checked-in preservation fixture must use the real serialized Group[] store shape');
    const fixtureBytes = JSON.stringify(fixtureGroups);
    const fixtureState = createSerializedMemento({ projects: fixtureGroups });
    const fixtureConfigurationValues = { storeProjectsInSettings: true };
    primaryConfiguration = createConfiguration(fixtureConfigurationValues);
    const fixtureService = new ProjectService(
        { globalState: fixtureState },
        { addRecentColor: async () => undefined },
    );
    const fixturePendingStore = new PendingWorkspaceSaveStore(fixtureState);
    const fixtureWorkspace = makeSaveWorkspace('savedMultiRoot');
    const fixtureMutationController = new ProjectMutationController({
        getCurrentWorkspacePath: () => null,
        getOpenProjectUri: () => null,
        getCurrentProjectDetailsForSave: async () => null,
        getProjectDetailsForSave: async () => null,
        getProjectsFlat: () => fixtureService.getProjectsFlat(),
        getProjectAndGroup: projectId => fixtureService.getProjectAndGroup(projectId),
        addProjectToGroup: (project, groupId) => fixtureService.addProject(project, groupId),
        updateProject: (projectId, project) => fixtureService.updateProject(projectId, project),
        removeGroup: (groupId, skipConfirmation) => fixtureService.removeGroup(groupId, skipConfirmation),
        getRandomColor: () => '#445566',
        isFolderGitRepo: () => false,
        prompt: {
            queryProjectFields: async () => assert.fail('workspace save must not use add/edit project fields'),
            queryGroup: async () => ['existing-group', false],
            queryProjectDescription: async () => 'Encompassing workspace',
            queryProjectColor: async () => '#445566',
        },
        showInputBox: async () => 'Team Workspace',
        showWarningMessage: message => assert.fail(`unexpected fixture warning: ${message}`),
        showInformationMessage: message => assert.fail(`unexpected fixture information: ${message}`),
        showErrorMessage: message => assert.fail(`unexpected fixture error: ${message}`),
        refreshAfterMutation: () => undefined,
    });
    const fixtureAdapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => fixtureWorkspace,
        pendingStore: fixturePendingStore,
        getProjectDetailsForSave: async () => ({
            path: '/work/team.code-workspace',
            remoteType: models.ProjectRemoteType.None,
        }),
        saveWorkspaceProject: details => fixtureMutationController.saveWorkspaceProject(details),
        executeSaveWorkspaceAs: async () => undefined,
        nowMs: () => 40_001,
    });

    await createStartup(fixtureService, fixtureAdapter).startUp();
    assert.strictEqual(JSON.stringify(fixtureConfigurationValues.projectData), fixtureBytes,
        'production startup migration must preserve the fixture serialized JSON exactly');
    assert.strictEqual(JSON.stringify(fixtureState.get('projects')), fixtureBytes,
        'production startup migration must leave the source fixture bytes unchanged');
    fixtureService.getGroups(true);
    fixtureService.getProjectsFlat();
    fixtureService.getProjectAndGroup('member-app');
    assert.strictEqual(JSON.stringify(fixtureConfigurationValues.projectData), fixtureBytes,
        'ordinary production ProjectService reads must not rewrite persisted fixture bytes');

    await fixturePendingStore.write(
        fixtureWorkspace.scopeIdentity,
        40_000,
        40_000 + PENDING_WORKSPACE_SAVE_TTL_MS,
    );
    await createStartup(fixtureService, fixtureAdapter).startUp();
    const fixtureAfterSave = fixtureConfigurationValues.projectData;
    const preservedFixturePrefix = fixtureAfterSave.map((group, groupIndex) => ({
        ...group,
        projects: group.projects.slice(0, fixtureGroups[groupIndex].projects.length),
    }));
    assert.strictEqual(JSON.stringify(preservedFixturePrefix), fixtureBytes,
        'production workspace save must preserve every original group/member field and serialized order');
    assert.strictEqual(
        fixtureAfterSave.reduce((count, group) => count + group.projects.length, 0),
        fixtureGroups.reduce((count, group) => count + group.projects.length, 0) + 1,
        'production workspace save must append exactly one record',
    );
    assert.deepStrictEqual(
        fixtureAfterSave[0].projects.slice(fixtureGroups[0].projects.length).map(project => project.path),
        ['/work/team.code-workspace'],
    );
    assert.strictEqual(fixturePendingStore.read(), null);

    const oldGroup = () => ({
        id: 'existing-group',
        groupName: 'Existing',
        collapsed: false,
        projects: [{
            id: 'member-app',
            name: 'App',
            description: 'keep',
            path: '/work/app',
            color: '#112233',
            favorite: true,
            isGitRepo: true,
            remoteType: models.ProjectRemoteType.None,
        }],
    });

    for (const target of ['settings', 'globalState']) {
        const existing = [oldGroup()];
        const globalState = createSerializedMemento(target === 'settings' ? { projects: existing } : {});
        const configurationValues = target === 'settings'
            ? { storeProjectsInSettings: true }
            : { storeProjectsInSettings: false, projectData: existing };
        primaryConfiguration = createConfiguration(configurationValues);
        const service = new ProjectService({ globalState }, { addRecentColor: async () => undefined });
        const pendingStore = new PendingWorkspaceSaveStore(globalState);
        const workspace = makeSaveWorkspace('savedMultiRoot');
        await pendingStore.write(workspace.scopeIdentity, 20_000, 20_000 + PENDING_WORKSPACE_SAVE_TTL_MS);
        const adapter = new SavedWorkspaceProjectAdapter({
            getCurrentWorkspace: () => workspace,
            pendingStore,
            getProjectDetailsForSave: async () => ({
                path: '/work/team.code-workspace',
                remoteType: models.ProjectRemoteType.None,
            }),
            saveWorkspaceProject: async details => {
                const project = new models.Project('Team', details.path);
                project.color = '#445566';
                project.remoteType = details.remoteType;
                await service.addProject(project, 'existing-group');
            },
            executeSaveWorkspaceAs: async () => undefined,
            nowMs: () => 20_001,
        });
        const startup = new DashboardStartupController({
            stewardInfos: {
                relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
                config: { openOnStartup: 'never' },
            },
            isExtensionInstalled: () => false,
            migrateDataIfNeeded: async () => ({
                projects: await settleMigration(() => service.migrateDataIfNeeded()),
                todos: { migrated: false },
            }),
            afterProjectMigrationSucceeded: () => adapter.completePendingWorkspaceSave(),
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
        const before = JSON.stringify(existing);
        await startup.startUp();
        const storedGroups = target === 'settings'
            ? configurationValues.projectData
            : globalState.get('projects');
        assert.strictEqual(JSON.stringify(storedGroups[0].projects.slice(0, 1)),
            JSON.stringify(existing[0].projects.slice(0, 1)),
            `${target} migration must preserve the old member project`);
        assert.strictEqual(storedGroups[0].projects.length, 2,
            `${target} migration must append one workspace project`);
        assert.strictEqual(storedGroups[0].projects[1].path, '/work/team.code-workspace');
        assert.strictEqual(pendingStore.read(), null);
        assert.strictEqual(JSON.stringify(existing), before,
            `${target} source data must remain unchanged by copy migration`);
    }

    const migrationFailure = new Error('forced real ProjectService migration failure');
    const failureExisting = [oldGroup()];
    const failureState = createSerializedMemento({ projects: failureExisting });
    primaryConfiguration = createConfiguration({ storeProjectsInSettings: true }, migrationFailure);
    const failureService = new ProjectService({ globalState: failureState }, { addRecentColor: async () => undefined });
    const failurePendingStore = new PendingWorkspaceSaveStore(failureState);
    const failureWorkspace = makeSaveWorkspace('savedMultiRoot');
    await failurePendingStore.write(
        failureWorkspace.scopeIdentity,
        30_000,
        30_000 + PENDING_WORKSPACE_SAVE_TTL_MS
    );
    let failureMutations = 0;
    let startupContinued = 0;
    const failureAdapter = new SavedWorkspaceProjectAdapter({
        getCurrentWorkspace: () => failureWorkspace,
        pendingStore: failurePendingStore,
        getProjectDetailsForSave: async () => ({
            path: '/work/team.code-workspace',
            remoteType: models.ProjectRemoteType.None,
        }),
        saveWorkspaceProject: async () => { failureMutations += 1; },
        executeSaveWorkspaceAs: async () => undefined,
        nowMs: () => 30_001,
    });
    const failureStartup = new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded: async () => ({
            projects: await settleMigration(() => failureService.migrateDataIfNeeded()),
            todos: { migrated: false },
        }),
        afterProjectMigrationSucceeded: () => failureAdapter.completePendingWorkspaceSave(),
        refreshDashboard: () => undefined,
        publishOpenWorkspace: () => undefined,
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        logError: () => undefined,
        showSteward: () => undefined,
        applyProjectColorToCurrentWindow: () => { startupContinued += 1; },
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'workspace',
        getVisibleEditorLanguageIds: () => [],
    });
    await failureStartup.startUp();
    assert.strictEqual(failureMutations, 0, 'migration failure must not run pending project mutation');
    assert.ok(failurePendingStore.read(), 'migration failure must retain pending intent for activation retry');
    assert.strictEqual(startupContinued, 1, 'migration failure must not abort unrelated remaining startup behavior');
    assert.strictEqual(failureState.get('projects').length, 1);
}

function runDashboardBridgeLifecycleChecks() {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    const refreshAfterMutation = extractFunctionBody(dashboard, 'refreshAfterMutation');
    const showSteward = extractFunctionBody(dashboard, 'showSteward');
    const projectedOpenWorkspaces = extractFunctionBody(dashboard, 'getOpenWorkspaceCards');
    const selectedProjectHandler = dashboard.slice(
        dashboard.indexOf("'selected-project': async e =>"),
        dashboard.indexOf("'add-project': async e =>")
    );

    const workspaceControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'openWorkspaces', 'workspaceController.ts'), 'utf8');
    const projectMutationControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'projects', 'projectMutationController.ts'), 'utf8');
    assert.ok(workspaceControllerSource.includes('export class OpenWorkspaceController'));
    assert.ok(workspaceControllerSource.includes('getCurrentWorkspace('));
    assert.ok(workspaceControllerSource.includes('getPublication('));
    assert.ok(workspaceControllerSource.includes('publish('));
    assert.ok(workspaceControllerSource.includes('createOpenWorkspacePublication('));
    assert.ok(!dashboard.includes('function getRawOpenProjects('));
    assert.ok(!dashboard.includes('function publishOpenWorkspace('));
    assert.ok(!dashboard.includes('function getOpenProjectUri('));
    assert.ok(!dashboard.includes('function getOpenProjects('));
    assert.ok(!dashboard.includes('getOpenProjectsFromWorkspace('));
    assert.ok(!dashboard.includes('AiSessionProjectHydrationController'));
    assert.ok(dashboard.includes("import OpenWorkspaceBridgeClient from './openWorkspaces/bridgeClient';"));
    assert.ok(dashboard.includes("import { OpenWorkspaceDashboardController } from './openWorkspaces/dashboardController';"));
    assert.ok(dashboard.includes("import { WorkspaceNavigationController } from './openWorkspaces/navigationController';"));
    assert.ok(dashboard.includes("import { OpenWorkspaceController } from './openWorkspaces/workspaceController';"));
    assert.strictEqual(dashboard.includes("from './openProjects/bridgeClient'"), false);
    assert.strictEqual(dashboard.includes("from './openProjects/dashboardController'"), false);
    assert.strictEqual(dashboard.includes("from './openProjects/workspaceController'"), false);
    assert.ok(dashboard.includes("import { CurrentProjectDetailsResolver } from './projects/currentProjectDetails';"));
    assert.ok(dashboard.includes("import { ProjectManualEditController } from './projects/projectManualEditController';"));
    assert.ok(dashboard.includes("import { ProjectOpenController } from './projects/projectOpenController';"));
    assert.ok(dashboard.includes("import { ProjectMutationController } from './projects/projectMutationController';"));
    assert.ok(dashboard.includes("import { ProjectPromptController } from './projects/projectPromptController';"));
    assert.ok(!dashboard.includes('async function addProject('));
    assert.ok(!dashboard.includes('async function saveOpenProject('));
    assert.ok(!dashboard.includes('async function saveProject('));
    assert.ok(!dashboard.includes('async function editProject('));
    assert.ok(!dashboard.includes('async function editProjectColor('));
    assert.ok(!dashboard.includes('async function editProjectsManuallyPerCommand('));
    assert.ok(!dashboard.includes('async function removeProjectPerCommand('));
    assert.ok(!dashboard.includes('async function removeGroupPerCommand('));
    assert.ok(!dashboard.includes('function getGroupsTempFilePath('));
    assert.ok(!dashboard.includes('async function getCurrentProjectDetailsForSave('));
    assert.ok(!dashboard.includes('async function getProjectDetailsForSave('));
    assert.ok(!dashboard.includes('async function openProject('));
    assert.ok(!dashboard.includes('async function openFolderUri('));
    assert.ok(!dashboard.includes('function projectPathMatchesCurrentWorkspace('));
    assert.ok(!dashboard.includes('async function addToWorkspace('));
    assert.ok(!dashboard.includes('async function queryProjectFields('));
    assert.ok(!dashboard.includes('async function queryProjectDescription('));
    assert.ok(!dashboard.includes('async function queryGroup('));
    assert.ok(!dashboard.includes('async function queryProjectPath('));
    assert.ok(!dashboard.includes('async function queryProjectColor('));
    assert.ok(!dashboard.includes("import { createOpenProjectRecords } from './openProjects/projection';"));
    assert.ok(dashboard.includes('const projectManualEditController = new ProjectManualEditController({'));
    assert.ok(dashboard.includes('const projectMutationController = new ProjectMutationController({'));
    assert.ok(dashboard.includes('const projectPromptController = new ProjectPromptController({'));
    assert.ok(dashboard.includes('new DashboardCommandRegistration<vscode.Disposable>({'));
    assert.ok(dashboard.includes('const openWorkspaceDashboardController = new OpenWorkspaceDashboardController({'));
    assert.ok(dashboard.includes('openWorkspaceController = new OpenWorkspaceController({'));
    assert.ok(dashboard.includes('new OpenWorkspaceBridgeClient('));
    assert.ok(dashboard.includes("reportDiagnostic: event => logOpenWorkspaceDiagnostic('Workspace', event)"));
    assert.ok(dashboard.includes("reportBridgeDiagnostic: event => logOpenWorkspaceDiagnostic('Bridge', event)"));
    assert.ok(dashboard.includes('error => logOpenWorkspaceBridgeError(error)'),
        'the OpenWorkspaceBridgeClient error callback must use the privacy-bounded diagnostics entry');
    const openWorkspaceBridgeWiring = dashboard.slice(
        dashboard.indexOf('openWorkspaceBridgeClient = new OpenWorkspaceBridgeClient('),
        dashboard.indexOf('const activeAiSessionTerminalHighlighter')
    );
    assert.strictEqual(openWorkspaceBridgeWiring.includes("logError('Open workspace bridge unavailable"), false,
        'open-workspace bridge errors must never reach generic raw error logging');
    const diagnosticsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'diagnostics.ts'), 'utf8');
    assert.ok(diagnosticsSource.includes("'open-workspace-diagnostics.jsonl'"));
    assert.ok(dashboard.includes('new DashboardDiagnostics({'));
    assert.ok(!dashboard.includes('function logOpenWorkspaceDiagnostic('));
    assert.ok(dashboard.includes('openWorkspaceController.publish('));
    assert.ok(dashboard.includes('context.subscriptions.push(openWorkspaceBridgeClient);'));
    assert.ok(!dashboard.includes('get openProjects()'));
    assert.ok(projectedOpenWorkspaces.includes('openWorkspaceDashboardController.getCards()'));
    assert.ok(selectedProjectHandler.includes("projectId.startsWith('__openWorkspaceNavigation-')"));
    assert.ok(selectedProjectHandler.includes('await workspaceNavigationController.open(projectId);'));
    assert.strictEqual(selectedProjectHandler.includes('getNavigationWorkspace(projectId)'), false);
    assert.strictEqual(selectedProjectHandler.includes('openProjectDashboardController'), false);
    assert.ok(selectedProjectHandler.includes('projectService.getProject(projectId)'));
    assert.ok(!selectedProjectHandler.includes('getOpenProjects()'));
    assert.ok(selectedProjectHandler.includes('await projectOpenController.openProject(project, projectOpenType);'));
    assert.ok(dashboard.includes('await projectMutationController.addProject('));
    assert.ok(dashboard.includes('saveCurrentWorkspace: () => savedWorkspaceProjectAdapter.saveCurrentWorkspace()'));
    assert.strictEqual(dashboard.includes('saveUntitledWorkspace:'), false,
        'workspace card saves must reuse the complete SavedWorkspaceProjectAdapter flow');
    assert.strictEqual(dashboard.includes("'save-project': async"), false,
        'legacy save-project messages must use the reserved snapshot-based workspace route');
    assert.ok(dashboard.includes('saveProject: () => savedWorkspaceProjectAdapter.saveCurrentWorkspace()'));
    assert.ok(dashboard.includes('await savedWorkspaceProjectAdapter.completePendingWorkspaceSave();'));
    const startupWiring = dashboard.slice(
        dashboard.indexOf('const dashboardStartupController = new DashboardStartupController({'),
        dashboard.indexOf('const dashboardLifecycleController = new DashboardLifecycleController({')
    );
    assert.ok(startupWiring.includes('afterProjectMigrationSucceeded: async () => {'));
    assert.ok(startupWiring.indexOf('migrateDataIfNeeded: async () => {')
        < startupWiring.indexOf('afterProjectMigrationSucceeded: async () => {'));
    assert.strictEqual((dashboard.match(/dashboardStartupController\.startUp\(\)/g) || []).length, 1,
        'activation must start one migration/pending-completion sequence');
    assert.ok(dashboard.includes('await dashboardStartupController.startUp();'),
        'activation must await the one ordered migration/pending-completion startup transaction');
    assert.strictEqual(dashboard.includes('void dashboardStartupController.startUp();'), false);
    const saveAdapterWiring = dashboard.slice(
        dashboard.indexOf('const savedWorkspaceProjectAdapter = new SavedWorkspaceProjectAdapter({'),
        dashboard.indexOf('const workspaceSessionHydrationController = new WorkspaceSessionHydrationController')
    );
    assert.ok(saveAdapterWiring.includes('getCurrentWorkspace: resolveCurrentOpenWorkspace'),
        'Save Workspace As must read a fresh resolved snapshot instead of a cached transient card/controller state');
    assert.ok(dashboard.includes('await projectMutationController.editProject('));
    assert.ok(dashboard.includes('await projectMutationController.editProjectColor('));
    assert.ok(dashboard.includes('editProjects: () => projectManualEditController.editProjectsManually()'));
    assert.ok(dashboard.includes('removeProject: () => projectRemovalController.removeProjectPerCommand()'));
    assert.ok(dashboard.includes('removeGroup: () => groupCommandController.removeGroupPerCommand()'));
    assert.ok(projectMutationControllerSource.includes('this.options.prompt.queryProjectFields('));
    assert.ok(projectMutationControllerSource.includes('this.options.prompt.queryGroup('));
    assert.ok(projectMutationControllerSource.includes('this.options.prompt.queryProjectDescription('));
    assert.ok(projectMutationControllerSource.includes('this.options.prompt.queryProjectColor('));
    assert.ok(projectMutationControllerSource.includes('async saveWorkspaceProject('));
    assert.ok(projectMutationControllerSource.includes('if (!projectDetails || !projectDetails.path)'));
    assert.ok(projectMutationControllerSource.includes("this.options.showWarningMessage('No project is currently open.');"));
    assert.ok(projectMutationControllerSource.includes('await this.saveProject(null, false, projectDetails);'));
    assert.ok(!selectedProjectHandler.includes('e.uri'));
    assert.ok(!selectedProjectHandler.includes('projectUri'));
    assert.ok(dashboard.includes('vscode.window.onDidChangeWindowState(windowState =>'));
    assert.ok(dashboard.includes('dashboardLifecycleController.handleWindowStateChanged(windowState);'));
    const dashboardLifecycleControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'lifecycleController.ts'), 'utf8');
    assert.ok(dashboardLifecycleControllerSource.includes('if (windowState.focused)'));
    assert.ok(dashboardLifecycleControllerSource.includes('this.options.publishOpenWorkspace(true);'));
    assert.ok(
        refreshAfterMutation.includes('dashboardRuntimeController.refreshAfterMutation();'),
        'saved project metadata mutations must republish even when configuration storage is disabled'
    );
    assert.ok(
        showSteward.includes('dashboardRuntimeController.showSteward();'),
        'legacy metadata mutation paths that reveal the steward must also republish'
    );
    const dashboardRuntimeControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'runtimeController.ts'), 'utf8');
    assert.ok(dashboardRuntimeControllerSource.includes('refreshAfterMutation('));
    assert.ok(dashboardRuntimeControllerSource.includes('this.options.publishOpenWorkspace();'));
}

function runOpenWorkspaceProductionCutoverChecks() {
    const root = path.join(__dirname, '..');
    const productionFiles = [
        'src/dashboard.ts',
        'src/openWorkspaces/bridgeClient.ts',
        'src/openWorkspaces/workspaceController.ts',
        'src/openWorkspaces/dashboardController.ts',
        'src/webview/dashboardViewModel.ts',
        'src/dashboard/webviewUpdateMessages.ts',
        'src/aiSessions/dashboardController.ts',
        'extensions/attention-ui-bridge/src/extension.ts',
        'extensions/attention-ui-bridge/src/openWorkspacePublication.ts',
        'extensions/attention-ui-bridge/src/openWorkspaceStore.ts',
        'extensions/attention-ui-bridge/src/openWorkspaceCoordinator.ts',
        'extensions/attention-ui-bridge/tsconfig.json',
    ];
    const sources = productionFiles.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]);
    for (const [file, source] of sources) {
        for (const forbidden of [
            '_projectStewardOpenProjects',
            "from './openProjects/bridgeClient'",
            "from './openProjects/dashboardController'",
            "from './openProjects/workspaceController'",
            "from '../openProjects/",
            "from '../../../src/openProjects/protocol'",
            "'open-projects', 'v1'",
            '"../../src/openProjects/protocol.ts"',
        ]) {
            assert.strictEqual(source.includes(forbidden), false, `${file} still loads or calls v1: ${forbidden}`);
        }
    }
    const bridgeExtension = sources.find(([file]) => file.endsWith('src/extension.ts'))[1];
    const dashboard = sources.find(([file]) => file === 'src/dashboard.ts')[1];
    assert.ok(bridgeExtension.includes("'_projectStewardOpenWorkspaces.bridge.handshake'"));
    assert.ok(bridgeExtension.includes("'_projectStewardOpenWorkspaces.bridge.publish'"));
    assert.ok(bridgeExtension.includes("'_projectStewardOpenWorkspaces.bridge.unregister'"));
    assert.ok(dashboard.includes("from './openWorkspaces/bridgeClient'"));
}

async function runCurrentProjectDetailsResolverChecks() {
    const workspaceUri = {
        scheme: 'file',
        fsPath: '/work/current',
        path: '/work/current',
        toString: () => 'file:///work/current',
    };
    const calls = [];
    const resolver = new CurrentProjectDetailsResolver({
        getWorkspaceFile: () => null,
        getWorkspaceFolders: () => [{ uri: workspaceUri, name: 'current' }],
        getRemoteName: () => 'dev-container',
        getProjectDetailsForSave: async (uri, remoteName) => {
            calls.push([uri, remoteName]);
            return { path: uri.fsPath, remoteType: 3 };
        },
    });

    assert.deepStrictEqual(await resolver.getCurrentProjectDetailsForSave(), { path: '/work/current', remoteType: 3 });
    assert.deepStrictEqual(calls, [[workspaceUri, 'dev-container']]);

    const emptyResolver = new CurrentProjectDetailsResolver({
        getWorkspaceFile: () => null,
        getWorkspaceFolders: () => [],
        getRemoteName: () => undefined,
        getProjectDetailsForSave: async () => {
            throw new Error('must not resolve without a workspace');
        },
    });
    assert.strictEqual(await emptyResolver.getCurrentProjectDetailsForSave(), null);
}

async function runProjectOpenControllerChecks() {
    const commands = [];
    const warnings = [];
    const errors = [];
    const workspaceUpdates = [];
    const stateUpdates = [];
    const folderUri = {
        scheme: 'file',
        fsPath: '/work/target',
        path: '/work/target',
        toString: () => 'file:///work/target',
    };
    const currentUri = {
        scheme: 'file',
        fsPath: '/work/current',
        path: '/work/current',
        toString: () => 'file:///work/current',
    };
    const fileUris = new Map([
        ['/work/target', folderUri],
        ['/work/current', currentUri],
    ]);
    const fileUri = value => {
        if (!fileUris.has(value)) {
            fileUris.set(value, {
                scheme: 'file',
                fsPath: value,
                path: value,
                toString: () => `file://${value}`,
            });
        }
        return fileUris.get(value);
    };
    const parseUri = value => ({
        scheme: value.split(':')[0],
        authority: value.startsWith('vscode-remote://') ? value.replace('vscode-remote://', '').split('/')[0] : '',
        fsPath: value,
        path: value.replace(/^vscode-remote:\/\/[^/]+/, '') || '/',
        toString: () => value,
    });
    const controller = new ProjectOpenController({
        getWorkspaceFile: () => null,
        getWorkspaceFolders: () => [{ uri: currentUri, name: 'current' }],
        getPrependVscodeUrlToWslRemotes: () => true,
        getProjectPathType: async projectPath => projectPath.endsWith('.code-workspace') ? models.ProjectPathType.WorkspaceFile : models.ProjectPathType.Folder,
        getFoldersFromWorkspaceFile: async () => ['/work/one', '/work/two'],
        showWarningMessage: message => warnings.push(message),
        showInformationMessage: message => warnings.push(message),
        showErrorMessage: message => errors.push(message),
        executeCommand: async (command, ...args) => commands.push([command, ...args]),
        updateWorkspaceFolders: (start, deleteCount, ...folders) => {
            workspaceUpdates.push([start, deleteCount, folders]);
            return true;
        },
        updateReopenReason: reason => stateUpdates.push(reason),
        fileUri,
        parseUri,
    });

    await controller.openProject({ name: 'Current', path: '/work/current' }, models.ProjectOpenType.Default);
    assert.deepStrictEqual(commands, []);

    await controller.openProject({ name: 'Target', path: '/work/target' }, models.ProjectOpenType.Default);
    assert.deepStrictEqual(commands.pop(), ['vscode.openFolder', folderUri, { forceNewWindow: true }]);

    await controller.openProject({ name: 'Relative', path: 'relative' }, models.ProjectOpenType.Default);
    assert.deepStrictEqual(commands.pop(), ['vscode.openFolder', fileUri('/work/current/relative'), { forceNewWindow: true }]);

    await controller.openProject({ name: 'Folder', path: '/work/folder' }, models.ProjectOpenType.AddToWorkspace);
    assert.strictEqual(workspaceUpdates.length, 1);
    assert.strictEqual(workspaceUpdates[0][2][0].name, 'Folder');

    await controller.openProject({ name: 'SSH', path: 'vscode-remote://ssh-remote+host', remoteType: models.ProjectRemoteType.SSH }, models.ProjectOpenType.NewWindow);
    assert.deepStrictEqual(commands.pop(), ['vscode.newWindow', { remoteAuthority: 'ssh-remote+host', reuseWindow: false }]);

    const noWorkspaceController = new ProjectOpenController({
        getWorkspaceFile: () => null,
        getWorkspaceFolders: () => [],
        getPrependVscodeUrlToWslRemotes: () => true,
        getProjectPathType: async () => models.ProjectPathType.Folder,
        getFoldersFromWorkspaceFile: async () => [],
        showWarningMessage: message => warnings.push(message),
        showInformationMessage: message => warnings.push(message),
        showErrorMessage: message => errors.push(message),
        executeCommand: async () => undefined,
        updateWorkspaceFolders: () => false,
        updateReopenReason: reason => stateUpdates.push(reason),
        fileUri,
        parseUri,
    });
    await noWorkspaceController.openProject({ name: 'Relative', path: 'relative' }, models.ProjectOpenType.Default);
    assert.ok(warnings.includes('Tried to open a project with a relative path, but no workspace is open.'));
}

function runWebviewRefreshFocusChecks() {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'webview', 'webviewFilterScripts.js'),
        'utf8'
    );
    const initFiltering = new Function(
        'document',
        'window',
        'sessionStorage',
        'requestAnimationFrame',
        `return function initFiltering(activeByDefault, dashboard) {${extractFunctionBody(source, 'initFiltering')}};`
    );
    let focusCalls = 0;
    let blurCalls = 0;
    let selectCalls = 0;
    const classList = {
        add: () => undefined,
        remove: () => undefined,
        contains: () => false,
        toggle: () => undefined,
    };
    const filterWrapper = { classList };
    const filterInput = {
        value: '',
        parentElement: filterWrapper,
        focus: () => { focusCalls += 1; },
        blur: () => { blurCalls += 1; },
        select: () => { selectCalls += 1; },
        addEventListener: () => undefined,
    };
    const clearSearchElement = { addEventListener: () => undefined };
    const document = {
        body: { classList },
        getElementById: id => id === 'filter' ? filterInput : clearSearchElement,
        querySelectorAll: () => [],
    };
    const sessionStorage = {
        getItem: () => '',
        setItem: () => undefined,
    };
    const window = {
        addEventListener: () => undefined,
    };
    const dashboard = {
        isSearchActive: () => false,
        setSearchQuery: () => undefined,
    };

    initFiltering(
        document,
        window,
        sessionStorage,
        callback => callback()
    )(true, dashboard);

    assert.strictEqual(focusCalls, 1, 'active-by-default search must focus after initialization');
    assert.strictEqual(selectCalls, 1, 'active-by-default search must select the current query');
    assert.strictEqual(blurCalls, 0, 'reloading a visible Webview must not alter editor focus');
}

async function runDashboardMigrationPublicationChecks() {
    const publications = [];
    const refreshes = [];
    const informationMessages = [];
    let currentMetadata = 'before-migration';
    let migrated = true;
    let showStewardCalls = 0;
    const controller = new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded: async () => {
            if (migrated) {
                currentMetadata = 'after-migration';
            }
            return {
                projects: { migrated },
                todos: { migrated: false },
            };
        },
        refreshDashboard: () => refreshes.push(currentMetadata),
        publishOpenWorkspace: () => publications.push(currentMetadata),
        showInformationMessage: message => informationMessages.push(message),
        showSteward: () => { showStewardCalls += 1; },
        applyProjectColorToCurrentWindow: () => undefined,
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'workspace',
        getVisibleEditorLanguageIds: () => [],
    });

    await controller.checkDataMigration();
    assert.deepStrictEqual(refreshes, ['after-migration']);
    assert.deepStrictEqual(publications, ['after-migration']);
    assert.strictEqual(showStewardCalls, 0, 'default startup migration must not require revealing the steward');
    assert.strictEqual(informationMessages.length, 1);

    migrated = false;
    currentMetadata = 'unchanged-without-migration';
    await controller.checkDataMigration();
    assert.deepStrictEqual(refreshes, ['after-migration'], 'no migration must not trigger a redundant refresh');
    assert.deepStrictEqual(publications, ['after-migration'], 'no migration must not trigger a redundant publish');

    migrated = true;
    currentMetadata = 'before-explicit-migration';
    await controller.checkDataMigration(true);
    assert.deepStrictEqual(refreshes, ['after-migration', 'after-migration']);
    assert.deepStrictEqual(publications, ['after-migration', 'after-migration']);
    assert.strictEqual(showStewardCalls, 1);
}

async function runCoordinatorWiringChecks() {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-steward-open-project-wiring-'));
    const registeredCommands = new Map();
    const executedCommands = [];
    const bridgeOutputLines = [];
    let aggregateDeliveryError = null;
    const vscode = {
        window: {
            createOutputChannel: name => {
                assert.strictEqual(name, 'Project Steward UI Bridge');
                return {
                    appendLine: line => bridgeOutputLines.push(line),
                    dispose: () => undefined,
                };
            },
        },
        workspace: {
            workspaceFolders: [{
                uri: {
                    toString: () => 'vscode-remote://dev-container%2Btarget%40ssh-remote%2Bhome-book/workspaces/AiToEarn',
                },
            }],
        },
        commands: {
            registerCommand: (command, callback) => {
                registeredCommands.set(command, callback);
                return { dispose: () => registeredCommands.delete(command) };
            },
            executeCommand: async (command, argument) => {
                executedCommands.push({ command, argument });
                if (command === '_projectStewardOpenWorkspaces.workspace.aggregate'
                    && aggregateDeliveryError) {
                    throw aggregateDeliveryError;
                }
                return undefined;
            },
        },
    };
    const previousModuleLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') {
            return vscode;
        }
        return previousModuleLoad.call(this, request, parent, isMain);
    };

    const context = {
        globalStoragePath: tempRoot,
        globalStorageUri: { scheme: 'file' },
        subscriptions: [],
    };
    try {
        const extension = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/extension');
        await extension.activate(context);
        const handshake = registeredCommands.get('_projectStewardOpenWorkspaces.bridge.handshake');
        const publish = registeredCommands.get('_projectStewardOpenWorkspaces.bridge.publish');
        const unregister = registeredCommands.get('_projectStewardOpenWorkspaces.bridge.unregister');
        assert.strictEqual(typeof handshake, 'function');
        assert.strictEqual(typeof publish, 'function');
        assert.strictEqual(typeof unregister, 'function');
        assert.strictEqual(registeredCommands.has('_projectStewardOpenProjects.bridge.publish'), false);
        assert.deepStrictEqual(await handshake({
            protocolVersion: 1,
            mainExtensionVersion: '1.0.0',
            instanceId: SELF,
            capabilities: { workspaces: true, atomicReplace: true, focusLeases: true },
        }), {
            accepted: false,
            protocolVersion: 2,
            bridgeExtensionVersion: 'unknown',
            capabilities: { workspaces: true, atomicReplace: true, focusLeases: true },
            errorCode: 'update-required',
        });
        assert.strictEqual((await handshake({
            protocolVersion: 2,
            mainExtensionVersion: '2.0.0',
            instanceId: SELF,
            capabilities: { workspaces: true, atomicReplace: true, focusLeases: true },
        })).accepted, true);

        const remoteWorkspace = makeWorkspaceRecord(42, {
            navigationUri: 'vscode-remote://dev-container%2Bold/workspaces/AiToEarn',
            roots: [makeWorkspaceRoot(42, {
                ordinal: 0,
                uri: 'vscode-remote://dev-container%2Bold/workspaces/AiToEarn',
            })],
        });
        await publish(makeWorkspacePublication({ followsFocusEvent: true, workspace: remoteWorkspace }));
        const aggregateDelivery = executedCommands.filter(
            value => value.command === '_projectStewardOpenWorkspaces.workspace.aggregate'
        ).pop();
        assert.ok(aggregateDelivery, 'production wiring should deliver an open-workspace aggregate');
        assert.strictEqual(aggregateDelivery.argument.registrations[0].instanceId, SELF);
        assert.strictEqual(
            aggregateDelivery.argument.registrations[0].workspace.navigationUri,
            'vscode-remote://dev-container%2Btarget%40ssh-remote%2Bhome-book/workspaces/AiToEarn'
        );
        assert.strictEqual(
            aggregateDelivery.argument.registrations[0].workspace.roots[0].uri,
            'vscode-remote://dev-container%2Btarget%40ssh-remote%2Bhome-book/workspaces/AiToEarn'
        );
        assert.strictEqual(aggregateDelivery.argument.registrations[0].workspace.navigationIdentity,
            remoteWorkspace.navigationIdentity);
        assert.strictEqual(aggregateDelivery.argument.registrations[0].workspace.roots[0].id,
            remoteWorkspace.roots[0].id);
        assert.ok(bridgeOutputLines.some(line =>
            line.startsWith('[OpenWorkspaces] ')
            && line.includes('"event":"publish"')
            && line.includes(SELF)
        ));
        assert.ok(executedCommands.some(value =>
            value.command === '_projectStewardOpenWorkspaces.workspace.diagnostic'
            && value.argument.event === 'publish'
        ));
        const diagnosticSentinel = '/private/wiring raw-command --session secret-session';
        aggregateDeliveryError = new Error(diagnosticSentinel);
        const nextRemoteWorkspace = makeWorkspaceRecord(43, {
            navigationUri: remoteWorkspace.navigationUri,
            roots: [makeWorkspaceRoot(43, {
                ordinal: 0,
                uri: remoteWorkspace.roots[0].uri,
            })],
        });
        await assert.rejects(
            publish(makeWorkspacePublication({ sequence: 2, workspace: nextRemoteWorkspace })),
            error => String(error).includes(diagnosticSentinel),
        );
        const crossExtensionDiagnostics = executedCommands.filter(
            value => value.command === '_projectStewardOpenWorkspaces.workspace.diagnostic'
        ).map(value => value.argument);
        assert.ok(crossExtensionDiagnostics.some(event =>
            event.event === 'error'
            && event.operation === 'publish'
            && event.errorCategory === 'open-workspace-operation'
            && event.errorCode === 'failed'
        ));
        assert.strictEqual(JSON.stringify(crossExtensionDiagnostics).includes(diagnosticSentinel), false);
        assert.strictEqual(bridgeOutputLines.join('\n').includes(diagnosticSentinel), false,
            'the bridge OutputChannel must not receive arbitrary exception text');
        aggregateDeliveryError = null;
        await unregister({ protocolVersion: 2, instanceId: SELF });
    } finally {
        Module._load = previousModuleLoad;
        for (const disposable of context.subscriptions.slice().reverse()) {
            disposable.dispose();
        }
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
}

async function main() {
    runWorkspaceProtocolV2Checks();
    await runWorkspaceContextResolverChecks();
    await runSavedWorkspaceProjectAdapterChecks();
    await runProjectServiceWorkspaceSaveMigrationIntegrationChecks();
    runWorkspaceProjectionV2Checks();
    runOpenWorkspacePublicationChecks();
    await runOpenWorkspaceStoreChecks();
    await runOpenWorkspaceCoordinatorChecks();
    await runOpenWorkspaceCoordinatorBoundaryChecks();
    await runOpenWorkspaceCoordinatorDiagnosticPrivacyChecks();
    await runOpenWorkspaceClientAndControllerChecks();
    await runWorkspaceNavigationControllerChecks();
    await runOpenWorkspaceHardeningChecks();
    await runCurrentProjectDetailsResolverChecks();
    await runProjectOpenControllerChecks();
    runDashboardBridgeLifecycleChecks();
    runOpenWorkspaceProductionCutoverChecks();
    runWebviewRefreshFocusChecks();
    await runDashboardMigrationPublicationChecks();
    await runCoordinatorWiringChecks();
    console.log('Open workspace safety checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
