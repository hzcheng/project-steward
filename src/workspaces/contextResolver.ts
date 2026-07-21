'use strict';

import {
    createWorkspaceScopeIdentity,
    createWorkspaceUriIdentity,
    WorkspaceUriIdentitySource,
} from './identity';
import {
    OpenWorkspace,
    OpenWorkspaceEnvironment,
    OpenWorkspaceKind,
    WorkspaceRoot,
} from './types';

export interface WorkspaceUri extends WorkspaceUriIdentitySource {
    fsPath: string;
    toString(): string;
}

export interface WorkspaceFolder {
    name: string;
    uri: WorkspaceUri;
}

export interface WorkspaceContext {
    workspaceFile?: WorkspaceUri | null;
    workspaceFolders?: readonly WorkspaceFolder[] | null;
    workspaceName?: string;
    remoteName?: string;
}

function resolveEnvironment(remoteName: string | undefined): OpenWorkspaceEnvironment {
    switch (remoteName) {
        case undefined:
        case null:
        case '':
            return 'local';
        case 'ssh-remote':
            return 'ssh';
        case 'wsl':
            return 'wsl';
        case 'dev-container':
        case 'attached-container':
            return 'devContainer';
        default:
            return 'remote';
    }
}

function resolveKind(workspaceFile: WorkspaceUri | null | undefined): OpenWorkspaceKind {
    if (!workspaceFile) {
        return 'singleFolder';
    }
    return workspaceFile.scheme.toLowerCase() === 'untitled'
        ? 'untitledMultiRoot'
        : 'savedMultiRoot';
}

function getWorkspaceFileBasename(workspaceFile: WorkspaceUri | null | undefined): string {
    const uriPath = workspaceFile?.path?.replace(/\/+$/g, '') || '';
    return uriPath.substring(uriPath.lastIndexOf('/') + 1);
}

export function removeWorkspaceWindowDecorations(name: string | undefined): string {
    return (name || '')
        .replace(/\s+\[(?:Dev Container|SSH|WSL)(?::[^\]]*)?\]\s*$/i, '')
        .replace(/\s+\(Workspace\)\s*$/i, '');
}

function getWorkspaceDisplayName(
    kind: OpenWorkspaceKind,
    context: WorkspaceContext,
    workspaceFolders: readonly WorkspaceFolder[],
): string {
    if (kind === 'singleFolder') {
        return workspaceFolders[0]?.name || context.workspaceName || 'Workspace';
    }
    if (kind === 'savedMultiRoot') {
        const workspaceName = removeWorkspaceWindowDecorations(context.workspaceName);
        const workspaceFileName = getWorkspaceFileBasename(context.workspaceFile)
            .replace(/\.code-workspace$/i, '');
        return workspaceName || workspaceFileName || workspaceFolders[0]?.name || 'Workspace';
    }
    const untitledName = removeWorkspaceWindowDecorations(
        context.workspaceName || getWorkspaceFileBasename(context.workspaceFile)
    );
    return /^Untitled(?:-\d+)?$/i.test(untitledName)
        ? 'Untitled'
        : untitledName || workspaceFolders[0]?.name || 'Untitled';
}

export class WorkspaceContextResolver {
    resolve(context: WorkspaceContext): OpenWorkspace | null {
        const workspaceFolders = context.workspaceFolders || [];
        if (workspaceFolders.length === 0) {
            return null;
        }

        const kind = resolveKind(context.workspaceFile);
        const navigationUri = kind === 'singleFolder'
            ? workspaceFolders[0].uri
            : context.workspaceFile;
        const roots: WorkspaceRoot[] = workspaceFolders.map((folder, ordinal) => ({
            id: createWorkspaceUriIdentity(folder.uri),
            name: folder.name,
            uri: folder.uri.toString(),
            hostPath: folder.uri.fsPath,
            ordinal,
        }));

        return {
            navigationIdentity: createWorkspaceUriIdentity(navigationUri),
            scopeIdentity: createWorkspaceScopeIdentity(workspaceFolders.map(folder => folder.uri)),
            kind,
            displayName: getWorkspaceDisplayName(kind, context, workspaceFolders),
            navigationUri: navigationUri.toString(),
            environment: resolveEnvironment(context.remoteName),
            roots,
        };
    }
}
