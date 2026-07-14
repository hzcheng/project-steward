# AI Session Attention Local Bridge Feasibility Report

Date: 2026-07-14
Status: INCOMPLETE

## Current Decision

The Local Bridge architecture has passed both routing matrices in Dev
Container and Remote SSH. In each environment, two independently opened
workspaces each completed 1,000 of 1,000 bidirectional command challenges, and
two windows on the same workspace each completed 200 of 200 challenges. Every
Workspace Probe consistently reached exactly one window-local UI Bridge
process.

The overall Phase 1 gate remains incomplete until the required additional
environments are classified. No Phase 2 file-store implementation is
validated by this partial result. The user explicitly authorized continuing
Phase 2 implementation while retaining the `INCOMPLETE` status.

## Valid Dev Container Distinct-Workspace Attempt

Workspace Probe `0.0.3` consumed a bounded, expiring automation marker and
wrote result envelopes without using the result files for coordination. UI
Bridge Probe `0.0.2` remained unchanged from the manually reviewed routing
probe.

- fixture A: `PASS`, 1,000 attempted, 1,000 completed, one stable Bridge
  process ID;
- fixture B: `PASS`, 1,000 attempted, 1,000 completed, one stable Bridge
  process ID;
- both fixtures used canonical ordered workspace URI paths;
- both reverse Bridge-to-Workspace command assertions completed;
- neither result reported an error.

This validates window-local command routing for two distinct workspaces opened
in separate VS Code windows connected to the same Dev Container. Raw result
envelopes are retained in the evidence JSONL file.

## Valid Dev Container Same-Workspace Attempt

Workspace Probe `0.0.4` added a strictly bounded same-workspace automation
mode. UI Bridge Probe `0.0.2` and the routing protocol remained unchanged.

- window 1: `PASS`, 200 attempted, 200 completed, one stable Bridge process
  ID;
- window 2: `PASS`, 200 attempted, 200 completed, one stable Bridge process
  ID;
- the two Workspace process IDs were different;
- the two Bridge process IDs were different;
- both reverse Bridge-to-Workspace command assertions completed;
- neither result reported an error.

This validates window-local command routing when the same canonical workspace
identity is open in two VS Code windows connected to the same Dev Container.
The process-specific evidence filenames prevented result overwrite but were
never read by either probe.

## Valid Remote SSH Distinct-Workspace Attempt

Workspace Probe `0.0.4` and UI Bridge Probe `0.0.2` ran across the Remote SSH
Workspace/UI Extension Host boundary.

- fixture A: `PASS`, 1,000 attempted, 1,000 completed, one stable Bridge
  process ID;
- fixture B: `PASS`, 1,000 attempted, 1,000 completed, one stable Bridge
  process ID;
- both statuses reported `remoteName: "ssh-remote"`;
- both reverse Bridge-to-Workspace command assertions completed;
- neither result reported an error.

Workspace Probe `0.0.5` subsequently confirmed that both canonical identities
and the marker-match decisions were correct; it did not replay the completed
run because the deterministic result files already existed.

## Valid Remote SSH Same-Workspace Attempt

Two distinct `.code-workspace` fixtures each referenced only fixture A. This
made VS Code create two independent windows while preserving the same
canonical folder identity in both Workspace Probes.

- window 1: `PASS`, 200 attempted, 200 completed, one stable Bridge process
  ID;
- window 2: `PASS`, 200 attempted, 200 completed, one stable Bridge process
  ID;
- both statuses reported `remoteName: "ssh-remote"`;
- the two Workspace process IDs were different;
- the two Bridge process IDs were different;
- neither result reported an error.

This validates window-local command routing for both distinct and colliding
workspace identities over Remote SSH.

## Invalid Dev Container Attempt 1

Both Workspace Probes saw their fixture as a `file:///tmp/...` URI because
they ran inside the remote Workspace Extension Host. Both UI Bridge Probes saw
the same fixture as a `vscode-remote://dev-container+.../tmp/...` URI because
they ran in the local UI Extension Host.

The probe compared complete URI strings. It therefore rejected the same
logical workspace at the Workspace-to-Bridge boundary:

- fixture A: 20 attempted, 0 completed;
- fixture B: 20 attempted, 0 completed;
- no Bridge process ID was accepted;
- the reverse Bridge-to-Workspace command assertion was never reached.

The common path components were `/tmp/project-steward-attention-fixture-a`
and `/tmp/project-steward-attention-fixture-b`; only the host-relative URI
scheme and authority differed. This demonstrates that complete Workspace and
UI Extension Host URI strings are not a valid shared identity in remote
windows. It does not demonstrate command misrouting.

Raw evidence is retained in
`docs/superpowers/reports/evidence/2026-07-14-local-bridge-routing.jsonl` with
classification `INVALID_PROBE_IDENTITY`.

## Unrun Environments

- Local: `NOT RUN`. The current Codex process cannot control the local desktop
  Extension Host or read its local `/tmp` evidence without manual UI work.
- WSL: `NOT RUN`. No WSL environment is available on this Linux host.

## Phase 2 Implementation Status

The disposable Local Bridge spike now contains the profile-local atomic
snapshot protocol, one-writer store, 90-second lease scan/cache, independent
scan interval, optional filesystem watcher accelerator, Workspace aggregation,
and stress/status commands. Unit/build/safety checks pass locally. The Phase 2
cross-window lifecycle, Profile isolation, reload, and performance matrix has
not been executed. It is explicitly classified as `NOT RUN` because the
current Codex environment cannot control or read the user's local desktop UI
Extension Host, so these changes are not a production feasibility claim.

## Phase 2 Runtime Matrix

Status: `NOT RUN`.

Pending checks are three-window publication and aggregation, ten-minute
stress/heartbeat behavior, watcher suppression, normal and forced close
cleanup, reload/handshake recovery, Profile isolation, and latency budget
measurement. Unit tests cover schema validation, atomic replacement, lease
expiry, corruption recovery, rollback rejection, symlink/size filtering, and
deterministic aggregation inputs; they do not replace this runtime matrix.

## Next Gate

The Phase 1 evidence is complete for Dev Container and Remote SSH only. The
random Workspace process ID and reverse command check remain the authoritative
window-local routing assertion. Before shipping, either run Local/WSL or keep
the report `INCOMPLETE` and execute the Phase 2 lifecycle/performance matrix
with the same limitation explicitly recorded.
