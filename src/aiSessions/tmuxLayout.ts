'use strict';

import { createHash } from 'crypto';
import type { AiSessionProviderId } from '../models';
import type {
    AiSessionManagedTmuxMetadata,
    AiSessionManagedTmuxMetadataBase,
    AiSessionRuntimeIdentity,
    AiSessionTmuxLayout,
    AiSessionTmuxLocator,
} from './runtimeTypes';
import {
    getAiSessionRuntimeRootSnapshotKey,
    isValidAiSessionRuntimeIdentity,
} from './runtimeTypes';

const METADATA_VERSION = 2;
const MAX_ID_LENGTH = 512;
const MAX_MARKER_LENGTH = 4096;
const MAX_CREATED_AT_LENGTH = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const TMUX_METADATA_OPTIONS = {
    managed: '@project-steward-managed',
    version: '@project-steward-version',
    layout: '@project-steward-layout',
    workspaceScopeIdentity: '@project-steward-workspace-scope-identity',
    workspaceNavigationIdentity: '@project-steward-workspace-navigation-identity',
    workspaceRootHostPaths: '@project-steward-workspace-root-host-paths',
    cwd: '@project-steward-cwd',
    provider: '@project-steward-provider',
    sessionId: '@project-steward-session-id',
    pendingId: '@project-steward-pending-id',
    createdAt: '@project-steward-created-at',
    marker: '@project-steward-marker',
} as const;

export class ProjectTmuxLayout {
    getLocator(identity: AiSessionRuntimeIdentity): AiSessionTmuxLocator {
        validateIdentityBase(identity);
        const sessionId = requireIdentityId(identity.sessionId, 'sessionId');
        return {
            layout: 'project',
            sessionName: getProjectSessionName(identity.workspaceScopeIdentity),
            windowName: `ai-${identity.provider}-${hashIdentityId(identity, sessionId)}`,
        };
    }

    getPendingLocator(identity: AiSessionRuntimeIdentity): AiSessionTmuxLocator {
        validateIdentityBase(identity);
        const pendingId = requireIdentityId(identity.pendingId, 'pendingId');
        return {
            layout: 'project',
            sessionName: getProjectSessionName(identity.workspaceScopeIdentity),
            windowName: `pending-${identity.provider}-${hashIdentityId(identity, pendingId)}`,
        };
    }
}

export class SessionTmuxLayout {
    getLocator(identity: AiSessionRuntimeIdentity): AiSessionTmuxLocator {
        validateIdentityBase(identity);
        const sessionId = requireIdentityId(identity.sessionId, 'sessionId');
        return {
            layout: 'session',
            sessionName: `project-steward-s-${identity.provider}-${hashIdentityId(identity, sessionId)}`,
        };
    }

    getPendingLocator(identity: AiSessionRuntimeIdentity): AiSessionTmuxLocator {
        validateIdentityBase(identity);
        const pendingId = requireIdentityId(identity.pendingId, 'pendingId');
        return {
            layout: 'session',
            sessionName: `project-steward-pending-${identity.provider}-${hashIdentityId(identity, pendingId)}`,
        };
    }
}

export function getTmuxRuntimeKey(identity: AiSessionRuntimeIdentity): string {
    validateIdentityBase(identity);
    const hasSessionId = identity.sessionId !== undefined;
    const hasPendingId = identity.pendingId !== undefined;
    if (hasSessionId === hasPendingId) {
        throw new Error('A tmux runtime identity must have exactly one sessionId or pendingId.');
    }
    const kind = hasSessionId ? 'session' : 'pending';
    const id = requireIdentityId(hasSessionId ? identity.sessionId : identity.pendingId, `${kind}Id`);
    return JSON.stringify([
        METADATA_VERSION,
        identity.provider,
        identity.workspaceScopeIdentity,
        identity.workspaceNavigationIdentity,
        JSON.parse(getAiSessionRuntimeRootSnapshotKey(identity)),
        identity.cwd,
        kind,
        id,
    ]);
}

