export const FOCUS_SPIKE_TTL_MS = 10_000;
const ID_PATTERN = /^[a-f0-9]{32}$/;

export interface FocusSpikeRequest {
    protocolVersion: 1;
    requestId: string;
    sourceInstanceId: string;
    targetInstanceId: string;
    createdAtMs: number;
}

export function parseFocusSpikeRequest(value: unknown, nowMs: number): FocusSpikeRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('focus request must be an object');
    const record = value as Record<string, unknown>;
    if (record.protocolVersion !== 1) throw new Error('protocolVersion must equal 1');
    for (const field of ['requestId', 'sourceInstanceId', 'targetInstanceId']) {
        if (typeof record[field] !== 'string' || !ID_PATTERN.test(record[field] as string)) throw new Error(`${field} is invalid`);
    }
    if (typeof record.createdAtMs !== 'number' || !Number.isFinite(record.createdAtMs)
        || nowMs < record.createdAtMs || nowMs - record.createdAtMs >= FOCUS_SPIKE_TTL_MS) throw new Error('focus request expired');
    return record as unknown as FocusSpikeRequest;
}

export function parseFocusSpikeRequestForRelay(value: unknown, nowMs: number): FocusSpikeRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('focus request must be an object');
    }
    return parseFocusSpikeRequest({
        ...(value as Record<string, unknown>),
        createdAtMs: nowMs,
    }, nowMs);
}

export function tryParseFocusSpikeJson(source: string): unknown | null {
    try {
        return JSON.parse(source) as unknown;
    } catch (error) {
        if (error instanceof SyntaxError) {
            return null;
        }
        throw error;
    }
}

export function shouldHandleFocusSpikeRequest(request: FocusSpikeRequest, localInstanceId: string, nowMs: number): boolean {
    return request.targetInstanceId === localInstanceId && nowMs - request.createdAtMs < FOCUS_SPIKE_TTL_MS;
}
