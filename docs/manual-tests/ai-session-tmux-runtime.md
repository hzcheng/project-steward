# AI Session tmux Runtime Acceptance Record

Date: 2026-07-20

Feature branch: `feat/session-tmux-support`

## Evidence policy

`PASS (automated)` below means the named command was actually executed in the recorded environment. `NOT RUN` means no claim is made for that platform or manual UI flow. The repository's `install-local` workflow packaged both VSIX files but could not complete through the disconnected VS Code management IPC route. A standalone Dev Container server CLI fallback installed the main extension; no installed UI behavior was exercised.

## Environment actually exercised

| Field | Observed value |
| --- | --- |
| Execution context | Linux Dev Container (`REMOTE_CONTAINERS=true`) |
| Container OS | Ubuntu 22.04.5 LTS (Jammy) |
| Kernel / architecture | Linux `5.10.134-16.3.an8.x86_64`, `x86_64` |
| tmux | `/usr/bin/tmux`, tmux 3.2a |
| Node.js / npm | Node.js v26.5.0 / npm 12.0.1 |
| VS Code remote CLI | 1.127.0, commit `4fe60c8b1cdac1c4c174f2fb180d0d758272d713`, x64 |
| Extension installation | `hzcheng.project-steward@2.1.2` installed in the Dev Container; installed `dist/dashboard.js` matched the freshly built bundle by SHA-256 |

The inherited VS Code IPC socket refused connections and the active management route remained disconnected, so the repository installer did not reach a successful extension-host response. The bounded standalone server CLI fallback installed the main VSIX into the Dev Container workspace extension host and listed the exact version. The UI-only attention bridge was also accepted into the remote server extension directory during diagnosis, but that is not evidence of correct local UI-host placement or execution. All installed UI behavior remains `NOT RUN`.

## Executed evidence

| Status | Command / action | Observed result |
| --- | --- | --- |
| PASS (automated) | `npm run test:tmux` | Printed `AI session tmux checks passed.` Pure fake boundaries covered settings, launch quoting, metadata, stores, locking, backend/coordinator/controller behavior, host routes, and Webview contracts. Post-rebase regressions also cover offline completion proof, independent known/inactive retention budgets, consistent initial tmux viewer titles, and stale snapshot projection. |
| PASS (automated) | `npm run test:tmux:smoke` | Printed `AI session tmux smoke checks passed.` in repeated fresh runs, including three consecutive final runs after production asset generation. Each run used a unique `project-steward-test-<pid>-<random>` server, `-f /dev/null`, and its own `TMUX_TMPDIR`; then it killed the server, verified `list-sessions` no longer succeeded, and removed only its validated owned stale socket if tmux left one behind. Final `/tmp` scans found no isolated socket or fixture root. |
| PASS (automated) | Real project layout in the isolated smoke server | Metadata filtering found exactly one managed project tmux session and exactly two managed AI windows. Concurrent ensure calls returned the exact same locator; the append-only provider ledger contained exactly one invocation for that identity. |
| PASS (automated) | Real session layout in the isolated smoke server | Metadata filtering found exactly two managed rows in exactly two independent tmux sessions, with strict session-scope identity metadata and base-only window metadata. |
| PASS (automated) | Detach boundary with real panes | Fake VS Code attach terminals were disposed; real project- and session-layout panes reported `pane_dead=0`, and discovery kept the runtimes active and detached. |
| PASS (automated) | New discovery / pending promotion | A new production discovery instance recovered live metadata. A pending project window was renamed to its final window, `pendingId` was removed, and `sessionId` was discoverable. |
| PASS (automated) | Provider exit isolation | Stopping one fake provider created its completion marker and removed only its managed project window; sibling project and independent session-layout targets remained alive. |
| PASS (automated) | Special-character command structure | An append-only JSONL record captured a unique invocation ID, PID, exact cwd containing spaces, quotes, `$`, and `;`, and the exact payload containing quotes, shell metacharacters, and a newline. All five controlled providers recorded exactly one unique invocation. |
| PASS (automated) | Cleanup failure boundaries | Pure injected checks distinguish explicit no-server results from ordinary numeric failures, retry an ordinary `kill-server` failure, and still run stopped verification plus later stages after two failures. Provider cleanup first writes every controlled stop file, then requires each registered fixture to have at least one valid PID from its own invocation-ID ledger rows or its own pid-file fallback. Every discovered PID receives only bounded `process.kill(pid, 0)` observation. Zero, partial, or invalid per-fixture evidence retains the provider root even when another fixture has multiple valid PIDs; an empty fixture set and complete evidence succeed. Socket and fixture roots are removed only with independent server-stopped and providers-stopped proof. |
| PASS (automated) | `npm run test:safety` | Pure tmux checks, AI safety checks, and Open Project safety checks passed. The ordinary safety script did not invoke the real smoke harness. |
| PASS (automated) | Pending-to-active execution handoff regression in `npm run test:safety` | A controlled promotion reproduced the backend consuming a pending runtime before its promise settled, then verified one successful handoff without a `stale-pending` result. The asynchronous handoff produced no execution snapshot before settlement and exactly one Running evaluation afterward. Explicit empty-project invalidation still cancels the handoff; repeated hydration generations and synchronous notification reentry notify, promote, persist the alias, and synchronize only once; a throwing notification records only its error category without undoing alias persistence. |
| PASS (automated) | Execution-state handoff matrix in `npm run test:safety` | Codex, Kimi, and Claude each passed project- and session-layout tmux fixtures. Every fixture performed exactly one immediate first-turn evaluation after promotion, preserved `runStartedAtMs`, and passed `Running → Stopped → Running → Stopped`; a Direct Terminal Codex fixture passed the same non-regression path. Provider parser suites remain the source of truth for native lifecycle event shapes. |
| PASS (automated) | Ten consecutive pure tmux runs | `node scripts/run-ai-session-tmux-checks.js` passed runs 1 through 10 consecutively against the final compiled output, with zero failures. |
| PASS (automated) | Final build and regression matrix | Dashboard, Open Project, architecture baseline, lint, development webpack, production prepublish, and `git diff --check` all exited 0. Lint reported repository warnings only; webpack reported deprecation warnings only. |
| PASS (automated) | Fresh execution-handoff verification commands | On 2026-07-19, `npm run test:tmux`, `npm run test:safety`, `npm run test:tmux:smoke`, `npm run test-compile`, `npm run vscode:prepublish`, and `npm run test:release-packaging` each exited 0. Production webpack emitted deprecation warnings only; release packaging printed `Release packaging checks passed.` |
| PASS (automated) | Explicit focused-session refresh | Successful active, pending, legacy Direct, runtime-backed, and conflict-selected focus paths request an immediate refresh; missing and failed targets do not claim focus. |
| PASS (automated) | Project tmux active-window synchronization | Managed A→B, managed→unmanaged, unchanged, query failure, pending promotion, visibility gating, single-flight, and disposal checks passed. |
| NOT RUN | Installed UI focused-session retest | The main VSIX is installed and hash-verified; Project Steward clicks and tmux-internal window switches still await manual verification after the VS Code UI reconnects. |

