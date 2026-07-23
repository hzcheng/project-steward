# Main Capability Regression Coverage Report

Date: 2026-07-23
Branch: `feat/refactor-and-ci`
Audited main head: `e9145123b3ad1cdcbc625e52291ae053e8acbce5`
Verification head: `2d93d70d55895ce9bec786887444bb7325681769`

## Result

**Automated status: PASS. Extension Host status in this container: BLOCKED.
Interactive multi-window/environment status: BLOCKED.**

The deterministic, Windows, Linux quality, real-tmux, behavior ownership,
coverage-baseline, and release-package gates passed. The pinned VS Code
Extension Host resolved version 1.130.0 but could not start because the
container lacks `libnspr4.so`; exit code was 127. This is recorded as BLOCKED,
not PASS. The enforced `scheduled-macos` job continues to own that real-host
gate.

## Capability Traceability

The checked-in manifest contains 16 capabilities and 94 explicit main commit
assignments. Full hashes and requirements are canonical in
`docs/testing/main-capability-coverage.json`.

| Capability | Assigned main commits (short) | Focused behavior IDs | PR gate | Scheduled/real job |
| --- | --- | --- | --- | --- |
| MAIN-WORKSPACE-IDENTITY | 4fa73572, 73a95939 | OPEN-OPEN-PROJECT-RUNTIME-IDENTITY-001 | test:deterministic:run | — |
| MAIN-WORKSPACE-SCOPE | 7b8c5e19, 910bac8d, 4edd2ce4, b1506988, c3ef7798, f895d423 | PROJECT-ASSIGNMENT-001; SESSION-WORKSPACE-SCOPE-001 | test:deterministic:run | — |
| MAIN-RUNTIME-OWNERSHIP | 542070ce, dcd46f63, b2f672bd, 6b9a8fa2, 7e307205 | RUNTIME-RUNTIME-PROJECTION-001 | test:deterministic:run | — |
| MAIN-WORKSPACE-HYDRATION | 3bdf33dd, 0da6d2f2, 532a89e8, 9f30fe66, aa2b38ce, 52e44f13, 26681274 | PERSIST-AI-SESSION-PROJECT-HYDRATION-CONTROLLER-001 | test:deterministic:run | — |
| MAIN-OPEN-WORKSPACE-PROTOCOL | 8dce13ca, 0749ad3e, ae84df5d, 4565f2c0, 81712b9b, 1eb860af, 4a04b945, 2bb717b5, e9c29252, 36e5ca3c | OPEN-PROTOCOL-001; ARCH-COORDINATOR-001 | test:deterministic:run | — |
| MAIN-OTHER-WINDOWS | ba2116e8, 9f9d5969, e02e498c | OPEN-OPEN-PROJECT-PUBLICATION-001; OPEN-OPEN-PROJECT-INCREMENTAL-RENDERING-001; OPEN-OTHER-WINDOWS-PRIVACY-001; OPEN-OTHER-WINDOWS-SUMMARY-001 | test:deterministic:run | — |
| MAIN-WORKSPACE-NAVIGATION | 0242a6c5, e6e65d56, 91a0f8a5, 3d1588d0, 35a8eba4 | OPEN-OPEN-PROJECT-WORKSPACE-CONTROLLER-001; OPEN-WORKSPACE-NAVIGATION-001 | test:deterministic:run | — |
| MAIN-WORKSPACE-SAVE | ef614653, 7c316961, 42e16ba1, 982c628a | OPEN-OPEN-PROJECT-DASHBOARD-CONTROLLER-001; PERSIST-DASHBOARD-MIGRATION-PUBLICATION-001; PERSIST-WORKSPACE-SAVE-001 | test:deterministic:run | — |
| MAIN-WORKSPACE-WEBVIEW | d9779343, e96db2c7, b9d25dc8, 58c4b1d4, 75c90d86, 89180757, 8b8c4489, c2d668da, e2a2786e, 58dc3f31, 6987e657, c11f28c8, d632069f, be6f937a, fef63320 | WEBVIEW-CURRENT-WORKSPACE-RENDERING-001; WEBVIEW-SHARED-CARD-STATE-001 | test:deterministic:run | scheduled-macos |
| MAIN-WORKSPACE-SEARCH | d25128a6 | TODO-TODO-SEARCH-RESULT-RENDERING-001 | test:deterministic:run | — |
| MAIN-WORKSPACE-ATTENTION | da3ea69d, eb8dff1f, 7b0970cb, f02a330a, 63a69455, 28665b86 | ATTENTION-ATTENTION-PROJECTION-001; ATTENTION-ATTENTION-PROJECT-RENDERING-001 | test:deterministic:run | — |
| MAIN-TMUX-FOCUS | 47fd52ed, e2e32b9e, 08f7837e, 0aa444ce | RUNTIME-RUNTIME-COORDINATOR-001; RUNTIME-TMUX-CLIENT-001; RUNTIME-TMUX-FOCUS-TARGET-001; RUNTIME-TMUX-FOCUS-FAST-PATH-001 | test:deterministic:run | tmux-smoke-linux |
| MAIN-TMUX-NAMING | 839ce9a9, e6a89153, b2fac7e6, fd0568a4, 2667134b, be487186, 7da8b787, 722a2ffb, 7ee927c4, 35f0761e, 140eeddb, d5124c8c, 79d77dd5, f34bdb62, 0d907fc2, 2142e65d, 7665b340, 0e77f61d, 8e9a82e3 | RUNTIME-TMUX-LAYOUT-001; RUNTIME-TMUX-NAMING-001; RUNTIME-TMUX-DISCOVERY-001; RUNTIME-TMUX-STORE-001 | test:deterministic:run | tmux-smoke-linux |
| MAIN-TMUX-CLEANUP | 24208096 | RUNTIME-REAL-TMUX-SMOKE-CLEANUP-001 | test:deterministic:run | tmux-smoke-linux |
| MAIN-RELEASE-PACKAGING | 88d366ce, 1ae927ae, a17c97bc | RELEASE-VSIX-PACKAGING-001; ARCH-RELEASE-IDENTITY-001 | test:ci:linux | — |
| MAIN-CI-WIRING | 8ba0e882, 587b4178, e9145123 | ARCH-CI-QUALITY-GATE-001; RUNTIME-REAL-TMUX-CI-GATE-001 | test:ci:linux | quality-linux, platform-windows, scheduled-macos, tmux-smoke-linux |

