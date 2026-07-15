# OPEN PROJECT Cross-Window Project Discovery Design

Date: 2026-07-15
Status: Approved

## Decision

`OPEN PROJECT` will show the distinct projects published by every live Project
Steward window in the same desktop VS Code client and VS Code Profile. The
current window's project cards remain pinned first and retain all AI-session
functionality. Projects that exist only in other windows are navigation-only.

Navigation reuses Project Steward's existing project-opening path:

```text
selected-project -> openProject() -> vscode.openFolder
```

VS Code therefore performs the same existing-window reuse that already occurs
when a saved repository card is clicked. The feature does not target a VS Code
window instance and does not use a private focus command.

The failed exact-window-focus spike proved that cross-window routing reached
the requested Workspace Extension Host, but VS Code rejected
`workbench.action.focusWindow` because that command is not registered. That
mechanism is not part of the production design.

## Product Semantics

- A card represents a project, not a VS Code window.
- Project identity is the normalized canonical workspace URI.
- The same project published by multiple windows produces one card.
- If the current window contains that project, its current card wins and no
  navigation duplicate is rendered.
- Otherwise the most recently focused live publisher supplies display metadata
  and ordering for the navigation card.
- Clicking a navigation card asks VS Code to open the project's canonical URI
  with the same logic used by existing saved project cards. VS Code may focus
  an existing window; if no reusable window remains, it may open the project.
- The design intentionally does not distinguish two windows that contain the
  same project.

## Goals

- Show all distinct projects open in live Project Steward windows within the
  current Profile.
- Cover local, Remote SSH, WSL, Dev Container, and other remote workspaces.
- Keep current-window cards first and fully session-capable.
- Make other cards lightweight project-switch shortcuts.
- Reuse the already working `openProject` and `vscode.openFolder` path.
- Keep installation and operation equivalent to the existing main-extension
  plus UI-Bridge architecture.
- Avoid heartbeat-only Webview refreshes.

## Non-goals

- Discovering windows from another VS Code Profile or physical machine.
- Focusing an exact VS Code window instance.
- Keeping duplicate cards for the same canonical project URI.
- Showing or managing sessions from navigation-only cards.
- Showing attention, Save, Favorite, provider, or context-menu controls on a
  navigation-only card.
- Adding OS-specific window automation, a VS Code CLI relay, or private
  workbench commands.
- Supporting mixed old/new protocol versions before the feature's first public
  release.

## Architecture

### 1. Workspace Publisher

Every Project Steward Workspace Extension instance owns a random activation
`instanceId`. It publishes the projects returned by the same current-workspace
logic that already builds `OPEN PROJECT`.

The publisher writes immediately on activation and again when:

- workspace folders or the workspace file change;
- project display metadata changes;
- the window becomes focused;
- the ten-second heartbeat is due.

`lastFocusedAtMs` changes only when the window becomes focused. Heartbeats
update only `leaseUpdatedAtMs`. Normal deactivation performs a best-effort
unregister; a thirty-second lease removes registrations left by crashes or
lost remote connections.

Empty windows publish an empty project list and produce no cards.

### 2. Profile-Local Registry

The UI-kind Local Bridge stores one validated registration per Workspace
Extension under its existing Profile-local storage root:

```text
open-projects/v1/instances/<instanceId>.json
```

The registry reuses the existing bridge-store safety properties:

- atomic temporary-file replacement;
- owner-specific files and monotonic sequence values;
- bounded file, array, and string sizes;
- regular-file and symlink checks;
- restrictive local permissions;
- lease validation and stale cleanup;
- malformed-file isolation.

There are no focus-request or focus-result files.

### 3. Aggregation

Each Local Bridge watches the shared registry directory and also performs a
bounded periodic fallback scan. It publishes a semantic aggregate to the
Workspace Extension in its own window.

The semantic revision includes instance identity, project descriptors, and
`lastFocusedAtMs`; it excludes sequence and lease-only timestamps. A heartbeat
therefore does not refresh the dashboard.

### 4. Dashboard Projection

The current window's cards continue to come directly from `getOpenProjects()`.
They are never reconstructed from cross-window data, so their sessions,
provider state, expansion state, terminal highlighting, attention state, and
management controls remain unchanged.

The projection then:

1. normalizes every current and published project URI;
2. reserves all current-window project identities;
3. groups remaining records by canonical project identity;
4. chooses the record from the most recently focused publisher in each group;
5. sorts navigation records by descending `lastFocusedAtMs`, then stable
   project ordinal and canonical identity;
