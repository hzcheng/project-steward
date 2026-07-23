# Logical Attention Card Count Design

## Context

AI-session attention intentionally retains one event per runtime execution. A
single logical Session can therefore own multiple unread aggregate entries with
keys such as:

```text
codex:<session-id>:<run-started-at-ms>:tmux
codex:<session-id>:<run-started-at-ms>:vscode
```

Session-row recovery already normalizes those keys to
`provider:<session-id>` so one interaction can acknowledge every retained
event. Card summaries do not perform the same normalization. They count raw
aggregate entries, so two unread runs of one logical Session render a red
attention count of `2`.

## Goal

Every Project Steward card must count distinct unread logical AI Sessions while
retaining every underlying runtime event ID for acknowledgement.

## Required Behavior

- A logical Session is identified by `provider:<session-id>`.
- A run-scoped key matching
  `provider:<session-id>:<run-started-at-ms>:<backend>` normalizes to its
  logical Session key.
- Multiple unread runs of the same logical Session contribute exactly one card
  attention count.
- Every distinct event ID from those runs remains attached to the logical
  Session summary.
- CURRENT WORKSPACE, OTHER WINDOWS, and saved-project summaries use the same
  logical counting rule.
- Explicit Close or Detach acknowledges all retained event IDs for the logical
  Session and makes its projected count disappear immediately.
- A terminal that closes without the explicit Project Steward action continues
  to preserve unread attention.

## Architecture

Keep the attention bridge and aggregate protocol run-scoped. Runtime identity is
needed to prevent lifecycle replay and event collisions, so the aggregate must
not discard or rewrite run keys.

Move the existing run-key normalization helper into the AI-session attention
domain, where both workspace Session projection and card projection can reuse
it without a workspace-to-AI-session dependency cycle.

Both project-summary entry points group aggregate records by the normalized
logical Session key:

- `getAttentionProjectSummaries()` for saved-project projection.
- `getAttentionSummaryForProjectKeys()` for workspace/card projection.

Each group uses a set for event IDs. The public summary exposes the logical
Session key, the sorted complete event-ID list, and the first sorted event ID as
the stable representative. Card count is the number of logical groups.

The acknowledgement controller and bridge protocol remain unchanged. Explicit
Close and Detach continue to use the recovery map, which already groups every
retained run event under the logical Session key.

## Data Flow

```text
runtime completions
  -> run-scoped attention aggregate entries
  -> logical Session normalization at projection
  -> one card count + all event IDs
  -> explicit Session interaction acknowledges all event IDs
  -> effective aggregate filters the acknowledged Session
  -> projected card count becomes zero
```

## CI Regression Contract

Add an automated behavior contract named
`ATTENTION-LOGICAL-SESSION-CARD-COUNT-001`.

The focused contract must prove:

1. Two run-scoped aggregate entries for one logical Session produce a project
   attention count of `1`.
2. The resulting logical Session summary retains both event IDs.
3. Workspace attention projection produces a card attention count of `1` for
   the same aggregate.
4. Saved-project projection uses the same count.
5. After both event IDs are acknowledged, projection produces count `0`.
6. Different logical Session IDs still contribute separate counts.

The existing Webview safety check for explicit Close and Detach must be
strengthened so a row backed by multiple recovered event IDs emits one
acknowledgement containing all IDs before the close/detach message.

The new behavior ID is added to the behavior catalog and the existing
`MAIN-WORKSPACE-ATTENTION` capability, so its owner remains reachable from the
pull-request deterministic gate.

## Error Handling and Compatibility

- Malformed or unrecognized keys remain unchanged and continue to be treated as
  distinct opaque Session keys.
- Empty event IDs remain ignored by the existing summary logic.
- No bridge protocol, persisted storage, release package, or setting changes
  are required.
- Existing event ordering remains deterministic.

## Verification

Use test-driven development:

1. Add the focused behavior contract and run it against the current code to
   record the expected `2 !== 1` failure.
2. Apply the projection-only normalization change.
3. Run the focused contract to green.
4. Run attention, open-workspace, Webview safety, behavior-catalog, TypeScript,
   and full Linux CI checks.

## Delivery Constraints

- Work is isolated on branch `fix/logical-attention-card-count` in a worktree
  created from `origin/main`.
- The primary checkout and its uncommitted files are not modified.
- The completed local branch is not pushed and no pull request is opened,
  because additional bugs may be investigated before publication.
