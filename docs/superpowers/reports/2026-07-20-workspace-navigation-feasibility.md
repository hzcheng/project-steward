# Workspace Navigation Feasibility

Date: 2026-07-21

Status: **FAIL CLOSED — no direct navigation cells enabled**

The current execution host is a VS Code Dev Container (`REMOTE_CONTAINERS=true`).
The running server and Extension Host use commit
`4fe60c8b1cdac1c4c174f2fb180d0d758272d713`; its remote CLI reports VS Code
`1.127.0`. An initial broad filesystem probe selected the separate stale
`fcf604774b9f2674b473065736ee75077e256353` remote CLI, which reports
`1.125.1`; process paths prove that it is not the running host. This explains
the observed `1.127.0`/`1.125.1` discrepancy. `/usr/local/bin/code` is a wrapper
that reports that a local `code` or `code-insiders` executable is not installed,
so it is not a Local/UI-host install path.

## Package, Dev Container Installation, and Cleanup

The probe was compiled and packaged from `spikes/workspace-navigation`, not
from the repository root:

| Field | Observed value |
| --- | --- |
| VSIX | `artifacts/project-steward-workspace-navigation-probe-0.0.2.vsix` |
| Extension | `hzcheng.project-steward-workspace-navigation-probe@0.0.2` |
| Size | 11,287 bytes |
| SHA-256 | `6730f55d51c61f0ccbc7acafa91870a9a7041daf4f7ac6855c92fbd3708d5abc` |
| Target host | Dev Container workspace Extension Host, server commit `4fe60c8b1cdac1c4c174f2fb180d0d758272d713` |

The shell inherited a stale IPC socket, so its first install request failed
with `ECONNREFUSED`. A live Dev Container Extension Host IPC was then selected
from the running server. After correcting the probe's explicit `not-runnable`
record, the final versioned install completed with:

```text
Installing extensions on Dev Container: DevBox @ reddev...
Extension 'project-steward-workspace-navigation-probe-0.0.2.vsix' was successfully installed.
```

`--list-extensions --show-versions` reports
`hzcheng.project-steward-workspace-navigation-probe@0.0.2`. The installed
`dist/extension.js` SHA-256 is
`9c2a3bbd9b1bd514982d96958309afe289b21bf93d07a367b4a5cdcca0098b7e`,
identical to the file inside the VSIX. Packaging warned that this disposable
probe has no repository field, bundled license, or package file allow-list;
those warnings do not alter the compiled payload identity. No Local/UI, SSH,
or WSL host was installed. Installation and activation do not constitute
navigation evidence.

Review cleanup removed the disposable extension from the confirmed Dev
Container host. A newly confirmed live Dev Container IPC reported no matching
entry in a successful `--list-extensions --show-versions` call. The hardened
probe source is version `0.0.3` and was compiled but not installed.
VS Code-managed `0.0.1`/`0.0.2` extension directories remain on disk, but the
authoritative extension list has no installed probe entry; those directories
were not manually deleted.

Exactly five files under the probe-owned
`.../globalStorage/hzcheng.project-steward-workspace-navigation-probe/workspace-navigation-probe/v1`
directory were moved, not deleted, to the recoverable backup
`/tmp/project-steward-workspace-navigation-probe-v1-backup-task12-review` and
checksummed. No other extension data was touched. Five already-running
Extension Hosts from the old `activationEvents: ["*"]` build recreated
registration files within three seconds. Uninstall does not stop an already
activated Extension Host; those windows require reload before writes cease,
after which the five-second registration TTL makes the recreated records
ineligible as live evidence. This report does not claim that the recreated
directory is clean.

The hardened disposable workspace extension activates only for explicit
commands. `start` opens a bounded ten-minute trial lifecycle; `stop` removes
its registration and heartbeat. It records source and target instance IDs,
target focus events, source heartbeat timestamps, and explicitly diagnostic
`registrationCountBefore`/`registrationCountAfter` values before and after
calling only:

```ts
vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.parse(target.navigationUri),
    { forceNewWindow: true }
);
```

Registration counts are never named or treated as window counts. The remote
CLI does not expose an authoritative desktop window count or focus state.
Process counts are also insufficient because one window may create
multiple remote processes and unrelated Dev Container windows share the same
server. No controlled second VS Code target window is available to this
execution, and no UI automation channel is available. Therefore even the
current Dev Container cells are not empirically runnable here. This is a hard
gate failure, not evidence that direct navigation is unsupported by VS Code.

