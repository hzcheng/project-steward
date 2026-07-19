# Task 12 Report: Tmux Webview UX, Real Smoke Test, and Documentation

## Outcome

- Active and matching history rows now preserve authoritative runtime backend, layout, attachment, and conflict attributes.
- Tmux rows render a quiet runtime badge, detached rows remain focusable, conflict rows render `Runtime conflict`, and keyboard/context-menu actions preserve backend semantics.
- Direct runtimes expose `Close Terminal…`; tmux runtimes expose `Detach Terminal…`. The host constrains each route to its expected backend before confirmation or mutation.
- Session rows have theme-aware focus and conflict treatments, including forced-colors support. Generated CSS and Webview JavaScript were refreshed by the production asset pipeline.
- A real tmux smoke harness exercises production client, backend, discovery, binding stores, and creation locking against a unique isolated tmux server. Only the VS Code terminal attachment boundary is faked.
- README, changelog, and an evidence-based manual acceptance record document settings, layout semantics, fallback, detach behavior, remote constraints, platform limitations, and unexecuted manual flows.

## Authorized Plan Gap

The planned Webview routes alone could be forged or become stale between rendering and host dispatch. With parent approval, `src/dashboard.ts` now sends `expectedBackend: 'vscode'` for close and `expectedBackend: 'tmux'` for detach, and `src/aiSessions/terminalCommandController.ts` rejects a route whose expected backend differs from the freshly resolved authoritative runtime. Tests prove mismatched routes produce neither confirmation nor detach. Legacy runtimes cannot satisfy a tmux-only route.

## TDD Evidence

- RED: Webview HTML lacked `data-session-backend`; GREEN: active rows emit backend/layout/attachment/conflict data, labels, badge, and backend-specific actions.
- RED: matching active history rows had no backend metadata and could send Direct close for tmux; GREEN: history rows map the authoritative active runtime and preserve tmux/direct action semantics.
- RED: forged backend routes produced four confirmations instead of two; GREEN: mismatched routes stop before confirmation and mutation.
- RED: generated styles lacked the session-row focus selector and runtime badge; GREEN: production CSS contains the exact keyboard focus selector plus badge/conflict/forced-colors rules.
- RED: the real smoke harness and isolated cleanup contracts were absent; GREEN: source checks and actual tmux runs cover unique `-L` server selection, `/dev/null` configuration, configured executable path, `finally` cleanup, stopped-server verification, and exact socket cleanup.
- RED: tmux 3.2a stopped answering after `kill-server` but retained its Unix socket; GREEN: cleanup captures `#{socket_path}`, proves the isolated server stopped, validates the exact unique socket, and removes only that socket.

## Real Tmux Coverage

The smoke harness uses `execFileSync` only and prepends `-L project-steward-test-<pid>-<random> -f /dev/null` to every invocation. It covers:

- concurrent ensure for one identity producing one provider/window;
- project layout with one tmux session and two managed windows;
- session layout with two independent tmux sessions and strict metadata;
- recovery through a fresh production discovery instance;
- detach semantics while real panes remain alive;
- pending project-window promotion and metadata cleanup;
- cwd, IDs, titles, and payloads containing spaces, quotes, shell metacharacters, and a newline;
- provider exit creating a marker and removing only its own window while siblings remain.

The final cleanup run left no `/tmp/**/project-steward-test-*` socket. No user tmux server or configuration was used.

## Manual Acceptance Evidence

Automated real-tmux evidence was collected inside the available Ubuntu 22.04 Dev Container using `/usr/bin/tmux` 3.2a. No VSIX was installed because installation was not authorized. Interactive UI, local Linux, macOS/Homebrew, Remote SSH, WSL, native Windows, real provider CLI, reload/reopen, reconnect, and multi-client flows are explicitly recorded as `NOT RUN` in `docs/manual-tests/ai-session-tmux-runtime.md`.

## Final Verification

Every required Task 12 command exited 0:

```text
npm run test:tmux
npm run test:tmux:smoke
npm run test:safety
npm run test:dashboard
npm run test:open-projects
npm run test:architecture-baseline
npm run lint
npm run webpack
npm run vscode:prepublish
git diff --check
```

