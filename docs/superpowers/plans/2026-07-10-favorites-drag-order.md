# Favorites Drag Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to reorder existing favorite project cards by dragging only within the `FAVORITES` group, while preserving ordinary Group order and synchronizing the result with project data.

**Architecture:** Add a pure Favorites ordering module that owns sorting, normalization, and favorite toggling through cloned Group data. The Dashboard persists its output through the existing `ProjectService`, while Webview rendering consumes the same ordering helper and Dragula sends a dedicated `reordered-favorites` message for same-container Favorites drops.

**Tech Stack:** TypeScript, VS Code Extension API, JavaScript Webview scripts, Dragula, Node `assert`/`vm` safety checks, Gulp asset generation.

## Global Constraints

- Create and work on `feat/favorites-order` from `main`; do not implement directly on `main`.
- Allow only `FAVORITES` to `FAVORITES` reordering within the same group container.
- Reject ordinary Group or `OPEN PROJECT` cards entering Favorites, and reject Favorites cards leaving Favorites.
- Never change ordinary Group ordering or project ownership when Favorites is reordered.
- Persist `favoriteOrder?: number` inside existing project data so it follows the current `storeProjectsInSettings` synchronization behavior.
- Append newly favorited projects to the end; clear order when unfavorited; re-favoriting appends again.
- Keep old data without `favoriteOrder` readable and stable.
- Do not add a new configuration key, globalState key, dependency, polling loop, or optimistic Webview persistence.
- Do not stage or commit implementation changes before user review.

---

### Task 1: Implement Pure Favorites Ordering Rules

**Files:**
- Create: `src/projects/favoriteProjectOrder.ts`
- Modify: `src/models.ts`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces: `getFavoriteProjectsInOrder(projects: readonly Project[]): Project[]`.
- Produces: `withFavoriteProjectOrder(groups: readonly Group[], projectIds: readonly string[]): Group[]`.
- Produces: `withToggledProjectFavorite(groups: readonly Group[], projectId: string): Group[] | null`.
- Adds: `Project.favoriteOrder?: number`.

- [ ] **Step 1: Create the feature branch without touching local-only settings**

Run:

```bash
git switch -c feat/favorites-order main
git status --short
```

Expected: branch is `feat/favorites-order`; `.vscode/settings.json` and the untracked design/plan documents remain present; no source files are staged.

- [ ] **Step 2: Write failing ordering tests**

Import `../out/projects/favoriteProjectOrder` in `scripts/run-ai-session-safety-checks.js` and add tests covering:

```js
function runFavoriteProjectOrderChecks() {
    const projects = [
        { id: 'legacy-a', favorite: true },
        { id: 'ordered', favorite: true, favoriteOrder: 0 },
        { id: 'duplicate-a', favorite: true, favoriteOrder: 2 },
        { id: 'duplicate-b', favorite: true, favoriteOrder: 2 },
        { id: 'invalid', favorite: true, favoriteOrder: -1 },
        { id: 'plain', favorite: false, favoriteOrder: 7 },
    ];

    assert.deepStrictEqual(
        favoriteProjectOrder.getFavoriteProjectsInOrder(projects).map(project => project.id),
        ['ordered', 'legacy-a', 'duplicate-a', 'duplicate-b', 'invalid']
    );

    const groups = [
        { id: 'one', projects: [projects[0], projects[1], projects[5]] },
        { id: 'two', projects: [projects[2], projects[3], projects[4]] },
    ];
    const reordered = favoriteProjectOrder.withFavoriteProjectOrder(
        groups,
        ['invalid', 'ordered', 'invalid', 'unknown']
    );

    assert.deepStrictEqual(
        favoriteProjectOrder.getFavoriteProjectsInOrder(reordered.flatMap(group => group.projects)).map(project => project.id),
        ['invalid', 'ordered', 'legacy-a', 'duplicate-a', 'duplicate-b']
    );
    assert.deepStrictEqual(reordered.map(group => group.projects.map(project => project.id)), [
        ['legacy-a', 'ordered', 'plain'],
        ['duplicate-a', 'duplicate-b', 'invalid'],
    ]);
    assert.strictEqual(reordered[0].projects[2].favoriteOrder, undefined);
    assert.strictEqual(projects[0].favoriteOrder, undefined);
}
```

Add separate assertions that toggling a non-favorite appends it after existing favorites, toggling a favorite removes `favoriteOrder`, re-favoriting appends it again, and an unknown ID returns `null`.

- [ ] **Step 3: Run RED verification**

Run `npm run test:safety`.

Expected: failure because `out/projects/favoriteProjectOrder` does not exist.

- [ ] **Step 4: Implement the pure module and model field**

Add `favoriteOrder?: number` beside `favorite?: boolean` in `src/models.ts`.

Create `src/projects/favoriteProjectOrder.ts` with these rules:

