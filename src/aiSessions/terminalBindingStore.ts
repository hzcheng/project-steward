'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionRuntimeIdentity } from './runtimeTypes';
import {
    cloneAiSessionRuntimeIdentity,
    isValidAiSessionRuntimeIdentity,
} from './runtimeTypes';

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
    workspaceScopeIdentity: string;
    workspaceNavigationIdentity: string;
    workspaceRootHostPaths: string[];
    cwd: string;
    markerPath: string;
    updatedAtMs: number;
}

export interface PendingAiSessionTerminalBinding extends AiSessionTerminalBindingBase {
    state: 'pending';
    pendingId: string;
    createdAt: string;
    excludedSessionIds: string[];
    title?: string;
}

export interface BoundAiSessionTerminalBinding extends AiSessionTerminalBindingBase {
    state: 'bound';
    sessionId: string;
    runStartedAtMs: number;
}

export interface ReleasedAiSessionTerminalBinding extends AiSessionTerminalBindingBase {
    state: 'released';
    sessionId: string;
}

export type AiSessionTerminalBinding = PendingAiSessionTerminalBinding
    | BoundAiSessionTerminalBinding
    | ReleasedAiSessionTerminalBinding;

export type PendingAiSessionTerminalBindingInput = Omit<
    PendingAiSessionTerminalBinding,
    'version' | 'state' | 'updatedAtMs'
>;

export type BoundAiSessionTerminalBindingInput = Omit<
    BoundAiSessionTerminalBinding,
    'version' | 'state' | 'updatedAtMs'
>;

export type ReleasedAiSessionTerminalBindingInput = Omit<
    ReleasedAiSessionTerminalBinding,
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

    setReleased(processId: AiSessionTerminalProcessId, input: ReleasedAiSessionTerminalBindingInput): void {
        let record = validateRecord({
            ...input,
            version: 2,
            state: 'released',
            updatedAtMs: this.now(),
        });
        if (!record || record.state !== 'released') {
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
    if (record.version !== 2
        || (record.state !== 'pending' && record.state !== 'bound' && record.state !== 'released')
        || !isProviderId(record.providerId) || !isBoundedString(record.markerPath, MAX_PATH_LENGTH)
        || !isFiniteNonNegative(record.updatedAtMs)) {
        return null;
    }
    if (record.state === 'bound') {
        if (!hasExactKeys(record, [
            'version', 'state', 'providerId', 'workspaceScopeIdentity',
            'workspaceNavigationIdentity', 'workspaceRootHostPaths', 'cwd', 'markerPath',
            'updatedAtMs', 'sessionId', 'runStartedAtMs',
        ]) || !isBoundedString(record.sessionId, MAX_ID_LENGTH)
            || !isFiniteNonNegative(record.runStartedAtMs)) {
            return null;
        }
        const identity = validateIdentity(record, { sessionId: record.sessionId });
        if (!identity) {
            return null;
        }
        return {
            version: 2,
            state: 'bound',
            providerId: record.providerId,
            workspaceScopeIdentity: identity.workspaceScopeIdentity,
            workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
            cwd: identity.cwd,
            sessionId: identity.sessionId as string,
            markerPath: record.markerPath,
            runStartedAtMs: record.runStartedAtMs,
            updatedAtMs: record.updatedAtMs,
        };
    }
    if (record.state === 'released') {
        if (!hasExactKeys(record, [
            'version', 'state', 'providerId', 'workspaceScopeIdentity',
            'workspaceNavigationIdentity', 'workspaceRootHostPaths', 'cwd', 'markerPath',
            'updatedAtMs', 'sessionId',
        ])) {
            return null;
        }
        const identity = validateIdentity(record, { sessionId: record.sessionId });
        if (!identity) {
            return null;
        }
        return {
            version: 2,
            state: 'released',
            providerId: record.providerId,
            workspaceScopeIdentity: identity.workspaceScopeIdentity,
            workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
            workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
            cwd: identity.cwd,
            sessionId: identity.sessionId as string,
            markerPath: record.markerPath,
            updatedAtMs: record.updatedAtMs,
        };
    }
    const identity = validateIdentity(record, { pendingId: record.pendingId });
    if (!hasExactKeys(record, [
        'version', 'state', 'providerId', 'workspaceScopeIdentity',
        'workspaceNavigationIdentity', 'workspaceRootHostPaths', 'cwd', 'markerPath',
        'updatedAtMs', 'pendingId', 'createdAt', 'excludedSessionIds',
    ], ['title']) || !identity || typeof record.createdAt !== 'string'
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
        workspaceScopeIdentity: identity.workspaceScopeIdentity,
        workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...identity.workspaceRootHostPaths],
        markerPath: record.markerPath,
        cwd: identity.cwd,
        pendingId: identity.pendingId as string,
        createdAt: record.createdAt,
        excludedSessionIds: [...record.excludedSessionIds] as string[],
        ...(record.title === undefined ? {} : { title: record.title as string }),
        updatedAtMs: record.updatedAtMs,
    };
}

function hasExactKeys(
    record: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = []
): boolean {
    const allowed = new Set([...required, ...optional]);
    return required.every(key => Object.prototype.hasOwnProperty.call(record, key))
        && Object.keys(record).every(key => allowed.has(key));
}

function cloneRecord(record: AiSessionTerminalBinding): AiSessionTerminalBinding {
    return record.state === 'pending'
        ? { ...record, workspaceRootHostPaths: [...record.workspaceRootHostPaths], excludedSessionIds: [...record.excludedSessionIds] }
        : { ...record, workspaceRootHostPaths: [...record.workspaceRootHostPaths] };
}

function validateIdentity(
    record: Record<string, unknown>,
    id: { sessionId: unknown } | { pendingId: unknown }
): AiSessionRuntimeIdentity | null {
    const identity = {
        provider: record.providerId,
        workspaceScopeIdentity: record.workspaceScopeIdentity,
        workspaceNavigationIdentity: record.workspaceNavigationIdentity,
        workspaceRootHostPaths: record.workspaceRootHostPaths,
        cwd: record.cwd,
        ...id,
    };
    return isValidAiSessionRuntimeIdentity(identity)
        ? cloneAiSessionRuntimeIdentity(identity)
        : null;
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