## Manual acceptance matrix

| Environment or flow | Result | Evidence / reason |
| --- | --- | --- |
| Local Linux host, extension UI | NOT RUN | The available host was a Linux Dev Container, not a local Linux extension host. |
| macOS, tmux on `PATH` | NOT RUN | No macOS host was available. |
| macOS, absolute Homebrew tmux path | NOT RUN | No macOS/Homebrew host was available. |
| Remote SSH | NOT RUN | No SSH extension host was exercised. |
| Dev Container, real tmux backend internals | PASS (automated) | Production backend/client/discovery/store code ran against isolated tmux 3.2a as recorded above. |
| Dev Container, installed extension UI | NOT RUN | The main VSIX was installed and hash-verified through the standalone server fallback, but project-card click, confirmation, viewer focus, and notifications were not manually exercised. |
| WSL | NOT RUN | No WSL environment was available. |
| Native Windows unsupported warning | NOT RUN | No native Windows extension host was available. Source/unit checks cover the unsupported-platform result only. |
| Project layout, actual Codex/Kimi/Claude CLIs | NOT RUN | Smoke used all three provider identities with controlled fake provider processes; it did not invoke provider CLIs. |
| Session layout, actual Codex/Kimi/Claude CLIs | NOT RUN | Smoke used controlled fake providers only. |
| New and resumed provider sessions through UI | NOT RUN | The installed extension UI and provider credentials were not exercised. |
| First-turn green Running dot after tmux promotion | NOT RUN | The new handoff race and provider/layout matrix passed automated checks, and the build was installed, but it was not exercised through the VS Code UI in this verification run. |
| Detach and reattach through UI | NOT RUN | Real pane survival and fake attach-registry behavior passed automated checks; interactive VS Code terminal reattach was not run. |
| Developer: Reload Window | NOT RUN | The extension was installed, but the reload flow was not exercised. |
| Complete VS Code close and reopen | NOT RUN | The extension was installed, but the full close/reopen flow was not exercised. |
| Remote disconnect and reconnect | NOT RUN | No Remote SSH host was available. |
| Mode/layout/executable changes with live runtimes | NOT RUN | Automated configuration and no-migration checks passed, but the Settings UI flow was not run. |
| Multiple clients sharing the project current window | NOT RUN | Requires two interactive clients attached to one project tmux session. |

## Manual follow-up procedure

For each available POSIX extension host, set all three machine-scoped settings, create and resume one Codex, Kimi, and Claude session in both layouts, detach and reattach, reload, fully reopen, and verify the process survives only while that host/container remains awake and running. For project layout, attach a second client and confirm that selecting a window in either client changes the shared current window. On native Windows, verify the actionable unsupported warning and explicit Direct Terminal fallback without changing the saved setting.
