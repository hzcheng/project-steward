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

export async function runTodoMutation(options: TodoHostMutationOptions): Promise<boolean> {
    try {
        await options.mutate();
    } catch (error) {
        options.logError('Failed to save TODO changes.', error);
        options.showErrorMessage('Could not save TODO changes. Your current panel has been preserved.');
        return false;
    }

    await options.onSuccess();
    return true;
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
