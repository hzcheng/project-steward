# AI Session Explicit Lifecycle Attention Design

Date: 2026-07-15
Status: Approved

The terminal-process exit fallback in this historical design is superseded by
`2026-07-24-attention-runtime-decoupling-design.md`. Provider lifecycle events
are now the only source of new attention.

## Decision

Project Steward will stop inferring that an AI session needs attention from a
period of file inactivity. The attention monitor will consume only explicit
provider lifecycle events plus the existing terminal-process exit marker.

The provider transcript remains the source of truth for this first
implementation. Project Steward will not install provider hooks, parse terminal
screen text, or modify Codex, Kimi, or Claude configuration.

This document supersedes the **Provider Activity Signal**, **Local Attention
State Machine**, and quiet-timing portions of
`2026-07-14-ai-session-attention-local-bridge-design.md`. The local UI bridge,
lease, acknowledgement, aggregation, and rendering architecture remain
unchanged.

## Goals

- Never alert merely because model output has been quiet for a fixed duration.
- Alert when an owned provider turn explicitly completes.
- Alert when the provider explicitly records abort, failure, approval, or
  question/input-required state.
- Suppress unread attention when the owning terminal is already visible in the
  focused window; do not replay that event when the user later leaves.
- Remove an unread event when a later explicit running event proves that the
  session resumed.
- Monitor only sessions created or resumed by Project Steward, including
  recovered uniquely matched Project Steward terminals.
- Keep provider parsing bounded and independent of transcript content.

## Non-goals

- Guessing approval or input state from natural-language output.
- Treating filesystem inactivity, `updatedAt`, or transcript `mtime` as a
  completion signal.
- Installing or configuring provider hooks.
- Monitoring sessions opened outside Project Steward.
- Guaranteeing an event that the provider does not persist explicitly.

## Normalized Lifecycle Model

Each provider service exposes one bulk method:

```ts
interface AiSessionLifecycleRequest {
    sessionId: string;
    runStartedAtMs: number;
}

interface AiSessionLifecycleSignal {
    token: string;
    phase: 'running' | 'needsAttention';
    reason?: 'completed' | 'aborted' | 'failed' | 'input-required';
    occurredAtMs: number;
}

getLifecycleSignals(
    requests: readonly AiSessionLifecycleRequest[]
): Record<string, AiSessionLifecycleSignal>;
```

`token` is opaque, stable for the same persisted event, and never leaves the
Workspace Extension. The bridge continues to receive only generated attention
event IDs and privacy-safe project/session identifiers.

The reader returns the newest recognized signal whose timestamp is at or after
`runStartedAtMs`. Older terminal events are ignored, preventing a resumed
session's previous completion from being reported as new attention.

## Provider Mapping

### Codex

- `event_msg/task_started` -> `running`
- `event_msg/task_complete` -> `needsAttention/completed`
- `event_msg/turn_aborted` -> `needsAttention/aborted`
- `response_item/custom_tool_call` named `request_user_input` ->
  `needsAttention/input-required`
- a later matching tool output or a new `task_started` -> `running`

Codex approval prompts without a persisted explicit lifecycle record are not
guessed in this version.

### Kimi

- `TurnBegin`, `StepBegin`, and continued execution events -> `running`
- `TurnEnd` -> `needsAttention/completed`
- `StepInterrupted` -> `needsAttention/aborted`
- `ApprovalRequest` and `QuestionRequest` ->
  `needsAttention/input-required`
- `ApprovalResponse` or subsequent execution -> `running`

Generic Kimi notifications are not used as failure signals because they may
describe background work rather than the owning turn.

### Claude

- user submission or an assistant record still executing tools -> `running`
- assistant `stop_reason` of `end_turn` or `stop_sequence` ->
  `needsAttention/completed`
- an `AskUserQuestion` tool-use block -> `needsAttention/input-required`
- `system/api_error` -> `needsAttention/failed`

Claude user interrupts are not reported unless a future persisted event proves
the interruption explicitly.

## Bounded Transcript Reading

Each service locates only requested session files and reads at most the final
512 KiB. If reading begins in the middle of a JSONL record, the first partial
line is discarded. Malformed and unknown records are skipped independently.

The lifecycle poll remains on the existing independent 10-second attention
interval. Provider file watchers may request earlier UI refreshes, but they are
not required for correctness. File silence no longer has any meaning.

## Run Boundary

Tracked terminal entries store `runStartedAtMs`:

- new sessions inherit the pending terminal's `createdAt`;
- resumed sessions capture the time immediately before the resume command;
- terminals recovered after activation use their recovery time and therefore
  report only subsequent lifecycle events;
- terminal exit uses a stable token containing the tracked run start.

This boundary favors avoiding false positives. A completion already present
before terminal recovery is not replayed.

## Attention State Machine

```text
pending --running signal----------------------> running
pending/running/acknowledged --attention------> needsAttention
needsAttention/acknowledged --new running-----> running
needsAttention --owner terminal becomes seen--> acknowledged
any state --terminal/session no longer owned--> removed
```

When an attention signal is observed while the owning VS Code window is focused
and the owning terminal is active, the event is created directly as
`acknowledged`. It is never converted back to unread simply because focus later
moves elsewhere.

Repeated polling of the same signal token is idempotent. A new attention token
increments the generation and produces a new event ID. The existing exact-event
acknowledgement and bridge tombstone behavior remains unchanged.

The terminal completion marker is converted into an explicit `completed`
signal and remains a fallback for CLI exit, crashes handled by the wrapper, and
providers that fail to persist a final turn event.

## Compatibility

Attention payload reason validation expands from `quiet | completed` to:

```text
completed | aborted | failed | input-required
```

Protocol version 1 is retained because both shipped extensions are developed
and released together and the product has not reached a compatibility-stable
release. `quiet` is rejected after this change so stale implementations fail
closed instead of reintroducing false positives.

## Verification

Automated checks must prove:

- each provider maps representative JSONL records to the normalized signals;
- historical terminal events before `runStartedAtMs` are ignored;
- long-running output with no terminal lifecycle event never raises attention;
- completion, abort, failure, and input-required events raise attention;
- focused-owner events are acknowledged immediately and never replayed;
- a newer running signal clears an older attention event;
- repeated tokens do not generate duplicate event IDs;
- payload and aggregate validators reject `quiet` and accept all new reasons;
- TypeScript compilation, safety checks, bridge compilation, webpack, lint, and
  diff checks pass.
