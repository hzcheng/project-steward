# Workspace-First Support Design

Date: 2026-07-20
Status: Approved

## Decision

Project Steward will treat the VS Code workspace as the primary object in the
live `OPEN` view. A VS Code window with one folder and a window with a
multi-root workspace will have the same product model: one workspace, one card,
and one flat AI-session surface.

Workspace folders are execution roots inside that workspace. They are not
separate `CURRENT WORKSPACE` cards and are not published as separate
`OTHER WINDOWS` navigation cards.

When an AI session starts, Project Steward selects one workspace folder as its
primary working directory and grants the provider access to every other
workspace folder through its native additional-directory option. The installed
Codex, Kimi, and Claude CLIs all expose `--add-dir`; Codex documents the option
as repeatable additional writable roots alongside the primary workspace.

This is a hard cutover for the live workspace, cross-window, and runtime-state
models. Project Steward will not implement v1/v2 dual reads, runtime-binding
migrations, or root-card compatibility projection. Existing saved projects,
groups, favorites, colors, descriptions, and paths remain intact because the
`PROJECTS` data model does not need to change.

## Problem

The current implementation mixes two identities:

- the VS Code window and workspace implied by the labels `CURRENT WORKSPACE`
  and `OTHER WINDOWS`;
- each individual workspace folder represented by a `Project` card.

An untitled multi-root workspace therefore produces several current cards and
publishes several cross-window records. Clicking one of those navigation cards
opens that folder with `forceNewWindow`, which can create a new single-folder
window instead of switching to the existing multi-root workspace.

Saved `.code-workspace` files already produce one card and can aggregate
session histories from their folders, but session creation still derives a
single `cwd` from the workspace project path and does not pass any additional
workspace roots to the provider. The saved and untitled cases consequently
have different presentation and incomplete execution semantics.

## Research Basis

VS Code defines a workspace as the collection of zero or more folders open in
one editor window. A multi-root workspace can be saved as a `.code-workspace`
file or represented by an `untitled:` workspace URI. The Extension API exposes
both `workspace.workspaceFile` and `workspace.workspaceFolders`; it documents
that a workspace-file URI, including an untitled URI, can be supplied to
`vscode.openFolder` to open the workspace again.

References:

