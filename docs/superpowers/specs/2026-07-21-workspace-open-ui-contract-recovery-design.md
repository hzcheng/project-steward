# Workspace OPEN UI Contract Recovery Design

Date: 2026-07-21

Status: Approved direction, pending document review

## Decision

Keep the workspace-first domain model and execution semantics, but restore the
established OPEN-card presentation and interaction contract from `main`.

The workspace-first renderer must reuse the original project-card visual shell
instead of presenting a separately designed workspace card. A single-folder
workspace and a multi-root workspace remain one logical card; workspace roots
remain execution metadata and never become sibling cards.

This design deliberately replaces two earlier workspace-first decisions that
failed manual acceptance:

- workspace-root tags are no longer rendered as an always-visible row on a
  collapsed CURRENT WORKSPACE card;
- OTHER WINDOWS navigation no longer fails closed into VS Code's Switch Window
  picker before attempting direct navigation.

The workspace aggregation model, multi-root `--add-dir` launch scope, saved
project isolation, and cross-window session-privacy boundary remain unchanged.

## Problem Confirmed by Manual Acceptance

The first installed workspace-first build preserved the intended data model but
regressed the product's existing interaction contract:

1. OPEN cards used a new layout rather than the established card shell.
2. The current card rendered a permanent root tag such as `vscode-dashboard`,
   so the fixed-height collapsed state looked partially expanded or clipped.
3. The workspace renderer hard-coded a folder icon and discarded environment
   icons for Dev Container, SSH, WSL, and other remote windows.
4. OTHER WINDOWS navigation intentionally routed every supported workspace to
   `workbench.action.switchWindow`, requiring a second manual selection.
5. New metadata and badges exceeded the narrow sidebar's available width.
6. Running-session CSS remained in the bundle, but the complete visible
   running-state contract was not demonstrated in the installed build.

These are acceptance failures, even where automated tests passed. The existing
tests encoded several of the rejected decisions and therefore cannot be used as
evidence that the user-facing behavior is correct.

## Product Invariants

1. CURRENT WORKSPACE contains zero or one card.
2. A collapsed workspace card looks and behaves like the pre-workspace OPEN
   card, including its dimensions, spacing, transitions, and environment icon.
3. Workspace roots never add a permanent third line to the collapsed card.
4. Expanding and collapsing the AI-session surface remains animated.
5. Only a CURRENT WORKSPACE card may expose session counts, running state,
   provider details, or session controls.
6. An OTHER WINDOWS card has one primary action: navigate directly to that
   exact logical workspace.
7. Navigation never substitutes a member folder for a multi-root workspace.
8. The OPEN view remains usable at a 200-pixel sidebar width without horizontal
   scrolling or inaccessible primary actions.

## Visual Contract

### Shared card shell

Current and navigation workspace cards use the established card primitives:

- `project-container` outer layout;
- `project steward-item-card` card shell;
- the existing accent, aura, title row, description row, hover, focus, and
  transition behavior;
- the existing typography, spacing, border radius, and VS Code theme tokens.

Workspace-specific behavior is expressed through data attributes and small
content variations inside that shell. It must not introduce a parallel card
design or a second independent set of base dimensions.

### Collapsed CURRENT WORKSPACE card

The collapsed card contains exactly two text rows:

1. workspace display name;
2. environment and root summary, for example `Dev Container · 3 folders`.

It may also contain the existing compact AI status badge and card actions when
space permits. It does not contain a workspace-root tag row, folder chips, an
expanded-session tab strip, or clipped expanded content.

For a single-folder workspace, the folder name may be the workspace display
name, but it is not repeated as a separate root tag.

### Expanded CURRENT WORKSPACE card

Expansion reveals the existing ACTIVE and SESSIONS surface below the card
summary using the pre-existing height/opacity transition. The list stays flat
across workspace roots. In a multi-root workspace, an individual session may
show its primary-root chip inside its row; single-root session rows omit the
redundant chip.

Root choice remains available through the new-session interaction. Root
metadata is therefore visible where it affects an operation, rather than as
permanent collapsed-card decoration.

### OTHER WINDOWS card

Navigation cards use the same visual shell and environment icon but remain
read-only and compact. They do not render AI-session panels, provider details,
running-state animation, or root chips. Their title and one-line description
identify the workspace and environment/root count.

### Environment icons

Workspace cards use the same environment-to-icon mapping as the established
project cards:

- local: folder;
- Dev Container: container;
- SSH, WSL, and generic remote: terminal/remote icon according to the existing
  helper's mapping.

The renderer must call the shared icon helper or a workspace adapter backed by
that helper. It must not hard-code the folder icon.

## Animation and State Contract

The user-selected animation semantic is execution-only:

- if at least one current-workspace AI session has
  `executionState === 'running'`, the CURRENT WORKSPACE card receives the
  configured running effect;
- waiting-for-input, idle, stopped, detached-without-running, and historical
  sessions do not make the workspace card animate;
- OTHER WINDOWS cards never animate, preserving the existing cross-window
  privacy boundary;
- `projectSteward.aiSessionRunningCardAnimation = none` keeps running state
  static and intentionally omits the effect layer;
- `prefers-reduced-motion` disables motion while retaining accessible state
  text.

The running aggregate must flow through the full render, open-workspace
incremental update, and AI-session incremental update paths. The visible class,
effect layer, keyframes, and configured mode must all be present together; a
unit test that proves only the numeric count is insufficient.

Expansion animation is independent of running-session animation. Toggling the
session surface must preserve the established expand/collapse transition even
when no session is running.

## Navigation Contract

VS Code's public `vscode.openFolder` command accepts a folder or workspace URI.
Project Steward will use each published workspace's exact `navigationUri`:

