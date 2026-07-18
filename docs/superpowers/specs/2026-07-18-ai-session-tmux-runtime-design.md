# AI Session Tmux Runtime Design

Date: 2026-07-18

Status: Approved in design discussion; awaiting written-spec review

## Summary

Project Steward will support two AI session runtime backends:

- the existing VS Code integrated terminal backend;
- a persistent tmux backend.

The tmux backend separates the AI provider process from the VS Code terminal used to view it. Closing or losing the attach terminal therefore does not stop the AI session. Project Steward can discover the managed tmux runtime later and attach a new terminal client without starting a duplicate provider process.

Tmux supports two layouts:

- `project`, the default: one tmux session per project and one tmux window per AI session;
- `session`: one tmux session per AI session.

The default runtime mode remains `vscode`, so existing users retain the current behavior until they explicitly enable tmux.

## Problem

Project Steward currently treats a VS Code `Terminal` as both the visible client and the lifetime owner of an AI session. It uses terminal objects, process-ID bindings, and completion marker files to support new-session matching, active-session projection, attention, reload recovery, focus, close, and archive guards.

This model cannot preserve an AI provider process after its visible terminal is closed or after VS Code disconnects from an SSH host or Dev Container. It also cannot discover a still-running process if the original terminal object no longer exists.

The feature must let users run long-lived Codex, Kimi, and Claude sessions in tmux while preserving the current Project Steward session-management experience.

## Product Goals

1. Let an AI provider process survive closure of its VS Code terminal client while the execution host remains awake and running.
2. Reattach to an existing managed tmux runtime instead of starting a duplicate provider process.
3. Support both new AI sessions and resumed history sessions.
4. Make one project tmux session with one window per AI session the default tmux organization.
5. Offer a one-tmux-session-per-AI-session isolation layout.
6. Let each execution machine configure its own tmux executable path.
7. Preserve Direct Terminal behavior, provider discovery, aliases, pins, archive behavior, attention, and Active/History tabs.
8. Keep tmux lifecycle handling provider-neutral.

## Non-Goals

- Installing or upgrading tmux.
- Supporting native Windows extension hosts in V1.
- Keeping work running while a laptop sleeps, a host shuts down, or a container stops.
- Configuring a custom tmux socket, server name, configuration file, or additional tmux arguments.
- Migrating a running AI process between Direct Terminal, project tmux layout, and session tmux layout.
- Providing a tmux session browser or general tmux management UI.
- Providing a Project Steward action to kill a tmux session or window.
- Using panes for separate AI sessions; each managed AI process owns a full tmux window.
- Giving multiple clients attached to one project tmux session independent current-window selection.
- Taking ownership of user-created tmux sessions, windows, or panes.
- Replacing provider-native session storage or discovery.

## Confirmed Product Decisions

### Global runtime preference

Runtime mode is a machine-scoped global preference for all projects and providers. It is not selected for every new session.

The preference controls only creation of a new runtime. If a selected AI session already has a live managed runtime, Project Steward reuses that runtime even when the current mode or tmux layout setting differs.

### Explicit fallback

Project Steward never silently falls back from tmux to Direct Terminal. If tmux cannot be used, the user may explicitly choose Direct Terminal for that operation or open settings.

### Detach does not terminate

Closing a VS Code terminal attached to tmux only detaches the client. It does not kill the managed tmux window or provider process. V1 does not add a force-terminate action; users reattach and exit the provider normally.

### Project layout is the default

In `project` layout, the project card is the organization boundary:

```text
Project card
└── managed tmux session
    ├── window: Codex session A
    ├── window: Codex session B
    └── window: Claude session C
```

The layout keeps at most one Project Steward attach terminal per project in each VS Code extension instance. Selecting different AI sessions focuses that terminal and selects the matching tmux window.

### Shared current window across clients

A tmux session has one current window. If the same project tmux session is attached from multiple VS Code windows, selecting an AI session in one client also changes the current tmux window shown by the other clients. V1 accepts this standard tmux behavior and does not create grouped viewer sessions.

## Settings

### Runtime mode

```json
"projectSteward.aiSessionTerminalMode": "vscode"
```

Schema:

