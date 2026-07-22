'use strict';

import * as crypto from 'crypto';

export interface WorkspaceUriIdentitySource {
    scheme: string;
    authority: string;
    path: string;
}

function normalizeUriComponent(value: string): string {
    return (value || '').normalize('NFC');
}

export function normalizeWorkspaceUri(uri: WorkspaceUriIdentitySource): string {
    return JSON.stringify([
        (uri.scheme || '').toLowerCase(),
        normalizeUriComponent(uri.authority),
        normalizeUriComponent(uri.path),
    ]);
}

function hashIdentity(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createWorkspaceUriIdentity(uri: WorkspaceUriIdentitySource): string {
    return hashIdentity(normalizeWorkspaceUri(uri));
}

export function createWorkspaceScopeIdentity(uris: readonly WorkspaceUriIdentitySource[]): string {
    const normalizedUris = (uris || [])
        .map(normalizeWorkspaceUri)
        .sort();
    return hashIdentity(JSON.stringify(normalizedUris));
}
