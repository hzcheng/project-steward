'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('./tempDirectory');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readLifecycleLines(fixturesRoot, state) {
    return fs.readFileSync(path.join(fixturesRoot, 'lifecycle', `${state}.jsonl`), 'utf8')
        .split(/\r?\n/g);
}

function withProviderHome(testContext, fixturesRoot, manifest, useFixtures, callback) {
    const temporaryRoot = makeTempDirectory(testContext, `project-steward-${manifest.id}-contract-`);
    const providerHome = path.join(temporaryRoot, 'provider-home');
    if (useFixtures) {
        fs.cpSync(path.join(fixturesRoot, 'home'), providerHome, { recursive: true });
        for (const [relativePath, timestamp] of Object.entries(manifest.fileTimes || {})) {
            const fixturePath = path.join(providerHome, relativePath);
            const fixtureTime = new Date(timestamp);
            fs.utimesSync(fixturePath, fixtureTime, fixtureTime);
        }
    } else {
        fs.mkdirSync(providerHome, { recursive: true });
    }

    const environmentVariable = manifest.environmentVariable;
    const previousValue = process.env[environmentVariable];
    process.env[environmentVariable] = providerHome;
    try {
        return callback(providerHome);
    } finally {
        if (previousValue === undefined) {
            delete process.env[environmentVariable];
        } else {
            process.env[environmentVariable] = previousValue;
        }
    }
}

function assertSignal(signal, expected, providerId) {
    assert.ok(signal, `${providerId} fixture must produce a lifecycle signal`);
    for (const [key, value] of Object.entries(expected)) {
        assert.equal(signal[key], value);
    }
    assert.match(signal.token, new RegExp(`^${providerId}:`));
}

