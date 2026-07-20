# Tmux Focused Session Synchronization Design

Date: 2026-07-20

Status: Approved

## Goal

Keep the Project Steward `Focused` AI-session state aligned with the terminal target the user is actually viewing:

- immediately after a user focuses a session from Project Steward;
- within one second after a user changes the active window inside a managed project-layout tmux session;
- without changing execution, attention, runtime-liveness, or detach semantics.

## Confirmed Problem

Direct Terminal and tmux session layout normally change the active VS Code terminal when the user focuses another AI session. The existing `onDidChangeActiveTerminal` handler then refreshes the Dashboard.

Project tmux layout deliberately reuses one VS Code attach terminal for every AI-session window in a project. Focusing another AI session selects a different tmux window but leaves the VS Code terminal unchanged. The successful focus path does not request a Dashboard refresh, so the Active Sessions projection can continue showing the prior focused session.

The attach binding also records only the last target selected through Project Steward. If the user changes windows from inside tmux, no VS Code event fires and the binding is not reconciled with tmux's actual active window.

## Product Semantics

### Direct Terminal

The focused AI session remains the runtime associated with `vscode.window.activeTerminal`.

### Tmux Session Layout

Each AI session has its own tmux session and its own VS Code attach terminal. The focused AI session remains the runtime associated with `vscode.window.activeTerminal`.

### Tmux Project Layout

The active VS Code terminal identifies the managed project tmux session. The focused AI session is the managed AI runtime whose tmux window is the active window in that tmux session.

If the active window is not a managed AI window, no AI session is focused. A base shell or another unmanaged window must not cause an arbitrary AI runtime to appear focused.

Tmux project sessions intentionally share their current window across attached clients. Project Steward therefore follows the active window reported by tmux, including a change made by another attached client.

## Architecture

### Targeted active-window query

`TmuxClient` will expose a bounded, read-only operation that lists windows for one validated tmux session and returns its single active window. The operation uses argument-array process execution and the existing output limits and validation rules. It does not rescan metadata for unrelated sessions or windows.

The result distinguishes:

- one valid active window;
- no active window or no session;
- malformed or ambiguous output;
- command failure.

Only the first two are ordinary results. Malformed, ambiguous, and command-failure results follow the existing categorized tmux error path.

### Backend focused binding

`TmuxRuntimeBackend` will keep the persisted attach binding used for restoration and a separate in-memory focused binding for the currently viewed managed runtime.

- `attachAndFocus` updates the focused binding before it returns.
- restored attach terminals initially use their validated persisted binding.
- a targeted active-window synchronization replaces the in-memory focused binding when the active window maps to exactly one managed runtime.
- an active unmanaged window sets the in-memory focused binding to `null` without destroying the last valid persisted restoration binding.
- failures leave the prior in-memory focused binding unchanged.

The backend synchronization result reports the resolved identity and whether that identity changed. Callers do not compare terminal objects or infer focus from runtime liveness.

### Dashboard focus monitor

`TmuxFocusedRuntimeMonitor` will isolate the polling lifecycle from Dashboard composition. Dashboard supplies visibility, active-terminal lookup, backend synchronization, refresh, safe diagnostics, interval, and disposal dependencies. The monitor will run at a one-second interval and perform work only when:

- the Project Steward view is visible;
- the active VS Code terminal belongs to a managed tmux attach;
- that attach uses project layout.

The monitor is single-flight. If a query is still pending, the next interval does nothing. It requests an incremental AI-session view refresh only when the focused identity changes.

The existing active-terminal event will continue to handle Direct Terminal and tmux session layout. It will ask the monitor for an immediate targeted synchronization when a managed project attach terminal becomes active, avoiding a full one-second wait after switching VS Code terminals.

### Explicit plugin focus

After `AiSessionTerminalCommandController` successfully focuses an active or pending runtime, it invokes its existing refresh callback. For project layout, the backend has already updated the in-memory focused binding, so the refreshed projection immediately marks the selected session as Focused. This refresh is backend-neutral and is safe for Direct Terminal and session-layout tmux, where the active-terminal event may independently coalesce another refresh.

Conflict-selection focus follows the same success rule. Cancelled, missing, changed, or failed focus attempts do not claim a new focused identity; their existing error or status refresh behavior remains intact.

## Data Flow

### Project Steward click

1. The Webview sends `focus-ai-session-terminal`.
2. The terminal command controller resolves a project-owned runtime.
3. The runtime coordinator focuses the backend runtime.
4. The tmux backend selects the project window and updates its focused binding.
5. The terminal command controller requests an incremental refresh.
6. `getFocusedAiSessionRuntimeIdentity` reads the new backend focused runtime.
7. `applyAiSessionRuntimeProjection` marks exactly that Active Sessions row as Focused.

### Tmux-internal window change

1. The user or another attached client changes the active project tmux window.
2. The next visible-view monitor tick queries that tmux session's active window.
3. The backend maps the locator to one managed runtime, or to no runtime for an unmanaged window.
4. If the focused identity changed, the monitor requests an incremental refresh.
5. The next projection reflects the authoritative tmux result.

## Error Handling and Diagnostics

- A slow query cannot overlap another query for the same monitor.
- Hiding the Dashboard prevents new queries; disposal clears the interval.
- Closing or detaching the active terminal makes the next focus resolution return no managed attach.
- A transient query failure preserves the previous focused identity.
- Diagnostics contain only an operation name and error category. They do not contain executable paths, tmux session names, window names, provider commands, prompts, responses, or raw exception messages.
- No retry loop is added beyond the next ordinary one-second tick.

## Performance

The monitor performs at most one targeted tmux command per second, and only for the visible Dashboard's active managed project attach. It does not call the full runtime discovery refresh and does not enumerate metadata for every managed runtime. Stable results do not refresh the Webview.

## Compatibility

- Direct Terminal focused behavior remains unchanged except for an idempotent refresh after a successful explicit focus.
- Tmux session layout continues to rely on VS Code active-terminal changes and is not polled.
- Pending and promoted project-layout runtimes use the same locator-based focused mapping.
- Running/Stopped execution state remains provider-native and independent from focused state.
- Attention acknowledgement remains independent from focused synchronization.

## Test Strategy

Automated checks will cover:

1. a successful runtime focus requests one immediate refresh;
2. active and pending focus paths, including conflict-selected focus;
3. failed, missing, cancelled, and changed targets do not claim focus;
4. Direct Terminal and tmux session-layout focus remain correct;
5. targeted tmux active-window parsing, no-session behavior, malformed output, bounded output, and command-failure categorization;
6. project-layout synchronization from managed window A to managed window B;
7. switching to an unmanaged window clears the focused AI identity;
8. an unchanged active window produces no refresh;
9. query failure retains the last focused identity and logs only a safe category;
10. the one-second monitor is visibility-gated, single-flight, and disposed cleanly;
11. existing tmux, AI-session safety, real tmux smoke, compile, production build, and release packaging suites remain green.

## Acceptance Criteria

- Clicking any active project-layout AI session updates the Focused row immediately without waiting for a VS Code terminal-change event.
- Changing the window inside the active managed project tmux session updates the Dashboard within one second while the Dashboard is visible.
- Selecting an unmanaged window clears all Focused AI rows for that project attach.
- Stable focus does not trigger repeated Webview refreshes.
- Dashboard-hidden state does not issue active-window queries.
- Direct Terminal, tmux session layout, execution state, attention state, detach, restoration, and promotion behavior do not regress.
