# Tmux Thread Switch Alias Continuity Design

## Context

Project Steward stores a user-defined AI Session name under the stable-looking
key `provider:<session-id>`. A managed Codex tmux window can later switch its
root thread while the same runtime continues. Runtime discovery already commits
that transition by rebinding the durable tmux record from the old Session ID to
the newly observed Session ID.

The runtime rebind currently updates only runtime identity. The alias remains
under the old key, so the active card looks up the new key, finds no alias, and
falls back to the provider Session name or UUID. The old root still appears in
History and continues to own the user's name.

## Goal

Preserve a user-defined Session name across a successful Codex root-thread
rebind without losing the old History label or overwriting a name explicitly
assigned to the new root.

## Required Behavior

- Alias continuity runs only after `TmuxRuntimeBindingStore.rebindKnown()`
  returns `rebound`.
- If `provider:<old-session-id>` has an alias and
  `provider:<new-session-id>` does not, copy the old alias to the new key.
- Retain the old key and alias so the previous root keeps its readable History
  label.
- If the new key already has a non-empty alias, preserve it.
- If the old alias is absent, either Session ID is empty, the provider is
  invalid, or both IDs are equal, make no alias-store write.
- A metadata-copy failure must be logged but must not undo or hide a successful
  durable runtime rebind.
- Failed, stale, missing, ambiguous, or non-Codex rebind attempts must not copy
  aliases.

## Architecture

Add `copyForRebind(providerId, previousSessionId, nextSessionId)` to
`AiSessionAliasController`. The controller owns alias validation, key creation,
read/merge/write behavior, and error mapping. It copies rather than moves the
alias and performs one `saveAll()` only when the target needs the source value.

Add an optional `onSessionRebound(previous, next)` callback to
`TmuxRuntimeDiscovery`. Discovery calls it after the durable store confirms the
rebind and before projecting the new identity. The callback is metadata-only:
discovery catches callback failures so alias persistence cannot invalidate the
already committed runtime transition.

Construct the alias controller before tmux discovery in `dashboard.ts`, then
wire the callback to `copyForRebind`. No new service, storage file, schema, or
provider API is introduced.

## Data Flow

```text
same managed tmux locator
  -> observer finds a different Codex root Session ID
  -> durable runtime store returns "rebound"
  -> discovery reports old and new runtime identities
  -> alias controller copies old alias when the new key is empty
  -> active card resolves the copied alias under the new Session ID
  -> History continues to resolve the retained old alias
```

## CI Regression Contract

Add automated behavior `SESSION-ALIAS-THREAD-SWITCH-001`.

The focused contract must prove:

1. A successful rebind copies the old alias to the new Session key.
2. The old alias is retained.
3. An existing new-root alias is not overwritten.
4. No source alias produces no write.
5. Failed rebind outcomes do not invoke alias migration.
6. Dashboard activation wires an alias-preserving callback into tmux discovery.
7. A throwing alias hook or alias-store save failure is contained, logged at
   the controller boundary, and cannot roll back the new runtime projection.

The owner tests live under `tests/contract/aiSessions/`. They are executed by
`test:deterministic:run`, which is called by `test:ci:linux`, which is the
`quality-linux` pull-request check in `.github/workflows/verify.yml`.

## Error Handling and Compatibility

- Alias data keeps the existing JSON format.
- Copying is idempotent: rerunning after a completed copy observes an existing
  target and performs no write.
- Existing target aliases win, including when they differ from the old alias.
- Alias failures use the controller's existing logging and save-error UI path;
  discovery also contains unexpected callback rejection.
- Immutable tmux metadata is not used for automatic historical backfill: after
  multiple switches it identifies the original root, not a proven direct
  predecessor, and replaying it would recreate aliases users intentionally
  reset. An already-affected local alias must be repaired once using the exact
  diagnosed old/new IDs.
- Pins, attention events, runtime lifecycle, and provider Session records are
  outside this fix.

## Verification

Use test-driven development:

1. Register the behavior and add focused controller/discovery/composition
   assertions.
2. Compile and run only the focused behavior to observe the current failure.
3. Add the minimal controller method, discovery callback, and dashboard wiring.
4. Run the focused behavior to green.
5. Run behavior-catalog, contract, tmux, architecture, and full Linux CI gates.

## Delivery Constraints

- Work only in the existing isolated worktree on
  `fix/logical-attention-card-count`.
- Do not modify the user-dirty primary checkout.
- Do not push, open a pull request, merge, or publish a release during this
  fix; more quick fixes may be added to the same branch.