- single-folder workspace: the canonical folder URI;
- saved multi-root workspace: the canonical `.code-workspace` URI;
- untitled multi-root workspace: no member-folder fallback; prompt the user to
  save the workspace before cross-window navigation.

For single-folder and saved multi-root records, one click executes:

```text
vscode.openFolder(exactNavigationUri, { forceNewWindow: true })
```

This restores the same direct path used by the established project cards and
allows VS Code to reuse/focus an existing matching window. Project Steward does
not show the Switch Window picker first and does not ask the user to identify a
window that the clicked card already identifies.

The card ID is still resolved through the latest validated aggregate; the
Webview never supplies an arbitrary URI. A stale card triggers a refresh and no
navigation. If `vscode.openFolder` rejects, Project Steward shows a concise
warning. It may offer an explicit user-invoked Switch Window action, but it must
not automatically open the picker as the normal click path.

The static all-false navigation capability matrix is removed. Navigation
support is derived from record kind and the presence of a valid exact URI, not
from an unproven environment allowlist. Local, SSH, WSL, Dev Container, and
generic remote records follow the same exact-URI rule.

## Narrow Sidebar Contract

The shared shell owns responsive behavior. At every supported width:

- title and description containers use `min-width: 0` and ellipsis;
- the icon and primary click target remain visible;
- status badges shrink to compact forms before consuming title space;
- optional labels disappear before icons or primary controls;
- expanded session rows remain selectable and their essential actions remain
  reachable;
- the card and its children never create horizontal scrolling;
- no content is visually cut at the fixed collapsed-card boundary.

At widths at or below 280 pixels, compact badge rules apply. At 200 pixels, the
user must still be able to distinguish the card, expand the current workspace,
select a session, start a session, and activate an OTHER WINDOWS card.

## Implementation Shape

The preferred implementation is an adapter into the existing visual renderer,
not a rollback to project-shaped domain semantics:

1. Keep `OpenWorkspaceCard` and workspace AI-session view models as the data
   source.
2. Extract or reuse a shared card-shell renderer from the established project
   rendering path.
3. Supply workspace title, description, environment icon, attributes, badges,
   actions, and optional session content through explicit parameters.
4. Delete the always-visible `workspace-root-tags` collapsed-card projection
   and any CSS used only by it.
5. Keep workspace navigation resolution in the workspace navigation
   controller, but change its normal path to exact-URI `vscode.openFolder`.

This avoids reintroducing one-card-per-root behavior while removing duplicated
visual primitives that caused the regression.

## Error and Compatibility Behavior

No persisted saved-project schema, group, favorite, color, description, or
path changes are required. No migration is added.

Malformed or stale cross-window records remain rejected. A missing exact
navigation URI results in no action and a refresh or warning; it never causes a
member root to be opened as a substitute.

Unknown animation configuration continues to normalize to the existing safe
default. Missing AI-session hydration renders an idle current card.

## Acceptance Criteria

Automated and installed-build acceptance must establish all of the following:

### Rendering

- A local single-folder current workspace renders one card with the original
  shell and folder icon.
- A Dev Container single-folder current workspace renders one card with the
  container icon and no repeated root-name row.
- A multi-root current workspace renders one collapsed card, not one card per
  root, and shows no permanent root tags.
- Collapsing removes the entire session surface from the card's visible height;
  expanding and collapsing visibly transitions.
- OTHER WINDOWS cards use the same compact shell and contain no session
  details.

### Animation

- A running current-workspace session activates each supported configured
  effect.
- A waiting, idle, stopped, or historical session does not activate the card
  animation.
- Changing execution state through an incremental update updates the visible
  card without a full Webview reload.
- Navigation cards never receive running markup or session facts.
- Reduced-motion and `none` behavior remain correct.

### Navigation

- A single click on a local OTHER WINDOWS single-folder card invokes
  `vscode.openFolder` with that exact folder URI and `forceNewWindow: true`.
- A single click on a saved multi-root card invokes it with the exact
  `.code-workspace` URI, never a member folder.
- The same direct command path is exercised for Dev Container and other remote
  URI records.
- The normal path never invokes `workbench.action.switchWindow`.
- A stale record performs no open command.
- An untitled multi-root record asks the user to save and performs no folder
  fallback.
- A rejected open command produces one warning and no automatic picker.

### Responsive behavior

- Automated markup/CSS contract checks cover the responsive states, and
  installed-Webview geometry checks cover representative sidebar widths of
  400, 280, 240, and 200 pixels.
- No width produces horizontal overflow or clips the collapsed summary into an
  apparently expanded card.
- At 200 pixels, current-card expansion, new session, session selection, and
  navigation-card activation remain operable.

### Regression and installation

- Saved PROJECTS cards and their actions retain their existing behavior.
- Workspace aggregation, provider `--add-dir` construction, protocol privacy,
  and session-root ownership suites remain green.
- The packaged VSIX is installed into the target Dev Container with the normal
  UI Bridge topology, then manually checked against the six reported
  regressions before the change is considered complete.
- With the target workspace already open, clicking its OTHER WINDOWS card is
  manually verified to focus that window directly, without a picker or a
  duplicate window, for the local and Dev Container cases used in acceptance.

## Superseded Prior Clauses

This document supersedes only these clauses from earlier workspace documents:

- the `Workspace-First Support Design` allowance for roots to appear as
  always-visible current-card tags;
- the navigation feasibility report and README policy that route all
  unsupported/direct-navigation cells to the Switch Window picker;
- any renderer-specific assumption that a workspace card may replace the
  established OPEN card shell.

It does not supersede workspace identity, root scope, `--add-dir`, session
ownership, one-card aggregation, or OTHER WINDOWS privacy decisions.
