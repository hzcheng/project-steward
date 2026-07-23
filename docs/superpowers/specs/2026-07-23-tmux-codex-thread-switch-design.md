# Tmux Codex Thread Switch Design

## Problem

Project Steward binds a managed tmux runtime to the Codex session created when
the terminal starts. Codex TUI can later switch to another root thread inside
the same pane, for example through `/new`, without replacing the shell or tmux
window.

The tmux runtime then remains bound to the old session ID. Execution monitoring
continues reading the old JSONL, whose latest lifecycle event can be
`task_complete`, while the new root thread is actively producing work. The
Active Session card consequently reports `stopped` and does not show its
running animation.

The required behavior is:

- the managed runtime follows the root Codex thread currently running in its
  pane;
- the previous thread remains available in History;
- subagent threads must never replace the root runtime binding;
- uncertain observations must not change durable state.

## Scope

This change covers Codex sessions running in Project Steward-managed tmux
windows on Linux extension hosts where process file-descriptor inspection is
available.

It does not:

- parse terminal screen contents;
- modify or delete Codex session JSONL files;
- infer ownership solely from workspace path or file timestamps;
- change Direct Terminal behavior;
- make thread-switch detection mandatory on platforms without a supported
  process inspection mechanism.

## Options Considered

### Select the newest session in the workspace

This is simple but cannot distinguish multiple Codex terminals running in the
same workspace. It can attach one terminal's card to another terminal's
session, so it is rejected.

### Parse the UUID displayed by Codex TUI

This associates the observation with the correct pane, but it depends on Codex
screen layout and can mistake a UUID printed in conversation content for the
current thread. Reading terminal content also expands the privacy surface. It
is rejected.

### Inspect session files opened by the pane process tree

The tmux pane PID establishes ownership. A bounded traversal of its descendant
processes can inspect open file descriptors that resolve beneath the configured
Codex sessions root. The first JSONL record identifies whether a file belongs
to a root `codex-tui` session or a subagent.

This option is selected because it ties the session to the exact runtime,
rejects subagents using structured metadata, and fails closed when evidence is
missing or ambiguous.

## Architecture

### Tmux window observation

`TmuxClient.listWindows()` will include the pane PID for each managed tmux
window. The PID is treated as an observation, not durable identity: tmux
locator metadata remains the durable runtime address.

Only a positive integer within the platform PID range is accepted. Missing or
invalid values disable thread-switch detection for that row without affecting
ordinary discovery.

### Codex root-thread observer

A focused observer receives:

- the pane PID;
- the configured Codex sessions root;
- the currently bound session ID;
- the runtime start time.

On Linux it performs a bounded traversal of `/proc/<pid>/task/<pid>/children`
and the corresponding descendant process directories. It reads symlink targets
from `/proc/<pid>/fd`, accepting only regular `.jsonl` files that resolve
beneath the configured Codex sessions root.

For each candidate, it reads only the bounded first JSONL line and accepts the
session when:

- the record type is `session_meta`;
- `payload.originator` is `codex-tui`;
- `payload.id` and `payload.session_id` are the same valid session ID;
- `payload.source` does not contain `subagent`;
- the session timestamp is not older than the runtime start.

The observer returns a replacement only when there is exactly one qualifying
root session different from the currently bound session. Zero or multiple
candidates produce no replacement.

Process enumeration, symlink, stat, and JSON parsing errors are contained
inside the observer. They produce no replacement and never fail the ordinary
tmux discovery refresh.

### Atomic durable rebind

The binding store will expose one serialized operation that replaces a known
binding only when all expected old fields still match:

- provider and workspace identities;
- old session ID;
- tmux locator;
- old `lastSeenAtMs`.

The new binding preserves provider, workspace, cwd, layout, locator, marker
path, and runtime start time while replacing the session ID. The operation
writes the new canonical known record durably and removes the old canonical
known record under the same final-record lock.

The operation returns one of:

- `rebound`: the durable replacement committed;
- `stale`: the expected old binding changed concurrently;
- `missing`: the expected old binding disappeared.

On `stale` or `missing`, discovery does not project the observed replacement in
that refresh. A later refresh re-evaluates current durable state.

### Discovery and projection

During enumeration, discovery compares each managed window's durable known
binding with the root-thread observer result. When an unambiguous replacement
exists, discovery attempts the atomic rebind before constructing the active
runtime snapshot.

After a successful rebind:

- the active runtime identity uses the new session ID;
- execution monitoring reads the new session JSONL;
- hydration resolves the new session name and status;
- the workspace running-session count includes the new running thread;
- the old session remains provider history and is no longer projected as an
  active runtime.

No synthetic completion or attention event is emitted for the old thread.
Existing provider history remains the source of its final lifecycle and name.

## Safety and Compatibility

- All process inspection is bounded by existing discovery row limits plus
  explicit descendant, descriptor, path-length, and first-line byte limits.
- Candidate paths are canonicalized and constrained beneath the Codex sessions
  root before being opened.
- Subagent metadata is excluded using the same semantic rule as
  `CodexSessionService`.
- Unsupported platforms and unavailable `/proc` preserve current behavior.
- Existing tmux metadata and readable locator names do not change during a
  rebind.
- Discovery cache invalidation and the binding-store lock prevent a stale
  observation from overwriting a newer attach, promotion, archive, or recovery
  decision.

## Testing

Focused contract tests will establish:

1. A pane that stops holding the old root JSONL and holds one new root JSONL
   rebinds to the new session.
2. Open subagent JSONL files are ignored.
3. Multiple qualifying root candidates make the observer return no
   replacement.
4. Invalid PID, traversal failure, escaped paths, malformed metadata, and
   unsupported platforms fail closed.
5. A stale or missing compare-and-swap prevents discovery from projecting the
   new identity.
6. A successful rebind leaves exactly one known record at the same locator and
   survives a fresh discovery instance.
7. Hydration keeps the old session in History while the new session is Active
   with `executionState: running`.
8. Webview projection applies the configured running animation after the
   switch.

The focused tests will be followed by the tmux contracts, AI-session safety
suite, dashboard webview contracts, deterministic CI suite, and Linux CI suite.

## Acceptance Criteria

- Reproducing `/new` in a Project Steward-managed Codex tmux pane causes the
  Active Session card to follow the new root session within the normal refresh
  interval.
- The card uses the new session's display name and running lifecycle state.
- The old session remains visible in History.
- Subagent creation never changes the Active Session identity.
- Ambiguous or unavailable process evidence leaves the existing binding
  unchanged.
- No existing Direct Terminal, tmux promotion, readable naming, recovery,
  attention, OTHER WINDOWS, packaging, or CI behavior regresses.
