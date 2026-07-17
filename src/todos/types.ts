import {
    TODO_NOTES_SEARCH_TEXT_LIMIT,
    TODO_UNTITLED_GROUP_TITLE,
    TODO_UNTITLED_ITEM_TITLE,
} from '../constants';

export type TodoPriority = 'high' | 'medium' | 'low';

export interface TodoGroup {
    id: string;
    title: string;
    collapsed: boolean;
    order: number;
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
    order: number;
}

export interface TodoDataV1 {
    version: 1;
    groups: TodoGroup[];
    todos: TodoItem[];
}

export interface TodoViewState {
    showCompleted: boolean;
    editingTodoId?: string;
}

export interface TodoSearchCatalogItem {
    key: string;
    todoId: string;
    groupId: string;
    title: string;
    groupTitle: string;
    priority: TodoPriority;
    completed: boolean;
    notesSearchText: string;
    searchText: string;
}

export interface AddTodoInput {
    title: string;
    notes?: string;
    priority?: TodoPriority;
    groupId?: string;
}

export interface TodoPatch {
    title?: string;
    notes?: string;
    priority?: TodoPriority;
    groupId?: string;
}

export interface TodoMutationResult {
    data: TodoDataV1;
}

export class UnsupportedTodoDataVersionError extends Error {
    readonly version: unknown;

    constructor(version: unknown) {
        super(`Unsupported TODO data version: ${String(version)}`);
        this.name = 'UnsupportedTodoDataVersionError';
        this.version = version;
        Object.setPrototypeOf(this, UnsupportedTodoDataVersionError.prototype);
    }
}

function asObject(value: unknown): { [key: string]: unknown } {
    return value && typeof value === 'object' ? value as { [key: string]: unknown } : {};
}

function cleanString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value.trim() : fallback;
}

function cleanDateString(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value : fallback;
}

function cleanOrder(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function normalizeTodoPriority(value: unknown): TodoPriority {
    if (value === 'high' || value === 'medium' || value === 'low') {
        return value;
    }

    return 'medium';
}

export function normalizeTodoData(value: unknown, nowIso = new Date(0).toISOString()): TodoDataV1 {
    const source = asObject(value);
    if (source.version !== undefined && source.version !== 1) {
        throw new UnsupportedTodoDataVersionError(source.version);
    }
    const rawGroups = Array.isArray(source.groups) ? source.groups : [];
    const groups: TodoGroup[] = [];
    const groupIds = new Set<string>();

    rawGroups.forEach((rawGroup, index) => {
        const group = asObject(rawGroup);
        const id = cleanString(group.id);
        if (!id || groupIds.has(id)) {
            return;
        }

        groupIds.add(id);
        groups.push({
            id,
            title: cleanString(group.title, TODO_UNTITLED_GROUP_TITLE) || TODO_UNTITLED_GROUP_TITLE,
            collapsed: group.collapsed === true,
            order: cleanOrder(group.order, index),
        });
    });

    const rawTodos = Array.isArray(source.todos) ? source.todos : [];
    const todos: TodoItem[] = [];
    const todoIds = new Set<string>();

    rawTodos.forEach((rawTodo, index) => {
        const todo = asObject(rawTodo);
        const id = cleanString(todo.id);
        const groupId = cleanString(todo.groupId);
        if (!id || todoIds.has(id) || !groupIds.has(groupId)) {
            return;
        }

        const completed = todo.completed === true;
        const completedAt = completed ? cleanDateString(todo.completedAt, nowIso) : undefined;
        todoIds.add(id);
        todos.push({
            id,
            groupId,
            title: cleanString(todo.title, TODO_UNTITLED_ITEM_TITLE) || TODO_UNTITLED_ITEM_TITLE,
            notes: typeof todo.notes === 'string' ? todo.notes.trim() : '',
            priority: normalizeTodoPriority(todo.priority),
            completed,
            createdAt: cleanDateString(todo.createdAt, nowIso),
            updatedAt: cleanDateString(todo.updatedAt, nowIso),
            completedAt,
            order: cleanOrder(todo.order, index),
        });
    });

    return {
        version: 1,
        groups: groups.sort((a, b) => a.order - b.order),
        todos: todos.sort((a, b) => a.order - b.order),
    };
}

export function buildTodoSearchItems(data: TodoDataV1): TodoSearchCatalogItem[] {
    const normalized = normalizeTodoData(data);
    const groupsById = new Map(normalized.groups.map(group => [group.id, group]));

    return normalized.todos.map(todo => {
        const group = groupsById.get(todo.groupId);
        const notesSearchText = todo.notes.slice(0, TODO_NOTES_SEARCH_TEXT_LIMIT);
        const groupTitle = group ? group.title : '';
        return {
            key: `todo:${todo.id}`,
            todoId: todo.id,
            groupId: todo.groupId,
            title: todo.title,
            groupTitle,
            priority: todo.priority,
            completed: todo.completed,
            notesSearchText,
            searchText: [todo.title, groupTitle, todo.priority, notesSearchText]
                .join(' ')
                .toLowerCase(),
        };
    });
}
