import {
    OpenWorkspacePublication,
    validateOpenWorkspacePublication,
} from '../../../src/openWorkspaces/protocol';
import { URL } from 'url';

function requireMatchingResourcePath(
    publishedUri: string,
    authoritativeUri: string,
    label: 'root' | 'workspace',
): void {
    let publishedPath: string;
    let authoritativePath: string;
    try {
        publishedPath = new URL(publishedUri).pathname;
        authoritativePath = new URL(authoritativeUri).pathname;
    } catch (error) {
        throw new Error(`${label} resource URI must be valid`);
    }
    if (publishedPath !== authoritativePath) {
        throw new Error(`${label} resource path must match before authority rewrite`);
    }
}

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
    workspace.roots.forEach((root, index) => {
        requireMatchingResourcePath(root.uri, rootUris[index], 'root');
    });
    if (workspace.kind === 'savedMultiRoot') {
        if (!workspaceUri) {
            throw new Error('authoritative saved workspace URI is required');
        }
        requireMatchingResourcePath(workspace.navigationUri, workspaceUri, 'workspace');
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
