'use strict';

export const ATTENTION_PAYLOAD_VERSION = 1;
export const MAX_ATTENTION_ITEMS = 1000;
export const MAX_ATTENTION_ID_LENGTH = 512;
export const MAX_ATTENTION_EVENT_ID_LENGTH = 1024;

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
    if (Object.keys(value).sort().join('\n') !== expected.slice().sort().join('\n')) {
        throw new Error(`${label} has unexpected fields`);
    }
}

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
    heartbeat: number;
}

export interface AttentionBridgeHandshakeRequest {
    protocolVersion: 1;
    mainExtensionVersion: string;
    instanceId: string;
}

export interface AttentionBridgeHandshakeResponse {
    accepted: boolean;
    protocolVersion: 1;
    bridgeExtensionVersion: string;
    capabilities: { snapshots: true; acknowledgements: true; atomicReplace: true };
    errorCode?: 'protocol-mismatch' | 'storage-unavailable';
}

export interface AttentionUnregisterRequest {
    protocolVersion: 1;
    instanceId: string;
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
    assertExactKeys(payload, ['version', 'generatedAtMs', 'items'], 'attention payload');
    if (payload.version !== ATTENTION_PAYLOAD_VERSION || typeof payload.generatedAtMs !== 'number' || !Number.isFinite(payload.generatedAtMs)) {
        throw new Error('invalid attention payload header');
    }
    if (!Array.isArray(payload.items) || payload.items.length > MAX_ATTENTION_ITEMS) throw new Error('attention payload items must be a bounded array');
    const items = payload.items.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('attention item must be an object');
        const record = item as Record<string, unknown>;
        assertExactKeys(record, ['projectId', 'sessionKey', 'state', 'eventId', 'reason', 'observedAtMs'], 'attention item');
        if (typeof record.projectId !== 'string' || !/^[a-f0-9]{64}$/.test(record.projectId)) {
            throw new Error('attention item projectId must be a privacy-safe SHA-256 key');
        }
        if (typeof record.sessionKey !== 'string' || !record.sessionKey || record.sessionKey.length > MAX_ATTENTION_ID_LENGTH) {
            throw new Error('attention item session identity is invalid');
        }
        if (record.state !== 'needsAttention' && record.state !== 'acknowledged') throw new Error('attention item state is invalid');
        if (typeof record.observedAtMs !== 'number' || !Number.isFinite(record.observedAtMs)) throw new Error('attention item timestamp is invalid');
        if (typeof record.eventId !== 'string' || !record.eventId || record.eventId.length > MAX_ATTENTION_EVENT_ID_LENGTH) {
            throw new Error('attention item eventId and reason combination is invalid');
        }
        if (record.reason !== 'quiet' && record.reason !== 'completed') throw new Error('attention item eventId and reason combination is invalid');
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
    const record = value as Record<string, unknown>;
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('attention owner must be an object');
    assertExactKeys(record, ['version', 'generatedAtMs', 'items', 'instanceId', 'sequence', 'heartbeat'], 'attention owner');
    const payload = validateAttentionPayload({ version: record.version, generatedAtMs: record.generatedAtMs, items: record.items });
    if (typeof record.instanceId !== 'string' || !/^[a-f0-9]{32}$/.test(record.instanceId)) throw new Error('invalid attention owner instanceId');
    if (typeof record.sequence !== 'number' || !Number.isSafeInteger(record.sequence) || record.sequence < 0) throw new Error('invalid attention owner sequence');
    if (typeof record.heartbeat !== 'number' || !Number.isSafeInteger(record.heartbeat) || record.heartbeat < 0) throw new Error('invalid attention owner heartbeat');
    return { ...payload, instanceId: record.instanceId, sequence: record.sequence, heartbeat: record.heartbeat };
}

export function validateAttentionBridgeHandshakeRequest(value: unknown): AttentionBridgeHandshakeRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('attention handshake request must be an object');
    const record = value as Record<string, unknown>;
    assertExactKeys(record, ['protocolVersion', 'mainExtensionVersion', 'instanceId'], 'attention handshake request');
    if (record.protocolVersion !== 1) throw new Error('attention handshake protocol is incompatible');
    if (typeof record.mainExtensionVersion !== 'string' || !record.mainExtensionVersion || record.mainExtensionVersion.length > 64) throw new Error('attention handshake main version is invalid');
    if (typeof record.instanceId !== 'string' || !/^[a-f0-9]{32}$/.test(record.instanceId)) throw new Error('attention handshake instanceId is invalid');
    return { protocolVersion: 1, mainExtensionVersion: record.mainExtensionVersion, instanceId: record.instanceId };
}

export function validateAttentionBridgeHandshakeResponse(value: unknown): AttentionBridgeHandshakeResponse {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('attention handshake response must be an object');
    const record = value as Record<string, unknown>;
    const expected = record.errorCode === undefined
        ? ['accepted', 'protocolVersion', 'bridgeExtensionVersion', 'capabilities']
        : ['accepted', 'protocolVersion', 'bridgeExtensionVersion', 'capabilities', 'errorCode'];
    assertExactKeys(record, expected, 'attention handshake response');
    if (record.protocolVersion !== 1) throw new Error('attention handshake protocol is incompatible');
    if (record.accepted !== true) throw new Error(`attention handshake rejected: ${String(record.errorCode || 'unknown')}`);
    if (typeof record.bridgeExtensionVersion !== 'string' || !record.bridgeExtensionVersion || record.bridgeExtensionVersion.length > 64) throw new Error('attention handshake bridge version is invalid');
    const capabilities = record.capabilities as Record<string, unknown>;
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) throw new Error('attention handshake capabilities are invalid');
    assertExactKeys(capabilities, ['snapshots', 'acknowledgements', 'atomicReplace'], 'attention handshake capabilities');
    if (capabilities.snapshots !== true || capabilities.acknowledgements !== true || capabilities.atomicReplace !== true) throw new Error('attention handshake capabilities are incompatible');
    if (record.errorCode !== undefined && record.errorCode !== 'protocol-mismatch' && record.errorCode !== 'storage-unavailable') throw new Error('attention handshake error code is invalid');
    return {
        accepted: true,
        protocolVersion: 1,
        bridgeExtensionVersion: record.bridgeExtensionVersion,
        capabilities: { snapshots: true, acknowledgements: true, atomicReplace: true },
        ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
    };
}

export function validateAttentionUnregisterRequest(value: unknown): AttentionUnregisterRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('attention unregister request must be an object');
    const record = value as Record<string, unknown>;
    assertExactKeys(record, ['protocolVersion', 'instanceId'], 'attention unregister request');
    if (record.protocolVersion !== 1) throw new Error('attention unregister protocol is incompatible');
    if (typeof record.instanceId !== 'string' || !/^[a-f0-9]{32}$/.test(record.instanceId)) throw new Error('attention unregister instanceId is invalid');
    return { protocolVersion: 1, instanceId: record.instanceId };
}
