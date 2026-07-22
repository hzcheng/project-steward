# Open Workspace Stale Identical Acknowledgement Design

## Context

Recovery publications are generation-gated so captured older workspaces cannot
publish after a newer desired workspace. One remaining race exists after a
publication command is already in flight: its acknowledgement can arrive after
an identical newer generation is queued. If that stale acknowledgement commits
`lastSemantic`, duplicate suppression can accept the newest operation without a
current-generation acknowledgement, leaving retry state and status stranded.

The same race applies to repeated `null` closure publications.

## Design

Publication acknowledgement state belongs to its generation. A successful
command may commit `lastSemantic`, reset `retryAttempt`, and emit `ready` only
when its generation is still the current `latestGeneration` at acknowledgement
time.

A stale successful command may still emit its success diagnostic, but it does
not mutate semantic or recovery state. Therefore, an identical current
generation queued behind it cannot be duplicate-suppressed and issues its own
publication command. The current acknowledgement then atomically commits the
semantic and completes recovery. JavaScript's synchronous acknowledgement
continuation prevents a newer `publish()` call from interleaving within that
generation check and state commit; a generation queued afterward observes a
fully completed prior recovery cycle.

Normal connected sequential publication remains unchanged. Recovery
generation coalescing before command dispatch, retry scheduling, and
dispose/unregister ordering are not modified.

## Tests

Add two deferred command regressions using the real bridge client:

1. An initial workspace publication is held in flight, the same workspace is
   published as a newer generation, and the stale command succeeds. Assert that
   the newer promise is accepted only after a second command, status becomes
   `ready`, retry state is not stranded, and no retry timer remains.
2. Repeat the scenario for initial `null` followed by another `null`, with the
   same two-command and recovery-completion assertions.

The existing different-generation coalescing, healthy sequential publication,
backoff, and disposal tests remain required and run in the full Task 11 matrix.
