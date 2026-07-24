import { TodoService } from './service';
import {
    AddTodoInput,
    TodoCommandAction,
    TodoCommandErrorCode,
    TodoCommandMessage,
    TodoCommandResultMessage,
    TodoDataV1,
    TodoItem,
    TodoPatch,
    TodoPriority,
    TodoRestorePosition,
    TodoStorageConflictError,
    TodoViewState,
} from './types';
import { buildTodoPanelSnapshot } from './viewModel';

const TODO_COMMAND_VERSION = 2;
const TODO_UNDO_WINDOW_MS = 5_000;
const TODO_COMMAND_ACTIONS = new Set<TodoCommandAction>([
    'add',
    'update',
    'complete',
    'delete',
    'undo',
    'reorder-items',
    'reorder-groups',
    'collapse-group',
    'collapse-groups',
    'sort-priority',
    'show-completed',
]);

interface TodoCommandControllerOptions {
    service: TodoService;
    getViewState: () => TodoViewState;
    setShowCompleted: (value: boolean) => Promise<TodoViewState>;
    getRevealedTodoId: () => string | undefined;
    clearRevealedTodoId: () => void;
    nowMs?: () => number;
    createUndoToken?: () => string;
}

interface TodoUndoRecord {
    expiresAt: number;
    item: TodoItem;
    position: TodoRestorePosition;
}

interface TodoCommandExecution {
    data: TodoDataV1;
    undoToken?: string;
}

class TodoCommandInputError extends Error {
    constructor(readonly code: 'invalid' | 'not-found' | 'undo-expired') {
        super(code);
        Object.setPrototypeOf(this, TodoCommandInputError.prototype);
    }
}

function asObject(value: unknown): { [key: string]: unknown } {
    return value && typeof value === 'object'
        ? value as { [key: string]: unknown }
        : {};
}

function requiredString(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TodoCommandInputError('invalid');
    }
    return value;
}

function optionalString(value: unknown): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new TodoCommandInputError('invalid');
    }
    return value;
}

function requiredBoolean(value: unknown): boolean {
    if (typeof value !== 'boolean') {
        throw new TodoCommandInputError('invalid');
    }
    return value;
}

function requiredStringArray(value: unknown): string[] {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) {
        throw new TodoCommandInputError('invalid');
    }
    return value as string[];
}

function optionalPriority(value: unknown): TodoPriority | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (value !== 'high' && value !== 'medium' && value !== 'low') {
        throw new TodoCommandInputError('invalid');
    }
    return value;
}

