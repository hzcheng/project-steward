# Shared Dashboard and TODO Visual System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `OPEN`, `PROJECTS`, and `TODO` use the same Dashboard group-header and 58 px item-card shells while preserving all existing project and TODO behavior.

**Architecture:** Existing project and TODO renderers keep their domain classes and `data-action` contracts but emit two fixed shared visual classes: `steward-group-header` and `steward-item-card`. `media/styles.scss` extracts the established sidebar project shell into those classes; project and TODO selectors retain only domain content layout. Existing TODO event delegation, storage, sync, search, and mutations remain unchanged.

**Tech Stack:** TypeScript 4 string renderers, VS Code webview HTML, SCSS/Sass, generated CSS through Gulp, Node `assert` contract checks.

## Global Constraints

- Work only in `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/todo-list` on branch `todo-list-功能`.
- Treat `docs/superpowers/specs/2026-07-17-shared-visual-primitives-design.md` as authoritative for this refactor.
- Do not change TODO storage, Settings Sync, data types, search projection, message types, or mutation behavior.
- Do not change project drag-and-drop, favorites, save state, AI session expansion, attention badges, or current-workspace behavior.
- Do not add dependencies.
- Keep `src/webview/webviewProjectScripts.js` and `media/webviewProjectScripts.js` byte-identical.
- Keep generated `media/styles.css` synchronized with `media/styles.scss`.
- Preserve the existing 58 px collapsed card height, 18 px radius, and `TodoPanelRenderOptions.maxVisibleTodosPerGroup` behavior with its default five-card TODO group viewport.
- Use VS Code theme variables; do not introduce hard-coded theme backgrounds.
- Preserve `hidden`, `aria-expanded`, `aria-label`, keyboard focus, and reduced-motion behavior.
- Shared sidebar shell rules are scoped through `body.steward-sidebar` so legacy non-sidebar project layouts do not change accidentally.

---

## File Structure

- Modify `src/webview/webviewContent.ts`: emit shared group-header, item-card, and accent classes from the project renderer.
- Modify `src/todos/webviewContent.ts`: emit the same shared classes, replace the summary card with a group header, and simplify the empty state.
- Modify `media/styles.scss`: own shared shells in one place and retain only domain content rules under `.project-*` and `.todo-*`.
- Generate `media/styles.css`: compiled/minified output from `media/styles.scss`.
- Modify `scripts/run-dashboard-webview-checks.js`: enforce markup contracts, style ownership, TODO states, and existing interaction contracts.
- Do not modify `src/webview/webviewProjectScripts.js`: its current expansion/editing/scrolling behavior already satisfies the approved design.

---

### Task 1: Establish The Shared Renderer Contract

**Files:**
- Modify: `scripts/run-dashboard-webview-checks.js:439-492`
- Modify: `scripts/run-dashboard-webview-checks.js:1251-1290`
- Modify: `src/webview/webviewContent.ts:348-507`
- Modify: `src/todos/webviewContent.ts:54-199`

**Interfaces:**
- Consumes: `getGroupSection(group: Group, options: GroupSectionOptions, emptyContent?: string)`, `getProjectDiv(project: Project, options: GroupSectionOptions)`, and `getTodoPanelContent(viewModel: TodoPanelViewModel, options?: TodoPanelRenderOptions): string`.
- Produces: project/TODO headers with `steward-group-header`, project/TODO cards with `steward-item-card`, and accent elements with `steward-item-accent`.
- Preserves: all existing `.group`, `.project`, `.todo-group`, `.todo-item`, and `data-action` behavior hooks.

- [ ] **Step 1: Replace the old additive-class assertions with failing shared-shell assertions**

In `runTodoViewModelChecks()`, replace the summary/compact-card assertions with:

```js
assert.ok(html.includes('todo-page-header group-title steward-group-header'));
assert.ok(html.includes('todo-group-header group-title steward-group-header'));
assert.ok(html.includes('todo-item steward-item-card'));
assert.ok(html.includes('todo-item-accent steward-item-accent'));
assert.strictEqual(html.includes('todo-summary-card'), false);
assert.strictEqual(html.includes('steward-card-compact'), false);
assert.ok(html.includes('title="Write &lt;spec&gt;"'));
assert.ok(html.includes('data-action="todo-toggle-show-completed"'));
```

