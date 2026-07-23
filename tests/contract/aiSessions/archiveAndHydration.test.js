'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const archive = require('../../../out/aiSessions/archiveBatch');
const { hydrateOpenProjectsWithAiSessions } = require('../../../out/aiSessions/projectHydration');
const { getAttentionProjectKey, getAttentionSessionLookupKey } = require('../../../out/aiSessions/attentionProject');

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
    const project = { id: 'p', path: '/work/app' };
    const session = { id: 's', name: 'Original', cwd: '/work/app', updatedAt: '2026-01-01T00:00:00Z' };
    const projectAttentionKey = getAttentionProjectKey(project.path);
    const attentionKey = getAttentionSessionLookupKey(projectAttentionKey, 'codex:s');
    const result = hydrateOpenProjectsWithAiSessions({
        projects: [project],
        providers: [{ id: 'codex', projectSessionsKey: 'codexSessions', projectSessionsUnavailableKey: 'codexUnavailable' }],
        sessionResults: { codex: { available: true, sessions: [session] } },
        assignments: { codex: new Map([['p', [session]]]) }, expandedProjects: new Set(['/work/app']),
        activeProviders: {}, pinnedSessions: new Set(['codex:s']), aliases: { 'codex:s': 'Alias' },
        aggregateByProjectAndSession: new Map([[attentionKey, {
            projectId: projectAttentionKey, sessionKey: 'codex:s', reasons: ['completed'], eventIds: ['event'], observedAtMs: 1,
        }]]),
        localAttentionBySession: {}, includeLocalAttention: false, getProjectKey: value => value.path,
    });
    assert.equal(result[0].codexSessionsExpanded, true);
    assert.equal(result[0].activeAiSessionProvider, 'codex');
    assert.deepEqual(result[0].codexSessions.map(item => ({ name: item.name, pinned: item.pinned, attention: item.attention })), [{
        name: 'Alias', pinned: true, attention: { eventId: 'event', reason: 'completed', unread: true },
    }]);
    assert.equal(session.name, 'Original');

    const unavailable = hydrateOpenProjectsWithAiSessions({
        projects: [{ id: 'empty', path: '/empty' }],
        providers: [{ id: 'codex', projectSessionsKey: 'codexSessions', projectSessionsUnavailableKey: 'codexUnavailable' }],
        sessionResults: { codex: { available: false, sessions: [] } }, assignments: { codex: new Map() },
        expandedProjects: new Set(), activeProviders: {}, pinnedSessions: new Set(), aliases: {},
        aggregateByProjectAndSession: new Map(), localAttentionBySession: {}, includeLocalAttention: true,
        getProjectKey: value => value.path,
    });
    assert.equal(unavailable[0].codexUnavailable, true);
    assert.deepEqual(unavailable[0].codexSessions, []);
});
