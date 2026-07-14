export async function drainBatch(promises: readonly Promise<unknown>[]): Promise<void> {
    let hasError = false;
    let firstError: unknown;

    await Promise.all(promises.map(promise => promise.then(
        () => undefined,
        error => {
            if (!hasError) {
                hasError = true;
                firstError = error;
            }
        }
    )));

    if (hasError) {
        throw firstError;
    }
}
