'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createDirectRuntimeHarness,
    createTmuxRuntimeHarness,
    defineRuntimeContract,
    fakeResumeRequest,
} = require('../../helpers/runtimeContract');

// SESSION-DIRECT-BACKEND-001
defineRuntimeContract({
    backendId: 'vscode',
    layout: 'direct',
    createHarness: createDirectRuntimeHarness,
});

// RUNTIME-TMUX-BACKEND-001
for (const layout of ['project', 'session']) {
    defineRuntimeContract({
        backendId: 'tmux',
        layout,
        createHarness: () => createTmuxRuntimeHarness(layout),
    });

    test(`RUNTIME-TMUX-BACKEND-001 [tmux ${layout}] focus after reload reuses the current-window attach terminal`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        const request = fakeResumeRequest(`reload-focus-${layout}`);
        const runtime = await harness.backend.ensureResume(request, layout);
        await harness.dependencies.attachStore.flush();
        const viewerCount = harness.viewerCount();
        harness.terminals[0].shown = false;

        const reloadedBackend = harness.createReloadedBackend();
        await reloadedBackend.focus(reloadedBackend.find(runtime.identity)[0]);

        assert.equal(harness.viewerCount(), viewerCount);
        assert.equal(harness.terminals[0].shown, true);
    });

    test(`RUNTIME-TMUX-BACKEND-001 [tmux ${layout}] focus after reload recovers the live tmux client when VS Code drops terminal metadata`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        const request = fakeResumeRequest(`reload-live-client-${layout}`);
        const runtime = await harness.backend.ensureResume(request, layout);
        await harness.dependencies.attachStore.flush();
        const originalTerminal = harness.terminals[0];
        const viewerCount = harness.viewerCount();
        originalTerminal.shown = false;
        harness.loseReloadAttachMetadata(originalTerminal);

        const reloadedBackend = harness.createReloadedBackend();
        await reloadedBackend.focus(reloadedBackend.find(runtime.identity)[0]);

        assert.equal(
            harness.viewerCount(),
            viewerCount,
            'a reload must not open a second terminal for the same live tmux client'
        );
        assert.equal(originalTerminal.shown, true);
        assert.equal(
            harness.operations.some(operation => operation.type === 'get-client-session'),
            true,
            'reload recovery must use the live terminal process when VS Code metadata is unavailable'
        );
    });

    test(`RUNTIME-TMUX-BACKEND-001 [tmux ${layout}] creates a recoverable tmux attach terminal`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        await harness.backend.ensureResume(
            fakeResumeRequest(`recoverable-attach-${layout}`),
            layout
        );
        const attach = harness.operations.find(operation =>
            operation.type === 'create-terminal'
        );

        assert.deepEqual(
            attach.creationOptions.shellArgs.slice(0, 2),
            ['attach-session', '-t']
        );
        assert.equal(
            harness.backend.isAttachTerminalCandidate({
                creationOptions: attach.creationOptions,
            }),
            true,
            'managed attach terminals must remain recoverable after extension reload'
        );
        assert.equal(
            harness.backend.isAttachTerminalCandidate({
                creationOptions: {
                    ...attach.creationOptions,
                    shellArgs: [
                        'attach-session',
                        '-d',
                        '-t',
                        attach.creationOptions.shellArgs[2],
                    ],
                },
            }),
            true,
            'terminals created by the previous exclusive-attach build must remain recoverable'
        );
    });

    test(`RUNTIME-TMUX-BACKEND-001 RUNTIME-TMUX-THREAD-SWITCH-001 [tmux ${layout}] focuses a durably rebound Codex thread when tmux metadata still names the original thread`, async () => {
        const harness = createTmuxRuntimeHarness(layout);
        const originalRequest = fakeResumeRequest(`original-thread-${layout}`);
        const original = await harness.backend.ensureResume(originalRequest, layout);
        const originalBinding = await harness.store.getKnown(
            original.identity.provider,
            original.identity.sessionId
        );
        const reboundSessionId = `rebound-thread-${layout}`;

        assert.equal(
            await harness.store.rebindKnown(originalBinding, reboundSessionId),
            'rebound'
        );
        await harness.backend.refresh(true);
        const reboundIdentity = {
            ...original.identity,
            sessionId: reboundSessionId,
        };
        const rebound = harness.backend.find(reboundIdentity);
        assert.equal(rebound.length, 1);
        const focusCount = harness.focusCount();

        await harness.backend.focus(rebound[0]);

        assert.equal(harness.focusCount(), focusCount + 1);
        const runtimeWindow = harness.windows.find(window =>
            window.sessionName === rebound[0].tmux.sessionName
            && (!rebound[0].tmux.windowName
                || window.windowName === rebound[0].tmux.windowName)
        );
        assert.equal(
            runtimeWindow.metadata.sessionId,
            original.identity.sessionId,
            'thread switching does not rewrite the live tmux metadata'
        );

        await harness.store.removeKnown(
            reboundIdentity.provider,
            reboundIdentity.sessionId
        );
        await assert.rejects(
            harness.backend.focus(rebound[0]),
            error => error?.name === 'AiSessionRuntimeTargetChangedError'
        );
        assert.equal(
            harness.focusCount(),
            focusCount + 1,
            'metadata mismatch is accepted only while the exact durable rebind exists'
        );
    });
}

test('RUNTIME-TMUX-PROJECT-FIRST-WINDOW-001 creates the first project runtime in the initial tmux window', async () => {
    const harness = createTmuxRuntimeHarness('project');
    const runtime = await harness.backend.ensureResume(
        fakeResumeRequest('first-project-window'),
        'project'
    );
    const newSessionOperations = harness.operations.filter(item => item.type === 'new-session');
    const newWindowOperations = harness.operations.filter(item => item.type === 'new-window');

    assert.equal(harness.windows.length, 1);
    assert.equal(newSessionOperations.length, 1);
    assert.equal(newWindowOperations.length, 0);
    assert.equal(harness.windows[0].sessionName, runtime.tmux.sessionName);
    assert.equal(harness.windows[0].windowName, runtime.tmux.windowName);
    assert.equal(newSessionOperations[0].windowName, runtime.tmux.windowName);
    assert.notEqual(harness.windows[0].windowName, 'project-steward');
});
