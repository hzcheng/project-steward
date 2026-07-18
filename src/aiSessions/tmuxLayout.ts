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

const METADATA_VERSION = 1;
const MAX_ID_LENGTH = 512;
const MAX_MARKER_LENGTH = 4096;
const MAX_CREATED_AT_LENGTH = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const TMUX_METADATA_OPTIONS = {
    managed: '@project-steward-managed',
    version: '@project-steward-version',
    layout: '@project-steward-layout',
    projectKey: '@project-steward-project-key',
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
            sessionName: getProjectSessionName(identity.projectKey),
            windowName: `ai-${identity.provider}-${hashIdentityId(identity.provider, sessionId)}`,
        };
    }

    getPendingLocator(identity: AiSessionRuntimeIdentity): AiSessionTmuxLocator {
        validateIdentityBase(identity);
        const pendingId = requireIdentityId(identity.pendingId, 'pendingId');
        return {
            layout: 'project',
            sessionName: getProjectSessionName(identity.projectKey),
            windowName: `pending-${identity.provider}-${hashIdentityId(identity.provider, pendingId)}`,
        };
    }
}

export class SessionTmuxLayout {
    getLocator(identity: AiSessionRuntimeIdentity): AiSessionTmuxLocator {
        validateIdentityBase(identity);
        const sessionId = requireIdentityId(identity.sessionId, 'sessionId');
        return {
            layout: 'session',
            sessionName: `project-steward-s-${identity.provider}-${hashIdentityId(identity.provider, sessionId)}`,
        };
    }

    getPendingLocator(identity: AiSessionRuntimeIdentity): AiSessionTmuxLocator {
        validateIdentityBase(identity);
        const pendingId = requireIdentityId(identity.pendingId, 'pendingId');
        return {
            layout: 'session',
            sessionName: `project-steward-pending-${identity.provider}-${hashIdentityId(identity.provider, pendingId)}`,
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
    return JSON.stringify([METADATA_VERSION, identity.provider, identity.projectKey, kind, id]);
}

export function parseManagedTmuxMetadata(values: unknown): AiSessionManagedTmuxMetadata | null {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        return null;
    }
    const record = values as Record<string, unknown>;
    if (record.managed !== '1' || record.version !== String(METADATA_VERSION)
        || !isTmuxLayout(record.layout) || !isAiSessionProviderIdValue(record.provider)
        || !isBoundedString(record.projectKey, MAX_ID_LENGTH)) {
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
        projectKey: record.projectKey,
        provider: record.provider,
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(marker !== undefined ? { marker } : {}),
    };
    if (record.sessionId !== undefined) {
        if (record.pendingId !== undefined || !isBoundedString(record.sessionId, MAX_ID_LENGTH)) {
            return null;
        }
        return { ...base, sessionId: record.sessionId };
    }
    if (!isBoundedString(record.pendingId, MAX_ID_LENGTH)) {
        return null;
    }
    return { ...base, pendingId: record.pendingId };
}

function getProjectSessionName(projectKey: string): string {
    return `project-steward-p-${hash(projectKey)}`;
}

function hashIdentityId(provider: string, id: string): string {
    return hash(`${provider}:${id}`);
}

function hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function validateIdentityBase(identity: AiSessionRuntimeIdentity): void {
    if (!identity || !isAiSessionProviderIdValue(identity.provider)) {
        throw new Error('Unknown AI session provider.');
    }
    if (!isBoundedString(identity.projectKey, MAX_ID_LENGTH)) {
        throw new Error('projectKey must be a non-empty bounded string without control characters.');
    }
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
