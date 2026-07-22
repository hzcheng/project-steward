# Workspace Parity: Attention and Pending Promotion Design

## Goal

Make a single-folder window, a saved multi-root workspace, and an untitled
multi-root workspace share the same AI Session lifecycle contract. Workspace
support must preserve the behavior that existed before the workspace-first
cutover while keeping the new product model: one workspace is one card and one
working context, regardless of how many folders it contains.

The immediate regressions are:

- a completed Session does not gain a persistent `needs attention` indicator in
  CURRENT WORKSPACE;
- OTHER WINDOWS can transition from the running animation to a neutral card
  before the later attention aggregate arrives, and then never redraw;
- a newly launched pending runtime can remain `Starting` because the old
  pending-to-Session promotion path is no longer called by production code.

This recovery does not change the current card appearance, the bridge protocol,
or the workspace-first storage model.

## Root Causes

### CURRENT WORKSPACE lost attention projection

The old project hydration path built an attention index and decorated hydrated
Sessions with unread event data. `WorkspaceSessionHydrationController` reads
provider history and runtime state, but it does not consume the effective
attention aggregate. The renderer still knows how to display
`session.attention.unread`; the workspace view model simply never supplies it.

The current workspace summary may still receive an aggregate count through a
different path. That does not repair the Session row, because the row needs its
own event identity for persistent rendering and explicit acknowledgement.

### OTHER WINDOWS ignores a later attention-only update

Running state and attention state arrive through separate publications. A
running-state publication can redraw a remote workspace first with zero running
Sessions and zero attention items. The attention aggregate can arrive shortly
afterward, but the attention callback currently schedules only the CURRENT
WORKSPACE AI Session update.

In addition, the semantic revision used by the open-workspace controller omits
the attention aggregate revision. An attention-only change therefore cannot
invalidate the OTHER WINDOWS projection.

### Pending promotion became test-only code

`resolvePendingAiSessionTerminals` still contains the matching, conflict
handling, runtime promotion, and alias behavior, and it still has isolated unit
coverage. The workspace-first hydration path no longer invokes it. Consequently
the resolver can pass every unit test while new Sessions remain pending in the
actual extension.

## Workspace Parity Contract

The following behavior is mandatory in all three workspace shapes: single
folder, saved multi-root, and untitled multi-root.

| Capability | Required result |
| --- | --- |
| Workspace identity | The window is represented by one card, not one card per folder. |
| Session scope | Provider scans, create, and resume use the selected workspace root/working directory. |
| Pending launch | A pending runtime is promoted exactly once when its provider Session becomes discoverable. |
| Running state | CURRENT WORKSPACE rows and OTHER WINDOWS cards show the existing running treatment. |
| Completion attention | A successful completion becomes unread and remains visible after runtime ownership is released. |
| Acknowledgement | Only clicking the corresponding Session row/card acknowledges its retained event IDs. |
| Cross-window synchronization | The aggregate makes the unread state visible in the owning window and in OTHER WINDOWS. |
| Existing actions | Provider switch, pin, single/batch archive, terminal focus/close/detach, search reveal, save workspace, and cross-window navigation retain their current behavior. |

Clicking an OTHER WINDOWS workspace card is navigation only and does not
acknowledge any Session. Refreshing the dashboard, switching tabs, collapsing a
card, reloading a window, or receiving a newer aggregate also does not
acknowledge. The indicator disappears only after an explicit click on the
corresponding Session UI, after which the existing aggregate acknowledgement
synchronizes every window.

## Audited Compatibility Boundary

The workspace-first implementation already preserves the root-aware create and
resume flows, provider switching, pinning, archive actions, terminal actions,
search reveal, workspace save, cross-window navigation, and running animation.
Those paths are protected as parity requirements rather than rewritten.

The confirmed missing production connections are:

1. effective attention aggregate to workspace Session view models;
2. attention-only aggregate changes to the OTHER WINDOWS refresh/revision;
3. workspace provider-scan results to pending runtime promotion.

Restoring temporary preferences from the removed project model is explicitly
out of scope. Old per-project expansion state, provider state, and group-collapse
state do not need a compatibility reader. Saved projects and saved workspaces
continue to use the workspace-first model. The removed monolithic project
hydration controller must not be restored merely to regain these lifecycle
connections.

## Design

### 1. Project attention into the workspace view model

Workspace hydration receives the effective attention aggregate and decorates
provider Sessions before active/history rows are projected. The mapping is
root-aware so the same provider Session identifier discovered under different
workspace roots cannot leak attention across roots.

Attention keys exist in two forms:

```text
provider:sessionId
provider:sessionId:runStartedAtMs:backend
```

The run-scoped form is normalized to the logical `provider:sessionId` form for
Session-row lookup while retaining every original event ID for acknowledgement.
The existing root/project identity on each aggregate item remains part of the
index key. If a Session is visible from overlapping scans, the existing
deduplication winner also owns the attention projection.

The resulting Session view model carries the existing attention shape, including
an unread flag and a stable event ID. Active rows derive `needsAttention` and
`attentionEventId` from that decorated Session exactly as the renderer already
expects. Clicking the row uses the controller's existing logical-Session recovery
map to acknowledge all retained run event IDs, not just the display event.

No new visual state, badge design, color, spacing, or animation is introduced.

### 2. Make attention a first-class open-workspace revision