```ts
export function getFavoriteProjectsInOrder(projects: readonly Project[]): Project[] {
    let favorites = (projects || []).filter(project => project.favorite);
    let orderCounts = new Map<number, number>();
    for (let project of favorites) {
        if (isValidFavoriteOrder(project.favoriteOrder)) {
            orderCounts.set(project.favoriteOrder, (orderCounts.get(project.favoriteOrder) || 0) + 1);
        }
    }

    return favorites.map((project, sourceIndex) => ({ project, sourceIndex }))
        .sort((left, right) => compareFavoriteEntries(left, right, orderCounts))
        .map(entry => entry.project);
}
```

`withFavoriteProjectOrder` must clone every Group and Project, deduplicate requested IDs, ignore unknown/non-favorite IDs, append omitted favorites using `getFavoriteProjectsInOrder`, assign continuous `0..n-1` values, and remove `favoriteOrder` from non-favorites.

`withToggledProjectFavorite` must return `null` for unknown IDs, otherwise clone all data, derive the current display order before toggling, remove/append the target ID as appropriate, update `favorite`, and normalize through the same order application logic.

- [ ] **Step 5: Run GREEN verification**

Run `npm run test:safety`.

Expected: all ordering, immutability, toggle, and existing safety checks pass.

---

### Task 2: Integrate Favorites Ordering with Rendering and Persistence

**Files:**
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/dashboard.ts`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes: the three functions from `src/projects/favoriteProjectOrder.ts`.
- Consumes Webview message: `{ type: 'reordered-favorites'; projectIds: string[] }`.
- Persists through: `projectService.saveGroups(groups)`.

- [ ] **Step 1: Write failing integration assertions**

Extend safety checks to require:

```js
assert.ok(webviewContent.includes('getFavoriteProjectsInOrder('));
assert.ok(dashboard.includes("case 'reordered-favorites':"));
assert.ok(dashboard.includes('withFavoriteProjectOrder(groups, projectIds)'));
assert.ok(dashboard.includes('withToggledProjectFavorite(groups, projectId)'));
```

Extend the real `getStewardContent()` rendering check with unordered favorite fixtures and assert that Favorites card opening tags occur in `favoriteOrder` order while the ordinary Group section remains in its original order.

- [ ] **Step 2: Run RED verification**

Run `npm run test:safety`.

Expected: source/rendering assertions fail because rendering and Dashboard handlers do not use the new module.

- [ ] **Step 3: Sort only the virtual Favorites projection**

In `src/webview/webviewContent.ts`, import `getFavoriteProjectsInOrder` and change Favorites construction to:

```ts
var favoriteProjects = getFavoriteProjectsInOrder(
    groups.reduce((projects, group) => projects.concat(group.projects || []), [] as Project[])
);
```

Do not sort or replace `groups` or their `projects` arrays.

- [ ] **Step 4: Add the dedicated Dashboard message handler**

In `handleStewardMessage`, add:

```ts
case 'reordered-favorites':
    await reorderFavoriteProjects(Array.isArray(e.projectIds) ? e.projectIds : []);
    break;
```

Implement:

```ts
async function reorderFavoriteProjects(projectIds: string[]) {
    let groups = projectService.getGroups();
    let reorderedGroups = withFavoriteProjectOrder(groups, projectIds);
    await projectService.saveGroups(reorderedGroups);
    refreshAfterMutation();
}
```

- [ ] **Step 5: Replace single-project favorite updates with normalized Group updates**

Change `toggleProjectFavorite` to read all Groups, call `withToggledProjectFavorite`, return when it yields `null`, save the returned Groups once, and refresh. Remove the old `projectService.updateProject` path so append/cleanup normalization is atomic.

- [ ] **Step 6: Run integration verification**

Run `npm run test:safety`.

Expected: sorted rendering and Dashboard source assertions pass; all existing project, window-color, and AI session checks remain green.

---

### Task 3: Restrict Dragula to Favorites Same-Group Reordering

**Files:**
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewDnDScripts.js`
- Generate: `media/webviewDnDScripts.js`
- Test: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces pure Webview predicates: `isFavoritesProjectContainer`, `canMoveProject`, and `canAcceptProject`.
- Produces message: `{ type: 'reordered-favorites'; projectIds: string[] }`.
- Keeps existing `{ type: 'reordered-projects'; groupOrders }` behavior for ordinary Groups.

- [ ] **Step 1: Write failing executable Dragula predicate tests**

Load `src/webview/webviewDnDScripts.js` with Node `vm` without calling `initDnD`. Use fake containers whose `closest()` reports ordinary, Favorites, or Open Project state, then assert:

```js
assert.strictEqual(dnd.canMoveProject(draggable, favorites), true);
assert.strictEqual(dnd.canMoveProject(draggable, openProjects), false);
assert.strictEqual(dnd.canMoveProject(draggable, ordinary), true);
assert.strictEqual(dnd.canAcceptProject(favorites, favorites), true);
assert.strictEqual(dnd.canAcceptProject(ordinary, favorites), false);
assert.strictEqual(dnd.canAcceptProject(favorites, ordinary), false);
assert.strictEqual(dnd.canAcceptProject(ordinaryTwo, ordinary), true);
```

Also assert the source script contains `type: 'reordered-favorites'` and that generated `media/webviewDnDScripts.js` is byte-for-byte identical after generation.

- [ ] **Step 2: Run RED verification**

Run `npm run test:safety`.

Expected: executable checks fail because the named predicates and Favorites message do not exist.

- [ ] **Step 3: Render Favorites cards as draggable virtual copies**

Extend `getProjectDiv` with a boolean that controls whether a virtual card receives container-level `data-nodrag`. Pass `true` only for the Favorites group; preserve `data-virtual-project` so ordinary reorder serialization continues excluding Favorites copies. Open Project cards remain `data-nodrag`.

- [ ] **Step 4: Implement Dragula predicates and specialized drop handling**

At module scope in `src/webview/webviewDnDScripts.js`, implement:

```js
function isFavoritesProjectContainer(container) {
    return Boolean(container && container.closest('[data-system-group="__favorites"]'));
}

function canMoveProject(el, source) {
    if (!el || el.hasAttribute('data-nodrag')) {
        return false;
    }
    return isFavoritesProjectContainer(source) || !source.closest('[data-virtual-group]');
}

function canAcceptProject(target, source) {
    if (isFavoritesProjectContainer(source)) {
        return target === source;
    }
    return !isFavoritesProjectContainer(target) && !target.closest('[data-virtual-group]');
}
```

Use these predicates in Dragula. In the `drop` callback, route Favorites drops to `onFavoritesReordered(source)` and all other drops to the existing `onReordered()`.

`onFavoritesReordered` must collect all Favorites `.project[data-id]` IDs in DOM order and post only `reordered-favorites`.

- [ ] **Step 5: Generate the shipped Webview asset**

Run `npx gulp copyWebviewAssets`.

Expected: `media/webviewDnDScripts.js` exactly matches `src/webview/webviewDnDScripts.js`.

- [ ] **Step 6: Run GREEN verification**

Run `npm run test:safety`.

Expected: all same-group/cross-group predicate checks, message checks, generated asset checks, and existing safety checks pass.

---

### Task 4: Production and Regression Verification

**Files:**
- Verify: `src/projects/favoriteProjectOrder.ts`
- Verify: `src/models.ts`
- Verify: `src/dashboard.ts`
- Verify: `src/webview/webviewContent.ts`
- Verify: `src/webview/webviewDnDScripts.js`
- Verify: `media/webviewDnDScripts.js`
- Verify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Produces a reviewable, unstaged implementation and reproducible verification evidence.

- [ ] **Step 1: Run static checks and production build**

Run:

```bash
npm run test-compile
npm run lint
npm run vscode:prepublish
npm run test:safety
```

Expected: every command exits `0`; lint may report only the repository's existing warning set; webpack and Gulp complete successfully.

- [ ] **Step 2: Verify source/generated asset parity and persistence scope**

Run:

```bash
cmp src/webview/webviewDnDScripts.js media/webviewDnDScripts.js
git diff --check
git status --short
git diff --cached --name-only
```

Expected: scripts are identical, no whitespace errors, no staged files, and `.vscode/settings.json` remains an unrelated local modification.

- [ ] **Step 3: Review the final diff against invariants**

Confirm from the diff and tests:

```text
1. Ordinary Group arrays retain their original project ID order.
2. Only favoriteOrder/favorite fields change during Favorites operations.
3. Old projects without favoriteOrder remain visible.
4. Unknown, duplicate, and omitted IDs cannot remove Favorites.
5. Favorites drag cannot cross any group boundary.
6. Ordinary Group drag and Open Project no-drag behavior remain unchanged.
7. No new settings, globalState keys, dependencies, or polling were added.
```

- [ ] **Step 4: Manual Extension Development Host checks**

Launch with `F5` and verify:

```text
1. Reorder several cards inside FAVORITES and reload the window; order persists.
2. Original Groups do not move or reorder.
3. Dragging Favorites out, ordinary cards in, or Open Project cards does nothing.
4. A newly favorited card appears at the bottom.
5. Unfavorite then re-favorite a card; it returns at the bottom.
6. Escape cancels an active drag without saving.
7. With Settings Sync/project settings storage enabled, favoriteOrder is present in projectData.
```

- [ ] **Step 5: Stop before staging**

Do not run `git add` or `git commit`. Present changed files, automated results, review findings, and any manual-test limitation to the user.
