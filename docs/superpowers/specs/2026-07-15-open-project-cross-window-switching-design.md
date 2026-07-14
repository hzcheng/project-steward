# OPEN PROJECT Cross-Window Switching Design

Date: 2026-07-15
Status: Approved

## Decision

`OPEN PROJECT` will show projects from every live Project Steward window opened
by the same desktop VS Code client and VS Code Profile. The current window's
project cards remain pinned at the top and retain all AI session functionality.
Cards owned by other windows are navigation-only and switch to the exact
existing window when clicked.

Cross-window discovery and switching will extend the existing Project Steward
Local Bridge. It will not call `vscode.openFolder` when a navigation card is
clicked, so switching cannot create a duplicate project window.

The feature is not yet released. The main extension and Local Bridge will be
updated together, with no compatibility layer, old-protocol fallback, or data
migration.

## Goals

- Show all projects open in live VS Code windows within the current Profile.
- Cover local, Remote SSH, WSL, Dev Container, and other remote windows.
- Keep the current window's cards first and fully session-capable.
- Make every other card a simple, exact window-switch target.
- Preserve separate cards when the same project is open in multiple windows.
- Sort other windows by most recent focus time.
- Never open a new window as a fallback for a failed switch.
- Reuse the existing two-extension installation and local file coordination
  model.

## Non-goals

- Discovering windows from another VS Code Profile.
- Discovering windows on another physical machine.
- Showing or managing sessions from a non-current window card.
- Showing session counts, attention counts, save controls, favorite controls,
  or context menus on navigation-only cards.
- Opening a closed project when its former window is no longer available.
- Supporting a mixed old/new main-extension and Local-Bridge installation.
- Using OS-specific automation such as AppleScript, PowerShell, `wmctrl`, or
  window-title matching.

## Existing Context

The current `OPEN PROJECT` list is built only from
`vscode.workspace.workspaceFile` and `vscode.workspace.workspaceFolders` in
the current Extension Host. A current-window card is rendered with
`data-open-project`; clicking it toggles its AI session section.

The Local Bridge already provides Profile-local file coordination between
local, SSH, WSL, and Dev Container windows. Its owner snapshots and leases are
used for attention aggregation. Open-window discovery will use a separate
registry so project-card lifecycle does not alter attention lifecycle.

VS Code does not expose a public API for enumerating or targeting arbitrary
desktop windows. Current VS Code source registers
`workbench.action.focusWindow`, which force-focuses the window in which the
command executes. The design therefore sends a request to the target window's
own Workspace Extension and lets that instance focus itself.

## Product Boundary

The coordination boundary is one desktop VS Code client and one VS Code
Profile. Every participating window must have the Project Steward main
extension active and its Local Bridge dependency active. The main extension's
current `*` activation makes every Project Steward-enabled workspace window a
publisher without requiring the sidebar to be opened.

Empty windows publish no project cards and are omitted from `OPEN PROJECT`.

## Architecture

### 1. Workspace Registry Publisher

Every main-extension instance owns a cryptographically random `instanceId` for
its activation lifetime. It builds project descriptors from the same
current-workspace inputs and matching rules used by the existing
`getOpenProjectsFromWorkspace` path.

The publisher registers immediately and republishes when:

- the extension activates;
- workspace folders or the workspace file change;
- the window gains focus;
- rendered project metadata changes;
- the ten-second heartbeat is due.

When `vscode.window.onDidChangeWindowState` reports `focused: true`, the
publisher records a new `lastFocusedAtMs`. A heartbeat updates only the lease;
it does not change the recent-focus order.

On normal deactivation the publisher sends a best-effort unregister request.
A thirty-second lease removes registrations left by crashes, lost remote
connections, or failed cleanup.

### 2. Local Bridge Open-Window Store

The Local Bridge stores window registry and focus relay data under its existing
Profile-local storage root:

```text
open-windows/v1/
  instances/
    <instanceId>.json
  focus-requests/
    <requestId>.json
  focus-results/
    <requestId>.json
```

Open-window files are independent from the existing attention instance files.
The store reuses the existing safety properties:

- owner-specific files;
- atomic temporary-file replacement;
- bounded file and field sizes;
- regular-file and symlink checks;
- restrictive local permissions;
- monotonic per-owner sequence numbers;
- lease-based stale cleanup.

Each Local Bridge instance remembers the Workspace Extension `instanceId`
bound to its window when it handles that window's registration command. This
binding is used both to deliver aggregate registry updates back to the correct
Workspace Extension and to decide whether a focus request targets this window.

### 3. Registry Aggregation

Every Local Bridge instance watches the registry directory and performs a
periodic fallback scan. It validates all live registrations and creates a
semantic aggregate that omits sequence and lease-only changes.

