# Task 11 Report: Host Runtime Composition and Lifecycle

## Outcome

- Composed Direct and tmux runtime backends, persistence, discovery, attach bindings, creation locking, and the runtime coordinator in the extension host.
- Restored Direct terminal bindings, then forced tmux discovery and restored attach terminals, before constructing the hydration controller.
- Converted attention, archive, create, resume, terminal commands, hydration, and active projection host wiring to runtime snapshots.
- Added activation, attention, visible-view, terminal-close, and configuration refresh sequencing without runtime migration.
- Added exact explicit Direct fallback, known-hint modal override, Open Settings, and redacted tmux diagnostics.
- Completed and stopped tmux transitions now differ: current markers emit the existing completion signal; stopped runtimes do not.
- Detached tmux runtimes block archive and can create/reuse a viewer without restarting the provider.

## Authorized Plan Gap

`src/aiSessions/tmuxRuntimeBackend.ts` was added to the planned file set after reporting that `focus()` only selected an existing attach client. The approved fix routes detached focus through the existing attach-only path with a bounded stable `Project Steward:` title. Fake tests prove one viewer is created, repeated focus reuses it, provider creation counts do not increase, and attach failures leave the runtime live without resending the provider command.

`TmuxClient.setExecutablePath()` already clears its availability promise. Configuration changes reapply the executable to invalidate availability, invalidate discovery, and force refresh; no duplicate cache API was added.

## TDD Evidence

- RED: tmux checks failed because dashboard composition lacked `TmuxRuntimeBindingStore`; safety failed because attention still called `getTerminalById`.
- Additional RED: stopped runtime initially retained the archive guard.
- GREEN: runtime-neutral controller checks, host source contracts, detached focus/reattach checks, stopped archive behavior, fallback copy, restore ordering, and redacted logging checks pass.
- No real tmux process was invoked.

## Final Verification

The final post-change command exited 0:

```text
npm run test-compile && node scripts/run-ai-session-tmux-checks.js && npm run test:safety && npm run test:dashboard && npm run test:architecture-baseline && npm run test:tmux && npm run test:tmux && npm run lint && git diff --check
```

- Compile, tmux checks, safety/open-project checks, dashboard checks, and architecture baseline passed.
- Tmux passed in the required direct run plus two consecutive npm-script runs.
- Lint exited 0 with only the repository's pre-existing warnings.
- `git diff --check` passed.
- The worktree used an ignored `node_modules` symlink to the primary checkout's existing dependency installation so dashboard CSS verification could resolve dragula; no tracked dependency files changed.

## Review Hardening Follow-up

- Direct completion now remains tracked with its marker until the completed attention snapshot is accepted, its event is awaited through bridge acknowledgement, and the local event is acknowledged; only then is the Direct entry released. A failed publication leaves ownership intact for retry.
- Tmux discovery retains completed and stopped inactive snapshots across refreshes and persisted known ownership until `acknowledgeInactive`. Completed snapshots publish the stable existing `terminal-exit:<runStartedAtMs>` event once before acknowledgement; stopped snapshots publish no completion event and are cleared only after an attention evaluation removes ownership.
- Matching locator-collision diagnostics are converted to stable defensive `conflict` snapshots for host lookup and projection. Archive and resume dispatch are blocked, with zero destructive action.
- Initial and subsequent visible dashboard transitions await forced runtime refresh before the single render. Hidden transitions do not render or force refresh; refresh rejection renders the error boundary instead of stale content, and message rejection is contained.
- Marker proof now requires an existing regular file and a finite positive `runStartedAtMs` whose value is no newer than marker mtime. Missing, zero, `NaN`, and stale markers fail closed.
- Detached tmux viewer titles come from the host project/session display data. Project-layout focus updates the attach binding to the selected managed window so the attach terminal projects the correct focused row.
- Focus, detach, create, resume, archive-focus, and pending-timeout focus rejections are contained at controller boundaries. Users receive fixed generic messages, stale runtime state is refreshed, and host diagnostics contain only redacted operation/category/backend metadata. No plain or post-dispatch failure enters fallback.

### Follow-up RED/GREEN Evidence

- RED: the second forced tmux refresh changed a completed inactive snapshot to `stopped`; GREEN: completed/stopped remain stable through consecutive refreshes and disappear only after explicit acknowledgement.
- RED: attention evaluation returned `undefined`, so release could not be gated on publication; GREEN: lifecycle behavior proves `publish → event lookup → bridge ack → local ack → release`, and rejected publication performs zero release.
- RED: collision composition lacked `findTmuxCollisionRuntime`; GREEN: matching diagnostics yield defensive conflict snapshots and block resume/archive.
- RED: first view ordering was `render → visible hook`; GREEN: initial and later ordering is `visible refresh → render`, with hidden/rejection behavior covered.
- RED: runtime focus rejection escaped as `raw focus timeout`; GREEN: focus/detach/create/resume/pending-timeout failures produce only fixed user copy, refresh, and redacted callbacks.

### Follow-up Verification

The complete required matrix exited 0 after the review fixes:

```text
npm run test-compile && node scripts/run-ai-session-tmux-checks.js && npm run test:safety && npm run test:dashboard && npm run test:architecture-baseline && npm run test:tmux && npm run test:tmux && npm run lint && git diff --check
```

