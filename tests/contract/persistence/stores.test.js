'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    createRuntimeFilesystemFixture,
    makeTmuxKnownBinding,
} = require('../../helpers/runtimeContract');
const AiSessionAliasStore = require('../../../out/aiSessions/aliasStore').default;
const AiSessionPinStore = require('../../../out/aiSessions/pinStore').default;
const AiSessionProjectStateStore = require('../../../out/aiSessions/projectStateStore').default;
const {
    AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX,
} = require('../../../out/aiSessions/terminalBindingStore');
const AiSessionTerminalBindingStore = require('../../../out/aiSessions/terminalBindingStore').default;
const { TmuxRuntimeBindingStore } = require('../../../out/aiSessions/tmuxRuntimeBindingStore');
const { normalizeTodoData } = require('../../../out/todos/types');
const {
    ProductionAttentionStore,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/productionAttentionStore');
const {
    OpenProjectStore,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openProjectStore');
const {
    OPEN_PROJECT_LEASE_MS,
    SELF,
    makeRegistration,
} = require('../openProjects/helpers');

const NOW = Date.parse('2026-07-18T10:00:00.000Z');

function makeState(initial = {}) {
    const values = { ...initial };
    return {
        values,
        memento: {
            get(key, fallback) {
                return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
            },
            async update(key, value) {
                if (value === undefined) delete values[key];
                else values[key] = value;
            },
        },
    };
}

function makeAttentionSnapshot(sequence = 1) {
    return {
        version: 1,
        generatedAtMs: NOW,
        items: [],
        instanceId: 'a'.repeat(32),
        sequence,
        heartbeat: sequence,
    };
}

test('PERSIST-ALIAS-STORE-001 reads valid aliases, drops missing fields, and exposes corrupt JSON to its controller boundary', t => {
    const root = makeTempDirectory(t, 'project-steward-persistence-alias-');
    const aliasesPath = path.join(root, 'ai-session-aliases.json');
    const store = new AiSessionAliasStore(root);

    assert.deepEqual(store.getAll(), {});
    store.saveAll({
        'codex:valid': 'Valid alias',
        'kimi:missing': '',
        'claude:wrong-type': 7,
    });
    assert.deepEqual(store.getAll(), { 'codex:valid': 'Valid alias' });
    store.set('kimi:trimmed', '  Multi\nLine  ');
    assert.equal(store.getAll()['kimi:trimmed'], 'Multi Line');
    store.remove('kimi:trimmed');
    assert.equal(store.getAll()['kimi:trimmed'], undefined);

    fs.writeFileSync(aliasesPath, '[]', 'utf8');
    assert.deepEqual(store.getAll(), {});
    fs.writeFileSync(aliasesPath, '{"codex:partial":', 'utf8');
    assert.throws(() => store.getAll(), SyntaxError);
});

test('PERSIST-PIN-STORE-001 makes duplicate writes idempotent and never resurrects stale legacy pins', t => {
    const root = makeTempDirectory(t, 'project-steward-persistence-pin-');
    const store = new AiSessionPinStore(root);

    store.add('codex:duplicate');
    store.add('codex:duplicate');
    assert.deepEqual(Array.from(store.getAll()), ['codex:duplicate']);

    store.migrateLegacy(['kimi:legacy', '', 'kimi:legacy']);
    assert.deepEqual(Array.from(store.getAll()).sort(), ['codex:duplicate', 'kimi:legacy']);
    store.remove('kimi:legacy');
    store.migrateLegacy(['kimi:legacy']);
    assert.equal(store.has('kimi:legacy'), false);
    assert.equal(store.toggle('claude:toggle'), true);
    assert.equal(store.toggle('claude:toggle'), false);

    const pinRoot = path.join(root, 'pinned-ai-sessions');
    fs.writeFileSync(path.join(pinRoot, 'partial.pin'), '', 'utf8');
    fs.writeFileSync(path.join(pinRoot, 'ignored.tmp'), 'claude:ignored', 'utf8');
    assert.deepEqual(Array.from(store.getAll()), ['codex:duplicate']);
});

test('PERSIST-PROJECT-STATE-STORE-001 sanitizes legacy project state and ignores invalid writes', async () => {
    const state = makeState({
        openProjectsExpandedCodexSessions: ['project-a', '', 7, 'project-a', 'project-b'],
        openProjectsActiveAiSessionProvider: {
            'project-a': 'codex',
            'project-b': 'unknown',
            'project-c': 'kimi',
        },
    });
    const store = new AiSessionProjectStateStore(
        state.memento,
        value => value === 'codex' || value === 'kimi' || value === 'claude'
    );

    assert.deepEqual(Array.from(store.getExpandedProjects()), ['project-a', 'project-b']);
    assert.deepEqual(store.getActiveProviders(), { 'project-a': 'codex', 'project-c': 'kimi' });
    await store.setExpanded('project-c', true);
    await store.setExpanded('', true);
    await store.setActiveProvider('project-d', 'claude');
    await store.setActiveProvider('project-e', 'unknown');
    assert.deepEqual(state.values.openProjectsExpandedCodexSessions, [
        'project-a', 'project-b', 'project-c',
    ]);
    assert.deepEqual(state.values.openProjectsActiveAiSessionProvider, {
        'project-a': 'codex', 'project-c': 'kimi', 'project-d': 'claude',
    });
});

test('TODO-TODO-STORE-001 preserves unversioned V1 data while dropping duplicate, orphaned, and missing-field records', () => {
    const normalized = normalizeTodoData({
        groups: [
            { id: 'group', title: ' Group ', collapsed: false, order: 0 },
            { id: 'group', title: 'Duplicate', collapsed: false, order: 1 },
            { title: 'Missing ID', order: 2 },
        ],
        todos: [
            {
                id: 'todo', groupId: 'group', title: ' Keep ', notes: ' note ', priority: 'high',
                completed: false, createdAt: '2026-07-18T00:00:00.000Z',
                updatedAt: '2026-07-18T00:00:00.000Z', order: 0,
            },
            { id: 'todo', groupId: 'group', title: 'Duplicate', order: 1 },
            { id: 'orphan', groupId: 'missing', title: 'Orphan', order: 2 },
            { groupId: 'group', title: 'Missing ID', order: 3 },
        ],
    });

    assert.deepEqual(normalized.groups, [
        { id: 'group', title: 'Group', collapsed: false, order: 0 },
    ]);
    assert.deepEqual(normalized.todos.map(todo => [todo.id, todo.title, todo.notes]), [
        ['todo', 'Keep', 'note'],
    ]);
    assert.throws(() => normalizeTodoData({ version: 2 }), /Unsupported TODO data version/);
});

test('PERSIST-AI-SESSION-TERMINAL-BINDING-STORE-001 accepts legacy bound records and rejects missing or oversized fields', async () => {
    const processId = 42001;
    const legacyProcessId = 42002;
    const missingProcessId = 42003;
    const state = makeState({
        [`${AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX}${legacyProcessId}`]: {
            version: 2,
            state: 'bound',
            providerId: 'kimi',
            sessionId: 'legacy',
            markerPath: '/tmp/legacy.done',
            runStartedAtMs: 1,
            updatedAtMs: 2,
        },
        [`${AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX}${missingProcessId}`]: {
            version: 2,
            state: 'bound',
            providerId: 'codex',
            markerPath: '/tmp/missing.done',
            runStartedAtMs: 1,
            updatedAtMs: 2,
        },
    });
    const store = new AiSessionTerminalBindingStore(state.memento, undefined, () => NOW);

    assert.equal(store.get(legacyProcessId).sessionId, 'legacy');
    assert.equal(store.get(missingProcessId), null);
    store.setPending(processId, {
        providerId: 'codex',
        markerPath: '/tmp/valid.done',
        cwd: '/work/project',
        createdAt: '2026-07-18T10:00:00.000Z',
        excludedSessionIds: ['older'],
        title: 'Valid pending binding',
    });
    await store.flush();
    assert.deepEqual(store.get(processId).excludedSessionIds, ['older']);
    store.setBound(processId, {
        providerId: 'codex',
        sessionId: 'valid',
        markerPath: '/tmp/valid.done',
        runStartedAtMs: NOW,
        cwd: '/work/project',
    });
    store.setBound(42004, {
        providerId: 'codex',
        sessionId: 'oversized',
        markerPath: `/${'x'.repeat(4097)}`,
        runStartedAtMs: NOW,
    });
    await store.flush();
    assert.equal(new AiSessionTerminalBindingStore(state.memento).get(processId).sessionId, 'valid');
    assert.equal(new AiSessionTerminalBindingStore(state.memento).get(42004), null);

    store.setReleased(processId, {
        providerId: 'codex',
        sessionId: 'valid',
        markerPath: '/tmp/valid.done',
    });
    await store.flush();
    assert.equal(store.get(processId).state, 'released');
    store.remove(processId);
    await store.flush();
    assert.equal(store.get(processId), null);
});

test('RUNTIME-TMUX-STORE-001 ignores corrupt, oversized, partially written, and stale binding files', async t => {
    const fixture = createRuntimeFilesystemFixture(t, 'project-steward-persistence-tmux-');
    const binding = makeTmuxKnownBinding('persistence', { lastSeenAtMs: NOW });
    const store = new TmuxRuntimeBindingStore(fixture.root, () => NOW);
    await store.setKnown(binding);
    assert.deepEqual(await store.listKnown(), [binding]);

    const [recordName] = fs.readdirSync(fixture.root).filter(name => name.endsWith('.json'));
    const recordPath = fixture.resolve(recordName);
    fs.writeFileSync(recordPath, '{"version":1', 'utf8');
    fs.writeFileSync(fixture.resolve('.interrupted.tmp'), JSON.stringify(binding), 'utf8');
    assert.deepEqual(await new TmuxRuntimeBindingStore(fixture.root, () => NOW).listKnown(), []);

    fs.writeFileSync(recordPath, 'x'.repeat(1024 * 1024 + 1), 'utf8');
    assert.deepEqual(await new TmuxRuntimeBindingStore(fixture.root, () => NOW).listKnown(), []);

    await store.setKnown(binding);
    const staleNow = NOW + (31 * 24 * 60 * 60 * 1000);
    assert.deepEqual(await new TmuxRuntimeBindingStore(fixture.root, () => staleNow).listKnown(), []);
});

test('ATTENTION-PRODUCTION-ATTENTION-STORE-LIFECYCLE-001 ignores corrupt, oversized, and partial files while rejecting stale sequences', async t => {
    const root = makeTempDirectory(t, 'project-steward-persistence-attention-');
    const store = new ProductionAttentionStore(root, 'persistence');
    const snapshot = makeAttentionSnapshot(2);
    await store.write(snapshot, NOW, 'fixture');
    await assert.rejects(store.write(makeAttentionSnapshot(1), NOW + 1, 'fixture'), /sequence decreased/);
    assert.deepEqual((await store.scan(NOW)).snapshots, [snapshot]);

    const ownerPath = path.join(root, 'instances', `${snapshot.instanceId}.json`);
    fs.writeFileSync(ownerPath, '{"storageVersion":1', 'utf8');
    fs.writeFileSync(path.join(root, 'instances', `${snapshot.instanceId}.partial.tmp`), '{}', 'utf8');
    assert.deepEqual((await new ProductionAttentionStore(root, 'reader').scan(NOW)).snapshots, []);

    fs.writeFileSync(ownerPath, 'x'.repeat(256 * 1024 + 1), 'utf8');
    assert.deepEqual((await new ProductionAttentionStore(root, 'reader').scan(NOW)).snapshots, []);
});

test('ATTENTION-PRODUCTION-ATTENTION-STORE-CLOCK-001 expires attention by receipt time', async t => {
    const root = makeTempDirectory(t, 'project-steward-persistence-attention-clock-');
    const store = new ProductionAttentionStore(root, 'clock');
    const snapshot = makeAttentionSnapshot();
    await store.write(snapshot, NOW, 'fixture');
    assert.deepEqual((await store.scan(NOW + 90_000)).snapshots, [snapshot]);
    assert.deepEqual((await store.scan(NOW + 90_001)).snapshots, []);
});

test('PERSIST-STORE-001 counts corrupt and oversized open-project records, ignores partial writes, and expires stale leases', async t => {
    const root = makeTempDirectory(t, 'project-steward-persistence-open-project-');
    const registration = makeRegistration(SELF, NOW, '/work/project', {
        leaseUpdatedAtMs: NOW,
        sequence: 2,
    });
    const store = new OpenProjectStore(root, SELF);
    await store.write(registration);
    assert.deepEqual((await store.scan(NOW)).registrations, [registration]);
    await assert.rejects(store.write({ ...registration, sequence: 1 }), /sequence decreased/);

    const instances = path.join(root, 'open-projects', 'v1', 'instances');
    const ownerPath = path.join(instances, `${SELF}.json`);
    fs.writeFileSync(ownerPath, '{"protocolVersion":1', 'utf8');
    fs.writeFileSync(path.join(instances, `${SELF}.partial.tmp`), '{}', 'utf8');
    const corrupt = await new OpenProjectStore(root, SELF).scan(NOW);
    assert.deepEqual(corrupt.registrations, []);
    assert.equal(corrupt.counters.parseErrors, 1);

    fs.writeFileSync(ownerPath, 'x'.repeat(256 * 1024 + 1), 'utf8');
    const oversized = await new OpenProjectStore(root, SELF).scan(NOW);
    assert.deepEqual(oversized.registrations, []);
    assert.equal(oversized.counters.oversizedFiles, 1);

    fs.writeFileSync(ownerPath, `${JSON.stringify(registration)}\n`, 'utf8');
    const stale = await new OpenProjectStore(root, SELF).scan(NOW + OPEN_PROJECT_LEASE_MS + 1);
    assert.deepEqual(stale.registrations, []);
    assert.equal(stale.counters.expired, 1);
});
