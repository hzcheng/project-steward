'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const helpers = require('../../../out/aiSessions/sessionHelpers');
const providers = require('../../../out/aiSessions/providers');
const CodexSessionService = require('../../../out/services/codexSessionService').default;
const KimiSessionService = require('../../../out/services/kimiSessionService').default;
const ClaudeSessionService = require('../../../out/services/claudeSessionService').default;

function setEnvironment(t, name, value) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
    });
}

function writeCodexSessionMetaFile(sessionsDir, sessionId, payload) {
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile, `${JSON.stringify({
        timestamp: payload.timestamp,
        type: 'session_meta',
        payload,
    })}\n`, 'utf8');
    return sessionFile;
}

function loadTerminalService() {
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return { window: { terminals: [], createTerminal() {}, showWarningMessage() {} } };
            }
            return previousLoad.call(this, request, parent, isMain);
        };
        delete require.cache[require.resolve('../../../out/aiSessions/terminalService')];
        return require('../../../out/aiSessions/terminalService').default;
    } finally {
        Module._load = previousLoad;
    }
}

test('SESSION-CODEX-SUBAGENT-SESSION-FILTER-001 excludes subagent and headless sessions and rejects their restored terminals', t => {
    const root = makeTempDirectory(t, 'provider-codex-filter-');
    const sessionsDir = path.join(root, 'sessions', '2026', '07', '13');
    const indexedNormalId = '11111111-1111-4111-8111-111111111111';
    const indexedSubagentId = '22222222-2222-4222-8222-222222222222';
    const fileNormalId = '33333333-3333-4333-8333-333333333333';
    const fileSubagentId = '44444444-4444-4444-8444-444444444444';
    const parentOnlyId = '55555555-5555-4555-8555-555555555555';
    const malformedIndexedId = '66666666-6666-4666-8666-666666666666';
    const indexedExecId = '77777777-7777-4777-8777-777777777777';
    const fileExecId = '88888888-8888-4888-8888-888888888888';
    setEnvironment(t, 'CODEX_HOME', root);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const writeMeta = (sessionId, timestamp, extra = {}) => writeCodexSessionMetaFile(
        sessionsDir,
        sessionId,
        { id: sessionId, session_id: sessionId, cwd: '/work/app', timestamp, ...extra }
    );

    writeMeta(indexedNormalId, '2026-07-13T01:00:00.000Z', { source: 'vscode' });
    const indexedSubagentFile = writeMeta(indexedSubagentId, '2026-07-13T02:00:00.000Z', {
        source: { subagent: { thread_spawn: { parent_thread_id: indexedNormalId, depth: 1 } } },
        parent_thread_id: indexedNormalId,
    });
    writeMeta(fileNormalId, '2026-07-13T03:00:00.000Z', { source: 'vscode' });
    const fileSubagentFile = writeMeta(fileSubagentId, '2026-07-13T04:00:00.000Z', {
        source: { subagent: { thread_spawn: { parent_thread_id: indexedNormalId, depth: 1 } } },
        parent_thread_id: indexedNormalId,
    });
    writeMeta(parentOnlyId, '2026-07-13T05:00:00.000Z', {
        source: 'vscode', parent_thread_id: indexedNormalId,
    });
    const indexedExecFile = writeMeta(indexedExecId, '2026-07-13T06:00:00.000Z', {
        source: 'exec', originator: 'codex_exec', thread_source: 'user',
    });
    const fileExecFile = writeMeta(fileExecId, '2026-07-13T07:00:00.000Z', {
        source: 'exec', originator: 'codex_exec', thread_source: 'user',
    });
    fs.writeFileSync(path.join(sessionsDir, `${malformedIndexedId}.jsonl`), 'not-json\n', 'utf8');
    fs.writeFileSync(path.join(root, 'session_index.jsonl'), [
        { id: indexedNormalId, thread_name: 'Parent', updated_at: '2026-07-13T01:00:00.000Z' },
        { id: indexedSubagentId, thread_name: 'Worker', updated_at: '2026-07-13T02:00:00.000Z' },
        { id: malformedIndexedId, thread_name: 'Index fallback', updated_at: '2026-07-13T06:00:00.000Z' },
        { id: indexedExecId, thread_name: 'Headless review', updated_at: '2026-07-13T07:00:00.000Z' },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

    const result = new CodexSessionService().getSessions();
    assert.equal(result.available, true);
    assert.deepEqual(new Set(result.sessions.map(session => session.id)), new Set([
        indexedNormalId, fileNormalId, parentOnlyId, malformedIndexedId,
    ]));
    for (const excludedFile of [indexedSubagentFile, fileSubagentFile, indexedExecFile, fileExecFile]) {
        assert.equal(fs.existsSync(excludedFile), true, 'filtering must not mutate provider files');
    }

    const assignments = helpers.assignAiSessionsToProjects(
        [{ project: { id: 'app' }, path: '/work/app' }],
        result.sessions,
        session => session.cwd
    );
    assert.deepEqual(new Set((assignments.get('app') || []).map(session => session.id)), new Set([
        indexedNormalId, fileNormalId, parentOnlyId,
    ]));

    const AiSessionTerminalService = loadTerminalService();
    const terminalService = new AiSessionTerminalService(
        path.join(root, 'storage'),
        providers.AI_SESSION_PROVIDER_IDS.map(providers.getAiSessionProviderDefinition),
        0
    );
    const restoredSubagent = {
        name: 'Codex restored',
        creationOptions: { env: { PROJECT_STEWARD_CODEX_SESSION_ID: indexedSubagentId } },
    };
    assert.equal(terminalService.resolveTerminalSession(restoredSubagent, () => result.sessions), null);
});

test('SESSION-CODEX-SESSION-ACTIVITY-TIMESTAMP-001 uses the session JSONL mtime as activity advances', t => {
    const root = makeTempDirectory(t, 'provider-codex-activity-');
    const sessionsDir = path.join(root, 'sessions', '2026', '07', '14');
    const sessionId = '77777777-7777-4777-8777-777777777777';
    setEnvironment(t, 'CODEX_HOME', root);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = writeCodexSessionMetaFile(sessionsDir, sessionId, {
        id: sessionId, session_id: sessionId, cwd: '/work/app',
        timestamp: '2026-07-14T01:00:00.000Z', source: 'vscode',
    });
    fs.writeFileSync(path.join(root, 'session_index.jsonl'), `${JSON.stringify({
        id: sessionId, thread_name: 'Active session', updated_at: '2026-07-14T02:00:00.000Z',
    })}\n`, 'utf8');

    const firstActivityAt = new Date('2026-07-14T03:00:00.000Z');
    fs.utimesSync(sessionFile, firstActivityAt, firstActivityAt);
    const service = new CodexSessionService();
    assert.equal(service.getSessions(true).sessions[0].updatedAt, firstActivityAt.toISOString());

    fs.appendFileSync(sessionFile, '{"type":"event"}\n', 'utf8');
    const secondActivityAt = new Date('2026-07-14T04:00:00.000Z');
    fs.utimesSync(sessionFile, secondActivityAt, secondActivityAt);
    assert.equal(service.getSessions(true).sessions[0].updatedAt, secondActivityAt.toISOString());
});

test('PERSIST-CODEX-SESSION-META-CACHE-001 reuses unchanged metadata and index reads, then invalidates each by signature', t => {
    const root = makeTempDirectory(t, 'provider-codex-meta-cache-');
    const sessionsDir = path.join(root, 'sessions', '2026', '07', '16');
    const sessionId = '88888888-8888-4888-8888-888888888888';
    setEnvironment(t, 'CODEX_HOME', root);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = writeCodexSessionMetaFile(sessionsDir, sessionId, {
        id: sessionId, session_id: sessionId, cwd: '/work/app',
        timestamp: '2026-07-16T01:00:00.000Z', source: 'vscode',
    });
    const indexPath = path.join(root, 'session_index.jsonl');
    fs.writeFileSync(indexPath, `${JSON.stringify({
        id: sessionId, thread_name: 'Cached Index', updated_at: '2026-07-16T02:00:00.000Z',
    })}\n`, 'utf8');

    const originalOpenSync = fs.openSync;
    const originalReadFileSync = fs.readFileSync;
    let sessionMetaOpenCount = 0;
    let sessionIndexReadCount = 0;
    fs.openSync = function (filePath) {
        if (filePath === sessionFile) sessionMetaOpenCount++;
        return originalOpenSync.apply(this, arguments);
    };
    fs.readFileSync = function (filePath) {
        if (filePath === indexPath) sessionIndexReadCount++;
        return originalReadFileSync.apply(this, arguments);
    };
    t.after(() => {
        fs.openSync = originalOpenSync;
        fs.readFileSync = originalReadFileSync;
    });

    const service = new CodexSessionService();
    assert.equal(service.getSessions({ forceRefresh: true }).sessions[0].name, 'Cached Index');
    const firstMetaReads = sessionMetaOpenCount;
    const firstIndexReads = sessionIndexReadCount;
    assert.ok(firstMetaReads > 0);
    assert.ok(firstIndexReads > 0);

    assert.equal(service.getSessions({ forceRefresh: true }).sessions[0].id, sessionId);
    assert.equal(sessionMetaOpenCount, firstMetaReads, 'unchanged metadata must stay cached');
    assert.equal(sessionIndexReadCount, firstIndexReads, 'unchanged index must stay cached');

    writeCodexSessionMetaFile(sessionsDir, sessionId, {
        id: sessionId, session_id: sessionId, cwd: '/work/renamed-and-longer',
        timestamp: '2026-07-16T03:00:00.000Z', source: 'vscode',
    });
    assert.equal(service.getSessions({ forceRefresh: true }).sessions[0].cwd, '/work/renamed-and-longer');
    assert.ok(sessionMetaOpenCount > firstMetaReads, 'changed metadata signature must reread disk');

    fs.writeFileSync(indexPath, `${JSON.stringify({
        id: sessionId, thread_name: 'Changed Index Name', updated_at: '2026-07-16T04:00:00.000Z',
    })}\n`, 'utf8');
    assert.equal(service.getSessions({ forceRefresh: true }).sessions[0].name, 'Changed Index Name');
    assert.ok(sessionIndexReadCount > firstIndexReads, 'changed index signature must reread disk');
});

test('SESSION-KIMI-NESTED-SUBAGENT-BOUNDARY-001 discovers only UUID directories at the work-dir session boundary', t => {
    const root = makeTempDirectory(t, 'provider-kimi-subagents-');
    const workDir = '/work/app';
    const sessionId = '77777777-7777-4777-8777-777777777777';
    setEnvironment(t, 'KIMI_SHARE_DIR', root);
    fs.writeFileSync(path.join(root, 'kimi.json'), JSON.stringify({ work_dirs: [{ path: workDir }] }), 'utf8');
    const workDirHash = crypto.createHash('md5').update(workDir, 'utf8').digest('hex');
    const sessionDir = path.join(root, 'sessions', workDirHash, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'wire.jsonl'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'state.json'), '{}', 'utf8');
    const nested = path.join(sessionDir, 'subagents', 'a12345678');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'wire.jsonl'), '{}\n', 'utf8');

    const result = new KimiSessionService().getSessions({ candidatePaths: [workDir] });
    assert.equal(result.available, true);
    assert.deepEqual(result.sessions.map(session => session.id), [sessionId]);
    assert.equal(result.scannedFiles, 1);
});

