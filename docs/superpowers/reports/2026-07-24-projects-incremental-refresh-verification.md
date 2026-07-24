# Projects Incremental Refresh Verification

Date: 2026-07-24

Status: **PASS**

Branch: `feat/todo-ux-overhaul`

Verified implementation commits:

- `ef5fc31` — update Projects without rebuilding the Dashboard;
- `4ad7604` — close review findings around stale echoes, CRUD entry points,
  out-of-order delivery failures, and DnD rebinding.

The branch and worktree remain based on `main` commit
`6e614d84b1ca7717e9e28a813cd27dc7b1df7633`. The primary checkout still points
to that commit and was not modified by this work.

## Root cause

The `reddb-dts-dual-active` Extension Host log recorded twelve
`configuration-changed` full Dashboard refreshes in approximately 1.8 seconds.
A project catalog mutation wrote both `projectSyncData` and compatibility
`projectData`; each configuration event reconciled the catalog and rebuilt the
complete Webview. Mutation controllers also requested another full provider
refresh after their writes.

## User-visible acceptance

The Projects surface now behaves as follows:

- collapsing one group or all groups changes the existing DOM in place and its
  local Settings echoes do not redraw the Projects panel;
- a saved-project, saved-group, or favorite drag keeps the already-moved DOM
  when the host's authoritative order matches it;
- add, edit, color, favorite toggle, remove, import, group, command-removal,
  and manual JSON mutations replace only the Projects panel;
- Projects partial replacement disposes stale drag handlers and binds DnD to
  the new cards;
- the Dashboard document, active tab, OPEN/TODO panel identities and state,
  window scroll, and sibling controllers survive a Projects update;
- local `projectSyncData` and `projectData` writes are consumed exactly once,
  including rapid coalesced writes;
- an external value that returns to an older local value is not hidden by a
  stale echo token;
- external project sync reconciles before publishing a Projects partial update;
- OPEN saved-state, project colors, and the complete search catalog are
  invalidated when project metadata changes;
- stale Projects messages are ignored and do not request a full refresh;
- stale or previous-document Projects/OPEN delivery failures cannot rebuild a
  newer successful view;
- malformed, inconsistent, latest-message delivery failures and mixed
  unrelated configuration changes retain the complete authoritative recovery
  path.

## P0 regression ownership

Behavior `PROJECT-INCREMENTAL-REFRESH-001` is automated and owned by:

- `tests/contract/persistence/projectCatalogSync.test.js`;
- `tests/contract/projects/panelController.test.js`;
- `tests/contract/openProjects/dashboardController.test.js`;
- `tests/integration/dashboard/errorRecovery.test.js`;
- `tests/integration/dashboard/webviewState.test.js`.

The required GitHub gate reaches these tests through:

```text
quality-linux
  → npm run test:ci:linux
  → npm run test:deterministic:run
  → contract and integration suites
```

The tests cover exact/coalesced echo consumption, failed writes, local/external
and mixed lifecycle routing, monotonic message sequences, out-of-order delivery
failures, Projects-only replacement, matching drag preservation, mismatch
fallback, stale-message rejection, OPEN/search semantic invalidation, and DnD
rebinding.

## Review-fix-commit loop

The read-only review reported no Critical findings and three Important
findings. All were fixed:

1. coalesced writes now discard every echo token no newer than the consumed
   final write, preventing a later external rollback from matching an obsolete
   token;
2. command-driven removal and manual JSON saves use partial refresh plus
   sidebar focus instead of `showSteward()` and its complete Webview rebuild;
3. Projects and OPEN delivery fallback is gated by the latest message and
   current document generation.

Self-review also found and fixed stale DnD bindings after Projects panel
replacement.

## Fresh verification gates

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run test:ci:linux` | 0 | Required Linux quality chain passed |
| deterministic suites inside `test:ci:linux` | 0 | 516 passed: 167 unit, 260 contract, 89 integration |
| `npm run test:behavior-contracts` | 0 | 37 catalog/main-capability tests and catalog checks passed |
| `npm run test:dashboard` | 0 | Dashboard Webview checks passed |
| `npm run test:safety` | 0 | Workspace parity, AI session tmux/safety, and open-workspace safety checks passed |
| `npm run test:architecture-baseline` | 0 | Performance architecture baseline passed |
| `npm run test:architecture-guards` | 0 | Architecture guards passed |
| `npm run lint:ci` | 0 | TSLint warning baseline passed |
| release packaging/prepublish/coverage inside `test:ci:linux` | 0 | Packaging, production build, and coverage baseline passed |
| `git diff --check` | 0 | No whitespace errors |

## Release artifacts

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `artifacts/project-steward-2.1.5.vsix` | 257,617 bytes | `08a29118e96d48b1b57a0f8ba10dbec1dad0cf4f5d34f0e1fd3afffd42a9d120` |
| `artifacts/project-steward-attention-ui-bridge-0.1.4.vsix` | 15,105 bytes | `906717a48b5f5e7438cbca406ecaf4cf5486c834e16c3abef5da9cf39551068f` |

The bridge code was not changed by this fix.

## VS Code Server installation

Environment:

- `REMOTE_CONTAINERS=true`;
- VS Code Server `1.127.0`, commit
  `4fe60c8b1cdac1c4c174f2fb180d0d758272d713`, `x64`;
- Node.js `v26.5.0`;
- npm `12.0.1`.

The main VSIX was force-installed with the pinned server CLI:

```text
/home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server
```

The command exited 0 and reported:

```text
Installing extensions...
Extension 'project-steward-2.1.5.vsix' was successfully installed.
```

The post-install listing reports `hzcheng.project-steward@2.1.5`.

Installed/package hashes match:

| File | SHA-256 |
| --- | --- |
| `media/webviewDashboardScripts.js` | `ad814e9a438c477547be8dcbbe2d8c2c1c247b33b07e841186d601eb751c81e7` |
| `dist/dashboard.js` | `85a3cce307a1fe0f397e034e58aead8dd6ed061130e3bdcb5abc892ffc52a3e3` |

The active Extension Host must reload before it executes the newly installed
files.

## Decision

The Projects no-reload behavior is implemented, reviewed, packaged, installed,
and verified. The feature branch and `.worktree/todo-ux` worktree remain
isolated. Nothing was pushed, no PR was opened, and `main` was not merged or
modified.