In `runSourceContractChecks()`, replace the old project primitive assertions with:

```js
assert.ok(webviewContentSource.includes('class="group-title steward-section-header steward-group-header"'));
assert.ok(webviewContentSource.includes('class="project steward-item-card"'));
assert.ok(webviewContentSource.includes('class="project-border steward-item-accent"'));
```

- [ ] **Step 2: Run the Dashboard checks and confirm the new contract fails**

Run:

```bash
npm run test:dashboard
```

Expected: FAIL at the first missing `steward-group-header` or `steward-item-card` assertion.

- [ ] **Step 3: Add shared classes to project group and card markup**

In `src/webview/webviewContent.ts`, change the normal and temporary group headers, project card, and accent markup to these class contracts:

```ts
<div class="group-title steward-section-header steward-group-header">
```

```ts
<div class="group-title steward-section-header steward-group-header" data-action="add-group">
```

```ts
<div class="project steward-item-card" style="${projectStyle}" data-id="${project.id}"
```

```ts
<div class="project-border steward-item-accent" style="${borderStyle}"></div>
```

Do not alter project attributes, action wrappers, title/path markup, AI session markup, or drag containers.

- [ ] **Step 4: Replace TODO shell markup while preserving behavior hooks**

In `src/todos/webviewContent.ts`:

1. Remove `steward-card` from the nested edit form so it is not a card inside a card.
2. Replace `steward-card steward-card-compact` on the `<li>` with `steward-item-card`.
3. Add a dedicated accent child before `.todo-item-view`.
4. Add `steward-group-header` to every TODO group header and remove `steward-section-header todo-group-strip`.

Replace `renderTodoItem()` with this implementation; Task 4 will only reorder title and priority within the existing title line:

```ts
function renderTodoItem(todo: TodoItemViewModel): string {
    const completedClass = todo.completed ? ' completed' : '';
    const checked = todo.completed ? ' checked' : '';
    return `<li class="todo-item steward-item-card todo-priority-${todo.priority}${completedClass}" data-todo-id="${escapeHtml(todo.id)}" aria-expanded="false">
        <span class="todo-item-accent steward-item-accent" aria-hidden="true"></span>
        <div class="todo-item-view">
            <div class="todo-item-main">
                <label class="todo-check">
                    <input type="checkbox" data-action="todo-toggle" data-todo-id="${escapeHtml(todo.id)}" aria-label="Complete ${escapeHtml(todo.title)}"${checked}>
                    <span class="todo-checkbox-visual"></span>
                </label>
                <div class="todo-item-content">
                    <div class="todo-title-line">
                        <span class="todo-priority-badge steward-badge">${escapeHtml(todo.priorityLabel)}</span>
                        <span class="todo-title-text" title="${escapeHtml(todo.title)}">${escapeHtml(todo.title)}</span>
                    </div>
                    ${todo.notes ? `<p class="todo-notes">${escapeHtml(todo.notes)}</p>` : ''}
                    <div class="todo-item-footer steward-meta">
                        <span>${todo.completed && todo.completedAt ? `Completed ${escapeHtml(todo.completedAt.slice(0, 10))}` : `Added ${escapeHtml((todo.createdAt || '').slice(0, 10))}`}</span>
                    </div>
                </div>
                <div class="todo-item-actions">
                    <button class="todo-icon-button steward-icon-button" type="button" data-action="todo-edit" data-todo-id="${escapeHtml(todo.id)}" title="Edit todo" aria-label="Edit todo">${Icons.edit}</button>
                    <button class="todo-icon-button steward-icon-button danger" type="button" data-action="todo-delete" data-todo-id="${escapeHtml(todo.id)}" title="Delete todo" aria-label="Delete todo">${Icons.remove}</button>
                </div>
            </div>
        </div>
        ${renderTodoEditForm(todo)}
    </li>`;
}
```

```ts
<header class="todo-group-header group-title steward-group-header">
```

Replace `renderTodoCommandBar()` with a non-collapsible shared header. Keep all three existing actions and their accessible labels:

```ts
return `<header class="todo-page-header group-title steward-group-header">
    <div class="todo-summary-copy">
        <strong>TODO</strong>
        <span class="todo-summary-meta steward-meta">${meta}</span>
    </div>
    <div class="todo-summary-actions group-actions right">
        <button class="todo-square-button steward-icon-button" type="button" data-action="todo-add" title="Add todo" aria-label="Add todo">${Icons.add}</button>
        <button class="todo-square-button steward-icon-button" type="button" data-action="todo-add-group" title="Add group" aria-label="Add group">${Icons.manage}</button>
        <label class="todo-square-toggle steward-icon-button ${viewModel.showCompleted ? 'active' : ''}" title="Show completed" aria-label="Show completed">
            <input type="checkbox" data-action="todo-toggle-show-completed"${viewModel.showCompleted ? ' checked' : ''}>
            <span>${Icons.collapseAll}</span>
        </label>
    </div>
</header>`;
```

For an empty model, keep this header and replace the decorative orb/buttons with:

```ts
<p class="todo-empty-state steward-empty-state">No todos yet</p>
```

- [ ] **Step 5: Run focused checks and review the renderer diff**

Run:

```bash
npm run test:dashboard
git diff --check
git diff -- src/webview/webviewContent.ts src/todos/webviewContent.ts scripts/run-dashboard-webview-checks.js
```

Expected: Dashboard checks pass; `git diff --check` exits 0; no `data-action` values or project data attributes are removed.

- [ ] **Step 6: Commit the shared markup contract**

```bash
git add src/webview/webviewContent.ts src/todos/webviewContent.ts scripts/run-dashboard-webview-checks.js
git commit -m "refactor: share dashboard visual markup"
```

---

### Task 2: Extract The Shared Group Header

**Files:**
- Modify: `scripts/run-dashboard-webview-checks.js:1451-1480`
- Modify: `media/styles.scss:68-176`
- Modify: `media/styles.scss:849-860`
- Modify: `media/styles.scss:940-1000`
- Modify: `media/styles.scss:1215-1313`
- Modify: `media/styles.scss:1862-1948`
- Generate: `media/styles.css`

**Interfaces:**
- Consumes: `.steward-group-header`, `.group-actions`, `.group-title-text`, `.collapse-icon` markup from Task 1.
- Produces: one sidebar group-header shell shared by project groups, the TODO page header, and TODO groups.
- Preserves: `.collapsed`, `data-action="collapse"`, `data-action="todo-collapse-group"`, and global expand/collapse-all behavior.

- [ ] **Step 1: Write failing style-ownership checks**

In `runSourceContractChecks()`, derive the shared sidebar block and assert the exact owner:

```js
const sidebarStyles = extractCssRule(styles, 'body.steward-sidebar');
const sharedGroupHeaderRule = extractCssRule(sidebarStyles, '.steward-group-header');
for (const declaration of [
    'display: flex',
    'width: 100%',
    'padding: 4px 6px',
    'border: 1px solid var(--vscode-panel-border)',
    'border-radius: 7px',
    'background: var(--vscode-list-inactiveSelectionBackground, transparent)',
    'font-size: 15px',
]) {
    assert.ok(sharedGroupHeaderRule.includes(declaration), `shared group header is missing ${declaration}`);
}

const todoGroupHeaderRule = extractCssRule(styles, '.todo-group-header');
for (const forbidden of ['border:', 'border-radius:', 'background:', 'box-shadow:']) {
    assert.strictEqual(todoGroupHeaderRule.includes(forbidden), false, `TODO group header must not own ${forbidden}`);
}
assert.strictEqual(styles.includes('.todo-group-strip'), false);
```

In the selector-presence loop, add `.steward-group-header` and `.todo-page-header`, then remove `.todo-summary-card` and `.todo-group-strip`.

- [ ] **Step 2: Run the Dashboard checks and confirm style ownership fails**

Run:

```bash
npm run test:dashboard
```

Expected: FAIL because `.steward-group-header` does not yet own the sidebar header shell and `.todo-group-strip` still exists.

- [ ] **Step 3: Move the established sidebar group shell into `.steward-group-header`**

Inside `body.steward-sidebar`, add the shared rule below `.groups-wrapper`:

