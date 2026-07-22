'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createDeferred,
    createFakeRuntimeBackend,
    fakeCreateRequest,
    fakeResumeRequest,
    fakeRuntime,
} = require('../../helpers/runtimeContract');
const { AiSessionRuntimeCoordinator } = require('../../../out/aiSessions/runtimeCoordinator');
const { TmuxRuntimeUnavailableError } = require('../../../out/aiSessions/runtimeTypes');

function createCoordinator(direct, tmux, overrides = {}) {
    return new AiSessionRuntimeCoordinator({
        direct,
        tmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
        ...overrides,
    });
}

test('RUNTIME-RUNTIME-COORDINATOR-001 RUNTIME-AI-SESSION-RUNTIME-CONTROLLER-001 RUNTIME-RUNTIME-CONTROLLER-001 single-flights concurrent resume and create requests', async () => {
    const resumeGate = createDeferred();
    const pendingGate = createDeferred();
    const direct = createFakeRuntimeBackend('vscode');
    const tmux = createFakeRuntimeBackend('tmux', { resumeGate, pendingGate });
    const coordinator = createCoordinator(direct, tmux);

    const resumes = [
        coordinator.resume(fakeResumeRequest('single-flight')),
        coordinator.resume(fakeResumeRequest('single-flight')),
    ];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tmux.ensureResumeCalls, 1);
    resumeGate.resolve();
    assert.deepEqual((await Promise.all(resumes)).map(result => result.status), ['started', 'started']);

    const creates = [
        coordinator.create(fakeCreateRequest('pending-single-flight')),
        coordinator.create(fakeCreateRequest('pending-single-flight')),
    ];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tmux.ensurePendingCalls, 1);
    pendingGate.resolve();
    assert.deepEqual((await Promise.all(creates)).map(result => result.status), ['started', 'started']);
});

test('RUNTIME-RUNTIME-COORDINATOR-001 reuses one runtime and reports cross-backend conflicts', async () => {
    const direct = createFakeRuntimeBackend('vscode');
    const tmux = createFakeRuntimeBackend('tmux');
    direct.active.push(fakeRuntime('vscode', 'reused'));
    const coordinator = createCoordinator(direct, tmux);

    const reused = await coordinator.resume(fakeResumeRequest('reused'));
    assert.equal(reused.status, 'focused');
    assert.equal(direct.focusCalls.length, 1);
    assert.equal(direct.ensureResumeCalls, 0);

    tmux.active.push(fakeRuntime('tmux', 'reused', {
        attached: false,
        tmux: { layout: 'project', sessionName: 'managed', windowName: 'ai-codex-reused' },
    }));
    const conflict = await coordinator.resume(fakeResumeRequest('reused'));
    assert.equal(conflict.status, 'conflict');
    assert.deepEqual(conflict.conflicts.map(runtime => runtime.backend).sort(), ['tmux', 'vscode']);
});

test('RUNTIME-RUNTIME-COORDINATOR-001 maps tmux unavailable choices without hiding other errors', async () => {
    const direct = createFakeRuntimeBackend('vscode');
    const unavailable = new TmuxRuntimeUnavailableError('not-found', 'tmux unavailable');
    const tmux = createFakeRuntimeBackend('tmux', { refreshError: unavailable });
    const choices = [];
    const coordinator = createCoordinator(direct, tmux, {
        chooseTmuxFallback: async context => {
            choices.push(context);
            return 'direct';
        },
    });

    const result = await coordinator.resume(fakeResumeRequest('fallback'));
    assert.equal(result.status, 'started');
    assert.equal(result.runtime.backend, 'vscode');
    assert.equal(direct.ensureResumeCalls, 1);
    assert.deepEqual(choices.map(choice => [choice.operation, choice.knownHint]), [['resume', false]]);

    const unexpected = new Error('private discovery detail');
    const failing = createCoordinator(
        createFakeRuntimeBackend('vscode'),
        createFakeRuntimeBackend('tmux', { refreshError: unexpected })
    );
    await assert.rejects(failing.resume(fakeResumeRequest('fail-closed')), error => error === unexpected);
});

test('RUNTIME-RUNTIME-COORDINATOR-001 promotes the unique pending backend and preserves conflicts', async () => {
    const direct = createFakeRuntimeBackend('vscode');
    const tmux = createFakeRuntimeBackend('tmux');
    tmux.pending.push(fakeRuntime('tmux', undefined, {
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', pendingId: 'pending-one' },
        state: 'pending', createdAt: '2026-07-18T10:00:00.000Z', excludedSessionIds: [],
        attached: false, tmux: { layout: 'session', sessionName: 'pending-one' },
    }));
    const coordinator = createCoordinator(direct, tmux);

    const promoted = await coordinator.promotePending('pending-one', 'session-one');
    assert.equal(promoted[0].identity.sessionId, 'session-one');
    assert.deepEqual(tmux.promoted, [{ pendingId: 'pending-one', sessionId: 'session-one' }]);

    direct.pending.push(fakeRuntime('vscode', undefined, {
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', pendingId: 'pending-two' },
        state: 'pending', createdAt: '2026-07-18T10:00:00.000Z', excludedSessionIds: [],
    }));
    tmux.pending.push(fakeRuntime('tmux', undefined, {
        identity: { provider: 'codex', projectKey: 'pk', cwd: '/work', pendingId: 'pending-two' },
        state: 'pending', createdAt: '2026-07-18T10:00:00.000Z', excludedSessionIds: [],
        attached: false, tmux: { layout: 'project', sessionName: 'managed', windowName: 'pending-two' },
    }));
    const conflicted = await coordinator.promotePending('pending-two', 'never');
    assert.equal(conflicted.length, 2);
    assert.ok(conflicted.every(runtime => runtime.state === 'conflict'));
});
