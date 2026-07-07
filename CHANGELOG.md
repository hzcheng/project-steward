# Change Log

All notable changes to the "Project Steward" extension will be documented in this file. It follows the [Keep a Changelog](http://keepachangelog.com/) recommendations.

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