An additional fresh `npm run test:tmux && npm run lint && git diff --check` also exited 0. Lint reports only the repository's existing warnings. No real tmux command was invoked.

## Round-2 Lifecycle Persistence and Race Hardening

- Attention settlement now evaluates one structured batch per round. In-scope completed runtimes are retained until publication produces an event and both bridge/local acknowledgement succeed; disabled, out-of-scope, and stopped runtimes release safely. Evaluation, acknowledgement, and release rejection paths retain ownership and emit only fixed redacted diagnostics.
- Completed/stopped tmux lifecycle state is persisted in the canonical final-runtime slot with full identity, locator, marker, start, and detection data. Legacy known records without a discriminator remain readable; inactive records survive restart, are excluded from known hints, share deterministic 512-record/30-day pruning, and are removed only after durable acknowledgement.
- Known-to-inactive persistence uses a serialized last-seen compare-and-swap transition, so a stale disappearance cannot overwrite a concurrently refreshed known runtime. Cache generations prevent a stale refresh from resurrecting acknowledged inactive state.
- Resume, create, promote, focus, detach, and archive paths force-refresh collision state before mutation. Backend-internal guards protect the final lock boundary, typed collision errors stay distinct from tmux-unavailable fallback, and ordinary conflict-shaped errors fail closed.
- Visible dashboard failures log and render only a fixed sentinel. Raw exceptions and local paths are unavailable to both host diagnostics and generated error HTML.

### Round-2 RED/GREEN Evidence

- RED: backend `ensureResume` reached runtime persistence after forced refresh exposed a locator collision; GREEN: the internal collision guard raises a defensive typed conflict before any tmux mutation or provider dispatch.
- RED: stale known-to-inactive conversion had no atomic version check; GREEN: a last-seen CAS rejects the stale transition and preserves the newer known record.
- RED: a legacy final record without `state` was ignored; GREEN: it is normalized to `known` while completed/stopped records retain their explicit discriminator.
- GREEN boundary tests cover bridge/local/release rejection retention, typed collision non-fallback, plain named collision fail-closed behavior, restart recovery, acknowledgement persistence failure, cap/TTL priority, and stale refresh generations.

### Round-2 Final Verification

The final required command exited 0:

```text
npm run test-compile && node scripts/run-ai-session-tmux-checks.js && npm run test:safety && npm run test:dashboard && npm run test:architecture-baseline && npm run test:tmux && npm run test:tmux && npm run lint && git diff --check
```

Lint emitted only the repository's existing warnings. The checks use fake tmux clients; no real tmux process was invoked.

## Round-3 Direct Isolation and Cross-Host Serialization

- Default Direct mode now uses a layered host refresh. A structured tmux-unavailable result is contained only when no cached or persisted live tmux known/pending/conflict ownership exists; ordinary errors and any unverifiable live ownership still fail closed. Persisted inactive records are deliberately not live blockers.
- Focus and detach first inspect the cached identity. A unique Direct runtime refreshes and re-resolves only the Direct backend, while tmux, unknown, duplicate, and conflict identities use the guarded host/full refresh. Single-session archive passes the provider/session identity into the same guard; batch archive uses the ownership-aware host guard.
- Persisted inactive records load independently from tmux availability during activation and attention evaluation. This permits restart recovery, publication, acknowledgement, and settlement while tmux itself is absent, without turning inactive records into duplicate-prevention hints.
- The host injects a fixed cross-instance final-record lock backed by `withTmuxCreationLock`. All known/inactive writes, compare-and-swap transitions, acknowledgements, TTL deletion, cap pruning, removal, and reconciliation acquire the instance queue and then the global file lock, re-read under that lock, and mutate without recursively acquiring it.
- Dashboard fire-and-forget attention evaluation, publication/acknowledgement settlement, and lifecycle drain entry points use one safe task boundary. Rejections are contained and reported with fixed operation/category fields; behavior tests observe no `unhandledRejection`.
- Pending promotion now inspects both forced-refresh outcomes before resolving or mutating a pending runtime. Any backend refresh rejection fails closed; refreshed collisions return conflict snapshots without promotion.

### Round-3 Race and Boundary Evidence

- RED: cached Direct focus failed when an unavailable tmux backend was refreshed; GREEN: Direct focus/detach refresh only Direct and perform the requested action.
- RED: host-visible Direct refresh propagated structured tmux unavailability without considering ownership; GREEN: Direct/no-live continues, while persisted known/pending ownership and plain failures remain blocking.
- Cross-instance tests use two independent stores sharing the real file lock and cover transition/reconcile in both orders, a held acknowledgement followed by rewrite, and pruning concurrent with a refreshed known record. Newer known ownership is neither overwritten nor deleted.
- A restart test restores completed inactive state through `loadPersistedInactive()` with a client that would throw if probed; the probe count remains zero.
- A rejected fire-and-forget attention task is observed with a process-level `unhandledRejection` listener; the listener receives no event and diagnostics contain only fixed fields.

### Round-3 Final Verification

The final required matrix exited 0:

```text
npm run test-compile && node scripts/run-ai-session-tmux-checks.js && npm run test:safety && npm run test:dashboard && npm run test:architecture-baseline && npm run test:tmux && npm run test:tmux && npm run lint && git diff --check
```

Lint emitted only the repository's existing warnings. Tmux checks use fake clients and controlled file locks; no real tmux process was invoked.
