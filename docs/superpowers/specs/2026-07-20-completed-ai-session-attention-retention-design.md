# Completed AI Session Attention Retention Design

## Goal

Restore the existing cross-window attention contract for both VS Code Terminal
and tmux runtimes: once an owned AI run completes and raises a
`needsAttention` event, Project Steward keeps the project badge visible until
the user clicks the corresponding AI Session or the project card carrying the
badge.

The fix must not change the production attention bridge protocol or package.
The main extension remains the owner of its unread event while the existing UI
Bridge continues to aggregate owner snapshots and filter explicitly
acknowledged event IDs.

## Regression

The runtime settlement path currently performs this sequence:

```text
publish needsAttention -> acknowledge event -> release runtime
```

That treats successful delivery as if the user had read the event. The bridge
therefore removes the event before another window can keep the project badge
visible. The settlement helper is shared by VS Code Terminal and tmux
backends, so the regression affects both modes.

Existing safety checks encode this incorrect sequence and therefore cannot
detect the product regression. They must be replaced with behavioral checks
that observe the aggregate before and after an explicit user acknowledgement.

## Product Contract

- Runtime delivery confirmation and user acknowledgement are distinct.
- A successful attention snapshot publication permits lifecycle cleanup; it
  does not acknowledge any event.
- A completed runtime whose attention snapshot could not be published remains
  owned and is retried.
- An unread completion survives removal of its VS Code Terminal or tmux
  runtime ownership record for the lifetime of the owning extension host.
- Clicking the corresponding AI Session acknowledges all retained run events
  for that provider/session pair.
- Clicking a project card in `OTHER WINDOWS` acknowledges the event IDs carried
  by that project's badge.
- Acknowledgements made in another window remain effective through the
  bridge's existing acknowledged-event filtering, even if the owning extension
  host republishes its retained local item.
- Attention disabled by configuration continues to clear local attention and
  must not block runtime cleanup.

Extension-host restart persistence is not added in this fix. The production
bridge package and protocol remain unchanged at version `0.1.3`.

## Main-Extension State Model

`AiSessionAttentionMonitor` retains an unseen entry only while it is in
`needsAttention`. Unseen `pending`, `running`, and `acknowledged` entries are
removed as before. This creates a small owner-side unread ledger without tying
it to a live runtime.

The attention controller keeps the mapping from a logical provider/session key
to its per-run attention keys while any retained monitor entry still exists.
This is necessary because lifecycle settlement uses a run-specific key:

```text
provider:sessionId:runStartedAtMs:backend
```

Run-specific keys prevent a later run from replaying or clearing an earlier
run's event. UI recovery data folds the retained run event IDs back under the
logical `provider:sessionId` key so clicking the visible Session acknowledges
all of its retained events.

The number of retained events remains bounded by the existing 1,000-item
attention payload limit. When the bound is reached, the controller preserves
the newest valid events, discards older overflow events from local retention,
and never emits an oversized bridge payload. Overflow is an explicit
best-effort degradation: a completed runtime whose event was discarded only
because of this safety limit may still be released, avoiding a permanently
blocked Session at the cost of dropping that old reminder.

## Lifecycle Settlement

Settlement evaluates all completion candidates once and classifies them as
follows:

- `stopped`, out-of-scope, or attention-disabled candidates may be released
  without an event.
- An in-scope completed candidate with a generated event may be released only
  after `publish()` returns `true`.
- An in-scope completed candidate with no event evidence or a failed
  publication remains owned for retry.
- An in-scope completed candidate whose event was generated but explicitly
  discarded by the 1,000-item safety limit may be released after the bounded
  snapshot is published successfully.

Settlement no longer calls either the bridge acknowledgement command or the
local monitor acknowledgement method. Those methods are reserved for explicit
user interaction. Merely completing, releasing, detaching, or closing runtime
infrastructure does not count as reading the event.

After successful release, later attention evaluations no longer see the
runtime input, but the monitor retains the `needsAttention` event and the
controller continues to include it in its owner snapshot.

## Acknowledgement Flow

### Session click in the owning window

The webview sends `acknowledge-ai-session-attention` with all event IDs mapped
to the logical Session. The main extension acknowledges the event locally and
through the bridge. The next owner snapshot marks or removes the event, and
the aggregate badge disappears.

### Project-card click in another window

The navigation card sends the project badge's event IDs to the bridge. The
bridge's existing acknowledgement store filters those IDs from every aggregate.
The owner may continue to publish its retained local item until disposal, but
the acknowledged ID cannot reappear in `OTHER WINDOWS` or the owning window.
No bridge protocol change is required.

## Error Handling

- Publication failure retains runtime lifecycle ownership and the unread event
  for a later retry.
- Runtime release failure retains the candidate and retries without generating
  a different event ID.
- Local acknowledgement failure is contained by the existing safe task
  boundary; bridge acknowledgement still prevents a cross-window badge replay.
- Duplicate completion polling is deduplicated by the run-specific lifecycle
  key and stable event ID.
- Stale acknowledged entries are pruned on later monitor evaluations.

## Automated Regression Coverage

The safety suite will prove all of the following:

1. A VS Code Terminal completion publishes an unread event, releases the
   runtime after delivery, and still appears in the effective aggregate.
2. A tmux completion follows the same contract and keeps the `OTHER WINDOWS`
   project attention count non-zero after its inactive binding is consumed.
3. Re-evaluating after the runtime has disappeared keeps an unacknowledged
   completion in the owner snapshot.
4. Settlement never invokes local or bridge acknowledgement as part of runtime
   cleanup.
5. A failed publication prevents both VS Code Terminal and tmux runtime
   release.
6. Clicking a logical Session acknowledges every retained per-run event for
   that provider/session pair.
7. Project-card acknowledgement filters the retained event from the aggregate,
   including when the owner republishes it.
8. Multiple runs of one Session use distinct event IDs and acknowledging one
   run cannot clear an unacknowledged later run.
9. Attention-disabled and genuinely stopped runtimes continue to settle
   without producing a badge.
10. A 1,001-event evaluation publishes the newest 1,000 items, discards the
    oldest retained item, and does not leave that overflow runtime blocked.
11. Source-wiring checks reject reintroduction of automatic acknowledgement in
    the lifecycle settlement path.

Focused tests run before the full compile, safety, tmux smoke, and release
packaging suites. Manual acceptance repeats the two-window scenario once with
`aiSession.runtimeBackend = vscode` and once with `tmux`.

## Release Impact

- Main extension: include the fix and regression coverage in `2.1.3`.
- Attention UI Bridge: no source, protocol, or version change; remain at
  `0.1.3`.
- The pending merge, tag, and GitHub Release remain blocked until both runtime
  modes pass automated and manual verification.
