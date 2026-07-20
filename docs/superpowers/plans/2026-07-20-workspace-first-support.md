# Workspace-First Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every VS Code window appear as zero or one live workspace card, while new and resumed Codex, Kimi, and Claude sessions receive one primary working directory plus every other workspace root through native additional-directory arguments.

**Architecture:** Introduce a live `OpenWorkspace` domain that is separate from persisted `Project` records, and make workspace identity, session assignment, launch scope, runtime ownership, cross-window publication, rendering, navigation, and save adaptation consume that domain directly. Cut transient v1 open-project and project-key runtime state over to workspace protocol/runtime v2 without migration; keep the saved-project store and its persisted schema unchanged.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js assertion-based safety checks, VS Code UI Bridge extension, structured Direct Terminal/tmux launch specs, HTML/CSS/vanilla JavaScript Webview.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-07-20-workspace-first-support-design.md`.
- A VS Code window produces zero or one current-workspace card and zero or one cross-window publication.
- Workspace roots are execution roots and metadata chips, never sibling live-project cards.
- Saved `Project` records, groups, favorites, colors, descriptions, and existing member-folder entries keep their current persisted representation.
- New and resumed multi-root sessions must receive every valid current root or fail before launching; never silently omit a root or grant a common parent.
- Direct Terminal and both tmux layouts must consume the same immutable `AiSessionDirectoryScope` and structured `AiSessionLaunchSpec`.
- Runtime ownership uses `workspaceScopeIdentity`, exact `cwd`, launch-time `workspaceNavigationIdentity`, and the complete launch-time root snapshot. Do not read or migrate legacy `projectKey` bindings or tmux metadata.
- Cross-window protocol v2 uses an `open-workspaces/v2` registry. Do not dual-read, dual-write, or project v1 records.
- Workspace navigation may use only `navigationUri`; it must never fall back to a member root.
- Restricted Mode and a missing `--add-dir` capability block multi-root create/resume while leaving cards and history readable.
- Keep diagnostics privacy-bounded: no prompts, responses, session names, commands, executable paths, raw root paths, or raw exception messages.
- Every task ends green and is committed independently. Do not proceed past the navigation feasibility gate until its real matrix has evidence.

## Change Map

| Boundary | New source of truth | Existing code replaced or adapted |
| --- | --- | --- |
| Live VS Code context | `src/workspaces/types.ts`, `identity.ts`, `contextResolver.ts` | `src/projects/openProjectService.ts` for live cards |
| Session ownership | `sessionAssignment.ts`, `sessionScope.ts` | `projectCandidates.ts`, project-per-root hydration |
| AI launch | `AiSessionDirectoryScope` in provider builders/controllers | builder/controller `cwd` parameters |
| Runtime ownership | workspace runtime identity v2 | every `projectKey` runtime/binding field |
| Current/other cards | `WorkspaceCardViewModel` | live `Project[]` and `openProjectCardKind` |
| Cross-window state | `src/openWorkspaces/*` and bridge `openWorkspace*` | `src/openProjects/*` and bridge `openProject*` |
| Navigation | `WorkspaceNavigationController` | `ProjectOpenController` for other-window cards |
| Save current workspace | `SavedWorkspaceProjectAdapter` | `saveOpenProject(projectId)` URI inference |
| Persisted projects | existing `Project` store unchanged | no migration and no schema rewrite |

---

### Task 1: Resolve one deterministic live workspace snapshot

**Files:**
- Create: `src/workspaces/types.ts`
- Create: `src/workspaces/identity.ts`
- Create: `src/workspaces/contextResolver.ts`
- Modify: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Produces: `OpenWorkspaceKind`, `OpenWorkspaceEnvironment`, `WorkspaceRoot`, `OpenWorkspace`, and `WorkspaceContextResolver.resolve()`.
- Consumes: `workspaceFile`, `workspaceFolders`, `workspace.name`, `env.remoteName`, and URI `scheme`, `authority`, `path`, and `fsPath`.

- [ ] **Step 1: Add failing identity and context tests**

Add `runWorkspaceContextResolverChecks()` to `scripts/run-open-project-safety-checks.js`. Require the compiled modules and assert empty, single-folder, saved multi-root, and untitled multi-root results. Include root reorder, rename, save transition, root add/remove, nested roots, URI encoding, local, SSH, WSL, Dev Container, and generic remote cases.

Use these invariants in the fixture:

```js
const first = resolver.resolve({
    workspaceFile: uri('untitled:Untitled-1'),
    workspaceName: 'Frontend + API',
    remoteName: 'ssh-remote',
    workspaceFolders: [folder('api', remoteUri('/work/api')), folder('web', remoteUri('/work/web'))],
});
const reordered = resolver.resolve({
    workspaceFile: uri('untitled:Untitled-1'),
    workspaceName: 'Renamed',
    remoteName: 'ssh-remote',
    workspaceFolders: [folder('web', remoteUri('/work/web')), folder('api', remoteUri('/work/api'))],
});
assert.strictEqual(first.kind, 'untitledMultiRoot');
assert.strictEqual(first.roots.length, 2);
assert.strictEqual(first.scopeIdentity, reordered.scopeIdentity);
assert.strictEqual(first.navigationIdentity, reordered.navigationIdentity);
assert.deepStrictEqual(reordered.roots.map(root => root.ordinal), [0, 1]);
assert.deepStrictEqual(reordered.roots.map(root => root.hostPath), ['/work/web', '/work/api']);
```

Also assert that changing an untitled URI to `/work/team.code-workspace` changes only `navigationIdentity`, adding `/work/docs` changes only the scope/root fields, and `resolve()` returns `null` for an empty window.

- [ ] **Step 2: Run the focused safety check and verify RED**

```bash
npm run test-compile && node scripts/run-open-project-safety-checks.js
```

Expected: compilation fails because `src/workspaces/contextResolver.ts` and its exported types do not exist.

- [ ] **Step 3: Implement immutable workspace types and identity helpers**

Use the approved shapes exactly:

```ts
export type OpenWorkspaceKind = 'singleFolder' | 'savedMultiRoot' | 'untitledMultiRoot';
export type OpenWorkspaceEnvironment = 'local' | 'ssh' | 'wsl' | 'devContainer' | 'remote';

export interface WorkspaceRoot {
    id: string;
    name: string;
    uri: string;
    hostPath: string;
    ordinal: number;
}

export interface OpenWorkspace {
    navigationIdentity: string;
    scopeIdentity: string;
    kind: OpenWorkspaceKind;
    displayName: string;
    navigationUri: string;
    environment: OpenWorkspaceEnvironment;
    roots: WorkspaceRoot[];
}
```

Normalize URI components before hashing. Derive each root ID from its normalized URI, `navigationIdentity` from the only folder URI or workspace-file URI, and `scopeIdentity` from sorted normalized root URIs. Keep display order in `ordinal`, but exclude it and names from hashes. `hostPath` must be the Extension Host-visible `fsPath` and must not be reconstructed from a `vscode-remote:` string.

- [ ] **Step 4: Run the focused safety check and verify GREEN**

```bash
npm run test-compile && node scripts/run-open-project-safety-checks.js
```

Expected: `Open project safety checks passed.`

- [ ] **Step 5: Commit Task 1**

```bash
git add src/workspaces scripts/run-open-project-safety-checks.js
git commit -m "feat: model the live vscode workspace"
```

---

### Task 2: Select launch roots and assign sessions once per workspace

**Files:**
- Create: `src/workspaces/sessionScope.ts`
- Create: `src/workspaces/sessionAssignment.ts`
- Create: `src/workspaces/primaryRootStore.ts`
- Modify: `src/aiSessions/types.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces: `AiSessionDirectoryScope`, `selectPrimaryWorkspaceRoot()`, `buildAiSessionDirectoryScope()`, `assignPathToWorkspaceRoot()`, and `WorkspacePrimaryRootStore`.
- Consumes: `OpenWorkspace`, active-editor URI, explicit root ID, last-used root ID, and normalized session `cwd`/`workDir`.

- [ ] **Step 1: Add failing primary-root, scope, and assignment tests**

Add `runWorkspaceSessionScopeChecks()` and `runWorkspaceSessionAssignmentChecks()` to the AI safety script. Cover the selection order explicit → active editor → stored root → ordinal zero, nested-root longest match, boundary-safe prefix matching, Windows case normalization, duplicate root paths, and invalid/unreadable roots.

```js
const scope = buildAiSessionDirectoryScope(workspace, {
    explicitRootId: 'root-web',
    isDirectory: value => value !== '/work/missing',
});
assert.deepStrictEqual(scope, {
    workspaceNavigationIdentity: workspace.navigationIdentity,
    workspaceScopeIdentity: workspace.scopeIdentity,
    workspaceRootHostPaths: ['/work/api', '/work/web'],
    primaryRootId: 'root-web',
    primaryCwd: '/work/web',
    additionalDirectories: ['/work/api'],
});
assert.strictEqual(assignPathToWorkspaceRoot('/work/api/packages/core', workspace.roots).id, 'root-api');
assert.strictEqual(assignPathToWorkspaceRoot('/work/api-old', workspace.roots), null);
```

Assert a scope build throws a typed error naming root IDs/names, not raw provider commands, when any root is invalid. Assert the store is keyed only by `scopeIdentity` and ignores a stored root that no longer exists.

- [ ] **Step 2: Run the AI safety check and verify RED**

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: compilation fails on the missing workspace scope modules.

- [ ] **Step 3: Implement the provider-neutral directory contract**

```ts
export interface AiSessionDirectoryScope {
    workspaceNavigationIdentity: string;
    workspaceScopeIdentity: string;
    workspaceRootHostPaths: string[];
    primaryRootId: string;
    primaryCwd: string;
    additionalDirectories: string[];
}
```

Return fresh arrays and freeze/copy scope inputs at runtime boundaries. Normalize and de-duplicate host paths; never replace roots with their common parent. Use `path.relative()` plus separator-aware checks for containment and choose the longest normalized matching root.

- [ ] **Step 4: Run the AI safety check and verify GREEN**

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: `AI session safety checks passed.`

- [ ] **Step 5: Commit Task 2**

```bash
git add src/workspaces src/aiSessions/types.ts scripts/run-ai-session-safety-checks.js
git commit -m "feat: define workspace ai session scope"
```

---

### Task 3: Build provider-native multi-root launch specifications

**Files:**
- Modify: `src/aiSessions/types.ts`
- Modify: `src/aiSessions/commandBuilders.ts`
- Modify: `src/aiSessions/providers.ts`
- Create: `src/aiSessions/providerDirectoryCapability.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Changes: provider builder parameters from `cwd: string` to `scope: AiSessionDirectoryScope`.
- Produces: cached `ProviderDirectoryCapabilityProbe.probe(provider)` with `supported | unsupported | unavailable` results.

- [ ] **Step 1: Add failing launch-spec and capability tests**

Extend `runCommandBuilderChecks()` for new and resume on all providers. Use whitespace, quotes, Unicode, POSIX metacharacters, Windows separators, and at least two additional roots. Assert exact argument arrays before serialization:

```js
assert.deepStrictEqual(buildCodexNewSessionLaunchSpec(scope, 'fix tests', marker), {
    executable: 'codex',
    args: ['--cd', '/work/web', '--add-dir', '/work/api', '--add-dir', '/work/文档', 'fix tests'],
    markerPath: marker,
    windowsDirectShell: 'powershell',
});
assert.deepStrictEqual(buildKimiResumeLaunchSpec('k1', scope, marker).args, [
    '--work-dir', '/work/web', '--add-dir', '/work/api', '--add-dir', '/work/文档', '--resume', 'k1',
]);
assert.deepStrictEqual(buildClaudeResumeLaunchSpec('c1', scope, marker), {
    executable: 'claude',
    args: ['--add-dir', '/work/api', '/work/文档', '--resume', 'c1'],
    cwd: '/work/web', markerPath: marker, windowsDirectShell: 'current',
});
```

Probe tests must verify one bounded `--help` execution per executable per activation, accepted help text for all three CLIs, timeout/nonzero/missing behavior, output-size bounds, and sanitized diagnostics.

- [ ] **Step 2: Run the AI safety check and verify RED**

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: launch builders reject the scope object or omit `--add-dir`.

- [ ] **Step 3: Change builders and add the cached capability probe**

Update `AiSessionProviderDefinition` so every launch and command builder consumes `AiSessionDirectoryScope`. Keep `serializeDirectLaunchCommand()` as the only string serializer. For Claude, pass one `--add-dir` followed by all additional directories; for Codex and Kimi, repeat the flag once per directory. Single-folder scopes have an empty additional list and preserve current command behavior.

The probe executes `[commandName, '--help']` through an injected bounded child-process adapter, caches by resolved executable/provider ID, and never infers support merely from provider presence.

- [ ] **Step 4: Run focused checks and verify GREEN**

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: `AI session safety checks passed.`

- [ ] **Step 5: Commit Task 3**

```bash
git add src/aiSessions/types.ts src/aiSessions/commandBuilders.ts src/aiSessions/providers.ts src/aiSessions/providerDirectoryCapability.ts scripts/run-ai-session-safety-checks.js
git commit -m "feat: launch ai providers with workspace roots"
```

---

### Task 4: Route create and resume through the workspace launch scope

**Files:**
- Modify: `src/aiSessions/creationController.ts`
- Modify: `src/aiSessions/resumeController.ts`
- Modify: `src/aiSessions/commandController.ts`
- Modify: `src/dashboard/messageRouter.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Consumes: current `OpenWorkspace`, `WorkspacePrimaryRootStore`, active editor URI, explicit `rootId`, trust state, and provider directory capability.
- Produces: `create-ai-session` and `resume-ai-session` actions with an optional explicit root and an immutable scope passed to runtime/terminal creation.

- [ ] **Step 1: Add failing controller tests**

Extend creation/resume controller checks for:

- implicit primary selection from the active editor;
- explicit `New Session in…` root selection;
- last-used-root persistence only after a successful start;
- resume retaining historical `cwd` when it still matches a root;
- resume requiring a root picker when historical `cwd` is outside current roots;
- all current roots being recalculated on resume;
- Restricted Mode, invalid root, provider missing, capability unsupported, picker cancellation, and launch failure producing no partial runtime/terminal.

The controller test should assert the handoff, not a reconstructed cwd:

```js
assert.deepStrictEqual(runtimeRequests[0].directoryScope, expectedScope);
assert.strictEqual(runtimeRequests[0].identity.workspaceScopeIdentity, workspace.scopeIdentity);
assert.strictEqual(runtimeRequests[0].identity.cwd, expectedScope.primaryCwd);
assert.deepStrictEqual(primaryRootWrites, [[workspace.scopeIdentity, expectedScope.primaryRootId]]);
```

Add router assertions for `{ type: 'create-ai-session', rootId: 'root-api' }` and `{ type: 'resume-ai-session', rootId: 'root-web' }`.

- [ ] **Step 2: Run controller checks and verify RED**

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js && node scripts/run-dashboard-webview-checks.js
```

Expected: controller signatures still derive a single cwd from a `Project`.

- [ ] **Step 3: Implement scope-first orchestration**

Add a shared preflight returning either a complete scope or a typed user-facing block reason. Check trust and capability before creating marker files, terminals, or tmux objects. Make the resume fallback explicit:

```ts
const historicalRoot = assignPathToWorkspaceRoot(session.cwd || session.workDir, workspace.roots);
const explicitRootId = historicalRoot?.id || await options.pickWorkspaceRoot(workspace, 'resume');
if (!explicitRootId) return;
const directoryScope = buildAiSessionDirectoryScope(workspace, { explicitRootId, isDirectory });
```

Keep title/prompt behavior intact. Pass `directoryScope` to provider builders and runtime requests; do not let the Direct Terminal or tmux backend rebuild it.

- [ ] **Step 4: Run controller checks and verify GREEN**

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js && node scripts/run-dashboard-webview-checks.js
```

Expected: both scripts pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/aiSessions src/dashboard/messageRouter.ts src/dashboard.ts scripts/run-ai-session-safety-checks.js scripts/run-dashboard-webview-checks.js
git commit -m "feat: create and resume sessions in a workspace scope"
```

---

### Task 5: Hard-cut runtime ownership to workspace identity v2

**Files:**
- Modify: `src/aiSessions/runtimeTypes.ts`
- Modify: `src/aiSessions/runtimeCoordinator.ts`
- Modify: `src/aiSessions/directTerminalRuntimeBackend.ts`
- Modify: `src/aiSessions/terminalBindingStore.ts`
- Modify: `src/aiSessions/tmuxAttachBindingStore.ts`
- Modify: `src/aiSessions/tmuxLayout.ts`
- Modify: `src/aiSessions/tmuxRuntimeBindingStore.ts`
- Modify: `src/aiSessions/tmuxRuntimeDiscovery.ts`
- Modify: `src/aiSessions/tmuxRuntimeBackend.ts`
- Modify: `src/aiSessions/activeSessionProjection.ts`
- Modify: `src/aiSessions/pendingTerminalResolver.ts`
- Modify: `src/aiSessions/commandController.ts`
- Modify: `src/aiSessions/dashboardController.ts`
- Modify: `src/aiSessions/projectStateStore.ts`
- Modify: `src/aiSessions/terminalCommandController.ts`
- Modify: `src/aiSessions/archiveController.ts`
- Modify: `src/aiSessions/attentionController.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-ai-session-tmux-checks.js`

**Interfaces:**
- Replaces: every runtime/binding `projectKey` with `workspaceScopeIdentity` plus launch-time navigation/root snapshot.
- Produces: v2 managed tmux metadata and v2 Direct Terminal/tmux binding records; legacy records are rejected, not migrated.

- [ ] **Step 1: Add failing v2 ownership and rejection tests**

Update runtime fixtures to this exact identity:

```ts
export interface AiSessionRuntimeIdentity {
    provider: AiSessionProviderId;
    workspaceScopeIdentity: string;
    workspaceNavigationIdentity: string;
    workspaceRootHostPaths: string[];
    cwd: string;
    sessionId?: string;
    pendingId?: string;
}
```

In both safety scripts assert:

- clone/equality/key functions include sorted normalized root snapshots;
- runtime lookup cannot cross `workspaceScopeIdentity` even when cwd/session ID match;
- the scope snapshot remains unchanged after a workspace-root change;
- v1 terminal bindings, tmux bindings, attach bindings, and managed tmux metadata are ignored;
- v2 records round-trip without leaking root paths into generated tmux names;
- Direct Terminal, project-layout tmux, and session-layout tmux receive the already-built launch spec unchanged;
- stale collision/conflict/lifecycle handling remains intact.

Use managed metadata version 2:

```js
assert.deepStrictEqual(parsed, {
    version: 2,
    layout: 'project',
    workspaceScopeIdentity: 'scope-1',
    workspaceNavigationIdentity: 'nav-1',
    workspaceRootHostPaths: ['/work/api', '/work/web'],
    cwd: '/work/web',
    provider: 'codex',
    sessionId: 's1',
});
assert.strictEqual(parseManagedMetadata({ ...parsed, version: 1, projectKey: 'old' }), null);
```

- [ ] **Step 2: Run runtime checks and verify RED**

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js && node scripts/run-ai-session-safety-checks.js
```

Expected: compilation fails on removed/renamed ownership fields.

- [ ] **Step 3: Implement the hard cutover**

Set managed metadata and binding schema versions to 2. Parse exact keys and validate bounded identity strings, normalized root arrays, one-and-only-one session/pending ID, and cwd membership in the stored launch snapshot. Remove all runtime `projectKey` comparisons and storage keys. Do not add a v1 adapter or fallback reader.

Use scope identity for ownership and exact cwd for execution/display. Use hashes of workspace identity for tmux names; never place raw navigation URIs or roots in names or diagnostics.

- [ ] **Step 4: Run runtime checks and verify GREEN**

```bash
npm run test-compile && node scripts/run-ai-session-tmux-checks.js && node scripts/run-ai-session-safety-checks.js
```

Expected: `AI session tmux checks passed.` and `AI session safety checks passed.`

- [ ] **Step 5: Commit Task 5**

```bash
git add src/aiSessions src/dashboard.ts scripts/run-ai-session-safety-checks.js scripts/run-ai-session-tmux-checks.js
git commit -m "feat: bind ai runtimes to workspace identity"
```

---

### Task 6: Hydrate one workspace session surface

**Files:**
- Create: `src/workspaces/sessionHydration.ts`
- Create: `src/workspaces/sessionHydrationController.ts`
- Create: `src/workspaces/viewModels.ts`
- Modify: `src/aiSessions/types.ts`
- Modify: `src/aiSessions/projectCandidates.ts`
- Modify: `src/aiSessions/projectHydration.ts`
- Modify: `src/aiSessions/projectHydrationController.ts`
- Modify: `src/aiSessions/viewModels.ts`
- Modify: `src/aiSessions/commandController.ts`
- Modify: `src/aiSessions/dashboardController.ts`
- Modify: `src/aiSessions/archiveController.ts`
- Modify: `src/aiSessions/attentionController.ts`
- Modify: `src/aiSessions/terminalCommandController.ts`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces: one `WorkspaceAiSessionViewModel` with flat provider histories, active/pending runtimes, root labels, and unavailable-provider state.
- Replaces: live `Project[]` candidate assignment and one hydration result per workspace folder.

- [ ] **Step 1: Add failing workspace hydration tests**

Add `runWorkspaceSessionHydrationChecks()` covering a three-root workspace, nested roots, duplicate provider IDs from overlapping scans, Direct Terminal/tmux pending and active sessions, unavailable providers, and a removed-root active runtime.

```js
assert.strictEqual(result.workspaceScopeIdentity, workspace.scopeIdentity);
assert.deepStrictEqual(result.sessionsByProvider.codex.map(value => [value.id, value.primaryRootId]), [
    ['api-history', 'root-api'],
    ['web-history', 'root-web'],
]);
assert.strictEqual(result.activeSessions[0].primaryRootLabel, 'Outside workspace');
assert.strictEqual(result.activeSessions[0].outsideWorkspace, true);
assert.strictEqual(result.cardCount, undefined, 'hydration must not create per-root cards');
```

Assert each provider is read once with all workspace `hostPath` candidate paths and results are de-duplicated by provider/session ID before sorting.

- [ ] **Step 2: Run the AI safety check and verify RED**

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: the workspace hydration modules do not exist and current hydration returns one `Project` per root.

- [ ] **Step 3: Implement workspace-owned hydration**

Add `primaryRootId`, `primaryRootLabel`, and optional `outsideWorkspace` to session view models. Assign history by longest root match. Include a removed-root active runtime only when continuity is proven by identical navigation identity or root-snapshot overlap; otherwise leave it unmanaged and absent. Inactive history outside current roots is omitted.

Keep old project hydration exports only for saved-project callers during this task; stop using them for the live workspace. Do not add a projection from `OpenWorkspace` back to multiple `Project` instances.

- [ ] **Step 4: Run the AI safety check and verify GREEN**

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js
```

Expected: `AI session safety checks passed.`

- [ ] **Step 5: Commit Task 6**

```bash
git add src/workspaces src/aiSessions scripts/run-ai-session-safety-checks.js
git commit -m "feat: hydrate one workspace session surface"
```

---

### Task 7: Render exactly one current-workspace card

**Files:**
- Modify: `src/models.ts`
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `src/dashboard/webviewUpdateMessages.ts`
- Modify: `src/dashboard/messageRouter.ts`
- Modify: `media/styles.scss`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Produces: `WorkspaceCardViewModel`, `workspace-updated` incremental message v2, root chips, and `new-session-in` action.
- Removes from live UI: `Project.openProjectCardKind`, per-root current cards, root navigation/context menus, and root-specific save actions.

- [ ] **Step 1: Add failing renderer and interaction tests**

Build fixtures for zero, one, and three roots. Assert only one `.workspace-card[data-workspace-scope-identity]`, one AI-session module, folder count/environment metadata, root tags, and root chips only for multi-root workspaces. Assert the primary action posts `create-ai-session` without a root and the secondary action posts `new-session-in`, then the selected root ID.

```js
assert.strictEqual((html.match(/class="workspace-card/g) || []).length, 1);
assert.ok(html.includes('Local · 3 folders'));
assert.ok(html.includes('data-primary-root-id="root-api"'));
assert.strictEqual(html.includes('data-action="selected-project"'), false);
```

Assert the incremental DOM consistency check expects `currentWorkspaceCount` to be 0 or 1 and never compares it with root/session counts.

- [ ] **Step 2: Run renderer checks and verify RED**

```bash
npm run test-compile && node scripts/run-dashboard-webview-checks.js && node scripts/run-ai-session-safety-checks.js
```

Expected: current rendering emits one project card per untitled root and lacks workspace/root metadata.

- [ ] **Step 3: Implement the workspace card and incremental update**

Add a serializable card shape rather than extending persisted `Project`:

```ts
export interface WorkspaceCardViewModel {
    id: string;
    kind: 'current' | 'navigation';
    navigationIdentity: string;
    scopeIdentity: string;
    name: string;
    environmentLabel: string;
    roots: Array<{ id: string; name: string; ordinal: number }>;
    aiSessions?: WorkspaceAiSessionViewModel;
    attentionCount: number;
}
```

Make current roots non-clickable metadata. Keep the existing ACTIVE/SESSIONS tabs, provider filters, pin/archive/focus/attach flows, and flat session ordering. Copy the source Webview script to `media` only through the existing Gulp asset task in verification; do not hand-edit generated copies.

- [ ] **Step 4: Run renderer checks and verify GREEN**

```bash
npm run test-compile && node scripts/run-dashboard-webview-checks.js && node scripts/run-ai-session-safety-checks.js
```

Expected: both scripts pass.

- [ ] **Step 5: Commit Task 7**

```bash
git add src/models.ts src/webview src/dashboard media/styles.scss scripts/run-ai-session-safety-checks.js scripts/run-dashboard-webview-checks.js
git commit -m "feat: render a single current workspace card"
```

---

### Task 8: Aggregate attention and search at workspace level

**Files:**
- Create: `src/workspaces/attentionProjection.ts`
- Modify: `src/aiSessions/attentionProject.ts`
- Modify: `src/webview/dashboardViewModel.ts`
- Modify: `src/webview/webviewDashboardScripts.js`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Produces: workspace-level attention summary and search catalog groups `AI SESSIONS`, `OPEN WORKSPACES`, `SAVED PROJECTS`.
- Consumes: all current root identities plus privacy-bounded other-window root records.

- [ ] **Step 1: Add failing attention/search tests**

Assert two roots with the same session/event evidence produce one unread item, separate events on the same session remain de-duplicated by event ID, and an other-window card joins attention through its root URIs without exposing session details.

For search, assert one current result, one result per other `navigationIdentity`, unchanged saved-project entries, and session result actions that reveal the workspace card/session row rather than a root card.

```js
assert.deepStrictEqual(searchGroups.map(group => group.title), [
    'AI SESSIONS', 'OPEN WORKSPACES', 'SAVED PROJECTS',
]);
assert.strictEqual(catalog.openWorkspaces.filter(item => item.current).length, 1);
assert.strictEqual(catalog.openWorkspaces.some(item => item.rootId), false);
```

- [ ] **Step 2: Run safety and Webview checks and verify RED**

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js && node scripts/run-dashboard-webview-checks.js
```

Expected: attention is keyed to one project path and search still labels `OPEN PROJECTS`.

- [ ] **Step 3: Implement workspace projections**

Aggregate raw attention over every normalized root, de-duplicate by provider session key and event ID, and leave raw bridge payloads unchanged. Rename the search catalog field to `openWorkspaces` in a versioned message boundary; do not infer workspace semantics from `Project.path`. Keep saved-project search construction untouched.

- [ ] **Step 4: Run safety and Webview checks and verify GREEN**

```bash
npm run test-compile && node scripts/run-ai-session-safety-checks.js && node scripts/run-dashboard-webview-checks.js
```

Expected: both scripts pass.

- [ ] **Step 5: Commit Task 8**

```bash
git add src/workspaces src/aiSessions/attentionProject.ts src/webview scripts/run-ai-session-safety-checks.js scripts/run-dashboard-webview-checks.js
git commit -m "feat: project attention and search by workspace"
```

---

### Task 9: Define and project strict open-workspace protocol v2

**Files:**
- Create: `src/openWorkspaces/protocol.ts`
- Create: `src/openWorkspaces/projection.ts`
- Modify: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Produces: publication, registration, aggregate validators, semantic revision, publication records, and one navigation card per `navigationIdentity`.
- Does not consume: v1 open-project publications or legacy project-card fields.

- [ ] **Step 1: Add failing v2 protocol and projection tests**

Require exact version 2 and exact keys for:

```ts
export interface OpenWorkspacePublicationV2 {
    protocolVersion: 2;
    instanceId: string;
    sequence: number;
    followsFocusEvent: boolean;
    workspace: OpenWorkspaceRecord | null;
}
```

Exercise max lengths/counts, control characters, duplicate roots, invalid ordinals, malformed URI/identity/environment/kind, `workspace: null`, deterministic semantic revision, current-instance exclusion, current-navigation reservation, duplicate publisher collapse, most-recent-focus metadata, stable sorting, and attention root metadata.

Explicitly assert `validateOpenWorkspacePublication()` rejects a valid v1 payload and `createOpenWorkspacePublication(workspace)` contains exactly one record, never `roots.length` records.

- [ ] **Step 2: Run open-workspace checks and verify RED**

```bash
npm run test-compile && node scripts/run-open-project-safety-checks.js
```

Expected: `src/openWorkspaces/protocol.ts` does not exist.

- [ ] **Step 3: Implement bounded exact v2 validation and projection**

Use one `workspace` field, root records without `hostPath`, and SHA-256 semantic revisions over semantic fields only. Exclude lease/heartbeat timestamps from the revision. Navigation card IDs must be opaque hashes resolved through the latest in-memory aggregate.

- [ ] **Step 4: Run open-workspace checks and verify GREEN**

```bash
npm run test-compile && node scripts/run-open-project-safety-checks.js
```

Expected: `Open project safety checks passed.` (rename the console label only in the final cleanup task).

- [ ] **Step 5: Commit Task 9**

```bash
git add src/openWorkspaces scripts/run-open-project-safety-checks.js
git commit -m "feat: define open workspace protocol v2"
```

---

### Task 10: Move the UI Bridge registry to `open-workspaces/v2`

**Files:**
- Create: `extensions/attention-ui-bridge/src/openWorkspacePublication.ts`
- Create: `extensions/attention-ui-bridge/src/openWorkspaceStore.ts`
- Create: `extensions/attention-ui-bridge/src/openWorkspaceCoordinator.ts`
- Modify: `extensions/attention-ui-bridge/src/extension.ts`
- Modify: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Produces: protocol-v2 handshake and commands `_projectStewardOpenWorkspaces.bridge.publish`, `.unregister`, and `_projectStewardOpenWorkspaces.workspace.aggregate`.
- Preserves: owner-specific atomic files, single bridge clock, focus stamps, leases, bounded scans, symlink defenses, malformed isolation, retries, and unregister semantics.

- [ ] **Step 1: Add failing store/coordinator/wiring tests**

Port the existing production store and coordinator cases to v2 and add assertions that:

- the registry path ends in `open-workspaces/v2`;
- a workspace publication writes one owner record;
- `workspace: null` unregisters or publishes an empty owner state as specified by the coordinator;
- v1 registry files are never scanned;
- exact handshake mismatch returns `accepted: false` and an update-required error code;
- two publishers of the same navigation identity remain two registrations for focus/lease ownership but project to one card in the main extension;
- heartbeats do not change semantic revision;
- remote URI replacement preserves navigation and root identities correctly.

- [ ] **Step 2: Run bridge checks and verify RED**

```bash
npm run test-compile && npm run attention:bridge:compile && node scripts/run-open-project-safety-checks.js
```

Expected: new bridge modules/commands are absent.

- [ ] **Step 3: Implement the v2 bridge path**

Copy only the security/lifecycle mechanics from the v1 implementation, then change the parsed schema and namespace. The bridge may normalize remote workspace/root URIs but must not synthesize a workspace from `workspaceFolders` when the main extension published `null`. Do not load `open-projects/v1`.

- [ ] **Step 4: Run bridge checks and verify GREEN**

```bash
npm run test-compile && npm run attention:bridge:compile && node scripts/run-open-project-safety-checks.js
```

Expected: all open-workspace bridge checks pass.

- [ ] **Step 5: Commit Task 10**

```bash
git add extensions/attention-ui-bridge/src scripts/run-open-project-safety-checks.js
git commit -m "feat: publish workspaces through bridge protocol v2"
```

---

### Task 11: Integrate the v2 client and other-window workspace cards

**Files:**
- Create: `src/openWorkspaces/bridgeClient.ts`
- Create: `src/openWorkspaces/workspaceController.ts`
- Create: `src/openWorkspaces/dashboardController.ts`
- Modify: `src/dashboard/webviewUpdateMessages.ts`
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-open-project-safety-checks.js`
- Modify: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Produces: one current publication, one card per other navigation identity, and explicit update-required UI on handshake mismatch.
- Consumes: `WorkspaceContextResolver`, v2 aggregate, current bridge instance ID, and workspace attention projection.

- [ ] **Step 1: Add failing client/controller/incremental rendering tests**

Test handshake success, mismatch without retry storms, queued publish/unregister lifecycle, focus publication, semantic-update skip, aggregate failure degradation, and card grouping. Assert root arrays are metadata only and no session/provider detail crosses the bridge.

```js
assert.strictEqual(cards.filter(card => card.kind === 'current').length, 1);
assert.strictEqual(cards.filter(card => card.kind === 'navigation').length, 2);
assert.strictEqual(cards.some(card => card.roots.some(root => root.hostPath)), false);
assert.strictEqual(state.otherWindows.status, 'update-required');
```

Webview checks must verify `OTHER WINDOWS` has lightweight cards, no session expander, and an actionable bridge-upgrade state that does not disable the current card.

- [ ] **Step 2: Run focused integration checks and verify RED**

```bash
npm run test-compile && npm run attention:bridge:compile && node scripts/run-open-project-safety-checks.js && node scripts/run-dashboard-webview-checks.js
```

Expected: dashboard still publishes/consumes project protocol v1.

- [ ] **Step 3: Wire the new controllers**

Resolve the workspace once per refresh/publication cycle. Publish `workspace: null` on closure. Keep a map from opaque navigation card ID to the latest live `OpenWorkspaceRecord`, and invalidate it on semantic aggregate change. A bridge failure may only change the `OTHER WINDOWS` state.

- [ ] **Step 4: Run focused integration checks and verify GREEN**

```bash
npm run test-compile && npm run attention:bridge:compile && node scripts/run-open-project-safety-checks.js && node scripts/run-dashboard-webview-checks.js
```

Expected: both scripts pass.

- [ ] **Step 5: Commit Task 11**

```bash
git add src/openWorkspaces src/dashboard.ts src/dashboard/webviewUpdateMessages.ts src/webview scripts/run-open-project-safety-checks.js scripts/run-dashboard-webview-checks.js
git commit -m "feat: show one card per open workspace"
```

---

### Task 12: Prove cross-window navigation before enabling it

**Files:**
- Create: `spikes/workspace-navigation/package.json`
- Create: `spikes/workspace-navigation/extension.ts`
- Create: `spikes/workspace-navigation/tsconfig.json`
- Create: `scripts/run-workspace-navigation-spike-checks.js`
- Create: `docs/superpowers/reports/2026-07-20-workspace-navigation-feasibility.md`
- Create: `src/openWorkspaces/navigationCapabilities.ts`
- Create: `src/openWorkspaces/navigationController.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-open-project-safety-checks.js`

**Interfaces:**
- Produces: an evidence-backed direct/fallback policy per workspace kind/environment and `WorkspaceNavigationController.open(cardId)`.
- Consumes: only the latest live record's `navigationUri`; never a member root.

- [ ] **Step 1: Build a disposable navigation probe and its source checks**

The probe command records source/target instance IDs and whether calling `vscode.openFolder(Uri.parse(navigationUri), { forceNewWindow: true })` focuses the already open target without increasing the window count. It must test single-folder, saved multi-root, and untitled multi-root targets in Local, SSH, WSL, and Dev Container hosts.

The automated source check rejects any use of `record.roots[*].uri` in the navigation action and verifies the probe records these outcomes for every cell: `focused-existing`, `opened-duplicate`, `replaced-source`, `unsupported`, or `not-runnable` with a reason.

- [ ] **Step 2: Run the probe source check and real matrix**

```bash
node scripts/run-workspace-navigation-spike-checks.js
```

Then package/install the disposable probe and complete the matrix in the report. Expected hard gate: no environment/kind is marked direct unless it repeatedly yields `focused-existing` with unchanged window count. A result of `opened-duplicate`, `replaced-source`, `unsupported`, or `not-runnable` selects fallback for that cell.

- [ ] **Step 3: Write a failing production navigation test from the recorded matrix**

For each direct cell assert the controller invokes only:

```js
['vscode.openFolder', parseUri(record.navigationUri), { forceNewWindow: true }]
```

For every fallback cell assert saved workspaces invoke `workbench.action.switchWindow`; untitled workspaces show “Save this workspace before switching to it”; and unavailable native switching shows a warning with no open command. Missing/stale card IDs refresh only. Assert no branch calls `vscode.openFolder` with a root URI.

- [ ] **Step 4: Implement the evidence-backed controller and verify GREEN**

Encode only observed `focused-existing` cells as direct in `navigationCapabilities.ts`; all other cells use the approved fallback. Run:

```bash
npm run test-compile && node scripts/run-open-project-safety-checks.js && node scripts/run-workspace-navigation-spike-checks.js
```

Expected: both scripts pass, and the report contains all 12 environment/kind cells with evidence or an explicit fallback reason.

- [ ] **Step 5: Commit Task 12**

```bash
git add spikes/workspace-navigation scripts/run-workspace-navigation-spike-checks.js docs/superpowers/reports/2026-07-20-workspace-navigation-feasibility.md src/openWorkspaces src/dashboard.ts scripts/run-open-project-safety-checks.js
git commit -m "feat: navigate open workspaces without root fallback"
```

---

### Task 13: Save a live workspace without changing saved-project storage

**Files:**
- Create: `src/workspaces/pendingWorkspaceSaveStore.ts`
- Create: `src/workspaces/savedWorkspaceProjectAdapter.ts`
- Modify: `src/projects/projectMutationController.ts`
- Modify: `src/dashboard/messageRouter.ts`
- Modify: `src/dashboard.ts`
- Modify: `scripts/run-open-project-safety-checks.js`
- Modify: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Produces: `saveCurrentWorkspace()` and activation-time `completePendingWorkspaceSave()`.
- Preserves: existing project service/store APIs and `Project` serialization.

- [ ] **Step 1: Add failing save-adapter and restart tests**

Cover:

- single folder saves its folder URI as one project;
- saved multi-root saves its `.code-workspace` URI as one project;
- untitled multi-root writes a bounded pending intent before `workbench.action.saveWorkspaceAs`;
- cancellation, expiry, changed root scope, malformed intent, and unrelated activation create no project;
- matching post-restart saved workspace creates exactly one project and clears intent;
- an existing saved member folder is neither merged nor deleted;
- serializing all pre-existing saved data before/after activation is semantically identical.

```js
assert.deepStrictEqual(savedProjectsAfter.slice(0, savedProjectsBefore.length), savedProjectsBefore);
assert.deepStrictEqual(added.map(project => project.path), ['/work/team.code-workspace']);
assert.strictEqual(pendingStore.read(), null);
```

- [ ] **Step 2: Run open-workspace and Webview checks and verify RED**

```bash
npm run test-compile && node scripts/run-open-project-safety-checks.js && node scripts/run-dashboard-webview-checks.js
```

Expected: current save flow resolves one root/project ID and cannot survive Save Workspace As host restart.

- [ ] **Step 3: Implement the adapter and pending intent**

Persist only `{ version: 1, scopeIdentity, createdAtMs, expiresAtMs }` in extension global state. Match the new saved snapshot by the same root-set fingerprint, then call the unchanged saved-project mutation API with its workspace-file URI. Clear intent on every terminal outcome. Keep the current project store schema and ordinary saved-project open behavior unchanged.

- [ ] **Step 4: Run open-workspace and Webview checks and verify GREEN**

```bash
npm run test-compile && node scripts/run-open-project-safety-checks.js && node scripts/run-dashboard-webview-checks.js
```

Expected: both scripts pass.

- [ ] **Step 5: Commit Task 13**

```bash
git add src/workspaces src/projects/projectMutationController.ts src/dashboard.ts src/dashboard/messageRouter.ts scripts/run-open-project-safety-checks.js scripts/run-dashboard-webview-checks.js
git commit -m "feat: save a live workspace as one project"
```

---

### Task 14: Complete the hard cutover and remove the live-project compatibility path

**Files:**
- Delete: `src/openProjects/bridgeClient.ts`
- Delete: `src/openProjects/dashboardController.ts`
- Delete: `src/openProjects/projection.ts`
- Delete: `src/openProjects/protocol.ts`
- Delete: `src/openProjects/workspaceController.ts`
- Delete: `extensions/attention-ui-bridge/src/openProjectCoordinator.ts`
- Delete: `extensions/attention-ui-bridge/src/openProjectPublication.ts`
- Delete: `extensions/attention-ui-bridge/src/openProjectStore.ts`
- Modify: `src/projects/openProjectService.ts`
- Modify: `src/aiSessions/projectCandidates.ts`
- Modify: `src/aiSessions/projectHydration.ts`
- Modify: `src/aiSessions/projectHydrationController.ts`
- Modify: `src/aiSessions/viewModels.ts`
- Modify: `src/models.ts`
- Modify: `src/dashboard.ts`
- Modify: `extensions/attention-ui-bridge/src/extension.ts`
- Modify: `scripts/run-open-project-safety-checks.js`
- Modify: `scripts/run-ai-session-safety-checks.js`
- Modify: `scripts/run-performance-architecture-baseline-checks.js`

**Interfaces:**
- Removes: v1 open-project protocol/commands, live `Project[]`, `openProjectCardKind`, and runtime `projectKey` vocabulary.
- Retains: saved-project `Project` APIs and workspace-file/folder helpers used by saved-project open/add behavior.

- [ ] **Step 1: Add failing architecture source assertions**

Add a repository scan that fails on production occurrences of:

```text
OPEN_PROJECT_PROTOCOL_VERSION
_projectStewardOpenProjects
open-projects/v1
openProjectCardKind
runtime.identity.projectKey
AiSessionRuntimeIdentity ... projectKey
```

Permit `Project` only in saved-project/group/favorite flows. Assert no live workspace controller imports `openProjectService`, `getOpenProjectsFromWorkspace`, or `ProjectOpenController`.

- [ ] **Step 2: Run compile and architecture checks and verify RED**

```bash
npm run test-compile && npm run attention:bridge:compile && npm run test:architecture-baseline
```

Expected: source assertions find the legacy live-project compatibility path.

- [ ] **Step 3: Delete legacy production code and rename test vocabulary**

Remove v1 modules and commands rather than leaving aliases. Narrow `openProjectService.ts` to helpers still required by saved-project behavior, or rename those helpers if no saved-project caller needs the file. Remove temporary live-project exports from AI hydration modules after all callers use workspace hydration. Rename the safety script/function output from open project to open workspace without changing its package-script entry unless a separate script rename is mechanically complete in the same commit.

- [ ] **Step 4: Run compile, architecture, and focused suites and verify GREEN**

```bash
npm run test-compile
npm run attention:bridge:compile
node scripts/run-open-project-safety-checks.js
node scripts/run-ai-session-safety-checks.js
node scripts/run-ai-session-tmux-checks.js
npm run test:architecture-baseline
```

Expected: all commands pass and the source scan finds no v1/runtime-project compatibility surface.

- [ ] **Step 5: Commit Task 14**

```bash
git add -A src/openProjects src/openWorkspaces src/aiSessions src/projects src/dashboard.ts src/models.ts extensions/attention-ui-bridge/src scripts
git commit -m "refactor: remove live project compatibility path"
```

---

### Task 15: Verify packaging, performance, and the acceptance matrix

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `scripts/run-release-notes-checks.js`
- Modify: `scripts/run-release-packaging-checks.js`
- Modify: `docs/superpowers/reports/2026-07-20-workspace-navigation-feasibility.md`
- Create: `docs/superpowers/reports/2026-07-20-workspace-first-acceptance.md`

**Interfaces:**
- Documents: workspace-first behavior, `--add-dir` requirement, Restricted Mode, navigation fallback, saved-project preservation, and intentional transient-state incompatibility.
- Verifies: local/package tests and the manual environment/provider/runtime matrix.

- [ ] **Step 1: Add failing release and packaging assertions**

Require release notes to mention one-card workspaces, all-root AI access, preserved saved projects, v2 bridge requirement, and non-adoption of legacy runtime bindings. Require the VSIX to include all new `out/workspaces`, `out/openWorkspaces`, bridge v2, Webview, and style artifacts, and to exclude spike sources/reports from the packaged extension.

- [ ] **Step 2: Run release checks and verify RED**

```bash
npm run test:release-notes && npm run test:release-packaging
```

Expected: documentation/package assertions fail until the new behavior and artifacts are declared.

- [ ] **Step 3: Update docs and build copied/generated assets**

Document the user behavior and incompatibility boundary. Run the production build so `src/webview/*.js` is copied to `media` by Gulp and both extension bundles are produced:

```bash
npm run vscode:prepublish
npm run attention:bridge:bundle
```

Do not edit minified/generated assets by hand.

- [ ] **Step 4: Run the full automated verification suite**

```bash
npm run lint
npm run test:safety
npm run test:dashboard
npm run test:tmux:smoke
npm run test:architecture-baseline
npm run test:release-notes
npm run test:release-packaging
```

Expected: every command exits 0 with the corresponding passed message. If real tmux smoke is unavailable, record the exact environment reason and run the fake tmux suite; do not mark the acceptance report complete until real smoke passes on a supported host.

- [ ] **Step 5: Execute and record the manual acceptance matrix**

For Local, SSH, WSL, and Dev Container, test single-folder, saved multi-root, and untitled multi-root with Codex, Kimi, and Claude in Direct Terminal, project-layout tmux, and session-layout tmux. Record create, resume, focus/attach, attention, archive, root add/remove, Save Workspace As, close/unregister, cross-window navigation, Restricted Mode, and missing-capability behavior.

All seven hard gates from the design must pass, including byte-for-byte semantic preservation of the saved-project fixture and zero observations of a member root opening as a new single-folder window.

- [ ] **Step 6: Review the final diff for privacy and compatibility boundaries**

```bash
git diff --check HEAD~14..HEAD
rg -n "OPEN_PROJECT_PROTOCOL_VERSION|_projectStewardOpenProjects|open-projects/v1|openProjectCardKind|runtime\.identity\.projectKey" src extensions/attention-ui-bridge/src
git status --short
```

Expected: `git diff --check` is clean, `rg` returns no matches, and status contains only the intended documentation/build artifacts for this task.

- [ ] **Step 7: Commit Task 15**

```bash
git add README.md CHANGELOG.md package.json scripts docs/superpowers/reports media
git commit -m "docs: ship workspace-first support"
```