## RED/GREEN Evidence Added

1. Main-capability coverage initially had no validator/export. The new manifest
   validator now rejects missing/duplicate commit assignments, missing behavior
   ownership/evidence, unreachable PR gates, missing scheduled jobs, and
   real-only coverage. Catalog plus manifest mutation suite: 37/37 PASS.
2. Workspace scope, save, and navigation received focused tests for root
   precedence, provider arguments, save serialization/migration, exact
   navigation, save-first, stale cards, and fail-closed fallback.
3. OTHER WINDOWS mutation testing exposed duplicate navigation identities being
   accepted by incremental DOM validation. Source and committed media logic now
   require unique navigation identities; privacy and summary behavior is owned
   by focused tests.
4. Tmux naming first asserted an incorrect 96-character boundary and failed;
   the observed 95-character contract was recorded. Atomic target snapshots,
   cached focus/reconcile-once behavior, readable/legacy naming, persistence,
   renamed-readable recovery, and foreign-suffix rejection are covered.
5. Scheduled workflow tests failed before
   `validateScheduledWorkflow` existed. The weekly workflow now reuses
   `verify.yml`; macOS Extension Host requires the reusable Linux, Windows, and
   real-tmux jobs to pass first.
6. Repeated packaging first exposed missing seed metadata, then a controlled
   `.vscodeignore` mutation produced a 99-entry main VSIX containing
   `extension/coverage/**`. With exclusions restored, both a clean run and a
   post-coverage run produced exactly 37 main entries and 6 bridge entries.