test('SESSION-CLAUDE-SESSION-001 finds cwd in the middle of a large top-level file and excludes nested subagents', t => {
    const root = makeTempDirectory(t, 'provider-claude-session-');
    const sessionId = '11111111-1111-4111-8111-111111111111';
    setEnvironment(t, 'CLAUDE_HOME', root);
    const sessionDir = path.join(root, 'projects', '-work-app');
    fs.mkdirSync(sessionDir, { recursive: true });
    const fillerLine = `${JSON.stringify({
        type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(4096) },
    })}\n`;
    const cwdLine = `${JSON.stringify({
        sessionId, cwd: '/work/app', timestamp: '2026-01-01T00:00:00.000Z',
    })}\n`;
    fs.writeFileSync(
        path.join(sessionDir, `${sessionId}.jsonl`),
        fillerLine.repeat(40) + cwdLine + fillerLine.repeat(40),
        'utf8'
    );
    const nestedSubagentDir = path.join(sessionDir, sessionId, 'subagents');
    fs.mkdirSync(nestedSubagentDir, { recursive: true });
    fs.writeFileSync(path.join(nestedSubagentDir, 'agent-a1234567890abcdef.jsonl'), cwdLine, 'utf8');

    const result = new ClaudeSessionService().getSessions({ candidatePaths: ['/work/app'] });
    assert.equal(result.available, true);
    assert.deepEqual(result.sessions.map(session => session.id), [sessionId]);
    assert.equal(result.sessions[0].cwd, '/work/app');
    assert.equal(result.scannedFiles, 1);
});
