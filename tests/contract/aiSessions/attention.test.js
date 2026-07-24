'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createFakeClock } = require('../../helpers/fakeClock');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    createDeferred,
    flushAsync,
    loadFreshWithFakeVscode,
} = require('../../helpers/runtimeContract');
const AttentionMonitor = require('../../../out/aiSessions/attentionMonitor').default;
const {
    AiSessionAttentionController,
    settleAiSessionRuntimeLifecycles,
} = require('../../../out/aiSessions/attentionController');
const {
    aggregateAttentionSnapshots,
    filterAcknowledgedAttentionAggregate,
} = require('../../../out/aiSessions/attentionAggregate');
const attentionPayload = require('../../../out/aiSessions/attentionPayload');
const attentionProject = require('../../../out/aiSessions/attentionProject');
const lifecycle = require('../../../out/aiSessions/lifecycle');
const workspaceAttentionProjection = require('../../../out/workspaces/attentionProjection');

const fixturesRoot = path.resolve(__dirname, '../../fixtures/providers');

function readLifecycle(providerId, state) {
    return fs.readFileSync(path.join(fixturesRoot, providerId, 'lifecycle', `${state}.jsonl`), 'utf8')
        .split(/\r?\n/g);
}

function lifecycleParser(providerId) {
    return {
        codex: lifecycle.parseCodexLifecycleLines,
        kimi: lifecycle.parseKimiLifecycleLines,
        claude: lifecycle.parseClaudeLifecycleLines,
    }[providerId];
}

// ATTENTION-ATTENTION-MONITOR-001
for (const providerId of ['codex', 'kimi', 'claude']) {
    test(`ATTENTION-ATTENTION-MONITOR-001 [${providerId}] maps Running, Waiting, Completed, and Stopped fixtures`, () => {
        const manifest = JSON.parse(fs.readFileSync(
            path.join(fixturesRoot, providerId, 'manifest.json'), 'utf8'
        ));
        const monitor = new AttentionMonitor({ now: () => 2000 });
        const key = `${providerId}:fixture-session`;
        const expected = {
            running: { state: 'running', reason: undefined },
            waiting: { state: 'needsAttention', reason: 'input-required' },
            completed: { state: 'needsAttention', reason: 'completed' },
            stopped: { state: 'needsAttention', reason: manifest.lifecycle.stoppedReason },
        };

        for (const state of ['running', 'waiting', 'completed', 'stopped']) {
            const signal = lifecycleParser(providerId)(
                readLifecycle(providerId, state), manifest.lifecycle.runStartedAtMs
            );
            const events = monitor.evaluate([{ key, signal, observedAt: signal.occurredAtMs }]);
            const snapshot = monitor.getSnapshot()[key];
            assert.equal(snapshot.state, expected[state].state);
            assert.equal(snapshot.event?.reason, expected[state].reason);
            assert.equal(monitor.evaluate([{ key, signal, observedAt: signal.occurredAtMs }]).length, 0,
                'duplicate lifecycle tokens must be idempotent');
            if (events[0]) {
                monitor.acknowledge([events[0].eventId]);
                assert.equal(monitor.getSnapshot()[key].state, 'acknowledged');
            }
        }
    });
}

test('ATTENTION-ATTENTION-MONITOR-001 clears attention when an interrupted session becomes idle', () => {
    const monitor = new AttentionMonitor({ now: () => 2000 });
    const key = 'claude:interrupted';
    monitor.evaluate([{ key, signal: {
        token: 'claude:waiting:1000',
        phase: 'needsAttention',
        reason: 'input-required',
        executionState: 'stopped',
        occurredAtMs: 1000,
    } }]);

    const events = monitor.evaluate([{ key, signal: {
        token: 'claude:user_interrupt:1001',
        phase: 'idle',
        executionState: 'stopped',
        occurredAtMs: 1001,
    } }]);

    assert.deepEqual(events, []);
    assert.deepEqual(monitor.getSnapshot()[key], {
        state: 'idle',
        stateChangedAt: 2000,
        event: undefined,
    });
});

