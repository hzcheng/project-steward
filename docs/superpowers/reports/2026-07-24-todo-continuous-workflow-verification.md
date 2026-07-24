# TODO Continuous Workflow Verification

Date: 2026-07-24

Status: **PASS**

Branch: `feat/todo-ux-overhaul`

Verified implementation commit: `94b571ade72bcf0d34a5f093f5f2e028d152122f`

The branch and worktree started from `main` commit
`6e614d84b1ca7717e9e28a813cd27dc7b1df7633`. The primary checkout was not
modified by this work.

## User-visible acceptance

The TODO surface now provides:

- a continuous page-level list without nested group scroll containers;
- two-line task titles in list cards;
- a centered SVG group chevron that points down when expanded and right when
  collapsed;
- full-card and title activation into an inline detail area without replacing
  the list;
- second-click collapse of the inline detail, with neighboring cards flowing
  below the expanded card;
- complete title, notes, priority, group, and timestamps in the inline detail;
- detail editing, including moving a task between groups;
- `Escape` and `Alt+Left` collapse the inline detail and restore card focus;
- group-local quick creation with `Enter` submit and `Escape` cancel;
- explicit drag handles, with card clicks reserved for toggling inline detail;
- optimistic completion, deletion, and reorder with authoritative rollback;
- ordered rebasing of rapid optimistic changes over host acknowledgements;
- a five-second exact Undo path for completion and deletion;
- search results that reveal hidden or collapsed tasks before opening inline
  detail;
- targeted card and group DOM patches that avoid rebuilding the TODO surface
  for disclosure changes and matching command acknowledgements;
- preservation of unsaved edit drafts across unrelated command results;
- responsive composition controls down to a 240-pixel panel width.
- activation- and document-scoped Webview asset URLs, so a window recovers its
  stylesheet and scripts after a same-version forced extension replacement
  instead of remaining in the unstyled startup state.

## Fresh verification gates

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run test:deterministic` | 0 | 497 tests passed: 167 unit, 250 contract, 80 integration |
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
| `artifacts/project-steward-2.1.5.vsix` | `f466febc990b119d3e133bca2af712737b17b691a2c937c3603936c4592ed615` | Archive integrity passed; contains the Webview asset-recovery fix |
| `artifacts/project-steward-attention-ui-bridge-0.1.4.vsix` | `4193c24166547f4a46354a51cd3e39057129de9d2ecd28af34291d205593d301` | Archive integrity and release packaging checks passed |

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
`6661429c70e63f11606ba97258b29cc8aa5563150ed7772ea37d97f0047fea70`.
The installed `media/styles.css` and the packaged worktree asset both have
SHA-256
`b83e912bbc9057a9348aafe323c529d16f4bec9d04a0c9980236c6a8f04c9fff`.
The installed and packaged `dist/dashboard.js` both have SHA-256
`2067079260b4b076b914b277e8dc98212280b627687d701cb1b1cc90ed2b2d15`.
These matches confirm that the installed TODO interaction, presentation, and
Webview asset-recovery code is the verified build. The already-installed UI
bridge was not changed.

The P0 `WEBVIEW-RESOURCE-RECOVERY-001` integration contract verifies that every
external stylesheet and script URL shares one revision within a rendered
document, that a subsequent render receives a new revision, and that a fresh
Extension Host activation receives a new namespace rather than repeating the
previous URL.

The active Extension Host must reload before it can execute the newly installed
extension files.

## Decision

The continuous TODO workflow is implemented, packaged, installed, and verified.
The feature branch remains isolated and has not been merged into `main`.
