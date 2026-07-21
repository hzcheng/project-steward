# Task 12 Report: Cross-window navigation gate

Date: 2026-07-21

Status: complete, fail-closed. No direct navigation capability is enabled.

## Delivered

- Disposable workspace-host probe with source/target instance IDs, focus-event
  sequencing, live registration counts, and all five required outcomes.
- Machine-checked 12-cell Local/SSH/WSL/Dev Container matrix.
- Evidence-gated navigation capabilities and `WorkspaceNavigationController`.
- Dashboard navigation-card wiring using only the latest
  `record.navigationUri`; production navigation never reads `record.roots`.
- Saved fallback to native `workbench.action.switchWindow`, untitled save
  prompt, unavailable-command warning/no action, and stale-card refresh only.

## TDD Evidence

- Probe/source RED: missing `spikes/workspace-navigation/extension.ts`.
- Production RED: missing `out/openWorkspaces/navigationController`.
- Command-discovery RED: forced query rejection escaped the controller.
- Native-switch RED: forced execution rejection escaped the controller.
- Each RED was followed by the minimal implementation and a GREEN targeted
  run.

## Empirical Gate

All 12 cells are `not-runnable` and select fallback. Local, SSH, and WSL hosts
are absent. The Dev Container probe is installed, but no controlled second
target plus authoritative UI window-count/focus automation channel is
available. Installation success is not navigation evidence.

The host-version discrepancy is recorded explicitly: the running server path
and commit `4fe60c8b1cdac1c4c174f2fb180d0d758272d713` report VS Code `1.127.0`;
the separate stale `fcf604774b9f2674b473065736ee75077e256353` CLI reports `1.125.1`.

## Installed Probe

- Artifact: `artifacts/project-steward-workspace-navigation-probe-0.0.2.vsix`
- ID/version: `hzcheng.project-steward-workspace-navigation-probe@0.0.2`
- Host: `Dev Container: DevBox @ reddev`, workspace Extension Host
- VSIX SHA-256: `6730f55d51c61f0ccbc7acafa91870a9a7041daf4f7ac6855c92fbd3708d5abc`
- Installed JS SHA-256 matches packaged JS:
  `9c2a3bbd9b1bd514982d96958309afe289b21bf93d07a367b4a5cdcca0098b7e`
- CLI output: successful install; extension list reports version `0.0.2`.

## Verification

Fresh final gate:

```text
npx tsc -p spikes/workspace-navigation/tsconfig.json
node scripts/run-workspace-navigation-spike-checks.js
npm run test:open-projects
npm run test:dashboard
npm run lint
git diff --check
```

All commands exited zero. The open-workspace safety checks exercise every
fallback matrix cell, stale IDs, missing/query-failing/execution-failing native
switching, the untitled save prompt, and root-URI exclusion.

## Residual Risk

Direct switching remains unproven everywhere. It must stay disabled until a
controlled run produces repeated `focused-existing` observations with an
unchanged authoritative window count for a specific environment/workspace-kind
cell. Packaging emitted disposable-probe metadata warnings (no repository,
bundled license, or file allow-list); the installed payload hash was verified.
