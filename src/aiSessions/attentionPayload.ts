'use strict';

export const ATTENTION_PAYLOAD_VERSION = 1;

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
    if (!Array.isArray(payload.items)) throw new Error('attention payload items must be an array');
    const items = payload.items.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('attention item must be an object');
        const record = item as Record<string, unknown>;
        if (typeof record.projectId !== 'string' || !record.projectId || typeof record.sessionKey !== 'string' || !record.sessionKey) {
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