function defineProviderContract({ id, serviceFactory, fixtures, definition }) {
    let manifest;
    try {
        manifest = readJson(path.join(fixtures.root, 'manifest.json'));
    } catch (error) {
        test(`SESSION-PROVIDER-001 [${id}] loads its fixture manifest`, () => {
            throw error;
        });
        return;
    }

    test(`SESSION-PROVIDER-001 [${id}] exposes stable metadata, project keys, and launch specs`, () => {
        const directoryScope = Object.freeze({
            workspaceNavigationIdentity: `navigation:${manifest.projectPath}`,
            workspaceScopeIdentity: `scope:${manifest.projectPath}`,
            workspaceRootHostPaths: Object.freeze([manifest.projectPath]),
            primaryRootId: `root:${manifest.projectPath}`,
            primaryCwd: manifest.projectPath,
            additionalDirectories: Object.freeze([]),
        });
        assert.equal(manifest.id, id, `SESSION-PROVIDER-001 [${id}] fixture manifest must match`);
        assert.equal(definition.id, id);
        assert.equal(definition.label, manifest.label);
        assert.equal(definition.projectSessionsKey, manifest.projectSessionsKey);
        assert.equal(definition.projectSessionsUnavailableKey, manifest.projectSessionsUnavailableKey);
        assert.equal(typeof definition.buildResumeLaunchSpec, 'function');
        assert.equal(typeof definition.buildNewSessionLaunchSpec, 'function');
        assert.deepEqual(
            definition.buildResumeLaunchSpec(
                manifest.launch.sessionId,
                directoryScope,
                manifest.launch.markerPath
            ),
            manifest.launch.resume
        );
        assert.deepEqual(
            definition.buildNewSessionLaunchSpec(
                directoryScope,
                manifest.launch.title,
                manifest.launch.markerPath
            ),
            manifest.launch.create
        );
        assert.equal(manifest.launch.resume.markerPath, manifest.launch.markerPath);
        assert.equal(manifest.launch.create.markerPath, manifest.launch.markerPath);
    });

    test(`SESSION-PROVIDER-001 [${id}] maps an isolated empty provider home to unavailable`, t => {
        withProviderHome(t, fixtures.root, manifest, false, () => {
            assert.deepEqual(serviceFactory().getSessions({ forceRefresh: true }), {
                available: false,
                sessions: [],
                scannedFiles: 0,
                parsedFiles: 0,
            });
        });
    });

    test(`SESSION-AI-SESSION-PROVIDER-MAX-FILES-001 [${id}] bounds parsing after deterministic discovery`, t => {
        withProviderHome(t, fixtures.root, manifest, true, () => {
            const result = serviceFactory().getSessions({
                forceRefresh: true,
                maxFiles: manifest.bounded.maxFiles,
            });
            assert.equal(result.available, true);
            assert.equal(result.scannedFiles, manifest.bounded.scannedFiles);
            assert.equal(result.parsedFiles, manifest.bounded.parsedFiles);
            assert.deepEqual(result.sessions.map(session => session.id), manifest.bounded.sessionIds);
        });
    });

    test(`SESSION-PROVIDER-001 [${id}] orders, filters, and isolates malformed fixture records`, t => {
        withProviderHome(t, fixtures.root, manifest, true, () => {
            const allSessions = serviceFactory().getSessions({ forceRefresh: true });
            assert.equal(allSessions.available, true);
            assert.equal(allSessions.scannedFiles, manifest.orderedSessionIds.length);
            assert.deepEqual(allSessions.sessions.map(session => session.id), manifest.orderedSessionIds);
            assert.deepEqual(allSessions.sessions.map(session => ({
                id: session.id,
                name: session.name,
                path: session.workDir || session.cwd,
            })), manifest.orderedSessions);

            const projectSessions = serviceFactory().getSessions({
                forceRefresh: true,
                candidatePaths: [manifest.projectPath],
            });
            assert.deepEqual(projectSessions.sessions.map(session => session.id), manifest.projectSessionIds);
            assert.ok(projectSessions.sessions.every(session =>
                (session.workDir || session.cwd).startsWith(manifest.projectPath)
            ));
        });
    });

    test(`SESSION-PROVIDER-001 [${id}] archives only the requested fixture session`, t => {
        withProviderHome(t, fixtures.root, manifest, true, () => {
            const service = serviceFactory();
            assert.ok(service.getSessions({ forceRefresh: true }).sessions.some(session =>
                session.id === manifest.archiveSessionId
            ));
            assert.equal(service.archiveSession(manifest.archiveSessionId), true);
            const remainingIds = service.getSessions({ forceRefresh: true }).sessions.map(session => session.id);
            assert.equal(remainingIds.includes(manifest.archiveSessionId), false);
            assert.deepEqual(remainingIds, manifest.orderedSessionIds.filter(idValue =>
                idValue !== manifest.archiveSessionId
            ));
        });
    });

    const lifecycleCases = [{
        state: 'running',
        expected: { phase: 'running', executionState: 'running' },
    }, {
        state: 'waiting',
        expected: { phase: 'needsAttention', reason: 'input-required', executionState: 'stopped' },
    }, {
        state: 'completed',
        expected: { phase: 'needsAttention', reason: 'completed', executionState: 'stopped' },
    }, {
        state: 'stopped',
        expected: {
            phase: 'needsAttention',
            reason: manifest.lifecycle.stoppedReason,
            executionState: 'stopped',
        },
    }];

    for (const lifecycleCase of lifecycleCases) {
        test(`PERSIST-LIFECYCLE-PARSER-001 [${id}] satisfies the ${lifecycleCase.state} provider contract`, () => {
            const signal = fixtures.parseLifecycleLines(
                readLifecycleLines(fixtures.root, lifecycleCase.state),
                manifest.lifecycle.runStartedAtMs
            );
            assertSignal(signal, lifecycleCase.expected, id);
        });
    }

    test(`PERSIST-PROVIDER-LIFECYCLE-SERVICE-001 [${id}] advances fixture lifecycle without rescanning`, t => {
        withProviderHome(t, fixtures.root, manifest, true, providerHome => {
            const service = serviceFactory();
            const request = {
                sessionId: manifest.lifecycle.serviceSessionId,
                runStartedAtMs: manifest.lifecycle.runStartedAtMs,
            };
            let signals = service.getLifecycleSignals([request]);
            assertSignal(signals[manifest.lifecycle.serviceSessionId], {
                phase: 'running',
                executionState: 'running',
            }, id);

            fs.appendFileSync(
                path.join(providerHome, manifest.lifecycle.serviceFile),
                `${fs.readFileSync(path.join(fixtures.root, 'lifecycle', 'completed.jsonl'), 'utf8').trim()}\n`,
                'utf8'
            );
            const originalReaddirSync = fs.readdirSync;
            fs.readdirSync = () => {
                throw new Error(`${id} cached lifecycle lookup must not rescan provider roots`);
            };
            try {
                signals = service.getLifecycleSignals([request]);
            } finally {
                fs.readdirSync = originalReaddirSync;
            }
            assertSignal(signals[manifest.lifecycle.serviceSessionId], {
                phase: 'needsAttention',
                reason: 'completed',
                executionState: 'stopped',
            }, id);
            assert.deepEqual(service.getLifecycleSignals([{
                ...request,
                runStartedAtMs: request.runStartedAtMs + 86_400_000,
            }]), {});
        });
    });
}

module.exports = {
    defineProviderContract,
};
