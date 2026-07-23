'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    getAttentionProjectKeys,
} = require('../../../out/aiSessions/attentionProject');
const {
    createOpenWorkspacePublication,
    projectOpenWorkspaceCards,
} = require('../../../out/openWorkspaces/projection');
const { normalizeWorkspaceUri } = require('../../../out/workspaces/identity');
const {
    replaceOpenWorkspacePublicationUris,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspacePublication');
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
        workspace: makeRecord({
            uri: 'vscode-remote://dev-container%2Bcurrent/workspaces/app',
            remoteType: 'devContainer',
        }),
    });
    const exactWindowUri = 'vscode-remote://dev-container%2Btarget%40ssh-remote%2Bhost/workspaces/app';

    const replaced = replaceOpenWorkspacePublicationUris(publication, null, [exactWindowUri]);

    assert.equal(replaced.workspace.roots[0].uri, exactWindowUri);
    assert.equal(publication.workspace.roots[0].uri, 'vscode-remote://dev-container%2Bcurrent/workspaces/app');
    assert.deepEqual(replaceOpenWorkspacePublicationUris(publication, null, [publication.workspace.roots[0].uri]), publication);
});

test('SESSION-IDENTITY-001 normalizes URI scheme and Unicode representation without erasing authority identity', () => {
    assert.equal(
        normalizeWorkspaceUri({ scheme: 'FILE', authority: '', path: '/work/cafe\u0301' }),
        normalizeWorkspaceUri({ scheme: 'file', authority: '', path: '/work/café' })
    );
    assert.notEqual(
        normalizeWorkspaceUri({ scheme: 'vscode-remote', authority: 'ssh-remote+one', path: '/work/shared' }),
        normalizeWorkspaceUri({ scheme: 'vscode-remote', authority: 'ssh-remote+two', path: '/work/shared' })
    );
    assert.notEqual(
        normalizeWorkspaceUri({ scheme: 'file', authority: '', path: '/work/project ' }),
        normalizeWorkspaceUri({ scheme: 'file', authority: '', path: '/work/project' })
    );
});

test('SESSION-RECORD-001 converts workspace metadata and carries the exact running-session count', () => {
    const workspace = {
        navigationIdentity: 'a'.repeat(64), scopeIdentity: 'b'.repeat(64),
        kind: 'savedMultiRoot', displayName: 'Workspace', navigationUri: 'file:///work/all.code-workspace',
        environment: 'local', roots: [
            { id: 'c'.repeat(64), name: 'App', uri: 'file:///work/app', hostPath: '/work/app', ordinal: 0 },
            { id: 'd'.repeat(64), name: 'API', uri: 'file:///work/api', hostPath: '/work/api', ordinal: 1 },
        ],
    };
    const record = createOpenWorkspacePublication(workspace, 2);
    assert.equal(record.runningAiSessionCount, 2);
    assert.deepEqual(record.roots.map(root => [root.name, root.ordinal]), [['App', 0], ['API', 1]]);
    assert.equal(createOpenWorkspacePublication(null, 2), null);
});

test('PROJECT-PROJECTION-001 keeps current cards, excludes own and current identities, and picks the focused duplicate', () => {
    const current = makeRecord({ uri: '/work/current' });
    const sharedIdentity = makeRecord({ uri: '/work/shared' }).navigationIdentity;
    const aggregate = makeAggregate([
        makeRegistration(SELF, 5000, '/work/self'),
        makeRegistration(OLDER, 2000, '/work/current'),
        makeRegistration(OLDER, 2000, '/work/shared/', {
            workspace: makeRecord({ uri: '/work/shared/', navigationIdentity: sharedIdentity, name: 'Older Shared' }),
        }),
        makeRegistration(NEWER, 3000, '/work/shared', {
            workspace: makeRecord({ uri: '/work/shared', navigationIdentity: sharedIdentity }),
        }),
        makeRegistration(OTHER, 2500, '/work/running', {
            projects: [makeRecord({ name: 'Running', uri: '/work/running', activeSessionCount: 3 })],
        }),
    ]);

    const cards = projectOpenWorkspaceCards(current, aggregate, SELF);

    assert.deepEqual(cards.map(card => card.name), ['Shared', 'Running']);
    assert.equal(cards[0].kind, 'navigation');
    assert.equal(cards[0].runningSessionCount, 0);
    assert.equal(cards[1].runningSessionCount, 3);
    assert.match(cards[0].id, /^__openWorkspaceNavigation-[a-f0-9]{24}$/);
});