The installed probe and the hardened source have different evidence roles.
The probe can produce four conservative runtime outcomes in this order:
`unsupported` when the command fails, `opened-duplicate` when the registration
count increases, `replaced-source` when the source heartbeat is missing or
does not advance after the action, and otherwise `not-runnable` because no
authoritative window count exists. It cannot produce `focused-existing`.
That fifth outcome is reserved for a future evidence importer backed by an
independently reviewed adapter.

## Matrix

Every `not-runnable` result selects the safe fallback. The trusted evidence
adapter registry is intentionally empty, so every `focused-existing` matrix
cell fails closed with `no trusted adapter configured`; source-name prefixes
or regular expressions do not establish trust. The future importer schema
requires unique `trialId` values, rejects duplicate observations, and requires
`startedAtMs`, `targetFocusedAtMs > startedAtMs`, an exact `evidenceSourceId`,
`evidenceArtifactRef`, and lowercase `evidenceSha256`. It also retains the
identity, cell, authoritative-count, focus-sequence, and source-heartbeat
invariants. Consequently all capability entries remain `false`.

<!-- workspace-navigation-matrix:start -->
```json
[
  {"environment":"local","kind":"singleFolder","outcome":"not-runnable","observations":[],"reason":"This execution is inside a Dev Container; no Local/UI Extension Host or controlled Local target window is available."},
  {"environment":"local","kind":"savedMultiRoot","outcome":"not-runnable","observations":[],"reason":"This execution is inside a Dev Container; no Local/UI Extension Host or controlled Local target window is available."},
  {"environment":"local","kind":"untitledMultiRoot","outcome":"not-runnable","observations":[],"reason":"This execution is inside a Dev Container; no Local/UI Extension Host or controlled Local target window is available."},
  {"environment":"ssh","kind":"singleFolder","outcome":"not-runnable","observations":[],"reason":"SSH_CONNECTION is unset and no SSH Remote Extension Host or controlled SSH target window is available."},
  {"environment":"ssh","kind":"savedMultiRoot","outcome":"not-runnable","observations":[],"reason":"SSH_CONNECTION is unset and no SSH Remote Extension Host or controlled SSH target window is available."},
  {"environment":"ssh","kind":"untitledMultiRoot","outcome":"not-runnable","observations":[],"reason":"SSH_CONNECTION is unset and no SSH Remote Extension Host or controlled SSH target window is available."},
  {"environment":"wsl","kind":"singleFolder","outcome":"not-runnable","observations":[],"reason":"WSL_DISTRO_NAME is unset and no WSL Extension Host or controlled WSL target window is available."},
  {"environment":"wsl","kind":"savedMultiRoot","outcome":"not-runnable","observations":[],"reason":"WSL_DISTRO_NAME is unset and no WSL Extension Host or controlled WSL target window is available."},
  {"environment":"wsl","kind":"untitledMultiRoot","outcome":"not-runnable","observations":[],"reason":"WSL_DISTRO_NAME is unset and no WSL Extension Host or controlled WSL target window is available."},
  {"environment":"devContainer","kind":"singleFolder","outcome":"not-runnable","observations":[],"reason":"The probe can run in this Dev Container workspace Extension Host, but no controlled second single-folder target and no authoritative UI window-count/focus automation channel are available."},
  {"environment":"devContainer","kind":"savedMultiRoot","outcome":"not-runnable","observations":[],"reason":"The probe can run in this Dev Container workspace Extension Host, but no controlled second saved multi-root target and no authoritative UI window-count/focus automation channel are available."},
  {"environment":"devContainer","kind":"untitledMultiRoot","outcome":"not-runnable","observations":[],"reason":"The probe can run in this Dev Container workspace Extension Host, but no controlled second untitled multi-root target and no authoritative UI window-count/focus automation channel are available."}
]
```
<!-- workspace-navigation-matrix:end -->

## Gate Decision

All 12 cells use fallback. Production must not call `vscode.openFolder` for any
workspace navigation card on the basis of this run. Saved workspaces use VS
Code's native Switch Window picker when available. Untitled workspaces ask the
user to save first. If native switching is unavailable, Project Steward warns
and performs no open action. Member root URIs are never a fallback.
