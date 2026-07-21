import {
    OpenWorkspacePublication,
    validateOpenWorkspacePublication,
} from '../../../src/openWorkspaces/protocol';

export function replaceOpenWorkspacePublicationUris(
    raw: unknown,
    workspaceUri: string | null,
    rootUris: readonly string[],
): OpenWorkspacePublication {
    const publication = validateOpenWorkspacePublication(raw);
    if (!publication.workspace) {
        return publication;
    }
    const workspace = publication.workspace;
    const roots = workspace.roots.map(root => ({
        ...root,
        uri: rootUris[root.ordinal] || root.uri,
    }));
    const navigationUri = workspaceUri
        || (workspace.kind === 'singleFolder' ? roots[0]?.uri : undefined)
        || workspace.navigationUri;
    return validateOpenWorkspacePublication({
        ...publication,
        workspace: {
            ...workspace,
            navigationUri,
            roots,
        },
    });
}
