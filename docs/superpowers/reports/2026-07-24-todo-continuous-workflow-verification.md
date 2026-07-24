# TODO Continuous Workflow Verification

Date: 2026-07-24

Status: **PASS**

Branch: `feat/todo-ux-overhaul`

Verified implementation commit: `c669eb1009cae4071d6a20446f6c4dc7861e5a33`

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
- completion that hides or updates only the selected card in place, updates its
  group and page counts, and does not reload the Webview document or TODO list;
- one-time local Settings write echoes that suppress completion-triggered
  lifecycle refreshes without hiding later Settings Sync or mixed
  configuration changes;
- authoritative completion acknowledgements that stay incremental when only
  completion timestamps differ, while concurrent sibling or structural changes
  safely fall back to a full authoritative render;
- preservation of unsaved edit drafts across unrelated command results;
- responsive composition controls down to a 240-pixel panel width.
- activation- and document-scoped Webview asset URLs, so a window recovers its
  stylesheet and scripts after a same-version forced extension replacement
  instead of remaining in the unstyled startup state.
- a borderless page-level TODO command bar that is visually distinct from
  bordered, collapsible group headers, with identical 14-pixel SVG actions
  before and after client-side redraws.

## Fresh verification gates

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run test:deterministic` | 0 | 503 tests passed: 167 unit, 251 contract, 85 integration |
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
| `artifacts/project-steward-2.1.5.vsix` | `209fca7bb7d70766f9273f2eead6bccc18ccf65a9ae3870a8ef49dc7d040bce5` | Archive integrity passed; contains the incremental TODO completion, Webview asset-recovery, and TODO page-hierarchy fixes |
| `artifacts/project-steward-attention-ui-bridge-0.1.4.vsix` | `0ecf88203691abe88dc860adad778e476962b7899c9db9c4dfd0d93dc8d5e18f` | Archive integrity and release packaging checks passed |

## VS Code Server installation

Environment:

- `REMOTE_CONTAINERS=true`
- VS Code `1.127.0`, commit
  `4fe60c8b1cdac1c4c174f2fb180d0d758272d713`, `x64`
- Node.js `v26.5.0`
- npm `12.0.1`

The active VS Code Server and its server-side extension CLI were verified
independently. The workspace extension was installed through that pinned CLI:

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
`c6420ddac9e6c6b240754c4f97c71892f72ac850bedac93cbddf558ff9bf0bb9`.
The installed `media/webviewDnDScripts.js` and the packaged worktree asset both
have SHA-256
`4334c58898bd1c3657e84155ed5cae37cde364f15f1502c5b27f971e04006bd7`.
The installed `media/styles.css` and the packaged worktree asset both have
SHA-256
`6af8f1b1ef866cfbd32ac4da794fd4b5f5aaabb75c577f8d44d7b6402650d3db`.
The installed and packaged `dist/dashboard.js` both have SHA-256
`6f3e2a90ebc5325db372b3d0e6d5fad0ea11ea3257dd7a240efb030266b5856a`.
These matches confirm that the installed TODO interaction, presentation, and
Webview asset-recovery code is the verified build. The already-installed UI
bridge was not changed.

The P0 `WEBVIEW-RESOURCE-RECOVERY-001` integration contract verifies that every
external stylesheet and script URL shares one revision within a rendered
document, that a subsequent render receives a new revision, and that a fresh
Extension Host activation receives a new namespace rather than repeating the
previous URL.

The P0 `TODO-COMPLETION-INCREMENTAL-001` contract verifies local Settings echo
consumption, external A-to-B-to-A and unsupported-version recovery, mixed
configuration events, single-card DOM completion, matching authoritative
acknowledgements, concurrent sibling changes, and hidden-card DnD exclusion.

The active Extension Host must reload before it can execute the newly installed
extension files.

## Decision

The continuous TODO workflow, completion-without-reload behavior, Webview
resource recovery, and TODO page hierarchy are implemented, packaged,
installed, and verified. The feature branch remains isolated and has not been
merged into `main`.
