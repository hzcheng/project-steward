# Global TODO List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a synchronized global `TODO` Dashboard tab with grouped todos, priorities, completion, inline editing, sorting, and search.

**Architecture:** Keep TODO data independent from `projectData` by adding a focused `TodoService` and TODO view-model/rendering helpers. Extend Dashboard with a third lazy-loaded tab and TODO message handlers, while keeping Open Projects and Projects semantics unchanged. Use lightweight TODO search projection in the initial catalog so `OPEN` startup stays fast.

**Tech Stack:** VS Code extension API, TypeScript 4, existing Dashboard webview JavaScript, existing node-based safety scripts, Settings Sync via VS Code User Settings.

## Global Constraints

- Work only in `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/todo-list`.
- Base branch has already merged latest `origin/main` via merge commit `825c839`.
- `TODO` is global and must not bind to saved/open projects.
- Storage follows `projectSteward.storeProjectsInSettings`: settings when true, `globalState` when false.
- `showCompleted` is local view state, not synchronized TODO data.
- Default top-level "add todo" target is `Inbox`; recreate `Inbox` if missing.
- TODO notes are plain text; no Markdown rendering.
- Search uses a lightweight TODO catalog with `notesSearchText` capped at 500 characters per item.
- First implementation must follow TDD: failing test first, then implementation.
- Do not modify the primary checkout or its `.vscode/settings.json`.

---

## File Structure

- Create `src/todos/types.ts`: TODO data interfaces, constants, validation helpers, and search projection types.
- Create `src/todos/service.ts`: storage selection, migration/copy behavior, and mutations for groups and todos.
- Create `src/todos/viewModel.ts`: render-ready view model and search catalog projection.
- Create `src/todos/webviewContent.ts`: TODO tab HTML rendering helpers.
- Modify `src/constants.ts`: add TODO storage and view-state keys.
- Modify `src/models.ts`: add `todoSearchItems`/TODO view state to `StewardInfos` or a focused nested property.
- Modify `src/webview/dashboardViewModel.ts`: extend `DashboardSearchCatalog` with TODO results.
- Modify `src/webview/webviewContent.ts`: add `TODO` tab button, panel, initial loading/empty content, and TODO search catalog.
- Modify `src/webview/webviewDashboardScripts.js`: support `todo` tab, lazy TODO panel message, TODO search action, and tab keyboard navigation.
- Modify `src/webview/webviewProjectScripts.js`: handle TODO item/group click actions inside Dashboard content.
- Modify `src/dashboard/messageRouter.ts`: register TODO message types.
- Modify `src/dashboard.ts`: instantiate `TodoService`, feed TODO search projection, handle TODO panel and mutations.
- Modify `media/styles.scss`: TODO list, items, editor, priority badges, completed item, and empty state styles.
- Modify `scripts/run-dashboard-webview-checks.js`: TDD coverage for store/view/search/tab/router contracts.
- Modify `package.json`: add `projectSteward.todoData` configuration schema.
- Later generated build files under `media/` may be updated by the repo build process if required.

---

### Task 1: TODO Data Model And Store

**Files:**
- Create: `src/todos/types.ts`
- Create: `src/todos/service.ts`
- Modify: `src/constants.ts`
- Modify: `package.json`
- Test: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Produces: `TodoDataV1`, `TodoGroup`, `TodoItem`, `TodoPriority`, `TodoViewState`, `TodoMutationResult`
- Produces: `normalizeTodoData(value: unknown, nowIso?: string): TodoDataV1`
- Produces: `buildTodoSearchItems(data: TodoDataV1): TodoSearchCatalogItem[]`
- Produces: `class TodoService { getData(): TodoDataV1; saveData(data: TodoDataV1): Thenable<void>; addGroup(title?: string): Promise<TodoDataV1>; addTodo(input: AddTodoInput): Promise<TodoDataV1>; updateTodo(id: string, patch: TodoPatch): Promise<TodoDataV1>; completeTodo(id: string, completed: boolean): Promise<TodoDataV1>; deleteTodo(id: string): Promise<TodoDataV1>; sortGroupByPriority(groupId: string): Promise<TodoDataV1>; }`
- Consumes: `BaseService.useSettingsStorage()`, `context.globalState`, `vscode.workspace.getConfiguration('projectSteward')`

- [ ] **Step 1: Write failing model/store tests**

Add this block near the other service/controller checks in `scripts/run-dashboard-webview-checks.js`:

