'use strict';

const assert = require('assert');
const Module = require('module');

const originalModuleLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {};
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};
const protocol = require('../out/openProjects/protocol');
const projection = require('../out/openProjects/projection');
const models = require('../out/models');
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

function assertRejectsValidation(callback, pattern) {
    assert.throws(callback, pattern);
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
}

runProtocolChecks();
runIdentityChecks();
runRecordChecks();
runProjectionChecks();
console.log('Open project safety checks passed.');