6. appends navigation-only cards after all current cards.

The renderer models behavior explicitly:

```ts
type OpenProjectCardKind = 'current' | 'projectNavigation';
```

A navigation card contains no AI-session view models.

### 5. Navigation

Clicking a navigation card follows the existing project-selection path:

1. The Webview sends the navigation card ID through `selected-project`.
2. The Workspace Extension resolves that ID from its latest projected
   navigation map; it does not accept an arbitrary URI from the Webview.
3. The latest registry aggregate is checked to reject a card that has already
   disappeared locally.
4. The resulting transient `Project` is passed to the existing `openProject`.
5. `openProject` preserves current Local, SSH, WSL, Dev Container, and generic
   remote handling and invokes `vscode.openFolder` or the existing remote
   opening branch.

Ctrl/Cmd click and middle click do not add special behavior to a navigation
card. Its single action is project switching.

## Data Contracts

```ts
interface OpenProjectRegistration {
  protocolVersion: 1;
  instanceId: string;
  sequence: number;
  lastFocusedAtMs: number;
  leaseUpdatedAtMs: number;
  projects: OpenProjectRecord[];
}

interface OpenProjectRecord {
  localProjectId: string;
  ordinal: number;
  name: string;
  description: string;
  uri: string;
  remoteType: 'local' | 'ssh' | 'wsl' | 'devContainer' | 'remote';
  color?: string;
}

interface OpenProjectAggregate {
  protocolVersion: 1;
  semanticRevision: string;
  observedAtMs: number;
  registrations: OpenProjectRegistration[];
}
```

Registration IDs are fixed-length random hexadecimal strings. A registration
contains at most 100 project records. Validators reject unknown keys, invalid
remote types, non-finite timestamps, oversized strings/files, malformed JSON,
and non-regular files.

`uri` is the canonical Project Steward path already resolved by the owning
Workspace Extension. Remote authorities and workspace paths are allowed in
Profile-local storage because they are required for project identity and
navigation; credentials and unrelated environment data are not published.

## User Interface

`OPEN PROJECT` remains a sticky system group.

Current-window cards:

- remain first and retain the current-workspace highlight;
- toggle AI sessions when clicked;
- retain provider selection, New Session, Manage, session actions, terminal
  highlighting, and attention rendering;
- remain session-capable for every root in a multi-root workspace.

Navigation-only cards:

- use the existing project-card visual language;
- show project name and Local, SSH, WSL, Dev Container, or Remote environment;
- expose a dedicated `data-project-navigation` marker;
- show a `Switch to this project` hover affordance;
- do not render sessions, counts, attention, provider controls, Save,
  Favorite, project actions, or context menus.

## Failure Handling

- A card absent from the latest aggregate is rejected and the view refreshes.
- `vscode.openFolder` and remote-opening failures are logged and shown through
  the existing Project Steward error path.
- Normal window closure unregisters immediately; crash cleanup is lease-based.
- A narrow close/click race may reopen a project because navigation is
  deliberately project-based. Exact closed-window detection is impossible
  without a public window-targeting API.
- Registry or bridge failures never remove the current window's own cards.

## Performance

Each active window writes one small registration at most once per ten-second
heartbeat, plus immediate writes for workspace or focus changes. Semantic
comparison prevents lease-only writes from refreshing the Webview.

Navigation-only cards never scan provider session histories. Only the current
window's existing project path loads session data.

## Testing

Automated checks cover:

- strict protocol validation and semantic revision behavior;
- atomic registry writes, malformed data, symlinks, bounds, leases, and
  monotonic sequences;
- canonical project identity and cross-window deduplication;
- current-card precedence and current-first ordering;
- recent-focus ordering for navigation cards;
- navigation cards containing no session or attention state;
- Webview click routing through `selected-project` and the existing
  `openProject` path;
- build, lint, bridge bundling, packaging, and existing AI-session regressions.

Manual verification covers Local, SSH, and Dev Container projects, confirms
that clicking a navigation card switches through the same behavior as a saved
repository card, and checks that the visible project list converges after a
window closes.

## Delivery

The main extension and UI Bridge are updated together. The disposable exact
focus spike code is removed after its failed result is retained in the
feasibility report. No compatibility or migration layer is added before the
feature's first public release.
