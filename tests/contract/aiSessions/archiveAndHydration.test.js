'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const archive = require('../../../out/aiSessions/archiveBatch');
const { hydrateWorkspaceAiSessions } = require('../../../out/workspaces/sessionHydration');
const { getAttentionProjectKeys } = require('../../../out/aiSessions/attentionProject');

test('PERSIST-BATCH-AI-SESSION-ARCHIVE-001 RUNTIME-AI-SESSION-ARCHIVE-RUNTIME-001 rejects running items and cleans every successful archive side effect', () => {
    const effects = [];
    const running = archive.archiveBatchAiSessionItem('running', {
        isRunning: () => true, archiveSession: () => true,
        deleteEntryMarker: () => effects.push('marker'), untrackTerminal: () => effects.push('terminal'),
        deletePin: () => effects.push('pin'), deleteAlias: () => effects.push('alias'),
    });
    assert.equal(running, 'running');
    assert.deepEqual(effects, []);
    const archived = archive.archiveBatchAiSessionItem('finished', {
        isRunning: () => false, archiveSession: () => true,
        deleteEntryMarker: () => effects.push('marker'), untrackTerminal: () => effects.push('terminal'),
        deletePin: () => effects.push('pin'), deleteAlias: () => effects.push('alias'),
    });
    assert.equal(archived, 'archived');
    assert.deepEqual(effects, ['marker', 'terminal', 'pin', 'alias']);
});

test('PERSIST-BATCH-AI-SESSION-ARCHIVE-HOST-001 emits one terminal completion for bounded validated selection', async () => {
    const completions = [];
    const effects = [];
    const sessions = [{ id: 'a', pinned: true }, { id: 'b' }];
    await archive.executeBatchAiSessionArchiveRequest({ projectId: 'p', provider: 'codex', sessionIds: ['a', 'a', 'missing', 3] }, {
        resolveProject: () => ({ id: 'p', activeAiSessionProvider: 'codex' }),
        getProjectSessions: () => sessions, resolveCurrentSessions: () => sessions,
        confirm: async value => { effects.push(['confirm', value]); return true; },
        archiveSession: id => id === 'a' ? 'archived' : 'failed',
        reportScopeRejected: () => effects.push('scope'), reportSelectionRejected: () => effects.push('selection'),
        reportResult: result => effects.push(['result', result]), logUnexpectedError: () => effects.push('error'),
        postCompletion: value => completions.push(value), refresh: () => effects.push('refresh'),
    });
    assert.equal(completions.length, 1);
    assert.equal(completions[0].status, 'finished');
    assert.deepEqual(completions[0].result.archivedIds, ['a']);
    assert.deepEqual(completions[0].result.rejectedIds, ['missing']);
    assert.equal(completions[0].result.malformedCount, 1);
    assert.equal(effects.filter(item => item === 'refresh').length, 1);
});

test('PERSIST-AI-SESSION-PROJECT-HYDRATION-001 projects assignment, pin, alias, provider availability, and attention without input mutation leaks', () => {
    const workspace = {
        navigationIdentity: 'navigation:fixture',
        scopeIdentity: 'scope:fixture',
        kind: 'singleFolder',
        displayName: 'App',
        navigationUri: 'file:///work/app',
        environment: 'local',
        roots: [{
            id: 'root:fixture', name: 'app', uri: 'file:///work/app',
            hostPath: '/work/app', ordinal: 0,
        }],
    };
    const session = { id: 's', name: 'Original', cwd: '/work/app', updatedAt: '2026-01-01T00:00:00Z' };
    const projectAttentionKey = getAttentionProjectKeys(['file:///work/app'])[0];
    const result = hydrateWorkspaceAiSessions({
        workspace,
        providers: [{ id: 'codex', label: 'Codex' }],
        sessionResults: { codex: { available: true, sessions: [session] } },
        getSessionComparableCwd: (_provider, value) => value.cwd,
        expanded: true,
        pinnedSessions: new Set(['codex:s']),
        aliases: { 'codex:s': 'Alias' },
        attentionAggregate: {
            protocolVersion: 1,
            aggregateRevision: 'a'.repeat(64),
            generatedAtMs: 1,
            sessions: [{
                projectId: projectAttentionKey, sessionKey: 'codex:s',
                reasons: ['completed'], eventIds: ['event'], observedAtMs: 1,
            }],
        },
    });
    assert.equal(result.expanded, true);
    assert.equal(result.activeProvider, 'codex');
    assert.deepEqual(result.sessionsByProvider.codex.map(item => ({
        name: item.name, pinned: item.pinned, attention: item.attention,
    })), [{
        name: 'Alias', pinned: true, attention: { eventId: 'event', reason: 'completed', unread: true },
    }]);
    assert.equal(session.name, 'Original');

    const unavailable = hydrateWorkspaceAiSessions({
        workspace,
        providers: [{ id: 'codex', label: 'Codex' }],
        sessionResults: { codex: { available: false, sessions: [] } },
        getSessionComparableCwd: () => '',
        pinnedSessions: new Set(),
        aliases: {},
    });
    assert.deepEqual(unavailable.unavailableProviders, ['codex']);
    assert.deepEqual(unavailable.sessionsByProvider.codex, []);
});