- type: `string`;
- enum: `vscode`, `tmux`;
- default: `vscode`;
- scope: `machine`.

The description must state that tmux preserves a process only while its execution host remains awake and running.

### Tmux layout

```json
"projectSteward.aiSessionTmuxLayout": "project"
```

Schema:

- type: `string`;
- enum: `project`, `session`;
- default: `project`;
- scope: `machine`.

Descriptions:

- `project`: group AI sessions as windows in one managed tmux session per project;
- `session`: run every AI session in its own managed tmux session.

### Tmux executable

```json
"projectSteward.aiSessionTmuxPath": "tmux"
```

Schema:

- type: `string`;
- default: `tmux`;
- scope: `machine`.

`tmux` resolves through the current extension host's `PATH`. An absolute executable path is also accepted. The value represents one executable only; it cannot contain additional tmux arguments or a shell command. Machine scope prevents the value from being synchronized between machines and allows local and remote settings to differ.

## User Experience

### Direct Terminal mode

All current behavior remains unchanged. Project Steward creates or reuses a VS Code terminal, sends the provider command, tracks the process-ID binding, and uses the completion marker as it does today.

### Project tmux layout

When a user creates or resumes an AI session:

1. Project Steward checks all runtime backends for an existing runtime.
2. If no runtime exists, it ensures the project tmux session exists.
3. It creates or reuses the managed tmux window for the AI session.
4. It focuses an existing project attach terminal or opens one attach terminal.
5. It selects the managed window for the chosen AI session.

The terminal title is:

```text
Project Steward: <project name> [tmux]
```

### Session tmux layout

Each AI session uses a separate managed tmux session. Project Steward creates at most one attach terminal per AI session in each extension instance.

The terminal title is:

```text
<provider>: <session display name> [tmux]
```

### Active rows

Tmux-backed rows remain in `ACTIVE` while their managed tmux runtime exists, even if no VS Code terminal is attached. They have a quiet `tmux` indicator so the backend remains visible after the global mode or layout is changed.

Clicking an active tmux row attaches or focuses its viewer and selects the corresponding window. The focused-row projection follows the selected managed tmux window when Project Steward refreshes runtime state.

For tmux-backed rows, `Close Terminal...` becomes `Detach Terminal...`:

- in project layout it closes the shared project attach terminal;
- in session layout it closes the selected session's attach terminal;
- neither action changes the runtime's active state.

The confirmation text explicitly states that the AI task will keep running in tmux.

### Tmux unavailable

For a new runtime, the warning offers:

- `Use VS Code Terminal This Time`;
- `Open Settings`.

If Project Steward has a persisted hint that the AI session previously used tmux but cannot verify it, the fallback action becomes `Resume in VS Code Anyway` and uses a modal duplicate-runtime warning.

No warning is displayed merely because a silent background discovery finds no tmux executable while Direct Terminal mode is selected and there is no relevant known tmux runtime.

## Runtime Architecture

```text
Creation, resume, focus, detach, archive, and attention controllers
                              │
                              ▼
                 AiSessionRuntimeCoordinator
                    ┌─────────┴─────────┐
                    ▼                   ▼
        DirectTerminalRuntimeBackend   TmuxRuntimeBackend
                                       ├── ProjectTmuxLayout
                                       └── SessionTmuxLayout
```

### AiSessionRuntimeCoordinator

The coordinator exposes backend-neutral operations:

- `findRuntime(identity)`;
- `createRuntime(request)`;
- `focusRuntime(runtime)`;
- `detachClient(runtime)`;
- `listActiveRuntimes()`;
- `getRuntimeCompletion(runtime)`.

The runtime identity contains provider ID, provider session ID when known, project key, and cwd. A runtime record contains its backend, optional tmux layout and locator, lifecycle state, completion marker, and optional attached VS Code terminal.

Lookup is independent of the current preference:

1. refresh known Direct Terminal bindings;
2. refresh both managed tmux layouts when tmux is available;
3. return the one matching live runtime;
4. report a conflict if more than one live runtime matches;
5. use current settings only if no live runtime exists.

The coordinator owns in-process single-flight guards so repeated clicks in one extension instance share the same lookup or creation promise.

### DirectTerminalRuntimeBackend