test('ATTENTION-ATTENTION-PAYLOAD-001 validates privacy-safe owner snapshots and deterministic aggregation', () => {
    const projectId = attentionProject.getAttentionProjectKey('/fixtures/project');
    const item = {
        projectId,
        sessionKey: 'codex:owner-session',
        state: 'needsAttention',
        eventId: 'owner-event',
        reason: 'completed',
        observedAtMs: 100,
    };
    const owner = attentionPayload.validateAttentionOwnerSnapshot({
        ...attentionPayload.createAttentionPayload([item], 100),
        instanceId: 'a'.repeat(32),
        sequence: 1,
        heartbeat: 1,
    });
    const peer = attentionPayload.validateAttentionOwnerSnapshot({
        ...attentionPayload.createAttentionPayload([{
            ...item, eventId: 'peer-event', reason: 'input-required',
        }], 101),
        instanceId: 'b'.repeat(32),
        sequence: 2,
        heartbeat: 2,
    });

    const aggregate = aggregateAttentionSnapshots([peer, owner], new Set(), 200);
    assert.deepEqual(aggregate.sessions, [{
        projectId,
        sessionKey: 'codex:owner-session',
        reasons: ['completed', 'input-required'],
        eventIds: ['owner-event', 'peer-event'],
        observedAtMs: 100,
    }]);
    assert.deepEqual(
        aggregateAttentionSnapshots([owner, peer], new Set(['owner-event']), 201).sessions,
        [{
            projectId,
            sessionKey: 'codex:owner-session',
            reasons: ['input-required'],
            eventIds: ['peer-event'],
            observedAtMs: 100,
        }]
    );
    assert.throws(() => attentionPayload.validateAttentionPayload({
        version: 1,
        generatedAtMs: 1,
        items: [{ ...item, projectId: '/fixtures/project' }],
    }), /privacy-safe/);
});

test('ATTENTION-ATTENTION-PROJECT-001 ATTENTION-ATTENTION-PROJECTION-001 maps aggregate ownership onto immutable project views', () => {
    const projectPath = 'file:///fixtures/project';
    const projectKey = attentionProject.getAttentionProjectKey('/fixtures/project');
    assert.equal(attentionProject.resolveAttentionProjectKey({ path: projectPath }), projectKey);
    const aggregate = {
        protocolVersion: 1,
        aggregateRevision: 'a'.repeat(64),
        generatedAtMs: 200,
        sessions: [{
            projectId: projectKey,
            sessionKey: 'codex:one',
            reasons: ['completed'],
            eventIds: ['event-b', 'event-a'],
            observedAtMs: 100,
        }],
    };
    const projects = [{ id: 'project', path: projectPath }];

    const projected = attentionProject.withAttentionProjects(projects, aggregate);
    assert.deepEqual(projected, [{
        id: 'project', path: projectPath,
        aiSessionAttentionCount: 1,
        aiSessionAttentionEventIds: ['event-a', 'event-b'],
    }]);
    assert.equal(projects[0].aiSessionAttentionCount, undefined);
    assert.equal(
        attentionProject.buildAttentionSessionIndex(aggregate).get(
            attentionProject.getAttentionSessionLookupKey(projectKey, 'codex:one')
        ).eventIds[0],
        'event-b'
    );
});

