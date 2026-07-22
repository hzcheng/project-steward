'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const AiSessionPinController = require('../../../out/aiSessions/pinController').default;
const AiSessionAliasController = require('../../../out/aiSessions/aliasController').default;
const { AiSessionCommandController } = require('../../../out/aiSessions/commandController');
const AiSessionExecutionMonitor = require('../../../out/aiSessions/executionMonitor').default;
const { AiSessionReadCoordinator } = require('../../../out/aiSessions/readCoordinator');
const GitRepositoryDetector = require('../../../out/projects/gitRepositoryDetector').default;

test('SESSION-PIN-CONTROLLER-001 maps store success and failure to stable controller outputs', async () => {
    const calls = [];
    const errors = [];
    const controller = new AiSessionPinController({
        store: {
            getAll: () => new Set(['codex:a']),
            toggle: key => calls.push(['toggle', key]),
            remove: key => calls.push(['remove', key]),
            migrateLegacy: keys => calls.push(['migrate', keys]),
        },
        getSessionKey: (provider, id) => `${provider}:${id}`,
        logError: (message, error) => errors.push([message, error.message]),
    });
    assert.deepEqual([...controller.getAll()], ['codex:a']);
    assert.equal(controller.toggle('codex', 'b'), true);
    controller.remove('codex', 'b');
    await controller.migrateLegacy(['codex:old'], () => Promise.resolve());
    assert.deepEqual(calls, [['toggle', 'codex:b'], ['remove', 'codex:b'], ['migrate', ['codex:old']]]);

    const failing = new AiSessionPinController({
        store: { getAll() { throw new Error('read'); }, toggle() { throw new Error('write'); }, remove() {}, migrateLegacy() {} },
        getSessionKey: (provider, id) => `${provider}:${id}`,
        logError: (message, error) => errors.push([message, error.message]),
    });
    assert.deepEqual([...failing.getAll()], []);
    assert.equal(failing.toggle('codex', 'b'), false);
    assert.deepEqual(errors.map(item => item[1]), ['read', 'write']);
});

test('SESSION-ALIAS-CONTROLLER-001 sanitizes writes and resolves original names through the provider boundary', () => {
    const writes = [];
    const controller = new AiSessionAliasController({
        store: { getAll: () => ({}), saveAll() {}, remove() {}, set: (key, value) => writes.push([key, value]) },
        isProviderId: value => value === 'codex',
        getSessionKey: (provider, id) => `${provider}:${id}`,
        getProviderResult: () => ({ sessions: [{ id: 'a', name: 'Original' }] }),
        logError() {},
    });
    controller.set('codex', 'a', '  Alias\nName  ');
    controller.set('unknown', 'a', 'ignored');
    assert.deepEqual(writes, [['codex:a', 'Alias Name']]);
    assert.equal(controller.getOriginalName('codex', 'a'), 'Original');
    assert.equal(controller.getOriginalName('codex', 'missing'), 'missing');
});

test('SESSION-AI-SESSION-COMMAND-CONTROLLER-001 exposes validated command effects without mutating invalid targets', async () => {
    const effects = [];
    const controller = new AiSessionCommandController({
        getOpenProjects: () => [{ id: 'project', path: '/work' }],
        getProjectKey: project => project.path,
        isProviderId: value => value === 'codex',
        setExpanded: async (key, value) => effects.push(['expanded', key, value]),
        setActiveProvider: async (key, value) => effects.push(['provider', key, value]),
        togglePin: () => true,
        getAliases: () => ({}), saveAliases: aliases => effects.push(['aliases', aliases]),
        getOriginalName: () => 'Original', getSessionKey: (provider, id) => `${provider}:${id}`,
        showInputBox: async () => 'Alias', writeClipboard: async value => effects.push(['clipboard', value]),
        showInformationMessage: message => effects.push(['message', message]), refresh: () => effects.push(['refresh']),
    });
    await controller.toggleSessionsExpanded('project', true);
    await controller.selectProvider('project', 'codex');
    await controller.selectProvider('missing', 'codex');
    await controller.renameSession('codex', 'session');
    await controller.copySessionId('session');
    assert.deepEqual(effects, [
        ['expanded', '/work', true], ['provider', '/work', 'codex'], ['refresh'],
        ['aliases', { 'codex:session': 'Alias' }], ['refresh'],
        ['clipboard', 'session'], ['message', 'Chat ID copied to clipboard.'],
    ]);
});

test('SESSION-AI-SESSION-EXECUTION-MONITOR-001 ignores duplicate and older events while exposing immutable snapshots', () => {
    let now = 10;
    const monitor = new AiSessionExecutionMonitor({ now: () => now });
    const signal = { token: 'one', occurredAtMs: 20, executionState: 'running' };
    assert.deepEqual(monitor.evaluate([{ key: 'codex:a', signal }]), ['codex:a']);
    assert.deepEqual(monitor.evaluate([{ key: 'codex:a', signal }]), []);
    assert.deepEqual(monitor.evaluate([{ key: 'codex:a', signal: { token: 'old', occurredAtMs: 19, executionState: 'stopped' } }]), []);
    const snapshot = monitor.getSnapshot();
    snapshot['codex:a'].state = 'stopped';
    assert.equal(monitor.getSnapshot()['codex:a'].state, 'running');
    assert.deepEqual(monitor.evaluate([]), []);
    assert.deepEqual(monitor.getSnapshot(), {});
});

test('ARCH-AI-SESSION-READ-COORDINATOR-001 reads registered providers with bounded diagnostics and deepest assignments', () => {
    let now = 100;
    const diagnostics = [];
    const provider = { id: 'codex', service: { getSessions: options => ({
        available: true, sessions: [{ id: 'a', cwd: '/work/app/src' }], scannedFiles: options.maxFiles, parsedFiles: 1,
    }) } };
    const coordinator = new AiSessionReadCoordinator([provider], event => diagnostics.push(event), () => now++);
    const result = coordinator.getProviderResult('codex', { reason: 'fixture', maxFiles: 5 });
    assert.equal(diagnostics[0].reason, 'fixture');
    assert.equal(diagnostics[0].scanBudget, 5);
    assert.deepEqual([...coordinator.getAssignments([
        { project: { id: 'root' }, path: '/work' }, { project: { id: 'app' }, path: '/work/app' },
    ], { codex: result }, (_provider, session) => session.cwd).codex.keys()], ['app']);
    assert.throws(() => coordinator.getProviderResult('kimi'), /not registered/);
});

test('PROJECT-GIT-REPOSITORY-DETECTOR-001 detects ancestor metadata, rejects URI input, and observes cache reset', t => {
    const root = makeTempDirectory(t, 'git-repository-detector-');
    const nested = path.join(root, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    const detector = new GitRepositoryDetector();
    assert.equal(detector.isGitRepositoryPath(nested), false);
    fs.mkdirSync(path.join(root, '.git'));
    assert.equal(detector.isGitRepositoryPath(nested), true);
    fs.rmSync(path.join(root, '.git'), { recursive: true });
    assert.equal(detector.isGitRepositoryPath(nested), true);
    detector.clearCache();
    assert.equal(detector.isGitRepositoryPath(nested), false);
    assert.equal(detector.isGitRepositoryPath('vscode-remote://ssh-remote+host/work'), false);
});
