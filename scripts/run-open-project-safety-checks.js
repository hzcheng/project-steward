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
const protocol = require('../out/openProjects/protocol');
const projection = require('../out/openProjects/projection');
const workspaceProtocol = require('../out/openWorkspaces/protocol');
const workspaceProjection = require('../out/openWorkspaces/projection');
const { default: OpenWorkspaceBridgeClient } = require('../out/openWorkspaces/bridgeClient');
const { OpenWorkspaceDashboardController } = require('../out/openWorkspaces/dashboardController');
const { OpenWorkspaceController } = require('../out/openWorkspaces/workspaceController');
const attentionProject = require('../out/aiSessions/attentionProject');
const { CurrentProjectDetailsResolver } = require('../out/projects/currentProjectDetails');
const { ProjectManualEditController } = require('../out/projects/projectManualEditController');
const { ProjectOpenController } = require('../out/projects/projectOpenController');
const { ProjectMutationController } = require('../out/projects/projectMutationController');
const { ProjectPromptController } = require('../out/projects/projectPromptController');
const { DashboardStartupController } = require('../out/dashboard/startupController');
const { WorkspaceContextResolver } = require('../out/workspaces/contextResolver');
const models = require('../out/models');
const { OpenWorkspaceStore } = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceStore');
const { OpenWorkspaceCoordinator } = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceCoordinator');
const { replaceOpenWorkspacePublicationUris } = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspacePublication');
Module._load = originalModuleLoad;

const SELF = '1'.repeat(32);
const OLDER = '2'.repeat(32);
const NEWER = '3'.repeat(32);
const OTHER = '4'.repeat(32);

function makeRecord(overrides = {}) {
    return {
        localProjectId: '__openProjects-0',
        ordinal: 0,
        name: 'Shared',
        description: 'Workspace folder',
        uri: '/work/shared',
        remoteType: 'local',
        color: '#222',
        ...overrides,
    };
}

function makePublication(overrides = {}) {
    return {
        protocolVersion: 1,
        instanceId: SELF,
        sequence: 1,
        followsFocusEvent: false,
        projects: [makeRecord()],
        ...overrides,
    };
}

function makeRegistration(instanceId = SELF, lastFocusedAtMs = 4000, uri = '/work/shared', overrides = {}) {
    return {
        protocolVersion: 1,
        instanceId,
        sequence: 1,
        lastFocusedAtMs,
        leaseUpdatedAtMs: 4500,
        projects: [makeRecord({ uri })],
        ...overrides,
    };
}

function makeAggregate(registrations, overrides = {}) {
    return {
        protocolVersion: 1,
        semanticRevision: 'revision',
        observedAtMs: 5000,
        registrations,
        ...overrides,
    };
}

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
        navigationUri: `file:///work/workspace-${index}`,
        environment: 'local',
        roots: [makeWorkspaceRoot(index)],
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

function runProtocolChecks() {
    const publication = makePublication();
    const registration = makeRegistration();
    const aggregate = makeAggregate([registration]);

    assert.deepStrictEqual(protocol.validateOpenProjectPublication(publication), publication);
    assert.deepStrictEqual(protocol.validateOpenProjectRegistration(registration), registration);
    assert.deepStrictEqual(protocol.validateOpenProjectAggregate(aggregate), aggregate);
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({ ...publication, unexpected: true }),
        /unexpected fields/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({
            ...publication,
            projects: [{ ...publication.projects[0], unexpected: true }],
        }),
        /unexpected fields/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectRegistration({ ...registration, unexpected: true }),
        /unexpected fields/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectAggregate({ ...aggregate, unexpected: true }),
        /unexpected fields/
    );

    for (const instanceId of ['short', 'A'.repeat(32), 'g'.repeat(32), `${SELF}0`]) {
        assertRejectsValidation(
            () => protocol.validateOpenProjectPublication({ ...publication, instanceId }),
            /instanceId/
        );
    }
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({ ...publication, projects: Array(101).fill(makeRecord()) }),
        /projects/
    );
    const sparseProjects = [makeRecord()];
    sparseProjects.length = 2;
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({ ...publication, projects: sparseProjects }),
        /open project record/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({
            ...publication,
            projects: [makeRecord({ remoteType: 'codespaces' })],
        }),
        /remoteType/
    );
    for (const sequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assertRejectsValidation(
            () => protocol.validateOpenProjectPublication({ ...publication, sequence }),
            /sequence/
        );
    }
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({
            ...publication,
            projects: [makeRecord({ ordinal: Number.MAX_SAFE_INTEGER + 1 })],
        }),
        /ordinal/
    );
    for (const timestamp of [NaN, Infinity, -Infinity]) {
        assertRejectsValidation(
            () => protocol.validateOpenProjectRegistration({ ...registration, lastFocusedAtMs: timestamp }),
            /lastFocusedAtMs/
        );
        assertRejectsValidation(
            () => protocol.validateOpenProjectAggregate({ ...aggregate, observedAtMs: timestamp }),
            /observedAtMs/
        );
    }
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({ ...publication, instanceId: '' }),
        /instanceId/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({
            ...publication,
            projects: [makeRecord({ name: '' })],
        }),
        /name/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectPublication({
            ...publication,
            projects: [makeRecord({ uri: 'x'.repeat(8193) })],
        }),
        /uri/
    );
    const runningPublication = {
        ...publication,
        projects: [makeRecord({ activeSessionCount: 2 })],
    };
    assert.deepStrictEqual(protocol.validateOpenProjectPublication(runningPublication), runningPublication);
    assert.strictEqual(
        protocol.validateOpenProjectRegistration({
            ...registration,
            projects: [{ ...registration.projects[0], activeSessionCount: 3 }],
        }).projects[0].activeSessionCount,
        3
    );
    for (const activeSessionCount of [-1, 1.5, '2', NaN, Number.MAX_SAFE_INTEGER + 1]) {
        assertRejectsValidation(
            () => protocol.validateOpenProjectPublication({
                ...publication,
                projects: [makeRecord({ activeSessionCount })],
            }),
            /activeSessionCount/
        );
    }
    assertRejectsValidation(
        () => protocol.validateOpenProjectAggregate(null),
        /aggregate/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectAggregate({ ...aggregate, registrations: {} }),
        /registrations/
    );
    const sparseRegistrations = [registration];
    sparseRegistrations.length = 2;
    assertRejectsValidation(
        () => protocol.validateOpenProjectAggregate({ ...aggregate, registrations: sparseRegistrations }),
        /open project registration/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectAggregate({ ...aggregate, semanticRevision: '' }),
        /semanticRevision/
    );
    assertRejectsValidation(
        () => protocol.validateOpenProjectAggregate({
            ...aggregate,
            registrations: [registration, { ...registration, sequence: registration.sequence + 1 }],
        }),
        /duplicate instanceId/
    );

    const baseRevision = protocol.createOpenProjectSemanticRevision([registration]);
    assert.strictEqual(
        protocol.createOpenProjectSemanticRevision([{ ...registration, sequence: 99, leaseUpdatedAtMs: 9999 }]),
        baseRevision
    );
    assert.notStrictEqual(
        protocol.createOpenProjectSemanticRevision([{ ...registration, lastFocusedAtMs: registration.lastFocusedAtMs + 1 }]),
        baseRevision
    );
    assert.notStrictEqual(
        protocol.createOpenProjectSemanticRevision([{
            ...registration,
            projects: [{ ...registration.projects[0], name: 'Changed' }],
        }]),
        baseRevision
    );
    assert.notStrictEqual(
        protocol.createOpenProjectSemanticRevision([{
            ...registration,
            projects: [{ ...registration.projects[0], activeSessionCount: 2 }],
        }]),
        baseRevision,
        'running session counts must be part of the semantic revision'
    );
    assert.strictEqual(
        protocol.createOpenProjectSemanticRevision([{
            ...registration,
            projects: [{ ...registration.projects[0], activeSessionCount: 0 }],
        }]),
        baseRevision,
        'an explicit zero active session count must not change the semantic revision'
    );
    assert.strictEqual(
        protocol.createOpenProjectSemanticRevision([
            makeRegistration(OLDER, 2000),
            makeRegistration(NEWER, 3000),
        ]),
        protocol.createOpenProjectSemanticRevision([
            makeRegistration(NEWER, 3000),
            makeRegistration(OLDER, 2000),
        ])
    );
    const tiedProjectAlpha = makeRecord({
        name: 'Alpha',
        description: 'First',
        remoteType: 'ssh',
        color: '#111',
    });
    const tiedProjectBeta = makeRecord({
        name: 'Beta',
        description: 'Second',
        remoteType: 'remote',
        color: '#222',
    });
    assert.strictEqual(
        protocol.createOpenProjectSemanticRevision([makeRegistration(SELF, 4000, '/work/shared', {
            projects: [tiedProjectAlpha, tiedProjectBeta],
        })]),
        protocol.createOpenProjectSemanticRevision([makeRegistration(SELF, 4000, '/work/shared', {
            projects: [tiedProjectBeta, tiedProjectAlpha],
        })])
    );
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
    assert.deepStrictEqual(
        workspaceProtocol.validateOpenWorkspacePublication({
            ...publication,
            workspace: { ...publication.workspace, roots: [] },
        }).workspace.roots,
        []
    );

    assertRejectsValidation(
        () => workspaceProtocol.validateOpenWorkspacePublication(makePublication()),
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
    assert.strictEqual(
        workspaceProtocol.createOpenWorkspaceSemanticRevision([
            makeWorkspaceRegistration(SELF, 4000, multiRoot),
        ]),
        workspaceProtocol.createOpenWorkspaceSemanticRevision([
            makeWorkspaceRegistration(SELF, 4000, { ...multiRoot, roots: multiRoot.roots.slice().reverse() }),
        ])
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
    const publicationRecord = workspaceProjection.createOpenWorkspacePublication(sourceWorkspace);
    assert.strictEqual(Array.isArray(publicationRecord), false, 'a workspace publication is one record, not one record per root');
    assert.deepStrictEqual(Object.keys(publicationRecord).sort(), [
        'displayName',
        'environment',
        'kind',
        'navigationIdentity',
        'navigationUri',
        'roots',
        'scopeIdentity',
    ]);
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
    assert.strictEqual(duplicateCard.environmentLabel, 'SSH');
    assert.strictEqual(duplicateCard.roots.length, 2);
    assert.strictEqual(duplicateCard.attentionCount, 1);
    assert.deepStrictEqual(Object.keys(duplicateCard).sort(), [
        'attentionCount',
        'environmentLabel',
        'id',
        'kind',
        'name',
        'navigationIdentity',
        'roots',
        'scopeIdentity',
    ]);
    assert.strictEqual(duplicateCard.kind, 'navigation');
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
        const legacyRegistration = makeRegistration(OTHER, 1000, '/legacy', { leaseUpdatedAtMs: 1000 });
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
        { workspace: record, followsFocusEvent: false },
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
        getCurrentWorkspaceAiSessions: () => null,
        getGroups: () => [],
        getTodoSearchItems: () => [],
        getCollapsed: () => false,
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
    assert.strictEqual(cards.filter(card => card.kind === 'navigation').length, 1,
        'two owner registrations for one navigation identity must project to one card');
    assert.strictEqual(cards.find(card => card.kind === 'navigation').name, 'Newest registration wins');
    assert.strictEqual(cards.some(card => card.roots.some(root => Object.hasOwnProperty.call(root, 'hostPath'))), false);
    assert.strictEqual(cards.find(card => card.kind === 'navigation').aiSessions, undefined,
        'OTHER WINDOWS cards must stay lightweight');
    dashboard.postUpdated();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].type, 'open-workspaces-updated');
    assert.strictEqual(posted[0].version, 2);
    assert.strictEqual(posted[0].currentWorkspaceCount, 1);
    assert.strictEqual(posted[0].navigationWorkspaceCount, 1);
    assert.strictEqual(posted[0].searchCatalog.version, 2);
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
    const dashboard = new OpenWorkspaceDashboardController({
        getCurrentWorkspace: () => current,
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
            activeSessionCount: 0,
            activeSessions: [],
            activeAttentionCount: 0,
        }),
        getGroups: () => [],
        getTodoSearchItems: () => [],
        getCollapsed: () => false,
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

