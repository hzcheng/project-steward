'use strict';

const Module = require('node:module');
const crypto = require('node:crypto');
const { createFakeClock } = require('../../helpers/fakeClock');

const OPEN_WORKSPACE_LEASE_MS = 30_000;
const SELF = '1'.repeat(32);
const OLDER = '2'.repeat(32);
const NEWER = '3'.repeat(32);
const OTHER = '4'.repeat(32);

function makeRecord(overrides = {}) {
    const sourceUri = overrides.navigationUri || overrides.uri || '/work/shared';
    const navigationUri = sourceUri.includes(':') ? sourceUri : `file://${sourceUri}`;
    const environment = overrides.environment || ({
        ssh: 'ssh', wsl: 'wsl', devContainer: 'devContainer', remote: 'remote', local: 'local',
    }[overrides.remoteType] || 'local');
    const navigationIdentity = overrides.navigationIdentity
        || crypto.createHash('sha256').update(`navigation:${navigationUri}`).digest('hex');
    const scopeIdentity = overrides.scopeIdentity
        || crypto.createHash('sha256').update(`scope:${navigationUri}`).digest('hex');
    const roots = overrides.roots || [{
        id: crypto.createHash('sha256').update(`root:${navigationUri}`).digest('hex'),
        name: overrides.name || 'Shared',
        uri: navigationUri,
        ordinal: 0,
    }];
    return {
        navigationIdentity,
        scopeIdentity,
        kind: overrides.kind || 'singleFolder',
        displayName: overrides.displayName || overrides.name || 'Shared',
        navigationUri,
        environment,
        runningAiSessionCount: overrides.runningAiSessionCount ?? overrides.activeSessionCount ?? 0,
        roots,
    };
}

function makePublication(overrides = {}) {
    return {
        protocolVersion: 3,
        instanceId: SELF,
        sequence: 1,
        followsFocusEvent: false,
        workspace: overrides.workspace || overrides.projects?.[0] || makeRecord(),
        ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'projects')),
    };
}

function makeRegistration(instanceId = SELF, lastFocusedAtMs = 4000, uri = '/work/shared', overrides = {}) {
    return {
        protocolVersion: 3,
        instanceId,
        sequence: 1,
        lastFocusedAtMs,
        leaseUpdatedAtMs: 4500,
        workspace: overrides.workspace || overrides.projects?.[0] || makeRecord({ uri }),
        ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'projects')),
    };
}

function makeAggregate(registrations, overrides = {}) {
    return {
        protocolVersion: 3,
        semanticRevision: 'a'.repeat(64),
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

function createSyntheticOpenWorkspaceStore(initialRegistrations = []) {
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
                if (nowMs - registration.leaseUpdatedAtMs > OPEN_WORKSPACE_LEASE_MS) {
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
    OPEN_WORKSPACE_LEASE_MS,
    OTHER,
    SELF,
    createCommandRegistry,
    createFakeClock,
    createSyntheticOpenWorkspaceStore,
    flushAsync,
    loadWithFakeVscode,
    makeAggregate,
    makePublication,
    makeRecord,
    makeRegistration,
};
