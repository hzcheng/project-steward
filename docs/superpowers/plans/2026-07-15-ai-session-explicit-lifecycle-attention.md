# AI Session Explicit Lifecycle Attention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace quiet-time attention guesses with explicit Codex, Kimi, and Claude lifecycle signals for Project Steward-owned terminal runs.

**Architecture:** Provider services read a bounded JSONL tail and normalize the newest event inside the tracked terminal run into a shared lifecycle signal. The attention monitor becomes a token-driven state machine, while the existing UI bridge and rendering paths carry the expanded explicit reason set.

**Tech Stack:** TypeScript 4, Node.js filesystem APIs, VS Code Extension API, JSONL provider transcripts, Node `assert` safety checks.

## Global Constraints

- Preserve `.vscode/settings.json`, `docs/assets/`, and `docs/running-projects-tabs-prd.md`; never stage them.
- Do not infer attention from quiet time, `updatedAt`, transcript `mtime`, or natural-language content.
- Read at most the last 512 KiB of a requested provider transcript.
- Monitor only sessions owned by a Project Steward terminal.
- Use reasons `completed`, `aborted`, `failed`, and `input-required`; reject `quiet`.
- Keep the existing 10-second independent attention evaluation interval.
- Keep bridge protocol version 1 and exact-event acknowledgements.

---

### Task 1: Normalized lifecycle parsers and bounded JSONL reader

**Files:**
- Create: `src/aiSessions/lifecycle.ts`
- Create: `src/aiSessions/jsonlTail.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces: `AiSessionAttentionReason`, `AiSessionLifecycleRequest`, `AiSessionLifecycleSignal`, and three provider parser functions.
- Produces: `readJsonlTailLines(filePath, maxBytes)`.

- [ ] **Step 1: Write the failing parser tests.** Add Codex fixtures for `task_started`, `task_complete`, `turn_aborted`, and `request_user_input`; Kimi fixtures for `TurnBegin`, `TurnEnd`, `StepInterrupted`, `ApprovalRequest`, and `QuestionRequest`; Claude fixtures for `end_turn`, `stop_sequence`, `AskUserQuestion`, and `system/api_error`. Assert malformed, unknown, and pre-run records return no signal.
- [ ] **Step 2: Run `npm run test:safety`.** Expected: RED because the lifecycle exports do not exist.
- [ ] **Step 3: Implement these exact public types:**

```ts
export type AiSessionAttentionReason = 'completed' | 'aborted' | 'failed' | 'input-required';
export interface AiSessionLifecycleRequest { sessionId: string; runStartedAtMs: number; }
export interface AiSessionLifecycleSignal {
    token: string;
    phase: 'running' | 'needsAttention';
    reason?: AiSessionAttentionReason;
    occurredAtMs: number;
}
```

Each parser walks lines in order, skips malformed records, filters timestamps before `runStartedAtMs`, and returns the last recognized signal. Tokens contain only event type, timestamp, and provider event/call identifiers.
- [ ] **Step 4: Implement bounded tail reads.** Seek to `max(0, size - maxBytes)`, read only that region, discard the first partial record when the offset is nonzero, and return complete UTF-8 lines. Missing, unreadable, and empty files return `[]`.
- [ ] **Step 5: Run `npm run test:safety`.** Expected: parser and tail-reader tests pass.

### Task 2: Provider lifecycle service integration

**Files:**
- Modify: `src/aiSessions/types.ts`
- Modify: `src/services/codexSessionService.ts`
- Modify: `src/services/kimiSessionService.ts`
- Modify: `src/services/claudeSessionService.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: Task 1 parsers and bounded reader.
- Produces: `AiSessionService.getLifecycleSignals(requests)`.

- [ ] **Step 1: Write failing service fixture tests.** Extend each temporary provider home with one lifecycle file, request one known ID and one missing ID, and assert only the known ID returns. Append a newer running event and assert it replaces completion. Put an old completion before `runStartedAtMs` and assert it is ignored.
- [ ] **Step 2: Run `npm run test:safety`.** Expected: RED because provider services lack `getLifecycleSignals`.
- [ ] **Step 3: Add this exact service contract:**

```ts
getLifecycleSignals(
    requests: readonly AiSessionLifecycleRequest[]
): Record<string, AiSessionLifecycleSignal>;
```