The open-workspace semantic revision includes the effective attention
aggregate's `aggregateRevision` alongside the existing bridge status, workspace
aggregate semantic revision, and running animation state. An attention-only
change therefore produces a distinct projection even when the remote workspace
inventory has not changed.

When the attention bridge accepts a changed aggregate, the extension schedules
both updates:

- the incremental CURRENT WORKSPACE AI Session refresh;
- the OTHER WINDOWS projection refresh.

This must be wired through an initialization-safe callback or nullable refresh
target so an early bridge message cannot access a controller before it is
constructed. Existing refresh coalescing remains responsible for suppressing
duplicate renders.

No protocol field is added. The main extension consumes the aggregate revision
and items already delivered by UI Bridge `0.1.3`.

### 3. Restore promotion through a workspace-native controller

Introduce a small workspace pending-promotion controller rather than restoring
the deleted project hydration controller. Hydration continues to own provider
reads and view-model construction; the promotion controller owns only the side
effectful transition from a pending runtime to a final Session runtime.

After a workspace-scoped provider scan succeeds, the controller receives:

- pending and active runtime snapshots for the current workspace identity;
- provider read results and provider definitions;
- the runtime coordinator and Session-key function;
- alias persistence and active-runtime synchronization callbacks;
- refresh, execution-evaluation, and diagnostic callbacks.

It delegates matching and settlement to
`resolvePendingAiSessionTerminals`. A successful promotion writes the alias,
synchronizes active terminal/runtime state, evaluates the new active execution,
and schedules a refresh. A failed or unmatched pending runtime remains eligible
for a later provider scan.

The controller deduplicates concurrent attempts by pending runtime identity.
It must not permanently memoize a failure: provider discovery, runtime
availability, and conflict selection can change. A successful promotion is
naturally excluded from later attempts because it no longer appears in the
pending runtime set.

### 4. Protect the parity boundary with behavioral tests

Add a dedicated Workspace parity suite and include it in the normal safety
verification. Its primary assertions exercise controller/view-model behavior,
not source-text patterns.

The core lifecycle scenario is:

```text
pending -> promoted -> running -> needsAttention -> Session click -> acknowledged
```

For each workspace shape, the suite proves:

1. a provider scan promotes one matching pending runtime and does not duplicate
   the Session row;
2. alias persistence, active-runtime synchronization, execution evaluation, and
   refresh happen after successful promotion;
3. running state appears in CURRENT WORKSPACE and the remote workspace
   projection;
4. completion survives runtime release and decorates the correct Session row;
5. the CURRENT WORKSPACE summary/row and OTHER WINDOWS card agree on unread
   state;
6. the race where the running update arrives before the attention aggregate
   still ends with the remote attention indicator;
7. refresh, tab changes, collapse, and workspace-card navigation do not
   acknowledge;
8. clicking the corresponding Session acknowledges all retained events and the
   next aggregate clears both windows;
9. the same Session ID under another root does not receive the event;
10. a failed or ambiguous promotion is retried and never creates a duplicate.

The suite also retains compact contract checks for create/resume root selection,
provider switch, pin, single/batch archive, terminal focus/close/detach, search
reveal, save workspace, and direct cross-window navigation. These checks may use
focused controller fixtures; they do not need a full VS Code host for every
case.

A narrow architecture gate supplements, but does not replace, behavioral tests.
It fails if the pending resolver again has no production caller, if workspace
hydration loses its attention input, or if attention updates cease to invalidate
the open-workspace projection.

## Error Handling and Performance

- A malformed or missing attention aggregate renders no unread state and does
  not fail workspace hydration.
- Unknown roots and removed roots are ignored rather than attached to the first
  workspace folder.
- Promotion errors are logged and retained for retry; one provider failure does
  not prevent other providers from hydrating.
- Refreshes remain coalesced and provider scans remain shared within one
  hydration cycle. Attention-only updates must not trigger an unnecessary
  provider history scan.
- Attention indexing is linear in aggregate items plus hydrated Sessions and is
  built once per relevant projection cycle.

## Non-Goals

- No card markup or stylesheet redesign.
- No change to CURRENT WORKSPACE expand/collapse targeting.
- No bridge package, command, payload, or protocol version change.
- No return to one card per workspace folder.
- No compatibility adapter for removed project-era transient preferences.
- No acknowledgement on workspace-card navigation.
- No extension-host restart persistence beyond the existing attention-retention
  contract.

## Acceptance Criteria

- CURRENT WORKSPACE shows the existing red attention indicator when one of its
  Sessions completes, including after the owned runtime has been released.
- OTHER WINDOWS transitions from the running animation to the existing attention
  indicator even when attention arrives in a later aggregate update.
- The indicator persists across refreshes and disappears only after the
  corresponding Session is clicked.
- New Sessions no longer remain indefinitely in `Starting`; a discoverable
  Session is promoted once and keeps the expected alias and runtime actions.
- All lifecycle and parity tests pass for single-folder, saved multi-root, and
  untitled multi-root fixtures.
- A production-wiring test prevents the attention and pending resolver paths
  from becoming test-only again.
- Existing dashboard, attention, tmux, compile, packaging, and release checks
  pass.
- Manual two-window acceptance covers Direct Terminal and tmux backends.
- The packaged main extension is installed into the Dev Container for user
  verification; the UI Bridge is not installed or overwritten.
