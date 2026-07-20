# Tmux Initial Execution State Handoff Design

Date: 2026-07-19

Status: Approved in design discussion; awaiting written-spec review

## Summary

Project Steward will make execution-state reporting consistent between Direct Terminal and tmux runtimes. A newly created tmux runtime must report the provider's first turn as `Running` as soon as its pending identity is promoted to a provider session identity, and it must later report `Stopped` from the same provider lifecycle evidence used by Direct Terminal mode.

The repair will preserve the provider-native meaning of execution state. A live tmux session or pane proves that the runtime is available, but it does not prove that the AI is currently executing. Tmux liveness therefore remains separate from the green execution indicator.

## Problem

New tmux sessions begin with a Project Steward pending identity. After the provider creates its durable session ID, project hydration resolves the new provider session and asynchronously promotes the tmux runtime from the pending identity to the final identity.

The current promotion bookkeeping can retire an in-flight settlement when a concurrent hydration observes that the backend has already consumed the pending runtime. The promotion itself may have succeeded, but the hydration generation that initiated it then reports `stale-pending` and skips its successful handoff work. The dashboard also has no explicit execution-monitor notification at the promotion boundary and relies on later polling to observe the final runtime.

The observed result is asymmetric:

- a new Codex or Kimi tmux session can miss the first provider `running` lifecycle signal;
- a later turn on the same promoted session can report `Running` and `Stopped` correctly;
- tmux runtime discovery, attachment, and persistence continue to work;
- existing tests pass because tmux promotion and execution monitoring are tested separately rather than through the complete handoff.

## Goals

1. Preserve an in-flight pending-to-final promotion until its own result is settled.
2. Treat a successful final runtime returned by the backend as authoritative even when the pending runtime has already disappeared from discovery.
3. Trigger execution evaluation immediately after a successful promotion handoff.
4. Preserve `runStartedAtMs` so a lifecycle event emitted before promotion completion remains eligible for the first cold read.
5. Provide equivalent first-turn and subsequent-turn behavior for Codex, Kimi, and Claude.
6. Cover both `project` and `session` tmux layouts.
7. Preserve existing Direct Terminal behavior.

## Non-Goals

- Changing the execution indicator's visual design or wording.
- Treating a live tmux pane, shell, session, or window as proof that the AI is executing.
- Changing provider lifecycle parsers or inventing provider-specific tmux state.
- Changing tmux naming, attachment, detach, persistence, or fallback behavior.
- Increasing the normal one-second execution polling frequency.
- Refactoring unrelated hydration, attention, or runtime code.

## Considered Approaches

### Event-driven promotion handoff

Repair the promotion settlement race and publish an explicit successful-promotion callback to dashboard composition. The dashboard immediately evaluates execution state against the now-final runtime, while the existing polling loop handles subsequent lifecycle events.

This is the selected approach because it repairs the demonstrated ownership boundary and makes the first evaluation deterministic without changing the meaning of `Running`.

### Stronger polling

Poll tmux discovery or provider lifecycle files more frequently. This may reduce visible delay, but it does not make an incorrectly retired promotion settlement successful and adds background work. It is rejected.

### Tmux process-state inference

Display `Running` while the tmux pane or provider process exists. This incorrectly marks an idle interactive provider as executing while it waits for user input. It is rejected.

## Architecture

The existing runtime architecture remains intact:

```text
provider session discovery
          │
          ▼
pending-session resolver
          │
          ▼
AiSessionRuntimeCoordinator.promotePending
          │
          ▼
TmuxRuntimeBackend promotion and discovery
          │
          ▼
successful promotion handoff
          │
          ├── synchronize active/focused runtime projection
          └── evaluate provider execution lifecycle immediately
```

The repair adds a narrow notification at the successful handoff boundary. It does not move provider lifecycle parsing into the tmux backend and does not make hydration own execution state.

## Promotion Settlement Rules

`AiSessionProjectHydrationController` will keep one memoized settlement for each pending-identity/final-session pair.