```js
const todoTypes = require('../out/todos/types');
const { TodoService } = require('../out/todos/service');

async function runTodoStoreChecks() {
    const updates = [];
    const configUpdates = [];
    const globalValues = new Map();
    const configValues = {};
    const makeService = useSettings => new TodoService({
        globalState: {
            get: key => globalValues.get(key),
            update: async (key, value) => { updates.push([key, value]); globalValues.set(key, value); },
        },
        configuration: {
            get: (key, fallback) => Object.prototype.hasOwnProperty.call(configValues, key) ? configValues[key] : fallback,
            update: async (key, value, target) => { configUpdates.push([key, value, target]); configValues[key] = value; },
        },
        useSettingsStorage: () => useSettings,
        now: () => '2026-07-16T00:00:00.000Z',
        generateId: prefix => `${prefix}-id`,
    });

    assert.deepStrictEqual(todoTypes.normalizeTodoData(null), { version: 1, groups: [], todos: [] });
    assert.strictEqual(todoTypes.normalizeTodoPriority('urgent'), 'medium');

    const localService = makeService(false);
    await localService.addTodo({ title: '  Draft PRD  ', notes: 'plain notes', priority: 'high' });
    const localData = localService.getData();
    assert.strictEqual(localData.groups[0].title, 'Inbox');
    assert.strictEqual(localData.todos[0].title, 'Draft PRD');
    assert.strictEqual(localData.todos[0].priority, 'high');
    assert.strictEqual(updates[0][0], 'todoData');
    assert.strictEqual(configUpdates.length, 0);

    await localService.addGroup('   ');
    assert.strictEqual(localService.getData().groups[1].title, 'Untitled Group');

    const todoId = localService.getData().todos[0].id;
    await localService.completeTodo(todoId, true);
    assert.strictEqual(localService.getData().todos[0].completed, true);
    assert.strictEqual(localService.getData().todos[0].completedAt, '2026-07-16T00:00:00.000Z');

    configValues.todoData = { version: 1, groups: [], todos: [] };
    const settingsService = makeService(true);
    await settingsService.addTodo({ title: 'Synced todo', notes: '', priority: 'low' });
    assert.strictEqual(configUpdates[0][0], 'todoData');
    assert.strictEqual(configValues.todoData.todos[0].title, 'Synced todo');
}
```

Call `await runTodoStoreChecks();` from `main()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:dashboard`

Expected: fails with `Cannot find module '../out/todos/types'` or `Cannot find module '../out/todos/service'`.

- [ ] **Step 3: Implement constants and types**

Add to `src/constants.ts`:

```ts
export const TODO_DATA_KEY = 'todoData';
export const TODO_VIEW_STATE_KEY = 'todoViewState';
export const TODO_DEFAULT_GROUP_TITLE = 'Inbox';
export const TODO_UNTITLED_GROUP_TITLE = 'Untitled Group';
export const TODO_NOTES_SEARCH_TEXT_LIMIT = 500;
```

Create `src/todos/types.ts`:

```ts
'use strict';

import {
    TODO_DEFAULT_GROUP_TITLE,
    TODO_NOTES_SEARCH_TEXT_LIMIT,
    TODO_UNTITLED_GROUP_TITLE,
} from '../constants';

export type TodoPriority = 'high' | 'medium' | 'low';

export interface TodoGroup {
    id: string;
    title: string;
    todoIds: string[];
    createdAt: string;
    updatedAt: string;
}

export interface TodoItem {
    id: string;
    groupId: string;
    title: string;
    notes: string;
    priority: TodoPriority;
    completed: boolean;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
}

export interface TodoDataV1 {
    version: 1;
    groups: TodoGroup[];
    todos: TodoItem[];
}

export interface TodoViewState {
    showCompleted: boolean;
}

export interface TodoSearchCatalogItem {
    id: string;
    groupId: string;
    groupTitle: string;
    title: string;
    priority: TodoPriority;
    completed: boolean;
    notesSearchText: string;
    searchText: string;
}

export const TODO_PRIORITY_ORDER: Record<TodoPriority, number> = {
    high: 0,
    medium: 1,
    low: 2,
};

export function normalizeTodoPriority(value: unknown): TodoPriority {
    return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

export function normalizeTodoGroupTitle(value: unknown): string {
    const title = String(value || '').trim();
    return title || TODO_UNTITLED_GROUP_TITLE;
}

export function normalizeTodoTitle(value: unknown): string {
    return String(value || '').trim();
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? value as T[] : [];
}

export function normalizeTodoData(value: unknown): TodoDataV1 {
    const source = value && typeof value === 'object' && (value as { version?: unknown }).version === 1
        ? value as { groups?: unknown; todos?: unknown }
        : { groups: [], todos: [] };
    const groups = asArray<Record<string, unknown>>(source.groups).map(group => ({
        id: asString(group.id),
        title: normalizeTodoGroupTitle(group.title),
        todoIds: asArray<string>(group.todoIds).filter(id => typeof id === 'string' && id),
        createdAt: asString(group.createdAt),
        updatedAt: asString(group.updatedAt),
    })).filter(group => group.id);
    const groupIds = new Set(groups.map(group => group.id));
    const todos = asArray<Record<string, unknown>>(source.todos).map(todo => ({
        id: asString(todo.id),
        groupId: asString(todo.groupId),
        title: normalizeTodoTitle(todo.title),
        notes: asString(todo.notes),
        priority: normalizeTodoPriority(todo.priority),
        completed: todo.completed === true,
        createdAt: asString(todo.createdAt),
        updatedAt: asString(todo.updatedAt),
        completedAt: todo.completedAt === undefined ? undefined : asString(todo.completedAt),
    })).filter(todo => todo.id && todo.groupId && groupIds.has(todo.groupId) && todo.title);
    const todoIds = new Set(todos.map(todo => todo.id));
    groups.forEach(group => {
        group.todoIds = group.todoIds.filter(id => todoIds.has(id));
        todos.filter(todo => todo.groupId === group.id && !group.todoIds.includes(todo.id))
            .forEach(todo => group.todoIds.push(todo.id));
    });
    return { version: 1, groups, todos };
}

export function getTodoNotesSearchText(notes: string): string {
    return String(notes || '').slice(0, TODO_NOTES_SEARCH_TEXT_LIMIT);
}

export function buildTodoSearchItems(data: TodoDataV1): TodoSearchCatalogItem[] {
    const groupsById = new Map(data.groups.map(group => [group.id, group]));
    return data.todos.map(todo => {
        const group = groupsById.get(todo.groupId);
        const notesSearchText = getTodoNotesSearchText(todo.notes);
        const groupTitle = group ? group.title : TODO_DEFAULT_GROUP_TITLE;
        return {
            id: todo.id,
            groupId: todo.groupId,
            groupTitle,
            title: todo.title,
            priority: todo.priority,
            completed: todo.completed,
            notesSearchText,
            searchText: [todo.title, notesSearchText, groupTitle, todo.priority].join(' ').toLowerCase(),
        };
    });
}
```

