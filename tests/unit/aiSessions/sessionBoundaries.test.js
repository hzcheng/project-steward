'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const helpers = require('../../../out/aiSessions/sessionHelpers');
const { getAiSessionScanMaxFiles } = require('../../../out/aiSessions/scanOptions');
const { isCommandAvailableOnPath } = require('../../../out/aiSessions/providerAvailability');
const previousLoad = Module._load;
let candidates;
let sessionPaths;
let pending;
let resolver;
let sessionHydration;
let sessionScope;
let getUsableTerminalCwd;
try {
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return { Uri: {
            parse(value) {
                const match = String(value).match(/^([^:]+):\/\/([^/]*)(\/.*)$/);
                return match
                    ? { scheme: match[1], authority: match[2], path: match[3], fsPath: match[3], toString: () => value }
                    : { scheme: 'file', authority: '', path: value, fsPath: value, toString: () => value };
            },
        } };
        return previousLoad.call(this, request, parent, isMain);
    };
    candidates = require('../../../out/aiSessions/projectCandidates');
    sessionPaths = require('../../../out/aiSessions/sessionPaths');
    pending = require('../../../out/aiSessions/pendingTerminals');
    resolver = require('../../../out/aiSessions/pendingTerminalResolver');
    sessionHydration = require('../../../out/workspaces/sessionHydration');
    sessionScope = require('../../../out/workspaces/sessionScope');
    ({ getUsableTerminalCwd } = require('../../../out/aiSessions/terminalCwd'));
} finally {
    Module._load = previousLoad;
}

const providers = [
    { id: 'codex', terminalNamePrefix: 'Codex', projectSessionsKey: 'codexSessions', terminalCwdFields: ['cwd'] },
    { id: 'kimi', terminalNamePrefix: 'Kimi', projectSessionsKey: 'kimiSessions', terminalCwdFields: ['workDir', 'cwd'] },
];

test('PROJECT-ASSIGNMENT-001 assigns a session only to its deepest matching project', () => {
    const result = helpers.assignAiSessionsToProjects([
        { project: { id: 'root' }, path: '/work' },
        { project: { id: 'app' }, path: '/work/app' },
    ], [{ id: 'one', cwd: '/work/app/src' }, { id: 'outside', cwd: '/elsewhere' }], item => item.cwd);
    assert.deepEqual([...result.keys()], ['app']);
    assert.deepEqual(result.get('app').map(item => item.id), ['one']);
});

test('PROJECT-CANDIDATE-FILTER-001 normalizes duplicate roots and excludes sessions outside them', () => {
    assert.deepEqual(helpers.normalizeAiSessionCandidatePaths(['/work/app/', '/work/app', '']), ['/work/app']);
    const source = { available: true, sessions: [{ id: 'in', cwd: '/work/app/src' }, { id: 'out', cwd: '/other' }] };
    assert.deepEqual(helpers.filterAiSessionsByCandidatePaths(source, ['/work/app'], item => item.cwd).sessions.map(item => item.id), ['in']);
    assert.equal(helpers.filterAiSessionsByCandidatePaths(source, [], item => item.cwd), source);
});

test('PROJECT-PROJECT-CANDIDATE-001 exposes stable workspace-root candidate paths', () => {
    const workspace = {
        navigationIdentity: 'navigation:fixture', scopeIdentity: 'scope:fixture',
        kind: 'savedMultiRoot', displayName: 'Fixture', navigationUri: 'file:///work/fixture.code-workspace',
        environment: 'local', roots: [
            { id: 'local', name: 'App', uri: 'file:///work/app', hostPath: '/work/app/', ordinal: 0 },
            { id: 'remote', name: 'Remote', uri: 'vscode-remote://ssh-remote+host/work/remote', hostPath: '/work/remote', ordinal: 1 },
        ],
    };
    assert.deepEqual(sessionHydration.getWorkspaceAiSessionCandidatePaths(workspace), [
        '/work/app', '/work/remote',
    ]);
    assert.equal(candidates.normalizeAiSessionProjectPath(''), '');
});

test('PROJECT-SESSION-PATH-001 selects provider-specific cwd fields and safe terminal labels', () => {
    assert.equal(sessionPaths.getAiSessionComparableCwd('kimi', { id: 'k1', cwd: '/fallback', workDir: '/preferred' }, providers), '/preferred');
    assert.equal(sessionPaths.getAiSessionTerminalName('unknown', { id: 'unsafe', name: '<name>' }, providers), 'AI: <name> [unsafe]');
    const scope = sessionScope.buildAiSessionDirectoryScope({
        navigationIdentity: 'navigation:fixture', scopeIdentity: 'scope:fixture',
        kind: 'singleFolder', displayName: 'App', navigationUri: 'file:///work/app', environment: 'local',
        roots: [{ id: 'app', name: 'App', uri: 'file:///work/app', hostPath: '/work/app', ordinal: 0 }],
    }, { isDirectory: value => value === '/work/app' });
    assert.equal(scope.primaryCwd, '/work/app');
});

