# AI Session Lifecycle Recovery Design

## Problem

Active-session execution state is currently reconstructed by parsing only the final 512 KiB of each provider's JSONL log. A long-running turn can emit enough output to push its `task_started` or equivalent event outside that window. If the Extension Host then reloads, the in-memory execution monitor starts from `stopped`, the bounded tail contains no lifecycle signal, and an active turn is rendered as stopped.

The same fixed-window reader is used by Codex, Kimi, and Claude, so the recovery gap applies to all three providers.

## Goals

- Recover the latest lifecycle signal after Extension Host reload even when the relevant start event is more than 512 KiB behind the end of the log.
- Apply the fix consistently to Codex, Kimi, and Claude.
- Keep steady-state work proportional to newly appended log data rather than total file size.
- Keep memory bounded while reading large JSONL files.
- Preserve current lifecycle semantics, including event-time ordering and Codex input-request matching.

## Non-goals

- Changing the user-visible execution states or card styling.
- Persisting execution state independently of provider logs.
- Reworking provider session discovery, terminal ownership, or attention aggregation.
- Adding a configurable lifecycle scan size.

## Chosen Approach

Add a shared incremental JSONL lifecycle reader. Each provider service owns a reader cache for its active session logs.

On the first request for a file and terminal run:

1. Open the JSONL file and read it forward in bounded chunks.
2. Split complete lines without retaining the full file.
3. Feed parsed events into a provider-specific lifecycle accumulator.
4. Ignore events earlier than `runStartedAtMs` while retaining the newest signal by event timestamp.
5. Cache the byte offset, unfinished trailing line, parser state, and latest signal.

On later requests, the reader processes only bytes appended after the cached offset and returns the cached latest signal when no new lifecycle event exists.

The reader resets and performs a cold scan when the terminal run start changes, the file is truncated, or its filesystem identity changes. Malformed JSON lines remain ignored. A temporary read failure returns no new signal without inventing a stopped transition.

## Components

### Incremental JSONL reader

A focused module under `src/aiSessions/` will own file offsets, bounded chunk reads, partial-line handling, file identity checks, and cursor reset behavior. It will not know provider event schemas.

Its public API will accept a cache key, file path, `runStartedAtMs`, and a provider accumulator factory, and return the latest `AiSessionLifecycleSignal` when available. The cache will retain only keys supplied by the current provider request set so inactive sessions do not accumulate indefinitely.

### Stateful lifecycle accumulators

`src/aiSessions/lifecycle.ts` will expose accumulator factories for Codex, Kimi, and Claude. Each accumulator consumes complete JSONL lines or decoded records and tracks the latest signal using `occurredAtMs`, preserving the existing rule that event timestamps win over physical line order.

The Codex accumulator will retain pending `request_user_input` call IDs across chunks and incremental reads. This ensures a later `custom_tool_call_output` restores `running` even when the request and output are separated by a chunk boundary.

Existing `parseCodexLifecycleLines`, `parseKimiLifecycleLines`, and `parseClaudeLifecycleLines` functions will delegate to the same accumulators so existing callers and tests retain their API and semantics.

### Provider integration

Codex, Kimi, and Claude session services will replace direct `readJsonlTailLines(...)` lifecycle parsing with the shared incremental reader. Session discovery and provider-specific file lookup remain unchanged.

Each service will prune reader cursors that are not present in its current lifecycle request list. Archiving or losing a session file will also discard its cursor.

## Error and Reset Semantics

- Invalid JSON lines are skipped and scanning continues.
- A final incomplete JSON line is buffered until the next append.
- File truncation or replacement discards the old cursor and parser state before rescanning.
- A different `runStartedAtMs` for the same session starts a new parser state so prior terminal runs cannot leak execution state.
- Read/stat failures do not manufacture a `stopped` signal; the caller keeps its last monitor state when possible.

## Testing

Automated safety checks will cover:

- A lifecycle start event followed by more than 512 KiB of unrelated output is recovered after a cold reader start.
- A completion appended after the cold scan updates the cached state to stopped without rescanning prior bytes.
- Codex input request and matching output work across chunk boundaries.
- Kimi and Claude recover long-running lifecycle starts through the shared reader.
- Partial final lines are completed on a later append.
- Truncation and a changed `runStartedAtMs` reset cached state.
- Malformed lines do not prevent later valid lifecycle events from being processed.
- Existing event-time ordering and provider lifecycle tests continue to pass.

The full AI-session and Open Project safety suites, TypeScript compilation, lint, and relevant packaging checks will be run before completion.

## Alternatives Rejected

### Persist execution state

Persisted state can become stale when provider activity occurs while the Extension Host is unavailable. Provider logs remain the source of truth, so recovery should be fixed at the log-reading boundary.

### Increase the fixed tail size

Any fixed limit can be exceeded by a sufficiently long turn. It delays recurrence without removing the blind spot and increases repeated read cost.
