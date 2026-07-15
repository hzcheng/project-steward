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
const { default: OpenProjectBridgeClient } = require('../out/openProjects/bridgeClient');
const models = require('../out/models');
const { OpenProjectStore } = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openProjectStore');
const { OpenProjectCoordinator } = require('../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openProjectCoordinator');
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
}

function runDashboardBridgeLifecycleChecks() {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    const rawOpenProjects = extractFunctionBody(dashboard, 'getRawOpenProjects');
    const openProjects = extractFunctionBody(dashboard, 'getOpenProjects');
    const refreshAfterMutation = extractFunctionBody(dashboard, 'refreshAfterMutation');
    const showSteward = extractFunctionBody(dashboard, 'showSteward');
    const projectedOpenProjects = extractFunctionBody(dashboard, 'getOpenProjectCards');
    const selectedProjectCase = dashboard.slice(
        dashboard.indexOf("case 'selected-project':"),
        dashboard.indexOf("case 'add-project':")
    );

    assert.ok(rawOpenProjects.includes('getOpenProjectsFromWorkspace('));
    assert.ok(!rawOpenProjects.includes('withAiSessions('));
    assert.ok(openProjects.includes('withAiSessions(getRawOpenProjects())'));
    assert.ok(dashboard.includes("import OpenProjectBridgeClient from './openProjects/bridgeClient';"));
    assert.ok(dashboard.includes("import { createOpenProjectRecords, projectOpenProjectCards } from './openProjects/projection';"));
    assert.ok(dashboard.includes('let openProjectAggregate: OpenProjectAggregate | null = null;'));
    assert.ok(dashboard.includes('new OpenProjectBridgeClient('));
    assert.ok(dashboard.includes("reportDiagnostic: event => logOpenProjectDiagnostic('Workspace', event)"));
    assert.ok(dashboard.includes("reportBridgeDiagnostic: event => logOpenProjectDiagnostic('Bridge', event)"));
    assert.ok(dashboard.includes("'open-project-diagnostics.jsonl'"));
    assert.ok(dashboard.includes('function logOpenProjectDiagnostic('));
    assert.ok(dashboard.includes('createOpenProjectRecords(getRawOpenProjects())'));
    assert.ok(dashboard.includes('context.subscriptions.push(openProjectBridgeClient);'));
    assert.ok(dashboard.includes('get openProjects() { return getOpenProjectCards() }'));
    assert.ok(projectedOpenProjects.includes('projectOpenProjectCards(getOpenProjects(), openProjectAggregate, openProjectBridgeClient.instanceId)'));
    assert.ok(projectedOpenProjects.includes("card.openProjectCardKind === 'projectNavigation'"));
    assert.ok(projectedOpenProjects.includes('openProjectNavigationCardsById = new Map('));
    assert.ok(selectedProjectCase.includes('getOpenProjectCards();'));
    assert.ok(selectedProjectCase.includes('openProjectNavigationCardsById.get(projectId)'));
    assert.ok(selectedProjectCase.indexOf('projectService.getProject(projectId)') < selectedProjectCase.indexOf('getOpenProjects().find'));
    assert.ok(selectedProjectCase.indexOf('getOpenProjects().find') < selectedProjectCase.indexOf('openProjectNavigationCardsById.get(projectId)'));
    assert.ok(selectedProjectCase.includes('await openProject(project, isProjectNavigation ? ProjectOpenType.Default : projectOpenType);'));
    assert.ok(!selectedProjectCase.includes('e.uri'));
    assert.ok(!selectedProjectCase.includes('projectUri'));
    assert.ok(dashboard.includes('vscode.window.onDidChangeWindowState(windowState =>'));
    assert.ok(dashboard.includes('if (windowState.focused)'));
    assert.ok(dashboard.includes('publishOpenProjects(true);'));
    assert.ok(
        refreshAfterMutation.includes('publishOpenProjects();'),
        'saved project metadata mutations must republish even when configuration storage is disabled'
    );
    assert.ok(
        showSteward.includes('publishOpenProjects();'),
        'legacy metadata mutation paths that reveal the steward must also republish'
    );
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

function runOpenProjectIncrementalRenderingChecks() {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    const bridgeCallback = dashboard.slice(
        dashboard.indexOf('const openProjectBridgeClient = new OpenProjectBridgeClient('),
        dashboard.indexOf('const activeAiSessionTerminalHighlighter')
    );
    assert.ok(bridgeCallback.includes('postOpenProjectsUpdated();'));
    assert.ok(!bridgeCallback.includes('refreshStewardViews();'));

    const content = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'webviewContent.ts'), 'utf8');
    assert.ok(content.includes('export function getOpenProjectsGroupContent('));
    assert.ok(content.includes('export function getProjectsPanelContent('));
    assert.ok(content.includes('<div class="sticky-groups-wrapper">'));

    const webviewScript = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'webview', 'webviewProjectScripts.js'),
        'utf8'
    );
    const wrapper = { innerHTML: '<div>old</div>' };
    let catalogReplacements = 0;
    const applyOpenProjectsUpdate = new Function(
        'document',
        'window',
        'normalizeDashboardSearchCatalog',
        `return function applyOpenProjectsUpdate(message) {${extractFunctionBody(webviewScript, 'applyOpenProjectsUpdate')}};`
    )(
        { querySelector: selector => selector === '.sticky-groups-wrapper' ? wrapper : null },
        { __projectStewardDashboard: { replaceSearchCatalog: () => { catalogReplacements += 1; } } },
        value => value && Array.isArray(value.sessions) && Array.isArray(value.openProjects) && Array.isArray(value.savedProjects)
            ? value
            : { sessions: [], openProjects: [], savedProjects: [] }
    );
    assert.strictEqual(applyOpenProjectsUpdate({
        type: 'open-projects-updated',
        version: 1,
        semanticRevision: 'revision-2',
        projectCount: 3,
        html: '<div data-group-id="__openProjects">new</div>',
        searchCatalog: { sessions: [], openProjects: [], savedProjects: [] },
    }), true);
    assert.strictEqual(wrapper.innerHTML, '<div data-group-id="__openProjects">new</div>');
    assert.strictEqual(catalogReplacements, 1);
    assert.strictEqual(applyOpenProjectsUpdate({ version: 2, html: '<div>bad</div>' }), false);
    assert.strictEqual(wrapper.innerHTML, '<div data-group-id="__openProjects">new</div>');
    assert.ok(webviewScript.includes("type: 'open-projects-rendered'"));
}

