export const STORE_PROTOCOL_VERSION = 1;
export const LEASE_MS = 90_000;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_WORKSPACE_IDENTITY_LENGTH = 8192;
export const MAX_PAYLOAD_LENGTH = 200 * 1024;

const ID_PATTERN = /^[a-f0-9]{32}$/;

export interface ProbeSnapshot {
    protocolVersion: 1;
    instanceId: string;
    workspaceProcessId: string;
    workspaceIdentity: string;
    sequence: number;
    sentAtMs: number;
    writtenAtMs: number;
    payload: string;
}

export interface StoreCounters {
    activeInstances: number;
    parseErrors: number;
    oversizedFiles: number;
    symlinkFiles: number;
    readErrors: number;
    rollbackCount: number;
    disappearedInstances: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireId(value: unknown, label: string): string {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
        throw new Error(`${label} must be 32 lowercase hexadecimal characters`);
    }
    return value;
}

function requireFiniteNonNegative(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a finite non-negative number`);
    }
    return value;
}

export function validateSnapshot(value: unknown): ProbeSnapshot {
    if (!isRecord(value)) {
        throw new Error('snapshot must be an object');
    }
    const expectedKeys = [
        'instanceId',
        'payload',
        'protocolVersion',
        'sentAtMs',
        'sequence',
        'workspaceIdentity',
        'workspaceProcessId',
        'writtenAtMs',
    ];
    if (Object.keys(value).sort().join('\n') !== expectedKeys.join('\n')) {
        throw new Error('snapshot has unexpected fields');
    }
    if (value.protocolVersion !== STORE_PROTOCOL_VERSION) {
        throw new Error(`protocolVersion must equal ${STORE_PROTOCOL_VERSION}`);
    }
    const instanceId = requireId(value.instanceId, 'instanceId');
    const workspaceProcessId = requireId(value.workspaceProcessId, 'workspaceProcessId');
    if (typeof value.workspaceIdentity !== 'string'
        || value.workspaceIdentity.length === 0
        || value.workspaceIdentity.length > MAX_WORKSPACE_IDENTITY_LENGTH) {
        throw new Error(`workspaceIdentity must contain 1-${MAX_WORKSPACE_IDENTITY_LENGTH} characters`);
    }
    if (typeof value.sequence !== 'number'
        || !Number.isSafeInteger(value.sequence)
        || value.sequence < 0) {
        throw new Error('sequence must be a non-negative safe integer');
    }
    const sentAtMs = requireFiniteNonNegative(value.sentAtMs, 'sentAtMs');
    const writtenAtMs = requireFiniteNonNegative(value.writtenAtMs, 'writtenAtMs');
    if (typeof value.payload !== 'string' || value.payload.length === 0 || value.payload.length > MAX_PAYLOAD_LENGTH) {
        throw new Error(`payload must contain 1-${MAX_PAYLOAD_LENGTH} characters`);
    }
    return {
        protocolVersion: STORE_PROTOCOL_VERSION,
        instanceId,
        workspaceProcessId,
        workspaceIdentity: value.workspaceIdentity,
        sequence: value.sequence,
        sentAtMs,
        writtenAtMs,
        payload: value.payload,
    };
}

export function parseSnapshotText(text: string): ProbeSnapshot {
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
        throw new Error(`snapshot exceeds ${MAX_FILE_BYTES} bytes`);
    }
    return validateSnapshot(JSON.parse(text));
}

export function createSnapshotFileName(instanceId: string): string {
    return `${requireId(instanceId, 'instanceId')}.json`;
}
