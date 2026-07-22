# Cross-platform and remote manual verification matrix

Matrix version: 1

Owner: Project Steward maintainers

Record policy: copy this document for an execution, fill every environment field, replace `NOT RUN` and the evidence placeholder, and retain the completed record with the release or pull-request evidence. A behavior passes only when every expected result is observed.

## OPEN-MULTI-WINDOW-001 — two local windows aggregate and focus correctly

- Prerequisites: install the candidate main and UI Bridge VSIX files in one local VS Code installation; prepare two different local project folders; clear stale dashboard publications by closing VS Code before starting.
- Steps: open each folder in a separate local VS Code window; open Project Steward in both; confirm each dashboard lists both open projects; select the other window's project from each dashboard; close one window and refresh the remaining dashboard.
- Expected results: each project is shown once with the correct window identity; selecting the other project focuses its existing window instead of opening a duplicate; the closed window disappears without removing the still-open project.
- Environment: OS/version = `UNRECORDED`; VS Code/version = `UNRECORDED`; extension versions = `UNRECORDED`; workspace paths/kinds = `UNRECORDED`.
- Execution date/result: `NOT RUN` (replace with ISO date and `PASS` or `FAIL`).
- Evidence location: `UNRECORDED` (link a redacted screen recording or screenshots plus extension-host logs).

## OPEN-SAME-WORKSPACE-WINDOWS-001 — duplicate windows for one workspace remain distinct

- Prerequisites: install the candidate VSIX files locally; prepare one local folder or workspace that VS Code permits opening in two windows.
- Steps: open the same workspace in two separate windows; open Project Steward in both; verify both publications; focus each window from the dashboard; close one window and wait for publication expiry/cleanup.
- Expected results: both live window instances are represented without unstable flicker or accidental collapse; selecting an instance focuses the intended window; cleanup removes only the closed instance.
- Environment: OS/version = `UNRECORDED`; VS Code/version = `UNRECORDED`; extension versions = `UNRECORDED`; workspace URI = `UNRECORDED`; window identifiers (redacted) = `UNRECORDED`.
- Execution date/result: `NOT RUN` (replace with ISO date and `PASS` or `FAIL`).
- Evidence location: `UNRECORDED` (link redacted before/after screenshots and extension-host logs).

## OPEN-REMOTE-SSH-MANUAL-001 — Remote SSH publication and open behavior

- Prerequisites: a reachable SSH host with the VS Code Remote - SSH extension; install the main extension in the SSH extension host and the UI Bridge in the local UI host; prepare one local and one remote project.
- Steps: open the remote project through Remote SSH and the local project in another window; open Project Steward; select each project from the opposite window; disconnect and reconnect SSH; reopen the dashboard.
- Expected results: local and SSH projects have distinct, stable identities; selection focuses the existing matching window; remote paths are not treated as local paths; disconnect removes or marks stale remote publication safely; reconnect restores it without duplication.
- Environment: local OS/version = `UNRECORDED`; SSH host OS/version = `UNRECORDED`; VS Code/Remote SSH versions = `UNRECORDED`; extension versions and host placement = `UNRECORDED`; remote authority (redacted) = `UNRECORDED`.
- Execution date/result: `NOT RUN` (replace with ISO date and `PASS` or `FAIL`).
- Evidence location: `UNRECORDED` (link redacted local/remote screenshots, Remote SSH log, and extension-host logs).

## OPEN-REMOTE-WSL-MANUAL-001 — WSL publication and path identity

- Prerequisites: Windows with WSL and the VS Code WSL extension; install the main extension in WSL and the UI Bridge in the local UI host; prepare one Windows project and one WSL project.
- Steps: open both projects in separate windows; open Project Steward; select each project across windows; reload the WSL window; close and reopen it.
- Expected results: Windows and WSL URIs remain distinct and correctly labeled; selection focuses the existing window; Linux paths are not rewritten as Windows drive paths; reload/reopen does not leave duplicate stale publications.
- Environment: Windows build = `UNRECORDED`; WSL distribution/version = `UNRECORDED`; VS Code/WSL extension versions = `UNRECORDED`; Project Steward versions and host placement = `UNRECORDED`.
- Execution date/result: `NOT RUN` (replace with ISO date and `PASS` or `FAIL`).
- Evidence location: `UNRECORDED` (link redacted screenshots, WSL log, and extension-host logs).

