'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    validateOpenProjectAggregate,
} = require('../../../out/openProjects/protocol');
const {
    OpenProjectCoordinator,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openProjectCoordinator');
const {
    OpenProjectStore,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openProjectStore');
const {
    OPEN_PROJECT_LEASE_MS,
    OTHER,
    SELF,
    createSyntheticOpenProjectStore,
    flushAsync,
    makePublication,
    makeRegistration,
} = require('./helpers');

function createCoordinator(root, overrides = {}) {
    const store = overrides.store || createSyntheticOpenProjectStore();
    const deliveries = [];
    const diagnostics = [];
    let nowMs = 1000;
    let fireInterval;
    let fireWatcher;
    const coordinator = new OpenProjectCoordinator(root, {
        now: () => nowMs,
        setInterval: callback => {
            fireInterval = callback;
            return 'coordinator-interval';
        },
        clearInterval: () => undefined,
        createWatcher: (_directory, callback) => {
            fireWatcher = callback;
            return { close: () => undefined };
        },
        createStore: () => store,
        deliverAggregate: aggregate => deliveries.push(aggregate),
        reportDiagnostic: event => diagnostics.push(event),
        ...overrides.dependencies,
    });
    return {
        coordinator,
        deliveries,
        diagnostics,
        fireInterval: () => fireInterval(),
        fireWatcher: () => fireWatcher(),
        setNow: value => { nowMs = value; },
        store,
    };
}

test('PERSIST-STORE-001 preserves sequence monotonicity and expires a registration immediately after its lease', async t => {
    const root = makeTempDirectory(t, 'open-project-focused-store-');
    const registration = makeRegistration(SELF, 900, '/work/owned', {
        sequence: 2,
        leaseUpdatedAtMs: 1000,
    });
    const store = new OpenProjectStore(root, SELF);

    await store.write(registration);
    assert.deepEqual((await store.scan(1000 + OPEN_PROJECT_LEASE_MS)).registrations, [registration]);
    await assert.rejects(
        store.write({ ...registration, sequence: 1 }),
        /sequence decreased/
    );

    const expired = await store.scan(1000 + OPEN_PROJECT_LEASE_MS + 1);
    assert.deepEqual(expired.registrations, []);
    assert.equal(expired.counters.expired, 1);
});

test('ARCH-COORDINATOR-001 preserves focus order across heartbeat publications and renews without redelivery', async t => {
    const harness = createCoordinator('/synthetic-coordinator');
    t.after(() => harness.coordinator.dispose());

    await harness.coordinator.publish(makePublication());
    harness.setNow(2000);
    await harness.coordinator.publish(makePublication({ sequence: 2, followsFocusEvent: true }));
    harness.setNow(3000);
    await harness.coordinator.publish(makePublication({ sequence: 3 }));

    const registration = (await harness.store.scan(3000)).registrations[0];
    assert.equal(registration.lastFocusedAtMs, 2000);
    assert.equal(registration.leaseUpdatedAtMs, 3000);
    assert.equal(harness.deliveries.length, 2, 'lease-only changes must suppress aggregate delivery');

    harness.setNow(14_000);
    harness.fireInterval();
    await flushAsync();
    assert.equal((await harness.store.scan(14_000)).registrations[0].leaseUpdatedAtMs, 14_000);
    assert.equal(harness.deliveries.length, 2);
});

test('ARCH-COORDINATOR-001 retries an unchanged semantic revision after delivery failure', async t => {
    let fireWatcher;
    const attempts = [];
    const coordinator = new OpenProjectCoordinator('/synthetic-delivery-retry', {
        now: () => 1000,
        setInterval: () => 'retry-interval',
        clearInterval: () => undefined,
        createWatcher: (_directory, callback) => {
            fireWatcher = callback;
            return { close: () => undefined };
        },
        createStore: () => createSyntheticOpenProjectStore(),
        deliverAggregate: aggregate => {
            attempts.push(aggregate);
            if (attempts.length === 1) throw new Error('delivery unavailable');
        },
    });
    t.after(() => coordinator.dispose());

    await assert.rejects(coordinator.publish(makePublication()), /delivery unavailable/);
    fireWatcher();
    await flushAsync();

    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].semanticRevision, attempts[0].semanticRevision);
});

test('ARCH-COORDINATOR-AGGREGATE-BOUNDARY-001 deterministically keeps the 100 most recently focused registrations', async () => {
    const registrations = Array.from({ length: 101 }, (_, index) => makeRegistration(
        index.toString(16).padStart(32, '0'),
        index >= 99 ? 1000 : index,
        `/work/project-${index}`,
        { sequence: index + 1, leaseUpdatedAtMs: 5000 }
    ));
    const expectedInstanceIds = registrations.slice()
        .sort((left, right) => right.lastFocusedAtMs - left.lastFocusedAtMs
            || left.instanceId.localeCompare(right.instanceId))
        .slice(0, 100)
        .map(registration => registration.instanceId);
    const deliverFromScan = async scanRegistrations => {
        const deliveries = [];
        const coordinator = new OpenProjectCoordinator('/synthetic-boundary', {
            now: () => 5000,
            setInterval: () => 'boundary-interval',
            clearInterval: () => undefined,
            createWatcher: () => ({ close: () => undefined }),
            createStore: () => ({
                write: async () => undefined,
                remove: async () => undefined,
                scan: async () => ({ registrations: scanRegistrations, counters: {} }),
            }),
            deliverAggregate: aggregate => deliveries.push(aggregate),
        });
        try {
            await coordinator.publish(makePublication());
            return deliveries[0];
        } finally {
            coordinator.dispose();
        }
    };

    const forward = await deliverFromScan(registrations);
    const reverse = await deliverFromScan(registrations.slice().reverse());

    assert.deepEqual(validateOpenProjectAggregate(forward), forward);
    assert.deepEqual(forward.registrations.map(value => value.instanceId), expectedInstanceIds);
    assert.deepEqual(reverse, forward);
    assert.ok(forward.registrations.some(value => value.instanceId === registrations[100].instanceId));
    assert.ok(!forward.registrations.some(value => value.instanceId === registrations[0].instanceId));
});

test('ARCH-COORDINATOR-001 suppresses aggregate delivery when only sequence and lease timestamps change', async t => {
    const store = createSyntheticOpenProjectStore();
    const harness = createCoordinator('/synthetic-semantic-revision', { store });
    t.after(() => harness.coordinator.dispose());
    await harness.coordinator.publish(makePublication());
    const initial = (await store.scan(1000)).registrations[0];

    store.seed({ ...initial, sequence: 2, leaseUpdatedAtMs: 2000 });
    harness.setNow(2000);
    await harness.coordinator.scanAndDeliver();

    assert.equal(harness.deliveries.length, 1);
    assert.equal(harness.deliveries[0].registrations[0].leaseUpdatedAtMs, 1000);
});