The aggregate is sent to the Workspace Extension in the same VS Code window
only when one of these values changes:

- the live window set;
- a project descriptor;
- a window's `lastFocusedAtMs`;
- a window expires or unregisters.

Heartbeat writes therefore do not trigger Webview rendering.

### 4. Dashboard Projection

The current window's cards continue to come from the existing local
`getOpenProjects()` path. They are not reconstructed from registry data, so
their provider sessions, active provider, expansion state, terminal state,
attention state, and management controls remain unchanged.

Other live registrations are projected into a new navigation-only view model.
The renderer must model current cards and navigation cards explicitly rather
than overloading the existing `isReadOnlyProject` flag:

```ts
type OpenProjectCardKind = 'current' | 'windowNavigation';
```

A navigation card carries its target window `instanceId` and never carries AI
session view models.

### 5. Targeted Focus Relay

Clicking a navigation card follows this flow:

1. The Webview posts the target window `instanceId` to its Workspace
   Extension.
2. The Workspace Extension verifies that the target exists in its latest live
   registry aggregate.
3. It invokes a private Local Bridge focus command with a random request ID,
   source instance ID, target instance ID, and creation time.
4. The source Local Bridge scans the registry again. It returns
   `target-missing` immediately if the target lease is no longer live;
   otherwise it atomically writes the request and waits up to three seconds for
   its result.
5. All bridge instances may observe the request, but only the bridge whose
   bound Workspace Extension ID equals the target ID may handle it.
6. The target bridge invokes a private command in its own Workspace Extension.
7. The target Workspace Extension validates that the requested target ID is
   its own activation ID and executes `workbench.action.focusWindow`.
8. The target bridge writes the result and removes the request.
9. The source bridge returns the result to the source Workspace Extension and
   removes the result file.

No focus failure path invokes `vscode.openFolder`, `vscode.newWindow`, a CLI,
or an operating-system automation command.

## Data Contracts

### Window Registration

```ts
interface OpenWindowRegistration {
  protocolVersion: 1;
  instanceId: string;
  sequence: number;
  lastFocusedAtMs: number;
  leaseUpdatedAtMs: number;
  projects: OpenWindowProject[];
}

interface OpenWindowProject {
  localProjectId: string;
  ordinal: number;
  name: string;
  description: string;
  uri: string;
  remoteType: 'local' | 'ssh' | 'wsl' | 'devContainer' | 'remote';
  color?: string;
}
```

`uri` is the canonical URI or Project Steward path already resolved by the
owning Workspace Extension. Remote credentials or secrets must not be added to
the descriptor. The local Profile storage may contain remote authorities and
workspace paths because they are required to identify and display an open
project.

The maximum registration contains 100 project descriptors. Strings and total
file size use explicit bounds aligned with the Local Bridge store limits.

### Aggregate

```ts
interface OpenWindowAggregate {
  protocolVersion: 1;
  semanticRevision: string;
  observedAtMs: number;
  windows: OpenWindowRegistration[];
}
```

`semanticRevision` hashes project data and focus ordering fields, excluding
sequence and lease timestamps.

### Focus Request and Result

```ts
interface WindowFocusRequest {
  protocolVersion: 1;
  requestId: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  createdAtMs: number;
}

interface WindowFocusResult {
  protocolVersion: 1;
  requestId: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  completedAtMs: number;
  success: boolean;
  errorCode?: 'target-missing' | 'focus-failed' | 'expired';
}
```

Only a live registered target may process a request. Request IDs and instance
IDs are validated fixed-length random hexadecimal identifiers. Focus requests
expire after ten seconds; result files expire after thirty seconds.

## Ordering and Identity

The dashboard constructs the group in this order:

1. all current-window cards, in their existing workspace order;
2. other windows by descending `lastFocusedAtMs`;
3. projects within each other window by their published `ordinal`.

Cards are never deduplicated across window instances. Two windows containing
the same URI produce two cards and remain separately targetable.

A cross-window DOM identity combines the target `instanceId` and the published
`localProjectId`; it must not reuse another window's `__openProjects-N` ID
without namespacing.

If multiple navigation cards have the same project name and URI, the UI adds a
deterministic `Window 1`, `Window 2`, and so on suffix based on lexical
`instanceId` ordering. The suffix remains stable for the lifetime of those
window instances even if recent-focus sorting changes.

## User Interface

`OPEN PROJECT` remains a sticky system group.

### Current-Window Cards

- Stay at the top.
- Keep the existing current-workspace highlight.
- Toggle AI sessions when clicked.
- Retain provider selection, New Session, Manage, session actions, terminal
  highlighting, and session attention rendering.
