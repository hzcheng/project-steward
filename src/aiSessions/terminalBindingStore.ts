'use strict';

import type { AiSessionProviderId } from '../models';

export const AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX = 'aiSessionTerminalProcessBinding.v2.';

const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_TITLE_LENGTH = 200;
const MAX_EXCLUDED_SESSION_IDS = 1000;

export interface AiSessionTerminalBindingState {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

interface AiSessionTerminalBindingBase {
    version: 2;
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

export type AiSessionTerminalProcessId = number | PromiseLike<number | undefined>;

export default class AiSessionTerminalBindingStore {
    private writeQueue: Promise<void> = Promise.resolve();
    private errorReported = false;

    constructor(
        private readonly state: AiSessionTerminalBindingState,
        private readonly onError: (error: unknown) => void = () => undefined,
        private readonly now: () => number = () => Date.now(),
        private readonly processIdTimeoutMs = 2000
    ) { }

    get(processId: number): AiSessionTerminalBinding | null {
        if (!isProcessId(processId)) {
            return null;
        }
        try {
            let record = validateRecord(this.state?.get(getBindingKey(processId), null as unknown));
            return record ? cloneRecord(record) : null;
        } catch (error) {
            this.reportErrorOnce(error);
            return null;
        }
    }

    setPending(processId: AiSessionTerminalProcessId, input: PendingAiSessionTerminalBindingInput): void {
        let record = validateRecord({
            ...input,
            version: 2,
            state: 'pending',
            updatedAtMs: this.now(),
        });
        if (!record || record.state !== 'pending') {
            return;
        }
        this.enqueueWrite(processId, record);
    }

    setBound(processId: AiSessionTerminalProcessId, input: BoundAiSessionTerminalBindingInput): void {
        let record = validateRecord({
            ...input,
            version: 2,
            state: 'bound',
            updatedAtMs: this.now(),
        });
        if (!record || record.state !== 'bound') {
            return;
        }
        this.enqueueWrite(processId, record);
    }

    remove(processId: AiSessionTerminalProcessId): void {
        this.enqueueWrite(processId, null);
    }

    flush(): Promise<void> {
        return this.writeQueue;
    }

    private enqueueWrite(processId: AiSessionTerminalProcessId, record: AiSessionTerminalBinding | null): void {
        let resolvedProcessId = this.resolveProcessId(processId);
        this.writeQueue = this.writeQueue.then(async () => {
            let pid = await resolvedProcessId;
            if (!isProcessId(pid)) {
                return;
            }
            await this.state.update(
                getBindingKey(pid),
                record ? cloneRecord(record) : undefined
            );
        }).catch(error => {
            this.reportErrorOnce(error);
        });
    }

    private resolveProcessId(processId: AiSessionTerminalProcessId): Promise<number | undefined> {
        if (typeof processId === 'number') {
            return Promise.resolve(isProcessId(processId) ? processId : undefined);
        }
        return new Promise(resolve => {
            let settled = false;
            let settle = (value: number | undefined) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                resolve(isProcessId(value) ? value : undefined);
            };
            let timeout = setTimeout(() => settle(undefined), this.processIdTimeoutMs);
            Promise.resolve(processId).then(settle, error => {
                this.reportErrorOnce(error);
                settle(undefined);
            });
        });
    }

    private reportErrorOnce(error: unknown): void {
        if (!this.errorReported) {
            this.errorReported = true;
            this.onError(error);
        }
    }
}

function getBindingKey(processId: number): string {
    return `${AI_SESSION_TERMINAL_PROCESS_BINDING_KEY_PREFIX}${processId}`;
}

function validateRecord(value: unknown): AiSessionTerminalBinding | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    let record = value as Record<string, unknown>;
    if (record.version !== 2 || (record.state !== 'pending' && record.state !== 'bound')
        || !isProviderId(record.providerId) || !isBoundedString(record.markerPath, MAX_PATH_LENGTH)
        || !isFiniteNonNegative(record.updatedAtMs)) {
        return null;
    }
    if (record.state === 'bound') {
        if (!isBoundedString(record.sessionId, MAX_ID_LENGTH) || !isFiniteNonNegative(record.runStartedAtMs)) {
            return null;
        }
        return {
            version: 2,
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
        version: 2,
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

function isProcessId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
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
