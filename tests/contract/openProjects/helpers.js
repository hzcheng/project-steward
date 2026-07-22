'use strict';

const Module = require('node:module');
const { createFakeClock } = require('../../helpers/fakeClock');

const OPEN_PROJECT_LEASE_MS = 30_000;
const SELF = '1'.repeat(32);
const OLDER = '2'.repeat(32);
const NEWER = '3'.repeat(32);
const OTHER = '4'.repeat(32);

function makeRecord(overrides = {}) {
    return {
        localProjectId: '__openProjects-0',
        ordinal: 0,
        name: 'Shared',
        description: 'Workspace folder',
        uri: '/work/shared',
        remoteType: 'local',
        color: '#222',
        ...overrides,
    };
}

function makePublication(overrides = {}) {
    return {
        protocolVersion: 1,
        instanceId: SELF,
        sequence: 1,
        followsFocusEvent: false,
        projects: [makeRecord()],
        ...overrides,
    };
}

function makeRegistration(instanceId = SELF, lastFocusedAtMs = 4000, uri = '/work/shared', overrides = {}) {
    return {
        protocolVersion: 1,
        instanceId,
        sequence: 1,
        lastFocusedAtMs,
        leaseUpdatedAtMs: 4500,
        projects: [makeRecord({ uri })],
        ...overrides,
    };
}

function makeAggregate(registrations, overrides = {}) {
    return {
        protocolVersion: 1,
        semanticRevision: 'revision',
        observedAtMs: 5000,
        registrations,
        ...overrides,
    };
}

function createCommandRegistry() {
    const calls = [];
    const handlers = new Map();
    const register = (command, callback) => {
        handlers.set(command, callback);
        return {
            dispose: () => {
                if (handlers.get(command) === callback) {
                    handlers.delete(command);
                }
            },
        };
    };
    const execute = async (command, argument) => {
        calls.push({ command, argument });
        const handler = handlers.get(command);
        if (!handler) {
            throw new Error(`command is not registered: ${command}`);
        }
        return handler(argument);
    };
    return { calls, execute, handlers, register };
}

function createSyntheticOpenProjectStore(initialRegistrations = []) {
    const registrations = new Map(initialRegistrations.map(value => [value.instanceId, value]));
    return {
        seed(registration) {
            registrations.set(registration.instanceId, registration);
        },
        async write(registration) {
            const previous = registrations.get(registration.instanceId);
            if (previous && registration.sequence < previous.sequence) {
                throw new Error('registration sequence decreased');
            }
            registrations.set(registration.instanceId, registration);
        },
        async remove(instanceId) {
            registrations.delete(instanceId);
        },
        async scan(nowMs) {
            let expired = 0;
            for (const [instanceId, registration] of registrations) {
                if (nowMs - registration.leaseUpdatedAtMs > OPEN_PROJECT_LEASE_MS) {
                    registrations.delete(instanceId);
                    expired += 1;
                }
            }
            const active = Array.from(registrations.values())
                .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
            return {
                registrations: active,
                counters: {
                    active: active.length,
                    parseErrors: 0,
                    oversizedFiles: 0,
                    symlinkFiles: 0,
                    readErrors: 0,
                    rollbackCount: 0,
                    expired,
                },
            };
        },
    };
}

function loadWithFakeVscode(request, vscode = {}) {
    const previousLoad = Module._load;
    try {
        Module._load = function (moduleRequest, parent, isMain) {
            if (moduleRequest === 'vscode') {
                return vscode;
            }
            return previousLoad.call(this, moduleRequest, parent, isMain);
        };
        return require(request);
    } finally {
        Module._load = previousLoad;
    }
}

async function flushAsync(turns = 6) {
    for (let turn = 0; turn < turns; turn += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

module.exports = {
    NEWER,
    OLDER,
    OPEN_PROJECT_LEASE_MS,
    OTHER,
    SELF,
    createCommandRegistry,
    createFakeClock,
    createSyntheticOpenProjectStore,
    flushAsync,
    loadWithFakeVscode,
    makeAggregate,
    makePublication,
    makeRecord,
    makeRegistration,
};