```scss
.steward-group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    width: 100%;
    padding: 4px 6px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 7px;
    color: var(--steward-foreground);
    background: var(--vscode-list-inactiveSelectionBackground, transparent);
    font-family: var(--vscode-font-family);
    font-size: 15px;
    font-weight: 750;
    line-height: 1.25;
    box-sizing: border-box;

    .group-actions {
        display: flex;
        align-items: center;
        gap: 2px;
        flex: 0 0 auto;
        opacity: 0;
        pointer-events: none;
        transition: opacity $defaultTransition $actionTransitionDelay;

        &.right {
            float: none;
        }

        > * {
            display: inline-grid;
            width: 22px;
            height: 22px;
            place-items: center;
            padding: 0;
            border: 0;
            color: currentColor;
            background: transparent;
            cursor: pointer;
        }

        svg {
            width: 14px;
            height: 14px;
            margin: 0;
            fill: currentColor;
        }
    }

    &:hover .group-actions,
    &:focus-within .group-actions {
        opacity: 1;
        pointer-events: all;
    }
}
```

Keep sticky positioning on `.groups-wrapper > .group:not(#tempGroup) .steward-group-header`. Remove the duplicated display, dimensions, padding, border, radius, background, and typography declarations from the nested sidebar `.group .group-title` rule.

- [ ] **Step 4: Reduce TODO header rules to domain layout**

Delete `.todo-summary-card` and `.todo-group-strip` shell rules. Keep `.todo-page-header` and `.todo-group-header` limited to content distribution:

```scss
.todo-page-header,
.todo-group-header {
    justify-content: space-between;
}

.todo-page-header {
    min-height: 28px;
}

.todo-summary-copy {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
}

.todo-summary-copy strong {
    flex: 0 0 auto;
    color: currentColor;
    font: inherit;
}
```

Retain title ellipsis, group count, collapse rotation, and danger hover color. Remove dimensions and icon sizing from `.todo-group-action`, `.todo-square-button`, and `.todo-square-toggle`; `.steward-group-header .group-actions` now owns those controls for project groups, the TODO page header, and TODO groups.

- [ ] **Step 5: Compile CSS and verify the shared group header**

Run:

```bash
npx gulp buildStyles
npm run test:dashboard
git diff --check
```

Expected: Gulp reports `Finished 'buildStyles'`; Dashboard checks pass; whitespace validation exits 0.

- [ ] **Step 6: Commit the shared header extraction**

```bash
git add media/styles.scss media/styles.css scripts/run-dashboard-webview-checks.js
git commit -m "refactor: share dashboard group headers"
```

---

### Task 3: Extract The Shared Item Card And Accent Rail

**Files:**
- Modify: `scripts/run-dashboard-webview-checks.js:1451-1520`
- Modify: `media/styles.scss:861-875`
- Modify: `media/styles.scss:1330-1404`
- Modify: `media/styles.scss:1956-2052`
- Modify: `media/styles.scss:2192-2239`
- Generate: `media/styles.css`

**Interfaces:**
- Consumes: `.steward-item-card` and `.steward-item-accent` emitted by Task 1.
- Produces: one shared 58 px card shell, hover/focus treatment, accent geometry, and expanded/editing/completed/selected states.
- Preserves: `.project-border` color input, `.todo-priority-*` color input, project aura, current-workspace selection, and AI session expansion.

- [ ] **Step 1: Write failing card ownership checks**

Add to `runSourceContractChecks()`:

```js
const sharedItemCardRule = extractCssRule(sidebarStyles, '.steward-item-card');
for (const declaration of [
    'height: 58px',
    'margin: 0 2px 7px 2px',
    'padding: 8px 10px 8px 15px',
    'border: 1px solid var(--vscode-panel-border)',
    'border-radius: 18px',
    'background: var(',
    'box-shadow:',
]) {
    assert.ok(sharedItemCardRule.includes(declaration), `shared item card is missing ${declaration}`);
}

const todoItemRule = extractCssRule(styles, '.todo-item');
for (const forbidden of ['border:', 'border-radius:', 'background:', 'box-shadow:']) {
    assert.strictEqual(todoItemRule.includes(forbidden), false, `TODO item must not own ${forbidden}`);
}

const sidebarProjectRule = extractCssRule(sidebarStyles, '.project');
for (const forbidden of ['height: 58px', 'border-radius: 18px', 'background: var(', 'box-shadow:']) {
    assert.strictEqual(sidebarProjectRule.includes(forbidden), false, `project domain rule must not duplicate ${forbidden}`);
}

const sharedAccentRule = extractCssRule(sidebarStyles, '.steward-item-accent');
assert.ok(sharedAccentRule.includes('left: 7px'));
assert.ok(sharedAccentRule.includes('width: 4px'));
assert.ok(sharedAccentRule.includes('border-radius: 999px'));
assert.ok(sharedItemCardRule.includes('&.completed'));
assert.ok(sharedItemCardRule.includes('&.selected'));
assert.ok(sharedItemCardRule.includes('&[data-current-workspace]'));
assert.ok(sharedItemCardRule.includes('&[data-codex-expanded]:hover'));
assert.strictEqual(styles.includes('.steward-card-compact'), false);

const reducedMotionRule = extractCssRule(styles, '@media (prefers-reduced-motion: reduce)');
assert.ok(reducedMotionRule.includes('.steward-item-card'));
assert.ok(reducedMotionRule.includes('.steward-item-accent'));
assert.ok(reducedMotionRule.includes('transition: none'));
```

In the selector-presence loop, add `.steward-item-card` and `.steward-item-accent`, then remove `.steward-card-compact`.

- [ ] **Step 2: Run checks and confirm the card extraction contract fails**

Run:

```bash
npm run test:dashboard
```

Expected: FAIL because the shell is still owned by the nested sidebar `.project` and `.todo-item` rules.

- [ ] **Step 3: Extract the complete sidebar shell into `.steward-item-card`**

Inside `body.steward-sidebar`, place this rule before `.project`:

```scss
.steward-item-card {
    position: relative;
    box-sizing: border-box;
    width: calc(100% - 4px);
    height: 58px;
    margin: 0 2px 7px 2px;
    padding: 8px 10px 8px 15px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 18px;
    background: var(
        --vscode-sideBarSectionHeader-background,
        var(--vscode-list-inactiveSelectionBackground, var(--vscode-sideBar-background))
    );
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.05),
        0 1px 4px rgba(0, 0, 0, 0.16);
    overflow: hidden;
    transition:
        background $defaultTransition,
        border-color $defaultTransition,
        box-shadow $defaultTransition,
        transform $defaultTransition;

    &::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        opacity: 0;
        background: linear-gradient(120deg, rgba(255, 255, 255, 0.10), transparent 46%);
        transition: opacity 180ms ease;
    }

    &:hover,
    &:focus-within {
        background: var(--vscode-list-hoverBackground);
        border-color: var(--vscode-focusBorder);
        box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.06),
            0 0 0 1px rgba(255, 255, 255, 0.04),
            0 7px 18px var(--vscode-widget-shadow);
        transform: translateY(-1px);

        &::before {
            opacity: 1;
        }
    }

    &.expanded,
    &.editing,
    &[data-codex-expanded] {
        height: auto;
        min-height: 58px;
    }

    &.completed {
        opacity: .75;
    }

    &.expanded:hover,
    &.expanded:focus-within,
    &.editing:hover,
    &.editing:focus-within,
    &[data-codex-expanded]:hover,
    &[data-codex-expanded]:focus-within {
        background: var(
            --vscode-sideBarSectionHeader-background,
            var(--vscode-list-inactiveSelectionBackground, var(--vscode-sideBar-background))
        );
        border-color: var(--vscode-panel-border);
        box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, .04),
            0 1px 4px rgba(0, 0, 0, .14);
        transform: none;

        &::before {
            opacity: 0;
        }
    }

    &.selected,
    &[data-current-workspace] {
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

    &.selected:hover,
    &.selected:focus-within,
    &[data-current-workspace]:hover,
    &[data-current-workspace]:focus-within {
        border-color: var(--vscode-focusBorder);
        box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.08),
            0 0 0 1px var(--vscode-focusBorder),
            0 6px 16px var(--vscode-widget-shadow);
    }
}
```

