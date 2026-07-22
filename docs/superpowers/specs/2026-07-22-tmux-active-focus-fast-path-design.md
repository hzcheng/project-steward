# Tmux Active Session Focus Fast Path Design

Date: 2026-07-22

Status: Approved

## Goal

Make clicking an active tmux AI-session card feel immediate while preserving exact workspace identity, managed-runtime ownership, conflict handling, stale-target recovery, and the existing card UI.

## Confirmed Problem

`AiSessionRuntimeCoordinator.focus` currently performs `refreshForHost(true)` before every ordinary tmux focus. That refresh waits for both Direct Terminal and tmux discovery before `TmuxRuntimeBackend.focus` can call `select-window`.

Tmux discovery calls `list-windows`, then reads 12 Project Steward metadata options separately for each unique session and each window. With 24 sessions/windows this can require roughly 576 sequential child processes before the target window is selected. Dev Container process and filesystem overhead makes the delay readily exceed one second.

The full scan is also not atomic with the later selection: tmux state may still change between discovery completion and `select-window`. Keeping it on the click path therefore adds latency without providing an atomic focus guarantee.

## Product Semantics

- A normal click may use the coordinator's cached runtime only when it is the single non-conflict candidate for the exact provider, session, and workspace scope.
- Before selecting a cached tmux locator, Project Steward must read a live metadata snapshot for that exact tmux target and verify the complete runtime identity.
- A missing target or identity mismatch must never be selected.
- A changed target triggers one forced host refresh. The refreshed identity may be focused only when it again resolves to exactly one non-conflict runtime and passes the same targeted verification.
- A second target change ends the action without another retry loop.
- Known conflicts and explicit conflict choices retain their existing forced-refresh behavior.
- Direct Terminal focus behavior remains unchanged.
- No Dashboard markup, CSS, icon, animation, card text, or click target changes are included.

## Architecture

### Targeted tmux snapshot

`TmuxClient` will expose `getTargetWindow(locator)`. It runs one bounded `display-message -p -t <exact-target> <format>` command. The format returns the actual session name, window name, window ID, and all Project Steward metadata values in one delimiter-safe record.

The parser will:

- require exactly one record with the expected field count;
- validate session/window names and the tmux window ID;
- reject control characters and over-limit metadata values;
- return `null` only for recognized missing-session/window/no-server results;
- return categorized, redacted errors for malformed output, timeout, or other failures.

The method does not enumerate unrelated sessions or windows.

### Backend ownership verification

`TmuxRuntimeBackend.focus` will obtain the targeted snapshot before `select-window`. It will use `parseManagedTmuxMetadata` and require:

- parsed metadata version and layout are valid;
- actual session/window locator equals the cached locator;
- parsed workspace scope, navigation identity, root snapshot, cwd, provider, and final/pending ID equal the cached runtime identity.

A missing or mismatched target throws a typed `AiSessionRuntimeTargetChangedError`. No terminal is created, shown, rebound, or selected before this verification succeeds.

### Coordinator fast path and recovery

For one cached non-conflict tmux runtime, `AiSessionRuntimeCoordinator.focus` calls the tmux backend immediately. It does not refresh Direct or tmux discovery first.

If targeted verification reports `AiSessionRuntimeTargetChangedError`, the coordinator performs one existing `refreshForHost(true)`, re-resolves the complete identity, and retries only if exactly one non-conflict runtime remains. A second target-change result is treated as an ordinary changed target and returns without focusing. Operational errors continue through existing safe diagnostics.

Conflict-only, ambiguous, or already-conflicted cached states do not enter the fast path. `focusSelected` keeps its existing forced refresh and exact selected-runtime comparison.

### Faster background discovery

The discovery protocol and session/window ownership split remain unchanged. `readMetadataOptions` will issue the 12 independent, bounded `show-options` reads concurrently for one target and preserve the existing all-or-nothing parse result. Targets remain processed in the existing bounded sequence, so concurrency is capped at the fixed metadata-field count instead of growing with the number of tmux windows.

This reduces background refresh latency without weakening the separate session-level and window-level ownership checks or introducing an incompatible metadata protocol.

## Error and Race Handling

- The targeted snapshot is immediately adjacent to selection and therefore has a smaller race window than the old global scan.
- If a target changes after validation but before selection, `select-window` fails through the existing categorized tmux error path; Project Steward does not silently select a fallback target.
- A validation mismatch causes exactly one global reconciliation, not an unbounded retry.
- A global conflict discovered during reconciliation prevents retry focus.
- A Direct/tmux collision already present in coordinator state continues to use the chooser.
- Error messages do not expose executable paths, tmux locators, metadata, prompts, or raw stdout/stderr.

## Performance Requirements

- A normal cached tmux card click performs one targeted metadata command, one `select-window`, and the existing attach-terminal show/flush work.
- A normal cached tmux card click performs zero Direct refreshes and zero full tmux discovery refreshes.
- Missing/mismatched targets may pay for one forced refresh and one revalidation.
- Metadata discovery has at most 12 option-read child processes in flight for one target and does not scale concurrency with total window count.

## Test Strategy

Automated checks will cover:

1. targeted snapshot command arguments, complete metadata parsing, and exact locator output;
2. missing target, malformed field count, oversized/control-character metadata, command failure, and redacted errors;
3. backend target identity and locator verification before any `select-window` or terminal show;
4. successful project-layout and session-layout focus;
5. coordinator unique tmux fast path with no backend refresh;
6. target-change forced refresh and one successful retry;
7. target-change refresh that resolves to missing, duplicate, or conflict state does not focus;
8. a second target change does not loop;
9. conflict-selected focus retains forced refresh;
10. Direct Terminal focus behavior remains unchanged;
11. metadata option reads overlap while retaining bounded concurrency and fail-closed semantics;
12. existing tmux, workspace parity, AI-session safety, Dashboard, real tmux smoke, compile, build, and packaging suites remain green.

## Acceptance Criteria

- Clicking a healthy active tmux session no longer waits for global runtime discovery.
- The clicked runtime is live-validated against the complete workspace-aware identity before selection.
- A stale, replaced, malformed, or conflicting target is never silently focused.
- Ordinary target-change recovery performs at most one forced refresh and one retry.
- Existing attention, running animation, completion, pending promotion, detach, conflict chooser, focused-row synchronization, and workspace projection behavior do not regress.
- The extension's visual appearance is unchanged.
