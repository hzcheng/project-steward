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
}