This backend adapts the existing `AiSessionTerminalService`. Existing process-ID persistence, completion markers, pending matching, terminal focus, terminal close, and reload behavior remain scoped to Direct Terminal runtimes.

### TmuxRuntimeBackend

The tmux backend contains four focused components.

#### TmuxClient

`TmuxClient` invokes the configured executable with argument arrays and `shell: false`. It provides typed operations for:

- availability and capability checks;
- listing sessions and windows;
- reading and writing user options;
- creating, renaming, selecting, and attaching sessions or windows;
- checking postconditions after creation;
- detecting clients and current windows.

`no server running` from a list operation means tmux is available with zero runtimes, not an availability error.

#### TmuxLayoutStrategy

`ProjectTmuxLayout` and `SessionTmuxLayout` map a runtime request to a tmux locator and implement only layout-specific ensure, select, and attach behavior. Discovery, launch construction, lifecycle state, metadata validation, persistence, and error handling are shared.

#### TmuxRuntimeDiscovery

Discovery enumerates managed session/window metadata and builds backend-neutral runtime records. It deduplicates concurrent refreshes and maintains a short-lived cache. A forced refresh occurs before creation or resume. Background refresh runs with existing AI session/attention refresh activity and while the relevant dashboard view is visible; it does not spawn an unbounded process per rendered row.

#### TmuxAttachTerminalRegistry

The registry maps a project key or AI session identity to the visible VS Code terminal client for the current extension instance. Terminal closure removes only this attachment record. Runtime state continues to come from tmux discovery.

On terminal creation, the configured tmux executable is used as the terminal shell with attach arguments. An inherited `TMUX` variable is removed from the attach terminal environment to avoid a false nested-tmux refusal; other environment values are preserved.

## Provider Launch Specification

Provider definitions will produce a structured launch specification instead of making tmux parse an opaque command assembled by controllers:

```text
executable
args[]
cwd
completionMarker
```

Direct Terminal serializes the specification for the current platform using the existing marker behavior.

Tmux is supported only on POSIX extension hosts in V1. The tmux backend supplies a fixed `/bin/sh` lifecycle wrapper that:

1. removes a stale marker;
2. starts the provider command with every value POSIX-quoted;
3. records the provider exit status;
4. creates the completion marker;
5. exits with the provider exit status.

The resulting wrapper is passed as the tmux command argument. The outer Node process never executes the string through a shell. The wrapper does not open a fallback interactive shell, so the managed window disappears when the provider exits.

Provider executable resolution happens in the extension host environment. The runtime uses the same provider and cwd semantics as Direct Terminal mode.

## Identity and Tmux Metadata

All generated names are shell-safe, bounded, and derived from SHA-256 hashes. The first 16 hexadecimal characters are used, and metadata is always checked before reusing a matching name.

### Project layout names

```text
session: project-steward-p-<hash(project-key)>
window:  ai-<provider>-<hash(provider:session-id)>
```

### Session layout names

```text
session: project-steward-s-<provider>-<hash(provider:session-id)>
```

### Pending names

```text
project window: pending-<provider>-<random-id>
session layout: project-steward-pending-<provider>-<random-id>
```

### Metadata

Project Steward stores user options at the appropriate session or window scope:

```text
@project-steward-managed
@project-steward-version
@project-steward-layout
@project-steward-project-key
@project-steward-provider
@project-steward-session-id
@project-steward-pending-id
@project-steward-created-at
@project-steward-marker
```

Metadata is authoritative for ownership. A name match without compatible managed metadata is a collision; Project Steward does not attach to, rename, kill, or overwrite the target.

The metadata does not contain prompts, titles, provider commands, environment dumps, or transcripts. A provider session ID is an identity, not a credential, and is already exposed by existing Project Steward session actions.

Managed windows receive local options:

- `automatic-rename off`;
- `allow-rename off`;
- `remain-on-exit off`.

Project Steward does not modify global tmux options. Unmanaged windows in a managed project session are ignored and preserved. If the final managed window exits while an unmanaged window remains, the tmux session may remain but Project Steward reports no active AI runtime for it.

## Persistence

### Direct Terminal bindings

The existing workspace-scoped, process-ID-based terminal binding store remains unchanged for Direct Terminal runtimes.

