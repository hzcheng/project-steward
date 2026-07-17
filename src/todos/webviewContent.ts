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
    return Number.isFinite(visibleItems) && visibleItems > 0 ? visibleItems : DEFAULT_MAX_VISIBLE_TODOS_PER_GROUP;
}

function getTodoPanelStyle(options: TodoPanelRenderOptions = {}): string {
    const visibleItems = normalizeMaxVisibleTodosPerGroup(options.maxVisibleTodosPerGroup);
    const listMaxHeight = (visibleItems * TODO_COLLAPSED_ITEM_HEIGHT_PX) + (Math.max(visibleItems - 1, 0) * TODO_LIST_GAP_PX);
    return ` style="--todo-visible-items: ${visibleItems}; --todo-collapsed-item-height: ${TODO_COLLAPSED_ITEM_HEIGHT_PX}px; --todo-list-max-height: ${listMaxHeight}px;"`;
}

function renderPriorityOptions(selected: string): string {
    return PRIORITIES.map(priority =>
        `<option value="${priority.value}"${priority.value === selected ? ' selected' : ''}>${priority.label}</option>`
    ).join('');
}

function renderGroupOptions(groups: TodoGroupViewModel[], selectedGroupId = ''): string {
    if (!groups.length) {
        return '<option value="">Inbox</option>';
    }

    return groups.map(group =>
        `<option value="${escapeHtml(group.id)}"${group.id === selectedGroupId ? ' selected' : ''}>${escapeHtml(group.title)}</option>`
    ).join('');
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
        </div>
    </form>`;
}

function renderTodoEditForm(todo: TodoItemViewModel): string {
    return `<form class="todo-edit-form todo-edit-panel steward-card" data-todo-form="edit" data-todo-id="${escapeHtml(todo.id)}" hidden>
        <div class="todo-edit-heading">EDIT TODO</div>
        <label class="todo-field-label">Title</label>
        <input class="todo-title-input" type="text" name="title" value="${escapeHtml(todo.title)}" aria-label="Todo title">
        <label class="todo-field-label">Priority</label>
        <div class="todo-priority-segment" aria-label="Todo priority">
            ${PRIORITIES.map(priority => `<label class="todo-priority-choice ${priority.value === todo.priority ? 'active' : ''}">
                <input type="radio" name="priority" value="${priority.value}"${priority.value === todo.priority ? ' checked' : ''}>
                <span>${priority.label}</span>
            </label>`).join('')}
        </div>
        <label class="todo-field-label">Notes</label>
        <textarea class="todo-notes-input" name="notes" rows="4" aria-label="Todo notes">${escapeHtml(todo.notes)}</textarea>
        <div class="todo-form-row todo-edit-actions">
            <button class="todo-secondary-button steward-button" type="button" data-action="todo-cancel-edit" data-todo-id="${escapeHtml(todo.id)}">Cancel</button>
            <button class="todo-primary-button steward-button steward-button-primary" type="submit" data-action="todo-save-edit"><span>${Icons.save}</span>Save</button>
        </div>
    </form>`;
}

function renderTodoItem(todo: TodoItemViewModel): string {
    const completedClass = todo.completed ? ' completed' : '';
    const checked = todo.completed ? ' checked' : '';
    return `<li class="todo-item steward-card steward-card-compact todo-priority-${todo.priority}${completedClass}" data-todo-id="${escapeHtml(todo.id)}" aria-expanded="false">
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

function renderTodoGroup(group: TodoGroupViewModel): string {
    const hiddenCompleted = group.hiddenCompletedCount
        ? `<p class="todo-hidden-completed">${group.hiddenCompletedCount} completed hidden</p>`
        : '';

    const groupMeta = group.completedCount && group.visibleTodos.some(todo => todo.completed)
        ? `${group.incompleteCount} open · ${group.completedCount} done`
        : `${group.incompleteCount} open`;

    return `<section class="todo-group group steward-section${group.collapsed ? ' collapsed' : ''}" data-todo-group-id="${escapeHtml(group.id)}">
        <header class="todo-group-header group-title steward-section-header todo-group-strip">
            <div class="todo-group-title-block group-title-text" data-action="todo-collapse-group" data-todo-group-id="${escapeHtml(group.id)}">
                <span class="collapse-icon" title="Open/Collapse Todo Group">${Icons.collapse}</span>
                <h2 title="${escapeHtml(group.title)}">${escapeHtml(group.title)}</h2>
                <span class="todo-group-count">${groupMeta}</span>
            </div>
            <div class="todo-group-actions group-actions right">
                <button class="todo-group-action" type="button" data-action="todo-add" data-group-id="${escapeHtml(group.id)}" title="Add todo" aria-label="Add todo">${Icons.add}</button>
                <button class="todo-group-action" type="button" data-action="todo-sort-priority" data-group-id="${escapeHtml(group.id)}" title="Sort by priority" aria-label="Sort by priority">${Icons.manage}</button>
                <button class="todo-group-action danger" type="button" data-action="todo-delete-group" data-group-id="${escapeHtml(group.id)}" title="Delete todo group" aria-label="Delete todo group">${Icons.remove}</button>
            </div>
        </header>
        ${group.visibleTodos.length
            ? `<ul class="todo-list">${group.visibleTodos.map(renderTodoItem).join('')}</ul>`
            : `<p class="todo-group-empty">No visible todos</p>`}
        ${hiddenCompleted}
    </section>`;
}

export function getTodoPanelContent(viewModel: TodoPanelViewModel, options: TodoPanelRenderOptions = {}): string {
    const panelStyle = getTodoPanelStyle(options);
    if (viewModel.isEmpty) {
        return `<div class="todo-panel todo-panel-empty"${panelStyle}>
            ${renderTodoCommandBar(viewModel)}
            <div class="todo-empty-state steward-empty-state">
                <div class="todo-empty-orb">${Icons.manage}</div>
                <strong>Plan your next large task</strong>
                <span>Create a group, then break the work into prioritized todos.</span>
                <button class="todo-empty-primary steward-button steward-button-primary" type="button" data-action="todo-add-group">Create first group</button>
                <button class="todo-empty-secondary steward-button" type="button" data-action="todo-add">Add todo to Inbox</button>
            </div>
        </div>`;
    }

    return `<div class="todo-panel"${panelStyle}>
        ${renderTodoCommandBar(viewModel)}
        <div class="todo-groups">
            ${viewModel.groups.map(renderTodoGroup).join('')}
        </div>
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

    return `<div class="todo-summary-card steward-card">
        <div class="todo-summary-copy">
            <strong>TODO</strong>
            <span class="todo-summary-meta steward-meta">${meta}</span>
        </div>
        <div class="todo-summary-actions">
            <button class="todo-square-button steward-icon-button" type="button" data-action="todo-add" title="Add todo" aria-label="Add todo">${Icons.add}</button>
            <button class="todo-square-button steward-icon-button" type="button" data-action="todo-add-group" title="Add group" aria-label="Add group">${Icons.manage}</button>
            <label class="todo-square-toggle steward-icon-button ${viewModel.showCompleted ? 'active' : ''}" title="Show completed">
                <input type="checkbox" data-action="todo-toggle-show-completed"${viewModel.showCompleted ? ' checked' : ''}>
                <span>${Icons.collapseAll}</span>
            </label>
        </div>
    </div>`;
}
