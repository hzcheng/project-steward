---
name: installing-vscode-extensions-locally
description: Use when building, packaging, installing, or verifying this Project Steward VS Code extension or VSIX in a local, SSH, Dev Container, workspace, or UI extension-host environment.
---

# Installing VS Code Extensions Locally

## Overview

Build and install the Project Steward extension that matches the current VS Code environment, then report exactly what was installed and what could not be installed.

## Workflow

1. Identify package scripts before guessing:
   - inspect `package.json`
   - prefer repo scripts such as `npm run install-local`, `npm run package`, or `npm run vscode:package`

2. Identify the active VS Code host before installing:
   - inspect environment hints such as `REMOTE_CONTAINERS`, `CODESPACES`, `SSH_CONNECTION`, and `VSCODE_IPC_HOOK_CLI`
   - run `which -a code` and `code --version` when manual CLI install may be needed
   - prefer the repo install script if it already selects the correct local, SSH, or Dev Container CLI
   - if multiple `code` CLIs exist and the target host is unclear, ask before installing

3. Run relevant checks first when the build is not already fresh:
   - compile or test scripts used by the repo
   - packaging checks if the extension has release packaging tests

4. Package and install through the repo's script when available.
   - Example: `npm run install-local`
   - If manual install is needed, use `code --install-extension <file>.vsix` or the environment-specific VS Code CLI in the repo docs.

5. Distinguish extension host compatibility.
   - Workspace extensions can install into Dev Containers/SSH workspaces.
   - UI-only extensions may need the local UI host and can fail from inside a remote extension host.
   - Report this as an environment limitation, not as a successful install.

6. Verify the result:
   - list installed extensions if practical
   - record VSIX path(s), version, and command output status
   - if a script exits 0 with warnings, report warnings separately from failure

## Reporting

Always tell the user:
- which VSIX artifact was built
- which extension id/version was installed
- which host received it, if known
- which checks were run
- any extension that was packaged but not installable in the current host

## Pitfalls

- Do not assume a UI bridge extension can install in a Dev Container just because the main workspace extension can.
- Do not use the first `code` binary on PATH when multiple hosts are present and the target host is unclear.
- Do not claim install success from packaging success alone.
- Do not skip the repo's packaging script in favor of a generic VSIX command unless the repo lacks one.