- [What is a VS Code workspace?](https://code.visualstudio.com/docs/editing/workspaces/workspaces)
- [Multi-root workspaces](https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces)
- [VS Code workspace API](https://code.visualstudio.com/api/references/vscode-api#workspace)
- [Codex CLI command reference](https://learn.chatgpt.com/docs/developer-commands.md?surface=cli)

Local provider capability checks on 2026-07-20 confirmed:

```text
codex --help   -> --cd <DIR>, repeatable --add-dir <DIR>
kimi --help    -> --work-dir <DIR>, repeatable --add-dir <DIR>
claude --help  -> --add-dir <directories...>
```

`--add-dir` grants directory access. It does not replace the need for a primary
working directory, which remains the location used for relative commands,
project-local configuration discovery, and the session's recorded `cwd`.

## Goals

- Make single-folder and multi-root workspaces feel like the same product.
- Render at most one current-workspace card per VS Code window.
- Render at most one navigation card per logical workspace in other windows.
- Keep AI sessions in one flat list while retaining a lightweight indication
  of each session's primary workspace folder.
- Give new and resumed Codex, Kimi, and Claude sessions access to every current
  workspace folder.
- Preserve Direct Terminal and tmux behavior through one provider-neutral
  directory-scope contract.
- Save a multi-root workspace as one saved project.
- Preserve all existing saved-project data.
- Fail closed instead of silently reducing a multi-root session to one folder
  or opening a workspace folder in a new window.

## Non-goals

- Migrating v1 cross-window registrations or root-card view state.
- Reattaching legacy runtime bindings to the new workspace-aware runtime model.
- Automatically merging or deleting saved folder projects that happen to be
  members of a workspace.
- Distinguishing historical sessions created from two different workspace
  files that contain the same folder roots. Provider histories record a
  working directory, not the originating `.code-workspace` file.
- Dynamically changing the directory permissions of an already running
  provider process when workspace folders change.
- Publishing AI-session details across windows.
- Adding OS-specific window automation.

## Product Invariants

1. One VS Code workspace produces one `CURRENT WORKSPACE` card.
2. Workspace folders never become sibling workspace cards.
3. One logical workspace produces at most one `OTHER WINDOWS` card.
4. A workspace navigation action never falls back to opening one member folder.
5. A multi-root AI session either receives every valid workspace root or does
   not start.
6. A session has one primary `cwd`, even when it can access multiple roots.
7. Saved projects and live workspaces are separate domain models.

## Domain Model

### Workspace roots

```ts
type OpenWorkspaceKind =
  | 'singleFolder'
  | 'savedMultiRoot'
  | 'untitledMultiRoot';

interface WorkspaceRoot {
  id: string;
  name: string;
  uri: string;
  hostPath: string;
  ordinal: number;
}
```

`uri` is the canonical VS Code resource identity. `hostPath` is the path the AI
CLI can use inside the active Extension Host. For SSH, WSL, and Dev Container
windows, it is the path visible on that remote host, not a
`vscode-remote://...` URI.

Root IDs are deterministic hashes of normalized root URIs. Root order remains
available for display and primary-directory fallback but does not affect root
or workspace scope identity.

### Open workspace

```ts
interface OpenWorkspace {
  navigationIdentity: string;
  scopeIdentity: string;
  kind: OpenWorkspaceKind;
  displayName: string;
  navigationUri: string;
  environment: 'local' | 'ssh' | 'wsl' | 'devContainer' | 'remote';
  roots: WorkspaceRoot[];
}
```

The model deliberately has two identities:

- `navigationIdentity` answers which workspace VS Code should switch to. It is
  derived from the only folder URI for a single-folder workspace, the saved
  workspace-file URI for a saved multi-root workspace, or the `untitled:` URI
  for an untitled multi-root workspace.
- `scopeIdentity` answers which collection of directory roots owns session
  histories and workspace-level view state. It is a hash of the sorted,
  normalized root URIs.

Saving an untitled workspace changes `navigationIdentity` but not
`scopeIdentity`. Reordering folders changes neither. Adding or removing a
folder changes `scopeIdentity`. Renaming a workspace changes only display
metadata.

Two saved workspace files containing the same roots keep distinct navigation
identities but share the same observable provider history because history can
only be assigned by `cwd`.

An empty VS Code window has no `OpenWorkspace` and renders the existing empty
state.

### Session directory scope

```ts
interface AiSessionDirectoryScope {
  workspaceNavigationIdentity: string;
  workspaceScopeIdentity: string;
  workspaceRootHostPaths: string[];
  primaryRootId: string;
  primaryCwd: string;
  additionalDirectories: string[];
}
```

Runtime, pending, terminal-binding, and tmux identities replace the overloaded
`projectKey` with `workspaceScopeIdentity` while retaining the exact `cwd`.
The workspace key determines card ownership; `cwd` determines execution and
the folder label shown on the session row. Runtime metadata also snapshots the
launch-time navigation identity and complete normalized root-path set so a
folder transition can be reconciled without changing the provider's live
permissions.

## Current Workspace UI

`CURRENT WORKSPACE` contains zero or one card. The card shows:

- `vscode.workspace.name`, falling back to the workspace-file basename or the
  single root name;
- environment and folder count, for example `Local · 3 folders`;
- workspace roots as lightweight tags or expandable metadata, never as
  navigable project cards;
- the existing `ACTIVE` and `SESSIONS` tabs;
- one flat session list across all roots;
- a small root-name chip on each session row only when the workspace contains
  more than one root;
- the existing provider, attention, pin, archive, terminal, and tmux state;
- a primary `New AI Session` action and a secondary `New Session in…` action.

The selected layout is intentionally flat. Grouping sessions by root would
reintroduce the multi-project switching model the feature removes. Completely
hiding roots would make incorrect `cwd` selection and similarly named sessions
difficult to diagnose.

## Primary Directory Selection

The primary root for a new session is selected in this order:

1. an explicit choice from `New Session in…`;
2. the workspace folder containing the active editor document;
3. the most recently used primary root stored for the current
   `scopeIdentity`;
4. the first valid root in workspace order.

The main `New AI Session` action never shows a folder picker. Provider
selection and the existing optional session-title flow remain unchanged.

An explicit root choice changes only the primary working directory. Every
other workspace root remains accessible.

## Provider Launch Semantics

The provider definitions will consume `AiSessionDirectoryScope` rather than a
single `cwd`. Each builder produces a structured `AiSessionLaunchSpec`; Direct
Terminal and tmux serialize the same launch spec rather than rebuilding shell
commands independently.

Conceptually, new sessions launch as:

```text
codex --cd <primary> --add-dir <other-1> --add-dir <other-2>
kimi --work-dir <primary> --add-dir <other-1> --add-dir <other-2>
(cwd=<primary>) claude --add-dir <other-1> <other-2>
```

Provider builders must use each CLI's native argument shape. They must not
construct one interpolated shell fragment and must preserve the existing
platform-specific serialization and marker behavior.

For resume:

1. keep the session's recorded `cwd` when it still belongs to a current root;
2. otherwise require an explicit current root choice;
3. add every other current workspace root through the provider's additional
   directory option;
4. use the workspace's current scope rather than the directories present when
   the historical session was first created.

The active runtime stores an immutable directory-scope snapshot. Adding or
removing a workspace folder does not mutate a running provider process. The
next new or resumed run uses the current workspace roots.

## Session Discovery and Assignment

The session scanner receives every `hostPath` from the current workspace. It
reads each provider once and assigns sessions through a provider-neutral
matcher:

1. normalize the session `cwd` or `workDir`;
2. find roots that contain that path;
3. choose the longest matching root path when roots are nested;
4. assign the session to the single current workspace and record the matching
   `primaryRootId`;
5. de-duplicate by provider session identity before rendering.

Pending and active runtimes use the same assignment rule. A running session
whose primary root is removed remains visible until the run ends with an
`Outside workspace` root chip. Once inactive, it is no longer included in the
current workspace's historical list.

The runtime coordinator may retain that outside-workspace association only
while it can prove continuity: the same live owner, an unchanged navigation
identity, or overlap between the current roots and the runtime's launch-time
root snapshot. If a workspace transition restarts the Extension Host and no
such evidence remains, Project Steward leaves the provider process running but
does not adopt it into the new card. It never guesses ownership from a process
name or provider alone.

The assignment layer must not create one hydrated `Project` per candidate
path. One `OpenWorkspace` owns all assignments.

## Attention

Raw attention events remain session/root facts so current lifecycle evidence
does not need a new artificial workspace origin. Workspace projection gathers
attention for every current root and de-duplicates by provider session key and
event ID.

The current workspace card shows the resulting workspace-level count and its
session rows show their individual unread state. `OTHER WINDOWS` records expose
only enough root identity metadata to join the separate privacy-bounded
attention aggregate. They do not include session names, provider histories,
reasons, prompts, or terminal state.

## Cross-Window Protocol v2

The v1 open-project protocol is replaced with a workspace protocol. Each
Workspace Extension instance publishes zero or one record:

```ts
interface OpenWorkspaceRootRecord {
  id: string;
  name: string;
  uri: string;
  ordinal: number;
}

interface OpenWorkspaceRecord {
  navigationIdentity: string;
  scopeIdentity: string;
  kind: OpenWorkspaceKind;
  displayName: string;
  navigationUri: string;
  environment: OpenWorkspaceEnvironment;
  roots: OpenWorkspaceRootRecord[];
}

interface OpenWorkspacePublicationV2 {
  protocolVersion: 2;
  instanceId: string;
  sequence: number;
  followsFocusEvent: boolean;
  workspace: OpenWorkspaceRecord | null;
}
```

The desktop UI Bridge continues to own focus and lease timestamps in one clock
domain. The Profile-local registry moves to an `open-workspaces/v2` namespace
and retains atomic writes, owner-specific files, bounded payloads, symlink and
regular-file checks, malformed-file isolation, and stale-lease cleanup.

The aggregate contains one registration per live `instanceId`. Dashboard
projection:

1. excludes the current instance;
2. reserves the current workspace's `navigationIdentity`;
3. groups remaining live registrations by `navigationIdentity`;
4. chooses display metadata from the most recently focused publisher;
5. sorts cards by descending last-focused time and stable identity;
6. renders one navigation-only card per logical workspace.

No v1 parser, v1 projection adapter, or mixed-version data merge is included.
The main extension and UI Bridge perform an exact protocol-capability handshake.
On mismatch, the current card and local session management remain available,
while `OTHER WINDOWS` shows an update-required state.

## Other Windows UI and Navigation

An `OTHER WINDOWS` card shows the workspace name, environment, root count, and
workspace-level unread attention count. It does not expand roots or expose
session details.

Clicking a navigation card means only “switch to this workspace”:

1. resolve the opaque card ID against the latest in-memory aggregate;
2. confirm that at least one matching registration remains live;
3. use only the record's `navigationUri`;
4. never substitute a member root URI;
5. refresh without opening anything if the target disappeared.

Before production implementation, a real VS Code feasibility gate must prove
whether `vscode.openFolder(navigationUri)` focuses an already open window for
single-folder, saved multi-root, and untitled multi-root workspaces. The matrix
must cover local, SSH, WSL, and Dev Container windows.

For a workspace kind that cannot switch reliably:

- a saved workspace invokes VS Code's native Switch Window picker;
- an untitled workspace asks the user to save it first;
- if the native switch command is unavailable, Project Steward shows an
  actionable warning and performs no open action.

Opening a workspace member as a new single-folder window is never an allowed
fallback. Any acceptance test that observes this behavior fails the feature.

## Saving Workspaces

`PROJECTS` continues to persist the existing `Project` shape. The live
workspace layer supplies a saved-project adapter:

- a single-folder workspace saves its folder URI as one project;
- a saved multi-root workspace saves its `.code-workspace` URI as one project;
- an untitled multi-root workspace first invokes VS Code's
  `Save Workspace As…` flow and saves only after a stable workspace-file URI is
  available.

The save flow records a bounded, expiring pending intent before invoking VS
Code because saving a workspace can restart the Extension Host. On activation,
the intent is completed only when the saved workspace's root-set fingerprint
matches the original `scopeIdentity`; cancellation, timeout, or a different
workspace clears the intent without creating a project.

Existing saved projects are unaffected. Previously saved member folders remain
separate entries in `PROJECTS`; Project Steward does not merge or delete them.
Saving the encompassing workspace later adds one workspace project alongside
those existing entries.

## Search

Global search groups become:

```text
AI SESSIONS
OPEN WORKSPACES
SAVED PROJECTS
```

The current workspace contributes one open-workspace result. Other live
workspaces contribute one result per `navigationIdentity`. Session results
reveal the owning workspace card and the session row; they never target a
synthetic root card.

## Workspace Changes

`WorkspaceContextResolver` rebuilds the snapshot when workspace folders,
workspace file, workspace name, saved-project display metadata, remote context,
or window focus publication state changes.

Incremental update rules are:

- display-only changes refresh the card and publication metadata;
- root reorder refreshes display order but not scope-owned state;
- root addition or removal invalidates session assignment and provider-read
  candidate paths;
- untitled-to-saved transition changes navigation publication without clearing
  session or view state;
- workspace closure unregisters the publication and renders the empty state.

Semantic revisions exclude lease-only heartbeat changes so the Webview is not
refreshed every ten seconds.

## Failure and Security Handling

- If any workspace root cannot resolve to a valid directory visible to the
  Extension Host, multi-root session creation and resume are blocked with the
  affected root names. Project Steward does not silently omit them.
- If a provider is absent or its installed CLI does not support `--add-dir`,
  multi-root creation and resume are disabled for that provider with an upgrade
  message. Capability checks are cached per provider executable and Extension
  Host activation.
- Workspace roots are the maximum automatic access boundary. Project Steward
  never grants a common parent merely to shorten arguments.
- In VS Code Restricted Mode, workspace cards and history remain visible, but
  actions that launch or resume an AI coding process are disabled until the
  workspace is trusted.
- Structured argument arrays, existing platform serializers, length bounds,
  and control-character validation apply before any Direct Terminal or tmux
  launch.
- A stale or malformed cross-window record is isolated and cannot remove the
  current window's own card.
- Registry or UI Bridge failure degrades only `OTHER WINDOWS`.

## Component Boundaries

The implementation will use explicit, testable components:

- `WorkspaceContextResolver`: VS Code state to `OpenWorkspace`.
- `WorkspaceIdentity`: URI normalization, navigation identity, root identity,
  and scope identity.
- `WorkspaceSessionAssignment`: history, pending, and active runtime assignment.
- `WorkspaceLaunchScope`: primary-root selection and immutable launch scope.
- `ProviderLaunchBuilder`: provider-native arguments from one directory scope.
- `OpenWorkspaceProtocolV2`: publication, registration, aggregate validation,
  and semantic revision.
- `WorkspaceViewProjection`: current card, other-window cards, search items, and
  workspace-level attention.
- `SavedWorkspaceProjectAdapter`: stable save and reopen behavior without
  changing the persisted project schema.

No component may infer workspace semantics from `Project.path`. The live view
does not use `Project[]` as its source model.

## Compatibility and Cutover

The release is intentionally incompatible for transient and runtime state:

- v1 open-project registry entries are ignored;
- root-based OPEN card IDs and collapse/provider state are not migrated;
- old terminal and tmux runtime bindings are not adopted by the new runtime
  identity model;
- existing provider processes are not terminated, but users must recreate or
  resume them under the new model if they want Project Steward management;
- stale v1 files expire or are cleaned independently and never enter v2 data
  flow.

The saved-project store is preserved in full. This is not a compatibility
adapter; it remains the correct domain model for the unchanged `PROJECTS`
feature.

## Performance

One current workspace replaces N root cards and one cross-window record
replaces N project records. Provider histories are scanned once per provider
against a bounded root-path set. Assignment uses normalized longest-prefix
matching and de-duplicates sessions before view-model creation.

Navigation cards remain lightweight and never trigger provider-history scans.
Semantic revisions and existing incremental Webview update paths prevent
heartbeat-only or display-unrelated refreshes.

## Automated Testing

Pure and integration checks cover:

- empty, single-folder, saved multi-root, and untitled multi-root snapshots;
- local, SSH, WSL, Dev Container, and generic remote root resolution;
- deterministic identities across root reorder, workspace save, rename, add,
  and remove operations;
- nested roots with longest-prefix assignment;
- history, pending, Direct Terminal, and tmux sessions assigned to one card;
- new and resumed Codex, Kimi, and Claude launch specs;
- paths containing whitespace, quotes, Unicode, shell metacharacters, and path
  separators from each supported platform;
- no partial launch when one additional directory is invalid;
- immutable active-runtime directory snapshots;
- removed-root `Outside workspace` projection;
- attention aggregation and event/session de-duplication across roots;
- strict v2 protocol validation, bounds, atomic storage, malformed records,
  symlinks, leases, unregister, and semantic revisions;
- exact capability mismatch behavior with no v1 fallback;
- exactly zero or one current card and at most one navigation card per
  `navigationIdentity`;
- search results revealing workspace and session targets;
- Save Workspace As cancellation, Extension Host restart, intent expiry, root
  mismatch, and successful saved-project creation;
- Restricted Mode and provider capability failures.

## Manual Acceptance Matrix

Before release, test every practical combination of:

- Local, Remote SSH, WSL, and Dev Container;
- single-folder, saved multi-root, and untitled multi-root;
- Codex, Kimi, and Claude;
- Direct Terminal, project-layout tmux, and session-layout tmux;
- new session, resume, active focus/attach, attention, archive, root changes,
  Save Workspace As, window close, and cross-window navigation.

Mandatory hard gates:

1. `CURRENT WORKSPACE` never renders more than one card.
2. Every launched multi-root provider can access all valid workspace roots.
3. Every session shows the correct primary-root chip.
4. Root changes do not silently mutate a running provider's directory scope.
5. `OTHER WINDOWS` never renders multiple cards for one workspace identity.
6. Clicking an other-window card never opens one workspace member as a new
   single-folder window.
7. Existing saved projects remain byte-for-byte semantically equivalent after
   activation and ordinary use.

## Success Criterion

When a user moves from a single-folder window to a multi-root workspace, the
only new concepts they need to notice are the folder count and the small
primary-directory chip on each AI session. Every other Project Steward action
continues to feel workspace-level and single-card.
