import type * as vscode from 'vscode';

import {
    TODO_DATA_KEY,
    TODO_DEFAULT_GROUP_TITLE,
    TODO_SETTINGS_KEY,
    TODO_UNTITLED_GROUP_TITLE,
    TODO_UNTITLED_ITEM_TITLE,
    TODO_VIEW_STATE_KEY,
} from '../constants';
import { getStewardConfiguration } from '../dashboard/configuration';
import {
    AddTodoInput,
    TodoDataV1,
    TodoGroup,
    TodoPatch,
    TodoViewState,
    normalizeTodoData,
    normalizeTodoPriority,
} from './types';

const GLOBAL_CONFIGURATION_TARGET = 1;

interface TodoMemento {
    get<T>(key: string): T;
    update(key: string, value: unknown): Thenable<void>;
}

interface TodoConfiguration {
    get<T>(key: string, defaultValue?: T): T;
    update(key: string, value: unknown, target?: unknown): Thenable<void>;
}

export interface TodoServiceDependencies {
    globalState: TodoMemento;
    configuration?: TodoConfiguration;
    useSettingsStorage?: () => boolean;
    now?: () => string;
    generateId?: (prefix: string) => string;
}

function createId(prefix: string): string {
    return `${prefix}-${Math.random().toString(36).substr(2, 9)}-${Date.now().toString(36)}`;
}

function getWorkspaceConfiguration(): TodoConfiguration {
    return getStewardConfiguration();
}

function isDependencies(value: vscode.ExtensionContext | TodoServiceDependencies): value is TodoServiceDependencies {
    return !!value && typeof (value as TodoServiceDependencies).useSettingsStorage === 'function';
}

export class TodoService {
    private readonly globalState: TodoMemento;
    private readonly getConfiguration: () => TodoConfiguration;
    private readonly useSettings: () => boolean;
    private readonly now: () => string;
    private readonly generateId: (prefix: string) => string;
    private mutationQueue: Promise<void> = Promise.resolve();

    constructor(contextOrDependencies: vscode.ExtensionContext | TodoServiceDependencies) {
        if (isDependencies(contextOrDependencies)) {
            this.globalState = contextOrDependencies.globalState;
            this.getConfiguration = () => contextOrDependencies.configuration || getWorkspaceConfiguration();
            this.useSettings = contextOrDependencies.useSettingsStorage;
            this.now = contextOrDependencies.now || (() => new Date().toISOString());
            this.generateId = contextOrDependencies.generateId || createId;
            return;
        }

        const context = contextOrDependencies as vscode.ExtensionContext;
        this.globalState = context.globalState as TodoMemento;
        this.getConfiguration = getWorkspaceConfiguration;
        this.useSettings = () => this.getConfiguration().get<boolean>('storeProjectsInSettings', true);
        this.now = () => new Date().toISOString();
        this.generateId = createId;
    }

    getData(): TodoDataV1 {
        return normalizeTodoData(this.getRawData(this.useSettings()), this.now());
    }

    saveData(data: TodoDataV1): Promise<void> {
        return this.enqueueMutation(() => this.saveDataNow(data));
    }

    getViewState(): TodoViewState {
        const value = this.globalState.get<Partial<TodoViewState>>(TODO_VIEW_STATE_KEY);
        return { showCompleted: !!value && value.showCompleted === true };
    }

    setShowCompleted(showCompleted: boolean): Promise<TodoViewState> {
        return this.enqueueMutation(async () => {
            const viewState = { showCompleted };
            await this.globalState.update(TODO_VIEW_STATE_KEY, viewState);
            return viewState;
        });
    }

    migrateDataIfNeeded(): Promise<boolean> {
        return this.enqueueMutation(async () => {
            const useSettings = this.useSettings();
            const destination = normalizeTodoData(this.getRawData(useSettings), this.now());
            if (this.hasData(destination)) {
                return false;
            }

            const source = normalizeTodoData(this.getRawData(!useSettings), this.now());
            if (!this.hasData(source)) {
                return false;
            }

            await this.writeData(source, useSettings);
            return true;
        });
    }

    addGroup(title?: string): Promise<TodoDataV1> {
        return this.enqueueMutation(async () => {
            const data = this.getData();
            const group: TodoGroup = {
                id: this.generateId('todo-group'),
                title: (title || '').trim() || TODO_UNTITLED_GROUP_TITLE,
                collapsed: false,
                order: data.groups.length,
            };

            data.groups.push(group);
            await this.saveDataNow(data);
            return data;
        });
    }

    addTodo(input: AddTodoInput): Promise<TodoDataV1> {
        return this.enqueueMutation(async () => {
            const data = this.getData();
            const group = this.resolveTargetGroup(data, input.groupId);
            const now = this.now();
            data.todos.push({
                id: this.generateId('todo'),
                groupId: group.id,
                title: (input.title || '').trim() || TODO_UNTITLED_ITEM_TITLE,
                notes: (input.notes || '').trim(),
                priority: normalizeTodoPriority(input.priority),
                completed: false,
                createdAt: now,
                updatedAt: now,
                order: data.todos.filter(todo => todo.groupId === group.id).length,
            });

            await this.saveDataNow(data);
            return data;
        });
    }

