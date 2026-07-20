'use strict';

import * as path from 'path';
import { URL } from 'url';
import type { AiSessionDirectoryScope } from '../aiSessions/types';
import { assignPathToWorkspaceRoot, normalizeWorkspaceHostPath } from './sessionAssignment';
import type { OpenWorkspace, WorkspaceRoot } from './types';

export interface ActiveEditorUri {
    fsPath: string;
}

export interface PrimaryWorkspaceRootSelectionOptions {
    explicitRootId?: string;
    activeEditorUri?: ActiveEditorUri | string | null;
    lastUsedRootId?: string;
}

export interface AiSessionDirectoryScopeOptions extends PrimaryWorkspaceRootSelectionOptions {
    isDirectory: (hostPath: string) => boolean;
}

export interface InvalidWorkspaceRoot {
    id: string;
    name: string;
}

export class WorkspaceDirectoryScopeError extends Error {
    readonly invalidRoots: InvalidWorkspaceRoot[];

    constructor(invalidRoots: readonly InvalidWorkspaceRoot[]) {
        const copiedRoots = invalidRoots.map(root => Object.freeze({ id: root.id, name: root.name }));
        super(`Workspace roots are unavailable: ${copiedRoots.map(root => `${root.name} (${root.id})`).join(', ')}`);
        this.name = 'WorkspaceDirectoryScopeError';
        this.invalidRoots = Object.freeze(copiedRoots.slice()) as InvalidWorkspaceRoot[];
        Object.setPrototypeOf(this, WorkspaceDirectoryScopeError.prototype);
    }
}

function getActiveEditorHostPath(uri: ActiveEditorUri | string | null | undefined): string {
    if (!uri) {
        return '';
    }
    if (typeof uri !== 'string') {
        return uri.fsPath || '';
    }
    if (!uri.includes('://')) {
        return uri;
    }

    try {
        let uriPath = decodeURIComponent(new URL(uri).pathname);
        if (/^\/[a-zA-Z]:\//.test(uriPath)) {
            uriPath = uriPath.substring(1);
        }
        return uriPath;
    } catch (error) {
        return '';
    }
}

function getFirstWorkspaceRoot(roots: readonly WorkspaceRoot[]): WorkspaceRoot | null {
    return (roots || [])
        .map((root, index) => ({ root, index }))
        .sort((left, right) => (left.root.ordinal - right.root.ordinal) || (left.index - right.index))[0]?.root
        || null;
}

export function selectPrimaryWorkspaceRoot(
    workspace: OpenWorkspace,
    options: PrimaryWorkspaceRootSelectionOptions = {},
): WorkspaceRoot | null {
    const roots = (workspace?.roots || []).slice();
    const explicitRoot = roots.find(root => root.id === options.explicitRootId);
    if (explicitRoot) {
        return explicitRoot;
    }

    const activeEditorRoot = assignPathToWorkspaceRoot(getActiveEditorHostPath(options.activeEditorUri), roots);
    if (activeEditorRoot) {
        return activeEditorRoot;
    }

    const lastUsedRoot = roots.find(root => root.id === options.lastUsedRootId);
    return lastUsedRoot || getFirstWorkspaceRoot(roots);
}

function isAbsoluteHostPath(value: string): boolean {
    return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function buildAiSessionDirectoryScope(
    workspace: OpenWorkspace,
    options: AiSessionDirectoryScopeOptions,
): AiSessionDirectoryScope {
    const roots = (workspace?.roots || []).slice();
    const normalizedRoots = roots.map(root => ({
        root,
        hostPath: normalizeWorkspaceHostPath(root.hostPath),
    }));
    const invalidRoots = normalizedRoots
        .filter(candidate => {
            if (!candidate.hostPath || !isAbsoluteHostPath(candidate.hostPath)) {
                return true;
            }
            try {
                return !options?.isDirectory(candidate.hostPath);
            } catch (error) {
                return true;
            }
        })
        .map(candidate => ({ id: candidate.root.id, name: candidate.root.name }));

    if (invalidRoots.length) {
        throw new WorkspaceDirectoryScopeError(invalidRoots);
    }

    const primaryRoot = selectPrimaryWorkspaceRoot(workspace, options);
    if (!primaryRoot) {
        throw new WorkspaceDirectoryScopeError([]);
    }

    const primaryCwd = normalizedRoots.find(candidate => candidate.root.id === primaryRoot.id)?.hostPath || '';
    const seenPaths = new Set<string>();
    const workspaceRootHostPaths = normalizedRoots.reduce((result, candidate) => {
        const comparablePath = /^[a-zA-Z]:[\\/]/.test(candidate.hostPath)
            ? candidate.hostPath.toLowerCase()
            : candidate.hostPath;
        if (!seenPaths.has(comparablePath)) {
            seenPaths.add(comparablePath);
            result.push(candidate.hostPath);
        }
        return result;
    }, [] as string[]);
    const additionalDirectories = workspaceRootHostPaths.filter(hostPath => {
        if (/^[a-zA-Z]:[\\/]/.test(hostPath) && /^[a-zA-Z]:[\\/]/.test(primaryCwd)) {
            return hostPath.toLowerCase() !== primaryCwd.toLowerCase();
        }
        return hostPath !== primaryCwd;
    });

    return Object.freeze({
        workspaceNavigationIdentity: workspace.navigationIdentity,
        workspaceScopeIdentity: workspace.scopeIdentity,
        workspaceRootHostPaths: Object.freeze(workspaceRootHostPaths.slice()) as string[],
        primaryRootId: primaryRoot.id,
        primaryCwd,
        additionalDirectories: Object.freeze(additionalDirectories.slice()) as string[],
    });
}
