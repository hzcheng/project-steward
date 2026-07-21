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
    if (workspace.roots.length !== rootUris.length) {
        throw new Error('authoritative root count must match the published workspace roots');
    }
    const roots = workspace.roots.map((root, index) => ({
        ...root,
        uri: rootUris[index],
    }));
    const navigationUri = workspace.kind === 'singleFolder'
        ? roots[0].uri
        : workspaceUri || workspace.navigationUri;
    return validateOpenWorkspacePublication({
        ...publication,
        workspace: {
            ...workspace,
            navigationUri,
            roots,
        },
    });
}
