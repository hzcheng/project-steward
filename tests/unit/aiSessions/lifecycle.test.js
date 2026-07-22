'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const lifecycle = require('../../../out/aiSessions/lifecycle');

// PERSIST-LIFECYCLE-PARSER-001

const fixturesRoot = path.resolve(__dirname, '../../fixtures/providers');
const runStartedAtMs = Date.parse('2026-07-20T00:00:00.000Z');
const providers = [{
    id: 'codex',
    parser: lifecycle.parseCodexLifecycleLines,
    stoppedReason: 'aborted',
}, {
    id: 'kimi',
    parser: lifecycle.parseKimiLifecycleLines,
    stoppedReason: 'aborted',
}, {
    id: 'claude',
    parser: lifecycle.parseClaudeLifecycleLines,
    stoppedReason: 'failed',
}];

function readLines(providerId, state) {
    return fs.readFileSync(
        path.join(fixturesRoot, providerId, 'lifecycle', `${state}.jsonl`),
        'utf8'
    ).split(/\r?\n/g);
}

for (const provider of providers) {
    const cases = [{
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
        expected: { phase: 'needsAttention', reason: provider.stoppedReason, executionState: 'stopped' },
    }];

    for (const fixtureCase of cases) {
        test(`PERSIST-LIFECYCLE-PARSER-001 [${provider.id}] maps ${fixtureCase.state} lifecycle signals`, () => {
            const signal = provider.parser(readLines(provider.id, fixtureCase.state), runStartedAtMs);
            assert.ok(signal, `${provider.id} ${fixtureCase.state} fixture must produce a signal`);
            for (const [key, value] of Object.entries(fixtureCase.expected)) {
                assert.equal(signal[key], value);
            }
            assert.match(signal.token, new RegExp(`^${provider.id}:`));
            assert.ok(signal.occurredAtMs >= runStartedAtMs);
        });
    }

    test(`PERSIST-LIFECYCLE-PARSER-001 [${provider.id}] isolates malformed and pre-run fixture lines`, () => {
        const signal = provider.parser(readLines(provider.id, 'malformed'), runStartedAtMs);
        assert.ok(signal);
        assert.equal(signal.phase, 'running');
        assert.equal(signal.executionState, 'running');
        assert.ok(signal.occurredAtMs >= runStartedAtMs);
    });
}
