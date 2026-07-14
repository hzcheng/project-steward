'use strict';

export const ATTENTION_PAYLOAD_VERSION = 1;
export const MAX_ATTENTION_ITEMS = 1000;
export const MAX_ATTENTION_ID_LENGTH = 512;

export interface AttentionPayloadItem {
    projectId: string;
    sessionKey: string;
    state: 'needsAttention' | 'acknowledged';
    eventId?: string;
    reason?: 'quiet' | 'completed';
    observedAtMs: number;
}

export interface AttentionPayload {
    version: 1;
    generatedAtMs: number;
    items: AttentionPayloadItem[];
}

export interface AttentionOwnerSnapshot extends AttentionPayload {
    instanceId: string;
    sequence: number;
    leaseUpdatedAtMs: number;
}

export function createAttentionPayload(items: AttentionPayloadItem[], generatedAtMs = Date.now()): AttentionPayload {
    return {
        version: ATTENTION_PAYLOAD_VERSION,
        generatedAtMs,
        items: (items || []).map(item => ({ ...item })).sort((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
    };
}

export function serializeAttentionPayload(payload: AttentionPayload): string {
    return JSON.stringify(validateAttentionPayload(payload));
}

export function parseAttentionPayload(value: string): AttentionPayload {
    return validateAttentionPayload(JSON.parse(value));
}

export function validateAttentionPayload(value: unknown): AttentionPayload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('attention payload must be an object');
    const payload = value as Record<string, unknown>;
    if (payload.version !== ATTENTION_PAYLOAD_VERSION || typeof payload.generatedAtMs !== 'number' || !Number.isFinite(payload.generatedAtMs)) {
        throw new Error('invalid attention payload header');
    }
    if (!Array.isArray(payload.items) || payload.items.length > MAX_ATTENTION_ITEMS) throw new Error('attention payload items must be a bounded array');
    const items = payload.items.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('attention item must be an object');
        const record = item as Record<string, unknown>;
        if (typeof record.projectId !== 'string' || !record.projectId || record.projectId.length > MAX_ATTENTION_ID_LENGTH
            || typeof record.sessionKey !== 'string' || !record.sessionKey || record.sessionKey.length > MAX_ATTENTION_ID_LENGTH) {
            throw new Error('attention item identity is invalid');
        }
        if (record.state !== 'needsAttention' && record.state !== 'acknowledged') throw new Error('attention item state is invalid');
        if (typeof record.observedAtMs !== 'number' || !Number.isFinite(record.observedAtMs)) throw new Error('attention item timestamp is invalid');
        if (record.eventId !== undefined && typeof record.eventId !== 'string') throw new Error('attention item eventId is invalid');
        if (record.reason !== undefined && record.reason !== 'quiet' && record.reason !== 'completed') throw new Error('attention item reason is invalid');
        return {
            projectId: record.projectId,
            sessionKey: record.sessionKey,
            state: record.state,
            eventId: record.eventId,
            reason: record.reason,
            observedAtMs: record.observedAtMs,
        } as AttentionPayloadItem;
    });
    return { version: 1, generatedAtMs: payload.generatedAtMs, items };
}

export function validateAttentionOwnerSnapshot(value: unknown): AttentionOwnerSnapshot {
    const payload = validateAttentionPayload(value);
    const record = value as Record<string, unknown>;
    if (typeof record.instanceId !== 'string' || !/^[a-f0-9]{32}$/.test(record.instanceId)) throw new Error('invalid attention owner instanceId');
    if (typeof record.sequence !== 'number' || !Number.isSafeInteger(record.sequence) || record.sequence < 0) throw new Error('invalid attention owner sequence');
    if (typeof record.leaseUpdatedAtMs !== 'number' || !Number.isFinite(record.leaseUpdatedAtMs) || record.leaseUpdatedAtMs < 0) throw new Error('invalid attention owner lease');
    return { ...payload, instanceId: record.instanceId, sequence: record.sequence, leaseUpdatedAtMs: record.leaseUpdatedAtMs };
}
