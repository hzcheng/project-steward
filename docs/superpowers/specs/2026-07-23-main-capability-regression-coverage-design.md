# Main Capability Regression Coverage Design

Date: 2026-07-23

## Context

The `feat/refactor-and-ci` branch now contains a merge of `origin/main` at
`e9145123b3ad1cdcbc625e52291ae053e8acbce5`. That main revision introduced the
workspace-first model and later fixes for workspace identity, scoped AI
sessions, cross-window publication, attention, tmux ownership and recovery,
Dashboard behavior, and release packaging.

The merged branch currently passes its deterministic Linux and Windows gates,
but a green aggregate test run is not sufficient evidence that every
main-added capability remains represented after test migration. The repository
needs a machine-checkable connection from each main capability family to its
behavior contracts, deterministic PR gate, and, where required, real-host
scheduled gate.

## Goal

Prevent later development from silently removing, weakening, or disconnecting
any behavior introduced by the merged main branch.

## Non-goals

- Reimplementing the workspace-first feature.
- Keeping deleted `openProjects` production modules as compatibility aliases.
- Requiring real VS Code UI automation or a real tmux server in every pull
  request.
- Treating a source-text assertion alone as sufficient proof of user-visible
  behavior when a focused behavioral boundary can be tested.
- Duplicating an existing focused test solely to increase test count.

## Acceptance Policy

All deterministic behavior runs in pull-request CI. Behavior that inherently
requires a real VS Code Extension Host or a real tmux process uses two layers:

1. a deterministic PR test with controlled boundaries; and
2. a scheduled or release smoke test against the real host capability.

A capability is covered only when its behavior test is reachable from the
declared gate. A test file that exists but is not invoked does not count.

## Capability Inventory

Main-only implementation commits are grouped by stable product capability,
rather than recorded as one row per corrective commit. Every non-documentation
main-only commit must map to at least one capability family below. A corrective
commit may map to more than one family.

| Capability | Required preserved behavior | Minimum deterministic evidence | Real-environment evidence |
| --- | --- | --- | --- |
| `MAIN-WORKSPACE-IDENTITY` | Local, SSH, WSL, Dev Container, saved multi-root, untitled multi-root, Unicode, UNC, authority, root order, and whitespace produce stable navigation and scope identities. | Unit and contract tests for context resolution, identity, normalization, and invalid zero-root input. | None. |
| `MAIN-WORKSPACE-SCOPE` | New and resumed Codex, Kimi, and Claude sessions receive one selected primary directory and every valid additional workspace root without partial launch. | Provider launch-spec tests on POSIX and Windows plus preflight/side-effect tests. | Scheduled Extension Host smoke for host wiring. |
| `MAIN-RUNTIME-OWNERSHIP` | Direct and tmux runtimes retain immutable workspace scope, root snapshot, cwd, and display context across resume, conflict, promotion, reload, and removed-root continuity. | Runtime type, coordinator, backend, persistence, hydration, and recovery contracts. | Scheduled Extension Host and real-tmux smoke. |
| `MAIN-WORKSPACE-HYDRATION` | History, active, pending, focused, stale, conflict, outside-workspace, alias, pin, execution, and provider availability project onto one current workspace surface. | Focused hydration and promotion controller tests, including concurrency and retry. | None. |
| `MAIN-OPEN-WORKSPACE-PROTOCOL` | Strict v3 zero-or-one publication per instance, sequence monotonicity, semantic revision stability, bounded aggregation, retry, stale acknowledgement, and prior-semantic recovery remain intact. | Protocol, bridge client, store, coordinator, and dashboard controller contracts. | Scheduled two-extension activation smoke. |
| `MAIN-OTHER-WINDOWS` | OTHER WINDOWS excludes self, de-duplicates by navigation identity, preserves focus order, shows no provider/session details, keeps attention and running summaries, and degrades independently when the bridge is unavailable. | Projection, rendering, incremental DOM rollback, privacy, status, attention-only revision, and degradation tests. | Manual two-window acceptance remains supplemental, not the only gate. |
| `MAIN-WORKSPACE-NAVIGATION` | Navigation targets the exact workspace identity; unsupported direct navigation fails closed to native Switch Window or save-first behavior and never opens a member root as a substitute. | Navigation controller and feasibility-classifier contracts for the 12 environment/workspace cells. | Scheduled Extension Host smoke where a controlled host is available. |
| `MAIN-WORKSPACE-SAVE` | Saving a live folder, saved multi-root, or untitled workspace creates one saved project while preserving existing group/project fields and serializing after migration. | Fixture-based saved adapter, mutation, migration, and pending-save tests. | None. |
| `MAIN-WORKSPACE-WEBVIEW` | Zero/one current card, root metadata, compact narrow layout, intrinsic current shell, unified card styling, exact collapse target, environment titles, session expansion, running animation, and safe incremental replacement remain stable. | Integration DOM and CSS artifact tests plus Dashboard safety checks. | Scheduled Extension Host smoke for activation and resource loading. |
| `MAIN-WORKSPACE-SEARCH` | Search headings, actions, current/other workspace targets, saved-project de-duplication, AI sessions, and TODO reveal remain available under catalog v2. | Dashboard catalog and Webview interaction tests, including malformed and stale update rejection. | None. |
| `MAIN-WORKSPACE-ATTENTION` | Workspace/root/session attention identity, anonymous attention, completion persistence, explicit acknowledgement, terminal close behavior, and synchronized current/other clearing remain stable. | Attention store, projection, controller, rendering, bridge, terminal-close, and acknowledgement contracts. | Scheduled two-extension activation smoke. |
| `MAIN-TMUX-FOCUS` | Healthy focus validates the exact target, avoids full discovery, retries one target change, and performs only bounded metadata reads. | Target snapshot, coordinator fast-path, ownership rejection, and fixed-concurrency tests. | Real-tmux scheduled smoke and bounded performance observation. |
| `MAIN-TMUX-NAMING` | Project/session layouts create readable bounded names, persist exact locators, promote durably, recover after reload, reject renamed foreign containers, and tolerate empty servers. | Naming, layout, store, discovery, promotion, reload, and collision tests. | Real-tmux native `list-sessions`/`list-windows` smoke. |
| `MAIN-TMUX-CLEANUP` | Smoke tests remove only registered fixture roots and isolated servers after planned, launched, stopped, failed, or ambiguous states. | Cleanup registry and mutation tests. | Real-tmux smoke verifies no owned residue. |
| `MAIN-RELEASE-PACKAGING` | Clean builds cannot reuse stale `out`/`dist`; VSIX contents match exact reviewed allowlists and exclude tests, coverage, CI metadata, source, docs, and probes across repeated runs. | Packaging contract with seeded stale outputs and a second-run residue case. | Release workflow packages the same artifacts. |
| `MAIN-CI-WIRING` | Linux, Windows, architecture, coverage, Extension Host, and tmux smoke gates remain reachable from their intended workflow jobs without `continue-on-error`. | CI workflow/parser contracts and mutation cases for missing or miswired commands. | GitHub Actions scheduled and release executions. |