## OPEN-DEV-CONTAINER-MANUAL-001 — Dev Container publication and lifecycle

- Prerequisites: Docker-compatible runtime and the VS Code Dev Containers extension; a fixture dev container; install the main extension in the container and the UI Bridge in the local UI host.
- Steps: open the fixture in a Dev Container and a local project in another window; open Project Steward; focus both projects from the opposite dashboard; rebuild/reopen the container; stop the container and observe cleanup.
- Expected results: container and local identities remain distinct; project selection focuses the correct existing window; rebuild/reopen produces one current publication; stopping the container does not leave an actionable ghost entry after cleanup.
- Environment: local OS/version = `UNRECORDED`; container image/digest = `UNRECORDED`; VS Code/Dev Containers versions = `UNRECORDED`; Project Steward versions and host placement = `UNRECORDED`.
- Execution date/result: `NOT RUN` (replace with ISO date and `PASS` or `FAIL`).
- Evidence location: `UNRECORDED` (link redacted screenshots, Dev Containers log, and extension-host logs).

## ATTENTION-UI-VISUAL-001 — attention state is visually correct

- Prerequisites: install both candidate VSIX files in their intended hosts; configure a controllable AI provider session that can transition through Running, Waiting, Completed, and Stopped.
- Steps: trigger each lifecycle state; inspect the dashboard marker, activity badge, colors, text, and ordering in both light and dark themes; acknowledge attention; repeat from a second window.
- Expected results: each state has the documented distinct presentation; contrast and labels remain readable; cross-window state agrees; acknowledgement clears only the intended attention; no stale badge survives a later state.
- Environment: OS/version = `UNRECORDED`; VS Code/version/theme = `UNRECORDED`; extension versions/host placement = `UNRECORDED`; provider/runtime = `UNRECORDED`; display scale/accessibility settings = `UNRECORDED`.
- Execution date/result: `NOT RUN` (replace with ISO date and `PASS` or `FAIL`).
- Evidence location: `UNRECORDED` (link redacted light/dark screenshots or recording for every lifecycle state).

## SESSION-TERMINAL-FOCUS-MANUAL-001 — session selection focuses the intended terminal

- Prerequisites: install the candidate VSIX files; create at least two AI sessions with distinct Direct Terminal or tmux targets in one project.
- Steps: select each session card repeatedly; switch to an unrelated terminal and select the session again; detach and reattach a tmux target when applicable; close one target and select its stale card.
- Expected results: a live selection reveals and focuses only the matching terminal/viewer; repeated selection is idempotent; detach/reattach preserves target identity; stale selection reports a bounded actionable failure and does not focus a sibling terminal.
- Environment: OS/version = `UNRECORDED`; VS Code/version = `UNRECORDED`; extension versions = `UNRECORDED`; provider/runtime/layout/tmux version = `UNRECORDED`; shell = `UNRECORDED`.
- Execution date/result: `NOT RUN` (replace with ISO date and `PASS` or `FAIL`).
- Evidence location: `UNRECORDED` (link redacted terminal/dashboard recording and extension-host logs).

## RUNTIME-SLEEP-DISCONNECT-RECOVERY-001 — sleep and remote disconnect recover safely

- Prerequisites: install the candidate VSIX files; create a running session and an attention transition; for the remote variant, use SSH or Dev Container with main/UI extension host placement recorded.
- Steps: suspend and resume the local machine while the session is running; separately disconnect the remote transport and reconnect it; reopen/focus the dashboard; wait for discovery and attention reconciliation; select the recovered session.
- Expected results: recovery does not duplicate sessions, windows, or attention; stale state is replaced by the newest observed state; a surviving runtime can be focused; a terminated runtime is reported as stopped/unavailable without an unbounded retry loop or leaked publication.
- Environment: local OS/version/power mode = `UNRECORDED`; remote kind/OS = `UNRECORDED`; VS Code/remote extension versions = `UNRECORDED`; Project Steward versions/host placement = `UNRECORDED`; provider/runtime/layout = `UNRECORDED`; sleep/disconnect duration = `UNRECORDED`.
- Execution date/result: `NOT RUN` (replace with ISO date and `PASS` or `FAIL`).
- Evidence location: `UNRECORDED` (link a redacted timestamped recording and local/remote extension-host logs).
