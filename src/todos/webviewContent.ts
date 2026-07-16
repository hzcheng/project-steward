import { TodoGroupViewModel, TodoItemViewModel, TodoPanelViewModel } from './viewModel';
import * as Icons from '../webview/webviewIcons';

const PRIORITIES = [
    { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' },
    { value: 'low', label: 'Low' },
];

function escapeHtml(value: string): string {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
    return `<form class="todo-add-form todo-compose-panel" data-todo-form="add">
        <div class="todo-compose-primary">
            <span class="todo-compose-icon">${Icons.add}</span>
            <input class="todo-title-input" type="text" name="title" placeholder="Add a todo" aria-label="Todo title">
        </div>
        <textarea class="todo-notes-input" name="notes" rows="2" placeholder="Notes" aria-label="Todo notes"></textarea>
        <div class="todo-form-row todo-compose-meta">
            <select name="priority" aria-label="Todo priority">${renderPriorityOptions('medium')}</select>
            <select name="groupId" aria-label="Todo group">${renderGroupOptions(viewModel.groups)}</select>
            <button class="todo-primary-button" type="submit" data-action="todo-add"><span>${Icons.add}</span>Add</button>
        </div>
    </form>`;
}

function renderTodoEditForm(todo: TodoItemViewModel): string {
    return `<form class="todo-edit-form todo-inline-editor" data-todo-form="edit" data-todo-id="${escapeHtml(todo.id)}" hidden>
        <input class="todo-title-input" type="text" name="title" value="${escapeHtml(todo.title)}" aria-label="Todo title">
        <textarea class="todo-notes-input" name="notes" rows="3" aria-label="Todo notes">${escapeHtml(todo.notes)}</textarea>
        <div class="todo-form-row todo-edit-actions">
            <select name="priority" aria-label="Todo priority">${renderPriorityOptions(todo.priority)}</select>
            <button class="todo-primary-button" type="submit" data-action="todo-save-edit"><span>${Icons.save}</span>Save</button>
            <button class="todo-secondary-button" type="button" data-action="todo-cancel-edit" data-todo-id="${escapeHtml(todo.id)}">Cancel</button>
        </div>
    </form>`;
}

function renderTodoItem(todo: TodoItemViewModel): string {
    const completedClass = todo.completed ? ' completed' : '';
    const checked = todo.completed ? ' checked' : '';
    return `<li class="todo-item todo-priority-${todo.priority}${completedClass}" data-todo-id="${escapeHtml(todo.id)}">
        <div class="todo-item-view">
            <div class="todo-item-main">
                <label class="todo-check">
                    <input type="checkbox" data-action="todo-toggle" data-todo-id="${escapeHtml(todo.id)}"${checked}>
                    <span>${escapeHtml(todo.title)}</span>
                </label>
                <div class="todo-item-actions">
                    <button class="todo-icon-button" type="button" data-action="todo-edit" data-todo-id="${escapeHtml(todo.id)}" title="Edit todo" aria-label="Edit todo">${Icons.edit}</button>
                    <button class="todo-icon-button danger" type="button" data-action="todo-delete" data-todo-id="${escapeHtml(todo.id)}" title="Delete todo" aria-label="Delete todo">${Icons.remove}</button>
                </div>
            </div>
            <div class="todo-item-meta">
                <span class="todo-priority-badge">${escapeHtml(todo.priorityLabel)}</span>
                ${todo.notes ? `<p class="todo-notes">${escapeHtml(todo.notes)}</p>` : ''}
            </div>
        </div>
        ${renderTodoEditForm(todo)}
    </li>`;
}

function renderTodoGroup(group: TodoGroupViewModel): string {
    const hiddenCompleted = group.hiddenCompletedCount
        ? `<p class="todo-hidden-completed">${group.hiddenCompletedCount} completed hidden</p>`
        : '';

    return `<section class="todo-group${group.collapsed ? ' collapsed' : ''}" data-todo-group-id="${escapeHtml(group.id)}">
        <header class="todo-group-header">
            <div class="todo-group-title-block">
                <h2>${escapeHtml(group.title)}</h2>
                <span class="todo-group-count">${group.visibleTodos.length} visible / ${group.totalTodos} total</span>
            </div>
            <div class="todo-group-actions">
                <button class="todo-quiet-button" type="button" data-action="todo-focus-add" data-group-id="${escapeHtml(group.id)}"><span>${Icons.add}</span>Add</button>
                <button class="todo-quiet-button" type="button" data-action="todo-sort-priority" data-group-id="${escapeHtml(group.id)}"><span>${Icons.manage}</span>Sort</button>
            </div>
        </header>
        ${group.visibleTodos.length
            ? `<ul class="todo-list">${group.visibleTodos.map(renderTodoItem).join('')}</ul>`
            : `<p class="todo-group-empty">No visible todos</p>`}
        ${hiddenCompleted}
    </section>`;
}

export function getTodoPanelContent(viewModel: TodoPanelViewModel): string {
    if (viewModel.isEmpty) {
        return `<div class="todo-panel todo-panel-empty">
            ${renderTodoCommandBar(viewModel)}
            ${renderTodoAddForm(viewModel)}
            <div class="todo-empty-state">
                <strong>No todos yet</strong>
                <span>Create the first planning item.</span>
            </div>
        </div>`;
    }

    return `<div class="todo-panel">
        ${renderTodoCommandBar(viewModel)}
        ${renderTodoAddForm(viewModel)}
        <div class="todo-groups">
            ${viewModel.groups.map(renderTodoGroup).join('')}
        </div>
    </div>`;
}

function renderTodoCommandBar(viewModel: TodoPanelViewModel): string {
    return `<div class="todo-toolbar">
        <div class="todo-summary">
            <span><strong>${viewModel.totalIncomplete}</strong> Open</span>
            <span><strong>${viewModel.totalCompleted}</strong> Done</span>
        </div>
        <div class="todo-toolbar-actions">
            <label class="todo-show-completed">
                <input type="checkbox" data-action="todo-toggle-show-completed"${viewModel.showCompleted ? ' checked' : ''}>
                Done
            </label>
            <button class="todo-quiet-button" type="button" data-action="todo-add-group"><span>${Icons.add}</span>Group</button>
        </div>
    </div>`;
}