test('ATTENTION-LOGICAL-SESSION-CARD-COUNT-001 counts logical sessions and retains every run event', () => {
    const projectPath = 'file:///fixtures/project';
    const projectKey = attentionProject.getAttentionProjectKey('/fixtures/project');
    const sameLogicalSessionAggregate = {
        protocolVersion: 1,
        aggregateRevision: 'b'.repeat(64),
        generatedAtMs: 300,
        sessions: [{
            projectId: projectKey,
            sessionKey: 'codex:one:100:tmux',
            reasons: ['completed'],
            eventIds: ['event-old'],
            observedAtMs: 100,
        }, {
            projectId: projectKey,
            sessionKey: 'codex:one:200:vscode',
            reasons: ['input-required'],
            eventIds: ['event-new'],
            observedAtMs: 200,
        }],
    };

    const projectSummary = attentionProject.getAttentionProjectSummaries(
        sameLogicalSessionAggregate
    )[0];
    assert.deepEqual(projectSummary, {
        projectKey,
        attentionCount: 1,
        eventIds: ['event-new', 'event-old'],
        sessions: [{
            sessionKey: 'codex:one',
            eventId: 'event-new',
            eventIds: ['event-new', 'event-old'],
        }],
    });
    assert.equal(
        attentionProject.getLogicalAttentionSessionKey('codex:one:200:vscode'),
        'codex:one'
    );
    assert.equal(
        attentionProject.getLogicalAttentionSessionKey('opaque-session-key'),
        'opaque-session-key'
    );
    assert.deepEqual(
        attentionProject.withAttentionProject(
            { id: 'project', path: projectPath },
            sameLogicalSessionAggregate
        ),
        {
            id: 'project',
            path: projectPath,
            aiSessionAttentionCount: 1,
            aiSessionAttentionEventIds: ['event-new', 'event-old'],
        }
    );
    assert.deepEqual(
        workspaceAttentionProjection.getWorkspaceAttentionSummary({
            roots: [{ uri: projectPath }],
        }, sameLogicalSessionAggregate),
        {
            attentionCount: 1,
            eventIds: ['event-new', 'event-old'],
            sessions: [{
                sessionKey: 'codex:one',
                eventId: 'event-new',
                eventIds: ['event-new', 'event-old'],
            }],
        }
    );

    const acknowledged = filterAcknowledgedAttentionAggregate(
        sameLogicalSessionAggregate,
        new Set(['event-old', 'event-new'])
    );
    assert.equal(
        workspaceAttentionProjection.getWorkspaceAttentionSummary({
            roots: [{ uri: projectPath }],
        }, acknowledged).attentionCount,
        0
    );

    const twoLogicalSessions = {
        ...sameLogicalSessionAggregate,
        sessions: sameLogicalSessionAggregate.sessions.concat({
            projectId: projectKey,
            sessionKey: 'codex:two:300:tmux',
            reasons: ['failed'],
            eventIds: ['event-two'],
            observedAtMs: 300,
        }),
    };
    assert.equal(
        attentionProject.getAttentionProjectSummaries(twoLogicalSessions)[0].attentionCount,
        2
    );
});

test('ATTENTION-LOGICAL-SESSION-CARD-COUNT-001 counts scoped runtime keys as one logical session', () => {
    const projectKey = attentionProject.getAttentionProjectKey('/fixtures/project');
    const workspaceScopeIdentity = 'b'.repeat(64);
    const sessionId = '019f9178-8dce-79d1-8b5d-d19ffa92c3dd';
    const sessions = [
        [100, 'tmux'],
        [200, 'vscode'],
        [300, 'tmux'],
        [400, 'vscode'],
        [500, 'tmux'],
    ].map(([runStartedAtMs, backend], index) => ({
        projectId: projectKey,
        sessionKey: attentionProject.getAttentionRuntimeSessionKey({
            workspaceScopeIdentity,
            provider: 'codex',
            sessionId,
            runStartedAtMs,
            backend,
        }),
        reasons: ['completed'],
        eventIds: [`event-${index}`],
        observedAtMs: runStartedAtMs,
    }));

    const summary = attentionProject.getAttentionProjectSummaries({
        protocolVersion: 1,
        aggregateRevision: 'c'.repeat(64),
        generatedAtMs: 500,
        sessions,
    })[0];

    assert.equal(summary.attentionCount, 1);
    assert.equal(summary.sessions[0].sessionKey, `codex:${sessionId}`);
    assert.deepEqual(summary.eventIds, [
        'event-0', 'event-1', 'event-2', 'event-3', 'event-4',
    ]);
});