function defaultUndoToken(): string {
    return `todo-undo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

export class TodoCommandController {
    private readonly service: TodoService;
    private readonly getViewState: () => TodoViewState;
    private readonly setShowCompleted: (value: boolean) => Promise<TodoViewState>;
    private readonly getRevealedTodoId: () => string | undefined;
    private readonly clearRevealedTodoId: () => void;
    private readonly nowMs: () => number;
    private readonly createUndoToken: () => string;
    private readonly undoRecords = new Map<string, TodoUndoRecord>();
    private revision = 0;

    constructor(options: TodoCommandControllerOptions) {
        this.service = options.service;
        this.getViewState = options.getViewState;
        this.setShowCompleted = options.setShowCompleted;
        this.getRevealedTodoId = options.getRevealedTodoId;
        this.clearRevealedTodoId = options.clearRevealedTodoId;
        this.nowMs = options.nowMs || (() => Date.now());
        this.createUndoToken = options.createUndoToken || defaultUndoToken;
    }

    async handle(value: unknown): Promise<TodoCommandResultMessage | undefined> {
        const message = this.readMessage(value);
        if (!message) {
            return undefined;
        }

        const revision = ++this.revision;
        try {
            const execution = await this.execute(message.action, message.payload);
            return {
                type: 'todo-command-result',
                version: TODO_COMMAND_VERSION,
                requestId: message.requestId,
                revision,
                success: true,
                snapshot: buildTodoPanelSnapshot(
                    execution.data,
                    this.getViewState(),
                    this.getRevealedTodoId()
                ),
                ...(execution.undoToken ? { undoToken: execution.undoToken } : {}),
            };
        } catch (error) {
            return {
                type: 'todo-command-result',
                version: TODO_COMMAND_VERSION,
                requestId: message.requestId,
                revision,
                success: false,
                snapshot: this.getSnapshot(),
                errorCode: this.mapError(error),
            };
        }
    }

    private readMessage(value: unknown): TodoCommandMessage | undefined {
        const message = asObject(value);
        if (message.type !== 'todo-command'
            || message.version !== TODO_COMMAND_VERSION
            || typeof message.requestId !== 'number'
            || !Number.isSafeInteger(message.requestId)
            || message.requestId < 1
            || typeof message.action !== 'string'
            || !TODO_COMMAND_ACTIONS.has(message.action as TodoCommandAction)) {
            return undefined;
        }
        return message as unknown as TodoCommandMessage;
    }

    private async execute(action: TodoCommandAction, value: unknown): Promise<TodoCommandExecution> {
        const payload = asObject(value);
        switch (action) {
            case 'add':
                return { data: await this.service.addTodo(this.readAddInput(payload)) };
            case 'update':
                return { data: await this.updateTodo(payload) };
            case 'complete':
                return this.completeTodo(payload);
            case 'delete':
                return this.deleteTodo(payload);
            case 'undo':
                return { data: await this.undo(payload) };
            case 'reorder-items':
                return {
                    data: await this.service.reorderTodos(
                        requiredString(payload.groupId),
                        requiredStringArray(payload.todoIds)
                    ),
                };
            case 'reorder-groups':
                return { data: await this.service.reorderGroups(requiredStringArray(payload.groupIds)) };
            case 'collapse-group':
                return {
                    data: await this.service.setGroupCollapsed(
                        requiredString(payload.groupId),
                        requiredBoolean(payload.collapsed)
                    ),
                };
            case 'collapse-groups':
                return {
                    data: await this.service.setGroupsCollapsed(requiredBoolean(payload.collapsed)),
                };
            case 'sort-priority':
                return {
                    data: await this.service.sortGroupByPriority(requiredString(payload.groupId)),
                };
            case 'show-completed': {
                const state = await this.setShowCompleted(requiredBoolean(payload.showCompleted));
                if (!state.showCompleted) {
                    this.clearRevealedTodoId();
                }
                return { data: this.service.getData() };
            }
        }
    }

    private readAddInput(payload: { [key: string]: unknown }): AddTodoInput {
        return {
            title: requiredString(payload.title),
            notes: optionalString(payload.notes),
            priority: optionalPriority(payload.priority),
            groupId: optionalString(payload.groupId),
        };
    }

    private async updateTodo(payload: { [key: string]: unknown }): Promise<TodoDataV1> {
        const todoId = requiredString(payload.todoId);
        const current = this.findTodo(todoId);
        const groupId = optionalString(payload.groupId);
        if (groupId !== undefined && !this.service.getData().groups.some(group => group.id === groupId)) {
            throw new TodoCommandInputError('not-found');
        }
        if (groupId && groupId !== current.groupId) {
            await this.service.moveTodo(todoId, groupId);
        }
        const patch: TodoPatch = {
            title: optionalString(payload.title),
            notes: optionalString(payload.notes),
            priority: optionalPriority(payload.priority),
        };
        return this.service.updateTodo(todoId, patch);
    }

    private async completeTodo(payload: { [key: string]: unknown }): Promise<TodoCommandExecution> {
        const todoId = requiredString(payload.todoId);
        const item = this.findTodo(todoId);
        const position = this.getRestorePosition(item);
        const data = await this.service.completeTodo(todoId, requiredBoolean(payload.completed));
        return { data, undoToken: this.rememberUndo(item, position) };
    }

    private async deleteTodo(payload: { [key: string]: unknown }): Promise<TodoCommandExecution> {
        const todoId = requiredString(payload.todoId);
        const item = this.findTodo(todoId);
        const position = this.getRestorePosition(item);
        const data = await this.service.deleteTodo(todoId);
        return { data, undoToken: this.rememberUndo(item, position) };
    }

    private async undo(payload: { [key: string]: unknown }): Promise<TodoDataV1> {
        const token = requiredString(payload.undoToken);
        const record = this.undoRecords.get(token);
        if (!record || this.nowMs() > record.expiresAt) {
            this.undoRecords.delete(token);
            throw new TodoCommandInputError('undo-expired');
        }

        this.undoRecords.delete(token);
        try {
            return await this.service.restoreTodo(record.item, record.position);
        } catch (error) {
            this.undoRecords.set(token, record);
            throw error;
        }
    }

    private findTodo(todoId: string): TodoItem {
        const todo = this.service.getData().todos.find(item => item.id === todoId);
        if (!todo) {
            throw new TodoCommandInputError('not-found');
        }
        return todo;
    }

    private getRestorePosition(item: TodoItem): TodoRestorePosition {
        const groupTodos = this.service.getData().todos
            .filter(todo => todo.groupId === item.groupId)
            .sort((left, right) => left.order - right.order);
        const index = groupTodos.findIndex(todo => todo.id === item.id);
        return {
            beforeId: index > 0 ? groupTodos[index - 1].id : undefined,
            afterId: index >= 0 && index + 1 < groupTodos.length
                ? groupTodos[index + 1].id
                : undefined,
        };
    }

    private rememberUndo(item: TodoItem, position: TodoRestorePosition): string {
        const token = this.createUndoToken();
        this.undoRecords.set(token, {
            expiresAt: this.nowMs() + TODO_UNDO_WINDOW_MS,
            item: { ...item },
            position,
        });
        return token;
    }

    private getSnapshot() {
        return buildTodoPanelSnapshot(
            this.service.getData(),
            this.getViewState(),
            this.getRevealedTodoId()
        );
    }

    private mapError(error: unknown): TodoCommandErrorCode {
        if (error instanceof TodoStorageConflictError) {
            return 'conflict';
        }
        if (error instanceof TodoCommandInputError) {
            return error.code;
        }
        return 'storage';
    }
}
