'use strict';

const {
    createDirectRuntimeHarness,
    createTmuxRuntimeHarness,
    defineRuntimeContract,
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
}