for (const [providerId, sessionsKey] of [
    ['codex', 'codexSessions'],
    ['kimi', 'kimiSessions'],
    ['claude', 'claudeSessions'],
]) {
    test(`ATTENTION-AI-SESSION-ATTENTION-CONTROLLER-001 [${providerId}] retains unread completion through runtime handoff until acknowledgement`, async () => {
        let runtime = { state: 'completed', runStartedAtMs: 900 };
        const publications = [];
        const runtimeLookups = [];
        const getRuntimeById = (lookupProviderId, lookupSessionId) => {
            runtimeLookups.push([lookupProviderId, lookupSessionId]);
            return lookupProviderId === providerId && lookupSessionId === 'session'
                ? runtime
                : null;
        };
        const wrongProviderId = providerId === 'codex' ? 'kimi' : 'codex';
        assert.equal(getRuntimeById(wrongProviderId, 'session'), null,
            'the runtime fixture must reject a different provider identity');
        runtimeLookups.length = 0;
        const workspace = {
            navigationIdentity: 'navigation:fixture', scopeIdentity: 'scope:fixture',
            kind: 'singleFolder', displayName: 'Fixture', navigationUri: 'file:///fixtures/project',
            environment: 'local', roots: [{
                id: 'root:fixture', name: 'Fixture', uri: 'file:///fixtures/project',
                hostPath: '/fixtures/project', ordinal: 0,
            }],
        };
        const sessionsByProvider = { codex: [], kimi: [], claude: [] };
        sessionsByProvider[providerId] = [{ id: 'session', primaryRootId: 'root:fixture' }];
        const workspaceSessions = { sessionsByProvider };
        const controller = new AiSessionAttentionController({
            isEnabled: () => true,
            getWorkspaceTarget: () => ({ cardId: 'workspace:fixture', workspace, sessions: workspaceSessions }),
            getProviders: () => [{
                id: 'codex', projectSessionsKey: 'codexSessions',
                service: { getLifecycleSignals: () => ({}) },
            }, {
                id: 'kimi', projectSessionsKey: 'kimiSessions', service: { getLifecycleSignals: () => ({}) },
            }, {
                id: 'claude', projectSessionsKey: 'claudeSessions', service: { getLifecycleSignals: () => ({}) },
            }],
            getRuntimeById,
            isRuntimeComplete: value => value.state === 'completed',
            publish: async items => { publications.push(items.map(item => ({ ...item }))); return true; },
            scheduleRefresh: () => undefined,
            postProjectsUpdated: () => undefined,
            nowMs: () => 1000,
        });

        const first = await controller.evaluate();
        const eventId = publications[0][0].eventId;
        assert.deepEqual(first.eventIdsBySession[`${providerId}:session`], [eventId]);
        assert.deepEqual(runtimeLookups, [[providerId, 'session']]);
        runtimeLookups.length = 0;
        runtime = null;
        await controller.evaluate();
        assert.deepEqual(publications[1].map(item => item.eventId), [eventId]);
        assert.deepEqual(runtimeLookups, [[providerId, 'session']]);
        runtimeLookups.length = 0;
        controller.acknowledge([eventId]);
        await controller.evaluate();
        assert.deepEqual(publications[2], []);
        assert.deepEqual(runtimeLookups, [[providerId, 'session']]);
    });
}

test('ATTENTION-AI-SESSION-ATTENTION-CONTROLLER-001 releases completed runtime ownership only after published attention evidence', async () => {
    const released = [];
    const candidates = [
        { key: 'codex:complete', state: 'completed' },
        { key: 'kimi:stopped', state: 'stopped' },
        { key: 'claude:retry', state: 'completed' },
    ];
    const result = await settleAiSessionRuntimeLifecycles({
        candidates,
        evaluateAttention: async () => ({
            enabled: true,
            published: true,
            inScopeSessionKeys: ['codex:complete', 'claude:retry'],
            eventIdsBySession: { 'codex:complete': ['event'] },
            overflowedSessionKeys: [],
        }),
        release: candidate => { released.push(candidate.key); },
    });
    assert.deepEqual(result, {
        releasedKeys: ['codex:complete', 'kimi:stopped'],
        retainedKeys: ['claude:retry'],
    });
    assert.deepEqual(released, ['codex:complete', 'kimi:stopped']);
});

