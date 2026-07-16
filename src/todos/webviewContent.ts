import { TodoGroupViewModel, TodoItemViewModel, TodoPanelViewModel } from './viewModel';

function escapeHtml(value: string): string {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderTodoItem(todo: TodoItemViewModel): string {
    const completedClass = todo.completed ? ' completed' : '';
    const checked = todo.completed ? ' checked' : '';
    return `<li class="todo-item todo-priority-${todo.priority}${completedClass}" data-todo-id="${escapeHtml(todo.id)}">
        <label class="todo-check">
            <input type="checkbox" data-action="todo-toggle" data-todo-id="${escapeHtml(todo.id)}"${checked}>
            <span>${escapeHtml(todo.title)}</span>
        </label>
        <span class="todo-priority-badge">${escapeHtml(todo.priorityLabel)}</span>
        ${todo.notes ? `<p class="todo-notes">${escapeHtml(todo.notes)}</p>` : ''}
        <div class="todo-item-actions">
            <button type="button" data-action="todo-edit" data-todo-id="${escapeHtml(todo.id)}" title="Edit todo">Edit</button>
            <button type="button" data-action="todo-delete" data-todo-id="${escapeHtml(todo.id)}" title="Delete todo">Delete</button>
        </div>
    </li>`;
}

function renderTodoGroup(group: TodoGroupViewModel): string {
    const hiddenCompleted = group.hiddenCompletedCount
        ? `<p class="todo-hidden-completed">${group.hiddenCompletedCount} completed hidden</p>`
        : '';

    return `<section class="todo-group${group.collapsed ? ' collapsed' : ''}" data-todo-group-id="${escapeHtml(group.id)}">
        <header class="todo-group-header">
            <h2>${escapeHtml(group.title)}</h2>
            <div class="todo-group-actions">
                <button type="button" data-action="todo-add" data-group-id="${escapeHtml(group.id)}">Add Todo</button>
                <button type="button" data-action="todo-sort-priority" data-group-id="${escapeHtml(group.id)}">Sort by Priority</button>
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
            <div class="todo-toolbar">
                <button type="button" data-action="todo-add">Add Todo</button>
                <button type="button" data-action="todo-add-group">Add Group</button>
            </div>
            <div class="todo-empty-state">No todos yet</div>
        </div>`;
    }

    return `<div class="todo-panel">
        <div class="todo-toolbar">
            <button type="button" data-action="todo-add">Add Todo</button>
            <button type="button" data-action="todo-add-group">Add Group</button>
            <label class="todo-show-completed">
                <input type="checkbox" data-action="todo-toggle-show-completed"${viewModel.showCompleted ? ' checked' : ''}>
                Show completed
            </label>
            <span class="todo-summary">${viewModel.totalIncomplete} open / ${viewModel.totalCompleted} completed</span>
        </div>
        <div class="todo-groups">
            ${viewModel.groups.map(renderTodoGroup).join('')}
        </div>
    </div>`;
}
