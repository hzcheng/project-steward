# TODO Continuous Workflow Verification

Date: 2026-07-24

Status: **PASS**

Branch: `feat/todo-ux-overhaul`

Verified implementation commit: `401e29e44e738708315a7a534872ee0d6b94b5d4`

The branch and worktree started from `main` commit
`6e614d84b1ca7717e9e28a813cd27dc7b1df7633`. The primary checkout was not
modified by this work.

## User-visible acceptance

The TODO surface now provides:

- a continuous page-level list without nested group scroll containers;
- two-line task titles in list cards;
- full-card and title activation into a focused detail surface;
- complete title, notes, priority, group, and timestamps in detail;
- detail editing, including moving a task between groups;
- list restoration to the originating scroll position and focus on Back,
  `Escape`, or `Alt+Left`;
- group-local quick creation with `Enter` submit and `Escape` cancel;
- explicit drag handles, with card clicks reserved for opening detail;
- optimistic completion, deletion, and reorder with authoritative rollback;
- a five-second exact Undo path for completion and deletion;
- search results that open and synchronize the focused TODO detail;
- responsive composition controls down to a 240-pixel panel width.

## Fresh verification gates

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run test:deterministic` | 0 | 490 tests passed: 167 unit, 250 contract, 73 integration |
| `npm run test:behavior-contracts` | 0 | 37 catalog and main-capability tests passed; catalog checks passed |
| `npm run test:dashboard` | 0 | Dashboard Webview checks passed |
| `npm run test:architecture-guards` | 0 | Architecture guards passed |
| `npm run lint:ci` | 0 | TSLint warning baseline checks passed |
| `npm run test:safety` | 0 | Workspace parity, AI session tmux, AI session safety, and open-workspace safety checks passed |
| `npm run test:release-packaging` | 0 | Release packaging checks passed |
| `npm run vscode:prepublish` | 0 | Production Webpack and Gulp builds completed successfully |

The production build emits the repository's existing Webpack deprecation
warnings for `Compilation.modules` and `Module.errors`; compilation and every
gate above still exited successfully.

## Release artifacts

| Artifact | SHA-256 | Verification |
| --- | --- | --- |
| `artifacts/project-steward-2.1.5.vsix` | `e6171b386720ac08321ba9a09fb339c5667ac45b82a8ec89e46a3aaf6e446827` | Archive integrity passed; contains `media/webviewTodoScripts.js` |
| `artifacts/project-steward-attention-ui-bridge-0.1.4.vsix` | `758a9d56df8184648705f524859f23cd4f46d8fb3e450569381367307983fdc5` | Release packaging check passed |

## VS Code Server installation

Environment:

- `REMOTE_CONTAINERS=true`
- VS Code `1.127.0`, commit
  `4fe60c8b1cdac1c4c174f2fb180d0d758272d713`, `x64`
- Node.js `v26.5.0`
- npm `12.0.1`

The repository's `npm run install-local` packaged both artifacts successfully,
then encountered an environment-only failure because the inherited
`VSCODE_IPC_HOOK_CLI` referenced a stale socket. The active VS Code Server and
its server-side extension CLI were verified independently. The workspace
extension was then installed through that pinned CLI:

```text
/home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server
```

The install exited 0 and reported:

```text
Installing extensions...
Extension 'project-steward-2.1.5.vsix' was successfully installed.
```

Post-install listing reports `hzcheng.project-steward@2.1.5`. The installed
`media/webviewTodoScripts.js` and the packaged worktree asset both have SHA-256
`9432ce5f3cb83e7074bef43dc9bc5bb59f6d9981163330a3b040b53953a2f825`,
confirming that the installed TODO interaction code is the verified build.
The already-installed UI bridge was not changed.

The active Extension Host must reload before it can execute the newly installed
extension files.

## Decision

The continuous TODO workflow is implemented, packaged, installed, and verified.
The feature branch remains isolated and has not been merged into `main`.
