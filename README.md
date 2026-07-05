# Project Steward

Project Steward is a VS Code project hub for developers who move between local folders, SSH remotes, Dev Containers, and AI coding sessions.

It gives you a compact sidebar panel where you can save projects, group them, mark favorites, reopen workspaces, and resume related Codex sessions without searching through recent windows or terminal history.

Project Steward is a fork of [Kruemelkatze/vscode-dashboard](https://github.com/Kruemelkatze/vscode-dashboard), redesigned around remote-first workflows and sidebar-based daily use.

![Project Steward demo](project-steward-demo.gif)

## Why Project Steward?

VS Code can open almost anything: local folders, `.code-workspace` files, SSH remotes, WSL folders, Dev Containers, and container-attached workspaces. After a while, the hard part is not opening one project. It is remembering where every project lives, which environment it belongs to, and how to get back to the right context quickly.

Project Steward turns those entries into a persistent project catalog.

- Save local folders, files, workspaces, SSH projects, WSL projects, and Dev Container projects.
- Keep projects organized with groups, descriptions, colors, and favorites.
- Use the sidebar panel instead of taking over the editor area.
- See the projects currently open in this VS Code window.
- Reopen a saved project in the current window or a new window.
- Resume Codex sessions associated with the current open project.
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

### Open Projects

The `OPEN PROJECT` group shows the project currently open in the active VS Code window. When the open project matches a saved card, Project Steward reuses the saved card metadata instead of showing a raw folder name.

### Favorites

Use the star on each project card to pin or unpin a project. Favorites appear in the `FAVORITES` group and keep the same project metadata as the original card.

### Codex Sessions

Open project cards can expand to show recent active Codex sessions related to that project. Selecting a session opens a VS Code terminal and runs `codex resume` for that session.

Project Steward avoids opening duplicate terminals for the same Codex session. If a matching terminal is still running, it focuses that terminal; if the prior session terminal has completed, it reuses the terminal and runs `codex resume` again.

You can also archive sessions from the session list to keep the panel manageable.

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
- Use the search bar to filter projects by name, description, path, group, and Codex session text.

## Remote and Dev Container Notes

Project Steward can save and reopen remote project records, including SSH and Dev Container URIs. For best results, use `Project Steward: Save Project` while you are already inside the target remote workspace.

Codex session discovery reads the Codex data available to the extension host:

- local sessions are read from the local machine
- remote sessions require the extension to run in the remote/workspace environment
- Dev Container sessions require Project Steward to be installed or running in that Dev Container environment

If a Dev Container project opens correctly but its Codex sessions do not appear, install Project Steward in the Dev Container and reload the window.

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
- `projectSteward.showAddProjectButtonTile`
- `projectSteward.customProjectCardBackground`
- `projectSteward.customProjectNameColor`
- `projectSteward.customProjectPathColor`
- `projectSteward.customCss`

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