    updateTodo(id: string, patch: TodoPatch): Promise<TodoDataV1> {
        return this.enqueueMutation(async () => {
            const data = this.getData();
            const todo = data.todos.find(item => item.id === id);
            if (!todo) {
                return data;
            }

            if (patch.title !== undefined) {
                todo.title = patch.title.trim() || TODO_UNTITLED_ITEM_TITLE;
            }
            if (patch.notes !== undefined) {
                todo.notes = patch.notes.trim();
            }
            if (patch.priority !== undefined) {
                todo.priority = normalizeTodoPriority(patch.priority);
            }
            if (patch.groupId !== undefined && data.groups.some(group => group.id === patch.groupId)) {
                todo.groupId = patch.groupId;
            }
            todo.updatedAt = this.now();

            await this.saveDataNow(data);
            return data;
        });
    }

    completeTodo(id: string, completed: boolean): Promise<TodoDataV1> {
        return this.enqueueMutation(async () => {
            const data = this.getData();
            const todo = data.todos.find(item => item.id === id);
            if (!todo) {
                return data;
            }

            const now = this.now();
            todo.completed = completed;
            todo.completedAt = completed ? now : undefined;
            todo.updatedAt = now;
            await this.saveDataNow(data);
            return data;
        });
    }

    deleteTodo(id: string): Promise<TodoDataV1> {
        return this.enqueueMutation(async () => {
            const data = this.getData();
            data.todos = data.todos.filter(todo => todo.id !== id);
            await this.saveDataNow(data);
            return data;
        });
    }

    deleteGroup(id: string): Promise<TodoDataV1> {
        return this.enqueueMutation(async () => {
            const data = this.getData();
            const groupExists = data.groups.some(group => group.id === id);
            if (!groupExists) {
                return data;
            }

            data.groups = data.groups
                .filter(group => group.id !== id)
                .map((group, index) => ({ ...group, order: index }));
            data.todos = data.todos.filter(todo => todo.groupId !== id);
            await this.saveDataNow(data);
            return data;
        });
    }

    setGroupCollapsed(id: string, collapsed: boolean): Promise<TodoDataV1> {
        return this.enqueueMutation(async () => {
            const data = this.getData();
            const group = data.groups.find(item => item.id === id);
            if (!group) {
                return data;
            }

            group.collapsed = collapsed;
            await this.saveDataNow(data);
            return data;
        });
    }

    sortGroupByPriority(groupId: string): Promise<TodoDataV1> {
        return this.enqueueMutation(async () => {
            const data = this.getData();
            const priorityRank = { high: 0, medium: 1, low: 2 };
            const sorted = data.todos
                .filter(todo => todo.groupId === groupId)
                .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.order - b.order);

            sorted.forEach((todo, index) => {
                todo.order = index;
                todo.updatedAt = this.now();
            });

            await this.saveDataNow(data);
            return data;
        });
    }

    private getRawData(useSettings: boolean): unknown {
        return useSettings
            ? this.getConfiguration().get<unknown>(TODO_SETTINGS_KEY)
            : this.globalState.get<unknown>(TODO_DATA_KEY);
    }

    private async saveDataNow(data: TodoDataV1): Promise<void> {
        const normalized = normalizeTodoData(data, this.now());
        await this.writeData(normalized, this.useSettings());
    }

    private async writeData(data: TodoDataV1, useSettings: boolean): Promise<void> {
        if (useSettings) {
            await this.getConfiguration().update(TODO_SETTINGS_KEY, data, GLOBAL_CONFIGURATION_TARGET);
            return;
        }

        await this.globalState.update(TODO_DATA_KEY, data);
    }

    private hasData(data: TodoDataV1): boolean {
        return data.groups.length > 0 || data.todos.length > 0;
    }

    private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(mutation);
        this.mutationQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private resolveTargetGroup(data: TodoDataV1, requestedGroupId?: string): TodoGroup {
        if (requestedGroupId) {
            const requestedGroup = data.groups.find(group => group.id === requestedGroupId);
            if (requestedGroup) {
                return requestedGroup;
            }
        }

        let inbox = data.groups.find(group => group.title === TODO_DEFAULT_GROUP_TITLE);
        if (!inbox) {
            inbox = {
                id: this.generateId('todo-group'),
                title: TODO_DEFAULT_GROUP_TITLE,
                collapsed: false,
                order: data.groups.length,
            };
            data.groups.unshift(inbox);
            data.groups.forEach((group, index) => {
                group.order = index;
            });
        }

        return inbox;
    }
}
