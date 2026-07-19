# Attention Local Bridge manual matrix

These disposable probes must be installed manually. The packaging script never installs either extension because the UI Bridge must be installed specifically in the local Extensions host, and a desktop `code` CLI may not be available.

## Fresh-build installation order

Use this exact order for every fresh build and for each matrix row:

1. Install the UI Bridge `0.1.3`; uninstall an older Workspace Probe from every tested Workspace host or force-install the new Workspace patch.
2. Reload the local UI Bridge host after installing `artifacts/project-steward-attention-ui-bridge-0.1.3.vsix`.
3. Open the target Local, Remote SSH, WSL, or Dev Container fixture window.
4. Install `artifacts/project-steward-attention-workspace-probe-0.0.5.vsix` in the Workspace host. For remote fixtures, use the remote `code-server --install-extension <absolute-vsix> --force`.
5. Restart only the target fixture Extension Host after the Workspace install. In the Local row this is also the UI host, so do not perform an additional UI-host restart.
6. Run **Developer: Show Running Extensions** and record that the UI Bridge is local while the Workspace Probe is local or remote as expected.
7. Run **Project Steward Attention Spike: Show Status** before starting a manual test and retain its JSON line.

Do not rebuild and reuse an unchanged probe artifact version. UI Bridge is `0.1.2`; Workspace Probe is `0.0.5`. Installing in a different Profile does not update an extension that remains installed in the Profile under test.

## Marker-gated routing automation

Workspace Probe `0.0.5` checks `/tmp/project-steward-attention-routing-control.json` two seconds after activation. The JSON object must contain exactly `protocolVersion`, `runId`, `mode`, `total`, `expiresAtMs`, and `fixtureIdentities`. Distinct-workspace mode is `routing`, total `1000`, with both fixture A and B identities. Same-workspace mode is `same-workspace-routing`, total `200`, with fixture A as the sole identity. Both modes require protocol `1`, a 32-character lowercase hexadecimal run ID, and an expiry in the next 30 minutes. Each activation logs the canonical workspace identity and marker-match decision before running or skipping automation.

A matching fixture writes its completed envelope beneath `/tmp/project-steward-attention-routing-results/<runId>/`. Distinct-workspace results use `<sha256(identity)>.json`; same-workspace results use `<sha256(identity + NUL + workspaceProcessId)>.json`, so two windows cannot overwrite each other. An existing result suppresses replay for the same active probe process. Result files are write-only evidence: neither probe reads their contents, and they never influence routing or aggregation.

## Host matrix

| Fixture | UI Bridge expected host | Workspace Probe expected host | Routing coverage |
| --- | --- | --- | --- |
| Local | Local | Local | Cross-extension routing and same workspace routing |
| Remote SSH | Local | Remote SSH | Cross-host routing |
| WSL | Local | WSL | Cross-host routing |
| Dev Container | Local | Dev Container | Cross-host routing |

Record the **Developer: Show Running Extensions** placement and the pre-test status JSON line for every row. Use the same workspace fixture when checking the same-workspace command, and a separate fixture when checking cross-workspace isolation.

Unresolved `extensionDependencies` or activation on the wrong host is a spike failure. Do not work around either failure by deleting the dependency.