- [ ] **Step 4: Implement `TodoService`**

Create `src/todos/service.ts`:

```ts
'use strict';

import * as vscode from 'vscode';
import {
    TODO_DATA_KEY,
    TODO_DEFAULT_GROUP_TITLE,
    TODO_UNTITLED_GROUP_TITLE,
} from '../constants';
import { TodoDataV1, TodoGroup, TodoItem, TodoPriority, TODO_PRIORITY_ORDER, normalizeTodoData, normalizeTodoGroupTitle, normalizeTodoPriority, normalizeTodoTitle } from './types';

export interface TodoServiceOptions {
    globalState: Pick<vscode.Memento, 'get' | 'update'>;
    configuration: Pick<vscode.WorkspaceConfiguration, 'get' | 'update'>;
    useSettingsStorage: () => boolean;
    now: () => string;
    generateId: (prefix: string) => string;
}

export interface AddTodoInput {
    groupId?: string;
    title: string;
    notes?: string;
    priority?: TodoPriority;
}

export interface TodoPatch {
    title?: string;
    notes?: string;
    priority?: TodoPriority;
}

export class TodoService {
    constructor(private readonly options: TodoServiceOptions) {
    }

    getData(): TodoDataV1 {
        return normalizeTodoData(this.options.useSettingsStorage()
            ? this.options.configuration.get(TODO_DATA_KEY)
            : this.options.globalState.get(TODO_DATA_KEY));
    }

    async saveData(data: TodoDataV1): Promise<void> {
        const normalized = normalizeTodoData(data);
        if (this.options.useSettingsStorage()) {
            await this.options.configuration.update(TODO_DATA_KEY, normalized, vscode.ConfigurationTarget.Global);
            return;
        }
        await this.options.globalState.update(TODO_DATA_KEY, normalized);
    }

    async addGroup(title = TODO_UNTITLED_GROUP_TITLE): Promise<TodoDataV1> {
        const data = this.getData();
        const group = this.createGroup(title);
        data.groups.push(group);
        await this.saveData(data);
        return data;
    }

    async addTodo(input: AddTodoInput): Promise<TodoDataV1> {
        const title = normalizeTodoTitle(input.title);
        if (!title) {
            throw new Error('A TODO title must be provided.');
        }
        const data = this.ensureTargetGroup(this.getData(), input.groupId);
        const group = data.groups.find(candidate => candidate.id === (input.groupId || data.groups[0].id)) || data.groups[0];
        const now = this.options.now();
        const todo: TodoItem = {
            id: this.options.generateId('todo'),
            groupId: group.id,
            title,
            notes: String(input.notes || ''),
            priority: normalizeTodoPriority(input.priority),
            completed: false,
            createdAt: now,
            updatedAt: now,
        };
        data.todos.unshift(todo);
        group.todoIds.unshift(todo.id);
        group.updatedAt = now;
        await this.saveData(data);
        return data;
    }

    async updateTodo(id: string, patch: TodoPatch): Promise<TodoDataV1> {
        const data = this.getData();
        const todo = data.todos.find(candidate => candidate.id === id);
        if (!todo) {
            return data;
        }
        if (patch.title !== undefined) {
            const title = normalizeTodoTitle(patch.title);
            if (!title) {
                throw new Error('A TODO title must be provided.');
            }
            todo.title = title;
        }
        if (patch.notes !== undefined) {
            todo.notes = String(patch.notes || '');
        }
        if (patch.priority !== undefined) {
            todo.priority = normalizeTodoPriority(patch.priority);
        }
        todo.updatedAt = this.options.now();
        await this.saveData(data);
        return data;
    }

    async completeTodo(id: string, completed: boolean): Promise<TodoDataV1> {
        const data = this.getData();
        const todo = data.todos.find(candidate => candidate.id === id);
        if (!todo) {
            return data;
        }
        const now = this.options.now();
        todo.completed = Boolean(completed);
        todo.completedAt = todo.completed ? now : undefined;
        todo.updatedAt = now;
        await this.saveData(data);
        return data;
    }

    async deleteTodo(id: string): Promise<TodoDataV1> {
        const data = this.getData();
        data.todos = data.todos.filter(todo => todo.id !== id);
        data.groups.forEach(group => {
            group.todoIds = group.todoIds.filter(todoId => todoId !== id);
        });
        await this.saveData(data);
        return data;
    }

    async sortGroupByPriority(groupId: string): Promise<TodoDataV1> {
        const data = this.getData();
        const group = data.groups.find(candidate => candidate.id === groupId);
        if (!group) {
            return data;
        }
        const indexById = new Map(group.todoIds.map((id, index) => [id, index]));
        const todosById = new Map(data.todos.map(todo => [todo.id, todo]));
        group.todoIds = group.todoIds.slice().sort((left, right) => {
            const leftTodo = todosById.get(left);
            const rightTodo = todosById.get(right);
            const leftPriority = leftTodo ? TODO_PRIORITY_ORDER[leftTodo.priority] : 99;
            const rightPriority = rightTodo ? TODO_PRIORITY_ORDER[rightTodo.priority] : 99;
            return leftPriority - rightPriority || (indexById.get(left) || 0) - (indexById.get(right) || 0);
        });
        group.updatedAt = this.options.now();
        await this.saveData(data);
        return data;
    }

    private ensureTargetGroup(data: TodoDataV1, groupId?: string): TodoDataV1 {
        if (groupId && data.groups.some(group => group.id === groupId)) {
            return data;
        }
        let inbox = data.groups.find(group => group.title === TODO_DEFAULT_GROUP_TITLE);
        if (!inbox) {
            inbox = this.createGroup(TODO_DEFAULT_GROUP_TITLE);
            data.groups.unshift(inbox);
        }
        return data;
    }

    private createGroup(title: string): TodoGroup {
        const now = this.options.now();
        return {
            id: this.options.generateId('todo-group'),
            title: normalizeTodoGroupTitle(title),
            todoIds: [],
            createdAt: now,
            updatedAt: now,
        };
    }
}
```

