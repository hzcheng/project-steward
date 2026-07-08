'use strict';

import * as path from 'path';

export function normalizeRemoteAuthority(remoteAuthority: string): string {
    if (!remoteAuthority) {
        return remoteAuthority;
    }

    try {
        return decodeURIComponent(remoteAuthority);
    } catch (e) {
        return remoteAuthority;
    }
}

export function normalizePosixPath(value: string): string {
    return path.posix.normalize(value).replace(/\/+$/g, '') || '/';
}

export function isPathInside(childPath: string, parentPath: string): boolean {
    return childPath !== parentPath && childPath.startsWith(`${parentPath}/`);
}

export function getPathMatchScore(currentPath: string, recentPath: string, isWorkspaceEntry: boolean): number {
    if (!currentPath || !recentPath) {
        return 0;
    }

    let normalizedCurrentPath = normalizePosixPath(currentPath);
    let normalizedRecentPath = normalizePosixPath(recentPath);

    if (normalizedCurrentPath === normalizedRecentPath) {
        return isWorkspaceEntry ? 100 : 60;
    }

    if (isWorkspaceEntry && isPathInside(normalizedCurrentPath, normalizedRecentPath)) {
        return 80;
    }

    if (isWorkspaceEntry && isPathInside(normalizedRecentPath, normalizedCurrentPath)) {
        return 70;
    }

    if (!isWorkspaceEntry && isPathInside(normalizedRecentPath, normalizedCurrentPath)) {
        return 40;
    }

    if (path.posix.basename(normalizedCurrentPath) === path.posix.basename(normalizedRecentPath)) {
        return isWorkspaceEntry ? 30 : 10;
    }

    return 0;
}

export function ensureLeadingSlash(value: string): string {
    if (!value) {
        return "/";
    }

    return value.startsWith("/") ? value : `/${value}`;
}

export function encodeRemoteAuthority(remoteAuthority: string): string {
    return normalizeRemoteAuthority(remoteAuthority).split('@').map(part => encodeURIComponent(part)).join('@');
}
