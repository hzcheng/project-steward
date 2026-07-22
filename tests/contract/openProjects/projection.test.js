'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ProjectRemoteType } = require('../../../out/models');
const {
    getAttentionProjectKey,
    withAttentionProjects,
} = require('../../../out/aiSessions/attentionProject');
const {
    createOpenProjectRecords,
    normalizeOpenProjectIdentity,
    projectOpenProjectCards,
} = require('../../../out/openProjects/projection');
const {
    replaceOpenProjectPublicationUris,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openProjectPublication');
const {
    NEWER,
    OLDER,
    OTHER,
    SELF,
    makeAggregate,
    makePublication,
    makeRecord,
    makeRegistration,
} = require('./helpers');

test('OPEN-OPEN-PROJECT-PUBLICATION-001 replaces workspace URIs by ordinal without mutating publications', () => {
    const publication = makePublication({
        projects: [makeRecord({
            uri: 'vscode-remote://dev-container%2Bcurrent/workspaces/app',
            remoteType: 'devContainer',
        })],
    });
    const exactWindowUri = 'vscode-remote://dev-container%2Btarget%40ssh-remote%2Bhost/workspaces/app';

    const replaced = replaceOpenProjectPublicationUris(publication, [exactWindowUri]);

    assert.equal(replaced.projects[0].uri, exactWindowUri);
    assert.equal(publication.projects[0].uri, 'vscode-remote://dev-container%2Bcurrent/workspaces/app');
    assert.deepEqual(replaceOpenProjectPublicationUris(publication, []), publication);
});

test('SESSION-IDENTITY-001 normalizes only representational separators and encoded URI plus signs', () => {
    assert.equal(normalizeOpenProjectIdentity('/work/shared/'), '/work/shared');
    assert.equal(normalizeOpenProjectIdentity('C:\\work\\shared\\'), 'C:/work/shared');
    assert.equal(
        normalizeOpenProjectIdentity('vscode-remote://ssh-remote%2Bone/work/shared/'),
        'vscode-remote://ssh-remote+one/work/shared'
    );
    assert.notEqual(
        normalizeOpenProjectIdentity('vscode-remote://ssh-remote+one/work/shared'),
        normalizeOpenProjectIdentity('vscode-remote://ssh-remote+two/work/shared')
    );
    assert.notEqual(normalizeOpenProjectIdentity('/work/project '), normalizeOpenProjectIdentity('/work/project'));
});

test('SESSION-RECORD-001 converts project metadata and includes only positive active-session counts', () => {
    const records = createOpenProjectRecords([{
        id: 'local',
        name: 'Local',
        description: 'Folder',
        path: '/local',
        remoteType: ProjectRemoteType.None,
        color: '#111',
    }, {
        id: 'ssh',
        name: 'SSH',
        description: '',
        path: 'vscode-remote://ssh-remote+host/ssh',
        remoteType: ProjectRemoteType.SSH,
    }, {
        id: 'container',
        name: 'Container',
        description: '',
        path: 'vscode-remote://dev-container+abc/container',
        remoteType: ProjectRemoteType.DevContainer,
    }], new Map([['local', 0], ['ssh', 2]]));

    assert.deepEqual(records.map(record => record.remoteType), ['local', 'ssh', 'devContainer']);
    assert.deepEqual(records.map(record => record.ordinal), [0, 1, 2]);
    assert.equal(records[0].color, '#111');
    assert.equal(records[0].activeSessionCount, undefined);
    assert.equal(records[1].activeSessionCount, 2);
    assert.equal(records[2].activeSessionCount, undefined);
});

test('PROJECT-PROJECTION-001 OPEN-OPEN-PROJECT-RUNTIME-IDENTITY-001 keeps current cards, excludes own and current identities, and picks the focused duplicate', () => {
    const current = [{
        id: '__openProjects-0',
        name: 'Current',
        description: 'Workspace folder',
        path: '/work/current/',
        codexSessions: [{ id: 'current-session' }],
    }];
    const aggregate = makeAggregate([
        makeRegistration(SELF, 5000, '/work/self'),
        makeRegistration(OLDER, 2000, '/work/current'),
        makeRegistration(OLDER, 2000, '/work/shared/'),
        makeRegistration(NEWER, 3000, '/work/shared'),
        makeRegistration(OTHER, 2500, '/work/running', {
            projects: [makeRecord({ name: 'Running', uri: '/work/running', activeSessionCount: 3 })],
        }),
    ]);

    const cards = projectOpenProjectCards(current, aggregate, SELF);

    assert.deepEqual(cards.map(card => card.name), ['Current', 'Shared', 'Running']);
    assert.equal(cards[0].openProjectCardKind, 'current');
    assert.equal(cards[0].codexSessions[0].id, 'current-session');
    assert.notEqual(cards[0], current[0]);
    assert.equal(cards[1].openProjectSourceInstanceId, NEWER);
    assert.equal(cards[2].openProjectActiveSessionCount, 3);
    assert.match(cards[1].id, /^__openProjectNavigation-[a-f0-9]{24}$/);
});

test('ATTENTION-REMOTE-ATTENTION-IDENTITY-001 derives attention identity from the exact remote URI', () => {
    const localPath = '/workspaces/shared';
    const remoteUri = 'vscode-remote://dev-container%2Btarget/workspaces/shared';
    const replaced = replaceOpenProjectPublicationUris(makePublication({
        projects: [makeRecord({ uri: localPath, remoteType: 'devContainer' })],
    }), [remoteUri]);
    const cards = projectOpenProjectCards([], makeAggregate([
        makeRegistration(OTHER, 4000, remoteUri, { projects: replaced.projects }),
    ]), SELF);

    const annotated = withAttentionProjects(cards, {
        protocolVersion: 1,
        aggregateRevision: 'a'.repeat(64),
        generatedAtMs: 10,
        sessions: [{
            projectId: getAttentionProjectKey(localPath),
            sessionKey: 'codex:019f7d85-3b51-7b82-8590-02409fcdffcd',
            eventIds: ['event-remote'],
            reasons: ['completed'],
            observedAtMs: 9,
        }],
    });

    assert.equal(annotated[0].path, remoteUri);
    assert.equal(annotated[0].aiSessionAttentionCount, 1);
});
