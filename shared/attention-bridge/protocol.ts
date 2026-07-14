export const PROTOCOL_VERSION = 1;
export const PROCESS_ID_PATTERN = /^[a-f0-9]{32}$/;
export const MAX_WORKSPACE_IDENTITY_LENGTH = 8192;

export interface RoutingChallenge {
    protocolVersion: number;
    workspaceProcessId: string;
    workspaceIdentity: string;
    nonce: string;
}

export interface RoutingResponse extends RoutingChallenge {
    bridgeProcessId: string;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireProcessId(value: unknown, label: string): string {
    if (typeof value !== 'string' || !PROCESS_ID_PATTERN.test(value)) {
        throw new Error(`${label} must be 32 lowercase hexadecimal characters`);
    }
    return value;
}

function requireBoundedString(value: unknown, label: string, maximum: number): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
        throw new Error(`${label} must contain 1-${maximum} characters`);
    }
    return value;
}

export function parseRoutingChallenge(value: unknown): RoutingChallenge {
    const record = requireObject(value, 'routing challenge');
    if (record.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`protocolVersion must equal ${PROTOCOL_VERSION}`);
    }
    return {
        protocolVersion: PROTOCOL_VERSION,
        workspaceProcessId: requireProcessId(record.workspaceProcessId, 'workspaceProcessId'),
        workspaceIdentity: requireBoundedString(record.workspaceIdentity, 'workspaceIdentity', MAX_WORKSPACE_IDENTITY_LENGTH),
        nonce: requireProcessId(record.nonce, 'nonce'),
    };
}

export function parseRoutingResponse(value: unknown): RoutingResponse {
    const challenge = parseRoutingChallenge(value);
    const record = requireObject(value, 'routing response');
    return {
        ...challenge,
        bridgeProcessId: requireProcessId(record.bridgeProcessId, 'bridgeProcessId'),
    };
}

export function assertMatchingRoutingResponse(request: RoutingChallenge, response: RoutingResponse): void {
    if (response.workspaceProcessId !== request.workspaceProcessId) {
        throw new Error('workspaceProcessId mismatch');
    }
    if (response.workspaceIdentity !== request.workspaceIdentity) {
        throw new Error('workspaceIdentity mismatch');
    }
    if (response.nonce !== request.nonce) {
        throw new Error('nonce mismatch');
    }
}

export function assertStableBridgeProcessId(seen: Set<string>, next: string): void {
    if (seen.size > 0 && !seen.has(next)) {
        throw new Error(`unstable bridge process mapping: ${Array.from(seen).join(',')} -> ${next}`);
    }
}
