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

---

## Important review follow-up: acknowledgement, mismatch, and retry state

Status: complete in a focused follow-up commit.

### Findings resolved

- Aggregate delivery now preserves the complete coordinator acknowledgement
  chain. The registered aggregate command returns the client's asynchronous
  consumer promise; a rejected consumer is logged locally with the original
  diagnostic but rejects the command boundary with fixed sanitized text. The
  client and coordinator commit their semantic revision only after the consumer
  resolves, so the same revision remains retryable.
- Handshake incompatibility no longer depends on exception message text. A
  private `OpenWorkspaceHandshakeIncompatibilityError` is created only when an
  actual response fails exact object keys, protocol version, capability values,
  accepted state, version bounds, or error-code validation. Rejected transport
  promises remain transient even when their messages contain words such as
  `protocol` or `capability`.
- Retry state now covers the full handshake-plus-publication recovery cycle.
  Successful handshakes retain `retryAttempt`; only successful required
  publication resets it. Likewise, `ready` is emitted only after publication
  success, preventing `ready`/`unavailable` churn between failed retries.

### Follow-up TDD evidence

RED failed on the newly added literal response mismatch case because
`protocolVersion: 1` scheduled a transient retry instead of entering terminal
update-required degradation:

```text
AssertionError: protocol version mismatch must not schedule a retry
1 !== 0
```

GREEN coverage proves:

- rejected, malformed, protocol-version-mismatched, and capability-mismatched
  responses are terminal, emit only `update-required`, and schedule no timer;
- a transport rejection whose text contains `protocol` remains transient;
- coordinator delivery through the actual registered client command rejects
  with sanitized text, retries the same semantic revision, and suppresses only
  after successful consumer acknowledgement; and
- six failed publications across successful retry handshakes use delays
  `100, 500, 2000, 10000, 30000, 30000`, keep one active timer, and emit exactly
  `unavailable` followed by `ready` after the seventh publication succeeds.

### Follow-up verification and self-review

Fresh verification passed main compile, UI Bridge compile, open-workspace
safety, Dashboard Webview, AI safety, and AI tmux. Source/generated Webview
parity and `git diff --check` also passed.

Self-review confirmed that no consumer detail crosses the command boundary,
only response validation can construct the terminal error type, and no path
other than publication success resets retry state or emits `ready`. No further
Critical, Important, or Minor finding remains.

---

## Important review follow-up: coalesced recovery publications

Status: complete in a focused follow-up commit.

### Finding resolved

- Publications captured while disconnected, handshaking, retrying, or awaiting
  the first successful current-generation acknowledgement are generation-gated.
  A newer workspace or `null` closure supersedes all older captured recovery
  operations before either handshake or publication.
- Retry recovery now enqueues the current desired generation directly. Only a
  successful acknowledgement of that current generation resets `retryAttempt`
  and emits `ready`; handshake success and stale acknowledgements cannot reset
  the backoff or churn status.
- Publications queued after the bridge is fully ready retain their existing
  sequential semantics, and disposal/unregister ordering is unchanged.

### Follow-up TDD evidence

RED used a deferred retry handshake after W1 failed, then queued W2 and W3. The
new regression initially observed both stale and current publications:

```text
AssertionError: recovery handshake completion must publish only the latest desired generation
actual: [W2, W3]
expected: [W3]
```

GREEN coverage proves:

- deferred recovery publishes only W3, never the captured W1 or W2;
- when the first W3 publication fails, the next delay is `500` rather than a
  reset `100`, exactly one timer remains active, and status stays
  `unavailable` until W3 is eventually acknowledged and emits `ready`;
- a latest `null` closure supersedes queued workspace generations; and
- a healthy connected client still publishes W1, W2, and W3 sequentially.

### Follow-up verification and self-review

Fresh verification passed main compile, UI Bridge compile, open-workspace
safety, Dashboard Webview, AI safety, and AI tmux. Source/generated Webview
parity and `git diff --check` also passed.

Self-review confirmed the latest-only window remains active across handshake
completion until the current generation is acknowledged, same-generation retry
heartbeats remain valid, normal ready-state sequencing is preserved, and no
dispose/unregister path changed. No further Critical, Important, or Minor
finding remains.