- [ ] **Step 5: Add configuration schema**

Add `projectSteward.todoData` to `package.json` under `contributes.configuration.properties`:

```json
"projectSteward.todoData": {
    "type": ["object", "null"],
    "markdownDescription": "Stores Project Steward global TODO data if the ```projectSteward.storeProjectsInSettings``` option is set to ```true```.",
    "default": null
}
```

- [ ] **Step 6: Run tests to verify Task 1 passes**

Run: `npm run test:dashboard`

Expected: `Dashboard Webview checks passed.`

- [ ] **Step 7: Commit Task 1**

```bash
git add package.json src/constants.ts src/todos/types.ts src/todos/service.ts scripts/run-dashboard-webview-checks.js
git commit -m "feat: add todo data store"
```

---

### Task 2: TODO View Model, HTML, And Search Projection

**Files:**
- Create: `src/todos/viewModel.ts`
- Create: `src/todos/webviewContent.ts`
- Modify: `src/webview/dashboardViewModel.ts`
- Modify: `src/webview/webviewContent.ts`
- Test: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Consumes: `TodoDataV1`, `TodoViewState`, `TodoSearchCatalogItem`
- Produces: `buildTodoViewModel(data: TodoDataV1, viewState: TodoViewState): TodoViewModel`
- Produces: `getTodoPanelContent(viewModel: TodoViewModel): string`
- Produces: `DashboardSearchCatalog.todos: DashboardSearchTodoItem[]`

- [ ] **Step 1: Write failing view/search tests**

Add tests to `runTodoStoreChecks()` or a new `runTodoViewChecks()`:

```js
const todoViewModel = require('../out/todos/viewModel');
const todoWebviewContent = require('../out/todos/webviewContent');

function runTodoViewChecks() {
    const data = todoTypes.normalizeTodoData({
        version: 1,
        groups: [{
            id: 'group-release',
            title: 'Release Plan',
            todoIds: ['todo-a', 'todo-b'],
            createdAt: '2026-07-16T00:00:00.000Z',
            updatedAt: '2026-07-16T00:00:00.000Z',
        }],
        todos: [
            { id: 'todo-a', groupId: 'group-release', title: 'Draft release checklist', notes: 'x'.repeat(600), priority: 'high', completed: false, createdAt: 'now', updatedAt: 'now' },
            { id: 'todo-b', groupId: 'group-release', title: 'Update screenshots', notes: 'done notes', priority: 'low', completed: true, createdAt: 'now', updatedAt: 'now', completedAt: 'now' },
        ],
    });
    const hiddenModel = todoViewModel.buildTodoViewModel(data, { showCompleted: false });
    assert.strictEqual(hiddenModel.openCount, 1);
    assert.strictEqual(hiddenModel.completedCount, 1);
    assert.strictEqual(hiddenModel.groups[0].todos.length, 1);
    const shownModel = todoViewModel.buildTodoViewModel(data, { showCompleted: true });
    assert.strictEqual(shownModel.groups[0].todos.length, 2);
    const html = todoWebviewContent.getTodoPanelContent(hiddenModel);
    assert.ok(html.includes('data-todo-group-id="group-release"'));
    assert.ok(html.includes('Draft release checklist'));
    assert.ok(!html.includes('Update screenshots'));
    const catalog = todoTypes.buildTodoSearchItems(data);
    assert.strictEqual(catalog[0].notesSearchText.length, 500);
    assert.ok(catalog[0].searchText.includes('release plan'));
}
```

Call `runTodoViewChecks();` from `main()`.

Also update `makeDashboardCatalog()` with a `todos` array and assert `filterDashboardCatalog(makeDashboardCatalog(), 'release')` returns `['todos']` when applicable.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:dashboard`

Expected: fails because `../out/todos/viewModel` or `DashboardSearchCatalog.todos` is missing.

- [ ] **Step 3: Implement TODO view model**

Create `src/todos/viewModel.ts`:

```ts
'use strict';

import { TodoDataV1, TodoGroup, TodoItem, TodoPriority, TodoViewState } from './types';

export interface TodoItemViewModel {
    id: string;
    groupId: string;
    title: string;
    notes: string;
    priority: TodoPriority;
    completed: boolean;
}

