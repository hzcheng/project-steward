'use strict';

export const PENDING_WORKSPACE_SAVE_STATE_KEY = 'projectSteward.pendingWorkspaceSave.v1';
export const PENDING_WORKSPACE_SAVE_TTL_MS = 10 * 60 * 1000;

const MAX_SCOPE_IDENTITY_LENGTH = 512;

interface MementoLike {
    get<T>(key: string): T;
    update(key: string, value: unknown): Thenable<void>;
}

export interface PendingWorkspaceSaveIntentV1 {
    version: 1;
    scopeIdentity: string;
    createdAtMs: number;
    expiresAtMs: number;
}

function isSafeTimestamp(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parsePendingWorkspaceSaveIntent(value: unknown): PendingWorkspaceSaveIntentV1 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const intent = value as Record<string, unknown>;
    if (Object.keys(intent).sort().join(',') !== 'createdAtMs,expiresAtMs,scopeIdentity,version'
        || intent.version !== 1
        || typeof intent.scopeIdentity !== 'string'
        || intent.scopeIdentity.length === 0
        || intent.scopeIdentity.length > MAX_SCOPE_IDENTITY_LENGTH
        || !isSafeTimestamp(intent.createdAtMs)
        || !isSafeTimestamp(intent.expiresAtMs)
        || intent.expiresAtMs <= intent.createdAtMs
        || intent.expiresAtMs - intent.createdAtMs > PENDING_WORKSPACE_SAVE_TTL_MS) {
        return null;
    }

    return {
        version: 1,
        scopeIdentity: intent.scopeIdentity,
        createdAtMs: intent.createdAtMs,
        expiresAtMs: intent.expiresAtMs,
    };
}

export class PendingWorkspaceSaveStore {
    static readonly storageKey = PENDING_WORKSPACE_SAVE_STATE_KEY;

    constructor(private readonly state: MementoLike) { }

    read(): PendingWorkspaceSaveIntentV1 | null {
        return parsePendingWorkspaceSaveIntent(
            this.state.get<unknown>(PENDING_WORKSPACE_SAVE_STATE_KEY)
        );
    }

    isValidAt(intent: PendingWorkspaceSaveIntentV1, nowMs: number): boolean {
        return isSafeTimestamp(nowMs)
            && intent.createdAtMs <= nowMs
            && nowMs < intent.expiresAtMs;
    }

    async write(scopeIdentity: string, createdAtMs: number, expiresAtMs: number): Promise<void> {
        const intent = parsePendingWorkspaceSaveIntent({
            version: 1,
            scopeIdentity,
            createdAtMs,
            expiresAtMs,
        });
        if (!intent) {
            throw new Error('Invalid pending workspace save intent.');
        }
        await this.state.update(PENDING_WORKSPACE_SAVE_STATE_KEY, intent);
    }

    clear(): Promise<void> {
        return Promise.resolve(this.state.update(PENDING_WORKSPACE_SAVE_STATE_KEY, undefined));
    }
}