function runOpenProjectPublicationChecks() {
    const publication = {
        protocolVersion: 1,
        instanceId: SELF,
        sequence: 1,
        followsFocusEvent: false,
        projects: [makeRecord({
            ordinal: 0,
            uri: 'vscode-remote://dev-container%2Bcurrent/workspaces/AiToEarn',
            remoteType: 'devContainer',
        })],
    };
    const exactWindowUri = 'vscode-remote://dev-container%2Btarget%40ssh-remote%2Bhome-book/workspaces/AiToEarn';

    const replaced = replaceOpenProjectPublicationUris(publication, [exactWindowUri]);

    assert.strictEqual(replaced.projects[0].uri, exactWindowUri);
    assert.strictEqual(publication.projects[0].uri, 'vscode-remote://dev-container%2Bcurrent/workspaces/AiToEarn');
    assert.deepStrictEqual(replaceOpenProjectPublicationUris(publication, []), publication);
}

function runRemoteAttentionIdentityChecks() {
    const localPath = '/workspaces/reddb-dual-active';
    const remoteUri = 'vscode-remote://dev-container%2Btarget/workspaces/reddb-dual-active';
    const attentionProjectId = attentionProject.getAttentionProjectKey(localPath);
    const publication = makePublication({
        projects: [makeRecord({ uri: localPath, remoteType: 'devContainer' })],
    });
    const replaced = replaceOpenProjectPublicationUris(publication, [remoteUri]);
    assert.strictEqual(replaced.projects[0].uri, remoteUri);

    const cards = projection.projectOpenProjectCards([], makeAggregate([
        makeRegistration(OTHER, 4000, remoteUri, { projects: replaced.projects }),
    ]), SELF);
    assert.strictEqual(cards[0].path, remoteUri);

    const annotated = attentionProject.withAttentionProjects(cards, {
        protocolVersion: 1,
        aggregateRevision: 'a'.repeat(64),
        generatedAtMs: 10,
        sessions: [{
            projectId: attentionProjectId,
            sessionKey: 'codex:019f7d85-3b51-7b82-8590-02409fcdffcd',
            eventIds: ['event-remote'],
            reasons: ['completed'],
            observedAtMs: 9,
        }],
    });
    assert.strictEqual(
        annotated[0].aiSessionAttentionCount,
        1,
        'OTHER WINDOWS must derive the workspace-host attention identity from its remote URI'
    );
}

function runWorkspaceContextResolverChecks() {
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
        workspaceName: 'Local App',
        remoteName: undefined,
        workspaceFolders: [folder('app', uri('file:///work/app'))],
    });
    assert.strictEqual(local.kind, 'singleFolder');
    assert.strictEqual(local.displayName, 'Local App');
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
        workspaceName: 'Team',
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
    assert.strictEqual(savedWithoutWorkspaceName.displayName, 'fallback.code-workspace');
    const untitledWithoutWorkspaceName = resolver.resolve({
        workspaceFile: uri('untitled:Untitled-3'),
        remoteName: undefined,
        workspaceFolders: [folder('untitled root name', uri('file:///work/untitled-root'))],
    });
    assert.strictEqual(untitledWithoutWorkspaceName.displayName, 'Untitled-3');
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
    assert.strictEqual(noRootSavedWorkspace.displayName, 'no-roots.code-workspace');
    assert.deepStrictEqual(noRootSavedWorkspace.roots, []);
    const noRootUntitledWorkspace = resolver.resolve({
        workspaceFile: uri('untitled:'),
        remoteName: undefined,
        workspaceFolders: [],
    });
    assert.strictEqual(noRootUntitledWorkspace.displayName, 'Workspace');
    assert.deepStrictEqual(noRootUntitledWorkspace.roots, []);

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

function runIdentityChecks() {
    assert.strictEqual(projection.normalizeOpenProjectIdentity('/work/shared/'), '/work/shared');
    assert.strictEqual(projection.normalizeOpenProjectIdentity('C:\\work\\shared\\'), 'C:/work/shared');
    assert.notStrictEqual(
        projection.normalizeOpenProjectIdentity('/work/project '),
        projection.normalizeOpenProjectIdentity('/work/project')
    );
    assert.notStrictEqual(
        projection.normalizeOpenProjectIdentity('/work/a\\b'),
        projection.normalizeOpenProjectIdentity('/work/a/b')
    );
    assert.strictEqual(
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote+one/work/shared/'),
        'vscode-remote://ssh-remote+one/work/shared'
    );
    assert.notStrictEqual(
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote+one/work/shared'),
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote+one/work/other')
    );
    assert.notStrictEqual(
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote+one/work/shared'),
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote+two/work/shared')
    );
    assert.strictEqual(
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote%2Bone/work/shared'),
        projection.normalizeOpenProjectIdentity('vscode-remote://ssh-remote+one/work/shared')
    );
    assert.notStrictEqual(
        projection.normalizeOpenProjectIdentity('vscode-remote://authority%2Fsegment/work/shared'),
        projection.normalizeOpenProjectIdentity('vscode-remote://authority/segment/work/shared')
    );
}

function runRecordChecks() {
    const records = projection.createOpenProjectRecords([
        { id: 'local', name: 'Local', description: 'Folder', path: '/local', remoteType: models.ProjectRemoteType.None, color: '#111' },
        { id: 'ssh', name: 'SSH', description: 'Folder', path: 'vscode-remote://ssh-remote+host/ssh', remoteType: models.ProjectRemoteType.SSH },
        { id: 'wsl', name: 'WSL', description: 'Folder', path: 'vscode-remote://wsl+Ubuntu/wsl', remoteType: models.ProjectRemoteType.WSL },
        { id: 'container', name: 'Container', description: 'Folder', path: 'vscode-remote://dev-container+abc/container', remoteType: models.ProjectRemoteType.DevContainer },
        { id: 'remote', name: 'Remote', description: 'Folder', path: 'vscode-remote://tunnel+host/remote', remoteType: models.ProjectRemoteType.Remote },
    ]);

    assert.deepStrictEqual(records.map(record => record.remoteType), ['local', 'ssh', 'wsl', 'devContainer', 'remote']);
    assert.deepStrictEqual(records.map(record => record.ordinal), [0, 1, 2, 3, 4]);
    assert.strictEqual(records[0].color, '#111');
    assert.strictEqual(records[1].color, undefined);

    const countedRecords = projection.createOpenProjectRecords([
        { id: 'idle', name: 'Idle', description: '', path: '/idle', remoteType: models.ProjectRemoteType.None },
        { id: 'running', name: 'Running', description: '', path: '/running', remoteType: models.ProjectRemoteType.SSH },
        { id: 'untracked', name: 'Untracked', description: '', path: '/untracked', remoteType: models.ProjectRemoteType.None },
    ], new Map([['idle', 0], ['running', 2]]));
    assert.strictEqual(countedRecords[0].activeSessionCount, undefined, 'zero counts must be omitted');
    assert.strictEqual(countedRecords[1].activeSessionCount, 2);
    assert.strictEqual(countedRecords[2].activeSessionCount, undefined, 'projects without counts must be omitted');
}

function runWorkspaceControllerRecordChecks() {
    const controller = new OpenProjectWorkspaceController({
        getWorkspaceFile: () => null,
        getWorkspaceFolders: () => [{ uri: { fsPath: '/work/app', path: '/work/app', scheme: 'file' }, name: 'app' }],
        getSavedProjects: () => [],
        getCurrentRemoteName: () => undefined,
        isFolderGitRepo: () => false,
        getActiveSessionCounts: () => new Map([['__openProjects-0', 2]]),
        publishRecords: () => undefined,
    });

    const countedRecords = controller.getOpenProjectRecords();
    assert.strictEqual(countedRecords.length, 1);
    assert.strictEqual(countedRecords[0].activeSessionCount, 2,
        'records must include running session counts by default');

    const initialRecords = controller.getOpenProjectRecords(false);
    assert.strictEqual(initialRecords.length, 1);
    assert.strictEqual(initialRecords[0].activeSessionCount, undefined,
        'initial publication must skip running session counts');
}