### Tmux runtime bindings

A new `TmuxRuntimeBindingStore` uses a dedicated directory under the extension host's global storage. It stores one versioned JSON file per runtime or pending ID. The directory is local to the extension host and is not synchronized. Separate files avoid aggregate read-modify-write loss across VS Code windows and can be enumerated on the minimum supported VS Code 1.51 API.

Writes use a same-directory temporary file followed by atomic rename. Record filenames are hashes generated by Project Steward, not user-controlled values. Reads ignore symbolic links, non-regular files, invalid JSON, unsupported versions, and records outside the configured size bounds.

The store contains two bounded record types:

- `pending`: provider, project key, cwd, creation time, excluded provider session IDs, optional alias, layout, and tmux locator;
- `known`: provider, final session ID, project key, layout, tmux locator, and last-seen time.

Tmux metadata remains the runtime source of truth. `known` records are hints used to prevent silent duplicate resumes when tmux cannot currently be queried. Successful discovery reconciles or deletes stale hints. If a user explicitly chooses `Resume in VS Code Anyway`, the corresponding hint is cleared after the warning is accepted.

Pending records expire after 24 hours, matching the current pending-terminal bound. Known hints are capped at 512 records and use least-recently-seen pruning. A known hint that has not been confirmed by successful discovery for 30 days is removed. Expiration never kills or modifies a tmux target; a later successful discovery can reconstruct the hint from authoritative tmux metadata.

When pending matching succeeds, Project Steward writes final metadata, renames the target, creates the `known` hint, removes the pending record, and stores the alias using the existing alias store.

### Tmux attach-client bindings

Tmux runtime identity is independent of terminal PID, but a surviving VS Code attach terminal still needs reload recovery. A separate workspace-scoped `TmuxAttachTerminalBindingStore` saves one versioned record per terminal process ID:

- layout;
- project key;
- tmux session target;
- provider and provider session ID for session layout;
- terminal title prefix used to reject PID reuse.

On activation, Project Steward restores matching attach terminals into `TmuxAttachTerminalRegistry` after validating the process ID, terminal title, and managed tmux target. A missing or invalid client binding can create an extra viewer but cannot lose or duplicate the provider runtime. Terminal closure deletes only the client binding; it does not delete `TmuxRuntimeBindingStore` records or tmux metadata.

## Lifecycle

Runtime lifecycle and attachment lifecycle are independent:

```text
Runtime:    pending -> active -> completed
                              -> stopped

Attachment: detached <-> attached
```

- `pending`: provider started but its final session ID is not yet matched;
- `active`: the managed tmux window or independent session exists;
- `completed`: the provider wrapper created a current completion marker and the runtime ended;
- `stopped`: the runtime disappeared without a current completion marker;
- `attached`: a current-extension-instance VS Code terminal is attached;
- `detached`: no such terminal is attached.

Only `pending` and `active` appear in the `ACTIVE` tab. Completion integrates with existing attention lifecycle. `stopped` removes the active row without generating a false successful-completion or needs-input event.

Archive guards check active runtimes through the coordinator rather than only checking VS Code terminals.

## Main Flows

### Resume history session

1. Resolve project and provider session as today.
2. Force coordinator discovery across all backends and layouts.
3. Focus the single existing live runtime if found.
4. Show a conflict chooser if multiple live runtimes are found; never start another process in this state.
5. If no runtime exists, choose the configured backend and layout.
6. Build a structured provider resume launch specification.
7. Ensure the runtime once, verify metadata and postconditions, persist its hint, and attach or focus its client.

### Create new session

1. Pick provider and collect the optional title as today.
2. Capture existing session IDs for the project cwd.
3. Create and persist a pending runtime record before launching the provider.
4. Create the pending tmux window or session.
5. Attach or focus the viewer and start existing session refresh.
6. Resolve the provider's newly created session using cwd, creation time, and excluded IDs.
7. Write final metadata and rename the tmux target.
8. Replace the pending binding with a known hint and apply the alias.

If the attach client disappears at any point, pending resolution continues. On extension restart, persisted pending records and tmux metadata reconstruct the pending runtime.

### Focus project-layout session

