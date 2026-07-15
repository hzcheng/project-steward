# Exact Existing-Window Focus Feasibility

Date: 2026-07-15

Status: **FAIL — exact-window focus command is unavailable**

The hard gate failed during the first real desktop execution. The Profile-local relay delivered the request to the exact requested Workspace Extension instance, but that instance could not focus its window because VS Code reported `command 'workbench.action.focusWindow' not found`.

Observed evidence:

```text
OPEN_WINDOW_FOCUS_SPIKE {"requestId":"a74b76a118e68bc1b05ef9e69d25bc4b","sourceInstanceId":"5db060ce0014d4f8d159a7dac8fb0bf1","targetInstanceId":"80d0bc3eeaa4ba442fc49cc8102891c9","handlingInstanceId":"80d0bc3eeaa4ba442fc49cc8102891c9","focused":false,"latencyMs":253,"registrationCountBefore":2,"registrationCountAfter":2,"error":"command 'workbench.action.focusWindow' not found"}
```

The equal target and handling IDs prove exact request routing. The unchanged registration count proves the request did not create a window. `focused: false` and the missing-command error disprove the required focus capability.

## Implementation

- Added the ten-second `FocusSpikeRequest` parser and exact-target predicate for 32-character lowercase hexadecimal process IDs.
- Added `_projectStewardOpenWindowSpike.workspace.focus`, which validates its target and runs only `workbench.action.focusWindow` in the target Workspace Extension Host.
- Added `Project Steward: Run Open Window Focus Spike`, which lists live IDs, selects one exact target, sends a request, and logs one `OPEN_WINDOW_FOCUS_SPIKE` JSON line with source, target, handler, focus state, latency, and registration counts.
- Extended the UI Bridge with Profile-local `open-window-focus-spike/{registrations,requests,results}` storage, atomic file replacement, 100 ms watch-driven scans/polling, a three-second source timeout, two-second registration heartbeats, and ten-second stale cleanup.
- The relay contains no `vscode.openFolder`, `vscode.newWindow`, CLI, or OS-automation fallback.

## Automated Evidence

TDD RED:

```text
$ npm run spike:attention:test
Error: Cannot find module '../spikes/attention-local-bridge/out/spikes/attention-local-bridge/shared/focusRelay'
exit code 1
```

This was the expected failure because the new pure relay module did not exist.

Integration contract RED:

```text
$ npm run spike:attention:test
AssertionError [ERR_ASSERTION]: Workspace focus spike must contain const FOCUS_WORKSPACE = '_projectStewardOpenWindowSpike.workspace.focus'
exit code 1
```

Review-regression RED:

```text
$ npm run spike:attention:test
TypeError: focusRelay.parseFocusSpikeRequestForRelay is not a function
exit code 1
```

This expected failure proved that desktop-clock restamping and malformed-JSON isolation were absent before the review fixes. The added checks verify that an arbitrary remote-host timestamp is replaced by the relay clock and malformed JSON is rejected without throwing through the scanner.

GREEN:

```text
$ npm run spike:attention:test
Attention Local Bridge spike checks passed.
exit code 0
```

Packaging:

```text
$ npm run attention:package
workspace (webpack 5.74.0) compiled successfully
webpack 5.74.0 compiled successfully
DONE Packaged: artifacts/project-steward-attention-ui-bridge-0.1.1.vsix
DONE Packaged: artifacts/project-steward-attention-workspace-probe-0.0.5.vsix
exit code 0

$ npx @vscode/vsce package --out artifacts/project-steward-1.1.8.vsix
webpack 5.74.0 compiled successfully
DONE Packaged: artifacts/project-steward-1.1.8.vsix
exit code 0
```

Fresh artifacts:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `artifacts/project-steward-1.1.8.vsix` | 237579 | `7814d2429f548c4d8efa521d3e9de7efb4ea5538f89bca4333c085eeb7e33002` |
| `artifacts/project-steward-attention-ui-bridge-0.1.1.vsix` | 8837 | `6227dc56ccd26df24255dc3c3c1fcc002aaf289363c6734ff3891a971926cb6b` |
| `artifacts/project-steward-attention-workspace-probe-0.0.5.vsix` | 7370 | `6fb7ae4bf29ddbd5b936cc513deb483d170f414aaefe78b396a52a14de0efcee` |

## Mandatory Matrix

The first real request is sufficient to fail the gate. A dash means no further
observation was needed after the required focus primitive failed.

| Case | Source ID | Target ID | Handling ID | `focused` | Latency | Registrations before/after | Evidence status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| first live cross-window request | `5db060ce0014d4f8d159a7dac8fb0bf1` | `80d0bc3eeaa4ba442fc49cc8102891c9` | `80d0bc3eeaa4ba442fc49cc8102891c9` | `false` | 253 ms | 2 / 2 | FAIL: command unavailable |
| local -> SSH | — | — | — | — | — | — | UNEXECUTED |
| local -> Dev Container | — | — | — | — | — | — | UNEXECUTED |
| same project window A -> same project window B | — | — | — | — | — | — | UNEXECUTED |
| 20 alternating requests between two targets | — | — | — | — | — | — | UNEXECUTED (all 20 requests) |
| request after target close | — | — | — | — | — | — | UNEXECUTED |

## Gate Decision

**FAIL.** The remaining exact-focus rows are unnecessary because the required primitive is absent in the first real target. Production must not use the target-instance focus relay. The approved replacement design discovers live projects through the Profile-local registry and reuses Project Steward's existing `openProject` / `vscode.openFolder` navigation behavior.

## Final Review Ledger

Independent review found and the implementation resolved two Important issues before commit:

- Fresh requests from skewed SSH/remote clocks are now restamped and TTL-validated in the shared desktop UI Bridge clock domain. The target Workspace validates request shape and exact target without reapplying a remote wall-clock TTL.
- Malformed JSON is now isolated and removed per file, allowing later registrations and requests to continue scanning.

Two Minor review findings require no spike fix because this code is disposable:
result records have only bounded structural checks rather than a standalone
exhaustive runtime parser, and the integration contract tests supplement but
do not replace real filesystem/concurrency tests. The replacement production
registry must use exhaustive registration/aggregate validators and behavioral
store tests.
