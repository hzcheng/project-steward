'use strict';

import type { AiSessionProviderId } from '../models';

export const AI_SESSION_TERMINAL_BINDINGS_KEY = 'aiSessionTerminalBindings.v1';
export const AI_SESSION_TERMINAL_INSTANCE_ENV_KEY = 'PROJECT_STEWARD_AI_TERMINAL_INSTANCE_ID';

const MAX_BINDINGS = 512;
const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_TITLE_LENGTH = 200;
const MAX_EXCLUDED_SESSION_IDS = 1000;

export interface AiSessionTerminalBindingState {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

interface AiSessionTerminalBindingBase {
    version: 1;
    providerId: AiSessionProviderId;
    markerPath: string;
    updatedAtMs: number;
}

export interface PendingAiSessionTerminalBinding extends AiSessionTerminalBindingBase {
    state: 'pending';
    cwd: string;
    createdAt: string;
    excludedSessionIds: string[];
    title?: string;
}

export interface BoundAiSessionTerminalBinding extends AiSessionTerminalBindingBase {
    state: 'bound';
    sessionId: string;
    runStartedAtMs: number;
}

export type AiSessionTerminalBinding = PendingAiSessionTerminalBinding | BoundAiSessionTerminalBinding;

export type PendingAiSessionTerminalBindingInput = Omit<
    PendingAiSessionTerminalBinding,
    'version' | 'state' | 'updatedAtMs'
>;

export type BoundAiSessionTerminalBindingInput = Omit<
    BoundAiSessionTerminalBinding,
    'version' | 'state' | 'updatedAtMs'
>;

export default class AiSessionTerminalBindingStore {
    private readonly records: Map<string, AiSessionTerminalBinding>;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly state: AiSessionTerminalBindingState,
        private readonly onError: (error: unknown) => void = () => undefined,
        private readonly now: () => number = () => Date.now()
    ) {
        this.records = this.readRegistry();
    }

    get(instanceId: string): AiSessionTerminalBinding | null {
        if (!isInstanceId(instanceId)) {
            return null;
        }
        let record = this.records.get(instanceId);
        return record ? cloneRecord(record) : null;
    }

    setPending(instanceId: string, input: PendingAiSessionTerminalBindingInput): void {
        let record = validateRecord({
            ...input,
            version: 1,
            state: 'pending',
            updatedAtMs: this.now(),
        });
        if (!isInstanceId(instanceId) || !record || record.state !== 'pending') {
            return;
        }
        this.records.set(instanceId, record);
        this.enqueueWrite(instanceId, record);
    }

    setBound(instanceId: string, input: BoundAiSessionTerminalBindingInput): void {
        let record = validateRecord({
            ...input,
            version: 1,
            state: 'bound',
            updatedAtMs: this.now(),
        });
        if (!isInstanceId(instanceId) || !record || record.state !== 'bound') {
            return;
        }
        this.records.set(instanceId, record);
        this.enqueueWrite(instanceId, record);
    }

    remove(instanceId: string): void {
        if (!isInstanceId(instanceId)) {
            return;
        }
        this.records.delete(instanceId);
        this.enqueueWrite(instanceId, null);
    }

    flush(): Promise<void> {
        return this.writeQueue;
    }

    private enqueueWrite(instanceId: string, record: AiSessionTerminalBinding | null): void {
        this.writeQueue = this.writeQueue.then(async () => {
            let latest = this.readRegistry();
            if (record) {
                latest.set(instanceId, cloneRecord(record));
            } else {
                latest.delete(instanceId);
            }
            latest = new Map(Array.from(latest.entries())
                .sort((left, right) => right[1].updatedAtMs - left[1].updatedAtMs)
                .slice(0, MAX_BINDINGS));
            let serialized = Array.from(latest.entries()).reduce((result, [key, value]) => {
                result[key] = cloneRecord(value);
                return result;
            }, {} as Record<string, AiSessionTerminalBinding>);
            await this.state.update(AI_SESSION_TERMINAL_BINDINGS_KEY, serialized);
        }).catch(error => {
            this.onError(error);
        });
    }

    private readRegistry(): Map<string, AiSessionTerminalBinding> {
        let raw: unknown;
        try {
            raw = this.state?.get(AI_SESSION_TERMINAL_BINDINGS_KEY, {} as Record<string, unknown>);
        } catch (error) {
            this.onError(error);
            return new Map();
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return new Map();
        }
        return new Map(Object.entries(raw as Record<string, unknown>)
            .filter(([instanceId]) => isInstanceId(instanceId))
            .map(([instanceId, value]) => [instanceId, validateRecord(value)] as const)
            .filter((entry): entry is readonly [string, AiSessionTerminalBinding] => !!entry[1])
            .sort((left, right) => right[1].updatedAtMs - left[1].updatedAtMs)
            .slice(0, MAX_BINDINGS));
    }
}

function validateRecord(value: unknown): AiSessionTerminalBinding | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    let record = value as Record<string, unknown>;
    if (record.version !== 1 || (record.state !== 'pending' && record.state !== 'bound')
        || !isProviderId(record.providerId) || !isBoundedString(record.markerPath, MAX_PATH_LENGTH)
        || !isFiniteNonNegative(record.updatedAtMs)) {
        return null;
    }
    if (record.state === 'bound') {
        if (!isBoundedString(record.sessionId, MAX_ID_LENGTH) || !isFiniteNonNegative(record.runStartedAtMs)) {
            return null;
        }
        return {
            version: 1,
            state: 'bound',
            providerId: record.providerId,
            sessionId: record.sessionId,
            markerPath: record.markerPath,
            runStartedAtMs: record.runStartedAtMs,
            updatedAtMs: record.updatedAtMs,
        };
    }
    if (!isBoundedString(record.cwd, MAX_PATH_LENGTH) || typeof record.createdAt !== 'string'
        || !Number.isFinite(Date.parse(record.createdAt)) || !Array.isArray(record.excludedSessionIds)
        || record.excludedSessionIds.length > MAX_EXCLUDED_SESSION_IDS
        || record.excludedSessionIds.some(id => !isBoundedString(id, MAX_ID_LENGTH))
        || (record.title !== undefined && (typeof record.title !== 'string' || record.title.length > MAX_TITLE_LENGTH))) {
        return null;
    }
    return {
        version: 1,
        state: 'pending',
        providerId: record.providerId,
        markerPath: record.markerPath,
        cwd: record.cwd,
        createdAt: record.createdAt,
        excludedSessionIds: [...record.excludedSessionIds] as string[],
        ...(record.title === undefined ? {} : { title: record.title as string }),
        updatedAtMs: record.updatedAtMs,
    };
}

function cloneRecord(record: AiSessionTerminalBinding): AiSessionTerminalBinding {
    return record.state === 'pending'
        ? { ...record, excludedSessionIds: [...record.excludedSessionIds] }
        : { ...record };
}

function isInstanceId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

function isProviderId(value: unknown): value is AiSessionProviderId {
    return value === 'codex' || value === 'kimi' || value === 'claude';
}

function isBoundedString(value: unknown, maxLength: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isFiniteNonNegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