test('OPEN-OTHER-WINDOWS-PRIVACY-001 exposes only the latest privacy-bounded workspace summary', () => {
    const current = makeRecord({ uri: '/work/current' });
    const sharedIdentity = makeRecord({ uri: '/work/shared' }).navigationIdentity;
    const latest = makeRecord({
        uri: '/work/shared',
        navigationIdentity: sharedIdentity,
        name: 'Latest Shared',
        activeSessionCount: 2,
        providerId: 'codex',
        sessionId: 'secret-session',
        sessionName: 'Secret title',
        cwd: '/private/cwd',
        markerPath: '/private/marker',
    });
    const attention = {
        protocolVersion: 1,
        aggregateRevision: 'b'.repeat(64),
        generatedAtMs: 20,
        sessions: [{
            projectId: getAttentionProjectKeys(latest.roots.map(root => root.uri))[0],
            sessionKey: 'codex:secret-session',
            eventIds: ['attention-event'],
            reasons: ['completed'],
            observedAtMs: 19,
        }],
    };
    const cards = projectOpenWorkspaceCards(current, makeAggregate([
        makeRegistration(SELF, 9000, '/work/own', {
            workspace: makeRecord({ uri: '/work/own', name: 'Own instance' }),
        }),
        makeRegistration(OLDER, 8000, '/work/current', {
            workspace: makeRecord({
                uri: '/work/current',
                navigationIdentity: current.navigationIdentity,
                name: 'Current duplicate',
            }),
        }),
        makeRegistration(OLDER, 1000, '/work/shared', {
            workspace: makeRecord({
                uri: '/work/shared',
                navigationIdentity: sharedIdentity,
                name: 'Older Shared',
            }),
        }),
        makeRegistration(NEWER, 2000, '/work/shared', {
            workspace: latest,
            providerId: 'claude',
            sessionId: 'registration-secret',
        }),
    ]), SELF, attention);

    assert.equal(cards.length, 1);
    assert.equal(cards[0].name, 'Latest Shared');
    assert.equal(cards[0].runningSessionCount, 2);
    assert.equal(cards[0].attentionCount, 1);
    assert.deepEqual(Object.keys(cards[0]).sort(), [
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
    const forbiddenKeys = new Set([
        'providerId', 'sessionId', 'sessionName', 'sessionTitle', 'cwd', 'markerPath',
    ]);
    function assertPrivacyBounded(value) {
        if (!value || typeof value !== 'object') return;
        for (const [key, nested] of Object.entries(value)) {
            assert.equal(forbiddenKeys.has(key), false, `forbidden OTHER WINDOWS key: ${key}`);
            assertPrivacyBounded(nested);
        }
    }
    assertPrivacyBounded(cards[0]);
    assert.equal(JSON.stringify(cards[0]).includes('Secret title'), false);
    assert.equal(JSON.stringify(cards[0]).includes('/private/'), false);
});

test('ATTENTION-REMOTE-ATTENTION-IDENTITY-001 derives attention identity from the exact remote URI', () => {
    const localPath = '/workspaces/shared';
    const remoteUri = 'vscode-remote://dev-container%2Btarget/workspaces/shared';
    const replaced = replaceOpenWorkspacePublicationUris(makePublication({
        workspace: makeRecord({ uri: localPath, remoteType: 'devContainer' }),
    }), null, [remoteUri]);
    const attention = {
        protocolVersion: 1,
        aggregateRevision: 'a'.repeat(64),
        generatedAtMs: 10,
        sessions: [{
            projectId: getAttentionProjectKeys([remoteUri])[0],
            sessionKey: 'codex:019f7d85-3b51-7b82-8590-02409fcdffcd',
            eventIds: ['event-remote'],
            reasons: ['completed'],
            observedAtMs: 9,
        }],
    };
    const cards = projectOpenWorkspaceCards(null, makeAggregate([
        makeRegistration(OTHER, 4000, remoteUri, { workspace: replaced.workspace }),
    ]), SELF, attention);

    assert.equal(cards[0].attentionCount, 1);
});