1. Verify the managed project session and target window still exist.
2. Select the target window.
3. Show the existing attach terminal for that project, or create and attach one.
4. Refresh the selected-window projection used for focused-row styling.

Because current window belongs to the tmux session, all other clients attached to the same project session observe the same selection.

### Detach

1. Resolve the relevant attach terminal in the current extension instance.
2. Confirm that the AI task continues in tmux.
3. Dispose the terminal client.
4. Remove only the attach registry and persisted attach-terminal binding.
5. Force runtime discovery and keep the runtime in `ACTIVE`.

### Provider exit

1. The lifecycle wrapper writes the completion marker and exits.
2. With `remain-on-exit off`, the window closes.
3. Runtime discovery no longer reports it as active.
4. Existing completion and attention logic consumes the marker.
5. Discovery clears the known runtime hint after confirming absence.

### External stop

If a managed window or tmux server disappears without a current marker, Project Steward marks the runtime stopped, removes it from `ACTIVE`, clears its known hint, and logs a diagnostic without publishing a normal completion event.

### Setting changes

Changing mode, layout, or executable invalidates availability and discovery caches. Running runtimes are not renamed or migrated. Future lookup continues to inspect both layouts, and only creation of an absent runtime uses the new preference.

## Concurrency and Idempotency

Repeated clicks in one extension instance share an in-flight coordinator operation keyed by provider and provider session ID, or pending ID before matching.

Different VS Code extension instances can still race. Cross-instance creation uses a short-lived filesystem lock in the extension host's global storage, keyed by the hashed runtime identity:

- lock creation uses an atomic create-if-absent operation;
- the holder always refreshes discovery after acquiring the lock;
- waiters use a bounded wait and then refresh instead of blindly creating;
- a lock older than 30 seconds is stale and recoverable;
- the holder verifies managed metadata and the exact expected runtime count before releasing the lock.

If creation returns an ambiguous result, Project Steward does not send the provider command again. It refreshes discovery and either reuses the verified target or reports a conflict.

## Error Handling

### Executable unavailable or unsupported

Availability uses the configured executable with `-V`, a bounded timeout, and required-command capability checks. Missing files, permission errors, timeouts, malformed results, unsupported required commands, and native Windows extension hosts produce an actionable warning.

### Runtime exists but attach fails

The runtime remains active. Project Steward reports an attach error and writes details to the output channel. It does not start or resume the provider again.

### Creation fails

Project Steward removes the newly written pending binding if it can prove no managed target was created. If creation is ambiguous, it retains the bounded pending record, refreshes discovery, and reports the uncertainty instead of risking a duplicate process.

### Metadata or name collision

Project Steward refuses ownership and reports the conflicting target. It never uses destructive tmux flags to replace an unknown target.

### Duplicate live runtimes

The session is projected once with a conflict state. The user can focus an existing Direct Terminal runtime or tmux runtime, but resume/create is disabled until the conflict is resolved outside V1. Project Steward does not kill either process.

### Discovery failure

The last successful short-lived snapshot may continue to render while marked stale. A user action forces a retry. No runtime is declared completed solely because one tmux command failed.

## Security and Privacy

- Tmux control commands use argument arrays with `shell: false`.
- The executable setting is one executable path or name, not an arbitrary command line.
- Provider, session, project, and pending names are validated and hashed before entering tmux target syntax.
- Provider launch values are POSIX-quoted in one shared serializer with tests for empty strings, whitespace, quotes, control characters, and shell metacharacters.
- User-controlled title and prompt values never enter tmux names or metadata.
- Logs include backend, layout, provider, hashed target, lifecycle decision, exit code, and error category.
- Logs exclude raw prompts, full environment variables, tokens, transcripts, and the complete provider command.
- Persistent records have schema versions, per-field length limits, list limits, and total record limits.
- Project Steward does not expose tmux sockets or network listeners.

## Performance

- Availability and discovery calls are asynchronous and timeout-bounded.
- Concurrent discovery requests share one promise.
- A short cache prevents repeated `list-sessions` and `list-windows` calls during one render cycle.
- User actions and lifecycle transitions force refreshes; ordinary webview rendering consumes the cached runtime projection.
- Background discovery is inactive when there is no reason to monitor managed tmux runtimes.
- Parsing is bounded by maximum managed sessions, windows, metadata lengths, and pending records.

