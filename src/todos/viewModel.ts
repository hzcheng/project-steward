import {
    TodoDataV1,
    TodoGroup,
    TodoItem,
    TodoPanelSnapshot,
    TodoViewState,
    normalizeTodoData,
} from './types';

export interface TodoItemViewModel extends TodoItem {
    priorityLabel: string;
}

export interface TodoGroupViewModel extends TodoGroup {
    visibleTodos: TodoItemViewModel[];
    totalTodos: number;
    incompleteCount: number;
    completedCount: number;
    hiddenCompletedCount: number;
}

export interface TodoPanelViewModel {
    groups: TodoGroupViewModel[];
    showCompleted: boolean;
    totalTodos: number;
    totalIncomplete: number;
    totalCompleted: number;
    isEmpty: boolean;
}

const PRIORITY_LABELS = {
    high: 'HIGH',
    medium: 'MED',
    low: 'LOW',
};

function toTodoItemViewModel(todo: TodoItem): TodoItemViewModel {
    return {
        ...todo,
        priorityLabel: PRIORITY_LABELS[todo.priority],
    };
}

export function buildTodoPanelSnapshot(
    data: TodoDataV1,
    viewState: Partial<TodoViewState> = {},
    revealedTodoId?: string
): TodoPanelSnapshot {
    const snapshot: TodoPanelSnapshot = {
        version: 1,
        data: normalizeTodoData(data),
        showCompleted: viewState.showCompleted === true,
    };
    if (revealedTodoId) {
        snapshot.revealedTodoId = revealedTodoId;
    }
    return snapshot;
}

export function buildTodoViewModel(
    data: TodoDataV1,
    viewState: Partial<TodoViewState> = {},
    revealedTodoId?: string
): TodoPanelViewModel {
    const normalized = normalizeTodoData(data);
    const showCompleted = viewState.showCompleted === true;
    const todosByGroup = new Map<string, TodoItem[]>();

    normalized.todos.forEach(todo => {
        const existing = todosByGroup.get(todo.groupId) || [];
        existing.push(todo);
        todosByGroup.set(todo.groupId, existing);
    });

    const groups = normalized.groups.map(group => {
        const groupTodos = (todosByGroup.get(group.id) || []).sort((a, b) => a.order - b.order);
        const incompleteTodos = groupTodos.filter(todo => !todo.completed);
        const completedTodos = groupTodos.filter(todo => todo.completed);
        const revealedCompletedTodos = showCompleted
            ? completedTodos
            : completedTodos.filter(todo => todo.id === revealedTodoId);
        const visibleTodos = incompleteTodos.concat(revealedCompletedTodos)
            .map(toTodoItemViewModel);
        return {
            ...group,
            visibleTodos,
            totalTodos: groupTodos.length,
            incompleteCount: incompleteTodos.length,
            completedCount: completedTodos.length,
            hiddenCompletedCount: completedTodos.length - revealedCompletedTodos.length,
        };
    });

    const totalCompleted = normalized.todos.filter(todo => todo.completed).length;

    return {
        groups,
        showCompleted,
        totalTodos: normalized.todos.length,
        totalIncomplete: normalized.todos.length - totalCompleted,
        totalCompleted,
        isEmpty: normalized.groups.length === 0,
    };
}
