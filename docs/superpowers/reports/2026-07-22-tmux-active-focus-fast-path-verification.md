# Tmux Active Session Focus Fast Path Verification

Date: 2026-07-22

Branch: `feat/workspace-support`

## Scope

- Added a bounded exact-target tmux metadata snapshot.
- Validated the complete workspace-aware runtime identity before `select-window`.
- Removed full Direct/tmux discovery from the healthy unique-tmux focus path.
- Added one typed target-change reconciliation and one retry.
- Parallelized the fixed 12 metadata reads for one discovery target without increasing concurrency with total window count.
- Made no Dashboard Webview, card-style, icon, animation, copy, or click-target changes.

## TDD Evidence

- Target snapshot test failed with `targetClient.getTargetWindow is not a function`, then passed after the client implementation.
- Backend ownership test failed with `Missing expected rejection`, then passed after live identity verification was added.
- Coordinator fast-path test failed because Direct refresh was `[true]` instead of `[]`, then passed after the tmux fast path was added.
- Metadata concurrency test failed with peak `1 !== 12`, then passed with fixed-count concurrent reads.

## Automated Verification

The following fresh commands exited 0:

```text
npm run test:workspace-parity
npm run test:safety
npm run test:dashboard
npm run test:tmux:smoke
npm run test:release-packaging
```

Observed pass messages included:

- `Workspace parity checks passed.`
- `AI session tmux checks passed.`
- `AI session safety checks passed.`
- `Open workspace safety checks passed.`
- `Dashboard Webview checks passed.`
- `AI session tmux smoke checks passed.`
- `Release packaging checks passed.`

## Real Tmux Performance

Measured against the current Dev Container tmux server with 24 windows after warming availability:

```json
{"windows":24,"targetedAverageMs":2.55,"targetedP95Ms":2.82,"fullDiscoveryMs":523.24}
```

The normal focus path now performs the targeted snapshot instead of waiting for the measured full discovery.

## Artifact and Installation

Main VSIX:

```text
/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/feat-workspace-support/artifacts/project-steward-2.1.3.vsix
SHA-256: 9279ffb2c6f4d8bb8ebdc91260be36b877b5a10ee7475b8abb1997e5971a08b6
```

Installed with the pinned Dev Container host:

```text
/home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server
```

Installation output reported `Extension 'project-steward-2.1.3.vsix' was successfully installed.` Post-install listing:

```text
hzcheng.project-steward@2.1.3
hzcheng.project-steward-attention-ui-bridge@0.1.3
```

The UI bridge was not installed or overwritten.
