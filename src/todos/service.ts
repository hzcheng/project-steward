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
    TodoSearchCatalogItem,
    TodoStorageConflictError,
    TodoViewState,
    UnsupportedTodoDataVersionError,
    buildTodoSearchItems,
    normalizeTodoData,
    normalizeTodoPriority,
} from './types';

const GLOBAL_CONFIGURATION_TARGET = 1;
const TODO_STORAGE_BACKEND_KEY = 'todoStorageBackend';

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
    private activeDataBackend: boolean | undefined;

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
        return this.getDataFromBackend(this.useSettings());
    }

    getSearchItems(): TodoSearchCatalogItem[] {
        const versionError = this.getUnsupportedVersionError();
        if (versionError) {
            return [];
        }
        try {
            return buildTodoSearchItems(this.getData());
        } catch (error) {
            if (error instanceof UnsupportedTodoDataVersionError) {
                return [];
            }
            throw error;
        }
    }

    getUnsupportedVersionError(): UnsupportedTodoDataVersionError | undefined {
        try {
            this.assertSupportedDataVersions();
            return undefined;
        } catch (error) {
            if (error instanceof UnsupportedTodoDataVersionError) {
                return error;
            }
            throw error;
        }
    }

    saveData(data: TodoDataV1): Promise<void> {
        let normalized: TodoDataV1;
        try {
            normalized = normalizeTodoData(data, this.now());
        } catch (error) {
            return Promise.reject(error);
        }
        return this.enqueueDataMutation(useSettings => this.writeData(normalized, useSettings));
    }

    getViewState(): TodoViewState {
        const value = this.globalState.get<Partial<TodoViewState>>(TODO_VIEW_STATE_KEY);
        return { showCompleted: !!value && value.showCompleted === true };
    }

    setShowCompleted(showCompleted: boolean): Promise<TodoViewState> {
        return this.enqueueDataMutation(() => this.setShowCompletedNow(showCompleted));
    }

    revealTodo(todoId: string, groupId: string): Promise<{
        revealed: boolean;
        data: TodoDataV1;
    }> {
        return this.enqueueDataMutation(async useSettings => {
            const data = this.getDataFromBackend(useSettings);
            const todo = data.todos.find(item => item.id === todoId);
            const group = data.groups.find(item => item.id === groupId);
            if (!todo || !group || todo.groupId !== group.id) {
                return { revealed: false, data };
            }
            if (group.collapsed) {
                group.collapsed = false;
                await this.saveDataNow(data, useSettings);
            }
            return { revealed: true, data };
        });
    }

    migrateDataIfNeeded(): Promise<boolean> {
        const useSettings = this.useSettings();
        return this.enqueueMutation(() => this.switchDataBackend(useSettings));
    }

    addGroup(title?: string): Promise<TodoDataV1> {
        return this.enqueueDataMutation(async useSettings => {
            const data = this.getDataFromBackend(useSettings);
            const group: TodoGroup = {
                id: this.generateId('todo-group'),
                title: (title || '').trim() || TODO_UNTITLED_GROUP_TITLE,
                collapsed: false,
                order: data.groups.length,
            };

            data.groups.push(group);
            await this.saveDataNow(data, useSettings);
            return data;
        });
    }

    addTodo(input: AddTodoInput): Promise<TodoDataV1> {
        return this.enqueueDataMutation(async useSettings => {
            const data = this.getDataFromBackend(useSettings);
            const group = this.resolveTargetGroup(data, input.groupId);
            const now = this.now();
            data.todos
                .map((todo, index) => ({ todo, index }))
                .filter(entry => entry.todo.groupId === group.id)
                .sort((a, b) => a.todo.order - b.todo.order || a.index - b.index)
                .forEach((entry, index) => { entry.todo.order = index + 1; });
            data.todos.push({
                id: this.generateId('todo'),
                groupId: group.id,
                title: (input.title || '').trim() || TODO_UNTITLED_ITEM_TITLE,
                notes: (input.notes || '').trim(),
                priority: normalizeTodoPriority(input.priority),
                completed: false,
                createdAt: now,
                updatedAt: now,
                order: 0,
            });

            await this.saveDataNow(data, useSettings);
            return data;
        });
    }

    renameGroup(id: string, title: string): Promise<TodoDataV1> {
        return this.enqueueDataMutation(async useSettings => {
            const data = this.getDataFromBackend(useSettings);
            const group = data.groups.find(item => item.id === id);
            if (!group) {
                return data;
            }

            group.title = (title || '').trim() || TODO_UNTITLED_GROUP_TITLE;
            await this.saveDataNow(data, useSettings);
            return data;
        });
    }

    reorderGroups(groupIds: string[]): Promise<TodoDataV1> {
        return this.enqueueDataMutation(async useSettings => {
            const data = this.getDataFromBackend(useSettings);
            this.assertExactOrder(data.groups.map(group => group.id), groupIds, 'TODO group');

            const groupsById = new Map(data.groups.map(group => [group.id, group]));
            data.groups = groupIds.map((groupId, order) => ({ ...groupsById.get(groupId)!, order }));
            await this.saveDataNow(data, useSettings);
            return data;
        });
    }

    reorderTodos(groupId: string, todoIds: string[]): Promise<TodoDataV1> {
        return this.enqueueDataMutation(async useSettings => {
            const data = this.getDataFromBackend(useSettings);
            if (!data.groups.some(group => group.id === groupId)) {
                throw new Error('TODO item reorder group must exist.');
            }
            const groupTodos = data.todos.filter(todo => todo.groupId === groupId);
            const otherGroupTodoIds = new Set(data.todos
                .filter(todo => todo.groupId !== groupId)
                .map(todo => todo.id));
            if (Array.isArray(todoIds) && todoIds.some(todoId => otherGroupTodoIds.has(todoId))) {
                throw new Error('TODO items can only be reordered within the same group.');
            }
            const allTodoIds = groupTodos.map(todo => todo.id);
            const incompleteTodoIds = groupTodos.filter(todo => !todo.completed).map(todo => todo.id);
            if (!this.hasExactIds(allTodoIds, todoIds) && !this.hasExactIds(incompleteTodoIds, todoIds)) {
                throw new Error('TODO item reorder must include exactly the current visible IDs.');
            }

            const requestedTodoIds = new Set(todoIds);
            const orderedTodoIds = todoIds.concat(allTodoIds.filter(todoId => !requestedTodoIds.has(todoId)));
            const orderByTodoId = new Map(orderedTodoIds.map((todoId, order) => [todoId, order]));
            groupTodos.forEach(todo => { todo.order = orderByTodoId.get(todo.id)!; });
            await this.saveDataNow(data, useSettings);
            return data;
        });
    }

    updateTodo(id: string, patch: TodoPatch): Promise<TodoDataV1> {
        return this.enqueueDataMutation(async useSettings => {
            const data = this.getDataFromBackend(useSettings);
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

            await this.saveDataNow(data, useSettings);
            return data;
        });
    }

    completeTodo(id: string, completed: boolean): Promise<TodoDataV1> {
        return this.enqueueDataMutation(async useSettings => {
            const data = this.getDataFromBackend(useSettings);
            const todo = data.todos.find(item => item.id === id);
            if (!todo) {
                return data;
            }

            const now = this.now();
            todo.completed = completed;
            todo.completedAt = completed ? now : undefined;
            todo.updatedAt = now;
            await this.saveDataNow(data, useSettings);
            return data;
        });
    }

    deleteTodo(id: string): Promise<TodoDataV1> {
        return this.enqueueDataMutation(async useSettings => {
            const data = this.getDataFromBackend(useSettings);
            data.todos = data.todos.filter(todo => todo.id !== id);
            await this.saveDataNow(data, useSettings);
            return data;
        });
    }

    deleteGroup(id: string): Promise<TodoDataV1> {
        return this.enqueueDataMutation(async useSettings => {
            const data = this.getDataFromBackend(useSettings);
            const groupExists = data.groups.some(group => group.id === id);
            if (!groupExists) {
                return data;
            }

            data.groups = data.groups
                .filter(group => group.id !== id)
                .map((group, index) => ({ ...group, order: index }));
            data.todos = data.todos.filter(todo => todo.groupId !== id);
            await this.saveDataNow(data, useSettings);
            return data;
        });
    }

    setGroupCollapsed(id: string, collapsed: boolean): Promise<TodoDataV1> {
        return this.enqueueDataMutation(async useSettings => {
            const data = this.getDataFromBackend(useSettings);
            const group = data.groups.find(item => item.id === id);
            if (!group) {
                return data;
            }

            group.collapsed = collapsed;
            await this.saveDataNow(data, useSettings);
            return data;
        });
    }

    setGroupsCollapsed(collapsed: boolean): Promise<TodoDataV1> {
        return this.enqueueDataMutation(async useSettings => {
            const data = this.getDataFromBackend(useSettings);
            data.groups.forEach(group => { group.collapsed = collapsed; });
            await this.saveDataNow(data, useSettings);
            return data;
        });
    }

    sortGroupByPriority(groupId: string): Promise<TodoDataV1> {
        return this.enqueueDataMutation(async useSettings => {
            const data = this.getDataFromBackend(useSettings);
            const priorityRank = { high: 0, medium: 1, low: 2 };
            const sorted = data.todos
                .filter(todo => todo.groupId === groupId)
                .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.order - b.order);

            sorted.forEach((todo, index) => {
                todo.order = index;
                todo.updatedAt = this.now();
            });

            await this.saveDataNow(data, useSettings);
            return data;
        });
    }

    private getRawData(useSettings: boolean): unknown {
        return useSettings
            ? this.getConfiguration().get<unknown>(TODO_SETTINGS_KEY)
            : this.globalState.get<unknown>(TODO_DATA_KEY);
    }

    private getDataFromBackend(useSettings: boolean): TodoDataV1 {
        return normalizeTodoData(this.getRawData(useSettings), this.now());
    }

    private async saveDataNow(data: TodoDataV1, useSettings: boolean): Promise<void> {
        const normalized = normalizeTodoData(data, this.now());
        await this.writeData(normalized, useSettings);
    }

    private async setShowCompletedNow(showCompleted: boolean): Promise<TodoViewState> {
        const viewState = { showCompleted };
        await this.globalState.update(TODO_VIEW_STATE_KEY, viewState);
        return viewState;
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

    private async switchDataBackend(useSettings: boolean): Promise<boolean> {
        if (this.activeDataBackend === useSettings) {
            this.assertSupportedDataVersions();
            return false;
        }
        if (this.activeDataBackend === undefined && this.getKnownDataBackend() === useSettings) {
            this.assertSupportedDataVersions();
            this.activeDataBackend = useSettings;
            return false;
        }

        const now = this.now();
        const destination = normalizeTodoData(this.getRawData(useSettings), now);
        const source = normalizeTodoData(this.getRawData(!useSettings), now);
        const destinationHasData = this.hasData(destination);
        const sourceHasData = this.hasData(source);

        if (destinationHasData && sourceHasData
            && JSON.stringify(destination) !== JSON.stringify(source)) {
            throw new TodoStorageConflictError();
        }

        if (!destinationHasData && sourceHasData) {
            await this.writeData(source, useSettings);
            await this.rememberDataBackend(useSettings);
            this.activeDataBackend = useSettings;
            return true;
        }

        if (destinationHasData && sourceHasData) {
            await this.rememberDataBackend(useSettings);
        }

        this.activeDataBackend = useSettings;
        return false;
    }

    private getKnownDataBackend(): boolean | undefined {
        const value = this.globalState.get<unknown>(TODO_STORAGE_BACKEND_KEY);
        return typeof value === 'boolean' ? value : undefined;
    }

    private async rememberDataBackend(useSettings: boolean): Promise<void> {
        await this.globalState.update(TODO_STORAGE_BACKEND_KEY, useSettings);
    }

    private assertSupportedDataVersions(): void {
        const now = this.now();
        const useSettings = this.useSettings();
        const selected = this.getRawData(useSettings);
        const other = this.getRawData(!useSettings);
        normalizeTodoData(selected, now);
        normalizeTodoData(other, now);
    }

    private enqueueDataMutation<T>(mutation: (useSettings: boolean) => Promise<T>): Promise<T> {
        const useSettings = this.useSettings();
        return this.enqueueMutation(async () => {
            await this.switchDataBackend(useSettings);
            return mutation(useSettings);
        });
    }

    private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(mutation);
        this.mutationQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private assertExactOrder(actualIds: string[], requestedIds: string[], scope: string): void {
        if (!this.hasExactIds(actualIds, requestedIds)) {
            throw new Error(`${scope} reorder must include exactly the current IDs.`);
        }
    }

    private hasExactIds(actualIds: string[], requestedIds: string[]): boolean {
        if (!Array.isArray(requestedIds) || requestedIds.length !== actualIds.length) {
            return false;
        }
        const requestedIdSet = new Set(requestedIds);
        return requestedIdSet.size === requestedIds.length
            && actualIds.every(id => requestedIdSet.has(id));
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