- Tmux smoke printed `AI session tmux smoke checks passed.` and final socket inspection was empty.
- Safety printed the tmux, AI safety, and Open Project pass messages.
- Lint exited 0 with repository warnings only; webpack/prepublish exited 0 with webpack deprecation warnings only.
- After production asset generation, `node scripts/run-ai-session-tmux-checks.js` passed ten consecutive runs (1–10), with zero failures.
- No VSIX install, push, PR, or merge was performed.

## Review Hardening Follow-up

- Conflict rows now invoke an extension-host QuickPick that identifies backend, tmux layout, attached/detached state, and exact target. The coordinator force-refreshes both backends and focuses only one exact match for the selected backend, complete identity/run contract, Direct terminal handle, or tmux locator. Cancelled, stale, missing, and non-unique selections perform no focus action. Conflict rows expose neither Close nor Detach before a concrete runtime is selected.
- Session markup now uses a non-focusable outer `role="group"` with a native sibling primary button and separate pin/archive/terminal buttons. Native Enter and Space activation, Shift+F10/context-menu access, screen-reader labels for provider/session/backend/layout/attachment/conflict state, detached history rows, focus restoration, forced colors, and primary-button `:focus-visible` are covered.
- Cleanup is a six-stage best-effort orchestrator. Capture, kill (with one fallback retry for ordinary failures), stopped verification, safe socket cleanup, provider stop verification, and fixture cleanup all run even when another stage fails; failures return a local `CleanupAggregateError` rather than relying on the post-Node-14 global `AggregateError`. Only explicit tmux no-server output or the exact `server exited unexpectedly` result observed immediately after a successful isolated kill counts as already stopped. Socket unlink and removal of the owned tmux root require positive stopped-server proof.
- Every real smoke run owns a fresh `TMUX_TMPDIR`. Socket cleanup requires the captured socket realpath to be exactly inside the owned `tmux-<uid>` directory with the unique server basename. It never unlinks an external, symlinked, non-socket, or unexpected path.
- Controlled providers append JSONL records containing unique invocation ID, PID, exact cwd, and payload. Cleanup writes every controlled stop file, requires each registered fixture to have at least one valid PID from its own invocation-ID rows (or its own pid-file compatibility fallback), deduplicates all discovered PIDs, and performs only bounded `process.kill(pid, 0)` observation until they exit. It never sends SIGTERM/SIGKILL, so stale or reused PIDs cannot cause destructive action. Missing evidence for one fixture cannot be hidden by another fixture's one or many PIDs; provider and tmux fixture roots are removed independently only after their corresponding providers-stopped/server-stopped proof. The real smoke asserts the concurrent locators are identical, invocation count is one, project topology is exactly one managed session/two windows, and session topology is exactly two managed sessions/two rows.

### Review RED/GREEN Evidence

- RED: conflict tests stopped at missing `getActiveCandidates`; GREEN: Direct and tmux exact choices focus their selected target, while cancel, stale handle, and rejected QuickPick boundaries produce zero focus actions.
- RED: generated HTML lacked `role="group"`; GREEN: native primary buttons and sibling actions pass detached/history/conflict labels plus Space and Shift+F10 behavior checks.
- RED: the smoke harness lacked `TMUX_TMPDIR`; GREEN: every injected cleanup-stage failure still reaches all remaining stages, and a failed first kill receives a second attempt.
- RED: the smoke harness lacked append-only invocation evidence; GREEN: JSONL assertions prove one concurrent dispatch, exact cwd/payload, unique invocations, and exact managed topology.
- RED: provider fallback used only the last pid file and sent termination signals; GREEN: ledger PID collection retains every valid duplicate invocation PID, ignores foreign/invalid rows, deduplicates, writes all stop files, and observes every tracked PID without destructive signals.

## Fail-safe Cleanup and Collision Review Follow-up

