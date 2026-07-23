# Workspace Running Animation Rebase Design

Date: 2026-07-21

Status: Approved direction A

## Context

The feature branch was rebased onto main after main added configurable running-session animation to legacy OTHER WINDOWS project cards. Workspace-first support intentionally deletes that v1 card/protocol path, and its approved privacy boundary forbids OTHER WINDOWS records and cards from carrying session or provider details.

The rebase must preserve main's user-visible animation capability without restoring the deleted v1 protocol or weakening the workspace-first privacy contract.

## Decision

Apply running-session card animation only to the CURRENT WORKSPACE card. Derive the running count locally from that card's hydrated `activeSessions` whose `executionState` is `running`. Do not add a running count, boolean, provider detail, or any other session fact to `OpenWorkspaceRecord`, bridge protocol v2, navigation cards, diagnostics, or navigation semantic revisions.

The existing `projectSteward.aiSessionRunningCardAnimation` values remain:

- `current`
- `sweep`
- `orbit`
- `halo`
- `ripple`
- `breath`
- `none`

Documentation and setting text will describe the CURRENT WORKSPACE behavior. `none` keeps the static running-state card treatment but renders no animation layer. Unknown values fail safely to `current`.

## Rendering and data flow

`WorkspaceAiSessionViewModel.activeSessions` remains the only data source. Rendering counts entries with `executionState === 'running'` and applies `session-running`, `data-session-fx`, the optional effect layer, and an accessible running-count title only when the card is current and the count is positive.

The animation value must flow through every render path:

1. Full Webview render reads the current configuration through `StewardInfos`.
2. Open-workspace incremental updates obtain the current configuration through the dashboard controller and pass it to the v2 update-message builder.
3. AI-session incremental updates do the same, so an execution-state refresh updates the card without a full Webview reload.

Navigation cards ignore the animation option even if malformed input contains an `aiSessions` field. This keeps OTHER WINDOWS privacy behavior structural rather than conventional.

The terminal-icon running animation already added by main remains unchanged.

## Error and compatibility behavior

No persisted project data or transient v1 state is read or migrated. No v2 bridge schema changes are made. Missing configuration uses `current`; invalid configuration also normalizes to `current`. A missing or unhydrated session view model renders an idle card.

## Verification

Behavior tests must first fail against the rebased code, then prove:

- current cards animate for running sessions and not merely active/stopped sessions;
- every configured mode is accepted, `none` omits the effect layer, and invalid values use `current`;
- navigation cards never expose the running count or animation markup;
- full render, open-workspace incremental updates, and AI-session incremental updates use the configured value;
- the main configuration enum, card keyframes, reduced-motion behavior, and terminal-icon animation remain present;
- the workspace-first privacy/source gates and complete automated suite remain green.
