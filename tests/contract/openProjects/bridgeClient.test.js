'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DashboardLifecycleController } = require('../../../out/dashboard/lifecycleController');
const {
    SELF,
    createCommandRegistry,
    createFakeClock,
    flushAsync,
    loadWithFakeVscode,
    makeAggregate,
    makeRecord,
    makeRegistration,
} = require('./helpers');

const OpenProjectBridgeClient = loadWithFakeVscode('../../../out/openProjects/bridgeClient').default;

test('OPEN-BRIDGE-CLIENT-001 sequences changes and focus publications while suppressing unchanged metadata', async t => {
    const clock = createFakeClock(1000);
    const commands = createCommandRegistry();
    const publications = [];
    const aggregates = [];
    commands.register('_projectStewardOpenProjects.bridge.publish', publication => {
        publications.push(publication);
    });
    commands.register('_projectStewardOpenProjects.bridge.unregister', () => undefined);
    const client = new OpenProjectBridgeClient(
        [makeRecord()],
        aggregate => aggregates.push(aggregate),
        error => { throw error; },
        {
            instanceId: SELF,
            now: () => clock.nowMs,
            registerCommand: commands.register,
            executeCommand: commands.execute,
            setInterval: clock.setInterval,
            clearInterval: clock.clearInterval,
        }
    );
    t.after(async () => {
        client.dispose();
        await flushAsync();
    });
    await flushAsync();

    await client.publish([makeRecord()]);
    await client.publish([makeRecord()], true);
    await client.publish([makeRecord({ name: 'Changed' })]);
    await client.publish([makeRecord({ name: 'Changed' })]);

    assert.deepEqual(publications.map(value => value.sequence), [1, 2, 3]);
    assert.deepEqual(publications.map(value => value.followsFocusEvent), [false, true, false]);
    assert.ok(publications.every(value => !Object.hasOwn(value, 'leaseUpdatedAtMs')));

    clock.advanceBy(10_000);
    await flushAsync();
    assert.equal(publications.at(-1).sequence, 4);
    assert.equal(publications.at(-1).followsFocusEvent, false);

    const aggregateCommand = commands.handlers.get('_projectStewardOpenProjects.workspace.aggregate');
    const aggregate = makeAggregate([makeRegistration()]);
    aggregateCommand(aggregate);
    aggregateCommand({
        ...aggregate,
        observedAtMs: 6000,
        registrations: [{ ...aggregate.registrations[0], sequence: 99, leaseUpdatedAtMs: 5999 }],
    });
    assert.deepEqual(aggregates, [aggregate], 'a stale semantic revision must be ignored');
});

test('OPEN-BRIDGE-CLIENT-001 retries the same semantic publication after command delivery fails', async t => {
    const errors = [];
    const attempts = [];
    let rejectNext = true;
    const client = new OpenProjectBridgeClient(
        [makeRecord()],
        () => undefined,
        error => errors.push(error),
        {
            instanceId: '5'.repeat(32),
            now: () => 1000,
            registerCommand: () => ({ dispose: () => undefined }),
            executeCommand: async (command, publication) => {
                if (command !== '_projectStewardOpenProjects.bridge.publish') return;
                attempts.push(publication);
                if (rejectNext) {
                    rejectNext = false;
                    throw new Error('bridge unavailable');
                }
            },
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
        }
    );
    t.after(() => client.dispose());
    await flushAsync();

    assert.equal(await client.publish([makeRecord()]), true);
    assert.deepEqual(attempts.map(value => value.sequence), [1, 2]);
    assert.equal(errors.length, 1);
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 publishes a focus marker only when the window gains focus', () => {
    const publications = [];
    let attentionEvaluations = 0;
    const controller = new DashboardLifecycleController({
        checkDataMigration: async () => undefined,
        applyProjectColorToCurrentWindow: () => undefined,
        refresh: () => undefined,
        publishOpenProjects: followsFocusEvent => publications.push(followsFocusEvent || false),
        evaluateAiSessionAttention: () => { attentionEvaluations += 1; },
    });

    controller.handleWindowStateChanged({ focused: false });
    controller.handleWindowStateChanged({ focused: true });
    controller.handleWorkspaceFoldersChanged();

    assert.deepEqual(publications, [true, false]);
    assert.equal(attentionEvaluations, 2);
});