- In a multi-root window, every locally generated current card remains
  session-capable.

### Navigation-Only Cards

- Use the project-card visual language.
- Show only the project name and Local, SSH, WSL, Dev Container, or Remote
  environment information.
- Use a dedicated DOM marker such as `data-window-navigation-project` and a
  target-instance attribute.
- Show `Switch to this window` on hover.
- Send only a focus request when clicked.
- Do not render session counts, attention counts, provider controls, session
  rows, Save, Favorite, project actions, or context menus.
- Ignore Ctrl/Cmd modifiers and middle-click window-opening behavior.

Switching does not automatically expand a session list or otherwise mutate the
target window's persisted dashboard UI state.

## Failure Handling

- A missing target is rejected by both the source Workspace Extension's latest
  aggregate and the source bridge's fresh registry scan. It removes or
  refreshes the stale card and shows
  `Target window is no longer available.`
- A request that has no result after three seconds reports a switch timeout.
- A rejected `workbench.action.focusWindow` call reports a focus failure.
- The source window permits only one outstanding focus request at a time.
- Repeated target handling is prevented by request ID and result-file
  idempotency.
- No failure reopens the project.
- Bridge or registry runtime failures are logged to the Project Steward output
  channel while the current window's existing cards remain usable. This is
  failure isolation, not an old-version compatibility path.

## Performance

Each active window writes one small registration at most once per ten-second
heartbeat, plus immediate writes for real workspace or focus changes. Normal
window counts produce negligible disk throughput.

Registry aggregation uses semantic comparison so lease-only writes do not
refresh the Webview. Filesystem watching supplies low-latency discovery and
focus request handling; bounded periodic scanning supplies recovery from lost
watch events.

The feature never scans provider session histories for navigation-only cards.
Only the current window's existing `getOpenProjects()` path loads session data.

## Mandatory Feasibility Spike

Implementation must begin with the smallest possible targeted-focus spike. Do
not implement registry UI or production storage until the spike passes.

The spike must prove:

1. local window A can cause local window B to execute
   `workbench.action.focusWindow` and reach the foreground;
2. a local window can focus an SSH window;
3. a local window can focus a Dev Container window;
4. two windows opening the same project can be targeted separately by instance
   ID;
5. repeated switching does not increase the VS Code desktop window count;
6. closing the target produces a bounded failure and never reopens it.

The result must record environment, request target, handling instance, focus
result, latency, and before/after window count. If exact targeting or forced
foreground focus fails in any required topology, stop implementation and
return to design rather than weakening the no-duplicate requirement.

## Automated Testing

### Registry Store

- registration validation and field bounds;
- atomic owner writes and monotonic sequences;
- ten-second heartbeat without semantic UI revision changes;
- thirty-second lease expiry;
- explicit unregister;
- malformed, oversized, symlink, and stale file handling.

### Aggregation and Projection

- current-window cards always precede navigation cards;
- other windows sort by descending focus time;
- projects within one window preserve ordinal order;
- identical projects in two windows remain separate;
- duplicate display suffixes are deterministic;
- navigation view models contain no session or attention data;
- empty-window registrations create no cards.

### Focus Relay

- only the exact target instance handles a request;
- the target Workspace Extension rejects a mismatched target ID;
- successful focus produces one result and cleans its request;
- missing, expired, duplicate, and timed-out requests fail safely;
- only one request per source is outstanding;
- no error path calls project-opening commands.

### Webview

- current-card clicks still toggle sessions;
- navigation-card clicks emit only a target focus message;
- navigation cards omit session, attention, save, favorite, and management
  markup;
- modifier keys and middle click do not open projects;
- registry updates preserve existing current-card expansion state.

### Regression

- existing OPEN PROJECT session behavior;
- attention aggregation and acknowledgement;
- batch session management;
- active terminal highlighting;
- saved-project and Favorites navigation;
- TypeScript compilation, lint safety checks, and Webpack builds for both
  extensions.

## Acceptance Criteria

1. Every live Project Steward workspace in the current Profile appears in
   every window's `OPEN PROJECT` group within the registry update interval.
2. Current-window cards are first and remain the only cards that expose AI
   sessions.
3. Other cards are ordered by recently focused window and act only as switch
   targets.
4. The same project open in two windows produces two independently targetable
   cards.
5. Clicking a navigation card focuses the exact existing window in local, SSH,
   and Dev Container topologies.
6. Successful and failed switching never creates another VS Code window.
7. Closed or crashed windows disappear after explicit unregister or at most one
   thirty-second lease.
8. Session scanning cost does not increase with the number of navigation-only
   cards.