1. Starting `promotePending` records the settlement as in flight.
2. A concurrent hydration may observe that the pending runtime is absent because the same backend promotion consumed it.
3. Absence alone must not retire a settlement whose promotion promise is still in flight.
4. The backend result is validated against the expected provider and final session ID.
5. A valid final runtime changes the settlement to success.
6. A rejected promise, invalid runtime result, conflicting identity, or explicit promotion failure retires the settlement.
7. A successful settlement is consumed once for alias synchronization, active-runtime synchronization, and the promotion notification.
8. Old successful or failed settlements must not be reused for a different pending identity or final session ID.

Existing bounded pending-runtime and backend lifecycle records remain responsible for crash recovery and cleanup. This repair must not introduce an unbounded timer or durable duplicate settlement store.

## Execution-State Handoff

After a successful promotion is consumed, dashboard composition will immediately invoke `AiSessionExecutionController.evaluate()`.

The controller will receive the final runtime from `AiSessionRuntimeCoordinator.getActive()` with:

- provider ID;
- final provider session ID;
- original runtime start time;
- runtime state other than `conflict`.

The provider service then performs its existing cold or incremental lifecycle read:

- Codex: `task_started` reports `Running`; task completion, abort, or input request reports `Stopped`.
- Kimi: `TurnBegin` and other running events report `Running`; `TurnEnd`, interruption, approval, or question requests report `Stopped`.
- Claude: user/assistant lifecycle events retain their existing running and stopped semantics.

If the first running event was written before promotion completed, it remains eligible because the promoted runtime retains the pending runtime's `runStartedAtMs`. The monitor schedules an incremental dashboard refresh only when its execution snapshot changes.

The normal one-second evaluation interval remains as resilience for later provider events. The explicit handoff evaluation removes reliance on timing between promotion, provider file writes, and the next interval tick.

## Data and Error Handling

- Promotion callbacks carry cloned runtime identities or immutable promotion identities; callers must not mutate backend snapshots.
- A callback failure must be logged through the existing AI session diagnostic path and must not roll back a completed tmux promotion.
- Execution evaluation continues to tolerate a lifecycle file that is not yet present. The next normal interval retries through the existing provider service behavior.
- Conflicting runtimes remain excluded from execution monitoring.
- A stale discovery snapshot remains marked stale and must not be converted into synthetic `Running` state.
- No prompt, response content, executable path, tmux command, or provider log content is added to diagnostics.

## Testing Strategy

### Regression test for the race

Add a hydration-controller test where:

1. a tmux pending runtime is visible;
2. provider discovery resolves the final session ID;
3. `promotePending` returns a controlled promise;
4. a concurrent hydration observes that the pending runtime has already disappeared;
5. the promotion promise resolves with the expected final runtime;
6. the settlement succeeds exactly once and invokes the promotion notification.

The test must fail against the current early-retirement behavior before production code changes.

### Execution handoff test

Add a dashboard-composition or focused controller test proving that a successful tmux promotion immediately invokes execution evaluation and projects `executionState: 'running'` for the final session. The test must use provider lifecycle evidence rather than tmux liveness.

### Provider and layout matrix

Pure tests will cover:

- Codex, Kimi, and Claude first running signals;
- transition from `Running` to `Stopped`;
- `project` and `session` layout runtime snapshots;
- a subsequent turn or resumed runtime;
- no behavior change for Direct Terminal runtimes;
- no duplicate notification from concurrent hydration generations.

Existing `test:tmux`, `test:safety`, compile, packaging, and real tmux smoke checks will run after the focused regression tests pass.

## Acceptance Criteria

1. A newly created tmux session displays the green `Running` indicator during its first provider turn.
2. The indicator changes to `Stopped` when the provider lifecycle reports completion, interruption, failure, or input required according to existing semantics.
3. A later turn and a resumed session continue to transition between `Running` and `Stopped`.
4. The behavior is equivalent for Codex, Kimi, and Claude in both tmux layouts.
5. An idle but live tmux session is not displayed as `Running`.
6. Concurrent hydration does not turn a successful promotion into `stale-pending` merely because that promotion consumed its pending runtime.
7. Promotion and execution notifications occur at most once per pending/final identity pair.
8. Direct Terminal execution-state behavior remains unchanged.
9. Relevant automated, smoke, and packaging checks pass.
