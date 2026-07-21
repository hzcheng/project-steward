# Open Workspace Prior-Semantic Recovery Design

## Context

The bridge retains `lastSemantic` from the most recent current-generation
acknowledgement so healthy identical publications can be suppressed. After a
later publication or handshake failure, however, that prior semantic must not
allow an identical current recovery generation to return success without a new
acknowledgement.

The existing generation guard correctly prevents a stale in-flight recovery
acknowledgement from resetting backoff or emitting `ready`, but the prior
semantic can still suppress the identical newest operation and strand the
bridge in `unavailable`. The same race applies when the semantic is `null`.

## Design

Add an explicit private `recoveryAcknowledgementRequired` boolean to
`OpenWorkspaceBridgeClient`.

- Initialize it to `true`, because activation is not healthy until the initial
  current generation is acknowledged.
- Set it to `true` synchronously when a transient handshake or publication
  failure enters recovery.
- Allow semantic duplicate suppression only while it is `false`.
- Clear it only in the current-generation successful publication guard, beside
  the `lastSemantic` commit, retry reset, and `ready` transition.
- Clear it during disposal, when no further recovery acknowledgement can be
  required.

Handshake success does not clear the flag. A stale publication success remains
diagnostic-only and also does not clear it. `lastSemantic` remains intact across
failure, preserving the distinction between last acknowledged content and
current bridge health.

All flag transitions are synchronous with their associated failure, current
acknowledgement, or disposal state transition. There is no awaited boundary
between the generation check and the current-success semantic/recovery commit.

## Tests

Use a shared deferred regression for both a workspace record and `null`:

1. Complete the initial publication successfully and prove a healthy identical
   `publish()` is accepted without another command.
2. Fail a forced heartbeat publication, observe `unavailable` and one `100` ms
   retry timer, then fire the timer.
3. Hold the first recovery publication in flight, queue the identical newest
   generation, and resolve the now-stale retry.
4. Assert the latest promise is still pending, status is still `unavailable`,
   and a second recovery command is issued.
5. Resolve the latest command and assert its promise becomes `true`, status
   becomes `ready`, and no timer remains.

Each case observes exactly four publication commands: prior success, failed
heartbeat, stale retry success, and latest success. Existing different-value
generation coalescing, healthy sequencing, retry backoff, heartbeat behavior,
and dispose/unregister ordering remain required.