async function runDashboardMigrationPublicationChecks() {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    const checkDataMigrationBody = extractFunctionBody(dashboard, 'checkDataMigration');
    const publications = [];
    const informationMessages = [];
    let currentMetadata = 'before-migration';
    let migrated = true;
    let showStewardCalls = 0;
    const checkDataMigration = new Function(
        'projectService',
        'publishOpenProjects',
        'vscode',
        'showSteward',
        `return async function checkDataMigration(openStewardAfterMigrate = false) {${checkDataMigrationBody}};`
    )(
        {
            migrateDataIfNeeded: async () => {
                if (migrated) {
                    currentMetadata = 'after-migration';
                }
                return migrated;
            },
        },
        () => publications.push(currentMetadata),
        { window: { showInformationMessage: message => informationMessages.push(message) } },
        () => { showStewardCalls += 1; }
    );

    await checkDataMigration();
    assert.deepStrictEqual(publications, ['after-migration']);
    assert.strictEqual(showStewardCalls, 0, 'default startup migration must not require revealing the steward');
    assert.strictEqual(informationMessages.length, 1);

    migrated = false;
    currentMetadata = 'unchanged-without-migration';
    await checkDataMigration();
    assert.deepStrictEqual(publications, ['after-migration'], 'no migration must not trigger a redundant publish');

    migrated = true;
    currentMetadata = 'before-explicit-migration';
    await checkDataMigration(true);
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
            if (locallyRenewed?.leaseUpdatedAtMs === currentNow) {
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
        for (let attempt = 0; attempt < 50 && eventDeliveries.length === beforePolling; attempt += 1) {
            await new Promise(resolve => setImmediate(resolve));
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
        workspace: { workspaceFolders: [] },
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
        const publish = registeredCommands.get('_projectStewardOpenProjects.bridge.publish');
        const unregister = registeredCommands.get('_projectStewardOpenProjects.bridge.unregister');
        assert.strictEqual(typeof publish, 'function');
        assert.strictEqual(typeof unregister, 'function');

        await publish(makePublication({ followsFocusEvent: true }));
        const aggregateDelivery = executedCommands.filter(
            value => value.command === '_projectStewardOpenProjects.workspace.aggregate'
        ).pop();
        assert.ok(aggregateDelivery, 'production wiring should deliver an open-project aggregate');
        assert.strictEqual(aggregateDelivery.argument.registrations[0].instanceId, SELF);
        assert.ok(bridgeOutputLines.some(line =>
            line.startsWith('[OpenProjects] ')
            && line.includes('"event":"publish"')
            && line.includes(SELF)
        ));
        assert.ok(executedCommands.some(value =>
            value.command === '_projectStewardOpenProjects.workspace.diagnostic'
            && value.argument.event === 'publish'
        ));
        await unregister({ protocolVersion: 1, instanceId: SELF });
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
    runIdentityChecks();
    runRecordChecks();
    runProjectionChecks();
    await runBridgeClientChecks();
    runDashboardBridgeLifecycleChecks();
    runWebviewRefreshFocusChecks();
    runOpenProjectIncrementalRenderingChecks();
    await runDashboardMigrationPublicationChecks();
    await runStoreChecks();
    await runCoordinatorChecks();
    await runCoordinatorAggregateBoundaryChecks();
    await runCoordinatorWiringChecks();
    console.log('Open project safety checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