test('ATTENTION-PRODUCTION-ATTENTION-STORE-LIFECYCLE-001 rejects old owner events and retains the newest sequence', async t => {
    const { ProductionAttentionStore } = require(
        '../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/productionAttentionStore'
    );
    const root = makeTempDirectory(t, 'project-steward-attention-store-contract-');
    const store = new ProductionAttentionStore(root, 'bridge-process');
    const projectId = attentionProject.getAttentionProjectKey('/fixtures/project');
    const snapshot = sequence => ({
        version: 1,
        generatedAtMs: 1000 + sequence,
        items: [{
            projectId, sessionKey: 'codex:stale-owner', state: 'needsAttention',
            eventId: `event-${sequence}`, reason: 'completed', observedAtMs: 1000 + sequence,
        }],
        instanceId: 'c'.repeat(32),
        sequence,
        heartbeat: sequence,
    });

    await store.write(snapshot(2), 1002, 'fixture');
    await assert.rejects(store.write(snapshot(1), 1003, 'fixture'), /sequence decreased/);
    assert.deepEqual((await store.scan(1003)).snapshots.map(value => value.sequence), [2]);
    const storedText = fs.readFileSync(
        path.join(root, 'instances', `${'c'.repeat(32)}.json`), 'utf8'
    );
    assert.equal(storedText.includes('/fixtures/project'), false);
});

test('ATTENTION-PRODUCTION-ATTENTION-STORE-CLOCK-001 leases owner snapshots by receipt time, not producer time', async t => {
    const { ProductionAttentionStore } = require(
        '../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/productionAttentionStore'
    );
    const root = makeTempDirectory(t, 'project-steward-attention-clock-contract-');
    const store = new ProductionAttentionStore(root, 'clock');
    const snapshot = {
        version: 1,
        generatedAtMs: 9_999_999_999,
        items: [],
        instanceId: 'e'.repeat(32),
        sequence: 1,
        heartbeat: 1,
    };

    await store.write(snapshot, 1000, 'fixture');
    assert.deepEqual((await store.scan(90_999)).snapshots.map(value => value.sequence), [1]);
    assert.deepEqual((await store.scan(91_001)).snapshots, []);
});

test('ATTENTION-PRODUCTION-ATTENTION-STORE-UNREGISTER-PROPAGATION-001 ATTENTION-PRODUCTION-ATTENTION-STORE-TOMBSTONE-REACTIVATION-RACE-001 propagates removal and safely permits a new owner generation', async t => {
    const { ProductionAttentionStore } = require(
        '../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/productionAttentionStore'
    );
    const root = makeTempDirectory(t, 'project-steward-attention-tombstone-contract-');
    const writer = new ProductionAttentionStore(root, 'writer');
    const peer = new ProductionAttentionStore(root, 'peer');
    const base = {
        version: 1, generatedAtMs: 1000, items: [], instanceId: 'd'.repeat(32), heartbeat: 0,
    };
    await writer.write({ ...base, sequence: 0 }, 1000, 'fixture');
    assert.deepEqual((await peer.scan(1000)).snapshots.map(value => value.sequence), [0]);
    await writer.remove(base.instanceId, 1002);
    assert.deepEqual((await peer.scan(1002)).snapshots, []);

    await writer.write({ ...base, sequence: 2, heartbeat: 2 }, 1004, 'fixture');
    assert.deepEqual((await peer.scan(1004)).snapshots.map(value => value.sequence), [2]);
    await assert.rejects(
        writer.write({ ...base, sequence: 1, heartbeat: 1 }, 1005, 'fixture'),
        /sequence decreased/
    );
    assert.deepEqual((await peer.scan(1005)).snapshots.map(value => value.sequence), [2]);
});