export interface TodoGroupViewModel {
    id: string;
    title: string;
    openCount: number;
    completedCount: number;
    todos: TodoItemViewModel[];
}

export interface TodoViewModel {
    groups: TodoGroupViewModel[];
    openCount: number;
    completedCount: number;
    groupCount: number;
    showCompleted: boolean;
    empty: boolean;
}

export function buildTodoViewModel(data: TodoDataV1, viewState: TodoViewState): TodoViewModel {
    const todosById = new Map(data.todos.map(todo => [todo.id, todo]));
    const groups = data.groups.map(group => buildGroupViewModel(group, todosById, viewState.showCompleted));
    const openCount = data.todos.filter(todo => !todo.completed).length;
    const completedCount = data.todos.filter(todo => todo.completed).length;
    return {
        groups,
        openCount,
        completedCount,
        groupCount: data.groups.length,
        showCompleted: Boolean(viewState.showCompleted),
        empty: data.groups.length === 0 && data.todos.length === 0,
    };
}

function buildGroupViewModel(group: TodoGroup, todosById: Map<string, TodoItem>, showCompleted: boolean): TodoGroupViewModel {
    const todos = group.todoIds
        .map(id => todosById.get(id))
        .filter((todo): todo is TodoItem => Boolean(todo))
        .filter(todo => showCompleted || !todo.completed)
        .map(todo => ({
            id: todo.id,
            groupId: todo.groupId,
            title: todo.title,
            notes: todo.notes,
            priority: todo.priority,
            completed: todo.completed,
        }));
    const groupTodos = group.todoIds
        .map(id => todosById.get(id))
        .filter((todo): todo is TodoItem => Boolean(todo));
    return {
        id: group.id,
        title: group.title,
        openCount: groupTodos.filter(todo => !todo.completed).length,
        completedCount: groupTodos.filter(todo => todo.completed).length,
        todos,
    };
}
```

- [ ] **Step 4: Implement TODO HTML rendering**

Create `src/todos/webviewContent.ts` with escaped, string-only HTML:

```ts
'use strict';

import { TodoGroupViewModel, TodoItemViewModel, TodoViewModel } from './viewModel';

