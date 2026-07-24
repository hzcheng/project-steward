# Max Visible Todos Per Group Verification

Date: 2026-07-24
Branch: `feat/todo-ux-overhaul`
Verified head before this report: `ad9a6805c1c5d29544041b4f5225ced01f456b97`

## Outcome

`projectSteward.maxVisibleTodosPerGroup` once again controls the collapsed-card viewport of every expanded TODO group.

- Positive fractional values are floored.
- Missing, non-numeric, zero, negative, and non-finite values fall back to `5`.
- Five collapsed cards occupy exactly `318px`: `5 × 58px + 4 × 7px`.
- Additional cards remain rendered and are reached with group-local scrolling.
- Inline details add their measured extra height to the current group rather than being clipped.
- Hidden → visible tab changes and sidebar width changes remeasure expanded details through `ResizeObserver`.
- Completing a TODO retains the existing card-level patch and does not remount the TODO root.

## TDD evidence

Required CI trace:

`quality-linux` → `npm run test:ci:linux` → `npm run test:deterministic:run` → `tests/integration/**/*.test.js` → `tests/integration/dashboard/todoContent.test.js` and `tests/integration/dashboard/todoInteraction.test.js`

Before production changes, the focused suite failed exactly two new assertions:

1. the rendered `.todo-panel` omitted the configured viewport variables;
2. opening an inline detail did not set `--todo-list-expanded-extra-height`.

The review follow-up added two more RED cases:

1. hidden-tab expansion remained `0px` after becoming visible;
2. sidebar-driven height growth remained `122px` instead of updating to `162px`.

All four cases passed after their respective minimal fixes.

## Review-fix-commit loop

Read-only review found two Important issues and no Critical issues:

1. a one-time `offsetHeight` measurement was invalid while the TODO panel was hidden and stale after sidebar resize;
2. the existing responsive-style test still enforced the removed “page scroll only” contract and would fail required CI.

Fixes:

- `3d301e8 test: align responsive todo viewport contract`
- `ad9a680 fix: remeasure expanded todo viewport`

Fresh read-only review closed both Important findings and found no new Critical or Important issues.

## Verification

Focused post-review command:

```text
npm run test-compile
node --test tests/integration/dashboard/todoContent.test.js \
  tests/integration/dashboard/todoInteraction.test.js \
  tests/integration/dashboard/styles.test.js
npm run test:behavior-contracts
npm run test:dashboard
```

Results:

- focused TODO/style tests: `33 passed, 0 failed`;
- behavior catalog/tooling tests: `37 passed, 0 failed`;
- Dashboard Webview checks: passed.

Required Linux branch gate:

```text
npm run test:ci:linux
```

Result: passed.

- unit: `167 passed, 0 failed`;
- contract: `260 passed, 0 failed`;
- integration: `93 passed, 0 failed`;
- deterministic total: `520 passed, 0 failed`;
- behavior contracts, lint baseline, safety checks, Dashboard checks, architecture baseline and guards, release notes, release packaging, VS Code prepublish, coverage and coverage baseline: passed.

## Package and installation

`npm run package:release` produced:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `artifacts/project-steward-2.1.5.vsix` | 258097 | `62a1c3dade4b7e59e44f444f5f075c4385b71b25432497bda786bf49a77da93a` |
| `artifacts/project-steward-attention-ui-bridge-0.1.4.vsix` | 15105 | `af0bd64f46490f91cd38b8cec25576004324884a54d33e2b37176a3e735d5a74` |

The main archive passed `unzip -t`. Its manifest contains the restored configuration description, and its TODO Webview asset contains the viewport height synchronization and `ResizeObserver`.

The main extension was force-installed with the pinned Dev Container VS Code Server:

```text
/home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server
```

Installation output:

```text
Extension 'project-steward-2.1.5.vsix' was successfully installed.
hzcheng.project-steward@2.1.5
hzcheng.project-steward-attention-ui-bridge@0.1.4
```

The installed and packaged `media/webviewTodoScripts.js` both hash to:

```text
d72db3cacea74e37b020628f9bdf6e17b8efccbb63c884b128d81bc0ea0f6563
```

The already installed UI Bridge was not reinstalled or modified.

## Isolation

- Feature worktree: `/home/hzcheng/projects/repos/vscode-dashboard/.worktree/todo-ux`
- Protected primary checkout: `/home/hzcheng/projects/repos/vscode-dashboard`
- Primary branch/head remained `main` at `6e614d84b1ca7717e9e28a813cd27dc7b1df7633`.
- No push, PR, or merge was performed.