function runProjectionChecks() {
    const current = [{
        id: '__openProjects-0', name: 'Current', description: 'Workspace folder',
        path: '/work/current', color: '#111', openProjectCardKind: 'current',
        codexSessions: [{ id: 'current-session', name: 'Current Session' }],
    }];
    const aggregate = makeAggregate([
        makeRegistration(SELF, 4000, '/work/current'),
        makeRegistration(OLDER, 2000, '/work/shared/'),
        makeRegistration(NEWER, 3000, '/work/shared'),
    ]);
    const cards = projection.projectOpenProjectCards(current, aggregate, SELF);
    assert.deepStrictEqual(cards.map(card => card.name), ['Current', 'Shared']);
    assert.strictEqual(cards[0].openProjectCardKind, 'current');
    assert.strictEqual(cards[0].codexSessions[0].id, 'current-session');
    assert.notStrictEqual(cards[0], current[0]);
    assert.strictEqual(cards[1].openProjectCardKind, 'projectNavigation');
    assert.strictEqual(cards[1].openProjectSourceInstanceId, NEWER);
    assert.strictEqual(cards[1].codexSessions, undefined);
    assert.strictEqual(cards[1].path, '/work/shared');
    assert.match(cards[1].id, /^__openProjectNavigation-[a-f0-9]{24}$/);

    const currentRemote = [{
        id: '__openProjects-0',
        name: 'Current Remote',
        description: 'Workspace folder',
        path: 'vscode-remote://ssh-remote+one/work/shared/',
    }];
    const remoteCards = projection.projectOpenProjectCards(currentRemote, makeAggregate([
        makeRegistration(OLDER, 2000, 'vscode-remote://ssh-remote+one/work/shared'),
        makeRegistration(NEWER, 3000, 'vscode-remote://ssh-remote+two/work/shared'),
    ]), SELF);
    assert.deepStrictEqual(remoteCards.map(card => card.name), ['Current Remote', 'Shared']);
    assert.strictEqual(remoteCards[1].path, 'vscode-remote://ssh-remote+two/work/shared');

    const ordered = projection.projectOpenProjectCards([], makeAggregate([
        makeRegistration(OLDER, 2000, '/work/zulu', {
            projects: [makeRecord({ ordinal: 1, name: 'Zulu', uri: '/work/zulu' })],
        }),
        makeRegistration(NEWER, 3000, '/work/bravo', {
            projects: [
                makeRecord({ ordinal: 2, name: 'Charlie', uri: '/work/charlie' }),
                makeRecord({ ordinal: 1, name: 'Bravo', uri: '/work/bravo' }),
                makeRecord({ ordinal: 1, name: 'Alpha', uri: '/work/alpha' }),
            ],
        }),
    ]), SELF);
    assert.deepStrictEqual(ordered.map(card => card.name), ['Alpha', 'Bravo', 'Charlie', 'Zulu']);

    const dirtyRecord = makeRecord({
        uri: 'vscode-remote://dev-container+abc/work/app/',
        remoteType: 'devContainer',
    });
    const dirtyRegistration = makeRegistration(OTHER, 1000, dirtyRecord.uri, { projects: [dirtyRecord] });
    const dirtyCards = projection.projectOpenProjectCards([], makeAggregate([dirtyRegistration]), SELF);
    const dirtyCard = dirtyCards[0];
    assert.strictEqual(dirtyCard.remoteType, models.ProjectRemoteType.DevContainer);
    assert.strictEqual(dirtyCard.openProjectEnvironmentLabel, 'Dev Container');
    for (const field of [
        'attentionProjectPath',
        'favorite',
        'favoriteOrder',
        'showSaveAction',
        'isCurrentWorkspace',
        'codexSessions',
        'kimiSessions',
        'claudeSessions',
        'codexSessionsExpanded',
        'codexSessionsUnavailable',
        'kimiSessionsUnavailable',
        'claudeSessionsUnavailable',
        'activeAiSessionProvider',
        'aiSessionAttentionCount',
        'aiSessionAttentionEventIds',
        'isGitRepo',
    ]) {
        assert.strictEqual(dirtyCard[field], undefined, `${field} leaked into a navigation card`);
    }

    assert.deepStrictEqual(
        projection.projectOpenProjectCards(current, null, SELF).map(card => card.name),
        ['Current']
    );

    const duplicateAlpha = makeRegistration(OLDER, 2000, '/work/duplicate', {
        projects: [makeRecord({ name: 'Alpha', uri: '/work/duplicate' })],
    });
    const duplicateBeta = makeRegistration(OLDER, 2000, '/work/duplicate', {
        projects: [makeRecord({ name: 'Beta', uri: '/work/duplicate' })],
    });
    const duplicateForward = projection.projectOpenProjectCards(
        [],
        makeAggregate([duplicateAlpha, duplicateBeta]),
        SELF
    );
    const duplicateReverse = projection.projectOpenProjectCards(
        [],
        makeAggregate([duplicateBeta, duplicateAlpha]),
        SELF
    );
    assert.deepStrictEqual(duplicateForward.map(card => card.name), ['Alpha']);
    assert.deepStrictEqual(duplicateReverse, duplicateForward);

    const sessionCountCards = projection.projectOpenProjectCards([], makeAggregate([
        makeRegistration(NEWER, 3000, '/work/running', {
            projects: [makeRecord({ name: 'Running', uri: '/work/running', activeSessionCount: 3 })],
        }),
        makeRegistration(OLDER, 2000, '/work/idle', {
            projects: [makeRecord({ name: 'Idle', uri: '/work/idle' })],
        }),
    ]), SELF);
    assert.strictEqual(sessionCountCards[0].name, 'Running');
    assert.strictEqual(sessionCountCards[0].openProjectActiveSessionCount, 3);
    assert.strictEqual(sessionCountCards[1].name, 'Idle');
    assert.strictEqual(sessionCountCards[1].openProjectActiveSessionCount, 0);
}

async function runBridgeClientChecks() {
    let currentNow = 1000;
    let heartbeatCallback;
    let heartbeatIntervalMs;
    let clearedHeartbeat;
    const heartbeatHandle = { kind: 'open-project-heartbeat' };
    const registeredCommands = new Map();
    const executions = [];
    const aggregates = [];
    const errors = [];
    const clientDiagnostics = [];
    const forwardedBridgeDiagnostics = [];
    const instanceId = 'a'.repeat(32);
    const records = [makeRecord()];
    const client = new OpenProjectBridgeClient(
        records,
        aggregate => aggregates.push(aggregate),
        error => errors.push(error),
        {
            instanceId,
            now: () => currentNow,
            registerCommand: (command, callback) => {
                registeredCommands.set(command, callback);
                return { dispose: () => registeredCommands.delete(command) };
            },
            executeCommand: async (command, argument) => {
                executions.push({ command, argument });
            },
            setInterval: (callback, milliseconds) => {
                heartbeatCallback = callback;
                heartbeatIntervalMs = milliseconds;
                return heartbeatHandle;
            },
            clearInterval: handle => {
                clearedHeartbeat = handle;
            },
            reportDiagnostic: event => clientDiagnostics.push(event),
            reportBridgeDiagnostic: event => forwardedBridgeDiagnostics.push(event),
        }
    );

    assert.strictEqual(client.instanceId, instanceId);
    assert.strictEqual(heartbeatIntervalMs, 10_000);
    assert.strictEqual(typeof heartbeatCallback, 'function');
    assert.strictEqual(
        typeof registeredCommands.get('_projectStewardOpenProjects.workspace.aggregate'),
        'function'
    );
    assert.strictEqual(
        typeof registeredCommands.get('_projectStewardOpenProjects.workspace.diagnostic'),
        'function'
    );
    assert.deepStrictEqual(executions, [{
        command: '_projectStewardOpenProjects.bridge.publish',
        argument: {
            protocolVersion: 1,
            instanceId,
            sequence: 1,
            followsFocusEvent: false,
            projects: records,
        },
    }]);
    assert.ok(!Object.prototype.hasOwnProperty.call(executions[0].argument, 'leaseUpdatedAtMs'));
    assert.ok(!Object.prototype.hasOwnProperty.call(executions[0].argument, 'lastFocusedAtMs'));
    assert.ok(!Object.prototype.hasOwnProperty.call(executions[0].argument, 'observedAtMs'));
    assert.ok(clientDiagnostics.some(event =>
        event.event === 'activate'
        && event.instanceId === instanceId
        && event.projectCount === 1
    ));
    registeredCommands.get('_projectStewardOpenProjects.workspace.diagnostic')({
        event: 'scan',
        atMs: 1000,
        registrationCount: 3,
    });
    assert.deepStrictEqual(forwardedBridgeDiagnostics, [{
        event: 'scan',
        atMs: 1000,
        registrationCount: 3,
    }]);

    await client.publish(records);
    assert.strictEqual(executions.length, 1, 'unchanged metadata should be suppressed between heartbeats');

    await heartbeatCallback();
    assert.strictEqual(executions.length, 2);
    assert.strictEqual(executions[1].argument.sequence, 2);
    assert.strictEqual(executions[1].argument.followsFocusEvent, false);
    assert.ok(clientDiagnostics.some(event =>
        event.event === 'publish-success'
        && event.sequence === 2
        && event.reason === 'heartbeat'
    ));

    await client.publish(records, true);
    assert.strictEqual(executions.length, 3);
    assert.deepStrictEqual(executions[2], {
        command: '_projectStewardOpenProjects.bridge.publish',
        argument: {
            protocolVersion: 1,
            instanceId,
            sequence: 3,
            followsFocusEvent: true,
            projects: records,
        },
    });

    const changedRecords = [makeRecord({ name: 'Changed' })];
    await client.publish(changedRecords);
    assert.strictEqual(executions.length, 4);
    assert.strictEqual(executions[3].argument.sequence, 4);
    await client.publish(changedRecords);
    assert.strictEqual(executions.length, 4);

    const receiveAggregate = registeredCommands.get('_projectStewardOpenProjects.workspace.aggregate');
    const aggregate = makeAggregate([makeRegistration()]);
    receiveAggregate(aggregate);
    assert.deepStrictEqual(aggregates, [aggregate]);
    assert.ok(clientDiagnostics.some(event =>
        event.event === 'aggregate'
        && event.registrationCount === 1
        && event.registrations[0].instanceId === SELF
    ));
    receiveAggregate({
        ...aggregate,
        observedAtMs: aggregate.observedAtMs + 1,
        registrations: [{ ...aggregate.registrations[0], sequence: 2, leaseUpdatedAtMs: 5001 }],
    });
    assert.strictEqual(aggregates.length, 1, 'lease-only aggregate changes should not invoke the callback');
    const changedAggregate = { ...aggregate, semanticRevision: 'changed-revision' };
    client.receiveAggregate(changedAggregate);
    assert.deepStrictEqual(aggregates, [aggregate, changedAggregate]);

    client.receiveAggregate({ ...aggregate, unexpected: true });
    client.receiveAggregate({ ...aggregate, unexpected: true });
    assert.strictEqual(errors.length, 1, 'aggregate errors should be throttled');
    currentNow += 60_000;
    client.receiveAggregate({ ...aggregate, unexpected: true });
    assert.strictEqual(errors.length, 2);

    client.dispose();
    assert.strictEqual(clearedHeartbeat, heartbeatHandle);
    assert.strictEqual(registeredCommands.has('_projectStewardOpenProjects.workspace.aggregate'), false);
    assert.deepStrictEqual(executions[executions.length - 1], {
        command: '_projectStewardOpenProjects.bridge.unregister',
        argument: { protocolVersion: 1, instanceId },
    });

    const unregisterFailure = new Error('forced unregister failure');
    const failingClient = new OpenProjectBridgeClient(
        records,
        () => undefined,
        () => undefined,
        {
            instanceId: 'b'.repeat(32),
            now: () => currentNow,
            registerCommand: () => ({ dispose: () => undefined }),
            executeCommand: command => {
                if (command === '_projectStewardOpenProjects.bridge.unregister') {
                    throw unregisterFailure;
                }
                return Promise.resolve();
            },
            setInterval: () => 'failing-heartbeat',
            clearInterval: () => undefined,
        }
    );
    assert.doesNotThrow(() => failingClient.dispose());
    await new Promise(resolve => setImmediate(resolve));

    const asynchronousUnregisterFailure = new Error('forced asynchronous unregister failure');
    const asynchronousUnregisterErrors = [];
    const unhandledRejections = [];
    const onUnhandledRejection = error => unhandledRejections.push(error);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
        const asynchronouslyFailingClient = new OpenProjectBridgeClient(
            records,
            () => undefined,
            error => asynchronousUnregisterErrors.push(error),
            {
                instanceId: 'd'.repeat(32),
                now: () => currentNow,
                registerCommand: () => ({ dispose: () => undefined }),
                executeCommand: command => command === '_projectStewardOpenProjects.bridge.unregister'
                    ? Promise.reject(asynchronousUnregisterFailure)
                    : Promise.resolve(),
                setInterval: () => 'asynchronous-failure-heartbeat',
                clearInterval: () => undefined,
            }
        );
        assert.doesNotThrow(() => asynchronouslyFailingClient.dispose());
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(asynchronousUnregisterErrors, [asynchronousUnregisterFailure]);
        assert.deepStrictEqual(unhandledRejections, []);
    } finally {
        process.removeListener('unhandledRejection', onUnhandledRejection);
    }

    const publishErrors = [];
    const publishFailure = new Error('forced publish failure');
    const failingPublishClient = new OpenProjectBridgeClient(
        records,
        () => undefined,
        error => publishErrors.push(error),
        {
            instanceId: 'c'.repeat(32),
            now: () => currentNow,
            registerCommand: () => ({ dispose: () => undefined }),
            executeCommand: async command => {
                if (command === '_projectStewardOpenProjects.bridge.publish') {
                    throw publishFailure;
                }
            },
            setInterval: () => 'publish-failure-heartbeat',
            clearInterval: () => undefined,
        }
    );
    await new Promise(resolve => setImmediate(resolve));
    await failingPublishClient.publish([makeRecord({ name: 'Second failure' })]);
    assert.deepStrictEqual(publishErrors, [publishFailure]);
    currentNow += 60_000;
    await failingPublishClient.publish([makeRecord({ name: 'Third failure' })]);
    assert.deepStrictEqual(publishErrors, [publishFailure, publishFailure]);
    failingPublishClient.dispose();

    const refreshExecutions = [];
    const refreshErrors = [];
    const refreshedRecords = [makeRecord({ name: 'Heartbeat Refreshed', activeSessionCount: 2 })];
    let refreshCallback;
    let refreshShouldThrow = false;
    const refreshingClient = new OpenProjectBridgeClient(
        records,
        () => undefined,
        error => refreshErrors.push(error),
        {
            instanceId: 'c'.repeat(32),
            now: () => currentNow,
            registerCommand: () => ({ dispose: () => undefined }),
            executeCommand: async (command, argument) => {
                refreshExecutions.push({ command, argument });
            },
            setInterval: callback => {
                refreshCallback = callback;
                return 'refresh-heartbeat';
            },
            clearInterval: () => undefined,
            refreshProjects: () => {
                if (refreshShouldThrow) {
                    throw new Error('forced refresh failure');
                }
                return refreshedRecords;
            },
        }
    );

    assert.strictEqual(refreshExecutions.length, 1, 'initial publication should use the constructor records');
    assert.deepStrictEqual(refreshExecutions[0].argument.projects, records);

    await refreshCallback();
    assert.strictEqual(refreshExecutions.length, 2);
    assert.deepStrictEqual(
        refreshExecutions[1].argument.projects,
        refreshedRecords,
        'heartbeats must republish freshly refreshed project records'
    );

    refreshShouldThrow = true;
    await refreshCallback();
    assert.strictEqual(refreshExecutions.length, 3, 'heartbeats must still publish cached records when refresh fails');
    assert.deepStrictEqual(refreshExecutions[2].argument.projects, refreshedRecords);
    assert.strictEqual(refreshErrors.length, 1, 'refresh failures must be reported');
    refreshingClient.dispose();
}

