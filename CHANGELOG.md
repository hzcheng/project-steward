# Change Log

All notable changes to the "Project Steward" extension will be documented in this file. It follows the [Keep a Changelog](http://keepachangelog.com/) recommendations.

## [2.1.6] 2026-07-25

### Added

-   Add a continuous TODO workflow with full inline card details, fixed-group creation forms, stable drag ordering, undo, and browser-level expanded-layout coverage.
-   Add recoverable project-catalog synchronization that preserves concurrent additions, deletions, group ordering, favorites, and local write ownership.
-   Add CI-owned behavior contracts for TODO incremental rendering, session-card activation, terminal focus, attention lifecycle, and tmux reload recovery.

### Changed

-   Update TODO completion, inline editing, group disclosure, and Projects rendering incrementally without replacing the whole dashboard surface.
-   Keep Active Session card ordering stable when terminal focus changes, and focus the VS Code terminal workbench after selecting a Session.
-   Size TODO groups around both the configured visible-card limit and the complete expanded card, while keeping the page command bar visually distinct from saved groups.

### Fixed

-   Recover a live tmux viewer after VS Code reload by resolving the restored terminal PID to its real tmux client session, preventing a second terminal from attaching to the same runtime.
-   Use the first tmux project window for the first Session instead of leaving an empty bootstrap window.
-   Keep Session exit, explicit close, provider interrupt, and acknowledged completion from creating or reopening false red attention indicators.
-   Recover stalled lazy dashboard panels and version Webview assets per activation so reloads do not leave the sidebar blank or stale.
-   Preserve aliases across Codex root-thread switches and focus the rebound tmux Session without duplicating the viewer.

## [2.1.5] 2026-07-23

### Added

-   Add cross-platform CI quality gates on Linux and Windows, plus an isolated real-tmux smoke gate for every pull request.
-   Add a behavior-contract catalog, main-capability traceability, architecture guards, deterministic provider fixtures, and coverage baselines to prevent established behavior from regressing.
-   Add weekly macOS Extension Host verification after the reusable Linux, Windows, and tmux gates pass.

### Changed

-   Refactor the regression suite into focused unit, contract, integration, platform, Extension Host, and real-runtime layers with explicit behavior ownership.
-   Make release packaging deterministic and reject tests, coverage output, source maps, documentation, and stale build files from production VSIX archives.

### Fixed

-   Rebind a managed tmux pane when Codex switches to a new root thread/session, keeping the replacement session in `ACTIVE` with its running animation while rejecting subagents and ambiguous process evidence.
-   Preserve `OTHER WINDOWS` navigation identity and privacy guarantees through incremental rendering updates.
-   Stabilize attention cleanup synchronization under full Linux CI load.
-   Keep provider aborts, Direct Terminal exit, user terminal close, and tmux runtime cleanup attention-neutral; only explicit provider completion, failure, or input events can create a red indicator.

## [2.1.4] 2026-07-22

### Added

-   Represent one card per non-empty VS Code workspace, with roots shown only as metadata and one flat AI-session surface for single-folder, saved multi-root, and untitled multi-root windows.
-   Give new and resumed Codex, Kimi, and Claude sessions access to all workspace roots through provider-native `--add-dir`, with one primary cwd shared by Direct Terminal and both tmux layouts.
-   Add trust and provider-capability preflight: Restricted Mode keeps cards and history readable while launch is blocked, and missing verified `--add-dir` capability creates no partial runtime.
-   Name managed tmux sessions after workspace cards and tmux windows after AI sessions when they are created, while keeping those names stable for the runtime lifetime.

### Changed

-   Use the UI Bridge v3 workspace registry and fail-closed other-window navigation. Unproven saved-workspace navigation uses VS Code's native `Switch Window` picker, while an untitled workspace asks the user to save it first; member roots are never opened as a fallback.
-   Preserve saved projects unchanged, including groups, favorites, colors, descriptions, and member-folder entries. Saving a workspace adds one project without merging or deleting existing entries.
-   Choose the primary working directory before creating a multi-root workspace session, and keep normal tmux session focusing on the verified fast path.
-   Use the same responsive card shell, project colors, running animation, and attention behavior for `CURRENT WORKSPACE`, `OTHER WINDOWS`, and saved projects.
-   Intentionally ignore transient v1 open-window state. Legacy terminal and tmux runtime bindings are not adopted or migrated; existing provider processes keep running and can be recreated or resumed under workspace-aware ownership.

### Fixed

-   Restore workspace-scoped AI session discovery, pending-session promotion, completion attention, and explicit attention acknowledgement across current and other windows.
-   Keep attention visible until its Session is opened, and clear it when the Session terminal exits or the user leaves the acknowledged Session.
-   Reuse an existing managed tmux attach terminal during Extension Host reload recovery instead of opening a duplicate terminal for the same tmux target.
-   Recover durable readable tmux names across promotion and reload, tolerate an empty tmux server, and reject renamed or unverified managed targets.
-   Keep workspace cards compact and fully visible in narrow sidebars, limit collapse toggling to the card summary, and assign stable fallback colors to unsaved workspaces.

## [2.1.3] 2026-07-20

### Added

-   Add an opt-in persistent tmux runtime for new and resumed Codex, Kimi, and Claude sessions, with machine-scoped executable and layout settings.
-   Add the default project layout (one tmux session per project and one window per AI session) and an isolated one-session-per-AI-session layout.
-   Show tmux backend, detached, and runtime-conflict state in Active Sessions, with backend-specific Detach Terminal actions.

### Changed

-   Discover and reuse live managed runtimes independently of the current runtime preference, while keeping Direct Terminal as the default and requiring explicit fallback when tmux is unavailable.
-   Keep tmux-backed sessions active after their VS Code viewer is detached, as long as the execution host remains awake and running.

### Fixed

-   Preserve `OTHER WINDOWS` attention badges when Remote SSH, WSL, or Dev Container navigation uses a full VS Code Remote URI.
-   Preserve completed AI Session attention in `OTHER WINDOWS` after VS Code Terminal or tmux runtime cleanup, until the user clicks the Session or project card.
-   Acknowledge attention from project-card clicks, clear retained attention when the feature is disabled, and rescan all runtime backends before archive confirmation.
-   Prevent concurrent or ambiguous tmux creation, metadata collisions, reload recovery, and attach failures from resending a provider command or modifying unmanaged tmux targets.
-   Renew long-running tmux creation locks so active owners are not mistaken for stale claims.
-   Make runtime conflicts explicitly selectable without ambiguous focus or detach, use accessible native session actions, and harden isolated tmux smoke cleanup and provider-invocation evidence.
-   Keep unmanaged tmux collision diagnostics out of the runtime chooser, classify cleanup failures conservatively, and verify controlled provider exit without sending process signals.
-   Preserve offline provider-completion evidence and live known-runtime hints independently, keep initial and restored tmux terminal titles consistent, and mark retained snapshots stale after discovery failures.

## [2.1.2] 2026-07-19

### Added

-   Show live execution activity for Active Sessions while keeping attention indicators independent.

### Changed

-   Read AI session lifecycle logs incrementally and scope recovered lifecycle state to the current run.
-   Route `OTHER WINDOWS` project cards through the same project-opening path as saved `PROJECTS` cards.

### Fixed

-   Keep newly created pending AI sessions visible until their terminal closes.
-   Recover long-running AI session state without reviving stale lifecycle events after cursor resets or Extension Host reloads.
-   Preserve the exact SSH and Dev Container authority published by each VS Code window so `OTHER WINDOWS` switches to the existing project window instead of opening the project in the wrong container.

## [2.1.1] 2026-07-18

### Added

-   Add project-card `ACTIVE` and `SESSIONS` tabs: `ACTIVE` aggregates live Codex, Kimi, and Claude terminals while `SESSIONS` keeps the complete selected-provider history.
-   Add a shared New Session action that explicitly asks for Codex, Kimi, or Claude instead of inheriting the history provider filter.
-   Add focused, attention, running, and starting states for Active Sessions, plus confirmed Terminal closing without removing history.

### Changed

-   Focus existing Active Session terminals without duplication, and move successfully resumed history Sessions into `ACTIVE`.
-   Preserve per-project tab choice, provider, Manage state, expansion state, and independent scroll positions across incremental updates.
-   Keep Active Sessions unavailable for single or batch archive until their Terminal is closed.

### Fixed

-   Exclude non-interactive Codex `exec` runs from Dashboard session lists.
-   Keep Active Session projection synchronized with Terminal close, pending creation, attention, focus, and Extension Host reload events.
-   Preserve adaptive tab fallback when the final Active Session closes and prevent failed resumes from stealing the Active tab.

## [2.1.0] 2026-07-17

### Added

-   Add a global `TODO` Dashboard tab with groups, priorities, notes, completion state, ordering, search, and inline editing.
-   Synchronize global TODO data through VS Code Settings Sync when project settings storage is enabled.
-   Add a configurable maximum number of visible TODO cards per group, with scrolling for additional cards.
-   Add a command to append the active editor file reference, including selected line ranges, to the active terminal and focus it for CLI discussions.

### Changed

-   Reuse shared Dashboard group headers, cards, controls, and visual tokens across projects, sessions, and TODO content.
-   Keep compact TODO cards on one line, reveal full titles on hover, and expand cards for details and editing.

### Fixed

-   Recover the Open Projects `OTHER WINDOWS` group if an incremental webview update drops the expected navigation cards.
-   Protect TODO data during storage backend migration, Settings Sync updates, unsupported data versions, and rejected writes.
-   Write synchronized TODO data through the primary `projectSteward` configuration instead of the merged legacy read adapter.
-   Preserve TODO drafts and form state across validation or storage failures while preventing duplicate submissions.
-   Restore keyboard focus after TODO panel updates and keep priority, group collapse, and completed-item controls synchronized.

## [2.0.1] 2026-07-16

### Changed

-   Split Dashboard session and command orchestration into smaller controllers to reduce `dashboard.ts` responsibilities while preserving the 2.0.0 user experience.
-   Add render-path diagnostics for Dashboard, Open Projects, AI session hydration, and incremental update message builds.
-   Cache Codex session metadata reads by file signature to reduce repeated JSONL metadata parsing during scans.
-   Coalesce high-frequency AI session watcher refreshes and skip unchanged incremental AI session messages.
-   Skip unchanged Open Projects incremental updates by semantic revision, including duplicate in-flight updates.
-   Cache per-project AI session view models so repeated incremental updates can reuse session row HTML and search text when project/provider inputs are unchanged.

### Fixed

-   Keep Open Projects update delivery retryable when a same-revision message is not delivered while the sidebar is hidden.
-   Stabilize asynchronous safety checks for attention-store lifecycle and Open Projects fallback polling.

## [2.0.0] 2026-07-15

### Added

-   Add `OPEN` and `PROJECTS` tabs plus grouped global search for AI sessions, open projects, and saved projects.
-   Show unread AI session counts on `OTHER WINDOWS` navigation cards in the live `OPEN` view.
-   Add cross-window Project Steward visibility by publishing live workspace project cards through the UI Bridge.
-   Add profile-local AI session attention so Codex, Kimi, and Claude sessions can show unread attention indicators across VS Code windows.
-   Add AI session attention acknowledgement, repeated-animation suppression, and webview reload restoration.
-   Add terminal-backed AI session monitoring and active terminal/session highlighting.
-   Add persistent AI terminal ownership using process IDs so reloads can recover the owning session terminal.
-   Add explicit lifecycle attention for completed, failed, aborted, and input-required Codex, Kimi, and Claude sessions.
-   Add a production UI Bridge dependency and release packaging for both `hzcheng.project-steward` and `hzcheng.project-steward-attention-ui-bridge`.
-   Add release packaging checks that guard dependency IDs, Bridge host kind, production VSIX names, GitHub Release assets, and Marketplace publish order.

### Changed

-   Load the static saved-project `PROJECTS` panel only when it is first opened, reducing initial Webview work.
-   Keep runtime attention and current-workspace highlighting in `OPEN`; `PROJECTS`, tabs, and search results remain static.
-   Move the live groups below the tab row; custom CSS targeting `.steward-sticky-header > .sticky-groups-wrapper` must target `#dashboard-tab-open .sticky-groups-wrapper` instead.
-   Search now ignores tab boundaries and returns one combined result list for matching AI sessions, open projects, and saved projects.
-   Keep AI attention indicators scoped to live `OPEN` content; saved `PROJECTS` cards remain static.
-   Keep `OTHER WINDOWS` project attention indicators on live navigation cards so users can see when another window needs interaction.
-   Resolve open projects by canonical URI/path and choose current-window or most-recently-focused publishers deterministically.
-   Publish open project updates after project metadata changes, migration, workspace-folder changes, and focus changes.
-   Package local installs from production VSIX artifacts and install the UI Bridge before the main extension.
-   Publish Marketplace releases in dependency order: UI Bridge first, main extension second.
-   Publish GitHub Release VSIX assets for both production extensions and include SHA-256 values in the workflow summary.

### Fixed

-   Prevent acknowledged AI attention events from colliding after Extension Host reloads by deriving attention event IDs from provider lifecycle tokens.
-   Keep active terminal attention unread until the user opens the associated AI session row.
-   Reuse pending AI terminals for discovered sessions instead of starting duplicate terminal ownership.
-   Restore ready AI terminal ownership after Extension Host reloads using persisted process IDs.
-   Avoid stale cross-window attention after reactivation by enforcing attention sequence and removal ordering.
-   Retain attention removal tombstones long enough to prevent stale events from reappearing.
-   Harden attention bridge lifecycle, validation, acknowledgement aggregation, retry behavior, unregister handling, and privacy boundaries.
-   Deduplicate open project attention badges so the same project does not show duplicate unread indicators.
-   Stabilize cross-window open project aggregation under concurrent publishers, focus changes, malformed records, and stale leases.
-   Republish project metadata after storage migration and saved-project mutations.
-   Sanitize project card colors used by cross-window project records.
-   Exclude explicit Codex subagent sessions from project assignment, terminal matching, and Dashboard session lists.
-   Keep release dry runs from publishing while still building both production VSIX files.

## [1.1.8] 2026-07-13

### Added

-   Add batch management for archiving eligible AI sessions while protecting sessions that are still open in terminals.
-   Highlight the visible AI session associated with the active running Codex, Kimi, or Claude terminal.

### Fixed

-   Preserve AI session aliases across provider refreshes.
-   Exclude explicit Codex subagent sessions from project assignment, terminal matching, and Dashboard session lists.

## [1.1.7] 2026-07-10

### Added

-   Allow favorite project cards to be reordered by dragging within the `FAVORITES` group.

### Changed

-   Persist Favorites ordering in project data so it follows the existing Settings Sync behavior.
-   Append newly favorited projects to the end of the Favorites list.

### Fixed

-   Keep Favorites-only drag operations isolated from ordinary Group and Open Project cards.

## [1.1.6] 2026-07-10

### Added

-   Add a Project Steward settings shortcut beside the group collapse/expand control.
-   Add a configurable maximum number of visible AI sessions, with a fixed-height session list.
-   Add optional Project Aura colors for the current VS Code window.
-   Highlight saved project cards that match the workspace opened in the current window.

### Changed

-   Refresh AI session card styling and move pin/archive actions into a compact hover toolbar.
-   Scale the project color indicator with compact and expanded project cards.

### Fixed

-   Preserve pinned AI session state across extension restarts and refreshes.
-   Restore original VS Code window colors when Project Aura is disabled.

## [1.1.5] 2026-07-08

### Changed

-   Update Open Project AI session rendering incrementally instead of rebuilding the full sidebar for every session refresh.
-   Reuse shared Open Project matching and remote project resolution helpers when building sidebar cards and saving projects.
-   Reduce synchronous filesystem work during sidebar refreshes by removing shell-based git detection and scoping AI session reads to open project paths.
-   Read large Claude session files with targeted cwd scanning plus bounded title sampling instead of loading the whole JSONL file.
-   Remove the trailing add-project tile from each group; projects can still be added from the group header action, command palette, and empty-state card.

### Fixed

-   Preserve Open Project session matching for large Claude session files whose cwd appears outside the sampled title window.
-   Allow folders initialized as git repositories during the current VS Code session to be detected without restarting the extension.

## [1.1.4] 2026-07-08

### Added

-   Track Claude sessions alongside Codex and Kimi sessions in Open Project cards.

### Changed

-   Replace horizontal AI session provider buttons with a compact provider selector.
-   Reduce background AI session scanning by polling less often and pausing watchers while the sidebar is hidden.
-   Debounce AI session refreshes to avoid repeatedly rebuilding the sidebar while session files are changing.

### Fixed

-   Keep the Open Project section visible when collapsing all regular project groups.
-   Prevent Collapse All from persisting shared group state across VS Code windows.
-   Keep sticky group headers visible when groups are collapsed.

## [1.1.3] 2026-07-07

### Added

-   Track Kimi sessions alongside Codex sessions in Open Project cards.
-   Add AI session provider tabs, new-session actions, session pinning, and local session aliases.
-   Add a session context menu with resume, rename, copy ID, pin or unpin, and archive actions.

### Changed

-   Reuse active session terminals when possible and make new AI session detection more resilient.
-   Keep AI session aliases local to the extension storage instead of syncing them with project data.

### Fixed

-   Remove stale local aliases when sessions are archived or disappear from the detected session list.
-   Keep session context menus visible above sticky sidebar content and inside the webview viewport.

## [1.1.2] 2026-07-05

### Changed

-   Refresh the README with the current Project Steward positioning, setup notes, Codex session behavior, and demo media.

### Fixed

-   Resuming a completed Codex session terminal now reruns `codex resume` instead of only focusing the stale terminal.

## [1.0.5] 2026-07-02

### Changed

-   Rename VS Code contribution IDs and commands from Project Dashboard to Project Steward to avoid stale layout cache and conflicts with the original extension.
-   Run the extension in the workspace extension host so remote SSH and Dev Container windows load the same Project Steward build.
-   Preserve fallback support for legacy `dashboard.*` settings after the Project Steward rename.

### Fixed

-   Fixed Project Steward sidebar rendering when configuration compatibility fallback is active.
