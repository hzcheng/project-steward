# Regression CI verification report

## Scope and revision

The final local verification was performed on 2026-07-23 against source commit `970012f802be49cba0f974c21609290e7ab36ac2` on `feat/refactor-and-ci`. This revision includes the scheduled real Extension Host smoke, exact test dependency, lifecycle contract, catalog path hardening, migrated behavior owners, focused tmux early/ambiguous-failure cleanup coverage, and the generated-coverage ignore rule. The command results below do not claim that the new macOS scenario has already run in GitHub Actions.

Environment: Linux, Node.js 22.12.0, npm 10.9.0, and tmux 3.2a. The test process used isolated temporary provider roots. This report intentionally omits local absolute paths, provider prompts, session content, and temporary resource names.

## Fresh verification results

All commands below exited 0. Durations are wall-clock measurements from this environment and are not historical CI estimates.

| Command | Wall time | Result |
| --- | ---: | --- |
| `npm ci` | 3.10 s | PASS; 608 locked packages installed |
| `npm run test:ci:linux` | 40.49 s | PASS; below the five-minute Linux main-gate target |
| `npm run test:tmux:smoke` | 8.81 s | PASS; isolated real-tmux server cleaned by the harness |
| `npm run test:release-packaging` | 0.16 s | PASS |
| `npm run test:architecture-baseline` | 0.13 s | PASS |
| `git diff --check` | 0.01 s | PASS; generated `coverage/` output is ignored |
| `npm run test:behavior-contracts` | 1.06 s | PASS |

The Linux gate covered TypeScript compilation for both extensions, behavior-catalog validation, the TSLint warning ratchet, deterministic unit/contract/integration tests, compatibility safety and Dashboard checks, architecture baseline and guards, release notes and package checks, the production bundle, and the coverage ratchet.

The P0 tmux cleanup owner directly exercises planned fixtures, successful launch-state transitions with PID-ledger proof, and failed dispatches with missing evidence. Three temporary production-code mutations independently broke those branches; each made the focused test fail before the original implementation was restored. The final focused run passed 3/3, including deletion only for proven-safe fixture roots and retention for an ambiguous launch root until explicit test cleanup.

An additional isolation audit ran `test:deterministic:run`, `test:safety:run`, and `test:dashboard:run` with fresh empty Codex, Kimi, and Claude provider roots. All three commands exited 0 (6.63 s, 7.32 s, and 0.18 s). The captured output contained none of the audited home/repository-parent markers or prompt/session canaries, and the empty temporary root was removed. This establishes output and fixture isolation for these suites; it does not claim that external remote environments were exercised.

## Behavior and quality baselines

The validated catalog contains 186 contracts after adding the scheduled Extension Host scenario:

| Dimension | Counts |
| --- | --- |
| Domain | architecture 11; attention 16; error 2; open-project 21; persistence 17; project 19; release 2; runtime 21; session 31; todo 23; webview 23 |
| Priority | P0 13; P1 173; P2 0 |
| Status | automated 177; manual 8; scheduled 1 |

Each catalog entry has one valid `status`; every owner and evidence reference resolves inside the repository to an inspectable regular file, automated owners contain the behavior ID, and every manual entry has a non-empty reason and is owned by the versioned manual matrix.

The TSLint baseline contains 100 existing warnings across 8 files and 13 file/rule pairs. CI permits reductions but rejects any new pair or count increase.

| Coverage | Baseline | Fresh Linux result |
| --- | ---: | ---: |
| Lines | 77.00% | 79.06% |
| Branches | 68.59% | 73.56% |
| Functions | 74.88% | 78.86% |
| Statements | 77.00% | 79.06% |

The fresh result meets or exceeds every stored coverage baseline. Behavior IDs remain the semantic ownership mechanism; coverage percentages are a regression ratchet, not a substitute for behavioral assertions.

## Environment-only and manual coverage

The eight manual contracts cover interactive multi-window focus and same-workspace identity, Remote SSH reconnect, WSL identity, Dev Container lifecycle, attention visuals/accessibility, live terminal focus, and operating-system sleep or remote-disconnect recovery. They were **not executed as part of this verification** and must not be treated as passing evidence.

Execute them according to [`docs/manual-tests/cross-platform-remote-matrix.md`](../../manual-tests/cross-platform-remote-matrix.md), recording the execution date; OS, VS Code, remote-extension, provider, and extension versions; host placement; result; and redacted evidence. The scheduled workflow now covers macOS deterministic checks plus a real dual-extension lifecycle on pinned VS Code Stable `1.130.0`; interactive SSH, WSL, Dev Container, visual, multi-window, sleep, and transport-interruption scenarios remain environment-only limitations owned by the manual matrix.

The local Linux follow-up used Node.js 22.12.0 and npm 10.9.0 for `npm ci`, the unit run, release/schedule contracts, and behavior-catalog validation; those checks passed. The suite validates the exact dependency/UI-kind metadata, invokes only the main extension's activation method, verifies both extensions are ultimately active, and awaits the real open-command and view-focus paths. Because the bridge also declares wildcard activation, this result does not claim that main activation caused bridge activation. Controlled mutations prove removal of either the production command registration or webview-provider registration is detected. Hostile inherited Electron/VS Code bootstrap variables are removed while the worker runs and restored afterward; an eight-minute outer POSIX process-group watchdog complements the two-minute in-suite timeout and the 15-minute workflow hard stop.

The diagnostic run built both production extension bundles and downloaded the official fixed VS Code artifact before attempting the real Host. This host has neither `xvfb-run`/`Xvfb` nor the Electron runtime library `libnspr4.so`, so Electron exited 127 before the Extension Host could start. **CI pending first scheduled run**: this scenario is not recorded as PASS until the macOS scheduled/manual workflow completes it successfully.

## Branch-protection handoff

The stable required-check names are:

- `quality-linux`
- `platform-windows`
- `tmux-smoke-linux`

Repository branch protection was not modified. After the workflow has completed successfully at least once on GitHub and these check names are available to repository settings, an administrator must mark all three checks as required for the protected branch. Until that manual settings step is completed, the workflow provides verification but is not itself proof that GitHub rejects an unverified merge.