function runDashboardBridgeLifecycleChecks() {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    const openProjects = extractFunctionBody(dashboard, 'getOpenProjects');
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
    assert.ok(!dashboard.includes('function publishOpenProjects('));
    assert.ok(!dashboard.includes('function getOpenProjectUri('));
    assert.ok(openProjects.includes('getOpenProjectsFromWorkspace('));
    assert.ok(openProjects.includes('aiSessionProjectHydrationController.hydrate(rawOpenProjects)'));
    assert.ok(dashboard.includes("import OpenWorkspaceBridgeClient from './openWorkspaces/bridgeClient';"));
    assert.ok(dashboard.includes("import { OpenWorkspaceDashboardController } from './openWorkspaces/dashboardController';"));
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
    assert.ok(dashboard.includes("reportDiagnostic: event => logOpenProjectDiagnostic('Workspace', event)"));
    assert.ok(dashboard.includes("reportBridgeDiagnostic: event => logOpenProjectDiagnostic('Bridge', event)"));
    const diagnosticsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'diagnostics.ts'), 'utf8');
    assert.ok(diagnosticsSource.includes("'open-project-diagnostics.jsonl'"));
    assert.ok(dashboard.includes('new DashboardDiagnostics({'));
    assert.ok(!dashboard.includes('function logOpenProjectDiagnostic('));
    assert.ok(dashboard.includes('openWorkspaceController.publish('));
    assert.ok(dashboard.includes('context.subscriptions.push(openWorkspaceBridgeClient);'));
    assert.ok(dashboard.includes('get openProjects() { return getOpenProjects() }'));
    assert.ok(projectedOpenWorkspaces.includes('openWorkspaceDashboardController.getCards()'));
    assert.ok(selectedProjectHandler.includes('getNavigationWorkspace(projectId)'));
    assert.ok(selectedProjectHandler.includes("projectId.startsWith('__openWorkspaceNavigation-')"));
    assert.ok(selectedProjectHandler.includes("'open-workspace-navigation-stale'"));
    assert.strictEqual(selectedProjectHandler.includes('openProjectDashboardController'), false);
    assert.ok(selectedProjectHandler.indexOf('projectService.getProject(projectId)') < selectedProjectHandler.indexOf('getOpenProjects().find'));
    assert.ok(selectedProjectHandler.includes('await projectOpenController.openProject(project, projectOpenType);'));
    assert.ok(dashboard.includes('await projectMutationController.addProject('));
    assert.ok(dashboard.includes('await projectMutationController.saveOpenProject('));
    assert.ok(dashboard.includes('await projectMutationController.editProject('));
    assert.ok(dashboard.includes('await projectMutationController.editProjectColor('));
    assert.ok(dashboard.includes('editProjects: () => projectManualEditController.editProjectsManually()'));
    assert.ok(dashboard.includes('removeProject: () => projectRemovalController.removeProjectPerCommand()'));
    assert.ok(dashboard.includes('removeGroup: () => groupCommandController.removeGroupPerCommand()'));
    assert.ok(projectMutationControllerSource.includes('this.options.prompt.queryProjectFields('));
    assert.ok(projectMutationControllerSource.includes('this.options.prompt.queryGroup('));
    assert.ok(projectMutationControllerSource.includes('this.options.prompt.queryProjectDescription('));
    assert.ok(projectMutationControllerSource.includes('this.options.prompt.queryProjectColor('));
    assert.ok(!selectedProjectHandler.includes('e.uri'));
    assert.ok(!selectedProjectHandler.includes('projectUri'));
    assert.ok(dashboard.includes('vscode.window.onDidChangeWindowState(windowState =>'));
    assert.ok(dashboard.includes('dashboardLifecycleController.handleWindowStateChanged(windowState);'));
    const dashboardLifecycleControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'lifecycleController.ts'), 'utf8');
    assert.ok(dashboardLifecycleControllerSource.includes('if (windowState.focused)'));
    assert.ok(dashboardLifecycleControllerSource.includes('this.options.publishOpenProjects(true);'));
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
    assert.ok(dashboardRuntimeControllerSource.includes('this.options.publishOpenProjects();'));
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