function escapeHtml(value: unknown): string {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function getTodoPanelContent(model: TodoViewModel): string {
    if (model.empty) {
        return `<div class="todo-empty-state" role="status">
            <div class="todo-empty-title">Plan your next large task</div>
            <div class="todo-empty-description">Create a group, then break the work into prioritized todos.</div>
            <button type="button" class="todo-primary-button" data-action="todo-add-group">Create first group</button>
            <button type="button" class="todo-secondary-button" data-action="todo-add">Add todo to Inbox</button>
        </div>`;
    }
    return `<div class="todo-panel" data-show-completed="${model.showCompleted ? 'true' : 'false'}">
        <div class="todo-summary">
            <span class="todo-summary-title">TODO</span>
            <span class="todo-summary-meta">${model.openCount} open · ${model.groupCount} groups · ${model.showCompleted ? `${model.completedCount} completed shown` : 'completed hidden'}</span>
            <button type="button" class="todo-icon-button" data-action="todo-add" title="Add TODO" aria-label="Add TODO">+</button>
            <button type="button" class="todo-icon-button" data-action="todo-add-group" title="Add Group" aria-label="Add Group">G+</button>
            <button type="button" class="todo-toggle-completed" data-action="todo-toggle-completed" aria-pressed="${model.showCompleted ? 'true' : 'false'}">${model.showCompleted ? 'Hide completed' : 'Show completed'}</button>
        </div>
        ${model.groups.map(getTodoGroupContent).join('')}
    </div>`;
}

function getTodoGroupContent(group: TodoGroupViewModel): string {
    return `<section class="todo-group" data-todo-group-id="${escapeHtml(group.id)}">
        <header class="todo-group-header">
            <button type="button" class="todo-group-collapse" data-action="todo-toggle-group" aria-expanded="true">⌄</button>
            <span class="todo-group-title">${escapeHtml(group.title)}</span>
            <span class="todo-group-count">${group.openCount} open${group.completedCount ? ` · ${group.completedCount} done` : ''}</span>
            <button type="button" class="todo-group-action" data-action="todo-add" data-todo-group-id="${escapeHtml(group.id)}" title="Add TODO">+</button>
            <button type="button" class="todo-group-action" data-action="todo-sort-priority" data-todo-group-id="${escapeHtml(group.id)}" title="Sort by priority">⇅</button>
        </header>
        <div class="todo-group-list">
            ${group.todos.length ? group.todos.map(getTodoItemContent).join('') : '<div class="todo-group-empty">No visible todos.</div>'}
        </div>
    </section>`;
}

function getTodoItemContent(todo: TodoItemViewModel): string {
    const completedClass = todo.completed ? ' completed' : '';
    return `<article class="todo-item${completedClass}" data-todo-id="${escapeHtml(todo.id)}" data-todo-group-id="${escapeHtml(todo.groupId)}">
        <button type="button" class="todo-checkbox" data-action="todo-toggle" aria-label="Mark ${escapeHtml(todo.title)} ${todo.completed ? 'incomplete' : 'complete'}">${todo.completed ? '✓' : ''}</button>
        <span class="todo-priority todo-priority-${todo.priority}">${todo.priority === 'medium' ? 'MED' : todo.priority.toUpperCase()}</span>
        <div class="todo-item-body">
            <div class="todo-item-title">${escapeHtml(todo.title)}</div>
            ${todo.notes ? `<div class="todo-item-notes">${escapeHtml(todo.notes)}</div>` : ''}
        </div>
        <button type="button" class="todo-item-action" data-action="todo-edit" title="Edit TODO">Edit</button>
        <button type="button" class="todo-item-action" data-action="todo-delete" title="Delete TODO">Delete</button>
    </article>`;
}
```

- [ ] **Step 5: Extend Dashboard search types/catalog**

Modify `src/webview/dashboardViewModel.ts`:

```ts
import type { TodoSearchCatalogItem } from '../todos/types';

export interface DashboardSearchTodoItem extends TodoSearchCatalogItem {
    key: string;
    name: string;
}

export interface DashboardSearchCatalog {
    sessions: DashboardSearchSessionItem[];
    openProjects: DashboardSearchProjectItem[];
    savedProjects: DashboardSearchProjectItem[];
    todos: DashboardSearchTodoItem[];
}
```

Update `buildDashboardSearchCatalog(groups, openProjects, todos = [])` to accept a third parameter:

```ts
export function buildDashboardSearchCatalog(
    groups: Group[],
    openProjects: Project[],
    todoItems: TodoSearchCatalogItem[] = []
): DashboardSearchCatalog {
    // existing logic
    return {
        sessions,
        openProjects: openItems,
        savedProjects: Array.from(savedByIdentity.values()),
        todos: todoItems.map(todo => ({
            ...todo,
            key: `todo:${todo.id}`,
            name: todo.title,
        })),
    };
}
```

- [ ] **Step 6: Run tests to verify Task 2 passes**

Run: `npm run test:dashboard`

Expected: `Dashboard Webview checks passed.`

- [ ] **Step 7: Commit Task 2**

```bash
git add src/todos/viewModel.ts src/todos/webviewContent.ts src/webview/dashboardViewModel.ts src/webview/webviewContent.ts scripts/run-dashboard-webview-checks.js
git commit -m "feat: render todo dashboard data"
```

---

### Task 3: Dashboard TODO Tab And Message Wiring

**Files:**
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewDashboardScripts.js`
- Modify: `src/dashboard/messageRouter.ts`
- Modify: `src/dashboard.ts`
- Test: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Consumes: `getTodoPanelContent()`, `TodoService`
- Produces messages: `request-todo-panel`, `todo-panel-content`, `todo-add`, `todo-add-group`, `todo-toggle`, `todo-delete`, `todo-sort-priority`, `todo-toggle-completed`

- [ ] **Step 1: Write failing tab/message tests**

Update `runControllerChecks()`:

```js
const todoButton = createElement('dashboard-tab-todo-button');
todoButton.setAttribute('data-dashboard-tab', 'todo');
const todoPanel = createElement('dashboard-tab-todo');
const elements = {
    'dashboard-tab-open': openPanel,
    'dashboard-tab-projects': projectsPanel,
    'dashboard-tab-todo': todoPanel,
};
```

Update querySelectorAll to return `[openButton, projectsButton, todoButton]`. Add assertions:

```js
assert.strictEqual(context.normalizeDashboardTab('todo'), 'todo');
assert.strictEqual(context.getAdjacentDashboardTab('projects', 'ArrowRight'), 'todo');
assert.strictEqual(context.getAdjacentDashboardTab('todo', 'ArrowLeft'), 'projects');

controller.activateTab('todo');
assert.deepStrictEqual(JSON.parse(JSON.stringify(messages.slice(-1)[0])), {
    type: 'request-todo-panel',
    version: 1,
    requestId: 1,
});
assert.strictEqual(controller.getTodoState(), 'loading');
assert.strictEqual(controller.applyTodoPanelMessage({
    type: 'todo-panel-content', version: 1, requestId: 1, html: '<div>todo</div>',
}), true);
assert.strictEqual(todoPanel.innerHTML, '<div>todo</div>');
```

Update source contract checks for `.dashboard-tab-todo`, `request-todo-panel`, and `todo-panel-content`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:dashboard`

Expected: fails because `todo` normalizes to `open` and `request-todo-panel` is missing.

- [ ] **Step 3: Add TODO panel markup**

In `src/webview/webviewContent.ts`, add tab and panel:

```html
<button type="button" id="dashboard-tab-todo-button" class="dashboard-tab-button" role="tab" aria-selected="false" aria-controls="dashboard-tab-todo" tabindex="-1" data-dashboard-tab="todo">TODO</button>
```

and:

```html
<section id="dashboard-tab-todo" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-todo-button" hidden>
    <div class="dashboard-todo-loading" role="status" hidden>Loading todos…</div>
</section>
```

- [ ] **Step 4: Extend Dashboard script for TODO lazy panel**

Update `normalizeDashboardTab`, `getAdjacentDashboardTab`, `panels`, `scrollPositions`, and add TODO request state mirroring Projects:

```js
function normalizeDashboardTab(tab) {
    return tab === 'projects' || tab === 'todo' ? tab : 'open';
}

function getDashboardTabOrder() {
    return ['open', 'projects', 'todo'];
}
```

Add `validateTodoPanelMessage`, `ensureTodoPanel`, `applyTodoPanelMessage`, `todoState`, `todoRequestId`, `acceptedTodoRequestId`. Return `getTodoState`, `ensureTodoPanel`, and `applyTodoPanelMessage`.

- [ ] **Step 5: Route TODO panel request in extension host**

In `src/dashboard/messageRouter.ts`, no special parser is needed if handler map already accepts strings; add tests only if type narrowing blocks it.

In `src/dashboard.ts`, instantiate `TodoService`, build TODO model, and handle:

```ts
'request-todo-panel': async e => {
    provider.postMessage({
        type: 'todo-panel-content',
        version: 1,
        requestId: Number.isSafeInteger(e.requestId) ? e.requestId : 0,
        html: getTodoPanelContent(buildTodoViewModel(todoService.getData(), todoViewState)),
    });
},
```

- [ ] **Step 6: Run tests to verify Task 3 passes**

Run: `npm run test:dashboard`

Expected: `Dashboard Webview checks passed.`

- [ ] **Step 7: Commit Task 3**

```bash
git add src/dashboard.ts src/dashboard/messageRouter.ts src/webview/webviewContent.ts src/webview/webviewDashboardScripts.js scripts/run-dashboard-webview-checks.js
git commit -m "feat: add todo dashboard tab"
```

---

### Task 4: TODO Webview Interactions And Mutations

**Files:**
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `src/dashboard.ts`
- Modify: `src/todos/service.ts`
- Test: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Consumes: TODO item/group DOM with `data-action`
- Produces postMessage actions to extension host
- Produces refreshed TODO panel after mutations

- [ ] **Step 1: Write failing interaction tests**

In `runSourceContractChecks()`, assert:

```js
assert.ok(projectSource.includes("data-action=\\\"todo-add\\\""));
assert.ok(projectSource.includes("type: 'todo-add'"));
assert.ok(projectSource.includes("type: 'todo-toggle'"));
assert.ok(projectSource.includes("type: 'todo-delete'"));
assert.ok(projectSource.includes("type: 'todo-sort-priority'"));
assert.ok(extensionHostSource.includes("'todo-add': async e =>"));
assert.ok(extensionHostSource.includes("'todo-toggle': async e =>"));
```

Add a controller-level test for `TodoService.sortGroupByPriority()` if not already covered:

```js
await localService.addTodo({ title: 'Low', priority: 'low' });
await localService.addTodo({ title: 'High', priority: 'high' });
const groupId = localService.getData().groups[0].id;
await localService.sortGroupByPriority(groupId);
const sortedTitles = localService.getData().groups[0].todoIds
    .map(id => localService.getData().todos.find(todo => todo.id === id).title);
assert.deepStrictEqual(sortedTitles, ['High', 'Low']);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:dashboard`

Expected: fails because TODO webview action messages are missing.

- [ ] **Step 3: Implement webview action posting**

In `src/webview/webviewProjectScripts.js`, add before project/group click fallthrough:

```js
var todoActionElement = e.target.closest('[data-action^="todo-"]');
if (todoActionElement) {
    onTodoActionClicked(e, todoActionElement);
    return;
}
```

Add:

```js
function onTodoActionClicked(event, element) {
    var todoItem = element.closest('[data-todo-id]');
    var todoGroup = element.closest('[data-todo-group-id]');
    var action = element.getAttribute('data-action');
    window.vscode.postMessage({
        type: action,
        todoId: todoItem && todoItem.getAttribute('data-todo-id'),
        groupId: element.getAttribute('data-todo-group-id') || (todoGroup && todoGroup.getAttribute('data-todo-group-id')),
        completed: action === 'todo-toggle' ? !(todoItem && todoItem.classList.contains('completed')) : undefined,
    });
}
```

First implementation may use `showInputBox` in extension host for add/edit title and notes if inline forms are too large for this task; full inline editing is completed in Task 5.

- [ ] **Step 4: Implement extension host mutations and refresh**

In `src/dashboard.ts`, add TODO handlers:

```ts
const postTodoPanelContent = (requestId = 1) => provider.postMessage({
    type: 'todo-panel-content',
    version: 1,
    requestId,
    html: getTodoPanelContent(buildTodoViewModel(todoService.getData(), todoViewState)),
});

'todo-add-group': async () => {
    await todoService.addGroup('Untitled Group');
    await postTodoPanelContent();
},
'todo-add': async e => {
    const title = await vscode.window.showInputBox({ placeHolder: 'TODO title', ignoreFocusOut: true });
    if (!title) { return; }
    await todoService.addTodo({ groupId: e.groupId as string, title, priority: 'medium' });
    await postTodoPanelContent();
},
'todo-toggle': async e => {
    await todoService.completeTodo(e.todoId as string, e.completed === true);
    await postTodoPanelContent();
},
'todo-delete': async e => {
    const choice = await vscode.window.showWarningMessage('Delete this TODO?', { modal: true }, 'Delete');
    if (choice === 'Delete') {
        await todoService.deleteTodo(e.todoId as string);
        await postTodoPanelContent();
    }
},
'todo-sort-priority': async e => {
    await todoService.sortGroupByPriority(e.groupId as string);
    await postTodoPanelContent();
},
```

- [ ] **Step 5: Run tests to verify Task 4 passes**

Run: `npm run test:dashboard`

Expected: `Dashboard Webview checks passed.`

- [ ] **Step 6: Commit Task 4**

```bash
git add src/dashboard.ts src/webview/webviewProjectScripts.js src/todos/service.ts scripts/run-dashboard-webview-checks.js
git commit -m "feat: wire todo mutations"
```

---

### Task 5: Inline Editing, Styles, And Final Verification

**Files:**
- Modify: `src/todos/webviewContent.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `media/styles.scss`
- Modify: `src/webview/webviewDashboardScripts.js`
- Modify: `CHANGELOG.md`
- Test: `scripts/run-dashboard-webview-checks.js`

**Interfaces:**
- Consumes/produces TODO panel DOM
- Produces accessible inline form fields and save/cancel actions

- [ ] **Step 1: Write failing source/style tests**

Add to `runSourceContractChecks()`:

```js
assert.ok(styles.includes('.todo-panel'));
assert.ok(styles.includes('.todo-item'));
assert.ok(styles.includes('.todo-priority-high'));
assert.ok(styles.includes('.todo-empty-state'));
assert.ok(styles.includes('.todo-edit-form'));
assert.ok(projectSource.includes('todo-save-edit'));
assert.ok(projectSource.includes('todo-cancel-edit'));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:dashboard`

Expected: fails because TODO styles and inline edit actions are missing.

- [ ] **Step 3: Add inline edit form HTML**

In `src/todos/webviewContent.ts`, add hidden or replacement form rendering:

```html
<form class="todo-edit-form" data-todo-edit-form hidden>
    <input class="todo-edit-title" name="title" aria-label="TODO title">
    <select class="todo-edit-priority" name="priority" aria-label="TODO priority">
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
    </select>
    <textarea class="todo-edit-notes" name="notes" aria-label="TODO notes"></textarea>
    <button type="button" data-action="todo-save-edit">Save</button>
    <button type="button" data-action="todo-cancel-edit">Cancel</button>
</form>
```

- [ ] **Step 4: Add webview inline edit behavior**

In `src/webview/webviewProjectScripts.js`, implement:

```js
function readTodoEditForm(form) {
    return {
        title: form.querySelector('[name="title"]').value,
        priority: form.querySelector('[name="priority"]').value,
        notes: form.querySelector('[name="notes"]').value,
    };
}
```

Post `todo-update` for existing todos and `todo-add` with title/notes/priority for new ones. Keep all values as text; never use `innerHTML`.

- [ ] **Step 5: Add extension host `todo-update`**

In `src/dashboard.ts`, add:

```ts
'todo-update': async e => {
    await todoService.updateTodo(e.todoId as string, {
        title: e.title as string,
        notes: e.notes as string,
        priority: e.priority as TodoPriority,
    });
    await postTodoPanelContent();
},
```

- [ ] **Step 6: Add styles**

Append focused TODO styles to `media/styles.scss`:

```scss
.todo-panel {
    padding: 14px;
}

.todo-summary,
.todo-group-header,
.todo-item,
.todo-edit-form,
.todo-empty-state {
    box-sizing: border-box;
}

.todo-summary,
.todo-group-header {
    display: flex;
    align-items: center;
    gap: 8px;
}

.todo-group {
    margin-top: 16px;
}

.todo-item {
    display: grid;
    grid-template-columns: 24px auto 1fr auto auto;
    gap: 8px;
    align-items: start;
    margin: 8px 0;
    padding: 10px;
    background: var(--steward-project-card-bg);
    border: 1px solid var(--vscode-panel-border);
}

.todo-item.completed {
    opacity: .62;
}

.todo-priority {
    font-size: 10px;
    font-weight: 700;
}

.todo-priority-high { color: var(--vscode-errorForeground); }
.todo-priority-medium { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
.todo-priority-low { color: var(--vscode-gitDecoration-untrackedResourceForeground); }

.todo-edit-form {
    display: grid;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--vscode-focusBorder);
}

.todo-empty-state {
    margin: 24px 14px;
    padding: 20px;
    border: 1px solid var(--vscode-panel-border);
}
```

- [ ] **Step 7: Update changelog**

Add under `[Unreleased]` in `CHANGELOG.md`:

```markdown
### Added

-   Add a global `TODO` Dashboard tab with grouped, synchronized planning tasks.
```

- [ ] **Step 8: Run focused tests**

Run: `npm run test:dashboard`

Expected: `Dashboard Webview checks passed.`

- [ ] **Step 9: Run broader verification**

Run:

```bash
npm run test:safety
npm run test:architecture-baseline
npm run test:release-notes
git diff --check
```

Expected:
- AI session safety checks passed.
- Open project safety checks passed.
- architecture baseline exits 0.
- release notes checks passed.
- `git diff --check` exits 0.

- [ ] **Step 10: Commit Task 5**

```bash
git add CHANGELOG.md media/styles.scss src/todos/webviewContent.ts src/webview/webviewProjectScripts.js src/webview/webviewDashboardScripts.js src/dashboard.ts scripts/run-dashboard-webview-checks.js
git commit -m "feat: add todo inline editing"
```

---

## Self-Review

- Spec coverage: storage/sync, grouped TODOs, priorities, completion, hidden completed items, Inbox target, local `showCompleted`, lightweight search, Dashboard tab, and tests are mapped to tasks.
- Placeholder scan: no `TBD`, `TODO`, `fill in details`, or undefined task references.
- Type consistency: `TodoDataV1`, `TodoViewState`, `TodoSearchCatalogItem`, `TodoService`, `buildTodoViewModel`, and `getTodoPanelContent` are defined before use.
- Known implementation risk: Task 4 allows prompt-based add/edit as an interim step, but Task 5 must complete inline editing before the feature is considered done.
