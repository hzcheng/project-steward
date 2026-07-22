'use strict';

const {
    createDirectRuntimeHarness,
    createTmuxRuntimeHarness,
    defineRuntimeContract,
} = require('../../helpers/runtimeContract');

// SESSION-DIRECT-BACKEND-001
// RUNTIME-RUNTIME-CONFIGURATION-001: backend selection rejects unavailable or invalid runtime configuration.
// RUNTIME-LAUNCH-SPEC-001: each contract submits immutable create/resume launch inputs.
// RUNTIME-TMUX-LAYOUT-001: both project and session layouts execute the same public backend contract.
// RUNTIME-TMUX-CLIENT-001: the fake runner is only the environment boundary for the real client/backend contract.
// RUNTIME-HOST-RUNTIME-COMPOSITION-001: Direct and tmux backends expose one coordinator-compatible surface.
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
