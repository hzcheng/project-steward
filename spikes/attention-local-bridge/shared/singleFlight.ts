export function createSingleFlight<Arguments extends unknown[], Result>(
    operation: (...args: Arguments) => Promise<Result>
): (...args: Arguments) => Promise<Result> {
    let inFlight: Promise<Result> | null = null;

    return (...args: Arguments): Promise<Result> => {
        if (inFlight !== null) {
            return inFlight;
        }

        const current = Promise.resolve().then(() => operation(...args));
        inFlight = current;
        current.then(
            () => {
                if (inFlight === current) {
                    inFlight = null;
                }
            },
            () => {
                if (inFlight === current) {
                    inFlight = null;
                }
            }
        );
        return current;
    };
}