Move the existing sheen and general hover declarations out of the sidebar `.project` rule. Keep `.project-aura`, icon, title/path, badges, project actions, and AI session content under `.project`.

- [ ] **Step 4: Extract accent geometry and keep domain colors local**

Add the shared geometry:

```scss
.steward-item-accent {
    position: absolute;
    left: 7px;
    top: 31%;
    bottom: 31%;
    width: 4px;
    height: auto;
    border-radius: 999px;
    opacity: .9;
    pointer-events: none;
    box-shadow: 0 0 12px var(--project-color, currentColor);
    transition: top $defaultTransition, bottom $defaultTransition, opacity $defaultTransition;
}

.steward-item-card:hover .steward-item-accent,
.steward-item-card:focus-within .steward-item-accent {
    top: 26%;
    bottom: 26%;
    opacity: 1;
}
```

Keep project inline color behavior through `.project-border`, and replace TODO pseudo-element color rules with child-element rules:

```scss
.todo-item-accent {
    color: var(--vscode-descriptionForeground);
    background: currentColor;
}

.todo-priority-high .todo-item-accent {
    color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground));
}

.todo-priority-medium .todo-item-accent {
    color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-terminal-ansiYellow));
}

.todo-priority-low .todo-item-accent {
    color: var(--vscode-gitDecoration-untrackedResourceForeground, var(--vscode-descriptionForeground));
}
```

Remove the obsolete `.steward-card-compact` rule. Remove shell declarations and `::before` accent geometry from `.todo-item`. Remove height/min-height and expanded-hover shell declarations from project `[data-codex-expanded]`; the shared states now own them. Move the existing current-workspace background, border, shadow, and hover declarations into the shared `.selected, &[data-current-workspace]` state while retaining the existing `data-current-workspace` behavior attribute.

Extend the existing reduced-motion media query with:

```scss
body.steward-sidebar .steward-group-header .group-actions,
body.steward-sidebar .steward-item-card,
body.steward-sidebar .steward-item-card::before,
body.steward-sidebar .steward-item-accent {
    transition: none;
}
```

- [ ] **Step 5: Compile CSS and run Dashboard plus safety regressions**

Run:

```bash
npx gulp buildStyles
npm run test:dashboard
npm run test:safety
git diff --check
```

Expected: Gulp completes; Dashboard checks, AI session safety checks, and Open Project safety checks pass; whitespace validation exits 0.

- [ ] **Step 6: Commit the shared card extraction**

```bash
git add media/styles.scss media/styles.css scripts/run-dashboard-webview-checks.js
git commit -m "refactor: share dashboard item cards"
```

---

### Task 4: Align TODO Collapsed, Expanded, Editing, And Empty States

**Files:**
- Modify: `scripts/run-dashboard-webview-checks.js:450-492`
- Modify: `scripts/run-dashboard-webview-checks.js:1481-1543`
- Modify: `src/todos/webviewContent.ts:90-118`
- Modify: `media/styles.scss:1315-1725`
- Generate: `media/styles.css`

**Interfaces:**
- Consumes: shared card shell and existing `expanded`, `editing`, `completed`, `has-editing-item` state classes.
- Produces: one-line collapsed title/notes, full expanded notes, complete edit form, five-card scrolling, and plain empty content.
- Preserves: `TodoPanelRenderOptions.maxVisibleTodosPerGroup`, `toggleTodoItemExpanded()`, `setTodoEditing()`, `syncTodoListExpandedHeight()`, and `syncTodoPrioritySegment()` without source changes.

- [ ] **Step 1: Write failing TODO state assertions**

Replace the old collapsed-details assertion with explicit preview/detail ownership:

