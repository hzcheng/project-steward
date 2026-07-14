export const EMPTY_WORKSPACE_IDENTITY = '<empty-workspace>';

export function createWorkspaceIdentity(uriPaths: readonly string[]): string {
    if (uriPaths.length === 0) {
        return EMPTY_WORKSPACE_IDENTITY;
    }
    return uriPaths.slice().sort().join('\n');
}
