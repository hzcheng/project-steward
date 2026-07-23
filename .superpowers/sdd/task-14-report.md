# Task 14 Report: Remove live-project compatibility

Date: 2026-07-21

Status: complete

## Delivered

- Deleted the complete v1 live open-project surface in the main extension and
  attention bridge: protocol, projection, publication, stores, bridge client,
  workspace/controller adapters, and dashboard live-project controller.
- Removed the temporary project-shaped AI-session hydration, projection,
  view-model, and project-state compatibility modules. Create, resume, archive,
  terminal, attention, and dashboard actions now accept only a workspace action
  target and carry workspace scope identity, navigation identity, complete root
  snapshot, exact cwd, and root selection through launch/runtime ownership.
- Removed live `Project[]`, `openProjectCardKind`, v1 commands and payloads,
  `_projectStewardOpenProjects*`, old group/session state keys, runtime
  `projectKey`, and all fallback/dual-read/dual-write paths.
- Removed the remaining executable Webview card compatibility markers:
  `data-open-project`, `data-project-navigation`, and `findOpenProjectDiv`.
  Current-workspace tab, batch, announcement, and incremental-update behavior
  now locates only `.workspace-card[data-current-workspace]`; other-window
  navigation accepts only the workspace v2 marker.
- Added `AiSessionWorkspaceStateStore`. Expanded state and active provider are
  keyed only by workspace scope identity and use new `.v2` memento keys. The
  open-workspaces group-collapse state also uses a new `.v2` key. This is the
  intentional pre-release incompatible state cutover; no v1 state is read,
  migrated, or deleted.
- Renamed publication/diagnostic/UI ownership vocabulary to open workspace and
  made the current/other-window UI consume only workspace v2 cards and updates.
  Generated Webview assets are byte-identical to their source scripts.
- Added a recursive production source gate covering main extension sources,
  bridge sources, and the bridge tsconfig. It rejects all required v1 tokens,
  deleted module paths, runtime-identity `projectKey`, and live workspace
  dependencies on saved-project helpers.

## Saved Project Boundary

The saved-project domain remains intentionally intact:

- `Project`, `ProjectService`, serialization, groups, favorites, colors,
  descriptions, ordinary add/remove/edit/order operations, and saved-project
  open behavior are retained.
- `ProjectOpenController` remains only for opening a user-selected saved
  project. `openProjectService` now contains only URI/path/workspace helpers
  required by saved-project and workspace-file/folder behavior.
- The workspace-save adapter and real `ProjectService` migration integration
  tests still prove that existing saved member records are preserved while one
  workspace record is appended.
- The remaining production `projectKey` identifiers occur only inside
  `attentionProject.ts`: they name privacy-hashed attention aggregation keys and
  enrich saved Project rows with attention counts. They are not runtime
  identity, live-card ownership, navigation, or a v1 compatibility reader.

## TDD Evidence

The architecture/source assertions were added before deletion. The initial RED
command was:

```text
npm run test-compile && npm run attention:bridge:compile && npm run test:architecture-baseline
```

Compilation succeeded and the new architecture gate failed on the still-present
`OPEN_PROJECT_PROTOCOL_VERSION` production source, proving that the gate could
observe the compatibility path before it was removed.

Independent review found that the first GREEN still reused `data-open-project`
and retained a dead-but-executable `data-project-navigation` branch. A second
source-gate RED was added before the fix and failed with:

```text
AssertionError: data-open-project remains in production sources:
src/webview/webviewContent.ts, src/webview/webviewProjectScripts.js
```

The compatibility markers/branch were then removed, tests were migrated to the
workspace v2 DOM contract, source/media/styles were added to the architecture
scan, and the original reviewer re-reviewed the result with no remaining
Critical or Important findings and a Ready verdict.

The old tests were not replaced by absence-only assertions. Their active
behavior moved to these v2 fixtures:

| Removed v1 behavior | Retained/replacement v2 coverage |
| --- | --- |
| open-project protocol, projection, publication, store, coordinator, client, controller | workspace protocol/projection/publication/store/coordinator/boundary/client/controller and hardening checks |
| project hydration/projection/view models | workspace scope, assignment, hydration, current-workspace rendering, and workspace state-store checks |
| project create/resume/archive/terminal routing | workspace scope controller launch, launch preflight, workspace-card integration, archive runtime, and tmux runtime-controller checks |
| v1 incremental/search/update messages | exact workspace v2 update messages, workspace rendering, strict v2 search catalog, and source-contract checks |
| live-project save/open fixtures | saved workspace adapter, real ProjectService migration, current-project resolver, and saved ProjectOpenController checks |

The real tmux smoke initially exposed invalid test identifiers containing shell
punctuation. Runtime v2 deliberately accepts session/pending IDs only from
`[A-Za-z0-9._:-]+`. The fixture now uses valid identity IDs while retaining
spaces, quotes, semicolons, `$`, and command-substitution text in cwd, payload,
and title, so its shell-safety coverage remains intact.

## Fresh Verification

The following commands were run together after the last code change:

```text
npm run test-compile
npm run attention:bridge:compile
node scripts/run-open-project-safety-checks.js
node scripts/run-ai-session-safety-checks.js
node scripts/run-ai-session-tmux-checks.js
node scripts/run-dashboard-webview-checks.js
npm run test:tmux:smoke
npm run test:architecture-baseline
npm run lint
git diff --check
```

Every command exited zero. The focused suites reported:

```text
Open workspace safety checks passed.
AI session safety checks passed.
AI session tmux checks passed.
Dashboard Webview checks passed.
AI session tmux smoke checks passed.
```

Lint reported only the repository's pre-existing warnings and no errors. The
required final forbidden-vocabulary scan returned zero matches:

```text
OPEN_PROJECT_PROTOCOL_VERSION
_projectStewardOpenProjects
open-projects/v1
openProjectCardKind
data-open-project
data-project-navigation
findOpenProjectDiv
runtime.identity.projectKey
```

## Compatibility and Residual Risk

- UI-only expansion/provider/group-collapse preferences stored under the old
  live-project keys are intentionally ignored. Saved project records are held
  under separate ProjectService storage and are neither migrated nor removed.
- Automated tests cover local model/controller behavior, bridge persistence and
  isolation, fake tmux behavior, and a real isolated tmux server. End-to-end VS
  Code Extension Host checks across Local, SSH, WSL, and Dev Container remain
  part of Task 15's manual acceptance matrix.