async function runOpenProjectWorkspaceControllerChecks() {
    const fileUri = {
        scheme: 'file',
        fsPath: '/work/shared',
        path: '/work/shared',
        toString: () => 'file:///work/shared',
    };
    const saved = new models.Project('Saved Shared', '/work/shared', 'Saved description');
    saved.color = '#123456';
    let publishInput = null;
    const controller = new OpenProjectWorkspaceController({
        getWorkspaceFile: () => null,
        getWorkspaceFolders: () => [{ uri: fileUri, name: 'shared' }],
        getSavedProjects: () => [saved],
        getCurrentRemoteName: () => undefined,
        isFolderGitRepo: projectPath => projectPath === '/work/shared',
        publishRecords: async (records, followsFocusEvent) => {
            publishInput = { records, followsFocusEvent };
        },
    });

    const rawOpenProjects = controller.getRawOpenProjects();
    assert.strictEqual(rawOpenProjects.length, 1);
    assert.strictEqual(rawOpenProjects[0].id, '__openProjects-0');
    assert.strictEqual(rawOpenProjects[0].name, 'Saved Shared');
    assert.strictEqual(rawOpenProjects[0].description, 'Saved description');
    assert.strictEqual(rawOpenProjects[0].path, '/work/shared');
    assert.strictEqual(rawOpenProjects[0].isGitRepo, true);
    assert.strictEqual(controller.getOpenProjectUri('__openProjects-0'), fileUri);
    assert.strictEqual(controller.getOpenProjectUri('__openProjects-1'), null);

    await controller.publish(true);
    assert.strictEqual(publishInput.followsFocusEvent, true);
    assert.deepStrictEqual(publishInput.records.map(record => ({
        localProjectId: record.localProjectId,
        name: record.name,
        uri: record.uri,
        color: record.color,
    })), [{
        localProjectId: '__openProjects-0',
        name: 'Saved Shared',
        uri: '/work/shared',
        color: '#123456',
    }]);
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

async function runOpenProjectDashboardControllerChecks() {
    const diagnostics = [];
    const posted = [];
    const todoSearchItems = [{
        key: 'todo:open-safety',
        todoId: 'open-safety',
        groupId: 'release',
        title: 'Preserve OPEN catalog',
        groupTitle: 'Release',
        priority: 'high',
        completed: false,
        notesSearchText: 'non-empty OPEN safety fixture',
        searchText: 'preserve open catalog release high non-empty open safety fixture',
    }];
    let nowMs = 3000;
    const controller = new OpenProjectDashboardController({
        getOpenProjects: () => [{
            id: 'project-a',
            name: 'Project A',
            description: 'Current',
            path: '/work/a',
        }],
        getGroups: () => [],
        getTodoSearchItems: () => todoSearchItems,
        getStewardInfos: () => ({
            openProjectsGroupCollapsed: false,
            config: {},
        }),
        getAttentionAggregate: () => ({
            protocolVersion: 1,
            aggregateRevision: '3'.repeat(64),
            generatedAtMs: 1,
            sessions: [],
        }),
        getBridgeInstanceId: () => SELF,
        postMessage: message => {
            posted.push(message);
            return Promise.resolve(true);
        },
        refresh: reason => diagnostics.push(['refresh', reason]),
        isVisible: () => true,
        logDiagnostic: (source, event) => diagnostics.push([source, event]),
        logError: error => { throw new Error(`Unexpected logError: ${error}`); },
        nowMs: () => {
            nowMs += 5;
            return nowMs;
        },
    });

    controller.setAggregate(makeAggregate([makeRegistration(SELF, 4000, '/work/a')]));
    controller.postUpdated();
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].type, 'open-projects-updated');
    assert.deepStrictEqual(posted[0].searchCatalog.todos, todoSearchItems,
        'OPEN incremental updates must preserve the non-empty TODO catalog');
    assert.deepStrictEqual(diagnostics.map(([source, event]) => [source, event.event]), [
        ['Renderer', 'open-project-cards-build'],
        ['Renderer', 'post-update-build'],
        ['Renderer', 'post-update'],
        ['Renderer', 'post-update-result'],
    ]);
    assert.strictEqual(diagnostics[0][1].durationMs, 5);
    assert.strictEqual(diagnostics[0][1].projectCount, 1);
    assert.strictEqual(diagnostics[0][1].cardCount, 1);
    assert.strictEqual(diagnostics[1][1].durationMs, 5);
    assert.strictEqual(diagnostics[1][1].projectCount, 1);

    controller.postUpdated();
    assert.strictEqual(posted.length, 1, 'unchanged open project revisions should not be posted twice');
    assert.strictEqual(diagnostics[diagnostics.length - 1][1].event, 'post-update-skip');

    controller.setAggregate(makeAggregate([makeRegistration(SELF, 5000, '/work/b')], {
        semanticRevision: 'revision-2',
    }));
    controller.postUpdated();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(posted.length, 2, 'changed open project revisions must still be posted');
    assert.notStrictEqual(posted[1].semanticRevision, posted[0].semanticRevision);

    const inFlightPosted = [];
    const inFlightDiagnostics = [];
    let resolveDelivery;
    const inFlightController = new OpenProjectDashboardController({
        getOpenProjects: () => [makeRecord({ uri: '/work/in-flight' })],
        getGroups: () => [],
        getTodoSearchItems: () => todoSearchItems,
        getStewardInfos: () => ({
            openProjectsGroupCollapsed: false,
            config: {},
        }),
        getAttentionAggregate: () => ({
            protocolVersion: 1,
            aggregateRevision: '4'.repeat(64),
            generatedAtMs: 1,
            sessions: [],
        }),
        getBridgeInstanceId: () => SELF,
        postMessage: message => {
            inFlightPosted.push(message);
            return new Promise(resolve => {
                resolveDelivery = resolve;
            });
        },
        refresh: reason => inFlightDiagnostics.push(['refresh', reason]),
        isVisible: () => true,
        logDiagnostic: (source, event) => inFlightDiagnostics.push([source, event]),
        logError: error => { throw new Error(`Unexpected logError: ${error}`); },
        nowMs: () => {
            nowMs += 5;
            return nowMs;
        },
    });
    inFlightController.setAggregate(makeAggregate([makeRegistration(SELF, 4000, '/work/in-flight')], {
        semanticRevision: 'in-flight-revision',
    }));
    inFlightController.postUpdated();
    inFlightController.postUpdated();
    assert.strictEqual(inFlightPosted.length, 1, 'in-flight open project revisions should not be posted twice');
    assert.strictEqual(inFlightDiagnostics[inFlightDiagnostics.length - 1][1].event, 'post-update-skip');
    resolveDelivery(true);
    await new Promise(resolve => setImmediate(resolve));
    inFlightController.postUpdated();
    assert.strictEqual(inFlightPosted.length, 1, 'delivered open project revisions should remain deduped');

    const undeliveredPosted = [];
    const undeliveredDiagnostics = [];
    let undeliveredVisible = true;
    const undeliveredController = new OpenProjectDashboardController({
        getOpenProjects: () => [makeRecord({ uri: '/work/undelivered' })],
        getGroups: () => [],
        getTodoSearchItems: () => todoSearchItems,
        getStewardInfos: () => ({
            openProjectsGroupCollapsed: false,
            config: {},
        }),
        getAttentionAggregate: () => ({
            protocolVersion: 1,
            aggregateRevision: '5'.repeat(64),
            generatedAtMs: 1,
            sessions: [],
        }),
        getBridgeInstanceId: () => SELF,
        postMessage: message => {
            undeliveredPosted.push(message);
            return Promise.resolve(false);
        },
        refresh: reason => undeliveredDiagnostics.push(['refresh', reason]),
        isVisible: () => undeliveredVisible,
        logDiagnostic: (source, event) => undeliveredDiagnostics.push([source, event]),
        logError: error => { throw new Error(`Unexpected logError: ${error}`); },
        nowMs: () => {
            nowMs += 5;
            return nowMs;
        },
    });
    undeliveredController.setAggregate(makeAggregate([makeRegistration(SELF, 4000, '/work/undelivered')], {
        semanticRevision: 'undelivered-revision',
    }));
    undeliveredController.postUpdated();
    undeliveredVisible = false;
    await new Promise(resolve => setImmediate(resolve));
    undeliveredVisible = true;
    undeliveredController.postUpdated();
    assert.strictEqual(undeliveredPosted.length, 2, 'undelivered hidden open project revisions must be retryable');
}