## Automated Testing

Unit and controller tests cover:

1. setting defaults, machine-specific values, and invalid executable configuration;
2. stable hashes, target names, bounds, and metadata mismatch handling;
3. project and session layout mapping;
4. runtime coordinator lookup precedence and conflict projection;
5. pending, active, completed, and stopped lifecycle transitions;
6. attached and detached client state independent of runtime state;
7. pending persistence and reload recovery without a terminal PID;
8. known-hint reconciliation and explicit Direct Terminal override;
9. structured provider launch specifications and POSIX quoting;
10. attach failure without provider restart;
11. mode and layout changes without runtime migration;
12. in-process and cross-instance creation idempotency;
13. malformed, oversized, stale, and version-incompatible persistence records;
14. existing provider discovery, alias, pin, archive, Active/History, attention, and terminal safety behavior.

A real tmux smoke test uses a unique test server name and no user configuration:

```text
tmux -L project-steward-<random-test-id> -f /dev/null
```

It never touches the user's default tmux server. It verifies:

- one project session with multiple managed windows;
- one independent session per AI session;
- metadata discovery after creating a new backend instance;
- detach with the provider process still alive;
- provider exit and window cleanup;
- pending-to-final rename;
- paths and arguments containing special characters;
- concurrent ensure operations producing one runtime;
- cleanup of the dedicated test server.

Existing compile, lint, AI session safety, dashboard, attention, open-project, and architecture-baseline checks must continue to pass.

## Manual Acceptance Matrix

Manual acceptance covers:

- local Linux;
- macOS with `tmux` on `PATH` and with an absolute Homebrew path;
- Remote SSH;
- Dev Container;
- WSL;
- native Windows unsupported messaging;
- project and session layouts;
- new and resumed Codex, Kimi, and Claude sessions;
- terminal detach and reattach;
- Developer: Reload Window;
- complete VS Code close and reopen;
- remote disconnect and reconnect while the remote host stays running;
- mode, layout, and executable changes while runtimes exist;
- multiple clients attached to one project session and their shared current window.

## Acceptance Criteria

1. Default settings preserve all Direct Terminal behavior.
2. Project layout creates one managed tmux session and one managed window per AI session in a project.
3. Selecting project-layout sessions reuses one attach terminal per project in an extension instance.
4. Session layout creates one independent managed tmux session per AI session.
5. New and resumed Codex, Kimi, and Claude sessions work in both layouts.
6. Detaching a terminal leaves the provider running and the session visible in `ACTIVE`.
7. Reattaching never starts another provider process when the managed runtime exists.
8. Reload, full reopen, and supported remote reconnect discover surviving managed runtimes.
9. Pending runtimes survive detach and extension restart and bind to the final provider session ID.
10. Mode and layout changes affect only absent runtimes and never migrate live ones.
11. A custom executable path works in its extension-host environment.
12. An unavailable executable provides explicit fallback without changing settings.
13. Normal provider exit produces the current completion and attention behavior.
14. External runtime loss without a marker is stopped, not completed.
15. Concurrent resume/create operations start at most one provider process per runtime identity.
16. Special characters in cwd, session ID, title, and prompt do not change command structure.
17. Active/History tabs, focus, attention, alias, pin, archive, and provider selection remain functional.
18. Multiple clients of one project tmux session share the current window as documented.
19. Project Steward never modifies an unmanaged tmux target after a name or metadata collision.
20. Tmux discovery does not add unbounded child-process work to webview rendering.

## Documentation and Rollout

Release notes and settings descriptions must explain:

- Direct Terminal remains the default;
- tmux preserves work only while the host and container stay running and awake;
- closing the VS Code terminal detaches rather than terminates;
- project layout groups AI sessions as windows;
- session layout isolates each AI session;
- settings and executable paths are machine-specific;
- multiple clients attached to one project layout share the current tmux window;
- native Windows requires WSL, SSH, or a Dev Container for V1 tmux support.

The feature requires no stored-data migration. Existing terminal bindings continue to represent Direct Terminal runtimes, while tmux records use new versioned keys and metadata.
