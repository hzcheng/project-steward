# Task 11 Report: Harden v2 Bridge Degradation and Incremental Updates

## Status and commit

Complete on `feat/workspace-support`.

- Commit message: `feat: show one card per open workspace`
- Nothing was pushed, merged, or cleaned up.

## Outcome

- Exact v2 handshake mismatch is terminal for the client and emits
  `update-required` without scheduling retries or allowing queued/heartbeat
  publications to create a handshake storm.
- Transient handshake or publication failure exposes `unavailable`, keeps at
  most one bounded retry timer, and republishes only the latest workspace after
  reconnection.
- Disposal during handshake unregisters immediately and prevents a late
  handshake from publishing. Disposal during an issued publication waits for
  that command to settle, then unregisters exactly once so the late publication
  cannot recreate stale bridge state.
- Aggregate semantic revisions are committed only after consumer delivery
  succeeds, allowing the same revision to recover from a failed callback.
- Workspace resolution is cached for a refresh/publication cycle and closure
  publishes `workspace: null`.
- Dashboard projection pairs each opaque navigation card with the winning live
  `OpenWorkspaceRecord`. The map is cleared immediately on semantic aggregate
  change or degradation and rebuilt only from the latest aggregate.
- Stale opaque-card clicks refresh safely and never fall through to saved
  project lookup or an open action.
- Bridge failures clear only the OTHER WINDOWS projection. The locally built
  current card, session surface, and workspace-scoped actions remain usable.
- OPEN incremental messages include a semantic OTHER WINDOWS status. Host and
  Webview duplicate suppression avoid repeat DOM/search-catalog replacement,
  while failed message delivery clears the suppression key for recovery.
- OTHER WINDOWS renders lightweight navigation cards in `ready`, a retrying
  unavailable state for transient failures, or an actionable UI Bridge upgrade
  state for mismatch. The upgrade state is forced open even when the saved
  group state is collapsed.
- Bridge publications and navigation cards retain only workspace/root metadata;
  no `hostPath`, provider history, session detail, prompt, or terminal state is
  transported through the v2 bridge.
- The production bridge path remains v2-only. The new actionable command opens
  the installed UI Bridge extension entry and adds no legacy bridge command.

## TDD evidence

### RED

The Task 10 baseline first passed main compile, UI Bridge compile, open-project
safety, and Dashboard Webview checks. After adding Task 11 tests, the focused
command failed at the first missing degradation contract:

```text
AssertionError: Expected values to be strictly deep-equal:
actual: []
expected: [ 'update-required' ]
```

The red suite also encoded terminal mismatch/no retry timer, queued transient
retry gating, handshake and publication disposal ordering, aggregate
re-delivery, stale opaque-ID invalidation, two navigation cards plus one current
card, privacy-bounded root metadata, delivery recovery, semantic update
suppression, and current-card isolation.

During self-review, an additional RED Webview case proved the actionable upgrade
state was hidden when the saved OTHER WINDOWS group was collapsed. A final RED
source contract proved stale opaque clicks were not yet routed to the dedicated
refresh path.

### GREEN

All new client, controller, projection, message, rendering, DOM consistency,
source wiring, and lifecycle cases pass. The source and shipped Webview scripts
are byte-identical.

## Self-review

- Critical findings: none.
- Important fixed: an update-required control could be hidden by saved collapse
  state; degraded states now render expanded.
- Important fixed: an invalidated opaque navigation ID could fall through to
  saved-project lookup and show a misleading warning; reserved navigation IDs
  now refresh with `open-workspace-navigation-stale` and perform no open action.
- Important fixed during impacted verification: the committed `media` Webview
  script is an exact generated mirror of `src/webview`; it was synchronized and
  parity-checked.
- Reviewed retry-timer gating, late handshake completion, publication/unregister
  ordering, aggregate callback failure, in-flight message delivery races, map
  invalidation, current-card construction, and v2 command/privacy boundaries.
- No Minor items are intentionally deferred from Task 11.

## Fresh verification

The final pre-commit verification command exited `0`:

```text
npm run test-compile
npm run attention:bridge:compile
node scripts/run-open-project-safety-checks.js
node scripts/run-dashboard-webview-checks.js
node scripts/run-ai-session-safety-checks.js
node scripts/run-ai-session-tmux-checks.js
cmp -s src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
git diff --check
```

Observed suite output:

```text
Open project safety checks passed.
Dashboard Webview checks passed.
AI session safety checks passed.
AI session tmux checks passed.
```

Both TypeScript compilers and all remaining hygiene commands exited `0`.

## Concerns and deferred scope

- No Task 11 correctness concern remains.
- Actual cross-window navigation capability and opening behavior remain Task 12
  scope; Task 11 continues to refresh safely instead of opening a workspace.