## Coverage Manifest

Create one machine-readable manifest under `docs/testing/` that records:

- capability ID;
- title and concise requirement;
- main-only source commit IDs assigned to the capability;
- required behavior contract IDs;
- PR gate script names;
- optional scheduled gate job names;
- whether real-environment evidence is required.

Commit IDs are lineage evidence, not test selectors. Behavior IDs remain the
stable test contract. The manifest must not contain file paths as substitutes
for behavior IDs.

The manifest covers every non-documentation commit in
`2b34c653119bdf480f2af0330ee3809b51441807..e9145123b3ad1cdcbc625e52291ae053e8acbce5`.
Merge commits may be ignored. Release metadata commits must map to release
packaging or CI wiring.

## Manifest Validator

A deterministic validator must fail when:

- a capability ID is duplicated or malformed;
- a listed main commit is missing, duplicated across no capability, outside the
  audited range, or documentation-only without an explicit exemption;
- a non-documentation main commit has no capability assignment;
- a required behavior ID is absent from `behavior-contracts.json`;
- a required behavior is not `automated`;
- a required behavior has no inspectable owner and evidence;
- a declared PR gate is absent from `package.json`;
- the behavior owner is not reachable from the declared PR gate;
- a required scheduled job is absent from the verification workflow;
- a real-environment capability has no deterministic PR behavior;
- a capability relies only on a legacy compatibility script.

The validator itself must have mutation tests for every failure class. It runs
inside `test:behavior-contracts`, before the longer deterministic suite.

## Coverage Audit and Test Migration

For each capability family:

1. identify current focused unit, contract, and integration owners;
2. identify equivalent assertions still present only in large safety scripts;
3. retain the safety assertion as defense in depth when it checks production
   composition or source reachability;
4. add a focused behavioral owner when no equivalent focused test exists;
5. add a negative or mutation case that proves the owner detects the relevant
   regression;
6. record the behavior ID and gate in the manifest.

Existing behavior tests are reused when they test the same observable contract.
Their names may retain historical `PROJECT` tokens where those tokens are
already public behavior IDs; source/module ownership must use workspace-first
production boundaries.

## CI Layers

### Pull requests

The Linux quality job must run:

- clean compile of both extensions;
- behavior catalog and main capability manifest validation;
- TSLint warning ratchet;
- focused unit, contract, and integration suites;
- workspace, tmux fake, AI session, open-workspace, and Dashboard safety gates;
- architecture guards;
- release note and repeated packaging checks;
- coverage ratchet.

The Windows job must compile and run path plus command serialization behavior
using complete workspace directory scopes.

### Scheduled and release

The scheduled workflow must additionally run:

- pinned VS Code Extension Host activation with both extensions;
- real isolated tmux smoke, including native readable-name assertions and
  cleanup;
- the same Linux and Windows reusable verification jobs used by pull requests.

No scheduled-only result may compensate for a missing deterministic PR test.

## Packaging Repeatability

Packaging validation must exercise a dirty generated-output state. At minimum,
the test must prove exclusion or cleanup of:

- stale root and bridge `out`/`dist`;
- `.ci`;
- `tests`;
- `coverage`;
- documentation and source;
- workspace navigation probes and spike extensions.

The exact main and bridge VSIX allowlists remain authoritative. A package that
contains extra files fails even if extension activation would still work.

## Error Handling

Coverage validation fails closed with bounded diagnostics:

- capability and behavior IDs may be printed;
- repository-relative paths may be printed;
- no environment values, user paths outside the repository, session contents,
  or provider data may be emitted;
- malformed JSON reports the file and structural reason without continuing
  with a partial manifest.

## Verification

Implementation is complete only after fresh successful runs of:

```text
npm run test:behavior-contracts
npm run test:ci:windows
npm run test:ci:linux
npm run test:tmux:smoke
git diff --check
```

The real-tmux command is required only on a host where tmux is available. It
must use the isolated harness and must not mutate the user's default tmux
server.

The Linux CI command must be run after a prior coverage run so repeated
packaging is verified against existing coverage residue.

## Completion Evidence

The final report must include:

- the capability-to-behavior coverage table;
- any main behavior that remains environment-dependent;
- red/green evidence for every new regression test;
- Linux and Windows test counts and exit status;
- real Extension Host and tmux smoke status;
- VSIX entry counts and hashes;
- confirmation that no test file was deleted;
- confirmation that `main` and the primary checkout were not modified.