- Ordinary numeric `kill-server` failures now become fixed redacted errors and reach the one retry; only explicit tmux no-server/already-stopped output is accepted without retry. Two ordinary failures still proceed through stopped verification and every later stage, and cannot authorize socket or tmux-root removal without proof.
- Provider cleanup no longer sends signals to ledger or pid-file PIDs. Stop files are the only control mechanism. Every registered fixture must contribute valid PID evidence, and every discovered PID is polled with signal `0` until `ESRCH` within a fixed deadline; missing/partial/invalid evidence or a live, stale/reused, or unverifiable PID produces a redacted `CleanupAggregateError` and retains the provider fixture root.
- `removeFixtures(serverStopped, providersStopped)` independently guards the tmux root and provider root. The cleanup stage is always invoked, even when one or both proofs are false.
- Runtime chooser candidates and selected-runtime revalidation now use verified backend `getActive()` snapshots only. Tmux metadata/name collision diagnostics from `getConflicts()` are never passed to a chooser or backend focus, and the controller filters those diagnostics through the same project-key/cwd/session ownership rules before they can affect routing. Collision-only focus requests announce the safe no-action result; a separately verified Direct runtime remains exactly focusable while the unmanaged collision stays non-actionable, while a collision owned by another project has no effect.

### Fail-safe RED/GREEN Evidence

- RED: a collision diagnostic was returned as a chooser candidate, then the first scoped API test failed because conflict snapshots were unavailable; GREEN: collision-only returns zero candidates/focus, forged collision selection returns false, verified Direct plus unmanaged tmux collision focuses Direct only, and another project's collision cannot change the current project's focus route.
- RED: the harness contained SIGTERM/SIGKILL provider fallback; GREEN: source and behavior checks prove only signal-0 observation, all ledger PIDs, bounded timeout, stop-file fan-out, and retained roots on unverifiable exit.
- RED: every numeric `kill-server` exit was swallowed; GREEN: ordinary numeric failure retries, explicit no-server does not, and repeated ordinary failure remains redacted and fail-safe while later cleanup continues.

### Per-fixture Provider Evidence Review Follow-up

- RED: a non-empty fixture set with zero evidence silently returned an empty global PID list, allowing provider cleanup to report success.
- GREEN: evidence is validated per registered fixture. Tests cover zero evidence, two fixtures with evidence for only one, multiple PIDs for one fixture not masking the other, an empty fixture set, and complete evidence. All stop files are attempted first; partial evidence still signal-0 verifies every known PID, returns `providersStopped=false`, and retains the provider root without exposing invocation IDs or paths.
- Verification: focused tmux checks and the real isolated smoke passed, followed by the complete tmux/safety/dashboard/Open Project/architecture/lint/webpack/prepublish matrix. A fresh real smoke after production asset generation also passed, and final scans found no isolated socket, provider root, tmux root, or diagnostic root.

### Review Follow-up Final Verification

The complete Task 12 matrix exited 0 after review hardening:

```text
npm run test:tmux
npm run test:tmux:smoke
npm run test:safety
npm run test:dashboard
npm run test:open-projects
npm run test:architecture-baseline
npm run lint
npm run webpack
npm run vscode:prepublish
git diff --check
```

After production asset generation, the pure tmux runner passed ten consecutive runs (1–10) with zero failures. The real isolated harness then passed three consecutive runs. The first pre-matrix real run intentionally retained its tmux root when the initial stopped classifier did not recognize the host's exact status-1 `server exited unexpectedly` response; the provider root had already been independently removed only after all ledger PIDs reached `ESRCH`. Five isolated reproductions confirmed that exact result. After the classifier test/fix, the retained server and diagnostic roots were each checked with their corresponding `TMUX_TMPDIR` and server name (`list-sessions` returned explicit no-server), no controlled provider process or smoke root remained, and only those exact task-owned roots were removed. Final scans then found no `project-steward-test-*` socket and no `project-steward-tmux-smoke-*`, `project-steward-tmux-server-*`, or diagnostic fixture root. Lint emitted repository warnings only; webpack/prepublish emitted deprecation warnings only. No VSIX was installed and no push, PR, or merge was performed.
