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