- [ ] **Step 4: Implement bulk provider reads.** Codex resolves IDs with `getSessionFiles()`. Claude uses only top-level session files. Kimi reads only the owning session's top-level `wire.jsonl`. Deduplicate IDs and reject empty IDs or non-finite run times.
- [ ] **Step 5: Run `npm run test:safety`.** Expected: all provider lifecycle fixtures pass.

### Task 3: Explicit-event attention monitor and reason protocol

**Files:**
- Modify: `src/aiSessions/attentionMonitor.ts`
- Modify: `src/aiSessions/attentionPayload.ts`
- Modify: `src/aiSessions/attentionAggregate.ts`
- Modify: `src/models.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: `AiSessionLifecycleSignal`.
- Produces: idempotent attention generations without timers or activity tokens.

- [ ] **Step 1: Replace quiet tests with failing lifecycle-transition tests.** Prove running never alerts, all four attention reasons alert, the same token never duplicates, focused-owner attention is immediately acknowledged, returning focus acknowledges an existing exact event, a newer running token removes attention, and a later attention token increments generation.
- [ ] **Step 2: Add failing payload tests.** Accept all four explicit reasons, allow four aggregate reasons, and reject `quiet`.
- [ ] **Step 3: Run `npm run test:safety`.** Expected: RED because the monitor still uses `activityToken`, `completed`, and `quietThresholdMs`.
- [ ] **Step 4: Implement the token-driven monitor.** Store `lastSignalToken` and `generation`. A new running token sets `running` and removes the old event. A new attention token creates one event. The same token is a no-op except that current owner visibility acknowledges an unread exact event.
- [ ] **Step 5: Reuse the lifecycle reason union in model, payload, and aggregate types.** Remove every production fallback to `quiet`.
- [ ] **Step 6: Run `npm run test:safety`.** Expected: explicit monitor and protocol checks pass.

### Task 4: Terminal run boundaries and dashboard integration

**Files:**
- Modify: `src/aiSessions/types.ts`
- Modify: `src/aiSessions/terminalService.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces: `AiSessionTerminalEntry.runStartedAtMs` for every owned run.
- Consumes: provider bulk lifecycle signals and passes them to the monitor.

- [ ] **Step 1: Write failing boundary tests.** Assert pending resolution preserves `Date.parse(createdAt)`, resume tracking replaces the old run start, and an automatically recovered terminal receives a finite recovery timestamp.
- [ ] **Step 2: Write failing dashboard source tests.** Assert evaluation calls `getLifecycleSignals()` once per provider with owned sessions, contains no `activityToken`, and converts a completion marker to a stable `terminal-exit:<runStartedAtMs>` completed signal.
- [ ] **Step 3: Run `npm run test:safety`.** Expected: RED because terminal entries lack the boundary and dashboard still supplies quiet inputs.
- [ ] **Step 4: Implement run tracking.** Pending sessions use their creation time; resume captures `Date.now()` immediately before tracking; recovered terminals default to `Date.now()`.
- [ ] **Step 5: Implement bulk evaluation.** Collect owned sessions, group lifecycle requests by provider, call each service once, prefer the stable terminal-exit signal when its marker exists, and preserve current owner visibility, bridge publication, acknowledgement, and incremental refresh behavior.
- [ ] **Step 6: Run `npm run test:safety`.** Expected: all integration safety checks pass.

### Task 5: Documentation, build, review, and delivery

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-ai-session-attention-local-bridge-design.md`
- Modify: `package.json` only if user-visible setting copy requires it.

**Interfaces:**
- Produces: consistent documentation and verified bundles.

- [ ] **Step 1: Mark the old quiet/activity sections as superseded.** Do not rewrite unaffected bridge architecture.
- [ ] **Step 2: Run full verification:** `npm run test:safety`, `npm run webpack`, `npm run attention:bridge:compile`, `npm run attention:bridge:bundle`, `npm run lint`, and `git diff --check`. Expected: every command exits 0.
- [ ] **Step 3: Review the diff.** Confirm no quiet inference remains, no provider content crosses the bridge, provider reads are bounded, repeated tokens are idempotent, focused events never replay, and unrelated working files are untouched.
- [ ] **Step 4: Stage only scoped files, commit as `fix: use explicit AI session lifecycle attention`, and push `feat/ai-session-attention-monitor`.