export function parseManagedTmuxMetadata(values: unknown): AiSessionManagedTmuxMetadata | null {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        return null;
    }
    const record = values as Record<string, unknown>;
    const hasSessionId = record.sessionId !== undefined;
    const hasPendingId = record.pendingId !== undefined;
    if (hasSessionId === hasPendingId || !hasExactKeys(record, [
        'managed', 'version', 'layout', 'workspaceScopeIdentity',
        'workspaceNavigationIdentity', 'workspaceRootHostPaths', 'cwd',
        'provider', hasSessionId ? 'sessionId' : 'pendingId',
    ], ['createdAt', 'marker'])) {
        return null;
    }
    if (record.managed !== '1' || record.version !== String(METADATA_VERSION)
        || !isTmuxLayout(record.layout) || !isAiSessionProviderIdValue(record.provider)
        || !isBoundedString(record.workspaceScopeIdentity, MAX_ID_LENGTH)
        || !isBoundedString(record.workspaceNavigationIdentity, MAX_MARKER_LENGTH)
        || !isBoundedString(record.cwd, MAX_MARKER_LENGTH)) {
        return null;
    }
    const workspaceRootHostPaths = parseWorkspaceRootHostPaths(record.workspaceRootHostPaths);
    if (!workspaceRootHostPaths) {
        return null;
    }

    const createdAt = record.createdAt;
    if (createdAt !== undefined
        && (!isBoundedString(createdAt, MAX_CREATED_AT_LENGTH)
            || !Number.isFinite(Date.parse(createdAt)))) {
        return null;
    }
    const marker = record.marker;
    if (marker !== undefined && !isBoundedString(marker, MAX_MARKER_LENGTH)) {
        return null;
    }

    const base: AiSessionManagedTmuxMetadataBase = {
        version: METADATA_VERSION,
        layout: record.layout,
        workspaceScopeIdentity: record.workspaceScopeIdentity,
        workspaceNavigationIdentity: record.workspaceNavigationIdentity,
        workspaceRootHostPaths,
        cwd: record.cwd,
        provider: record.provider,
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(marker !== undefined ? { marker } : {}),
    };
    if (hasSessionId) {
        if (!isBoundedString(record.sessionId, MAX_ID_LENGTH)) {
            return null;
        }
        const result = { ...base, sessionId: record.sessionId };
        return isValidAiSessionRuntimeIdentity(result) ? result : null;
    }
    if (!isBoundedString(record.pendingId, MAX_ID_LENGTH)) {
        return null;
    }
    const result = { ...base, pendingId: record.pendingId };
    return isValidAiSessionRuntimeIdentity(result) ? result : null;
}

function hasExactKeys(
    record: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = []
): boolean {
    const keys = Object.keys(record);
    const allowed = new Set([...required, ...optional]);
    return required.every(key => Object.prototype.hasOwnProperty.call(record, key))
        && keys.every(key => allowed.has(key));
}

function getProjectSessionName(workspaceScopeIdentity: string): string {
    return `project-steward-p-${hash(workspaceScopeIdentity)}`;
}

function hashIdentityId(identity: AiSessionRuntimeIdentity, id: string): string {
    return hash(`${identity.workspaceScopeIdentity}:${identity.provider}:${id}`);
}

function hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function validateIdentityBase(identity: AiSessionRuntimeIdentity): void {
    if (!identity || !isAiSessionProviderIdValue(identity.provider)) {
        throw new Error('Unknown AI session provider.');
    }
    if (!isValidAiSessionRuntimeIdentity(identity)) {
        throw new Error('The tmux runtime workspace identity is invalid.');
    }
}

function parseWorkspaceRootHostPaths(value: unknown): string[] | null {
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch (_error) {
            return null;
        }
    }
    if (!Array.isArray(parsed)) {
        return null;
    }
    const identity = {
        provider: 'codex' as const,
        workspaceScopeIdentity: 'validation',
        workspaceNavigationIdentity: 'validation',
        workspaceRootHostPaths: parsed,
        cwd: '',
        sessionId: 'validation',
    };
    for (const candidate of parsed) {
        identity.cwd = typeof candidate === 'string' ? candidate : '';
        if (isValidAiSessionRuntimeIdentity(identity)) {
            return [...parsed] as string[];
        }
    }
    return null;
}

function requireIdentityId(value: unknown, name: string): string {
    if (!isBoundedString(value, MAX_ID_LENGTH)) {
        throw new Error(`${name} must be a non-empty bounded string without control characters.`);
    }
    return value;
}

function isAiSessionProviderIdValue(value: unknown): value is AiSessionProviderId {
    return value === 'codex' || value === 'kimi' || value === 'claude';
}

function isTmuxLayout(value: unknown): value is AiSessionTmuxLayout {
    return value === 'project' || value === 'session';
}

function isBoundedString(value: unknown, maxLength: number): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength
        && !CONTROL_CHARACTERS.test(value);
}