test('ATTENTION-PRODUCTION-ATTENTION-STORE-UNREGISTER-PROPAGATION-001 scan racing remove cannot repopulate owner caches', async t => {
    const { ProductionAttentionStore } = require(
        '../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/productionAttentionStore'
    );
    const root = makeTempDirectory(t, 'project-steward-attention-scan-remove-race-');
    const instanceId = 'f'.repeat(32);
    const ownerPath = path.join(root, 'instances', `${instanceId}.json`);
    const writer = new ProductionAttentionStore(root, 'writer');
    const peer = new ProductionAttentionStore(root, 'peer');
    const snapshot = {
        version: 1,
        generatedAtMs: 1000,
        items: [],
        instanceId,
        sequence: 1,
        heartbeat: 1,
    };
    await writer.write(snapshot, 1000, 'fixture');
    assert.deepEqual((await peer.scan(1001)).snapshots.map(value => value.sequence), [1]);

    const readEntered = createDeferred();
    const releaseRead = createDeferred();
    const originalReadFile = fs.promises.readFile;
    let intercepted = false;
    fs.promises.readFile = async (...args) => {
        const value = await originalReadFile.apply(fs.promises, args);
        if (String(args[0]) === ownerPath && !intercepted) {
            intercepted = true;
            readEntered.resolve();
            await releaseRead.promise;
        }
        return value;
    };
    try {
        const racingScan = writer.scan(1002);
        let timeout;
        await Promise.race([
            readEntered.promise,
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error('attention owner read did not start within 2 seconds')),
                    2000
                );
            }),
        ]).finally(() => clearTimeout(timeout));
        const racingRemove = writer.remove(instanceId, 1003);
        releaseRead.resolve();
        await Promise.all([racingScan, racingRemove]);
    } finally {
        releaseRead.resolve();
        fs.promises.readFile = originalReadFile;
    }

    assert.deepEqual((await writer.scan(1004)).snapshots, []);
    assert.deepEqual((await peer.scan(1004)).snapshots, []);
});

test('ATTENTION-ATTENTION-BRIDGE-CLIENT-LIFECYCLE-001 ATTENTION-ATTENTION-BRIDGE-CLIENT-PRIVACY-001 reconnects and flushes only the latest privacy-safe owner snapshot', async () => {
    const clock = createFakeClock(60_000);
    const commands = [];
    const registered = new Map();
    let available = false;
    const vscode = { commands: {
        registerCommand: (command, callback) => {
            registered.set(command, callback);
            return { dispose: () => registered.delete(command) };
        },
        executeCommand: async (command, argument) => {
            commands.push({ command, argument });
            if (command === '_projectStewardAttention.bridge.handshake') {
                if (!available) throw new Error('command not found');
                return {
                    accepted: true, protocolVersion: 1, bridgeExtensionVersion: 'fixture',
                    capabilities: { snapshots: true, acknowledgements: true, atomicReplace: true },
                };
            }
            if (command === '_projectStewardAttention.bridge.publish' && !available) {
                throw new Error('command not found');
            }
            return undefined;
        },
    } };
    const Client = loadFreshWithFakeVscode(
        '../../../out/aiSessions/attentionBridgeClient', vscode, __dirname
    ).default;
    const errors = [];
    const client = new Client(() => undefined, error => errors.push(error), {
        now: () => clock.nowMs,
        setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
        clearTimeout: handle => clock.clearTimeout(handle),
        mainExtensionVersion: 'fixture',
    });
    const projectId = attentionProject.getAttentionProjectKey('/fixtures/project');
    const item = eventId => ({
        projectId, sessionKey: 'codex:bridge', state: 'needsAttention', eventId,
        reason: 'input-required', observedAtMs: clock.nowMs,
    });

    assert.equal(await client.publish([item('superseded')]), false);
    assert.equal(await client.publish([item('latest')]), false);
    available = true;
    clock.advanceBy(100);
    await flushAsync();
    const publications = commands.filter(entry =>
        entry.command === '_projectStewardAttention.bridge.publish'
    );
    assert.equal(publications.length, 1);
    assert.deepEqual(publications[0].argument.items.map(value => value.eventId), ['latest']);
    assert.equal(JSON.stringify(publications[0].argument).includes('/fixtures/project'), false);
    assert.ok(errors.length >= 1);
    client.dispose();
    await flushAsync();
});
