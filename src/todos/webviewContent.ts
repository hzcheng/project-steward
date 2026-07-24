import { TodoGroupViewModel, TodoItemViewModel, TodoPanelViewModel } from './viewModel';
import * as Icons from '../webview/webviewIcons';

const DEFAULT_MAX_VISIBLE_TODOS_PER_GROUP = 5;
const TODO_COLLAPSED_ITEM_HEIGHT_PX = 58;
const TODO_LIST_GAP_PX = 7;

const PRIORITIES = [
    { value: 'high', label: 'HIGH' },
    { value: 'medium', label: 'MED' },
    { value: 'low', label: 'LOW' },
];

export interface TodoPanelRenderOptions {
    maxVisibleTodosPerGroup?: number;
}

function escapeHtml(value: string): string {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeMaxVisibleTodosPerGroup(value: unknown): number {
    const visibleItems = Math.floor(Number(value));
    return Number.isFinite(visibleItems) && visibleItems > 0
        ? visibleItems
        : DEFAULT_MAX_VISIBLE_TODOS_PER_GROUP;
}

function getTodoPanelStyle(options: TodoPanelRenderOptions = {}): string {
    const visibleItems = normalizeMaxVisibleTodosPerGroup(options.maxVisibleTodosPerGroup);
    const listMaxHeight = (visibleItems * TODO_COLLAPSED_ITEM_HEIGHT_PX)
        + (Math.max(visibleItems - 1, 0) * TODO_LIST_GAP_PX);
    return ` style="--todo-visible-items: ${visibleItems}; --todo-collapsed-item-height: ${TODO_COLLAPSED_ITEM_HEIGHT_PX}px; --todo-list-max-height: ${listMaxHeight}px;"`;
}

export function getUnsupportedTodoVersionPanelContent(version: unknown): string {
    return `<div class="todo-panel todo-panel-error" data-todo-error="unsupported-version">
        <header class="todo-page-header todo-page-command-bar">
            <div class="todo-summary-copy">
                <strong>TODO</strong>
                <span class="todo-summary-meta steward-meta">Read-only</span>
            </div>
        </header>
        <div class="todo-unsupported-version steward-empty-state" role="alert">
            <p>Stored TODO data uses unsupported version ${escapeHtml(String(version))}.</p>
            <p>This TODO list is read-only. Update Project Steward before making changes.</p>
        </div>
    </div>`;
}

function renderPriorityOptions(selected: string): string {
    return PRIORITIES.map(priority =>
        `<option value="${priority.value}"${priority.value === selected ? ' selected' : ''}>${priority.label}</option>`
    ).join('');
}

function renderGroupOptions(groups: TodoGroupViewModel[], selectedGroupId = ''): string {
    return ['<option value="">Inbox</option>', ...groups.map(group =>
        `<option value="${escapeHtml(group.id)}"${group.id === selectedGroupId ? ' selected' : ''}>${escapeHtml(group.title)}</option>`
    )].join('');
}

function renderTodoAddForm(viewModel: TodoPanelViewModel): string {
    return `<form class="todo-add-form todo-compose-panel steward-card" data-todo-form="add" hidden>
        <div class="todo-compose-primary">
            <span class="todo-compose-icon">${Icons.add}</span>
            <input class="todo-title-input" type="text" name="title" placeholder="Add a todo" aria-label="Todo title">
        </div>
        <textarea class="todo-notes-input" name="notes" rows="2" placeholder="Notes" aria-label="Todo notes"></textarea>
        <div class="todo-form-row todo-compose-meta">
            <select name="priority" aria-label="Todo priority">${renderPriorityOptions('medium')}</select>
            <select name="groupId" aria-label="Todo group">${renderGroupOptions(viewModel.groups)}</select>
            <button class="todo-primary-button steward-button steward-button-primary" type="submit" data-action="todo-add"><span>${Icons.add}</span>Add</button>
            <button class="todo-secondary-button steward-button" type="button" data-action="todo-cancel-add">Cancel</button>
        </div>
    </form>`;
}

function renderTodoItem(todo: TodoItemViewModel): string {
    const completedClass = todo.completed ? ' completed' : '';
    const checked = todo.completed ? ' checked' : '';
    const priorityBadge = todo.priority === 'medium'
        ? ''
        : `<span class="todo-priority-badge steward-badge">${escapeHtml(todo.priorityLabel)}</span>`;
    return `<li class="todo-item steward-item-card todo-priority-${todo.priority}${completedClass}" data-todo-id="${escapeHtml(todo.id)}">
        <span class="todo-item-accent steward-item-accent" aria-hidden="true"></span>
        <div class="todo-item-view">
            <div class="todo-item-main">
                <label class="todo-check">
                    <input type="checkbox" data-action="todo-toggle" data-todo-id="${escapeHtml(todo.id)}" aria-label="Complete ${escapeHtml(todo.title)}"${checked}>
                    <span class="todo-checkbox-visual"></span>
                </label>
                <div class="todo-item-content">
                    <div class="todo-title-line">
                        <button class="todo-title-button" type="button" data-action="todo-open-detail" data-todo-id="${escapeHtml(todo.id)}" aria-expanded="false" title="Expand details">
                            <span class="todo-title-text">${escapeHtml(todo.title)}</span>
                        </button>
                        ${priorityBadge}
                    </div>
                </div>
                <div class="todo-item-actions">
                    <button class="todo-icon-button steward-icon-button danger" type="button" data-action="todo-delete" data-todo-id="${escapeHtml(todo.id)}" title="Delete todo" aria-label="Delete todo">${Icons.remove}</button>
                    <button class="todo-drag-handle todo-icon-button steward-icon-button" type="button" draggable="true" data-drag-todo-item="${escapeHtml(todo.id)}" title="Drag to reorder" aria-label="Drag ${escapeHtml(todo.title)}">⋮⋮</button>
                </div>
            </div>
        </div>
    </li>`;
}

function renderTodoGroup(group: TodoGroupViewModel): string {
    const hiddenCompleted = group.hiddenCompletedCount
        ? `<p class="todo-hidden-completed">${group.hiddenCompletedCount} completed hidden</p>`
        : '';

    const groupMeta = group.completedCount && group.visibleTodos.some(todo => todo.completed)
        ? `${group.incompleteCount} open · ${group.completedCount} done`
        : `${group.incompleteCount} open`;

    return `<section class="todo-group group steward-section${group.collapsed ? ' collapsed' : ''}" data-todo-group-id="${escapeHtml(group.id)}">
        <header class="todo-group-header group-title steward-group-header">
            <div class="todo-group-title-block group-title-text">
                <button class="todo-group-collapse-button" type="button" data-action="todo-collapse-group" data-todo-group-id="${escapeHtml(group.id)}" aria-expanded="${group.collapsed ? 'false' : 'true'}" title="${group.collapsed ? 'Expand' : 'Collapse'} todo group" aria-label="${group.collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(group.title)}">
                    <span class="todo-group-chevron collapse-icon" aria-hidden="true">${Icons.collapse}</span>
                </button>
                <h2 data-drag-todo-group title="${escapeHtml(group.title)}">${escapeHtml(group.title)}</h2>
                <span class="todo-group-count">${groupMeta}</span>
            </div>
            <div class="todo-group-actions group-actions right">
                <button class="todo-group-action" type="button" data-action="todo-quick-add" data-group-id="${escapeHtml(group.id)}" title="Quick add todo" aria-label="Quick add todo">${Icons.add}</button>
                <button class="todo-group-action" type="button" data-action="todo-sort-priority" data-group-id="${escapeHtml(group.id)}" title="Sort by priority" aria-label="Sort by priority">${Icons.manage}</button>
                <button class="todo-group-action" type="button" data-action="todo-rename-group" data-group-id="${escapeHtml(group.id)}" title="Rename todo group" aria-label="Rename todo group">${Icons.edit}</button>
                <button class="todo-group-action danger" type="button" data-action="todo-delete-group" data-group-id="${escapeHtml(group.id)}" title="Delete todo group" aria-label="Delete todo group">${Icons.remove}</button>
            </div>
        </header>
        <form class="todo-quick-add-form" data-todo-form="quick-add" data-group-id="${escapeHtml(group.id)}" hidden>
            <input type="text" name="title" placeholder="Add to ${escapeHtml(group.title)}" aria-label="New todo in ${escapeHtml(group.title)}">
            <button class="todo-primary-button steward-button steward-button-primary" type="submit">Add</button>
            <button class="todo-quiet-button" type="button" data-action="todo-cancel-quick-add">Cancel</button>
        </form>
        ${group.visibleTodos.length
            ? `<ul class="todo-list">${group.visibleTodos.map(renderTodoItem).join('')}</ul>`
            : `<p class="todo-group-empty">No visible todos</p>`}
        ${hiddenCompleted}
    </section>`;
}

export function getTodoPanelContent(
    viewModel: TodoPanelViewModel,
    options: TodoPanelRenderOptions = {},
): string {
    const listContent = viewModel.isEmpty
        ? '<p class="todo-empty-state steward-empty-state">No todos yet</p>'
        : `<div class="todo-groups">${viewModel.groups.map(renderTodoGroup).join('')}</div>`;
    const panelStyle = getTodoPanelStyle(options);

    return `<div class="todo-panel${viewModel.isEmpty ? ' todo-panel-empty' : ''}"${panelStyle}>
        <div class="todo-list-surface">
            ${renderTodoCommandBar(viewModel)}
            ${renderTodoAddForm(viewModel)}
            ${listContent}
        </div>
        <div class="todo-undo-region" role="status" aria-live="polite" hidden></div>
        <div class="todo-live-region" role="status" aria-live="polite" aria-atomic="true"></div>
    </div>`;
}

function renderTodoCommandBar(viewModel: TodoPanelViewModel): string {
    const groupCount = viewModel.groups.length;
    const completedState = viewModel.showCompleted
        ? `${viewModel.totalCompleted} completed shown`
        : 'completed hidden';
    const meta = viewModel.isEmpty
        ? 'No groups yet · synced when Project Steward data is synced'
        : `${viewModel.totalIncomplete} open · ${groupCount} ${groupCount === 1 ? 'group' : 'groups'} · ${completedState}`;

    return `<header class="todo-page-header todo-page-command-bar">
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
}