function runOpenProjectIncrementalRenderingChecks() {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    const controllerPath = path.join(__dirname, '..', 'src', 'openWorkspaces', 'dashboardController.ts');
    assert.ok(fs.existsSync(controllerPath));
    const controllerSource = fs.readFileSync(controllerPath, 'utf8');
    assert.ok(controllerSource.includes('export class OpenWorkspaceDashboardController'));
    assert.ok(controllerSource.includes('postUpdated('));
    assert.ok(controllerSource.includes('buildOpenWorkspacesUpdatedMessage'));
    const bridgeCallback = dashboard.slice(
        dashboard.indexOf('openWorkspaceBridgeClient = new OpenWorkspaceBridgeClient('),
        dashboard.indexOf('const activeAiSessionTerminalHighlighter')
    );
    assert.ok(bridgeCallback.includes('postOpenWorkspacesUpdated();'));
    assert.ok(!bridgeCallback.includes('refreshStewardViews();'));

    const content = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'webviewContent.ts'), 'utf8');
    assert.ok(content.includes('export function getOpenWorkspacesGroupContent('));
    assert.ok(content.includes('export function getProjectsPanelContent('));
    assert.ok(content.includes('<div class="sticky-groups-wrapper">'));
    assert.ok(content.includes('session-running'));
    assert.ok(content.includes('openProjectActiveSessionCount'));

    const webviewScript = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'webview', 'webviewProjectScripts.js'),
        'utf8'
    );
    const validHtml = [
        '<div class="open-current-workspace-group"><div class="workspace-card" data-current-workspace data-workspace-scope-identity="scope"></div></div>',
        '<div class="open-other-windows-group"><div class="workspace-card" data-other-workspace data-workspace-navigation-identity="other"></div></div>',
    ].join('');
    const wrapper = { innerHTML: '<div>old</div>' };
    const documentStub = {
        querySelector: selector => {
            if (selector === '.sticky-groups-wrapper') return wrapper;
            if (selector.includes('[data-other-windows-status]')) {
                const status = /data-other-windows-status="([^"]+)"/.exec(wrapper.innerHTML);
                return status ? { getAttribute: () => status[1] } : null;
            }
            return null;
        },
        querySelectorAll: selector => {
            if (selector.includes('[data-current-workspace]'))
                return wrapper.innerHTML.includes('data-current-workspace') ? [{}] : [];
            if (selector.includes('[data-other-workspace]'))
                return wrapper.innerHTML.includes('data-other-workspace') ? [{}] : [];
            if (selector === '.sticky-groups-wrapper .open-other-windows-group') {
                return wrapper.innerHTML.includes('open-other-windows-group') ? [{}] : [];
            }
            return [];
        },
    };
    let catalogReplacements = 0;
    let replacedSearchCatalog = null;
    const applyOpenWorkspacesUpdate = new Function(
        'document',
        'window',
        'normalizeDashboardSearchCatalog',
        `
        var lastAppliedOpenWorkspacesSemanticRevision = null;
        function getOpenWorkspacesUpdateDomState() {${extractFunctionBody(webviewScript, 'getOpenWorkspacesUpdateDomState')}}
        function isOpenWorkspacesUpdateDomConsistent(message) {${extractFunctionBody(webviewScript, 'isOpenWorkspacesUpdateDomConsistent')}}
        return function applyOpenWorkspacesUpdate(message) {${extractFunctionBody(webviewScript, 'applyOpenWorkspacesUpdate')}};
        `
    )(
        documentStub,
        { __projectStewardDashboard: { replaceSearchCatalog: catalog => {
            catalogReplacements += 1;
            replacedSearchCatalog = catalog;
        } } },
        value => value && value.version === 2 && Array.isArray(value.sessions) && Array.isArray(value.openWorkspaces)
            && Array.isArray(value.savedProjects) && Array.isArray(value.todos)
            ? value
            : { sessions: [], openProjects: [], savedProjects: [], todos: [] }
    );
    const catalog = {
        version: 2,
        sessions: [],
        openWorkspaces: [{ current: true }, { current: false }],
        savedProjects: [],
        todos: [{ todoId: 'preserved' }],
    };
    assert.strictEqual(applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated',
        version: 2,
        semanticRevision: 'a'.repeat(64),
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 1,
        otherWindowsStatus: 'ready',
        html: validHtml,
        searchCatalog: catalog,
    }), true);
    assert.strictEqual(wrapper.innerHTML, validHtml);
    assert.strictEqual(catalogReplacements, 1);
    assert.deepStrictEqual(replacedSearchCatalog.todos, [{ todoId: 'preserved' }],
        'OPEN incremental rendering must preserve the non-empty TODO catalog replacement');
    assert.strictEqual(applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated',
        version: 2,
        semanticRevision: 'a'.repeat(64),
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 1,
        otherWindowsStatus: 'ready',
        html: '<div>same semantic update must not replace the DOM</div>',
        searchCatalog: catalog,
    }), true);
    assert.strictEqual(wrapper.innerHTML, validHtml,
        'an already applied workspace semantic revision must not replace the DOM again');
    assert.strictEqual(catalogReplacements, 1,
        'an already applied workspace semantic revision must not replace the search catalog again');
    assert.strictEqual(applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated', version: 2, semanticRevision: 'b'.repeat(64),
        currentWorkspaceCount: 1, navigationWorkspaceCount: 1,
        otherWindowsStatus: 'ready',
        html: '<div class="open-current-workspace-group"><div class="workspace-card" data-current-workspace data-workspace-scope-identity="scope"></div></div>',
        searchCatalog: catalog,
    }), false, 'OPEN WORKSPACES update must reject DOM that loses OTHER WINDOWS cards');
    assert.strictEqual(wrapper.innerHTML, validHtml);
    const updateRequiredCatalog = {
        ...catalog,
        openWorkspaces: [{ current: true }],
    };
    const updateRequiredHtml = [
        '<div class="open-current-workspace-group"><div class="workspace-card" data-current-workspace data-workspace-scope-identity="scope"></div></div>',
        '<div class="open-other-windows-group" data-other-windows-status="update-required"><button data-action="open-bridge-extension"></button></div>',
    ].join('');
    assert.strictEqual(applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated', version: 2, semanticRevision: 'c'.repeat(64),
        currentWorkspaceCount: 1, navigationWorkspaceCount: 0,
        otherWindowsStatus: 'update-required',
        html: updateRequiredHtml,
        searchCatalog: updateRequiredCatalog,
    }), true, 'an actionable update-required state must be accepted without navigation cards');
    assert.strictEqual(wrapper.innerHTML, updateRequiredHtml);
    assert.ok(webviewScript.includes("type: 'open-workspaces-rendered'"));

    const postOpenWorkspacesUpdated = extractFunctionBody(dashboard, 'postOpenWorkspacesUpdated');
    assert.ok(postOpenWorkspacesUpdated.includes('openWorkspaceDashboardController.postUpdated()'));
    const postUpdatedIndex = controllerSource.indexOf('postUpdated()');
    assert.notStrictEqual(postUpdatedIndex, -1);
    const postUpdatedBody = controllerSource.slice(postUpdatedIndex, controllerSource.indexOf('\n    }\n}', postUpdatedIndex));
    assert.ok(postUpdatedBody.includes('this.options.postMessage(message).then('));
    assert.ok(postUpdatedBody.includes('if (!delivered)'));
    assert.ok(postUpdatedBody.includes('if (this.options.isVisible())'));
    assert.ok(postUpdatedBody.includes("this.options.logError('Failed to post OPEN WORKSPACE update message.'"));
    assert.ok(controllerSource.includes('refresh: (reason: string) => void;'));
    assert.ok(postUpdatedBody.includes("this.options.refresh('open-workspace-update-not-delivered');"));
    assert.ok(postUpdatedBody.includes("this.options.refresh('open-workspace-update-post-error');"));
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
        publishOpenProjects: () => publications.push(currentMetadata),
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