test('SESSION-PENDING-TERMINAL-MATCHER-001 picks the newest unclaimed post-create session in the same cwd', () => {
    const result = { available: true, sessions: [
        { id: 'old', cwd: '/work/app', updatedAt: '2026-01-01T00:00:00Z' },
        { id: 'claimed', cwd: '/work/app', updatedAt: '2026-01-02T00:00:00Z' },
        { id: 'new', cwd: '/work/app', updatedAt: '2026-01-03T00:00:00Z' },
        { id: 'other', cwd: '/other', updatedAt: '2026-01-04T00:00:00Z' },
    ] };
    const match = pending.findPendingAiSessionTerminalMatch({
        identity: { provider: 'codex', cwd: '/work/app' },
        createdAt: '2026-01-01T12:00:00Z', excludedSessionIds: [],
    }, result, new Set(['codex:claimed']), helpers.getAiSessionKey, providers);
    assert.equal(match.id, 'new');
    assert.equal(pending.findPendingAiSessionTerminalMatch({
        identity: { provider: 'codex', cwd: '/work/app' }, createdAt: 'invalid', excludedSessionIds: [],
    }, result, new Set(), helpers.getAiSessionKey, providers), null);
});

test('SESSION-PENDING-TERMINAL-RESOLVER-001 promotes one valid runtime and reports controlled invalid promotion output', async () => {
    const base = {
        identity: {
            provider: 'codex', workspaceScopeIdentity: 'scope:/work/app',
            workspaceNavigationIdentity: 'navigation:/work/app', workspaceRootHostPaths: ['/work/app'],
            cwd: '/work/app', pendingId: 'pending-1',
        },
        backend: 'vscode', state: 'pending', markerPath: '/tmp/pending', runStartedAtMs: 1,
        attached: true, createdAt: '2026-01-01T00:00:00Z', excludedSessionIds: [], title: 'Fixture',
    };
    const options = {
        pendingRuntimes: [base], activeRuntimes: [], providers,
        sessionResults: { codex: { available: true, sessions: [{ id: 'new', cwd: '/work/app', updatedAt: '2026-01-02T00:00:00Z' }] } },
        getSessionKey: helpers.getAiSessionKey, setAlias() {}, syncActiveRuntime() {},
        runtimeCoordinator: { promotePending: () => [{
            ...base, identity: { ...base.identity, sessionId: 'new', pendingId: undefined }, state: 'active',
        }] },
    };
    assert.deepEqual(await resolver.resolvePendingAiSessionTerminals(options), {
        attempted: 1, promoted: [{ pendingId: 'pending-1', provider: 'codex', sessionId: 'new' }], failures: [],
    });
    assert.equal(resolver.getPendingAiSessionPromotionFailureReason([], 'codex', 'new'), 'missing-runtime');
});

test('SESSION-SCAN-OPTION-001 removes scan limits only for interactive identity lookups', () => {
    assert.equal(getAiSessionScanMaxFiles('terminal-candidates', 100), 0);
    assert.equal(getAiSessionScanMaxFiles('alias-original-name', 100), 0);
    assert.equal(getAiSessionScanMaxFiles('dashboard-refresh', 100), 100);
});

test('SESSION-AI-SESSION-PROVIDER-AVAILABILITY-001 resolves POSIX and Windows PATH candidates without executing commands', () => {
    const exists = value => value === '/bin/codex' || value === 'C:\\Tools\\kimi.CMD';
    assert.equal(isCommandAvailableOnPath('codex', { PATH: '/bin:/usr/bin' }, 'linux', exists), true);
    assert.equal(isCommandAvailableOnPath('claude', { PATH: '/bin:/usr/bin' }, 'linux', exists), false);
    assert.equal(isCommandAvailableOnPath('kimi', { Path: 'C:\\Tools', PATHEXT: '.EXE;.CMD' }, 'win32', exists), true);
    assert.equal(isCommandAvailableOnPath('', { PATH: '/bin' }, 'linux', exists), false);
});

test('SESSION-TERMINAL-CWD-001 accepts directories and file parents but rejects URI and missing paths', t => {
    const root = makeTempDirectory(t, 'session-terminal-cwd-');
    const file = path.join(root, 'file.txt');
    fs.writeFileSync(file, 'fixture');
    assert.equal(getUsableTerminalCwd(root), root);
    assert.equal(getUsableTerminalCwd(file), root);
    assert.equal(getUsableTerminalCwd('vscode-remote://ssh-remote+host/work'), null);
    assert.equal(getUsableTerminalCwd(path.join(root, 'missing')), null);
});

test('SESSION-KEY-001 round-trips supported provider keys and rejects malformed or unknown keys', () => {
    const isProviderId = value => ['codex', 'kimi', 'claude'].includes(value);
    assert.equal(helpers.getAiSessionKey('codex', 'session'), 'codex:session');
    assert.equal(helpers.getAiSessionProviderIdFromKey('codex:session', isProviderId), 'codex');
    assert.equal(helpers.getAiSessionProviderIdFromKey('unknown:session', isProviderId), null);
    assert.equal(helpers.getAiSessionProviderIdFromKey('missing-separator', isProviderId), null);
});
