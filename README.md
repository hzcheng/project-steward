# Project Steward

Project Steward is a VS Code project hub for developers who move between local folders, SSH remotes, Dev Containers, and AI coding sessions.

It gives you a compact sidebar panel where you can save projects, group them, mark favorites, reopen workspaces, and resume related AI coding sessions without searching through recent windows or terminal history.

Project Steward is a fork of [Kruemelkatze/vscode-dashboard](https://github.com/Kruemelkatze/vscode-dashboard), redesigned around remote-first workflows and sidebar-based daily use.

![Project Steward demo](project-steward-demo.gif)

## Why Project Steward?

VS Code can open almost anything: local folders, `.code-workspace` files, SSH remotes, WSL folders, Dev Containers, and container-attached workspaces. After a while, the hard part is not opening one project. It is remembering where every project lives, which environment it belongs to, and how to get back to the right context quickly.

Project Steward turns those entries into a persistent project catalog.

- Save local folders, files, workspaces, SSH projects, WSL projects, and Dev Container projects.
- Keep projects organized with groups, descriptions, colors, and favorites.
- Use the sidebar panel instead of taking over the editor area.
- See one card per non-empty VS Code workspace and one lightweight card for each workspace open in another window.
- Reopen a saved project in the current window or a new window.
- Create and resume Codex, Kimi, and Claude sessions with access to every folder in the current workspace.
- Sync saved project data through VS Code Settings Sync when desired.

## Highlights

### Sidebar Project Hub

Project Steward lives in the Activity Bar as a sidebar view. It is designed for repeated use throughout the day: quick scanning, quick opening, and quick project switching.

### Save Current Project

Use `Project Steward: Save Project` to save the current workspace automatically. Project Steward detects the current context and records the right kind of path when possible:

- local folder paths
- workspace files
- SSH remote URIs
- WSL remote URIs
- Dev Container remote URIs

You can choose a group while saving, then edit the name, description, and color later.

### OPEN and PROJECTS Views

The sidebar has two focused views:

- `OPEN` is the live workspace view. `CURRENT WORKSPACE` shows exactly one card for the active non-empty window, whether it contains one folder or a multi-root workspace. Workspace folders appear as metadata chips, not as cards to switch between. `OTHER WINDOWS` provides at most one navigation card for each logical workspace open elsewhere on the machine.
- `PROJECTS` is the static saved-project library for Favorites, groups, editing, and drag-and-drop organization. It is loaded only when first opened, keeping the initial sidebar render small.

When an AI session in another window needs attention, its `OTHER WINDOWS` navigation card shows the unread session count without exposing provider or session details. Runtime attention and current-workspace highlighting stay in `OPEN`; saved cards in `PROJECTS` remain static.

Other-window navigation is fail-closed. Project Steward uses direct workspace navigation only for environment/workspace combinations backed by reviewed evidence. Otherwise, a saved workspace opens VS Code's native `Switch Window` picker, an untitled workspace asks you to save it first, and a missing native command produces a warning without opening anything. A member folder is never used as a navigation fallback.

### Global Search

The search bar searches all three useful sources at once: AI sessions in the current workspace, currently open workspaces across windows, and saved projects. Search uses the lightweight initial catalog, so searching does not load the `PROJECTS` view. Results are grouped into `AI SESSIONS`, `OPEN WORKSPACES`, and `SAVED PROJECTS`.

### Favorites

Use the star on each project card to pin or unpin a project. Favorites appear in the `FAVORITES` group and keep the same project metadata as the original card.

### AI Sessions

Open the current workspace card to switch between `ACTIVE` and `SESSIONS`. `ACTIVE` collects every live Codex, Kimi, and Claude runtime across all workspace roots, including detached managed tmux runtimes. `SESSIONS` keeps the complete history for the selected provider, including sessions that are already active. Clicking an active session focuses or attaches its terminal; clicking an inactive history entry resumes it. Multi-root rows show the selected primary-root chip while the list stays flat and workspace-level.

Use `NEW` to choose Codex, Kimi, or Claude explicitly before Project Steward opens the terminal. Active sessions must be closed before they can be archived.

For a multi-root workspace, Project Steward chooses one primary working directory and grants access to all roots with each provider's native `--add-dir` argument. Codex and Kimi receive repeated `--add-dir` flags; Claude receives its native multi-directory form. New and resumed sessions use the same immutable directory scope in Direct Terminal and both tmux layouts. Project Steward checks every root, workspace trust, provider availability, and verified `--add-dir` capability before it creates a marker, terminal, tmux target, or provider process. Restricted Mode keeps cards and history readable but blocks launching until the workspace is trusted; a missing capability blocks the multi-root action with an upgrade message.

Direct Terminal remains the default. In this mode, selecting a session opens a VS Code terminal and runs the matching resume command for that provider. Project Steward avoids opening duplicate terminals for the same session. If a matching terminal is still running, it focuses that terminal; if the prior session terminal has completed, it reuses the terminal and runs the resume command again.

### Persistent tmux runtimes

Set `projectSteward.aiSessionTerminalMode` to `tmux` to run new and resumed AI sessions in managed tmux targets. A quiet `tmux` badge identifies these runtimes in `ACTIVE`, even after the global mode or layout changes. Project Steward always reuses a live runtime before consulting the current creation preference.

The default `project` layout creates one managed tmux session per workspace scope and one window per AI session. It keeps one attach terminal per workspace in each VS Code extension instance. The optional `session` layout creates an independent tmux session and attach terminal for each AI session.

`Detach Terminal…` closes only the VS Code viewer. The provider process and its `ACTIVE` row remain alive in tmux, and selecting the row attaches again without restarting the provider. Project Steward does not provide a force-kill action; attach and exit the provider normally when you want it to stop.

If discovery finds more than one verified live runtime for the same AI session, the row shows `Runtime conflict` and hides Close/Detach. Selecting it opens a runtime chooser that identifies Direct versus tmux, layout, attachment state, and the exact terminal or tmux target. Metadata or name-collision diagnostics are never offered as runtime targets and are scoped to their owning project; a collision with no verified runtime produces a safe status announcement and no focus action. Cancelling or choosing a runtime that changes before the forced refresh also performs no action.

If a tmux discovery refresh fails, Project Steward keeps the last successful runtime snapshot visible with a quiet `stale` label. Selecting the row retries discovery; one failed tmux command never declares the provider completed or stopped.

Tmux persistence is bounded by the execution host: the computer must remain awake and running, and an SSH host, WSL distribution, or Dev Container must remain available. Laptop sleep, host shutdown, and container stop suspend or terminate work according to that environment.

Project Steward never silently falls back to a Direct Terminal when tmux is unavailable. The warning lets you use a VS Code terminal for that operation or open Settings. If a previous tmux runtime cannot be verified, the explicit Direct fallback includes a duplicate-runtime warning.

In the `project` layout, tmux owns one shared current window. If multiple VS Code windows or other tmux clients attach to the same managed project session, selecting a window in one client changes the window shown by the others.

You can also create, rename locally, pin, copy session IDs, and archive sessions from the session list to keep the panel manageable.

### Saving Workspaces and Upgrade Boundary

Saving a single-folder window adds its folder as one saved project. Saving a saved multi-root window adds its `.code-workspace` file as one project. For an untitled multi-root workspace, Project Steward records a short-lived save intent before opening `Save Workspace As…`, so the save can finish safely after an Extension Host restart. Existing saved projects are preserved unchanged: groups, favorites, colors, descriptions, and already-saved member folders are neither merged nor deleted.

Workspace-first support requires the Project Steward UI Bridge v3. If the UI Bridge is missing or outdated, only `OTHER WINDOWS` degrades; the current workspace and saved projects remain available. This upgrade cutover intentionally ignores v1 open-window state. Legacy terminal and tmux runtime bindings are not adopted or migrated, and existing provider processes are not terminated. Recreate or resume those sessions to manage them with the workspace-aware runtime model.

## Quick Start

1. Install Project Steward from the VS Code Marketplace.
2. Open the Project Steward icon in the Activity Bar.
3. Open a project you want to keep.
4. Run `Project Steward: Save Project` from the Command Palette.
5. Pick or create a group.
6. Add a description so the project is easy to recognize later.
7. Use the star on the card to pin important projects to `FAVORITES`.

You can also use the `+` button in a group and choose `Save Current Project`.

## Opening Projects

- Click a project card to open it.
- `Ctrl` + click, or `Cmd` + click on macOS, opens the project in a new window.
- Hover a card to access edit, color, and remove actions.
- Use the search bar to find current AI sessions, open-window projects, and saved projects by their names, descriptions, environments, and groups.

## Remote and Dev Container Notes

Project Steward can save and reopen remote project records, including SSH and Dev Container URIs. For best results, use `Project Steward: Save Project` while you are already inside the target remote workspace.

AI session discovery reads the provider data available to the extension host:

- local sessions are read from the local machine
- remote sessions require the extension to run in the remote/workspace environment
- Dev Container sessions require Project Steward to be installed or running in that Dev Container environment

If a Dev Container project opens correctly but its AI sessions do not appear, install Project Steward in the Dev Container and reload the window.

Tmux is resolved and run by the active extension host. Install tmux on the local machine for a local window, on the SSH host for Remote SSH, inside the Dev Container for a container workspace, or inside WSL for a WSL workspace. The executable setting is machine-scoped, so each host can use its own `PATH` or absolute path.

Native Windows extension hosts are not supported by the tmux backend in this release. Use Project Steward from WSL, Remote SSH, or a Dev Container to run tmux on a POSIX extension host. Direct Terminal mode continues to work on native Windows.

## Syncing Projects

By default, projects are stored in VS Code global state on the current machine.

To sync projects across machines, enable:

```json
"projectSteward.storeProjectsInSettings": true
```

When enabled, Project Steward stores project data in user settings, so VS Code Settings Sync can synchronize it between your devices.

This makes all synced machines share the same Project Steward catalog. If you want different project lists on different machines, keep the default storage mode.

## Commands

- `Project Steward: Open`
- `Project Steward: Save Project`
- `Project Steward: Add Project`
- `Project Steward: Add Projects from Folder`
- `Project Steward: Add Group`
- `Project Steward: Remove Group`
- `Project Steward: Remove Project`
- `Project Steward: Edit Projects`

Default keybinding:

- Windows/Linux: `Ctrl+F1`
- macOS: `Cmd+F1`

## Configuration

Project Steward can be configured from VS Code settings.

Common options:

- `projectSteward.storeProjectsInSettings`
- `projectSteward.searchIsActiveByDefault`
- `projectSteward.displayProjectPath`
- `projectSteward.projectTileWidth`
- `projectSteward.openOnStartup`
- `projectSteward.showAddGroupButtonTile`
- `projectSteward.customProjectCardBackground`
- `projectSteward.customProjectNameColor`
- `projectSteward.customProjectPathColor`
- `projectSteward.customCss`

AI runtime options (all machine-scoped):

- `projectSteward.aiSessionTerminalMode`: `vscode` (default) or `tmux`; affects creation only and never migrates a live runtime.
- `projectSteward.aiSessionTmuxLayout`: `project` (default, one project session with AI windows) or `session` (one tmux session per AI session).
- `projectSteward.aiSessionTmuxPath`: one executable name resolved through the extension host's `PATH`, or one absolute executable path. Do not add arguments or shell syntax.
- `projectSteward.aiSessionRunningCardAnimation`: animation shown on the `CURRENT WORKSPACE` card while a local AI session executes: `current` (default), `sweep`, `orbit`, `halo`, `ripple`, `breath`, or `none`. `OTHER WINDOWS` cards do not expose provider or session details.

Example:

```json
{
  "projectSteward.aiSessionTerminalMode": "tmux",
  "projectSteward.aiSessionTmuxLayout": "project",
  "projectSteward.aiSessionTmuxPath": "/usr/bin/tmux"
}
```

The UI uses VS Code theme colors by default, so it should fit both light and dark themes.

## Development

CI and local verification use Node.js 22.12 or newer. Install the locked dependencies:

```bash
npm ci
```

For a quick feedback loop, compile once and run the smallest owning test file. Test names include their behavior-contract ID:

```bash
npm run test-compile
node --test tests/unit/projects/projectPathUtils.test.js
```

Run all deterministic unit, contract, and integration suites:

```bash
npm run test:deterministic
```

The weekly/manual macOS workflow also runs a real Extension Host smoke against pinned VS Code Stable `1.130.0`. It loads both the main workspace extension and the UI bridge from this checkout, activates them, and verifies the main command/view lifecycle with isolated temporary user data, extensions, workspace, home, and provider directories:

```bash
npm run test:extension-host
```

This downloads the fixed VS Code test build when it is not cached and requires a host capable of launching Electron. A worker watchdog covers download, Electron startup, and test-suite loading; on macOS/Linux it terminates the owned worker process group after eight minutes. The scheduled job retains a separate 15-minute hard timeout. The scenario is intentionally scheduled rather than part of the Linux pull-request gate.

Run the real-tmux smoke test on a POSIX host with tmux installed. The harness uses and cleans up a uniquely named test server; it never uses the default tmux server:

```bash
PROJECT_STEWARD_TMUX_PATH=/usr/bin/tmux npm run test:tmux:smoke
```

Run the Linux CI-equivalent quality gate:

```bash
npm run test:ci:linux
```

Before fixing a regression, add or update a focused test that names a stable behavior ID and run it to observe the failure. Apply the smallest fix, rerun that focused test, then run the relevant full gate. Update [`docs/testing/behavior-contracts.json`](docs/testing/behavior-contracts.json) when behavior ownership changes. See [`docs/testing/README.md`](docs/testing/README.md) for catalog rules, focused commands, CI coverage, and the manual environment matrix.

Other useful development commands:

```bash
npx gulp buildStyles
npm run webpack
npm run test:tmux
```

Package, test, and install locally:

```bash
npm run install-local
```

## Changelog

[View Changelog](CHANGELOG.md)

## Acknowledgements

- Project Steward started as a fork of [Kruemelkatze/vscode-dashboard](https://github.com/Kruemelkatze/vscode-dashboard).
- Icons are based on [Font Awesome](http://fontawesome.io) assets and the original project icon set.
- Color names are generated using the [Name that Color](http://chir.ag/projects/name-that-color/#6195ED) library.
