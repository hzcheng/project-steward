# Current Workspace Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Highlight every Project Steward card that represents the workspace or workspace folders opened in the current VS Code window.

**Architecture:** Resolve current saved-project IDs in the Extension Host with the existing remote-aware matcher, then decorate cloned Webview view models with a transient `isCurrentWorkspace` flag. Render that flag as a data attribute and style it exclusively with VS Code theme tokens so local, SSH, Dev Container, Favorites, and Open Project cards share one state without persisting it.

**Tech Stack:** TypeScript, VS Code Extension API, Webview HTML, SCSS/CSS, Node `assert` safety checks, Gulp/Sass.

## Global Constraints

- Highlight every matching card in ordinary Groups, `FAVORITES`, and `OPEN PROJECT`.
- A saved `.code-workspace` matches the current workspace file; folder-mode and multi-root windows match every current workspace folder.
- Reuse the existing URI and remote-aware matcher; never match by display name.
- Keep the state local to the current VS Code window and never write it to settings, global state, imports, or synchronization data.
- Use a subtle selection background, thin theme-colored outline, and restrained glow without labels, icons, flashing, or polling.
- Preserve project color bars, Project Aura, hover actions, Favorites state, and expanded AI session content.
- Do not stage or commit implementation changes before user review.

---

### Task 1: Build Transient Current-Workspace View State

**Files:**
- Create: `src/projects/currentWorkspaceState.ts`
- Modify: `src/models.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/webview/webviewContent.ts`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: `findSavedProjectForOpenProject(savedProjects, uri, currentRemoteName)` and `resolveWorkspaceUris(workspaceFile, workspaceFolders)`.
- Produces: `withCurrentWorkspaceState(groups: Group[], openProjects: Project[], currentProjectIds: string[]): { groups: Group[]; openProjects: Project[] }` and transient `Project.isCurrentWorkspace?: boolean`.

- [ ] **Step 1: Write the failing transient-state test**

Add the compiled helper import and a focused test to `scripts/run-ai-session-safety-checks.js`:

```js
const currentWorkspaceState = require('../out/projects/currentWorkspaceState');

function runCurrentWorkspaceStateChecks() {
    const saved = { id: 'saved', name: 'Saved', path: '/work/saved' };
    const other = { id: 'other', name: 'Other', path: '/work/other' };
    const groups = [{ id: 'group', groupName: 'Work', projects: [saved, other] }];
    const openProjects = [{ id: '__openProjects-0', name: 'Saved', path: '/work/saved' }];

    const result = currentWorkspaceState.withCurrentWorkspaceState(groups, openProjects, ['saved']);

    assert.strictEqual(result.groups[0].projects[0].isCurrentWorkspace, true);
    assert.strictEqual(result.groups[0].projects[1].isCurrentWorkspace, false);
    assert.strictEqual(result.openProjects[0].isCurrentWorkspace, true);
    assert.strictEqual(saved.isCurrentWorkspace, undefined);
    assert.strictEqual(openProjects[0].isCurrentWorkspace, undefined);
    assert.notStrictEqual(result.groups[0], groups[0]);
}
```

Call `runCurrentWorkspaceStateChecks()` alongside the existing safety-check functions.

- [ ] **Step 2: Run the test and verify the missing module failure**

Run `npm run test:safety`.

Expected: compilation or Node execution fails because `out/projects/currentWorkspaceState` does not exist.

- [ ] **Step 3: Implement the pure view-state decorator**

Create `src/projects/currentWorkspaceState.ts`:

```ts
'use strict';

import { Group, Project } from '../models';

export interface CurrentWorkspaceState {
    groups: Group[];
    openProjects: Project[];
}

export function withCurrentWorkspaceState(
    groups: Group[],
    openProjects: Project[],
    currentProjectIds: string[]
): CurrentWorkspaceState {
    let currentIds = new Set((currentProjectIds || []).filter(id => !!id));
    let decoratedGroups = (groups || []).map(group => ({
        ...group,
        projects: (group.projects || []).map(project => ({
            ...project,
            isCurrentWorkspace: currentIds.has(project.id),
        })),
    } as Group));
    let decoratedOpenProjects = (openProjects || []).map(project => ({
        ...project,
        isCurrentWorkspace: true,
    } as Project));

    return { groups: decoratedGroups, openProjects: decoratedOpenProjects };
}
```

Add the transient model property to `Project` in `src/models.ts`:

```ts
isCurrentWorkspace?: boolean;
```

- [ ] **Step 4: Resolve matching saved-project IDs in the Extension Host**

In `src/dashboard.ts`, import `findSavedProjectForOpenProject`, add a getter to `stewardInfos`, and implement:

```ts
function getCurrentWorkspaceProjectIds(): string[] {
    let savedProjects = projectService.getProjectsFlat();
    let matchingIds = resolveWorkspaceUris(
        vscode.workspace.workspaceFile,
        vscode.workspace.workspaceFolders
    ).map(uri => findSavedProjectForOpenProject(savedProjects, uri, vscode.env.remoteName))
        .filter(project => !!project)
        .map(project => project.id);

    return Array.from(new Set(matchingIds));
}
```

Expose the result without storage:

```ts
get currentWorkspaceProjectIds() { return getCurrentWorkspaceProjectIds() },
```

Add the corresponding optional property to `StewardInfos`:

```ts
currentWorkspaceProjectIds?: string[];
```

- [ ] **Step 5: Decorate cloned data before constructing virtual groups**

At the beginning of `getStewardContent` in `src/webview/webviewContent.ts`, replace direct use of `groups` and `infos.openProjects` with:

```ts
var workspaceState = withCurrentWorkspaceState(
    groups,
    infos.openProjects || [],
    infos.currentWorkspaceProjectIds || []
);
groups = workspaceState.groups;
var openProjects = workspaceState.openProjects;
```

Import `withCurrentWorkspaceState` and remove the later duplicate `openProjects` declaration. Build Favorites after decoration so its cards inherit the same flag.

- [ ] **Step 6: Run the focused safety suite**

Run `npm run test:safety`.

Expected: TypeScript compilation succeeds and `runCurrentWorkspaceStateChecks` passes without output or assertion failures.

---

### Task 2: Render and Style the Current-Workspace State

**Files:**
- Modify: `src/webview/webviewContent.ts`
- Modify: `media/styles.scss`
- Generate: `media/styles.css`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: `Project.isCurrentWorkspace` produced by Task 1.
- Produces: `data-current-workspace` on matching `.project` elements and theme-aware sidebar styling.

- [ ] **Step 1: Write failing rendering and style assertions**

Extend `runWebviewContentChecks()` in `scripts/run-ai-session-safety-checks.js`:

```js
const currentProjectStyleBlock = extractScssBlock(sidebarStyles, '&[data-current-workspace]');
const compiledCurrentProjectStyleBlock = extractScssBlock(compiledStyles, 'body.steward-sidebar .project[data-current-workspace]');

assert.ok(webviewContent.includes("project.isCurrentWorkspace ? ' data-current-workspace' : ''"));
assert.ok(currentProjectStyleBlock.includes('var(--vscode-list-inactiveSelectionBackground'));
assert.ok(currentProjectStyleBlock.includes('var(--vscode-focusBorder)'));
assert.ok(currentProjectStyleBlock.includes('box-shadow'));
assert.ok(compiledCurrentProjectStyleBlock.includes('var(--vscode-focusBorder)'));
assert.ok(!currentProjectStyleBlock.includes('animation'));
```

- [ ] **Step 2: Run the test and verify it fails on the missing marker/style**

Run `npm run test:safety`.

Expected: `runWebviewContentChecks` reports an assertion failure for `data-current-workspace` or the SCSS block.

- [ ] **Step 3: Render the data attribute**

