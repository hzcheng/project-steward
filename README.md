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
- See the current workspace and projects open in other VS Code windows.
- Reopen a saved project in the current window or a new window.
- Resume Codex, Kimi, and Claude sessions associated with the current open project.
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

- `OPEN` is the live workspace view. `CURRENT WORKSPACE` shows the active window and its Codex, Kimi, or Claude sessions, while `OTHER WINDOWS` provides navigation cards for projects open elsewhere on the machine.
- `PROJECTS` is the static saved-project library for Favorites, groups, editing, and drag-and-drop organization. It is loaded only when first opened, keeping the initial sidebar render small.

When an AI session in another window needs attention, its `OTHER WINDOWS` navigation card shows the unread session count. Runtime attention and current-workspace highlighting stay in `OPEN`; saved cards in `PROJECTS` remain static.

### Global Search

The search bar searches all three useful sources at once: AI sessions in the current workspace, currently open projects across windows, and saved projects. Search uses the lightweight initial catalog, so searching does not load the `PROJECTS` view. Results are grouped into `AI SESSIONS`, `OPEN PROJECTS`, and `SAVED PROJECTS`.

### Favorites

Use the star on each project card to pin or unpin a project. Favorites appear in the `FAVORITES` group and keep the same project metadata as the original card.

### AI Sessions

Open a current-workspace project card to switch between `ACTIVE` and `SESSIONS`. `ACTIVE` collects every live Codex, Kimi, and Claude runtime, including detached managed tmux runtimes. `SESSIONS` keeps the complete history for the selected provider, including sessions that are already active. Clicking an active session focuses or attaches its terminal; clicking an inactive history entry resumes it.

Use `NEW` to choose Codex, Kimi, or Claude explicitly before Project Steward opens the terminal. Active sessions must be closed before they can be archived.

Direct Terminal remains the default. In this mode, selecting a session opens a VS Code terminal and runs the matching resume command for that provider. Project Steward avoids opening duplicate terminals for the same session. If a matching terminal is still running, it focuses that terminal; if the prior session terminal has completed, it reuses the terminal and runs the resume command again.

### Persistent tmux runtimes

Set `projectSteward.aiSessionTerminalMode` to `tmux` to run new and resumed AI sessions in managed tmux targets. A quiet `tmux` badge identifies these runtimes in `ACTIVE`, even after the global mode or layout changes. Project Steward always reuses a live runtime before consulting the current creation preference.

The default `project` layout creates one managed tmux session per project card and one window per AI session. It keeps one attach terminal per project in each VS Code extension instance. The optional `session` layout creates an independent tmux session and attach terminal for each AI session.

`Detach Terminal…` closes only the VS Code viewer. The provider process and its `ACTIVE` row remain alive in tmux, and selecting the row attaches again without restarting the provider. Project Steward does not provide a force-kill action; attach and exit the provider normally when you want it to stop.

If discovery finds more than one verified live runtime for the same AI session, the row shows `Runtime conflict` and hides Close/Detach. Selecting it opens a runtime chooser that identifies Direct versus tmux, layout, attachment state, and the exact terminal or tmux target. Metadata or name-collision diagnostics are never offered as runtime targets and are scoped to their owning project; a collision with no verified runtime produces a safe status announcement and no focus action. Cancelling or choosing a runtime that changes before the forced refresh also performs no action.

If a tmux discovery refresh fails, Project Steward keeps the last successful runtime snapshot visible with a quiet `stale` label. Selecting the row retries discovery; one failed tmux command never declares the provider completed or stopped.

Tmux persistence is bounded by the execution host: the computer must remain awake and running, and an SSH host, WSL distribution, or Dev Container must remain available. Laptop sleep, host shutdown, and container stop suspend or terminate work according to that environment.

Project Steward never silently falls back to a Direct Terminal when tmux is unavailable. The warning lets you use a VS Code terminal for that operation or open Settings. If a previous tmux runtime cannot be verified, the explicit Direct fallback includes a duplicate-runtime warning.

In the `project` layout, tmux owns one shared current window. If multiple VS Code windows or other tmux clients attach to the same managed project session, selecting a window in one client changes the window shown by the others.

You can also create, rename locally, pin, copy session IDs, and archive sessions from the session list to keep the panel manageable.

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

Install dependencies:

```bash
npm install
```

Compile TypeScript:

```bash
npm run test-compile
```

Build webview styles:

```bash
npx gulp buildStyles
```

Run webpack for local extension development:

```bash
npm run webpack
```

Run the fake-tmux suite used by ordinary safety CI:

```bash
npm run test:tmux
```

Run the opt-in real tmux smoke test against a unique isolated server (never the user's default tmux server):

```bash
PROJECT_STEWARD_TMUX_PATH=/usr/bin/tmux npm run test:tmux:smoke
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
