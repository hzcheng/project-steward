'use strict';

import * as path from 'path';
import type { WorkspaceRoot } from './types';

interface NormalizedHostPath {
    comparable: string;
    windows: boolean;
}

function isWindowsPath(value: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

export function normalizeWorkspaceHostPath(value: string): string {
    value = typeof value === 'string' ? value : '';
    if (!value.trim()) {
        return '';
    }

    const pathApi = isWindowsPath(value) ? path.win32 : path.posix;
    const normalized = pathApi.normalize(value);
    const root = pathApi.parse(normalized).root;
    return normalized.length > root.length
        ? normalized.replace(/[\\/]+$/g, '')
        : normalized;
}

function normalizeComparableHostPath(value: string): NormalizedHostPath | null {
    const normalized = normalizeWorkspaceHostPath(value);
    if (!normalized) {
        return null;
    }

    const windows = isWindowsPath(normalized);
    return {
        comparable: windows ? normalized.toLowerCase() : normalized,
        windows,
    };
}

export function getWorkspaceHostPathComparisonKey(value: string): string {
    const normalizedPath = normalizeComparableHostPath(value);
    if (!normalizedPath) {
        return '';
    }

    return `${normalizedPath.windows ? 'windows' : 'posix'}:${normalizedPath.comparable}`;
}

function containsPath(rootPath: NormalizedHostPath, candidatePath: NormalizedHostPath): boolean {
    if (rootPath.windows !== candidatePath.windows) {
        return false;
    }

    const pathApi = rootPath.windows ? path.win32 : path.posix;
    const relativePath = pathApi.relative(rootPath.comparable, candidatePath.comparable);
    return relativePath === '' || (
        relativePath !== '..'
        && !relativePath.startsWith(`..${pathApi.sep}`)
        && !pathApi.isAbsolute(relativePath)
    );
}

export function isWorkspaceHostPathContained(rootPath: string, candidatePath: string): boolean {
    const normalizedRoot = normalizeComparableHostPath(rootPath);
    const normalizedCandidate = normalizeComparableHostPath(candidatePath);
    return !!normalizedRoot && !!normalizedCandidate && containsPath(normalizedRoot, normalizedCandidate);
}

export function assignPathToWorkspaceRoot(
    candidatePath: string,
    roots: readonly WorkspaceRoot[],
): WorkspaceRoot | null {
    const normalizedCandidate = normalizeComparableHostPath(candidatePath);
    if (!normalizedCandidate) {
        return null;
    }

    const matches = (roots || [])
        .map((root, index) => ({
            root,
            index,
            normalizedPath: normalizeComparableHostPath(root?.hostPath),
        }))
        .filter(candidate => candidate.normalizedPath && containsPath(candidate.normalizedPath, normalizedCandidate))
        .sort((left, right) => {
            const lengthDifference = right.normalizedPath.comparable.length - left.normalizedPath.comparable.length;
            if (lengthDifference !== 0) {
                return lengthDifference;
            }

            const ordinalDifference = left.root.ordinal - right.root.ordinal;
            return ordinalDifference || left.index - right.index;
        });

    return matches[0]?.root || null;
}