7. Full Linux CI exposed a load-dependent legacy safety-fixture race: a fixed
   50-`setImmediate` poll did not always observe the owner read. It was replaced
   by explicit deferred synchronization with a bounded timeout, the real
   scan/remove behavior was added to the focused contract, and the legacy
   safety check passed three consecutive isolated runs before Linux CI passed.
8. A live managed tmux pane can outlive one Codex root thread and start another.
   The durable binding previously remained on the completed thread, so the
   replacement thread did not render its running animation. The pane PID is now
   observed through a bounded Linux `/proc` process/fd scan; only an unambiguous
   root `session_meta` may atomically rebind the exact known locator. Focused
   tests cover subagent rejection, ambiguity, malformed input, compare-and-swap
   races, crash recovery, Active/History movement, and running animation
   projection (`RUNTIME-TMUX-THREAD-SWITCH-001`).

## Verification Evidence

| Gate | Result |
| --- | --- |
| `npm run test:behavior-contracts` | PASS, 37/37 catalog/manifest mutation tests |
| `npm run test:deterministic` | PASS before final race case, 426/426 |
| Final deterministic suite inside `test:ci:linux` | PASS, 441/441: 165 unit, 216 contract, 60 integration |
| `npm run test:ci:windows` | PASS, 26/26 |
| `npm run test:coverage:run` plus baseline | PASS; statements 78.75%, branches 71.61%, functions 79.90%, lines 78.75% |
| `npm run test:ci:linux` | PASS, including compile, behavior ownership, lint, deterministic, legacy safety, dashboard, architecture, release notes, VSIX, and coverage |
| `npm run test:tmux:smoke` | PASS; isolated server `project-steward-test-493316-cb55564a4014b91d` cleaned |
| Default tmux server before/after | Unchanged: the same four user sessions; no harness-owned `/tmp/project-steward-tmux-smoke-*` root remained |
| `npm run test:extension-host` | BLOCKED: VS Code 1.130.0 binary could not load `libnspr4.so`; exit 127 |

## Release Artifacts

| Artifact | ZIP entries | SHA-256 |
| --- | ---: | --- |
| `artifacts/project-steward-2.1.4.vsix` | 37 | `d782dd9b0dad3783030d1db13538ef2b66de255a452292f92fa2ba29c8a62b84` |
| `artifacts/project-steward-attention-ui-bridge-0.1.4.vsix` | 6 | `f5268f2e8b1f652cf167bad380da35241f5fa3adc6b5e0e21f423723e60f44fc` |

Both archives passed `unzip -t`. Neither archive contains coverage, tests,
`.ci`, source maps, documentation, or seeded stale-output probes.

The main VSIX was force-installed as `hzcheng.project-steward@2.1.4` into
`Dev Container: DevBox @ reddev`. The installed `dist/dashboard.js` SHA-256
matches the same file inside the VSIX:
`411218a2e488f50d6af7e418e783b34dd002a4bbd65344861e554e26afc0361f`.
The already-installed UI bridge remained at version 0.1.4; the tmux thread
rebinding fix is owned by the workspace extension and does not require a bridge
update.

## Repository Integrity

- `git diff --name-only --diff-filter=D origin/main...HEAD -- 'tests/**'`
  returned no deleted tests.
- The feature worktree was clean before this report was created.
- The primary checkout was not modified by this work. Its status remains the
  user's pre-existing modified `.vscode/settings.json` and untracked `.codex/`.
- `main` and the feature branch merge base both resolve to
  `e9145123b3ad1cdcbc625e52291ae053e8acbce5`; no merge or push to `main` was
  performed.

## Remaining Manual/Environment Cells

The existing workspace-first acceptance matrix still has 12 navigation cells
and 108 launch-ownership cells marked NOT-RUN/BLOCKED. They require controlled
two-window Local, SSH, WSL, and Dev Container environments plus interactive
Codex/Kimi/Claude flows. Automated checks cover the contracts but are not
reported as manual evidence. This container also needs the system library
providing `libnspr4.so` before its pinned Electron Extension Host can run.