---

## Important review follow-up: stale identical acknowledgements

Status: complete in a focused follow-up commit.

### Finding resolved

- A successful stale in-flight command no longer commits `lastSemantic`.
  Semantic state, retry reset, and `ready` now share the same
  current-generation acknowledgement guard.
- Consequently, an identical latest workspace generation or repeated `null`
  cannot be duplicate-suppressed by a stale acknowledgement. It issues and
  receives its own command before recovery completes.
- A generation arriving after the acknowledgement guard remains safe because
  the guard, semantic commit, retry reset, and status transition are one
  synchronous continuation with no awaited or re-entrant boundary before
  `setStatus`; the prior generation has completed recovery atomically before a
  status callback can enqueue newer work.

### Follow-up TDD evidence

RED held a recovery publication in flight, queued the same workspace as a new
generation, then resolved the stale command. The new regression observed only
one command:

```text
AssertionError: identical workspace generation stale acknowledgement must not suppress the latest identical command
actual: [workspace]
expected: [workspace, workspace]
```

GREEN coverage proves for both an identical workspace and repeated `null`:

- the stale and latest generations issue exactly two commands;
- the latest publication promise resolves `true` only after its own command;
- status remains `unavailable` until that current acknowledgement emits
  `ready`, with no active retry timer; and
- a forced subsequent failure schedules `100` rather than continuing the old
  backoff, then its single retry restores final `ready` with no timer stranded.

Existing different-generation coalescing, healthy sequential publication,
backoff, and disposal/unregister tests remain green.

### Follow-up verification and self-review

Fresh verification passed main compile, UI Bridge compile, open-workspace
safety, Dashboard Webview, AI safety, and AI tmux. All three source/generated
Webview parity checks and `git diff --check` also passed.

Self-review confirmed stale success remains diagnostic-only, current success is
the sole semantic/recovery commit path, the synchronous guard prevents an
after-check generation from splitting the atomic recovery transition, and no
dispose/unregister path changed. No further Critical, Important, or Minor
finding remains.

---

## Important review follow-up: prior-semantic recovery health

Status: complete in a focused follow-up commit.

### Finding resolved

- A private `recoveryAcknowledgementRequired` state now separates bridge health
  from `lastSemantic`. It starts set, is set synchronously on transient
  handshake or publication failure, and is cleared only by current-generation
  acknowledgement or disposal.
- Semantic duplicate suppression requires that recovery state to be clear.
  The prior acknowledged semantic therefore remains available for healthy
  suppression without allowing an identical recovery generation to skip its
  required command.
- Handshake success and stale publication success do not clear recovery state,
  reset backoff, or emit `ready`.

### Follow-up TDD evidence

RED first committed a workspace semantic successfully, verified its healthy
duplicate was suppressed, failed a heartbeat, and resolved a stale retry after
queuing the identical latest generation. Only three commands were observed:

```text
AssertionError: prior workspace semantic recovery prior semantic must not suppress the latest recovery command
actual: [prior success, failed heartbeat, stale retry]
expected: [prior success, failed heartbeat, stale retry, latest success]
```

GREEN coverage proves for both a workspace and repeated `null`:

- healthy identical publication remains accepted without an extra command;
- the exact sequence is four commands: prior success, failed heartbeat, stale
  retry success, and latest success;
- after stale retry success, the latest command exists but its promise remains
  pending and status remains `unavailable`;
- only latest acknowledgement resolves the promise `true`, emits `ready`, and
  leaves no active timer.

Existing different-generation coalescing, healthy sequential publication,
backoff, heartbeat, and disposal/unregister tests remain green.

### Follow-up verification and self-review

Fresh verification passed main compile, UI Bridge compile, open-workspace
safety, Dashboard Webview, AI safety, and AI tmux. All three source/generated
Webview parity checks and `git diff --check` also passed.

Self-review confirmed every transient failure sets recovery state before any
status callback can re-enter publication, current acknowledgement clears it
before the `ready` callback, disposal clears it beside `disposed`, terminal
incompatibility remains non-retrying, and `lastSemantic` is never erased. No
further Critical, Important, or Minor finding remains.
