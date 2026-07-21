# Task 12 Report: Cross-window navigation gate

Date: 2026-07-21

Status: complete, fail-closed. No direct navigation capability is enabled.

## Delivered

- Disposable workspace-host probe with source/target instance IDs, focus-event
  sequencing, diagnostic registration counts, authoritative count placeholders,
  source heartbeat evidence, and all five required outcomes.
- Command-only activation with explicit start/stop and a bounded ten-minute
  trial lifecycle; activation alone performs no storage writes.
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
- Review RED: injected direct capability was ignored and no direct URI was
  parsed/executed.
- Review RED: continuous `*` activation and the old window-count field contract
  failed the hardened probe source checks.
- Each RED was followed by the minimal implementation and a GREEN targeted
  run.

## Empirical Gate

All 12 cells are `not-runnable` and select fallback. Local, SSH, and WSL hosts
are absent. The Dev Container has no controlled second target plus
authoritative UI window-count/focus automation channel. Registration/process
counts are diagnostic only and can never select direct behavior. Installation
success is not navigation evidence.

The host-version discrepancy is recorded explicitly: the running server path
and commit `4fe60c8b1cdac1c4c174f2fb180d0d758272d713` report VS Code `1.127.0`;
the separate stale `fcf604774b9f2674b473065736ee75077e256353` CLI reports `1.125.1`.

## Probe Installation and Cleanup

- Artifact: `artifacts/project-steward-workspace-navigation-probe-0.0.2.vsix`
- ID/version: `hzcheng.project-steward-workspace-navigation-probe@0.0.2`
- Host: `Dev Container: DevBox @ reddev`, workspace Extension Host
- VSIX SHA-256: `6730f55d51c61f0ccbc7acafa91870a9a7041daf4f7ac6855c92fbd3708d5abc`
- Installed JS SHA-256 matches packaged JS:
  `9c2a3bbd9b1bd514982d96958309afe289b21bf93d07a367b4a5cdcca0098b7e`
- CLI output: successful install; extension list reports version `0.0.2`.
- Cleanup: `@0.0.2` is now absent from a successful Dev Container extension
  list; hardened source `@0.0.3` was not installed.
- VS Code-managed `0.0.1`/`0.0.2` directories remain on disk but are absent
  from the authoritative installed-extension list; they were not manually removed.
- The five original probe registration files were recoverably moved to
  `/tmp/project-steward-workspace-navigation-probe-v1-backup-task12-review`
  with per-file SHA-256 checksums. No other extension storage was touched.
- Five already-running old Extension Hosts recreated registrations within
  three seconds. They require window reload to stop old heartbeats; after
  reload, their records age beyond the five-second live-registration TTL.
  Cleanup is therefore recoverable but not yet quiescent.

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
switching, injected direct success/failure using only `record.navigationUri`,
the untitled save prompt, and root-URI exclusion.

## Residual Risk

Direct switching remains unproven everywhere. It must stay disabled until a
controlled run produces repeated observations satisfying every authoritative
count, identity, cell, focus, and heartbeat invariant. Old Extension Hosts
continue writing recreated probe registrations until their windows reload;
those registrations are not authoritative evidence. Packaging emitted
disposable-probe metadata warnings (no repository, bundled license, or file
allow-list); the previously installed payload hash was verified.
