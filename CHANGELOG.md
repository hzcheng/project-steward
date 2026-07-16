# Change Log

All notable changes to the "Project Steward" extension will be documented in this file. It follows the [Keep a Changelog](http://keepachangelog.com/) recommendations.

## [Unreleased]

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
