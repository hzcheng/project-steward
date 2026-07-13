# Codex Subagent Session Filter Design

**Date:** 2026-07-13

## Goal

Keep internally spawned Codex subagent sessions out of Project Steward's AI session results while preserving normal parent sessions and avoiding destructive changes to provider data.

## Observed Provider Storage

The provider implementations and local storage samples use different layouts:

- Codex stores normal sessions and subagent sessions as UUID-named JSONL files under the same recursive `sessions/` tree. A subagent's first `session_meta` event has an object-valued `payload.source` containing a `subagent` property, as well as related fields such as `parent_thread_id`.
- Kimi stores subagents below a normal UUID session directory in `subagents/`. `KimiSessionService` reads only immediate UUID session directories beneath each work-directory hash, so nested subagents are already outside its scan boundary.
- Claude stores subagents below a normal session in `<session-id>/subagents/agent-*.jsonl`. `ClaudeSessionService` reads only immediate UUID JSONL files in each project directory, so nested subagents are already outside its scan boundary.

The incorrect Dashboard rows therefore originate in `CodexSessionService`: its recursive file discovery treats every UUID JSONL as a top-level session and currently discards the `source` classification when reading metadata.

## Filtering Rule

Only a Codex session whose first `session_meta` event explicitly contains `payload.source.subagent` is filtered.

The filter does not infer subagent status from `parent_thread_id` alone. Older or future derived-thread formats that carry a parent ID without the explicit subagent source remain visible, preventing broad classification from hiding unrelated session types.

Filtering is non-destructive:

- no session file is deleted, moved, or archived;
- no pin or alias metadata is deleted;
- no new setting or persisted filter state is introduced.

## Architecture and Data Flow

`CodexSessionService` remains the single filtering boundary.

1. Extend its internal session metadata representation with a subagent classification derived from the first `session_meta` payload.
2. When processing `session_index.jsonl`, skip a session before creating its `CodexSession` result if the corresponding file metadata explicitly marks it as a subagent.
3. When adding sessions discovered only from JSONL files, apply the same check before inserting them into the result map.
4. Keep the existing parsing and error tolerance for missing, malformed, or non-`session_meta` first lines.

Because subagents never enter the provider's `CodexSession[]` result, all downstream consumers behave consistently without additional filters:

- project assignment and Dashboard rendering exclude them;
- pin, alias, archive, and batch-management scopes cannot select them;
- terminal reverse resolution does not use them as candidates;
- active-terminal highlighting cannot target a hidden subagent row.

Kimi and Claude require no production changes. Their existing non-recursive/top-level scan boundaries remain authoritative.

## Cache and Watcher Behavior

The existing Codex file fingerprint may still observe subagent JSONL creation or updates and invalidate the provider cache. This design deliberately leaves watcher behavior unchanged: the requested behavior is result filtering, and changing fingerprint semantics would add complexity and could delay discovery of a parent session created alongside subagent activity.

After a refresh, the recomputed result excludes subagents. The short-lived extra refresh is preferable to weakening session discovery correctness.

## Error Handling

- A missing session file or unreadable first line follows the existing behavior and is not classified as a subagent.
- Malformed JSON remains isolated to that file; it does not make the provider unavailable.
- A `source` value of another type or an object without a `subagent` property is treated as a normal session.
- A session carrying only `parent_thread_id` remains visible by design.

## Testing

Executable safety coverage uses temporary provider homes and real file layouts.

### Codex

Create fixtures for:

- a normal indexed session;
- an indexed session with explicit `payload.source.subagent`;
- a file-only subagent absent from `session_index.jsonl`;
- a file-only normal session;
- a session with `parent_thread_id` but no explicit subagent source;
- malformed or missing metadata following existing fallback behavior.

Assert that both the index path and file-discovery fallback exclude only the explicitly marked subagents.

### Kimi and Claude

Add nested subagent decoys using their real directory shapes and assert that the existing readers continue to return only top-level UUID sessions. These are regression guards; no provider production logic changes.

### Integration

Run the existing AI-session safety suite, lint, webpack build, generated-asset parity checks, and diff hygiene. Confirm the filtered Codex result cannot appear in project assignment or terminal-resolution candidates, while normal parent sessions remain unchanged.

## Acceptance Criteria

- Explicitly marked Codex subagent sessions do not appear in the Dashboard after refresh.
- Normal Codex parent sessions continue to appear.
- Sessions with only `parent_thread_id` remain visible.
- No provider session file, pin, or alias is deleted by filtering.
- Kimi and Claude top-level session results remain unchanged and nested subagent data remains excluded.
- Existing resume, archive, batch management, project assignment, and active-terminal highlighting behavior remains intact for visible sessions.
- No runtime dependency, setting, migration, staging, or commit is introduced as part of design documentation.
