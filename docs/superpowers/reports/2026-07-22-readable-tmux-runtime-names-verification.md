# Readable tmux Runtime Names Verification

Date: 2026-07-22

Status: **PASS**

Baseline under verification: `140eeddbd147db009da638cc07c0d30e155e87c7`

The verification ran in the pinned VS Code Dev Container host. `REMOTE_CONTAINERS=true`, and the only CLI used for installation was:

```text
/home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server
```

That CLI reports VS Code `1.127.0`, commit `4fe60c8b1cdac1c4c174f2fb180d0d758272d713`, `x64`.

## Fresh regression and packaging suites

| Command | Exit | Fresh result |
| --- | ---: | --- |
| `npm run test:workspace-parity` | 0 | `Workspace parity checks passed.` |
| `npm run test:safety` | 0 | `Workspace parity checks passed.`; `AI session tmux checks passed.`; `AI session safety checks passed.`; `Open workspace safety checks passed.` |
| `npm run test:dashboard` | 0 | `Dashboard Webview checks passed.` |
| `npm run test:tmux:smoke` | 0 | `AI session tmux smoke checks passed.` |
| `npm run test:architecture-baseline` | 0 | JSON baseline emitted with `dashboardLines: 2012`, `refreshCalls: 2`, `webviewHtmlAssignments: 3`, `providerRegistryCalls: 1`, and providers `codex`, `kimi`, `claude`. |
| `npm run test:release-packaging` | 0 | `Release packaging checks passed.` |

The first real tmux smoke attempt exited 1 at the pending-promotion assertion (`0 !== 1`). Root-cause tracing found that the smoke harness still called the now-three-argument `TmuxRuntimeBackend.promotePending(identity, sessionId, sessionName)` contract with two arguments. Production validation therefore correctly rejected the missing display name before a rename was attempted. The validation harness was minimally updated to pass its already-declared title, then the full smoke command was rerun fresh and exited 0 with the pass message above. No production source was changed during final verification.

Release packaging produced both:

```text
artifacts/project-steward-attention-ui-bridge-0.1.4.vsix
artifacts/project-steward-2.1.3.vsix
```

The Webpack build emitted deprecation warnings for `Compilation.modules` and `Module.errors`; both bundles compiled successfully, packaging exited 0, and the release checker passed. The UI bridge artifact was not installed.

## Visual and persistence scope

Commands:

```bash
git diff 3e21b7f^..HEAD -- src/webview src/styles src/dashboard.ts src/projects src/workspaces
git diff --check
git status --short
```

The scoped diff contains only `src/workspaces/pendingSessionPromotionController.ts` (19 insertions, 2 deletions). It switches pending promotion to the durable runtime-coordinator candidate path and preserves serialized per-scope draining. There are no changes in `src/webview`, `src/styles`, `src/dashboard.ts`, or `src/projects`. Therefore this readable-name change does not alter Dashboard markup/styles/cards or saved-project/workspace persistence behavior. `git diff --check` exited 0.

## Native real-tmux evidence

The real smoke harness used its own randomly named isolated tmux server and native `tmux list-sessions -F '#{session_name}'` plus `tmux list-windows -a -F '#{session_name}\t#{window_name}'`. It asserted that the selected project-layout and session-layout rows appeared verbatim and ended in lowercase hexadecimal 8-character identity suffixes.

Selected project-layout native rows:

```text
list-sessions: ps-Smoke-Project-d989d08e
list-windows:  ps-Smoke-Project-d989d08e	codex-session-one-special-4d1229b0
```

Selected session-layout native rows:

```text
list-sessions: ps-Smoke-Project-kimi-isolated-one-75f97c33
list-windows:  ps-Smoke-Project-kimi-isolated-one-75f97c33	kimi-kimi-isolated-one-75f97c33
```

The native outputs visibly retain the readable project component `Smoke-Project`, readable session components `session-one-special` and `kimi-isolated-one`, and the required suffixes `d989d08e`, `4d1229b0`, and `75f97c33`.

The harness stopped its provider fixtures, killed only its isolated tmux server, removed its own temporary socket/session state, and left the nine pre-existing default-server `project-steward-p-*` sessions unchanged. Inspection also found one stopped fixture directory left by the initial failed harness run; it contained only harness-owned `.stop` files and no live PIDs, and only that exact temporary directory was removed. A final process/temp-root check found no harness server or fixture residue.

## Main VSIX inspection

| Field | Verified value |
| --- | --- |
| Absolute artifact | `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/feat-workspace-support/artifacts/project-steward-2.1.3.vsix` |
| SHA-256 | `081794f05b44781742c14369e5ee8e806b3926816496f2444fecd293e2a65114` |
| Extension ID | `hzcheng.project-steward` |
| Version | `2.1.3` |
| VSIX manifest identity | `Id="project-steward" Version="2.1.3" Publisher="hzcheng"` |
| Archive integrity | `unzip -t`: all entries OK, no compressed-data errors |
| Contents | 37 files, 935,121 uncompressed bytes |

Inspection commands:

```bash
realpath artifacts/project-steward-2.1.3.vsix
sha256sum artifacts/project-steward-2.1.3.vsix
unzip -t artifacts/project-steward-2.1.3.vsix
unzip -p artifacts/project-steward-2.1.3.vsix extension/package.json
unzip -p artifacts/project-steward-2.1.3.vsix extension.vsixmanifest
unzip -l artifacts/project-steward-2.1.3.vsix
```

The 37 archive entries are the two VSIX metadata files plus `extension/package.json`, README, license, changelog, ten `extension/media/*` assets, `extension/dist/dashboard.js`, fourteen compiled `extension/out/workspaces/*` modules, and six compiled `extension/out/openWorkspaces/*` modules. The package manifest declares `publisher: hzcheng`, `name: project-steward`, `version: 2.1.3`, and `main: ./dist/dashboard`.

## Pinned Dev Container installation

Before installation, the pinned CLI reported:

```text
hzcheng.project-steward@2.1.3
hzcheng.project-steward-attention-ui-bridge@0.1.3
```

Only the main artifact was installed:

```bash
/home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server \
  --install-extension \
  /home/hzcheng/projects/repos/vscode-dashboard/.worktrees/feat-workspace-support/artifacts/project-steward-2.1.3.vsix \
  --force
```

The CLI exited 0 and printed:

```text
Installing extensions...
Extension 'project-steward-2.1.3.vsix' was successfully installed.
```

After installation, the same pinned CLI reported:

```text
hzcheng.project-steward@2.1.3
hzcheng.project-steward-attention-ui-bridge@0.1.3
```

The main extension is installed as `hzcheng.project-steward@2.1.3` on the pinned Dev Container workspace host. The user-managed UI bridge remained exactly `0.1.3` before and after. It was not installed, upgraded, overwritten, or otherwise touched. The repository's `install-local` script was intentionally not used because this verification required a main-extension-only install.

## Decision

All required suites, architecture baseline, scope audit, native real-tmux naming assertions, release package inspection, and pinned-host post-install listing pass. The readable tmux runtime-name build is verified for the requested Dev Container install scope.
