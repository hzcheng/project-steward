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
