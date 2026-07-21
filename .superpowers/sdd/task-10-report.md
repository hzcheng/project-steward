# Task 10 Report: Atomic Open-Workspace v2 Cutover

## Status and commit

Complete. The implementation, verification updates, generated Webview asset,
and this report are included in one atomic commit with message:

`feat: publish workspaces through bridge protocol v2`

Nothing was pushed, merged, or cleaned up.

## Outcome

- Cut the desktop UI Bridge and main extension to the exact
  `_projectStewardOpenWorkspaces.*` handshake, publish, unregister, aggregate,
  and diagnostic commands.
- Added an exact v2 capability handshake for `workspaces`, `atomicReplace`, and
  `focusLeases`; mismatches return `accepted: false` with `update-required`.
- Added the `open-workspaces/v2/instances` owner-file store and coordinator,
  preserving atomic writes, bounded payloads/scans, symlink and regular-file
  defenses, malformed-owner isolation, high-water sequence checks, leases,
  one bridge clock, focus stamps, retry delivery, and unregister cleanup.
- Preserved main-extension workspace/root identities while the UI Bridge
  replaces host-authoritative URIs by root ordinal. Saved workspace URIs and
  untitled navigation URIs remain intact; `workspace: null` is never expanded
  from `workspaceFolders`.
- Added the main v2 bridge client, one-workspace publication controller, and
  dashboard controller. Publications contain zero or one workspace; aggregate
  projection emits one current card and one lightweight navigation card per
  other navigation identity.
- Cut the live dashboard, incremental OPEN update, TODO/search catalog, and AI
  incremental update to workspace cards and v2 search catalogs. OTHER WINDOWS
  cards expose metadata and attention only, with no root chips or session
  controls.
- Routed current-card toggle/provider, create, resume, focus/detach, and batch
  archive actions directly through a `WorkspaceAiSessionActionTarget` containing
  the current `OpenWorkspace` and hydrated session surface. The live v2 path
  never selects or synthesizes a member `Project`.
- Kept saved-project data and actions unchanged. Retained v1 source files and
  legacy controller options only for the planned Task 14 deletion; neither
  production extension loads or calls the v1 bridge path.
- Removed the remaining production dependency from the workspace search view
  model to `openProjects/projection`, while preserving saved-project identity
  normalization semantics locally.

## TDD evidence

### RED

The initial Task 10 command compiled both existing projects, then the new safety
contract failed because the v2 main client did not exist:

```text
npm run test-compile
npm run attention:bridge:compile
node scripts/run-open-project-safety-checks.js

Error: Cannot find module '../out/openWorkspaces/bridgeClient'
```

Focused RED cycles also demonstrated:

- the AI incremental builder still emitted version 1 instead of version 2;
- `dashboardViewModel.ts` still loaded `openProjects/projection`;
- the AI Webview replacement did not restore batch-management state; and
- an active-only workspace session could not be focused through the opaque v2
  current-card ID.

Each failure was observed before its production fix.

### GREEN coverage

Added or ported checks for:

- exact handshake success/mismatch, publish/focus/heartbeat/dispose ordering,
  queued unregister, and aggregate/diagnostic routing;
- v2 registry namespace, owner isolation, atomic replacement, v1 registry
  exclusion, malformed/oversized/symlink defenses, lease expiry, sequence
  rollback rejection, bounded aggregate size, focus ordering, null workspace,
  and heartbeat-stable semantic revisions;
- host URI replacement for saved, single-folder, untitled, remote, root-ordinal,
  and null publications;
- one current publication, duplicate navigation-identity collapse, current
  identity reservation, lightweight navigation rendering, workspace counts,
  v2 search results, and rendered acknowledgements;
- workspace-native AI incremental HTML/catalog updates and semantic suppression;
- direct v2-card routing for toggle/provider, create, resume, active-only focus,
  and batch archive, with an exact assertion that the integration performs zero
  legacy member-project reads; and
- production source scans covering the main dashboard, workspace client and
  controllers, AI incremental controller, search/update modules, UI Bridge
  entrypoint/modules, and bridge TypeScript inputs.

## Fresh verification

The final implementation passed:

```text
npm run test-compile
npm run attention:bridge:compile
node scripts/run-open-project-safety-checks.js
node scripts/run-dashboard-webview-checks.js
node scripts/run-ai-session-safety-checks.js
node scripts/run-ai-session-tmux-checks.js
npm run webpack
npm run attention:bridge:bundle
npm run lint
cmp -s src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
git diff --check
```

Observed suite output:

```text
Open project safety checks passed.
Dashboard Webview checks passed.
AI session safety checks passed.
AI session tmux checks passed.
webpack compiled successfully
attention UI Bridge webpack compiled successfully
```

Repository-wide lint exited `0` with the established warning baseline. A
focused lint over every new `src/openWorkspaces` file and every modified AI,
update-message, and search TypeScript file emitted no warnings.

## Self-review

- Critical finding fixed: current workspace cards use opaque workspace IDs, so
  legacy `Project.id` lookup would have made session controls silently no-op.
  All live action controllers now resolve the workspace target first and the
  integration test rejects any member-project access.
- Important finding fixed: AI incremental updates initially retained a v1
  project-shaped message/catalog adapter. They now replace the validated current
  workspace section and publish only the v2 workspace search catalog.
- Important finding fixed: full current-workspace AI replacement now restores
  batch-management DOM state as well as tabs and active-terminal highlighting.
- Important finding fixed: a production workspace search module still imported
  the v1 projection solely for saved-project identity normalization. That
  dependency is removed without changing saved-project fields or behavior.
- Confirmed no v2 bridge/dashboard/navigation card contains `hostPath`, provider
  detail, session detail, or a member-root navigation fallback.
- Confirmed source and generated Webview scripts are byte-identical.
- Confirmed the worktree contains only Task 10 production, test, generated
  asset, and report changes.

## Deferred scope

- Task 11 owns explicit OTHER WINDOWS degradation UI and additional retry/
  lifecycle hardening.
- Task 12 owns the navigation feasibility gate and actual opaque-card switching;
  current navigation clicks refresh safely and never open a root URI.
- Task 14 owns deletion of retained v1 source and legacy controller branches.
