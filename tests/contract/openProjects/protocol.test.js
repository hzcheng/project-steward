'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    MAX_OPEN_WORKSPACE_RECORDS,
    createOpenWorkspaceSemanticRevision,
    validateOpenWorkspaceAggregate,
    validateOpenWorkspacePublication,
    validateOpenWorkspaceRegistration,
} = require('../../../out/openWorkspaces/protocol');

const FIRST_INSTANCE_ID = '1'.repeat(32);
const SECOND_INSTANCE_ID = '2'.repeat(32);

function makeRecord(overrides = {}) {
    return {
        navigationIdentity: 'a'.repeat(64),
        scopeIdentity: 'b'.repeat(64),
        kind: 'singleFolder',
        displayName: 'Shared',
        navigationUri: 'file:///work/shared',
        environment: 'local',
        runningAiSessionCount: 0,
        roots: [{ id: 'c'.repeat(64), name: 'Shared', uri: 'file:///work/shared', ordinal: 0 }],
        ...overrides,
    };
}

function makePublication(overrides = {}) {
    return {
        protocolVersion: 3,
        instanceId: FIRST_INSTANCE_ID,
        sequence: 1,
        followsFocusEvent: false,
        workspace: makeRecord(),
        ...overrides,
    };
}

function makeRegistration(instanceId = FIRST_INSTANCE_ID, overrides = {}) {
    return {
        protocolVersion: 3,
        instanceId,
        sequence: 1,
        lastFocusedAtMs: 4000,
        leaseUpdatedAtMs: 4500,
        workspace: makeRecord(),
        ...overrides,
    };
}

test('ARCH-PROTOCOL-001 / OPEN-PROTOCOL-001 validates complete protocol envelopes and exact registration fields', () => {
    const publication = makePublication();
    const registration = makeRegistration();
    const aggregate = {
        protocolVersion: 3,
        semanticRevision: 'd'.repeat(64),
        observedAtMs: 5000,
        registrations: [registration],
    };

    assert.deepEqual(validateOpenWorkspacePublication(publication), publication);
    assert.deepEqual(validateOpenWorkspaceRegistration(registration), registration);
    assert.deepEqual(validateOpenWorkspaceAggregate(aggregate), aggregate);
    assert.throws(
        () => validateOpenWorkspaceRegistration({ ...registration, unexpected: true }),
        /unexpected fields/
    );
    assert.throws(
        () => validateOpenWorkspaceRegistration({ ...registration, leaseUpdatedAtMs: Infinity }),
        /leaseUpdatedAtMs/
    );
});

test('OPEN-PROTOCOL-002 rejects publication payloads with non-protocol keys', () => {
    assert.throws(
        () => validateOpenWorkspacePublication({ ...makePublication(), unexpected: true }),
        /unexpected fields/
    );
    assert.throws(
        () => validateOpenWorkspacePublication({
            ...makePublication(),
            workspace: { ...makeRecord(), unexpected: true },
        }),
        /unexpected fields/
    );
});

test('OPEN-PROTOCOL-003 rejects aggregate registrations that share an instance ID', () => {
    assert.throws(
        () => validateOpenWorkspaceAggregate({
            protocolVersion: 3,
            semanticRevision: 'd'.repeat(64),
            observedAtMs: 5000,
            registrations: [makeRegistration(), makeRegistration(FIRST_INSTANCE_ID, { sequence: 2 })],
        }),
        /duplicate instanceId/
    );
});

test('OPEN-PROTOCOL-004 accepts the maximum record count and rejects one more', () => {
    assert.equal(MAX_OPEN_WORKSPACE_RECORDS, 100);
    assert.doesNotThrow(() => validateOpenWorkspacePublication({
        ...makePublication(),
        workspace: makeRecord({
            kind: 'savedMultiRoot',
            navigationUri: 'file:///work/all.code-workspace',
            roots: Array.from({ length: MAX_OPEN_WORKSPACE_RECORDS }, (_, ordinal) => ({
                id: ordinal.toString(16).padStart(64, '0'), name: `Root ${ordinal}`,
                uri: `file:///work/root-${ordinal}`, ordinal,
            })),
        }),
    }));
    assert.throws(
        () => validateOpenWorkspacePublication({
            ...makePublication(),
            workspace: makeRecord({
                kind: 'savedMultiRoot', navigationUri: 'file:///work/all.code-workspace',
                roots: Array.from({ length: MAX_OPEN_WORKSPACE_RECORDS + 1 }, (_, ordinal) => ({
                    id: ordinal.toString(16).padStart(64, '0'), name: `Root ${ordinal}`,
                    uri: `file:///work/root-${ordinal}`, ordinal,
                })),
            }),
        }),
        /at most 100 records|at most 100/
    );
});

test('OPEN-PROTOCOL-005 keeps semantic revisions stable when only transient registration fields change', () => {
    const registration = makeRegistration();
    const revision = createOpenWorkspaceSemanticRevision([registration]);

    assert.equal(
        createOpenWorkspaceSemanticRevision([{ ...registration, sequence: 99, leaseUpdatedAtMs: 9999 }]),
        revision
    );
    assert.notEqual(
        createOpenWorkspaceSemanticRevision([{ ...registration, lastFocusedAtMs: 4001 }]),
        revision
    );
});

test('OPEN-PROTOCOL-006 keeps semantic revisions stable when registrations arrive in a different order', () => {
    const first = makeRegistration(FIRST_INSTANCE_ID, { lastFocusedAtMs: 4000 });
    const second = makeRegistration(SECOND_INSTANCE_ID, { lastFocusedAtMs: 3000 });

    assert.equal(
        createOpenWorkspaceSemanticRevision([first, second]),
        createOpenWorkspaceSemanticRevision([second, first])
    );
});
