# AI Session Terminal Workbench Focus Verification

Date: 2026-07-24
Branch: `feat/todo-ux-overhaul`
Implementation commit: `34df29af34e5a6b1931ae2e7d47fa12c22bd0bc5`

## Outcome

Clicking a successfully resolved active or pending AI-session card now completes the full user transaction:

1. validate workspace ownership and the exact runtime;
2. select and reveal the Direct or tmux terminal;
3. request the existing incremental AI-session projection refresh;
4. explicitly focus the VS Code Terminal work area with `workbench.action.terminal.focus`.

Successful explicit conflict selections use the same final focus step. Missing, foreign, cancelled, changed, and failed runtime selections do not move workbench focus.

## Diagnosis

The reported Codex session was inspected directly:

```text
sessionId: 019f9178-8dce-79d1-8b5d-d19ffa92c3dd
workspaceScopeIdentity: fbc870800f721df95eae6b7bc4d0268117098b65582379ad3949af3662d20578
workspaceNavigationIdentity: ceca71bc24e720fa57bd22b172efcd9c187daea0a1d179086493677127dac960
tmux target: ps-vscode-dashboard-0a5108ed:codex-快速修复-ac81bb8e
tmux pane: %67
tmux pane cwd: /home/hzcheng/projects/repos/vscode-dashboard
```

The durable runtime record, live tmux target, and attached tmux client were all present. The target window was already selectable and there was no `focus-runtime` failure. The missing step was at the workbench boundary: the controller treated `Terminal.show()` as complete and never explicitly transferred focus from the sidebar Webview to the Terminal work area.

VS Code does not provide a reliable exact-existing-application-window focus command. The implementation therefore guarantees the supported behavior in the current VS Code window and makes no unsupported external-window claim.

## TDD Evidence

Required CI trace:

`quality-linux` → `npm run test:ci:linux` → `npm run test:deterministic:run` → `tests/contract/aiSessions/sessionControllers.test.js`

Before production changes, the focused contract failed on both new success assertions:

```text
Expected: ['show', 'refresh', 'focus-terminal-view', 'dispose', 'refresh']
Actual:   ['show', 'refresh', 'dispose', 'refresh']

Expected: ['focus-runtime', 'refresh', 'focus-terminal-view']
Actual:   ['focus-runtime', 'refresh']
```

After the minimal controller and Dashboard wiring change:

```text
tests/contract/aiSessions/sessionControllers.test.js
5 passed, 0 failed
```

The contract additionally verifies pending focus, valid conflict selection, foreign workspace rejection, and runtime focus failure behavior.

## Review-Fix-Commit Loop

Self-review found one Important compatibility issue and no Critical issues:

- Making the injected workbench-focus callback a hard constructor requirement broke isolated runtime safety consumers that intentionally do not compose VS Code UI behavior.

The callback was changed to an optional controller capability while production Dashboard composition supplies it unconditionally. Fresh safety verification then passed:

```text
Workspace parity checks passed.
AI session tmux checks passed.
AI session safety checks passed.
Open workspace safety checks passed.
```

No unresolved Critical, Important, or Minor findings remain.

## Verification

Focused post-review verification:

```text
npm run test-compile
node --test --test-concurrency=1 tests/contract/aiSessions/sessionControllers.test.js
npm run test:safety:run
npm run test:behavior-contracts
git diff --check
```

Results:

- session controller: `5 passed, 0 failed`;
- safety checks: passed;
- behavior catalog/tooling: `37 passed, 0 failed`;
- diff check: passed.

Layered and real-environment verification:

```text
npm run test:deterministic
PROJECT_STEWARD_TMUX_PATH=/usr/bin/tmux npm run test:tmux:smoke
npm run test:ci:linux
```

Results:

- deterministic: `521 passed, 0 failed`;
- isolated real tmux smoke: passed;
- Linux CI-equivalent gate: passed;
- behavior contracts, lint baseline, safety, Dashboard, architecture baseline and guards, release notes, release packaging, production bundle, coverage, and coverage baseline: passed;
- coverage: statements `80.49%`, branches `72.34%`, functions `82.03%`, lines `80.49%`.

## Package and Installation

The Linux gate produced:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `artifacts/project-steward-2.1.5.vsix` | 258160 | `32a16b759a046f2a106368fb255ed4027caaa8fabbce7a78c59a751731945f91` |
| `artifacts/project-steward-attention-ui-bridge-0.1.4.vsix` | 15105 | `856df72eb46b282555861467a7e3a747b2fda611662120be67c39fe3ea5c89d3` |

The main archive passed `unzip -t`. Its packaged `dist/dashboard.js` contains `workbench.action.terminal.focus`.

The main extension was force-installed with the pinned Dev Container VS Code Server:

```text
/home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server
Extension 'project-steward-2.1.5.vsix' was successfully installed.
```

Installed versions:

```text
hzcheng.project-steward@2.1.5
hzcheng.project-steward-attention-ui-bridge@0.1.4
```

The installed main bundle also contains `workbench.action.terminal.focus`. The already installed UI Bridge was not reinstalled or modified.

## Isolation

- Feature worktree: `/home/hzcheng/projects/repos/vscode-dashboard/.worktree/todo-ux`
- Protected primary checkout: `/home/hzcheng/projects/repos/vscode-dashboard`
- Primary branch/head remained `main` at `6e614d84b1ca7717e9e28a813cd27dc7b1df7633`.
- The existing primary-checkout `.vscode/settings.json` modification was preserved.
- No push, PR, merge, or protected-branch write was performed.
