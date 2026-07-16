import { TodoDataV1, TodoGroup, TodoItem, TodoViewState, normalizeTodoData } from './types';

export interface TodoItemViewModel extends TodoItem {
    priorityLabel: string;
}

export interface TodoGroupViewModel extends TodoGroup {
    visibleTodos: TodoItemViewModel[];
    totalTodos: number;
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
    high: 'High',
    medium: 'Medium',
    low: 'Low',
};

function toTodoItemViewModel(todo: TodoItem): TodoItemViewModel {
    return {
        ...todo,
        priorityLabel: PRIORITY_LABELS[todo.priority],
    };
}

export function buildTodoViewModel(data: TodoDataV1, viewState: Partial<TodoViewState> = {}): TodoPanelViewModel {
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
        const visibleTodos = groupTodos
            .filter(todo => showCompleted || !todo.completed)
            .map(toTodoItemViewModel);
        return {
            ...group,
            visibleTodos,
            totalTodos: groupTodos.length,
            hiddenCompletedCount: showCompleted ? 0 : groupTodos.filter(todo => todo.completed).length,
        };
    });

    const totalCompleted = normalized.todos.filter(todo => todo.completed).length;

    return {
        groups,
        showCompleted,
        totalTodos: normalized.todos.length,
        totalIncomplete: normalized.todos.length - totalCompleted,
        totalCompleted,
        isEmpty: normalized.todos.length === 0,
    };
}