async function runStoreChecks() {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-steward-open-projects-'));
    const ownInstanceId = 'b'.repeat(32);
    const instancesDirectory = path.join(tempRoot, 'open-projects', 'v1', 'instances');
    const registration = makeRegistration(ownInstanceId, 900, '/work/owned', {
        sequence: 1,
        leaseUpdatedAtMs: 1000,
    });
    const filePath = path.join(instancesDirectory, `${ownInstanceId}.json`);
    const writeRegistration = async (instanceId, value) => {
        await fs.promises.writeFile(path.join(instancesDirectory, `${instanceId}.json`), `${JSON.stringify(value)}\n`);
    };

    try {
        const oversizedWriteRoot = path.join(tempRoot, 'oversized-write');
        const oversizedWriteStore = new OpenProjectStore(oversizedWriteRoot, ownInstanceId);
        const oversizedWrite = {
            ...registration,
            projects: Array.from({ length: 100 }, (_, ordinal) => makeRecord({
                localProjectId: `oversized-${ordinal}`,
                ordinal,
                description: 'x'.repeat(4000),
                uri: `/work/oversized/${ordinal}`,
            })),
        };
        assert.ok(Buffer.byteLength(`${JSON.stringify(oversizedWrite)}\n`, 'utf8') > 256 * 1024);
        await assert.rejects(oversizedWriteStore.write(oversizedWrite), /256 KiB/);
        assert.deepStrictEqual((await oversizedWriteStore.scan(1200)).registrations, []);
        await assert.rejects(
            fs.promises.access(path.join(oversizedWriteRoot, 'open-projects', 'v1', 'instances')),
            /ENOENT/
        );

        const concurrentRoot = path.join(tempRoot, 'concurrent');
        const concurrentStore = new OpenProjectStore(concurrentRoot, ownInstanceId);
        const originalRename = fs.promises.rename;
        let releaseLowerRename;
        let lowerRenameReachedResolve;
        const lowerRenameReached = new Promise(resolve => {
            lowerRenameReachedResolve = resolve;
        });
        fs.promises.rename = async (source, destination) => {
            const pending = JSON.parse(await fs.promises.readFile(source, 'utf8'));
            if (pending.sequence === 1) {
                lowerRenameReachedResolve();
                await new Promise(resolve => {
                    const fallback = setTimeout(resolve, 100);
                    releaseLowerRename = () => {
                        clearTimeout(fallback);
                        resolve();
                    };
                });
            }
            const result = await originalRename(source, destination);
            if (pending.sequence === 2 && releaseLowerRename) {
                releaseLowerRename();
            }
            return result;
        };
        try {
            const lowerWrite = concurrentStore.write({ ...registration, sequence: 1 });
            await lowerRenameReached;
            const higherWrite = concurrentStore.write({ ...registration, sequence: 2 });
            assert.deepStrictEqual(
                (await Promise.allSettled([lowerWrite, higherWrite])).map(result => result.status),
                ['fulfilled', 'fulfilled']
            );
        } finally {
            fs.promises.rename = originalRename;
        }
        assert.strictEqual((await concurrentStore.read(ownInstanceId, 1200)).sequence, 2);

        fs.promises.rename = async (source, destination) => {
            const pending = JSON.parse(await fs.promises.readFile(source, 'utf8'));
            if (pending.sequence === 4) {
                throw new Error('forced higher write failure');
            }
            return originalRename(source, destination);
        };
        try {
            await assert.rejects(
                concurrentStore.write({ ...registration, sequence: 4 }),
                /forced higher write failure/
            );
        } finally {
            fs.promises.rename = originalRename;
        }
        await concurrentStore.write({ ...registration, sequence: 3 });
        assert.strictEqual((await concurrentStore.read(ownInstanceId, 1200)).sequence, 3);

        const removalRoot = path.join(tempRoot, 'cross-store-removal');
        const producerInstanceId = 'd'.repeat(32);
        const observerInstanceId = 'e'.repeat(32);
        const removalDirectory = path.join(removalRoot, 'open-projects', 'v1', 'instances');
        const producerRegistration = makeRegistration(producerInstanceId, 900, '/work/producer', {
            sequence: 5,
            leaseUpdatedAtMs: 1000,
        });
        const producerStore = new OpenProjectStore(removalRoot, producerInstanceId);
        const observerStore = new OpenProjectStore(removalRoot, observerInstanceId);
        await producerStore.write(producerRegistration);
        assert.deepStrictEqual((await observerStore.scan(1200)).registrations, [producerRegistration]);
        await producerStore.remove(producerInstanceId);
        assert.deepStrictEqual((await observerStore.scan(1200)).registrations, []);
        await fs.promises.writeFile(
            path.join(removalDirectory, `${producerInstanceId}.json`),
            `${JSON.stringify({ ...producerRegistration, sequence: 4, leaseUpdatedAtMs: 1200 })}\n`
        );
        const removedRollback = await observerStore.scan(1200);
        assert.deepStrictEqual(removedRollback.registrations, []);
        assert.strictEqual(removedRollback.counters.rollbackCount, 1);

        const isolationRoot = path.join(tempRoot, 'cache-isolation');
        const isolationDirectory = path.join(isolationRoot, 'open-projects', 'v1', 'instances');
        const isolationInstanceId = 'f'.repeat(32);
        const isolationPath = path.join(isolationDirectory, `${isolationInstanceId}.json`);
        const isolationRegistration = makeRegistration(isolationInstanceId, 900, '/work/isolation', {
            sequence: 10,
            leaseUpdatedAtMs: 1000,
        });
        const isolationStore = new OpenProjectStore(isolationRoot, '0'.repeat(32));
        const assertIsolatedCache = async (counter) => {
            const isolated = await isolationStore.scan(1200);
            assert.deepStrictEqual(isolated.registrations, [isolationRegistration]);
            assert.strictEqual(isolated.counters[counter], 1);
        };
        await fs.promises.mkdir(isolationDirectory, { recursive: true });
        await fs.promises.writeFile(isolationPath, `${JSON.stringify(isolationRegistration)}\n`);
        assert.deepStrictEqual((await isolationStore.scan(1200)).registrations, [isolationRegistration]);

        await fs.promises.writeFile(isolationPath, '{malformed');
        await assertIsolatedCache('parseErrors');

        await fs.promises.writeFile(isolationPath, Buffer.alloc(256 * 1024 + 1));
        await assertIsolatedCache('oversizedFiles');

        const isolationTarget = path.join(isolationRoot, 'symlink-target.json');
        await fs.promises.writeFile(isolationTarget, `${JSON.stringify(isolationRegistration)}\n`);
        await fs.promises.unlink(isolationPath);
        await fs.promises.symlink(isolationTarget, isolationPath);
        await assertIsolatedCache('symlinkFiles');

        await fs.promises.unlink(isolationPath);
        await fs.promises.mkdir(isolationPath);
        await assertIsolatedCache('readErrors');

        await fs.promises.rmdir(isolationPath);
        await fs.promises.writeFile(isolationPath, `${JSON.stringify({
            ...isolationRegistration,
            instanceId: OTHER,
        })}\n`);
        await assertIsolatedCache('parseErrors');

        await fs.promises.writeFile(isolationPath, `${JSON.stringify({
            ...isolationRegistration,
            sequence: 9,
        })}\n`);
        await assertIsolatedCache('rollbackCount');

        const highWaterRoot = path.join(tempRoot, 'high-water');
        const highWaterDirectory = path.join(highWaterRoot, 'open-projects', 'v1', 'instances');
        const highWaterInstanceId = 'c'.repeat(32);
        const highWaterPath = path.join(highWaterDirectory, `${highWaterInstanceId}.json`);
        const highWaterStore = new OpenProjectStore(highWaterRoot, ownInstanceId);
        await fs.promises.mkdir(highWaterDirectory, { recursive: true });
        await fs.promises.writeFile(highWaterPath, `${JSON.stringify(makeRegistration(
            highWaterInstanceId,
            900,
            '/work/high-water',
            { sequence: 5, leaseUpdatedAtMs: 1000 }
        ))}\n`);
        assert.deepStrictEqual((await highWaterStore.scan(1000)).registrations.map(value => value.sequence), [5]);
        assert.deepStrictEqual((await highWaterStore.scan(31_001)).registrations, []);
        await fs.promises.writeFile(highWaterPath, `${JSON.stringify(makeRegistration(
            highWaterInstanceId,
            900,
            '/work/high-water',
            { sequence: 4, leaseUpdatedAtMs: 31_001 }
        ))}\n`);
        const highWaterRollback = await highWaterStore.scan(31_001);
        assert.deepStrictEqual(highWaterRollback.registrations, []);
        assert.strictEqual(highWaterRollback.counters.rollbackCount, 1);

        const store = new OpenProjectStore(tempRoot, ownInstanceId);
        await store.write(registration);
        assert.deepStrictEqual((await store.scan(1200)).registrations, [registration]);
        await assert.rejects(
            store.write({ ...registration, sequence: registration.sequence - 1 }),
            /sequence/
        );
        assert.deepStrictEqual(await store.read(registration.instanceId, 1200), registration);
        assert.strictEqual((await fs.promises.stat(instancesDirectory)).mode & 0o777, 0o700);
        assert.strictEqual((await fs.promises.stat(filePath)).mode & 0o777, 0o600);

        const malformedId = '5'.repeat(32);
        const oversizedId = '6'.repeat(32);
        const symlinkId = '7'.repeat(32);
        const directoryId = '8'.repeat(32);
        const mismatchId = '9'.repeat(32);
        const expiredId = 'a'.repeat(32);

        await fs.promises.writeFile(path.join(instancesDirectory, `${malformedId}.json`), '{not json');
        await fs.promises.writeFile(path.join(instancesDirectory, `${oversizedId}.json`), Buffer.alloc(256 * 1024 + 1));
        await fs.promises.symlink(filePath, path.join(instancesDirectory, `${symlinkId}.json`));
        await fs.promises.mkdir(path.join(instancesDirectory, `${directoryId}.json`));
        await writeRegistration(mismatchId, makeRegistration(OTHER, 900, '/work/mismatch', {
            leaseUpdatedAtMs: 1000,
        }));
        await writeRegistration(ownInstanceId, { ...registration, sequence: 0 });
        await writeRegistration(expiredId, makeRegistration(expiredId, 800, '/work/expired', {
            leaseUpdatedAtMs: 0,
        }));

        const scan = await store.scan(31_000);
        assert.deepStrictEqual(scan.registrations, [registration]);
        assert.deepStrictEqual(scan.counters, {
            active: 1,
            parseErrors: 2,
            oversizedFiles: 1,
            symlinkFiles: 1,
            readErrors: 1,
            rollbackCount: 1,
            expired: 1,
        });
        assert.deepStrictEqual(await store.read(registration.instanceId, 31_000), registration);

        await store.remove(registration.instanceId);
        assert.deepStrictEqual((await store.scan(31_000)).registrations, []);
        assert.strictEqual(await store.read(registration.instanceId, 31_000), undefined);
    } finally {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
}

async function runCoordinatorChecks() {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-steward-open-project-coordinator-'));
    let currentNow = 1000;
    let watcherCallback;
    let watcherClosed = false;
    let intervalCallback;
    let intervalMs;
    let clearedInterval;
    const intervalHandle = { kind: 'coordinator-interval' };
    const delivered = [];
    const diagnostics = [];
    const coordinator = new OpenProjectCoordinator(tempRoot, {
        now: () => currentNow,
        setInterval: (callback, milliseconds) => {
            intervalCallback = callback;
            intervalMs = milliseconds;
            return intervalHandle;
        },
        clearInterval: handle => {
            clearedInterval = handle;
        },
        createWatcher: (directory, callback) => {
            assert.strictEqual(directory, path.join(tempRoot, 'open-projects', 'v1', 'instances'));
            watcherCallback = callback;
            return { close: () => { watcherClosed = true; } };
        },
        deliverAggregate: async aggregate => {
            delivered.push(aggregate);
        },
        reportDiagnostic: event => diagnostics.push(event),
    });
    const observer = new OpenProjectStore(tempRoot, OTHER);

    try {
        assert.strictEqual(intervalMs, 5000);
        assert.strictEqual(typeof watcherCallback, 'function');
        assert.strictEqual(typeof intervalCallback, 'function');

        await assert.rejects(
            coordinator.publish({ ...makePublication(), leaseUpdatedAtMs: 1000 }),
            /unexpected fields/
        );
        assert.deepStrictEqual((await observer.scan(currentNow)).registrations, []);

        await coordinator.publish(makePublication());
        const initialHeartbeat = (await observer.scan(currentNow)).registrations[0];
        assert.strictEqual(initialHeartbeat.lastFocusedAtMs, 0);
        assert.strictEqual(initialHeartbeat.leaseUpdatedAtMs, 1000);
        assert.strictEqual(delivered.length, 1);
        assert.strictEqual(delivered[0].observedAtMs, 1000);
        assert.ok(diagnostics.some(event => event.event === 'publish' && event.instanceId === SELF));
        assert.ok(diagnostics.some(event => event.event === 'scan' && event.registrationCount === 1));
        assert.ok(diagnostics.some(event => event.event === 'deliver' && event.registrationCount === 1));

        currentNow = 2000;
        await coordinator.publish(makePublication({ sequence: 2, followsFocusEvent: true }));
        const firstFocus = (await observer.scan(currentNow)).registrations[0];
        assert.strictEqual(firstFocus.lastFocusedAtMs, 2000);
        assert.strictEqual(firstFocus.leaseUpdatedAtMs, 2000);
        assert.strictEqual(delivered.length, 2);

        currentNow = 3000;
        await coordinator.publish(makePublication({ sequence: 3, followsFocusEvent: false }));
        const heartbeat = (await observer.scan(currentNow)).registrations[0];
        assert.strictEqual(heartbeat.lastFocusedAtMs, 2000);
        assert.strictEqual(heartbeat.leaseUpdatedAtMs, 3000);
        assert.strictEqual(delivered.length, 2);

        await assert.rejects(
            coordinator.publish(makePublication({ instanceId: OLDER, sequence: 4 })),
            /different instanceId/
        );

        currentNow = 4000;
        await coordinator.publish(makePublication({
            sequence: 4,
            projects: [makeRecord({ name: 'Changed' })],
        }));
        assert.strictEqual(delivered.length, 3);

        currentNow = 5000;
        await coordinator.publish(makePublication({
            sequence: 5,
            followsFocusEvent: true,
            projects: [makeRecord({ name: 'Changed' })],
        }));
        assert.strictEqual(delivered.length, 4);
        assert.strictEqual(delivered[3].observedAtMs, 5000);

        currentNow = 36_001;
        intervalCallback();
        let locallyRenewed;
        for (let attempt = 0; attempt < 50; attempt += 1) {
            locallyRenewed = (await observer.scan(currentNow)).registrations[0];
            if (locallyRenewed?.leaseUpdatedAtMs === currentNow
                && diagnostics.some(event => event.event === 'renew' && event.instanceId === SELF)) {
                break;
            }
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.ok(locallyRenewed, 'the local UI Bridge must keep an open window registered');
        assert.strictEqual(locallyRenewed.leaseUpdatedAtMs, currentNow);
        assert.ok(diagnostics.some(event => event.event === 'renew' && event.instanceId === SELF));
        assert.strictEqual(
            delivered.length,
            4,
            'a Bridge-owned lease renewal must not refresh the dashboard'
        );

        currentNow = 37_000;
        await coordinator.unregister({ protocolVersion: 1, instanceId: SELF });
        assert.deepStrictEqual((await observer.scan(currentNow)).registrations, []);
        await assert.rejects(
            coordinator.unregister({ protocolVersion: 1, instanceId: OLDER }),
            /different instanceId/
        );
    } finally {
        coordinator.dispose();
        assert.strictEqual(watcherClosed, true);
        assert.strictEqual(clearedInterval, intervalHandle);
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }

    let releaseFocusWrite;
    let focusWriteEnteredResolve;
    const focusWriteEntered = new Promise(resolve => { focusWriteEnteredResolve = resolve; });
    const focusWriteGate = new Promise(resolve => { releaseFocusWrite = resolve; });
    let mutationQueue = Promise.resolve();
    let persistedRegistration;
    const concurrentStore = {
        write: registration => {
            const write = mutationQueue.then(async () => {
                if (registration.sequence === 1) {
                    focusWriteEnteredResolve();
                    await focusWriteGate;
                }
                persistedRegistration = registration;
            });
            mutationQueue = write.then(() => undefined, () => undefined);
            return write;
        },
        remove: async () => { persistedRegistration = undefined; },
        scan: async () => {
            await mutationQueue;
            return {
                registrations: persistedRegistration ? [persistedRegistration] : [],
                counters: {},
            };
        },
    };
    const concurrentCoordinator = new OpenProjectCoordinator('/unused-concurrent-root', {
        now: () => 1000,
        setInterval: () => 'concurrent-interval',
        clearInterval: () => undefined,
        createWatcher: () => ({ close: () => undefined }),
        deliverAggregate: async () => undefined,
        createStore: () => concurrentStore,
    });
    try {
        const focusPublish = concurrentCoordinator.publish(makePublication({ followsFocusEvent: true }));
        await focusWriteEntered;
        const heartbeatPublish = concurrentCoordinator.publish(makePublication({
            sequence: 2,
            followsFocusEvent: false,
        }));
        await new Promise(resolve => setImmediate(resolve));
        releaseFocusWrite();
        await Promise.all([focusPublish, heartbeatPublish]);
        assert.strictEqual(
            persistedRegistration.lastFocusedAtMs,
            1000,
            'an overlapping heartbeat must preserve the pending focus publication timestamp'
        );
    } finally {
        concurrentCoordinator.dispose();
    }

    let stalledIntervalCallback;
    let stalledRegistration;
    let deliveryEnteredResolve;
    const deliveryEntered = new Promise(resolve => { deliveryEnteredResolve = resolve; });
    const stalledDelivery = new Promise(() => undefined);
    const stalledCoordinator = new OpenProjectCoordinator('/unused-stalled-delivery-root', {
        now: () => currentNow,
        setInterval: callback => {
            stalledIntervalCallback = callback;
            return 'stalled-delivery-interval';
        },
        clearInterval: () => undefined,
        createWatcher: () => ({ close: () => undefined }),
        deliverAggregate: () => {
            deliveryEnteredResolve();
            return stalledDelivery;
        },
        createStore: () => ({
            write: async registration => { stalledRegistration = registration; },
            remove: async () => { stalledRegistration = undefined; },
            scan: async () => ({
                registrations: stalledRegistration ? [stalledRegistration] : [],
                counters: {},
            }),
        }),
    });
    try {
        currentNow = 1000;
        void stalledCoordinator.publish(makePublication());
        await deliveryEntered;

        currentNow = 12_000;
        stalledIntervalCallback();
        for (let attempt = 0; attempt < 50 && stalledRegistration?.leaseUpdatedAtMs !== currentNow; attempt += 1) {
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.strictEqual(
            stalledRegistration.leaseUpdatedAtMs,
            currentNow,
            'a stalled aggregate delivery must not block the local Bridge lease renewal'
        );
    } finally {
        stalledCoordinator.dispose();
    }

    const eventRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-steward-open-project-events-'));
    let eventNow = 1000;
    let fireWatcher;
    let fireInterval;
    let coordinatorStore;
    let scanCalls = 0;
    let blockNextScan = false;
    const scanBlocked = { promise: undefined, resolve: undefined };
    scanBlocked.promise = new Promise(resolve => { scanBlocked.resolve = resolve; });
    const eventDeliveries = [];
    const eventCoordinator = new OpenProjectCoordinator(eventRoot, {
        now: () => eventNow,
        setInterval: callback => {
            fireInterval = callback;
            return 'event-interval';
        },
        clearInterval: () => undefined,
        createWatcher: (_directory, callback) => {
            fireWatcher = callback;
            return { close: () => undefined };
        },
        deliverAggregate: async aggregate => {
            eventDeliveries.push(aggregate);
        },
        createStore: (rootDirectory, instanceId) => {
            coordinatorStore = new OpenProjectStore(rootDirectory, instanceId);
            const originalScan = coordinatorStore.scan.bind(coordinatorStore);
            coordinatorStore.scan = async nowMs => {
                scanCalls += 1;
                if (blockNextScan) {
                    blockNextScan = false;
                    await scanBlocked.promise;
                }
                return originalScan(nowMs);
            };
            return coordinatorStore;
        },
    });

    try {
        await eventCoordinator.publish(makePublication());
        const baselineScans = scanCalls;
        blockNextScan = true;
        const inFlight = eventCoordinator.scanAndDeliver();
        await new Promise(resolve => setImmediate(resolve));
        fireWatcher();
        fireWatcher();
        fireWatcher();
        scanBlocked.resolve();
        await inFlight;
        assert.strictEqual(scanCalls, baselineScans + 2, 'watcher events should coalesce into one follow-up scan');

        const peerStore = new OpenProjectStore(eventRoot, OTHER);
        eventNow = 2000;
        await peerStore.write(makeRegistration(OTHER, 1900, '/work/peer', {
            sequence: 1,
            leaseUpdatedAtMs: 2000,
        }));
        const beforePolling = eventDeliveries.length;
        fireInterval();
        const pollingDeadline = Date.now() + 1000;
        while (eventDeliveries.length === beforePolling && Date.now() < pollingDeadline) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.strictEqual(eventDeliveries.length, beforePolling + 1, 'fallback polling should recover a missed watcher event');
        assert.deepStrictEqual(
            eventDeliveries[eventDeliveries.length - 1].registrations.map(value => value.instanceId),
            [OTHER, SELF]
        );
    } finally {
        eventCoordinator.dispose();
        await fs.promises.rm(eventRoot, { recursive: true, force: true });
    }
}

async function runCoordinatorAggregateBoundaryChecks() {
    const registrations = Array.from({ length: 101 }, (_, index) => makeRegistration(
        index.toString(16).padStart(32, '0'),
        index >= 99 ? 1000 : index,
        `/work/project-${index}`,
        { sequence: index + 1, leaseUpdatedAtMs: 5000 }
    ));
    const expectedInstanceIds = registrations.slice()
        .sort((left, right) => right.lastFocusedAtMs - left.lastFocusedAtMs
            || (left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0))
        .slice(0, 100)
        .map(registration => registration.instanceId);

    const deliverFromScan = async scanRegistrations => {
        const deliveries = [];
        const coordinator = new OpenProjectCoordinator('/unused-bounded-root', {
            now: () => 5000,
            setInterval: () => 'bounded-interval',
            clearInterval: () => undefined,
            createWatcher: () => ({ close: () => undefined }),
            deliverAggregate: async aggregate => { deliveries.push(aggregate); },
            createStore: () => ({
                write: async () => undefined,
                remove: async () => undefined,
                scan: async () => ({ registrations: scanRegistrations, counters: {} }),
            }),
        });
        try {
            await coordinator.publish(makePublication());
            assert.strictEqual(deliveries.length, 1);
            return deliveries[0];
        } finally {
            coordinator.dispose();
        }
    };

    const forwardAggregate = await deliverFromScan(registrations);
    const reverseAggregate = await deliverFromScan(registrations.slice().reverse());
    assert.strictEqual(forwardAggregate.registrations.length, 100);
    assert.deepStrictEqual(protocol.validateOpenProjectAggregate(forwardAggregate), forwardAggregate);
    assert.deepStrictEqual(
        forwardAggregate.registrations.map(registration => registration.instanceId),
        expectedInstanceIds
    );
    assert.deepStrictEqual(reverseAggregate, forwardAggregate);
    assert.ok(forwardAggregate.registrations.some(registration => registration.instanceId === registrations[100].instanceId));
    assert.ok(!forwardAggregate.registrations.some(registration => registration.instanceId === registrations[0].instanceId));

    let fireWatcher;
    let deliveryAttempts = 0;
    const attemptedRevisions = [];
    const successfulDeliveries = [];
    const retryDiagnostics = [];
    const retryCoordinator = new OpenProjectCoordinator('/unused-retry-root', {
        now: () => 6000,
        setInterval: () => 'retry-interval',
        clearInterval: () => undefined,
        createWatcher: (_directory, callback) => {
            fireWatcher = callback;
            return { close: () => undefined };
        },
        deliverAggregate: async aggregate => {
            deliveryAttempts += 1;
            attemptedRevisions.push(aggregate.semanticRevision);
            if (deliveryAttempts === 1) {
                throw new Error('forced aggregate delivery failure');
            }
            successfulDeliveries.push(aggregate);
        },
        reportDiagnostic: event => retryDiagnostics.push(event),
        createStore: () => ({
            write: async () => undefined,
            remove: async () => undefined,
            scan: async () => ({ registrations: [makeRegistration()], counters: {} }),
        }),
    });
    try {
        await assert.rejects(
            retryCoordinator.publish(makePublication()),
            /forced aggregate delivery failure/
        );
        assert.ok(retryDiagnostics.some(event =>
            event.event === 'error'
            && event.operation === 'publish'
            && /forced aggregate delivery failure/.test(event.error)
        ));
        fireWatcher();
        for (let attempt = 0; attempt < 50 && successfulDeliveries.length === 0; attempt += 1) {
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.strictEqual(deliveryAttempts, 2);
        assert.strictEqual(attemptedRevisions[1], attemptedRevisions[0]);
        assert.strictEqual(successfulDeliveries.length, 1);
        assert.deepStrictEqual(
            protocol.validateOpenProjectAggregate(successfulDeliveries[0]),
            successfulDeliveries[0]
        );
    } finally {
        retryCoordinator.dispose();
    }
}

async function runCoordinatorWiringChecks() {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-steward-open-project-wiring-'));
    const registeredCommands = new Map();
    const executedCommands = [];
    const bridgeOutputLines = [];
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
    runProtocolChecks();
    runWorkspaceProtocolV2Checks();
    runWorkspaceContextResolverChecks();
    runIdentityChecks();
    runRecordChecks();
    runWorkspaceControllerRecordChecks();
    runProjectionChecks();
    runWorkspaceProjectionV2Checks();
    runOpenWorkspacePublicationChecks();
    await runOpenWorkspaceStoreChecks();
    await runOpenWorkspaceCoordinatorChecks();
    await runOpenWorkspaceCoordinatorBoundaryChecks();
    await runOpenWorkspaceClientAndControllerChecks();
    await runOpenWorkspaceHardeningChecks();
    await runCurrentProjectDetailsResolverChecks();
    await runProjectOpenControllerChecks();
    runDashboardBridgeLifecycleChecks();
    runOpenWorkspaceProductionCutoverChecks();
    runWebviewRefreshFocusChecks();
    runOpenProjectIncrementalRenderingChecks();
    await runDashboardMigrationPublicationChecks();
    await runCoordinatorWiringChecks();
    console.log('Open project safety checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
