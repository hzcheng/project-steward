'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    MAX_OPEN_PROJECT_RECORDS,
    createOpenProjectSemanticRevision,
    validateOpenProjectAggregate,
    validateOpenProjectPublication,
    validateOpenProjectRegistration,
} = require('../../../out/openProjects/protocol');

const FIRST_INSTANCE_ID = '1'.repeat(32);
const SECOND_INSTANCE_ID = '2'.repeat(32);

function makeRecord(overrides = {}) {
    return {
        localProjectId: '__openProjects-0',
        ordinal: 0,
        name: 'Shared',
        description: 'Workspace folder',
        uri: '/work/shared',
        remoteType: 'local',
        ...overrides,
    };
}

function makePublication(overrides = {}) {
    return {
        protocolVersion: 1,
        instanceId: FIRST_INSTANCE_ID,
        sequence: 1,
        followsFocusEvent: false,
        projects: [makeRecord()],
        ...overrides,
    };
}

function makeRegistration(instanceId = FIRST_INSTANCE_ID, overrides = {}) {
    return {
        protocolVersion: 1,
        instanceId,
        sequence: 1,
        lastFocusedAtMs: 4000,
        leaseUpdatedAtMs: 4500,
        projects: [makeRecord()],
        ...overrides,
    };
}

test('ARCH-PROTOCOL-001 / OPEN-PROTOCOL-001 validates complete protocol envelopes and exact registration fields', () => {
    const publication = makePublication();
    const registration = makeRegistration();
    const aggregate = {
        protocolVersion: 1,
        semanticRevision: 'revision',
        observedAtMs: 5000,
        registrations: [registration],
    };

    assert.deepEqual(validateOpenProjectPublication(publication), publication);
    assert.deepEqual(validateOpenProjectRegistration(registration), registration);
    assert.deepEqual(validateOpenProjectAggregate(aggregate), aggregate);
    assert.throws(
        () => validateOpenProjectRegistration({ ...registration, unexpected: true }),
        /unexpected fields/
    );
    assert.throws(
        () => validateOpenProjectRegistration({ ...registration, leaseUpdatedAtMs: Infinity }),
        /leaseUpdatedAtMs/
    );
});

test('OPEN-PROTOCOL-002 rejects publication payloads with non-protocol keys', () => {
    assert.throws(
        () => validateOpenProjectPublication({ ...makePublication(), unexpected: true }),
        /unexpected fields/
    );
    assert.throws(
        () => validateOpenProjectPublication({
            ...makePublication(),
            projects: [{ ...makeRecord(), unexpected: true }],
        }),
        /unexpected fields/
    );
});

test('OPEN-PROTOCOL-003 rejects aggregate registrations that share an instance ID', () => {
    assert.throws(
        () => validateOpenProjectAggregate({
            protocolVersion: 1,
            semanticRevision: 'revision',
            observedAtMs: 5000,
            registrations: [makeRegistration(), makeRegistration(FIRST_INSTANCE_ID, { sequence: 2 })],
        }),
        /duplicate instanceId/
    );
});

test('OPEN-PROTOCOL-004 accepts the maximum record count and rejects one more', () => {
    assert.equal(MAX_OPEN_PROJECT_RECORDS, 100);
    assert.doesNotThrow(() => validateOpenProjectPublication({
        ...makePublication(),
        projects: Array.from({ length: MAX_OPEN_PROJECT_RECORDS }, (_, ordinal) => makeRecord({
            localProjectId: `__openProjects-${ordinal}`,
            ordinal,
        })),
    }));
    assert.throws(
        () => validateOpenProjectPublication({
            ...makePublication(),
            projects: Array.from({ length: MAX_OPEN_PROJECT_RECORDS + 1 }, makeRecord),
        }),
        /at most 100 records/
    );
});

test('OPEN-PROTOCOL-005 keeps semantic revisions stable when only transient registration fields change', () => {
    const registration = makeRegistration();
    const revision = createOpenProjectSemanticRevision([registration]);

    assert.equal(
        createOpenProjectSemanticRevision([{ ...registration, sequence: 99, leaseUpdatedAtMs: 9999 }]),
        revision
    );
    assert.notEqual(
        createOpenProjectSemanticRevision([{ ...registration, lastFocusedAtMs: 4001 }]),
        revision
    );
});

test('OPEN-PROTOCOL-006 keeps semantic revisions stable when registrations arrive in a different order', () => {
    const first = makeRegistration(FIRST_INSTANCE_ID, { lastFocusedAtMs: 4000 });
    const second = makeRegistration(SECOND_INSTANCE_ID, { lastFocusedAtMs: 3000 });

    assert.equal(
        createOpenProjectSemanticRevision([first, second]),
        createOpenProjectSemanticRevision([second, first])
    );
});
