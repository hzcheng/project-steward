import { TodoStorageConflictError } from './types';

export interface TodoHostMutationOptions {
    mutate: () => Promise<unknown>;
    onSuccess: () => Promise<unknown>;
    showErrorMessage: (message: string) => unknown;
    logError: (message: string, error: unknown) => unknown;
}

interface TodoDeletionData {
    todos: Array<{
        id: string;
        title: string;
    }>;
}

export interface DeleteTodoWithConfirmationOptions {
    todoId: string;
    getData: () => TodoDeletionData;
    confirm: (title: string) => PromiseLike<unknown>;
    deleteTodo: (todoId: string) => Promise<unknown>;
    refreshPanel: () => Promise<unknown>;
    showErrorMessage: (message: string) => unknown;
    logError: (message: string, error: unknown) => unknown;
}

export interface TodoPromptMutationOptions {
    initialValue?: string;
    prompt: (value: string | undefined) => PromiseLike<string | undefined>;
    mutate: (value: string) => Promise<unknown>;
    refreshPanel: () => Promise<unknown>;
    showErrorMessage: (message: string) => unknown;
    logError: (message: string, error: unknown) => unknown;
}

interface TodoGroupData {
    groups: Array<{
        id: string;
        title: string;
    }>;
}

export interface RenameTodoGroupWithPromptOptions {
    groupId: string;
    getData: () => TodoGroupData;
    prompt: (value: string) => PromiseLike<string | undefined>;
    renameGroup: (groupId: string, value: string) => Promise<unknown>;
    refreshPanel: () => Promise<unknown>;
    showErrorMessage: (message: string) => unknown;
    logError: (message: string, error: unknown) => unknown;
}

export interface TodoMutationResultMessage {
    type: 'todo-mutation-result';
    version: 1;
    requestId: number;
    success: boolean;
    panelRefreshed?: boolean;
}

export interface TodoRequestMutationOptions extends TodoHostMutationOptions {
    requestId: unknown;
    valid: boolean;
    postResult: (message: TodoMutationResultMessage) => PromiseLike<unknown>;
}

export async function runTodoMutation(options: TodoHostMutationOptions): Promise<boolean> {
    try {
        await options.mutate();
    } catch (error) {
        options.logError('Failed to save TODO changes.', error);
        options.showErrorMessage(error instanceof TodoStorageConflictError
            ? `${error.message} Your current panel has been preserved.`
            : 'Could not save TODO changes. Your current panel has been preserved.');
        return false;
    }

    await options.onSuccess();
    return true;
}

export async function runTodoPromptMutation(options: TodoPromptMutationOptions): Promise<boolean> {
    let promptValue = options.initialValue;
    while (true) {
        const value = await options.prompt(promptValue);
        if (value === undefined) {
            return false;
        }
        promptValue = value;
        const succeeded = await runTodoMutation({
            mutate: () => options.mutate(value),
            onSuccess: options.refreshPanel,
            showErrorMessage: options.showErrorMessage,
            logError: options.logError,
        });
        if (succeeded) {
            return true;
        }
    }
}

export async function runTodoRequestMutation(options: TodoRequestMutationOptions): Promise<boolean> {
    const requestId = options.requestId;
    if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId) || requestId < 1) {
        return false;
    }

    const succeeded = options.valid
        ? await runTodoMutation({
            ...options,
            onSuccess: async () => undefined,
        })
        : false;
    const result: TodoMutationResultMessage = {
        type: 'todo-mutation-result',
        version: 1,
        requestId,
        success: succeeded,
    };
    if (succeeded) {
        try {
            await options.onSuccess();
        } catch (error) {
            options.logError('Failed to refresh the TODO panel after saving.', error);
            options.showErrorMessage('TODO saved, but the panel could not be refreshed.');
            result.panelRefreshed = false;
        }
    }
    await options.postResult(result);
    return succeeded;
}

export async function renameTodoGroupWithPrompt(options: RenameTodoGroupWithPromptOptions): Promise<boolean> {
    const group = options.getData().groups.find(item => item.id === options.groupId);
    if (!group) {
        return false;
    }

    return runTodoPromptMutation({
        initialValue: group.title,
        prompt: value => options.prompt(value || ''),
        mutate: value => options.renameGroup(options.groupId, value),
        refreshPanel: options.refreshPanel,
        showErrorMessage: options.showErrorMessage,
        logError: options.logError,
    });
}

export async function deleteTodoWithConfirmation(options: DeleteTodoWithConfirmationOptions): Promise<boolean> {
    const todo = options.getData().todos.find(item => item.id === options.todoId);
    if (!todo) {
        return false;
    }

    const confirmed = await options.confirm(todo.title);
    if (confirmed !== 'Delete') {
        return false;
    }

    return runTodoMutation({
        mutate: () => options.deleteTodo(options.todoId),
        onSuccess: options.refreshPanel,
        showErrorMessage: options.showErrorMessage,
        logError: options.logError,
    });
}
