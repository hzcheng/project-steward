# Exact Existing-Window Focus Feasibility

Date: 2026-07-15

Status: **BLOCKED — mandatory desktop-window matrix not executed**

The hard gate is not PASS. The spike protocol, cross-window relay, automated checks, bundles, and packages are complete, but this execution environment exposes only a remote VS Code Server shell. It cannot install the UI-kind bridge into the desktop client, invoke the Command Palette/Quick Pick, observe foreground focus, or count desktop windows. No focus result below is inferred from compilation or automated tests.

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

Every row is explicitly unexecuted. A dash means no observation was made.

| Case | Source ID | Target ID | Handling ID | `focused` | Latency | Registrations before/after | Evidence status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| local -> local | — | — | — | — | — | — | UNEXECUTED |
| local -> SSH | — | — | — | — | — | — | UNEXECUTED |
| local -> Dev Container | — | — | — | — | — | — | UNEXECUTED |
| same project window A -> same project window B | — | — | — | — | — | — | UNEXECUTED |
| 20 alternating requests between two targets | — | — | — | — | — | — | UNEXECUTED (all 20 requests) |
| request after target close | — | — | — | — | — | — | UNEXECUTED |

## Remaining Manual Commands and Artifacts

1. In the desktop VS Code client, install `artifacts/project-steward-attention-ui-bridge-0.1.1.vsix` into the client/UI side of every test window.
2. Install `artifacts/project-steward-attention-workspace-probe-0.0.5.vsix` into each applicable local, SSH, and Dev Container Workspace Extension Host. `artifacts/project-steward-1.1.8.vsix` is also available if the main extension needs refreshing.
3. Run `Developer: Reload Window` in every participating window and wait at least two seconds for registrations to heartbeat.
4. Run `Project Steward: Run Open Window Focus Spike` from the source window for each live-target row. For the alternating row, invoke it 20 times and alternate the selected target.
5. For the closed-target row, open the picker while the target is live, close the target window, then select its still-listed ID; verify a missing/timeout result and no reopened window.
6. Copy every `OPEN_WINDOW_FOCUS_SPIKE` line from the `Project Steward Attention Spike Routing` output channel into this report and independently record the desktop live-window count before and after each request.
7. Mark PASS only if every live result has `focused: true`, `handlingInstanceId === targetInstanceId`, and unchanged registration/window counts, and the closed target is not reopened. Mark FAIL if any required topology violates those conditions.

## Gate Decision

**BLOCKED.** Task 2 must not start until the mandatory matrix is measured and this report is changed to PASS or FAIL from real observations.

## Final Review Ledger

Independent review found and the implementation resolved two Important issues before commit:

- Fresh requests from skewed SSH/remote clocks are now restamped and TTL-validated in the shared desktop UI Bridge clock domain. The target Workspace validates request shape and exact target without reapplying a remote wall-clock TTL.
- Malformed JSON is now isolated and removed per file, allowing later registrations and requests to continue scanning.

Two Minor review findings are intentionally deferred because this is disposable spike code and the mandatory matrix remains the decisive proof: result records have only bounded structural checks rather than a standalone exhaustive runtime parser, and the integration contract tests supplement but do not replace real filesystem/concurrency and desktop-window tests. Production Task 2 must add exhaustive protocol/result parsers and behavioral store/coordinator tests if the hard gate later passes.