```js
const collapsedNotesRule = extractCssRule(styles, '.todo-item:not(.expanded) .todo-notes');
assert.ok(collapsedNotesRule.includes('white-space: nowrap'));
assert.ok(collapsedNotesRule.includes('text-overflow: ellipsis'));
assert.strictEqual(collapsedNotesRule.includes('display: none'), false);

const collapsedFooterRule = extractCssRule(styles, '.todo-item:not(.expanded) .todo-item-footer');
assert.ok(collapsedFooterRule.includes('display: none'));

const expandedNotesRule = extractCssRule(styles, '.todo-item.expanded .todo-notes');
assert.ok(expandedNotesRule.includes('white-space: pre-wrap'));

const completedRule = extractCssRule(styles, '.todo-item.completed');
assert.strictEqual(completedRule.includes('background:'), false);
assert.strictEqual(completedRule.includes('opacity:'), false);
assert.strictEqual(styles.includes('.todo-item.completed::before'), false);

assert.ok(styles.includes('.todo-list.has-editing-item'));
assert.ok(styles.includes('.todo-item.editing .todo-edit-form'));
assert.strictEqual(styles.includes('.todo-empty-orb'), false);
```

Retain the existing assertions for:

```js
toggleTodoItemExpanded(item, editing)
item.classList.toggle('editing', editing)
list.classList.toggle('has-editing-item'
view.hidden = false
.todo-item[data-todo-id]
!todoItem.classList.contains('editing')
```

Also retain the existing render assertions for `--todo-visible-items: 5`, custom value `--todo-visible-items: 7`, `--todo-collapsed-item-height: 58px`, and `--todo-list-max-height`.

- [ ] **Step 2: Run checks and confirm collapsed notes/empty state fail**

Run:

```bash
npm run test:dashboard
```

Expected: FAIL because collapsed notes are hidden, the completed rule owns a background, or the decorative empty-orb rule still exists.

- [ ] **Step 3: Put title before priority and retain full-title hover**

In `renderTodoItem()`, make `.todo-title-line` read:

```ts
<div class="todo-title-line">
    <span class="todo-title-text" title="${escapeHtml(todo.title)}">${escapeHtml(todo.title)}</span>
    <span class="todo-priority-badge steward-badge">${escapeHtml(todo.priorityLabel)}</span>
</div>
```

Do not remove the native `title`, checkbox label, edit/delete labels, dates, or notes markup.

- [ ] **Step 4: Make collapsed notes a single-line preview and expanded notes complete**

Replace the combined hidden-details rule with:

```scss
.todo-item:not(.expanded) .todo-notes {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.todo-item:not(.expanded) .todo-item-footer {
    display: none;
}

.todo-item.expanded .todo-notes,
.todo-item.editing .todo-notes {
    white-space: pre-wrap;
}
```

Keep `.todo-title-text` at one line with `overflow: hidden`, `text-overflow: ellipsis`, and `white-space: nowrap`. Let the shared card rule own collapsed/expanded height. Keep `.todo-item` limited to grid, gap, and cursor declarations.

- [ ] **Step 5: Preserve the shared shell in completed/editing states and simplify empty content**

Remove `background: transparent` and `opacity` from `.todo-item.completed`, and delete `.todo-item.completed::before`; the shared `.steward-item-card.completed` state owns reduced shell emphasis without forcing the shared sheen visible. Retain strike-through title and lower badge emphasis. Remove `.todo-empty-orb`, `.todo-empty-primary`, and `.todo-empty-secondary` rules. Use:

```scss
.todo-empty-state {
    margin: 18px 4px 0;
    padding: 10px 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    text-align: center;
}
```

Retain these existing scrolling/editing rules exactly:

```scss
.todo-list {
    max-height: calc(var(--todo-list-max-height) + var(--todo-list-expanded-extra-height, 0px));
    overflow-y: auto;
}

.todo-list.has-editing-item {
    max-height: none;
    overflow-y: visible;
}

.todo-item.editing .todo-edit-form {
    display: grid;
}
```

- [ ] **Step 6: Compile, verify, and commit TODO state alignment**

Run:

```bash
npx gulp buildStyles
npm run test:dashboard
npm run test:safety
git diff --check
```

Expected: all commands exit 0; Dashboard, AI session safety, and Open Project safety checks report passing.

Commit:

```bash
git add src/todos/webviewContent.ts media/styles.scss media/styles.css scripts/run-dashboard-webview-checks.js
git commit -m "style: align todo with dashboard cards"
```

---

### Task 5: Build, Install, And Perform Visual Acceptance