In `getProjectDiv()` append this conditional attribute to the `.project` opening tag:

```ts
${project.isCurrentWorkspace ? ' data-current-workspace' : ''}
```

Keep it independent from `data-open-project`, favorite state, and expanded session state.

- [ ] **Step 4: Add the sidebar highlight style after expanded-card overrides**

Inside `body.steward-sidebar .project` in `media/styles.scss`, after the `data-open-project` expanded-hover rules, add:

```scss
&[data-current-workspace],
&[data-current-workspace][data-codex-expanded]:hover {
    background: var(
        --vscode-list-inactiveSelectionBackground,
        var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background))
    );
    border-color: var(--vscode-focusBorder);
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.07),
        0 0 0 1px var(--vscode-focusBorder),
        0 4px 12px var(--vscode-widget-shadow);
}

&[data-current-workspace]:hover {
    border-color: var(--vscode-focusBorder);
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.08),
        0 0 0 1px var(--vscode-focusBorder),
        0 6px 16px var(--vscode-widget-shadow);
}
```

Do not alter `.project-border`, `.project-aura`, favorite/save badges, or session-row styling.

- [ ] **Step 5: Compile SCSS into the shipped CSS**

Run `npx gulp buildStyles`.

Expected: `media/styles.css` is regenerated successfully and contains `.project[data-current-workspace]` selectors.

- [ ] **Step 6: Run rendering and style safety checks**

Run `npm run test:safety`.

Expected: all transient-state, rendering, compiled-CSS, and existing AI-session safety assertions pass.

---

### Task 3: Regression Verification and Manual Review Preparation

**Files:**
- Verify: `src/projects/currentWorkspaceState.ts`
- Verify: `src/models.ts`
- Verify: `src/dashboard.ts`
- Verify: `src/webview/webviewContent.ts`
- Verify: `media/styles.scss`
- Verify: `media/styles.css`
- Verify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: completed state calculation and Webview styling from Tasks 1 and 2.
- Produces: a reviewable, unstaged implementation with reproducible verification evidence.

- [ ] **Step 1: Run static compilation and linting**

Run `npm run test-compile` and `npm run lint`.

Expected: both commands exit with status `0` and report no TypeScript or TSLint errors.

- [ ] **Step 2: Build the production extension bundle**

Run `npm run vscode:prepublish`.

Expected: webpack and production Gulp tasks finish with status `0`, producing `dist/dashboard.js` and current Webview assets.

- [ ] **Step 3: Run the complete safety suite after production generation**

Run `npm run test:safety`.

Expected: command exits with status `0`; generated CSS remains synchronized with SCSS.

- [ ] **Step 4: Inspect persistence and scope in the final diff**

Run:

```bash
git diff --check
git diff -- src/models.ts src/dashboard.ts src/projects/currentWorkspaceState.ts src/webview/webviewContent.ts media/styles.scss media/styles.css scripts/run-ai-session-safety-checks.js
git status --short
```

Expected: no whitespace errors; `isCurrentWorkspace` appears only in transient view-state/rendering code; `.vscode/settings.json` remains an unrelated pre-existing modification; no files are staged.

- [ ] **Step 5: Manual Extension Development Host checks**

Launch the extension with `F5`, then verify:

```text
1. The current saved project is highlighted in its ordinary Group and FAVORITES copy.
2. OPEN PROJECT cards are highlighted even when the current project is not saved.
3. A different project with the same display name is not highlighted.
4. A multi-root folder window highlights every matching saved folder card.
5. SSH and Dev Container cards match their saved remote URI.
6. Hover, expanded sessions, project color bar, aura, favorite star, and save action remain usable.
7. Opening another VS Code window gives that window its own independent highlight.
```

Expected: all seven behaviors match the design with no state added to `projectSteward.projectData`.

- [ ] **Step 6: Stop before staging for user review**

Do not run `git add` or `git commit`. Present the changed files, verification output, and any manual-test limitation to the user for review.
