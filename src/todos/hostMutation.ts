export interface TodoHostMutationOptions {
    mutate: () => Promise<unknown>;
    onSuccess: () => Promise<unknown>;
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