**Files:**
- Verify: `src/webview/webviewProjectScripts.js`
- Verify: `media/webviewProjectScripts.js`
- Verify: `media/styles.scss`
- Verify: `media/styles.css`
- Generated package: `artifacts/project-steward-2.0.1.vsix`

**Interfaces:**
- Consumes: all four implementation commits.
- Produces: a locally installed VSIX ready for user acceptance.

- [ ] **Step 1: Run the complete automated verification suite**

Run:

```bash
npx gulp buildStyles copyWebviewAssets
npm run test:dashboard
npm run test:safety
npm run lint
cmp -s src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
git diff --check
```

Expected:

- Gulp completes `buildStyles` and `copyWebviewAssets`.
- `Dashboard Webview checks passed.`
- `AI session safety checks passed.`
- `Open Project safety checks passed.`
- TSLint exits 0.
- `cmp` and `git diff --check` exit 0 without output.

- [ ] **Step 2: Confirm generated assets contain no unstaged surprise**

Run:

```bash
git status --short
git diff -- media/styles.scss media/styles.css src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
```

Expected: no uncommitted source/generated drift. If Gulp changes `media/styles.css`, inspect it, rerun Task 4 verification, and amend only the Task 4 commit before continuing.

- [ ] **Step 3: Build and install the local extension packages**

Run:

```bash
SKIP_NPM_CI=1 npm run install-local
```

Expected final line:

```text
Installed artifacts/project-steward-attention-ui-bridge-0.1.2.vsix and artifacts/project-steward-2.0.1.vsix with code.
```

Reload the VS Code window after installation.

- [ ] **Step 4: Inspect all three tabs at required widths**

At approximately 220, 280, 350, and 420 px sidebar widths, verify:

- project and TODO group headers have the same color, border, radius, typography, spacing, and action reveal;
- project and TODO cards have the same 58 px collapsed height, 18 px radius, background, border, shadow, accent geometry, hover, and focus treatment;
- long project and TODO titles ellipsize without moving controls;
- TODO notes preview stays on one line when collapsed and is complete when expanded;
- no title, priority badge, checkbox, or action overlaps at 220 px.

- [ ] **Step 5: Inspect behavior and theme compatibility**

Verify in dark, light, and high-contrast themes:

- click a TODO card surface to expand/collapse;
- click checkbox/edit/delete controls without toggling the card surface;
- start edit and confirm title, priority, notes, cancel, and save are simultaneously visible;
- change priority and confirm selected feedback appears before save;
- create more than five tasks in one group and confirm overflow scrolling;
- edit the sixth task and confirm the group height cap is temporarily removed, then restored after cancel/save;
- collapse/delete a TODO group and use Dashboard expand/collapse all;
- expand an OPEN project AI session and verify project height, attention badges, favorite/save controls, and current-workspace treatment remain correct;
- confirm empty TODO shows the shared page header plus plain `No todos yet` text.

- [ ] **Step 6: Record acceptance evidence**

Add the exact automated commands and manual combinations checked to the implementation summary. If a visual or behavior check fails, add a focused regression assertion to `scripts/run-dashboard-webview-checks.js`, make the smallest source fix, regenerate CSS, rerun the complete suite, and commit the correction as:

```bash
git add scripts/run-dashboard-webview-checks.js media/styles.scss media/styles.css src/webview/webviewContent.ts src/todos/webviewContent.ts
git commit -m "fix: address shared dashboard visual regression"
```

Do not create an empty correction commit when no fix is required.

---

## Plan Self-Review

- Spec coverage: shared group/header ownership is Task 2; shared card/accent ownership is Task 3; TODO default/expanded/editing/completed/empty/scrolling states are Task 4; responsive, theme, project, AI session, and accessibility regressions are Task 5.
- Scope: only renderers, SCSS, generated CSS, and focused contract checks change. Data, synchronization, messages, and event scripts remain outside the change set.
- Type consistency: no new TypeScript type or runtime interface is introduced. Shared class names are fixed as `steward-group-header`, `steward-item-card`, and `steward-item-accent` throughout.
- Test order: each implementation task begins with a failing contract assertion, then runs the same focused command after implementation.
- Generated assets: every SCSS task regenerates `media/styles.css`; final verification also checks copied webview JavaScript byte-for-byte.
